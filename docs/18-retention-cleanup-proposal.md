# One Tappe: operational data cleanup (G5) proposal

**Status:** proposal. **Not implemented.** No retention period is chosen here: periods for
OTP, session, security, audit, KYC and financial data need approved retention rules (Q-L1,
Q-L2, and your CA for financial records). This document lists:

- the affected tables;
- the **technical minimums** the code already depends on;
- the mechanism that will apply your periods safely once they are set.

---

## 1. Affected tables

| Table                                                        | Grows with                    | Personal data held                                               | Protection today                    | Technical minimum before removal (from the code)                                                                                                                                       | Proposed action                                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `otp_challenge`                                              | Every sign-in code            | Phone number, request IP, delivery reference                     | None                                | **24 hours** after `created_at`: the per-phone daily limit (10/day) and the lock after 10 wrong codes read the last 24 hours (`otp.service.ts`)                                        | Delete after the approved period (never under 24 h)                                                                                                                             |
| `auth_session`                                               | Every sign-in                 | User id, IP address, user agent, device id, refresh-token hashes | None                                | **Until `expires_at`** (absolute lifetime: 90 days customer, 30 days worker, 12 h staff). Revoked or rotated rows are kept until then so refresh-token **reuse detection** still works | Delete a period after `expires_at`                                                                                                                                              |
| `staff_login_challenge`                                      | Every staff login             | User id                                                          | None                                | Until `expires_at` (single use)                                                                                                                                                        | Delete after `expires_at` + period                                                                                                                                              |
| `staff_invitation`                                           | Staff onboarding              | Email                                                            | Delete-forbidden trigger            | Kept: it proves who invited whom                                                                                                                                                       | Keep (audit). Anonymising, if ever, is a separate decision                                                                                                                      |
| `job_run`                                                    | Every job tick (13 jobs)      | None (errors may name ids)                                       | None                                | None beyond operations (the last run per job feeds monitoring)                                                                                                                         | Delete successful runs after the period; keep failures longer                                                                                                                   |
| `notification`                                               | Every message, per channel    | Rendered variables (names, times), user id                       | None                                | Undelivered or retrying rows must stay. `dedupe_key` must outlive every event that could repeat (booking lifetime)                                                                     | Delete terminal rows (SENT, DELIVERED, READ, SKIPPED, CANCELLED, FAILED-final) after the period; **the in-app inbox uses this table**, so the period is also a product decision |
| `integration_event` (Zoho outbox)                            | Every Zoho sync               | Copies of CRM fields (names, phones)                             | Delete-forbidden trigger            | Pending and dead-letter rows must stay                                                                                                                                                 | Anonymise payloads of processed rows after the period (a trigger-approved function); keep the row                                                                               |
| `integration_inbound_event`                                  | Zoho Desk webhooks            | Ticket text                                                      | None                                | Deduplication window of the webhook                                                                                                                                                    | Delete after the period                                                                                                                                                         |
| `user_device`                                                | App installs                  | Push token                                                       | None                                | Active devices must stay                                                                                                                                                               | Delete devices disabled or unseen for the period                                                                                                                                |
| `worker_presence_event`                                      | Worker online/offline changes | Worker id and online/offline times (no location)                 | None                                | Dispatch reads current presence (a separate table), not history                                                                                                                        | Delete or aggregate after the period                                                                                                                                            |
| `payment_event`                                              | Every gateway event           | None since G6 (minimised)                                        | Delete-forbidden, append-only       | **Financial record**                                                                                                                                                                   | Keep for the statutory period (CA)                                                                                                                                              |
| `audit_log`                                                  | Every audited change          | Before/after rows (secrets redacted)                             | Append-only                         | **Legal and security record**                                                                                                                                                          | Keep for the approved period; never by the generic job                                                                                                                          |
| `stored_document` (KYC)                                      | Worker documents              | ID documents                                                     | Already purged by `purge-documents` | Period is Q-L2 (B7)                                                                                                                                                                    | Existing job; the period comes from your answer                                                                                                                                 |
| Payments, refunds, invoices, credit notes, earnings, payouts | Money                         | Customer / worker ids                                            | Delete-forbidden                    | Statutory                                                                                                                                                                              | Not touched by cleanup                                                                                                                                                          |

---

## 2. Mechanism

1. **Policy table `retention_policy`**, as configuration (audited, changed through the admin
   API with a reason and a second person):
   - `target` (one of a fixed list the code knows);
   - `action` (DELETE or ANONYMISE);
   - `keep_for` (an interval, **NULL = do nothing**);
   - `batch_size`;
   - `approved_by` and `approved_at`.
   - **Seeded with every period NULL**, so nothing is removed until you approve one.
2. **Floors in code.** Each target has the technical minimum from §1, for example OTP ≥ 24 h,
   sessions ≥ `expires_at`. A policy shorter than its floor is refused by validation and by a
   database check.
3. **Leased job `apply-retention`** (daily, in the existing worker):
   - for each target with a period, it deletes or anonymises **in small batches** (for example
     1,000 rows per transaction) using the indexed timestamp;
   - **only rows in a terminal state**, for example never a queued notification or a
     dead-letter Zoho event;
   - it stops at a time budget.
4. **Every run is recorded** in `retention_run`: target, cutoff, rows affected, duration,
   error. This produces a metric and an alert on failure. Cleanup is itself auditable,
   without logging the removed personal data.
5. **Delete-forbidden tables are never touched by a generic delete.** Where anonymising is
   approved (for example old Zoho payloads), it happens through a dedicated database function
   that the trigger allows, blanks named fields only, and writes an audit row.
6. **Backups:** the design depends on backup retention too. A value removed from the live
   database stays in backups until they expire. The backup retention (Q-I2) has to fit the
   same rules.

---

## 3. Tests (when implemented)

- Nothing is removed while periods are NULL.
- A policy below its floor is refused, by the API and in SQL.
- OTP rate limits and locks still work immediately after a cleanup run at the floor.
- Session reuse detection still works for a rotated token until `expires_at`.
- Pending and retrying rows are never removed.
- Batching and the time budget are respected.
- Rerunning is harmless.
- Delete-forbidden tables are refused.
- Runs are recorded.

---

## 4. Decisions needed

- **Q-L1** (existing): periods for OTP, sessions, notifications, the in-app inbox, device
  records, presence history, job history and Zoho payloads. Also the customer-data rules after
  the last booking.
- **Q-L2** (existing): KYC documents after a worker leaves.
- **Q-L1a** (new): audit-log retention.
- **Q-L1b** (new): financial and payment-event retention (CA).
- **Q-L1c** (new): who approves a retention policy change (two people proposed).
