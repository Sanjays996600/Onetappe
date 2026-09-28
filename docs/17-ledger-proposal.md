# One Tappe: double-entry ledger (A2) architecture proposal

**Status:** proposal for approval. **Not implemented.** The accounting model in §3 and §5
needs your approval and your chartered accountant's (CA's) before any code. Where a rule is
an accounting decision, this document shows the options instead of choosing one.

---

## 1. Why, and what changes

Today the operational tables say what happened (`payment` captured ₹X, `refund` ₹Y,
`worker_earning` ₹Z). Nothing proves they add up. A ledger adds one invariant, enforced by
the database:

> Every journal entry has Σ debits = Σ credits, and posted entries never change.

**What stays the same:**

- The payment, refund, booking and earning **state machines stay the operational truth**.
  The ledger does not decide anything.
- The ledger is written **in the same database transaction** as the operational change that
  causes it. It needs no queue, no new service and no second copy of the rules in the apps.

**Timing:** there is no production money yet, so the ledger can start **before launch**,
with no backfill. That is the main reason to build it before payouts and real refunds.

---

## 2. Data model

| Table                   | Columns (main)                                                                                                                                                                                        | Protections                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger_account`        | `code` (e.g. `1210`), `name`, `type` (ASSET, LIABILITY, INCOME, EXPENSE, EQUITY), `normal_side`, `is_active`                                                                                          | Configuration: audited, never deleted, codes immutable                                                                                                                 |
| `journal_entry`         | `id`, `entry_number` (gap-free sequence), `occurred_at` (business time), `posted_at`, `source_type` + `source_id` + `source_event`, `description`, `reverses_entry_id`, actor/request context         | **Unique (`source_type`, `source_id`, `source_event`)**: posting the same business event twice is impossible (idempotency). Append-only: no update, delete or truncate |
| `journal_line`          | `entry_id`, `line_no`, `account_code`, `debit_paise` / `credit_paise` (bigint, exactly one > 0), `currency`; dimensions `booking_id`, `payment_id`, `refund_id`, `worker_id`, `invoice_id`, `city_id` | Append-only. A **deferred constraint trigger** checks at commit that each entry balances and that all its lines share one currency. Accounts must be active            |
| `ledger_period` (later) | `period`, `status` OPEN or CLOSED                                                                                                                                                                     | No posting into a closed period; corrections go into the open period                                                                                                   |

- **Balances** come from views (`Σ debit − Σ credit` per account and dimension). A worker's
  payable balance and the gateway clearing balance are single queries.
- **Posting API:** one internal `LedgerService.post(tx, sourceEvent, lines)`, called only by
  the payment, refund, settlement, earning and payout services **inside their existing
  transactions**. Nothing else writes the ledger; no HTTP endpoint posts entries.

**Corrections:** never edit; post a **reversing entry** (`reverses_entry_id`, the same lines
with sides swapped), then the correct entry. Each has its own source event, for example
`refund:<id>:CORRECTED:<n>`, so idempotency still holds. Corrections by staff need a reason
and a second person (four eyes, like refunds).

---

## 3. Chart of accounts (starting proposal; numbering for the CA to confirm)

| Code | Account                                     | Type      | Used for                                                                |
| ---- | ------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| 1110 | Bank: operating account                     | Asset     | Settlements received; payouts paid                                      |
| 1210 | Gateway clearing: Razorpay                  | Asset     | Money captured at Razorpay, not yet settled to the bank                 |
| 1310 | GST input credit                            | Asset     | GST on gateway fees (if claimable)                                      |
| 2110 | Customer advances (unearned)                | Liability | Paid bookings not yet delivered                                         |
| 2120 | Customer refunds payable                    | Liability | Approved refunds not yet sent back                                      |
| 2210 | Worker payable                              | Liability | Earnings owed to workers                                                |
| 2220 | Payout clearing                             | Liability | Payouts sent, awaiting bank confirmation                                |
| 2310 | GST output payable                          | Liability | GST on invoices                                                         |
| 2320 | TDS / TCS payable (if applicable)           | Liability | Tax deducted on worker payments, or collected as an e-commerce operator |
| 4110 | Service revenue (or commission revenue, §5) | Income    | Delivered services                                                      |
| 4120 | Cancellation fee revenue                    | Income    | Cancellation charges, if the policy has any                             |
| 4190 | Discounts and promotions (contra-revenue)   | Income    | Promotions, if shown gross                                              |
| 5110 | Cost of service: worker pay                 | Expense   | Worker earnings (principal model only)                                  |
| 5210 | Payment gateway fees                        | Expense   | Razorpay fees                                                           |
| 5310 | Refund and chargeback losses                | Expense   | Written-off amounts (four eyes)                                         |

---

## 4. Journal entries per business event (principal model shown; §5 for the alternative)

Example booking: price ₹499.00 + 18% GST ₹89.82 = **₹588.82** (58,882 paise). Worker pay
₹330 (33,000). Razorpay fee ₹13.90 + GST ₹2.12 (illustrative; real fees come from the
settlement data).

| #   | Business event (source)                                            | Debit                                                                                  | Credit                                                                             |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Payment captured (`payment:CAPTURED`, G6-verified amount)          | 1210 Gateway clearing 58,882                                                           | 2110 Customer advances 58,882                                                      |
| 2   | Service delivered, invoice issued (`invoice:ISSUED`)               | 2110 Customer advances 58,882                                                          | 4110 Revenue 49,900; 2310 GST output 8,982                                         |
| 3   | Worker earning created at settlement (`worker_earning:CREATED`)    | 5110 Worker pay 33,000                                                                 | 2210 Worker payable 33,000                                                         |
| 4   | Razorpay settles to the bank (`recon settlement item`)             | 1110 Bank 57,280; 5210 Gateway fees 1,390; 1310 GST input 212                          | 1210 Gateway clearing 58,882                                                       |
| 5   | Refund approved **before** delivery (`refund:APPROVED`)            | 2110 Customer advances                                                                 | 2120 Refunds payable                                                               |
| 6   | Refund processed by Razorpay (`refund:PROCESSED`)                  | 2120 Refunds payable                                                                   | 1210 Gateway clearing                                                              |
| 7   | Refund **after** delivery, with credit note (`credit_note:ISSUED`) | 4110 Revenue (or a sales-returns account); 2310 GST output                             | 2120 Refunds payable                                                               |
| 8   | Duplicate or late payment (auto-refunded)                          | on capture: 1210 Gateway clearing                                                      | 2120 Refunds payable (never revenue); then #6                                      |
| 9   | Cancellation fee kept (policy)                                     | 2110 Customer advances                                                                 | 4120 Cancellation fee; 2310 GST output; the rest to 2120 if refunded               |
| 10  | Worker cancellation / waiting / travel pay                         | 5110 Worker pay                                                                        | 2210 Worker payable                                                                |
| 11  | Payout approved and sent (`worker_payout:PAID`)                    | 2210 Worker payable                                                                    | 2220 Payout clearing (then 1110 Bank on bank confirmation); 2320 TDS if applicable |
| 12  | Chargeback or adjustment from the settlement report                | 5310 Losses, or 1210 reversal                                                          | 1210 Gateway clearing (four eyes to write off)                                     |
| 13  | Promotion discount                                                 | Either invoice net (revenue already net), or 4190 Discounts against 2110 — CA's choice |                                                                                    |

**Invariants that become checkable:**

- 2110 per booking returns to zero once a booking is delivered or fully refunded.
- 1210 per payment returns to zero once settled (reconciliation, doc 16).
- 2210 per worker equals unpaid earnings.
- 2310 equals the GST on issued invoices minus credit notes.

---

## 5. Accounting decisions for you and your CA (engineering will not choose)

| #     | Decision                                                                                                                                                                                                                                                                               | Why it matters                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Q-L-1 | **Principal or marketplace model?** Does One Tappe sell the service (revenue = full price; worker pay is a cost), or does it collect on behalf of independent workers (revenue = commission only; the worker's share is a liability)? This follows from contracts and GST registration | Changes entries #2 and #3, what the invoice shows, and GST (e.g. e-commerce operator TCS obligations) |
| Q-L-2 | GST treatment: rate, SAC code, place of supply, issuing entity; whether GST on gateway fees is claimable                                                                                                                                                                               | Accounts 2310 and 1310                                                                                |
| Q-L-3 | Revenue recognition point: at service completion (as the current invoice timing implies) or at payment                                                                                                                                                                                 | Entry #2 timing                                                                                       |
| Q-L-4 | Tax on worker payments: TDS (which section) or TCS, and thresholds                                                                                                                                                                                                                     | Entry #11, account 2320                                                                               |
| Q-L-5 | Discounts: net invoicing or gross plus contra-revenue                                                                                                                                                                                                                                  | Entry #13                                                                                             |
| Q-L-6 | Is this ledger the **book of record**, or a sub-ledger exported to an accounting system (for example Zoho Books or Tally)? If exported: summary or detail, how often                                                                                                                   | Export design; period closing                                                                         |
| Q-L-7 | Chart of accounts numbering and names                                                                                                                                                                                                                                                  | §3                                                                                                    |
| Q-L-8 | Who may post manual corrections, and who is the second person                                                                                                                                                                                                                          | Four-eyes roles                                                                                       |

The payment table has cash-collection columns (`cash_receipt_number`, `collected_by`), but
payment is currently prepaid only (Q-B11). Cash would need a "cash with worker" asset account
and its own entries; it is out of scope until you decide to allow it.

---

## 6. How it connects to what exists

| Existing                                  | Ledger role                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `payment` (captured, G6-verified)         | Source of entry #1, and #8 for duplicates. Posted inside `applyCaptured`'s transaction           |
| `refund` (two-person, idempotent)         | Sources of #5, #6 and #7. Posted in the refund service's transactions                            |
| `invoice`, `credit_note`                  | Sources of #2 and #7. Posted by `SettlementService` in its existing transaction                  |
| `worker_earning`                          | Source of #3 and #10. Unique per booking, worker and type, as today                              |
| `worker_payout` (not built)               | Source of #11. The payout flow is designed on top of the ledger (the balance of 2210 per worker) |
| `payment_event` / reconciliation (doc 16) | Settlement items post #4 and #12. Reconciliation compares 1210 with the provider                 |
| `audit_log`                               | Still records who did what. The ledger records the money effect                                  |

The operational tables do not change shape. The ledger only references them.

---

## 7. Proof and tests (when implemented)

- **Database:**
  - an unbalanced entry fails at commit;
  - update, delete and truncate are refused;
  - a duplicate source event is refused;
  - a posting to an inactive account is refused;
  - a posting to a closed period is refused.
- **Per flow:** every existing journey test (pay, cancel, refund, duplicate, late payment,
  settle, earnings) also asserts the exact journal lines and that the invariants in §4 hold.
- **Property test:** thousands of random journeys; the trial balance is always zero; per-booking
  2110 and per-payment 1210 close.
- **Concurrency:** the existing 100-way booking and duplicate-webhook tests still post exactly
  one entry per business event.
- **Replay:** rebuilding balances from `journal_line` equals the running balances.

---

## 8. Order of work, after approval

1. Your and your CA's answers to Q-L-1 to Q-L-8.
2. Migration: accounts, entries, lines, balance check, append-only protection. Posting
   service. Entries #1–#10 in the existing transactions. Tests.
3. Reconciliation (doc 16) posts #4 and #12 and checks 1210.
4. The payout flow (#11), on the ledger.
5. Accounting export (Q-L-6) and period close.
