# Axiom — Phase 4 v2 Deployment Prompt (Second Push)
# Date: 2026-06-30 | Engine: Module E v1.2 | TB Parser: v2.1

---

## CONTEXT

Phase 4 v1 deployed kinga-tax-engine + KingaTaxPanel + KingaFindingsPanel.
This second push adds three things:

1. **Class 7 (Intangible Assets)** — added to kinga-tax-engine and KingaTaxPanel
   (was coded AFTER the first push, so production DB is missing it)

2. **process-trial-balance v2.1** — 13 missing auto-classification patterns added
   + account_code fallback bug fixed + AuditedAccountsAdapter wired in

3. **A sample trial balance** for the first dry run (historical note, 2026-10-18:
   the file originally named here was removed from the repository; the invented
   replacement is `scripts/fixtures/synthetic-sme-tb-2025.csv`)

---

## TASK 1 — Update DB migration to include Class 7

The file `supabase/migrations/20260628100000_tax_engine_schema.sql` was already
patched locally. The `ita_class` CHECK constraint now reads:

```sql
CHECK (ita_class IN (1, 2, 3, 5, 6, 7, 8))
```

**Run this SQL in the Supabase SQL editor** (idempotent — ALTER only if needed):

```sql
-- Add Class 7 to the ita_class CHECK constraint
-- (only needed if the migration already ran without Class 7)
ALTER TABLE public.capital_allowances
  DROP CONSTRAINT IF EXISTS capital_allowances_ita_class_check;

ALTER TABLE public.capital_allowances
  ADD CONSTRAINT capital_allowances_ita_class_check
  CHECK (ita_class IN (1, 2, 3, 5, 6, 7, 8));
```

Then verify:
```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.capital_allowances'::regclass
  AND contype = 'c'
  AND conname LIKE '%ita_class%';
-- Expected: ita_class IN (1, 2, 3, 5, 6, 7, 8)
```

---

## TASK 2 — Deploy updated process-trial-balance (v2.1)

The edge function `supabase/functions/process-trial-balance/index.ts` has been
updated with:
- **13 new AUTO_CLASSIFICATION_RULES** (COGS, income tax charge, interest expense,
  bank charges, insurance, entertainment/meetings, stationeries, telephone/internet,
  travel, cleaning, service levy P&L, professional fees, trade receivables,
  long-term loans with flexible word order, trade payables)
- **account_code fallback fix**: rows without a code column now use account_name
  as the key (stops all rows being silently skipped)
- **TRIAL_BALANCE_IMBALANCE tolerance**: raised from 0.01 → 1.00 TZS
  (TZS is non-decimal; rounding accumulates to whole-TZS differences)
- **Version bump**: parser_version → "v2.1"

And the new file `supabase/functions/process-trial-balance/auditedAccountsAdapter.ts`
adds the `isAuditedAccountsFormat()` + `parseAuditedAccounts()` pipeline that
detects SCI/SFP sheet structure and converts audited financial statements to the
flat TB format. It is imported into index.ts and called BEFORE the generic XLSX
parser.

**Deploy both files as a single edge function update.**

Verify deployment:
```bash
# Supabase CLI
supabase functions deploy process-trial-balance --no-verify-jwt
```

Or in Lovable: confirm the edge function shows "v2.1" in the log after next upload.

---

## TASK 3 — Deploy updated kinga-tax-engine (v1.2 — Class 7)

The file `supabase/functions/kinga-tax-engine/index.ts` already has Class 7 added
(rate=0, method=straight_line, amber CPA warning box). Deploy it:

```bash
supabase functions deploy kinga-tax-engine --no-verify-jwt
```

---

## TASK 4 — Verify all 6 checks pass

After deployment, run in Supabase SQL editor:

```sql
-- V1: ita_class constraint includes 7
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.capital_allowances'::regclass
  AND conname LIKE '%ita_class%';
-- Expected: CHECK (ita_class IN (1, 2, 3, 5, 6, 7, 8))

-- V2: capital_allowances and tax_computations exist with RLS
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('capital_allowances', 'tax_computations')
ORDER BY tablename;
-- Expected: capital_allowances rowsecurity=true, tax_computations rowsecurity=false

-- V3: process-trial-balance edge function metadata
-- (check Lovable's edge function list for v2.1 confirmation)

-- V4: kinga-tax-engine deployed
-- (check Lovable's edge function list — should be most recent deploy)
```

---

## TASK 5 — First Live Dry Run

Historical note (2026-10-18): this task originally named a real client's trial
balance and listed its figures and expected tax results. Those have been removed
from the repository. Use the invented, balanced sample
`scripts/fixtures/synthetic-sme-tb-2025.csv` for any dry run.

**Upload steps:**
1. Log into the dashboard → select the sample company
2. Upload `scripts/fixtures/synthetic-sme-tb-2025.csv` as the trial balance
3. System should return status = "valid" (no BLOCKED / UNMAPPED_ACCOUNTS errors)
4. Open the corporate tax panel and add capital allowances from a PPE schedule
5. Set months_overdue = 0 and run the tax analysis

---

## WHAT IS NOT IN THIS PUSH

- Class 7 useful-life input field (v1.3 — deferred)
- First Year Allowance checkbox (v1.3 — deferred)
- TRA e-Filing checklist (Phase 5H — next sprint)
- Loss carry-forward tracker (Phase 5C — deferred)
- PDF tax computation report (Phase 5F — deferred)

---

## CODE CHECKS

After deployment, verify no TypeScript errors:
- `supabase/functions/process-trial-balance/index.ts` — imports from `./auditedAccountsAdapter.ts` ✓
- `supabase/functions/process-trial-balance/auditedAccountsAdapter.ts` — exports `isAuditedAccountsFormat`, `parseAuditedAccounts`, `getAuditedAccountsMetadata` ✓
- `supabase/functions/kinga-tax-engine/index.ts` — Class 7 in ITA_ASSET_CLASSES with rate=0 ✓
- `src/components/KingaTaxPanel.tsx` — Class 7 in ITA_CLASS_LABELS with amber warning box ✓

Engine version strings to confirm:
- process-trial-balance: `parser_version: "v2.1"`
- kinga-tax-engine: `ENGINE_VERSION = "Module E v1.2"`
