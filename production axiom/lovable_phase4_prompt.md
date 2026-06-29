# Lovable — Kinga Phase 4 Deployment
# Module E: ITA Corporate Tax Computation Engine
# ALL TASKS IN ONE SHOT — NO BACK AND FORTH
# Version: FINAL — constants verified against PwC Tanzania (Jan 2026) + Deloitte TZ (Aug 2025)

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

This migration creates:
- `capital_allowances` table — ITA s.17 (Third Schedule) wear & tear asset register, with RLS
  - Valid `ita_class` values: 1, 2, 3, 5, 6, 7, 8 (constraint: `CHECK (ita_class IN (1,2,3,5,6,7,8))`)
  - No Class 4 — Tanzania ITA does NOT have a Class 4
- `tax_computations` table — full ITA waterfall storage, without RLS (service role writes)
  - Unique constraint on `(company_id, upload_id)`

Do NOT skip or modify the migration. Apply it exactly as written.

---

## TASK 2 — DEPLOY EDGE FUNCTION

Deploy `supabase/functions/kinga-tax-engine/index.ts`.
- Function name must be exactly `kinga-tax-engine`.
- Do not modify the source file.

### What this function implements

Full Tanzania ITA Chapter 332 corporate tax waterfall (verified constants as of 2026-06-28):

**ITA s.34 Wear & Tear — VERIFIED (PwC Tanzania, reviewed 14 Jan 2026):**
| Class | Assets | Rate | Method |
|-------|--------|------|--------|
| 1 | Computers, data equip, automobiles, buses <30 pax, goods vehicles <7t, construction equip | 37.5% | Reducing balance |
| 2 | Buses ≥30 pax, heavy trucks, trailers, railroad, vessels, aircraft, ag/mfg plant & machinery | 25% | Reducing balance |
| 3 | Office furniture, fixtures, equipment; all other assets | 12.5% | Reducing balance |
| 5 | Agricultural/livestock/fish farming buildings & structures | 20% | Straight-line on cost |
| 6 | Commercial buildings & structures (all others) | 5% | Straight-line on cost |
| 7 | Intangible assets (patents, trademarks, licences, software) | 1 ÷ useful life (rounded down to nearest 0.5 yr) | Straight-line — CPA must confirm useful life |
| 8 | Agricultural plant & machinery; EFDs for non-VAT traders; minerals/petroleum exploration equip | 100% | Immediate write-off |

**CIT rate: 30%** — ITA s.4 (standard; engine uses standard rate)

**AMT: 1% of TURNOVER** — Only for companies with unrelieved losses for current + PRECEDING 2 INCOME YEARS
- NOT applied automatically — engine flags as warning and provides indicative figure
- Engine does NOT auto-apply AMT (cannot determine 3-year loss history from a single TB)
- NOT applied to profitable companies
- Source: PwC Tanzania (Jan 2026)

**Thin cap: 7:3 debt-to-equity (70:30 = 2.333:1)** — ITA s.12(2) (exempt-controlled entities only)
- CRITICAL: Debt owed to RESIDENT Tanzanian financial institutions is EXCLUDED from thin cap debt
- Engine computes upper-bound (includes all detected debt); flags for CPA review
- Source: Deloitte Tanzania Thin Cap (Aug 2025)

**Tax loss carry-forward: NO TIME LIMIT**
- Deductibility capped at 60% of taxable profits per year (non-ag/health/education)
- Source: PwC Tanzania (Jan 2026)

**Entertainment: NOT auto-disallowed**
- ITA s.11(2) potentially 100% disallows as "consumption expenditure"
- Engine flags for CPA review with accounts found
- CPA must determine disallowance % based on documentation

**Classification warnings:**
- Engine returns `classification_warnings[]` — array of items requiring CPA attention
- Each warning has: `category`, `message`, `accounts_found[]`, `action_required`
- These appear as orange review boxes in the KingaTaxPanel above the waterfall

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

Immediately AFTER that closing `)}`, insert:

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
- `KingaTaxPanel` appears directly below `KingaFindingsPanel` in the dashboard
- Same conditional gate: only on complete + valid uploads with a company_id
- `periodYear` derived from upload date (same logic as KingaFindingsPanel)
- `userId` from `useAuth` hook (already in scope in Dashboard.tsx)
- `KingaTaxPanel.tsx` already exists in `src/components/` — only Dashboard.tsx needs to be updated

---

## TASK 4 — VERIFY EVERYTHING

Run these SQL checks and report results:

```sql
-- V1: Both new tables exist with correct RLS settings
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('capital_allowances', 'tax_computations')
ORDER BY tablename;
-- Expected:
--   capital_allowances  | rowsecurity=true
--   tax_computations    | rowsecurity=false

-- V2: capital_allowances has correct RLS policies
SELECT policyname FROM pg_policies
WHERE tablename = 'capital_allowances'
ORDER BY policyname;
-- Expected: ca_delete, ca_insert, ca_select, ca_update

-- V3: capital_allowances ita_class CHECK constraint uses (1,2,3,5,6,7,8) — not BETWEEN 1 AND 5
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.capital_allowances'::regclass AND contype = 'c';
-- Expected: CHECK (ita_class = ANY (ARRAY[1,2,3,5,6,7,8])) or equivalent

-- V4: tax_computations unique constraint on (company_id, upload_id)
SELECT indexname FROM pg_indexes
WHERE tablename = 'tax_computations'
  AND indexname LIKE '%company_id%';
-- Expected: at least one index referencing company_id

-- V5: kinga-tax-engine edge function deployed
-- Confirm via Lovable deployment log

-- V6: No TypeScript errors in modified files
-- Confirm via build output
```

### Code checks:
- [ ] `kinga-tax-engine` deployed ✅
- [ ] `capital_allowances` table with RLS (4 policies: ca_select, ca_insert, ca_update, ca_delete) ✅
- [ ] `tax_computations` table, no RLS, unique on (company_id, upload_id) ✅
- [ ] `KingaTaxPanel` import added to Dashboard.tsx ✅
- [ ] `KingaTaxPanel` renders after `KingaFindingsPanel` ✅
- [ ] `AddCapAllowanceModal` inside `KingaTaxPanel.tsx` shows 7 ITA classes (1,2,3,5,6,7,8 — no Class 4) ✅
- [ ] No TypeScript errors ✅
- [ ] No other files modified ✅

---

## END STATE

When complete, a CPA using the dashboard can:

1. Open any **complete + valid** trial balance in the dashboard
2. See the **Kinga — Corporate Tax (ITA Chapter 332)** panel below the statutory findings panel
3. Click **"+ Capital Allowance"** to enter the ITA asset register. The class selector shows verified classes and rates:
   - Class 1: Computers, automobiles, buses <30 pax, construction equip (37.5% RB)
   - Class 2: Heavy vehicles, vessels, aircraft, ag/mfg plant (25% RB)
   - Class 3: Furniture, fixtures, equipment; all other assets (12.5% RB)
   - Class 5: Agricultural/livestock buildings (20% SL on cost)
   - Class 6: Commercial/industrial buildings (5% SL on cost)
   - Class 7: Intangible assets — patents, trademarks, licences, software (1÷useful life SL — CPA specifies useful life)
   - Class 8: Agricultural plant & machinery; EFDs; minerals/petroleum exploration equip (100% immediate)
4. Set **months overdue** for TAA penalty estimation
5. Click **"Run Tax Analysis"** → see the full ITA waterfall dry-run:
   - Accounting PBT
   - Auto-detected add-backs: depreciation, fines/penalties, provisions, thin cap (upper-bound)
   - Orange **CPA Review** boxes for: entertainment (potentially 100% disallowed), charitable donations (2% of taxable income cap), thin cap (exclude local bank debt), AMT eligibility (3-year loss history required), any undetected categories
   - Wear & tear deductions by ITA class from the capital_allowances register
   - Taxable income
   - CIT at 30%; AMT at 1% of turnover (indicative only — shown but NOT applied unless CPA confirms 3-year loss history)
   - Gap vs balance sheet income tax provision
   - Estimated TAA penalty (5%/month × months overdue)
   - Total exposure: CRITICAL (≥50M) / HIGH (≥10M) / MEDIUM (≥1M) / LOW
6. Click **"Commit Computation"** → ITA waterfall saved to `tax_computations`, CIT gap finding created in `findings`

---

## TECHNICAL REFERENCE (do not deviate)

- Supabase project: `bvyivmmfjejbmqoydezk`
- `findings` table trigger `enforce_verified_statutory_rule` is bypassed because `kinga-tax-engine` inserts with `finding_type = 'statutory_payable'` and `statutory_rule_id = NULL`
- CIT finding dedup: `uq_statutory_payable_per_period` on (company_id, finding_category, period_start, period_end) — already exists from Phase 3 migration
- `KingaTaxPanel.tsx` already exists in `src/components/` — do NOT recreate it
- `capital_allowances` RLS uses `firm_members` table (same pattern as `tax_payments`)
- Engine called via `supabase.functions.invoke("kinga-tax-engine", ...)` — NOT direct fetch
- ITA VERIFIED RATES (do not use old rates):
  - Class 1 = 37.5% RB (NOT 50%)
  - Class 2 = 25% RB (NOT 37.5%)
  - Class 3 = 12.5% RB (NOT 25%)
  - Class 5 = 20% SL on cost (agricultural buildings — NOT 5%)
  - Class 6 = 5% SL on cost (commercial buildings — NEW)
  - Class 8 = 100% immediate (agricultural plant — NEW)
  - NO Class 4
- AMT = 1% of TURNOVER, only if 3 consecutive loss years (NOT 0.5%, NOT always applied)
- Thin cap = 7:3 (2.333:1); local bank debt EXCLUDED from thin cap debt definition
- Penalty = 5%/month on unpaid tax (TAA 2015 s.76)
- Engine version in code: `"Module E v1.2"`
