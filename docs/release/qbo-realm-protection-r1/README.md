# qbo-realm-protection-r1 — QuickBooks realmID application encryption

Status: **built and tested; NOT merged, NOT applied, NOT deployed, NOT published.** Customer QuickBooks access stays off
(`QBO_CONNECTOR_ENABLED = false`, `QBO_ENVIRONMENT = "sandbox"`). The owner authorized building this release ("Build realmID release");
merging, applying, deploying and publishing each need the owner's separate go.

## Requirement

Intuit, support case 00232331, answer of 9 Nov 2026: *"Refresh tokens and realmID must both be encrypted in persistent storage (AES
preferred), with the key in separate server-side configuration. Host encryption at rest is not enough for realmID if the app stores it in
the clear."* The refresh token already met this (AES-256-GCM envelope, `_shared/qboTokenEnvelope.ts`). This release does the same for the
realmID. The reviewed design is `release/candidates/qbo-realm-protection-r0/DESIGN.md` (now marked superseded by this record).

## What protects the realm

* **Envelope** (`supabase/functions/_shared/qboRealmProtection.ts`): the realm sealed with the existing token key ring (`QBO_TOKEN_KEY_*`),
  AES-256-GCM, purpose `qbo-realm-id`, bound to the workspace and environment (a realm parked by the OAuth callback is bound to the one-time
  handoff's hash, like the parked code). Opened only inside the Edge Functions.
* **Index**: `h1.<keyId>.<HMAC-SHA256>` over `(environment, realm)` with its **own** key (`QBO_REALM_INDEX_KEY_ID` / `QBO_REALM_INDEX_KEY_B64`),
  so the database can keep one live connection per realm, detect a realm shared by two workspaces and serialise per realm without holding it.
  Equality between rows remains visible to a database reader (inherent to any equality index); the realm is not recoverable without the key.
* The browser never receives or sends a realm: `qbo_connection_status` returns none, the page shows "QuickBooks company connected on
  <date>" and the environment, an import names the connection by its id, and new import files are named `quickbooks-[sandbox-]<date>.csv`.

## Phases

| Phase | Migration(s) | Reversible | What changes |
|---|---|---|---|
| A — additive schema | `20261230100000_qbo_realm_protection_schema.sql` | yes | `realm_envelope` + `realm_index` on `qbo_connections`, `qbo_disconnect_operations`, `qbo_oauth_states`, `qbo_pull_intents`, `qbo_pulls`; `realm_verified_at` on connections and operations; shape checks; `uq_qbo_connections_live_protected`; write-once guards; service-only `qbo_protect_*_realm`, `qbo_verify_*_realm`, `qbo_realm_protection_status` |
| B — dual write (PR 1) | `20261230200000_qbo_realm_protection_connect.sql`, `20261230300000_qbo_realm_protection_evidence.sql` | yes (plaintext still written) | callback, finish, store, disconnect, intent and provenance write the protection beside the plaintext; status read loses `realm_id` |
| C — cutover (PR 2, separate) | `20261231100000_qbo_realm_protection_cutover_schema.sql`, `20261231200000_qbo_realm_protection_cutover_functions.sql`, `20261231300000_qbo_realm_protection_cutover_redaction.sql` | **no, for the plaintext** (part 3) | part 1: realm_id nullable, every row keeps plaintext or protection, guards allow only a verified row's redaction; part 2: uniqueness, per-realm lock, pending-revocation and shared-realm checks on the index, no function writes a plaintext, backfill writers dropped; part 3: plaintext of live connections, operations and OAuth states removed. Each part re-checks the 100 % gate |

Append-only evidence (`qbo_pull_intents`, `qbo_pulls`) follows option (a) of the design: historical rows keep their plaintext as provenance
(their guards are unchanged); new rows carry the protection. Disconnected (terminal) connection rows cannot change and keep theirs.
`qbo_realm_protection_status()` counts what remains in clear (`terminal_plaintext`, `intents_plaintext_only`, `pulls_plaintext_only`).

## Secrets the owner must set BEFORE deploying the functions

| Secret | Value |
|---|---|
| `QBO_REALM_INDEX_KEY_ID` | a short name, `[a-z0-9-]{1,32}`, different from every `QBO_TOKEN_KEY_*_ID` (for example `idx1`) |
| `QBO_REALM_INDEX_KEY_B64` | exactly 32 random bytes, base64 (for example `openssl rand -base64 32`); never equal to a token key |

`QBO_TOKEN_KEY_ID` / `QBO_TOKEN_KEY_B64` (and the optional previous pair) are reused for the envelopes. Without the index key the
callback, finish, import, disconnect and backfill functions answer "not configured" and write nothing: there is no plaintext-only fallback
for new writes. Losing the index key means a full re-index; losing the token key means every envelope (tokens and realms) is unreadable.

## Deployment order, PR 1 (Phases A + B) — owner / Lovable only

1. Set the two secrets above (Supabase → Edge Functions → Secrets).
2. Apply `20261230100000`, then `20261230200000`, then `20261230300000` through the canonical journalled migrator, in that order (each
   refuses without its predecessor; a replay is a no-op). Between apply and step 3 the deployed functions keep working (the new
   parameters default to NULL); what they write unprotected is protected in step 4. The sandbox rehearsal's status line shows no company id
   until step 5.
3. Deploy `qbo-oauth-callback`, `qbo-finish-connection`, `qbo-pull-trial-balance`, `qbo-disconnect` and the new `qbo-realm-protect`
   (`supabase functions deploy <name>`; a GitHub merge does not redeploy functions).
4. Run the backfill with the service-role key (never a member's token):
   `POST /functions/v1/qbo-realm-protect {"action":"protect"}`, then `{"action":"verify"}`. Both answer counts only; `verify` must answer
   `200 complete` with `live_verified = live_connections` and `operations_verified = operations`.
5. Publish the frontend (the import sends a connection id; the status line shows the connection date).

Rollback of PR 1: stop at any step; the plaintext is intact. To remove the schema, drop the functions, guards' added rule, index,
constraints and columns of Phase A (they hold only derived data).

## Phase C (PR 2) — irreversible for the plaintext

Needs: PR 1 fully deployed, `verify` at 100 %, **a database backup**, and the owner's explicit go. Order:

1. Backup. 2. `qbo-realm-protect` `{"action":"verify"}` → `200 complete` (connections stored since the last pass are verified here).
3. Apply `20261231100000` → `20261231200000` → `20261231300000`, in order (each refuses unless every live connection and every disconnect
   operation is protected, and verified while it still holds a plaintext: `QBO_REALM_CUTOVER_REFUSED`, nothing changed). The Phase B
   functions keep working throughout (their plaintext argument is accepted and never stored; they read the realm from the envelope).
4. Deploy the Phase C versions of `qbo-oauth-callback`, `qbo-finish-connection`, `qbo-pull-trial-balance`, `qbo-disconnect`,
   `qbo-realm-protect` (and `qbo-connect-start`, whose bundle includes `qboConnect.ts`). 5. `verify` again: a local open-and-index check, counts
   only, nothing written. No frontend change.

What keeps a plaintext afterwards, by design: disconnected (terminal) connection rows (their guard forbids any change) and import intents
and provenance rows written before Phase B (append-only evidence, DESIGN option a). `qbo_realm_protection_status()` counts both
(`terminal_plaintext`, `intents_plaintext_only`, `pulls_plaintext_only`). Backups taken before Phase C still contain the plaintext until they
age out; say so to Intuit if asked. An OAuth attempt parked in clear before Phase B (consumed, at most minutes old) is ended and its state
row removed, as `qbo_housekeeping` would.

## Evidence

* `scripts/db-proof/qboRealmProtection.mjs` (CI: Disposable-DB job) — real PostgreSQL, the full chain, existing data written by main's
  functions, the backfill through the real orchestration and module.
* `src/lib/ingestion/qboRealmProtection.test.ts`, `qboConnect.test.ts`, `qboPull.test.ts`, `qboReadiness.test.ts`,
  `src/lib/workspace/qboConnectorClient.test.ts`, `src/components/workspace/QuickBooksImport.test.ts`, `src/lib/__tests__/intuitSecurityR1.test.ts`.
