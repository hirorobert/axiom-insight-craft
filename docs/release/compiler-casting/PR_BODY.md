> **Consolidated release (2026-11-12):** this identity was re-authored as the THIRD compiler identity, `20261228100000_statement_compiler_casting_declaration.sql`, over the merged second identity (`20261222200000`, PR #268, compiler `12314dad…`, rule pack 2.4.0). The combined bundle is `85a0f362…` (function closure `8419ff17…`), rule pack **2.5.0 = 2.4.0 with `subtotal-casting` 1.1.0**; 2.3.0 and `112c5847…` below describe the original branch form (20261220100000) and were never applied or deployed. Deploy `compile-financial-report` once, after 20261228100000.

**Draft. Base: #257 (`feat/returning-client-integration`) ← #256 ← #255 ← main `f366367`.** Authored only: nothing applied, merged, deployed or published. This is the only change in the stack that touches the **pinned compiler closure**, so it is isolated here.

## What it does
- **Fixes two registered casting defects** at their source: `DEFECT-FS-RESTATED-COMPARATIVE-CASTING-001` (a restated comparative could not be signed) and `DEFECT-FS-NEW-ACCOUNT-COMPARATIVE-CASTING-001` (an account in one year only blocked sign-off). A composed line now declares, per period, that a casting child with **no binding** for that period contributed nothing (`castingNilPeriodIds`); `subtotal-casting` 1.1.0 (canonical rule pack 2.3.0) honours it. No fact is invented, nothing is added up in the builder, a real casting error still fails, a bound child with no fact is still missing evidence, and an undeclared (extracted) report behaves as before. Rule packs 1.0.0 / 2.2.0 are untouched, so every recorded evaluation stays reproducible.
- **Regenerates the compiler bundle deterministically** (`112c5847…`; the build script now normalises `node_modules` path comments so a linked worktree no longer changes the digest) and registers the new closure of `compile-financial-report` (`bc7c3a62…`; the previous one stays *known older*).
- **Migration `20261228100000`** (forward-only, idempotent, **not applied**): the receipt table and `fs_record_server_compilation` accept exactly two compiler identities, the applied one and the new one; the function is re-created from its live text with two anchored replacements. Order: apply the migration, then deploy the function.
- Carries `signoff.ts` reading a missing comparative without dates (authored in #256 as `dba4fcf` without regenerating the bundle; moved here). #256 and #257 keep every first-period control enforced without it; this PR adds its unit test and a CI run of the first-period proof on the product client alone (`FIRST_PERIOD_PRODUCT_CLIENT=1`, 54/54).

## Evidence (local; embedded PostgreSQL 18.4 — GitHub CI for this head is reported in the PR conversation)
- Unit, real rule on the composed document: 11 tests (restated both periods; current-year-only and last-year-only accounts; a casting error still `FAIL`; undeclared document `INSUFFICIENT_EVIDENCE` — the pre-fix behaviour reproduced; v1 ignores the declaration; schema refusals).
- `returningClientJourney.mjs` 42/42: Source B now reaches REVIEWED → FINAL (was asserted as the exact stop); new group C: two new current-year accounts sign REVIEWED → FINAL.
- First-period 54/54; trackA 29; publicationControls 71; publicationIntegrityGate 40; publicationAuthorityLegacy 12; readinessReadOnly 26; signoffPolicy 24; comparatives 28; closeReview 100; readiness 28. `buildStatementCompiler.mjs --check` OK. tsc and eslint clean; `src/lib` suite green except the Windows-only symlink (`EPERM`) transport tests, which also fail without this change.

## Gaps (stated)
1. The new database groups were **not** run against the pre-fix compiler (the old bundle cannot be paired with the new rule-pack version); the pre-fix behaviour is reproduced at the unit level with the undeclared document.
2. **Hosted application and function deployment are out of scope** and are not done. The verifier registry (`verifyDeployedClosure`) is updated for the new closure.
3. **Unchanged, separate:** the first-period cash-flow / equity statements still build from comparative balances; the applicable IFRS for SMEs basis must be verified before any reporting behaviour changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
