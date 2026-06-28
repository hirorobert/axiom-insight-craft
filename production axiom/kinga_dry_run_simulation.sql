-- ============================================================
-- Kinga Findings Engine — Dry-Run Simulation Queries
-- Run in Supabase SQL Editor to preview engine output before
-- deploying the Edge Function.
-- Date: 2026-06-26
--
-- SEQUENCE:
--   Q1 — Pre-flight: which rules are verified right now?
--   Q2 — Pre-flight: which trial balance uploads exist and are valid?
--   Q3 — SDL simulation: what finding would the engine produce?
--   Q4 — WHT simulation: retained earnings base check
--   Q5 — Existing findings: anything already in the table?
--   Q6 — account_mappings audit: are retained earnings accounts flagged?
--
-- Replace :company_id with a real company UUID before running Q2–Q6.
-- Find yours with: SELECT id, user_id FROM public.companies LIMIT 5;
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- Q1: Pre-flight — Which Module B rules are verified right now?
--     Engine only fires on rows where verified_at IS NOT NULL.
--     This tells you exactly which rules will produce findings.
-- ════════════════════════════════════════════════════════════
SELECT
  trigger_category,
  trigger_account_classification,
  rate_pct,
  flat_tax_tzs,
  threshold_amount,
  rate_is_threshold,
  effective_from,
  effective_to,
  verified_at IS NOT NULL            AS is_verified,
  TO_CHAR(verified_at, 'YYYY-MM-DD') AS verified_date
FROM public.statutory_rules
WHERE trigger_account_classification IS NOT NULL
  AND jurisdiction = 'TZ'
  AND effective_to IS NULL
ORDER BY is_verified DESC, trigger_account_classification, trigger_category;

-- Expected output to critically assess:
--   • Any row with is_verified = true will fire when the engine runs.
--   • Rows with is_verified = false are blocked by enforce_verified_statutory_rule.
--   • If ONLY sdl shows is_verified = true, only SDL findings will be generated.
--   • If wht_undistributed_earnings is also verified, WHT findings will also fire.


-- ════════════════════════════════════════════════════════════
-- Q2: Pre-flight — Trial balance uploads for this company
--     The engine requires a valid (status = 'valid') trial balance.
--     This shows what's available.
-- Replace :company_id below.
-- ════════════════════════════════════════════════════════════
SELECT
  id                                                    AS upload_id,
  file_name,
  status,
  uploaded_at,
  (processing_result->>'status')                        AS pr_status,
  (processing_result->'summary'->>'total_accounts')     AS total_accounts,
  (processing_result->'summary'->>'processed_at')       AS processed_at,
  -- Key classification totals for Module B assessment
  ROUND(
    CAST(
      processing_result->'statements'->'income_statement'->'operating_expenses'->>'total'
      AS NUMERIC
    ), 2
  )                                                     AS opex_total_tzs,
  ROUND(
    CAST(
      processing_result->'statements'->'income_statement'->'revenue'->>'total'
      AS NUMERIC
    ), 2
  )                                                     AS revenue_total_tzs,
  ROUND(
    CAST(
      processing_result->'statements'->'balance_sheet'->'equity'->>'total'
      AS NUMERIC
    ), 2
  )                                                     AS equity_total_tzs
FROM public.trial_balance_uploads
WHERE company_id = '<your_company_id>'                  -- REPLACE THIS
ORDER BY uploaded_at DESC;

-- Expected output to critically assess:
--   • pr_status must = 'valid' for the engine to use the upload.
--   • opex_total_tzs: this × 3.5% = raw SDL finding (before payroll filter).
--   • equity_total_tzs: this is the WRONG base for WHT — only retained_earnings
--     subset should be used. Compare with Q4 to see the magnitude of the difference.
--   • revenue_total_tzs: this is the base for vat_registration_threshold advisory.


-- ════════════════════════════════════════════════════════════
-- Q3: SDL dry-run simulation — what the engine would produce
--     Replace :company_id and :upload_id below.
-- ════════════════════════════════════════════════════════════
WITH sdl_rule AS (
  SELECT
    id, trigger_category, trigger_account_classification,
    rate_pct, flat_tax_tzs, rate_is_threshold, statute,
    effective_from, verified_at
  FROM public.statutory_rules
  WHERE trigger_category = 'sdl'
    AND jurisdiction     = 'TZ'
    AND effective_to IS NULL
    AND verified_at IS NOT NULL
),
tb AS (
  SELECT
    id            AS upload_id,
    file_name,
    CAST(
      processing_result->'statements'->'income_statement'->'operating_expenses'->>'total'
      AS NUMERIC
    )             AS opex_total,
    processing_result->'statements'->'income_statement'->'operating_expenses'->'accounts'
                  AS opex_accounts
  FROM public.trial_balance_uploads
  WHERE id = '<your_upload_id>'                        -- REPLACE THIS
    AND (processing_result->>'status') = 'valid'
),
calculation AS (
  SELECT
    r.id                                                      AS statutory_rule_id,
    r.trigger_category,
    r.trigger_account_classification,
    r.rate_pct,
    r.statute,
    t.upload_id,
    t.file_name,
    t.opex_total                                              AS base_amount_tzs,
    ROUND(t.opex_total * r.rate_pct / 100.0, 2)               AS computed_obligation_tzs,
    0.00::NUMERIC                                             AS declared_amount_tzs,
    ROUND(t.opex_total * r.rate_pct / 100.0, 2)               AS variance_tzs,
    100.00::NUMERIC                                           AS variance_pct,
    JSONB_ARRAY_LENGTH(t.opex_accounts)                       AS account_count,
    t.opex_accounts                                           AS account_detail
  FROM sdl_rule r
  CROSS JOIN tb t
  WHERE t.opex_total IS NOT NULL
    AND t.opex_total > 10000                                  -- VARIANCE_THRESHOLD_TZS
)
SELECT
  trigger_category,
  trigger_account_classification,
  CONCAT(rate_pct::TEXT, '% × TZS ', TO_CHAR(base_amount_tzs, 'FM999,999,999,990.00'))
                                                              AS formula,
  base_amount_tzs,
  computed_obligation_tzs,
  declared_amount_tzs,
  variance_tzs,
  variance_pct,
  account_count,
  '⚠ SDL base includes ALL operating expenses (payroll + rent + utilities + depreciation). '
  || 'Actual SDL base = payroll only. Expect OVER-ESTIMATION until payroll accounts '
  || 'are flagged in account_mappings.'                       AS payroll_limitation_warning,
  account_detail                                              AS accounts_included_in_base
FROM calculation;

-- CRITICAL REVIEW CHECKLIST for Q3 output:
-- [ ] Does base_amount_tzs look like total operating expenses for the period?
-- [ ] Does computed_obligation_tzs look plausible as a % of that base?
-- [ ] Look at account_detail: can you see non-payroll accounts like rent, depreciation?
--     If yes — the SDL is over-estimated. By how much?
-- [ ] Is account_count reasonable for this company's chart of accounts?
-- [ ] If base_amount_tzs is NULL: the trial balance has no operating_expenses
--     classification — check account_mappings for this company.


-- ════════════════════════════════════════════════════════════
-- Q4: WHT retained earnings simulation
--     Shows: total equity vs retained-earnings-only base.
--     Quantifies the magnitude of the WHT over-estimation bug
--     that the engine fix in Step C1b addresses.
--     Replace :company_id and :upload_id below.
-- ════════════════════════════════════════════════════════════
WITH equity_data AS (
  SELECT
    CAST(
      processing_result->'statements'->'balance_sheet'->'equity'->>'total'
      AS NUMERIC
    ) AS total_equity,
    processing_result->'statements'->'balance_sheet'->'equity'->'accounts'
      AS equity_accounts
  FROM public.trial_balance_uploads
  WHERE id = '<your_upload_id>'                        -- REPLACE THIS
    AND (processing_result->>'status') = 'valid'
),
retained_earnings_accounts AS (
  SELECT account_code
  FROM public.account_mappings am
  JOIN public.companies c ON c.user_id = am.user_id
  WHERE c.id = '<your_company_id>'                     -- REPLACE THIS
    AND am.is_retained_earnings = true
),
wht_rule AS (
  SELECT id, trigger_category, rate_pct, verified_at IS NOT NULL AS is_verified
  FROM public.statutory_rules
  WHERE trigger_category = 'wht_undistributed_earnings'
    AND jurisdiction = 'TZ' AND effective_to IS NULL
)
SELECT
  w.trigger_category,
  w.rate_pct,
  w.is_verified                                                   AS rule_is_verified,
  ed.total_equity                                                 AS total_equity_tzs,
  -- Retained earnings accounts flagged in account_mappings
  (SELECT COUNT(*) FROM retained_earnings_accounts)               AS retained_earnings_account_count,
  (SELECT STRING_AGG(account_code, ', ') FROM retained_earnings_accounts)
                                                                  AS retained_earnings_codes,
  -- What the UNFIXED engine would compute (wrong — all equity)
  ROUND(ed.total_equity * w.rate_pct / 100.0, 2)                 AS wht_on_total_equity_WRONG,
  -- What the FIXED engine computes (retained earnings accounts only)
  -- This requires matching equity_accounts JSONB array against retained_earnings_accounts.
  -- Below: conservative — if 0 retained accounts flagged, safe base = 0
  CASE
    WHEN (SELECT COUNT(*) FROM retained_earnings_accounts) = 0
    THEN 'ERROR: No is_retained_earnings=true accounts found. WHT cannot be computed safely.'
    ELSE 'See Q4b below for retained-only total.'
  END                                                             AS wht_safe_base_status,
  ed.equity_accounts                                              AS all_equity_accounts_detail
FROM wht_rule w
CROSS JOIN equity_data ed;

-- CRITICAL REVIEW CHECKLIST for Q4 output:
-- [ ] Is rule_is_verified = true? If yes, WHT will fire in the engine.
-- [ ] How large is total_equity_tzs vs retained_earnings only?
--     If retained_earnings_account_count = 0: engine would emit an error finding,
--     not a WHT obligation finding. You need to flag retained earnings in account_mappings.
-- [ ] Look at all_equity_accounts_detail: identify which accounts are share capital
--     (should NOT be in WHT base) vs retained earnings (should be).
-- [ ] wht_on_total_equity_WRONG: this was the UNFIXED engine's number.
--     After the fix, the engine uses only retained earnings accounts.


-- ════════════════════════════════════════════════════════════
-- Q5: Existing findings — prevent running if already populated
--     Check before running the engine for a period.
-- Replace :company_id below.
-- ════════════════════════════════════════════════════════════
SELECT
  f.id,
  sr.trigger_category,
  f.finding_type,
  f.title,
  f.period_start,
  f.period_end,
  f.computed_obligation_tzs,
  f.exposure_amount_tzs,
  f.status,
  f.engine_run_id,
  f.created_at
FROM public.findings f
LEFT JOIN public.statutory_rules sr ON sr.id = f.statutory_rule_id
WHERE f.company_id = '<your_company_id>'               -- REPLACE THIS
ORDER BY f.period_start DESC, sr.trigger_category;

-- Expected: 0 rows before first engine run.
-- If rows exist for a period you're about to run: the engine will skip those
-- (23505 on uq_finding_per_rule_per_period — now that migration 20260626190000
-- has been applied). Verify the existing findings are correct before re-running.


-- ════════════════════════════════════════════════════════════
-- Q6: account_mappings audit — retained earnings and payroll flags
--     Critical for knowing whether WHT and SDL will compute correctly.
-- Replace :company_id below.
-- ════════════════════════════════════════════════════════════
SELECT
  am.account_code,
  am.account_name,
  am.statement,
  am.classification,
  am.normal_balance,
  am.is_cash_account,
  am.is_retained_earnings,
  -- is_payroll_account does not exist yet (OD-2 open decision).
  -- SDL uses ALL operating_expenses until this field is added.
  CASE
    WHEN am.classification = 'equity'             AND am.is_retained_earnings = true
    THEN 'WHT base ✓'
    WHEN am.classification = 'equity'             AND am.is_retained_earnings = false
    THEN 'equity — NOT in WHT base (share capital / reserves)'
    WHEN am.classification = 'operating_expenses'
    THEN 'SDL base (incl. non-payroll ⚠)'
    WHEN am.classification = 'revenue'
    THEN 'Presumptive tax / VAT threshold base'
    ELSE am.classification
  END                                                     AS engine_role
FROM public.account_mappings am
JOIN public.companies c ON c.user_id = am.user_id
WHERE c.id = '<your_company_id>'                         -- REPLACE THIS
ORDER BY am.statement, am.classification, am.account_code;

-- CRITICAL REVIEW CHECKLIST for Q6 output:
-- [ ] Equity accounts: is_retained_earnings = true on the correct ones?
--     If ALL equity accounts have is_retained_earnings = false, WHT engine
--     will emit a config error (no retained earnings accounts found).
-- [ ] Operating_expenses accounts: these ALL feed into the SDL base.
--     Identify which are payroll vs non-payroll. The payroll:total ratio
--     is the SDL over-estimation factor (e.g. 20M payroll / 80M opex = 4× over).
-- [ ] Revenue accounts: are they all mapped? Any missing = understated
--     presumptive tax base and VAT threshold check.
