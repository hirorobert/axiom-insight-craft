-- Ω∞ CFOCLOSE Financial Statements Workspace — persistence for the
-- canonicalStatement engine (Phase 3 of the integrated financial-statements
-- workspace directive).
--
-- Three tables, mirroring the append-only, content-addressed discipline
-- already established by financial_statement_documents
-- (20260915100000): a prepared canonical report is a versioned,
-- immutable snapshot; a rule-pack evaluation run is an immutable record
-- keyed by a deterministic hash of what it evaluated; a reviewer decision
-- is an append-only log entry. None of these three tables is ever
-- UPDATEd or DELETEd — every "change" is a new row, exactly matching
-- canonicalStatement/reviewState.ts's own in-memory discipline (a
-- correction appends a new fact version + a new report_version, it never
-- mutates the prior one).
--
-- This is deliberately a thin persistence layer over
-- src/lib/financialStatementsWorkspace/evaluationOrchestrator.ts — the
-- JSONB payloads are the canonical model's own serialized shape
-- (canonicalStringify, which renders every bigint as {"__bigint__": "..."}
-- rather than a native JSON number) so no monetary figure is ever
-- represented as floating point here, on-disk or in transit.
--
-- THIS MIGRATION IS UNAPPLIED. It has not been run against any database —
-- committed to the repository only, per the assessment-and-design
-- authorization it was written under (the "Do not apply migrations to a
-- live database" constraint of the financial-statements-workspace
-- directive). Do not run `supabase db push` (or paste this into a live
-- SQL editor) without separate, explicit authorization.
--
-- Write authority: exactly like financial_statement_documents, no
-- INSERT/UPDATE/DELETE RLS policy exists for `authenticated`/`anon` on any
-- of these three tables. Every write goes through one of the three
-- SECURITY DEFINER RPCs below, called only by a future Edge Function's
-- service-role client — never directly from a React component or hook
-- (Iron Dome 4.2). Each RPC independently re-verifies firm membership
-- from its own firmMemberId + companyId arguments (defense in depth,
-- matching resolve_account_review_batch / intake_financial_statement_document).
--
-- Statutory sign-off role enforcement (Iron Dome 4.6,
-- hesabu_gate_before_signoff on statement_sign_offs) is a SEPARATE, later
-- concern — a working-paper-level reviewer decision recorded here
-- (ACCEPT_FINDING / CORRECT_FACT / etc.) is not itself a statutory
-- sign-off, and this migration does not touch statement_sign_offs.

-- ════════════════════════════════════════════════════════════════════════
-- 1. financial_statement_reports — versioned, immutable report snapshots
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE public.financial_statement_reports (
  id                          UUID        NOT NULL DEFAULT gen_random_uuid(),
  report_id                   TEXT        NOT NULL,
  report_version              INTEGER     NOT NULL,
  company_id                  UUID        NOT NULL,
  period_year                 INTEGER     NOT NULL,
  provenance_origin           TEXT        NOT NULL,
  report_document             JSONB       NOT NULL,
  content_hash                TEXT        NOT NULL,
  created_by_firm_member_id   UUID        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fsr_pk PRIMARY KEY (id),

  CONSTRAINT fk_fsr_company
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,

  CONSTRAINT fk_fsr_created_by
    FOREIGN KEY (created_by_firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,

  CONSTRAINT chk_fsr_period_year
    CHECK (period_year BETWEEN 2000 AND 2100),

  CONSTRAINT chk_fsr_report_version
    CHECK (report_version >= 1),

  CONSTRAINT chk_fsr_provenance_origin
    CHECK (provenance_origin IN ('TRIAL_BALANCE_DERIVED', 'DOCUMENT_REVIEWED')),

  CONSTRAINT chk_fsr_content_hash
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),

  -- The idempotency constraint: a report lineage never has two rows at the
  -- same version. A retried "prepare" call for a version already saved
  -- returns the existing row (see save_financial_statement_report below)
  -- instead of raising a conflict or creating a duplicate.
  CONSTRAINT uq_fsr_report_id_version UNIQUE (report_id, report_version)
);

COMMENT ON TABLE public.financial_statement_reports IS
  'Versioned, immutable canonicalStatement report snapshots. Never accounting '
  'truth by itself -- report_document is only meaningful once independently '
  'passed through validateCanonicalReport, which every writer of this table '
  'is required to have already done (evaluationOrchestrator.ts).';

COMMENT ON COLUMN public.financial_statement_reports.report_document IS
  'The full CanonicalFinancialStatementReport, serialized via '
  'canonicalStatement/serialization.ts''s canonicalStringify (bigint minor '
  'units rendered as {"__bigint__": "..."} strings, never a native JSON '
  'number) -- decimal-safe on disk, exactly like in memory.';

CREATE INDEX idx_fsr_company_period
  ON public.financial_statement_reports (company_id, period_year, provenance_origin);

-- ── Immutability — a row, once inserted, is never changed ───────────────

CREATE OR REPLACE FUNCTION public.financial_statement_reports_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Iron Dome: financial_statement_reports is append-only. DELETE is not permitted. [id=%]',
      OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  RAISE EXCEPTION
    'Iron Dome: financial_statement_reports rows are immutable once inserted -- a change is a new (report_id, report_version) row, never an UPDATE. [id=%]',
    OLD.id
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_fsr_guard
  BEFORE UPDATE OR DELETE ON public.financial_statement_reports
  FOR EACH ROW EXECUTE FUNCTION public.financial_statement_reports_guard();

ALTER TABLE public.financial_statement_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fsr_select" ON public.financial_statement_reports
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.company_id = financial_statement_reports.company_id
        AND fm.user_id = auth.uid()
        AND fm.accepted_at IS NOT NULL
    )
  );

REVOKE ALL ON public.financial_statement_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.financial_statement_reports TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 2. financial_statement_evaluations — immutable rule-pack evaluation runs
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE public.financial_statement_evaluations (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
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

  CONSTRAINT fk_fse_company
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,

  CONSTRAINT fk_fse_report_version
    FOREIGN KEY (report_id, report_version)
    REFERENCES public.financial_statement_reports(report_id, report_version)
    ON DELETE RESTRICT,

  CONSTRAINT chk_fse_input_hash
    CHECK (input_hash ~ '^[0-9a-f]{64}$'),

  -- evaluation_run_id is itself a deterministic hash of
  -- (reportId, reportVersion, rulePack, engineVersion) -- see
  -- evaluationOrchestrator.ts. This UNIQUE constraint is what actually
  -- "prevents duplicate evaluation creation" at the database level: two
  -- concurrent requests to evaluate the identical report content race to
  -- insert the identical id, and the loser's INSERT ... ON CONFLICT DO
  -- NOTHING (see save_financial_statement_evaluation) simply returns the
  -- winner's row.
  CONSTRAINT uq_fse_evaluation_run_id UNIQUE (evaluation_run_id)
);

COMMENT ON TABLE public.financial_statement_evaluations IS
  'Immutable record of one canonical rule-pack run against one exact report '
  'version. evaluation_run_id is a deterministic hash -- replaying the same '
  'evaluation never creates a second row (see uq_fse_evaluation_run_id).';

CREATE INDEX idx_fse_report_version
  ON public.financial_statement_evaluations (report_id, report_version);

CREATE OR REPLACE FUNCTION public.financial_statement_evaluations_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION
    'Iron Dome: financial_statement_evaluations is append-only and immutable -- no UPDATE or DELETE is permitted. [id=%]',
    OLD.id
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_fse_guard
  BEFORE UPDATE OR DELETE ON public.financial_statement_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.financial_statement_evaluations_guard();

ALTER TABLE public.financial_statement_evaluations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fse_select" ON public.financial_statement_evaluations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.company_id = financial_statement_evaluations.company_id
        AND fm.user_id = auth.uid()
        AND fm.accepted_at IS NOT NULL
    )
  );

REVOKE ALL ON public.financial_statement_evaluations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.financial_statement_evaluations TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 3. financial_statement_reviewer_decisions — append-only decision log
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE public.financial_statement_reviewer_decisions (
  id                        UUID        NOT NULL DEFAULT gen_random_uuid(),
  decision_id               TEXT        NOT NULL,
  report_id                 TEXT        NOT NULL,
  company_id                UUID        NOT NULL,
  decision                  JSONB       NOT NULL,
  reviewer_firm_member_id   UUID        NOT NULL,
  decided_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fsrd_pk PRIMARY KEY (id),

  CONSTRAINT fk_fsrd_company
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,

  CONSTRAINT fk_fsrd_reviewer
    FOREIGN KEY (reviewer_firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,

  -- Mirrors reviewerDecisions.ts's appendDecision / reviewState.ts's
  -- recordFactCorrection in-memory discipline: a decisionId is recorded
  -- at most once per report lineage, ever.
  CONSTRAINT uq_fsrd_report_decision UNIQUE (report_id, decision_id)
);

COMMENT ON COLUMN public.financial_statement_reviewer_decisions.decision IS
  'The full ReviewerDecision (canonicalStatement/types.ts), including its '
  'own decisionType/target/rationale -- a CORRECT_FACT decision is recorded '
  'here for audit AND drives a new financial_statement_reports row via '
  'evaluationOrchestrator.ts''s correctReportFact, atomically at the '
  'application layer (both writes happen from the same Edge Function '
  'request); this table does not itself enforce that atomicity at the SQL '
  'level, matching the equivalent choice already made for '
  'reviewState.ts''s in-memory recordFactCorrection, which composes two '
  'appends rather than a single primitive.';

CREATE INDEX idx_fsrd_report
  ON public.financial_statement_reviewer_decisions (report_id);

CREATE OR REPLACE FUNCTION public.financial_statement_reviewer_decisions_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION
    'Iron Dome: financial_statement_reviewer_decisions is append-only -- no UPDATE or DELETE is permitted. [id=%]',
    OLD.id
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_fsrd_guard
  BEFORE UPDATE OR DELETE ON public.financial_statement_reviewer_decisions
  FOR EACH ROW EXECUTE FUNCTION public.financial_statement_reviewer_decisions_guard();

ALTER TABLE public.financial_statement_reviewer_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fsrd_select" ON public.financial_statement_reviewer_decisions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.company_id = financial_statement_reviewer_decisions.company_id
        AND fm.user_id = auth.uid()
        AND fm.accepted_at IS NOT NULL
    )
  );

REVOKE ALL ON public.financial_statement_reviewer_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.financial_statement_reviewer_decisions TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- 4. Sole write paths — idempotent insert-or-return, SECURITY DEFINER,
--    service_role only (mirrors intake_financial_statement_document)
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.save_financial_statement_report(
  p_report_id                 TEXT,
  p_report_version             INTEGER,
  p_company_id                 UUID,
  p_period_year                INTEGER,
  p_provenance_origin          TEXT,
  p_report_document            JSONB,
  p_content_hash                TEXT,
  p_created_by_firm_member_id  UUID
)
  RETURNS public.financial_statement_reports
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.financial_statement_reports;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.id = p_created_by_firm_member_id
      AND fm.company_id = p_company_id
      AND fm.accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: firm member % is not an accepted member of company %', p_created_by_firm_member_id, p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
    FROM public.financial_statement_reports
   WHERE report_id = p_report_id AND report_version = p_report_version
   LIMIT 1;

  IF FOUND THEN
    RETURN v_row;
  END IF;

  INSERT INTO public.financial_statement_reports (
    report_id, report_version, company_id, period_year, provenance_origin,
    report_document, content_hash, created_by_firm_member_id
  ) VALUES (
    p_report_id, p_report_version, p_company_id, p_period_year, p_provenance_origin,
    p_report_document, p_content_hash, p_created_by_firm_member_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO v_row
      FROM public.financial_statement_reports
     WHERE report_id = p_report_id AND report_version = p_report_version
     LIMIT 1;
    RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.save_financial_statement_report(TEXT, INTEGER, UUID, INTEGER, TEXT, JSONB, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_financial_statement_report(TEXT, INTEGER, UUID, INTEGER, TEXT, JSONB, TEXT, UUID) TO service_role;


CREATE OR REPLACE FUNCTION public.save_financial_statement_evaluation(
  p_evaluation_run_id   TEXT,
  p_report_id            TEXT,
  p_report_version       INTEGER,
  p_company_id           UUID,
  p_rule_pack_id         TEXT,
  p_rule_pack_version    TEXT,
  p_engine_version       TEXT,
  p_input_hash           TEXT,
  p_findings             JSONB
)
  RETURNS public.financial_statement_evaluations
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.financial_statement_evaluations;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.financial_statement_reports fsr
    WHERE fsr.report_id = p_report_id AND fsr.report_version = p_report_version AND fsr.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'NOT_FOUND: no financial_statement_reports row (report_id=%, report_version=%) for company %', p_report_id, p_report_version, p_company_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_row
    FROM public.financial_statement_evaluations
   WHERE evaluation_run_id = p_evaluation_run_id
   LIMIT 1;

  IF FOUND THEN
    RETURN v_row;
  END IF;

  INSERT INTO public.financial_statement_evaluations (
    evaluation_run_id, report_id, report_version, company_id,
    rule_pack_id, rule_pack_version, engine_version, input_hash, findings
  ) VALUES (
    p_evaluation_run_id, p_report_id, p_report_version, p_company_id,
    p_rule_pack_id, p_rule_pack_version, p_engine_version, p_input_hash, p_findings
  )
  RETURNING * INTO v_row;

  RETURN v_row;
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO v_row
      FROM public.financial_statement_evaluations
     WHERE evaluation_run_id = p_evaluation_run_id
     LIMIT 1;
    RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.save_financial_statement_evaluation(TEXT, TEXT, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_financial_statement_evaluation(TEXT, TEXT, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) TO service_role;


CREATE OR REPLACE FUNCTION public.append_financial_statement_reviewer_decision(
  p_decision_id                TEXT,
  p_report_id                   TEXT,
  p_company_id                  UUID,
  p_decision                    JSONB,
  p_reviewer_firm_member_id     UUID
)
  RETURNS public.financial_statement_reviewer_decisions
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.financial_statement_reviewer_decisions;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.id = p_reviewer_firm_member_id
      AND fm.company_id = p_company_id
      AND fm.accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: firm member % is not an accepted member of company %', p_reviewer_firm_member_id, p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
    FROM public.financial_statement_reviewer_decisions
   WHERE report_id = p_report_id AND decision_id = p_decision_id
   LIMIT 1;

  IF FOUND THEN
    RETURN v_row;
  END IF;

  INSERT INTO public.financial_statement_reviewer_decisions (
    decision_id, report_id, company_id, decision, reviewer_firm_member_id
  ) VALUES (
    p_decision_id, p_report_id, p_company_id, p_decision, p_reviewer_firm_member_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO v_row
      FROM public.financial_statement_reviewer_decisions
     WHERE report_id = p_report_id AND decision_id = p_decision_id
     LIMIT 1;
    RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.append_financial_statement_reviewer_decision(TEXT, TEXT, UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_financial_statement_reviewer_decision(TEXT, TEXT, UUID, JSONB, UUID) TO service_role;
