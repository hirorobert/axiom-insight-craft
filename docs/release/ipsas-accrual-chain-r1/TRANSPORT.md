# IPSAS accrual preparation — exact-byte staged installation transport (candidate)

Status: **authored and proven on a disposable database; NOT installed, NOT registered as hosted history.** No Drizzle mirror, journal entry or `RELEASE_JOURNAL` registration exists for it, on purpose: those are registered only after canonical hosted execution (equipment-r1 precedent, `docs/release/equipment-transport-r1/RECORD.md`). `src/lib/__tests__/ipsasStagedTransport.test.ts` fails if any appears early.

Why a transport: the source migration `20261207100000_ipsas_accrual_preparation.sql` is 48,766 bytes, comparable to the equipment migration (54,129 bytes) that the hosted migrator could not load directly (`AGENTS.md`: SQL too large for the hosted migrator is staged byte-verified as inert data in a private schema and executed by a small registered migration).

## Identities

| Item | Value |
|---|---|
| Source | `supabase/migrations/20261207100000_ipsas_accrual_preparation.sql`, 48,766 bytes, SHA-256 `1bc89935c89fd44f6b2e8e8a03b802cbc03ec1afa4b0dbcfff2b5a9f538562d4`, introduced by commit `88b4897b036baa2021444991e8f5ed510b0926b7` |
| Required journal head | hosted id **91**, `0090_eqp_2_multiclass_staged_apply`, SHA-256 `ed1ceb09ff9d1bd85a022e38cff680ed725855df4898061cc97d6830763a3644` (or its final-LF form `977f5671…e63c`) — i.e. the equipment-r1 transport **must already be installed** |
| Bootstrap (becomes hosted id 92) | `release/staged-transport-ipsas/00_ipsas_staged_transport.sql`, 7,369 bytes, `0e7c3807b7c06b2906154bcffb816b03d67fa145cc755eacc3a70358c9cba6c8` |
| Apply (becomes hosted id 93) | `release/staged-transport-ipsas/10_ipsas_1_preparation_staged_apply.sql`, 13,006 bytes, `a740359da5386b3773cdb6894786b91df1032fd0672aa6b725f29abff65c3bd5` |
| Stage (inert data) | `release/staged-transport-ipsas/stage/1_ipsas-1-preparation.source.sql` |
| Private schema | `cfoclose_ipsas_release` (own lock key, own error codes; the equipment schema is untouched) |

If the hosted journal head is anything else when the owner is ready, the bootstrap refuses (`IPSAS_TRANSPORT_WRONG_PREDECESSOR`) and **nothing changes**. The remedy is to re-run the generator against the new head, review and re-prove — never to edit applied history. The generator's `SOURCE_COMMIT` falls back to the working-tree bytes under the same byte count and SHA-256 if that commit becomes unreachable (squash merge); re-pinning the commit changes no rendered form.

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
- `scripts/db-proof/ipsasTransport.mjs` + manifest (21 cases) on the real pre-migration chain, embedded PostgreSQL 16: wrong id/hash, final-LF predecessor form, private rights incl. service role and sequences, missing/altered/unknown stage, inertness, immutable evidence, metadata-tamper rehash, **missing prerequisite**, unrelated journal head, late failure, **hostile DDL hook changing a preserved setting**, **hostile hook widening a privilege**, two concurrent installers (exactly one wins), duplicate refusal, post-install authority matrix and framework gate, preservation. 21/21, structured result valid against the manifest.
- `src/lib/__tests__/ipsasStagedTransport.test.ts`: pinned bytes/predecessor, committed files equal rendering, ordering of checks, preserved perimeter, mirror strictness, "nothing claimed as applied".
- Not done: hosted verification; installation; deployed-source attestation; the authenticated page has not been driven against an installed database.
