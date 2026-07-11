-- ============================================================================
-- MAONO · PHASE A · IRON DOME NUCLEAR DESIGN
-- CFO Intelligence Engine — Foundation Layer
--
-- Tables:
--   1. account_pl_mapping       P&L category hierarchy (Hoffman fac-ifrs derived)
--   2. variance_materiality     Per-company configurable thresholds
--   3. variance_budgets         Version-controlled, approval-gated budgets
--   4. variance_runs            Append-only run log
--   5. variance_analyses        Append-only computed variances
--
-- Phase B tables (cashflow_forecasts, maono_insights, variance_alerts,
--   maono_context) are in 20260711300100_maono_phase_b.sql
--
-- IRON DOME FOUNDING CONSTRAINTS (read before touching this file):
--   1. maono-compute MUST verify safisha_status='clean' on every TB upload used.
--   2. Budget rows are IMMUTABLE after approved_by is set.
--   3. variance_runs and variance_analyses are APPEND-ONLY (trigger-enforced).
--   4. All materiality thresholds are configurable per company — no hardcoded %.
--   5. Any future data source must pass a Safisha-equivalent gate before Maono
--      can consume it. This is a founding constraint, not a future decision.
-- ============================================================================

-- ── 1. account_pl_mapping ─────────────────────────────────────────────────────
--
-- Maps account codes / code ranges / name patterns → IFRS P&L categories.
-- Hierarchy based on Charles Hoffman's fac-ifrs fundamental accounting concepts:
--   Revenue → Gross Profit → EBITDA → EBIT → EBT → Net Profit
--
-- Priority: exact (1) > range (2) > pattern (3)
-- Client-specific overrides have priority over global defaults.

CREATE TABLE IF NOT EXISTS account_pl_mapping (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope: NULL = global default; company_id = client override
  company_id       UUID REFERENCES companies(id) ON DELETE CASCADE,

  -- Matching rule
  match_type       TEXT NOT NULL CHECK (match_type IN ('exact', 'range', 'pattern')),
  -- exact:   account_code = match_value
  -- range:   match_value = '4000-4999' → account_code BETWEEN '4000' AND '4999'
  -- pattern: match_value is a SIMILAR TO pattern on account_name (normalised)
  match_value      TEXT NOT NULL,
  match_priority   INTEGER NOT NULL DEFAULT 50,  -- lower = higher priority

  -- P&L classification (Hoffman hierarchy)
  pl_category      TEXT NOT NULL CHECK (pl_category IN (
    'REVENUE',              -- all sales / turnover lines
    'COST_OF_SALES',        -- COGS, direct labour, direct materials
    'OTHER_INCOME',         -- non-trading income (gain on disposal, etc.)
    'PERSONNEL_COSTS',      -- staff costs (PAYE base)
    'DEPRECIATION',         -- D&A — separated for EBITDA add-back
    'AMORTISATION',         -- intangibles — separated for EBITDA add-back
    'OTHER_OPEX',           -- G&A, marketing, rent, utilities
    'FINANCE_INCOME',       -- interest received
    'FINANCE_COSTS',        -- interest paid (thin-cap scrutinised)
    'TAX_EXPENSE',          -- CIT + DTA movement
    'WITHHOLDING_TAX',      -- WHT deducted at source
    'BALANCE_SHEET_ASSET',  -- not a P&L line — excluded from income statement
    'BALANCE_SHEET_LIAB',
    'BALANCE_SHEET_EQUITY',
    'STATISTICAL'           -- memo / control accounts — excluded from totals
  )),

  -- Whether this account's normal balance is credit (revenue, liability, equity)
  -- vs debit (asset, expense). Used for sign-flip in variance computation.
  is_credit_normal BOOLEAN NOT NULL DEFAULT FALSE,

  -- Source of this rule
  source           TEXT NOT NULL DEFAULT 'saff_default'
                   CHECK (source IN ('saff_default', 'hoffman_fac_ifrs', 'csf_tz_coa', 'client_override')),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES auth.users(id),

  CONSTRAINT account_pl_mapping_unique_rule
    UNIQUE NULLS NOT DISTINCT (company_id, match_type, match_value)
);

-- Tanzania SME default mappings (Hoffman fac-ifrs + standard East African CoA ranges)
-- Account code conventions: 1xxx=Assets, 2xxx=Liab, 3xxx=Equity,
--   4xxx=Revenue, 5xxx=CoS, 6xxx=OpEx, 7xxx=Other Income, 8xxx=Finance, 9xxx=Tax

INSERT INTO account_pl_mapping
  (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
VALUES
  -- Revenue (4000–4999)
  (NULL, 'range', '4000-4999', 10, 'REVENUE',         TRUE,  'saff_default'),
  -- Cost of Sales (5000–5999)
  (NULL, 'range', '5000-5999', 10, 'COST_OF_SALES',   FALSE, 'saff_default'),
  -- Personnel costs (6000–6099 typical)
  (NULL, 'range', '6000-6099', 20, 'PERSONNEL_COSTS', FALSE, 'saff_default'),
  -- Depreciation / Amortisation (6100–6199 typical)
  (NULL, 'range', '6100-6149', 20, 'DEPRECIATION',    FALSE, 'saff_default'),
  (NULL, 'range', '6150-6199', 20, 'AMORTISATION',    FALSE, 'saff_default'),
  -- Other OpEx (6200–6999)
  (NULL, 'range', '6200-6999', 30, 'OTHER_OPEX',      FALSE, 'saff_default'),
  -- Other Income (7000–7499)
  (NULL, 'range', '7000-7499', 10, 'OTHER_INCOME',    TRUE,  'saff_default'),
  -- Finance Income (7500–7699)
  (NULL, 'range', '7500-7699', 10, 'FINANCE_INCOME',  TRUE,  'saff_default'),
  -- Finance Costs (8000–8499)
  (NULL, 'range', '8000-8499', 10, 'FINANCE_COSTS',   FALSE, 'saff_default'),
  -- Withholding Tax (8500–8699)
  (NULL, 'range', '8500-8699', 10, 'WITHHOLDING_TAX', FALSE, 'saff_default'),
  -- Tax Expense (9000–9499)
  (NULL, 'range', '9000-9499', 10, 'TAX_EXPENSE',     FALSE, 'saff_default'),
  -- Balance Sheet: Assets (1xxx), Liabilities (2xxx), Equity (3xxx)
  (NULL, 'range', '1000-1999', 10, 'BALANCE_SHEET_ASSET',  FALSE, 'saff_default'),
  (NULL, 'range', '2000-2999', 10, 'BALANCE_SHEET_LIAB',   TRUE,  'saff_default'),
  (NULL, 'range', '3000-3999', 10, 'BALANCE_SHEET_EQUITY', TRUE,  'saff_default')
ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

-- Pattern-based fallbacks (for accounts outside standard ranges)
INSERT INTO account_pl_mapping
  (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
VALUES
  (NULL, 'pattern', '%(revenue|sales|turnover|income from)%',  90, 'REVENUE',        TRUE,  'saff_default'),
  (NULL, 'pattern', '%(cost of sales|cost of goods|cogs)%',    90, 'COST_OF_SALES',  FALSE, 'saff_default'),
  (NULL, 'pattern', '%(salary|salaries|wages|payroll|staff)%', 90, 'PERSONNEL_COSTS',FALSE, 'saff_default'),
  (NULL, 'pattern', '%(depreciation|amortis)%',                90, 'DEPRECIATION',   FALSE, 'saff_default'),
  (NULL, 'pattern', '%(interest expense|finance charge|loan)%',90, 'FINANCE_COSTS',  FALSE, 'saff_default'),
  (NULL, 'pattern', '%(interest income|investment income)%',   90, 'FINANCE_INCOME', TRUE,  'saff_default'),
  (NULL, 'pattern', '%(income tax|corporate tax|deferred tax)%',90,'TAX_EXPENSE',    FALSE, 'saff_default')
ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

-- Computed P&L aggregation definitions (Hoffman arithmetic chain)
-- These are computed in maono-compute, not stored as rows:
--   GROSS_PROFIT   = sum(REVENUE) + sum(OTHER_INCOME) - sum(COST_OF_SALES)
--   EBITDA         = GROSS_PROFIT - sum(PERSONNEL_COSTS) - sum(OTHER_OPEX)
--   EBIT           = EBITDA - sum(DEPRECIATION) - sum(AMORTISATION)
--   EBT            = EBIT + sum(FINANCE_INCOME) - sum(FINANCE_COSTS)
--   NET_PROFIT     = EBT - sum(TAX_EXPENSE) - sum(WITHHOLDING_TAX)

COMMENT ON TABLE account_pl_mapping IS
  'Maps account codes to IFRS P&L categories per Hoffman fac-ifrs fundamental '
  'accounting concepts. Priority: exact(1) > range(2) > pattern(3). '
  'company_id=NULL = global default; company_id SET = client override (takes precedence).';

CREATE INDEX IF NOT EXISTS idx_account_pl_mapping_company
  ON account_pl_mapping(company_id, match_type, match_priority);

ALTER TABLE account_pl_mapping ENABLE ROW LEVEL SECURITY;

CREATE POLICY "account_pl_mapping_read" ON account_pl_mapping
  FOR SELECT USING (
    company_id IS NULL OR                              -- global defaults visible to all
    company_id IN (
      SELECT company_id FROM firm_members WHERE user_id = auth.uid()
    )
  );
CREATE POLICY "account_pl_mapping_write" ON account_pl_mapping
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM firm_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'partner', 'manager')
    )
  );

-- ── 2. variance_materiality ───────────────────────────────────────────────────
--
-- Per-company configurable thresholds. No hardcoded percentages anywhere.
-- Materiality = TRUE when (variance_pct >= pct_threshold) OR (|variance_tzs| >= abs_threshold_tzs)

CREATE TABLE IF NOT EXISTS variance_materiality (
  company_id          UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,

  -- Variance thresholds
  pct_threshold       NUMERIC(6,2)  NOT NULL DEFAULT 10.0  CHECK (pct_threshold > 0),
  abs_threshold_tzs   NUMERIC(18,2) NOT NULL DEFAULT 5000000 CHECK (abs_threshold_tzs > 0),

  -- Cash flow warning thresholds (days of runway)
  cash_warn_days      INTEGER       NOT NULL DEFAULT 30    CHECK (cash_warn_days > 0),
  cash_critical_days  INTEGER       NOT NULL DEFAULT 14    CHECK (cash_critical_days > 0 AND cash_critical_days < cash_warn_days),

  -- Trend confidence (periods needed for each confidence level)
  min_periods_medium  INTEGER       NOT NULL DEFAULT 4,
  min_periods_high    INTEGER       NOT NULL DEFAULT 8,

  updated_by          UUID REFERENCES auth.users(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cash_thresholds_ordered CHECK (cash_critical_days < cash_warn_days)
);

COMMENT ON TABLE variance_materiality IS
  'Per-company variance materiality thresholds. No threshold is hardcoded in '
  'application code — all comparisons reference this table. '
  'Variance is material if: variance_pct >= pct_threshold OR |variance_tzs| >= abs_threshold_tzs.';

ALTER TABLE variance_materiality ENABLE ROW LEVEL SECURITY;
CREATE POLICY "variance_materiality_read" ON variance_materiality
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  );
CREATE POLICY "variance_materiality_write" ON variance_materiality
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM firm_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'partner', 'manager')
    )
  );

-- ── 3. variance_budgets ───────────────────────────────────────────────────────
--
-- IRON DOME: Budgets are VERSION-CONTROLLED.
-- Once approved_by is set (budget approved), the row is IMMUTABLE.
-- New budgets create new versions. Variance always references the version
-- active at period_from — never overwritten retroactively.

CREATE TABLE IF NOT EXISTS variance_budgets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year      INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  period_month     INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  account_code     TEXT    NOT NULL,
  account_name     TEXT,

  -- Budget figures (same sign convention as TB: debit positive, credit positive in their column)
  budget_debit     NUMERIC(18,2),
  budget_credit    NUMERIC(18,2),

  -- Version control
  version          INTEGER NOT NULL DEFAULT 1,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_by    UUID REFERENCES variance_budgets(id),

  -- Approval gate
  submitted_by     UUID NOT NULL REFERENCES auth.users(id),
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by      UUID REFERENCES auth.users(id),
  approved_at      TIMESTAMPTZ,

  -- Import metadata
  source           TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual', 'csv_import', 'prior_year_actuals')),
  import_batch_id  UUID,

  CONSTRAINT budget_unique_active
    UNIQUE NULLS NOT DISTINCT (company_id, fiscal_year, period_month, account_code, version)
);

-- IRON DOME: Budget immutability trigger
-- Once approved_by IS NOT NULL, the row cannot be modified.
CREATE OR REPLACE FUNCTION enforce_budget_immutability()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.approved_by IS NOT NULL THEN
    RAISE EXCEPTION
      'IRON DOME: Approved budget rows are immutable. '
      'Create a new version (version=%) to supersede this budget.',
      OLD.version + 1
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER budget_enforce_immutability
  BEFORE UPDATE ON variance_budgets
  FOR EACH ROW EXECUTE FUNCTION enforce_budget_immutability();

-- Prevent deletion of approved budgets
CREATE OR REPLACE FUNCTION enforce_budget_no_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.approved_by IS NOT NULL THEN
    RAISE EXCEPTION
      'IRON DOME: Approved budget rows cannot be deleted. '
      'Set is_active=FALSE on a new version row to supersede.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER budget_enforce_no_delete
  BEFORE DELETE ON variance_budgets
  FOR EACH ROW EXECUTE FUNCTION enforce_budget_no_delete();

CREATE INDEX IF NOT EXISTS idx_variance_budgets_lookup
  ON variance_budgets(company_id, fiscal_year, period_month, account_code)
  WHERE is_active = TRUE AND approved_by IS NOT NULL;

ALTER TABLE variance_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "budget_read" ON variance_budgets
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  );
CREATE POLICY "budget_submit" ON variance_budgets
  FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
    AND submitted_by = auth.uid()
    AND approved_by IS NULL  -- cannot self-approve on insert
  );
CREATE POLICY "budget_approve" ON variance_budgets
  FOR UPDATE USING (
    company_id IN (
      SELECT company_id FROM firm_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'partner', 'manager')
    )
    AND approved_by IS NULL  -- can only approve once
  );

-- ── 4. variance_runs ─────────────────────────────────────────────────────────
--
-- IRON DOME: APPEND-ONLY. Historical runs cannot be deleted or overwritten.
-- Each re-analysis creates a new run_id. Full audit trail of every analysis.

CREATE TABLE IF NOT EXISTS variance_runs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Snapshot of exact TB uploads used (Iron Dome: immutable after run)
  tb_upload_ids          UUID[] NOT NULL,

  -- Period
  period_from            DATE NOT NULL,
  period_to              DATE NOT NULL,
  fiscal_year            INTEGER NOT NULL,
  period_month           INTEGER NOT NULL,

  -- Budget version used (snapshot reference)
  budget_version_ids     UUID[] NOT NULL DEFAULT '{}',

  -- Run metadata
  trigger_type           TEXT NOT NULL DEFAULT 'manual'
                         CHECK (trigger_type IN ('manual', 'scheduled', 'api')),
  triggered_by           UUID NOT NULL REFERENCES auth.users(id),
  status                 TEXT NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running', 'complete', 'error')),
  error_message          TEXT,

  -- Safisha gate result (logged for audit)
  safisha_gate_passed    BOOLEAN,
  safisha_blocked_uploads UUID[],

  -- Summary (denormalised for fast dashboard queries)
  total_accounts         INTEGER,
  material_variance_count INTEGER,
  gross_profit_variance_tzs NUMERIC(18,2),
  ebitda_variance_tzs    NUMERIC(18,2),
  net_profit_variance_tzs NUMERIC(18,2),

  -- Confidence level (seasonal periods available at run time)
  seasonal_periods_available INTEGER NOT NULL DEFAULT 0,
  trend_confidence       TEXT NOT NULL DEFAULT 'none'
                         CHECK (trend_confidence IN ('high','medium','low','none')),

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT run_period_valid CHECK (period_from <= period_to)
);

-- APPEND-ONLY enforcement
CREATE OR REPLACE FUNCTION maono_block_run_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only allow status + summary updates on the same run
    IF OLD.id                   != NEW.id                   OR
       OLD.company_id           != NEW.company_id           OR
       OLD.tb_upload_ids        != NEW.tb_upload_ids        OR
       OLD.period_from          != NEW.period_from          OR
       OLD.period_to            != NEW.period_to            OR
       OLD.triggered_by         != NEW.triggered_by         THEN
      RAISE EXCEPTION
        'IRON DOME: variance_runs is append-only. '
        'Core fields cannot be changed after run creation.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'IRON DOME: variance_runs rows cannot be deleted. All analysis history is permanent.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER maono_runs_append_only
  BEFORE UPDATE OR DELETE ON variance_runs
  FOR EACH ROW EXECUTE FUNCTION maono_block_run_mutation();

CREATE INDEX IF NOT EXISTS idx_variance_runs_company
  ON variance_runs(company_id, period_from DESC, status);

ALTER TABLE variance_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "runs_read" ON variance_runs
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  );
CREATE POLICY "runs_insert" ON variance_runs
  FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
    AND triggered_by = auth.uid()
  );

-- ── 5. variance_analyses ──────────────────────────────────────────────────────
--
-- IRON DOME: APPEND-ONLY. One row per account per run. Never updated after write.

CREATE TABLE IF NOT EXISTS variance_analyses (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               UUID NOT NULL REFERENCES variance_runs(id),
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Account identity
  account_code         TEXT    NOT NULL,
  account_name         TEXT,
  pl_category          TEXT    NOT NULL,   -- from account_pl_mapping
  pl_subcategory       TEXT,
  is_credit_normal     BOOLEAN NOT NULL DEFAULT FALSE,

  -- Figures (all in TZS)
  actual_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  budget_amount        NUMERIC(18,2),
  prior_period_amount  NUMERIC(18,2),
  prior_year_amount    NUMERIC(18,2),

  -- Computed variances (actual vs budget)
  variance_tzs         NUMERIC(18,2),   -- actual - budget
  variance_pct         NUMERIC(8,4),    -- (actual - budget) / ABS(budget) * 100
  is_material          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Computed period-over-period
  pop_variance_tzs     NUMERIC(18,2),   -- actual - prior_period
  pop_variance_pct     NUMERIC(8,4),

  -- Computed year-over-year
  yoy_variance_tzs     NUMERIC(18,2),   -- actual - prior_year
  yoy_variance_pct     NUMERIC(8,4),

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APPEND-ONLY enforcement
CREATE OR REPLACE FUNCTION maono_block_analysis_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'IRON DOME: variance_analyses is append-only. '
      'Run a new analysis (new run_id) to recompute variances.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER maono_analyses_append_only
  BEFORE UPDATE OR DELETE ON variance_analyses
  FOR EACH ROW EXECUTE FUNCTION maono_block_analysis_mutation();

CREATE INDEX IF NOT EXISTS idx_variance_analyses_run
  ON variance_analyses(run_id, pl_category, is_material);

CREATE INDEX IF NOT EXISTS idx_variance_analyses_company_period
  ON variance_analyses(company_id, pl_category)
  INCLUDE (actual_amount, variance_tzs, variance_pct, is_material);

ALTER TABLE variance_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "analyses_read" ON variance_analyses
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  );
CREATE POLICY "analyses_insert" ON variance_analyses
  FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  );

-- ── Safisha gate helper function ──────────────────────────────────────────────
--
-- Called by maono-compute before any analysis runs.
-- Returns the list of blocked upload IDs (safisha_status != 'clean').
-- If any uploads are blocked, the Edge Function must abort the run.

CREATE OR REPLACE FUNCTION maono_check_safisha_gate(
  p_upload_ids UUID[]
)
RETURNS TABLE(
  upload_id      UUID,
  safisha_status TEXT,
  is_blocked     BOOLEAN
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT
    id AS upload_id,
    COALESCE(safisha_status, 'not_started') AS safisha_status,
    COALESCE(safisha_status, 'not_started') != 'clean' AS is_blocked
  FROM trial_balance_uploads
  WHERE id = ANY(p_upload_ids)
  ORDER BY id;
$$;

COMMENT ON FUNCTION maono_check_safisha_gate IS
  'IRON DOME gate function. maono-compute calls this before every analysis run. '
  'If any upload returns is_blocked=TRUE, the run must not proceed. '
  'Dirty data never enters Maono.';

-- ── Confidence level function ─────────────────────────────────────────────────
--
-- Deterministic formula (Fix 4a from brutal assessment):
--   seasonal_periods_available = count of prior years with clean data for same month
--   confidence_level based on thresholds in variance_materiality

CREATE OR REPLACE FUNCTION maono_compute_confidence(
  p_company_id   UUID,
  p_period_month INTEGER
)
RETURNS TABLE(
  seasonal_periods_available INTEGER,
  trend_confidence           TEXT
) LANGUAGE sql SECURITY DEFINER AS $$
  WITH seasonal AS (
    SELECT COUNT(DISTINCT fiscal_year) AS periods
    FROM variance_runs
    WHERE company_id     = p_company_id
      AND period_month   = p_period_month
      AND status         = 'complete'
  ),
  thresholds AS (
    SELECT
      COALESCE(min_periods_medium, 4) AS med_threshold,
      COALESCE(min_periods_high,   8) AS high_threshold
    FROM variance_materiality
    WHERE company_id = p_company_id
    UNION ALL
    SELECT 4, 8  -- defaults if no row exists
    LIMIT 1
  )
  SELECT
    seasonal.periods::INTEGER,
    CASE
      WHEN seasonal.periods >= thresholds.high_threshold THEN 'high'
      WHEN seasonal.periods >= thresholds.med_threshold  THEN 'medium'
      WHEN seasonal.periods >= 2                         THEN 'low'
      ELSE 'none'
    END
  FROM seasonal, thresholds;
$$;

COMMENT ON FUNCTION maono_compute_confidence IS
  'Deterministic confidence level formula per Fix 4a. '
  'seasonal_periods_available = count of prior years with completed run for same month. '
  'Thresholds from variance_materiality (configurable). '
  'confidence=none disables trend analysis entirely — maono-risk returns early.';

-- ── Grant execute ─────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION maono_check_safisha_gate TO authenticated;
GRANT EXECUTE ON FUNCTION maono_compute_confidence  TO authenticated;
