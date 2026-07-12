CREATE TABLE IF NOT EXISTS xbrl_concept_map (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporting_framework TEXT NOT NULL CHECK (reporting_framework IN ('ifrs_for_smes', 'full_ifrs')),
  pl_category         TEXT NOT NULL CHECK (pl_category IN (
    'revenue','cost_of_goods_sold','gross_profit','operating_expenses','depreciation_amortisation',
    'employee_costs','finance_costs','other_income','taxation','current_assets','non_current_assets',
    'current_liabilities','non_current_liabilities','equity','ignore'
  )),
  xbrl_namespace      TEXT NOT NULL,
  xbrl_prefix         TEXT NOT NULL,
  xbrl_concept        TEXT NOT NULL,
  xbrl_balance        TEXT NOT NULL CHECK (xbrl_balance IN ('debit','credit')),
  xbrl_period_type    TEXT NOT NULL CHECK (xbrl_period_type IN ('instant','duration')),
  taxonomy_version    TEXT NOT NULL DEFAULT '2023-01-01',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reporting_framework, pl_category)
);
GRANT SELECT ON public.xbrl_concept_map TO authenticated;
GRANT ALL ON public.xbrl_concept_map TO service_role;
ALTER TABLE xbrl_concept_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "xbrl_concept_map_read" ON xbrl_concept_map;
CREATE POLICY "xbrl_concept_map_read" ON xbrl_concept_map FOR SELECT USING (auth.role() = 'authenticated');

CREATE TABLE IF NOT EXISTS xbrl_instance_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id           UUID NOT NULL REFERENCES trial_balance_uploads(id) ON DELETE CASCADE,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_year         INTEGER NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  reporting_framework TEXT NOT NULL,
  output_format       TEXT NOT NULL CHECK (output_format IN ('xbrl_2_1','ixbrl_1_1')),
  taxonomy_version    TEXT NOT NULL,
  instance_xml        TEXT NOT NULL,
  instance_sha256     TEXT NOT NULL,
  fact_count          INTEGER NOT NULL DEFAULT 0,
  validation_passed   BOOLEAN NOT NULL,
  validation_errors   INTEGER NOT NULL DEFAULT 0,
  validation_warnings INTEGER NOT NULL DEFAULT 0,
  validation_info     INTEGER NOT NULL DEFAULT 0,
  request_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  function_version    TEXT NOT NULL DEFAULT 'generate-xbrl/v1.0.0',
  generated_by        UUID NOT NULL REFERENCES auth.users(id),
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
GRANT SELECT ON public.xbrl_instance_documents TO authenticated;
GRANT ALL ON public.xbrl_instance_documents TO service_role;

CREATE OR REPLACE FUNCTION xbrl_block_document_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'IRON DOME: xbrl_instance_documents is append-only.'
    USING ERRCODE = 'restrict_violation';
END; $$;

DROP TRIGGER IF EXISTS xbrl_documents_append_only ON xbrl_instance_documents;
CREATE TRIGGER xbrl_documents_append_only
  BEFORE UPDATE OR DELETE ON xbrl_instance_documents
  FOR EACH ROW EXECUTE FUNCTION xbrl_block_document_mutation();

CREATE INDEX IF NOT EXISTS idx_xbrl_docs_upload ON xbrl_instance_documents(upload_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_xbrl_docs_company_year ON xbrl_instance_documents(company_id, period_year DESC);
CREATE INDEX IF NOT EXISTS idx_xbrl_docs_validation ON xbrl_instance_documents(upload_id, validation_passed);

ALTER TABLE xbrl_instance_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "xbrl_doc_read" ON xbrl_instance_documents;
CREATE POLICY "xbrl_doc_read" ON xbrl_instance_documents FOR SELECT USING (
  company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
);

CREATE TABLE IF NOT EXISTS xbrl_validation_issues (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES xbrl_instance_documents(id) ON DELETE CASCADE,
  severity      TEXT NOT NULL CHECK (severity IN ('error','warning','info')),
  arelle_code   TEXT,
  message       TEXT NOT NULL,
  xbrl_element  TEXT,
  fact_value    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
GRANT SELECT ON public.xbrl_validation_issues TO authenticated;
GRANT ALL ON public.xbrl_validation_issues TO service_role;

DROP TRIGGER IF EXISTS xbrl_issues_append_only ON xbrl_validation_issues;
CREATE TRIGGER xbrl_issues_append_only
  BEFORE UPDATE OR DELETE ON xbrl_validation_issues
  FOR EACH ROW EXECUTE FUNCTION xbrl_block_document_mutation();

CREATE INDEX IF NOT EXISTS idx_xbrl_issues_document ON xbrl_validation_issues(document_id, severity);
CREATE INDEX IF NOT EXISTS idx_xbrl_issues_errors ON xbrl_validation_issues(document_id) WHERE severity = 'error';

ALTER TABLE xbrl_validation_issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "xbrl_issues_read" ON xbrl_validation_issues;
CREATE POLICY "xbrl_issues_read" ON xbrl_validation_issues FOR SELECT USING (
  document_id IN (
    SELECT xd.id FROM xbrl_instance_documents xd
    WHERE xd.company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())
  )
);

CREATE OR REPLACE FUNCTION xbrl_write_instance(
  p_upload_id UUID, p_company_id UUID, p_period_year INTEGER,
  p_reporting_framework TEXT, p_output_format TEXT, p_taxonomy_version TEXT,
  p_instance_xml TEXT, p_instance_sha256 TEXT, p_fact_count INTEGER,
  p_validation_passed BOOLEAN, p_validation_errors INTEGER,
  p_validation_warnings INTEGER, p_validation_info INTEGER,
  p_request_id UUID, p_function_version TEXT, p_issues JSONB
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user UUID; v_doc_id UUID; v_issue JSONB;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN RAISE EXCEPTION 'IRON DOME: xbrl_write_instance requires authenticated user.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM firm_members WHERE company_id = p_company_id AND user_id = v_user) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of company %.', p_company_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trial_balance_uploads WHERE id = p_upload_id AND company_id = p_company_id) THEN
    RAISE EXCEPTION 'Upload % does not belong to company %.', p_upload_id, p_company_id;
  END IF;
  IF p_reporting_framework IN ('ipsas_accrual','ipsas_cash') THEN
    RAISE EXCEPTION 'IRON DOME: IPSAS XBRL taxonomy not implemented. Framework % cannot generate XBRL output.', p_reporting_framework;
  END IF;
  IF p_output_format NOT IN ('xbrl_2_1','ixbrl_1_1') THEN
    RAISE EXCEPTION 'Invalid output_format: %', p_output_format;
  END IF;
  IF p_instance_sha256 IS NULL OR length(p_instance_sha256) != 64 THEN
    RAISE EXCEPTION 'IRON DOME: instance_sha256 must be a 64-character hex string.';
  END IF;

  INSERT INTO xbrl_instance_documents (
    upload_id, company_id, period_year, reporting_framework,
    output_format, taxonomy_version, instance_xml, instance_sha256, fact_count,
    validation_passed, validation_errors, validation_warnings, validation_info,
    request_id, function_version, generated_by
  ) VALUES (
    p_upload_id, p_company_id, p_period_year, p_reporting_framework,
    p_output_format, p_taxonomy_version, p_instance_xml, p_instance_sha256, p_fact_count,
    p_validation_passed, p_validation_errors, p_validation_warnings, p_validation_info,
    p_request_id, p_function_version, v_user
  ) RETURNING id INTO v_doc_id;

  FOR v_issue IN SELECT * FROM jsonb_array_elements(p_issues) LOOP
    INSERT INTO xbrl_validation_issues (document_id, severity, arelle_code, message, xbrl_element, fact_value)
    VALUES (v_doc_id, v_issue->>'severity', v_issue->>'arelle_code', v_issue->>'message', v_issue->>'xbrl_element', v_issue->>'fact_value');
  END LOOP;
  RETURN v_doc_id;
END; $$;

REVOKE ALL ON FUNCTION xbrl_write_instance FROM PUBLIC;
GRANT EXECUTE ON FUNCTION xbrl_write_instance TO authenticated;

CREATE INDEX IF NOT EXISTS idx_xbrl_concept_map_lookup ON xbrl_concept_map(reporting_framework, pl_category);