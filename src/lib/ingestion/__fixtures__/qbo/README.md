# QuickBooks Online sandbox fixtures

Both files are the **Trial Balance of Intuit's own sample company** ("Sandbox Company US 9355", a developer sandbox: invented data,
US region, USD), as of 2026-10-31, pulled on 2026-10-31:

- `qbo-sandbox-trial-balance.json`: the response of `GET /v3/company/<realm>/reports/TrialBalance` (read in the API Explorer; the
  company id is not in the body). Saved as returned, reformatted only by line breaks.
- `qbo-sandbox-trial-balance.xlsx`: the same report from the QuickBooks screen, "Export to Excel".

They contain no client data. They show the report's shape only: this is a US sandbox, so they prove nothing about Tanzanian
currency or regional behaviour. Used by `qboTrialBalance.test.ts` (shape, conversion and the A2 parity check).
