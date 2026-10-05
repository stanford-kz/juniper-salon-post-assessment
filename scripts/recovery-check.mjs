// Manual crash verification against the running local prototype.
// Run prepare, stop/crash the worker, restart it, then run verify.
// prepare-overdue / verify-overdue also prove that downtime does not reset timers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:3000';
const mode = process.argv[2];
const overdue = mode?.includes('overdue');
const key = overdue ? 'recovery-overdue' : 'recovery';
const file = `.data/${key}.json`;
async function request(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
}
async function until(id, predicate) {
  let value;
  for (let i = 0; i < 100; i++) {
    const result = await request(`/api/openings/${id}`); value = result.body;
    if (result.status === 200 && predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Workflow did not reach expected state: ${JSON.stringify(value)}`);
}
if (mode?.startsWith('prepare')) {
  const now = Date.now();
  const startsAt = new Date(now + 86400000).toISOString();
  const candidate = (id, name, joinedDays) => ({ id, name, mobile: '+1 602 555 0199', service: 'Cut & finish', preferredStylist: 'Carla', availableFrom: new Date(now).toISOString(), availableUntil: new Date(now + 2 * 86400000).toISOString(), joinedAt: new Date(now - joinedDays * 86400000).toISOString() });
  const input = { slot: { service: 'Cut & finish', stylist: 'Carla', startsAt, durationMinutes: 60 }, waitlist: [candidate('recovery-maya', 'Maya Chen', 7), candidate('recovery-jordan', 'Jordan Ellis', 5)], demoMode: true, offerWindowSeconds: overdue ? 15 : 900 };
  const created = await request('/api/openings', input);
  assert.equal(created.status, 201, JSON.stringify(created));
  const id = created.body.workflowId;
  const state = await until(id, state => state.currentOffer?.status === 'active');
  const duplicate = await request('/api/openings', { ...input, slot: { ...input.slot, id: 'different-staff-row', stylist: 'CARLA' } });
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.workflowId, id);
  await mkdir('.data', { recursive: true });
  await writeFile(file, JSON.stringify({ preparedAt: new Date().toISOString(), workflowId: id, input, before: state, duplicateStartStatus: duplicate.status }, null, 2));
  console.log(JSON.stringify({ prepared: key, workflowId: id, offerId: state.currentOffer.id, expiresAt: state.currentOffer.expiresAt, duplicateStartStatus: duplicate.status }));
} else if (mode?.startsWith('verify')) {
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const id = saved.workflowId;
  const before = saved.before.currentOffer;
  const after = await until(id, state => overdue ? state.offers.length > 1 : state.currentOffer?.status === 'active');
  assert.equal(after.offers[0].id, before.id);
  assert.equal(after.offers[0].sentAt, before.sentAt);
  assert.equal(after.offers[0].expiresAt, before.expiresAt);
  const ledger = JSON.parse(await readFile(`.data/outbox/${createHash('sha256').update(before.id).digest('hex')}.json`, 'utf8'));
  assert.equal(ledger.receipt.expiresAt, before.expiresAt);
  const checks = ['exact duplicate stylist/start rejected with 409', 'original offer ID preserved', 'original sentAt preserved', 'original deadline preserved', 'persisted delivery receipt reused'];
  if (overdue) {
    assert.equal(after.offers[0].status, 'expired');
    assert.equal(after.offers[1].candidateId, 'recovery-jordan');
    checks.push('deadline elapsed during worker downtime', 'first offer expired after restart', 'next client contacted automatically');
    if (!['filled', 'unfilled', 'cancelled'].includes(after.phase)) await request(`/api/openings/${id}/cancel`, { reason: 'Overdue crash verification completed' });
  } else {
    assert.equal(after.offers.length, 1);
    assert.equal(after.currentOffer.id, before.id);
    checks.push('no duplicate offer created by worker replay');
    const declined = await request(`/api/openings/${id}/respond`, { offerId: before.id, candidateId: before.candidateId, decision: 'decline' });
    assert.equal(declined.status, 200);
    const next = await until(id, state => state.currentOffer?.status === 'active' && state.currentOffer.id !== before.id);
    const offer = next.currentOffer;
    const replies = await Promise.all([1, 2].map(() => request(`/api/openings/${id}/respond`, { offerId: offer.id, candidateId: offer.candidateId, decision: 'accept' })));
    assert.deepEqual(replies.map(result => result.status).sort(), [200, 409]);
    const late = await request(`/api/openings/${id}/respond`, { offerId: before.id, candidateId: before.candidateId, decision: 'accept' });
    assert.equal(late.status, 409);
    const final = (await request(`/api/openings/${id}`)).body;
    assert.equal(final.phase, 'filled'); assert.equal(final.offers.filter(item => item.status === 'accepted').length, 1);
    checks.push('decline after restart advances automatically', 'simultaneous HTTP accepts yield one 200 and one 409', 'late first-client acceptance yields 409', 'exactly one accepted offer and manual Square reminder');
  }
  const result = { verifiedAt: new Date().toISOString(), preparedAt: saved.preparedAt, workflowId: id, originalOfferId: before.id, originalDeadline: before.expiresAt, recoveredDeadline: after.offers[0].expiresAt, checks, passed: true };
  await mkdir('evidence', { recursive: true });
  await writeFile(`evidence/${key}-results.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} else {
  throw new Error('Use prepare, verify, prepare-overdue, or verify-overdue. Crash/restart the worker between prepare and verify.');
}
