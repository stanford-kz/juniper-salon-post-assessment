# Juniper Salon

A local waitlist prototype built from a customer conversation with Lena, the owner of Juniper Salon. It uses real Temporal Workflows to offer one cancelled appointment to one eligible client at a time, remember the deadline, and continue after a decline, timeout, or worker restart.

**This is a prototype. SMS delivery is simulated. Staff still update Square themselves. No real client is contacted.**

## Run locally

Requirements: Node.js 20 or newer and Docker Desktop running. From the repository directory, run this single command:

```sh
npm ci && npm run dev
```

Open **http://localhost:3000**. Inspect the actual workflow history at **http://localhost:8233**. The local Temporal service uses port 7233. All published service ports bind to loopback. The first run downloads the Temporal Docker image and npm packages.

The page offers two explicitly different modes:

- **Salon rules:** 15-minute offers, Phoenix time, Tuesday–Saturday 9 a.m.–6 p.m. Outreach entered outside those hours waits durably until reopening. Contact ends at the appointment start.
- **Demonstration:** an explicitly simulated open salon and short response windows, so the process can be exercised in minutes even when the salon is closed. Texts remain simulated in both modes.

Stop the API and worker with Ctrl+C. Stop Temporal with `npm run stop`. Temporal history remains in the Docker volume; restarting the app does not reset an offer's deadline. Keep the local `.data/` folder when testing recovery because it contains the simulated delivery ledger. Do not commit that folder or use real client information.

## What Lena asked for

Lena and Carla currently find cancellations in Square, scan a Google Sheet, and text clients. Two staff members once offered the same Saturday opening to different clients, and both said yes. Lena initially suggested broadcasting texts. After discussing that incident, she chose one-at-a-time offers in waitlist order.

The recorded discovery is in [docs/customer-discovery.txt](docs/customer-discovery.txt). The key requirements are:

1. Match the service, appointment availability, and required stylist. Skip clients who opted out of texts. Offer the opening to the earliest eligible waitlist entry.
2. Give one client 15 minutes. A decline or timeout advances to the next eligible person automatically. Declining or missing an offer does not remove the client from the saved waitlist.
3. Show the service, stylist, appointment date and time, and offer expiry. A valid acceptance fills the opening and prompts staff to update Square. Old or repeated replies cannot claim it again.
4. Let staff cancel an opening. Make delivery failures visible, with retry and skip controls. Show an exhausted opening as unfilled.
5. Show the current recipient, the remaining queue, and a history of declines, timeouts, and other changes. Resume after a restart with the same offer and deadline.
6. Use America/Phoenix business hours, Tuesday–Saturday 09:00–18:00. Defer new outreach while closed. End a pending offer if its client opts out. Stop outreach at the appointment start.

Lena estimates that she currently fills **about 3 of 10** last-minute cancellations. Her proposed trial target is **at least 5 of 10**, with less repeated checking. Those are customer-reported baseline and target figures, not measured prototype results.

## Demonstration

Use fictional clients and the clearly labeled demonstration mode.

1. Review the saved waitlist and create an opening that matches at least two opted-in clients.
2. Observe the first offer. Let it expire and watch the next offer begin without a staff action.
3. Accept the current offer in the client response simulator. The opening should fill and display the manual Square follow-up.
4. Select an earlier offer in the simulator and try accepting it. The reply should be rejected as no longer available.
5. Create a separate opening with simulated delivery failure. Use the staff retry or skip control.
6. Create another opening, then cancel it or opt out the current recipient. Inspect the resulting history and response behavior.
7. In salon-rules mode, verify that a closed salon schedules outreach for the next opening time.

The simulator is an evaluator tool, not an authenticated client portal. It deliberately permits selecting old offers to exercise late replies.

## Where Temporal matters

- A Workflow owns each opening's offer sequence and booking decision.
- Temporal timers preserve response deadlines and off-hours waits in durable history.
- Workflow messages handle replies and staff decisions. Validation occurs against the current recipient, offer, and deadline before changing the opening.
- Queries supply the staff board with durable state and event history.
- Activities perform simulated message delivery. Stable delivery identifiers and a persisted local ledger protect against duplicate simulated deliveries on retry.

The browser's countdown is only a display. It does not decide whether an offer has expired. The server and workflow remain authoritative when the browser closes.

## Checks and evidence

```sh
npm run typecheck
npm test
```

Workflow tests use Temporal's test environment. Its test server may download on first use. See [evidence/verification.md](evidence/verification.md) for the checks actually performed and their outcomes, including browser and recovery checks. The `evidence/` directory also contains the required Temporal Web UI screenshot. Presentation slides are in `presentation/`.

## Boundaries and next step

The prototype has no real SMS provider, Square integration, authentication, multi-device shared waitlist database, or production monitoring. The saved waitlist is local browser data; active workflow state is durable in Temporal. The local delivery ledger is a development substitute for a transactional provider integration. Exact duplicate stylist/start combinations are blocked; a production booking integration must also reject partially overlapping slots and reconcile external Square changes.

Production work would need verified contact consent, authenticated client response links, shared customer records, provider idempotency and webhook handling, and reconciliation with Square. A next step is a small supervised trial with Lena and Carla after those integrations and controls are in place. Record openings refilled / eligible cancellations, staff touches per opening, delivery failures, and any conflicting promise. Compare with Lena's baseline before expanding.

## Source

Created as a new public, non-fork repository from the supplied [Temporal assessment starter](https://github.com/john-b-yang/temporal-waitlist-assessment-starter). Application-specific behavior follows the recorded customer discovery. The application is intended for local evaluation and has not been publicly deployed.
