# One Tappe — Security review

Reviewed 23 Sep 2026 against the code in this repository. Each area says what is in
place (with the test that proves it), and what is still open. Open items carry one of:

- **Before UI**: must exist before app screens are built on top of it.
- **Before production**: must exist before real customers, workers or money.
- **Later**: safe to add after launch.

## Summary of open items

| #   | Item                                                                                                                                                       | When              | Owner                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------ |
| S1  | Edge rate limiting / WAF in front of the API (per IP and per token), bot protection on OTP endpoints                                                       | Before production | Infrastructure (company cloud) |
| S2  | Admin panel session through a BFF with an httpOnly, Secure, SameSite=Strict cookie. No tokens in browser storage                                           | Before UI (admin) | Built with the admin panel     |
| S3  | Mobile apps: tokens in Android Keystore / iOS Keychain; certificate pinning decision; no PII in analytics SDKs                                             | Before UI (apps)  | Built with the apps            |
| S4  | Production login user created as a member of `onetappe_app` (never the owner); migrator credential only in the release pipeline                            | Before production | Infrastructure                 |
| S5  | Backups encrypted, in a separate account; restore drill done and timed ([07](07-operations-and-recovery.md))                                               | Before production | Infrastructure                 |
| S6  | Secrets in a managed secret store (AWS Secrets Manager / GCP Secret Manager); rotation runbook                                                             | Before production | Infrastructure                 |
| S7  | Penetration test by an independent tester on staging                                                                                                       | Before production | Company                        |
| S8  | Provider delivery-report webhooks (MSG91, FCM, ZeptoMail) are not ingested; failures seen only as send errors                                              | Later             | Backend                        |
| S9  | Document retention period for worker KYC to be confirmed by counsel (the `documents.retention` setting; until it is set, nothing is deleted automatically) | Before production | Company / counsel              |
| S10 | SOS: today a safety incident is recorded, alerted (metrics/alert rule) and sent to Desk. Paging an on-call person is not built                             | Before production | Backend + operations           |

## 1. Access to other people's records (IDOR)

- Every customer and worker endpoint filters by the signed-in user in the query. Records
  of another user answer 404, so their existence is not revealed. This is not checked
  after loading the record.
- Staff endpoints check the permission and the staff member's city scope. A booking
  outside their scope is 404.
- The same assignment check applies to worker job actions, including the new retry rule.
  A retry only succeeds for the person who did the step.
- **Tests:** `failure-scenarios.test.ts` › "other people's records (IDOR)" covers:
  - a customer trying 12 kinds of access to another customer's booking, address and case;
  - a worker reading someone else's job;
  - a customer token calling worker and admin APIs.
    `failure-journeys.test.ts` covers staff city scope and permissions.

## 2. OTP abuse

Policy (`OTP_POLICY` in `auth/otp/otp.service.ts`):

- 6-digit codes, valid for 5 minutes, and only a salted HMAC is stored.
- A new code is available after 30 seconds.
- Each code allows 5 verification attempts.
- Limits per phone: 5 requests per hour, 10 per day, and 10 wrong codes per hour before
  a 1-hour lock.
- Limit per IP: 20 requests per hour.

If the provider fails, the code is withdrawn and no cooldown is spent. There is no bypass
or master code. The `test` provider starts only when `APP_ENV=test`, and `console` only in
local/test. **Tests:** `auth.test.ts`.

The per-IP limit uses the client IP. Only the `X-Forwarded-For` entries added by our own
proxies are trusted (`TRUSTED_PROXY_HOPS`, 1 = the load balancer, the default in staging
and production), so a caller cannot choose its IP by sending the header. The admin panel's
server may pass a staff member's IP only with the shared `BFF_SHARED_SECRET` key.
**Test:** `client-ip.test.ts`. The limits live in PostgreSQL, so they hold across
instances, but edge limits (S1) are still needed against volumetric abuse.

## 3. Sessions

| App      | Access token | Session lifetime | Idle timeout |
| -------- | ------------ | ---------------- | ------------ |
| Customer | 15 min       | 90 days          | —            |
| Worker   | 15 min       | 30 days          | —            |
| Admin    | 10 min       | 12 hours         | 30 min       |

- Refresh tokens rotate on every use. Reusing an old refresh token revokes the session
  (replay detection).
- Tokens are bound to the app they were issued for.
- Staff sign in with a password plus a TOTP authenticator. After repeated wrong passwords
  the account locks for 15 minutes. Codes cannot be replayed.
- Money and override actions need an MFA check within the last 10 minutes.
- **Tests:** `auth.test.ts`, `configuration.test.ts` ("money changes need a recent
  authenticator check").

## 4. XSS and CSRF

- The API only serves JSON. Every response carries:
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Cache-Control: no-store`
  - HSTS in staging and production.
    **Test:** `failure-scenarios.test.ts` › "response headers".
- Authentication is by bearer token, not by cookie, so the API itself is not exposed to
  CSRF. CORS is off unless `CORS_ORIGINS` lists exact origins, and credentials are never
  allowed.
- Open (S2): the admin panel must not keep tokens in `localStorage`. Its server-side
  "backend for frontend" holds the session in an httpOnly cookie and adds CSRF protection
  on its own routes. Text shown in the admin panel and apps must be rendered as text (React
  default), never as HTML.

## 5. File uploads (worker documents)

- Files go straight to a private S3 bucket through a presigned POST. The policy fixes the
  object key, the content type, a size of 1 byte to 5 MB and server-side encryption (KMS
  in production), and the upload window is 5 minutes.
- The bucket is never public. Object keys contain only ids (`workers/<id>/<check>/<random>`),
  never names or phone numbers.
- On submission the API:
  - checks the real file type from its bytes (JPEG, PNG or PDF only; HTML and SVG are
    refused and deleted);
  - records a SHA-256 hash;
  - queues a ClamAV scan.
- Staff can open a document only when:
  - its scan is clean;
  - its hash still matches (tamper check);
  - they hold `worker.documents.view`;
  - they give a reason, which is audited.
- The file is served as an attachment with nosniff, a sandbox CSP and no-store.
- Retention: a leaver's documents are deleted after the configured period, keeping the
  record and hash. Abandoned uploads are removed after 24 hours.
- **Tests:** `documents.test.ts`, `malware-scan.test.ts` (real clamd and the EICAR
  signature), `s3-storage.test.ts` (policy content).
- **Not yet verified:** S3's enforcement of the policy on the company bucket (the local S3
  emulator does not enforce POST policies). This is on the launch checklist in
  [08](08-provider-setup.md).

## 6. Webhook spoofing

- **Razorpay:** HMAC-SHA256 of the raw body with a webhook secret that is different from
  the API key secret, compared in constant time. Events are stored once per event id, and
  amounts and order ids are checked against our record. A forged webhook is rejected and
  logged. **Test:** `failure-journeys.test.ts` ("a forged one is rejected").
- **Zoho Desk:** a shared key is required (32+ characters, compared in constant time).
  The body is only a hint; the ticket is fetched from Zoho with our OAuth token. A forged
  webhook can at most trigger a harmless re-read. **Test:** `zoho-integration.test.ts`.

## 7. Personal data in logs, errors and metrics

- Logs are JSON and redact:
  - keys named phone, email, address, name, lat/lng, token, OTP, code, PAN, Aadhaar,
    account number, IFSC and similar;
  - anything that looks like an Indian mobile number, masked to its last four digits.
- Access logs record the route pattern (`/customer/bookings/:id`), never the raw URL or
  query.
- Error responses carry a code, a message and the request id. Unknown errors become
  `INTERNAL_ERROR`, with no stack trace or SQL.
- Metrics labels are route patterns, job names and outcomes only.
- Staff see phone numbers and addresses masked unless they hold the reveal permission;
  each reveal is audited.
- Zoho receives the minimum:
  - CRM gets name, phone and customer id for support;
  - Desk safety tickets carry references only, not the incident narrative.
- **Tests:** `observability.test.ts` (redaction and route patterns), `failure-journeys.test.ts`
  (masking and audited reveal).

## 8. Secrets

- Nothing secret is in the repository:
  - `.env` files are ignored by git;
  - `.env.example` holds placeholders only;
  - gitleaks scans the full history on every push, with two reviewed false positives
    listed by fingerprint.
- Outside local/test the API refuses to start with:
  - `.env.example` or test values;
  - a non-random encryption key;
  - live Razorpay keys in staging, or test keys in production;
  - console/test OTP;
  - log-only notification senders;
  - local storage or no malware scanning;
  - plain-HTTP provider URLs.
    **Tests:** `config.test.ts`, `notifications.test.ts`.
- Encrypted at rest in the database (AES-256-GCM with `DATA_ENCRYPTION_KEY`):
  - staff TOTP secrets;
  - the Zoho access token.
    Worker bank account numbers have an encrypted column (plus last 4 digits), but the API
    that captures bank details is not built yet (it belongs with worker payouts).
- Open (S6): the store and rotation of production secrets is an infrastructure task.

## 9. Privilege escalation

- There are 8 staff roles with granular permissions and no universal bypass. City scope
  limits most roles.
- Money actions:
  - refunds on completed bookings need a second person to approve, with fresh MFA;
  - price and payout changes need `pricing.manage` plus fresh MFA.
- Every configuration change requires a written reason and is audited.
- Staff accounts (`/admin/staff`, `user.manage`, fresh MFA, a reason) work as follows:
  - accounts are created by invitation: a single-use, 72-hour link; the person chooses a
    password of 12+ characters and enrols the authenticator at first sign-in, so nobody
    knows another person's password;
  - nobody can change their own roles, status, MFA or invitation;
  - customer and worker accounts can never be made staff;
  - the last active super administrator cannot be removed;
  - suspending or resetting MFA ends all of that person's sessions;
  - a revoked role stops working on the next request.
- The first super administrator of a new environment is created once by
  `staff-bootstrap` (refused when one exists).
- **Tests:** `staff-admin.test.ts`, `failure-journeys.test.ts`, `configuration.test.ts`.

## 10. Database permissions

- Migration 0022 creates `onetappe_app`. The runtime login is a member of it, so it:
  - cannot alter tables, disable triggers, TRUNCATE or change `schema_migration`;
  - cannot update or delete audit, history, invoice and other append-only rows. The
    triggers refuse this too, even for the owner.
- The whole test suite runs as that role. **Tests:** `database-guarantees.test.ts` ›
  "least privilege".
- Business rules also live in the database, so they hold for any client:
  - the booking state machine;
  - reservation overlap exclusion;
  - worker eligibility;
  - operating hours;
  - immutable money rules;
  - a required actor context on critical writes.
- Open (S4): create the production login as a member of the role; keep the owner
  credential only in the migration step of the release pipeline.

## 11. Encryption

- In transit:
  - TLS at the edge;
  - HTTPS required for every provider URL outside local/test;
  - PostgreSQL connections over TLS (managed-database default; set `sslmode=require` in
    `DATABASE_URL`).
- At rest:
  - managed PostgreSQL storage encryption;
  - S3 SSE-KMS with a customer-managed key (required in production);
  - field-level AES-256-GCM for the secrets listed in §8.

## 12. Backups

Covered in [07-operations-and-recovery.md](07-operations-and-recovery.md):

- backups are encrypted and held in a separate account with restricted access;
- restores are tested;
- backup access is logged.

## 13. Dependencies

- Lockfile installs only (`--frozen-lockfile`).
- `pnpm audit --audit-level high` runs in CI and weekly.
- Pull requests get a dependency review.
- Dependabot opens weekly update pull requests.
- CodeQL runs the security-extended queries.
- Today there are no known vulnerabilities (`pnpm audit`, 23 Sep 2026).
