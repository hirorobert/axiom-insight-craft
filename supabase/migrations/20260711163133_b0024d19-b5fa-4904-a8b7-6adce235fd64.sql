CREATE TABLE IF NOT EXISTS cashflow_forecasts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               UUID NOT NULL REFERENCES variance_runs(id),
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  forecast_week        DATE NOT NULL,
  week_number          INTEGER NOT NULL,
  opening_cash         NUMERIC(18,2) NOT NULL DEFAULT 0,
  expected_ar_inflows  NUMERIC(18,2) NOT NULL DEFAULT 0,
  expected_other_inflows NUMERIC(18,2) NOT NULL DEFAULT 0,
  expected_ap_outflows NUMERIC(18,2) NOT NULL DEFAULT 0,
  expected_other_outflows NUMERIC(18,2) NOT NULL DEFAULT 0,
  paye_due             NUMERIC(18,2) NOT NULL DEFAULT 0,
  vat_due              NUMERIC(18,2) NOT NULL DEFAULT 0,
  sdl_due              NUMERIC(18,2) NOT NULL DEFAULT 0,
  wht_due              NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_statutory_due  NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_inflows        NUMERIC(18,2) GENERATED ALWAYS AS
    (expected_ar_inflows + expected_other_inflows) STORED,
  total_outflows       NUMERIC(18,2) GENERATED ALWAYS AS
    (expected_ap_outflows + expected_other_outflows +
     paye_due + vat_due + sdl_due + wht_due + other_statutory_due) STORED,
  closing_cash         NUMERIC(18,2),
  risk_flag            TEXT NOT NULL DEFAULT 'ok'
                       CHECK (risk_flag IN ('ok','watch','critical')),
  risk_reason          TEXT,
  ar_confidence        TEXT NOT NULL DEFAULT 'estimated'
                       CHECK (ar_confidence IN ('actual','estimated','low')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cashflow_forecasts_run
  ON cashflow_forecasts(run_id, week_number);

GRANT SELECT, INSERT ON cashflow_forecasts TO authenticated;
GRANT ALL ON cashflow_forecasts TO service_role;

ALTER TABLE cashflow_forecasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cashflow_read" ON cashflow_forecasts FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "cashflow_insert" ON cashflow_forecasts FOR INSERT WITH CHECK (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);

CREATE TABLE IF NOT EXISTS maono_insights (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                  UUID NOT NULL REFERENCES variance_runs(id),
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  insight_type            TEXT NOT NULL CHECK (insight_type IN ('root_cause','risk','decision','action')),
  subject_account_codes   TEXT[],
  subject_pl_categories   TEXT[],
  input_snapshot          JSONB NOT NULL,
  ai_output               TEXT NOT NULL,
  ai_model_used           TEXT,
  confidence_level        TEXT NOT NULL DEFAULT 'none'
                          CHECK (confidence_level IN ('high','medium','low','none','validation_failed')),
  numeric_validation_passed BOOLEAN NOT NULL DEFAULT FALSE,
  numeric_validation_detail JSONB,
  context_version         INTEGER,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION maono_block_insight_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION
    'IRON DOME: maono_insights is append-only. AI insights cannot be modified after generation.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS maono_insights_append_only ON maono_insights;
CREATE TRIGGER maono_insights_append_only
  BEFORE UPDATE OR DELETE ON maono_insights
  FOR EACH ROW EXECUTE FUNCTION maono_block_insight_mutation();

CREATE INDEX IF NOT EXISTS idx_maono_insights_run
  ON maono_insights(run_id, insight_type);

GRANT SELECT, INSERT ON maono_insights TO authenticated;
GRANT ALL ON maono_insights TO service_role;

ALTER TABLE maono_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "insights_read" ON maono_insights FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "insights_insert" ON maono_insights FOR INSERT WITH CHECK (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);

CREATE TABLE IF NOT EXISTS variance_alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID REFERENCES variance_runs(id),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alert_type        TEXT NOT NULL CHECK (alert_type IN (
    'variance_threshold','cash_critical','cash_watch','tra_risk_signal','budget_missing','trend_deterioration'
  )),
  severity          TEXT NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('info','warn','critical')),
  account_codes     TEXT[],
  pl_categories     TEXT[],
  message           TEXT NOT NULL,
  detail            TEXT,
  acknowledged_by   UUID REFERENCES auth.users(id),
  acknowledged_at   TIMESTAMPTZ,
  acknowledgment_note TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION maono_block_alert_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.run_id IS DISTINCT FROM NEW.run_id OR OLD.company_id != NEW.company_id OR
       OLD.alert_type != NEW.alert_type OR OLD.message != NEW.message THEN
      RAISE EXCEPTION
        'IRON DOME: variance_alerts core fields are immutable after creation.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'IRON DOME: variance_alerts rows cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS maono_alerts_append_only ON variance_alerts;
CREATE TRIGGER maono_alerts_append_only
  BEFORE UPDATE OR DELETE ON variance_alerts
  FOR EACH ROW EXECUTE FUNCTION maono_block_alert_mutation();

CREATE INDEX IF NOT EXISTS idx_variance_alerts_company
  ON variance_alerts(company_id, severity, created_at DESC)
  WHERE acknowledged_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON variance_alerts TO authenticated;
GRANT ALL ON variance_alerts TO service_role;

ALTER TABLE variance_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alerts_read" ON variance_alerts FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "alerts_acknowledge" ON variance_alerts FOR UPDATE USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);

CREATE TABLE IF NOT EXISTS maono_context (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_key      TEXT NOT NULL UNIQUE,
  context_version  INTEGER NOT NULL DEFAULT 1,
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by       UUID REFERENCES auth.users(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT ON maono_context TO authenticated;
GRANT ALL ON maono_context TO service_role;

ALTER TABLE maono_context ENABLE ROW LEVEL SECURITY;
CREATE POLICY "maono_context_read" ON maono_context FOR SELECT USING (is_active = TRUE);

INSERT INTO maono_context (context_key, title, content) VALUES
('statutory_calendar',
 'Tanzania Statutory Payment Calendar',
 'TANZANIA STATUTORY PAYMENT DEADLINES (TRA-verified, Finance Act 2026):
- PAYE (Pay As You Earn): Due 7th of the FOLLOWING month. Computed on gross payroll. Rates: 0% on first TZS 270,000/month, 8% on 270,001-520,000, 20% on 520,001-760,000, 25% on 760,001-1,000,000, 30% above 1,000,000.
- VAT (Value Added Tax): Due 20th of the FOLLOWING month. Standard rate 18%. Filing and payment together.
- SDL (Skills Development Levy): Due 7th of the FOLLOWING month. Rate: 4.5% of gross payroll (all employees). Applied on same base as PAYE.
- WCF (Workers Compensation Fund): Annual premium. Rate varies by industry risk class (0.5%-5% of annual payroll). Due at policy renewal.
- WHT (Withholding Tax): Due 7th of the FOLLOWING month. Rates: services to residents 5%, services to non-residents 15%, dividends 10% residents/15% non-residents, interest 10%.
- Corporate Income Tax (CIT) installments: Quarterly - due 3rd month, 6th month, 9th month, and 12th month of the year of income. Rate: 30% (25% for newly listed companies for 3 years).
- TZS exchange rate impact: All statutory payments in TZS. USD/TZS volatility affects companies with USD-denominated revenue.'),
('tra_audit_signals',
 'TRA Audit Risk Signals',
 'KNOWN TRA AUDIT TRIGGER PATTERNS (based on TRA enforcement priorities):
- SDL base erosion: SDL computed on a base significantly lower than PAYE base without documented exemptions.
- VAT output/input ratio below industry norms: High input VAT claims relative to output may trigger VAT audit.
- Thin capitalisation: Interest expense exceeding 70:30 debt-to-equity ratio (ITA s.24A). Excess interest is non-deductible.
- Transfer pricing: Related-party transactions without arm''s-length documentation (ITA s.33 management fees capped at 1% of turnover for non-financial companies).
- Revenue significantly below prior year without explanatory note.
- Large one-off expenses (>TZS 50M) without supporting invoices on file.
- EFDMS Z-report totals inconsistent with VAT return figures.
- Zero or near-zero SDL/PAYE despite non-zero headcount costs in TB.'),
('tanzania_economy',
 'Tanzania Economic Context 2026',
 'TANZANIA ECONOMIC CONTEXT (for variance root-cause analysis):
- Inflation: persistent inflationary pressure on input costs; TZS purchasing power affected by USD/TZS rate.
- Seasonal patterns: tourism sector (peak July-October, low March-May), agriculture (harvest season April-June affects food processing), school calendar (January/September affect education-related businesses).
- Banking: CRDB, NMB, Equity Tanzania, Absa Tanzania, DTB, Exim Bank are major commercial banks. Collection periods of 30-60 days are typical for B2B transactions.
- EFDMS: All VAT-registered businesses required to issue receipts via Electronic Fiscal Device. Z-report reconciliation is a standard compliance step.
- Finance Act 2026: Key changes include SDL rate maintained at 4.5%, WHT on digital services added, presumptive tax threshold raised to TZS 200M annual turnover.')
ON CONFLICT (context_key) DO NOTHING;