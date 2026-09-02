# Ω∞ Migration Identity Reconciliation

This document tracks every case in this project where Lovable's live execution identity for a migration diverged from the repository's reviewed, canonical authoring identity. Phase 2A was the first case (below); Phase 0A is the second (see that section further down). Each case is reconciled independently under Model B — the earlier-timestamped, reviewed file stays the sole executable replay authority; Lovable's generated capture becomes a permanent, inert, comment-only historical marker.

## Project

`bvyivmmfjejbmqoydezk` (the live AXIOM/SAFF ERP Supabase project, per `.env`'s `VITE_SUPABASE_URL`).

## Canonical reviewed migration

`supabase/migrations/20260816120000_account_review_authority.sql`
SHA-256: `c588462dfa82718488fc6ea02236d6efcc40f83c94f87e60bad1426b1c6ec8d5`

This is the migration actually authored and taken through this project's Phase 2A design gates: canonical account-identity proof, non-reporting drift guard, per-account concurrency serialization design, `SECURITY DEFINER` `search_path` review, RLS model, idempotency algorithm. It is the sole intended executable Phase 2A creation authority going forward.

## Lovable historical execution identity

`20260818040518` — the version identity Lovable's own tooling generated and recorded as applied on `bvyivmmfjejbmqoydezk` on 2026-08-18.

Original generated artifact SHA-256 (as committed at `06c4b3d593024da2ac1d2e07f864acc1ee2803b1`, still retrievable from that commit's tree): `84bc842bb52701679d3fa196fe5ba2532a3934974064004e9271d8d1aa02c774`

## Live forensic evidence (state as last observed, relayed via Lovable)

- `20260816120000` — **absent** from live migration history
- `20260818040518` — **present**, recorded applied
- `20260818040518`'s recorded `statements` payload — one 22,228-character Phase 2A SQL body
- Phase 2A schema objects (`account_review_batches`, `account_review_decisions`, `account_review_decisions_seq`, `resolve_account_review_batch`, `get_effective_non_reporting_status`, associated RLS policies and the immutability trigger) — confirmed to exist exactly once on the live project

This environment has no authenticated access to `bvyivmmfjejbmqoydezk` and cannot independently re-run this query; the state above is as relayed and cross-checked against the regenerated `src/integrations/supabase/types.ts` (which does contain all four new objects, corroborating that the migration genuinely executed live).

## What happened and why

Lovable applied equivalent executable SQL under its own generated timestamp (`20260818040518`) rather than under the timestamp of the file actually authored and reviewed in this repository (`20260816120000`). A direct diff of the two files' content proved they are executable-SQL-identical — the only difference is a trailing rollback-comment block (ten lines, all `-- DROP ...` comments) and a missing final newline in Lovable's captured version, both non-executing. The hash difference between the two files is fully explained by that difference; no Phase 2A object, policy, grant, or function body differs between what was authored and what actually ran.

Because `20260816120000` sorts before `20260818040518` by timestamp, leaving both files fully executable would break deterministic replay: a fresh clone, CI run, or disaster-recovery rebuild would execute `20260816120000` first (creating every Phase 2A object), then fail when `20260818040518`'s duplicate `CREATE TABLE`/`CREATE FUNCTION` statements hit already-existing objects.

Five reconciliation models were evaluated (keep both unchanged and repair history only; keep the authored file canonical and mark the generated one inert; keep the generated file canonical and mark the authored one inert; delete one file with provenance recorded elsewhere; or some other approach). **Model B** was selected: `20260816120000` remains the sole executable creation authority; `20260818040518` becomes a permanent, comment-only audit marker. This was chosen over the mirror-image option (keeping Lovable's generated file executable instead) because `20260816120000` is the artifact whose SHA-256 has been independently verified across every Phase 2A gate in this project's history, whose SQL was the one actually security-reviewed, and whose filename is meaningful rather than an opaque generated UUID suffix.

This repository change does **not** alter what historically executed against the live database — Postgres already ran the DDL once, under version `20260818040518`, and that historical execution event and its tracking-table row are unaffected by what the repository file for that version now contains. The repository file's role from this point forward concerns future replays only (fresh installs, CI, DR), not a redescription of the past.

**Live history still requires a separate, metadata-only reconciliation**: `supabase migration repair --status applied 20260816120000` against `bvyivmmfjejbmqoydezk`, so that a future `supabase db push` against that same project does not attempt to (re-)run `20260816120000` either. Per Supabase's own documentation, `migration repair` updates the history tracking record only and does not execute any migration SQL — it is not a re-application of the DDL. **This live repair has not been performed.** This environment has no authenticated access to the target project; it can only be performed by someone/something (Lovable, or a CLI session) that does.

## Open defects (unchanged by this reconciliation)

- `DEFECT-MIGRATION-HISTORY-DIVERGENCE-001` — open. This reconciliation resolves the specific Phase 2A duplicate; the project's wider historical migration divergence (local vs. live migration counts) is a separate, broader problem not addressed here.
- `DEFECT-DEFAULT-ACL-AUTHENTICATED-001` — open, untouched.
- `DEFECT-PHASE2A-MIGRATION-REPLAY-001` — **remains open, not closed by this commit.** This commit repairs the *repository representation* of replay determinism only. It cannot be closed until the live history repair above is actually performed and a fresh-replay (or equivalent) proof is obtained against the real project.

## Scope note (Phase 2A section)

Nothing above certifies the wider ~96-file migration history repository-wide. That record is scoped specifically to the Phase 2A duplicate between `20260816120000` and `20260818040518`.

---

# Phase 0A Migration Identity Reconciliation

## Canonical reviewed migration

`supabase/migrations/20260901120000_engine_execution_foundation.sql`
Pre-live (hardened) SHA-256: `acaaf0a49741d9a038682bd0d507088598e728c93b83888816a46e9bcd5b3b29`

Taken through the same design/security review rigor as Phase 2A: canonical identity model, `NULLS NOT DISTINCT` concurrency correction, subquery-free bounded `CHECK` constraints, `SECURITY INVOKER` trigger justification, and independently `deno check`-verified shared modules. This is the sole intended executable Phase 0A creation authority going forward.

## Lovable live execution identity

`20260902052434` — the version identity Lovable's own tooling generated and recorded as applied on `bvyivmmfjejbmqoydezk` on 2026-09-02, at file `supabase/migrations/20260902052434_5756b235-5fad-437e-8753-07a632b8a70a.sql`.

## Executable equivalence proof

Both files' comments and blank lines were stripped and diffed directly: 268/268 non-comment lines identical, zero diff output. The only difference between the two files is comment/header content — Lovable's generated file carries no equivalent of the canonical file's extensive documentation header. No table, column, constraint, index, trigger, function body, or grant statement differs between what was authored and what actually ran.

## What happened and why

Same pattern as Phase 2A, now observed a fourth time in this project (`account_mapping_memory`, Phase 2A, and now Phase 0A): Lovable applies executable SQL under its own generated timestamp rather than the repository's authored one. Because `20260901120000 < 20260902052434`, leaving both executable would break deterministic replay the same way the Phase 2A duplicate would have. **Model B** applied identically: `20260901120000` stays canonical and executable; `20260902052434`'s file is now a comment-only marker (see that file's own header for the full record, mirroring the Phase 2A marker's structure).

## Live ACL defect found during this execution — separate from the identity reconciliation

The live execution exposed a **real defect in the canonical migration's own text**, not a platform quirk: `REVOKE ALL ON public.engine_runs FROM PUBLIC, anon;` (and the equivalent for `idempotency_keys`) never named `authenticated`. This project's `pg_default_acl` already grants `authenticated` broad privileges (`arwdDxtm`) at `CREATE TABLE` time — the pre-existing, still-open `DEFECT-DEFAULT-ACL-AUTHENTICATED-001` — so the migration's subsequent `GRANT SELECT TO authenticated` only *added* SELECT on top of that inherited grant rather than replacing it. RLS still correctly blocked unauthorized rows in practice, but the table-level ACL itself did not satisfy the required defence-in-depth invariant.

**Correction**: `supabase/migrations/20260902110000_phase0a_acl_hardening.sql` — a new, additive, post-execution migration touching only `engine_runs`/`idempotency_keys` grants. Explicitly revokes from `PUBLIC`/`anon`/`authenticated`, then grants `SELECT` to `authenticated` and full authority to `service_role`. Does **not** touch `ALTER DEFAULT PRIVILEGES` — that remains `DEFECT-DEFAULT-ACL-AUTHENTICATED-001`'s separate, future, project-wide remediation, deliberately out of scope here.

## Phase 0A ACL hardening — second reconciliation (applied live)

Repository canonical identity: `20260902110000` (`supabase/migrations/20260902110000_phase0a_acl_hardening.sql`, SHA-256 `096ba34655163fde195b75128147643f9f3452f11b3e3bbea8c47a00206ba4ad`).

Live execution identity: `20260902074804` — Lovable's generated capture at `supabase/migrations/20260902074804_0020dd27-ac04-4b6c-b8e2-6eda1b34a823.sql`, applied to `bvyivmmfjejbmqoydezk`.

Executable equivalence: proven directly, not accepted on Lovable's own claim — both files' comments/blank lines stripped and diffed: 11/11 normalized lines identical (the 10 REVOKE/GRANT statements plus `SET search_path`), zero diff output.

Reconciled under Model B, same as every prior case in this document: `20260902110000` remains the sole executable repository authority; `20260902074804`'s file is now a comment-only historical marker. Note: `20260902074804` sorts numerically *before* `20260902110000`, so on a fresh replay the marker is encountered first — harmless, since it executes nothing; the canonical file is still the only place the grants actually run.

Live post-state certified (as relayed and reconciled): `authenticated` = SELECT only on both tables; `PUBLIC` = none; `anon` = none; `service_role` = full controlled authority. This closes the concrete live ACL gap this section originally recorded as open.

## Open defects (Phase 0A)

- `DEFECT-DEFAULT-ACL-AUTHENTICATED-001` — open, unchanged in scope, now with a second concrete manifestation on record (Phase 0A joins Phase 2A as evidence of the same underlying project-wide default-privilege gap). The *specific instance* of this defect on `engine_runs`/`idempotency_keys` is now fixed live; the project-wide root cause remains unaddressed.
- `DEFECT-MIGRATION-HISTORY-DIVERGENCE-001` — open, unchanged; Phase 0A's identity divergence (now observed twice — foundation and ACL hardening) is additional evidence of the same root pattern, not a new defect.

## Scope note (Phase 0A section)

This record is scoped specifically to the two Phase 0A duplicates (`20260901120000`/`20260902052434` and `20260902110000`/`20260902074804`) and the ACL correction discovered and closed at those executions. It does not certify or attempt to repair the project-wide default-ACL defect itself, and does not certify Phase 0A's live behavioral correctness (idempotency concurrency, lifecycle enforcement under real transactions, etc.) — those remain unverified by this environment, as recorded in the Phase 0A hardening gates.

---

# Phase 0 SAFISHA Certification Foundation — Migration Identity Reconciliation

## Canonical reviewed migration

`supabase/migrations/20260902130000_safisha_certification_foundation.sql`
SHA-256 (current): `58fa8ebf41ac168c06fc205a4b6424b7c7eb6dcbdbddd80b7a4192db3538428a`

Taken through the full Phase 0 Slice 1 → Slice 1R design/hardening gate sequence: RESULT vs ELIGIBILITY separation, subquery-free bounded `CHECK` constraints on `exceptions`/`rows_snapshot`, `SECURITY INVOKER` justification on both new functions, explicit per-role `REVOKE`/`GRANT` (naming `authenticated` explicitly per the `DEFECT-DEFAULT-ACL-AUTHENTICATED-001` lesson), and the Slice 1R authority-selection ordering fix. This is the sole intended executable creation authority for `tb_certifications`, `commit_tb_certification`, and `get_authoritative_certification` going forward.

## Lovable live execution identity

`20260902104124` — the version identity Lovable's own tooling generated and recorded as applied on `bvyivmmfjejbmqoydezk`, row name `80ce84e4-3b61-42f7-a959-6397fd8f4257`, at file `supabase/migrations/20260902104124_80ce84e4-3b61-42f7-a959-6397fd8f4257.sql`.

## How this evidence was obtained

Retrieved directly by the project owner: `SELECT * FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 5` run in the live Supabase SQL editor for `bvyivmmfjejbmqoydezk`, exported to CSV, and relayed to this session. This environment has no authenticated access to that project and did not run this query itself — the evidence is read-only data supplied by someone who does have access, not a live connection made from here.

The same evidence set also confirms three earlier reconciliations already recorded in this document remain correctly tracked live: `20260901120000` (Phase 0A foundation, tracked as `20260902052434`), `20260902110000` (Phase 0A ACL hardening, tracked as `20260902074804`), and the pre-existing Phase 2A/`account_mapping_memory` provenance-split migration (tracked as `20260818040518` and `20260813151156` respectively, both already accounted for elsewhere in this document and in the earlier `account_mapping_memory` history).

## Executable equivalence proof

The `statements` payload for version `20260902104124` was extracted verbatim from the exported row and diffed directly against the canonical repository file, both with comments and blank lines stripped: **220/220 normalized lines identical, zero diff output.** No table, column, constraint, index, trigger, function body, or grant statement differs between what was authored and what actually ran.

## Resolution of DEFECT-SAFISHA-MIGRATION-HISTORY-001

This defect was originally framed as "migration 20260902130000 is physically applied live but missing from remote migration history." That framing is now corrected by direct evidence: **the migration was never missing.** Its exact executable content is present and tracked in `supabase_migrations.schema_migrations` — under Lovable's own generated identity (`20260902104124`), not the repository's authored timestamp (`20260902130000`). This is the same identity-divergence pattern already reconciled three times elsewhere in this document, not a distinct failure mode.

**Reconciled under Model B, same as every prior case:** `20260902130000` remains the sole executable repository authority; `20260902104124`'s file (`supabase/migrations/20260902104124_80ce84e4-3b61-42f7-a959-6397fd8f4257.sql`) is now a comment-only historical marker, matching the exact structure of the Phase 0A ACL hardening marker above.

**What remains genuinely open, not resolved by this reconciliation:**

1. The live `schema_migrations` tracking table itself is unmodified by this repository change — no `supabase migration repair` was run, no live database was written. If a future `supabase db push` against `bvyivmmfjejbmqoydezk` specifically needs to recognize `20260902130000` (rather than Lovable's tracked `20260902104124`) as applied, that still requires a real, credentialed `migration repair` command — this environment has none, unchanged from every prior statement of this constraint this session.
2. **`20260902150000_safisha_source_hash_authority_hardening.sql`** (the `trg_protect_source_file_hash` trigger and the fail-closed `get_authoritative_certification` predicate, from the Slice 2 authority-hardening round) does **not** appear anywhere in this evidence set. No tracked version corresponds to its content. **It has not been confirmed live and must be treated as still pending application** — its protections (blocking client forgery of `source_file_hash`, and failing closed on an unknown current hash) are not yet active on the live project regardless of this reconciliation.
3. `DEFECT-SAFISHA-SOURCE-HASH-WRITE-FAILURE-STALE-AUTHORITY-001` (Slice 2 authority-boundary review) — unaffected by this reconciliation, remains open as recorded.
4. `DEFECT-DEFAULT-ACL-AUTHENTICATED-001` and `DEFECT-MIGRATION-HISTORY-DIVERGENCE-001` — open, unchanged; this is a fourth concrete manifestation of the same identity-divergence pattern, not a new defect.

## Scope note (SAFISHA foundation section)

This record is scoped specifically to the `20260902130000`/`20260902104124` identity reconciliation. It does not certify SAFISHA's live behavioral correctness (real certification commits, real authority-selection queries under concurrent load, etc.) — those remain unverified by this environment. It explicitly does **not** extend to `20260902150000`, which remains unreconciled and unconfirmed live per item 2 above.
