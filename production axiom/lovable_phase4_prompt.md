# Lovable — Kinga Phase 4 Deployment
# Module E: ITA Corporate Tax Computation Engine
# ALL TASKS IN ONE SHOT — NO BACK AND FORTH

---

## RULES BEFORE YOU START

- Do NOT ask clarifying questions. Execute all tasks sequentially.
- Do NOT modify any existing migration files.
- Do NOT touch RLS policies on existing tables, storage, or auth settings.
- Do NOT address pre-existing linter warnings.
- After ALL tasks, produce ONE final verification report.
- Supabase project: `bvyivmmfjejbmqoydezk` (Lovable Cloud managed).

---

## TASK 1 — APPLY DB MIGRATION

Apply `supabase/migrations/20260628100000_tax_engine_schema.sql` to the database.

This migration:
- Creates `capital_allowances` table (ITA s.34 wear & tear asset register) with RLS
- Creates `tax_computations` table (ITA waterfall storage) without RLS (service role writes)

Do NOT skip or modify the migration. Apply it exactly as written.

---

## TASK 2 — DEPLOY EDGE FUNCTION

Deploy `supabase/functions/kinga-tax-engine/index.ts`.
- Function name must be exactly `kinga-tax-engine`.
- Do not modify the source file.

This function implements the full Tanzania ITA Chapter 332 corporate tax waterfall:
Accounting PBT → ITA add-backs (depreciation, entertainment, penalties, provisions, thin cap)
→ wear & tear deductions → taxable income → CIT 30% vs minimum tax 0.5% → gap → finding.

---

## TASK 3 — ADD KingaTaxPanel TO Dashboard.tsx

### Step A — Import

Add this import at the top of `src/pages/Dashboard.tsx` with the other component imports:

```typescript
import { KingaTaxPanel } from "@/components/KingaTaxPanel";
```

### Step B — Placement

In `src/pages/Dashboard.tsx`, find the existing `KingaFindingsPanel` block:

```tsx
{/* Kinga — Statutory Compliance Analysis */}
{selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (
  <KingaFindingsPanel
    companyId={selectedUpload.company_id}
    uploadId={selectedUpload.id}
    periodYear={new Date(selectedUpload.uploaded_at).getFullYear()}
    periodMonth={new Date(selectedUpload.uploaded_at).getMonth() + 1}
    companyName={selectedUpload.company_name ?? undefined}
    userId={user?.id ?? ""}
  />
)}
```

Immediately AFTER that closing `)}`, add:

```tsx
{/* Kinga — Corporate Tax Computation (ITA Chapter 332) */}
{selectedUpload.status === "complete" && selectedUpload.is_valid === true && selectedUpload.company_id && (
  <KingaTaxPanel
    companyId={selectedUpload.company_id}
    uploadId={selectedUpload.id}
    periodYear={new Date(selectedUpload.uploaded_at).getFullYear()}
    companyName={selectedUpload.company_name ?? undefined}
    userId={user?.id ?? ""}
  />
)}
```

### What this does:
- `KingaTaxPanel` appears below `KingaFindingsPanel` in the dashboard
- Same conditional gate: only on complete + valid uploads with a company
- `periodYear` derived from upload date (same logic as KingaFindingsPanel)
- `userId` from `useAuth` hook (already imported in Dashboard.tsx)

---

## TASK 4 — VERIFY EVERYTHING

Run these SQL checks and report results:

```sql
-- V1: Both new tables exist
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('capital_allowances', 'tax_computations')
ORDER BY tablename;
-- Expected: capital_allowances rowsecurity=true, tax_computations rowsecurity=false

-- V2: capital_allowances has RLS policies
SELECT policyname FROM pg_policies
WHERE tablename = 'capital_allowances'
ORDER BY policyname;
-- Expected: ca_delete, ca_insert, ca_select, ca_update

-- V3: tax_computations unique constraint
SELECT indexname FROM pg_indexes
WHERE tablename = 'tax_computations'
  AND indexname LIKE '%company_id%';
-- Expected: idx_tax_computations_company_year + unique constraint index

-- V4: kinga-tax-engine edge function deployed
-- (confirm via Lovable deployment log)

-- V5: No TypeScript errors in modified files
-- (confirm via build output)
```

### Code checks:
- [ ] `kinga-tax-engine` deployed ✅
- [ ] `capital_allowances` table with RLS ✅
- [ ] `tax_computations` table ✅
- [ ] `KingaTaxPanel` import added to Dashboard.tsx ✅
- [ ] `KingaTaxPanel` renders after `KingaFindingsPanel` ✅
- [ ] `AddCapAllowanceModal` (inside KingaTaxPanel.tsx) saves to `capital_allowances` ✅
- [ ] No TypeScript errors ✅
- [ ] No other files modified ✅

---

## END STATE

When complete, a CPA using the dashboard can:

1. Open any complete, valid trial balance in the dashboard
2. See the **Kinga — Corporate Tax (ITA Chapter 332)** panel below the statutory findings panel
3. Click **"+ Capital Allowance"** to enter the ITA asset register (computers, vehicles, plant, furniture, buildings — each with class-appropriate wear & tear rate)
4. Set **months overdue** (for TAA penalty estimate)
5. Click **"Run Tax Analysis"** → see the full ITA waterfall dry-run:
   - Accounting PBT
   - All auto-detected add-backs (depreciation, entertainment, penalties, provisions, excess mgmt fees, thin cap)
   - Wear & tear deductions by asset class
   - Taxable income
   - CIT 30% vs minimum tax 0.5% (with ITA s.65 flag if minimum tax applies)
   - Gap vs balance sheet provision
   - Estimated TAA penalty
   - Total exposure (colour-coded CRITICAL / HIGH / MEDIUM / LOW)
6. Click **"Commit Computation"** → waterfall saved to `tax_computations`, CIT gap finding created in `findings`

---

## TECHNICAL REFERENCE

- Supabase project: `bvyivmmfjejbmqoydezk`
- `findings` table trigger `enforce_verified_statutory_rule` is bypassed because `kinga-tax-engine` inserts with `finding_type = 'statutory_payable'` and `statutory_rule_id = NULL`
- CIT finding dedup: `uq_statutory_payable_per_period` index on (company_id, finding_category='corporate_tax', period_start, period_end)
- `KingaTaxPanel.tsx` already exists in `src/components/` — Lovable only needs to wire it into Dashboard.tsx
- `capital_allowances` RLS uses `firm_members` table (same pattern as `tax_payments`)
- Engine called via `supabase.functions.invoke("kinga-tax-engine", ...)` — NOT direct fetch
- ITA rates: Class 1=50%, 2=37.5%, 3=25%, 4=12.5%, 5=5% straight-line on cost
- Minimum tax: 0.5% of gross income (revenue total) per ITA s.65
- Thin cap: 70:30 debt:equity ratio. Excess interest = (excess debt / total debt) × total interest
- Penalty: 5%/month on unpaid tax per TAA 2015 s.76 (same as findings engine)
