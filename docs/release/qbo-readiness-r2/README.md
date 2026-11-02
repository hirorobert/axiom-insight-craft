# QBO readiness controls r2 — source candidate, 2 November 2026

## Status and scope

Implemented in source, tested locally; NOT installed, deployed, published, enabled or accepted by Intuit. Initial source: `f40f61104b6749ebd4712448e41280b61d5988b6`, clean working tree. Platform-managed source snapshots may advance while edits are recorded; no manual Git state changes. Existing installed SQL and mirrors are unchanged. No hosted financial, token, payment, membership, grant, rollout or publication mutation was performed.

Charter is **proposed, adoption/accounting review unrecorded**. Applicable target controls: P1/P2/P6/P7; R1/R8/R13/R14; G1; §11.3 request identity, immutable history and uncertain outcomes; §11.4 tenant boundaries and separate installation/publication/activation. Existing repository controls remain authoritative. This is connector source preparation, not framework compliance or retrospective certification.

### Facts/gaps and implementation

| Control | Status/evidence | Limitation |
|---|---|---|
| Source fiscal alignment | Source + local tests: `qboFiscalBasis.ts`, `qboPull.ts`, candidate `qbo_saved_period` reads confirmed saved period and matching engagement; GET Preferences verifies fiscal month, report basis, home currency; report metadata checked separately | Real non-January/leap/short-period vendor samples still need authorized acceptance |
| Fiscal YTD provenance | Candidate append-only `qbo_fiscal_pull_basis` binds period, Preferences SHA, fiscal start month/start, as-of, currency, basis and operation lease to the pre-upload intent | Old evidence has no new fiscal assessment; never backfilled |
| Read-only Accounting | `qboReadOnlyGuard.ts`: exact GET TrialBalance/Preferences only; all Accounting POST/PUT/PATCH/DELETE denied before network | OAuth accounting permission itself is broader; not a vendor read-only scope |
| Disconnect/revoke | Source function + candidate: authenticated both-rights check, terminal local connection, encrypted pending revoke operation, fixed allowlisted OAuth revoke POST, receipt deletes pending envelope, same request replay | Not deployed; live revoked/400/lost-response behavior requires vendor acceptance |
| Full import fence | Lease retained through rotation, checked at fiscal intent and upload INSERT; obsolete operation cannot rotate/register; disconnect waits for live lease; terminal row cannot resurrect | 300-second crashed-operation wait; no global Intuit app/workspace quota ledger claimed |
| Environment isolation | Production credentials require their own pair and `QBO_PRODUCTION_APPROVED=true`; same sandbox values refused; token envelope bound to company/realm/environment | Backend approval configuration remains absent; customer source switch remains false |
| Rate/quota handling | GET-only up to two attempts for 5xx, 500ms pause; 429/402 stop with no immediate retry; response/socket/body deadlines and 5 MB whole-response refusal | Local activity does not establish workspace-wide remaining Intuit credits |
| Uncertain registration | Unknown save leaves source object intact, reports unconfirmed, no automatic registration/import replay | Existing reservation/pending-link recovery; no arbitrary source deletion |
| Disconnect URL | `/quickbooks/disconnect`: informational only; ignores all realm/company query input; authenticated confirmation from connected workspace | Documentation does not establish a signed disconnect invocation/webhook contract |

## Fiscal semantics

TrialBalance is fiscal YTD **as of the end date**. `start_date` echoed in a header is not proof that QuickBooks remeasured income/expense accounts. Fetch Preferences for the connection’s exact environment/realm, derive the most recent first day of its fiscal month at or before the saved end, require exact saved start equality and saved currency equality. Require actual report start/end/currency/basis to agree as well. Never truncate, convert, rebalance, or create opening balances.

Non-January fiscal years, leap February, prior-year comparisons and interim fiscal YTD are explicit test cases. A shortened first period whose start is not the fiscal start and an extended period crossing a fiscal reset are refused; manual independently prepared evidence is the alternative. A shorter fiscal YTD ending before the year end is accepted only when its start equals the verified fiscal start. Unknown fiscal month/currency/method or unconfirmed saved dates refuse. No arbitrary client period or engagement identity is authority.

The owner-recorded Sandbox US FY2026 USD import (45 accounts; debit and credit 41421.60) remains immutable evidence under its original contract, not retrospectively certified by these controls. This turn did not query its balances or modify it.

## Disconnect and retry contract

A verified person needs both `prepare_trial_balance` and `manage_source_files`, judged again by SQL for the connection’s own company. SQL serializes store/disconnect on company/environment/realm and locks the connection. Busy imports stop disconnect; retry after completion. A successful begin atomically makes the existing connection terminal and moves the encrypted token into service-only revocation staging. Imports/refresh cannot access it. Reconnect is refused while revoke is pending so a delayed old revoke cannot revoke a new connection.

Upstream success (200) plus confirmed final receipt clears pending token material. Network, timeout, 400 or uncertain final save remains `revocation_pending`, never falsely confirmed. Retry uses the SAME actor + request identity and encrypted material. A 45-second revocation-operation lease serializes duplicate upstream calls; its exact receipt identity is required to clear staging. Busy retry stops without a second revoke, and a crashed call waits for lease expiry. Authenticated `qbo_pending_disconnect` returns only that actor’s request/connection identities to resume after refresh, never envelope. Unknown other request or actor conflicts. If no usable token exists, `local_only` explicitly means upstream revocation unproved; remove access in Intuit and obtain evidence. No fabricated success, scheduled purge or invented retention duration. Pending failed revocations remain encrypted until resolved; operation metadata remains for audit. A future housekeeping/retention policy needs separate approval.

Intuit OAuth Step 16 mentions a realm query parameter for navigation/reconnect, but specifies no authenticated signed request to the configured Disconnect URL. Therefore unauthenticated navigation **does nothing**. Owner must register the informational URL only after publication is authorized; use normal sign-in/workspace confirmation for effects. No realm-based unauthenticated RPC or webhook.

## Primary documents actually read

- [TrialBalance API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/trialbalance): report header and supported query parameters. Public page describes explicit ranges, but does NOT prove fiscal remeasurement; owner-supplied Intuit clarification about YTD is the conservative semantic contract.
- [Preferences API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/preferences): `AccountingInfoPrefs.FirstMonthOfFiscalYear`, `ReportPrefs.ReportBasis`, `CurrencyPrefs.HomeCurrency`.
- [OAuth 2.0, Step 16](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0): revoke access and refresh using POST `https://developer.api.intuit.com/v2/oauth2/tokens/revoke`; JSON `{token}` with client Basic authentication; 200 success, 400 failure. Example realm navigation lacks a signed invocation contract.
- [Platform service fees](https://help.developer.intuit.com/s/article/platform-service-fees): Builder includes 500,000 monthly CorePlus credits; Reports/data-out metered; exceeding Builder included allowance is blocked. Not a CFOClose per-connection budget or verified credit balance.
- [Production/App Assessment](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app): assessment approval precedes production credential visibility; URLs required. Tanzania eligibility is **owner-reported Intuit support clarification**, not independently proven by this public page; obsolete UK-entity assertion in r1 is not current eligibility evidence.
- [Rate-limit primary support article](https://help.developer.intuit.com/s/article/API-call-limits-and-throttling): primary search excerpt read; full page not independently captured. No local concurrency counter is presented as vendor allowance.

## Candidate installation/release — NOT executed

Exact SQL fingerprint is `release/candidates/qbo-readiness-r2/manifest.json`. Candidate remains outside authored migrations/journal until reviewed promotion/registration. It is forward-only and includes explicit transaction boundaries, grants/RLS for each new table, fixed search paths and private writer grants; installed migration files are untouched. A native migrator-compatible registered wrapper/staged package must be prepared and reviewed if required; never strip BEGIN/COMMIT ad hoc or submit reconstructed SQL. No hosted journal head or migrator capacity is inferred in this source-only turn.

1. Review candidate, documented pending-token retention and residual risks; promote/register exact bytes using repository release process and test canonical submission envelope. Obtain current DB + Storage recovery evidence and capture existing publication/binding/signoff/pack + QBO provenance fingerprints.
2. Recheck journal predecessor and absent candidate objects; apply ONLY approved registered candidate, verify RLS/grants/signatures, token secrecy, terminal connection guard and unchanged historical digests/counts.
3. Deploy matching pull plus new disconnect (JWT true), alongside shared environment/guard closure for start/finish; callback JWT false remains unchanged. Review explicit JWT config in release package (do not rely on defaults). Deploy nothing before candidate verified; new source on old schema fails closed without reserving an upload.
4. Authorized synthetic acceptance: original source hashes unchanged; January/non-January samples; real Preferences/report basis; disconnect/refresh/import race; resume same pending revoke; cross-tenant and signed-out refusals; no source-write endpoints. Get independent deployed-closure evidence or explicitly record unavailable attestation.
5. Publish only with owner authorization; verify informational Disconnect URL and authenticated retry UX; configure Intuit URLs separately. Production credentials, assessment submission/legal terms, customer switch/environment transition remain separate owner actions.

Postchecks: new tables RLS enabled, no anon/authenticated access to token-bearing rows; only service writer EXECUTE; pending identity read only authenticated + current both-rights/own actor; rotation lease-id and registration fence; immutable fiscal provenance and original pulls; unchanged all historical uploads, signoffs, publication bindings/authority and packs; payment/rollout/AI untouched. Stop on actual mismatch; never replay ambiguous installation.

## Production assessment truthful answer map

| Question/topic | Actual answer | Missing external evidence |
|---|---|---|
| Application domain | `https://cfoclose.com` canonical source; App URL name present | Deployed new frontend identity not verified |
| Launch | Existing authenticated `/workspace` | Register/verify in Intuit portal by owner |
| OAuth callback | Existing callback function name `qbo-oauth-callback`; `QBO_REDIRECT_URI` name present | Exact stored value intentionally NOT read; owner must confirm same registered address |
| Disconnect | Proposed `https://cfoclose.com/quickbooks/disconnect` safe navigation, then authenticated confirmation | Not published/registered; invocation authenticity unspecified by vendor |
| Privacy/EULA | Existing `/privacy` and `/terms` pages | No new legal approval fabricated; lawyer review/data handling/retention assessment remain external |
| Scope | Accounting OAuth; application-enforced GET-only report/Preferences; no Accounting write-back | No assertion that granted scope is read-only |
| Storage/security | AES-256-GCM bound envelopes, backend-only keys, private token rows, authenticated tenant rights | No claim of security certification or completed penetration audit |
| Production eligibility | Owner reports Tanzania Builder App Assessment eligibility | Intuit approval/production keys and legal acceptance not supplied |
| Capacity/fees | 500,000 Builder monthly CorePlus allowance from primary fee page; Reports metered | Workspace-wide consumption/credits/overage contract not measured here |
| Supported accounting | Imported source only; normal existing check/review required | No public reporting certification, legal/compliance or statutory assurance claimed |

Secret **names only** checked 2026-11-02: `QBO_CLIENT_ID_SANDBOX`, `QBO_CLIENT_SECRET_SANDBOX`, `QBO_REDIRECT_URI`, `QBO_APP_URL`, `QBO_TOKEN_KEY_ID`, `QBO_TOKEN_KEY_B64`: PRESENT. `QBO_CLIENT_ID_PRODUCTION`, `QBO_CLIENT_SECRET_PRODUCTION`, `QBO_PRODUCTION_APPROVED`: MISSING. No values read/printed, no keys rotated, no production names created. Presence is not runtime validity.

## Test evidence

- Connector/sandbox regressions: **302/302**, 12 files (including 24 new readiness and 8 new pull adversarial cases).
- Final broader release selection: **401/401**, 17 files; migration authority, applied immutability, release journal, legacy-name and metadata regressions included.
- Disposable PostgreSQL 17.11: **19/19** real candidate controls; full existing chain, synthetic ownership, grant refusal, lease/disconnect/rotation, immutable history counts, saved period, evidence idempotency and no partial upload after disconnect. No hosted DB.
- Deno check: all five function entry points passed; latest changed pull/disconnect also checked. No Intuit request made.
- Full lint: 0 errors, 181 warnings at final run; no manual project build/typecheck invocation permitted by the preview harness. Preview build log reports `build OK`; this is not an independently run full production build/typecheck.
- Playwright: 1280 and 375 widths, informational Disconnect page renders; forged realm/company URL identifiers ignored; no POST, no horizontal overflow. Screenshots under `/tmp/browser/qbo-readiness`. Authenticated NEW disconnect/import journey NOT exercised: candidate intentionally unapplied, no hosted mutation authorized; local orchestration and PostgreSQL boundaries exercised instead.

The QBO Deno entry-point check and disposable candidate proof are wired into the existing CI jobs; no hosted execution is introduced. Full independent production build/TypeScript clearance remains a CI requirement, not claimed from the preview watcher.
