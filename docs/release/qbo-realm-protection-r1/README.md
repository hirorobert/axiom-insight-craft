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
| C — cutover v2 (PR #289; supersedes #282) | `20261231100000_qbo_realm_protection_cutover_schema.sql`, `20261231200000_qbo_realm_protection_cutover_functions.sql`, `20261231250000_qbo_realm_rotation_post_redaction.sql`, `20261231300000_qbo_realm_protection_cutover_redaction.sql` | parts 1–3 change no row; **part 4 is not reversible for the plaintext** | part 1: realm_id nullable, every row keeps plaintext or protection, guards allow only a verified row's redaction plus forward-only reseal/reindex; part 2: uniqueness, per-realm lock, pending-revocation and shared-realm checks on the index, index-key homogeneity, no function writes a plaintext, backfill writers dropped; part 3: reseal and reindex that work once the plaintext is gone; part 4: plaintext of live connections, pending operations and OAuth states removed, history byte-identical. **Status: all four parts applied on 2026-11-22: parts 1–3 as hosted 120–122, part 4 (separately approved) as hosted 123** (see "Phase C v2" below) |

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

## Who may run the backfill

Lovable Cloud does not disclose the service-role credential to anyone (Supabase: "Service role and API keys are not accessible for Lovable
Cloud–managed projects"), and Lovable's own direct function calls use the signed-in user's session. So `qbo-realm-protect` does not ask for
that credential. It admits **only a signed-in, active platform owner**:

* the gateway requires a valid session (`verify_jwt = true`), and the function checks it again (`_shared/auth.ts` `validateAuth`:
  signature, expiry and a user subject; with asymmetric signing keys this is a local check, so a signed-out session stays usable until it
  expires, about an hour); a token with no user (the service-role or anon key), an expired or forged session, or no session is
  refused `401` before the database is asked;
* the database decides authority with its own `public.is_platform_owner(user)` (an active `commercial_admins` row at the `platform_owner`
  tier, hosted since 20261104100000); a workspace owner, member, commercial-tier administrator or inactive owner is refused `403`; an
  answer that is not exactly `true`, or a check that cannot complete, is refused (`403` / `503`), never assumed;
* only then does the function use its own service client, and only for the two fixed actions (`{"action":"protect"}` /
  `{"action":"verify"}`, nothing else accepted) through the service-only database functions. There is no SQL, no row selection and no
  realm in the request or the answer.

Safe to repeat, to run twice at once, and to resume: each row is decided by its own call under a row lock that never overwrites
(`already_protected` / `already_verified`), so an interrupted run leaves only finished rows and the next run completes the rest
(proven on real PostgreSQL: an interrupted run, two concurrent protects, two concurrent verifications). The function log records the
actor's user id, the outcome and the counts; never a realm, envelope, index, key or row id.

## Deployment order, PR 1 (Phases A + B) — owner / Lovable only

1. Set the two secrets above (Supabase → Edge Functions → Secrets).
2. Apply `20261230100000`, then `20261230200000`, then `20261230300000` through the canonical journalled migrator, in that order (each
   refuses without its predecessor; a replay is a no-op). Between apply and step 3 the deployed functions keep working (the new
   parameters default to NULL); what they write unprotected is protected in step 5. The sandbox rehearsal's status line shows no company id
   until step 4.
3. Deploy `qbo-oauth-callback`, `qbo-finish-connection`, `qbo-pull-trial-balance`, `qbo-disconnect`, `qbo-connect-start` (its bundle
   includes `_shared/qboConnect.ts`) and the new `qbo-realm-protect` (a GitHub merge does not redeploy functions; deploy each explicitly).
4. Publish the frontend (the import sends a connection id; the status line shows the connection date; the platform-owner rehearsal page
   gains the encryption control). Until step 5, an import or disconnect protects its own connection first (`realmForOperation` in `_shared/qboRealmProtection.ts`).
5. Run the backfill as the platform owner (see "Who may run the backfill"): sign in, open `/internal/tester/quickbooks`, press
   **Encrypt stored company IDs**, then **Check encryption**. Both show counts only. Done only when the check reads "Check complete" with
   every connection and every disconnect record checked (the function's `200 complete`). Anything else: run it again; if the count of
   records needing attention does not fall, stop. If the very first press says the session expired although you are signed in, the old
   `qbo-realm-protect` is still deployed (a merge does not redeploy functions): deploy it, then press again. Nothing was changed.

Rollback of PR 1: stop at any step; the plaintext is intact. To remove the schema, drop the functions, guards' added rule, index,
constraints and columns of Phase A (they hold only derived data).

## Hosted record, Phases A + B (2026-11-18, owner-authorized)

| Hosted id | Mirror | Source | Applied form |
|---|---|---|---|
| 114 | `0113_qbo_realm_protection_schema` | `20261230100000` | identical, `7b310469…` (17,633 B) |
| 115 | `0114_qbo_realm_protection_connect` | `20261230200000` | identical, `578a4baf…` (13,128 B) |
| 116 | `0115_qbo_realm_protection_evidence` | `20261230300000` | **whitespace variant**, `b58065bb…` (16,318 B): Lovable's migrator added one leading space to line 60 (a continuation line of an `UPDATE … SET` inside `qbo_begin_disconnect`); nothing else differs. Not significant to PostgreSQL; the migration's postconditions passed; the hosted `prosrc` was read back with the extra space. Registered as the reviewed `release_whitespace_variant` entry, whose validator accepts exactly that one indentation change. Phase C replaces `qbo_begin_disconnect` wholesale. |

Applied through Lovable's migrator from main `8819ccf`, one file at a time; journal hashes read independently in the hosted SQL editor.
Before the backfill: 5 connections (3 live), 2 disconnect operations, none protected.

## Phase C v2 — irreversible for the plaintext (supersedes PR #282)

PR #282 (v1) was written before the token-key reseal (`20261230400000`), its guard repair (`20261230410000`) and the index-key rotation
(`20261230500000`). Applied today it would have replaced both realm guards with bodies lacking the reseal and reindex transitions, left no way
to rotate either key once the plaintext is gone, installed nothing it could verify, and let a connect or disconnect compare indexes made by two
different keys (a duplicate live connection, or a shared token revoked by mistake). v2 fixes all of that. Four parts, each **self-verifying**
(it pins the SHA-256 of every function body it installs and of every body it depends on; any difference fails the whole block, nothing changes)
and a no-op on replay:

| Part | File | Bytes (LF) | SHA-256 (as committed) | Final LF removed |
|---|---|---|---|---|
| 1 schema | `20261231100000_qbo_realm_protection_cutover_schema.sql` | 16,936 | `599c851f209d0e5a4bbf782320139823a371750b89898afb6488dd5af6108966` | `7228d91cbfa3e15ed6584bfde5526e6263aa7871b7048a0f7f8ad48b2485d5a3` |
| 2 functions | `20261231200000_qbo_realm_protection_cutover_functions.sql` | 20,450 | `48295fcd5fae4ef3d368494a427d44f13ccd64157ce80f036732ca49e6fcf020` | `4aaf390a506dc901293242239eaf3d84ce093dd6e7c69a4da534f92a5c215bc9` |
| 3 post-redaction rotation | `20261231250000_qbo_realm_rotation_post_redaction.sql` | 15,045 | `ae14667cb7163c23d7123cd76d2f06e3b22e19ccd6624a64d144ec023ce40b89` | `c06fef91aa4a08cf89a130aa39efeca9ae3f0a122e1a50169801854378c8980f` |
| 4 redaction ★ | `20261231300000_qbo_realm_protection_cutover_redaction.sql` | 10,742 | `b671d00a042bd7132afaf7066791658482ddb32a8f0a8c51b1a854c2418967c0` | `cb51832b574ad8171aaff4d6b6b9d52810c5d55c9237b5fa51604585ef735a70` |

Generated by `scripts/release/genQboCutoverV2.mjs` from v1's reviewed text (`acdee94`) plus the reviewed v2 bodies; the fiscal wrapper's
before-digest is computed on a local database over the exact chain. A fingerprint proves which file was applied, not that it is correct; the
preconditions and postconditions below are what make an application correct or refused.

**What each part does**

1. **Schema.** `realm_id` nullable on connections, operations, intents and pulls (every row keeps the plaintext or the protection); the OAuth
   handoff pairing; `qbo_key_version(id, kind)` (`k<N>`/`idx<N>` → N, anything else NULL); `qbo_index_key_mixed(index_key_id)` (owner-only);
   both guards keep **every** earlier rule and allow exactly: a VERIFIED row's `realm_id` → NULL (never back, never another value); the reseal
   transition onto a **strictly newer** token key; the reindex transition onto a **strictly newer** index key (a NULL version never allows).
   *Pre:* the guards are exactly `db305b36…`/`819623c9…` (hosted 119); every live connection and operation is protected, verified while it
   holds a plaintext, and names a versioned key. *Post:* constraints, nullability, both guards and both helpers hash to their pins; invoker
   guards attached; helpers not executable by `authenticated`.
2. **Functions.** As v1 (uniqueness, per-realm lock, pending-revocation and shared-realm checks on `realm_index`; no new plaintext written;
   writers dropped) plus **index-key homogeneity**: `qbo_store_connection` and `qbo_begin_disconnect` hold the advisory lock
   `qbo-index-rotation` SHARED and refuse while live indexes are on more than one key (`QBO_INDEX_ROTATION_IN_PROGRESS` / PT409, and
   `rotation_in_progress`; the functions answer 409 and the app asks the person to wait and retry). *Pre:* part 1 installed; the fiscal wrapper
   is exactly `23a522bc…` (it is rebuilt from its live text with one anchored replacement). *Post:* five bodies pinned; grants unchanged.
3. **Post-redaction rotation.** The two reseal functions, the token reseal and the two reindex functions, same signatures, service role only:
   the plaintext is compared only while the row still holds one (once redacted the caller sends NULL and it is never read); a move goes only
   to a strictly newer key version (`downgrade` otherwise); every re-index holds `qbo-index-rotation` EXCLUSIVE. *Pre:* parts 1 and 2,
   recognised by their results (writers gone, store body pinned). *Post:* five bodies pinned; only the service role may execute them.
4. **Redaction ★**, LIVE rows only. The plaintext of live connections, **pending** disconnect operations and OAuth states (transient, deleted
   by housekeeping) is set NULL; attempts parked in clear end. *Pre:* every body parts 1–3 installed hashes to its pin (so the plaintext can never
   be removed while key rotation still depends on it); every live row and operation protected and verified. *Post:* no live plaintext; the
   no-plaintext rules installed; and a digest of every **historical** row (terminal connections, finished disconnect operations, import intents,
   provenance rows) taken before any change equals the one taken after — history is byte-identical or the whole block fails.

**Trust boundary (stated, not solved).** The database never holds a key, so it cannot check that a new envelope opens to the same realm or
that a new index is the realm's HMAC. The Edge Function, which holds the keys, proves both before submitting: it opens the old envelope,
recomputes the stored index with the index key that index names, seals or indexes, and opens the new envelope back. The database enforces
compare-and-swap, forward-only key versions, the guards and the service-role-only grants. Anyone who controls **both** the deployed Edge
Functions and the secrets (a Lovable or Supabase project administrator) can read every realm and token and write any well-formed value.
Nothing here protects against that party, and no migration can. Key ids must be versioned (`k<N>`, `idx<N>`) and the sealing or indexing key
must be the highest version in its ring: the functions refuse to start otherwise (`not_configured`), and never seal backwards.

**Hosted record, Phase C v2 parts 1–3 (2026-11-22, owner-authorized).** Applied through Lovable's native migrator from main (unchanged
since merge commit `babe6cd`), one prompt per part; mirrors committed by Lovable and registered as `release_verbatim` in PR #290.

| Hosted id | Mirror | Source | Applied form |
|---|---|---|---|
| 120 | `0119_qbo_realm_protection_cutover_schema` | `20261231100000` | identical, `599c851f…` (16,936 B) |
| 121 | `0120_qbo_realm_protection_cutover_functions` | `20261231200000` | identical, `48295fcd…` (20,450 B) |
| 122 | `0121_qbo_realm_rotation_post_redaction` | `20261231250000` | identical, `ae14667c…` (15,045 B) |

After each part a read-only stage check in the hosted SQL editor showed:
- every body the part installs equal to its pin (part 1 4/4; part 2 5/5, with the backfill writers dropped; part 3 5/5);
- part 4 absent;
- every QuickBooks and commercial row fingerprint unchanged, since parts 1–3 change no row.

Only the part 1 approval card was shown and hashed before Allow (the final-LF-removed form `7228d91c…`, which journal 120 records as the
identical form). For parts 2 and 3 Lovable reused the session's approval and showed no card. Their identity rests on the journal hashes,
each file's own self-verification and the stage check.

The six QuickBooks functions were then deployed explicitly from main (bundles unchanged since `babe6cd`):
- probes returned 401/400/405, with no 503;
- on the new code, "Check keys" reported k2, "Check index key" idx2, and "Check encryption" `200 complete`;
- a stage check afterwards was identical.

Lovable records a "submitted source" fingerprint per function that cannot be reproduced from this repository; live-source attestation is not
available.

**Hosted record, Phase C v2 part 4 ★ (2026-11-22, separately owner-approved, residual risks accepted).**

| Hosted id | Mirror | Source | Applied form |
|---|---|---|---|
| 123 | `0122_qbo_realm_protection_cutover_redaction` | `20261231300000` | identical, `b671d00a…` (10,742 B) |

**Accepted residual risks:**
- no tested restore;
- the live realm IDs now exist only as k2 envelopes, recoverable while key custody holds;
- OAuth reconnection is not a restore;
- applied before a backup containing parts 1–3 existed.

**Immediately before the apply,** in a freshly loaded Lovable session, the stage check, the Part 4 preflight and the inventory of all 54 functions were identical to the baseline. Lovable again showed **no approval card**.

**Read-only checks right after:**
- journal 123 = `b671d00a…`; parts 1–3 still exact;
- **0 live plaintext** (3 live connections and 1 OAuth state cleared; nothing deleted);
- only the `qbo_connections` and `qbo_oauth_states` fingerprints changed;
- the history digest (`20b0011e…`, over terminal connections, finished operations, intents and provenance) was identical;
- no function redeployed;
- "Check keys" k2, "Check index key" idx2 and "Check encryption" `200 complete` on the redacted rows.

**What still holds plaintext, by design:** 12 historical rows (3 disconnected connections, 3 finished disconnect operations, 3 intents, 3 provenance rows) and every backup taken before 2026-11-22 ~14:52 UTC until it expires.

**Open:**
- Intuit compliance (case 00232331); a follow-up question about historical records is drafted;
- customer QuickBooks access stays off.

**Order.** Each step needs the owner's go; ★ needs its own separate, explicit GO. Status as of 2026-11-22: steps 1–4 done (above); step 5 (sandbox
acceptance: connect, import, disconnect) needs its own go, because it writes data.

1. Read-only pre-checks on hosted:
   - a database backup taken after the idx2 move is listed;
   - the owner's independent copies of k2 and idx2 are confirmed;
   - "Check keys" reports only versioned ids, with k2 current; "Check index key" reports idx2 current;
   - `verify` → `200 complete`;
   - hosted body digests: both guards `db305b36…`/`819623c9…`, and `qbo_record_fiscal_pull_intent` `23a522bc…`. If it differs, part 2 will
     refuse: stop and review, do not edit the file.
2. Apply part 1, then part 2, then part 3, through Lovable's migrator, verbatim. Hash the approval dialog's SQL before Allow; verify the journal
   hash and the installed digests after each. The deployed Phase B functions keep working throughout.
3. Deploy, explicitly and once, the six QuickBooks functions from main: `qbo-oauth-callback`, `qbo-finish-connection`,
   `qbo-pull-trial-balance`, `qbo-disconnect`, `qbo-realm-protect`, `qbo-connect-start`. Probes: 401/400/405, no 503. Publishing the frontend
   is needed only for the new `rotation_in_progress` message (optional; without it the generic message is shown).
4. ★ Apply part 4 only with the separate GO. There is no rollback other than restoring the whole database from the step-1 backup. A live
   production restore is not an approved procedure, and no isolated hosted restore exists today (Lovable offers only "Restore to this backup"
   on the live project), so the recoverability of this step is **not** demonstrated.
5. `verify` (a local open-and-index check, counts only); `qbo_realm_protection_status()` shows 0 live plaintext; sandbox acceptance.

**Rotating a key after Phase C** (for example k2 → k3):

- *Token key:* add `QBO_TOKEN_KEY_NEXT_*` = k3 (the configured k2 stays, for opening only) and run `{"action":"reseal"}` until it answers
  `200 complete`. Interruptions are safe: each row moves atomically or not at all, so re-run.
- *Index key:* add `QBO_REALM_INDEX_KEY_NEXT_*` = idx3 (optionally `QBO_REALM_INDEX_KEY_PREV_*` for a third recognising key) and run
  `{"action":"reindex"}` until complete. Connects and disconnects answer 409 while it runs.
- Retire an old key from the ring only after `keys`/`index_keys` report zero rows under it **and** no backup still needed depends on it.
  k1 and idx1 stay: historical rows and pre-Phase-C backups depend on them.

**What keeps a plaintext afterwards, by design:**

- disconnected (terminal) connection rows (their guard forbids any change);
- finished disconnect operations (`revoked`, `local_only`): history of a completed revocation, never read to operate;
- import intents and provenance rows written before Phase B (append-only evidence, DESIGN option a).

`qbo_realm_protection_status()` counts both (`terminal_plaintext`, `intents_plaintext_only`, `pulls_plaintext_only`). Backups taken before
Phase C still contain the plaintext until they age out. Whether this meets Intuit's requirement is an open compliance question, not an owner
risk decision; it is not changed here.

## Evidence

* `scripts/db-proof/qboRealmCutoverRotation.mjs` (CI: Disposable-DB job) — Phase C v2, adversarially: order and self-verification, the
  post-redaction k2→k3 and idx2→idx3 rotation through the real orchestration, interruption, downgrade, stale and cross-tenant submissions,
  wrong keys, homogeneity, uniqueness, pending revocations, terminal rows, grants, no bare UPDATE or DELETE.
* `scripts/e2e/qboRotationStackJourney.mjs` (CI: local Supabase stack) — the same rotation through real PostgREST (safeupdate) after `supabase start`.
* `scripts/db-proof/qboRealmProtection.mjs` (CI: Disposable-DB job) — real PostgreSQL, the full chain, existing data written by main's
  functions, the backfill through the real orchestration and module.
* `src/lib/ingestion/qboRealmProtection.test.ts`, `qboConnect.test.ts`, `qboPull.test.ts`, `qboReadiness.test.ts`,
  `src/lib/workspace/qboConnectorClient.test.ts`, `src/components/workspace/QuickBooksImport.test.ts`, `src/lib/__tests__/intuitSecurityR1.test.ts`.
