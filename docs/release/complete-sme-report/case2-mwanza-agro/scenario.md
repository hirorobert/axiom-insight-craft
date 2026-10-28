# SYNTHETIC case 2: Mwanza Agro Supplies Limited (not a real entity)

Invented software-test inputs for the second, materially different SME case of the complete-report proof
(`scripts/db-proof/completeSmeReport.mjs`). Nothing here is a real entity's record, an audited report, an actual asset
register, a real management representation or a professional review. Never reuse it as evidence for a real entity.

What makes it different from the acceptance-r1 case:

- a year to 30 June (FY2025 = 1 July 2024 to 30 June 2025; FY2024 = 1 July 2023 to 30 June 2024), so the daily
  depreciation convention and every period rule are exercised on a non-calendar year;
- two equipment classes (plant and machinery; motor vehicles), each with its own uniform useful life (10 and 5 years);
- an addition in each class during the year (M-3 dryer on 31 December 2024; V-2 van on 1 October 2024), so part-year
  charges arise (182 and 273 days of a 365-day year);
- a disposal with confirmed proceeds (M-2 bottling line sold on 1 January 2025 for 5,042.00 against a carrying amount
  of 4,742.00: gain 300.00 presented in other income; the prior year sold a fully depreciated tool for 50.00);
- an investing section in the cash-flow statement, present only in the current year;
- a loan from the director (related party control and transactions APPLICABLE, with their disclosures);
- an interim dividend paid in the year, none in the prior year, and a dividend declared after the reporting date
  (events after the reporting period APPLICABLE, with its disclosure).

Figures (TZS, two decimals), all hand-calculated and tying to the trial balances in this folder:

| Item | FY2025 | FY2024 |
|---|---|---|
| Plant and machinery: gross / accumulated depreciation / carrying | 22,950.00 / 5,346.00 / 17,604.00 | 19,300.00 / 5,790.00 / 13,510.00 |
| Motor vehicles: gross / accumulated depreciation / carrying | 15,300.00 / 5,892.00 / 9,408.00 | 8,000.00 / 3,200.00 / 4,800.00 |
| Depreciation (plant 1,200 + 368 + 546; vehicles 1,600 + 1,092) | 4,806.00 | 3,530.00 |
| Profit before tax / tax / profit | 4,400.00 / 1,200.00 / 3,200.00 | 2,050.00 / 800.00 / 1,250.00 |
| Operating / investing / financing cash flow | 6,506.00 / -13,208.00 / -3,000.00 | 4,230.00 / 50.00 / -1,000.00 |
| Cash at the end of the year | 6,338.00 | 16,040.00 (1 July 2023: 12,760.00) |
| Total assets / liabilities / equity | 42,850.00 / 10,400.00 / 32,450.00 | 41,850.00 / 11,600.00 / 30,250.00 |

Depreciation by item (daily convention; the year from 1 July 2024 has 365 days): M-1 mill cost 12,000 over 10 years,
available throughout: 1,200.00. M-2 bottling line cost 7,300 over 10 years, derecognised 1 January 2025: 184 days of
365 = 368.00; accumulated at disposal 2,190 + 368 = 2,558.00. M-3 dryer cost 10,950 over 10 years, available from
31 December 2024: 182 days = 546.00. V-1 pickup cost 8,000 over 5 years, available throughout: 1,600.00. V-2 van cost
7,300 over 5 years, available from 1 October 2024: 273 days = 1,092.00.

Explicit nil rows. The product never treats an absent figure as zero. A cash-flow or equity line that has a figure in
one period and no evidence row in the other (dividends paid, equipment purchases) leaves that period's subtotal,
closing cash or casting total without a value, which the sign-off rules refuse (`SUBTOTAL_OMITTED_MISSING_LINE`,
`subtotal-casting: INSUFFICIENT_EVIDENCE`). The existing control is to state the nil explicitly with the SAME line
label in both periods: two nil rows in the comparative transaction ledger (P6, P8) and one nil dividend row in the
comparative equity movements (the equity line's identity includes its description, so the description must be the
same in both years). See the record: a declared-nil capability the product does not yet offer as such.

A first version of this case had the disposal-gain account 84200 only in the current year. That blocks sign-off
(`subtotal-casting: INSUFFICIENT_EVIDENCE` on `line:sci:sci.other_income` for the comparative period, while the
composition itself shows a comparative amount of 0 from zero accounts), and a nil-balance row for the account in the
prior trial balance does not help: it is dropped at certification. No existing control resolves an account that is new
in the current year; it is registered as a defect in the record. The case was changed so the prior year also carries
the account (a fully depreciated tool sold for 50.00), which is the only reason case 2 reaches FINAL.

A first version of this case gave plant and machinery three different lives (8, 10 and 15 years) in one class. The
class estimate carries ONE useful life for straight-line depreciation (browser and server: `ESTIMATE_INCOMPLETE`
without a numeric class life), and the estimates note proposal states that single life, so a class whose items have
different lives cannot be disclosed truthfully through the class estimate. The case was changed to uniform lives per
class and the limitation is recorded as a product capability to add (a useful-life range per class, as paragraph
17.31(c) allows), not worked around.
