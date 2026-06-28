# Kinga — Validation Report Per-Account Structure Specification
**Findings Engine Output Contract v1.0**
**Status: DESIGN — see §10 for Required Decisions**
**Author: Kinga Phase 2 architecture review**
**Date: 2026-06-26**

---

## 0. Purpose

This document specifies the complete output contract for the Kinga findings engine. It covers:

- The validation report hierarchy (Company → Period → Account → Findings)
- Module A: EFDMS reconciliation (GL vs. EFDMS canonical layer diff)
- Module B: Statutory rule triggers (account classification matching)
- The `source_detail` JSONB schema for each finding type
- TypeScript interface definitions (for the Edge Function and frontend)
- Response pack generation trigger conditions
- Required Decisions blocking Module B development

The report is designed to be TurboTax-grade: every number traceable to a source,
every calculation shown, every rule cited with its statute reference. A tax auditor
must be able to pick up the report with no other documentation and reconstruct every
computation from first principles.

---

## 1. Report Hierarchy

```
ValidationReport
├── meta                         ← report identity and generation context
├── summary                      ← portfolio-level roll-up
├── findings_by_account[]        ← one AccountSection per account with findings
│   ├── account metadata
│   └── findings[]
│       ├── Module A: efdms_diff  ← EFDMS vs. GL variance
│       └── Module B: rule_trigger ← statutory obligation fired
└── findings_without_account[]   ← manual findings with no account classification
```

---

## 2. Report-Level Schema (TypeScript)

```typescript
// The complete report envelope returned by the findings engine
interface ValidationReport {
  meta: ReportMeta;
  summary: ReportSummary;
  findings_by_account: AccountSection[];
  findings_without_account: Finding[];   // manual findings, TRA notices
}

interface ReportMeta {
  report_id:        string;              // UUID; stable across re-renders for the same input
  company_id:       string;
  company_name:     string;
  company_tin:      string | null;       // TRA TIN if recorded on the companies row
  period_start:     string;              // ISO-8601 DATE, e.g. "2025-07-01"
  period_end:       string;              // ISO-8601 DATE, e.g. "2026-06-30"
  period_label:     string;             // e.g. "FY2025/2026 (TZ)"
  generated_at:     string;             // ISO-8601 TIMESTAMPTZ
  generated_by:     string;             // user_id of the staff member who triggered the run
  engine_version:   string;             // e.g. "1.0.0"
  report_status:    'draft' | 'final';
  // 'draft': findings engine run is complete but not all response packs are ready.
  // 'final': all findings have response_pack_ready = true (or were resolved/disputed).
}

interface ReportSummary {
  total_exposure_tzs:       string;     // NUMERIC as string to avoid float precision loss
  total_findings:           number;
  open_findings:            number;
  resolved_findings:        number;
  disputed_findings:        number;
  in_progress_findings:     number;
  findings_by_type: {
    efdms_diff:   TypeSummary;
    rule_trigger: TypeSummary;
    manual:       TypeSummary;
  };
  findings_by_status: {
    open:        number;
    in_progress: number;
    resolved:    number;
    disputed:    number;
  };
  accounts_with_findings:   number;     // distinct account codes with ≥1 finding
  response_packs_ready:     number;     // findings where response_pack_ready = true
}

interface TypeSummary {
  count:              number;
  total_exposure_tzs: string;
}
```

---

## 3. AccountSection Schema

One section per distinct `account_code` that has at least one finding in the period.
Accounts are ordered by descending `account_total_exposure_tzs` (highest risk first).
Within an account, findings are ordered by descending `exposure_amount_tzs`.

```typescript
interface AccountSection {
  account_code:               string;   // e.g. "5001"
  account_name:               string;   // e.g. "Salary & Wages Expense"
  account_classification:     string;   // e.g. "operating_expenses" (account_classification enum)
  statement:                  string;   // e.g. "income_statement"
  line_item:                  string;   // e.g. "Staff Costs"
  account_balance_tzs:        string;   // trial balance amount for this account in the period
  canonical_records_count:    number;   // number of canonical_financial_records matched to this account
  account_total_exposure_tzs: string;   // sum of exposure_amount_tzs for all findings in this account
  findings:                   Finding[];
}
```

**Account matching:**
An account is associated with a finding when:
- Module A: the trial balance account whose GL amount was compared against EFDMS canonical records
- Module B: the account_mappings.classification = statutory_rules.trigger_account_classification
  for the matching statutory rule

---

## 4. Finding Schema

```typescript
interface Finding {
  // Identity
  id:                       string;             // UUID; the findings.id in the database
  finding_type:             'efdms_diff' | 'rule_trigger' | 'manual';
  title:                    string;
  status:                   'open' | 'in_progress' | 'resolved' | 'disputed';
  response_pack_ready:      boolean;

  // Statute linkage (null for efdms_diff and manual findings)
  statutory_rule_id:        string | null;
  statute_reference:        string | null;      // e.g. "Finance Act 2023, s.14"
  trigger_category:         string | null;      // e.g. "sdl"

  // Period
  period_start:             string;             // ISO-8601 DATE
  period_end:               string;             // ISO-8601 DATE

  // Financials (all TZS, as strings to avoid float precision loss)
  exposure_amount_tzs:      string;             // total amount at risk (primary sort key)
  base_amount_tzs:          string | null;      // GL amount or EFDMS amount (the "starting point")
  comparison_amount_tzs:    string | null;      // the counter-value for diff findings
  computed_obligation_tzs:  string | null;      // principal obligation before interest/penalty
  interest_amount_tzs:      string | null;      // estimated interest (if computed)
  penalty_amount_tzs:       string | null;      // estimated penalty (if computed)

  // Detail
  source_detail:            EfdmsDiffDetail | RuleTriggerDetail | ManualDetail;

  // Provenance
  created_at:               string;
  created_by:               string;             // user_id of the findings-engine run
  tra_notice_ref:           string | null;
  tra_notice_date:          string | null;

  // Related findings
  related_finding_ids:      string[];           // UUIDs of related findings
}
```

---

## 5. source_detail JSONB Specification

### 5A. efdms_diff (Module A)

Records a variance between the GL trial balance and the EFDMS canonical layer.

```typescript
interface EfdmsDiffDetail {
  // Variance metadata
  diff_type:              'sales_over_reported'   // GL > EFDMS (revenue in GL not on EFDMS)
                        | 'sales_under_reported'  // EFDMS > GL (receipts not in books)
                        | 'purchase_over_reported'
                        | 'purchase_under_reported';

  // Amounts
  gl_amount_tzs:          string;                 // sum of canonical_financial_records for period
  efdms_amount_tzs:       string;                 // sum of trial balance GL for the period
  variance_tzs:           string;                 // ABS(gl - efdms)
  variance_pct:           number;                 // (variance / MAX(gl, efdms)) * 100, 2dp

  // VAT exposure computed from variance
  vat_exposure_tzs:       string | null;          // variance * applicable_vat_rate (if rule found)
  vat_rate_applied:       number | null;          // e.g. 0.18 for 18% standard rate

  // Period granularity
  period_year:            number;                 // e.g. 2025
  period_month:           number | null;          // null for annual comparison

  // Evidence counts
  canonical_record_count: number;                 // number of canonical_financial_records in scope
  gl_account_codes:       string[];               // account codes contributing to gl_amount_tzs

  // Batch provenance (which ingestion batches contributed)
  batch_ids:              string[];               // ingestion_batches.id UUIDs
}
```

**Module A computation:**

```
FOR each company, FOR each period (year, [month]):

  efdms_total = SUM(canonical_financial_records.amount_tzs)
    WHERE company_id = ? AND period_year = ? [AND period_month = ?]
    AND record_type = 'sale'  -- or 'purchase'

  gl_total = SUM(trial_balance account balances)
    WHERE account_classification IN ('revenue', ...)  -- the GL counterpart accounts
    AND upload_id IN (uploads for this company and period)

  IF ABS(efdms_total - gl_total) > variance_threshold THEN
    INSERT finding (finding_type = 'efdms_diff')
      base_amount_tzs        = gl_total
      comparison_amount_tzs  = efdms_total
      exposure_amount_tzs    = ABS(gl_total - efdms_total)
      source_detail          = { diff_type, gl_amount_tzs, efdms_amount_tzs, ... }
```

**Variance threshold (Required Decision — see §10 RD-1):**
What is the minimum variance that should generate a finding?
- Option A: Absolute threshold (e.g., any variance > TZS 50,000)
- Option B: Percentage threshold (e.g., any variance > 1% of the larger amount)
- Option C: Both (finding generated if EITHER threshold is exceeded)

---

### 5B. rule_trigger (Module B)

Records a statutory obligation detected by matching an account classification to a rule.

```typescript
interface RuleTriggerDetail {
  // Rule identification
  trigger_category:     string;           // e.g. "sdl"
  rule_id:              string;           // statutory_rules.id UUID

  // Computation inputs
  rate_pct:             number | null;    // e.g. 3.5
  flat_tax_tzs:         number | null;    // e.g. 90000 (compound base component)
  rate_is_threshold:    boolean;
  threshold_amount:     number | null;

  // Computation (shown as a human-readable string for auditability)
  base_amount_tzs:      string;           // sum of matching account balances
  computation:          string;           // e.g. "0.035 × 450,000,000 = 15,750,000"
  // For compound rules: "90,000 + 0.03 × (2,500,000 − 7,000,000) is below band — 0"
  // For flat-only rules: "100,000 (flat)"
  // For threshold rules: "turnover 180,000,000 < threshold 200,000,000 → exempt"

  // Account linkage
  account_code:         string;           // e.g. "5001"
  account_classification: string;         // e.g. "operating_expenses"

  // Evidence
  supporting_canonical_record_ids: string[];   // canonical_financial_records.id UUIDs
  batch_ids:            string[];              // ingestion_batches.id UUIDs

  // Late payment (if applicable — set by the engine when computing interest/penalty)
  due_date:             string | null;    // ISO-8601 DATE: the statutory due date for this obligation
  filing_date_assumed:  string | null;   // date the engine assumed for interest calculation
  months_delayed:       number | null;   // integer months past due
  interest_rate_pct:    number | null;   // e.g. 10.5 (TRA statutory interest rate)
  penalty_rate_pct:     number | null;   // e.g. 5.0 (TRA statutory penalty rate)
}
```

**Module B computation:**

```
FOR each company:

  matched_rules = SELECT sr.*
    FROM statutory_rules sr
    JOIN account_mappings am ON am.classification = sr.trigger_account_classification
    WHERE am.user_id = company.user_id         -- user's chart of accounts
      AND sr.jurisdiction = 'TZ'
      AND sr.verified_at IS NOT NULL           -- enforce_verified_statutory_rule invariant
      AND sr.effective_from <= period_end
      AND (sr.effective_to IS NULL OR sr.effective_to > period_start)

  FOR each matched_rule:

    base_amount = SUM(trial_balance account balances)
      WHERE account_classification = matched_rule.trigger_account_classification
        AND upload period overlaps [period_start, period_end]

    obligation = compute_obligation(matched_rule, base_amount)
    -- see §6: Obligation Computation Rules

    IF obligation > 0 THEN
      INSERT finding (finding_type = 'rule_trigger', statutory_rule_id = matched_rule.id)
```

---

## 6. Obligation Computation Rules

The engine must compute `computed_obligation_tzs` from a `statutory_rules` row and a `base_amount_tzs`.
The formula depends on the rule encoding:

| row_encoding | condition | formula | example |
|---|---|---|---|
| Pure rate | `rate_is_threshold=false, rate_pct IS NOT NULL, flat_tax_tzs IS NULL` | `obligation = (rate_pct / 100) × base_amount` | SDL: `0.035 × 450M = 15.75M` |
| Flat only | `rate_is_threshold=false, rate_pct IS NULL, flat_tax_tzs IS NOT NULL` | `obligation = flat_tax_tzs` | band3_noncompliant: `100,000` |
| Compound | `rate_is_threshold=false, rate_pct IS NOT NULL, flat_tax_tzs IS NOT NULL` | `obligation = flat_tax_tzs + (rate_pct / 100) × (base - band_floor)` | band4_compliant: `90,000 + 0.03 × (base - 7,000,000)` |
| Threshold | `rate_is_threshold=true` | `obligation = 0` if `base ≤ threshold_amount`, else look up next band rule | presumptive_tax_threshold: `if turnover ≤ 200M → presumptive applies; else corporate rate` |
| Zero rate | `rate_is_threshold=false, rate_pct = 0.0000` | `obligation = 0` | band1, band2_new_tin |

**Band floor derivation for compound rules:**
The `band_floor` for band4_compliant is TZS 7,000,000 (the lower boundary of the band).
This is NOT stored in `statutory_rules` — it is a well-known constant from the Act (FA2026 s.31(a)(ii)).
The engine must hard-code band floor values as a lookup table keyed by `trigger_category`.

```typescript
const BAND_FLOORS: Record<string, number> = {
  'presumptive_tax_band4_compliant': 7_000_000,    // FA2026 s.31(a)(ii)
  // Add more compound bands here as legislation introduces them
};
```

**Required Decision — see §10 RD-2:**
Should band floors be stored in `statutory_rules` (as a new `band_floor_tzs` column)
or remain hard-coded in the engine? The hard-coded approach is brittle when bands change.
The column approach requires another migration.

---

## 7. Interest and Penalty Computation

Late-payment interest and penalties are computed when:
- The obligation has a known `due_date` (the statutory filing deadline)
- The current date is past the `due_date`
- The user has NOT provided evidence of timely payment

**Interest formula (TRA standard):**
```
interest = obligation × (interest_rate_pct / 100) × (months_delayed / 12)
```

**Penalty formula (TRA standard):**
```
penalty = obligation × (penalty_rate_pct / 100)
```

**Required Decision — see §10 RD-3:**
TRA interest and penalty rates are set by regulation, not the Finance Acts in the statutory_rules table.
These rates must be stored somewhere (a new table, a JSONB config column, or constants in the engine).
Confirm the current TRA late-payment interest rate and penalty rate before implementing.

---

## 8. Response Pack Generation

The `response_pack_ready` flag on `findings` is set to `true` by the existing
`trg_update_response_pack_ready` trigger when `evidence_requests.current_step >= 3`.

The findings engine does NOT generate the PDF response pack.
A separate Edge Function (`kinga-generate-response-pack`) is responsible for:
1. Checking `response_pack_ready = true` for the finding
2. Fetching all linked evidence (evidence_requests, canonical records, efdms_records)
3. Generating a PDF structured as:
   - Cover: company, TIN, period, generated_at, TRA reference number
   - Section A: Summary of obligation (statute cited, rate, base, computation)
   - Section B: Supporting canonical records (tabulated)
   - Section C: EFDMS receipt evidence (if applicable)
   - Section D: Counterparty evidence (TIN, name, transaction list)
4. Storing the PDF in Supabase Storage
5. Writing an `audit_logs` row: `action = 'response_pack_generated'`

---

## 9. Full API Response Envelope

The findings engine Edge Function (`kinga-run-findings-engine`) returns:

```typescript
// POST /functions/v1/kinga-run-findings-engine
// Body: { company_id, period_start, period_end, module: 'A' | 'B' | 'all' }

interface FindingsEngineResponse {
  // Run metadata
  run_id:             string;        // UUID for this engine run (logged in audit_logs)
  company_id:         string;
  period_start:       string;
  period_end:         string;
  engine_version:     string;
  run_at:             string;

  // Results
  report:             ValidationReport;

  // Engine diagnostics (for debugging, not shown to clients)
  diagnostics: {
    rules_evaluated:          number;
    accounts_scanned:         number;
    canonical_records_scanned:number;
    duration_ms:              number;
    warnings:                 string[];  // non-fatal issues (e.g. no canonical records for period)
  };
}
```

---

## 10. Required Decisions (Blocking Module B)

### RD-1 (HIGH): Variance threshold for efdms_diff findings

What is the minimum variance that generates a finding?

- Option A (Recommended): Absolute floor TZS 50,000 AND percentage floor 0.5%.
  A finding is generated only if BOTH conditions are met.
  Rationale: prevents noise from rounding differences on small-turnover accounts.
- Option B: Any variance at all (zero threshold).
  Rationale: complete audit coverage, but generates many immaterial findings.
- Option C: User-configurable per company.
  Rationale: most flexible, requires new schema (company_settings table or column).

**Decision needed from:** Product owner.

### RD-2 (HIGH): Band floor storage for compound presumptive tax rules

Should band floor values (the lower turnover boundary for each band) be:
- (A) Hard-coded in the engine as constants (fast to ship, brittle when bands change)
- (B) Stored in a new `band_floor_tzs NUMERIC(20,2) NULL` column on `statutory_rules`
      (requires another migration, but self-documenting and engine-agnostic)

**Recommendation: Option B** — add `band_floor_tzs` as part of the findings engine migration.
This is the same type of semantic precision improvement as `flat_tax_tzs` in migration 20260626170000.

If Option B: the migration must also backfill:
```sql
UPDATE statutory_rules SET band_floor_tzs = 4000001  WHERE trigger_category = 'presumptive_tax_band3_compliant';
UPDATE statutory_rules SET band_floor_tzs = 4000001  WHERE trigger_category = 'presumptive_tax_band3_noncompliant';
UPDATE statutory_rules SET band_floor_tzs = 7000001  WHERE trigger_category = 'presumptive_tax_band4_compliant';
UPDATE statutory_rules SET band_floor_tzs = 7000001  WHERE trigger_category = 'presumptive_tax_band4_noncompliant';
```

### RD-3 (HIGH): TRA interest and penalty rates

What are the current TRA statutory late-payment rates?
- Interest rate: ___% per annum on unpaid tax
- Penalty rate: ___% of outstanding obligation
- Are these the same across SDL, WHT, VAT withholding, and presumptive tax?
- Source: cite the specific section of TAA (Tax Administration Act) or subsidiary regulations.

Once confirmed: these should be stored either in `statutory_rules` (as separate rows for
`trigger_category = 'tra_late_payment_interest'` etc.) or in a separate `tax_rates_config` table.

### RD-4 (MEDIUM): GL account-to-EFDMS matching rule

For Module A (EFDMS diff):
- Which `account_classification` values represent the GL "sales" accounts?
  Current enum: `revenue`, `other_income` — are both included in EFDMS sales comparison?
- Which represent "purchases"? Current enum: `cost_of_goods_sold`, `operating_expenses`?
- Or is the matching configurable per company?

**Recommendation:** Use a static mapping in the engine for v1.0:
```typescript
const GL_EFDMS_MATCH: Record<'sale' | 'purchase', account_classification[]> = {
  sale:     ['revenue', 'other_income'],
  purchase: ['cost_of_goods_sold', 'operating_expenses'],
};
```
Confirm this mapping is correct for TZ accounting practice.

### RD-5 (MEDIUM): `trigger_account_classification` for SDL, WHT, VAT rows

The existing statutory_rules rows for SDL, VAT withholding, etc. were inserted without
setting `trigger_account_classification`. This column is NULL for all current rows.
Module B cannot fire for these rules until the column is populated.

**Action required:** For each active statutory rule that should trigger on a ledger account,
run:
```sql
UPDATE statutory_rules
SET trigger_account_classification = 'operating_expenses'   -- confirm correct classification
WHERE trigger_category = 'sdl'
  AND effective_to IS NULL;
```
Confirm the correct classification for each category:

| trigger_category | trigger_account_classification |
|---|---|
| sdl | operating_expenses (confirm: payroll costs) |
| wht_professional_services | operating_expenses (confirm: contractor costs) |
| wht_rent | operating_expenses or non_current_assets (confirm) |
| vat_withholding_goods | cost_of_goods_sold (confirm) |
| vat_withholding_services | operating_expenses (confirm) |
| stamp_duty | ??? |
| presumptive_tax_* | revenue (turnover-based, confirm) |

### RD-6 (LOW): Multi-period findings

If a company uploads trial balance data for multiple periods (e.g., monthly breakdowns
within an annual period), should Module A compare:
- (A) Annual totals only (sum all periods)
- (B) Monthly totals separately (generates one finding per month)
- (C) Both (annual finding + monthly drill-down findings linked by related_finding_ids)

---

## 11. Example Report Output (Condensed)

```json
{
  "meta": {
    "report_id": "a1b2c3d4-...",
    "company_id": "e5f6a7b8-...",
    "company_name": "Acme Tanzania Ltd",
    "company_tin": "100-123-456",
    "period_start": "2025-07-01",
    "period_end": "2026-06-30",
    "period_label": "FY2025/2026 (TZ)",
    "generated_at": "2026-06-26T10:00:00Z",
    "report_status": "draft",
    "engine_version": "1.0.0"
  },
  "summary": {
    "total_exposure_tzs": "21750000.00",
    "total_findings": 2,
    "open_findings": 2,
    "findings_by_type": {
      "efdms_diff":   { "count": 1, "total_exposure_tzs": "6000000.00" },
      "rule_trigger": { "count": 1, "total_exposure_tzs": "15750000.00" },
      "manual":       { "count": 0, "total_exposure_tzs": "0.00" }
    }
  },
  "findings_by_account": [
    {
      "account_code": "5001",
      "account_name": "Salary & Wages Expense",
      "account_classification": "operating_expenses",
      "account_balance_tzs": "450000000.00",
      "account_total_exposure_tzs": "15750000.00",
      "findings": [
        {
          "id": "f1a2b3c4-...",
          "finding_type": "rule_trigger",
          "title": "Skills Development Levy — FY2025/2026",
          "status": "open",
          "statutory_rule_id": "<sdl-rule-uuid>",
          "statute_reference": "Vocational Education and Training Act Cap 82 (Finance Act 2023)",
          "trigger_category": "sdl",
          "period_start": "2025-07-01",
          "period_end": "2026-06-30",
          "exposure_amount_tzs": "15750000.00",
          "base_amount_tzs": "450000000.00",
          "computed_obligation_tzs": "15750000.00",
          "source_detail": {
            "trigger_category": "sdl",
            "rate_pct": 3.5,
            "flat_tax_tzs": null,
            "rate_is_threshold": false,
            "base_amount_tzs": "450000000.00",
            "computation": "3.5% × 450,000,000 = 15,750,000",
            "account_code": "5001",
            "account_classification": "operating_expenses",
            "batch_ids": ["b1b2b3b4-..."],
            "due_date": null,
            "months_delayed": null
          }
        }
      ]
    },
    {
      "account_code": "4001",
      "account_name": "Sales Revenue",
      "account_classification": "revenue",
      "account_balance_tzs": "850000000.00",
      "account_total_exposure_tzs": "6000000.00",
      "findings": [
        {
          "id": "g5h6i7j8-...",
          "finding_type": "efdms_diff",
          "title": "EFDMS Sales Variance — FY2025/2026",
          "status": "open",
          "statutory_rule_id": null,
          "period_start": "2025-07-01",
          "period_end": "2026-06-30",
          "exposure_amount_tzs": "6000000.00",
          "base_amount_tzs": "850000000.00",
          "comparison_amount_tzs": "820000000.00",
          "computed_obligation_tzs": null,
          "source_detail": {
            "diff_type": "sales_over_reported",
            "gl_amount_tzs": "850000000.00",
            "efdms_amount_tzs": "820000000.00",
            "variance_tzs": "30000000.00",
            "variance_pct": 3.66,
            "vat_exposure_tzs": "5400000.00",
            "vat_rate_applied": 0.18,
            "period_year": 2025,
            "period_month": null,
            "canonical_record_count": 1250,
            "gl_account_codes": ["4001"],
            "batch_ids": ["c1c2c3c4-..."]
          }
        }
      ]
    }
  ]
}
```

---

## 12. Database Changes Required Before Module B

The following schema changes are needed before the Module B findings engine can be built.
They are separate migrations (not in 20260626170000):

1. **`trigger_account_classification` backfill** — populate for all active statutory_rules rows
   where the rule fires on an account classification (all except EFDMS-diff rules).

2. **`band_floor_tzs` column** (if RD-2 → Option B) — add to statutory_rules, backfill all bands.

3. **`audit_action` values already added** — `finding_generated`, `reconciliation_run`, etc.
   are in migration 20260626170000 ✓.

4. **`findings` column for engine run ID** — consider adding `engine_run_id UUID NULL`
   to findings so every auto-generated finding traces back to the specific reconciliation_run
   audit_log row that created it. This enables: "show me all findings from run X" and
   "was this finding re-generated after I corrected the data?"
```
