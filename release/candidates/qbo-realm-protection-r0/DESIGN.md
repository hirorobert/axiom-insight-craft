# QuickBooks realmID protection — design and inert candidate (r0)

**Status: INERT CANDIDATE — awaiting Intuit's written clarification (case 00232331).** Nothing here is a migration, is registered,
is imported by a function or page, or is deployed. Do not apply, promote or wire any of it until the clarification arrives and
the owner decides.

## The requirement and the open question

Intuit (developer.intuit.com, go-live security requirements, read 2026-11-06): *"Encrypt and store the refresh token and realmID in
persistent memory. Encrypt the refresh token with a symmetric algorithm (3DES or AES). AES is preferred. Store your AES key in your
app, in a separate configuration file."*

Two different protections exist and must not be confused:

| | What it protects against | CFOClose today |
|---|---|---|
| **Disk (at-rest) encryption** by the platform (Supabase/AWS volume encryption) | someone reading the physical disk or a raw volume snapshot | Provided by the platform for the whole database, including `realm_id`. Not verified by us beyond the provider's documentation. |
| **Application encryption** (the app encrypts before the database sees it; the key lives only in the app) | anyone who can read the database through SQL: a leaked service key, a database dump, a backup, an over-broad query | **Refresh token: yes** (AES-256-GCM `v1.<keyId>.<iv>.<ct>`, key only in Edge Function secrets, `_shared/qboTokenEnvelope.ts`). **realmID: no** — `qbo_connections.realm_id` and four other tables hold it in plaintext. |

The sentence's second half names only the refresh token for the algorithm. Whether realmID must also be application-encrypted, or
whether storing it in persistent storage protected by disk encryption satisfies "encrypt and store", is the question put to Intuit.
This candidate is the smallest compatible design if the answer is "application encryption required".

## Where realmID lives today (plaintext)

| Place | Use | Treatment in this design |
|---|---|---|
| `qbo_connections.realm_id` | one-live-connection unique index `(company_id, realm_id, environment)`; identity guard; shared-realm check in `qbo_begin_disconnect`; per-realm advisory lock `hashtextextended('qbo-connect:'||env||':'||realm)`; API calls `/v3/company/{realm}` | **Phase A (candidate SQL here):** add `realm_envelope` + `realm_index`; backfill. Phase C switches uniqueness/locks/checks to `realm_index` and removes the plaintext. |
| `qbo_oauth_states.realm_id` | parked for at most 10 minutes between callback and finish | Phase B: callback stores envelope + index only (short-lived; no backfill needed — rows expire). |
| `qbo_disconnect_operations.realm_id` | pending revocation blocks reconnect of the same realm | Phase B/C: envelope + index; the `QBO_REVOKE_PENDING` check compares indexes. |
| `qbo_pull_intents.realm_id`, `qbo_pulls.realm_id` | append-only provenance (`tbu_append_only_guard`) | **Open question for Intuit/owner.** Append-only evidence cannot be rewritten without weakening its guard. Options: (a) leave historical rows as provenance and write envelope + index for new rows; (b) a reviewed, audited redaction exception. Not decided here. |
| `trial_balance_uploads.file_name` of an import | `quickbooks-<realm>-<date>.csv` | Phase B: name new imports `quickbooks-<date>.csv`; existing names are upload evidence (same open question). |
| Browser | `qbo_connection_status` returns `realm_id`; the UI shows "Connected to QuickBooks company {realm}" and sends `realmId` back on import | Phase B: the page addresses a connection by its `id`; see *Display* below. |
| Refresh-token envelope AAD | `connectionBinding(company, realm, env)` binds each token to the plaintext realm | **Unchanged.** Functions open the realm envelope first, then the token with the same binding; no token is re-sealed, so no existing connection has to reconnect. |

## Design (smallest compatible)

* **Realm envelope:** the *same reviewed* `sealSecret`/`openSecret` (AES-256-GCM, 96-bit random IV, AAD-bound) with the *existing*
  token key ring (`QBO_TOKEN_KEY_*`, held as Edge Function secrets — "a separate configuration file" in Intuit's words), purpose
  `qbo-realm-id`, bound to workspace + environment. Rotation works as for tokens.
* **Realm index:** `h1.<keyId>.<HMAC-SHA256>` over a domain-separated, length-prefixed `(environment, realm)` with its **own**
  key (`QBO_REALM_INDEX_KEY_ID` / `_B64`). Needed because the database must still enforce one live connection per realm, detect a
  realm shared by two workspaces before revoking Intuit's token, and serialise per realm — without holding the realm. Not bound to
  the workspace, on purpose (shared-realm detection). A plain unkeyed hash would be brute-forceable (realm ids are short numbers);
  the keyed HMAC is not without the key. Equality between rows is still visible to a database reader (inherent to any equality
  index). Rotating the index key is a full re-index, so it is separate from the token key.
* Module: `realmProtection.ts` (this folder; unit tests in `src/lib/__tests__/intuitSecurityR1.test.ts`).

## Phases (each separately approved; none started)

* **Phase A — additive schema** (`phase-a-additive.sql`): two nullable columns, a shape constraint, a partial unique index on the
  index, and `qbo_protect_connection_realm(id, realm, envelope, index)` (service role only). It fills only the new columns, refuses
  unless the supplied plaintext equals the row's `realm_id`, never overwrites, never touches a disconnected (terminal) row.
  Nothing existing changes; every current function keeps working unmodified.
* **Phase B — functions dual-write + backfill:** callback/finish/pull/disconnect write envelope + index alongside the plaintext; a
  one-off, service-only backfill function seals each live connection, verifies its own round trip, submits through
  `qbo_protect_connection_realm`, then a verification pass opens every envelope and compares it with the plaintext (counts only;
  no realm logged). The UI moves to connection ids.
* **Phase C — cutover (irreversible for the plaintext):** uniqueness, locks and shared-realm checks use `realm_index`; functions
  read the realm only by opening the envelope; then `realm_id` is set to NULL (constraint relaxed) for live rows. Requires: Phase B
  verification at 100 %, a database backup, and the owner's explicit go. Backups taken before Phase C still contain the plaintext
  until they age out — state this to Intuit if asked.

## Preserving existing connections

Proven on a disposable database by `scripts/db-proof/qboRealmProtectionCandidate.mjs` (14/14 on 2026-11-06, the full chain plus
this candidate): two workspaces sharing one QuickBooks company, a second company with a held import lease, and a disconnected
connection with a pending revocation. After Phase A and the backfill every pre-existing column of every connection (identity,
status, token envelope, key id, expiries, lease, disconnect time) is byte-identical; revocations, pulls, intents and OAuth states
are unchanged; each envelope opens to exactly its realm only for its own workspace; shared realms share one index; replay is
idempotent; a wrong plaintext, a conflicting index and a malformed value are refused; members cannot call the backfill; the lease
functions, the members' status read and a reconnect of the same company keep working and keep the protection. `updated_at` is
stamped by the existing guard trigger — the only non-new column that changes.

## Display implications

With Phase C the database can no longer return the realm to the browser. Options, in order of preference:

1. **"QuickBooks company connected on <date>"** plus environment — no realm at all. Simplest; nothing to protect.
2. A masked tail (e.g. `…0001`) returned on demand by an Edge Function that opens the envelope for an authorised member — never
   stored, never cached (`no-cache, no-store`).
3. The QuickBooks company *name* from Intuit's CompanyInfo at connect time — needs one more read-only Intuit call and stores
   another customer identifier, so only if users need to tell several connected companies apart.

The import request changes from `realmId` to `connectionId`; the function resolves the realm server-side.

## Rollback

* Phase A: drop the function, the index, the constraint and the two columns (they hold only derived data; the plaintext is intact).
* Phase B: stop dual-writing; leave or clear the new columns.
* Phase C: restoring plaintext means opening every envelope with the key — possible while the key exists; that is the reason
  Phase C is last and separately approved.
