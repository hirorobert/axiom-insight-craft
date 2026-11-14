# 05 — Phase 5 / 6 Boundary & Sequence

**Terminology (resolves a trap):** accounting **Phase 5** = cash-flow / financial-statements
foundation; accounting **Phase 6** = reversible account-review + tri-state authoritative flags.
Both are unrelated to the commercial "Ω∞ Phase 6 = checkout". This file uses the accounting
meaning. No `research/phase5/**` docs exist on this branch; the story lives in code + release/
architecture docs.

## A. Phase 5 — COMPLETED (research-grade / gated)
- **Canonical statement model** (`src/lib/canonicalStatement/`, schema `1.0.0`): format-neutral
  model, immutable append-only `MonetaryFact[]`, atomic `recordFactCorrection` bumping
  `reportVersion` by exactly 1 (`reviewState.ts:57-136`), deterministic hashed rule engine.
  NULL ≠ zero enforced. **VERIFIED present + tested; DISABLED in product.**
- **Rule pack v2.2.0 = 14 rules** (`rules/rulePack.ts:47-52`): v1's 10 + `equityClosingTie`,
  `equityProfitTie`, `scheduleCasting`, and the cash rules (`cashPerimeterReconciliation`,
  `cashflow-account-rollforward`).
- **`cashFlowEngines.ts`** — **pure / dormant / NOT wired** (imported only by
  `primaryCashFlowEngine.ts`, `maonoAnalyticalContract.ts`, `evidenceResolverTypes.ts`, tests). Its
  own `crossCheckOperatingCashFlow` disclaims being genuine dual-engine independence (`:261-293`).
- The product's *intended* cash-flow generator is a different World-B module
  `financialGeneration/cashFlowDirect.ts` (direct method from a transaction-ledger evidence
  family) — also gated off.
- **Honest limitation carried forward:** `DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001` — cash flow is
  preparer-supplied ledger evidence reconciled to the TB, **not** bank-independent; two
  independently *derived* operating-cash-flow numbers remain impossible
  (`FINANCIAL_STATEMENTS_RELEASE_PACKAGE.md:82-96`).

## B. The FIRST Phase 6 slice — stage-by-stage
Slice = grouped review → authorised versioned decisions → traceable TB summary → repeat upload
with compatible reuse + changed-context reopening.

| Stage | Status | Evidence |
|---|---|---|
| 1. Grouped review | **VERIFIED at RPC; MISSING in UI** | `resolve_account_review_batch` takes a batch atomically (`20260904120000:106`), but `AccountReviewPanel.tsx` is per-account only — no bulk/"apply to matching" affordance. |
| 2. Authorised versioned decisions | **VERIFIED (live)** | append-only, immutable `account_review_decisions` ledger ordered by global `sequence_no` (`20260816120000:98-151`, immutability trigger `:171-173`); role-authorised server-side (`20260904120000:159-161`); actor from `auth.uid()`. |
| 3. Traceable TB summary | **VERIFIED (live)** | immutable hash-snapshotted `tb_certifications` ledger (`20260902130000:55-117`, append-only trigger `:144-159`) + 6-layer readiness projection bound to the exact upload. |
| 4. Repeat reuse + reopening | **PARTIAL** | Reuse: deterministic period-agnostic `account_mappings` reuse is live; the *governed suggestion* resolver (`mappingMemory.ts`) is pure & **dormant** (store unpopulated, no writer). Reopening: identity-drift + certification-drift guards are **live**. |

**What of the slice fits WITHOUT new authority, vs needs approval:**
- *No new authority:* a **grouped-review UI** over the already-authorised batch RPC (Stage 1 UI
  gap) and surfacing the existing versioned ledger/TB summary (Stages 2–3) are additive UI.
- *Needs a decision:* **activating** `account_mapping_memory` as the persistent reuse store needs a
  writer + the compatibility policy signed off (framework/source-system/period gating is already
  modelled, fail-closed). AI-assisted suggestions on top of it need the provider data-handling
  decision (C-2) — the suggestion must enter the existing authorised review, never bypass it.

## C. Everything needed AFTER the first slice for *supported* statements
1. **Activate World B** — the framework-aware generation/validation/publication engine is gated
   off (`workspaceGate.ts:21=false`, `persistenceGate.ts:16=false`; migrations
   `20260919100000/110000` unapplied). This is the single biggest unlock.
2. **MappingSet as a hashed versioned set** — `account_mappings` is still a mutable
   `ON CONFLICT DO UPDATE` projection (`ARCHITECTURE-GAP.md:22`); the decision *ledger* is
   versioned, the effective *projection* is not.
3. **Adjustments into statements** — `adjusting_journal_entries`/`aje_lines` exist but debits=credits
   is client-side only (no DB trigger) and no statement engine reads them (`ARCHITECTURE-GAP.md:23`).
4. **Evidence families the TB cannot supply** — SOCIE movements, independent cash ledger, budgets,
   asset/PPE registers; each is a first-class `EVIDENCE_GAP` state in `statementComposition.ts`.
5. **"Reference" trust tier + per-engagement "expert review required"** — unmodelled
   (`AUDIT.md:143-144`).
6. **Live sign-off role gate** — absent on legacy `statement_sign_offs` (control finding **C-1**).
7. **Resolve `DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001`** (affects MAONO analytics, not
   statements directly) and the status-doc drift on the authoritative-flags defect.

**Do not expand B into C.** The first slice is UI + activation of already-authorised batch/ledger/
certification mechanisms plus a governed reuse store; C is the larger generation-engine activation
and the evidence-family + versioned-mapping work.
