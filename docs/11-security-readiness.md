# One Tappe — Security and system readiness

Reviewed on 23 Sep 2026 against the repository (branch
`claude/appointment-booking-app-design-tqp3ip`, migrations 0001–0026) and the running system:

- the API suite: 29 files and 289 tests passing, as the least-privilege database role;
- the browser suite: 7 tests (admin panel, plus the customer and worker web builds driving
  the whole HH60 journey), passing locally and in CI (run #31);
- the logs of that journey, scanned for personal data;
- a dump-and-restore drill;
- `pnpm audit`;
- a scan of the app bundles for secrets.

This document is the security and readiness view. [10-system-matrix.md](10-system-matrix.md)
is the feature view, [06-security-review.md](06-security-review.md) the controls in depth,
and [07-operations-and-recovery.md](07-operations-and-recovery.md) operations and recovery.

**Classifications:**

| Class                             | Meaning                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| PRODUCTION READY                  | Built, tested here, nothing known missing                          |
| FUNCTIONAL BUT HARDENING REQUIRED | Works and is tested; named hardening remains                       |
| PARTIAL                           | Part built                                                         |
| NOT IMPLEMENTED                   | Not built                                                          |
| BLOCKER BEFORE PILOT              | Must be fixed before any real customer, worker, payment or address |
| BLOCKER BEFORE PRODUCTION         | Pilot can run without it; general launch cannot                    |

---

## 1. What this review changed

The review found real problems and fixed them in code, with tests:

| Found                                                                                                                                                                                                                      | Fixed                                                                                                                                                                              | Test                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **A suspended worker kept operational access.** Their old session could still reach offers, jobs and customer addresses; suspension only changed `worker_profile.status`, which the job and offer endpoints did not check. | The global guard checks the worker's status on **every request**. Non-working workers reach only an explicit list: status, onboarding, earnings, support, SOS, consents, sign-out. | `authorization.test.ts`, `route-policy.test.ts`  |
| **Finished jobs kept showing the customer's home.** The worker app could read the door, gate code, exact pin and notes of every past job indefinitely.                                                                     | After the job the worker sees the area only (pincode, city). Door, notes, pin and phone number are shown only while the job is active.                                             | `authorization.test.ts`                          |
| **IDs could be probed.** Someone else's booking (cancel, reschedule, rating, payments), job step or offer answered 403 "belongs to someone else", confirming it exists.                                                    | These now answer exactly like a missing record (404).                                                                                                                              | `authorization.test.ts` compares with random ids |
| **Pay tapped twice at once created two gateway orders.**                                                                                                                                                                   | The second tap waits for the first order and returns the same payment. A start abandoned by a crash is marked failed and replaced.                                                 | `abnormal-traffic.test.ts`                       |
| **SOS paged nobody.** No named person was alerted, and there was no acknowledgement or escalation.                                                                                                                         | Full paging workflow (§12).                                                                                                                                                        | `sos-escalation.test.ts`                         |
| **No response to a lost or stolen phone.**                                                                                                                                                                                 | "Sign out of all devices" in both apps. Support can end a customer's or worker's sessions, with a reason and a fresh authenticator check, and the action is audited.               | `authorization.test.ts`                          |
| **Staff numbers could open phone-app accounts.** A staff account with a phone number could be signed in to a phone app (a customer profile would be attached to it).                                                       | Refused (`STAFF_ACCOUNT`).                                                                                                                                                         | `sos-escalation.test.ts`                         |
| **Admin configuration and integration routes had no app restriction.** They were protected only by permissions that phone-app tokens never have.                                                                           | Restricted to admin-panel tokens as well (second check).                                                                                                                           | `route-policy.test.ts`                           |
| **The database connection did not have to use TLS.**                                                                                                                                                                       | Staging and production refuse a `DATABASE_URL` without `sslmode=verify-full`.                                                                                                      | `config.test.ts`                                 |
| **Android backups included app data.**                                                                                                                                                                                     | `allowBackup: false` in both apps.                                                                                                                                                 | Build configuration (verify on device)           |
| **The browser API rejected PATCH, and the request id was invisible to browsers.** (Found by the journey test.)                                                                                                             | CORS allows PATCH and exposes `x-request-id`.                                                                                                                                      | `journey.spec.ts`                                |
| **Restore had never been tried.**                                                                                                                                                                                          | `scripts/restore-drill.sh` dumps, restores and verifies data **and protections**. It runs in CI on every push.                                                                     | CI `integration-tests` job                       |

---

## 2. Customer data: where it is and who sees it

Staff see **masked** data by default: phone `******1234` and address as area only. Unmasked
contact needs `customer.pii.reveal`, a written reason, and every reveal is audited.
Roles without that permission (auditor, finance, worker operations) never see it.
`authorization.test.ts` checks this for the support and auditor roles.

| Data                                 | Stored                                                                                              | Who can read it (API)                                                                                                                                                                         | Shown in                                                                        | Logs                               | Analytics                          | Zoho                                                                  | Retention                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Name                                 | `app_user.full_name`                                                                                | **Customer:** `/customer/me`. **Worker:** first name, own jobs only. **Staff:** masked; full with `customer.pii.reveal` (audited)                                                             | **Customer app:** profile. **Worker app:** first name. **Panel:** masked        | Redacted (field and text rules)    | None (no analytics SDK in any app) | CRM contact (first/last name)                                         | Life of account. **No erasure flow yet**: blocker B6                                                     |
| Phone number                         | `app_user.phone_e164`; per-address contact phone                                                    | **Customer:** own. **Worker:** only while their job is active. **Staff:** masked; reveal audited                                                                                              | **Customer app:** profile. **Worker app:** "Call customer" during the job only  | Masked to last 4 (verified)        | None                               | CRM `Mobile`; Desk contact                                            | As above                                                                                                 |
| Home address and notes               | `address` (live); `booking.address_snapshot` (as booked)                                            | **Customer:** own addresses and bookings. **Worker:** the accepted job's address **while active** (after: area only). **Offer:** locality and pincode only. **Staff:** area; full with reveal | **Customer app:** address, booking. **Worker app:** active job                  | Redacted; journey scan found none  | None                               | **Not sent**                                                          | Addresses: until archived. Snapshots: kept with the booking (tax and dispute record). Erasure policy: B6 |
| GPS / pin                            | `address.lat/lng`; `worker_presence` (worker's last position when going online); SOS position       | **Customer:** own. **Worker:** active job pin only. **Staff:** incidents with `safety.read`                                                                                                   | **Customer app:** map pin. **Worker app:** "Open in Google Maps" while active   | Field-redacted; scan found none    | None                               | **Not sent**                                                          | Presence overwritten; SOS kept with the incident                                                         |
| Booking history                      | `booking`, `booking_status_history` (append-only)                                                   | **Customer:** own (others' bookings answer 404). **Worker:** own jobs. **Staff:** `booking.read`, limited to granted cities                                                                   | **Customer app:** bookings list. **Worker app:** history (area only). **Panel** | Booking id and code only           | None                               | CRM booking (code, status, time, amount, service, city) if configured | Kept (business and tax record)                                                                           |
| Worker–customer interaction          | Job steps, start-code attempts (hashed code), rating                                                | **Parties:** their own booking. **Staff:** `booking.read`                                                                                                                                     | **Both apps**                                                                   | Start code never logged (verified) | None                               | Not sent                                                              | Kept with the booking                                                                                    |
| Payment references                   | `payment` (gateway order/payment ids; never card or UPI details, which stay in Razorpay's checkout) | **Customer:** own booking's payment status. **Staff:** `payment.read`                                                                                                                         | **Customer app:** status only                                                   | Ids only                           | None                               | Not sent                                                              | Kept (financial record)                                                                                  |
| Invoices                             | `invoice` (issued by settlement)                                                                    | **Customer:** own. **Staff:** `invoice.read`                                                                                                                                                  | **Customer app**                                                                | No                                 | None                               | Not sent                                                              | Statutory (GST: at least 8 years; CA to confirm)                                                         |
| Support conversations and complaints | `support_case`, `support_case_event` (append-only)                                                  | **Customer:** own cases. **Staff:** `support.read` / `support.manage`                                                                                                                         | **Customer app:** case list. **Panel**                                          | Not logged                         | None                               | **Desk ticket**: the text the customer wrote, plus contact            | Kept; erasure policy B6                                                                                  |
| SOS / safety                         | `safety_incident` (restricted narrative), `safety_incident_event` (append-only)                     | **Reporter:** creates only. **Staff:** `safety.read` / `safety.manage`                                                                                                                        | **Panel** (safety staff)                                                        | Incident code only                 | None                               | Reference ticket only ("details restricted")                          | Kept (legal record)                                                                                      |

**Transport and storage for all rows:**

- **In transit:** TLS for app to API (HTTPS and HSTS in staging/production), for API to
  database (`verify-full`, now enforced), and to Razorpay, Zoho and MSG91 (HTTPS enforced).
- **At rest:** managed PostgreSQL storage encryption. Bank account numbers use
  application-level AES-256-GCM.
- **Backups:** encrypted, in a separate account (§15).

---

## 3. Worker data and identity documents (KYC)

- **Storage:** documents live in a **private** S3 bucket with KMS encryption; staging and
  production refuse anything else. Nothing is public, and there are no public URLs.
- **Upload:**
  - short-lived pre-signed PUT, limited to one object key, JPEG/PNG/PDF, 1 byte to 5 MB;
  - the declared type is checked against the actual bytes;
  - every file is malware-scanned (ClamAV, required in staging/production) before anyone
    can open it.
- **Download:** only through the API, never a link:
  - requires `worker.documents.view` and a reason;
  - only files that passed the scan and still match their recorded hash;
  - every view is audited.
- **Stored data:** no Aadhaar number is stored, only the last 4 characters of a reference.
- **Logs:** document bytes and contents are never logged. The redaction rules drop
  `aadhaar`/`pan`/`accountNumber` fields.
- **Retention:** a leaver's documents are deleted after the configured period
  (`documents.retention`). **The period must be set by counsel** (blocker B7); until then
  nothing is deleted automatically.
- **Self-service onboarding screens (upload from the worker app) are not built yet.** The
  API is ready; the onboarding team handles verification today.

---

## 4. API authorization (the backend is the boundary)

- **Route inventory.** `test/security/route-policy.test.ts` reads the access policy of all
  184 routes **from the running application**. It fails if any of these changes:
  - the reviewed list of public routes (16, each protected another way: a signature, a
    secret, a one-time token, a rate limit, or nothing to protect);
  - any non-public route without an app restriction;
  - any admin route without a permission, or open to phone-app tokens;
  - customer routes are customer-app only, and worker routes worker-app only;
  - money, people and platform changes require a fresh authenticator check;
  - the list of routes open to suspended or unapproved workers (15).
- **IDOR/BOLA tests.** `test/security/authorization.test.ts`, with a real session of the
  attacker's own:
  - **Customer B vs customer A's booking:** every booking route (read, timeline, invoice,
    start code, pay, "I have paid", cancel, reschedule, rating) answers 404, **identical
    to a random id**.
  - **Other customer resources:** A's address, A's payment id on B's own booking, support
    cases and SOS tied to A's booking are all refused.
  - **Worker B vs worker A's job:** all job steps, reading the job, withdrawing, and
    accepting or rejecting A's offer are refused. No address leaks in the answer.
  - **Staff limits:**
    - a city-limited dispatcher cannot open, list or change another city's booking;
    - customer-support and auditor roles see masked contact details;
    - the auditor cannot reveal them;
    - wrong-app tokens are refused on every group.
- **Existing tests** (earlier work): the database refuses channel-invalid transitions even
  for raw SQL, only the assigned worker moves a job, refunds need a second person, and
  overrides need a fresh authenticator check.

**Remaining:**

- **Customer suspension (hardening H3).** The `customer.manage` permission has no endpoint
  or role yet. A customer can be disabled only through the account status, and there is no
  panel action for it.
- **Sessions after permission changes.** Staff permission changes take effect on the next
  request, because they are loaded per request. Phone-app sessions carry no permissions.

---

## 5. Authentication and sessions

| Control                      | Implementation                                                                                                                                                                                                                                                                                                                | Status           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| OTP                          | **Code:** 6 digits, 5-minute expiry, only the newest code works, single use, 5 attempts per code. **Limits:** 30 s resend cooldown; 5 per hour and 10 per day per phone; 20 per hour per network; 10 wrong codes lock the phone for an hour. **Other:** no master or test code in staging or production (refused at start-up) | Tested           |
| Account enumeration          | OTP request answers the same whether the number is known; staff login gives the same answer for unknown emails                                                                                                                                                                                                                | Tested           |
| Staff                        | Password + TOTP (enrolled on first sign-in, codes not reusable), lockout after 5 wrong passwords, 10-minute access token, 30-minute idle timeout, 12-hour absolute limit, fresh authenticator check for sensitive actions                                                                                                     | Tested           |
| Phone-app sessions           | 15-minute access token. Refresh token rotated on use, and a replayed old refresh token revokes the whole session (theft detection). Absolute limit: 90 days (customer), 30 days (worker)                                                                                                                                      | Tested           |
| Logout / sign out everywhere | Logout revokes at once. "Sign out of all devices" (new); staff can end a person's sessions (new, audited)                                                                                                                                                                                                                     | Tested           |
| Suspended accounts           | Disabled users refused on every request. **Suspended workers limited on every request (new)**. Suspended staff: sessions revoked                                                                                                                                                                                              | Tested           |
| Token storage in apps        | iOS Keychain / Android Keystore, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (not migrated to a new phone). Web test build: memory only. Admin panel: sealed httpOnly `__Host-` cookie, no tokens in the browser                                                                                                                         | Verify on device |
| General API rate limiting    | **Not built** beyond OTP, staff login and start-code attempts: blocker B3                                                                                                                                                                                                                                                     | Missing          |

---

## 6. Database

| Control                    | Status                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Least privilege            | The API runs as a member of `onetappe_app`: no DDL, cannot disable triggers or TRUNCATE; append-only tables are SELECT/INSERT only. The whole test suite runs as this role |
| Migrations                 | Applied by a separate owner credential. CI refuses edited, renamed or removed migrations. Types regenerated and verified in CI                                             |
| Append-only / audit        | Status history, schedule history, price lines, audit log, support and safety timelines. Tamper attempts are refused (tested, and re-verified on a restored copy)           |
| Double booking             | PostgreSQL exclusion constraint `worker_reservation_no_overlap` plus a no-overlap constraint on shifts                                                                     |
| Transactions and deadlocks | Serialized per booking by row lock; deadlocks retried (tested); staff edits versioned (`STALE_BOOKING`)                                                                    |
| TLS                        | **Now enforced** outside local/test (`sslmode=verify-full`)                                                                                                                |
| Connection limits          | Pool per process, statement timeout, recovery from outages and dropped connections (tested). **Production pool sizing and PgBouncer: infrastructure (B1)**                 |
| Credentials                | Environment / secret manager only; never in the repository (gitleaks in CI); placeholder values refused at start-up                                                        |

**Concurrency tests, now including abnormal traffic** (`abnormal-traffic.test.ts`):

| Scenario                                     | Result                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Forty customers, five workers, one slot      | Exactly five bookings; the rest get `NO_AVAILABILITY`; zero overlapping reservations |
| Customer cancelling while the worker accepts | Always ends cancelled with the worker free                                           |
| Staff holding while the customer cancels     | Never a 500; history always agrees with the row                                      |

---

## 7. Payments (Razorpay)

| Check                                         | Status                                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment success from the app is never trusted | The booking is confirmed only by the signed webhook or the server's own query to Razorpay                                                                                                           |
| Webhook signature                             | Verified on the raw bytes; forged webhooks rejected (tested)                                                                                                                                        |
| Duplicate / replayed webhook                  | Stored once and processed once (database unique constraint, tested)                                                                                                                                 |
| Out of order / late                           | A failure after a capture does not undo it. Payment after expiry is refunded automatically. An authorization after expiry is never captured (tested)                                                |
| Order and amount matching                     | Order, amount and currency matched to our record; a booking can never have two captured payments (database)                                                                                         |
| Pay pressed twice                             | **Fixed**: one order (tested)                                                                                                                                                                       |
| Refunds                                       | Server-side policy; never above the amount captured, even across requests (database); a second person approves, with a fresh authenticator check; nobody approves their own; processed idempotently |
| Reconciliation                                | Job queries Razorpay for payments open more than 15 minutes; alert `PaymentsUnresolved`                                                                                                             |
| Secrets                                       | Key secret and webhook secret server-side only (not in the apps: bundle scan). Live keys refused outside production, test keys refused in production                                                |
| **Live verification**                         | **Not done**: blocker B4 (Razorpay test mode on staging with real webhooks, then a live ₹1 payment and refund)                                                                                      |

---

## 8. Zoho isolation

**Data boundary:** One Tappe PostgreSQL is the operational source of truth. Zoho is the
CRM, support-desk and communication platform, fed from it.

| Zoho receives                                                                                                                              | Zoho never receives                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| **CRM contact:** name, mobile, email                                                                                                       | Addresses                                            |
| **CRM booking:** code, status, time, amount, service code, city                                                                            | GPS                                                  |
| **Desk support ticket:** the requester's contact, the subject and text they wrote, with the One Tappe case and booking codes as references | Payment references, invoices                         |
| **Desk safety ticket:** code, category, severity, booking code, "details restricted"                                                       | KYC and bank details; safety narratives; start codes |

- **Bookings never wait on Zoho.** Every sync goes through a transactional outbox with
  retries, backoff, a circuit breaker per target, a dead-letter state, and retry/discard
  from the panel.
- **Tested failures:** token expiry, API failure, rate limiting, duplicate sync (external
  links and once-keys), delayed sync, invalid Desk webhook (signature), retry and
  dead-letter recovery (`zoho-integration.test.ts`).
- **Tokens:** the refresh token lives in the secret manager. The access token is stored
  encrypted in the database and refreshed under a lock.
- **Not yet verified against a real Zoho org:** blocker B4.

---

## 9. Logs

**Evidence:** the logs of the full browser journey, API and background worker, **are now
scanned automatically by `journey.spec.ts`**. None of these appear:

- the customer's or worker's phone number;
- the name or house number;
- coordinates;
- the start code;
- `Bearer` tokens or JWTs.

**What is logged instead:** request lines carry the route template (not ids from the URL),
status, duration, a request id and the actor's user id.

**Redaction:**

- phone numbers are masked to the last 4 digits;
- email addresses are masked;
- bearer tokens, JWTs, `key=`/`token=`/`secret=`/`signature=`/`password=`/`otp=`/`code=`
  parameters are removed;
- fields named phone, email, address, lat/lng, name, token, otp, aadhaar and similar are
  dropped entirely.

The only exception is the **local-only** console OTP provider, which prints codes by
design. Staging and production refuse it at start-up.

---

## 10. Mobile apps

| Check                                                                                | Result                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets in the app package                                                           | Bundle scan: only the API URL. No Razorpay secret, Zoho credential, database URL, private key, MSG91 key or server secret. The Razorpay **key id** is public by design and fetched per payment                                            |
| Google Maps keys                                                                     | In native builds by necessity (discoverable). **Must be restricted** to the app's package and signing certificate (Android) and bundle id (iOS), Maps SDK only: part of B5                                                                |
| On-device storage                                                                    | Session tokens only, in Keychain/Keystore, this device only; nothing else persisted (no AsyncStorage). Android backups off                                                                                                                |
| Trust in the app                                                                     | None: every button is re-validated by the API (§4)                                                                                                                                                                                        |
| Certificate pinning, root/jailbreak detection, screenshot blocking on the start code | Not implemented (hardening H4, optional; weigh against breakage)                                                                                                                                                                          |
| Dependencies                                                                         | `pnpm audit`: 0 high/critical (CI gate); 2 moderate in Expo's own dependencies (`uuid` in iOS build tooling; `decode-uri-component` in Expo Router's URL parser, a DoS on a malformed link). Tracked; clear on the next Expo upgrade (H5) |

---

## 11. Location privacy

| Stage                    | What the worker sees                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Offer (before accepting) | Service, locality, pincode, time, estimated pay. **No address, no customer name**           |
| Accepted, job active     | Full address, gate and access notes, exact pin, customer first name, phone number (to call) |
| After completion         | **Area only (pincode, city). No door, notes, pin or phone (new, tested)**                   |

**Other rules:**

- another customer's address is never reachable through another booking (tested, §4);
- the customer's app never receives the worker's location;
- worker presence position is stored only when they go online.
- **Live tracking is not built.** If it is added, it must be duty-time only, consented
  (the consent purpose already exists), and never kept longer than needed.

---

## 12. SOS and safety

**Workflow, built and tested:**

1. Customer or worker presses SOS. The incident is created **at once** in one transaction,
   and pressing again after lost signal does not duplicate it.
2. The time, the booking (only if the reporter is part of it) and the phone's last known
   location (if permitted) are captured.
3. **In the same transaction**, level-1 on-call safety staff are paged by **SMS and
   email**. The page carries the incident code, category and reporter type only (no name,
   address or location; details are in the panel).
4. **Escalation:** no acknowledgement in 2 minutes pages level 2 as well; after that,
   levels 1–3 every 3 minutes, until someone acknowledges. The timing is configurable
   within safe bounds.
5. **Acknowledgement** (`acknowledge`, or any action on the incident) is recorded with who
   and when, and stops paging. It is idempotent.
6. Actions and taking command are recorded. **Closure needs a second person** (enforced by
   the database for serious incidents).
7. The timeline is append-only (tested): reported, every page, nobody on call, acknowledged,
   actions, status changes.

**Not a single channel:**

- **SMS and email** are two channels from the API.
- **Prometheus** alerts independently:
  - `SafetyIncidentOpen`;
  - `SafetyIncidentUnacknowledged` (2 minutes);
  - `SafetyNobodyOnCall` (empty level-1 roster).
- **Alertmanager** routes these to its own receiver (phone call / on-call app). Delivery
  failures never stop escalation (tested with the SMS provider down).
- **Guardrails:**
  - safety pages cannot be switched off in the panel;
  - the roster needs safety staff with a mobile number and a fresh authenticator check.

**Emergency services:**

- "Emergency? Call 112" is on every screen of both apps.
- The SOS confirmation tells people to also call 112.
- One Tappe SOS is presented as One Tappe's own safety team, not an emergency service.

**Before a pilot:**

- the SMS page template must be registered on DLT with MSG91 (B2);
- an Alertmanager receiver that phones people must be configured (B1);
- a staffed roster covering all service hours is needed (B2).

---

## 13. Failure testing

| Scenario                                       | Covered by                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Two customers booking the final worker         | `concurrency.test.ts` (10-way), `failure-journeys` (API), `abnormal-traffic` (40-way)                                 |
| Customer presses Pay twice                     | `abnormal-traffic` (**fixed**)                                                                                        |
| Duplicate / late / out-of-order webhook        | `failure-journeys`, `failure-scenarios`, `database-guarantees`                                                        |
| Customer closes the app during payment         | Server-side confirmation by webhook or reconciliation; "I have paid" asks the gateway (`failure-journeys`)            |
| Worker accepts an expired offer                | `booking-flow` (`OFFER_EXPIRED`); offers expire and move on                                                           |
| Worker accepts two overlapping jobs            | Database exclusion constraint; `concurrency.test.ts`                                                                  |
| Customer reschedules during assignment         | `booking-flow` (reschedule keeps the worker or refuses); cancel-vs-accept race in `abnormal-traffic`                  |
| Worker or customer loses internet              | Job steps and bookings are safe to retry (`failure-scenarios`: retried steps succeed once)                            |
| Repeated API request                           | Idempotency keys everywhere money or records are created (`booking-flow`, `support-cases`)                            |
| Background worker crash / server restart       | Leases and idempotent jobs (`failure-scenarios`); a payment start abandoned mid-way is recovered (`abnormal-traffic`) |
| Database connection disappears                 | `resilience.test.ts` (503 then recovery, dropped connections, partition, worker survives)                             |
| Zoho, SMS provider or push fails               | `zoho-integration`, `auth` (SMS failure withdraws the code), `notifications`; SOS escalation with SMS down            |
| Admin and customer modify the same booking     | `failure-scenarios` (`STALE_BOOKING`), `abnormal-traffic` (hold vs cancel)                                            |
| Expired token / suspended worker's old session | `client-contract` (refresh), `authorization` (**fixed**)                                                              |
| Guessing booking ids                           | `authorization` (404, identical to random)                                                                            |
| Invalid or malicious input                     | Strict zod schemas on every body (unknown fields refused); state machine enforced in the database                     |
| Unexpected file upload                         | `documents.test.ts` (type from bytes, size, malware scan with a test signature, hash re-check)                        |

---

## 14. Security testing and scanning

**In CI on every push:**

- gitleaks (pinned, checksum-verified);
- `pnpm audit --audit-level high`;
- CodeQL;
- dependency review on pull requests;
- the route-policy and authorization tests;
- the restore drill;
- the browser log scan.

**Manual review this round:**

- authorization of every route;
- the business rules that tools cannot see (who may see an address when, suspension,
  refunds, SOS);
- data flows to Zoho, logs and apps.

**Still required before production (B8):** an independent application-security review
against the OWASP API Top 10, ASVS level 2 and the MASVS (mobile), including a test of
the deployed staging environment and the store builds.

---

## 15. Monitoring

Alert rules are in `infra/monitoring/alerts.yml`. Metrics come from `/metrics` (bearer
token) and database-backed backlog gauges.

| Area                                   | Alert / signal                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| API availability                       | `ApiDown`, `ApiLatencyHigh`                                                                                    |
| Background worker                      | `WorkerDown`                                                                                                   |
| 5xx / errors                           | `ApiErrorRateHigh`                                                                                             |
| Database health                        | Readiness endpoint (fails when the database is down) and `ApiDown`; managed-database metrics (B1)              |
| Queue backlog                          | `NotificationBacklog`, `IntegrationBacklogOld`                                                                 |
| Background-job failures                | `JobFailing`                                                                                                   |
| Razorpay webhooks                      | `PaymentEventProblems`, `PaymentsUnresolved`, `RefundsFailed`                                                  |
| Zoho sync                              | `IntegrationPaused` (circuit open), `IntegrationDeadEvents`, `IntegrationBacklogOld`                           |
| OTP provider                           | **No alert yet**: failed sends are recorded per challenge and logged; alert rule to add (H1)                   |
| Notifications                          | `NotificationBacklog` (failed or unsent)                                                                       |
| Abnormal booking failures              | `ConfirmedBookingsUnassigned`                                                                                  |
| SOS                                    | `SafetyIncidentOpen`, **`SafetyIncidentUnacknowledged`, `SafetyNobodyOnCall` (new)**                           |
| Authentication abuse / security events | Recorded (`ACCESS_DENIED` audit rows, OTP locks, refresh-token reuse revocations). **No alert rules yet (H1)** |

Alertmanager receivers (who is phoned) are infrastructure (B1).

---

## 16. Backup and recovery

| Item                  | Plan / evidence                                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frequency             | Continuous WAL archiving (point-in-time) + daily snapshots (managed PostgreSQL); documents: bucket versioning + cross-account replication                                                                                                                                                                                      |
| Retention             | 35 days point-in-time; 12 monthly snapshots                                                                                                                                                                                                                                                                                    |
| Encryption            | KMS key separate from the data key; separate account; deletion-protected                                                                                                                                                                                                                                                       |
| RPO / RTO             | 5 minutes / 2 hours                                                                                                                                                                                                                                                                                                            |
| Procedure             | [07](07-operations-and-recovery.md) §5; `scripts/restore-drill.sh` verifies a restore (row counts of every table, content checksums of bookings, payments, audit and history, triggers, constraints, the double-booking constraint, append-only refusal, runtime-role privileges)                                              |
| Responsible           | Infrastructure owner (company role), with the engineering lead; restore drills quarterly and after major schema changes                                                                                                                                                                                                        |
| **Last restore test** | **23 Sep 2026, local**: e2e database after the browser journey restored with identical checksums, protections verified; the API test database likewise (dump 1 s, restore 1 s). **Now runs in CI on every push.** **A timed drill of a real managed-database backup has not been done (no production infrastructure yet): B1** |

---

## 17. Real-device testing

**Browser builds do not replace phones.** The checklist below is **not yet done**
(blocker B5). Run it on at least:

- Android 10, 12, 13 and 14;
- one low-end phone (2–3 GB RAM) and a common mid-range phone;
- small and large screens;
- one iPhone on current iOS;
- Jio and Airtel networks.

| Area                       | What to check                                                                   |
| -------------------------- | ------------------------------------------------------------------------------- |
| OTP                        | SMS arrival, autofill, resend timer, wrong code, lockout                        |
| Permissions                | Location allow / deny / "only this time" paths                                  |
| GPS                        | Accuracy, indoors, mock location                                                |
| Maps                       | Pin moves, restricted key works only in the signed build                        |
| Razorpay checkout          | UPI intent, cards, back button, app killed mid-payment, confirmation by webhook |
| Deep links                 | Links open the right screen when the app is installed and when it is not        |
| Background / foreground    | Status refresh, offer countdown                                                 |
| Network                    | Network loss and recovery; 2G/3G throttling                                     |
| Notifications              | Push delivery and tapping a notification                                        |
| Session persistence        | Survives app restart and reboot; "sign out everywhere"                          |
| Worker job lifecycle       | Every step end to end                                                           |
| SOS                        | From both apps, with the paging reaching real phones                            |
| Language and accessibility | Hindi and English rendering and font scaling; TalkBack / VoiceOver labels       |

---

## 18. Readiness by component

| Component                                  | Classification                    | Notes                                                                      |
| ------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------- |
| NestJS API (core)                          | FUNCTIONAL BUT HARDENING REQUIRED | H1–H3; general rate limiting B3                                            |
| Authentication / sessions                  | FUNCTIONAL BUT HARDENING REQUIRED | Device testing (B5); rate limiting (B3)                                    |
| RBAC and authorization                     | PRODUCTION READY                  | Route policy and IDOR tests in CI; customer suspension action missing (H3) |
| PostgreSQL schema and guarantees           | PRODUCTION READY                  | Append-only, exclusion constraints, least privilege, verified on restore   |
| Booking engine, pricing, serviceability    | PRODUCTION READY                  | Concurrency and abnormal-traffic tests                                     |
| Dispatch and worker availability           | FUNCTIONAL BUT HARDENING REQUIRED | No push for offers yet (the worker app polls)                              |
| Razorpay payments and refunds              | FUNCTIONAL BUT HARDENING REQUIRED | Live verification B4                                                       |
| Invoices                                   | FUNCTIONAL BUT HARDENING REQUIRED | GST treatment and series to be confirmed by a CA                           |
| Worker earnings                            | PARTIAL                           | Payouts not built (production blocker in 10)                               |
| Notifications                              | FUNCTIONAL BUT HARDENING REQUIRED | DLT templates and FCM verification (B2, B4)                                |
| Zoho CRM / Desk                            | FUNCTIONAL BUT HARDENING REQUIRED | Live verification B4                                                       |
| Support                                    | FUNCTIONAL BUT HARDENING REQUIRED | Panel screens for support are still to build                               |
| SOS / safety                               | FUNCTIONAL BUT HARDENING REQUIRED | Paging built; B2 operational set-up; panel safety screens to build         |
| Maps / location                            | PARTIAL                           | Device testing and key restriction (B5)                                    |
| File storage (KYC)                         | FUNCTIONAL BUT HARDENING REQUIRED | Retention period (B7); worker upload screens not built                     |
| Background jobs and queues                 | PRODUCTION READY                  | Leases, idempotency, failure tests                                         |
| Audit logs                                 | PRODUCTION READY                  | Append-only, verified on restore                                           |
| Monitoring                                 | PARTIAL                           | Rules exist; stack and receivers not deployed (B1); abuse alerts (H1)      |
| Backups and recovery                       | PARTIAL                           | Drill script in CI; real managed-backup drill (B1)                         |
| CI/CD                                      | FUNCTIONAL BUT HARDENING REQUIRED | Deployment pipeline and `main` branch protection pending (10)              |
| Customer app                               | FUNCTIONAL BUT HARDENING REQUIRED | Device testing B5                                                          |
| Worker app                                 | PARTIAL                           | Onboarding screens missing; device testing B5                              |
| Admin panel                                | PARTIAL                           | Support, safety, refund and worker screens to build                        |
| Data-protection compliance (DPDP Act 2023) | NOT IMPLEMENTED                   | B6                                                                         |

---

## 19. Blockers

### B1 — Production infrastructure is not built · BLOCKER BEFORE PILOT

- **Problem:** there is no deployed environment:
  - no managed PostgreSQL (PITR, TLS, pooling);
  - no secret manager;
  - no WAF or edge rate limits;
  - no monitoring stack or Alertmanager receivers;
  - no backups in a separate account.
- **Impact:** nothing can safely hold real data. Without monitoring and receivers, outages
  and SOS escalations reach nobody outside the API's own SMS and email.
- **Fix:** build staging and production per [07](07-operations-and-recovery.md) and
  [08](08-provider-setup.md) under company-owned accounts with role-based access.
- **Tests:**
  - the API refuses start-up with a weak configuration (already enforced);
  - a timed restore drill of a real snapshot with `scripts/restore-drill.sh`;
  - an alert fire-drill that phones the on-call person.
- **Dependencies:** cloud account ownership (company), budget.

### B2 — SOS paging needs its operational half · BLOCKER BEFORE PILOT

- **Problem:** the paging code is built. Its delivery depends on:
  - the SMS template being registered on DLT and set as the `SAFETY_ALERT` SMS template id;
  - a staffed on-call roster for every service hour;
  - an Alertmanager receiver that phones people.
- **Impact:** a customer or worker in danger could go unanswered.
- **Fix:**
  - register the template;
  - set the roster in the panel (API ready; panel screen to build);
  - write the safety runbook (who calls whom, police liaison, evidence handling).
- **Tests:** a monthly live SOS drill on staging, timed from press to acknowledgement,
  with the SMS provider down as a second drill.
- **Dependencies:** B1; the MSG91 DLT account; safety team hiring.

### B3 — No general API rate limiting · BLOCKER BEFORE PILOT

- **Problem:** only OTP, staff login and start codes are limited. Every other authenticated
  endpoint accepts unlimited requests.
- **Impact:** scraping one's own data is harmless, but floods can exhaust the database
  pool and the gateway budget; a stolen token can hammer the API.
- **Fix:**
  - edge limits per IP at the WAF;
  - an application limit per session and per IP for mutating routes, with 429 and
    `Retry-After`;
  - stricter limits on payment start, SOS and support creation;
  - an alert on the rate of 429s.
- **Tests:** a limit test per route group; a load test proving limits do not affect
  normal use.
- **Dependencies:** B1 (WAF).

### B4 — Providers not verified live · BLOCKER BEFORE PILOT

- **Problem:** Razorpay, MSG91, FCM, ZeptoMail and Zoho are built and contract-tested
  against fakes, not the real accounts.
- **Impact:** real payments, SMS or tickets could fail in ways the fakes do not show.
- **Fix:**
  - staging with each provider's test mode and real webhooks;
  - then one live ₹1 payment and refund in production before launch;
  - a real Zoho org with the configured fields.
- **Tests:** the provider checklist in [08](08-provider-setup.md), recorded with request
  ids.
- **Dependencies:** B1; company-owned provider accounts.

### B5 — No real-device testing · BLOCKER BEFORE PILOT

- **Problem:** the apps have run only as web builds in a browser.
- **Impact:** OTP autofill, permissions, maps, Razorpay checkout, background behaviour and
  secure storage are unverified on the devices people use.
- **Fix:**
  - EAS builds signed with company keys;
  - Google Maps keys restricted to the package and signing certificate;
  - the §17 checklist.
- **Tests:** §17, recorded per device.
- **Dependencies:** Apple and Google developer accounts (company-owned), B1 staging, B4.

### B6 — Personal-data rights and retention (DPDP Act 2023) · BLOCKER BEFORE PRODUCTION

- **Problem:** there is no flow for a person to see, correct or erase their data, or
  withdraw consent to processing beyond the existing choices. There is no retention
  schedule for customer data.
- **Impact:** a legal obligation; erasure requests would need manual database work, which
  this project forbids.
- **Fix:**
  - retention schedule per data class (counsel);
  - a data export;
  - erasure by anonymising the person while keeping the legally required financial and
    safety records;
  - a grievance-officer contact in the apps.
- **Tests:** erasure removes personal fields everywhere, including Zoho (via the outbox),
  and keeps invoices valid.
- **Dependencies:** counsel.
- **Pilot:** can run on documented manual escalation to counsel; production cannot.

### B7 — KYC retention period unset · BLOCKER BEFORE PRODUCTION

- **Problem:** `documents.retention` has no value, so leavers' documents are kept
  indefinitely.
- **Fix:** counsel sets the period; operations sets it in the panel (audited).
- **Tests:** the existing retention test.
- **Dependencies:** counsel.

### B8 — Independent security assessment · BLOCKER BEFORE PRODUCTION

- **Problem:** this review was done by the team building the system.
- **Fix:** an external test of staging and the store builds against the OWASP API Top 10,
  ASVS L2 and MASVS, including business-logic abuse (refunds, dispatch, SOS).
- **Tests:** retest every finding; add a regression test for each.
- **Dependencies:** B1, B5.

## 20. Hardening (not blockers)

| Item   | Description                                                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1** | Alert rules on security events and OTP delivery: `ACCESS_DENIED` rate, OTP locks, OTP send failures, refresh-token reuse, reveals per staff member per day |
| **H2** | Shorter absolute session for customers (90 days) if the risk review prefers; device list per account                                                       |
| **H3** | Panel action to suspend a customer (permission exists, no endpoint)                                                                                        |
| **H4** | Certificate pinning and screenshot protection for the start-code screen, if the device matrix shows they do not break networks or accessibility            |
| **H5** | Clear the two moderate advisories with the next Expo upgrade                                                                                               |
