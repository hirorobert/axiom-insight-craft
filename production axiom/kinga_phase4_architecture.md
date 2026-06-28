# Kinga Phase 4 — Iron Dome Nuclear Architecture
# Module E: ITA Corporate Tax Computation Engine
# Date: 2026-06-28

---

## WHAT THIS PHASE ADDS

Phase 3 gave Axiom the ability to detect **statutory underpayments** from the trial balance
(SDL gap, outstanding NSSF/NHIF/VAT payables). Phase 4 adds the **most material TRA audit
exposure for any Tanzanian entity: Corporate Income Tax.**

The ITA computation is not a simple rate × base. It requires:
1. Removing non-deductible expenses (accounting depreciation, entertainment, penalties, provisions)
2. Substituting wear & tear per ITA s.34 asset class rates
3. Testing thin capitalisation (ITA s.24A — 70:30 debt:equity)
4. Applying minimum tax (ITA s.65 — 0.5% of gross income) if CIT would otherwise be too low
5. Comparing computed tax to the provision in the balance sheet

A single FY underprovision on a TZS 5B turnover company could be TZS 150M+.
The CPA currently has no automated tool that does this. **Axiom is the first.**

---

## ARCHITECTURE

```
LAYER 1 — DATA INGESTION (Phase 3 ✅)
  process-trial-balance     Universal XLSX/CSV → structured processing_result

LAYER 2 — STATUTORY DETECTOR (Phase 3 ✅)
  kinga-findings-engine     Module B: SDL, WHT rule-trigger findings
                            Module C: Outstanding payables from balance sheet

LAYER 3 — TAX COMPUTATION (Phase 4 🎯)
  kinga-tax-engine          Module E: ITA Chapter 332 full waterfall
  capital_allowances table  ITA s.34 asset register
  tax_computations table    Stored waterfall per company/period

LAYER 4 — UI (Phase 4 🎯)
  KingaTaxPanel             Waterfall display + Capital Allowance entry
  (Dashboard.tsx wired)     Renders after KingaFindingsPanel
```

---

## ITA COMPUTATION WATERFALL

```
Accounting Profit Before Tax                          (from IS)
  ADD: Accounting depreciation & amortisation         (ITA s.34 — replaced by W&T)
  ADD: Entertainment expenses × 50%                  (ITA s.11(3))
  ADD: Penalties, fines, interest on taxes            (ITA s.11(1))
  ADD: Provisions for bad/doubtful debt               (ITA s.25 — only write-offs allowed)
  ADD: Excess management fees (>2% of turnover)       (ITA s.33(3))
  ADD: Thin cap disallowed interest                   (ITA s.24A)
────────────────────────────────────────────────────────────────
  LESS: ITA wear & tear (by class)                    (ITA s.34)
    Class 1  Computers & data equipment    50% RB
    Class 2  Commercial vehicles           37.5% RB
    Class 3  Plant, machinery & equipment  25% RB
    Class 4  Furniture & fittings          12.5% RB
    Class 5  Buildings                     5% SL
  LESS: Prior year tax losses                         (ITA s.19 — 5 year limit)
════════════════════════════════════════════════════════════════
TAXABLE INCOME
  × 30% = CIT at standard rate
  OR 0.5% of gross income = Minimum Tax (ITA s.65)
  TAX PAYABLE = max(CIT, Minimum Tax)
════════════════════════════════════════════════════════════════
  LESS: Income Tax Provision (from balance sheet)
════════════════════════════════════════════════════════════════
CIT GAP  ← finding if |gap| > TZS 500,000
  + Penalty = gap × 5%/month × months_overdue        (TAA 2015 s.76)
════════════════════════════════════════════════════════════════
TOTAL EXPOSURE
```

---

## ACCOUNT DETECTION (Zero Configuration)

The engine auto-detects everything by account name pattern matching on the TB:

| What it finds | Example account names matched |
|---|---|
| Depreciation (add-back) | "Depreciation Expense", "Amortisation of Goodwill" |
| Entertainment (50% add-back) | "Entertainment", "Client Functions", "Refreshments" |
| Penalties (add-back) | "TRA Penalties", "NSSF Late Interest", "Fines" |
| Provisions (add-back) | "Provision for Bad Debts", "Doubtful Debt Provision" |
| Mgmt fees (excess) | "Management Fees", "Head Office Charges", "Royalties" |
| Long-term debt (thin cap) | "Term Loan", "Bank Loan", "Debentures" |
| Short-term debt (thin cap) | "Overdraft", "Bank Overdraft", "Credit Facility" |
| Equity (thin cap) | "Share Capital", "Retained Earnings", "Capital Reserve" |
| Interest expense (thin cap) | "Interest Expense", "Finance Costs", "Riba" |
| Income Tax Provision (gap) | "Income Tax Payable", "Current Tax Payable", "CIT Payable" |

Wear & tear is NOT auto-detected (assets must be entered in capital_allowances table by the CPA).

---

## NEW DATABASE TABLES

### `capital_allowances`
ITA s.34 asset register. One row per asset class per period.
Fields: company_id, period_year, asset_description, ita_class (1-5), cost_tzs, ita_wdv_opening_tzs,
additions_tzs, disposals_at_tax_cost_tzs, wear_tear_tzs, ita_wdv_closing_tzs, created_by.
RLS: firm_members policy (same pattern as tax_payments).

### `tax_computations`
Stores the full ITA waterfall per (company_id, upload_id). UNIQUE on that pair.
All waterfall figures stored as NUMERIC. add_backs and deductions stored as JSONB arrays.
Upsert-safe: re-running the engine replaces the previous computation.

---

## FINDING CREATED

When CIT gap exceeds TZS 500,000:
- `finding_type = 'statutory_payable'`
- `finding_category = 'corporate_tax'`
- `statutory_rule_id = NULL` (bypasses enforce_verified_statutory_rule trigger)
- Dedup on (company_id, finding_category, period_start, period_end)
- Severity: critical ≥50M, high ≥10M, medium ≥1M, low

---

## FILES CREATED

| File | Status |
|---|---|
| `supabase/migrations/20260628100000_tax_engine_schema.sql` | ✅ Written |
| `supabase/functions/kinga-tax-engine/index.ts` | ✅ Written |
| `src/components/KingaTaxPanel.tsx` | ✅ Written |
| `production axiom/lovable_phase4_prompt.md` | ✅ Written |

---

## PHASE 5 CANDIDATES (NEXT IRON DOME)

1. **Kinga Risk Score** — Composite 0-100 audit risk score per company:
   SDL gap ratio + CIT effective rate vs 30% + NSSF coverage + open findings age + assessment count.
   Shown as a single number in the dashboard header. Tells the CPA at a glance.

2. **EFDMS Revenue Reconciliation (Module D)** — CPAs upload TRA EFD Z-report CSV.
   Engine cross-references against TB revenue. Gap = unreceipted sales = VAT base erosion.
   Every business with turnover >TZS 14M must use EFD machines (EFDMS Regulations 2010).

3. **TRA Tax Computation Schedule (PDF export)** — Generate the formal ITA schedule in
   TRA-expected format (Form ITX 100) directly from the waterfall. CPA attaches to return.

4. **WHT Activation** — Set `verified_at = now()` on WHT rule in statutory_rules.
   Engine already has the logic — just needs the DB flag.

5. **Prior Year Loss Carry-Forward** — ITA s.19: losses carry forward 5 years.
   Track per company in tax_computations, auto-apply deduction in following years.
