> Historical candidate evidence. The independent review confirmed further defects in the #227/#228 chain. Unapplied PPE/grants source and all three transport fingerprints below are superseded by [the independent review](../ipsas-independent-review/REPORT.md). Existing CI evidence applies to its named commits; it does not validate the repairs. Nothing has been installed or published by this review.

# IPSAS grants and revenue — exact-byte staged installation transport (candidate)

Status: **authored and proven on a disposable database; NOT installed, NOT registered as hosted history.** Like the preparation transport (`TRANSPORT.md`) it adds no Drizzle mirror, journal entry or `RELEASE_JOURNAL` registration — those come only after canonical hosted execution. `src/lib/__tests__/ipsasGrantsStagedTransport.test.ts` fails if any appears early. It is a **separate dependent slice**; this PR does not edit the preparation transport (its revision that pins `search_path` lives in #218 and is carried here by merge; the test pins its registered hashes).

Why a transport: `20261208100000_ipsas_grants.sql` is 30,564 bytes — large enough that the hosted migrator may not load it directly (`AGENTS.md`: SQL too large for the hosted migrator is staged byte-verified as inert data in a private schema and executed by a small registered migration). Why a second schema rather than extending the first: the preparation bootstrap's guard approves exactly its own artifact list; changing it would re-render a reviewed, pinned candidate.

## Identities

| Item | Value |
|---|---|
| Source | `supabase/migrations/20261208100000_ipsas_grants.sql`, 30,564 bytes, SHA-256 `012ac1bba2bdc1a2b2a41d81ed4d4a24716680486c3b8709d1297b678c8db3bf`, introduced by commit `e0a3d4856a871e94f1ddddcc2576ed2d61f1fc90` (its save and confirm functions call `_ipsas_authorize_mutation`; the earlier 30,002 B `d1ddcb3b…` revision was never applied) |
| Required journal head | hosted id **93**, `0092_ipsas_1_preparation_staged_apply`, SHA-256 `e578516cc0a7068ed0efdfe815500b60a238d778454d816449e3bd009498afb8` (or its final-LF form) — i.e. the **IPSAS preparation transport must already be installed** (which itself requires the equipment-r1 transport, id 91) |
| Bootstrap (becomes hosted id 94, tag `0093_ipsas_grants_staged_transport`) | `release/staged-transport-ipsas-grants/00_ipsas_grants_staged_transport.sql`, 7,669 bytes, `4b68241a0d3064d16047de8c3f623c35e815e7e2852aff63f7d61d755c00e16b` |
| Apply (becomes hosted id 95, tag `0094_ipsas_2_grants_staged_apply`) | `release/staged-transport-ipsas-grants/10_ipsas_2_grants_staged_apply.sql`, 14,238 bytes, `4182251a069cd11b9707bb017a99233241cccf436c6f453b8b1df3adba8d60e8` |
| Stage (inert data) | `release/staged-transport-ipsas-grants/stage/1_ipsas-2-grants.source.sql` |
| Private schema | `cfoclose_ipsas_grants_release` (own lock key `cfoclose_ipsas_grants_release_transport`, own error codes `IPSAS_GRANTS_TRANSPORT_*`; the preparation and equipment schemas are untouched) |

If the hosted journal head is anything else when the owner is ready, the bootstrap refuses (`IPSAS_GRANTS_TRANSPORT_WRONG_PREDECESSOR`) and **nothing changes**. The remedy is to re-run the generator against the new head, review and re-prove — never to edit applied history. The journal tags `0093`/`0094` are the next numbers *if* hosted history is exactly as assumed; they are registered only after execution.

## Recorded predecessor state - reconciled, not assumed
- **Equipment-r1: recorded as installed** (2026-10-28, owner-authorized, merged PR #213; hosted journal ids 89, 90, 91 = tags `0088`-`0090`, registered in `drizzle/migrations/meta/_journal.json` and `RELEASE_JOURNAL`; `docs/release/equipment-transport-r1/RECORD.md`). It must not be repeated.
- **IPSAS preparation transport (#218): NOT installed.** This transport therefore needs it first: bootstrap id 92, apply id 93, then this transport's ids 94 and 95. The grants bootstrap refuses unless the hosted head is exactly id 93 with the preparation apply's registered hash.
- **A recorded installation is not a fresh verification.** No hosted access exists here; before any step, re-read the hosted journal. If it has moved, regenerate against the new head and re-prove; never edit applied history.

## What the apply checks inside one statement (any failure rolls back everything, consumption included)
1. Transport lock; journal locked; head is exactly the approved predecessor (id 93), and no uncommitted foreign journal row.
2. **Prerequisites present** (`IPSAS_GRANTS_TRANSPORT_PREREQUISITE_MISSING`): `companies`, `tb_certifications`, `fiscal_periods`, `trial_balance_uploads`, **`ipsas_prep_revisions`, `ipsas_confirmations`**, and the helpers the grants reuse: `_ipsas_immutable`, `_ipsas_minor`, `_ipsas_nat`, `_ipsas_enough`, `_ipsas_arr`, `_ipsas_refusal`, `_ipsas_authorize_mutation`, `_cr_certified_accounts`, `_cr_member`, `ipsas_prep_context`.
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
- `scripts/db-proof/ipsasGrantsTransport.mjs` + manifest (**24 cases**, structured result validated against the manifest) on the real predecessor chain (the IPSAS preparation migration applied directly), embedded PostgreSQL 16: wrong id/hash, final-LF predecessor form, private rights incl. service role and sequences, missing/altered/unknown stage, inertness, immutable evidence, metadata-tamper rehash, **missing prerequisite**, **IPSAS preparation helper missing**, unrelated journal head, late failure, **hostile DDL hook changing a preserved setting**, **hostile hook widening a privilege**, two concurrent installers (exactly one wins), duplicate refusal, authority matrix and framework gate, and preservation — with **existing IPSAS preparation revisions and confirmations seeded before the baseline and shown byte-identical after**.
- **Transport = direct application.** The proof executes the migration directly inside a transaction that is rolled back, digests everything it creates (76 catalogue facts: columns, defaults, identity, constraints, indexes, triggers, RLS, ACLs, nine functions with their definitions), then installs through the transport and requires the identical digest (the digest now includes which function each `id` default is bound to). This is stronger than the preparation transport's proof, which does not compare catalogues.
- `src/lib/__tests__/ipsasGrantsStagedTransport.test.ts`: pinned bytes/predecessor, committed files equal rendering, separation from the preparation transport (its files still hash to its registered forms), ordering of checks, preserved perimeter incl. preparation history, mirror strictness, "nothing claimed as applied".

## search_path / default-binding: reproduced, and resolved in this transport (still open for the preparation transport)
**Concern.** `DEFAULT gen_random_uuid()` is unqualified in the migration (as it is in 188 other places in the repository's migrations; none are qualified). Unqualified names bind through the **executing session's search_path**.

**Reproduction** (`scripts/db-proof/ipsasSearchPathBinding.mjs`: the exact source run in a rolled-back transaction per variant, binding read from `pg_depend`, not from text; embedded PostgreSQL 16 on the real chain, where `pgcrypto` is installed in `public` and therefore provides `public.gen_random_uuid()`):

| Session search_path | `public.gen_random_uuid()` present | Default binds to |
|---|---|---|
| `"$user", public` (default) | yes (pgcrypto) | core `pg_catalog` |
| `pg_catalog, public` | yes | core `pg_catalog` |
| `public` (pg_catalog implicit first) | yes | core `pg_catalog` |
| `extensions, public` | yes | core `pg_catalog` |
| **`public, pg_catalog`** | yes | **`public.gen_random_uuid` (the pgcrypto function)** |

(The script also has variants that create a `public.gen_random_uuid()` first; in this database one already existed through pgcrypto, so those variants were repeats of the rows above and add no information here. They would matter only on a database without one.)

So the ambiguity is **real but narrow**: it appears only when a session lists `public` *ahead of* `pg_catalog` **and** a `public.gen_random_uuid()` exists. Both functions return a random v4 UUID, so behaviour is the same; the differences are (1) a default bound to an extension function makes `DROP EXTENSION pgcrypto` fail or cascade into the column defaults, and (2) anyone able to create objects in `public` could substitute their own function under such a path. This environment's `public`-resident pgcrypto is a test-database fact; whether the hosted project has a `public.gen_random_uuid()` (Supabase normally installs pgcrypto in `extensions`) and what its migrator's session path is are **unknown from this repository**.

**Resolution here.** The apply now sets `search_path` to `pg_catalog, public` for the execution of the source only and restores it immediately after (transaction-local, so it also reverts on any failure). The source bytes are untouched. New proof case `apply.binding-independent-of-session-search-path`: a **control** shows an unpinned direct run under `public, pg_catalog` binds the public function and yields a different catalogue digest; the transport's apply, run under five different session paths, binds the core function and yields the digest of the default-session reference every time.

**The same fix is now in the preparation transport (#218, commit `6040c8c`)**, with its own proof cases; that apply's registered form changed accordingly (13,006 -> 13,461 B, `cd9969ed…c1a44` - since superseded by the regeneration for the authority re-check, see the identities above), which is why this transport's predecessor hashes, bootstrap and apply were regenerated (the identities above are the current ones). Both are uninstalled candidates, so no applied history is touched. The 188 historical unqualified defaults in older migrations are already in whatever state the hosted database has, and whether hosted has a `public.gen_random_uuid()` is unknown from this repository.

## Not done
Hosted verification; installation; deployed-source attestation; the authenticated page has not been driven against an installed database.
