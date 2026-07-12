-- 20260711300000_maono_phase_a.sql (verbatim, with search_path & GRANTs added for the linter)
CREATE TABLE IF NOT EXISTS account_pl_mapping (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID REFERENCES companies(id) ON DELETE CASCADE,
  match_type       TEXT NOT NULL CHECK (match_type IN ('exact', 'range', 'pattern')),
  match_value      TEXT NOT NULL,
  match_priority   INTEGER NOT NULL DEFAULT 50,
  pl_category      TEXT NOT NULL CHECK (pl_category IN (
    'REVENUE','COST_OF_SALES','OTHER_INCOME','PERSONNEL_COSTS','DEPRECIATION','AMORTISATION',
    'OTHER_OPEX','FINANCE_INCOME','FINANCE_COSTS','TAX_EXPENSE','WITHHOLDING_TAX',
    'BALANCE_SHEET_ASSET','BALANCE_SHEET_LIAB','BALANCE_SHEET_EQUITY','STATISTICAL'
  )),
  is_credit_normal BOOLEAN NOT NULL DEFAULT FALSE,
  source           TEXT NOT NULL DEFAULT 'saff_default'
                   CHECK (source IN ('saff_default','hoffman_fac_ifrs','csf_tz_coa','client_override')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES auth.users(id),
  CONSTRAINT account_pl_mapping_unique_rule
    UNIQUE NULLS NOT DISTINCT (company_id, match_type, match_value)
);

INSERT INTO account_pl_mapping
  (company_id, match_type, match_value, match_priority, pl_category, is_credit_normal, source)
VALUES
  (NULL, 'range', '4000-4999', 10, 'REVENUE',         TRUE,  'saff_default'),
  (NULL, 'range', '5000-5999', 10, 'COST_OF_SALES',   FALSE, 'saff_default'),
  (NULL, 'range', '6000-6099', 20, 'PERSONNEL_COSTS', FALSE, 'saff_default'),
  (NULL, 'range', '6100-6149', 20, 'DEPRECIATION',    FALSE, 'saff_default'),
  (NULL, 'range', '6150-6199', 20, 'AMORTISATION',    FALSE, 'saff_default'),
  (NULL, 'range', '6200-6999', 30, 'OTHER_OPEX',      FALSE, 'saff_default'),
  (NULL, 'range', '7000-7499', 10, 'OTHER_INCOME',    TRUE,  'saff_default'),
  (NULL, 'range', '7500-7699', 10, 'FINANCE_INCOME',  TRUE,  'saff_default'),
  (NULL, 'range', '8000-8499', 10, 'FINANCE_COSTS',   FALSE, 'saff_default'),
  (NULL, 'range', '8500-8699', 10, 'WITHHOLDING_TAX', FALSE, 'saff_default'),
  (NULL, 'range', '9000-9499', 10, 'TAX_EXPENSE',     FALSE, 'saff_default'),
  (NULL, 'range', '1000-1999', 10, 'BALANCE_SHEET_ASSET',  FALSE, 'saff_default'),
  (NULL, 'range', '2000-2999', 10, 'BALANCE_SHEET_LIAB',   TRUE,  'saff_default'),
  (NULL, 'range', '3000-3999', 10, 'BALANCE_SHEET_EQUITY', TRUE,  'saff_default')
ON CONFLICT (company_id, match_type, match_value) DO NOTHING;

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

CREATE INDEX IF NOT EXISTS idx_account_pl_mapping_company
  ON account_pl_mapping(company_id, match_type, match_priority);

GRANT SELECT ON account_pl_mapping TO authenticated;
GRANT INSERT ON account_pl_mapping TO authenticated;
GRANT ALL ON account_pl_mapping TO service_role;

ALTER TABLE account_pl_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY "account_pl_mapping_read" ON account_pl_mapping
  FOR SELECT USING (
    company_id IS NULL OR
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  );
CREATE POLICY "account_pl_mapping_write" ON account_pl_mapping
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM firm_members
      WHERE user_id = auth.uid() AND role IN ('owner','partner','manager')
    )
  );

CREATE TABLE IF NOT EXISTS variance_materiality (
  company_id          UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  pct_threshold       NUMERIC(6,2)  NOT NULL DEFAULT 10.0  CHECK (pct_threshold > 0),
  abs_threshold_tzs   NUMERIC(18,2) NOT NULL DEFAULT 5000000 CHECK (abs_threshold_tzs > 0),
  cash_warn_days      INTEGER       NOT NULL DEFAULT 30    CHECK (cash_warn_days > 0),
  cash_critical_days  INTEGER       NOT NULL DEFAULT 14    CHECK (cash_critical_days > 0 AND cash_critical_days < cash_warn_days),
  min_periods_medium  INTEGER       NOT NULL DEFAULT 4,
  min_periods_high    INTEGER       NOT NULL DEFAULT 8,
  updated_by          UUID REFERENCES auth.users(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cash_thresholds_ordered CHECK (cash_critical_days < cash_warn_days)
);

GRANT SELECT, INSERT, UPDATE ON variance_materiality TO authenticated;
GRANT ALL ON variance_materiality TO service_role;

ALTER TABLE variance_materiality ENABLE ROW LEVEL SECURITY;
CREATE POLICY "variance_materiality_read" ON variance_materiality
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  );
CREATE POLICY "variance_materiality_write" ON variance_materiality
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM firm_members
      WHERE user_id = auth.uid() AND role IN ('owner','partner','manager')
    )
  );

CREATE TABLE IF NOT EXISTS variance_budgets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year      INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  period_month     INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  account_code     TEXT    NOT NULL,
  account_name     TEXT,
  budget_debit     NUMERIC(18,2),
  budget_credit    NUMERIC(18,2),
  version          INTEGER NOT NULL DEFAULT 1,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_by    UUID REFERENCES variance_budgets(id),
  submitted_by     UUID NOT NULL REFERENCES auth.users(id),
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by      UUID REFERENCES auth.users(id),
  approved_at      TIMESTAMPTZ,
  source           TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','csv_import','prior_year_actuals')),
  import_batch_id  UUID,
  CONSTRAINT budget_unique_active
    UNIQUE NULLS NOT DISTINCT (company_id, fiscal_year, period_month, account_code, version)
);

CREATE OR REPLACE FUNCTION enforce_budget_immutability()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.approved_by IS NOT NULL THEN
    RAISE EXCEPTION
      'IRON DOME: Approved budget rows are immutable. Create a new version (version=%) to supersede this budget.',
      OLD.version + 1
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS budget_enforce_immutability ON variance_budgets;
CREATE TRIGGER budget_enforce_immutability
  BEFORE UPDATE ON variance_budgets
  FOR EACH ROW EXECUTE FUNCTION enforce_budget_immutability();

CREATE OR REPLACE FUNCTION enforce_budget_no_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.approved_by IS NOT NULL THEN
    RAISE EXCEPTION
      'IRON DOME: Approved budget rows cannot be deleted. Set is_active=FALSE on a new version row to supersede.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS budget_enforce_no_delete ON variance_budgets;
CREATE TRIGGER budget_enforce_no_delete
  BEFORE DELETE ON variance_budgets
  FOR EACH ROW EXECUTE FUNCTION enforce_budget_no_delete();

CREATE INDEX IF NOT EXISTS idx_variance_budgets_lookup
  ON variance_budgets(company_id, fiscal_year, period_month, account_code)
  WHERE is_active = TRUE AND approved_by IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON variance_budgets TO authenticated;
GRANT ALL ON variance_budgets TO service_role;

ALTER TABLE variance_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "budget_read" ON variance_budgets
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  );
CREATE POLICY "budget_submit" ON variance_budgets
  FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
    AND submitted_by = auth.uid()
    AND approved_by IS NULL
  );
CREATE POLICY "budget_approve" ON variance_budgets
  FOR UPDATE USING (
    company_id IN (
      SELECT company_id FROM firm_members
      WHERE user_id = auth.uid() AND role IN ('owner','partner','manager')
    )
    AND approved_by IS NULL
  );

CREATE TABLE IF NOT EXISTS variance_runs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tb_upload_ids          UUID[] NOT NULL,
  period_from            DATE NOT NULL,
  period_to              DATE NOT NULL,
  fiscal_year            INTEGER NOT NULL,
  period_month           INTEGER NOT NULL,
  budget_version_ids     UUID[] NOT NULL DEFAULT '{}',
  trigger_type           TEXT NOT NULL DEFAULT 'manual'
                         CHECK (trigger_type IN ('manual','scheduled','api')),
  triggered_by           UUID NOT NULL REFERENCES auth.users(id),
  status                 TEXT NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running','complete','error')),
  error_message          TEXT,
  safisha_gate_passed    BOOLEAN,
  safisha_blocked_uploads UUID[],
  total_accounts         INTEGER,
  material_variance_count INTEGER,
  gross_profit_variance_tzs NUMERIC(18,2),
  ebitda_variance_tzs    NUMERIC(18,2),
  net_profit_variance_tzs NUMERIC(18,2),
  seasonal_periods_available INTEGER NOT NULL DEFAULT 0,
  trend_confidence       TEXT NOT NULL DEFAULT 'none'
                         CHECK (trend_confidence IN ('high','medium','low','none')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT run_period_valid CHECK (period_from <= period_to)
);

CREATE OR REPLACE FUNCTION maono_block_run_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.id                   != NEW.id                   OR
       OLD.company_id           != NEW.company_id           OR
       OLD.tb_upload_ids        != NEW.tb_upload_ids        OR
       OLD.period_from          != NEW.period_from          OR
       OLD.period_to            != NEW.period_to            OR
       OLD.triggered_by         != NEW.triggered_by         THEN
      RAISE EXCEPTION
        'IRON DOME: variance_runs is append-only. Core fields cannot be changed after run creation.'
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

DROP TRIGGER IF EXISTS maono_runs_append_only ON variance_runs;
CREATE TRIGGER maono_runs_append_only
  BEFORE UPDATE OR DELETE ON variance_runs
  FOR EACH ROW EXECUTE FUNCTION maono_block_run_mutation();

CREATE INDEX IF NOT EXISTS idx_variance_runs_company
  ON variance_runs(company_id, period_from DESC, status);

GRANT SELECT, INSERT, UPDATE ON variance_runs TO authenticated;
GRANT ALL ON variance_runs TO service_role;

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

CREATE TABLE IF NOT EXISTS variance_analyses (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               UUID NOT NULL REFERENCES variance_runs(id),
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_code         TEXT    NOT NULL,
  account_name         TEXT,
  pl_category          TEXT    NOT NULL,
  pl_subcategory       TEXT,
  is_credit_normal     BOOLEAN NOT NULL DEFAULT FALSE,
  actual_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  budget_amount        NUMERIC(18,2),
  prior_period_amount  NUMERIC(18,2),
  prior_year_amount    NUMERIC(18,2),
  variance_tzs         NUMERIC(18,2),
  variance_pct         NUMERIC(8,4),
  is_material          BOOLEAN NOT NULL DEFAULT FALSE,
  pop_variance_tzs     NUMERIC(18,2),
  pop_variance_pct     NUMERIC(8,4),
  yoy_variance_tzs     NUMERIC(18,2),
  yoy_variance_pct     NUMERIC(8,4),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION maono_block_analysis_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION
      'IRON DOME: variance_analyses is append-only. Run a new analysis (new run_id) to recompute variances.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS maono_analyses_append_only ON variance_analyses;
CREATE TRIGGER maono_analyses_append_only
  BEFORE UPDATE OR DELETE ON variance_analyses
  FOR EACH ROW EXECUTE FUNCTION maono_block_analysis_mutation();

CREATE INDEX IF NOT EXISTS idx_variance_analyses_run
  ON variance_analyses(run_id, pl_category, is_material);

CREATE INDEX IF NOT EXISTS idx_variance_analyses_company_period
  ON variance_analyses(company_id, pl_category)
  INCLUDE (actual_amount, variance_tzs, variance_pct, is_material);

GRANT SELECT, INSERT ON variance_analyses TO authenticated;
GRANT ALL ON variance_analyses TO service_role;

ALTER TABLE variance_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "analyses_read" ON variance_analyses
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  );
CREATE POLICY "analyses_insert" ON variance_analyses
  FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION maono_check_safisha_gate(
  p_upload_ids UUID[]
)
RETURNS TABLE(
  upload_id      UUID,
  safisha_status TEXT,
  is_blocked     BOOLEAN
) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT
    id AS upload_id,
    COALESCE(safisha_status, 'not_started') AS safisha_status,
    COALESCE(safisha_status, 'not_started') != 'clean' AS is_blocked
  FROM trial_balance_uploads
  WHERE id = ANY(p_upload_ids)
  ORDER BY id;
$$;

CREATE OR REPLACE FUNCTION maono_compute_confidence(
  p_company_id   UUID,
  p_period_month INTEGER
)
RETURNS TABLE(
  seasonal_periods_available INTEGER,
  trend_confidence           TEXT
) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
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
    SELECT 4, 8
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

GRANT EXECUTE ON FUNCTION maono_check_safisha_gate TO authenticated;
GRANT EXECUTE ON FUNCTION maono_compute_confidence  TO authenticated;