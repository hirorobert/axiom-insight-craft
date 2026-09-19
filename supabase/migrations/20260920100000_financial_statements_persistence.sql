-- CFOClose financial-statements workspace — durable, append-only persistence.
--
-- Evidence batches, canonical report versions, evaluation runs, reviewer
-- decisions, atomic multi-version correction groups and publication states.
-- Designed from the preserved candidate branch and re-verified against current
-- main; the proof is scripts/db-proof (real PostgreSQL 16, replayed from zero).
--
-- SECURITY MODEL
--   * Nothing here is writable by a client role. Every write goes through a
--     SECURITY DEFINER function that pins search_path, derives the acting firm
--     member from auth.uid() (no argument carries actor authority; any actor in
--     a payload is discarded), requires accepted membership of the company AND
--     that the workspace is enabled for it (default denied, kill switch — see
--     20260920000000), and is granted to `authenticated` only.
--   * Every table is append-only (UPDATE/DELETE rejected by trigger) and
--     foreign keys are RESTRICT: history cannot be cascaded or edited away.
--   * Writers of one lineage are serialised by transaction-scoped advisory locks;
--     report versions must be exactly latest+1; exact replays are idempotent;
--     conflicting replays are refused (PT409). A correction group is ONE function
--     call, therefore ONE transaction: it lands completely or not at all.
--   * Money is never a JSON number: evidence documents may contain no JSON
--     numbers at all, and report documents may not carry a numeric minorUnits.
--   * The server computes its own document hash and never trusts a client hash
--     for conflict detection.
--
-- Error codes: 42501 forbidden · PT403 feature disabled · PT409 stale/conflict ·
--              P0002 not found · 22023 invalid argument.
--
-- THIS MIGRATION IS NOT APPLIED to any database by its author. Apply only through
-- the project's reviewed, managed process after the release checklist passes.

-- ════════════════════════════════════════════════════════════════════════
-- 0. shared append-only guard
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fs_append_only_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: % is append-only (% is not permitted)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 1. tables
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE public.financial_evidence_batches (
  id                          UUID        NOT NULL DEFAULT gen_random_uuid(),
  seq                         BIGINT      GENERATED ALWAYS AS IDENTITY,
  evidence_batch_id           TEXT        NOT NULL,
  company_id                  UUID        NOT NULL,
  reporting_period_id         TEXT        NOT NULL,
  evidence_type               TEXT        NOT NULL,
  period_role                 TEXT        NOT NULL,
  series_key                  TEXT        NOT NULL DEFAULT 'default',
  schema_version              TEXT        NOT NULL,
  source_file_name            TEXT        NULL,
  content_hash                TEXT        NOT NULL,
  document_hash               TEXT        NOT NULL,
  replay_identity             TEXT        NOT NULL,
  currency                    TEXT        NULL,
  scale                       INTEGER     NULL,
  batch_document              JSONB       NOT NULL,
  diagnostics                 JSONB       NOT NULL,
  validation_status           TEXT        NOT NULL,
  version                     INTEGER     NOT NULL,
  supersedes_batch_id         TEXT        NULL,
  uploaded_by_firm_member_id  UUID        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT feb_pk PRIMARY KEY (id),
  CONSTRAINT fk_feb_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_feb_uploader FOREIGN KEY (uploaded_by_firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  CONSTRAINT chk_feb_type CHECK (evidence_type IN (
    'TRIAL_BALANCE', 'TRANSACTION_LEDGER', 'EQUITY_MOVEMENTS', 'BUDGET', 'IPSAS_CASH_RECEIPTS_PAYMENTS',
    'SUPPORTING_SCHEDULE', 'NOTES_AND_POLICIES', 'PRIOR_PERIOD_STATEMENTS', 'EXTRACTED_CANDIDATES')),
  CONSTRAINT chk_feb_role CHECK (period_role IN ('CURRENT', 'COMPARATIVE')),
  CONSTRAINT chk_feb_status CHECK (validation_status IN ('VALID', 'VALID_WITH_WARNINGS', 'REQUIRES_REVIEW', 'INVALID')),
  CONSTRAINT chk_feb_content_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_feb_document_hash CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_feb_replay CHECK (replay_identity ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_feb_currency CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_feb_scale CHECK (scale IS NULL OR scale BETWEEN 0 AND 6),
  CONSTRAINT chk_feb_version CHECK (version >= 1),
  CONSTRAINT chk_feb_chain CHECK ((version = 1) = (supersedes_batch_id IS NULL)),
  CONSTRAINT chk_feb_series CHECK (length(series_key) BETWEEN 1 AND 120),
  CONSTRAINT uq_feb_batch_id UNIQUE (evidence_batch_id),
  CONSTRAINT uq_feb_replay UNIQUE (company_id, replay_identity),
  CONSTRAINT uq_feb_series_version UNIQUE (company_id, reporting_period_id, evidence_type, period_role, series_key, version)
);

CREATE INDEX idx_feb_company_period ON public.financial_evidence_batches (company_id, reporting_period_id, evidence_type);

CREATE TABLE public.financial_statement_reports (
  id                          UUID        NOT NULL DEFAULT gen_random_uuid(),
  seq                         BIGINT      GENERATED ALWAYS AS IDENTITY,
  report_id                   TEXT        NOT NULL,
  report_version              INTEGER     NOT NULL,
  company_id                  UUID        NOT NULL,
  period_year                 INTEGER     NOT NULL,
  provenance_origin           TEXT        NOT NULL,
  report_document             JSONB       NOT NULL,
  content_hash                TEXT        NOT NULL,
  document_hash               TEXT        NOT NULL,
  evidence_batch_ids          TEXT[]      NOT NULL DEFAULT '{}',
  created_by_firm_member_id   UUID        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fsr_pk PRIMARY KEY (id),
  CONSTRAINT fk_fsr_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fsr_created_by FOREIGN KEY (created_by_firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  CONSTRAINT chk_fsr_period_year CHECK (period_year BETWEEN 2000 AND 2100),
  CONSTRAINT chk_fsr_version CHECK (report_version >= 1),
  CONSTRAINT chk_fsr_origin CHECK (provenance_origin IN ('TRIAL_BALANCE_DERIVED', 'DOCUMENT_REVIEWED')),
  CONSTRAINT chk_fsr_content_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_fsr_document_hash CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT uq_fsr_report_version UNIQUE (report_id, report_version)
);

CREATE INDEX idx_fsr_company_period ON public.financial_statement_reports (company_id, period_year, provenance_origin);

CREATE TABLE public.financial_statement_evaluations (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  seq                 BIGINT      GENERATED ALWAYS AS IDENTITY,
  evaluation_run_id   TEXT        NOT NULL,
  report_id           TEXT        NOT NULL,
  report_version      INTEGER     NOT NULL,
  company_id          UUID        NOT NULL,
  rule_pack_id        TEXT        NOT NULL,
  rule_pack_version   TEXT        NOT NULL,
  engine_version      TEXT        NOT NULL,
  input_hash          TEXT        NOT NULL,
  findings            JSONB       NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fse_pk PRIMARY KEY (id),
  CONSTRAINT fk_fse_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fse_report FOREIGN KEY (report_id, report_version) REFERENCES public.financial_statement_reports(report_id, report_version) ON DELETE RESTRICT,
  CONSTRAINT chk_fse_input_hash CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_fse_findings CHECK (jsonb_typeof(findings) = 'array'),
  CONSTRAINT uq_fse_run UNIQUE (evaluation_run_id)
);

CREATE INDEX idx_fse_report_version ON public.financial_statement_evaluations (report_id, report_version, seq DESC);

CREATE TABLE public.financial_statement_reviewer_decisions (
  id                        UUID        NOT NULL DEFAULT gen_random_uuid(),
  seq                       BIGINT      GENERATED ALWAYS AS IDENTITY,
  decision_id               TEXT        NOT NULL,
  report_id                 TEXT        NOT NULL,
  company_id                UUID        NOT NULL,
  decision                  JSONB       NOT NULL,
  correction_group_id       TEXT        NULL,
  reviewer_firm_member_id   UUID        NOT NULL,
  decided_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fsrd_pk PRIMARY KEY (id),
  CONSTRAINT fk_fsrd_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fsrd_reviewer FOREIGN KEY (reviewer_firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  CONSTRAINT uq_fsrd_decision UNIQUE (report_id, decision_id)
);

CREATE INDEX idx_fsrd_report ON public.financial_statement_reviewer_decisions (report_id, seq);

CREATE TABLE public.financial_statement_correction_groups (
  id                          UUID        NOT NULL DEFAULT gen_random_uuid(),
  group_id                    TEXT        NOT NULL,
  idempotency_key             TEXT        NOT NULL,
  company_id                  UUID        NOT NULL,
  report_id                   TEXT        NOT NULL,
  expected_report_version     INTEGER     NOT NULL,
  from_report_version         INTEGER     NOT NULL,
  to_report_version           INTEGER     NOT NULL,
  step_count                  INTEGER     NOT NULL,
  group_hash                  TEXT        NOT NULL,
  applied_by_firm_member_id   UUID        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fscg_pk PRIMARY KEY (id),
  CONSTRAINT fk_fscg_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fscg_actor FOREIGN KEY (applied_by_firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  CONSTRAINT chk_fscg_steps CHECK (step_count BETWEEN 1 AND 64 AND to_report_version = expected_report_version + step_count AND from_report_version = expected_report_version + 1),
  CONSTRAINT chk_fscg_hash CHECK (group_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_fscg_key CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT uq_fscg_group UNIQUE (report_id, group_id),
  CONSTRAINT uq_fscg_idem UNIQUE (company_id, idempotency_key)
);

CREATE TABLE public.financial_statement_publications (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid(),
  seq                   BIGINT      GENERATED ALWAYS AS IDENTITY,
  report_id             TEXT        NOT NULL,
  report_version        INTEGER     NOT NULL,
  company_id            UUID        NOT NULL,
  state                 TEXT        NOT NULL,
  reason                TEXT        NOT NULL,
  actor_firm_member_id  UUID        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fsp_pk PRIMARY KEY (id),
  CONSTRAINT fk_fsp_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fsp_report FOREIGN KEY (report_id, report_version) REFERENCES public.financial_statement_reports(report_id, report_version) ON DELETE RESTRICT,
  CONSTRAINT fk_fsp_actor FOREIGN KEY (actor_firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  CONSTRAINT chk_fsp_state CHECK (state IN ('DRAFT', 'REVIEWED', 'FINAL')),
  CONSTRAINT chk_fsp_reason CHECK (length(btrim(reason)) >= 8)
);

CREATE INDEX idx_fsp_report_version ON public.financial_statement_publications (report_id, report_version, seq DESC);

-- ── append-only triggers, RLS, grants (reads only, by accepted company members) ──

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'financial_evidence_batches', 'financial_statement_reports', 'financial_statement_evaluations',
    'financial_statement_reviewer_decisions', 'financial_statement_correction_groups', 'financial_statement_publications'
  ] LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fs_append_only_guard()', t, t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    -- The membership lookup goes through the SECURITY DEFINER helper: `authenticated` has no
    -- SELECT on firm_members, so a policy that read it directly would fail for every caller.
    EXECUTE format($p$CREATE POLICY "%s_select" ON public.%I FOR SELECT USING (
      company_id IN (SELECT public.get_member_company_ids()))$p$, t, t);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- 2. internal helpers (never callable by a client role)
-- ════════════════════════════════════════════════════════════════════════

-- Resolves the caller's firm member for a company from auth.uid(), and refuses
-- unless the workspace is enabled for that company (default denied / kill switch).
CREATE OR REPLACE FUNCTION public.fs_actor_member_id(p_company_id UUID)
  RETURNS UUID
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_member UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;

  SELECT fm.id INTO v_member
    FROM public.firm_members fm
   WHERE fm.user_id = v_uid AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL
     AND fm.role <> 'viewer'
   ORDER BY fm.id LIMIT 1;

  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: the caller is not an accepted, non-viewer member of company %', p_company_id USING ERRCODE = '42501';
  END IF;

  IF NOT public.fs_rollout_allows(p_company_id) THEN
    RAISE EXCEPTION 'FEATURE_DISABLED: the financial-statements workspace is not enabled for this company' USING ERRCODE = 'PT403';
  END IF;

  RETURN v_member;
END;
$$;

CREATE OR REPLACE FUNCTION public.fs_sha256_hex(p_text TEXT)
  RETURNS TEXT
  LANGUAGE sql
  IMMUTABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
$$;

-- Report documents may never carry money as a JSON number, and must describe the lineage they are saved under.
CREATE OR REPLACE FUNCTION public.fs_assert_report_document(p_doc JSONB, p_report_id TEXT, p_version INTEGER, p_company_id UUID)
  RETURNS VOID
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF jsonb_typeof(p_doc) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID: a report document must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF (p_doc #>> '{reportIdentity,reportId}') IS DISTINCT FROM p_report_id
     OR (p_doc #>> '{reportIdentity,companyId}') IS DISTINCT FROM p_company_id::text
     OR (p_doc #>> '{reportIdentity,reportVersion}') IS DISTINCT FROM p_version::text THEN
    RAISE EXCEPTION 'INVALID: the report document does not match the lineage, company and version it is saved under' USING ERRCODE = '22023';
  END IF;
  IF jsonb_path_exists(p_doc, '$.**.minorUnits ? (@.type() != "object")')
     OR jsonb_path_exists(p_doc, '$.**.presentationMultiplier ? (@.type() != "object")') THEN
    RAISE EXCEPTION 'INVALID: monetary amounts must be exact integers carried as strings, never JSON numbers' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fs_store_evaluation(
  p_evaluation_run_id TEXT, p_report_id TEXT, p_report_version INTEGER, p_company_id UUID,
  p_rule_pack_id TEXT, p_rule_pack_version TEXT, p_engine_version TEXT, p_input_hash TEXT, p_findings JSONB
)
  RETURNS public.financial_statement_evaluations
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.financial_statement_evaluations;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.financial_statement_reports r
     WHERE r.report_id = p_report_id AND r.report_version = p_report_version AND r.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'NOT_FOUND: no report % version % for this company', p_report_id, p_report_version USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_evaluations:' || p_evaluation_run_id));

  SELECT * INTO v_row FROM public.financial_statement_evaluations WHERE evaluation_run_id = p_evaluation_run_id;
  IF FOUND THEN
    IF v_row.report_id = p_report_id AND v_row.report_version = p_report_version AND v_row.company_id = p_company_id
       AND v_row.input_hash = p_input_hash AND v_row.findings = p_findings THEN
      RETURN v_row;
    END IF;
    RAISE EXCEPTION 'REPLAY_CONFLICT: evaluation % already exists with different content', p_evaluation_run_id USING ERRCODE = 'PT409';
  END IF;

  INSERT INTO public.financial_statement_evaluations (
    evaluation_run_id, report_id, report_version, company_id, rule_pack_id, rule_pack_version, engine_version, input_hash, findings
  ) VALUES (
    p_evaluation_run_id, p_report_id, p_report_version, p_company_id, p_rule_pack_id, p_rule_pack_version, p_engine_version, p_input_hash, p_findings
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- Unresolved blocking findings for a report version: the latest evaluation's actionable
-- CRITICAL/HIGH failures and every INSUFFICIENT_EVIDENCE, minus findings whose most recent
-- decision is ACCEPT_FINDING or REJECT_FINDING. Mirrors findingsView.ts's read model.
CREATE OR REPLACE FUNCTION public.fs_unresolved_blocking_count(p_report_id TEXT, p_version INTEGER)
  RETURNS INTEGER
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  WITH ev AS (
    SELECT e.findings FROM public.financial_statement_evaluations e
     WHERE e.report_id = p_report_id AND e.report_version = p_version
     ORDER BY e.seq DESC LIMIT 1
  ), f AS (
    SELECT jsonb_array_elements(ev.findings) AS j FROM ev
  ), latest AS (
    SELECT DISTINCT ON (d.decision #>> '{target,findingKey}')
           d.decision #>> '{target,findingKey}' AS fk, d.decision ->> 'decisionType' AS dt
      FROM public.financial_statement_reviewer_decisions d
     WHERE d.report_id = p_report_id
       AND d.decision #>> '{target,kind}' = 'FINDING_KEY'
       AND d.decision ->> 'decisionType' IN ('ACCEPT_FINDING', 'REJECT_FINDING', 'DEFER', 'REQUEST_EVIDENCE')
     ORDER BY d.decision #>> '{target,findingKey}', d.seq DESC
  )
  SELECT count(*)::INTEGER FROM f
   WHERE f.j ->> 'actionable' = 'true'
     AND (f.j ->> 'outcome' = 'INSUFFICIENT_EVIDENCE' OR f.j ->> 'failureSeverity' IN ('CRITICAL', 'HIGH'))
     AND COALESCE((SELECT l.dt FROM latest l WHERE l.fk = f.j ->> 'findingKey'), '') NOT IN ('ACCEPT_FINDING', 'REJECT_FINDING');
$$;

REVOKE ALL ON FUNCTION public.fs_actor_member_id(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_sha256_hex(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_assert_report_document(JSONB, TEXT, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_store_evaluation(TEXT, TEXT, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_unresolved_blocking_count(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 3. write RPCs (SECURITY DEFINER, authenticated only)
-- ════════════════════════════════════════════════════════════════════════

-- ── evidence ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fs_ingest_evidence_batch(
  p_evidence_batch_id TEXT, p_company_id UUID, p_reporting_period_id TEXT, p_evidence_type TEXT,
  p_period_role TEXT, p_series_key TEXT, p_schema_version TEXT, p_source_file_name TEXT,
  p_content_hash TEXT, p_currency TEXT, p_scale INTEGER, p_batch_document JSONB,
  p_validation_status TEXT, p_diagnostics JSONB, p_expected_previous_batch_id TEXT
)
  RETURNS public.financial_evidence_batches
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor  UUID;
  v_replay TEXT;
  v_doc_hash TEXT;
  v_row    public.financial_evidence_batches;
  v_latest public.financial_evidence_batches;
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);

  IF jsonb_typeof(p_batch_document) IS DISTINCT FROM 'object' OR jsonb_typeof(p_diagnostics) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID: evidence document must be an object and diagnostics an array' USING ERRCODE = '22023';
  END IF;
  -- Money and quantities travel as decimal STRINGS. A JSON number anywhere in an evidence document is refused.
  IF jsonb_path_exists(p_batch_document, '$.** ? (@.type() == "number")') THEN
    RAISE EXCEPTION 'INVALID: evidence documents must not contain JSON numbers; carry decimals as strings' USING ERRCODE = '22023';
  END IF;

  v_doc_hash := public.fs_sha256_hex(p_batch_document::text);
  v_replay := public.fs_sha256_hex(concat_ws('|', p_company_id::text, p_reporting_period_id, p_evidence_type, p_period_role, coalesce(p_series_key, 'default'), p_content_hash));

  PERFORM pg_advisory_xact_lock(hashtext('financial_evidence:' || p_company_id::text || '|' || p_reporting_period_id || '|' || p_evidence_type || '|' || p_period_role || '|' || coalesce(p_series_key, 'default')));

  -- Exact replay of the same source content is a no-op that returns the stored batch.
  SELECT * INTO v_row FROM public.financial_evidence_batches WHERE company_id = p_company_id AND replay_identity = v_replay;
  IF FOUND THEN
    IF v_row.document_hash = v_doc_hash THEN
      RETURN v_row;
    END IF;
    RAISE EXCEPTION 'REPLAY_CONFLICT: the same source content was already ingested with a different parsed document' USING ERRCODE = 'PT409';
  END IF;

  IF EXISTS (SELECT 1 FROM public.financial_evidence_batches WHERE evidence_batch_id = p_evidence_batch_id) THEN
    RAISE EXCEPTION 'REPLAY_CONFLICT: evidence batch id % is already in use', p_evidence_batch_id USING ERRCODE = 'PT409';
  END IF;

  SELECT * INTO v_latest FROM public.financial_evidence_batches
   WHERE company_id = p_company_id AND reporting_period_id = p_reporting_period_id AND evidence_type = p_evidence_type
     AND period_role = p_period_role AND series_key = coalesce(p_series_key, 'default')
   ORDER BY version DESC LIMIT 1;

  IF p_expected_previous_batch_id IS DISTINCT FROM v_latest.evidence_batch_id THEN
    RAISE EXCEPTION 'STALE_VERSION: the evidence series changed; expected predecessor does not match the latest batch' USING ERRCODE = 'PT409';
  END IF;

  INSERT INTO public.financial_evidence_batches (
    evidence_batch_id, company_id, reporting_period_id, evidence_type, period_role, series_key, schema_version,
    source_file_name, content_hash, document_hash, replay_identity, currency, scale, batch_document, diagnostics,
    validation_status, version, supersedes_batch_id, uploaded_by_firm_member_id
  ) VALUES (
    p_evidence_batch_id, p_company_id, p_reporting_period_id, p_evidence_type, p_period_role, coalesce(p_series_key, 'default'), p_schema_version,
    p_source_file_name, p_content_hash, v_doc_hash, v_replay, p_currency, p_scale, p_batch_document, p_diagnostics,
    p_validation_status, coalesce(v_latest.version, 0) + 1, v_latest.evidence_batch_id, v_actor
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ── reports ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fs_save_report_version(
  p_report_id TEXT, p_report_version INTEGER, p_company_id UUID, p_period_year INTEGER,
  p_provenance_origin TEXT, p_report_document JSONB, p_content_hash TEXT, p_evidence_batch_ids TEXT[]
)
  RETURNS public.financial_statement_reports
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor  UUID;
  v_doc_hash TEXT;
  v_row    public.financial_statement_reports;
  v_latest public.financial_statement_reports;
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);
  PERFORM public.fs_assert_report_document(p_report_document, p_report_id, p_report_version, p_company_id);
  v_doc_hash := public.fs_sha256_hex(p_report_document::text);

  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reports:' || p_report_id));

  SELECT * INTO v_row FROM public.financial_statement_reports WHERE report_id = p_report_id AND report_version = p_report_version;
  IF FOUND THEN
    IF v_row.company_id <> p_company_id THEN
      RAISE EXCEPTION 'FORBIDDEN: report lineage % is not accessible to this company', p_report_id USING ERRCODE = '42501';
    END IF;
    IF v_row.document_hash = v_doc_hash AND v_row.content_hash = p_content_hash THEN
      RETURN v_row;
    END IF;
    RAISE EXCEPTION 'STALE_REPORT_VERSION: report % version % already exists with different content', p_report_id, p_report_version USING ERRCODE = 'PT409';
  END IF;

  SELECT * INTO v_latest FROM public.financial_statement_reports WHERE report_id = p_report_id ORDER BY report_version DESC LIMIT 1;
  IF FOUND THEN
    IF v_latest.company_id <> p_company_id THEN
      RAISE EXCEPTION 'FORBIDDEN: report lineage % is not accessible to this company', p_report_id USING ERRCODE = '42501';
    END IF;
    IF v_latest.period_year <> p_period_year OR v_latest.provenance_origin <> p_provenance_origin THEN
      RAISE EXCEPTION 'STALE_REPORT_VERSION: report % cannot change its period or provenance origin', p_report_id USING ERRCODE = 'PT409';
    END IF;
  END IF;

  IF p_report_version <> COALESCE(v_latest.report_version, 0) + 1 THEN
    RAISE EXCEPTION 'STALE_REPORT_VERSION: expected version % for report % but received %', COALESCE(v_latest.report_version, 0) + 1, p_report_id, p_report_version USING ERRCODE = 'PT409';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(coalesce(p_evidence_batch_ids, '{}')) AS e(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.financial_evidence_batches b WHERE b.evidence_batch_id = e.id AND b.company_id = p_company_id)
  ) THEN
    RAISE EXCEPTION 'NOT_FOUND: a referenced evidence batch does not exist for this company' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.financial_statement_reports (
    report_id, report_version, company_id, period_year, provenance_origin, report_document, content_hash, document_hash,
    evidence_batch_ids, created_by_firm_member_id
  ) VALUES (
    p_report_id, p_report_version, p_company_id, p_period_year, p_provenance_origin, p_report_document, p_content_hash, v_doc_hash,
    coalesce(p_evidence_batch_ids, '{}'), v_actor
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ── evaluations ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fs_save_evaluation(
  p_evaluation_run_id TEXT, p_report_id TEXT, p_report_version INTEGER, p_company_id UUID,
  p_rule_pack_id TEXT, p_rule_pack_version TEXT, p_engine_version TEXT, p_input_hash TEXT, p_findings JSONB
)
  RETURNS public.financial_statement_evaluations
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor UUID;
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);
  RETURN public.fs_store_evaluation(p_evaluation_run_id, p_report_id, p_report_version, p_company_id, p_rule_pack_id, p_rule_pack_version, p_engine_version, p_input_hash, p_findings);
END;
$$;

-- ── decisions ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fs_append_decision(p_decision_id TEXT, p_report_id TEXT, p_company_id UUID, p_decision JSONB)
  RETURNS public.financial_statement_reviewer_decisions
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor UUID;
  v_row   public.financial_statement_reviewer_decisions;
  v_clean JSONB := p_decision - 'reviewerId';
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);

  IF v_clean ->> 'decisionId' IS DISTINCT FROM p_decision_id THEN
    RAISE EXCEPTION 'INVALID: the decision payload id does not match the decision id argument' USING ERRCODE = '22023';
  END IF;
  IF v_clean ->> 'decisionType' = 'CORRECT_FACT' THEN
    RAISE EXCEPTION 'INVALID: a fact correction must be recorded through a correction group' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reviewer_decisions:' || p_report_id || ':' || p_decision_id));

  IF NOT EXISTS (SELECT 1 FROM public.financial_statement_reports r WHERE r.report_id = p_report_id AND r.company_id = p_company_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: no report lineage % for this company', p_report_id USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_row FROM public.financial_statement_reviewer_decisions WHERE report_id = p_report_id AND decision_id = p_decision_id;
  IF FOUND THEN
    IF v_row.company_id = p_company_id AND v_row.decision = v_clean THEN
      RETURN v_row;
    END IF;
    RAISE EXCEPTION 'REPLAY_CONFLICT: decision % already exists with different content', p_decision_id USING ERRCODE = 'PT409';
  END IF;

  INSERT INTO public.financial_statement_reviewer_decisions (decision_id, report_id, company_id, decision, reviewer_firm_member_id)
       VALUES (p_decision_id, p_report_id, p_company_id, v_clean, v_actor)
    RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ── correction groups: ONE call = ONE transaction ──────────────────────

CREATE OR REPLACE FUNCTION public.fs_apply_correction_group(
  p_group_id TEXT, p_idempotency_key TEXT, p_company_id UUID, p_report_id TEXT,
  p_expected_report_version INTEGER, p_steps JSONB, p_decisions JSONB, p_evaluation JSONB
)
  RETURNS public.financial_statement_correction_groups
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor    UUID;
  v_hash     TEXT;
  v_group    public.financial_statement_correction_groups;
  v_latest   public.financial_statement_reports;
  v_n        INTEGER;
  v_i        INTEGER;
  v_step     JSONB;
  v_dec      JSONB;
  v_version  INTEGER;
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);

  IF jsonb_typeof(p_steps) IS DISTINCT FROM 'array' OR jsonb_typeof(p_decisions) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_steps) < 1 OR jsonb_array_length(p_steps) > 64
     OR jsonb_array_length(p_steps) <> jsonb_array_length(p_decisions) THEN
    RAISE EXCEPTION 'INVALID: a correction group needs 1-64 steps and exactly one decision per step' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_steps);
  v_hash := public.fs_sha256_hex(p_steps::text || '|' || p_decisions::text || '|' || p_expected_report_version::text || '|' || coalesce(p_evaluation::text, ''));

  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reports:' || p_report_id));

  -- Exact replay (same idempotency key + same content) returns the stored group; any other use of the key conflicts.
  SELECT * INTO v_group FROM public.financial_statement_correction_groups WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_group.group_hash = v_hash AND v_group.report_id = p_report_id THEN
      RETURN v_group;
    END IF;
    RAISE EXCEPTION 'REPLAY_CONFLICT: idempotency key already used with a different correction' USING ERRCODE = 'PT409';
  END IF;

  SELECT * INTO v_latest FROM public.financial_statement_reports WHERE report_id = p_report_id ORDER BY report_version DESC LIMIT 1;
  IF NOT FOUND OR v_latest.company_id <> p_company_id THEN
    RAISE EXCEPTION 'NOT_FOUND: no report lineage % for this company', p_report_id USING ERRCODE = 'P0002';
  END IF;
  IF v_latest.report_version <> p_expected_report_version THEN
    RAISE EXCEPTION 'STALE_REPORT_VERSION: the report is at version % but the correction was formed against %', v_latest.report_version, p_expected_report_version USING ERRCODE = 'PT409';
  END IF;

  FOR v_i IN 0 .. v_n - 1 LOOP
    v_step := p_steps -> v_i;
    v_dec  := p_decisions -> v_i;
    v_version := p_expected_report_version + v_i + 1;

    IF (v_step ->> 'reportVersion')::INTEGER IS DISTINCT FROM v_version THEN
      RAISE EXCEPTION 'STALE_REPORT_VERSION: step % must be version % (versions must be contiguous)', v_i + 1, v_version USING ERRCODE = 'PT409';
    END IF;
    IF v_dec ->> 'decisionType' IS DISTINCT FROM 'CORRECT_FACT'
       OR (v_dec ->> 'expectedReportVersion')::INTEGER IS DISTINCT FROM v_version - 1 THEN
      RAISE EXCEPTION 'INVALID: decision % is not a CORRECT_FACT formed against version %', v_i + 1, v_version - 1 USING ERRCODE = '22023';
    END IF;

    PERFORM public.fs_assert_report_document(v_step -> 'reportDocument', p_report_id, v_version, p_company_id);

    IF EXISTS (SELECT 1 FROM public.financial_statement_reviewer_decisions d WHERE d.report_id = p_report_id AND d.decision_id = v_dec ->> 'decisionId') THEN
      RAISE EXCEPTION 'REPLAY_CONFLICT: decision % already exists on this report', v_dec ->> 'decisionId' USING ERRCODE = 'PT409';
    END IF;

    INSERT INTO public.financial_statement_reports (
      report_id, report_version, company_id, period_year, provenance_origin, report_document, content_hash, document_hash,
      evidence_batch_ids, created_by_firm_member_id
    ) VALUES (
      p_report_id, v_version, p_company_id, v_latest.period_year, v_latest.provenance_origin, v_step -> 'reportDocument',
      v_step ->> 'contentHash', public.fs_sha256_hex((v_step -> 'reportDocument')::text), v_latest.evidence_batch_ids, v_actor
    );

    INSERT INTO public.financial_statement_reviewer_decisions (decision_id, report_id, company_id, decision, correction_group_id, reviewer_firm_member_id)
         VALUES (v_dec ->> 'decisionId', p_report_id, p_company_id, v_dec - 'reviewerId', p_group_id, v_actor);
  END LOOP;

  IF p_evaluation IS NOT NULL THEN
    PERFORM public.fs_store_evaluation(
      p_evaluation ->> 'evaluationRunId', p_report_id, p_expected_report_version + v_n, p_company_id,
      p_evaluation ->> 'rulePackId', p_evaluation ->> 'rulePackVersion', p_evaluation ->> 'engineVersion',
      p_evaluation ->> 'inputHash', p_evaluation -> 'findings');
  END IF;

  INSERT INTO public.financial_statement_correction_groups (
    group_id, idempotency_key, company_id, report_id, expected_report_version, from_report_version, to_report_version,
    step_count, group_hash, applied_by_firm_member_id
  ) VALUES (
    p_group_id, p_idempotency_key, p_company_id, p_report_id, p_expected_report_version, p_expected_report_version + 1,
    p_expected_report_version + v_n, v_n, v_hash, v_actor
  ) RETURNING * INTO v_group;
  RETURN v_group;
END;
$$;

-- ── publication state ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fs_set_publication_state(
  p_report_id TEXT, p_report_version INTEGER, p_company_id UUID, p_state TEXT, p_reason TEXT
)
  RETURNS public.financial_statement_publications
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor   UUID;
  v_role    TEXT;
  v_current public.financial_statement_publications;
  v_latest_version INTEGER;
  v_row     public.financial_statement_publications;
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);
  SELECT fm.role INTO v_role FROM public.firm_members fm WHERE fm.id = v_actor;

  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_publications:' || p_report_id || ':' || p_report_version::text));

  IF NOT EXISTS (SELECT 1 FROM public.financial_statement_reports r WHERE r.report_id = p_report_id AND r.report_version = p_report_version AND r.company_id = p_company_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: no report % version % for this company', p_report_id, p_report_version USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_current FROM public.financial_statement_publications
   WHERE report_id = p_report_id AND report_version = p_report_version ORDER BY seq DESC LIMIT 1;

  IF FOUND AND v_current.state = p_state THEN
    RETURN v_current; -- exact replay
  END IF;
  IF FOUND AND v_current.state = 'FINAL' THEN
    RAISE EXCEPTION 'CONFLICT: a FINAL report version is immutable; create a new version instead' USING ERRCODE = 'PT409';
  END IF;

  IF p_state IN ('REVIEWED', 'FINAL') AND v_role NOT IN ('owner', 'partner') THEN
    RAISE EXCEPTION 'FORBIDDEN: only an owner or partner may mark a report REVIEWED or FINAL' USING ERRCODE = '42501';
  END IF;

  IF p_state IN ('REVIEWED', 'FINAL') THEN
    IF NOT EXISTS (SELECT 1 FROM public.financial_statement_evaluations e WHERE e.report_id = p_report_id AND e.report_version = p_report_version) THEN
      RAISE EXCEPTION 'NOT_EVALUATED: this report version has no evaluation; validate it before marking it %', p_state USING ERRCODE = 'PT409';
    END IF;
    IF public.fs_unresolved_blocking_count(p_report_id, p_report_version) > 0 THEN
      RAISE EXCEPTION 'BLOCKED: unresolved blocking findings remain; the report cannot be marked %', p_state USING ERRCODE = 'PT409';
    END IF;
  END IF;

  IF p_state = 'FINAL' THEN
    IF v_current.id IS NULL OR v_current.state <> 'REVIEWED' THEN
      RAISE EXCEPTION 'CONFLICT: a report must be REVIEWED before it can be FINAL' USING ERRCODE = 'PT409';
    END IF;
    SELECT max(r.report_version) INTO v_latest_version FROM public.financial_statement_reports r WHERE r.report_id = p_report_id;
    IF v_latest_version <> p_report_version THEN
      RAISE EXCEPTION 'STALE_REPORT_VERSION: only the latest version can be FINAL' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id)
       VALUES (p_report_id, p_report_version, p_company_id, p_state, p_reason, v_actor)
    RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 4. grants: authenticated only, never PUBLIC/anon
-- ════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.fs_ingest_evidence_batch(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_save_report_version(TEXT, INTEGER, UUID, INTEGER, TEXT, JSONB, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_save_evaluation(TEXT, TEXT, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_append_decision(TEXT, TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_apply_correction_group(TEXT, TEXT, UUID, TEXT, INTEGER, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_set_publication_state(TEXT, INTEGER, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fs_ingest_evidence_batch(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fs_save_report_version(TEXT, INTEGER, UUID, INTEGER, TEXT, JSONB, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fs_save_evaluation(TEXT, TEXT, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fs_append_decision(TEXT, TEXT, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fs_apply_correction_group(TEXT, TEXT, UUID, TEXT, INTEGER, JSONB, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fs_set_publication_state(TEXT, INTEGER, UUID, TEXT, TEXT) TO authenticated;
