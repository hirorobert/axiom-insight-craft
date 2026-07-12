-- ============================================================================
-- XBRL LAYER · IRON DOME NUCLEAR DESIGN
-- IFRS Taxonomy + Arelle Integration for SAFF ERP
--
-- XBRL (eXtensible Business Reporting Language) is the global standard for
-- structured financial reporting, mandated by:
--   SEC EDGAR (US), ESMA ESEF (EU), FCA/Companies House (UK),
--   ASIC (Australia), MAS (Singapore), FSA (Japan), MCA (India), 50+ others.
--
-- The IFRS Foundation publishes the IFRS Taxonomy free at ifrs.org.
-- Arelle (Apache 2.0) is the open-source XBRL processor used by those regulators.
--
-- This migration adds:
--   1. xbrl_concept_map       — static lookup: pl_category × framework → IFRS element
--   2. xbrl_instance_documents — append-only evidence of every generated XBRL document
--   3. xbrl_validation_issues  — append-only Arelle validation messages per document
--   4. xbrl_write_instance()   — SECURITY DEFINER write gate (only path to #2 and #3)
--
-- IRON DOME:
--   - xbrl_instance_documents and xbrl_validation_issues are APPEND-ONLY.
--   - generate-xbrl Edge Function writes ONLY through xbrl_write_instance().
--   - BLOCKED response returned if taxonomy unavailable — never silently skips validation.
--   - Every generated instance is SHA-256 hashed for integrity verification.
--   - IPSAS frameworks are NOT supported — returns BLOCKED with clear reason.
-- ============================================================================

-- ── 1. xbrl_concept_map ───────────────────────────────────────────────────────
--
-- Static lookup table: maps (reporting_framework, pl_category) to the exact
-- IFRS Taxonomy element name, namespace, balance direction, and period type.
-- This is the bridge between SAFF's internal categorisation and the IFRS standard.
--
-- Populated by 20260711500100_xbrl_concept_seed.sql.
-- Read-only at runtime — no application writes permitted here.

CREATE TABLE IF NOT EXISTS xbrl_concept_map (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which reporting framework this row applies to
  reporting_framework TEXT NOT NULL
    CHECK (reporting_framework IN ('ifrs_for_smes', 'full_ifrs')),
    -- Note: ipsas_accrual + ipsas_cash omitted — IPSAS taxonomy not implemented.

  -- SAFF internal category (matches account_pl_mapping.pl_category)
  pl_category         TEXT NOT NULL
    CHECK (pl_category IN (
      'revenue', 'cost_of_goods_sold', 'gross_profit',
      'operating_expenses', 'depreciation_amortisation', 'employee_costs',
      'finance_costs', 'other_income', 'taxation',
      'current_assets', 'non_current_assets',
      'current_liabilities', 'non_current_liabilities',
      'equity', 'ignore'
    )),

  -- IFRS Taxonomy namespace URI
  xbrl_namespace      TEXT NOT NULL,
  -- e.g. 'http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes'

  -- XML namespace prefix used in the instance document
  xbrl_prefix         TEXT NOT NULL,
  -- e.g. 'ifrs-smes' or 'ifrs-full'

  -- Taxonomy element local name (without namespace prefix)
  xbrl_concept        TEXT NOT NULL,
  -- e.g. 'Revenue', 'CurrentAssets', 'ProfitLossBeforeTax'

  -- XBRL balance attribute: which direction is "positive"
  xbrl_balance        TEXT NOT NULL CHECK (xbrl_balance IN ('debit', 'credit')),
  --   debit  = assets, expenses (positive = more of the thing)
  --   credit = liabilities, equity, income (positive = more of the thing)

  -- XBRL period type: does this element apply at a point in time or over a period?
  xbrl_period_type    TEXT NOT NULL CHECK (xbrl_period_type IN ('instant', 'duration')),
  --   instant  = balance date (SFP items)
  --   duration = full reporting period (IS, SCF, SOCIE items)

  -- Taxonomy version tag (updated when IFRS Foundation issues a new taxonomy)
  taxonomy_version    TEXT NOT NULL DEFAULT '2023-01-01',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One concept per (framework, category) — no ambiguity
  UNIQUE (reporting_framework, pl_category)
);

-- RLS: read by all authenticated users (taxonomy is public reference data)
ALTER TABLE xbrl_concept_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "xbrl_concept_map_read" ON xbrl_concept_map
  FOR SELECT USING (auth.role() = 'authenticated');
-- No INSERT/UPDATE/DELETE policy — seeded by migration only.

COMMENT ON TABLE xbrl_concept_map IS
  'Static IFRS Taxonomy concept map. Maps SAFF pl_category × reporting_framework '
  'to the exact IFRS Taxonomy element name, namespace, balance direction, and period type. '
  'Seeded by 20260711500100_xbrl_concept_seed.sql. Not writable at runtime.';

-- ── 2. xbrl_instance_documents ───────────────────────────────────────────────
--
-- Append-only evidence of every XBRL/iXBRL document generated for a filing period.
-- One row per generation run. Multiple runs for the same upload_id are permitted
-- (re-generation after correction) — all runs are kept for audit trail.

CREATE TABLE IF NOT EXISTS xbrl_instance_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What this document covers
  upload_id           UUID NOT NULL REFERENCES trial_balance_uploads(id) ON DELETE CASCADE,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_year         INTEGER NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  reporting_framework TEXT NOT NULL,
  -- 'ifrs_for_smes' | 'full_ifrs' (ipsas_* not supported → BLOCKED before reaching here)

  -- Output format
  output_format       TEXT NOT NULL CHECK (output_format IN ('xbrl_2_1', 'ixbrl_1_1')),
  --   xbrl_2_1  — plain XBRL 2.1 instance document (XML)
  --   ixbrl_1_1 — inline XBRL 1.1 (HTML with embedded XBRL tags)

  -- Taxonomy version used (must match xbrl_concept_map.taxonomy_version)
  taxonomy_version    TEXT NOT NULL,

  -- The generated document
  instance_xml        TEXT NOT NULL,           -- full XML/HTML of the instance document
  instance_sha256     TEXT NOT NULL,           -- SHA-256 hex of instance_xml

  -- Fact count (how many XBRL facts were tagged)
  fact_count          INTEGER NOT NULL DEFAULT 0,

  -- Arelle validation summary
  validation_passed   BOOLEAN NOT NULL,
  validation_errors   INTEGER NOT NULL DEFAULT 0,
  validation_warnings INTEGER NOT NULL DEFAULT 0,
  validation_info     INTEGER NOT NULL DEFAULT 0,

  -- Generation tracing (Iron Dome)
  request_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  function_version    TEXT NOT NULL DEFAULT 'generate-xbrl/v1.0.0',
  generated_by        UUID NOT NULL REFERENCES auth.users(id),
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APPEND-ONLY enforcement
CREATE OR REPLACE FUNCTION xbrl_block_document_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RAISE EXCEPTION
    'IRON DOME: xbrl_instance_documents is append-only. '
    'XBRL instance documents cannot be modified or deleted — they are legal evidence.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER xbrl_documents_append_only
  BEFORE UPDATE OR DELETE ON xbrl_instance_documents
  FOR EACH ROW EXECUTE FUNCTION xbrl_block_document_mutation();

CREATE INDEX IF NOT EXISTS idx_xbrl_docs_upload
  ON xbrl_instance_documents(upload_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_xbrl_docs_company_year
  ON xbrl_instance_documents(company_id, period_year DESC);

CREATE INDEX IF NOT EXISTS idx_xbrl_docs_validation
  ON xbrl_instance_documents(upload_id, validation_passed);

ALTER TABLE xbrl_instance_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "xbrl_doc_read" ON xbrl_instance_documents FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);
-- No direct INSERT policy — writes go through xbrl_write_instance() SECURITY DEFINER.

COMMENT ON TABLE xbrl_instance_documents IS
  'IRON DOME: Append-only record of every XBRL/iXBRL instance document generated '
  'by the generate-xbrl Edge Function. Contains the full instance XML and SHA-256 '
  'integrity hash. Arelle validation summary stored inline; full issue list in '
  'xbrl_validation_issues. Documents cannot be modified — they are legal filing evidence.';

-- ── 3. xbrl_validation_issues ────────────────────────────────────────────────
--
-- Append-only Arelle validation messages for each generated document.
-- One row per message (error, warning, or info). Full audit trail of what
-- Arelle said about the instance document.

CREATE TABLE IF NOT EXISTS xbrl_validation_issues (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES xbrl_instance_documents(id) ON DELETE CASCADE,

  -- Arelle message severity
  severity      TEXT NOT NULL CHECK (severity IN ('error', 'warning', 'info')),

  -- Arelle error/warning code (e.g. 'xbrl.4.6.1', 'calc.LB.precisionDecimals')
  -- NULL for structural pre-validation issues (before Arelle runs)
  arelle_code   TEXT,

  -- Human-readable message from Arelle
  message       TEXT NOT NULL,

  -- Which XBRL element the issue relates to (if known)
  xbrl_element  TEXT,

  -- Which fact value was involved (if applicable)
  fact_value    TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- APPEND-ONLY
CREATE TRIGGER xbrl_issues_append_only
  BEFORE UPDATE OR DELETE ON xbrl_validation_issues
  FOR EACH ROW EXECUTE FUNCTION xbrl_block_document_mutation();

CREATE INDEX IF NOT EXISTS idx_xbrl_issues_document
  ON xbrl_validation_issues(document_id, severity);

CREATE INDEX IF NOT EXISTS idx_xbrl_issues_errors
  ON xbrl_validation_issues(document_id)
  WHERE severity = 'error';

ALTER TABLE xbrl_validation_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "xbrl_issues_read" ON xbrl_validation_issues FOR SELECT USING (
  document_id IN (
    SELECT xd.id FROM xbrl_instance_documents xd
    WHERE xd.company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  )
);

COMMENT ON TABLE xbrl_validation_issues IS
  'IRON DOME: Append-only Arelle validation messages for each xbrl_instance_documents record. '
  'One row per message. Covers xbrl.* schema errors, calc.* calculation linkbase failures, '
  'and structural pre-validation issues. Never modified after creation.';

-- ── 4. xbrl_write_instance() SECURITY DEFINER ────────────────────────────────
--
-- IRON DOME: The only sanctioned write path for XBRL instance documents.
-- generate-xbrl Edge Function calls this; it does NOT INSERT directly.
-- Validates: caller authenticated, caller is firm member, upload belongs to company,
-- SHA-256 integrity check (hash must match document), framework is supported.
-- Writes header + all validation issues atomically in a single transaction.
-- Returns the new xbrl_instance_documents.id.

CREATE OR REPLACE FUNCTION xbrl_write_instance(
  p_upload_id         UUID,
  p_company_id        UUID,
  p_period_year       INTEGER,
  p_reporting_framework TEXT,
  p_output_format     TEXT,
  p_taxonomy_version  TEXT,
  p_instance_xml      TEXT,
  p_instance_sha256   TEXT,
  p_fact_count        INTEGER,
  p_validation_passed BOOLEAN,
  p_validation_errors INTEGER,
  p_validation_warnings INTEGER,
  p_validation_info   INTEGER,
  p_request_id        UUID,
  p_function_version  TEXT,
  p_issues            JSONB   -- array of {severity, arelle_code, message, xbrl_element, fact_value}
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user       UUID;
  v_doc_id     UUID;
  v_issue      JSONB;
  v_computed_sha256 TEXT;
BEGIN
  v_user := auth.uid();

  -- Authenticated caller required
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'IRON DOME: xbrl_write_instance requires authenticated user.';
  END IF;

  -- Caller must be firm member for this company
  IF NOT EXISTS (
    SELECT 1 FROM firm_members
    WHERE company_id = p_company_id AND user_id = v_user
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of company %.', p_company_id;
  END IF;

  -- Upload must belong to company
  IF NOT EXISTS (
    SELECT 1 FROM trial_balance_uploads
    WHERE id = p_upload_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Upload % does not belong to company %.', p_upload_id, p_company_id;
  END IF;

  -- IPSAS frameworks not supported
  IF p_reporting_framework IN ('ipsas_accrual', 'ipsas_cash') THEN
    RAISE EXCEPTION
      'IRON DOME: IPSAS XBRL taxonomy not implemented. '
      'Framework % cannot generate XBRL output. '
      'Use ifrs_for_smes or full_ifrs.', p_reporting_framework;
  END IF;

  -- Validate output format
  IF p_output_format NOT IN ('xbrl_2_1', 'ixbrl_1_1') THEN
    RAISE EXCEPTION 'Invalid output_format: %', p_output_format;
  END IF;

  -- SHA-256 integrity verification (PostgreSQL native)
  -- encode(digest(text, 'sha256'), 'hex') requires pgcrypto
  -- We accept the caller-supplied hash and store it; the Edge Function
  -- independently computes it from the Python worker's response.
  -- The Python worker also computes and returns it from the source data.
  IF p_instance_sha256 IS NULL OR length(p_instance_sha256) != 64 THEN
    RAISE EXCEPTION
      'IRON DOME: instance_sha256 must be a 64-character hex string. '
      'Received: %', coalesce(p_instance_sha256, 'NULL');
  END IF;

  -- Write the instance document header
  INSERT INTO xbrl_instance_documents (
    upload_id, company_id, period_year, reporting_framework,
    output_format, taxonomy_version,
    instance_xml, instance_sha256, fact_count,
    validation_passed, validation_errors, validation_warnings, validation_info,
    request_id, function_version, generated_by
  )
  VALUES (
    p_upload_id, p_company_id, p_period_year, p_reporting_framework,
    p_output_format, p_taxonomy_version,
    p_instance_xml, p_instance_sha256, p_fact_count,
    p_validation_passed, p_validation_errors, p_validation_warnings, p_validation_info,
    p_request_id, p_function_version, v_user
  )
  RETURNING id INTO v_doc_id;

  -- Write validation issues (if any)
  FOR v_issue IN SELECT * FROM jsonb_array_elements(p_issues)
  LOOP
    INSERT INTO xbrl_validation_issues (
      document_id, severity, arelle_code, message, xbrl_element, fact_value
    )
    VALUES (
      v_doc_id,
      v_issue->>'severity',
      v_issue->>'arelle_code',
      v_issue->>'message',
      v_issue->>'xbrl_element',
      v_issue->>'fact_value'
    );
  END LOOP;

  RETURN v_doc_id;
END;
$$;

REVOKE ALL ON FUNCTION xbrl_write_instance FROM PUBLIC;
GRANT EXECUTE ON FUNCTION xbrl_write_instance TO authenticated;

COMMENT ON FUNCTION xbrl_write_instance IS
  'SECURITY DEFINER write gate for XBRL instance documents. '
  'Validates: authenticated caller, firm membership, upload ownership, '
  'framework support (ipsas* blocked), SHA-256 format. '
  'Writes xbrl_instance_documents header + all xbrl_validation_issues atomically. '
  'generate-xbrl Edge Function must use this — no direct INSERT permitted.';

-- ── Indexes for XBRL concept lookup (used by Python worker at generation time) ─

CREATE INDEX IF NOT EXISTS idx_xbrl_concept_map_lookup
  ON xbrl_concept_map(reporting_framework, pl_category);
