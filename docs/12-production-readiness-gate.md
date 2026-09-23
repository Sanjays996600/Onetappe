# One Tappe — Engineering gate: production readiness

**Date:** 23 Sep 2026.
**Commit reviewed:** `d1f6632` on `claude/appointment-booking-app-design-tqp3ip`.
**Database:** migrations 0001–0026.

Everything below was checked against the code, the migrated database and the running
system, not against earlier documents. Where earlier documents disagree with this one, this
one is current. [11-security-readiness.md](11-security-readiness.md) has the
personal-data map and the security controls in depth; it is referenced, not repeated.

---

## 1. Evidence gathered for this gate

| Check                                                           | Result (this commit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, typecheck, build                                  | All pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Domain / client / mobile kit / admin                            | 23 / 7 / 3 / 7 tests pass                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| API (PostgreSQL, least-privilege role)                          | 31 files, 301 tests pass (including the 8 new gate tests below). The full suite was run 4 times after the last flake fix                                                                                                                                                                                                                                                                                                                                                              |
| Browser E2E (built API, worker, admin, both app web builds)     | 7 tests pass, including the full cross-app journey and the log-leak scan                                                                                                                                                                                                                                                                                                                                                                                                              |
| Restore drill                                                   | Pass: row counts, content checksums, triggers, constraints, append-only refusal and runtime-role privileges verified on the restored copy                                                                                                                                                                                                                                                                                                                                             |
| CI                                                              | Run #35 green on all jobs (the preceding run #34 failed only the generated-types check, fixed in `d1f6632`)                                                                                                                                                                                                                                                                                                                                                                           |
| **New: concurrency** (`test/security/concurrency-gate.test.ts`) | **Bookings:** 2, 10, 50 and **100** simultaneous bookings for one worker's slot give exactly one winner each time; every loser gets `NO_AVAILABILITY`, never a crash. Partially overlapping starts inside the travel buffer: exactly one wins. **Reschedules:** two into one slot, one; a reschedule racing a new booking, one; 20 into the last free slot, exactly one. The loser keeps its original time. **Result:** zero overlapping reservations after every run, on 3 of 3 runs |
| **New: load test** (`e2e/load/load-test.ts`)                    | See §5. **Result:** 4,860 requests from 100 simulated phones, 0 server errors, exactly 20 bookings for 20 workers, 20 payments captured once each, 0 overlaps, 0 failed jobs                                                                                                                                                                                                                                                                                                          |
| Razorpay current documentation                                  | **Could not be re-checked.** This environment's network policy blocks razorpay.com. The implementation matches the documented contract as studied earlier (§4, phase 10); a re-check against the live documentation is listed as required                                                                                                                                                                                                                                             |

---

## 2. Architecture as implemented

The implementation matches the intended architecture.

```
Customer app (Expo) ─┐
Worker app (Expo) ───┼─ HTTPS ─> NestJS modular monolith (one API process type)
Admin panel (Next.js)┘  (the admin browser never holds tokens: its server holds a sealed session)
                            │  global guard: token → live session → account status →
                            │  app → worker status → permission (+city) → fresh MFA
                            │  rate limits (per session / per IP / tighter for sensitive routes)
                            ▼
      auth · customer · worker · booking (quotes, creation, lifecycle, dispatch) · pricing ·
      payments (orders, webhooks, reconciliation, refunds, settlement, invoices) · support ·
      safety (paging, escalation) · legal/consent · configuration · staff · storage
                            ▼
      PostgreSQL 16: the source of truth. State machine and exclusion constraints in the
      database, append-only history, audit triggers, least-privilege runtime role
                            ▼
      Background worker (same codebase, separate process): leased idempotent jobs +
      transactional outboxes for notifications and Zoho
                            ▼
      Razorpay · MSG91 · FCM · ZeptoMail (Zoho) · Zoho CRM/Desk · S3 (KMS) + ClamAV
      · Google Maps (client SDK only)
```

- **Source of truth:** booking, pricing, availability and payment state are authoritative
  only in PostgreSQL. The apps display it and send requests; Zoho receives copies.
- **No queue or cache service:** the outboxes and job leases live in PostgreSQL. This is
  deliberate at this scale, and safe with more than one instance (leases).
- **No microservices, and no business logic in the apps:** the apps hold only display
  rules, such as which button to show. The API re-checks everything, as
  `authorization.test.ts` proves.

---

## 3. What this gate found

These findings are **new**. Unless marked fixed, they appear in the matrix (§6).

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                               | Severity                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| G1  | **The admin panel covers only bookings, staff and system status.** No screens exist for customers, workers/verification/training, catalog, service areas, pricing/taxes/promotions/payout rules, refunds, support, safety (acknowledge, on-call roster), audit log, Zoho sync or notifications, although the API exists for all of these. There is **no admin API** for payment/invoice lookup or for worker payouts. | Pilot blocker                                                                    |
| G2  | **Neither app registers for push notifications.** The API and the FCM adapter are ready, but the apps never call `registerDevice` or ask for notification permission. A worker sees a job offer only while the app is open.                                                                                                                                                                                           | Pilot blocker                                                                    |
| G3  | **Worker onboarding screens are missing** (personal details, document upload, training status per item). The API, private storage and scanning are ready.                                                                                                                                                                                                                                                             | Pilot blocker (or manual onboarding by staff; your decision, Q-O3)               |
| G4  | **Training modules and verification requirements can be changed only by a migration** (no API or audit trigger). Operations would need developers to change them.                                                                                                                                                                                                                                                     | Production blocker                                                               |
| G5  | **No housekeeping jobs for operational data:** expired OTP challenges, revoked sessions, job-run history, delivered notifications. Nothing personal is exposed, but these tables grow without bound and hold phone numbers (OTP) longer than needed.                                                                                                                                                                  | Production blocker (retention)                                                   |
| G6  | **Payment webhooks check the amount but not the currency**, and no test sends an amount-mismatch webhook.                                                                                                                                                                                                                                                                                                             | Hardening, before live payments                                                  |
| G7  | **Some foreign keys used on hot paths have no index:** `user_device(user_id)` (every push), `refund(payment_id)`, `payment_event(payment_id)`, `notification(booking_id)`, `safety_incident(booking_id)`, `worker_payout(worker_id)`. The other unindexed foreign keys are actor columns on rarely-queried rows.                                                                                                      | Hardening                                                                        |
| G8  | **The database pool is fixed at 10 connections per process** (not configurable). Under 100 simultaneous phones one instance serves about 250 requests a second with p95 around 0.85 s (§5).                                                                                                                                                                                                                           | Hardening (configurable pool; sizing per server)                                 |
| G9  | **Deep links are not implemented** (the scheme is declared only). **Screenshot protection is absent** on the start code.                                                                                                                                                                                                                                                                                              | Deep links: pilot blocker if notifications link into the app; screenshots: later |
| G10 | **Razorpay: the live documentation could not be re-checked from this environment.**                                                                                                                                                                                                                                                                                                                                   | Required before live payments                                                    |
| G11 | **Separation of duties for workers:** the same `WORKER_OPERATIONS` person can verify documents **and** activate the worker; there is no second-person rule, unlike refunds. Business decision (Q-R2).                                                                                                                                                                                                                 | Decision needed                                                                  |

Fixed during this gate: nothing needed fixing in code. The two new test files and the
load-test harness are additions.

---

## 4. Phase-by-phase

| Phase                       | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Status                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1 Repository / architecture | §2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Conforms                                          |
| 2 Database                  | **Keys:** 87 tables, all with primary keys; 166 foreign keys, **all NO ACTION** (no cascade deletes). **Constraints:** 277 checks, 46 unique, 3 exclusion. **Protection:** money, people, bookings and safety tables are audited, need an action context and cannot be deleted; history tables are append-only. **Change control:** only migrations change the schema, and CI forbids editing an applied migration. **Gaps:** G4, G5, G7                                                                                                                                                                          | Strong                                            |
| 3 Concurrency               | §1 (up to 100-way; reschedule races). Deadlock and serialization retries are **bounded** (4 attempts, jittered backoff, only `40P01`/`40001`). **No external call is made inside a retried transaction** (checked by scanning every transaction body): gateway orders, SMS, Zoho, storage and scanning all run outside                                                                                                                                                                                                                                                                                            | Strong                                            |
| 4 State machine             | 22 transitions, each with its allowed channels and reason rules. Identical in the domain package and the database; parity is tested. Illegal transitions and wrong channels are refused, even for raw SQL (tested). No endpoint accepts a status from a client. **Your journey maps as follows:** quote is stateless; hold and payment pending are one status, `PENDING_PAYMENT`, with the slot held; offered, rejected and timeout are assignment states; rescheduled is a schedule change, not a status; payment failed and refunds are payment and refund states; intervention is `ON_HOLD` plus staff actions | Strong                                            |
| 5 Customer authentication   | OTP: 6 digits, 5-minute expiry, 5 attempts, newest code only, single use, 30 s resend, 5 per hour and 10 per day per phone, 20 per hour per network, phone locked for an hour after 10 wrong codes. No test or master OTP outside tests (refused at start-up). Same answer for known and unknown numbers. Refresh rotation with reuse detection; logout and sign-out-everywhere; request limits. MSG91 is built but not verified live                                                                                                                                                                             | Built; live MSG91 pending                         |
| 6 Worker eligibility        | Authentication and eligibility are separate. Status is checked on **every request** (a suspended worker's old token cannot reach offers or jobs; tested). The database checks eligibility at allocation: shift, service permission, verifications valid until the job ends, restrictions. Onboarding screens are missing (G3)                                                                                                                                                                                                                                                                                     | Strong backend; app screens missing               |
| 7 Staff and RBAC            | Password plus authenticator; fresh check for sensitive actions; roles loaded per request. Eight roles (§7). Every route's policy is tested (`route-policy.test.ts`). Decisions needed: Q-R1 to Q-R3                                                                                                                                                                                                                                                                                                                                                                                                               | Strong; decisions pending                         |
| 8 Data protection           | [11](11-security-readiness.md) §2–§4; IDOR/BOLA tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Strong; DPDP rights missing (B6)                  |
| 9 Mobile security           | Keychain/Keystore (this device only), no secrets in bundles, Android backups off, no business authority. Push (G2), deep links (G9), device testing (B5)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Partial                                           |
| 10 Razorpay                 | **Webhook:** raw-body HMAC-SHA256 checked in constant time against `X-Razorpay-Signature`, deduplicated by `x-razorpay-event-id`. **Order handling:** amount matched; the order is queried from the server ("I have paid" and reconciliation); capture is server-side. **Refunds:** policy, two people, cap, idempotent. **Failure cases:** duplicate, late and out-of-order webhooks tested; the booking is never confirmed from the app. G6, G10; live verification (B4)                                                                                                                                        | Built; live check pending                         |
| 11 Zoho                     | **Mechanics:** outbox, OAuth refresh under a lock, encrypted access token, rate-limit and timeout handling, circuit breaker, dead letter, retry and discard from the API, signed Desk webhook, once-keys against duplicates. **Boundary:** [11](11-security-readiness.md) §8. **Coverage:** CRM and Desk built; Mail through ZeptoMail; **SalesIQ not built** (Q-Z1); People/Projects not used (no requirement identified)                                                                                                                                                                                        | Built; live check pending                         |
| 12 Notifications            | Business events (for example `WORKER_ASSIGNED`) go to a notification outbox, then a dispatcher sends them per channel, with templates, routing and consent (WhatsApp). A failure never touches the booking (tested). WhatsApp provider not chosen                                                                                                                                                                                                                                                                                                                                                                 | Built; push not in apps (G2)                      |
| 13 Document storage         | [11](11-security-readiness.md) §3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Built; retention period (B7); upload screens (G3) |
| 14 Location and maps        | GPS, reverse geocode, pin, pincode fallback, server-side serviceability, navigation hand-off, minimum location before acceptance, **area only after completion** (tested). API-key restriction and devices (B5)                                                                                                                                                                                                                                                                                                                                                                                                   | Built; device check pending                       |
| 15 SOS and safety           | [11](11-security-readiness.md) §12: paging, escalation, acknowledgement, immutable timeline, second-person closure, 112 guidance. Recipients and escalation contacts: Q-S1                                                                                                                                                                                                                                                                                                                                                                                                                                        | Built; operational set-up pending (B2)            |
| 16 Admin panel              | G1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **Partial: pilot blocker**                        |
| 17 Background jobs          | 13 jobs, leased (one runner) and idempotent. **Duplicates are impossible by constraint:** one invoice per booking, one credit note per refund, one live assignment and reservation per crew slot, one captured payment per booking, earnings unique per booking/worker/type, refunds, bookings, cases and SOS keyed by idempotency key, webhooks by event id, notifications and outbox by dedupe key. G5                                                                                                                                                                                                          | Strong                                            |
| 18 Observability            | JSON logs with request id, actor and booking id; metrics; backlog gauges; alert rules including SOS, payments and rate limiting. OTP-failure and security-event alerts missing (H1). Monitoring stack not deployed (B1)                                                                                                                                                                                                                                                                                                                                                                                           | Built; not deployed                               |
| 19 Log security             | Journey logs scanned automatically (no phone numbers, names, addresses, coordinates, start codes or tokens)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Strong                                            |
| 20 Backup and recovery      | Restore drill script in CI; a real managed-backup drill is pending (B1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Partial                                           |
| 21 Infrastructure           | Not built. **Server details needed (Q-I1)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Not implemented                                   |
| 22 Environments             | `APP_ENV` = local/test/staging/production. Start-up refuses: test OTP, console OTP and sandbox payments where not allowed; live Razorpay keys outside production; placeholder secrets; `log` channels; local storage; missing TLS (database and providers); missing KMS in production. Separate credentials per environment are an operating rule (Q-I3)                                                                                                                                                                                                                                                          | Built                                             |
| 23 CI/CD                    | Format, lint, typecheck, build, unit tests, API tests on PostgreSQL, migrations (apply, re-run, generated types), migration immutability, browser E2E, restore drill, gitleaks, audit (high+), CodeQL, dependency review. **`main` branch and protection not created yet (repository admin).** No deployment pipeline yet (needs B1)                                                                                                                                                                                                                                                                              | Built; protection pending                         |
| 24 Staging                  | Not built (B1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Not implemented                                   |
| 25 Real devices             | Not done (B5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Not done                                          |
| 26 Failure testing          | [11](11-security-readiness.md) §13 plus the new concurrency tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Strong                                            |
| 27 Load testing             | §5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Done locally; repeat on staging hardware          |
| 28 Business configuration   | All configurable through the API (and audited) except G4. **No real business values are set anywhere:** the seeds are test data (Q-B1 to Q-B12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Needs your input                                  |

---

## 5. Load test results

**Set-up:**

- the production build of the API (one instance, 10 database connections) and the
  background worker;
- PostgreSQL 16 on the same 4-core, 15 GB machine as the load generator;
- 20 seeded workers and 100 simulated phones, each from its own network address;
- run with `e2e/load/load-test.ts`.

| Phase                                     | Requests | Throughput | p50    | p95    | p99    | Errors                                 |
| ----------------------------------------- | -------- | ---------- | ------ | ------ | ------ | -------------------------------------- |
| Sign-up (OTP, consents, profile, address) | 600      | 339/s      | 23 ms  | 53 ms  | 129 ms | 0                                      |
| Reads: catalog                            | 1,000    | —          | 353 ms | 588 ms | 642 ms | 0                                      |
| Reads: profile                            | 1,000    | —          | 276 ms | 554 ms | 646 ms | 0                                      |
| Reads: bookings list                      | 1,000    | —          | 181 ms | 377 ms | 432 ms | 0                                      |
| Reads: availability                       | 1,000    | —          | 683 ms | 951 ms | 1.05 s | 0                                      |
| All reads together                        | 4,000    | ~250/s     | 329 ms | 843 ms | 940 ms | 0                                      |
| 100 phones booking one slot at once       | 200      | 79/s       | 371 ms | 729 ms | 2.4 s  | 0 (80 × `NO_AVAILABILITY` as designed) |
| 20 payments, each webhook delivered twice | 60       | 27/s       | 1.1 s  | 2.1 s  | 2.1 s  | 0                                      |

**After processing:**

| Measure                                | Value |
| -------------------------------------- | ----- |
| Bookings confirmed                     | 20    |
| Payments captured                      | 20    |
| Bookings with two captures             | 0     |
| Offers sent (by the background worker) | 20    |
| Overlapping reservations               | 0     |
| Notifications waiting                  | 0     |
| Failed job runs                        | 0     |
| Database connections used during reads | 13    |

**Interpretation:**

- 100 phones browsing continuously is far beyond a Noida pilot.
- Correctness held completely under load.
- Latency rises because one instance's 10 connections are the bottleneck (every request
  checks the session in the database), and PostgreSQL shares the CPU with the load
  generator here.
- **Before production:** repeat on the staging server; make the pool size configurable
  (G8); size instances and PgBouncer for the server; review the availability query.

---

## 6. Production Readiness Matrix

**Classes:**

| Code   | Meaning                         |
| ------ | ------------------------------- |
| READY  | PRODUCTION READY                |
| HARDEN | FUNCTIONAL — HARDENING REQUIRED |
| PART   | PARTIAL                         |
| NI     | NOT IMPLEMENTED                 |
| LATER  | SAFE TO IMPLEMENT LATER         |

Pilot / Prod: blocker before pilot / before production.

| Component                               | Class  | Pilot | Prod | Notes                                   |
| --------------------------------------- | ------ | ----- | ---- | --------------------------------------- |
| PostgreSQL schema, constraints, history | READY  |       |      | Indexes G7 (hardening)                  |
| Booking state machine                   | READY  |       |      |                                         |
| Double-booking / concurrency            | READY  |       |      | 100-way tested                          |
| Pricing, taxes, serviceability engine   | READY  |       |      | Values are business input (§8)          |
| Dispatch and availability               | HARDEN | ✔     |      | Depends on push (G2)                    |
| Customer authentication (OTP)           | HARDEN | ✔     |      | MSG91 live (B4); devices (B5)           |
| Worker authentication and eligibility   | READY  |       |      | Onboarding screens G3                   |
| Staff authentication, MFA, RBAC         | HARDEN |       | ✔    | Role decisions Q-R1 to Q-R3             |
| Authorization (IDOR/BOLA, routes)       | READY  |       |      | Tested in CI                            |
| Request limits                          | HARDEN | ✔     |      | Edge/WAF (B3)                           |
| Payments (Razorpay)                     | HARDEN | ✔     |      | G6, G10, live (B4)                      |
| Refunds                                 | HARDEN | ✔     |      | Admin screens (G1); policy (Q-B7)       |
| Invoices                                | HARDEN |       | ✔    | GST treatment (Q-B4); admin lookup (G1) |
| Worker earnings                         | HARDEN |       |      | Payout rule values (Q-B5)               |
| Worker payouts                          | NI     |       | ✔    | API and finance flow                    |
| Notifications                           | HARDEN | ✔     |      | Push in apps (G2); DLT templates (B2)   |
| Zoho CRM / Desk                         | HARDEN |       | ✔    | Live org (B4)                           |
| Zoho SalesIQ                            | NI     |       |      | Q-Z1 (LATER unless required)            |
| Support cases                           | HARDEN | ✔     |      | Admin screens (G1)                      |
| SOS / safety                            | HARDEN | ✔     |      | Contacts (Q-S1); screens (G1); B2       |
| Worker document storage (KYC)           | HARDEN | ✔     | ✔    | Screens G3 (pilot); retention B7 (prod) |
| Location / maps                         | HARDEN | ✔     |      | Keys and devices (B5)                   |
| Customer app                            | HARDEN | ✔     |      | G2, G9, B5                              |
| Worker app                              | PART   | ✔     |      | G2, G3, B5                              |
| Admin panel                             | PART   | ✔     |      | G1                                      |
| Background jobs                         | HARDEN |       | ✔    | G5                                      |
| Observability                           | HARDEN | ✔     |      | Deployed stack (B1); H1                 |
| Log security                            | READY  |       |      |                                         |
| Backup and disaster recovery            | PART   | ✔     |      | Real drill (B1)                         |
| Infrastructure                          | NI     | ✔     |      | Q-I1                                    |
| Staging                                 | NI     | ✔     |      | B1                                      |
| CI/CD                                   | HARDEN | ✔     |      | `main` protection; deploy pipeline      |
| Real-device testing                     | NI     | ✔     |      | B5                                      |
| Data-protection rights (DPDP)           | NI     |       | ✔    | B6                                      |
| Independent security review             | NI     |       | ✔    | B8                                      |
| Load and capacity                       | HARDEN |       | ✔    | G8; staging rerun                       |

### Details for every non-ready component

**Dispatch and availability**

- **Current:** database-checked eligibility; offers with expiry; redispatch; offers are
  shown in the app only while it is open.
- **Gap:** no push (G2).
- **Risk:** offers expire unseen and bookings go unassigned.
- **Work:** push registration and permission in both apps, the offer push, and deep links
  into the offer.
- **Tests:** device tests; the unassigned-bookings alert.
- **External:** Firebase project, Apple push key.

**Customer authentication**

- **Current:** complete and tested; the MSG91 adapter is contract-tested.
- **Gap:** not verified live; DLT registration.
- **Risk:** customers cannot sign in.
- **Work:** MSG91 account, DLT template, staging verification.
- **Tests:** the [08](08-provider-setup.md) checklist.
- **External:** MSG91 and DLT.

**Staff, MFA and RBAC**

- **Current:** enforced and tested.
- **Gap:** role contents are a business decision (Q-R1 to Q-R3); no second person for
  worker activation (G11).
- **Work:** adjust per your answers (a migration, audited).
- **Tests:** route policy and authorization tests updated.

**Request limits:** application done. Edge limits need the WAF (B3).

**Payments**

- **Current:** complete and tested with the sandbox gateway.
- **Gaps:** currency check (G6), live docs re-check (G10), live account (B4).
- **Risk:** a mismatch or API change unnoticed before real money.
- **Work:**
  - add the currency check and an amount/currency-mismatch test;
  - re-read the Razorpay docs;
  - staging test mode, then one live ₹1 payment and refund.
- **External:** Razorpay account (company-owned) and webhook URL.

**Refunds**

- **Current:** API, two-person approval, cap, idempotent processing.
- **Gap:** no admin screens; refund policy values.
- **Work:** refund queue and approval screens.
- **Business:** Q-B7.

**Invoices**

- **Current:** issued at settlement, one per booking, sequential series.
- **Gap:** GST treatment and series not confirmed; no admin lookup.
- **Business:** Q-B4 (CA).

**Worker earnings**

- **Current:** created at settlement, unique per booking.
- **Gap:** payout rule values (Q-B5).

**Worker payouts** (not implemented)

- **Current:** tables exist (payout batches, encrypted bank accounts).
- **Gap:** no API, no approval flow, no bank transfer.
- **Risk:** workers cannot be paid through the system.
- **Work:** payout batches, approval (second person), bank file or payout API, statements.
- **External:** banking or payout provider (Q-B5).
- **Classification:** production blocker. A pilot could pay manually outside the system
  only if you accept that; your decision.

**Notifications**

- **Current:** outbox, routing, templates, consent, retries.
- **Gap:** push not in the apps (G2); DLT templates.
- **External:** FCM, APNs, MSG91 DLT, ZeptoMail domain.

**Zoho CRM / Desk**

- **Current:** built and contract-tested.
- **Gap:** live org.
- **Work:** configure fields and departments; staging sync; failure drill.
- **External:** Zoho org (Q-Z2).

**Support / safety**

- **Current:** API complete and tested.
- **Gap:** no admin screens; safety contacts and rota; DLT.
- **Risk:** cases and SOS cannot be worked without screens.
- **Business:** Q-S1, Q-S2.

**Document storage**

- **Current:** private S3 with KMS, scanning, audited views.
- **Gap:** upload screens (G3); retention period (B7).
- **Business:** Q-L2.

**Location / maps**

- **Current:** built.
- **Gap:** keys restricted per app; device tests.
- **External:** Google Cloud project (Q-A2).

**Customer app / worker app**

- **Gaps:** push (G2), deep links (G9), device tests (B5); the worker app also lacks
  onboarding (G3).
- **External:** Apple and Google developer accounts (Q-A1).

**Admin panel**

- **Current:** bookings, staff, system.
- **Gap:** G1.
- **Work, pilot-critical first:**
  1. safety (acknowledge, incident, on-call roster);
  2. support cases;
  3. refunds;
  4. workers (verification, training, status, restrictions, shifts);
  5. customers (masked, reveal, sign out);
  6. configuration (service areas, pricing, taxes, promotions, payout rules, operating
     hours, notification routes);
  7. audit log;
  8. Zoho and notification failures;
  9. payments and invoices (needs a new admin API).
- **Tests:** a browser test per screen.

**Background jobs:** add housekeeping and retention jobs (G5). Periods are a decision
(Q-L1).

**Observability:** deploy Prometheus, Alertmanager and log storage; add OTP-failure and
security-event alerts (H1).

**Backup and disaster recovery:** managed backups; a timed drill of a real snapshot with
`scripts/restore-drill.sh`; an owner named (Q-I2).

**Infrastructure / staging**

- **Design:** DNS; TLS at a reverse proxy or load balancer; API and background worker as
  separate processes; managed or self-hosted PostgreSQL on a private network only; S3 with
  KMS; a firewall allowing only 443 in; secrets manager; monitoring; backups off-server.
- **Blocked on:** Q-I1 to Q-I4.

**CI/CD:** a repository admin creates `main` and applies [09](09-github-controls.md). A
deployment pipeline follows once the servers exist.

**Real devices:** [11](11-security-readiness.md) §17.

**DPDP rights (B6)** and **independent review (B8):** as in [11](11-security-readiness.md)
§19.

**Load and capacity:** G8, then repeat §5 on staging hardware.

---

## 7. Roles and permissions as configured

| Role              | Can                                                                                                                                                                | Cannot                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| SUPER_ADMIN       | Staff and roles, catalog, service areas, settings, notification setup, integrations, audit, system                                                                 | Bookings, money, customers' or workers' personal data |
| OPERATIONS_HEAD   | All booking actions incl. overrides; promotions; service areas; support; safety read and escalate; worker status; reveal customer and worker contact; end sessions | Pricing, refunds approval, payouts, roles             |
| DISPATCHER        | Read, assign, reschedule, cancel, book on behalf, no-show; shifts; reveal customer contact                                                                         | Overrides, refunds, worker status, pricing            |
| CUSTOMER_SUPPORT  | Read, reschedule, cancel; support cases; request refunds; reveal customer contact; end customer sessions; escalate safety                                          | Approve refunds, assign workers, worker data          |
| WORKER_OPERATIONS | Worker records, documents (audited), verification decisions, status, availability; reveal worker contact; end worker sessions                                      | Bookings, money, customers                            |
| FINANCE           | Payments, refunds (request and approve, never their own), payouts, **pricing**, worker bank details                                                                | Personal contact data, bookings actions               |
| SAFETY            | Command and close incidents (a second person closes), on-call roster, worker restrictions and status, reveal contact, cancel bookings, end sessions                | Money, pricing                                        |
| AUDITOR           | Read everything operational including the audit log                                                                                                                | Any change; revealing personal data                   |

Roles can be limited to a city. Every reveal of personal data needs a reason and is audited.

---

## 8. Questions for you (nothing below has been assumed)

### Infrastructure and accounts

- **Q-I1** Server: provider or VPS; region (India?); CPU/RAM/disk; count (one or several);
  managed PostgreSQL or self-hosted; OS; who administers it.
- **Q-I2** Who owns backups and restore drills (a named role)? Any retention beyond the
  proposed 35 days point-in-time plus 12 monthly?
- **Q-I3** Domains: API, admin panel, staging. Who controls DNS?
- **Q-I4** Object storage: AWS S3 (and region) or another S3-compatible provider with KMS?
- **Q-A1** Apple and Google developer accounts: company-owned? Who has access?
- **Q-A2** Google Cloud project for Maps and Firebase (push): company-owned?
- **Q-Z1** Is Zoho SalesIQ (in-app chat) required for the pilot, or later?
- **Q-Z2** Zoho org: data centre (.in?), CRM modules and fields, Desk departments. Is a
  sandbox available?
- **Q-P1** Razorpay account: company-owned, KYC complete, test mode available for staging?
- **Q-M1** MSG91 account and DLT registration (sender id, templates): who owns them?

### Business rules (configurable; values needed)

- **Q-B1** Pilot service area: Noida zones, localities, pincodes, radius.
- **Q-B2** HH60: exact task list, duration, which options exist.
- **Q-B3** HH60 price (base, charges by time or distance, if any).
- **Q-B4** GST: registration, rate and SAC code, issuing entity, invoice series (CA to
  confirm).
- **Q-B5** Worker payout per job, travel and waiting pay, payout frequency and method.
- **Q-B6** Operating hours per zone; how far ahead customers may book; minimum notice;
  "as soon as possible" allowed?
- **Q-B7** Cancellation and refund policy (by time before the visit; who pays for a worker
  no-show).
- **Q-B8** Worker verification requirements (which documents, police verification,
  expiries) and training modules.
- **Q-B9** Support hours and channels; the promised response times.
- **Q-B10** Promotions for the pilot, if any.
- **Q-B11** Payment timing (prepaid only, as built?). No cash on delivery.
- **Q-B12** Languages beyond English and Hindi?

### Safety

- **Q-S1** Who receives SOS pages (names and phones per level), service hours covered,
  and the escalation after level 3.
- **Q-S2** Safety runbook: police liaison, when to call 112 on the person's behalf,
  evidence handling.

### Legal and data

- **Q-L1** Retention periods: customer data after the last booking, OTP and session data,
  support and safety records (counsel).
- **Q-L2** KYC document retention after a worker leaves (counsel).
- **Q-L3** Terms of service, privacy notice and cancellation policy text (counsel), and
  the grievance officer's contact.

### Roles

- **Q-R1** Should dispatchers and customer support be able to reveal customer phone
  numbers (needed to call them), or only operations heads?
- **Q-R2** Should activating a worker need a second person, as refunds do?
- **Q-R3** Should finance manage prices, or a separate pricing owner?

### Scope

- **Q-O3** For the pilot: worker onboarding in the app (G3), or done by staff in the panel
  with the worker app used only for jobs?

---

## 9. Proposed order of work (for your approval)

1. **Answers to §8.** Nothing below changes business rules without them.
2. **Foundation fixes** (no business input needed):
   - G6 currency check and test;
   - G7 indexes (a migration);
   - G8 configurable pool;
   - G5 housekeeping jobs (with the periods from Q-L1);
   - G4 configuration API for training and verification requirements.
3. **Admin panel, pilot-critical screens** (G1, in the order above).
4. **Push and deep links in both apps** (G2, G9); worker onboarding screens if chosen (G3).
5. **Infrastructure and staging** (B1) once Q-I1 to Q-I4 are answered. Then provider set-up
   (B2, B4), staging E2E and load rerun, and edge limits (B3).
6. **Real-device testing** (B5), then the pilot.
7. **Before production:** payouts, DPDP rights (B6), KYC retention (B7), independent
   security review (B8).

**Time:** steps 2–4 are the bulk of the remaining engineering, several weeks of careful
work. The admin screens are the largest single item. Steps 5–6 depend on accounts and
hardware from you.
