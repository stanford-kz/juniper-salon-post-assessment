import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MockActivityEnvironment, TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/activity';
import type { WorkflowHandle } from '@temporalio/client';
import { cancelOpening, deliveryAction, getOpening, optOut, respondToOffer, waitlistWorkflow } from '../src/workflows';
import { createOfferSender, sendOffer } from '../src/activities';
import { nextBusinessTime } from '../src/business-hours';
import type { Candidate, DeliveryInput, DeliveryReceipt, OpeningInput, OpeningState } from '../src/types';

type Handle = WorkflowHandle<typeof waitlistWorkflow>;
async function eventually(handle: Handle, predicate: (state: OpeningState) => boolean): Promise<OpeningState> {
  const deadline = Date.now() + 8_000;
  let state: OpeningState;
  do {
    state = await handle.query(getOpening);
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(`State did not converge: ${JSON.stringify(state!)}`);
}

test('durable waitlist business rules on a real Temporal test server', { timeout: 90_000 }, async t => {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const deliveries: DeliveryInput[] = [];
  async function check(name: string, run: () => Promise<void>) { await run(); t.diagnostic(`PASS: ${name}`); }
  const worker = await Worker.create({
    connection: env.nativeConnection, taskQueue: 'waitlist-tests', workflowsPath: require.resolve('../src/workflows'),
    activities: {
      sendOffer: async (input: DeliveryInput): Promise<DeliveryReceipt> => {
        deliveries.push(input);
        if (input.candidate.id === 'cross-close' && input.deliveryAttempt === 1) {
          await env.sleep('2 seconds');
          throw ApplicationFailure.nonRetryable('Business hours ended during delivery attempt.', 'OutsideBusinessHours');
        }
        if (input.candidate.simulateFailure && input.deliveryAttempt === 1) throw new Error('Provider unavailable');
        const now = await env.currentTimeMs();
        return { id: input.offerId, channel: 'simulated_sms', sentAt: new Date(now).toISOString(), expiresAt: new Date(Math.min(now + input.offerWindowSeconds * 1000, Date.parse(input.slot.startsAt))).toISOString(), message: 'Simulated test offer' };
      },
    },
  });
  async function fixture(): Promise<OpeningInput> {
    const now = await env.currentTimeMs();
    const slotStart = now + 2 * 86_400_000;
    const candidate = (id: string, age: number): Candidate => ({ id, name: id, mobile: '+15550100000', service: 'Haircut', preferredStylist: 'Maya', availableFrom: new Date(slotStart - 3_600_000).toISOString(), availableUntil: new Date(slotStart + 3_600_000).toISOString(), joinedAt: new Date(now - age * 86_400_000).toISOString() });
    return { slot: { service: 'Haircut', stylist: 'Maya', startsAt: new Date(slotStart).toISOString(), durationMinutes: 45 }, waitlist: [candidate('newer', 1), candidate('older', 3)], demoMode: true, offerWindowSeconds: 900 };
  }
  async function start(input: OpeningInput): Promise<Handle> {
    return env.client.workflow.start(waitlistWorkflow, { workflowId: `test-${randomUUID()}`, taskQueue: 'waitlist-tests', args: [input] });
  }
  async function cancel(handle: Handle) { await handle.executeUpdate(cancelOpening, { args: [{ reason: 'test finished' }] }); await handle.result(); }
  const running = worker.run();
  try {
      await check('service, required stylist, full availability and opt-out filtering; FIFO despite input order', async () => {
        const input = await fixture();
        const base = input.waitlist[0];
        input.waitlist.push({ ...base, id: 'wrong-service', service: 'Color' }, { ...base, id: 'wrong-stylist', preferredStylist: 'Carla' }, { ...base, id: 'too-short', availableUntil: new Date(Date.parse(input.slot.startsAt) + 15 * 60_000).toISOString() }, { ...base, id: 'opted-out', optedOut: true });
        const handle = await start(input);
        const state = await eventually(handle, state => state.currentOffer?.status === 'active');
        assert.equal(state.currentOffer?.candidateId, 'older');
        assert.equal(state.candidates.filter(candidate => candidate.eligible).length, 2);
        assert.equal(state.offers.length, 1);
        await cancel(handle);
      });
      await check('decline advances automatically, late response cannot claim the next offer, one acceptance fills', async () => {
        const handle = await start(await fixture());
        const first = (await eventually(handle, s => s.currentOffer?.status === 'active')).currentOffer!;
        const decline = await handle.executeUpdate(respondToOffer, { args: [{ offerId: first.id, candidateId: first.candidateId, decision: 'decline' }] });
        assert.equal(decline.ok, true);
        const next = (await eventually(handle, s => s.currentOffer?.status === 'active' && s.currentOffer.id !== first.id)).currentOffer!;
        assert.equal(next.candidateId, 'newer');
        const late = await handle.executeUpdate(respondToOffer, { args: [{ offerId: first.id, candidateId: first.candidateId, decision: 'accept' }] });
        assert.equal(late.ok, false);
        const accepted = await handle.executeUpdate(respondToOffer, { args: [{ offerId: next.id, candidateId: next.candidateId, decision: 'accept' }] });
        assert.equal(accepted.ok, true);
        const final = await handle.result();
        assert.equal(final.phase, 'filled');
        assert.equal(final.squareUpdateRequired, true);
        assert.equal(final.candidates.length, 2, 'declined client is not removed from waitlist');
        assert.equal(final.offers.filter(offer => offer.status === 'accepted').length, 1);
      });
      await check('durable 15-minute timer expires, then advances automatically and exhausts', async () => {
        const input = await fixture(); input.offerWindowSeconds = 900;
        const handle = await start(input);
        const first = (await eventually(handle, s => s.currentOffer?.status === 'active')).currentOffer!;
        await env.sleep('901 seconds');
        const next = await eventually(handle, s => s.currentOffer?.status === 'active' && s.currentOffer.id !== first.id);
        assert.equal(next.offers[0].status, 'expired');
        const result = await handle.result(); // Time-skips the next durable timer.
        assert.equal(result.phase, 'unfilled');
        assert.deepEqual(result.offers.map(offer => offer.status), ['expired', 'expired']);
      });
      await check('concurrent duplicate accept requests produce at most one successful claim', async () => {
        const input = await fixture(); input.waitlist = [input.waitlist[0]];
        const handle = await start(input);
        const offer = (await eventually(handle, s => s.currentOffer?.status === 'active')).currentOffer!;
        const request = { offerId: offer.id, candidateId: offer.candidateId, decision: 'accept' as const };
        const results = await Promise.allSettled([handle.executeUpdate(respondToOffer, { args: [request] }), handle.executeUpdate(respondToOffer, { args: [request] })]);
        assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.ok).length, 1);
        assert.equal((await handle.result()).offers.filter(item => item.status === 'accepted').length, 1);
      });
      await check('wrong recipient cannot accept; cancellation invalidates outstanding offer', async () => {
        const handle = await start(await fixture());
        const offer = (await eventually(handle, s => s.currentOffer?.status === 'active')).currentOffer!;
        assert.equal((await handle.executeUpdate(respondToOffer, { args: [{ offerId: offer.id, candidateId: 'not-the-recipient', decision: 'accept' }] })).ok, false);
        await handle.executeUpdate(cancelOpening, { args: [{ reason: 'Walk-in took slot' }] });
        const final = await handle.result();
        assert.equal(final.phase, 'cancelled');
        assert.equal(final.currentOffer?.status, 'cancelled');
        assert.equal(final.acceptedCandidate, null);
      });
      await check('pending opt-out invalidates the offer and advances without removing the client', async () => {
        const handle = await start(await fixture());
        const offer = (await eventually(handle, s => s.currentOffer?.status === 'active')).currentOffer!;
        await handle.executeUpdate(optOut, { args: [{ candidateId: offer.candidateId }] });
        const next = await eventually(handle, s => s.currentOffer?.status === 'active' && s.currentOffer.id !== offer.id);
        assert.equal(next.offers[0].status, 'opted_out');
        assert.equal(next.candidates.find(c => c.id === offer.candidateId)?.optedOut, true);
        assert.equal(next.candidates.length, 2);
        await cancel(handle);
      });
      await check('bounded failed delivery is visible and staff retry restores the same recipient', async () => {
        const input = await fixture(); input.waitlist.find(c => c.id === 'older')!.simulateFailure = true;
        const handle = await start(input);
        await eventually(handle, s => s.currentOffer?.status === 'sending');
        await env.sleep('5 seconds');
        const attention = await eventually(handle, s => s.phase === 'needs_attention');
        assert.equal(attention.currentOffer?.deliveryAttempts, 1);
        const offerId = attention.currentOffer!.id;
        await handle.executeUpdate(deliveryAction, { args: [{ offerId, action: 'retry' }] });
        const active = await eventually(handle, s => s.currentOffer?.status === 'active');
        assert.equal(active.currentOffer?.id, offerId);
        assert.equal(active.currentOffer?.deliveryAttempts, 2);
        await cancel(handle);
      });
      await check('staff can skip failed delivery and contact next eligible client', async () => {
        const input = await fixture(); input.waitlist.find(c => c.id === 'older')!.simulateFailure = true;
        const handle = await start(input);
        await eventually(handle, s => s.currentOffer?.status === 'sending');
        await env.sleep('5 seconds');
        const attention = await eventually(handle, s => s.phase === 'needs_attention');
        await handle.executeUpdate(deliveryAction, { args: [{ offerId: attention.currentOffer!.id, action: 'skip' }] });
        const active = await eventually(handle, s => s.currentOffer?.status === 'active');
        assert.equal(active.currentOffer?.candidateId, 'newer');
        assert.equal(active.offers[0].status, 'skipped');
        await cancel(handle);
      });
      await check('appointment-start cutoff expires current offer and never contacts another client', async () => {
        const input = await fixture();
        const now = await env.currentTimeMs();
        input.slot.startsAt = new Date(now + 30_000).toISOString();
        for (const candidate of input.waitlist) { candidate.availableFrom = new Date(now).toISOString(); candidate.availableUntil = new Date(now + 3_600_000).toISOString(); }
        const handle = await start(input);
        await eventually(handle, s => s.currentOffer?.status === 'active');
        const final = await handle.result();
        assert.equal(final.phase, 'unfilled');
        assert.equal(final.offers.length, 1);
        assert.equal(final.offers[0].status, 'expired');
        assert.match(final.timeline.at(-1)!.message, /Appointment start/);
      });
      await check('normal mode waits for Tuesday 09:00 Phoenix and preserves real 15-minute window', async () => {
        let now = await env.currentTimeMs();
        const sunday = new Date(now);
        sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7 || 7));
        sunday.setUTCHours(20, 0, 0, 0);
        await env.sleep(sunday.getTime() - now);
        const input = await fixture(); input.demoMode = false; input.offerWindowSeconds = 3;
        const tuesday = new Date(sunday.getTime() + 2 * 86_400_000); tuesday.setUTCHours(16, 0, 0, 0);
        input.slot.startsAt = new Date(tuesday.getTime() + 3_600_000).toISOString();
        for (const candidate of input.waitlist) { candidate.availableFrom = tuesday.toISOString(); candidate.availableUntil = new Date(tuesday.getTime() + 3 * 3_600_000).toISOString(); }
        const before = deliveries.length;
        const handle = await start(input);
        const waiting = await eventually(handle, s => s.phase === 'waiting_for_hours');
        assert.equal(waiting.nextActionAt, tuesday.toISOString());
        assert.equal(waiting.offerWindowSeconds, 900);
        assert.equal(deliveries.length, before, 'no texts sent while closed');
        now = await env.currentTimeMs(); await env.sleep(tuesday.getTime() - now + 100);
        const active = await eventually(handle, s => s.currentOffer?.status === 'active');
        assert.equal(Date.parse(active.currentOffer!.expiresAt!) - Date.parse(active.currentOffer!.sentAt!), 900_000);
        await cancel(handle);
      });
      await check('slot before reopening ends unfilled without sending any text', async () => {
        const now = await env.currentTimeMs();
        const sunday = new Date(now); sunday.setUTCDate(sunday.getUTCDate() + ((7 - sunday.getUTCDay()) % 7 || 7)); sunday.setUTCHours(20, 0, 0, 0);
        await env.sleep(sunday.getTime() - now);
        const input = await fixture(); input.demoMode = false;
        input.slot.startsAt = new Date(sunday.getTime() + 3_600_000).toISOString();
        for (const candidate of input.waitlist) { candidate.availableFrom = sunday.toISOString(); candidate.availableUntil = new Date(sunday.getTime() + 3 * 3_600_000).toISOString(); }
        const before = deliveries.length;
        const handle = await start(input);
        const final = await handle.result();
        assert.equal(final.phase, 'unfilled'); assert.equal(deliveries.length, before); assert.equal(final.offers.length, 0);
      });
      await check('delivery retry crossing Saturday closing waits durably until Tuesday', async () => {
        const now = await env.currentTimeMs();
        const saturday = new Date(now);
        saturday.setUTCDate(saturday.getUTCDate() + ((6 - saturday.getUTCDay() + 7) % 7 || 7));
        saturday.setUTCHours(23, 59, 0, 0); // 16:59 Phoenix; advance one hour below.
        const closingEdge = saturday.getTime() + 3_659_000; // 17:59:59 Phoenix.
        await env.sleep(closingEdge - now);
        const input = await fixture(); input.demoMode = false;
        const reopen = nextBusinessTime(closingEdge + 2_000);
        input.slot.startsAt = new Date(reopen + 7_200_000).toISOString();
        input.waitlist = [{ ...input.waitlist[0], id: 'cross-close', availableFrom: new Date(closingEdge).toISOString(), availableUntil: new Date(reopen + 4 * 3_600_000).toISOString() }];
        const handle = await start(input);
        const deferred = await eventually(handle, s => s.phase === 'waiting_for_hours');
        assert.equal(deferred.nextActionAt, new Date(reopen).toISOString());
        assert.ok(deferred.timeline.some(item => item.type === 'delivery_deferred'));
        await env.sleep(reopen - await env.currentTimeMs() + 100);
        const active = await eventually(handle, s => s.currentOffer?.status === 'active');
        assert.equal(active.currentOffer?.deliveryAttempts, 2);
        await cancel(handle);
      });
      await check('STOP during a failed-delivery retry overnight wait prevents that retry at reopening', async () => {
        const now = await env.currentTimeMs();
        const saturday = new Date(now);
        saturday.setUTCDate(saturday.getUTCDate() + ((6 - saturday.getUTCDay() + 7) % 7 || 7));
        saturday.setUTCHours(23, 59, 58, 0);
        const edge = saturday.getTime() + 3_600_000; // Saturday 17:59:58 Phoenix.
        await env.sleep(edge - now);
        const reopen = nextBusinessTime(edge + 4_000);
        const input = await fixture(); input.demoMode = false;
        input.slot.startsAt = new Date(reopen + 7_200_000).toISOString();
        for (const candidate of input.waitlist) {
          candidate.availableFrom = new Date(edge).toISOString();
          candidate.availableUntil = new Date(reopen + 4 * 3_600_000).toISOString();
          candidate.simulateFailure = candidate.id === 'older';
        }
        const handle = await start(input);
        await eventually(handle, state => state.currentOffer?.status === 'sending');
        await env.sleep('4 seconds');
        const attention = await eventually(handle, state => state.phase === 'needs_attention');
        await handle.executeUpdate(deliveryAction, { args: [{ offerId: attention.currentOffer!.id, action: 'retry' }] });
        await eventually(handle, state => state.phase === 'waiting_for_hours');
        await handle.executeUpdate(optOut, { args: [{ candidateId: 'older' }] });
        const priorDeliveries = deliveries.filter(item => item.workflowId === handle.workflowId && item.candidate.id === 'older').length;
        await env.sleep(reopen - await env.currentTimeMs() + 100);
        const next = await eventually(handle, state => state.currentOffer?.candidateId === 'newer' && state.currentOffer.status === 'active');
        assert.equal(next.offers[0].status, 'opted_out');
        assert.equal(deliveries.filter(item => item.workflowId === handle.workflowId && item.candidate.id === 'older').length, priorDeliveries, 'STOP client never reaches provider after reopening');
        await cancel(handle);
      });
      await check('no eligible clients ends explicitly unfilled without outreach', async () => {
        const input = await fixture(); input.waitlist.forEach(candidate => candidate.optedOut = true);
        const before = deliveries.length;
        const handle = await start(input); const final = await handle.result();
        assert.equal(final.phase, 'unfilled'); assert.equal(final.offers.length, 0); assert.equal(deliveries.length, before);
      });
  } finally {
    worker.shutdown();
    await running;
    await env.teardown();
  }
});

test('Phoenix business-hour boundaries include Tuesday opening and exclude Saturday closing', () => {
  const cases = [
    ['2026-10-06T15:59:00Z', '2026-10-06T16:00:00Z'],
    ['2026-10-06T16:00:00Z', '2026-10-06T16:00:00Z'],
    ['2026-10-11T00:59:59Z', '2026-10-11T00:59:59Z'],
    ['2026-10-11T01:00:00Z', '2026-10-13T16:00:00Z'],
    ['2026-10-11T20:00:00Z', '2026-10-13T16:00:00Z'],
    ['2026-10-12T20:00:00Z', '2026-10-13T16:00:00Z'],
  ];
  for (const [input, expected] of cases) assert.equal(new Date(nextBusinessTime(Date.parse(input))).toISOString(), new Date(expected).toISOString());
});

test('simulated SMS provider durably deduplicates concurrent retries and preserves deadline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'juniper-outbox-test-'));
  const original = process.env.DATA_DIR; process.env.DATA_DIR = directory;
  try {
    const now = Date.now();
    const input: DeliveryInput = { workflowId: 'durable-test', offerId: 'offer-1', slot: { service: 'Haircut', stylist: 'Maya', startsAt: new Date(now + 3_600_000).toISOString(), durationMinutes: 45 }, candidate: { id: 'client', name: 'Client', mobile: '+15550100000', service: 'Haircut', preferredStylist: null, availableFrom: new Date(now).toISOString(), availableUntil: new Date(now + 7_200_000).toISOString(), joinedAt: new Date(now).toISOString() }, deliveryAttempt: 1, offerWindowSeconds: 900, demoMode: true };
    const activityEnvironment = new MockActivityEnvironment();
    const call = (value: DeliveryInput) => activityEnvironment.run<[DeliveryInput], DeliveryReceipt, typeof sendOffer>(sendOffer, value);
    const receipts = await Promise.all(Array.from({ length: 5 }, () => call(input)));
    for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
    const afterRestart = await call({ ...input, deliveryAttempt: 2 });
    assert.deepEqual(afterRestart, receipts[0]);
    assert.equal((await readdir(path.join(directory, 'outbox'))).filter(file => file.endsWith('.json')).length, 1);
    assert.match(receipts[0].message, /Haircut.*Maya/); assert.match(receipts[0].message, /Phoenix/);
    await assert.rejects(call({ ...input, offerId: 'already-started', slot: { ...input.slot, startsAt: new Date(now - 1000).toISOString() } }), (error: unknown) => error instanceof ApplicationFailure && error.type === 'AppointmentStarted');
    await assert.rejects(call({ ...input, offerId: 'opted-out', candidate: { ...input.candidate, optedOut: true } }), (error: unknown) => error instanceof ApplicationFailure && error.type === 'OptedOut');
    assert.equal((await readdir(path.join(directory, 'outbox'))).filter(file => file.endsWith('.json')).length, 1, 'cutoff creates no outbox record');
  } finally { process.env.DATA_DIR = original; if (original === undefined) delete process.env.DATA_DIR; await rm(directory, { recursive: true, force: true }); }
});

test('STOP and staff cancellation stop an in-flight provider before publication', { timeout: 30_000 }, async t => {
  for (const action of ['optout', 'cancel'] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `juniper-cancel-${action}-`));
    const original = process.env.DATA_DIR; process.env.DATA_DIR = directory;
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    let entered!: () => void;
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const providerHold = new Promise<void>(resolve => { release = resolve; });
    const provider = createOfferSender({ beforePublish: async input => { if (input.candidate.id === 'first') { entered(); await providerHold; } } });
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: `held-provider-${action}`, workflowsPath: require.resolve('../src/workflows'), activities: { sendOffer: provider }, maxHeartbeatThrottleInterval: '100 milliseconds' });
    const running = worker.run();
    try {
      const now = await env.currentTimeMs();
      const candidate = (id: string, age: number): Candidate => ({ id, name: id, mobile: '+15550100000', service: 'Haircut', preferredStylist: null, availableFrom: new Date(now).toISOString(), availableUntil: new Date(now + 7_200_000).toISOString(), joinedAt: new Date(now - age * 86_400_000).toISOString() });
      const handle = await env.client.workflow.start(waitlistWorkflow, { workflowId: `held-${action}-${randomUUID()}`, taskQueue: `held-provider-${action}`, args: [{ slot: { service: 'Haircut', stylist: 'Maya', startsAt: new Date(now + 3_600_000).toISOString(), durationMinutes: 45 }, waitlist: [candidate('first', 3), candidate('second', 1)], demoMode: true, offerWindowSeconds: 900 }] });
      await providerEntered;
      if (action === 'optout') {
        await handle.executeUpdate(optOut, { args: [{ candidateId: 'first' }] });
        const next = await eventually(handle, state => state.currentOffer?.candidateId === 'second' && state.currentOffer.status === 'active');
        assert.equal(next.offers[0].status, 'opted_out');
        release();
        const files = (await readdir(path.join(directory, 'outbox'))).filter(file => file.endsWith('.json'));
        assert.equal(files.length, 1, 'only the next eligible client receives a text');
        const records = await Promise.all(files.map(file => import('node:fs/promises').then(fs => fs.readFile(path.join(directory, 'outbox', file), 'utf8')).then(JSON.parse)));
        assert.equal(records[0].candidateId, 'second');
        await handle.executeUpdate(cancelOpening, { args: [{}] });
        await handle.result();
      } else {
        await handle.executeUpdate(cancelOpening, { args: [{ reason: 'Client walked in' }] });
        const final = await handle.result();
        release();
        assert.equal(final.phase, 'cancelled');
        assert.equal(final.offers.length, 1, 'cancellation never advances to another client');
        assert.equal((await readdir(path.join(directory, 'outbox'))).filter(file => file.endsWith('.json')).length, 0, 'cancelled delivery never publishes');
      }
      t.diagnostic(`PASS: ${action} cancelled a held real provider Activity before publication`);
    } finally {
      release(); worker.shutdown(); await running; await env.teardown();
      process.env.DATA_DIR = original; if (original === undefined) delete process.env.DATA_DIR;
      await rm(directory, { recursive: true, force: true });
    }
  }
});
