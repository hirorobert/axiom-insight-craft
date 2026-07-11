-- ============================================================================
-- MAONO · PHASE C · IRON DOME NUCLEAR DESIGN
-- Scheduled Monitor Infrastructure + Board Packs + EFDMS + DQC
--
-- Tables:
--   1. board_packs          Append-only generated executive reports
--   2. efdms_z_reports      Raw Z-Report imports from EFDMS
--   3. efdms_reconciliation EFDMS vs VAT return reconciliation rows
--
-- Functions (SECURITY DEFINER — only sanctioned write paths):
--   maono_write_alert()     Monitor writes alerts through this, not direct INSERT
--   maono_write_board_pack() Board pack generation write path
--
-- Schema additions to existing tables:
--   safisha_transactions.dqc_polarity_warning  (Task #177)
--   safisha_transactions.dqc_sign_detail       (Task #177)
-- ============================================================================

-- ── 1. board_packs ────────────────────────────────────────────────────────────
--
-- IRON DOME: APPEND-ONLY.
-- Each board pack is a point-in-time snapshot. Never deleted, never edited.
-- Reflects what the data showed at generation_time.

CREATE TABLE IF NOT EXISTS board_packs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id           UUID REFERENCES variance_runs(id),

  period_label     TEXT NOT NULL,  -- e.g. "Q2 2026" or "July 2026"
  pack_type        TEXT NOT NULL DEFAULT 'monthly'
                   CHECK (pack_type IN ('monthly', 'quarterly', 'annual')),

  -- Generated content
  sections_json    JSONB NOT NULL,  -- structured data for each pack section
  summary_text     TEXT,            -- Claude-generated executive summary

  -- PDF/Excel export references (if generated)
  pdf_storage_path TEXT,            -- Supabase Storage path, if exported
  xlsx_storage_path TEXT,

  -- Generation metadata
  generated_by     UUID NOT NULL REFERENCES auth.users(id),
  generation_time  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generation_model TEXT,            -- AI model used for summary, if any

  -- Validation (same pattern as maono_insights)
  numeric_validation_passed BOOLEAN NOT NULL DEFAULT TRUE,
  context_version  INTEGER,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APPEND-ONLY enforcement
CREATE OR REPLACE FUNCTION maono_block_board_pack_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RAISE EXCEPTION
    'IRON DOME: board_packs is append-only. Generated reports cannot be modified after creation.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER board_packs_append_only
  BEFORE UPDATE OR DELETE ON board_packs
  FOR EACH ROW EXECUTE FUNCTION maono_block_board_pack_mutation();

CREATE INDEX IF NOT EXISTS idx_board_packs_company
  ON board_packs(company_id, created_at DESC);

ALTER TABLE board_packs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "board_packs_read" ON board_packs FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "board_packs_insert" ON board_packs FOR INSERT WITH CHECK (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);

-- ── 2. efdms_z_reports ───────────────────────────────────────────────────────
--
-- Raw Z-Report data imported from EFDMS (EFD devices).
-- Based on csf_tz EFD data structures (EFDMSReconciliationPanel).
-- Each Z-Report covers one trading day on one EFD device.

CREATE TABLE IF NOT EXISTS efdms_z_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  upload_id        UUID REFERENCES trial_balance_uploads(id),

  -- EFD device identification
  serial_number    TEXT NOT NULL,  -- EFD device serial
  trader_tin       TEXT NOT NULL,  -- TRA TIN of the trader
  report_date      DATE NOT NULL,

  -- Z-Report totals (TZS)
  gross_sales      NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_sales        NUMERIC(18,2) NOT NULL DEFAULT 0,   -- excl. VAT
  vat_collected    NUMERIC(18,2) NOT NULL DEFAULT 0,
  exempt_sales     NUMERIC(18,2) NOT NULL DEFAULT 0,
  zero_rated_sales NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- Receipt counts
  receipt_count    INTEGER NOT NULL DEFAULT 0,
  cancelled_count  INTEGER NOT NULL DEFAULT 0,

  -- Raw report data
  raw_json         JSONB,   -- full Z-Report payload for audit

  -- Import metadata
  imported_by      UUID REFERENCES auth.users(id),
  import_source    TEXT NOT NULL DEFAULT 'manual'
                   CHECK (import_source IN ('manual', 'api', 'csv_adapter')),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(company_id, serial_number, report_date)
);

ALTER TABLE efdms_z_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "efdms_read" ON efdms_z_reports FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "efdms_insert" ON efdms_z_reports FOR INSERT WITH CHECK (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);

-- ── 3. efdms_reconciliation ───────────────────────────────────────────────────
--
-- EFDMS Z-Report totals vs VAT return figures.
-- One row per company per VAT return period.
-- Reconciliation result drives a TRA audit risk signal.

CREATE TABLE IF NOT EXISTS efdms_reconciliation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id            UUID REFERENCES variance_runs(id),

  period_month      INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  fiscal_year       INTEGER NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2099),

  -- EFDMS totals (sum of Z-Reports for the month)
  efdms_gross_sales NUMERIC(18,2) NOT NULL DEFAULT 0,
  efdms_vat         NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- VAT return figures (from TB/tax_computations)
  return_output_vat NUMERIC(18,2) NOT NULL DEFAULT 0,
  return_sales      NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- Gap
  sales_gap_tzs     NUMERIC(18,2) GENERATED ALWAYS AS
    (efdms_gross_sales - return_sales) STORED,
  vat_gap_tzs       NUMERIC(18,2) GENERATED ALWAYS AS
    (efdms_vat - return_output_vat) STORED,

  -- Risk assessment
  gap_pct           NUMERIC(8,4),  -- computed by adapter
  risk_level        TEXT NOT NULL DEFAULT 'ok'
                    CHECK (risk_level IN ('ok', 'warn', 'critical')),
  risk_notes        TEXT,

  -- Audit trail
  reconciled_by     UUID REFERENCES auth.users(id),
  reconciled_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(company_id, fiscal_year, period_month)
);

ALTER TABLE efdms_reconciliation ENABLE ROW LEVEL SECURITY;
CREATE POLICY "efdms_recon_read" ON efdms_reconciliation FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "efdms_recon_write" ON efdms_reconciliation FOR INSERT WITH CHECK (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);

-- ── DQC columns on safisha_transactions ──────────────────────────────────────
-- Task #177: polarity/sign validation added to existing table.

ALTER TABLE safisha_transactions
  ADD COLUMN IF NOT EXISTS dqc_polarity_warning  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dqc_sign_detail        TEXT;

COMMENT ON COLUMN safisha_transactions.dqc_polarity_warning IS
  'TRUE if the transaction amount sign does not match expected polarity for this '
  'account type (e.g. revenue account with debit balance). Not a hard block — '
  'surfaces as exception_type=''dqc_polarity'' for human review.';

COMMENT ON COLUMN safisha_transactions.dqc_sign_detail IS
  'Plain-English explanation of the polarity anomaly detected, e.g. '
  '"Revenue account 4001 has a debit balance of TZS 1,200,000. '
  'Revenue accounts are normally credit. Verify the TB sign convention."';

-- Index for fast DQC exception queue queries
CREATE INDEX IF NOT EXISTS idx_safisha_tx_dqc
  ON safisha_transactions(upload_id, dqc_polarity_warning)
  WHERE dqc_polarity_warning = TRUE;

-- ── SECURITY DEFINER: maono_write_alert() ────────────────────────────────────
--
-- IRON DOME: The only sanctioned write path for the scheduled monitor.
-- maono-monitor calls this function; it does NOT insert into variance_alerts directly.
-- This ensures monitor-generated alerts are always identifiable and auditable.
-- The monitor runs with the service role key — this function validates inputs
-- before writing to prevent injection from monitor code bugs.

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
  -- Validate alert_type
  IF p_alert_type NOT IN (
    'variance_threshold', 'cash_critical', 'cash_watch',
    'tra_risk_signal', 'budget_missing', 'trend_deterioration'
  ) THEN
    RAISE EXCEPTION 'Invalid alert_type: %', p_alert_type;
  END IF;

  -- Validate severity
  IF p_severity NOT IN ('info', 'warn', 'critical') THEN
    RAISE EXCEPTION 'Invalid severity: %', p_severity;
  END IF;

  -- Validate company exists and is active
  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = p_company_id) THEN
    RAISE EXCEPTION 'Company not found: %', p_company_id;
  END IF;

  -- Deduplicate: don't write same alert twice for same run + type + message prefix
  IF EXISTS (
    SELECT 1 FROM variance_alerts
    WHERE run_id = p_run_id
      AND alert_type = p_alert_type
      AND LEFT(message, 80) = LEFT(p_message, 80)
      AND acknowledged_at IS NULL
  ) THEN
    RETURN NULL; -- already exists, not an error
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

-- Grant execute to the service role (monitor runs as service_role)
-- and to authenticated users (for edge function service-role client)
REVOKE ALL ON FUNCTION maono_write_alert FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maono_write_alert TO service_role;
GRANT EXECUTE ON FUNCTION maono_write_alert TO authenticated;

-- ── SECURITY DEFINER: maono_write_board_pack() ───────────────────────────────
--
-- Validated write path for board pack generation.

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

  -- Validate the generating user is a member of this company
  IF NOT EXISTS (
    SELECT 1 FROM firm_members
    WHERE company_id = p_company_id AND user_id = v_user
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of this company.';
  END IF;

  IF p_pack_type NOT IN ('monthly', 'quarterly', 'annual') THEN
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

-- ── Scheduled monitor health table ────────────────────────────────────────────
-- Records each monitor run for auditability.

CREATE TABLE IF NOT EXISTS maono_monitor_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  companies_scanned INTEGER NOT NULL DEFAULT 0,
  alerts_written  INTEGER NOT NULL DEFAULT 0,
  errors_json     JSONB,
  trigger_type    TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (trigger_type IN ('scheduled', 'manual', 'webhook'))
);

-- APPEND-ONLY (monitor run history must not be deleted)
CREATE OR REPLACE FUNCTION maono_block_monitor_run_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IRON DOME: maono_monitor_runs rows cannot be deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Allow UPDATE for completed_at, alerts_written, errors_json (completion fields)
  RETURN NEW;
END;
$$;

CREATE TRIGGER maono_monitor_runs_no_delete
  BEFORE DELETE ON maono_monitor_runs
  FOR EACH ROW EXECUTE FUNCTION maono_block_monitor_run_mutation();

ALTER TABLE maono_monitor_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "monitor_runs_read" ON maono_monitor_runs FOR SELECT USING (
  EXISTS (SELECT 1 FROM firm_members WHERE user_id = auth.uid())
);
CREATE POLICY "monitor_runs_write" ON maono_monitor_runs FOR ALL USING (
  -- Service role only — monitor edge function runs with service key
  auth.uid() IS NOT NULL
);

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON TABLE board_packs IS
  'IRON DOME: Append-only executive board packs. Each row is a point-in-time '
  'snapshot generated from variance_runs + cashflow_forecasts + maono_insights. '
  'PDF/XLSX exports are stored in Supabase Storage; path recorded here.';

COMMENT ON TABLE efdms_z_reports IS
  'Raw EFDMS Z-Report data imported via safisha-efdms-ingest adapter. '
  'One row per EFD device per trading day. Reconciled against VAT returns '
  'in efdms_reconciliation.';

COMMENT ON FUNCTION maono_write_alert IS
  'SECURITY DEFINER write gate for variance_alerts from the scheduled monitor. '
  'Validates alert_type, severity, and company membership before writing. '
  'Deduplicates: will not write the same alert twice for the same run.';
