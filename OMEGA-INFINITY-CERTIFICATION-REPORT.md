# Ω∞ Public-Sector / Framework Intelligence Engine — Final Certification Report

**Directive:** SAFF ERP — Ω∞ Public-Sector / Framework Intelligence Engine, Iron Dome Nuclear Implementation Directive
**Scope executed:** Slices 0–15 (all)
**Report date:** 2026-08-11

**Supersession note (2026-08-12):** at the time this report was written, local `main` was 290 commits behind `origin/main` without either side knowing it. A subsequent controlled convergence (`integrate-framework-intelligence-20260812`, reconciled against `origin/main` at `b5543785aae1ed44c6e080a60ed3611d2b469999`) resolved part of Section Z's blocker #1 ("nothing connected to the live app"): the `FrameworkConfirmationBanner` is now wired into the real, current `CompanyManager.tsx`, and the EFDMS/Reconcile and Compliance panel re-homing is applied against the real, current `PrepareWorkspace.tsx`/`ComplianceWorkspace.tsx`/etc. — not the stale versions this report was validated against. `AccountReviewPanel.tsx` was deliberately left as origin's own independent (and more complete) implementation rather than carrying Slice 8's version forward; see the convergence session's reconciliation matrix. The core findings below (rule-pack grounding, accounting-equation cross-validation, the security incident and fix) are unaffected and remain accurate. `process-trial-balance` integration and a live write edge function (blockers #1's edge-function half, and #3) remain open.

---

## A. Repository architecture — before

Per [PHASE-0-PUBLIC-SECTOR-REALITY-AUDIT.md](PHASE-0-PUBLIC-SECTOR-REALITY-AUDIT.md):

- `reporting_framework` (companies table): single manual dropdown, 4 values, no inference of any kind, unenforced after first save.
- A second, incompatible framework enum (`fiscal_periods.accounting_basis`) existed with a different value set on a different table — never reconciled.
- Classification: a 6-tier deterministic/fuzzy/regex classifier (`process-trial-balance`), IFRS-shaped throughout, zero IPSAS-specific rules, zero source-system detection, zero entity-context model.
- Comparative periods: a real, working engine already existed (`fiscal_periods` + `kinga-comparative-engine`), IAS1/IPSAS1-cited — more built-out than the directive assumed.
- Cash flow: a real indirect-method SCF already existed in `kinga-tax-engine`, hardcoded to IFRS-for-SMEs, no IPSAS variant.
- `account_mappings`: no period dimension, mutated in place — a correction silently changes how a prior period would reprocess.
- `AccountReviewPanel`: already draft-then-save (good), but rendered all rows in one scrollable list — no Previous/Next, no per-decision navigation.
- Zero MUSE/GFS-specific logic anywhere in the codebase. A prior design doc for source adapters existed but was never implemented.
- Test coverage: only small pure numeric utilities were tested. The entire classifier, rule library, and framework-branching export logic were untested.

## B. Repository architecture — after

17 new pure library files under `src/lib/accounting/` (+17 test files, 258 tests), 1 new (unapplied) database migration, and 4 existing files touched with minimal, regression-tested diffs:

- `entityContext.ts` — pure `EntityAccountingContext` contract, `Provenance<T>` wrapper (C8).
- `frameworkAdapter.ts` — lossless conversion between the canonical DB string and the pure framework/basis pair.
- `detectEntityContext.ts` — read-only framework detection, evidence-graded, zero I/O.
- `confirmationPosture.ts` — confidence → UX posture mapping (Section XVII).
- `frameworkPresentationRegistry.ts` — replaces `ExportStatements.tsx`'s hardcoded if/else (its own comment invited this exact refactor).
- `museIpsasRulePack.ts` — `TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1`, 294 rules, every one grounded in a real Arusha District Council MUSE export.
- `museClassifier.ts` — evidence-ladder classifier over the rule pack.
- `goldenTestCorpus.test.ts` — Section XXII fixtures + Section XXVI scenario certification status.
- `comparativeEvidence.ts` — source-tier hierarchy, C4-compliant explicit states, mapping-drift detection.
- `reviewDecisionState.ts` + reworked `AccountReviewPanel.tsx` — five decision states, Previous/Next navigation.
- `statementAggregationEngine.ts` — accounting-equation aggregation, proven against real, complete FY2026 data.
- `cashFlowEngines.ts` — two distinct cash-flow products with a mandatory cross-check.
- `movementSchedules.ts` — real PPE roll-forward engine + 13-type schedule-requirement registry.
- `mappingMemory.ts` + migration — priority evidence ladder, period-scoped, append-only.
- `controlledActivation.ts` — three-gate eligibility decision layer (outcome, framework-confidence, explicit allowlist).
- `frameworkConfirmationBannerContent.ts` + `FrameworkConfirmationBanner.tsx` — the one live UI integration point.
- `section18AdversarialCertification.test.ts` — this report's executable evidence for section S.

## C. Entity-context implementation

`EntityAccountingContext` (Slice 1): `jurisdiction`, and five independently-provenanced dimensions (`entityClass`, `ownershipClass`, `reportingFramework`, `accountingBasis`, `sourceSystem`), each a `Provenance<T>` carrying `value`, `confidence`, `source`, `evidence[]`, `confirmedBy?`, `confirmedAt?` — matching C8 exactly. Structurally orthogonal: no field's value can be derived from another (proven in `entityContext.test.ts` and the Section XVIII sweep).

## D. Framework-detection evidence hierarchy

Implemented tiers (Slice 2): prior professional confirmation (HIGH) > non-default DB value (MEDIUM, `USER_MANUAL_ENTRY`) > untouched schema default (LOW, `CONFIGURED_ENGAGEMENT_CONTEXT`) > absent/unrecognized (NONE, `UNKNOWN`). Not implemented: source-system-signature and lexical-signal tiers — no real evidence source exists for either yet (honest gap, not fabricated).

## E. Source-system detection

**Not implemented beyond the type system.** `SourceSystem` exists as a pure enum; `detectEntityAccountingContext` always returns `UNKNOWN`/`NONE` for it — Phase 0 confirmed zero source-system detection exists anywhere in the shipped app, and no evidence source was available this session to build one honestly.

## F. Tanzania IPSAS common core

31 `IpsasPresentationCode` values spanning all five `AccountNature` buckets (ASSET, LIABILITY, NET_ASSETS, REVENUE, EXPENSE), derived entirely from the real Arusha DC chart — not a pre-conceived taxonomy imposed on the data.

## G. LGA profile

**Fully real.** 294 rules, 271 at HIGH confidence (`AUTO_MAPPED_RULE`-eligible), 23 honestly flagged `REVIEW_SUGGESTED` where the source data itself doesn't state exchange-vs-non-exchange status. Golden Test Corpus Section XXII.A: all 14 named required cases (service levy, user fee, subvention, PPE, ECL, etc.) proven against real codes.

## H. Agency/regulatory profile

**PARTIAL, not proven.** Architecture is extensible (rules are `entityClasses`-parameterised, not LGA-hardcoded — Golden Test Corpus §B proves this structurally), but no real TCU/PPRA/ADEM MUSE export exists in this session's evidence, so no agency-specific rule content was built. Fabricating one would have violated C4/Section XVIII.

## I. SOE IFRS isolation proof

**PROVEN.** `detectEntityAccountingContext` has no ownership/entity-class parameter — there is no code path by which "government-owned" could reach the framework decision. An ATCL-shaped fixture (`full_ifrs` in DB) resolves to `IFRS`, never `IPSAS_ACCRUAL` (`goldenTestCorpus.test.ts`, `section18AdversarialCertification.test.ts`).

## J. NGO/CBO non-inference proof

**PROVEN.** An NGO/QuickBooks-shaped fixture (untouched `ifrs_for_smes` default) resolves at LOW confidence, never HIGH, and `classifyConfirmationPosture` maps that to `EXPLICIT_ASK` — the system asks rather than silently trusting the default.

## K. MUSE rule registry

`TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1` — 294 exact-code rules, each with `ruleId`, `version`, `evidenceDetail` citing the real source (Arusha DC, entity 00703099, FY2025/FY2026). Three documented real exclusions proven in tests: a `63xxxxxx` code that's a liability despite the prefix meaning net assets elsewhere in the same chart; a `61xxxxxx` accumulated-depreciation code with opposite treatment from its same-prefix sibling; `31xxxxxx` inventory codes distinguished from PPE additions sharing the same prefix.

## L. Comparative engine

Pure evidence-tier hierarchy + explicit `KNOWN`/`ZERO`/`MISSING`/`NOT_APPLICABLE` states (discriminated union — C4 enforced at the type level). Proven against real presence-change data: `13465101 "Subvention Capital"` (real, in FY2025, absent from FY2026) resolves `MISSING`, never a fabricated 0. Does not duplicate the existing `kinga-comparative-engine` — this is the contract layer a future integration would wire it through.

## M. Audited mapping memory

Migration `20260811000000_account_mapping_memory.sql` — append-only (immutability trigger, mirrors the existing `tenant_events` pattern), RLS-scoped to firm membership, `confirmed_by` FKs to `firm_members.id` (never `auth.users.id`). Priority ladder (`cag_external_audited > saff_professionally_approved > user_approved_current > system_rule`) implemented as executable selection logic (`selectAuthoritativeMapping`), proven order-independent. **This migration has NOT been applied to any database** (see T, X, Z).

## N. Review Previous/Next behavior

Five decision states derived (never redundantly stored) from existing draft data. Verified **in a running browser**, not just unit tests: Next → Next → changed a draft classification → Previous → Next confirmed the change persisted; "Show full list" reflected the same state. The existing save/upsert/reprocess contract in `AccountReviewPanel.tsx` was not touched.

## O. Statement engine

`aggregateStatementPresentation` proven against the **complete, real** 237-account Arusha FY2026 trial balance: the accounting equation (`Assets = Liabilities + NetAssets + Surplus`) holds to sub-cent tolerance, and the independently-computed surplus (-234,109,972.56 TZS) matches the real government-reported figure (-234,109,973 TZS) in the actual Statement of Changes in Net Assets and Equity.

## P. Cash-flow engines

Two distinct products (`buildOperatingCashFlowReconciliation`, `buildPrimaryCashFlowStatement`) with a mandatory `crossCheckOperatingCashFlow`. The build process caught two real bugs before they shipped: WIP-transfer entries wrongly counted as capex (fixed via a rule-pack refinement, `WORK_IN_PROGRESS_TRANSFER_NON_CASH`), and an inverted sign in the financing-activities formula. Both fixed and re-verified. Does not touch the existing, live `kinga-tax-engine` SCF logic.

## Q. Notes/movement engine

One fully-real, fully-computed engine (PPE roll-forward) — built only after an initial roll-forward hypothesis was checked against real data and found **false** (Opening balances are static, not rolled forward; the real mechanic uses cumulative-to-date addition deltas instead). 12 named schedule types modeled as pure contracts with a materiality-based requirement assessment; only PPE has real computation logic behind it — the rest are honestly `NOT_APPLICABLE` or `UNASSESSABLE_FROM_TB`, never fabricated.

## R. Dry-run results for Arusha unresolved accounts

| Outcome | Count |
|---|---|
| AUTO_MAPPED_RULE (HIGH) | 271 |
| REVIEW_SUGGESTED (MEDIUM/LOW) | 23 |
| UNRESOLVED | 0 (of these 294; any code outside this set still resolves UNRESOLVED) |

## S. False-positive adversarial results

All 13 Section XVIII prohibitions proven false via `section18AdversarialCertification.test.ts` (15 tests, all passing): debit≠expense, credit≠revenue, government≠IPSAS, parastatal≠IPSAS, NGO≠IPSAS, QuickBooks≠IFRS, MUSE is never blindly certified, same-name≠same-mapping-globally, missing-comparative≠0, prior-mapping≠current-approval, lexical-match≠authority, no note/schedule generated from unsupported data, no fabricated movement amounts.

## T. Exact migrations

Two: `supabase/migrations/20260811000000_account_mapping_memory.sql` and, following the live security finding in section X's addendum, `20260811000001_account_mapping_memory_security_fix.sql`. **Applied via the project owner + Lovable Cloud** (this session's own Supabase CLI still has no access to the live project — an unrelated project was linked at session start, and the real project ref rejects this account; see Task #106 history). The first migration was applied and live-tested; the second is pending re-verification as of this report.

## U. Exact files changed

**New (35):** 17 source files + 17 test files under `src/lib/accounting/`, 1 migration, 1 new component (`FrameworkConfirmationBanner.tsx`), this report, the Phase 0 audit.
**Modified, minimal/regression-tested diffs (5):** `ExportStatements.tsx` (Slice 3 — behavior-preserving registry swap), `AccountReviewPanel.tsx` (Slice 8 — navigation shell only, save contract untouched), `CompanyManager.tsx` (Slice 14 — 2 lines, one banner render), plus `TrialBalanceUpload.tsx` and the workspace pages from the earlier Task #255 session (unrelated to this directive).
**Toolchain repair (incidental, not part of this directive):** `package-lock.json` — `node_modules` was fully broken at session start (missing `vite`/`tsc`/`vitest` binaries); `npm install --legacy-peer-deps` repaired it.

## V. Build result

`tsc --noEmit -p tsconfig.app.json` → **0 errors**, every slice, including this final pass.

## W. Test result

**258/258 passing**, 21 test files, 0 regressions at any point this session. (Test count grew from 97 at session start — all pre-existing tests — to 258; every new test is additive.)

## X. RLS/security result

**Addendum (post-report, via the project owner + Lovable Cloud, live database):** the migration was applied and live-tested with real negative-case queries. Steps 1–5 (table exists, RLS enabled, insert succeeds, UPDATE blocked, DELETE blocked) all **PASSED** against the immutability trigger exactly as designed. Step 7 (anonymous access must be denied) **FAILED**: `GET /rest/v1/v_latest_account_mapping_memory?select=id` using only the public `anon` key returned `HTTP 200` with real row data — every company's confirmed mapping data was readable by anyone holding the public key.

Root cause: `v_latest_account_mapping_memory` was created without `security_invoker`, so it ran with its `postgres` owner's privileges (bypassing the base table's RLS) rather than the querying role's — compounded by this specific project's `ALTER DEFAULT PRIVILEGES` granting `anon` implicit access to new public objects, silently overriding the migration's intended `GRANT SELECT ... TO authenticated`. **This was not discoverable by static SQL review** — it depends on live, project-specific default-privilege configuration this session had no way to see. It is the exact reason this report declined to write "RLS: verified" without a live database.

Fixed in `20260811000001_account_mapping_memory_security_fix.sql` (`security_invoker = on` + explicit `REVOKE ALL ... FROM anon` on both objects, not relying on defaults). **Re-verified live, post-fix, by the project owner via Lovable Cloud:**
- The exact request that leaked before (`GET /rest/v1/v_latest_account_mapping_memory?select=id`, anon key only) now returns `401 permission denied for view v_latest_account_mapping_memory`.
- The base table now returns a clean, deliberate `401 permission denied for table account_mapping_memory` — no longer an accidental error leaking from the RLS policy's `firm_members` subquery.
- Live catalog confirms `security_invoker=on` is set and the ACL on both objects is `authenticated, postgres, service_role` — no `anon` entry.
- The Supabase linter's "Security Definer View" category no longer appears for this view.
- The legitimate access path still resolves correctly post-fix: the firm-membership RLS predicate evaluates `true` for an accepted member and `false` for a non-member of the same test row's company, and the view still returns the row for `service_role`.

**This table is now genuinely verified end-to-end via live adversarial testing** — not just designed to spec. It is the one component in this entire directive that went through a real find-a-bug-then-prove-the-fix cycle against production infrastructure, which is exactly the standard the rest of this report explicitly could not meet without live database access.

**Broader implication, not yet actioned:** if this project's `ALTER DEFAULT PRIVILEGES` grants `anon` access to new objects by default, any *other* view created in this project without explicit `security_invoker` and without explicit anon revocation may have the same exposure, independent of this directive's work. That audit is outside this session's scope but worth the project owner's attention.

## Y. Final git status

```
 M package-lock.json
 M src/components/AccountReviewPanel.tsx
 M src/components/CompanyManager.tsx
 M src/components/ExportStatements.tsx
?? src/components/FrameworkConfirmationBanner.tsx
?? src/lib/accounting/                                    (17 source + 17 test files)
?? supabase/migrations/20260811000000_account_mapping_memory.sql
?? PHASE-0-PUBLIC-SECTOR-REALITY-AUDIT.md
?? OMEGA-INFINITY-CERTIFICATION-REPORT.md
```
(Unrelated pre-existing/other-session changes — `TrialBalanceUpload.tsx`, workspace pages, `.claude/`, `supabase/.temp/` — omitted above; not part of this directive's diff.)

## Z. Remaining blockers

1. **Nothing built this session is connected to the live application's real data flow.** `process-trial-balance` (the edge function every real upload goes through) is completely unmodified — it does not know `TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1` exists. A user uploading a real MUSE trial balance today gets zero benefit from any of Slices 1–15.
2. ~~The migration is unapplied.~~ **RESOLVED.** Both `account_mapping_memory` and its security-fix follow-up are applied and live-verified (see X's addendum) — the only component of this directive to complete a full live find-fix-reverify cycle.
3. **No live write path exists at all.** `controlledActivation.ts` decides eligibility and builds the record; no edge function performs the actual insert, and none was built — deliberately, because it could not have been integration-tested without live DB access at the time it would have been written.
4. ~~RLS is unverified.~~ **RESOLVED for `account_mapping_memory`** (see X). Not assessed for any other table — this directive did not touch any other table's RLS.
5. **Agency/regulatory (H) and SOE-content (I, partial) rule coverage does not exist** — only the LGA profile is real.
6. **UX integration (Slice 14) is one touchpoint**, not the "full" integration the directive's own slice name describes — the Provenance Drawer (Section XIX) and account-level review-workbench explainability UI were not built.
7. **New, from the security fix**: this project's `ALTER DEFAULT PRIVILEGES` grants `anon` implicit access to new public objects. Any other view in this project created without explicit `security_invoker` and without an explicit anon revocation may carry the same exposure this session found and fixed for `account_mapping_memory` — that audit is outside this directive's scope.
8. Fixing #1 and #3 requires either a working Supabase CLI session with real project access, or the project owner building/deploying the edge-function integration directly with the same live-verification discipline #2/#4 just demonstrated.

---

## Final verdict

**BLOCKED — not integrated into any live data path; migration unapplied; RLS unverifiable this session.**

This is not a verdict about correctness. Every piece of logic built — entity-context detection, the 294-rule MUSE registry, the classifier, the comparative engine, the statement and cash-flow engines, the movement schedules, mapping memory, controlled activation, the review workbench rework — is real, tested against real government financial data where evidence existed, and passes 258/258 tests with 0 TypeScript errors and 0 conflict markers. None of Section XXVII's seven explicit certification blockers (false inference, comparative-as-zero, provenance-less mappings, irreversible review, statement reconciliation failure, cash-flow disagreement, red tests/build) are present — each was actively tested for and found absent.

But "CERTIFIED" for an engine whose stated purpose is processing real trial balance uploads would be a claim about the live system, not about this library. The live system is unchanged. Certifying it would overstate what exists by exactly the margin this whole directive was built to prevent.
