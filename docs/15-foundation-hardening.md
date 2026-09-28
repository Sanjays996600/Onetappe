# One Tappe: Step 1, foundation hardening

**Scope approved:** G6, G7, G4 (foundation), the A1 reconciliation design, the A2 ledger
proposal, and the G5 cleanup proposal (no retention periods). No business rule, retention
period or architecture was changed.

---

## 1. G6: payment amount and currency

**Rule.** A payment confirms a booking only when the gateway reports **exactly** the order's
amount in paise **and** its currency. The check is one function,
`apps/api/src/payments/money-check.ts`, used on every path:

| Path                                         | Before                                        | After                                                     |
| -------------------------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| `payment.captured` / `order.paid` webhook    | Amount checked only when present; no currency | Amount and currency required and equal                    |
| `payment.authorized` webhook                 | Amount checked only when present; no currency | Same                                                      |
| "I have paid" refresh and reconciliation job | Amount checked before capture; no currency    | Same rule before applying the status and before capturing |
| An event for an already-captured payment     | Ignored silently                              | A mismatch is recorded; a match is ignored as before      |
| `refund.processed` webhook                   | Amount not checked                            | Mismatch flagged; the gateway's outcome still stands      |

**Outcome of a mismatch:**

- nothing is authorized, captured or confirmed;
- the booking stays `PENDING_PAYMENT` and expires or is paid correctly as usual;
- the gateway event is stored **once** with the problem, for example
  `AMOUNT_MISMATCH expected 58882 got 100`, `CURRENCY_MISMATCH expected INR got USD` or
  `CURRENCY_MISSING`;
- the existing `PAYMENT_EVENT_PROBLEMS` status and alert fire.

Nothing is corrected automatically.

**No sensitive data:**

- Problem texts contain only amounts and ISO currency codes. Malformed values are reported
  as `AMOUNT_INVALID` or `CURRENCY_INVALID` and are not echoed.
- Razorpay webhooks are now stored **minimised**: ids, amounts, currency, status, fees, taxes
  and error codes only. The payer's email, phone, UPI id, card and bank details and free-form
  notes are dropped before storage. Previously the whole body was stored.

**Tests added:**

| File                                               | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/payments/money-check.test.ts`                 | 5     | Exact match; ±1 paisa; other currency; missing amount or currency; malformed values not echoed                                                                                                                                                                                                                                                                                                                                                          |
| `src/payments/providers/razorpay.provider.test.ts` | +2    | Currency parsed from payments and refunds; stored payload keeps money facts and drops email, phone, UPI id, card, bank and notes                                                                                                                                                                                                                                                                                                                        |
| `test/security/payment-webhook-validation.test.ts` | 13    | Correct amount and currency; wrong amount (below, above, far off); wrong currency; missing currency; wrong authorization never captured; the status-check path; a late mismatched event after confirmation; duplicate (5 concurrent) and repeated delivery; a repeated mismatched event; forged, re-signed, unsigned and garbage signatures; an unknown order; a webhook delayed past server-side confirmation; a refund settled for a different amount |

**Mutation check:** with the check disabled, 8 of the 13 HTTP tests fail. The other 5 cover
behaviour that already worked (exact match, duplicates, forgery, unknown order, delay) and
now guard it.

---

## 2. G7: indexes for real query paths

Each candidate foreign key was traced to the queries that use it. Indexes were added only
where a query filters on the column.

| Table and column              | Query that filters on it                                               | How often                                  | Decision                                                                       |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `user_device(user_id)`        | Active push devices of a person (`notification-dispatcher.service.ts`) | Every push notification                    | **Partial index** matching the query's predicate (active devices with a token) |
| `refund(payment_id)`          | Amount already refunded for a payment (`refund.service.ts`)            | Every refund request and paid cancellation | **Index**                                                                      |
| `payment_event(payment_id)`   | Gateway events of a booking's payments (`booking-trace.service.ts`)    | Support traces, payment investigations, A1 | **Partial index** (non-null)                                                   |
| `notification(booking_id)`    | Messages about a booking (`booking-trace.service.ts`)                  | Support and safety traces                  | **Partial index** (non-null); the fastest-growing table                        |
| `safety_incident(booking_id)` | None; only joined from the incident to the booking's primary key       | —                                          | **No index**                                                                   |
| `worker_payout(worker_id)`    | None (payouts not built)                                               | —                                          | **No index** until payouts exist                                               |

Referenced rows are never deleted (triggers forbid it), so foreign-key checks don't need
indexes either.

**Query plans** (`EXPLAIN (ANALYZE, BUFFERS)`, PostgreSQL 16). The volume was synthetic, on
a scratch database: 80k devices, 10k refunds, 400k gateway events and 1M notifications.

| Query                            | Before                                                     | After                                                                  |
| -------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Q1 push devices of a person      | Seq Scan, 79,998 rows filtered, 1,160 buffers, **12.9 ms** | Index Scan `user_device_active_user_idx`, 5 buffers, **0.07 ms**       |
| Q2 refunded so far for a payment | Seq Scan, 9,999 rows filtered, 205 buffers, **1.7 ms**     | Index Scan `refund_payment_idx`, 3 buffers, **0.10 ms**                |
| Q3 gateway events of 2 payments  | Parallel Seq Scan, 400k rows, 5,709 buffers, **20.6 ms**   | Bitmap Index Scan `payment_event_payment_idx`, 10 buffers, **0.11 ms** |
| Q4 notifications of a booking    | Parallel Seq Scan, 1M rows, 19,160 buffers, **41.8 ms**    | Bitmap Index Scan `notification_booking_idx`, 13 buffers, **0.15 ms**  |

The before-scans grow linearly with the tables; the after-scans do not.

**Integrity of the migration (`0027_query_path_indexes.sql`).** An 0026 database was migrated
forward and compared with the 0026 original and with a fresh 0001–0027 database:

| Measure                                                        | 0026                    | After 0027              |
| -------------------------------------------------------------- | ----------------------- | ----------------------- |
| Tables                                                         | 87                      | 87                      |
| Check / foreign-key / primary / unique / exclusion constraints | 277 / 166 / 87 / 46 / 3 | 277 / 166 / 87 / 46 / 3 |
| Triggers (all enabled)                                         | 224                     | 224                     |
| Functions                                                      | 267                     | 267                     |
| Runtime-role (`onetappe_app`) grants                           | 319                     | 319                     |
| Indexes                                                        | 200                     | 204                     |

- **Full `pg_dump -s` diff from 0026 to 0027:** exactly the 4 `CREATE INDEX` statements.
- **Forward-migrated vs fresh:** identical.
- **Tests on the 0027 schema:** the concurrency, concurrency-gate, database-guarantee and
  notification suites pass (47 tests).

**Operational note.** The migration runner runs each file in a transaction, so these are
plain `CREATE INDEX`. They lock writes to the four tables for the build: about 1.7 s at the
synthetic volume above, negligible before launch. Future indexes on large live tables need a
non-transactional path for `CREATE INDEX CONCURRENTLY`.

---

## 3. G4: training and verification requirements as configuration

**Before:** training modules and each service's verification and training requirements
(which decide who may be booked: `worker_ineligibility_reason()` reads them at every
allocation) could be changed only by a migration, with no audit.

**Now** (`0028_worker_requirement_configuration.sql`,
`src/configuration/worker-requirement*.ts`):

| Change                                  | How                                                                                                                                                                     | Who (permission)                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| View modules, requirements and requests | `GET /admin/config/worker-requirements`, `GET …/relaxations`                                                                                                            | `worker_requirement.read`               |
| Create or rename a training module      | `POST /admin/config/training-modules`, `PATCH …/:code`                                                                                                                  | `worker_requirement.manage`             |
| Switch a module off                     | `PATCH …/:code {isActive:false}`; **refused while any service requires it**                                                                                             | `worker_requirement.manage`             |
| **Add** a requirement (strengthen)      | `POST /admin/config/services/:id/verification-requirements` or `…/training-requirements`; immediate; the response reports how many permitted workers do not meet it yet | `worker_requirement.manage`             |
| **Remove** a requirement (weaken)       | `POST …/worker-requirements/relaxations` creates a **pending request**; nothing changes until approved                                                                  | `worker_requirement.manage`             |
| Approve or reject a removal             | `POST …/relaxations/:id/approve` or `…/reject`, with a note; **never your own request**; approval removes the requirement in the same transaction                       | `worker_requirement.approve_relaxation` |
| Withdraw a request                      | `POST …/relaxations/:id/withdraw`; requester only                                                                                                                       | `worker_requirement.manage`             |

**Every mutating route:**

- needs the permission **for all cities** (these rules apply everywhere);
- needs a fresh authenticator check;
- needs a reason or note of 5–500 characters;
- rejects unknown fields;
- is recorded in `audit_log` with the actor and the reason.

**The database enforces the same rules**, whatever code or SQL the application role runs:

- **Removing a requirement:** refused unless a relaxation for exactly that requirement was
  approved **in the same transaction** by someone other than the requester. The four-eyes
  `CHECK` covers this; the decision must come from the acting staff member.
- **An old approval** cannot be reused to remove a requirement that was added again later.
- **Relaxations** start as `PENDING`, cannot be edited, and move once to APPLIED, REJECTED or
  WITHDRAWN.
- **Requirement rows** cannot be edited in place. They cannot be truncated: the application
  role has no TRUNCATE privilege, and the owner is stopped by a trigger.
- **Training modules:** codes are immutable; modules are never deleted; a required module
  stays active; a new training requirement needs an active module.

**Tests:** `test/worker-requirements.test.ts` (12) covers:

- no production role holds the permissions;
- staff without them get 403;
- a city-limited grant is refused;
- validation, and the audit trail with actor and reason;
- a required module can't be switched off (API and SQL);
- adding a requirement makes a current worker ineligible, with the impact reported;
- unknown or inactive modules are refused;
- the full request → self-approval refused → approval by another person flow removes the
  requirement and restores eligibility;
- rejection and withdrawal;
- SQL-level refusals: delete, edit, truncate, a forged approval, self-approval and a reused
  approval.

The route-policy test lists all 8 mutating routes as fresh-MFA routes. **Mutation check:**
without the delete guard, 2 of the database tests fail.

### Decision needed from you (not assumed)

The three permissions exist and are enforced, but **no role holds them**, so nobody can use
these endpoints in a real environment yet. Please decide:

- **Q-G4a:** which role(s) may **view** requirements (`worker_requirement.read`). Options:
  WORKER_OPERATIONS, OPERATIONS_HEAD, SAFETY, AUDITOR.
- **Q-G4b:** which role(s) may **add** modules and requirements and **request** removals
  (`worker_requirement.manage`). Options: WORKER_OPERATIONS, OPERATIONS_HEAD.
- **Q-G4c:** which role(s) may **approve** removals (`worker_requirement.approve_relaxation`).
  It should be different from the requesting role. Options: SAFETY, OPERATIONS_HEAD, or a
  founder-level role.

The grants are one audited migration once you answer.
