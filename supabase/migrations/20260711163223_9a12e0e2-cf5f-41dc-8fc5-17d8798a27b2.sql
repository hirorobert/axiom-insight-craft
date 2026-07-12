CREATE TABLE IF NOT EXISTS board_packs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id           UUID REFERENCES variance_runs(id),
  period_label     TEXT NOT NULL,
  pack_type        TEXT NOT NULL DEFAULT 'monthly'
                   CHECK (pack_type IN ('monthly','quarterly','annual')),
  sections_json    JSONB NOT NULL,
  summary_text     TEXT,
  pdf_storage_path TEXT,
  xlsx_storage_path TEXT,
  generated_by     UUID NOT NULL REFERENCES auth.users(id),
  generation_time  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generation_model TEXT,
  numeric_validation_passed BOOLEAN NOT NULL DEFAULT TRUE,
  context_version  INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION maono_block_board_pack_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION
    'IRON DOME: board_packs is append-only. Generated reports cannot be modified after creation.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS board_packs_append_only ON board_packs;
CREATE TRIGGER board_packs_append_only
  BEFORE UPDATE OR DELETE ON board_packs
  FOR EACH ROW EXECUTE FUNCTION maono_block_board_pack_mutation();

CREATE INDEX IF NOT EXISTS idx_board_packs_company
  ON board_packs(company_id, created_at DESC);

GRANT SELECT, INSERT ON board_packs TO authenticated;
GRANT ALL ON board_packs TO service_role;

ALTER TABLE board_packs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "board_packs_read" ON board_packs FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "board_packs_insert" ON board_packs FOR INSERT WITH CHECK (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);

CREATE TABLE IF NOT EXISTS efdms_z_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  upload_id        UUID REFERENCES trial_balance_uploads(id),
  serial_number    TEXT NOT NULL,
  trader_tin       TEXT NOT NULL,
  report_date      DATE NOT NULL,
  gross_sales      NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_sales        NUMERIC(18,2) NOT NULL DEFAULT 0,
  vat_collected    NUMERIC(18,2) NOT NULL DEFAULT 0,
  exempt_sales     NUMERIC(18,2) NOT NULL DEFAULT 0,
  zero_rated_sales NUMERIC(18,2) NOT NULL DEFAULT 0,
  receipt_count    INTEGER NOT NULL DEFAULT 0,
  cancelled_count  INTEGER NOT NULL DEFAULT 0,
  raw_json         JSONB,
  imported_by      UUID REFERENCES auth.users(id),
  import_source    TEXT NOT NULL DEFAULT 'manual'
                   CHECK (import_source IN ('manual','api','csv_adapter')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, serial_number, report_date)
);

GRANT SELECT, INSERT ON efdms_z_reports TO authenticated;
GRANT ALL ON efdms_z_reports TO service_role;

ALTER TABLE efdms_z_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "efdms_read" ON efdms_z_reports FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "efdms_insert" ON efdms_z_reports FOR INSERT WITH CHECK (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);

CREATE TABLE IF NOT EXISTS efdms_reconciliation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id            UUID REFERENCES variance_runs(id),
  period_month      INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  fiscal_year       INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2099),
  efdms_gross_sales NUMERIC(18,2) NOT NULL DEFAULT 0,
  efdms_vat         NUMERIC(18,2) NOT NULL DEFAULT 0,
  return_output_vat NUMERIC(18,2) NOT NULL DEFAULT 0,
  return_sales      NUMERIC(18,2) NOT NULL DEFAULT 0,
  sales_gap_tzs     NUMERIC(18,2) GENERATED ALWAYS AS
    (efdms_gross_sales - return_sales) STORED,
  vat_gap_tzs       NUMERIC(18,2) GENERATED ALWAYS AS
    (efdms_vat - return_output_vat) STORED,
  gap_pct           NUMERIC(8,4),
  risk_level        TEXT NOT NULL DEFAULT 'ok'
                    CHECK (risk_level IN ('ok','warn','critical')),
  risk_notes        TEXT,
  reconciled_by     UUID REFERENCES auth.users(id),
  reconciled_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, fiscal_year, period_month)
);

GRANT SELECT, INSERT, UPDATE ON efdms_reconciliation TO authenticated;
GRANT ALL ON efdms_reconciliation TO service_role;

ALTER TABLE efdms_reconciliation ENABLE ROW LEVEL SECURITY;
CREATE POLICY "efdms_recon_read" ON efdms_reconciliation FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "efdms_recon_write" ON efdms_reconciliation FOR INSERT WITH CHECK (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);

ALTER TABLE safisha_transactions
  ADD COLUMN IF NOT EXISTS dqc_polarity_warning  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dqc_sign_detail        TEXT;

CREATE INDEX IF NOT EXISTS idx_safisha_tx_dqc
  ON safisha_transactions(reconciliation_id, dqc_polarity_warning)
  WHERE dqc_polarity_warning = TRUE;

CREATE OR REPLACE FUNCTION maono_write_alert(
  p_company_id   UUID,
  p_run_id       UUID,
  p_alert_type   TEXT,
  p_severity     TEXT,
  p_pl_categories TEXT[],
  p_account_codes TEXT[],
  p_message      TEXT,
  p_detail       TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_alert_type NOT IN (
    'variance_threshold','cash_critical','cash_watch',
    'tra_risk_signal','budget_missing','trend_deterioration'
  ) THEN
    RAISE EXCEPTION 'Invalid alert_type: %', p_alert_type;
  END IF;

  IF p_severity NOT IN ('info','warn','critical') THEN
    RAISE EXCEPTION 'Invalid severity: %', p_severity;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = p_company_id) THEN
    RAISE EXCEPTION 'Company not found: %', p_company_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM variance_alerts
    WHERE run_id = p_run_id
      AND alert_type = p_alert_type
      AND LEFT(message, 80) = LEFT(p_message, 80)
      AND acknowledged_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO variance_alerts (
    run_id, company_id, alert_type, severity,
    pl_categories, account_codes, message, detail
  )
  VALUES (
    p_run_id, p_company_id, p_alert_type, p_severity,
    p_pl_categories, p_account_codes, p_message, p_detail
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION maono_write_alert FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maono_write_alert TO service_role;
GRANT EXECUTE ON FUNCTION maono_write_alert TO authenticated;

CREATE OR REPLACE FUNCTION maono_write_board_pack(
  p_company_id      UUID,
  p_run_id          UUID,
  p_period_label    TEXT,
  p_pack_type       TEXT,
  p_sections_json   JSONB,
  p_summary_text    TEXT,
  p_generation_model TEXT,
  p_context_version INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id    UUID;
  v_user  UUID;
BEGIN
  v_user := auth.uid();

  IF NOT EXISTS (
    SELECT 1 FROM firm_members
    WHERE company_id = p_company_id AND user_id = v_user
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of this company.';
  END IF;

  IF p_pack_type NOT IN ('monthly','quarterly','annual') THEN
    RAISE EXCEPTION 'Invalid pack_type: %', p_pack_type;
  END IF;

  INSERT INTO board_packs (
    company_id, run_id, period_label, pack_type,
    sections_json, summary_text, generated_by,
    generation_model, context_version
  )
  VALUES (
    p_company_id, p_run_id, p_period_label, p_pack_type,
    p_sections_json, p_summary_text, v_user,
    p_generation_model, p_context_version
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION maono_write_board_pack FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maono_write_board_pack TO authenticated;

CREATE TABLE IF NOT EXISTS maono_monitor_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  companies_scanned INTEGER NOT NULL DEFAULT 0,
  alerts_written  INTEGER NOT NULL DEFAULT 0,
  errors_json     JSONB,
  trigger_type    TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (trigger_type IN ('scheduled','manual','webhook'))
);

CREATE OR REPLACE FUNCTION maono_block_monitor_run_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IRON DOME: maono_monitor_runs rows cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS maono_monitor_runs_no_delete ON maono_monitor_runs;
CREATE TRIGGER maono_monitor_runs_no_delete
  BEFORE DELETE ON maono_monitor_runs
  FOR EACH ROW EXECUTE FUNCTION maono_block_monitor_run_mutation();

GRANT SELECT, INSERT, UPDATE ON maono_monitor_runs TO authenticated;
GRANT ALL ON maono_monitor_runs TO service_role;

ALTER TABLE maono_monitor_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "monitor_runs_read" ON maono_monitor_runs FOR SELECT USING (
  EXISTS (SELECT 1 FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "monitor_runs_write" ON maono_monitor_runs FOR ALL USING (
  auth.uid() IS NOT NULL
);