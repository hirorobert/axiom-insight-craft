# intuit-security-r1 — Intuit security requirements: cache headers, file downloads, realmID

Status: **prepared and tested locally; NOT applied, NOT deployed, NOT published, NOT verified live.** Customer QuickBooks access stays
off (`QBO_CONNECTOR_ENABLED = false`), the Intuit questionnaire stays unsubmitted, the Cloudflare production proxy is unchanged. No
Lovable AI request was used. Intuit clarification case 00232331 is pending.

Source text (developer.intuit.com → QuickBooks Online → Go live → Security requirements, read 2026-11-06):

* R-CACHE: "Caching is disabled on all SSL pages and all pages that contain sensitive data by using value no-cache and no-store
  instead of private in the Cache-Control header."
* R-REALM: "Encrypt and store the refresh token and realmID in persistent memory. Encrypt the refresh token with a symmetric algorithm
  (3DES or AES). AES is preferred. Store your AES key in your app, in a separate configuration file."

## Requirement status

| Surface | Before (measured) | This change | Status after merge (not deployed) |
|---|---|---|---|
| QuickBooks Edge Functions (5) | `no-store` only | `no-cache, no-store`, all other headers kept | **verified gap → fix prepared**, unit/Deno checked; live after deploy only |
| Trial-balance file/draft functions (`trial-balance-source-download`, `-signer`, `trial-balance-draft`) | `no-store` only | `no-cache, no-store` | **verified gap → fix prepared** |
| Original-file download, final file response | measured 2026-11-06 on production: signed Storage object, **no Cache-Control**, `Expires` ≈ link expiry (+60 s), `Last-Modified` present | the function serves the bytes itself with `no-cache, no-store` (proxied delivery); the browser never fetches the Storage object | **verified gap → fix prepared**; CI local-stack journey checks the final response |
| PostgREST `/rest/v1` successful reads, RPCs, inserts | no Cache-Control (measured, real PostgREST) | pre-request hook → `no-cache, no-store` | **verified gap → fix prepared, proven on real PostgREST 13.0.8 and 14.18** |
| PostgREST error responses (401/403/400/404/405/406) | no Cache-Control | **still none** — PostgREST discards the hook's header when the request fails (14 cases measured) | **verified residual gap**; not fixable in the database |
| Supabase Auth `/auth/v1` | no Cache-Control | none (GoTrue is managed, not ours) | **interpretation awaiting clarification** |
| Supabase Storage responses other than the app's download | per Storage | unchanged | **interpretation awaiting clarification** (the app no longer uses them for downloads) |
| Static HTML shell (Lovable hosting) | `no-cache, must-revalidate, max-age=0` (no `no-store`) | out of scope (Lovable-controlled; Cloudflare unchanged) | **interpretation awaiting clarification** |
| CORS preflight (`OPTIONS`) answers of the functions | no Cache-Control, body `ok` | unchanged (no data) | not a page; listed for completeness |
| Service-only / non-QuickBooks functions still `no-store`: `trial-balance-source-sweeper`, `trial-balance-storage-cleanup`, `issue-enquiry-challenge`, `_shared/serviceEnquiryHandler.ts` | `no-store` | unchanged (pinned by `intuitSecurityR1.test.ts`; storage-cleanup's closure is pinned in `verifyDeployedClosure.mjs`) | **verified gap, deliberately deferred** (no customer data to a browser; changing them adds deployments) |
| R-REALM refresh token | AES-256-GCM application envelope, key only in function secrets | unchanged | **verified compliant** (source review; key storage as Edge Function secrets) |
| R-REALM realmID | plaintext `text` in `qbo_connections` and four other tables; disk encryption by the platform only | inert design + candidate only (`release/candidates/qbo-realm-protection-r0/`) | **interpretation awaiting clarification** |

Nothing above claims third-party data handling, logging or attack resistance as verified beyond the measurements named.

## What the download change means (three different facts)

1. **Signed-link validity** — the function issues a Storage link valid for 60 s (unchanged; the issuance decision and its audit record
   are unchanged). With proxied delivery the link is used once, inside the function, and never reaches the browser.
2. **HTTP cache freshness** — before: the Storage response had no Cache-Control and an `Expires` about 60 s ahead plus
   `Last-Modified`, so a browser or intermediary could treat it as fresh for that minute, and heuristic freshness could apply. The
   link's short life does not make the cached copy short-lived: a cache keeps a stored response independently of whether the link
   still works. After: the file response carries `Cache-Control: no-cache, no-store` and `Pragma: no-cache`.
3. **Retention of downloaded copies** — a file the user saves is theirs on their device; no header controls it. The app hashes it
   against the server's fingerprint, offers it as a save, and revokes its in-memory object URL after 10 s.

Older clients that still request a link (no `delivery` field) keep the original answer, so deploying the function first never breaks
the live site. The new frontend refuses a link answer (it saves nothing), so the function must be deployed **before** publishing.

## Checks run (2026-11-06, Windows, this worktree)

* Real PostgREST proof: `scripts/db-proof/apiCacheHeaders.mjs` — embedded PostgreSQL 16.14, the full migration chain, PostgREST
  14.18 and 13.0.8 official binaries: **28/28**. Evidence: `postgrest-proof-20261106.json` (this folder).
* Realm candidate proof: `scripts/db-proof/qboRealmProtectionCandidate.mjs` — **14/14**.
* `deno check` (Deno 2.9.6, the CI version): the five QuickBooks functions pass; `trial-balance-source-download` and
  `trial-balance-draft` pass. `trial-balance-source-signer` reports 2 type errors at line 57 (`result.path` / `result.token` narrowing)
  that are pre-existing and not touched here (only its header value changed); it is not in the CI Deno list.
* `bunx vitest run` (full suite, `--testTimeout=60000` for this slower Windows host): 7,494 passed, 3 failed, 10 skipped. The 3 are
  environmental here: `stagedTransport.test.ts` ×2 (`EPERM` creating a symlink — they fail identically on an untouched `origin/main`
  checkout on this machine) and one `atomicEnvelope.test.ts` fixture case that hit a 120 s timeout under full-suite load and passes
  when run alone. CI on Linux is the authority.
* `bunx tsc --noEmit -p tsconfig.app.json`: 0 errors. `bun run lint`: 0 errors (181 pre-existing warnings). `bun run build`: OK;
  `assertPackIsolation`, `assertSingleLockfile`: OK; `assertMigrationAuthority`: OK, `PENDING_HOSTED_APPLY: 20261215100000_api_cache_control_headers.sql`.
* Function closure digests (from `git archive`, LF bytes; full list with every file in `deployment-manifest.json`):
  `trial-balance-source-download` `f803dddb…`, `qbo-connect-start` `5634764d…`, `qbo-oauth-callback` `8c7bf767…`,
  `qbo-finish-connection` `efb16ea4…`, `qbo-pull-trial-balance` `e1283fc9…`, `qbo-disconnect` `26cd8935…`,
  `trial-balance-source-signer` `8106809e…`, `trial-balance-draft` `bbda483d…`.
* Local Supabase stack in CI (`real-app-e2e`, run 42197797505 on the first PR head; `supabase start` applied the migration): the
  original-file journey passed 19/19 and the main browser journey 71/71. Measured there, through Supabase's own gateway: REST read
  and RPC `200` with `no-cache, no-store`; a privilege-denied read (`403`) and a bad-input read (`400`) with no Cache-Control; Auth
  `/auth/v1/user` `200` with no Cache-Control; the proxied file `200` `application/octet-stream` with `no-cache, no-store` and
  `Pragma: no-cache`; the function's refusals (`403`, `403`, `401`) with `no-cache, no-store`; the raw signed Storage object `200`
  with no Cache-Control, `Expires` 61 s after `Last-Modified` (the same shape as production). The IPSAS browser journey's own
  download check still expected the old Storage fetch; it was updated to require one no-cache POST and no Storage fetch.

## Deployment (owner / Lovable only; nothing here is done by this PR)

1. Merge only after CI is green and the owner approves. Merging does not apply, deploy or publish anything.
2. **Pre-check (read-only), hosted SQL:**
   `select setrole::regrole, setdatabase, c from pg_db_role_setting, unnest(setconfig) c where c like 'pgrst.%';`
   If any `pgrst.db_pre_request` exists, stop: the migration would refuse (it never replaces a hook); a chained version is needed.
   Also confirm in the Supabase dashboard that no pre-request hook is configured outside the database (not visible from SQL).
3. **Apply `20261215100000_api_cache_control_headers.sql` through the canonical journalled migrator** (Lovable's native migrator),
   byte for byte (4,955 B, SHA-256 `6c7707d7…c49301b`, or the registered final-LF-removed form). Never through the SQL editor.
4. Verify with a successful read (errors never carry the header, so they prove nothing), using a signed-in test session's token:
   `curl -sD - -o /dev/null "$SUPABASE_URL/rest/v1/companies?select=id&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $USER_JWT"`
   → expect `200` and `cache-control: no-cache, no-store`; and
   `select c from pg_db_role_setting, unnest(setconfig) c where c like 'pgrst.db_pre_request=%';` → exactly
   `pgrst.db_pre_request=public.api_cache_control_pre_request`. Also confirm an ordinary page load of the app still works (every API
   request now runs the hook; a broken hook would fail every request — rollback below).
5. **Deploy functions** (each explicitly): `trial-balance-source-download` FIRST (proxied delivery; backwards compatible), then
   `qbo-connect-start`, `qbo-oauth-callback`, `qbo-finish-connection`, `qbo-pull-trial-balance`, `qbo-disconnect`,
   `trial-balance-source-signer`, `trial-balance-draft`. Compare deployed bundles with `deployment-manifest.json` where the platform
   allows downloading them; otherwise record that attestation is unavailable.
6. Verify: a signed-in POST to `functions/v1/trial-balance-source-download` with `{"upload_id","company_id","delivery":"proxied"}` for
   a disposable upload → `200`, `content-type: application/octet-stream`, `cache-control: no-cache, no-store`, bytes equal to the file;
   each QuickBooks function's JSON answer (e.g. an unauthenticated `qbo-connect-start` 401) → `cache-control: no-cache, no-store`.
7. **Publish the frontend** (explicit Publish), then download an original file through the UI and confirm in DevTools: one POST to the
   function with `no-cache, no-store`, and no request to `/storage/v1/object/sign/`.
8. Report each item separately as prepared / tested / deployed / verified live.

## Rollback

* **Hook:** a new journalled migration
  `ALTER ROLE authenticator RESET pgrst.db_pre_request; NOTIFY pgrst, 'reload config'; DROP FUNCTION public.api_cache_control_pre_request();`
  (proven: after RESET + reload, requests succeed without the header). Emergency only, if every API request fails: the RESET + NOTIFY
  alone restores service; record it and journal it afterwards.
* **Function headers:** redeploy the previous closures (header value back to `no-store`); no data involved.
* **Downloads:** redeploying the previous `trial-balance-source-download` breaks the NEW frontend's downloads (it refuses link answers),
  so roll back the frontend first (re-publish the previous version), then the function if needed.
* **realmID candidate:** inert; nothing to roll back.

Applicable charter targets: least privilege and no widened authority (no grant beyond EXECUTE on one table-free function; no RLS,
policy or role attribute change — proven by catalog snapshot), server-owned authorization (the download decision is unchanged).
Charter adoption status is unchanged by this release.
