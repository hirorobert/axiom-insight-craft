# Pilot fixtures: one synthetic entity, FY2025/26

Synthetic and redacted. Nothing here is a real client's record. The figures of the food-rations case are those of fixture E2 in
scripts/acceptance/rfr-v3/cases.mjs; the rest is generated so that every file ties to the others exactly.

Regenerate (and check) with: `bun scripts/readiness/writePilotFixtures.mjs` (add `--check` to compare without writing).

| File | What it is | Constructed? |
|---|---|---|
| tb_fy2026.csv | Trial balance at 30 June 2026 | The nine accounts are a fixture; account 9999 is a constructed balancing line standing for the rest of the books |
| gl_fy2026.csv | General Ledger export: a Beginning Balance row per account, then the year's entries | CONSTRUCTED. The cheque 001593 posting (Dr food ration, Cr bank) follows the real bank row; the other entries are aggregates. The ledger carries NO opening payable and no equity counterpart for bill 003/2024.2025: that omission is the constructed fact the pilot corrects |
| bank_nmb_fy2026.csv | One complete bank account, 2 pages, running balances chain, no outstanding items | CONSTRUCTED around the real cheque row of 2 July 2025 |
| approved_prior_year.csv | Approved prior-year closing figures per line | CONSTRUCTED except the payable of 33,518,793.00 for bill 003/2024.2025, taken from the approved note in the E2 fixture |
| evidence.json | The documents held and the facts each states | Voucher, payee confirmation, opening journal, payments listing and invoice register are CONSTRUCTED; their hashes are of placeholder text, not of real files |

Amounts are plain decimals (no thousands separators), TZS, two decimals. Debit is positive in the ledger and the trial balance.
On the bank statement a payment is the Debit column (money out) and a receipt the Credit column (money in).
