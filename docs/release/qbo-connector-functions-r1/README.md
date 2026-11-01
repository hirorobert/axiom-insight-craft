# QuickBooks Online connector functions (B9), release record r1

**Status: authored and unit-tested; NOT deployed; NOT exercised against Intuit; depends on the unapplied storage migration (PR #239).** Nothing here runs until the
owner applies the migration, creates the secrets below and deploys the three functions, each a separate explicit step.

## The three functions

| Function | Who calls it | What it does |
|---|---|---|
| `qbo-connect-start` (POST, JWT) | The signed-in person, from the app | Stores only the SHA-256 of an unguessable single-use state (`qbo_start_oauth_state`, which judges the person's right) and answers with the authorisation address. No token exists yet. |
| `qbo-oauth-callback` (GET, **`verify_jwt = false`**) | Intuit, redirecting the browser | The single-use state is the only credential (a redirect carries no Supabase login). Consumes it first, exchanges the code through the guard, seals the refresh token (AES-256-GCM, bound to workspace + environment + realm), stores only the envelope, and sends the browser back with a status word only (`connected`, `denied`, `failed`). An unknown, expired or used state is a plain 400. |
| `qbo-pull-trial-balance` (POST, JWT) | The signed-in person | Refresh (new refresh token stored by compare-and-swap **before** the new access token is used) -> report through the guard -> convert (refused, never repaired) -> check the report's own period -> reserve, store and register the file **as the person** (the same steps as a manual upload) -> provenance last. |

Pure cores (unit-tested in Node): `_shared/qboConnect.ts`, `qboPull.ts`, `qboTokenClient.ts`, `qboPullSummary.ts`, `qboEnv.ts`; the Intuit addresses live only in `qboReadOnlyGuard.ts` (a scan test fails if any other function code names an Intuit host).

## Secrets the owner creates (Edge Function secrets; their values are never shared with an agent)

| Name | Meaning |
|---|---|
| `QBO_CLIENT_ID_SANDBOX`, `QBO_CLIENT_SECRET_SANDBOX` | The development app's credentials (Keys and OAuth, Development) |
| `QBO_CLIENT_ID_PRODUCTION`, `QBO_CLIENT_SECRET_PRODUCTION` | Only once Intuit has approved production access (support case 00231947; the UK-entity route) |
| `QBO_REDIRECT_URI` | The https address of `qbo-oauth-callback`, registered with Intuit for the app |
| `QBO_APP_URL` | The https origin of the application (where the browser is sent back) |
| `QBO_TOKEN_KEY_ID`, `QBO_TOKEN_KEY_B64` | The current envelope key: a short name and exactly 32 random bytes in base64 |
| `QBO_TOKEN_KEY_PREV_ID`, `QBO_TOKEN_KEY_PREV_B64` | Optional: the previous key, kept only while old envelopes are re-sealed |
| `QBO_MINOR_VERSION` | Optional, default 75 |

A missing or malformed value makes a function answer "not configured"; nothing has a default.

## Evidence

Unit tests on this PR: guard address builders (47 guard tests), token client (17), connect and callback (31 with the envelope), pull (40), configuration (10). Highlights: the state
is consumed first and exactly once, even when the exchange throws; a state whose actor lost the right is consumed and refused; the browser redirect and every outcome contain no code, state,
token or envelope; the stored envelope opens only with its own workspace, environment and realm; rotation happens before the report is fetched and two pulls at once produce exactly one
fetch (the other is told it is busy); a failed step never triggers a later one; **the recorded result hash of a pull equals the hash of the same books imported from the manual Excel export**
(charter A2, through the whole pipeline, on the UK sandbox sample). CI gains a `deno check` step for the three entry files.

## Not claimed, and for the independent reviewer

- **Never run against Intuit.** No sandbox authorisation, token exchange, refresh or report call has been made by this code; the only real Intuit data used is the recorded sample report.
- **No `deno check` was run locally** (Deno is not installed on the author's machine); CI runs it. The entry files are thin wiring over tested cores, but they are not type-checked until CI runs.
- **Concurrent refresh semantics at Intuit are unverified.** The compare-and-swap keeps OUR store consistent (one winner); whether a losing pull's freshly issued refresh token invalidates the winner's is not documented in what was read. Ask Intuit (add to case 00231947).
- **Refresh of an existing import is not built.** If an active upload exists for the period, the pull answers `active_upload_exists` and removes the stored object; replacing is the existing replace flow and is a separate change.
- **Provenance after registration.** If the upload registers but the provenance row cannot be written, the function answers `provenance_failed` with the upload id (it does not roll the upload back). The reviewer should decide whether that is acceptable or the order must change.
- **The upload steps need `manage_source_files`** (reserve) as well as `prepare_trial_balance` (this connector's own check): both are required, which is stricter than either alone.
- **No browser UI.** The Connect button, the status display and the Refresh action are not built; the callback returns the browser to `/workspace/<company>/<year>/trial-balance/review?qbo=<status>` (the year travels in the OAuth state).
- No cleanup job for expired OAuth states; no retention job for provenance (see the storage record).
