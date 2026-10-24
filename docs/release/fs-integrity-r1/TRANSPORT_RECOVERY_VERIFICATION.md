# fs-integrity-r1 — transport, recovery and deployed-function verification (2026-10-24)

Three separate workstreams. Nothing here was installed, deployed or published. Reporting access stays disabled
(`kill_switch = true` at the last read). Hosted journal head read 2026-10-24: id 75, hash `870c3ea2…62857`
(= `drizzle/migrations/0074_tb_decision_catalogue_read_predicate.sql`).

## 1. Exact-byte staged transport — BUILT, REGISTERED, TESTED (disposable database only)

`scripts/release/fsIntegrityStagedTransport.mjs` → `release/staged-transport-fsi/` (15 generated files; `--check` OK).
A new private schema `cfoclose_fsi_release`; the journalled FS and TB transports are unchanged.

| Form (submitted without final LF) | Bytes | SHA-256 | Expected hosted id |
|---|---|---|---|
| `fs_integrity_staged_transport` (bootstrap) | 8,126 | `8001cf3edcb607f62187c14eb4be57993c5f3f8e59d4b15d896d5a493a10e4c8` | 76 |
| `fsi_1_server_compilation_staged_apply` | 6,318 | `21325cb1984c8e2e05ecc8ac532b75cc2c30dd1ff5a81b2914a4024f0d80b018` | 77 |
| `fsi_2_integrity_gate_staged_apply` | 5,920 | `dc467960f2c87f0f02e3b26cb6705123a4c7d4e5b3b69aa7c56eaae375c576d3` | 78 |
| `fsi_3_final_authority_staged_apply` | 5,715 | `b592d692c0b63614aee8ec67cd46e09272e9527571c9b6bef28ce3fd8bdc0f69` | 79 |
| `fsi_4_document_structure_staged_apply` | 6,451 | `5481a1bbbc516140ee7717b65c0eed3adf75353b77d39aa96a32513a4a2ead35` | 80 |

Staged artifacts (inert data, insert-checked against these literals): the four sources at merged `27f48f7f`
(23,305 / 50,518 / 67,716 / 62,060 bytes), their self-checking wrappers rendered from those bytes (24,869 `e008e54c…`,
52,098 `ada364d7…`, 69,274 `fcbba792…`, 63,624 `9025d0be…`), the corrected preflight (6,556 `70f69d9e…`, run inside batch 1
before its wrapper) and postcondition (9,618 `05326ba1…`, run inside batch 4 after its wrapper), both at `56edbf85`.
Each apply also refuses unless the existing sign-off bindings and consumed pack issuances are byte-identical afterwards.

Registration: the forms are pinned in the module (`REGISTERED_TRANSPORT_FORMS`) and `scripts/ci/releaseJournal.mjs`
accepts mirrors of kind `fsi_staged_transport`. Journal tags are added to `RELEASE_JOURNAL` only once the hosted journal
holds them (a registry entry without a mirror is itself a drift error).

Proof `scripts/db-proof/fsIntegrityStagedTransport.mjs` on local PostgreSQL 17 (loopback, disposable): **37/37 PASS** —
wrong predecessor / missing bootstrap / out of order refused with nothing changed; changed byte, added final LF, wrong
kind, duplicate, update, delete, truncate refused; no client role can see the schema; **interrupted application**
(failure injected inside 20261125100000) rolled back schema, staging, events and journal, then the **retry** applied;
**postcondition failure** rolled back batch 4 and its journal row, then applied after the cause was removed; duplicate and
concurrent submissions: exactly one applies; final journal = five registered hashes, ids 76–80; existing sign-off binding
and account preserved. Vitest: 164/164 across the transport, wrapper and migration-authority suites; migration authority OK.
Limits: PostgreSQL 17 locally (hosted is the platform version); the seeded binding is a disposable fixture; no consumed
pack issuance existed to seed (hosted also has 0).

## 2. Recovery — export coverage and restoration (NOT complete recovery on its own)

| Item | Database export | Separate action required |
|---|---|---|
| All tables (accounts' data, companies, licences, payments, uploads metadata, reports, bindings) | Included | — |
| Sign-in accounts incl. password hashes | Included | — |
| Release journal and private release schemas | Included | — |
| Stored files (69 objects: trial balances, packs) and their paths | **Excluded** | Download every bucket from Storage, keeping folder paths |
| Edge Function code | **Excluded** | Recreatable from Git (approved commits); deployed bytes are not retrievable (see 3) |
| Secrets (payment provider keys, email, service credentials) | **Excluded** | Owner keeps a private record; never in Git or chat |
| Sign-in provider settings, auth URLs, email templates | **Excluded** | Owner records current settings |
| Storage bucket settings / policies | Policies are in the database; bucket settings partly | Recorded by the migrations |

Restoration (isolated, never over this project): restore the export into a separate empty database project; upload
the Storage files to the same bucket names and paths; deploy the functions from the approved commit; re-enter secrets
and sign-in provider settings; sign in with an existing account and open one stored trial balance to confirm.
In-place fallback: **More → Database → Manage → Backups** restores the daily snapshot (database only, no point-in-time,
later data lost, schema reverts). Recovery counts as complete only with the export AND the Storage download AND the
owner's secret/settings record.

## 3. Deployed-function verification — UNRESOLVED, separate from recovery

No tool available here downloads a deployed bundle or returns a source-linked attestation; status **NOT VERIFIED**
(no exception approved). An export does not change this.
Proposed method: after deployment, the owner runs `supabase functions download compile-financial-report` and
`seal-reporting-pack` into a scratch folder and `node scripts/release/verifyDeployedClosure.mjs <fn> <folder>` against the
required closures (`745c8170…`, `cdc5416f…`). Partial runtime signal only (not closure proof): every compile receipt is
constrained to compiler digest `49fc0852…`.

## 4. Controlled installation log (2026-10-24, from 11:31 UTC)

- Recovery: owner confirmed the database backup (`tbcommand_261024.backup`) and the Storage archive
  (`storage_export_20261024.zip`, SHA-256 `171ba970…7bdea`, 70 files + manifest) are downloaded and kept privately.
- `verifyDeployedClosure.mjs` now registers `compile-financial-report` with its full closure `745c8170…db59` (distinct from
  the compiler digest `49fc0852…`, which classifies as UNKNOWN). Tests: 12/12 (exact bundle REQUIRED; one changed byte in
  each of its four files UNKNOWN).
- Live predecessor rechecked: journal id 75 `870c3ea2…62857`; transport schema absent; kill switch true; 2 bindings
  (digest md5 `b24555d2…`), 0 consumed issuances.
- Deployed `compile-financial-report` and `seal-reporting-pack`. The deploy tool reported its own submitted-source hashes
  (`2555f921…`, `07576f96…`; a different scheme from the closure digest). **Deployed-source verification: PENDING — not
  performed** (no bundle download available here).
- Applied bootstrap through the canonical migrator: hosted id 76, SHA-256 `8001cf3e…e4c8`, mirror
  `drizzle/migrations/0075_fs_integrity_staged_transport.sql` byte-identical to the approved form; registered in
  `RELEASE_JOURNAL`; migration authority OK (four reporting migrations still PENDING_HOSTED_APPLY). After: no client role
  can use the schema; bindings and issuances unchanged; kill switch true.
- **STOPPED before batch 1:** the ten artifacts in `release/staged-transport-fsi/stage/` (431,558 bytes) are not staged
  (0 rows). Staging needs a privileged database session that can submit each file's exact bytes; none is available to the
  agent (sandbox session is read-only; the query tools take retyped text). Each insert refuses any byte difference.

### 4.1 Batches applied (2026-10-24, 11:40–11:45 UTC)

- Staging (by the owner's Codex session, 11:39:25 UTC, role postgres): independently rechecked — 10 artifacts, each
  stored byte count and SHA-256 recomputed from the body and equal to the approved constants in the batch files; all
  unconsumed; journal head id 76 `8001cf3e…e4c8`; kill switch true; 2 publication bindings (latest 2026-10-09), 0 consumed
  issuances.
- Applied through the canonical migrator, each mirror byte-identical to its approved batch file:
  - id 77 `21325cb1…b018` fsi-1 (20261123100000 server compilation, with corrected preflight)
  - id 78 `dc467960…76d3` fsi-2 (20261124100000 publication integrity gate)
  - id 79 `b592d692…0f69` fsi-3 (20261125100000 FINAL authority). Backfill: one ESTABLISHED authority for the acceptance
    company, FY2025, report v6 (the existing FINAL); no conflict.
  - id 80 `5481a1bb…ad35` fsi-4 (20261126100000 document structure, with the staged postcondition executed in-transaction)
- Preservation: every batch's in-transaction baseline of bindings + issued packs is the same value
  (`26a5fb3f…7c57`) before and after; bindings still 2 (unchanged digest), issued packs 0; all 10 artifacts consumed.
- Registered 0076–0079 in `RELEASE_JOURNAL`; migration authority OK, nothing pending; 23/23 focused tests.
- Kill switch true; rollout unchanged (only the acceptance company); frontend not published.
- Deployed-source verification: still PENDING — not performed.
