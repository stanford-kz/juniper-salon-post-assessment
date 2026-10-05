import { ActivityCancellationType, CancellationScope, condition, defineQuery, defineUpdate, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
import type * as activities from './activities';
import { nextBusinessTime } from './business-hours';
import type { ActionResult, DeliveryActionInput, EligibleCandidate, Offer, OpeningInput, OpeningState, RespondInput } from './types';

const { sendOffer } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 seconds',
  heartbeatTimeout: '3 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumAttempts: 3 },
});
export const getOpening = defineQuery<OpeningState>('getOpening');
export const respondToOffer = defineUpdate<ActionResult, [RespondInput]>('respondToOffer');
export const cancelOpening = defineUpdate<ActionResult, [{ reason?: string }]>('cancelOpening');
export const deliveryAction = defineUpdate<ActionResult, [DeliveryActionInput]>('deliveryAction');
export const optOut = defineUpdate<ActionResult, [{ candidateId: string }]>('optOut');
const unavailable = (): ActionResult => ({ ok: false, code: 'unavailable', message: 'This offer is no longer available. You remain on the waitlist.' });


export async function waitlistWorkflow(input: OpeningInput): Promise<OpeningState> {
  const now = () => new Date(Date.now()).toISOString();
  const normalize = (value: string) => value.trim().toLowerCase();
  const slotStart = Date.parse(input.slot.startsAt);
  const slotEnd = slotStart + input.slot.durationMinutes * 60_000;
  const candidates: EligibleCandidate[] = input.waitlist.map(candidate => {
    let reason = 'Eligible — oldest waitlist join gets priority';
    if (candidate.optedOut) reason = 'Opted out of texts';
    else if (normalize(candidate.service) !== normalize(input.slot.service)) reason = 'Different service';
    else if (candidate.preferredStylist && normalize(candidate.preferredStylist) !== 'any' && normalize(candidate.preferredStylist) !== normalize(input.slot.stylist)) reason = 'Requires a different stylist';
    else if (Date.parse(candidate.availableFrom) > slotStart || Date.parse(candidate.availableUntil) < slotEnd) reason = 'Not available for the full appointment';
    return { ...candidate, eligible: reason.startsWith('Eligible'), reason };
  }).sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt) || a.id.localeCompare(b.id));
  const state: OpeningState = {
    workflowId: workflowInfo().workflowId, phase: 'offering', slot: input.slot, candidates, offers: [], currentOffer: null,
    acceptedCandidate: null, squareUpdateRequired: false, offerWindowSeconds: input.demoMode ? (input.offerWindowSeconds ?? 20) : 900,
    demoMode: input.demoMode === true, timeZone: 'America/Phoenix', timeline: [], createdAt: now(),
  };
  const event = (type: string, message: string) => state.timeline.push({ at: now(), type, message });
  let requestedDeliveryAction: 'retry' | 'skip' | undefined;
  let activeDeliveryScope: CancellationScope | undefined;
  const isCancelled = () => state.phase === 'cancelled';
  const appointmentStarted = () => Date.now() >= slotStart;

  setHandler(getOpening, () => state);
  setHandler(respondToOffer, response => {
    const offer = state.currentOffer;
    if (!offer || state.phase !== 'offering' || offer.status !== 'active' || offer.id !== response.offerId || offer.candidateId !== response.candidateId) return unavailable();
    if (Date.now() >= Date.parse(offer.expiresAt!) || appointmentStarted()) {
      offer.status = 'expired'; event('expired', `${offer.candidateName}'s offer expired.`); return unavailable();
    }
    if (response.decision !== 'accept' && response.decision !== 'decline') return { ok: false, code: 'invalid', message: 'Choose accept or decline.' };
    if (response.decision === 'accept') {
      // Reserve before yielding so concurrent responses cannot fill twice.
      offer.status = 'accepted'; state.phase = 'filled';
      state.acceptedCandidate = candidates.find(candidate => candidate.id === offer.candidateId)!;
      state.squareUpdateRequired = true;
      event('accepted', `${offer.candidateName} accepted. Opening filled; staff must update Square manually.`);
      return { ok: true, code: 'accepted', message: 'You have accepted this appointment. The salon will update its schedule.' };
    }
    offer.status = 'declined';
    event('declined', `${offer.candidateName} declined and remains on the waitlist. Moving to the next eligible client.`);
    return { ok: true, code: 'declined', message: 'Thanks for letting us know. You remain on the waitlist.' };
  });
  setHandler(cancelOpening, ({ reason }) => {
    if (state.phase === 'filled' || state.phase === 'unfilled' || isCancelled()) return { ok: false, code: 'closed', message: 'This opening is already closed.' };
    state.phase = 'cancelled';
    activeDeliveryScope?.cancel();
    if (state.currentOffer && !['declined', 'expired', 'skipped', 'opted_out'].includes(state.currentOffer.status)) state.currentOffer.status = 'cancelled';
    event('cancelled', `Staff cancelled the opening${reason ? `: ${reason}` : '.'} All offer links are unavailable.`);
    return { ok: true, code: 'cancelled', message: 'Opening cancelled. The contacted client can no longer accept.' };
  });
  setHandler(deliveryAction, action => {
    const offer = state.currentOffer;
    if (state.phase !== 'needs_attention' || !offer || offer.status !== 'delivery_failed' || offer.id !== action.offerId || appointmentStarted()) return { ok: false, code: 'unavailable', message: 'This delivery issue is no longer awaiting action.' };
    if (action.action !== 'retry' && action.action !== 'skip') return { ok: false, code: 'invalid', message: 'Choose retry or skip.' };
    requestedDeliveryAction = action.action; state.phase = 'offering'; offer.status = action.action === 'retry' ? 'sending' : 'skipped';
    event(action.action, action.action === 'retry' ? `Staff requested another delivery attempt for ${offer.candidateName}.` : `Staff skipped ${offer.candidateName}; they remain on the waitlist.`);
    return { ok: true, code: action.action, message: action.action === 'retry' ? 'Retrying simulated text delivery.' : 'Moving to the next eligible client.' };
  });
  setHandler(optOut, ({ candidateId }) => {
    const candidate = candidates.find(item => item.id === candidateId);
    if (!candidate) return { ok: false, code: 'invalid', message: 'Client not found.' };
    candidate.optedOut = true; candidate.eligible = false; candidate.reason = 'Opted out of texts';
    const offer = state.currentOffer;
    if (offer?.candidateId === candidateId && ['active', 'sending', 'delivery_failed'].includes(offer.status)) {
      activeDeliveryScope?.cancel();
      offer.status = 'opted_out'; requestedDeliveryAction = 'skip';
      if (state.phase === 'needs_attention') state.phase = 'offering';
    }
    event('opted_out', `${candidate.name} opted out. Their pending offer is unavailable; no further texts will be sent in this opening.`);
    return { ok: true, code: 'opted_out', message: 'Text opt-out recorded for this opening. Update the source waitlist before future outreach.' };
  });

  event('created', `Opening created for ${input.slot.service} with ${input.slot.stylist}. ${candidates.filter(c => c.eligible).length} eligible clients, ordered by waitlist join time.`);
  if (state.demoMode) event('demo', `Demo mode: simulated open salon, ${state.offerWindowSeconds}-second response windows. No real texts or Square writes.`);
  async function waitForBusinessHours(): Promise<boolean> {
    if (isCancelled() || appointmentStarted()) return false;
    const next = state.demoMode ? Date.now() : nextBusinessTime(Date.now());
    if (next > Date.now()) {
      state.phase = 'waiting_for_hours'; state.nextActionAt = new Date(Math.min(next, slotStart)).toISOString();
      event('waiting_for_hours', `Outreach pauses until ${state.nextActionAt} (Tue–Sat, 09:00–18:00 America/Phoenix).`);
      await condition(() => isCancelled(), Math.max(1, Math.min(next, slotStart) - Date.now()));
      state.nextActionAt = undefined;
    }
    if (isCancelled() || appointmentStarted()) return false;
    state.phase = 'offering'; return true;
  }
  for (const candidate of candidates.filter(candidate => candidate.eligible)) {
    if (!(await waitForBusinessHours())) break;
    if (candidate.optedOut) continue;
    const current: Offer = { id: `${state.workflowId}:offer:${state.offers.length + 1}`, candidateId: candidate.id, candidateName: candidate.name, status: 'sending', deliveryAttempts: 0 };
    state.offers.push(current); state.currentOffer = current;
    let delivered = false;
    while (!delivered && !isCancelled() && !appointmentStarted() && !candidate.optedOut) {
      if (!(await waitForBusinessHours())) break;
      // STOP can arrive while the business-hours timer is pending.
      if (candidate.optedOut || isCancelled() || appointmentStarted()) break;
      current.deliveryAttempts++; current.status = 'sending';
      event('sending', `Sending a simulated offer text to ${candidate.name}.`);
      const deliveryScope = new CancellationScope();
      activeDeliveryScope = deliveryScope;
      try {
        const receipt = await deliveryScope.run(() => sendOffer({ workflowId: state.workflowId, offerId: current.id, slot: input.slot, candidate, offerWindowSeconds: state.offerWindowSeconds, deliveryAttempt: current.deliveryAttempts, demoMode: state.demoMode }));
        if (isCancelled() || candidate.optedOut) break;
        Object.assign(current, receipt, { status: 'active', deliveryError: undefined });
        delivered = true; event('offered', `${candidate.name} has the only active offer until ${receipt.expiresAt}.`);
      } catch (error) {
        const cause = (error as { cause?: { type?: string } }).cause;
        if (cause?.type === 'OutsideBusinessHours') {
          event('delivery_deferred', 'Delivery retry reached closing time. Waiting durably for business hours before any text is sent.');
          continue;
        }
        if (isCancelled() || candidate.optedOut || appointmentStarted()) break;
        current.status = 'delivery_failed'; current.deliveryError = 'Simulated text delivery failed after 3 automatic attempts. Staff can retry or skip.';
        state.phase = 'needs_attention'; event('delivery_failed', `${candidate.name}: ${current.deliveryError}`);
        requestedDeliveryAction = undefined;
        await condition(() => requestedDeliveryAction !== undefined || isCancelled() || !!candidate.optedOut, Math.max(1, slotStart - Date.now()));
        if (requestedDeliveryAction === 'skip' || isCancelled() || candidate.optedOut || appointmentStarted()) break;
      } finally {
        if (activeDeliveryScope === deliveryScope) activeDeliveryScope = undefined;
      }
    }
    if (isCancelled() || appointmentStarted()) break;
    if (!delivered) continue;
    const responded = await condition(() => current.status !== 'active' || isCancelled(), Math.max(1, Date.parse(current.expiresAt!) - Date.now()));
    if (!responded && current.status === 'active') {
      current.status = 'expired'; event('expired', `${candidate.name}'s offer expired. They remain on the waitlist.`);
    }
    if (state.acceptedCandidate || isCancelled()) break;
  }
  if (!state.acceptedCandidate && !isCancelled()) {
    if (state.currentOffer && ['active', 'sending', 'delivery_failed'].includes(state.currentOffer.status)) state.currentOffer.status = 'expired';
    state.phase = 'unfilled'; state.currentOffer = null;
    event('unfilled', appointmentStarted() ? 'Appointment start reached. Outreach stopped; opening remains unfilled.' : 'All eligible clients were tried or no eligible clients matched. Opening remains unfilled; staff attention is needed.');
  }
  return state;
}
