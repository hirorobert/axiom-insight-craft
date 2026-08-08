# Ω∞ North Star UI — audit, minimal remediation, certification (S1–S4, S7, S8a)

Presentation-only chapter. No database, migration, RLS, Edge Function, engine, `deriveWorkspaceState`, `stageMetadata`, `computePreflight`, generated types or route-architecture change. No deploy, no push. S5/S6 stay frozen.

## Audit of what already exists

| Requirement | Verdict |
|---|---|
| S1 Overview reduced to three zones | PARTIAL |
| Zone 1 quiet identity (`Company · FY`) | FAIL — Overview renders no identity line at all, only the blocking-TIN affordance |
| Zone 2 exactly one dominant CTA | PASS (single `data-testid="primary-cta"` surface) |
| Zone 3 subordinate workflow orientation | PASS (thin inline stage path, locked rows carry no CTA) |
| OnboardingFlow / progress ledger / files / mission table off Overview | PASS |
| S2 direct routing `?upload=…&review=unresolved` | PASS (`buildPrepareReviewRoute`) |
| Upload selection stays inside company/period boundary | PASS (`resolveActiveUpload` selects only from the workspace's own uploads; the param is a hint) |
| S3 telemetry re-homed to Prepare "Processing details", collapsed | PASS |
| Uploads/files still reachable in Prepare | PASS |
| S4 workpaper table, unresolved first, restrained decisions | PASS |
| Status semantics — zero false assurance | FAIL — see D2, D3 |
| Navigation language | FAIL — see D4 |
| No duplicated TIN surface | PARTIAL — see D5 |
| `AUTO_CLASSIFIED_CERTIFIED` absent | PASS (zero matches in repo) |
| S7 responsive 390/768/1024/1440 | PASS previously; re-verified after remediation |

## Defects to remediate (only these)

- **D1 — Zone 1 identity missing.** Add one quiet line at the top of `WorkspaceOverview`: `Arusha DC · FY2025` — small, muted, no card, no metadata wall. The blocking-TIN affordance stays exactly as it is.
- **D2 — False assurance in Overview copy.** "classified 135 safely" asserts assurance the state does not prove. Replace the detail line with neutral facts read from the same summary: `240 accounts processed · 135 classified/mapped · 105 require professional review`.
- **D3 — False assurance in the workbench.** `AccountReviewPanel` headline "Could not be classified safely" becomes `No reliable suggestion — classify`. Wording only; suggestion/evidence logic, pre-selection, exclusion semantics, the `confidence_source: "user_approved"` payload and the save path are untouched.
- **D4 — Engineering-console navigation.** `WorkspaceLayout` stage tabs render `OVW / PREP / RECON / STMTS / COMPLY / MON` and all-caps `PREPARE / RECONCILE / …`. Fix in the layout only, using the existing `config.label` in normal case ("Overview", "Prepare", "Reconcile", …). Below the label breakpoint a tab compresses to icon + status dot with `aria-label` and `title` carrying the full stage name — no cryptic abbreviation as canonical language. `stageMetadata.ts` is not modified; its `tabLabel`/`shortLabel` simply stop being consumed here.
- **D5 — Duplicate TIN surface.** The layout header renders a "TIN missing" chip on a narrower placeholder-only test while the Overview owns the blocking TIN exception. Remove the chip from the header; the Overview affordance (with `CompanyTinDialog`) remains the single TIN surface.
- **D6 — Registered defect, not fixed.** Record in project memory: `DEFECT-CLASSIFICATION-PROVENANCE-001` — existing `confidence_source = "user_approved"` may conflate manual classification with approval of a system-generated suggestion. No backend or payload change.

## Files

Changed: `src/pages/workspace/WorkspaceOverview.tsx` (D1, D2), `src/components/AccountReviewPanel.tsx` (D3 copy only), `src/pages/workspace/WorkspaceLayout.tsx` (D4, D5), plus the memory entry for D6.

Not changed: `stageMetadata.ts`, `deriveWorkspaceState.ts`, `computePreflight.ts`, `resolveActiveUpload.ts`, `PrepareWorkspace.tsx` (already correct), `App.tsx`, `src/integrations/supabase/*`, all migrations, all Edge Functions, `OnboardingFlow.tsx` and `TrialBalanceProgressLedger.tsx` (retained, already re-homed), landing-page files.

## Verification before certifying

`git diff --check`, conflict-marker scan across `src` and `supabase`, `npm run build`, `bunx vitest run`, plus the 20 required checks: single dominant CTA on the Overview, no duplicate workflow presentation, no OnboardingFlow/progress ledger on Overview, Processing details present in Prepare, uploads reachable in Prepare, valid TIN absent from the Overview, direct unresolved routing with `companyId`/`periodYear` preserved and the upload pin unable to cross the workspace boundary, unresolved filter active, save semantics unchanged, no classification/engine/database change, no horizontal overflow and readable stacked workpaper at 390/768/1024/1440, no false-assurance terminology, no `AUTO_CLASSIFIED_CERTIFIED`, change set limited to the authorised files.

Live Arusha DC proof runs if an authenticated preview session is available; otherwise those specific items report `NOT VERIFIED — AUTH SESSION REQUIRED` rather than failing the chapter.

## Final report

One report covering A–AC as specified, ending in either `Ω∞ NORTH STAR UI CHAPTER CERTIFIED AND FROZEN` or `BLOCKED — <evidence>`. S5/S6 and blockers B1, B2, B3, B5 plus `DEFECT-MAONO-001` are listed as **NEXT ARCHITECTURAL CHAPTER — NOT IMPLEMENTED**, with no proposal to begin them.