# Lovable Prompt — Kinga Phase 3 Activation

---

## CONTEXT

This project is **Axiom** — a Tanzania tax compliance SaaS for CPA firms. The core engine is called **Kinga** and it automatically detects statutory underpayments (SDL, NSSF, NHIF, WHT, VAT, TRA assessments) by reading a company's trial balance and running it through verified statutory rules.

The Supabase project is **INACTIVE/PAUSED**. Please restore it and apply all pending work described below.

---

## TASK 1 — RESTORE SUPABASE PROJECT

The Supabase project (`zoinoezmxtmxrfcsqcte`) is paused. Please restore it so the database and edge functions are active again.

---

## TASK 2 — APPLY THESE MIGRATIONS IN ORDER

Apply the following SQL migrations to the Supabase database. Run them in the exact order listed.

---

### Migration A — `20260626200000` — Payroll account flag

```sql
BEGIN;
ALTER TABLE public.account_mappings
  ADD COLUMN IF NOT EXISTS is_payroll_account BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN public.account_mappings.is_payroll_account IS
  'SDL base flag. Set TRUE for gross emolument accounts (salaries, wages, allowances). '
  'SDL (CAP 441) = 3.5% x gross emoluments. '
  'Do NOT set TRUE on NHIF, NSSF, WCF, SDL expense, rent, utilities, depreciation.';
COMMIT;
```

---

### Migration B — `20260627110000` — Tax payments table (closes OD-1)

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS public.tax_payments (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  tax_category      TEXT          NOT NULL,
  period_year       INTEGER       NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  period_month      INTEGER       NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  amount_paid_tzs   NUMERIC(18,2) NOT NULL CHECK (amount_paid_tzs >= 0),
  payment_date      DATE          NOT NULL,
  payment_reference TEXT          NULL,
  payment_source    TEXT          NOT NULL DEFAULT 'preparer_declared'
                    CHECK (payment_source IN ('preparer_declared','efdms_matched','tra_receipt')),
  notes             TEXT          NULL,
  created_by        UUID          NOT NULL REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_payments_company_category_period
  ON public.tax_payments (company_id, tax_category, period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_tax_payments_company_id
  ON public.tax_payments (company_id, period_year DESC, period_month DESC);
ALTER TABLE public.tax_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tax_payments_select" ON public.tax_payments FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.user_id = auth.uid() AND fm.company_id = tax_payments.company_id));
CREATE POLICY "tax_payments_insert" ON public.tax_payments FOR INSERT
  WITH CHECK (auth.uid() = created_by AND EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.user_id = auth.uid() AND fm.company_id = tax_payments.company_id));
CREATE POLICY "tax_payments_update" ON public.tax_payments FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.user_id = auth.uid() AND fm.company_id = tax_payments.company_id));
CREATE POLICY "tax_payments_delete" ON public.tax_payments FOR DELETE
  USING (created_by = auth.uid());
COMMENT ON TABLE public.tax_payments IS
  'Records of statutory payments made per tax category per period. '
  'Used by kinga-findings-engine Step C3 to compute net variance (gross_obligation - amount_paid).';
COMMIT;
```

---

### Migration C — `20260627120000` — finding_category column + OD-13 dedup index

```sql
BEGIN;
ALTER TABLE public.findings
  ADD COLUMN IF NOT EXISTS finding_category TEXT NULL;
COMMENT ON COLUMN public.findings.finding_category IS
  'Statutory category for this finding. '
  'For rule_trigger findings: matches statutory_rules.trigger_category (e.g. sdl, wht_undistributed_earnings). '
  'For statutory_payable findings (Module C): e.g. sdl_outstanding, nssf_outstanding, tra_assessment. '
  'NULL for manual and efdms_diff findings.';
CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_payable_per_period
  ON public.findings (company_id, finding_category, period_start, period_end)
  WHERE statutory_rule_id IS NULL AND finding_type = 'statutory_payable';
COMMIT;
```

---

## TASK 3 — DEPLOY EDGE FUNCTIONS

Deploy these two Supabase edge functions from the repository. The updated source files are already committed to the GitHub repo (`hirorobert/axiom-insight-craft`, branch `main`):

### `supabase/functions/kinga-findings-engine/index.ts`
**Version: Module B+C v2.1**
Key changes from previous version:
- Universal account detection by name patterns (no manual flags required for standard account names)
- Step C3: queries `tax_payments` table, deducts declared payments from gross obligation, computes net variance
- Penalty estimate at TAA 2015 s.76 rate (5% per month on unpaid tax × months overdue)
- Module C (statutory payables detector) now writes `finding_category` column correctly
- Dedup guard on 23505 covers both Module B (rule-based) and Module C (payable-based) findings

### `supabase/functions/process-trial-balance/index.ts`
**Version: v2.0 — Universal Ingestion**
Key changes from previous version:
- **XLSX support** via SheetJS — accepts Excel files not just CSV
- **Generic column detection** — auto-detects debit/credit/balance/account columns from any header layout
- **Auto-classification** — classifies unmapped accounts by account name using 100+ semantic patterns (covers QuickBooks, Sage, Tally, manual Excel, Swahili account names, GFS codes)
- **CRITICAL BUG FIX**: `processing_result` JSONB structure now matches what `kinga-findings-engine` reads:
  - Old (broken): `pr.mapping.incomeStatement.operatingExpenses`
  - Fixed: `pr.statements.income_statement.operating_expenses.accounts` + `.total`
  - This was causing the engine to find no data on all real uploads

---

## TASK 4 — ADD NEW UI COMPONENT

Add the file `src/components/KingaFindingsPanel.tsx` from the repo to the project. This is a React component that provides:

- **"Run Analysis" button** — calls `kinga-findings-engine` with `dry_run: true` first, shows a colour-coded preview of all findings before saving
- **Findings preview** — expandable rows per finding showing: base amount, gross obligation, declared paid, net variance, estimated penalty, total exposure, months overdue
- **Colour coding** — critical (≥50M TZS), high (≥10M), medium (≥1M), low
- **"Commit Findings" button** — user reviews preview and confirms before anything is saved to DB
- **Live findings table** — shows committed findings from DB below the panel
- **Module C payables section** — shows outstanding statutory payables detected from balance sheet (TRA assessments, NSSF arrears, SDL outstanding, etc.)

Integrate this component into the company dashboard page. It should appear after the trial balance upload section. It requires these props:
```typescript
<KingaFindingsPanel
  companyId={company.id}
  uploadId={latestUpload.id}
  periodYear={2025}
  periodMonth={12}
  companyName={company.name}
/>
```

---

## TASK 5 — VERIFY EVERYTHING IS WORKING

After applying migrations and deploying functions, please verify:

1. `tax_payments` table exists with RLS enabled
2. `findings.finding_category` column exists
3. `uq_statutory_payable_per_period` index exists
4. `uq_finding_per_rule_per_period` index exists (from earlier migration)
5. Both edge functions deploy without error
6. `KingaFindingsPanel` component renders in the dashboard without TypeScript errors

---

## TECHNICAL NOTES

- Supabase project ref: `zoinoezmxtmxrfcsqcte`
- GitHub repo: `hirorobert/axiom-insight-craft`, branch `main`
- All migration files exist in `supabase/migrations/`
- All edge function files exist in `supabase/functions/`
- The `account_mappings` table is keyed by `user_id` (NOT `company_id`) — this is intentional
- The `findings` table has a trigger `enforce_verified_statutory_rule` that validates inserts — Module C findings bypass it correctly by using `finding_type = 'statutory_payable'` with `statutory_rule_id = NULL`
- The `statutory_rules` table has only one verified rule currently: SDL (trigger_category = 'sdl'). WHT rule exists but `verified_at` is NULL — engine skips unverified rules by design.

---

## END STATE

When complete, a CPA preparer can:
1. Upload a trial balance (XLSX or CSV, any format)
2. System auto-classifies all accounts by name
3. Click "Run Analysis" in the dashboard
4. See a colour-coded preview of all statutory gaps with net amounts and penalty estimates
5. Click "Commit" to save findings
6. Review findings panel showing SDL gap, outstanding payables (TRA assessments, NSSF arrears, etc.) with total exposure including estimated TAA penalties
