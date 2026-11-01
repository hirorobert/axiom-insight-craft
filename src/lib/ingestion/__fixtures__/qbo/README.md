# QuickBooks Online sandbox fixtures

All files are Trial Balance reports of **Intuit's own sample companies** (developer sandboxes: invented data, no client data), pulled
on 2026-10-31 from the Intuit developer portal's API Explorer, which calls the sandbox API.

| Files | Company | Region / currency | Period |
|---|---|---|---|
| `qbo-sandbox-trial-balance.json` + `.xlsx` | Sandbox Company US 9355 | US / USD | as of 2026-10-31 (the API default, this month to date) |
| `qbo-sandbox-gb-trial-balance.json` + `.xlsx` | Sandbox Company GB fa92 | GB / GBP | 2026-01-01 to 2026-10-31 |
| `qbo-sandbox-au-trial-balance.json` + `.xlsx` | Sandbox Company AU 93b8 | AU / AUD | 2026-01-01 to 2026-10-31 |
| `qbo-sandbox-ca-trial-balance.json` + `.xlsx` | Sandbox Company CA c511 | CA / CAD | 2026-01-01 to 2026-10-31 |

- The JSON is the body of `GET /v3/company/<realm>/reports/TrialBalance` as returned (the company id is not in the body); the GB, AU
  and CA files are the same bodies without added line breaks. A report without **both** `start_date` and `end_date` ignores a lone
  `end_date` (the header then says "this month-to-date"), so the regional samples were requested with both.
- Each `.xlsx` is the same report from the QuickBooks screen, "Export to Excel" (downloaded 2026-11-01, "As of 31 Oct 2026"; the screen
  default for the UK was 1 Nov, whose totals are identical).
- **Parity:** for every region the converter's file and the Excel export give the identical normalised accounting result. The AU and CA
  Excel exports carry floating-point noise from QuickBooks (for example `812.429999999999` for 812.43); the reader reads a number cell
  within a millionth of a minor unit of a whole minor unit as that unit (`numberCellNoise.test.ts`), so they now read.
- The GB, AU and CA reports include foreign-currency accounts (for example "Debtors - USD", "Creditors - HKD") inside a report in the
  company's home currency, and zero-balance rows.
- They show the report's shape only. **No Tanzanian or other region's behaviour is proven by them**; Intuit's portal offers sandboxes
  only for the US, Australia, the United Kingdom and Canada. Used by `qboTrialBalance.test.ts`.
