# IPSAS accrual preparation — exact-byte staged installation transport (candidate)

Status: **authored and proven on a disposable database; NOT installed, NOT registered as hosted history.** No Drizzle mirror, journal entry or `RELEASE_JOURNAL` registration exists for it, on purpose: those are registered only after canonical hosted execution (equipment-r1 precedent, `docs/release/equipment-transport-r1/RECORD.md`). `src/lib/__tests__/ipsasStagedTransport.test.ts` fails if any appears early.

Why a transport: the source migration `20261207100000_ipsas_accrual_preparation.sql` is 51,496 bytes, comparable to the equipment migration (54,129 bytes) that the hosted migrator could not load directly (`AGENTS.md`: SQL too large for the hosted migrator is staged byte-verified as inert data in a private schema and executed by a small registered migration).

## Identities

| Item | Value |
|---|---|
| Source | `supabase/migrations/20261207100000_ipsas_accrual_preparation.sql`, 51,496 bytes, SHA-256 `3fb7460f4b5ff45623e8876a522394ce4eef67da32705b80dbe46caaf44d21b7`, introduced by commit `e0a3d4856a871e94f1ddddcc2576ed2d61f1fc90` (it adds `_ipsas_authorize_mutation`, the authority re-check at the mutation boundary - see `AUTHORITY_ORDERING.md`; the previously reviewed bytes were 48,766 B `1bc89935…562d4`, never applied) |
| Required journal head | hosted id **91**, `0090_eqp_2_multiclass_staged_apply`, SHA-256 `ed1ceb09ff9d1bd85a022e38cff680ed725855df4898061cc97d6830763a3644` (or its final-LF form `977f5671…e63c`) — i.e. the equipment-r1 transport must already be installed. **It is recorded as installed** (see "Recorded predecessor state" below); that is the repository's record, not a fresh verification |
| Bootstrap (becomes hosted id 92) | `release/staged-transport-ipsas/00_ipsas_staged_transport.sql`, 7,369 bytes, `b774ac26cd7476babd885985af825eb247e1b0004a29afef871b7e05900a1bbd` |
| Apply (becomes hosted id 93) | `release/staged-transport-ipsas/10_ipsas_1_preparation_staged_apply.sql`, 13,461 bytes, `e578516cc0a7068ed0efdfe815500b60a238d778454d816449e3bd009498afb8` |
| Stage (inert data) | `release/staged-transport-ipsas/stage/1_ipsas-1-preparation.source.sql` |
| Private schema | `cfoclose_ipsas_release` (own lock key, own error codes; the equipment schema is untouched) |

If the hosted journal head is anything else when the owner is ready, the bootstrap refuses (`IPSAS_TRANSPORT_WRONG_PREDECESSOR`) and **nothing changes**. The remedy is to re-run the generator against the new head, review and re-prove — never to edit applied history. The generator's `SOURCE_COMMIT` falls back to the working-tree bytes under the same byte count and SHA-256 if that commit becomes unreachable (squash merge); re-pinning the commit changes no rendered form.

## Recorded predecessor state (equipment-r1) - reconciled, not assumed
The repository records the equipment staged transport as **installed on 2026-10-28** by an owner-authorized installation from merged PR #213 (`docs/release/equipment-transport-r1/RECORD.md`): hosted journal ids **89** (`0088_equipment_staged_transport`, 7,393 B), **90** (`0089_eqp_1_preparation_staged_apply`, 9,348 B) and **91** (`0090_eqp_2_multiclass_staged_apply`, 9,755 B, SHA-256 `ed1ceb09…3644`), with the mirrors registered in `drizzle/migrations/meta/_journal.json` (tags 0088-0090 are the last entries on `main`) and `RELEASE_JOURNAL`. So:
- **Do not repeat or re-apply any equipment migration.** Neither equipment migration is a prerequisite *to apply*; they are a prerequisite *already recorded as satisfied*, and this transport's bootstrap simply requires that the hosted head be exactly id 91 with that hash.
- **Recorded installation is not fresh verification.** No hosted access exists in this work. At installation time the journal head must be read again; it may legitimately have moved (for example, other releases) - in which case the bootstrap refuses and the remedy is to regenerate against the new head, review and re-prove, never to edit applied history.
- The IPSAS source also depends on objects the equipment migration created (`fs_equipment_answers`, `_fs_equipment_depreciation_charge`, `_fs_equipment_rational`); the apply's prerequisite check refuses if any is absent, which is the live test of that record.

## search_path / default binding (resolved in this revision)
The source has unqualified names (`DEFAULT gen_random_uuid()`). Reproduced under controlled variations (`scripts/db-proof/ipsasSearchPathBinding.mjs`, on the #223 branch): with a session `search_path` that lists `public` ahead of `pg_catalog` and a `public.gen_random_uuid()` present (pgcrypto in `public` in the proof database), the default binds to that public function; otherwise to the core one. This revision's apply pins `pg_catalog, public` for the execution of the source only and restores it immediately (transaction-local, so also reverted on failure). **The search_path pin changed only the generated apply** (13,006 -> 13,461 B); the authority re-check later changed the authored source (see `AUTHORITY_ORDERING.md`) and the generated forms were regenerated. Two new proof cases: an unpinned direct run under `public, pg_catalog` is shown to bind the public function (control) and to differ; the apply under five session paths binds the core function and yields the same catalogue as the default-session reference; and the installed catalogue equals the migration executed directly. Nothing hosted is affected: no revision of this file has been applied anywhere.

## What the apply checks inside one statement (any failure rolls back everything, consumption included)
1. Transport lock; journal locked; head is exactly the approved predecessor, and no uncommitted foreign journal row.
2. **Prerequisites present** (`IPSAS_TRANSPORT_PREREQUISITE_MISSING`): `companies`, `firm_members`, `tb_certifications`, `financial_statement_documents`, `fs_equipment_answers`; `_fs_equipment_depreciation_charge`, `_fs_equipment_rational`, `_cr_certified_accounts`, `_cr_member`, `fs_rollout_allows`, `workspace_capability_allowed`.
3. Own staged row exists, unconsumed, byte count and SHA-256 **recomputed from the body**, target not already installed.
4. Preserved perimeter locked `SHARE` and hashed: the shared reporting/commercial/assistant/rollout/issuance tables plus the three equipment tables.
5. Exact source executed; target objects exist.
6. **Privilege postconditions** (`IPSAS_TRANSPORT_PRIVILEGE_POSTCONDITION`): RLS on both tables; `anon`, `authenticated`, `service_role` hold no table privilege; none can execute any `_ipsas_*` helper; only `authenticated` can execute the three RPCs.
7. Perimeter hash unchanged; row consumed; `applied` event recorded.

## Ordered installation (only after owner authorisation; nothing here is done by this PR)
1. Re-read the hosted journal. Confirm head = id 91 / the hash above, and that neither the schema `cfoclose_ipsas_release` nor `public.ipsas_prep_revisions` exists. If state differs, reconcile; do not repeat. Snapshot the preserved tables and settings.
2. Run `node scripts/release/ipsasStagedTransport.mjs --check` (must print OK, 3 files).
3. Apply `00_ipsas_staged_transport.sql` through the native migrator → expect journal **92**. Verify the recorded bytes equal the registered form (only the migrator's single final LF is accepted as an alternative).
4. Load `stage/1_ipsas-1-preparation.source.sql` as **inert data** (it is an `INSERT`; the trigger recomputes length and digest and rejects any altered body). Never submit the migration source as executable SQL.
5. Apply `10_ipsas_1_preparation_staged_apply.sql` through the native migrator → expect journal **93**.
6. Verify: both `ipsas_*` tables empty; the three RPCs executable by `authenticated` only; helpers by none; staged row consumed; one `applied` event; preserved-table hashes unchanged.
7. Only then register the two actual mirrors in Drizzle and `RELEASE_JOURNAL` (a new kind modelled on `equipment_staged_transport`), run the generator check, migration-authority and release-journal checks, and record the final SHA. Frontend publication, setting any company to `ipsas_accrual`, and the rollout allow-list are separate authorisations. An unknown installation response requires reading journal/schema/staging state; never blindly retry.

## Evidence
- `scripts/db-proof/ipsasTransport.mjs` + manifest (**23 cases**: the original 21 plus binding-independence and installed-equals-direct) on the real pre-migration chain, embedded PostgreSQL 16: wrong id/hash, final-LF predecessor form, private rights incl. service role and sequences, missing/altered/unknown stage, inertness, immutable evidence, metadata-tamper rehash, **missing prerequisite**, unrelated journal head, late failure, **hostile DDL hook changing a preserved setting**, **hostile hook widening a privilege**, two concurrent installers (exactly one wins), duplicate refusal, post-install authority matrix and framework gate, preservation. 23/23, structured result valid against the manifest.
- `src/lib/__tests__/ipsasStagedTransport.test.ts`: pinned bytes/predecessor, committed files equal rendering, ordering of checks, preserved perimeter, mirror strictness, "nothing claimed as applied".
- Not done: hosted verification; installation; deployed-source attestation; the authenticated page has not been driven against an installed database.
