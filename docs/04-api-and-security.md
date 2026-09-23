# One Tappe — API, access control and integrations

Milestone 2: authentication, authorization, API endpoints, payments, OTP, notifications and the
background worker. All of it wraps the booking engine from milestone 1. Controllers only parse
input and call services; the database still has the final say on availability, transitions and
history.

## 1. Environments

`APP_ENV` is one of `local`, `test`, `staging`, `production`. The API refuses to start when the
configuration does not fit the environment (`apps/api/src/config/env.ts`):

| Rule                                                                                           | Why                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Production must use `OTP_PROVIDER=msg91` and `PAYMENT_PROVIDER=razorpay` with `rzp_live_` keys | No simulated OTP or payments in production       |
| Non-production environments must not use `rzp_live_` keys                                      | Development never touches real money             |
| `OTP_PROVIDER=test` (fixed code) only in `test`; `console` only in `local`/`test`              | No universal or static bypass OTP outside tests  |
| Every secret is distinct and at least 32 characters                                            | One leaked secret does not unlock the others     |
| Production is refused until managed document storage exists                                    | Worker documents never sit on an app server disk |

Secrets come from the environment only (`.env` locally, the company secret manager elsewhere).
`.env` is git-ignored and `apps/api/.env.example` has local-only values.

**Processes.** One build, two processes:

- `node dist/main.js`: the HTTP API.
- `node dist/worker.js`: background jobs. You can run several; each job holds a database lease,
  so only one instance runs a given job at a time.

## 2. Authentication

| Who      | How                                                             | Session                                                           |
| -------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| Customer | Phone → 6-digit OTP. No password.                               | 15-minute access token and a rotating refresh token (90 days)     |
| Worker   | Phone → OTP. Signing in does not mean the worker may take jobs. | 15-minute access token and a rotating refresh token (30 days)     |
| Staff    | Email + password → authenticator app (TOTP) → session           | 10-minute access token, 30-minute idle timeout, 12 hours absolute |

**OTP protection** (`OTP_POLICY`):

- A code expires after 5 minutes.
- A new code can be requested after 30 seconds.
- A code allows 5 attempts.
- Each phone can request 5 codes an hour and 10 a day.
- Each IP address can make 20 requests an hour.
- After 10 wrong codes in an hour, the phone is locked for an hour.
- Codes are stored as HMACs. Attempt counters are saved even when verification fails.
- One phone number maps to one identity (`app_user.phone` is unique).

**Staff protection:**

- Passwords are hashed with scrypt.
- 5 wrong passwords lock the account for 15 minutes.
- An unknown email takes the same time to reject as a wrong password.
- MFA is enrolled on first sign-in.
- A used TOTP step cannot be replayed.
- Sensitive actions (approving refunds, confirming without prepayment, starting without a code,
  changing business settings) also need the authenticator re-entered within the last 10 minutes
  (`POST /auth/staff/step-up`).

**Refresh tokens:**

- Refresh tokens are stored hashed and rotated on every use.
- Presenting an old refresh token again revokes the whole session (reuse detection).
- Every request re-checks the session in the database, so logout and revocation take effect
  immediately.

## 3. Worker lifecycle and eligibility

```
REGISTERED → PROFILE_PENDING → DOCUMENTS_PENDING → VERIFICATION_PENDING → TRAINING_PENDING
  → APPROVED → ACTIVE      (also SUSPENDED, RESTRICTED, REJECTED, INACTIVE)
```

- The database enforces the allowed transitions, and every transition lands in
  `worker_status_history`.
- The capacity engine only considers a worker at the moment of dispatch when all of these hold:
  - the worker is `ACTIVE` (or `RESTRICTED`, if the restriction does not cover this service);
  - the worker has permission for the service;
  - the worker is not blocked by the customer;
  - the worker has a shift covering the whole visit, including travel;
  - no other reservation overlaps;
  - for instant bookings, the worker is online.

## 4. Roles and permissions

Eight staff roles, defined in migration `0011`. No role holds every permission, including
`SUPER_ADMIN`, which administers users, roles and configuration but cannot see bookings or
money. A role can be limited to one city.

| Role                | Can                                                                           | Cannot                                        |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| `SUPER_ADMIN`       | Staff accounts, role grants, settings, catalog, service areas, audit log      | Bookings, customers, payments                 |
| `OPERATIONS_HEAD`   | Live operations, overrides, worker status, reveal PII (audited)               | Approve refunds, see payments                 |
| `DISPATCHER`        | Manual bookings, assign/reassign, reschedule, cancel, no-shows, shifts        | Overrides, refunds, worker verification       |
| `CUSTOMER_SUPPORT`  | Support cases, refund requests, reschedule/cancel, customer contact (audited) | Approve refunds, see payments, see worker PII |
| `WORKER_OPERATIONS` | Onboarding, documents, verification, training, status, shifts                 | Bookings, customers, money                    |
| `FINANCE`           | Payments, refunds (approve), invoices, payouts, pricing, worker bank details  | Customer or worker contact details            |
| `SAFETY`            | Incidents, restrictions, suspensions, reveal PII for incidents                | Money                                         |
| `AUDITOR`           | Read everything masked, plus the audit log                                    | Reveal PII, change anything                   |

**Separation of duties:** nobody approves their own refund. Refund approval, override and
settings changes need a recent MFA check.

## 5. Personal data

- **Masking by default.** Staff APIs mask personal data: `******3210`, `ra***@gmail.com`,
  `R*** K***`, and a partial address.
- **Revealing a record** means calling `POST /admin/customers/:id/reveal` or
  `POST /admin/workers/:id/reveal`. It requires `customer.pii.reveal` or `worker.pii.reveal`, a
  written reason, and writes an audit event with the fields that were revealed.
- **Worker documents** are stored encrypted (AES-256-GCM). Each one is opened through a
  short-lived signed link, and the audit log records who opened it.
- **Workers see only what the job needs:**
  - An offer shows no address or customer details.
  - Once the job is theirs, the worker sees the customer's first name and the address.
  - The worker sees the customer's phone number only from assignment until the visit ends.

## 6. API

Base path `/api/v1`. The API sends JSON, money in integer paise and times as ISO-8601 UTC.
Errors look like `{ "error": { "code", "message", "details", "requestId" } }`.

Customer and worker requests that create something need an `Idempotency-Key` header. A retry
returns the first result with `replayed: true`.

**Customer** (`/customer`, customer token):

| Area      | Endpoints                                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in   | `POST /customer/auth/otp`, `POST /customer/auth/verify` (returns `isNewUser`), `POST /auth/refresh`, `POST /auth/logout`                                                                                                                     |
| Profile   | `GET/PATCH /me`, `POST /devices`, `GET/POST /addresses`, `POST /addresses/:id/archive`                                                                                                                                                       |
| Catalogue | `GET /serviceability`, `GET /catalog`, `GET /services/:id`, `POST /quotes`, `GET /availability`                                                                                                                                              |
| Bookings  | `POST /bookings`, `GET /bookings`, `GET /bookings/:id`, `GET /bookings/:id/timeline`, `POST /bookings/:id/cancel`, `POST /bookings/:id/reschedule`, `GET /bookings/:id/start-code`, `GET /bookings/:id/invoice`, `POST /bookings/:id/rating` |
| Payment   | `POST /bookings/:id/payments` (returns gateway checkout details), `POST /bookings/:id/payments/:paymentId/refresh`                                                                                                                           |
| Help      | `POST/GET /support-cases`, `POST /sos`, `GET /notifications`                                                                                                                                                                                 |

**Worker** (`/worker`, worker token):

| Area       | Endpoints                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in    | `POST /worker/auth/otp`, `POST /worker/auth/verify`                                                                                                                                               |
| Onboarding | `GET/PATCH /me`, `GET /me/verifications`, `POST /me/documents` (signed upload link), `POST /me/verifications`, `GET /me/training`                                                                 |
| Work       | `POST /me/presence`, `GET /me/shifts`, `GET /offers`, `POST /offers/:id/accept`, `POST /offers/:id/reject`                                                                                        |
| Job        | `GET /jobs/current`, `GET /jobs`, `GET /jobs/:bookingId`, `POST /jobs/:bookingId/en-route`, `/arrived`, `/start` (takes the customer's start code), `/complete`, `/customer-no-show`, `/withdraw` |
| Money      | `GET /earnings`                                                                                                                                                                                   |
| Help       | `POST /support-cases`, `POST /sos`                                                                                                                                                                |

**Admin** (`/admin`, staff token + permission):

| Area      | Endpoints                                                                                                                                                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in   | `POST /auth/staff/login`, `POST /auth/staff/mfa`, `POST /auth/staff/step-up`                                                                                                                                                                                     |
| Bookings  | `GET /bookings` (search), `POST /bookings` (manual), `GET /bookings/:id` (with timeline), `/assign`, `/redispatch`, `/reschedule`, `/cancel`, `/customer-no-show`, `/worker-no-show`, `/confirm-without-prepayment`, `/start-override`, `/hold`, `/release-hold` |
| People    | `GET /customers`, `GET /customers/:id`, `POST /customers/:id/reveal`, `GET /workers`, `GET /workers/:id`, `POST /workers/:id/reveal`, verifications, documents, training, status, service permissions, shifts, restrictions                                      |
| Money     | `GET/POST /refunds`, `POST /refunds/:id/approve`, `POST /refunds/:id/reject`                                                                                                                                                                                     |
| Cases     | `GET /support-cases`, `GET /support-cases/:id`, `POST /support-cases/:id/actions`, safety incidents (same shape)                                                                                                                                                 |
| Oversight | `GET /audit`, `PUT /settings/:key`                                                                                                                                                                                                                               |

Every admin change needs a written reason. The database records the actor, role, source,
request id, time, previous and new state for every change, and those records cannot be edited
or deleted.

## 7. Payments

- **Provider-neutral.** `PaymentProvider` has two implementations: `razorpay` (staging uses test
  keys, production uses live keys) and `sandbox`, a signed simulator for local and test work.
  Card details never reach One Tappe; the app opens the gateway checkout.
- **Razorpay account setting.** Turn on automatic capture in the Razorpay dashboard. Only
  `captured` payments confirm a booking; an `authorized`-only payment stays pending.
  Configure the webhook with the events `payment.captured`, `payment.failed`,
  `refund.processed` and `refund.failed`, pointing at `/api/v1/payments/webhooks/razorpay`.
  The webhook secret must differ from the API key secret.
- **A booking is paid only when the server has verified the payment:**
  - either through a signed gateway webhook,
  - or through the API asking the gateway directly (`refresh`, and a reconciliation job every
    minute).
  - A "success" message from the app changes nothing.
- **Webhooks are idempotent.** The signature is checked on the raw body, and each gateway event
  is stored once by its id. A repeated webhook returns `DUPLICATE` and changes nothing.
- **Edge cases:**
  - A second payment for an already-paid booking is refunded automatically.
  - A payment arriving after the booking expired or was cancelled is refunded automatically.
  - An amount mismatch is flagged for finance.
- **Refunds:**
  - Refunds follow the configured cancellation rules.
  - A refund that is not covered by a policy needs a second person holding `refund.approve`.
  - A refund is sent to the gateway once, looked up before any retry, and settles when the
    gateway's webhook arrives.

## 8. Background jobs (`dist/worker.js`)

| Job                      | Every | Does                                                                        |
| ------------------------ | ----- | --------------------------------------------------------------------------- |
| `expire-unpaid-bookings` | 30 s  | Expires bookings whose payment window passed and releases the worker hold   |
| `release-expired-holds`  | 60 s  | Releases temporary reservations left behind                                 |
| `expire-worker-offers`   | 15 s  | Times out unanswered offers and offers the next eligible worker             |
| `redispatch-unassigned`  | 60 s  | Retries bookings that had no eligible worker                                |
| `dispatch-notifications` | 5 s   | Sends queued notifications; retries at 1, 5, 15 and 60 minutes, max 5 tries |
| `reconcile-payments`     | 60 s  | Asks the gateway about open orders (covers a lost webhook)                  |
| `process-refunds`        | 60 s  | Sends approved refunds to the gateway                                       |
| `settle-bookings`        | 60 s  | Issues the invoice, records worker earnings and closes completed bookings   |

Every job can safely run twice. Each one works from current database state under row locks and
unique keys, and each run is logged in `job_run`.

## 9. Notifications

- **One outbox.** Notifications go through a single outbox (`notification`) with a dedupe key,
  so an event is never sent twice on the same channel.
- **Templates.**
  - Templates are stored per event, channel and language. English and Hindi are seeded; English
    is the fallback.
  - Events:
    - booking confirmed, payment successful
    - worker assigned, worker arriving
    - service started, service completed
    - rescheduled, cancelled
    - refund initiated, refund completed
  - Channels: push, SMS, WhatsApp, email and in-app.
- **Senders are log-only for now.** Real providers plug in behind `ChannelSender` once the
  company's accounts exist.

## 10. OTP delivery

`OtpSender` has three implementations:

- `msg91`: production and staging.
- `console`: local only; prints the code to the log.
- `test`: automated tests only; fixed code.

The environment rules in section 1 keep the last two out of production.

## 11. CI and merge rules

GitHub Actions (`.github/workflows/ci.yml`) runs six jobs on every push and pull request:

1. `format`: Prettier.
2. `lint`: typescript-eslint, strict type-checked.
3. `typecheck`: TypeScript, plus a production build.
4. `domain-tests`: state machine, pricing and capacity unit tests.
5. `migrations`: applies all migrations to an empty database, re-applies them (must apply 0) and
   checks the generated database types are current.
6. `integration-tests`: PostgreSQL 16 tests covering:
   - the full HTTP acceptance journey
   - the failure journeys
   - concurrency
   - database guarantees
   - authentication

**To require these before merge**, turn on branch protection for `main` in the GitHub repository
settings (Settings → Branches), with required status checks set to the six jobs above. This is a
repository setting and cannot be set from code.

## 12. Tested journeys

`apps/api/test/acceptance.test.ts` follows one HH60 booking through the API, end to end:

1. A customer signs up with OTP, adds a Noida address, views HH60, gets a quote and books.
2. The customer pays through the sandbox gateway. The booking is confirmed from the signed
   webhook.
3. Worker operations onboards a worker through the API.
4. The worker gets the offer and accepts it, then marks en route and arrived.
5. The customer's start code starts the job, and the worker completes it.
6. The booking closes, the invoice is issued and the worker's earning is recorded.
7. The customer rates the visit, and the full timeline and audit trail are checked.

`apps/api/test/failure-journeys.test.ts` covers:

- payment failure, duplicate webhook, and a payment arriving after expiry (refund)
- no worker available, worker rejection, offer timeout, worker no-show
- customer cancellation with refund through to settlement
- rescheduling
- a refund that needs a second approver
- concurrent booking of the last slot
- a repeated request with the same idempotency key
- invalid and expired OTP
- invalid start code, with lockout
