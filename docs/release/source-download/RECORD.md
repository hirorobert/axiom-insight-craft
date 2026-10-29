# Original-file retrieval for trial-balance uploads (candidate - nothing deployed)

## The gap this closes
A signed-in owner had **no authorized path** to retrieve the original file they uploaded. The `trial-balance-files` bucket's session
policies grant only the legacy personal folder (`<auth uid>/...`); source files live under `workspaces/<company>/...`, and the upload
lifecycle design is explicit that **no client Storage policy is widened**. The signer issues *upload* URLs only; `process-trial-balance`
reads with the service role. (Found by the authenticated IPSAS journey, #221, which records it as `TB-SOURCE-OWNER-RETRIEVAL`.)

## What is added (no migration, no Storage policy, no schema change)
| Piece | Rule |
|---|---|
| Edge Function `trial-balance-source-download` | Body is exactly `{ upload_id, company_id }` (any other key -> 400). Authenticates the JWT. Reads the upload row with the service role (7 columns, read-only). **Binding:** the named company must be the upload's own company; unknown upload, other company's upload and missing right are one answer (403 `forbidden`), so ids cannot be probed. **Authority is re-checked on every request** with the existing `can_user_act_on_workspace(user, company, 'manage_source_files')` (owner with a current plan, or an active explicit grant). Path must be `workspaces/<company>/...` (or a legacy `<uploader>/...`) and well formed, else a server error - never a download. Answers with `createSignedUrl(path, 60 s, { download: <safe name> })`, the recorded `source_file_hash` (null until processing recorded it) and the size. Logs one structured line (no URL, no token). |
| `src/lib/workspace/sourceDownload.ts` | The one browser path. Calls the function, fetches the URL, **hashes the received bytes and compares them with the server's recorded SHA-256 before anything is saved**; a mismatch discards the bytes and says so. With no recorded fingerprint the file is saved and the user is told it could not be compared. |
| `ManageTrialBalance` -> **Download original** | Under "File options" with Replace/Remove, shown only in `manage` mode (owner or `manage_source_files`, current plan). The button is a convenience; the server decides. |

## Who may download (decision recorded, not invented)
The same right that governs uploading, replacing and removing the source: **`manage_source_files`** (owner with a current plan, or an explicit grant).
Open product questions, deliberately not decided here: (1) whether reviewers (`review_close`) or preparers (`prepare_trial_balance`) should also be able to retrieve evidence;
(2) whether a workspace whose plan has lapsed ("read-only archive") should still allow retrieval - today it does **not** (`workspace_authority_basis` returns no basis without a current plan).

## Known limits
- A URL already issued cannot be recalled: after a revocation, access outlives the revocation by at most the 60 s expiry. The journey records this as `DOWNLOAD-URL-OUTLIVES-REVOCATION-UNTIL-EXPIRY`.
- No durable audit row per download (that would need a table and a migration); the function logs one structured line (actor, upload, company, outcome).
- A file with no recorded fingerprint cannot be integrity-checked against the server's record (the bytes are still the object the server holds).

## Evidence
- Unit: 18 tests for the decision module and the browser integrity check (`sourceDownload.test.ts`); 6 for the visible action (`ManageTrialBalanceDownload.test.ts`); 11 contract tests for the journey and CI wiring.
- Real stack (CI `real-app-e2e`, **not run locally - no Docker**): `scripts/e2e/sourceDownloadJourney.mjs` and the "Download original" group of `localStackJourney.mjs` (real Chrome download compared byte for byte with the uploaded file; a preparer and a partner refused by the server).

## Deployment (not performed)
`supabase functions deploy trial-balance-source-download` is an explicit owner action. No migration is involved. Until the function is deployed the button reports a retryable failure; nothing else changes.
