# One Tappe — System matrix

Verified against the code and tests on 23 Sep 2026: branch
`claude/appointment-booking-app-design-tqp3ip`, migrations 0001–0024, 23 API test files
and 247 tests passing, and CI plus the Security workflow green.

**Status:**

- **COMPLETE**: built and tested here.
- **PARTIAL**: built, but part of it is missing or not yet verified against the real
  provider.
- **NOT STARTED**: not built.

**When it must be done:**

- **Before UI**: needed before the app screens are built on it.
- **Before production**: needed before real customers, workers or money.
- **Later**: safe to add after launch.
- **—**: nothing outstanding.

## Identity and access

| Component                                           | Status   | Must be done      | Evidence / what remains                                                                         |
| --------------------------------------------------- | -------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| Customer and worker OTP sign-in                     | PARTIAL  | Before production | Code complete (`auth.test.ts`); run the MSG91 verification list ([08](08-provider-setup.md) §2) |
| OTP abuse controls (limits, lockout, no master OTP) | COMPLETE | —                 | `auth.test.ts`; test OTP only when `APP_ENV=test`                                               |
| Staff login, TOTP MFA, step-up for money actions    | COMPLETE | —                 | `auth.test.ts`, `configuration.test.ts`                                                         |
| Staff account management (invitations, roles)       | COMPLETE | —                 | `staff-admin.test.ts`; `staff-bootstrap` CLI for the first super admin                          |
| Sessions (rotation, reuse detection, idle timeout)  | COMPLETE | —                 | `auth.test.ts`                                                                                  |
| RBAC with city scope                                | COMPLETE | —                 | `failure-journeys.test.ts`, `configuration.test.ts`                                             |
| Personal data masking and audited reveal            | COMPLETE | —                 | `failure-journeys.test.ts`                                                                      |
| Legal documents and consent                         | COMPLETE | Before production | `legal-consent.test.ts`. Final texts are needed from counsel                                    |

## Admin configuration (no direct database edits)

| Component                                           | Status   | Must be done | Evidence / what remains                                                         |
| --------------------------------------------------- | -------- | ------------ | ------------------------------------------------------------------------------- |
| Cities, zones, localities, pincodes, serviceability | COMPLETE | —            | `configuration.test.ts`. Noida launch data to enter ([03](03-inputs-needed.md)) |
| Services, options, tasks (HH60 configuration)       | COMPLETE | —            | `configuration.test.ts`. HH60 values to enter                                   |
| Prices, taxes, charges, worker payout rules         | COMPLETE | —            | Immutable once created, forward-only changes, MFA (`configuration.test.ts`)     |
| Promotions                                          | COMPLETE | —            | `configuration.test.ts`                                                         |
| Operating hours (enforced by the database)          | COMPLETE | —            | `configuration.test.ts`                                                         |
| Cancellation and refund rules                       | COMPLETE | —            | `configuration.test.ts`, `failure-journeys.test.ts`                             |
| Notification templates and channel routes           | COMPLETE | —            | `configuration.test.ts`, `notifications.test.ts`                                |
| Business settings (invoice issuer, Zoho, retention) | COMPLETE | —            | Validated registry; unknown keys refused                                        |
| Audit of every configuration change                 | COMPLETE | —            | Database triggers; reason required                                              |

## Booking

| Component                                                   | Status   | Must be done      | Evidence / what remains                                                                |
| ----------------------------------------------------------- | -------- | ----------------- | -------------------------------------------------------------------------------------- |
| Quote and availability                                      | COMPLETE | —                 | `acceptance.test.ts`, `configuration.test.ts`                                          |
| Booking creation (idempotent, price confirmed)              | COMPLETE | —                 | `booking-flow.test.ts`, `failure-journeys.test.ts`                                     |
| Double-booking protection (database exclusion constraint)   | COMPLETE | —                 | `concurrency.test.ts` (10 simultaneous customers)                                      |
| Dispatch: offer, accept, reject, timeout, re-dispatch       | COMPLETE | —                 | `failure-journeys.test.ts`                                                             |
| Job steps: en route, arrived, start code, complete, no-show | COMPLETE | —                 | `acceptance.test.ts`; retries after lost signal are safe (`failure-scenarios.test.ts`) |
| Reschedule, cancel, hold, manual booking by operations      | COMPLETE | —                 | `failure-journeys.test.ts`, `booking-flow.test.ts`                                     |
| Two staff editing one booking                               | COMPLETE | —                 | `STALE_BOOKING` (`failure-scenarios.test.ts`)                                          |
| Invoices and credit notes                                   | PARTIAL  | Before production | Built. A CA must confirm the GST treatment and invoice series                          |
| Ratings                                                     | COMPLETE | —                 | `acceptance.test.ts`                                                                   |
| Booking trace across the system                             | COMPLETE | —                 | `/admin/bookings/:id/trace` (`observability.test.ts`)                                  |

## Payments

| Component                                                            | Status      | Must be done      | Evidence / what remains                                                                                                              |
| -------------------------------------------------------------------- | ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Razorpay orders, verified webhooks, capture, reconciliation          | PARTIAL     | Before production | Code complete and tested with the signed sandbox. **Not yet run against Razorpay test mode** (§1 list in [08](08-provider-setup.md)) |
| Duplicate, late and out-of-order webhooks; gateway down              | COMPLETE    | —                 | `failure-journeys.test.ts`, `failure-scenarios.test.ts`                                                                              |
| Refunds (automatic, policy-based, dual approval)                     | PARTIAL     | Before production | Tested with the sandbox; verify in Razorpay test mode                                                                                |
| Worker earnings                                                      | COMPLETE    | —                 | Recorded at settlement                                                                                                               |
| Worker payouts (bank details capture, payout batches, bank transfer) | NOT STARTED | Before production | Tables exist (`worker_payout`, encrypted bank account); API and finance flow not built                                               |
| Cash / pay on delivery                                               | NOT STARTED | By decision       | Not added, as decided. The payment interface and `PAY_AFTER_SERVICE` mode allow it later                                             |

## Workers

| Component                                                              | Status   | Must be done      | Evidence / what remains                                                                                                                                                 |
| ---------------------------------------------------------------------- | -------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding, verification, training, shifts, presence, eligibility      | COMPLETE | —                 | `acceptance.test.ts`, `database-guarantees.test.ts`                                                                                                                     |
| KYC document storage (private S3, KMS, malware scan, audit, retention) | PARTIAL  | Before production | Code complete (`documents.test.ts`, `malware-scan.test.ts`, `s3-storage.test.ts`). Verify policy enforcement on the company bucket; counsel to set the retention period |

## Support, safety and Zoho

| Component                                               | Status      | Must be done          | Evidence / what remains                                                                                                 |
| ------------------------------------------------------- | ----------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Support cases → Zoho Desk tickets → status back         | PARTIAL     | Before production     | Complete against a Zoho fake (`zoho-integration.test.ts`); verify with the company Desk ([08](08-provider-setup.md) §3) |
| Zoho CRM customer and booking mirror                    | PARTIAL     | Before production     | Same: built and fake-tested, not verified live                                                                          |
| Zoho outage isolation, retries, dead letter, monitoring | COMPLETE    | —                     | `zoho-integration.test.ts`, `/admin/integrations`                                                                       |
| Zoho SalesIQ chat                                       | NOT STARTED | With the customer app | Client-side SDK in the customer app; escalations become Desk tickets                                                    |
| Zoho Mail (transactional, ZeptoMail)                    | PARTIAL     | Before production     | Adapter built; verify domain and delivery                                                                               |
| Zoho People, Zoho Projects                              | —           | —                     | Not needed by the platform                                                                                              |
| SOS / safety incidents                                  | PARTIAL     | Before production     | Recorded, alerted (`SafetyIncidentOpen`), Desk reference ticket. **Paging a named on-call person is not built**         |

## Notifications

| Component                                             | Status   | Must be done      | Evidence / what remains                                                  |
| ----------------------------------------------------- | -------- | ----------------- | ------------------------------------------------------------------------ |
| Event → configured channels, outbox, retries, consent | COMPLETE | —                 | `notifications.test.ts`; failures never touch booking state              |
| Push (FCM)                                            | PARTIAL  | Before production | Adapter built and fake-tested; verify with the Firebase project          |
| SMS (MSG91, DLT templates)                            | PARTIAL  | Before production | Same; needs DLT templates                                                |
| Email (ZeptoMail)                                     | PARTIAL  | Before production | Same                                                                     |
| WhatsApp                                              | PARTIAL  | Later             | Channel and consent built; provider not chosen, so the channel stays off |
| In-app notification list                              | COMPLETE | —                 | `GET /customer/notifications`                                            |

## Location

| Component                                              | Status      | Must be done                             | Evidence / what remains                                                                                                      |
| ------------------------------------------------------ | ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Address coordinates, radius and pincode serviceability | COMPLETE    | —                                        | The API takes coordinates from the app                                                                                       |
| Maps / geocoding in the apps (pin, address search)     | NOT STARTED | **Decision before UI**                   | Choose the provider (Google Maps Platform or Mappls). It is a client SDK; no backend change needed                           |
| Live worker location and ETA for the customer          | NOT STARTED | Before production, if promised at launch | Status-based tracking (en route, arrived) works today. Live GPS needs the maps decision plus worker-tracking consent (built) |

## Platform, security and operations

| Component                                             | Status      | Must be done      | Evidence / what remains                                                                         |
| ----------------------------------------------------- | ----------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| PostgreSQL as source of truth; DB-enforced rules      | COMPLETE    | —                 | `database-guarantees.test.ts`                                                                   |
| Least-privilege runtime database role                 | COMPLETE    | —                 | Migration 0022; whole suite runs as it                                                          |
| Database failure, failover, partition, deadlock retry | COMPLETE    | —                 | `resilience.test.ts`, `concurrency.test.ts`                                                     |
| Transactional outbox (notifications, integrations)    | COMPLETE    | —                 | Tested with provider outages                                                                    |
| Structured logs, redaction, correlation ids           | COMPLETE    | —                 | `observability.test.ts`                                                                         |
| Metrics, health checks, alert rules                   | COMPLETE    | —                 | `infra/monitoring/alerts.yml`                                                                   |
| Monitoring stack, paging, log store                   | NOT STARTED | Before production | Infrastructure ([07](07-operations-and-recovery.md) §1)                                         |
| Security headers, CORS, placeholder-secret refusal    | COMPLETE    | —                 | `failure-scenarios.test.ts`, `config.test.ts`                                                   |
| Rate limiting: OTP and staff login                    | COMPLETE    | —                 | `auth.test.ts`                                                                                  |
| Rate limiting: edge / WAF for the whole API           | NOT STARTED | Before production | Infrastructure ([06](06-security-review.md) S1)                                                 |
| Secrets in a managed secret store, rotation           | NOT STARTED | Before production | Infrastructure                                                                                  |
| Backups, point-in-time recovery, DR drill             | NOT STARTED | Before production | Plan written ([07](07-operations-and-recovery.md)); infrastructure to implement and drill       |
| Staging and production environments, containers, CD   | NOT STARTED | Before production | Needed first for the provider verification lists                                                |
| CI (format, lint, types, tests, migrations, guard)    | COMPLETE    | —                 | `.github/workflows/ci.yml`, green                                                               |
| Security CI (secrets, dependencies, CodeQL)           | COMPLETE    | —                 | `.github/workflows/security.yml`, green                                                         |
| GitHub branch protection and review rules             | PARTIAL     | **Before UI**     | Files are in place; a repository admin must create `main` and apply [09](09-github-controls.md) |
| Penetration test                                      | NOT STARTED | Before production | Independent tester on staging                                                                   |
| Product analytics                                     | NOT STARTED | Later             | Without personal data (ids only), with consent                                                  |

## Applications

| Component    | Status      | Must be done | Notes                                                                                                                                                                                                                                                                                                      |
| ------------ | ----------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer app | NOT STARTED | Next         | Vertical slice next. Tokens in the Keychain / Keystore; SalesIQ SDK; maps SDK once chosen                                                                                                                                                                                                                  |
| Worker app   | NOT STARTED | Next         | Same slice; retry-safe job steps are ready                                                                                                                                                                                                                                                                 |
| Admin panel  | PARTIAL     | Next         | Built and browser-tested (`e2e/tests/admin.spec.ts`): sign-in with an authenticator, invitations, the live board, booking search, detail and trace, versioned actions, staff management and system status. Still to build: support, safety, refunds, worker verification, customers, configuration screens |

## What is left before the UI slice

Backend code: nothing blocks it. Two decisions and one admin action remain:

1. **GitHub:** create `main` and apply the ruleset ([09](09-github-controls.md)), so UI
   work arrives through reviewed pull requests.
2. **Maps provider** for the location screen (Google Maps Platform or Mappls).
3. **Live tracking at launch or not.** Status-based tracking is ready; live GPS needs item
   2 and a small backend addition.
