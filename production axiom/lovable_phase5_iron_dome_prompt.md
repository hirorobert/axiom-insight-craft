# Axiom — Phase 5 "Iron Dome" Comparative Engine
# Date: 2026-06-30 | Standards: IAS 1 / IPSAS 1 / ITA Cap.332

---

## CONTEXT

Phase 4 built the single-period CIT tax engine.
Phase 5 adds the comparative layer — IPSAS 1 / IAS 1 require every
financial statement to show current year AND prior year side-by-side.
Without comparatives, position items (receivables, PPE, loans) cannot
be assessed for movement, deterioration, or consistency.

This is an 8-step deployment. Do them IN ORDER.

---

## STEP 1 — Run Phase 5A migration (Period Registry)

**File:** `supabase/migrations/20260630100000_phase5a_period_registry.sql`

Run in Supabase SQL editor. This creates:
- `fiscal_periods` table (one row per company per year-end date)
- Adds `period_id`, `fiscal_year_end`, `company_id` to `trial_balance_uploads`
- Adds `period_id` to `capital_allowances` and `tax_computations`
- Two triggers: sync fiscal_year_end on period_id set; promote valid upload to active
- View `v_period_pairs` (current + prior period in one query)

**Verify:**
```sql
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND tablename IN ('fiscal_periods','trial_balance_uploads')
ORDER BY tablename;
-- Expected: fiscal_periods rowsecurity=true

SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='trial_balance_uploads'
  AND column_name IN ('period_id','fiscal_year_end','company_id');
-- Expected: 3 rows
```

---

## STEP 2 — Run Phase 5C migration (Tax Losses)

**File:** `supabase/migrations/20260630110000_phase5c_tax_losses.sql`

Run in Supabase SQL editor. This creates:
- `tax_losses` table (ITA s.19 loss carry-forward register)
- Adds `loss_relief_applied_tzs`, `unrelieved_losses_bf_tzs`,
  `unrelieved_losses_cf_tzs`, `amt_3yr_trigger` to `tax_computations`
- View `v_loss_history` (5-year rolling AMT risk panel)

**Verify:**
```sql
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname='public' AND tablename='tax_losses';
-- Expected: rowsecurity=true

SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='tax_computations'
  AND column_name IN ('loss_relief_applied_tzs','amt_3yr_trigger');
-- Expected: 2 rows
```

---

## STEP 3 — Run Phase 5E migration (WDV Auto-Populate)

**File:** `supabase/migrations/20260630120000_phase5e_wdv_autopopulate.sql`

Run in Supabase SQL editor. This creates:
- DB function `carry_forward_wdv(company_id, from_year, to_year)`
  that auto-copies prior year `ita_wdv_closing_tzs` → current year
  `ita_wdv_opening_tzs` for each matched asset (by description + class)
- View `v_wdv_carry_forward` showing MATCHED / NEEDS_CARRY_FORWARD / OVERRIDDEN status

**Verify:**
```sql
SELECT routine_name FROM information_schema.routines
WHERE routine_schema='public' AND routine_name='carry_forward_wdv';
-- Expected: 1 row
```

---

## STEP 4 — Deploy AuditedAccountsAdapter v2.0

**File:** `supabase/functions/process-trial-balance/auditedAccountsAdapter.ts`

This file has been updated from v1.0 → v2.0. Changes:
- `parseSheet()` now detects BOTH current-year and prior-year numeric columns
  by scanning header rows for year labels ("2025"/"2024", "Current Year"/"Prior Year")
- NEW export: `parseAuditedAccountsComparative()` returns
  `{ current: TBRows[][], prior: TBRows[][], meta }` so a single Excel upload
  auto-registers both periods

Deploy as part of the process-trial-balance edge function update.

---

## STEP 5 — Deploy kinga-comparative-engine

**File:** `supabase/functions/kinga-comparative-engine/index.ts`

New edge function. Deploy it:
```bash
supabase functions deploy kinga-comparative-engine --no-verify-jwt
```

What it does:
- Accepts `{ company_id, current_period_id, prior_period_id? }`
- Resolves prior period automatically from `fiscal_periods.prior_period_id` if not supplied
- Loads `processing_result` JSONB from both period uploads
- Computes and returns:
  - **Income statement movements** (revenue, COGS, gross profit, expenses, PBT, PAT)
  - **Balance sheet movements** (assets, liabilities, equity — line by line)
  - **Key ratios** — both years (gross margin, net margin, current ratio, D/E, receivable days)
  - **Retained earnings reconciliation** (IAS 1.106 — opening RE = prior closing RE)
  - **AMT 3-year risk** (ITA s.65 — 3 consecutive loss years gates minimum tax)
  - **ECL movement** (IFRS 9 — receivables growing faster than revenue = deteriorating)
  - **Auto-generated findings** (material movements, RE gaps, AMT risk, margin decline)

---

## STEP 6 — Add fiscal_periods UI (Period Selector)

Add a **Period Selector** component to the upload flow. When a user uploads a TB:

1. Ask: "What period does this cover?" → Date picker for fiscal_year_end
2. Show dropdown: "Prior year" → autocomplete from existing fiscal_periods for this company
3. After VALID status: auto-set `active_upload_id` on fiscal_periods (trigger handles this)
4. Show "Prior year linked: FY2024 (Kamanga Medics)" confirmation badge

**Component:** `src/components/PeriodSelector.tsx`

Props:
```typescript
interface PeriodSelectorProps {
  companyId: string;
  onPeriodSelected: (periodId: string) => void;
}
```

State:
- `fiscalYearEnd: Date | null`
- `priorPeriodId: string | null`
- `periods: FiscalPeriod[]` (loaded from fiscal_periods table)

---

## STEP 7 — Add KingaComparativePanel

New panel in the Kinga tab, displayed alongside KingaTaxPanel.

**Component:** `src/components/KingaComparativePanel.tsx`

Layout (two-column table, IPSAS/IAS 1 style):

```
                          FY2025 (TZS)    FY2024 (TZS)    Change      %
═══════════════════════════════════════════════════════════════════════════
INCOME STATEMENT
Revenue / Turnover        9,396,638,868   8,200,000,000   +1,196,639  +14.6%  ✅
Cost of Goods Sold        3,821,206,509   3,200,000,000   +621,207     +19.4%  ⚠️
Gross Profit              5,575,432,359   5,000,000,000   +575,432     +11.5%  ✅
Operating Expenses        5,394,365,596   4,800,000,000   +594,366     +12.4%  ⚠️
Profit Before Tax           181,066,763     200,000,000    -18,933      -9.5%  ⚠️
Income Tax Charge            54,320,029      60,000,000     -5,680      -9.5%  ✅
Profit After Tax            126,746,734     140,000,000    -13,253      -9.5%  ⚠️

BALANCE SHEET
Total Assets              8,101,425,081   7,500,000,000   +601,425     +8.0%  ✅
  Trade Receivables          714,131,700     500,000,000   +214,132    +42.8%  🔴
  Cash & Bank              3,678,834,052   3,200,000,000   +478,834    +15.0%  ✅
Total Liabilities         5,930,011,166   5,600,000,000   +330,011     +5.9%  ✅
Total Equity              2,044,667,181   1,900,000,000   +144,667     +7.6%  ✅

KEY RATIOS
Gross Margin                      59.3%           61.0%     -1.7pp      ⚠️
Net Margin                         1.3%            1.7%     -0.4pp      ⚠️
Current Ratio                      2.6x            2.4x     +0.2x       ✅
Receivable Days                   27.7 days       22.3 days +5.4 days   🔴
```

Flags:
- ✅ ok (change < 10%, amount < TZS 10M)
- ⚠️ watch (change 10–20% OR amount TZS 10–50M)
- 🔴 material (change ≥ 20% OR amount ≥ TZS 50M)

Below the table, show collapsible sections for:
- **Retained Earnings Reconciliation** (IAS 1.106)
- **AMT 3-Year Risk Status** (ITA s.65)
- **ECL Adequacy** (IFRS 9)

---

## STEP 8 — Wire up "Run Comparative" button

In `KingaComparativePanel.tsx`, add a "Run Comparative Analysis" button that:
1. Calls `kinga-comparative-engine` with current + prior period IDs
2. Renders the movement table
3. Pushes any auto-generated findings to the findings table

Edge function call:
```typescript
const { data } = await supabase.functions.invoke('kinga-comparative-engine', {
  body: {
    company_id:        companyId,
    current_period_id: currentPeriodId,
    prior_period_id:   priorPeriodId,   // optional — engine resolves from chain
  }
});
```

---

## CURRENCY DISPLAY BUG (fix alongside this push)

The validation report is displaying `$` instead of `TZS`. Find every instance of
currency formatting in the validation report component and replace the currency
symbol from `$` / `USD` to `TZS`. Tanzania shilling has no decimal places
(integers only) — format as `TZS 17,371,317,215` not `TZS 17,371,317,215.00`.

Search for: `toFixed(2)` and `$` in the validation report component.
Replace with: `Math.round()` and `TZS ` prefix.

---

## WHAT PHASE 5 DOES NOT INCLUDE (Phase 6)

- Cash flow statement comparative (IPSAS 2 / IAS 7)
- Segment reporting comparatives (IFRS 8)
- Foreign currency translation differences (IAS 21)
- PDF export of the comparative report (deferred to Phase 5F)
- Multi-year trend chart (3–5 years) — deferred

---

## ENGINE VERSION STRINGS

After deployment, confirm in Supabase Edge Functions:
- `process-trial-balance` → `parser_version: "v2.2"`
- `kinga-tax-engine`       → `ENGINE_VERSION = "Module E v1.2"`
- `kinga-comparative-engine` → `ENGINE_VERSION = "Module F v1.0"`

---

## SUMMARY OF FILES CHANGED / CREATED

| File | Action |
|------|--------|
| `supabase/migrations/20260630100000_phase5a_period_registry.sql` | NEW |
| `supabase/migrations/20260630110000_phase5c_tax_losses.sql` | NEW |
| `supabase/migrations/20260630120000_phase5e_wdv_autopopulate.sql` | NEW |
| `supabase/functions/process-trial-balance/auditedAccountsAdapter.ts` | UPDATED v2.0 |
| `supabase/functions/kinga-comparative-engine/index.ts` | NEW |
| `src/components/PeriodSelector.tsx` | NEW (Lovable to build) |
| `src/components/KingaComparativePanel.tsx` | NEW (Lovable to build) |
