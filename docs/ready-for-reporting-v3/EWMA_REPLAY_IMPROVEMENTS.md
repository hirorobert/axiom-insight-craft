# EWMA replay: findings for CFOClose improvements and the evidence-request list

Status: **proposal for the Ready for Reporting pilot backlog.** Nothing here is implemented. It records what a real
engagement (EWMA FY2025/26, IPSAS accrual, QuickBooks) surfaced after the CAG draft management letter, so the pilot
(PR #255) and its follow-ups can turn each item into a rule, a fixture and an evidence request.

Sources: the complete NMB 40102300487 statement (40 pages; the transcription agrees with the bank's printed totals:
debits 1,339,256,295.87 in 358 rows, credits 1,377,015,097.21 in 65 rows, closing 125,809,398.97), the QuickBooks
"Transaction List by Date" for July 2025–June 2026 (the "cashbook"), the other bank statements, and the draft ML.
Amounts are TZS. Client data stays outside the repository; fixtures built from it must be redacted or synthetic.

## 1. Findings the auditors did not raise → detection rules

Each is a case CFOClose should catch without being told. "Rule" is what the product must do; "Fixture" is the
acceptance case to add to `cases.mjs` (synthetic, same shape).

| # | What happened at EWMA | Rule | Fixture |
|---|---|---|---|
| I-1 | The same cheque was entered twice in the cashbook (001786 800,000; 001608 1,294,500; 3,444,500 under 001810 and 001813). The bank paid each once. Ledger cash understated 5,539,000; expenses overstated. | Bank ↔ book matching is one-to-one. A book payment with no bank row whose number and amount equal an already-matched book row is a **suspected duplicate**, not an unpresented cheque. | Two identical book rows, one bank row → one match, one `BOOK_DUPLICATE_SUSPECTED`; never reported as an unpresented cheque. |
| I-2 | Ten cheque numbers were used twice for different payments (1608, 1665, 1668, 1717, 1726, 1759, 1760, 1786, 1802, 1813). | Cheque numbers are unique per account; reuse is a control finding and disables number-based matching for those rows (falls back to amount + date, with ambiguity held). | Reused number with two different amounts → finding; matching does not pair by number. |
| I-3 | Amounts keyed with transposed cents (10,386,784.80 vs bank .08; 11,892,417.60 vs .06), hidden by "Reconcile Adjustment" plugs of 0.72 and 0.54 and a 0.01 bank-charge plug. | A book entry posted to a reconciliation-discrepancy account, of any size, is listed with the matched rows it offsets. Near-equal pairs (same number, amount differs by digit transposition) are shown as amount errors. | Plug of 0.72 offsetting a transposed pair → `RECONCILIATION_PLUG` + `AMOUNT_MISKEYED`. |
| I-4 | Eight cheques worth 54,498,180.63 were dated 25–30 June 2026 and not presented by year end, including 22,236,155 to a related association and 12,165,328 to a supplier; one (Benson, 1,160,000) has been unpresented since March. | Unpresented cheques at period end each get a **targeted request**: the next statement showing presentation. Cheques dated in the last days of the period and large relative to the balance are listed for release evidence (window-dressing risk). Old unpresented cheques need validity or cancellation. | Year-end cheque without the subsequent statement → held; with it → cleared (S2 pattern); 90-day-old cheque → `STALE_CHEQUE`. |
| I-5 | The whole CRDB TZS balance less principal (19,209,092.89) was booked as interest on 18/06/2026; the bank shows interest 9,478,357.99, WHT 257,424.85, charges 27,695.86 and an opening balance of 10,015,855.61 that the books never carried. | Income credited from a bank balance (one entry equal to a balance less a round principal) is compared with the statement's interest rows; the difference is classified (opening balance, tax, charges). | Interest posted = balance − principal → `INCOME_FROM_BALANCE`, with the bank-derived split. (The auditors cited the 19,209,092.89 under Q1 but did not question it.) |
| I-6 | A whole bank account (CRDB TZS 0152241325200) was absent from the ledger; its balance was presented as a "fixed deposit". | Already in V3 §5.1 (population). Add: an evidence account whose balance equals a ledger balance on a different line is presented once (`EVIDENCE_SINGLE_USE`). | E1 / E4 (existing). |
| I-7 | 16,000,000 recorded as "Lion Protection Programme" income was eight deposits from member villages into the Faraja account; one narration reads "malipo ya Mfuko wa Faraja" (payment to the Faraja fund). If they repay Faraja loans (ML Q12 queries those loans), they are not income. (Correction: an earlier draft of this note called the receipt unsupported; a keyword search missed it because the bank narration names the villages, not the programme.) | A receipt from a counterparty that also appears as a borrower, or into a fund account, is checked against the loan register before it is accepted as income. Matching never relies on a programme name appearing in the bank narration. | Receipt from a borrower, credited to income → `RECEIPT_CLASSIFICATION_REVIEW`; narration without the programme keyword still matches by account and counterparty. |
| I-8 | NMB USD ledger exceeds the bank after the duplicate concession receipt, pending the closing rate. | Foreign-currency cash is compared in the account currency first (bank USD vs ledger USD), then translated at one recorded closing rate. | USD ledger ≠ USD bank → finding before any translation. |
| I-9 | Four 2024/25 payables (9,975,671.75) paid in July 2025 may have been expensed again. | Same as the food-rations rule (E2), generalised: a payment equal to an approved opening payable, posted to expense. | Generalise E2 to a list of opening payables. |
| I-10 | The cashbook opened at the bank balance (88,050,597.63), not the approved book balance (73,716,187.75). | Opening book cash must equal the approved figure; a book opening equal to the bank opening is a finding when the approved figures differ (unpresented items lost). | Opening book = bank ≠ approved → `OPENING_SET_TO_BANK`. |
| I-11 | A "Created by QB Online to adjust balance" journal exists (18/07/2025). | QuickBooks system adjustment journals are listed with their lines and explained before readiness. | System journal present → `SYSTEM_ADJUSTMENT_JOURNAL`. |

## 2. Evidence requests as a product feature

The EWMA list below is the acceptance example for an **evidence request** feature: one list per engagement, each
request tied to the findings and auditor queries it would close, the scope it holds, its effect on the statements,
and who must produce it. Ordering is by effect on the statements, not by age.

| Priority | Request | Closes | Effect if not received |
|---|---|---|---|
| Immediate | NMB 40102300487 statement for July 2026 | I-4 (8 cheques, 54,498,180.63), I-1 (the 3,444,500) | Unpresented cheques stay unconfirmed; cash scope held |
| Immediate | TAWA statement of account at 30/06/2026 and the block-fee / top-up letters | ML Q2, Q7, Q8, Q9/Q23, Q10 (191,625,000; 182,460,489.47; 39,659,244.94) | Receivables derecognised as the auditors recommend |
| Immediate | Enduimet Rangers Association letter on the 120,000,000 and the 100,000,000 in account 1033 | ML Q18, Q19 | 120,000,000 cannot be classified (collection, refund or liability) |
| Received | Bank of Tanzania rate at 30/06/2026 (TZS 2,623.50, provided by management) | ML Q11; I-8 | — (applied; the rate source stays on file) |
| Before sign-off | Customer statements (account 13101, invoice 1003 customer) and USD invoices | ML Q3, Q13, Q14 | Receivables and revenue stay as qualified |
| Before sign-off | Beneficiary lists (56,640,000), support for 46,633,500, support equipment 30,000,000 | ML Q15, Q16, Q17 | Expenses unsupported |
| Before sign-off | Jambo Kili statement or confirmation to 30/06/2026 | V3 coverage | Dormant account balance unevidenced |
| Before sign-off | 2024/25 bank reconciliations and the Bank of Tanzania rate at 30/06/2025 | ML Q20; I-10 | Opening difference treated as a prior-period correction |
| Before sign-off | Village loan register (Mfuko wa Faraja) | ML Q12; I-7 | 16,000,000 stays classified as income |

Rules for the feature: a request is satisfied only by evidence that carries the facts it asks for (V3 §5.2
"probative"); a request the user rejects records who decided and the consequence shown; requests are regenerated when
the findings change; the list is exportable as a letter to the client.

## 3. How this maps to the pilot

- I-1, I-2, I-3, I-4 extend V3 §5.3–5.4 (matching and timing items).
- I-5, I-7, I-9 extend the treatment rules (E2 pattern) and need the ledger (V3 §3).
- I-6, I-8, I-10 extend the population and opening bridge (V3 §4, §5.1).
- I-11 is a QuickBooks-specific ledger check.
- Section 2 is a new user-facing feature on top of the V3 hold reasons.
