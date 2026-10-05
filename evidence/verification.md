# Verification record

Verified locally on October 5, 2026 using fictional client data. SMS delivery is simulated; no real texts or Square writes were performed.

## Automated checks

`npm run typecheck` passed. `npm test` passed **4 of 4 test groups, with 0 failures**. The suite uses real Temporal test servers, including time-skipping for durable deadlines. Expected provider failures are deliberately injected; their warning logs are not failed assertions. Source: [tests/workflow.test.ts](../tests/workflow.test.ts).

The workflow group checks these **14 scenarios**:

1. Service, required stylist, full appointment availability, opt-out filtering, and oldest-first ordering.
2. Decline automatically advances; the old client cannot claim the next offer; valid acceptance fills it and requires manual Square entry.
3. A 15-minute durable timer expires, advances, and eventually marks an exhausted opening unfilled.
4. Concurrent duplicate accepts produce at most one successful claim.
5. A wrong recipient cannot accept; staff cancellation invalidates the pending offer.
6. Pending opt-out invalidates the offer and advances without removing the client from the waitlist.
7. Bounded delivery failures become visible; staff retry restores the same recipient.
8. Staff skip advances past failed delivery.
9. Appointment start expires the current offer and prevents further outreach.
10. Normal mode waits for Tuesday 09:00 Phoenix and enforces a 15-minute response window.
11. An appointment before reopening ends unfilled without sending.
12. Delivery crossing Saturday closing waits durably until Tuesday reopening.
13. STOP during an overnight failed-delivery retry prevents that client being contacted when the salon reopens.
14. No eligible clients produces an explicit unfilled result without outreach.

The other three test groups verify:

- Six Phoenix business-hour boundary cases, including Tuesday opening and Saturday closing.
- The actual filesystem provider: five concurrent retry calls produce one persisted receipt with the same deadline; a later invocation reuses it. Past appointment starts and opted-out snapshots create no new outbox entry.
- Two real Temporal tests hold the actual provider immediately before publication. STOP cancels the held delivery and only the next eligible client receives a record. Staff cancellation publishes no record and never advances to another client.

## Forced worker restart and HTTP checks

The live worker was forcibly stopped with **SIGKILL** after an offer was created, then restarted against the same Temporal service and local delivery ledger. The verifier completed at **19:25:59 UTC / 12:25:59 p.m. PDT**. Results are recorded in [recovery-results.json](recovery-results.json); the reproducible verifier is [scripts/recovery-check.mjs](../scripts/recovery-check.mjs).

The original workflow ID, offer ID, send time, and deadline survived. The deadline remained `2026-10-05T19:31:25.867Z`; restart did not create a duplicate offer or receipt. A subsequent decline automatically advanced to the next client. Simultaneous HTTP acceptance requests returned one `200` and one `409`; a stale first-client acceptance returned `409`. Exactly one offer was accepted, with the manual Square reminder present. Creating the same stylist/start with a different row ID and stylist capitalization also returned `409` and the existing workflow ID.

This live restart occurred **before** the original deadline. Expiry and appointment-cutoff behavior are covered by the automated Temporal scenarios above; no separate live expiry-during-downtime result is claimed.

## Browser checks and screenshots

The staff interface was opened in a browser and checked for off-hours deferral, duplicate-opening rejection, and rejection of an expired client's acceptance. The persisted filled/unfilled states and manual Square reminder were inspected. Evidence:

- [business-hours.jpg](business-hours.jpg): normal mode waits until Tuesday 09:00 Phoenix.
- [late-reply.jpg](late-reply.jpg): expired offer, automatic progression history, and the unavailable reply. This screenshot predates the final layout simplification.
- [juniper-dashboard.jpg](juniper-dashboard.jpg): filled and unfilled openings, including manual Square follow-up.
- [temporal-workflow.jpg](temporal-workflow.jpg): the actual completed recovery workflow, ID, status, and Temporal history view.

**Browser cancellation was not completed:** the automation encountered the native confirmation dialog. Cancellation is verified at the Workflow/provider level by automated tests, but this record does not claim an end-to-end browser cancellation check. Nor does it claim every control was exercised in the browser.

## Practical limits

The prototype is local and unauthenticated. The client reply screen is a simulator. Square reconciliation and real SMS delivery, consent enforcement, provider webhook handling, and operational monitoring require production integrations. The waitlist is stored in one browser; it is not a shared multi-device source of truth. Consent updates are propagated to loaded active workflows, with future outreach relying on saved source consent. Exact stylist/start duplicates are prevented; differently-started overlapping appointments are not detected.

The filesystem ledger verifies local simulated-provider behavior. It does not establish exactly-once delivery guarantees for a future external SMS provider. Tests demonstrate the listed cases, not an exhaustive guarantee against every distributed-system failure. The customer's approximate 3-of-10 current fill rate and proposed 5-of-10 target are baseline and goal, not measured prototype outcomes.
