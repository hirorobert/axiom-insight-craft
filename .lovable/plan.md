# Amended Phase 0 Report — Ω∞ North Star Workspace Reconstruction

All eight mandatory corrections are accepted. Every claim below is backed by a live schema/data query or a file read performed before writing this report. No code has been modified.

## A. Authoritative vs derived entity context

`public.companies` columns (queried): `id, user_id, name, code, description, industry, fiscal_year_end, currency, is_active, created_at, updated_at, reporting_framework, tin`.

There is **no** authoritative sector, entity_type, legal_form, or jurisdiction column anywhere in the schema. `industry` is free text and NULL for Arusha DC. So:

- `reporting_framework = 'ipsas_accrual'` is **one evidence source only**, not sector identity. The earlier claim is withdrawn.
- `EntityContext` is therefore **DERIVED, NOT AUTHORITATIVE**, and must be labelled that way in code, in the audit record, and in the UI.

Derivation precedence (highest first): explicit entity type/sector (does not exist yet) → reporting framework → jurisdiction/legal form (does not exist yet) → account vocabulary and source-file metadata → resulting confidence. With only tier 2 and tier 4 available today, derived sector confidence can never exceed `medium`, and `medium` derived sector may support REVIEW_SUGGESTED but **never** AUTO_CLASSIFIED_CERTIFIED.

Consequence: certified auto-classification requires an explicit, persisted, user-confirmed sector/entity type. That makes the migration answer YES (see J).

## B. Period-aware reporting-standard rules

The classifier must key its vocabulary and basis to the period, not to a static IPSAS dialect:

```text
period_start < 2026-01-01  → IPSAS 9 / 11 / 23 basis (exchange / non-exchange distinction)
period_start >= 2026-01-01 → IPSAS 47 Revenue (binding-arrangement distinction)
                             IPSAS 48 Transfer Expenses where applicable
early_adoption flag        → overrides the date test, must be explicitly recorded, never inferred
```

Rules carry a `standard_basis` field resolved at classification time (e.g. `IPSAS 23` for FY2025, `IPSAS 47` for FY2026+). "Exchange / non-exchange" wording is data on a rule, never hard-coded in the engine. There is currently no `early_adoption` storage — until one exists, early adoption is unavailable and must not be assumed.

## C. Three-state classification outcome model

Replaces the earlier two-state proposal.

| Outcome | Condition | Human action | Record |
| --- | --- | --- | --- |
| `AUTO_CLASSIFIED_CERTIFIED` | explicit sector + framework + period resolved, single matching certified rule, normal balance compatible, all negative tests pass, no competing rule | none | rule id, version, standard basis, evidence, actor, reversible via existing correction workflow |
| `REVIEW_SUGGESTED` | strong but incomplete evidence (derived sector, or rule matched with one missing corroborator) | confirm or change | suggestion + reason + confidence |
| `UNRESOLVED` | conflicting, insufficient, or no rule | classify | reason string |

Only the last two enter the workbench. Certified rules are deterministic, explainable, framework-aware, period-aware, auditable, reversible, and covered by positive **and** negative tests. No ML, no probability thresholds, no silent acceptance.

## D. Enum consumer graph — result: **B, authoritative presentation taxonomy. This is a blocker.**

Traced in `process-trial-balance/index.ts`: the enum value is the **key** of the emitted statement object — `processing_result.statements.income_statement.operating_expenses.accounts / .total`, and the same for `balance_sheet`. Consumers of those keys: `ExportStatements.tsx`, `MappingSourcePreview.tsx`, `AccountReviewPanel.tsx`, `AccountMappingManager/Modal.tsx`, `PeriodClosingBalancesPanel`, `computeComplianceScore.ts`, `kinga-findings-engine`, `generate-management-letter`, `maono-compute`, `maono-cashflow`, `maono-decide`.

So `account_classification` is not a coarse internal class — it **is** the financial-statement taxonomy. Forcing local-government IPSAS presentation (taxes, transfers, grants/subventions, employee costs, goods and services, net assets) through `revenue / cost_of_goods_sold / operating_expenses / equity` would produce an IFRS-shaped statement for a public-sector entity. Reporting this limitation and stopping, per correction 6.

Incidental finding: `maono-compute` and `maono-cashflow` read a table `account_classifications` that does not exist in the schema. Pre-existing defect, out of scope, logged.

## E. Server-authority rule boundary

One implementation only. `process-trial-balance` (server) is the sole classifier and sole writer. The frontend renders `classification`, `line_item`, `standard_basis`, `outcome`, `confidence`, `reason`, `provenance` from the server payload and never re-runs accounting rules. The previously proposed `src/lib/accounting/entityContext.ts` mirror is **withdrawn**; any shared code lives only under `supabase/functions/_shared`.

## F. Positive and negative rule strategy

Every rule is a conjunction, never a token match:

```text
IF sector evidence sufficient for the intended outcome
AND account semantics match the rule's phrase set
AND normal balance is compatible with the target classification
AND no exclusion term present
AND code hierarchy / prior confirmed mapping does not contradict
AND exactly one rule matches
THEN auto-classify (certified) ELSE suggest ELSE unresolved
```

Exclusion vocabulary (blocks naive revenue/expense): fund, fund balance, payable, receivable, reserve, deferred, retention, deposit, advance, clearing, suspense, control, accrual, prepaid, provision, contra, surplus, equity, net assets. Sign is corroborating evidence only — never determinative in either direction. Negative tests are mandatory per rule.

## G. Breakdown of the 105 unresolved accounts (live query, upload `c8a8ede6…`)

Summary block: 240 accounts, 135 auto-classified, 105 needs_review. 104 have `confidence_source = null` (tier-6 fall-through: no company mapping, no global mapping, no dictionary hit, no rule hit); 1 is `dictionary_contains_conflict`.

| Group | Count | Value (TZS bn) | Examples |
| --- | --- | --- | --- |
| G1 own-source revenue candidates (credit, fee/levy/royalty/grant vocabulary) | 19 | 74.20 | Levy -Service; User Fee; Forest Royalties; Market Fees and Charges |
| G2 public expenditure candidates (debit, PE/OC vocabulary) | 69 | 122.65 | Civil Servants; Extra-Duty; Honoraria; Food and Refreshment |
| G3 ambiguous fund constructs | 3 | 0.06 | Drug Revolving Fund - DRF; Community Health Fund - CHF/TIKA |
| G4 balance-sheet / exclusion-term hits | 5 | 2.20 | payable / reserve / deposit style names |
| G5 no rule, no vocabulary signal | 9 | 3.07 | miscellaneous |

Grouping is diagnostic only — it is a triage query, not a classifier, and no row here is treated as classified.

## H. Predicted human-review count after safe deterministic rules

Two scenarios, stated before any rule is written:

- **Without an explicit persisted sector** (derived context only, max confidence medium): 0 certified, ~88 REVIEW_SUGGESTED (G1+G2), ~17 UNRESOLVED (G3+G4+G5). Human touches stay ~105. This is exactly the failure mode the review identified, which is why the migration is now required.
- **With explicit confirmed sector + period basis + certified rules**: target 60–75 certified in G2 (PE/OC salary and operating vocabulary is the most deterministic set), 15–25 suggested, 15–20 unresolved → **expected human-review queue 30–45, driven to ~20–30 as the certified rule set is extended engagement by engagement.** Any rule that cannot pass its negative tests stays a suggestion rather than being promoted to hit a number.

## I. Exact files to change

UI slices (1–4, 7): `src/pages/workspace/WorkspaceOverview.tsx`, `src/pages/workspace/PrepareWorkspace.tsx`, `src/components/AccountReviewPanel.tsx`, `src/components/workspace/TrialBalanceProgressLedger.tsx` (re-home + collapse), `src/components/workspace/ui/Surface.tsx` (extend primitives only).

Server slices (not yet authorised): `supabase/functions/process-trial-balance/index.ts`, new `supabase/functions/_shared/entityContext.ts` and `_shared/publicSectorRules.ts`, plus Deno tests.

Must NOT change: `deriveWorkspaceState.ts`, `stageMetadata.ts`, `computePreflight.ts`, `src/integrations/supabase/client.ts` / `types.ts`, existing migrations, KINGA/HESABU/SAFISHA/XBRL functions, sign-off and gate triggers, `App.tsx` route table.

## J. Migration requirement — reassessed to **YES** (for the server-side work only)

The earlier "NO" is withdrawn. Certified auto-classification cannot rest on derived context, and the enum cannot express public-sector presentation. Minimum needed before Slice 6:

1. `companies`: explicit `sector`, `entity_type`, `jurisdiction`, plus provenance of who set them (user-confirmed, never inferred).
2. A presentation-taxonomy resolution for public-sector statements — either a `presentation_group` + `standard_basis` layer on `account_mappings` consumed by the statement builder, or a framework-aware statement section map. This is a schema design decision that must be settled before any rule is written.
3. Classification outcome + rule provenance fields (`outcome`, `rule_id`, `rule_version`, `standard_basis`, `evidence`) so certified decisions are auditable and reversible.

UI slices 1–4 and 7 require **no** migration.

## K. Revised atomic slices

Authorised to implement on approval (UI only, zero logic/data/route/permission change):

- **S1** Overview → three zones: quiet identity (TIN only when missing/invalid and blocking), one Current Decision surface with one dominant CTA, subordinate 7-stage path with lock reasons and zero CTA authority.
- **S2** Status → reason → action: the exception count itself navigates to exactly the unresolved set (pinned upload, unresolved-first filter).
- **S3** Re-home telemetry: `TrialBalanceProgressLedger` into Prepare behind a quiet "Processing details" disclosure; Files stay in Prepare. `OnboardingFlow` leaves the authenticated workspace.
- **S4** Exception workbench: compact workpaper table (Account · Balance · Suggested · Confidence/reason · Decision), unresolved first, stacked records under 768px, explicit exclusions.
- **S7** Responsive pass at 390 / 768 / 1024 / 1440 px.
- **S8a** UI regression: `npm run build`, `bunx vitest run`, conflict-marker scan, single-CTA assertion.

Held pending separate authorisation, in this order: **S5a** persist explicit sector/entity type (migration + confirmation UI) → **S5b** derived `EntityContext` with provenance, server-only → **S6a** presentation-taxonomy decision → **S6b** period-aware certified rule set with positive/negative tests → **S6c** three-state outcome plumbing and provenance → **S8b** accounting-invariant certification.

## L. Blockers

1. **B1 (hard)** `account_classification` is an authoritative presentation taxonomy, so IPSAS classification cannot be expressed within it. Blocks S6 until the taxonomy decision in J.2 is made.
2. **B2 (hard)** No persisted authoritative sector/entity type. Blocks `AUTO_CLASSIFIED_CERTIFIED` entirely.
3. **B3 (hard)** No early-adoption storage, so IPSAS 47/48 early adoption cannot be established for any engagement.
4. **B4 (medium)** `maono-compute` / `maono-cashflow` reference a non-existent `account_classifications` table — pre-existing, logged, out of scope.
5. **B5 (medium)** Live authenticated screenshot verification of the Arusha DC workspace still requires a signed-in Lovable preview session.

## Requested authorisation

Approve S1–S4 + S7 + S8a (UI only, no migration, no engine change) and I will implement those. S5/S6 stay blocked until B1–B3 are resolved, each needing its own decision from you.