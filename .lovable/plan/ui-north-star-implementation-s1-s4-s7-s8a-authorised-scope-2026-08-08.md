# UI North Star Implementation — S1–S4, S7, S8a (authorised scope)

UI and presentation only. No database change, no Edge Function change, no engine change, no deploy, no push. S5 and S6 are explicitly out of scope. The term `AUTO_CLASSIFIED_CERTIFIED` is retired and will not appear anywhere; reserved future terminology is `AUTO_MAPPED_RULE` / `REVIEW_SUGGESTED` / `UNRESOLVED`, kept semantically separate from professional approval (`review_status` / `approved_by` / `approved_at`).

## S1 — Overview becomes one decision surface

`src/pages/workspace/WorkspaceOverview.tsx` is rebuilt into three zones and nothing else.

```text
Arusha DC · FY2025                                   (quiet identity line)

PREPARE DATA
105 accounts require review
240 accounts processed. 135 classified safely.
[ Review 105 accounts ]                              (the only dominant CTA)

Prepare · Reconcile · Statements · Tax · Compliance · Filing · Monitor
                                                     (thin subordinate path)
```

- `OnboardingFlow` is removed from the authenticated workspace (component file retained, no longer mounted here).
- `TrialBalanceProgressLedger` is removed from the Overview.
- Second CTA, sync/refresh chrome, mission strip, expandable workflow list and the Files list all leave the first screen.
- TIN is rendered only when missing or invalid and it blocks the current step, as a compact exception with an `Add TIN` affordance; a valid TIN is not shown.
- Stage path shows complete / current / available / locked with the lock reason available on the row, and carries zero CTA authority.
- All copy, counts and lock reasons are read from the existing `workspaceState` and `upload.processing_result` — no new derivation.

## S2 — Status is the action

The Current Decision CTA and the exception count are the same control. It navigates to `/workspace/:companyId/:periodYear/prepare?upload=<activeUploadId>&review=unresolved`, landing on the unresolved set with no intermediate hunt. `PrepareWorkspace` reads the `review` param and scrolls/focuses the workbench with the unresolved filter applied. Route table and gate conditions are untouched.

## S3 — Telemetry re-homed

`TrialBalanceProgressLedger` is mounted inside `PrepareWorkspace` under a collapsed `Processing details` disclosure (closed by default). Files stay in Prepare's existing `UploadsStatusPanel`. Nothing is deleted from the product.

## S4 — Exception workbench

`src/components/AccountReviewPanel.tsx` is converted from stacked cards to a professional workpaper.

- Desktop columns: Account · Balance · SAFF assessment (suggestion + reason, or "Ambiguous — classify") · Decision.
- Unresolved items first; already-suggested rows follow; excluded rows collapse to a quiet, explicit state.
- Under 768px each row becomes a structured stacked record keeping account name, balance and assessment visible; evidence discloses on demand.
- Save/reprocess logic, the upsert payload, `confidence_source: "user_approved"`, the exclusion semantics and the reprocess polling are unchanged — this is a rendering change only.

## S7 — Responsive

Verified at 390 / 768 / 1024 / 1440 px: one primary action visible without scrolling, no horizontal overflow in the primary workflow, accessible tap targets.

## S8a — UI regression certification

Per slice: `git diff --check`, `npm run build`, `bunx vitest run`, conflict-marker scan. Final pass adds the single-dominant-CTA assertion on the Overview and the direct-routing check. Then the report: structure before/after, duplicate surfaces removed, first-viewport contents, CTA proof, routing proof, workbench result, mobile results, invariants preserved, files changed, tests, build, git status, remaining S5/S6 blockers.

## Files

Changed: `src/pages/workspace/WorkspaceOverview.tsx`, `src/pages/workspace/PrepareWorkspace.tsx`, `src/components/AccountReviewPanel.tsx`, `src/components/workspace/ui/Surface.tsx` (extend primitives only).

Not touched: `deriveWorkspaceState.ts`, `stageMetadata.ts`, `computePreflight.ts`, `App.tsx` routes, migrations, RLS, KINGA, HESABU, SAFISHA, XBRL, `process-trial-balance`, `src/integrations/supabase/*`.

## Registered, not fixed

`DEFECT-MAONO-001` — severity HIGH, status OPEN, isolated from this work: `maono-compute` and `maono-cashflow` query a non-existent `account_classifications` table, a latent production runtime failure. Recorded in project memory as a tracked defect; no code change in this branch.

## Held blockers (S5/S6, dependency-scoped)

- **B1 — HARD for S6.** `account_classification` is simultaneously the account nature and the financial-statement presentation key (`processing_result.statements.<statement>.<classification>`), consumed by exports, compliance scoring, KINGA findings, the management letter and MAONO. The agreed fix is decoupling into account nature → framework presentation mapping (`presentation_code`, `presentation_label`, `standard_basis`) → statement line, with tax treatment and cash-flow classification as separate dimensions. The existing enum is preserved, not destroyed.
- **B2 — HARD for `AUTO_MAPPED_RULE`.** No authoritative sector. Minimum authoritative model when authorised: `sector`, `sector_source`, `sector_confirmed_at`, `sector_confirmed_by`, reusing existing `reporting_framework`; `entity_type` deferred until it earns its place; no `jurisdiction` column added for completeness alone.
- **B3 — MEDIUM/HARD for the global standards engine.** No early-adoption configuration, so IPSAS 47/48 early application cannot be established. FY2025 defaults to the pre-IPSAS-47 basis with early adoption treated as unsupported until explicitly configured. Not a blocker for S1–S4.
- **B5 — verification only.** Authenticated preview screenshots of the Arusha DC workspace need a signed-in Lovable preview session.

When S6 is authorised it starts with a **dry-run classifier simulator** over the current 105 accounts — no writes, printing outcome and reason per account for inspection — before any auto-mapping is enabled, and rules live in a versioned registry with explicit `ruleId`, `version`, `effectiveFrom`, `sector`, `phraseSignals`, `exclusions`, `standardBasis` and `outcomeAuthority`, never scattered branches. No target review count is optimised toward.