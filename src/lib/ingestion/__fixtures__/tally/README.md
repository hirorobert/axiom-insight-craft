# Tally (TallyPrime) trial-balance export fixtures — SYNTHETIC

**Every file in this folder was written by hand from Tally's documentation** (docs/release/tally-export-r1/README.md,
sources S1–S12). None was produced by TallyPrime. They show the layout the reader is built to expect; they are not
evidence of what a real export contains, and acceptance against a real Tanzanian Tally export is still required.

The company, ledgers and amounts are invented. The chart is a small Tanzanian trader (TZS, period 1-Jan-2025 to
31-Dec-2025) under Tally's predefined groups; every variant carries the same 13 ledgers and balances
(debits 1,47,50,000.00 = credits 1,47,50,000.00), so one case can be compared with another.

| File | Shape |
|---|---|
| `tally-detailed-fy2025.csv` | Group-wise Detailed export, one-row header (Particulars / Debit / Credit), group lines above indented ledgers (2 spaces per level, kept by quoting), Indian lakh grouping as text, Grand Total. 12 group lines, 13 ledgers. |
| `tally-detailed-fy2025.xlsx` | The same report as a workbook: two-row header ("Closing Balance" over Debit / Credit) and NUMBER cells. Built by `make-tally-fixture.mjs` in this folder (run from the repository root). |
| `tally-ledgerwise-fy2025.csv` | Ledger-wise export (F5): a flat list of the 13 ledgers and the Grand Total, international grouping. |
| `tally-closing-drcr-fy2025.csv` | Ledger-wise with one "Closing Balance" column and a `Dr`/`Cr` suffix on every amount (its Grand Total cell is left empty — what Tally prints there in a one-column view is not documented). |
| `tally-trial-balance-fy2025.xml` | The ENVELOPE of DSPACCNAME / DSPACCINFO pairs that Tally's XML case study shows, ledger-wise: a closing debit negative, a closing credit positive, the unused side empty. |

Variants used only in `src/lib/ingestion/tallyExport.test.ts` (a mismatched group subtotal, a net-reported group, a
duplicate ledger, a sub-ledger group without its ledgers, a missing Grand Total, a "Difference in opening balances"
line, flattened indentation, a non-Tally file) are derived from these in the test itself.

The characterization corpus (`characterizationCorpus.ts`) reads only the `.csv` files directly under `__fixtures__/`,
so nothing in this folder enters the pinned corpus; the corpus proves the generic path is unchanged.
