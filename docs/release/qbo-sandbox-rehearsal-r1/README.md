# Restricted QuickBooks Sandbox rehearsal

## Purpose and boundaries

The connector backend is installed, but no real Sandbox import has yet been accepted. `/internal/tester/quickbooks` provides a controlled entry into the existing trial-balance workflow without enabling the customer connector flag or switching away from Sandbox.

The screen checks the signed-in platform owner before listing workspaces. Opening a rehearsal additionally checks current workspace ownership and requires a source-free company, explicit sample-data confirmation and working per-tab session storage. Enrollment is actor/company/year scoped and survives the same-tab OAuth round trip. Re-entry after an import is allowed for that actor after current ownership is checked. This browser marker controls presentation only; it grants no database or connector capability. The existing backend must still authenticate every operation and require both prepare-trial-balance and manage-source-files rights. Its active-upload protection still decides whether an import may be registered. It never overwrites an existing source.

The card verifies the actor again on mount, discards stale company/year reads, and hides immediately on identity changes. A same-actor token refresh does not interrupt an in-flight operation. No OAuth code, token, secret, financial data or progress status is written by the enrollment helper.

This is a real restricted Sandbox workflow, not a fixture-only acceptance preview. The development-only restriction on fixture previews remains unchanged. The proposed development charter remains unadopted. Applicable targets are P1 provenance, P6 server authority and R14 read-only connectors. No framework or accounting acceptance is asserted.

## Installed baseline

Main `d8185c57ce8fbad8b91dd7c9717412c7879cfe1e` records the native installs: CF-03 at hosted journal id 100 / Drizzle 0099, and QBO storage at hosted id 101 / Drizzle 0100. Both mirror files differ from their canonical sources only by the omitted final LF, accepted by the existing ordinary mirror rule. No migration or installed mirror is changed here. Test expectations now reflect the actual journal: 86 source mirrors and no pending source migrations. This does not replace a live hosted verification.

## Real acceptance still to execute

1. Sign in as the platform owner. Use or create a separate empty sample-data company and an engagement with the intended reporting dates.
2. Open the restricted route, select that company/year and confirm the sample-data scope.
3. Connect to an Intuit Sandbox company. The person starting OAuth must finish it. Intuit consent is a user action; no consent, credentials or approval is fabricated.
4. Import for those exact dates. Check the source evidence, original bytes/hash, denomination, completeness and processing result.
5. Export the same trial balance manually from the same Sandbox company for the same dates and accounting basis. Compare the normalized account balances and debit/credit totals, reporting all differences. A second import must refuse to overwrite an active source.
6. Exercise reconnect/refusal/recovery paths and record actual results. Passing unit tests and disposable proofs are not this real acceptance.

Production activation still requires production credentials and Intuit approval, accounting/actor-identity review and the retention/legal decision. The source flag remains false. This change neither enables customer access nor authorizes official financial-statement issuance. Previously deployed QBO functions are not redeployed by this frontend change.
