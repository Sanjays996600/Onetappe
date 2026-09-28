# One Tappe: settlement reconciliation (A1) design

**Status:** design only, for approval. **Not implemented.**
**Implementation is blocked on:**

- the Razorpay contract being verified from the official documentation (§2);
- your answers in §10.

---

## 1. Purpose and rules

Nightly (and on demand), compare what **we** recorded (payments, refunds, and later the
ledger) with what **Razorpay reports it settled**, and list every difference for finance.

| Rule                         | How the design meets it                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Detect, never silently fix   | A run writes only to reconciliation tables. It never updates `payment`, `refund`, `invoice` or earnings. The single exception, the proven status check in §6, is proposed for your approval.                 |
| Idempotent and safe to rerun | Every provider item is stored per run under a unique key. Every difference has a deterministic key, so rerunning the same period cannot create a duplicate exception. It updates `last_seen_run_id` instead. |
| Auditable                    | Runs, provider snapshots and exceptions are append-only or audited. Every human decision carries a note and an actor.                                                                                        |
| Uses existing architecture   | A leased job in the existing background worker and a module inside `payments`. No new service. No provider call inside a database transaction.                                                               |
| Provider-neutral core        | Matching works on a `SettlementSource` interface. Razorpay is one adapter, written only after its contract is verified.                                                                                      |

---

## 2. What is verified, and what is not

**Verified from our own code:**

- We create each Razorpay order with `receipt = our payment id` and notes `booking_code` and
  `payment_id`, amounts in paise, currency `INR`.
- Refunds carry `receipt` and `notes.refund_id` = our refund id.
- Webhooks and status fetches give `order_id`, the payment `id`, `amount`, `currency` and
  `status` (G6).

**Not verified (the documentation could not be reached).** razorpay.com is blocked by this
environment's network policy, both for direct requests and for the web-fetch tool. A web
search points to `GET /v1/settlements/recon/combined` (query `year`, `month`, optional `day`,
`count`, `skip`). It returns one row per settled transaction (payments, refunds, transfers and
adjustments) with fields such as `entity_id`, `type`, `debit`, `credit`, `amount`, `currency`,
`fee`, `tax`, `settlement_id`, `settlement_utr`, `settled_at`, `order_id`, `order_receipt`,
`method` and `dispute_id`. Sources: [Razorpay: Fetch Settlement Recon Details](https://razorpay.com/docs/api/settlements/fetch-recon/)
and [Razorpay Settlements API](https://razorpay.com/docs/api/settlements/), **seen only as
search-result summaries**.

**Before any adapter code, someone with access verifies each item below on the official
pages and records the answers in this document:**

| #   | Question to verify                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- |
| R1  | Endpoint(s), authentication, pagination (`count`/`skip` limits), rate limits                             |
| R2  | Exact row fields and types; amounts in paise; `fee` and `tax` semantics (is `fee` inclusive of GST?)     |
| R3  | How refunds, reversals, adjustments, disputes and chargebacks appear (`type`, sign, `debit` vs `credit`) |
| R4  | Date semantics: is `year/month/day` the settlement date? Time zone? How late is a day's data complete?   |
| R5  | Does `order_receipt` echo our `receipt` (our payment id)?                                                |
| R6  | Settlement cycle for our account (T+n), and whether settlements can be on hold                           |
| R7  | Instant or partial settlements, and whether one payment can appear in more than one settlement           |
| R8  | Sandbox / test-mode behaviour of the recon endpoint (for staging tests)                                  |

---

## 3. Components

```
background worker ──(daily lease: reconcile-settlements)──► ReconciliationService
                                                              │ 1 fetch (outside DB tx), page by page
                                                              ▼
                                                  SettlementSource (interface)
                                                     ├─ RazorpaySettlementSource  (after §2 verification)
                                                     └─ SandboxSettlementSource   (tests, staging)
                                                              │ 2 store snapshot (one tx per page, idempotent)
                                                              ▼
PostgreSQL: recon_run ─< recon_provider_item      3 match in SQL (one tx) ─► recon_exception (upsert by key)
                                                   4 clear exceptions no longer true (record the run)
                                                   5 finish run, counts; alert on new exceptions
admin API (read, rerun, review, resolve) ──► same service; four-eyes where money is concerned
```

```ts
interface SettlementItem {
  providerEntityId: string; // payment / refund / adjustment id at the provider
  type: 'PAYMENT' | 'REFUND' | 'ADJUSTMENT' | 'DISPUTE' | 'TRANSFER' | 'OTHER';
  direction: 'CREDIT' | 'DEBIT';
  amountPaise: number; // integer, never float
  feePaise: number | null;
  taxPaise: number | null;
  currency: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  ourReference: string | null; // receipt/notes when the provider echoes them (R5)
  settlementId: string;
  settlementReference: string | null; // e.g. bank UTR
  settledAt: Date;
}
interface SettlementSource {
  readonly provider: 'RAZORPAY' | 'SANDBOX';
  /** Every item settled on `day` (the provider's settlement date), all pages. */
  settledOn(day: string): AsyncIterable<SettlementItem>;
}
```

---

## 4. Data model (a new migration, when approved)

| Table                   | Purpose                                                                                                                                                           | Key protections                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `recon_run`             | One attempt to reconcile one provider day: status (RUNNING, COMPLETED, FAILED), who started it (job or staff plus reason), counts, and a hash of the fetched data | At most one RUNNING run per (provider, day), by a partial unique index; audited; never deleted                                      |
| `recon_provider_item`   | Snapshot of what the provider reported in that run (the fields above only: no personal data)                                                                      | Unique (run, type, provider entity id); append-only; money as bigint paise                                                          |
| `recon_exception`       | One row per distinct difference                                                                                                                                   | Unique `exception_key`; status OPEN → UNDER_REVIEW → RESOLVED, ACCEPTED or CLEARED; resolution needs a note; audited; never deleted |
| `recon_exception_event` | History of each exception (seen in run X, cleared in run Y, note added, status changed)                                                                           | Append-only                                                                                                                         |

The exception key is `sha256(type | provider | provider entity id | our payment id | our refund id)`.
The same difference found again updates `last_seen_run_id` and `occurrences`; it is never
inserted twice.

---

## 5. Matching and the exceptions it produces

A provider item is linked to our records by `provider_payment_id`, then `provider_order_id`,
then `ourReference` (verified per R5). Our side is `payment` / `refund` (later, ledger lines
too).

| Code  | Condition                                                                                                                                                                | What it usually means                                             | Handling                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| RC-01 | Provider settled a payment for **our** order, but our payment is not `CAPTURED`                                                                                          | Missed or failed webhook; captured-but-unrecorded                 | Exception. Optional proven action in §6                                                                                          |
| RC-02 | Settled amount or currency ≠ our `captured_amount_paise` / `currency`                                                                                                    | Gateway or data error                                             | Exception, high severity. Never auto-fixed                                                                                       |
| RC-03 | Our payment is `CAPTURED`, but no settlement item after the settlement window (R6) plus a grace period                                                                   | Provider not settled (hold, dispute) or captured on our side only | Exception. Before raising, the run checks the payment's current state (outside a transaction) and records the answer as evidence |
| RC-04 | One provider payment linked to two of our payments, the same provider item twice, or two non-duplicate captures for one booking                                          | Duplicate                                                         | Exception, high severity                                                                                                         |
| RC-05 | Provider item we cannot link to any of our orders                                                                                                                        | Another integration on the account, a dashboard test or fraud     | Exception, for review                                                                                                            |
| RC-06 | Provider refund (debit) with no refund of ours; refund amount differs; ours `PROCESSED` but not in any settlement after the window; theirs processed while ours `FAILED` | Refund mismatch or reversal                                       | Exception. The G6 amount check already flags webhook refund mismatches live                                                      |
| RC-07 | Adjustment, dispute, chargeback or reversal row                                                                                                                          | Money taken back or added by the provider                         | Always an exception; we have no dispute model yet                                                                                |
| RC-08 | Fee or tax differs from the agreed schedule                                                                                                                              | Pricing change at the provider                                    | Only once a fee schedule is configured (business input); otherwise recorded, not flagged                                         |
| RC-09 | Sum of a settlement's rows ≠ the settlement's own total                                                                                                                  | Provider-side inconsistency                                       | Exception                                                                                                                        |
| RC-10 | Settlement total not found on the bank statement (UTR)                                                                                                                   | Money not received                                                | **Later**: needs bank-statement import                                                                                           |

**Clearing:** when a later run no longer finds the condition (for example RC-03 once the
settlement arrives), the exception moves to CLEARED with the run id. That changes only the
exception's own state, never a financial record.

---

## 6. Corrections: none automatic, with one proposed exception

- **Default: nothing is corrected by reconciliation.** Finance reviews each exception and
  resolves it with a note:
  - **RESOLVED:** fixed through a normal audited flow, for example a refund through the
    two-person refund flow.
  - **ACCEPTED:** a known, explained difference.
- A resolution that states money was lost or written off needs a **second person** (the same
  four-eyes rule as refunds).
- **Proposed, for your approval:** for **RC-01 only**, the run may call the **existing**
  server-side status check (`PaymentService.reconcileOrder`) for that order. This is the path
  the "I have paid" button and the minute job already use:
  - it re-reads the payment from the gateway;
  - it applies it through the same signed-event path, with the G6 amount and currency check
    and event-id deduplication.
  - It is proven safe by the payment architecture: it is idempotent, it never trusts our
    snapshot, and a mismatch still confirms nothing.
  - The exception stays open until a later run shows it cleared.

---

## 7. Operation

- **Schedule:** once a day, for the settlement day that is complete per R4. Also a manual
  rerun for any day, which needs a reason.
- **Concurrency:** the job lease plus the one-running-run index. A second trigger for the same
  day waits or is refused.
- **Failure mid-run:**
  - pages already stored stay in the FAILED run;
  - the next run starts clean;
  - exceptions are only written by a run that fetched **all** pages, so a partial fetch never
    raises false "missing" exceptions.
- **Monitoring:** new metrics `recon_exceptions_open{code}` and `recon_last_success_age`.
  Alerts on any new RC-02, RC-04 or RC-07, and on no successful run for 48 hours.
- **Access:** new permissions `recon.read`, `recon.run` and `recon.resolve` (plus a second
  person for write-offs). **Which roles hold them is your decision** (§10).

---

## 8. Relation to the ledger (A2)

Once the ledger exists, reconciliation also compares each settlement with the **gateway
clearing** account:

- captured payments debit it;
- refunds and fees reduce it;
- settlements to the bank credit it.

A clean settlement brings the clearing balance for those items to zero. Differences become
exceptions in the same table.

---

## 9. Tests (when implemented)

- **Sandbox settlement source fixtures:** each RC code; a clean day with zero exceptions;
  rerun idempotency (same input twice → identical exceptions, counts +1);
  - concurrent triggers;
  - failure after page 2 (no false exceptions);
  - clearing;
  - large multi-page days.
- **The RC-01 action**, if approved: mismatched money still confirms nothing.
- **Staging** against Razorpay test mode (R8), then one live ₹1 payment and refund, reconciled
  end to end.

---

## 10. Decisions needed from you

- **Q-A1a:** settlement cycle and grace period before "captured but not settled" is raised
  (R6 gives the cycle; the grace is yours).
- **Q-A1b:** who may view, run and resolve reconciliation. Who is the second person for
  write-offs?
- **Q-A1c:** approve the RC-01 automatic status check (§6), or keep everything manual.
- **Q-A1d:** do you have a provider fee schedule to check against (RC-08), or only record fees?
- **Q-A1e:** bank-statement import (RC-10): which bank, what format, and when?
- **Required action:** someone with internet access completes the R1–R8 verification from
  the official Razorpay documentation, together with G10.
