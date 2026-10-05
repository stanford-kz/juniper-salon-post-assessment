export type Slot = { id?: string; service: string; stylist: string; startsAt: string; durationMinutes: number };
export type Candidate = {
  id: string; name: string; mobile: string; service: string; preferredStylist: string | null;
  availableFrom: string; availableUntil: string; joinedAt: string; simulateFailure?: boolean; optedOut?: boolean;
};
export type OpeningInput = { slot: Slot; waitlist: Candidate[]; offerWindowSeconds?: number; demoMode?: boolean };
export type EligibleCandidate = Candidate & { eligible: boolean; reason: string };
export type OfferStatus = 'sending' | 'active' | 'accepted' | 'declined' | 'expired' | 'cancelled' | 'delivery_failed' | 'skipped' | 'opted_out';
export type Offer = {
  id: string; candidateId: string; candidateName: string; status: OfferStatus; deliveryAttempts: number;
  sentAt?: string; expiresAt?: string; message?: string; deliveryError?: string;
};
export type OpeningState = {
  workflowId: string; phase: 'offering' | 'waiting_for_hours' | 'needs_attention' | 'filled' | 'unfilled' | 'cancelled';
  slot: Slot; candidates: EligibleCandidate[]; offers: Offer[]; currentOffer: Offer | null;
  acceptedCandidate: Candidate | null; squareUpdateRequired: boolean; offerWindowSeconds: number;
  demoMode: boolean; timeZone: string; nextActionAt?: string;
  timeline: { at: string; type: string; message: string }[]; createdAt: string;
};
export type ActionResult = { ok: boolean; code: string; message: string };
export type RespondInput = { offerId: string; candidateId: string; decision: 'accept' | 'decline'; requestId?: string };
export type DeliveryActionInput = { offerId: string; action: 'retry' | 'skip' };
export type DeliveryInput = {
  workflowId: string; offerId: string; slot: Slot; candidate: Candidate; offerWindowSeconds: number; deliveryAttempt: number; demoMode: boolean;
};
export type DeliveryReceipt = { id: string; sentAt: string; expiresAt: string; message: string; channel: 'simulated_sms' };
