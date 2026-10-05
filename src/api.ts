import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client, Connection } from '@temporalio/client';
import express, { type NextFunction, type Request, type Response } from 'express';
import { cancelOpening, deliveryAction, getOpening, optOut, respondToOffer, waitlistWorkflow } from './workflows';
import type { ActionResult, OpeningInput, OpeningState } from './types';

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(process.cwd(), 'public')));
let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' })
    .then(connection => new Client({ connection, namespace: 'default' }))
    .catch(error => { clientPromise = undefined; throw error; });
  return clientPromise;
}
class InputError extends Error {}
function text(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InputError(`${field} must be nonempty text (up to ${max} characters).`);
  return value.trim();
}
function date(value: unknown, field: string): string {
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result)) || !/(Z|[+-]\d\d:\d\d)$/.test(result)) throw new InputError(`${field} must be a valid ISO timestamp including timezone.`);
  return new Date(result).toISOString();
}
function parseInput(body: unknown): OpeningInput {
  if (!body || typeof body !== 'object') throw new InputError('Opening details are required.');
  const input = body as Record<string, any>;
  if (!input.slot || !Array.isArray(input.waitlist) || input.waitlist.length > 100) throw new InputError('Provide a slot and up to 100 waitlist clients.');
  const slot = { id: input.slot.id ? text(input.slot.id, 'slot.id') : undefined, service: text(input.slot.service, 'service'), stylist: text(input.slot.stylist, 'stylist'), startsAt: date(input.slot.startsAt, 'startsAt'), durationMinutes: Number(input.slot.durationMinutes) };
  if (!Number.isInteger(slot.durationMinutes) || slot.durationMinutes < 1 || slot.durationMinutes > 480) throw new InputError('Duration must be 1–480 minutes.');
  if (Date.parse(slot.startsAt) <= Date.now()) throw new InputError('The appointment start must be in the future.');
  const ids = new Set<string>();
  const waitlist = input.waitlist.map((item: any) => {
    if (!item || typeof item !== 'object') throw new InputError('Each waitlist client must be an object.');
    const candidate = {
      id: text(item.id, 'candidate id'), name: text(item.name, 'client name'), mobile: text(item.mobile, 'mobile', 40), service: text(item.service, 'requested service'),
      preferredStylist: item.preferredStylist ? text(item.preferredStylist, 'preferred stylist') : null,
      availableFrom: date(item.availableFrom, 'availableFrom'), availableUntil: date(item.availableUntil, 'availableUntil'), joinedAt: date(item.joinedAt, 'joinedAt'),
      simulateFailure: item.simulateFailure === true, optedOut: item.optedOut === true,
    };
    if (ids.has(candidate.id)) throw new InputError('Waitlist client IDs must be unique.');
    ids.add(candidate.id);
    if (Date.parse(candidate.availableFrom) >= Date.parse(candidate.availableUntil)) throw new InputError('Client availability must end after it starts.');
    return candidate;
  });
  const demoMode = input.demoMode === true;
  const offerWindowSeconds = demoMode ? Number(input.offerWindowSeconds ?? 20) : 900;
  if (!Number.isInteger(offerWindowSeconds) || offerWindowSeconds < 2 || offerWindowSeconds > 900) throw new InputError('Demo response window must be 2–900 seconds.');
  return { slot, waitlist, demoMode, offerWindowSeconds };
}
const unavailable = (): ActionResult => ({ ok: false, code: 'unavailable', message: 'This offer is no longer available. You remain on the waitlist.' });
async function stateFor(client: Client, workflowId: string): Promise<OpeningState> {
  return client.connection.withDeadline(Date.now() + 5_000, () => client.workflow.getHandle(workflowId).query(getOpening));
}
app.get('/api/health', async (_request, response) => {
  const client = await getClient();
  await client.connection.withDeadline(Date.now() + 3_000, () => client.connection.workflowService.getSystemInfo({}));
  response.json({ ok: true, temporal: 'connected', simulatedSms: true, squareIntegration: false });
});
app.post('/api/openings', async (request, response) => {
  const input = parseInput(request.body);
  // Ignore user-provided row IDs for locking. Two staff entering the same stylist
  // and instant reach the same durable Workflow, even if spelling case differs.
  const openingKey = `${input.slot.stylist.trim().toLowerCase()}|${input.slot.startsAt}`;
  const workflowId = `opening-${createHash('sha256').update(openingKey).digest('hex').slice(0, 24)}`;
  const client = await getClient();
  try {
    await client.workflow.start(waitlistWorkflow, { workflowId, taskQueue: 'juniper-waitlist', args: [input], workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'FAIL' });
  } catch (error) {
    if (error instanceof Error && error.name === 'WorkflowExecutionAlreadyStartedError') {
      response.status(409).json({ error: 'This stylist and appointment start already have an opening. Open the existing workflow instead.', workflowId, openingId: workflowId, existing: true });
      return;
    }
    throw error;
  }
  response.status(201).json({ workflowId, openingId: workflowId });
});
app.get('/api/openings', async (_request, response) => {
  const client = await getClient();
  const ids: string[] = [];
  // Never let accumulated history hide an active opening or prevent opt-out
  // propagation to it. The iterator follows every server page of live work.
  for await (const execution of client.workflow.list({ query: "WorkflowType = 'waitlistWorkflow' AND ExecutionStatus = 'Running'", pageSize: 100 })) {
    ids.push(execution.workflowId);
  }
  let closedCount = 0;
  for await (const execution of client.workflow.list({ query: "WorkflowType = 'waitlistWorkflow' AND ExecutionStatus != 'Running'", pageSize: 30 })) {
    ids.push(execution.workflowId);
    if (++closedCount >= 30) break;
  }
  const results = await Promise.allSettled([...new Set(ids)].map(id => stateFor(client, id)));
  const openings = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  openings.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  response.json({ openings, unavailableCount: results.filter(result => result.status === 'rejected').length });
});
app.get('/api/openings/:id', async (request, response) => response.json(await stateFor(await getClient(), request.params.id)));
app.post('/api/openings/:id/respond', async (request, response) => {
  const input = { offerId: text(request.body?.offerId, 'offerId', 200), candidateId: text(request.body?.candidateId, 'candidateId'), decision: request.body?.decision };
  if (input.decision !== 'accept' && input.decision !== 'decline') throw new InputError('Choose accept or decline.');
  const client = await getClient();
  const handle = client.workflow.getHandle(request.params.id);
  // Closed Workflow Updates are rejected by Temporal; retain the customer-facing
  // "no longer available" result for stale links and repeated browser clicks.
  const state = await stateFor(client, request.params.id);
  if (['filled', 'unfilled', 'cancelled'].includes(state.phase)) { response.status(409).json(unavailable()); return; }
  try {
    const result = await client.connection.withDeadline(Date.now() + 10_000, () => handle.executeUpdate(respondToOffer, { args: [input] }));
    response.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    const current = await stateFor(client, request.params.id);
    if (['filled', 'unfilled', 'cancelled'].includes(current.phase)) { response.status(409).json(unavailable()); return; }
    throw error;
  }
});
app.post('/api/openings/:id/cancel', async (request, response) => {
  const reason = request.body?.reason ? text(request.body.reason, 'reason', 240) : undefined;
  const client = await getClient();
  const state = await stateFor(client, request.params.id);
  if (['filled', 'unfilled', 'cancelled'].includes(state.phase)) { response.status(409).json({ ok: false, code: 'closed', message: 'This opening is already closed.' }); return; }
  const result = await client.workflow.getHandle(request.params.id).executeUpdate(cancelOpening, { args: [{ reason }] });
  response.status(result.ok ? 200 : 409).json(result);
});
app.post('/api/openings/:id/delivery-action', async (request, response) => {
  const offerId = text(request.body?.offerId, 'offerId', 200);
  const action = request.body?.action;
  if (action !== 'retry' && action !== 'skip') throw new InputError('Choose retry or skip.');
  const client = await getClient();
  const state = await stateFor(client, request.params.id);
  if (state.phase !== 'needs_attention') { response.status(409).json({ ok: false, code: 'unavailable', message: 'No delivery issue is awaiting action.' }); return; }
  const result = await client.workflow.getHandle(request.params.id).executeUpdate(deliveryAction, { args: [{ offerId, action }] });
  response.status(result.ok ? 200 : 409).json(result);
});
app.post('/api/openings/:id/optout', async (request, response) => {
  const candidateId = text(request.body?.candidateId, 'candidateId');
  const client = await getClient();
  const state = await stateFor(client, request.params.id);
  if (['filled', 'unfilled', 'cancelled'].includes(state.phase)) { response.status(409).json({ ok: false, code: 'closed', message: 'Opening closed. Record this opt-out in the source waitlist before future outreach.' }); return; }
  const result = await client.workflow.getHandle(request.params.id).executeUpdate(optOut, { args: [{ candidateId }] });
  response.status(result.ok ? 200 : 409).json(result);
});
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  const name = error instanceof Error ? error.name : '';
  const status = error instanceof InputError || error instanceof SyntaxError ? 400 : name === 'WorkflowNotFoundError' ? 404 : 503;
  response.status(status).json({ error: error instanceof Error ? error.message : 'Unexpected error', code: status === 503 ? 'temporarily_unavailable' : 'invalid_request' });
});
const port = Number(process.env.PORT ?? 3000);
app.listen(port, '127.0.0.1', () => console.log(`Juniper waitlist is available at http://localhost:${port}`));
