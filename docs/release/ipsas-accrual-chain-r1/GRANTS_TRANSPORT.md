# IPSAS grants and revenue — exact-byte staged installation transport (candidate)

Status: **authored and proven on a disposable database; NOT installed, NOT registered as hosted history.** Like the preparation transport (`TRANSPORT.md`) it adds no Drizzle mirror, journal entry or `RELEASE_JOURNAL` registration — those come only after canonical hosted execution. `src/lib/__tests__/ipsasGrantsStagedTransport.test.ts` fails if any appears early. It is a **separate dependent slice**: the preparation transport's bytes are untouched (the test pins its registered hashes).

Why a transport: `20261208100000_ipsas_grants.sql` is 30,002 bytes — large enough that the hosted migrator may not load it directly (`AGENTS.md`: SQL too large for the hosted migrator is staged byte-verified as inert data in a private schema and executed by a small registered migration). Why a second schema rather than extending the first: the preparation bootstrap's guard approves exactly its own artifact list; changing it would re-render a reviewed, pinned candidate.

## Identities

| Item | Value |
|---|---|
| Source | `supabase/migrations/20261208100000_ipsas_grants.sql`, 30,002 bytes, SHA-256 `d1ddcb3bbe26f0953806f7fff369c0ffc3e8350b47fcecbf0efb37e150fbd5fd`, introduced by commit `a37cb74e85bb715fc1bad5ef9c09445aaa17d727` |
| Required journal head | hosted id **93**, `0092_ipsas_1_preparation_staged_apply`, SHA-256 `a740359da5386b3773cdb6894786b91df1032fd0672aa6b725f29abff65c3bd5` (or its final-LF form) — i.e. the **IPSAS preparation transport must already be installed** (which itself requires the equipment-r1 transport, id 91) |
| Bootstrap (becomes hosted id 94, tag `0093_ipsas_grants_staged_transport`) | `release/staged-transport-ipsas-grants/00_ipsas_grants_staged_transport.sql`, 7,669 bytes, `9571610f3cbb5f840506a19a17cc07dbfd94a2617ecf002ddd1c04012f1cf792` |
| Apply (becomes hosted id 95, tag `0094_ipsas_2_grants_staged_apply`) | `release/staged-transport-ipsas-grants/10_ipsas_2_grants_staged_apply.sql`, 13,731 bytes, `1e12a057aa8327f2c1a19624376e26e76dd5cedda9a13265c23ce01446559569` |
| Stage (inert data) | `release/staged-transport-ipsas-grants/stage/1_ipsas-2-grants.source.sql` |
| Private schema | `cfoclose_ipsas_grants_release` (own lock key `cfoclose_ipsas_grants_release_transport`, own error codes `IPSAS_GRANTS_TRANSPORT_*`; the preparation and equipment schemas are untouched) |

If the hosted journal head is anything else when the owner is ready, the bootstrap refuses (`IPSAS_GRANTS_TRANSPORT_WRONG_PREDECESSOR`) and **nothing changes**. The remedy is to re-run the generator against the new head, review and re-prove — never to edit applied history. The journal tags `0093`/`0094` are the next numbers *if* hosted history is exactly as assumed; they are registered only after execution.

## What the apply checks inside one statement (any failure rolls back everything, consumption included)
1. Transport lock; journal locked; head is exactly the approved predecessor (id 93), and no uncommitted foreign journal row.
2. **Prerequisites present** (`IPSAS_GRANTS_TRANSPORT_PREREQUISITE_MISSING`): `companies`, `tb_certifications`, `fiscal_periods`, `trial_balance_uploads`, **`ipsas_prep_revisions`, `ipsas_confirmations`**, and the helpers the grants reuse: `_ipsas_immutable`, `_ipsas_minor`, `_ipsas_nat`, `_ipsas_enough`, `_ipsas_arr`, `_ipsas_refusal`, `_cr_certified_accounts`, `_cr_member`, `ipsas_prep_context`.
3. Own staged row exists, unconsumed, byte count and SHA-256 **recomputed from the body**, target not already installed.
4. Preserved perimeter locked `SHARE` and hashed: the shared reporting/commercial/assistant/rollout/issuance tables, the equipment tables **and the IPSAS preparation history** (`ipsas_prep_revisions`, `ipsas_confirmations`).
5. Exact source executed; target objects exist.
6. **Privilege postconditions**: RLS on both new tables; `anon`, `authenticated`, `service_role` hold no table privilege; none can execute any `_ipsas_*` helper (this also re-checks the preparation helpers); only `authenticated` can execute the three grants RPCs.
7. Perimeter hash unchanged; row consumed; `applied` event recorded.

## Ordered installation (only after owner authorisation; nothing here is done by this PR)
1. Re-read the hosted journal. Confirm head = id 93 / the hash above, and that neither the schema `cfoclose_ipsas_grants_release` nor `public.ipsas_grant_revisions` exists. Snapshot the preserved tables and settings.
2. `node scripts/release/ipsasGrantsStagedTransport.mjs --check` (must print OK, 3 files).
3. Apply `00_…` through the native migrator → expect journal **94**. Verify the recorded bytes equal the registered form.
4. Load `stage/1_ipsas-2-grants.source.sql` as **inert data** (an `INSERT`; the trigger recomputes length and digest and rejects any altered body). Never submit the migration source as executable SQL.
5. Apply `10_…` through the native migrator → expect journal **95**.
6. Verify: both `ipsas_grant_*` tables empty; the three RPCs executable by `authenticated` only; helpers by none; staged row consumed; one `applied` event; preserved-table hashes (including the preparation history) unchanged.
7. Only then register the two mirrors in Drizzle and `RELEASE_JOURNAL`, run the generator check, migration-authority and release-journal checks, and record the final SHA. Frontend publication, setting any company to `ipsas_accrual`, and the rollout allow-list are separate authorisations. An unknown installation response requires reading journal/schema/staging state; never blindly retry.

## Evidence
- `scripts/db-proof/ipsasGrantsTransport.mjs` + manifest (**23 cases**, structured result validated against the manifest) on the real predecessor chain (the IPSAS preparation migration applied directly), embedded PostgreSQL 16: wrong id/hash, final-LF predecessor form, private rights incl. service role and sequences, missing/altered/unknown stage, inertness, immutable evidence, metadata-tamper rehash, **missing prerequisite**, **IPSAS preparation helper missing**, unrelated journal head, late failure, **hostile DDL hook changing a preserved setting**, **hostile hook widening a privilege**, two concurrent installers (exactly one wins), duplicate refusal, authority matrix and framework gate, and preservation — with **existing IPSAS preparation revisions and confirmations seeded before the baseline and shown byte-identical after**.
- **Transport = direct application.** The proof executes the migration directly inside a transaction that is rolled back, digests everything it creates (76 catalogue facts: columns, defaults, identity, constraints, indexes, triggers, RLS, ACLs, nine functions with their definitions), then installs through the transport and requires the identical digest. This is stronger than the preparation transport's proof, which does not compare catalogues.
- `src/lib/__tests__/ipsasGrantsStagedTransport.test.ts`: pinned bytes/predecessor, committed files equal rendering, separation from the preparation transport (its files still hash to its registered forms), ordering of checks, preserved perimeter incl. preparation history, mirror strictness, "nothing claimed as applied".

## Finding recorded by the equivalence proof (observed; cause inferred)
A first version of the equivalence check read different stored defaults: the migration executed in the proof's long-lived admin session (whose search_path earlier migrations had set) stored `DEFAULT public.gen_random_uuid()` for both tables' `id` columns, while the transport's installation in a default pooled session stored `gen_random_uuid()` (the same function name resolving differently). The inferred cause is that an unqualified name in the migration text binds through the **search_path of the executing session**; that was not separately proven. It is a property of the migration text (and of the preparation migration), not of the transport. The proof therefore pins the reference run and the installation to the same kind of fresh session and reads both under one explicit search_path, so only stored differences can show. If the hosted migrator's session path differs from a default one, the stored default may take the other form; both are functionally equivalent, but a future migration should qualify the name if that matters.

## Not done
Hosted verification; installation; deployed-source attestation; the authenticated page has not been driven against an installed database.
