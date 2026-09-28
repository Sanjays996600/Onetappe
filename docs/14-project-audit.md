# One Tappe: project audit against the working rules and design guidelines

**Date:** 28 Sep 2026.
**Commit audited:** `dd134ea` on `claude/appointment-booking-app-design-tqp3ip`.
**Measured against:** [CLAUDE.md](../CLAUDE.md) and
[13-system-design-guidelines.md](13-system-design-guidelines.md).

Everything below was re-run or re-read for this audit. Findings from
[12-production-readiness-gate.md](12-production-readiness-gate.md) were re-checked against
the code, not copied.

---

## 1. Verification run (this audit)

| Check                                           | Result                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Lint, format, typecheck                         | Pass                                                                           |
| Build (API, worker, admin, both app web builds) | Pass                                                                           |
| API tests (PostgreSQL, least-privilege role)    | 31 files, **301 / 301 pass**                                                   |
| Domain / API client / mobile kit / admin        | 23 / 7 / 3 / 7 pass                                                            |
| Browser E2E (whole system)                      | **7 / 7 pass**. Needs `E2E_CHROMIUM_PATH` in this container; see note below    |
| Restore drill                                   | Pass (dump 1 s, restore 1 s; data, triggers, constraints, privileges verified) |
| GitHub CI #38 and Security #25 on `dd134ea`     | Green                                                                          |

**Note on the E2E run:** the first local run failed in 2 tests and skipped 5. The cause was
the environment, not the code. This container's pre-installed Chromium (build 1194) doesn't
match the build the pinned Playwright expects, so the browser never launched. The rerun
with `E2E_CHROMIUM_PATH` pointing at the installed browser passed 7 of 7, as CI does.

The API log shows `connect ETIMEDOUT api.razorpay.com`. That comes from
`failure-scenarios.test.ts`, which simulates an unreachable gateway on purpose.

---

## 2. Size and hygiene

| Area               | Lines  |
| ------------------ | ------ |
| API source         | 21,591 |
| API tests          | 10,121 |
| SQL migrations     | 3,633  |
| Admin panel        | 2,193  |
| Customer app       | 2,192  |
| Worker app         | 1,201  |
| Shared packages    | 3,227  |
| E2E and load tests | 1,083  |

The database has 87 tables.

| Check                                       | Result                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `any`, `@ts-ignore`, `@ts-expect-error`     | **0**                                                                                                      |
| `eslint-disable`                            | 2, both a documented React hook-dependency exception                                                       |
| Skipped or focused tests (`.skip`, `.only`) | **0** (the 4 matches are a notification "skip" helper, not tests)                                          |
| `TODO` / `FIXME`                            | 0 (the 2 matches are the `+91XXXXXXXXXX` format in comments)                                               |
| `console.log`                               | Only in command-line tools (migration, staff bootstrap, load test)                                         |
| Test-to-source ratio (API)                  | About 1 : 2                                                                                                |
| Largest files                               | About 600–630 lines (`customer.service`, `worker.service`, `pricing-config.controller`, `payment.service`) |

**Verdict:** clean. The biggest services are near the size where splitting helps. Per the
rules, they are split only when a change touches them, not rewritten for style (A5).

---

## 3. Conformance to CLAUDE.md

| Rule                                                                         | Evidence                                                                                                                         | Status             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Booking, pricing, availability and payment state authoritative in PostgreSQL | State machine and exclusion constraints in the database; no endpoint accepts a status from a client                              | Conforms           |
| No business logic in the apps                                                | No price, amount or total arithmetic found in any app or in `mobile-kit`; the API re-checks everything (`authorization.test.ts`) | Conforms           |
| Payment confirmed only server-side through the provider                      | Signed webhook, order queried from the server, `reconcile-payments` job; never confirmed from the app                            | Conforms (A1, G6)  |
| Webhooks idempotent                                                          | Deduplicated by event id; unique constraints for one capture per booking                                                         | Conforms           |
| No card data stored                                                          | Hosted checkout only                                                                                                             | Conforms           |
| No master or static OTP in production                                        | Refused at start-up outside tests                                                                                                | Conforms           |
| No hard-coded or committed secrets                                           | gitleaks in CI; start-up refuses placeholder secrets                                                                             | Conforms           |
| Money as integers                                                            | `amount_paise bigint` everywhere; no float money in the API                                                                      | Conforms           |
| Invariants in the database                                                   | 277 check, 46 unique and 3 exclusion constraints; append-only history; audit triggers                                            | Conforms           |
| Authorization on every route and object                                      | `route-policy.test.ts` covers every route; IDOR/BOLA tests                                                                       | Conforms           |
| No external calls in database transactions                                   | Checked in the gate by scanning every transaction body                                                                           | Conforms           |
| Zoho outage doesn't stop bookings                                            | Outbox plus circuit breaker; tested                                                                                              | Conforms           |
| PostgreSQL not public                                                        | No infrastructure exists yet; this is a design rule for staging (Q-I1)                                                           | Not yet applicable |
| Tests with every change; errors not suppressed                               | 341 automated tests plus E2E; flakes were root-caused, none skipped                                                              | Conforms           |

---

## 4. Conformance to the system design guidelines

| Guideline chapter                         | What One Tappe does                                                                                                                         | Status                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1 Scaling                                 | Stateless API and a separate worker process; sessions in the database; one primary database; no premature sharding                          | Conforms (right-sized for a pilot)                                    |
| 2 Estimation                              | Load test: 100 phones, about 250 reads/s on one instance with 10 connections                                                                | Conforms; repeat on staging                                           |
| 3 Framework                               | Scope, questions and decisions logged in docs 03 and 12                                                                                     | Conforms                                                              |
| 4 Rate limiter                            | Per session, per IP and a sensitive group; 429 with `Retry-After`; edge limits pending (B3)                                                 | Conforms (edge pending)                                               |
| 7 Unique IDs                              | UUIDs plus sequential invoice series                                                                                                        | Conforms                                                              |
| 10 Notification system                    | Outbox, routing, templates, consent, dedupe keys, retries, per-channel dispatch                                                             | Conforms; device registration missing (G2)                            |
| 16 Proximity                              | Server-side serviceability by distance from the service-location centre                                                                     | Conforms at pilot scale; geohash only if search by distance is needed |
| 19 Message queue semantics                | Outboxes and leased jobs in PostgreSQL (at-least-once plus dedupe = effectively once); dead letter for Zoho                                 | Conforms; no separate queue service needed                            |
| 20 Metrics and alerting                   | Metrics, backlog gauges, alert rules; stack not deployed (B1); OTP and security alerts missing (H1)                                         | Partial                                                               |
| 21 Reconciliation                         | Order-status reconciliation every minute for open payments                                                                                  | Partial (A1)                                                          |
| 22 Hotel reservation (closest to booking) | Idempotency keys with unique constraints; the database as the final guard (exclusion constraint); bounded retry; 100-way concurrency tested | **Strong**                                                            |
| 24 Object storage                         | Private S3 with KMS, malware scan, purge job                                                                                                | Conforms                                                              |
| 26 Payment system                         | Hosted page, webhook as the truth, idempotency key to the gateway, retries, amount check, two-person refunds                                | Conforms except A1, A2, G6                                            |
| 27 Wallet / ledger                        | No wallet (correctly out of scope)                                                                                                          | Not applicable                                                        |

---

## 5. New findings in this audit

| #   | Finding                                                                                                                                                                                                                                                                                                                           | Severity                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A1  | **No settlement-file reconciliation.** `reconcile-payments` re-queries open orders from the last two days. Nothing compares Razorpay's daily **settlement report** with captured payments, refunds and invoices, as chapter 26 requires. A capture or refund missed by both the webhook and the 2-day window would never surface. | Production blocker (before live money)   |
| A2  | **No double-entry ledger.** Money is recorded as rows in the payment, refund, earning and payout tables, all append-only or audited. There is no single ledger where every movement debits one account and credits another and the entries sum to zero. That makes finance reports and payouts harder to prove correct.           | Decision; recommended before payouts     |
| A3  | **G8 in document 12 was wrong.** The pool **is** configurable through `DATABASE_POOL_MAX` (1–100, default 10) and has been since the booking-engine commit. What remains is sizing it per server and adding PgBouncer on staging.                                                                                                 | Correction (doc 12 updated)              |
| A4  | **Local E2E depends on the container's browser build.** CI installs its own browser. Locally, `E2E_CHROMIUM_PATH` must be set, but `CLAUDE.md` doesn't mention it.                                                                                                                                                                | Developer experience (CLAUDE.md updated) |
| A5  | **Four services are about 600 lines.** They are well structured and fully tested. Split them only when a change touches them.                                                                                                                                                                                                     | Later                                    |

---

## 6. Findings from document 12, re-checked

| #   | Finding                                                                                                                                                                             | Still open?                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| G1  | Admin panel covers only bookings, staff and system                                                                                                                                  | **Yes.** 10 pages, none for safety, support, refunds, workers, customers, configuration or audit |
| G2  | Apps don't register for push                                                                                                                                                        | **Yes**                                                                                          |
| G3  | No worker onboarding screens                                                                                                                                                        | **Yes** (Q-O3 decides)                                                                           |
| G4  | Training and verification configuration only by migration                                                                                                                           | **Yes**                                                                                          |
| G5  | No housekeeping for OTP, sessions, job runs, notifications                                                                                                                          | **Yes.** Only `purge-documents` exists                                                           |
| G6  | Webhook checks the amount, not the currency                                                                                                                                         | **Yes.** `AMOUNT_MISMATCH` exists; the currency isn't compared                                   |
| G7  | Missing indexes on `user_device(user_id)`, `refund(payment_id)`, `payment_event(payment_id)`, `notification(booking_id)`, `safety_incident(booking_id)`, `worker_payout(worker_id)` | **Yes** (only `refund(booking_id)` and `notification(user_id)` exist)                            |
| G8  | Pool not configurable                                                                                                                                                               | **No**, see A3                                                                                   |
| G9  | Deep links, screenshot protection                                                                                                                                                   | **Yes**                                                                                          |
| G10 | Razorpay docs not re-checked                                                                                                                                                        | **Yes** (network policy)                                                                         |
| G11 | No second person for worker activation                                                                                                                                              | **Yes** (Q-R2 decides)                                                                           |

Blockers B1–B8 (infrastructure, staging, providers, devices, data-protection rights,
retention, independent review) and questions Q-I1–Q-O3 are unchanged: **none has been
answered yet.**

---

## 7. Overall assessment

- **Foundation (database, booking engine, concurrency, auth, authorization, payments core,
  jobs, observability code, tests, CI):** strong, and it conforms to both the rules and the
  guidelines. Nothing needs rewriting.
- **Still needed for a pilot:**
  - admin screens (G1);
  - push and deep links (G2, G9);
  - onboarding (G3, or staff-led);
  - infrastructure and staging (B1);
  - live providers (B2, B4);
  - device tests (B5).
- **Still needed for production:**
  - the items above;
  - A1, and A2 if chosen;
  - G4, G5;
  - payouts;
  - data-protection rights (B6), KYC retention (B7), independent review (B8).

## 8. Proposed order to start work

1. **Foundation fixes that need no business input:**
   - G6: currency check, and a currency- and amount-mismatch test;
   - G7: indexes (one migration);
   - A1: settlement reconciliation design, then build (format from Razorpay's settlement API once the docs can be re-checked, G10);
   - G4: configuration API for training and verification requirements.
2. **G5 housekeeping jobs.** The mechanism can be built now; the retention periods need Q-L1.
3. **Admin panel, pilot-critical screens first** (safety, support, refunds, workers, customers, configuration, audit).
4. **Push and deep links in both apps; onboarding if chosen.**
5. **Infrastructure, staging and providers**, once Q-I1–Q-I4, Q-P1 and Q-M1 are answered.
6. **Decision on A2 (ledger)** before building payouts.
