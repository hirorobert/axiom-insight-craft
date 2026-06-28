# Kinga — Findings Engine Specification
**Module B: Rule Trigger (GL-Account-Based)**
**Version: v1.0**
**Date: 2026-06-26**
**Status: IMPLEMENTED — Edge Function written, SDL verified in DB**

---

## 0. Purpose

This document specifies the findings engine for Kinga's compliance module. It covers Module B (rule_trigger findings derived from GL account balances), the obligation computation formula, the trigger guard architecture, open decisions, and smoke tests.

Module A (EFDMS diff — GL vs EFDMS variance) is defined separately. The EFDMS adapter spec (`kinga_efdms_adapter_spec.md`) is its prerequisite.

---

## 1. Two-Module Architecture

```
GL trial balance  ──────────────────────────────► Module B: rule_trigger
(trial_balance_uploads.processing_result)          • SDL on operating_expenses
                                                   • WHT on equity (retained earnings)
                                                   • Presumptive tax on revenue
                                                   • VAT reg threshold advisory

canonical_financial_records ────────────────────► Module A: efdms_diff  (future)
(EFDMS purchase + Z-report)                        • VAT withheld vs GL purchases
                                                   • Z-report sales vs GL revenue
```

**Module B fires when:** a company has a valid trial balance upload AND active, verified statutory rules with `trigger_account_classification IS NOT NULL`.

**Module A fires when:** a company has canonical EFDMS records AND a trial balance for the same period.

**A rule belongs to exactly one module.** `trigger_account_classification IS NULL` → Module A (or advisory). `trigger_account_classification IS NOT NULL` → Module B. The column is the selector.

---

## 2. Data Sources

### 2A. Statutory Rules (trigger side)

Table: `public.statutory_rules`

Module B reads only rows where:
- `trigger_account_classification IS NOT NULL`
- `verified_at IS NOT NULL` ← engine pre-filter; trigger enforces at DB layer
- `jurisdiction = 'TZ'` (v1.0 scope)
- `effective_from <= period_end AND (effective_to IS NULL OR effective_to >= period_start)`

**Active Module B rules as of 2026-06-26:**

| trigger_category | classification | formula | rate/amount | verified |
|---|---|---|---|---|
| `sdl` | `operating_expenses` | rate | 3.5% | ✓ FA2025 |
| `wht_undistributed_earnings` | `equity` | rate | 10% | ✓ FA2025 |
| `retained_earnings_deemed_distribution` | `equity` | rate | (FA2026 — unverified) | ✗ |
| `presumptive_tax_band1` | `revenue` | rate | 0% | ✓ FA2025 |
| `presumptive_tax_band2_new_tin` | `revenue` | rate | (per band) | ✓ FA2025 |
| `presumptive_tax_band3_compliant` | `revenue` | rate | 3% | ✓ FA2025 |
| `presumptive_tax_band3_noncompliant` | `revenue` | flat | TZS 100,000 | ✓ FA2025 |
| `presumptive_tax_band4_compliant` | `revenue` | compound | TZS 90,000 + 3% | ✓ FA2025 |
| `presumptive_tax_band4_noncompliant` | `revenue` | flat | TZS 250,000 | ✓ FA2025 |
| `presumptive_tax_threshold` | `revenue` | threshold | TZS 200,000,000 | ✓ FA2025 |
| `presumptive_tax_top_band_rate` | `revenue` | rate | (per rule) | ✓ FA2025 |
| `vat_registration_threshold` | `revenue` | threshold advisory | TZS 200,000,000 | ✓ FA2025 |

**FA2026 rules cannot produce findings until Presidential Assent is confirmed and `verified_at` is set.**

### 2B. GL Account Balances (base side)

Source: `trial_balance_uploads.processing_result JSONB`

Structure (set by `process-trial-balance` Edge Function):
```typescript
processing_result.status          // 'valid' | 'invalid' | 'blocked'
processing_result.statements      // null if status != 'valid'
  .income_statement               // classification → { accounts, total }
    ['operating_expenses']        // SDL base
    ['revenue']                   // Presumptive tax / VAT threshold base
    ['cost_of_goods_sold']
  .balance_sheet
    ['equity']                    // WHT on retained earnings base
    ['current_assets']
    ...
  .cash_flow
    ['operating_activities']
    ...
```

**Engine guard:** If `processing_result.status !== 'valid'`, the entire run aborts with an error. Findings on an invalid or blocked trial balance would be built on unreliable numbers.

### 2C. Classification → Statement mapping

Hardcoded in the engine (`CLASSIFICATION_TO_STATEMENT`):

| account_classification | statement section |
|---|---|
| `revenue`, `cost_of_goods_sold`, `operating_expenses`, `other_income`, `taxes` | `income_statement` |
| `current_assets`, `non_current_assets`, `current_liabilities`, `non_current_liabilities`, `equity` | `balance_sheet` |
| `operating_activities`, `investing_activities`, `financing_activities` | `cash_flow` |

---

## 3. Obligation Computation Formula

Three variants encoded in `statutory_rules`:

| Condition | Formula | SDL example |
|---|---|---|
| `rate_pct IS NOT NULL`, `flat_tax_tzs IS NULL` | `obligation = (rate_pct / 100) × base` | `3.5% × opex_total` |
| `flat_tax_tzs IS NOT NULL`, `rate_pct IS NULL` | `obligation = flat_tax_tzs` | `TZS 100,000` (band3_noncompliant) |
| Both set | `obligation = flat_tax_tzs + (rate_pct / 100) × base` | `TZS 90,000 + 3% × revenue` (band4_compliant) |
| `rate_is_threshold = true` | Eligibility check only; `obligation = 0` | VAT registration advisory |

**Threshold rules:** If `base > threshold_amount`, a finding is created with `computed_obligation_tzs = 0` and `exposure_amount_tzs = 0`. The finding is advisory — it flags that the company crossed an eligibility threshold but does not compute a dollar obligation. The title makes this explicit: "VAT Registration Threshold Breach (Advisory)".

---

## 4. The `enforce_verified_statutory_rule` Trigger Guard

This is the most important safety mechanism in the findings layer. It fires **BEFORE INSERT and BEFORE UPDATE** on `findings` for **all roles including service_role**.

**V1:** `finding_type = 'rule_trigger'` → `statutory_rule_id` must NOT be NULL.
**V2:** `statutory_rule_id IS NOT NULL` → referenced rule's `verified_at` must NOT be NULL.

The engine satisfies both before even reaching the DB:
- Engine only reads rules where `verified_at IS NOT NULL` → V2 pre-satisfied
- Engine always sets `statutory_rule_id = rule.id` on rule_trigger findings → V1 pre-satisfied

The trigger is the **final, unforgeable gate**. If a bug in the engine bypasses the pre-filter and passes an unverified rule, the trigger fires with `SQLSTATE 23514` and the INSERT is rejected. No unverified finding can land in the DB.

**FA2026 rules before Presidential Assent:** `verified_at IS NULL` on all FA2026 rows. The engine pre-filter excludes them. Even if the pre-filter had a bug, the trigger would catch any attempt.

---

## 5. findings Table Mapping

From migration `20260625100000`:

| findings column | Module B value | Notes |
|---|---|---|
| `company_id` | request.company_id | Required |
| `statutory_rule_id` | rule.id | Required for rule_trigger (V1) |
| `upload_id` | request.upload_id | FK → trial_balance_uploads |
| `finding_type` | `'rule_trigger'` | Triggers enforce_verified_statutory_rule |
| `title` | `"SDL — 2025-07"` | Built from trigger_category label + period |
| `statute_reference` | rule.statute | e.g. "Vocational Education and Training Act CAP 82 s.15" |
| `period_start` | First day of period month | DATE |
| `period_end` | Last day of period month | DATE |
| `exposure_amount_tzs` | `MAX(0, variance)` | CHECK: must be ≥ 0 |
| `base_amount_tzs` | GL classification total | Operating expenses sum for SDL |
| `comparison_amount_tzs` | declared_amount | 0 in v1.0 (see OD-1) |
| `computed_obligation_tzs` | Obligation formula result | Principal before penalty/interest |
| `interest_amount_tzs` | NULL | Set on TRA notice receipt |
| `penalty_amount_tzs` | NULL | Set on TRA notice receipt |
| `source_detail` | Full JSONB (see §6) | Engine provenance + GL evidence |
| `status` | `'open'` | Default |
| `created_by` | request.triggered_by | Explicit UUID — service_role has no auth.uid() |

---

## 6. source_detail JSONB Schema

```typescript
{
  // Engine provenance
  engine_version:   string;   // "Module B v1.0"
  engine_run_id:    string;   // UUID — trace back to audit_logs row
  upload_id:        string;   // trial_balance_uploads.id
  upload_file_name: string;   // e.g. "ClientABC_TB_Jul2025.xlsx"

  // Rule snapshot (at time of finding generation)
  rule_id:                        string;
  trigger_category:               string;
  trigger_account_classification: string;
  statute:                        string;
  rate_pct:                       number | null;
  flat_tax_tzs:                   number | null;
  rate_is_threshold:              boolean;
  threshold_amount:               number | null;
  rule_effective_from:            string;  // YYYY-MM-DD

  // Obligation computation
  obligation_formula:      string;  // human-readable e.g. "rate: 3.5% × base(50000000.00)"
  base_amount_tzs:         number;
  computed_obligation_tzs: number;
  declared_amount_tzs:     number;  // 0 in v1.0
  variance_tzs:            number;
  variance_pct:            number | null;

  // GL evidence (accounts included in the base)
  period_year:      number;
  period_month:     number;
  account_balances: Array<{
    account_code: string;
    account_name: string;
    debit:        number;
    credit:       number;
    balance:      number;
  }>;
  account_count: number;

  // Open decision documentation (always present)
  declared_amount_source: string;   // explains why declared = 0

  // SDL-specific (only present for sdl findings)
  payroll_limitation_note?: string;
}
```

---

## 7. SDL Payroll Limitation (v1.0)

**Problem:** `trigger_account_classification = 'operating_expenses'` captures ALL operating expenses in the GL — rent, utilities, depreciation, professional fees, insurance — not just payroll. SDL is a levy on **payroll only** (3.5% of gross wages).

**Impact:** The computed SDL obligation in v1.0 is over-estimated. For a company with TZS 200M operating expenses of which TZS 50M is payroll, the engine computes `3.5% × 200M = TZS 7M` instead of the correct `3.5% × 50M = TZS 1.75M`.

**v1.0 approach:** Accept the overestimation. Document it clearly in `source_detail.payroll_limitation_note` on every SDL finding. The evidence_requests workflow collects the actual payroll amount, and the preparer manually adjusts.

**v1.1 fix (open decision OD-2):** Add `is_payroll_account BOOLEAN DEFAULT false` to `account_mappings`. Module B SDL logic then sums only accounts where `is_payroll_account = true`. This requires a schema migration + account re-mapping for each company.

---

## 8. Open Decisions

| ID | Decision | Impact | Resolution path |
|---|---|---|---|
| OD-1 | **Declared amount source.** No tax_payments table exists. `declared_amount_tzs = 0` for all v1.0 findings. | Every finding shows 100% variance. Preparer manually adjusts after reviewing evidence. | Add `tax_payments` table in v2.0. Link SDL payment records. Recalculate variance automatically. |
| OD-2 | **SDL payroll flag.** `operating_expenses` over-estimates SDL base. | SDL findings are over-estimated. Clearly documented in source_detail. | Add `is_payroll_account BOOLEAN` to `account_mappings`. Filter in Module B v1.1. |
| OD-3 | **Variance threshold.** Currently TZS 10,000. | Sub-threshold differences not flagged. May miss small but systematic underpayments. | Review after first full reconciliation cycle. Adjust per firm risk profile. |
| OD-4 | **Presumptive tax multi-band logic.** Multiple band rules share `trigger_account_classification = 'revenue'`. Engine v1.0 evaluates each band rule independently, which may generate multiple findings for the same revenue base. | Over-finding: company may receive 3 presumptive tax findings. | Implement band dispatch logic: (1) check threshold, (2) match exact band, (3) emit single finding. Module B v1.1. |
| OD-5 | **Period matching.** Engine receives `upload_id` from caller. No automatic period detection from trial balance file. | Caller must select the correct upload for the period being assessed. | Add `period_year`/`period_month` columns to `trial_balance_uploads`. Auto-match on engine call. |
| OD-6 | **NULL Module B rules.** V2 result showed 4 unclassified active rules: `nonresident_digital_service_tax`, `single_instalment_food_crops`, `single_instalment_forest_produce`, `withholding_crops_livestock_fishery`. | These rules cannot produce Module B findings. | Each needs a classification decision (or documented as Module A / bespoke). |

---

## 9. Engine Call Contract

**Endpoint:** `POST /functions/v1/kinga-findings-engine`

**Request:**
```json
{
  "company_id":   "uuid",
  "upload_id":    "uuid",
  "period_year":  2025,
  "period_month": 7,
  "triggered_by": "uuid",
  "dry_run":      false
}
```

**Response (success):**
```json
{
  "engine_run_id":    "uuid",
  "company_id":       "uuid",
  "period_year":      2025,
  "period_month":     7,
  "rules_evaluated":  12,
  "rules_skipped":    3,
  "findings_created": 2,
  "findings_skipped": 1,
  "errors":           [],
  "dry_run":          false
}
```

**`dry_run: true`:** Engine computes but does not INSERT findings. Returns `findings_preview` array instead. Safe to call repeatedly. Useful for pre-flight check before writing to DB.

---

## 10. Smoke Tests

### Smoke A — SDL finding created for a company with operating expenses
```
1. Upload a trial balance with:
   - operating_expenses total = TZS 50,000,000
   - processing_result.status = 'valid'
2. Call kinga-findings-engine with that upload_id, period_year=2025, period_month=7
3. Expected response:
   - findings_created >= 1
   - errors = []
4. Verify finding in DB:
   SELECT title, trigger_category__from_rule, computed_obligation_tzs,
          base_amount_tzs, source_detail
   FROM findings
   WHERE company_id = :company_id
     AND finding_type = 'rule_trigger'
     AND period_start = '2025-07-01';
   Expected: computed_obligation_tzs = 1750000.00 (3.5% × 50,000,000)
             source_detail.payroll_limitation_note IS NOT NULL (SDL warning present)
```

### Smoke B — dry_run returns preview without writing
```
1. Call engine with dry_run: true
2. Expected:
   - findings_created = N (count of what would be created)
   - No rows in findings table for this company/period
3. Call again with dry_run: false
4. Expected: findings_created = N, rows now in DB
```

### Smoke C — FA2026 unverified rules produce no findings
```
1. Confirm retained_earnings_deemed_distribution has verified_at IS NULL
2. Call engine for a company with equity > 0
3. Expected: no finding for retained_earnings_deemed_distribution
   (engine pre-filter excludes it; trigger would catch if engine had a bug)
```

### Smoke D — Invalid trial balance aborts with error
```
1. Upload a trial balance that fails debit/credit balance check
   (processing_result.status = 'invalid')
2. Call engine with that upload_id
3. Expected:
   - findings_created = 0
   - errors[0].stage = 'gl_read'
   - errors[0].error_message contains 'invalid'
```

### Smoke E — enforce_verified_statutory_rule trigger fires on direct INSERT
```sql
-- Attempt to insert a finding referencing an unverified FA2026 rule directly
BEGIN;
INSERT INTO public.findings (
  company_id, statutory_rule_id, finding_type, title,
  period_start, period_end, exposure_amount_tzs, source_detail, created_by
)
SELECT c.id, sr.id, 'rule_trigger', 'Smoke E — should FAIL',
       '2026-07-01', '2026-07-31', 0.00, '{}', c.user_id
FROM public.companies c
CROSS JOIN public.statutory_rules sr
WHERE sr.trigger_category = 'retained_earnings_deemed_distribution'
  AND sr.verified_at IS NULL
LIMIT 1;
ROLLBACK;
-- Expected: ERROR 23514 — V2 violation
```

### Smoke F — Idempotency: second engine run does not duplicate findings
```
1. Run engine for company/period → findings_created = N
2. Run engine again for same company/period
3. Expected: second run fails on duplicate insert (23505), findings_skipped = N
   findings table still has exactly N rows (no duplicates)
```

---

## 11. Required DB Migration Before Production

Before deploying the engine to production, apply one additional migration:

```sql
-- Add engine_run_id to findings for full audit traceability
-- (Recommended before first production run)
ALTER TABLE public.findings
  ADD COLUMN IF NOT EXISTS engine_run_id UUID NULL;

COMMENT ON COLUMN public.findings.engine_run_id IS
  'UUID of the engine run that created this finding. '
  'Links to audit_logs.entity_id where entity_type = ''company'' '
  'and action = ''reconciliation_engine_completed''. '
  'NULL for manually created findings.';

CREATE INDEX IF NOT EXISTS idx_findings_engine_run_id
ON public.findings (engine_run_id)
WHERE engine_run_id IS NOT NULL;
```

Until this migration is applied, `engine_run_id` is stored only in `source_detail.engine_run_id` (JSONB). The audit_log row carries it in `metadata.engine_run_id`. Both are queryable; the dedicated column is simply faster.
