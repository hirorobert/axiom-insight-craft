-- ============================================================
-- Migration: 20260630120000 — Phase 5E: WDV Auto-Populate
-- Date: 2026-06-30
-- Authority: ITA Cap.332 s.34 — Wear & Tear
--
-- PURPOSE:
--   When a CPA opens a new tax year for a company, the opening
--   WDV (Written-Down Value) for each asset class should
--   auto-populate from the prior year's closing WDV — eliminating
--   the manual re-entry of 6-10 numbers per client per year.
--
--   This migration adds:
--   1. A DB function that copies closing WDV → opening WDV for the
--      new year when called by kinga-tax-engine or the UI.
--   2. A view v_wdv_carry_forward for easy inspection.
--
-- HOW IT WORKS:
--   kinga-tax-engine (v1.3+) will call this function automatically
--   when it detects that capital_allowances rows for the new period
--   have ita_wdv_opening_tzs = 0 AND a prior period exists with
--   ita_wdv_closing_tzs > 0 for the same asset class + company.
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════
-- 1. AUTO-POPULATE FUNCTION
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.carry_forward_wdv(
  p_company_id  UUID,
  p_from_year   INTEGER,
  p_to_year     INTEGER
)
RETURNS TABLE (
  asset_description   TEXT,
  ita_class           INTEGER,
  wdv_closing_prior   NUMERIC,
  wdv_opening_new     NUMERIC,
  action              TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- For each asset in the prior year that has a non-zero closing WDV,
  -- update the matching asset row in the current year (matched by
  -- asset_description + ita_class) if its opening WDV is still zero.

  RETURN QUERY
  WITH prior_year AS (
    SELECT
      ca.asset_description,
      ca.ita_class,
      ca.ita_wdv_closing_tzs AS wdv_closing
    FROM public.capital_allowances ca
    WHERE ca.company_id  = p_company_id
      AND ca.period_year = p_from_year
      AND ca.ita_wdv_closing_tzs > 0
  ),
  updated AS (
    UPDATE public.capital_allowances cur
    SET
      ita_wdv_opening_tzs = py.wdv_closing,
      updated_at          = now()
    FROM prior_year py
    WHERE cur.company_id          = p_company_id
      AND cur.period_year         = p_to_year
      AND cur.asset_description   = py.asset_description
      AND cur.ita_class           = py.ita_class
      AND cur.ita_wdv_opening_tzs = 0   -- only update if not already set
    RETURNING cur.asset_description, cur.ita_class, py.wdv_closing AS wdv_closing_prior,
              cur.ita_wdv_opening_tzs AS wdv_opening_new
  )
  SELECT
    u.asset_description,
    u.ita_class,
    u.wdv_closing_prior,
    u.wdv_opening_new,
    'UPDATED'::TEXT AS action
  FROM updated u

  UNION ALL

  -- Report assets in prior year that have no matching row in current year yet
  SELECT
    py.asset_description,
    py.ita_class,
    py.wdv_closing,
    0::NUMERIC,
    'MISSING_IN_CURRENT_YEAR'::TEXT
  FROM prior_year py
  WHERE NOT EXISTS (
    SELECT 1 FROM public.capital_allowances cur
    WHERE cur.company_id        = p_company_id
      AND cur.period_year       = p_to_year
      AND cur.asset_description = py.asset_description
      AND cur.ita_class         = py.ita_class
  );

END;
$$;

COMMENT ON FUNCTION public.carry_forward_wdv IS
  'Carries ITA WDV closing balance from p_from_year → p_to_year opening balance '
  'for each asset (matched by asset_description + ita_class). '
  'Called by kinga-tax-engine v1.3 when opening WDV = 0 and prior year data exists. '
  'RETURNS: list of assets updated + any assets missing in the current year.';

GRANT EXECUTE ON FUNCTION public.carry_forward_wdv TO authenticated;
GRANT EXECUTE ON FUNCTION public.carry_forward_wdv TO service_role;


-- ════════════════════════════════════════════════════════════
-- 2. VIEW — WDV CARRY-FORWARD STATUS
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_wdv_carry_forward AS
SELECT
  cur.company_id,
  c.name                          AS company_name,
  cur.period_year                 AS current_year,
  pri.period_year                 AS prior_year,
  cur.asset_description,
  cur.ita_class,
  pri.ita_wdv_closing_tzs         AS wdv_closing_prior,
  cur.ita_wdv_opening_tzs         AS wdv_opening_current,
  CASE
    WHEN cur.ita_wdv_opening_tzs = 0 AND pri.ita_wdv_closing_tzs > 0
      THEN 'NEEDS_CARRY_FORWARD'
    WHEN cur.ita_wdv_opening_tzs = pri.ita_wdv_closing_tzs
      THEN 'MATCHED'
    WHEN cur.ita_wdv_opening_tzs <> pri.ita_wdv_closing_tzs
      THEN 'OVERRIDDEN'
    ELSE 'OK'
  END                             AS status
FROM public.capital_allowances cur
JOIN public.companies c ON c.id = cur.company_id
LEFT JOIN public.capital_allowances pri
  ON  pri.company_id        = cur.company_id
  AND pri.period_year       = cur.period_year - 1
  AND pri.asset_description = cur.asset_description
  AND pri.ita_class         = cur.ita_class
ORDER BY cur.company_id, cur.period_year DESC, cur.ita_class;

COMMENT ON VIEW public.v_wdv_carry_forward IS
  'Shows WDV carry-forward status for each asset. '
  'NEEDS_CARRY_FORWARD: prior year closing WDV exists but current opening = 0. '
  'MATCHED: opening WDV = prior closing WDV (correct). '
  'OVERRIDDEN: CPA manually set a different opening WDV.';


COMMIT;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION SQL
-- ════════════════════════════════════════════════════════════

-- V1: Function exists
-- SELECT routine_name, routine_type FROM information_schema.routines
-- WHERE routine_schema = 'public' AND routine_name = 'carry_forward_wdv';
-- Expected: 1 row, routine_type = 'FUNCTION'

-- V2: View exists
-- SELECT * FROM public.v_wdv_carry_forward LIMIT 5;

-- V3: Manual test (once data exists)
-- SELECT * FROM public.carry_forward_wdv('<company_id>', 2024, 2025);
