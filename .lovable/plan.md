# Ω∞ North Star Workspace Reconstruction — Phase 0 Discovery + Implementation Map

## A. Discovery evidence (verified, not assumed)

**State sources (authoritative — must not be duplicated)**
- `src/lib/workspace/deriveWorkspaceState.ts` — pure engine producing `missions` (7 stages) + `nextAction`.
- `src/lib/workspace/computePreflight.ts` — trial-balance certification verdict/blocker.
- `src/hooks/useWorkspaceData.ts` — sole DB reader (company, uploads, HESABU/sign-off/filing timestamps).
- `supabase/functions/process-trial-balance` — sole writer of classification results into `trial_balance_uploads.processing_result`.

**Duplicated presentations on the Overview** (confirmed by reading `WorkspaceOverview.tsx`, 696 lines):
1. `OnboardingFlow` (Getting Started · Step 1 of 4, with its own "Open Prepare Data" CTA)
2. Directive `SurfaceCard` (second CTA)
3. `TrialBalanceProgressLedger` (7 processing rows, own warning banner, own resolve link)
4. Compact mission strip
5. Expandable Workflow list (7 stages, each a link)
6. Files/uploads list
7. Stage tabs from `WorkspaceLayout`

That is three CTA-bearing surfaces and three renderings of the same workflow state.

**Why 105 accounts need review** (live query, upload `c8a8ede6…`):
- 104 items have `confidence_source = none` — Tier 6 fall-through in `classifyAccountTiered`: no company mapping, no global mapping, no dictionary hit, no rule hit.
- 1 item is `dictionary_contains_conflict` (Spare Parts – Vehicles…), a legitimate ambiguity.
- Cause: the dictionary and rule tiers are commercial/IFRS-only. The only `levy` rules present are commercial service-levy expense/payable. There are zero public-sector rules (subvention, government grant, user fee, CHF, DRF, personal emoluments, other charges, own-source revenue).

**Entity / reporting-context capability today**
- `companies.reporting_framework` exists and for Arusha DC is already `ipsas_accrual` (set via `FirstRunEngagement`).
- There is no `sector`, `entity_type`, or confidence/provenance column on `companies`. `industry` exists but is NULL.
- `process-trial-balance` never reads `reporting_framework` — classification is framework-blind. This is the root architectural gap.

**Classification vocabulary constraint**
- `account_classification` is a Postgres enum with exactly 13 labels (current/non-current assets, current/non-current liabilities, equity, revenue, COGS, operating_expenses, other_income, taxes, and 3 cash-flow labels).
- IPSAS semantics must therefore be expressed as `line_item` text plus statement and normal_balance on top of existing enum labels. No new enum labels, no parallel chart of accounts.

**Migration requirement: NO.** `reporting_framework` already carries the sector signal, EntityContext can be derived deterministically in code, and provenance fits in the existing `processing_result` JSONB and `account_mappings.confidence_source` text column. A migration would only be needed to persist a dedicated `sector` column, which this directive does not require.

**Files that MUST NOT change:** `deriveWorkspaceState.ts`, `stageMetadata.ts`, `src/integrations/supabase/client.ts` / `types.ts`, all migrations, KINGA/HESABU/SAFISHA functions, sign-off and gate triggers, and the route table in `App.tsx`.

**Risk register**
- R1 Over-classifying public-sector credits as revenue — mitigated: sign is evidence only; every public-sector rule requires name semantics AND framework context, and fund/payable/reserve/deferred/retention terms are excluded from revenue rules.
- R2 Silent authoritative mapping — mitigated: suggestions remain `needs_review`; the review screen stays the sole writer.
- R3 Hiding uncertainty — mitigated: the Overview shows the exception count and links straight to it; telemetry is re-homed, not deleted.

## B. Implementation map (atomic slices)

**Slice 1 — Overview hierarchy (presentation only).** Rebuild `WorkspaceOverview.tsx` into three zones: a quiet identity header (name · FY; TIN surfaced only when missing/invalid and blocking), one Current Decision surface (state, one sentence, one material number, ONE CTA), and a subordinate 7-stage engagement path carrying lock reasons and zero CTA authority. `OnboardingFlow` and `TrialBalanceProgressLedger` leave the Overview; the second CTA, duplicated sync chrome, and the Files list leave the first screen.

**Slice 2 — Status → reason → action.** The Current Decision CTA routes directly to the unresolved account set in Prepare (pinned `?upload=<id>` with the review panel filtered to unresolved), so "N accounts need review" is itself the action.

**Slice 3 — Re-home what leaves the Overview.** `TrialBalanceProgressLedger` moves into Prepare behind a collapsed "Processing details"; files stay in Prepare's existing `UploadsStatusPanel`; onboarding guidance becomes implicit in the Current Decision copy.

**Slice 4 — Prepare exception workbench.** Rework `AccountReviewPanel` into a workpaper table: Account · Balance · Suggested classification · Confidence/reason · Decision (Accept / Change), unresolved first, stacked records below 768px. Bulk accept only per shared deterministic rule, with a preview of exactly what changes; exclusions stay explicit.

**Slice 5 — EntityContext (no migration).** New pure module `src/lib/accounting/entityContext.ts` plus a mirror under `supabase/functions/_shared`, deriving `{ sector, reportingFramework, jurisdiction, entityType, confidence, provenance }` from `companies.reporting_framework` and existing evidence. `process-trial-balance` reads the company row and passes context into classification; context and provenance are recorded in `processing_result`.

**Slice 6 — Public-sector / IPSAS rule tier.** A context-gated rule set, active only when sector is public, mapping levies, taxes, user fees, subventions/grants, transfers, personal emoluments, other charges and CHF/DRF-style funds onto existing enum classifications with IPSAS `line_item` wording (non-exchange revenue · levies, employee costs, goods and services, and so on). Sign never decides alone; fund/payable/reserve/deferred terms route to liability or to human review. Deterministic hits become suggestions tagged `confidence_source = "ipsas_rule"`; genuinely ambiguous accounts (for example Drug Revolving Fund) stay unresolved with a stated reason.

**Slice 7 — Responsive pass** at 390 / 768 / 1024 / 1440 px, with no horizontal overflow in the primary workflow.

**Slice 8 — Certification.** Unit tests for `entityContext` and the public-sector classifier (including explicit "credit is not revenue" and "debit is not expense" cases), a single-dominant-CTA assertion for the Overview, `bunx vitest run`, `npm run build`, conflict-marker scan, then the Section XIX certification report. No push to main.

## C. Technical notes
- Zero changes to `deriveWorkspaceState`, `stageMetadata`, the route table, gates, RLS, or migrations.
- Only `process-trial-balance` changes server-side; it remains the sole writer and keeps `needs_review` semantics and NULL-means-not-computed.
- Public-sector classification maps into the existing `account_classification` enum; IPSAS specificity lives in `line_item`.
- Redeploy scope: `process-trial-balance` only.

## D. Open decision
Slice 6 changes engine behaviour by adding a suggestion tier. It writes no authoritative mapping — suggestions still require human acceptance. Confirm this is authorised, or restrict the work to Slices 1–4 and 7 (UI only) with the classification gap reported instead.