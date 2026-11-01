# QuickBooks Online connector functions (B9), release record r1

**Status: authored and unit-tested; NOT deployed; NOT exercised against Intuit; depends on the unapplied storage migration (PR #239).** Nothing here runs until the
owner applies the migration, creates the secrets below and deploys the four functions, each a separate explicit step.

## The four functions

| Function | Who calls it | What it does |
|---|---|---|
| `qbo-connect-start` (POST, JWT) | The signed-in person, from the app | Stores only the SHA-256 of an unguessable single-use state (`qbo_start_oauth_state`, which judges the person's right) and answers with the authorisation address. No token exists yet. |
| `qbo-oauth-callback` (GET, **`verify_jwt = false`**) | Intuit, redirecting the browser | The single-use state is the only credential (a redirect carries no Supabase login), and it proves only who **started** the attempt. So it exchanges **nothing** and never calls Intuit (review r2, S4): it seals the authorisation code, parks it with the state (`qbo_record_oauth_return`, consuming the state exactly once) and sends the browser back with a one-time handoff code in the address **fragment** (`#qbo_handoff=...`; a browser never sends a fragment to a server). A decline or an unusable return comes back as `?qbo=denied` / `?qbo=failed`. An unknown, expired or used state is a plain 400. |
| `qbo-finish-connection` (POST, JWT) | The signed-in person, from the app, with the handoff | `qbo_take_oauth_return` gives the sealed code back only if the signed-in person is the one who **started** the attempt, the handoff has not expired (5 minutes) and they still hold both rights; any answer ends the handoff. Only then is the code exchanged through the guard, the refresh token sealed (bound to workspace + environment + realm) and only the envelope stored. Anyone else gets `not_yours` and no token for their QuickBooks company ever exists. |
| `qbo-pull-trial-balance` (POST, JWT) | The signed-in person | **Both rights checked first** (`prepare_trial_balance` and `manage_source_files`), before Intuit is touched -> take the refresh **lease** (a second simultaneous import is `busy` without any call to Intuit) -> refresh (new refresh token stored by compare-and-swap **before** the new access token is used) -> report through the guard -> convert (refused, never repaired) -> check the report's own period -> reserve the upload -> **record the evidence (nothing is stored if this fails)** -> store and register the file **as the person** (the same steps as a manual upload) -> link the evidence to the upload. If only that last link fails the answer is `imported_record_pending` (HTTP 202), never a false "imported". |

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

Unit tests on this PR: guard address builders (47 guard tests), token client (17), connect and callback (31 with the envelope), pull (52, after the independent review: both rights before Intuit, the lease, evidence first, the pending outcome), configuration (10). Five deliberate breakages of `qboPull.ts` (no upload right, no lease, store before evidence, success on a failed link, a leaked lease) each fail the tests; see `docs/release/qbo-connector-review-r1/README.md`. Highlights: the state
is consumed first and exactly once, even when the exchange throws; a state whose actor lost the right is consumed and refused; the browser redirect and every outcome contain no code, state,
token or envelope; the stored envelope opens only with its own workspace, environment and realm; rotation happens before the report is fetched and two pulls at once produce exactly one
fetch (the other is told it is busy); a failed step never triggers a later one; **the recorded result hash of a pull equals the hash of the same books imported from the manual Excel export**
(charter A2, through the whole pipeline, on the UK sandbox sample). CI gains a `deno check` step for the four entry files.

## Not claimed, and for the independent reviewer

- **Never run against Intuit.** No sandbox authorisation, token exchange, refresh or report call has been made by this code; the only real Intuit data used is the recorded sample report.
- **`deno check`** (r2): passes in CI on the verification pull request #242 and locally (Deno 2.9.6) for the four entry files; see the review record, finding 8.
- **Concurrent refresh at Intuit.** Prevented rather than recovered: the lease means two simultaneous imports never present the same refresh token. A search summary of Intuit's authorization FAQ says the previous token expires when a new one is issued; that is **not verified at the primary source** (the page could not be opened). The crash window (Intuit issued a token, the process died before storing it) cannot be closed from our side: it is detected on the next refresh and the person reconnects. Full table: `docs/release/qbo-connector-review-r1/README.md`, finding 6.
- **Refresh of an existing import is not built.** If an active upload exists for the period, the pull answers `active_upload_exists` and removes the stored object; replacing is the existing replace flow and is a separate change.
- **Evidence before effect** (changed after the independent review): the order was "register, then record provenance", which could leave a registered upload with no evidence. Now the facts are recorded first; if they cannot be, nothing is stored (`provenance_failed` means **nothing was imported**); if only the final link fails the answer is `imported_record_pending` and the next import (or `qbo_complete_pending_pulls`) finishes it.
- **Both rights, everywhere** (changed after the review): `prepare_trial_balance` and `manage_source_files` are required for connect, disconnect, status and import, and the import checks both before touching Intuit. A delegate therefore needs two explicit grants; the owner has both.
- **The browser side** is in PR #241: the card reads `#qbo_handoff` from the address, removes it at once and calls `qbo-finish-connection`. The callback returns the browser to `/workspace/<company>/<year>/trial-balance/review` (the year travels in the OAuth state). Intuit's authorisation-code lifetime is not verified at the primary source; an expired code is refused by Intuit and answered `expired` (connect again).
- Cleanup of expired OAuth states and dead tokens runs opportunistically from `qbo-connect-start` (`qbo_housekeeping`, best effort). No purge of the seven-year evidence ships (see the storage record).
