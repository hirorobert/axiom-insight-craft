# Ω∞ Phase 2A Migration Identity Reconciliation

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

## Scope note

Nothing above certifies the wider ~96-file migration history repository-wide. This record is scoped specifically to the Phase 2A duplicate between `20260816120000` and `20260818040518`.
