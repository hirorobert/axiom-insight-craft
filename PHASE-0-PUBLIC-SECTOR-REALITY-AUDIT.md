# PHASE 0 — Public-Sector / Framework Intelligence Reality Audit

**Purpose:** Ground-truth map of what exists today in AXIOM Insight Craft before any
"public-sector intelligence layer" (source-system detection, framework classification,
MUSE/IPSAS rules, evidence ladders) is designed. Read-only research. No code changed.

**Scope note:** Multiple stale copies of this repo exist under
`.claude/worktrees/*` (e.g. `adoring-hamilton-a45fb7`, `inspiring-hamilton-e426fd`).
All citations below are from the actual working tree at
`C:\Users\user\axiom-insight-craft` unless stated otherwise.

---

## 1. Existing company/entity context fields

**Table:** `public.companies` — created `supabase/migrations/20260108144134_7cc71206-d9d5-47bd-a7a7-378d27630a52.sql:2-14`, extended by two later migrations. Full current schema (confirmed against generated types `src/integrations/supabase/types.ts:695-709`):

| Column | Type | Source migration |
|---|---|---|
| `id` | uuid PK | 20260108144134 |
| `user_id` | uuid | 20260108144134 |
| `name` | text | 20260108144134 |
| `code` | text | 20260108144134 |
| `description` | text | 20260108144134 |
| `industry` | text (free-form) | 20260108144134:8 |
| `fiscal_year_end` | text, default `'12-31'` | 20260108144134:9 |
| `currency` | text, default `'USD'` | 20260108144134:10 |
| `is_active` | boolean | 20260108144134 |
| `tin` | text, nullable | `20260707100000_companies_add_tin.sql:6` |
| `reporting_framework` | text, `NOT NULL DEFAULT 'ifrs_for_smes'`, CHECK-constrained | `20260701000001_companies_reporting_framework.sql:18-26` |
| `created_at`/`updated_at` | timestamptz | 20260108144134 |

**No** `entity_type`, `ownership`, `jurisdiction`, or `sector` columns exist anywhere (grepped `src/`, `supabase/migrations/` for these terms — no schema hits; the only `\bsector\b` matches are English-prose comments like "government / public sector" inside the reporting_framework migration comment and CompanyManager label text).

`industry` is a **free-text `<Input>`** field in the UI (`src/components/CompanyManager.tsx:370-375`, placeholder `"Technology"`) — not a controlled enum, and (confirmed by grep) **never read** by any classification, tax, or statement-generation logic. It exists purely as a display label.

---

## 2. `reporting_framework`

**Defined:** `supabase/migrations/20260701000001_companies_reporting_framework.sql:18-26` — column on `companies`, `TEXT NOT NULL DEFAULT 'ifrs_for_smes'`, CHECK-constrained to exactly 4 values:
`ifrs_for_smes | full_ifrs | ipsas_accrual | ipsas_cash`.

**Set (write):** Only one path — a manual `<Select>` in `src/components/CompanyManager.tsx:378-398`. `full_ifrs` and `ipsas_cash` options are `disabled` in the UI ("coming soon") — `CompanyManager.tsx:390,392`. There is **no automated inference** of this value anywhere; it is 100% preparer-chosen at company-settings time, defaulting to `ifrs_for_smes`.

The UI states "Cannot be changed after first report is generated" (`CompanyManager.tsx:396`) but **this is UI copy only — no code enforces it.** The `<Select>` is never disabled based on report/period state.

**Read (consumers):**
- `src/hooks/useWorkspaceData.ts:44,146` — fetched as part of `WorkspaceCompany`.
- `src/pages/workspace/FilingWorkspace.tsx:98` — passed to `ExportStatements`.
- `src/components/ExportStatements.tsx:255-288,327-339,957` — `getFrameworkConfig()` branches only on `ifrs_for_smes` / `ipsas_accrual`; any other value throws `"'{value}' is not a supported reporting framework"`. Comment at `ExportStatements.tsx:251-254`: *"This branching is intentional for two frameworks. When a third framework is added, refactor to Framework Adapter pattern per Priority 8. Do not add a third branch here."*
- `supabase/functions/generate-xbrl/index.ts:118,121-129` — `ipsas_accrual`/`ipsas_cash` trigger a hard `BLOCKED` (422) response: *"IRON DOME: IPSAS XBRL taxonomy not implemented."*
- `supabase/functions/generate-management-letter/index.ts:257` and `supabase/functions/generate-disclosure-notes/index.ts:590` — read the same field, default label `"IFRS for SMEs"`.

**⚠ Data-model inconsistency found:** `generate-xbrl/index.ts:107-109`, `generate-management-letter/index.ts:159`, and `generate-disclosure-notes/index.ts:519` all `SELECT ... reporting_framework FROM trial_balance_uploads`. But per the generated types (`src/integrations/supabase/types.ts:2676-2736`) and every migration found, **`trial_balance_uploads` has no `reporting_framework` column** — it only exists on `companies`. Either these three functions are silently getting `undefined`/falling through to the `?? "ifrs_for_smes"` default on every call (functionally masking the bug), or the live DB has a column that isn't reflected in migrations/types (schema drift). This needs verification against the live Supabase schema before any new framework logic is built on top of it.

**Second, parallel "framework" concept:** `fiscal_periods.accounting_basis` — `supabase/migrations/20260630100000_phase5a_period_registry.sql:60-61` — `TEXT NOT NULL DEFAULT 'IFRS'`, CHECK-constrained to `('IFRS', 'IPSAS', 'IFRS_SME', 'GAAP_TZ')`. This is a **different value set** from `companies.reporting_framework` (`ifrs_for_smes|full_ifrs|ipsas_accrual|ipsas_cash`), lives on a different table, and there is no code found that syncs the two. Any new framework-registry design must reconcile or deprecate one of these.

---

## 3. Industry/entity-type fields elsewhere

None beyond `companies.industry` (see §1). No entity-type, legal-form, or ownership-structure field exists on any table found in `supabase/migrations/`.

---

## 4. Onboarding / first-run setup flow

**No dedicated "FirstRunEngagement" component exists** (grepped for `FirstRunEngagement|first.run|onboarding|OnboardingFlow` — no such component name found).

The closest thing is a minimal gate inside `src/pages/Dashboard.tsx` — comment at `Dashboard.tsx:9`: *"shows a minimal onboarding screen only when the firm has zero companies"*, logic at `Dashboard.tsx:80,137`. This only decides routing (create-a-company vs. go-to-workspace); it does not walk the user through setting framework/currency/TIN/fiscal-year-end.

Company context (`reporting_framework`, `currency`, `tin`, `fiscal_year_end`, `industry`) is established **only** via `src/components/CompanyManager.tsx` (a settings CRUD modal), independently of any upload flow.

The upload flow itself (`src/components/TrialBalanceUpload.tsx`) enforces exactly **one** context gate — TIN:
- `isTinMissing()` check at `TrialBalanceUpload.tsx:19-23,290-299` blocks upload until a real TRA TIN (9-12 digits, not the `PUT-REAL-TRA-TIN-HERE` sentinel) is set.
- **No equivalent gate exists for `reporting_framework`, `currency`, or `fiscal_year_end`.** A company can upload trial balances indefinitely on the default `ifrs_for_smes` framework without ever being asked to confirm it.
- Marketing copy at `TrialBalanceUpload.tsx:190`: *"Export from Tally, QuickBooks, Sage or Excel — accounts with debit/credit columns"* — this is the **only** place these source-system names appear in the actual app UI; it's just copy, not a functional selector.

---

## 5. `process-trial-balance` edge function — classification logic

File: `supabase/functions/process-trial-balance/index.ts` (1261 lines). Current version tag `v2.2` (header `index.ts:3`).

**6-tier classifier**, `classifyAccountTiered()` at `index.ts:618-764`:

| Tier | Signal | Source |
|---|---|---|
| 1 | `account_mappings` — company-scoped, exact `account_code` | `index.ts:631-633` |
| 2 | `account_mappings` — company-scoped, normalized name (exact, then Levenshtein ≤2 fuzzy) | `index.ts:636-642` |
| 3 | `account_mappings` — global (`company_id IS NULL`), code then name | `index.ts:645-654` |
| 4a | `keyword_dictionary` — exact match | `index.ts:656-670` |
| 4b | `keyword_dictionary` — "contains", longest-match-wins, with conflict → `needs_review` and an "expense-over-asset" override (`index.ts:672-717`) | |
| 4c | `keyword_dictionary` — fuzzy on exact-type terms (≤2 edits) → always `needs_review` | `index.ts:719-737` |
| 5 | `AUTO_CLASSIFICATION_RULES` — ~60 hardcoded regex groups (English + Swahili) covering revenue/COGS/opex/payroll/statutory levies/BS lines | `index.ts:165-348` |
| 6 | `needs_review` (no guess) | `index.ts:759-763` |

**Signals used:** account **name** (regex/keyword/fuzzy match, English + Swahili terms like `mishahara`, `mapato`, `wadai`) and account **code** (exact-match only, never fuzzed — `index.ts:630`). Account **sign/balance** is used only for the "closing-stock rescue" heuristic (`index.ts:806-841`, reclassifies mis-signed inventory accounts to COGS) — not for primary classification. **No use of `company.industry`, `company.reporting_framework`, source-system, or any entity-context field anywhere in this file.**

Other notable behaviors:
- Auto-detects XLSX/CSV, generic column detection by header keyword scan (`detectColumns`, `index.ts:370-405`).
- Detects "audited accounts" workbooks (SCI+SFP sheet pairs) vs flat TBs, converts via `auditedAccountsAdapter.ts` (see §13).
- Trial-balance integrity (Dr=Cr, ±1 TZS tolerance) is the only **hard** block (`index.ts:1018-1045`); balance-sheet-equation failure is a soft warning that still allows statements/tax/export (`index.ts:1204-1210`).
- Writes `processing_result` JSONB to `trial_balance_uploads` (see §8).

---

## 6. `normalizeAccountName`

`src/lib/normalizeAccountName.ts:15-21` (full file, 22 lines):

```ts
export function normalizeAccountName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // strip punctuation
    .replace(/\s+/g, " ")    // collapse whitespace
    .trim();
}
```

That's the entirety of it — lowercase, strip all non-word/non-space chars (which also strips accented/non-ASCII letters per the file's own comment, `normalizeAccountName.ts:10-13`), collapse whitespace, trim. It has **no** stemming, no synonym handling, no language detection.

This function is duplicated **3 times** by design (documented, not accidental):
1. `src/lib/normalizeAccountName.ts` (browser)
2. `supabase/functions/process-trial-balance/index.ts:551-557` (Deno, inline copy — the module isn't exported so it can't be imported)
3. A SQL mirror via `regexp_replace` in `supabase/migrations/20260703100000_account_mappings_v2_and_keyword_dict.sql:97-103` (used only for one-time backfill, not real-time)

All three are kept in sync via a shared golden-fixture JSON `supabase/functions/_shared/normalize-golden.json`, tested from both sides (`src/lib/__tests__/normalizeAccountName.test.ts`, `supabase/functions/process-trial-balance/normalize.test.ts`).

---

## 7. `account_mappings` table

Created `supabase/migrations/20260122083339_f3490c3c-931f-4523-93e1-bd1a0bfdd294.sql:31-56`, substantially extended by `20260703100000_account_mappings_v2_and_keyword_dict.sql` and `20260703120000_account_mappings_account_key.sql`. Final schema (confirmed via `src/integrations/supabase/types.ts:64-124`):

| Column | Notes |
|---|---|
| `id`, `user_id`, `company_id` | `company_id` nullable → NULL means "global" mapping for that user |
| `account_code` | nullable (dropped NOT NULL in v2) |
| `account_name` | required |
| `normalized_account_name` | output of `normalizeAccountName()` |
| `account_key` | **generated column**: `COALESCE(account_code, normalized_account_name)` — `20260703120000:24-25`, exists so PostgREST `.upsert(..., {onConflict:'company_id,account_key'})` can target a full (non-partial) unique index |
| `statement` | enum `financial_statement`: `balance_sheet\|income_statement\|cash_flow` |
| `classification` | enum `account_classification` (13 values, §9) |
| `line_item` | free text display label |
| `normal_balance` | `debit\|credit` |
| `is_cash_account`, `is_retained_earnings`, `is_payroll_account` | booleans, drive downstream engine logic (cash-flow cash detection, SOCIE retained-earnings roll-forward, SDL payroll base) |
| `confidence_source` | text, default `'user_approved'`; documented values (`20260703100000:117-119`): `user_approved\|auto_classified\|keyword_dict\|fuzzy_match` |
| `approved_at`, `created_at`, `updated_at` | timestamps |

This is explicitly the **only** table the review/mapping UI writes to (`process-trial-balance` never writes to it — comment `index.ts:1099-1101`: *"account_mappings is NOT written here... The PART 4 review screen is the sole writer."*). It's a per-(company, account) explicit mapping cache — no framework, no source-system, no GFS-code column.

`keyword_dictionary` (sibling table, `20260703100000:135-159`) is a **global** English+Swahili term→classification lookup, ~160 seeded terms (`20260703110000_keyword_dictionary_seed.sql`), used at Tier 4 above. It intentionally excludes the three `cash_flow` classification values (`20260703100000:150-153`, comment: *"keyword lookup cannot reliably target cash flow sections from a GL name alone"*).

---

## 8. `trial_balance_uploads.processing_result` shape

Defined by the `ProcessingResult` interface in `supabase/functions/process-trial-balance/index.ts:107-120`:

```ts
interface ProcessingResult {
  status: "valid" | "invalid" | "blocked" | "needs_review";
  statements: Statements | null;   // balance_sheet/income_statement/cash_flow buckets
  validation_report: Record<string, unknown>;
  errors: ValidationError[];
  needs_review_accounts?: NeedsReviewAccount[];
  summary: {
    total_accounts: number;
    processed_at: string;
    parser_version: string;
    columns_detected: Record<string, string>;
    auto_classified: number;
  };
}
```

`Statements` (`index.ts:74-78`) = `{ balance_sheet: Record<class, {accounts[], total}>, income_statement: Record<class, {accounts[], total}>, cash_flow: Record<class,{accounts[],total}> | null }` — `cash_flow` stays `null` unless at least one account was actually classified into `operating_activities|investing_activities|financing_activities` (`index.ts:861-863,869`), which in practice almost never happens from the tiered classifier (keyword dictionary explicitly excludes those 3 classes — see §7 — and none of the `AUTO_CLASSIFICATION_RULES` target them either). **In practice `processing_result.statements.cash_flow` is essentially always null** — the real cash-flow statement is built downstream by `kinga-tax-engine`, not here (§11).

Column comment in the v2.2 header (`index.ts:13-16`) documents a **breaking shape change** from v1: old shape was `pr.mapping.incomeStatement.operatingExpenses` (array); current shape is `pr.statements.income_statement.operating_expenses.accounts` + `.total`. `ExportStatements.tsx:301-304` still has a back-compat shim (`processingResult?.mapping ?? statementsToMapping(processingResult?.statements)`), confirming the legacy shape may still exist in old rows.

---

## 9. `account_classification` enum

Defined `supabase/migrations/20260122083339_f3490c3c-931f-4523-93e1-bd1a0bfdd294.sql:14-28`. 13 values, unchanged since creation (no `ALTER TYPE ... ADD VALUE` found for this enum anywhere in `supabase/migrations/`):

```
current_assets, non_current_assets, current_liabilities, non_current_liabilities, equity,
revenue, cost_of_goods_sold, operating_expenses, other_income, taxes,
operating_activities, investing_activities, financing_activities
```

First 10 are BS/IS lines; last 3 are cash-flow-activity lines (rarely populated — see §8). This enum is entity/framework-agnostic — it is IFRS-shaped (assets/liabilities/equity/revenue/expenses) with no IPSAS-specific concepts (e.g. no "net assets", "controlled entity", "non-exchange revenue", "appropriations").

---

## 10. Financial statement generation

There is **no separate "generate-statements" edge function**. Statement generation happens inline inside `process-trial-balance`, function `aggregateStatements()` at `index.ts:768-874` — it walks the classified `RawAccount[]` and buckets each into the BS/IS/CF sections keyed by `account_classification`, computing per-section totals and total assets/liabilities/equity/revenue/expenses (`index.ts:855-863`).

Downstream, `hesabu-validate` (`supabase/functions/hesabu-validate/index.ts`) is a **post-generation, pre-sign-off validation gate**, not a generator — 12 cross-statement assertions H-01..H-12 (`index.ts:15-35`) checking SFP equation, IS derivations, and — critically — SCF/SOCIE consistency, which it reads from `computation_detail.scf_engine` / `.socie_engine` (i.e., from `tax_computations`, produced by `kinga-tax-engine` — not from `trial_balance_uploads.processing_result`). Its `hesabu_gate_before_signoff` trigger (per CLAUDE.md §4.6) enforces this passes before sign-off.

Input to the whole chain: `process-trial-balance` consumes the raw uploaded file; `hesabu-validate` and `kinga-tax-engine` consume `trial_balance_uploads.processing_result` + `tax_computations` rows.

---

## 11. Cash-flow generation

**Historical/statutory cash-flow statement:** generated inside `supabase/functions/kinga-tax-engine/index.ts:1174-1232` as `scfEngine` — a full **indirect-method** Statement of Cash Flows (operating/investing/financing sections, opening/closing cash reconciliation, tolerance-based reconciliation check). Explicitly tagged `ifrs_section: "IFRS for SMEs Section 7 — Statement of Cash Flows (indirect method)"` (`index.ts:1231`). It depends on `period_closing_balances` (prior-year snapshot, §15) for opening cash; when unavailable it self-flags `is_first_year_draft: true` and emits a mandatory CPA disclaimer (`index.ts:1209,1216-1218`). This is stored in `tax_computations.computation_detail.scf_engine`, consumed by `hesabu-validate` (H-06/H-07/H-08).

**This is hardcoded to IFRS-for-SMEs presentation and terminology** — no IPSAS cash-basis or IPSAS-accrual variant exists.

**Forecast cash-flow (separate concept):** `supabase/functions/maono-cashflow/index.ts` — a 13-week **rolling forecast** (not a statutory statement) derived from TB actuals + Tanzania statutory due-date calendar (PAYE/VAT/SDL/WHT), writes to `cashflow_forecasts` table. Unrelated to statement presentation; purely a treasury/liquidity tool, gated behind `MAONO_ENABLED` per CLAUDE.md §3.

`trial_balance_uploads.processing_result.statements.cash_flow` (the process-trial-balance-produced bucket) is effectively always `null` in practice (§8) — it is **not** the real source of the cash-flow statement.

---

## 12. Note/disclosure generation — NoteSynth

`src/components/NoteSynth.tsx` (frontend, 56-80+ lines read) is a thin UI wrapper — it calls `supabase.functions.invoke("generate-disclosure-notes", { body: { uploadId } })` (`NoteSynth.tsx:67-69`) and renders the returned `DisclosureNote[]`. Each note carries `sources: Array<"trial_balance"|"tax_computation"|"company_profile">` (`NoteSynth.tsx:37`) for audit-trail purposes.

Backend: `supabase/functions/generate-disclosure-notes/index.ts` — reads `trial_balance_uploads` (`index.ts:518-519,625,632`) and `tax_computations` (`index.ts:558-572`, noting `tax_computations` has no `period_month` column so period is derived from `fiscal_year_end`). Each note is tagged with its `sources[]` (`index.ts:129,185,234,267,307,345,386,407,441`) — `company_profile`-sourced notes and `tax_computation`/`trial_balance`-sourced notes are distinguished, giving basic provenance per note but not per-line-item.

**Movement-schedule concept:** only one hit found — a hardcoded note title *"MOVEMENT IN UNRELIEVED TAX LOSS POOL (ITA s.19)"* at `generate-disclosure-notes/index.ts:411`. This is a single canned paragraph, **not** a generalized movement-schedule engine (no PPE roll-forward, no receivables/payables movement schedule, no provisions movement schedule found anywhere in this function or elsewhere in the repo).

---

## 13. Comparative-year handling

This is more built-out than expected. Three layers:

1. **`fiscal_periods` registry** — `supabase/migrations/20260630100000_phase5a_period_registry.sql:36-69`. One row per company per year-end, with `prior_period_id` self-referencing FK (`:47`) chaining backward, `active_upload_id` pointer to the canonical valid TB for that period (`:50`, auto-promoted on `status='valid'` via trigger `promote_valid_upload_to_active`, `:189-206`), `status` lock (`open|locked|archived`, `:53-54`), and its own `accounting_basis` field (`IFRS|IPSAS|IFRS_SME|GAAP_TZ`, `:60-61` — see the framework-duplication warning in §2).
2. **`v_period_pairs` view** — `20260630100000:256-274` — one-query current+prior lookup, used by `kinga-comparative-engine`.
3. **`kinga-comparative-engine`** edge function (`supabase/functions/kinga-comparative-engine/index.ts`) — compares current vs prior TB: line-by-line movement table, retained-earnings reconciliation (IAS 1.106/IPSAS 1.89, cited in header `:1-25`), 3-year AMT revenue-trend risk, ECL movement, deferred-tax IS-vs-BS consistency. Auto-resolves `prior_period_id` from `fiscal_periods` if not supplied (`:19`).
4. **`auditedAccountsAdapter.ts` comparative-column support** — `supabase/functions/process-trial-balance/auditedAccountsAdapter.ts:408-515`, `parseAuditedAccountsComparative()` — detects two-year columns in an uploaded audited-accounts workbook (current/prior headers, or two adjacent 4-digit-year columns) and can split into `{ current, prior }` TB row sets in one parse. **Caveat:** the main `index.ts` handler (checked at `index.ts:966-989`) calls only `parseAuditedAccounts()` (v1, current-year-only) — the comparative v2 function exists but is **not wired into the main upload flow**; it appears to be built but not yet invoked end-to-end (no caller found outside its own file and no test).

`period_closing_balances` (§15) is the actual prior-year numeric snapshot consumed by `kinga-tax-engine` for SCF/SOCIE opening balances — a separate mechanism from the TB-vs-TB comparative engine above.

---

## 14. `AccountReviewPanel` — review/decision workflow

Full file read: `src/components/AccountReviewPanel.tsx` (384 lines).

- **Layout:** renders **all** `needsReviewAccounts` at once as a scrollable list of cards (`AccountReviewPanel.tsx:262-351`) — **no Previous/Next navigation, no pagination, no one-at-a-time review mode.**
- **Selection is draft-then-save, not immediately committed.** Choices live in local React state (`choices` map, `AccountReviewPanel.tsx:110`) via a `<Select>` per row (`:319-334`); nothing is written to Supabase until the single **"Save & Reprocess"** button is clicked (`:142-236`, `handleSaveAndReprocess`).
- Rows can be marked **"Exclude from import"** via checkbox (`:336-346`) instead of classified — excluded rows clear their pending choice (`:126-127`).
- The button is disabled until `allResolved` — every non-excluded row has a choice, or all rows are excluded (`:135-138,364`).
- On save: builds one row per pending account with `confidence_source: "user_approved"` (`:167`) and **upserts to `account_mappings`** on conflict target `company_id,account_key` (`:178-181`, the generated column from §7) — corrections always win (`DO UPDATE` is the default). Then resets the upload (`status:'processing', processing_result:null`) and re-invokes `process-trial-balance` (`:189-198`), polling every 2s for a terminal status with a 90s timeout (`:200-228`).
- Pre-selection: if the classifier already produced a `suggested_classification` (Tier 4c fuzzy match), it's pre-filled as the default choice (`:102-108`) but still requires the user to hit Save.

This is a **batch commit** UX pattern (review N rows, save once, full reprocess), not an incremental per-item review. Any "Evidence Ladder" or "Dry-run simulator" concept sitting on top of this would need to either replace this panel or be layered as a pre-step before it, since there is no per-row commit hook to intercept.

---

## 15. Prior-period storage

Two distinct mechanisms, neither is "prior periods' confirmed mappings":

1. **`period_closing_balances`** — `supabase/migrations/20260707183617_6cb7067f-cf11-49a5-bf6a-4948c6a2b08b.sql:33-73` (also re-declared in `20260707200000_iron_dome_nuclear_full.sql`). One row per `(company_id, period_year, period_month)`. Stores **numeric snapshot only**: SFP totals (current/non-current assets & liabilities, equity, cash), equity components (share capital, retained earnings, other reserves — for SOCIE roll-forward), deferred-tax closing position, cumulative unrelieved tax losses, and written-down-values per ITA wear-and-tear class 1-8. Written by `kinga-tax-engine` as a byproduct of each computation run (`upload_id`, `engine_version`, `computed_at` provenance columns at `:70-72`). This is what feeds `openingDataAvailable`/`openingBal` in the SCF/SOCIE engines (§11).
2. **`fiscal_periods.prior_period_id`** chain (§13) — links whole periods, and via `active_upload_id` can reach the prior period's full `trial_balance_uploads.processing_result` (including its `account_mappings`-derived classification), but this is an indirect path, not a dedicated "confirmed mappings" table.

**No table stores "prior periods' confirmed account mappings" as a first-class concept** — `account_mappings` itself has no period dimension; it's scoped only to `(user_id, company_id)` and is mutated in place (upsert), so a correction made this year silently changes what last year's classification would resolve to if reprocessed. There is no versioned/audited history of mapping decisions over time.

---

## 16. Source-system detection (MUSE, QuickBooks, Sage, Excel origin)

**Not implemented in shipped code.** Grepped `src/` and `supabase/functions/` for `source_system|sourceSystem|quickbooks|Sage` (case-insensitive):
- `src/components/ValidationReport.tsx:190` — one line of **marketing copy**: *"Export from Tally, QuickBooks, Sage or Excel — accounts with debit/credit columns"*. Not a functional detector.
- `supabase/functions/kinga-findings-engine/index.ts` — comments only (`:46,373,467,828`), describing the classifier as working "across QuickBooks, Sage, Tally, GFS, and manual charts of accounts" — this is a claim about the *regex classifier's* format-agnosticism, not an actual source-system detector/tagger. No field anywhere records which system a TB came from.

**A full source-adapter architecture is designed but not built**: `production axiom/kinga_universal_ingestion_architecture.md` (repo root, dated 2026-06-26, status "Phase 3 Design") proposes exactly this — a `RawAccount.source` field (`"quickbooks_csv"|"sage_xlsx"|"ocr_pdf"|...`, doc line 69), per-source `FormatAdapter`s (`QuickBooksAdapter`, `SageAdapter`, `TallyAdapter`, `GenericXLSXAdapter`, `OCRAdapter`, `WebFormAdapter` — doc lines 51-59), and a 4-tier classification engine including an LLM tier (Claude Haiku) for low-confidence names. **None of this is implemented**: no `classify-accounts` edge function exists (checked directory listing of `supabase/functions/` — 23 functions, none named this), and the account_mappings schema additions the doc calls for (`is_auto_classified`, `classification_confidence`, `classification_source`, `classification_tier` — doc lines 171-174) are **absent** from the actual table (confirmed against `types.ts:64-124`, §7). This doc is planning artifact only — treat as prior-art context, not as existing capability.

---

## 17. MUSE / GFS / IPSAS / public-sector-specific rules

- **"MUSE"** — zero matches anywhere in `src/`, `supabase/functions/`, or `supabase/migrations/`, and zero matches in the planning doc either. The concept does not exist in this codebase under that name.
- **"GFS" (Government Finance Statistics codes)** — mentioned only in the same design doc, `production axiom/kinga_universal_ingestion_architecture.md:13,190,192,224`, framed as an open, unsolved hard case: *"GFS codes with no descriptive name: The only genuinely hard case... Options: (1) Tier 3 LLM with code + GFS lookup table, (2) require account name column, (3) preparer provides name at upload time. Phase 3c."* Open Decision OD-16 (`doc:224`) proposes building an internal GFS lookup table from "PSASB Chart of Accounts v2021" — **not started**. Same phrase echoed in code comments only (never executed logic) at `supabase/functions/kinga-findings-engine/index.ts:46,373,467,828`.
- **"IPSAS"** — real, shipped, but framework-label-only: appears in the `reporting_framework` CHECK constraint (§2), in `CompanyManager.tsx` labels/options (`:29-30,391-392`), in `ExportStatements.tsx` statement-name mapping (§18 below), in `generate-xbrl`'s hard IPSAS-block (§2), and in the `kinga-comparative-engine` standards citation header. There is **no IPSAS-specific classification rule, no IPSAS chart-of-accounts pattern, and no IPSAS-specific statement line items** anywhere in `AUTO_CLASSIFICATION_RULES` or `keyword_dictionary` — the classifier is IFRS-shaped throughout (§9).
- **"public sector" / "LGA" / "local government"** — only prose (UI labels, migration comments); no functional LGA/public-sector logic, no GFRS chart-of-accounts seed (CLAUDE.md §12 mentions GFRS as a concept but no code implements it).

**Conclusion: there is no MUSE or IPSAS-specific rule engine today.** IPSAS support today = one dropdown value + a hardcoded 422 block on XBRL export + two changed statement header labels in `ExportStatements.tsx`. Everything else (classification rules, cash-flow engine, SOCIE engine, disclosure notes) is IFRS-for-SMEs-shaped and would silently mislabel an IPSAS entity's accounts if selected, since the classifier never branches on `reporting_framework`.

---

## 18. `confidence_source` / provenance fields

- **`account_mappings.confidence_source`** (text column, §7) — the only persisted provenance field. Values actually written: `"user_approved"` (only value ever written by app code — `AccountReviewPanel.tsx:167`). The migration comment (`20260703100000:117-119`) documents 4 intended values (`user_approved|auto_classified|keyword_dict|fuzzy_match`) but only `user_approved` is observed being written in the reviewed code paths.
- **In-flight (not persisted) provenance** — `process-trial-balance/index.ts`'s `TieredClassifyResult` type (`:102-104`) carries a richer, transient `confidence_source` at classification time: `"mapping"|"dictionary_exact"|"dictionary_contains"|"rule"` for classified accounts, plus `"dictionary_contains_conflict"|"dictionary_fuzzy"` reasons for needs-review accounts (`:660-763`). This is surfaced to the UI via `NeedsReviewAccount.confidence_source` (`:98`, rendered in the tooltip at `AccountReviewPanel.tsx:300-304`) but is **not written back to any table** for classified (non-review) accounts — once an account is auto-classified, the tier/confidence that produced it is discarded; only the final `line_item`/`classification` survive into `processing_result`.
- No `confidence` **score** (0.0-1.0 float) is persisted anywhere in shipped code — the design doc's `classification_confidence FLOAT` (§16) was never implemented. The shipped model is coarse and categorical (`"high"|"medium"` confidence enum, `index.ts:517-519`, itself barely used — nearly everything resolves to `"high"`).

---

## 19. Downstream consumers of classification output

**Frontend files reading `processing_result` / `processingResult`:**
`src/pages/workspace/FilingWorkspace.tsx`, `src/pages/workspace/PrepareWorkspace.tsx`, `src/pages/UploadStatus.tsx`, `src/lib/workspace/types.ts`, `src/hooks/useWorkspaceData.ts`, `src/components/certification/{types,TrialBalanceIntegrityCard,RecentUploadsList,ClassificationBreakdown,CertificationSummaryStrip,BalanceSheetEquationCard}.tsx`, `src/components/UploadsStatusPanel.tsx`, `src/components/MappingCoverageIndicator.tsx`, `src/components/ExportStatements.tsx`, `src/components/DashboardAnalytics.tsx`, `src/components/AccountReviewPanel.tsx`.

**Frontend files reading `account_mappings` directly:**
`src/components/MappingCoverageIndicator.tsx`, `src/components/ExportStatements.tsx`, `src/components/AccountReviewPanel.tsx`, `src/components/AccountMappingManager.tsx`.

**Backend (edge functions) reading `processing_result`:**
`supabase/functions/kinga-tax-engine/index.ts`, `supabase/functions/kinga-findings-engine/index.ts`, `supabase/functions/kinga-comparative-engine/index.ts`, `supabase/functions/generate-management-letter/index.ts`, `supabase/functions/generate-disclosure-notes/index.ts` (plus `process-trial-balance` itself, the writer).

**Panel components named in the prompt** — confirmed to exist: `src/components/KingaTaxPanel.tsx`, `src/components/KingaFindingsPanel.tsx`, `src/components/KingaComparativePanel.tsx`, `src/components/HesabuAssurancePanel.tsx` (not deep-read; listed per instructions).

Any change to the classification output shape (§8) or to what `confidence_source`/framework metadata is attached to a classified account has a wide, multi-file blast radius across both statement export and the three Kinga engines.

---

## 20. Existing tests

All test files found in the repo (excluding stale `.claude/worktrees/*` copies):

| File | Covers |
|---|---|
| `src/lib/workspace/deriveWorkspaceState.test.ts` | Pure workspace-state engine (14-path coverage per CLAUDE.md) — unrelated to classification |
| `src/lib/__tests__/computeComplianceScore.test.ts` | Compliance scoring — unrelated |
| `src/lib/__tests__/computeWearTear.test.ts` | ITA s.34 wear & tear rates — unrelated |
| `src/lib/__tests__/normalizeAccountName.test.ts` | `normalizeAccountName()` golden-fixture test (Vitest side) |
| `supabase/functions/process-trial-balance/normalize.test.ts` | Same golden fixture, Deno side — inlined copy, must be kept byte-identical manually (comment `:7-9`) |
| `supabase/functions/process-trial-balance/balanceSheetCheck_test.ts` | `checkBalanceSheetEquation()` — net-income-into-closing-equity arithmetic only |

**Gaps — nothing tests:**
- The 6-tier `classifyAccountTiered()` classifier itself (Tiers 1-6, `index.ts:618-764`) — no unit tests found despite extensive in-code comments referencing a `"classification.test.js"` regression suite (e.g. `index.ts:181-189,233,698`, `"Regression: classification.test.js test 1 (account 1030)"`) — **that file does not exist anywhere in the repo** (confirmed via filesystem search). Either it was deleted, never committed, or lives only in Lovable's own environment.
- `AUTO_CLASSIFICATION_RULES` regex library (60+ pattern groups) — no tests.
- `account_mappings` tiered lookup, fuzzy Levenshtein matching, keyword_dictionary longest-match-wins/conflict logic — no tests.
- `AccountReviewPanel` save/reprocess flow — no tests.
- `reporting_framework` branching in `ExportStatements.tsx` (`getFrameworkConfig`) — no tests.
- `kinga-tax-engine` SCF/SOCIE engines, `kinga-comparative-engine`, `hesabu-validate` assertions — no tests found.
- `auditedAccountsAdapter.ts` (SCI/SFP detection, comparative-column parsing) — no tests found despite being fairly complex heuristic parsing logic.

**Net:** test coverage exists only for small, pure, already-stable numeric utilities. All classification and framework-presentation logic — exactly the surface a new public-sector intelligence layer would touch — is currently untested.

---

## Companies & trial_balance_uploads — exact current schema (reference)

**`companies`** (assembled from `20260108144134:2-14` + `20260701000001:18-26` + `20260707100000:6`, cross-checked against `types.ts:695-709`):
```
id uuid PK · user_id uuid · name text · code text · description text · industry text
fiscal_year_end text default '12-31' · currency text default 'USD' · is_active boolean default true
tin text (nullable) · reporting_framework text NOT NULL default 'ifrs_for_smes'
  CHECK IN ('ifrs_for_smes','full_ifrs','ipsas_accrual','ipsas_cash')
created_at, updated_at timestamptz
```

**`trial_balance_uploads`** (assembled from `20251207114310:6-16` + `20251208084402:29` + `20260108144134:46-47` + `20260122083339:96-99` + `20260711162832/20260711200000:3-8` + `20260630100000:118-167`, cross-checked against `types.ts:2676-2736`):
```
id uuid PK · file_name text · file_path text · file_size int · status text default 'pending'
company_name text (legacy free-text) · company_id uuid FK→companies (nullable)
period_id uuid FK→fiscal_periods (nullable) · fiscal_year_end date (denormalized, trigger-synced)
period_year int (nullable) · user_id uuid FK→auth.users
uploaded_at, processed_at timestamptz
processing_result jsonb · validation_report jsonb · accounting_errors jsonb default '[]'
is_valid boolean · safisha_status text CHECK IN ('processing','needs_review','blocked','clean')
```
Note: per generated types, **no** `reporting_framework` column exists here — see the §2 discrepancy flag.

---

## Final classification table — proposed concepts vs. reality

| Proposed concept | Classification | Justification (from findings above) |
|---|---|---|
| **EntityAccountingContext** (unified company context object: framework, currency, TIN, industry, jurisdiction) | **EXTEND** | `companies` already has framework/currency/TIN/industry (§1) but no jurisdiction/entity-type/ownership. `WorkspaceCompany` (§2, `useWorkspaceData.ts:39-47`) is already a partial version of this — extend that type and its one query, don't invent a parallel context object. |
| **Framework Registry** (structured, extensible framework definitions) | **REPLACE** | Current "registry" is a 4-value CHECK constraint (§2) plus a 2-branch `if/else that throws` in `ExportStatements.tsx` (§2, explicitly commented as needing a "Framework Adapter pattern" refactor) plus a *second, inconsistent* `fiscal_periods.accounting_basis` enum (§2, §13). Two incompatible enums for the same concept on two different tables must be reconciled before extending — this is a replace, not a bolt-on. |
| **Source-System Profile** (detect MUSE/QuickBooks/Sage/Excel origin) | **BLOCKED** on design, otherwise greenfield | Zero implementation exists (§16). A full adapter design exists on paper (`kinga_universal_ingestion_architecture.md`) but its own schema additions were never built, and it targets a different problem (column-layout normalization + LLM tiering), not framework inference. Building this without first deciding how it interacts with the untested 6-tier classifier (§20) risks silently changing classification behavior for every existing user — treat as blocked pending a compatibility plan with §5's classifier. |
| **MUSE/IPSAS Rule Registry** (GFS codes, LGA chart of accounts, IPSAS-specific classification patterns) | **NOT FOUND — greenfield** | No MUSE code anywhere; GFS is an unsolved "open decision" in a design doc only (§17); `account_classification` enum and all classification rules are IFRS-shaped with zero IPSAS-specific line items (§9, §17). This is net-new work, not an extension of anything. |
| **Evidence Ladder** (weak→strong signal hierarchy for framework/entity inference, avoiding "government-owned ⇒ IPSAS" false inference) | **NOT FOUND — greenfield** | `reporting_framework` today is a single manual dropdown with zero inference of any kind (§2, §4) — there is no existing "weak signal" logic to harden or replace, so there's nothing to accidentally regress, but also nothing to build on. |
| **Comparative Engine** (prior-period diffing) | **REUSE** (mostly built) | `fiscal_periods` + `prior_period_id` chain + `v_period_pairs` view + `kinga-comparative-engine` (§13) already implement current-vs-prior TB comparison end-to-end, IAS 1/IPSAS 1-cited. Gap: `parseAuditedAccountsComparative()` exists but isn't wired into the main upload path (§13) — that's a small integration task, not new architecture. |
| **Dry-run simulator** (preview classification impact before committing) | **NOT FOUND — greenfield** | `AccountReviewPanel` is batch-commit only (choices staged in React state, then one irreversible Save & Reprocess — §14). No "preview the resulting statements before saving mappings" capability exists anywhere in the reviewed code. |
| **Audited Mapping Memory** (versioned history of confirmed mappings across periods) | **NOT FOUND — greenfield**, adjacent to REUSE for raw balances | `account_mappings` has no period dimension and is mutated in place (§7, §15) — a correction this year silently changes how a prior-year reprocess would resolve. `period_closing_balances` (§15) is a real, working prior-period *numeric* snapshot mechanism (reuse the provenance pattern: `upload_id`, `engine_version`, `computed_at`) but stores balances, not mapping decisions — the "memory of decisions" concept itself must be built new, ideally mirroring `period_closing_balances`'s provenance columns. |
| **Statement Presentation Mapping** (framework→label mapping for statement names/headers) | **EXTEND** | `ExportStatements.tsx:255-288` (`getFrameworkConfig`) already does exactly this for 2 frameworks, with an explicit code comment inviting a "Framework Adapter pattern" when a third is added (§2, §18). This is the cleanest, most direct extension point in the whole codebase for framework-aware presentation. |
| **Cash-Flow split engine** (statutory CF statement, framework-aware) | **EXTEND** (IFRS-only today) | A full indirect-method SCF already exists and works (`kinga-tax-engine`'s `scfEngine`, §11) — but it is hardcoded to IFRS-for-SMEs Section 7 language and structure, with no IPSAS cash/accrual variant. Extend this engine with framework branching rather than building a second cash-flow engine; `process-trial-balance`'s own `cash_flow` bucket (§8, §11) is effectively dead code and should not be the extension point. |
| **Disclosure/Movement Engine** (PPE roll-forward, receivables/payables movement schedules, general note automation) | **DEFER / mostly greenfield** | `generate-disclosure-notes` exists and produces framework-labeled notes with basic source provenance (§12) — reuse its scaffolding (note structure, `sources[]` provenance tagging) — but the only "movement" content today is one hardcoded tax-loss paragraph (§12). A general movement-schedule engine (PPE, receivables, provisions) does not exist and would need real design; defer until the Framework Registry and Evidence Ladder are settled, since movement presentation is framework-dependent (IPSAS notes differ structurally from IFRS notes). |
| **AccountReviewPanel Previous/Next rework** | **REPLACE** (of the navigation UX only; keep the save contract) | Current panel shows all `needs_review` rows in one scrollable list with a single batch "Save & Reprocess" (§14) — there is no per-row navigation to rework, so "Previous/Next" is a new interaction model layered on top of the existing draft-state (`choices`/`excluded` maps) and existing upsert-on-save contract to `account_mappings`. Keep the underlying save/reprocess mechanics (§14) unchanged; replace only the rendering/navigation shell. |
