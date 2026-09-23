# One Tappe — Provider setup and launch verification

Every account below belongs to the company and is opened with a company email. Developers
get role-based access to staging only. Production credentials go into the cloud secret
manager and are never pasted into chats, tickets or files.

The development sandbox used to build this code could not reach `razorpay.com`,
`zoho.com`/`desk.zoho.com` or `msg91.com`. The adapters were built against:

- the official Razorpay Node SDK source (API paths and signature scheme);
- Zoho and MSG91 documentation found through search;
- tests with local fakes that reproduce each provider's documented behaviour.

**Each "Verify" list below must be run against the real test accounts before
production**. It is part of the launch checklist ([10-system-matrix.md](10-system-matrix.md)).

## 1. Razorpay (payments)

**Staging uses test mode (`rzp_test_…`), production uses live mode (`rzp_live_…`).** The
API refuses live keys outside production and test keys in production.

| Setting (Razorpay Dashboard) | Value                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| API keys                     | Generate in _Account & Settings → API Keys_; key id → `RAZORPAY_KEY_ID`, secret → `RAZORPAY_KEY_SECRET`                               |
| Payment capture              | **Automatic capture** turned on. The server still captures any payment it finds only _authorized_, as a fallback (reconciliation job) |
| Webhook URL                  | `https://<api-domain>/api/v1/payments/webhooks/razorpay`                                                                              |
| Webhook secret               | A new random value (not the API key secret) → `RAZORPAY_WEBHOOK_SECRET`                                                               |
| Webhook events               | `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`                         |
| Payment methods              | UPI, cards, net banking, wallets as the business chooses. The app never handles card data (Razorpay Checkout)                         |
| Refund speed                 | Normal (default). Instant refunds are a business decision (extra fee)                                                                 |
| Team access                  | Owner: director. Developers: _Developer_ role on test mode only. Finance: _Finance_ role                                              |

Environment: `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
`RAZORPAY_WEBHOOK_SECRET`.

**Verify in test mode before production:**

1. Pay by UPI (success) and by a test card (success).
2. Fail a payment. The booking stays payable, and a retry succeeds.
3. Close Checkout after paying, before the app hears back. "I have paid" (refresh)
   confirms the booking.
4. Temporarily disable the webhook. The reconciliation job confirms within a minute.
5. Turn auto-capture off in test mode. The server captures authorized payments.
6. Make a late payment after the booking has expired. It is refunded automatically.
7. Customer cancellation refund. A refund on a completed booking, with dual approval.
8. Resend a webhook from the dashboard. It is processed once (duplicate).
9. Tamper with a webhook body or secret. It is rejected (401), and nothing changes.
10. Compare the dashboard's payments and refunds for the day with
    `/admin/system/status` and the `payment` and `refund` tables.

## 2. MSG91 (OTP and transactional SMS)

**Prerequisite (India): DLT registration.** Register the company entity, a 6-character
sender header and every SMS template (English and Hindi) on a DLT portal. Operators block
unregistered messages.

| Setting                     | Value                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Auth key                    | Company MSG91 account → `MSG91_AUTH_KEY` (separate keys for staging and production)                                           |
| OTP template                | The DLT-approved OTP template, created in MSG91 → `MSG91_TEMPLATE_ID`                                                         |
| Transactional SMS templates | One MSG91 Flow per notification with its DLT template id, set per template in the admin panel (`/admin/config/notifications`) |
| IP allow-list (if enabled)  | The production NAT egress IPs                                                                                                 |

Environment: `OTP_PROVIDER=msg91`, `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`,
`MSG91_TEMPLATE_ID`, and `MSG91_API_URL` (default `https://control.msg91.com`).

There is no test or master OTP outside automated tests. The `test` and `console`
providers refuse to start in staging and production.

**Verify on staging with real phones (Jio, Airtel, Vi, BSNL):**

1. A code arrives within 10 seconds in English and in Hindi.
2. A wrong code is rejected. After 5 wrong codes the challenge is locked.
3. An expired code (after 5 minutes) is rejected.
4. Resend is refused within 30 seconds; the hourly and daily caps apply.
5. With an invalid auth key, the app shows "could not send" (503) and the code is
   withdrawn.
6. The delivery report in the MSG91 panel matches our `otp_challenge.delivery_reference`.

## 3. Zoho (CRM, Desk; SalesIQ with the app)

Data centre: India (`accounts.zoho.in`, `www.zohoapis.in`, `desk.zoho.in`). These are the
defaults.

| Step                | What to do                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API client          | In the Zoho API Console, create a _Server-based_ (or _Self_) client → `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`                                                             |
| Scopes              | Desk: `Desk.tickets.ALL`, `Desk.contacts.ALL`, `Desk.search.READ`, `Desk.basic.READ`. CRM: `ZohoCRM.modules.ALL`. Verify the exact names in the console                  |
| Refresh token       | Generate with `access_type=offline` for a dedicated integration user (not a person's account) → `ZOHO_REFRESH_TOKEN`                                                     |
| Desk organisation   | Desk org id → `ZOHO_DESK_ORG_ID`                                                                                                                                         |
| Desk custom fields  | Ticket fields for case code, booking code, customer id and category. Put their API names (`cf_…`) in the `zoho.desk` setting                                             |
| Desk department     | Department id for One Tappe tickets → the `zoho.desk` setting (`departmentId`)                                                                                           |
| Desk status mapping | Custom statuses → One Tappe statuses in `zoho.desk.statusMap` (Open/Closed are built in)                                                                                 |
| Desk webhook        | Ticket update events → `https://<api-domain>/api/v1/integrations/zoho-desk/webhook`, header `x-onetappe-webhook-key: <ZOHO_DESK_WEBHOOK_SECRET>` (32+ random characters) |
| CRM                 | A custom field on Contacts for the One Tappe customer id (unique) → `zoho.crm.contactIdField`. An optional custom module for bookings → `zoho.crm.bookingModule`         |
| Turn on             | `ZOHO_DESK_ENABLED=true`, `ZOHO_CRM_ENABLED=true`                                                                                                                        |

The two business settings are edited in the admin panel (`PUT /admin/settings/:key`,
validated and audited).

**SalesIQ:**

- Create the chat widget and use the mobile SDK in the customer app (next milestone).
- Chats that need action are converted to Desk tickets in Zoho. SalesIQ holds no booking
  data of its own.
- Pass the customer id and booking code as visitor info, never the phone or address.

**People and Projects:** no integration is needed for the booking platform.

**Verify on staging:**

1. A customer opens a support case in the app. A Desk ticket appears with the case code,
   booking code and customer id.
2. The agent changes the status in Desk. Within seconds (webhook) or 10 minutes (pull)
   the customer sees it.
3. With the Zoho token revoked, the integration pauses. It shows in
   `/admin/integrations`, bookings continue, and resume sends the backlog.
4. Burst 200 events. There is no rate-limit error storm, and the target pauses and
   resumes.
5. A CRM contact is created once per customer and updated on profile change.

## 4. Push (Firebase Cloud Messaging)

- Firebase project (company Google account). Service account with the _Firebase Cloud
  Messaging API Admin_ role, JSON key → `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL` and
  `FCM_PRIVATE_KEY` (keep the key's newlines as `\n`).
- iOS: an APNs key uploaded to Firebase.
- `PUSH_PROVIDER=fcm`.
- **Verify:**
  - delivery to Android and iOS;
  - an unregistered token disables that device;
  - notifications are not sent when a customer has switched a channel off.

## 5. Email (ZeptoMail)

- Verify the sending domain (SPF, DKIM, DMARC). Create a Mail Agent and a _Send Mail_
  token → `ZEPTOMAIL_TOKEN`.
- Set `EMAIL_FROM_ADDRESS` and `EMAIL_FROM_NAME`, and `EMAIL_PROVIDER=zeptomail`.
- **Verify:** delivery to Gmail and Outlook, not spam; bounces visible in ZeptoMail.

## 6. WhatsApp

Provider not chosen yet (open decision). The channel exists and needs WhatsApp consent.
Until a provider is chosen, keep `WHATSAPP_PROVIDER=none`: messages are recorded as
skipped, with the reason.

## 7. Document storage (AWS S3 + KMS) and ClamAV

| Setting                 | Value                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Bucket                  | `onetappe-<env>-documents` in `ap-south-1`; _Block Public Access_ all on; Object Ownership: bucket owner enforced                  |
| Encryption              | SSE-KMS with a customer-managed key → `S3_KMS_KEY_ID` (required in production); bucket key on                                      |
| Versioning              | On; non-current versions expire after the retention period                                                                         |
| Bucket policy           | Deny non-TLS requests; deny `PutObject` without `aws:kms` encryption                                                               |
| CORS                    | `POST` from the worker PWA origin only (native apps need none)                                                                     |
| IAM (API + worker role) | `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `workers/*`; `kms:GenerateDataKey`, `kms:Decrypt` on the key; no `ListBucket` |
| ClamAV                  | `clamd` in the private network (sidecar or internal service), `freshclam` updating signatures → `CLAMAV_HOST`, `CLAMAV_PORT`       |

Environment: `STORAGE_PROVIDER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_KMS_KEY_ID`,
`MALWARE_SCANNER=clamav`.

**Verify against the real bucket** (the local emulator does not enforce upload
policies):

1. Uploading more than 5 MB is refused by S3.
2. A different content type is refused.
3. A different key is refused.
4. After 5 minutes the upload URL is refused.
5. The object has SSE-KMS.
6. The object URL without a signature returns 403.
7. The EICAR test file is removed and the verification withdrawn.

## 8. PostgreSQL

- Managed PostgreSQL 16:
  - Multi-AZ;
  - storage encryption;
  - TLS required (`sslmode=require` in `DATABASE_URL`);
  - point-in-time recovery on (see [07](07-operations-and-recovery.md)).
- Two credentials:
  - **Owner / migrator:** used only by the release pipeline's `pnpm db:migrate` step.
  - **Runtime login:** `CREATE ROLE onetappe_api LOGIN PASSWORD '…' IN ROLE onetappe_app;`.
    Its URL is the API's and worker's `DATABASE_URL`. Migration 0022 creates
    `onetappe_app`; this needs the `CREATEROLE` privilege, which the managed master user
    has.
- First staff account:
  `DATABASE_URL=<runtime url> node dist/staff-bootstrap.cli.js --email <director email> --name "<name>"`.
  Hand the printed invitation token over in person.

## 9. Secrets and other settings

| Variable                                                           | Notes                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `AUTH_TOKEN_SECRET`, `OTP_HASH_SECRET`, `VERIFICATION_CODE_SECRET` | 32+ random bytes each (`openssl rand -base64 32`); different per environment                            |
| `DATA_ENCRYPTION_KEY`                                              | 32 random bytes, base64. Rotating it needs a re-encryption step (runbook to write before rotation)      |
| `METRICS_TOKEN`                                                    | 32+ random characters; given to the Prometheus scraper only                                             |
| `CORS_ORIGINS`                                                     | Exact admin panel / PWA origins                                                                         |
| `TRUSTED_PROXY_HOPS`                                               | Number of our proxies that add `X-Forwarded-For` (1 = load balancer; the default in staging/production) |
| `BFF_SHARED_SECRET`                                                | 32+ random characters, shared only by the API and the admin panel server                                |
| `LOG_LEVEL`                                                        | `info` in production                                                                                    |
