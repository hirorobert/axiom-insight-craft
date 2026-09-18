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
-- Write authority: no INSERT/UPDATE/DELETE RLS policy or table grant exists
-- for `authenticated`/`anon` on any of these three tables. Every write goes
-- through one of three SECURITY DEFINER RPCs (section 4). Each derives the
-- acting firm member INSIDE the function from auth.uid() — no argument carries
-- actor authority and any actor embedded in a payload is discarded — and
-- re-checks accepted company membership itself (RLS is bypassed inside a
-- definer function, so the checks are explicit). EXECUTE is granted to
-- `authenticated` only, never PUBLIC/anon, matching resolve_account_review_batch.
-- The browser reaches them only through the future `financial-statement-workspace`
-- Edge Function, which must call them with the CALLER's JWT (never a service-role
-- key, under which auth.uid() is NULL and every call is refused).
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
-- 4. Sole write paths — SECURITY DEFINER RPCs. The actor is ALWAYS derived
--    inside the function from auth.uid(); no argument carries actor
--    authority, and nothing in a submitted payload is trusted for identity.
--    Same pattern as resolve_account_review_batch: EXECUTE is granted to
--    `authenticated` only (never PUBLIC/anon), the caller's own JWT is what
--    auth.uid() reads, and every function re-checks accepted company
--    membership itself. RLS is bypassed inside a definer function, which is
--    exactly why the checks below are explicit and not optional.
-- ════════════════════════════════════════════════════════════════════════

-- Internal helper: resolves the caller's firm_members.id for a company, or
-- refuses. Not callable by any client role (REVOKEd below) — only by the
-- definer functions that follow, which run as the function owner.
CREATE OR REPLACE FUNCTION public.fsr_actor_member_id(p_company_id UUID)
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
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required'
      USING ERRCODE = '42501';
  END IF;

  SELECT fm.id INTO v_member
    FROM public.firm_members fm
   WHERE fm.user_id = v_uid
     AND fm.company_id = p_company_id
     AND fm.accepted_at IS NOT NULL
   ORDER BY fm.id
   LIMIT 1;

  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: the caller is not an accepted member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  RETURN v_member;
END;
$$;

REVOKE ALL ON FUNCTION public.fsr_actor_member_id(UUID) FROM PUBLIC, anon, authenticated;

-- ── save_financial_statement_report ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.save_financial_statement_report(
  p_report_id          TEXT,
  p_report_version     INTEGER,
  p_company_id         UUID,
  p_period_year        INTEGER,
  p_provenance_origin  TEXT,
  p_report_document    JSONB,
  p_content_hash       TEXT
)
  RETURNS public.financial_statement_reports
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor  UUID;
  v_row    public.financial_statement_reports;
  v_latest public.financial_statement_reports;
BEGIN
  -- Actor and membership come from auth.uid(); this raises for anon,
  -- a non-member, or a member of some other company.
  v_actor := public.fsr_actor_member_id(p_company_id);

  -- Serialise every writer of one report lineage. Transaction-scoped: released
  -- at COMMIT/ROLLBACK, so two concurrent "next version" saves cannot both
  -- pass the version check below.
  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reports:' || p_report_id));

  SELECT * INTO v_row
    FROM public.financial_statement_reports
   WHERE report_id = p_report_id AND report_version = p_report_version;

  IF FOUND THEN
    -- Exact replay is a no-op; the same version with different content, or a
    -- version that belongs to another company, is refused — never overwritten.
    IF v_row.company_id = p_company_id AND v_row.content_hash = p_content_hash THEN
      RETURN v_row;
    END IF;
    IF v_row.company_id <> p_company_id THEN
      RAISE EXCEPTION 'FORBIDDEN: report lineage % is not accessible to this company', p_report_id
        USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'STALE_REPORT_VERSION: report % version % already exists with different content', p_report_id, p_report_version
      USING ERRCODE = 'PT409';
  END IF;

  SELECT * INTO v_latest
    FROM public.financial_statement_reports
   WHERE report_id = p_report_id
   ORDER BY report_version DESC
   LIMIT 1;

  IF FOUND THEN
    -- A lineage is bound to one company, one period and one provenance origin.
    IF v_latest.company_id <> p_company_id THEN
      RAISE EXCEPTION 'FORBIDDEN: report lineage % is not accessible to this company', p_report_id
        USING ERRCODE = '42501';
    END IF;
    IF v_latest.period_year <> p_period_year OR v_latest.provenance_origin <> p_provenance_origin THEN
      RAISE EXCEPTION 'STALE_REPORT_VERSION: report % cannot change its period or provenance origin', p_report_id
        USING ERRCODE = 'PT409';
    END IF;
  END IF;

  -- Optimistic-concurrency guard: exactly latest + 1 (or 1 for a new lineage).
  IF p_report_version <> COALESCE(v_latest.report_version, 0) + 1 THEN
    RAISE EXCEPTION 'STALE_REPORT_VERSION: expected version % for report % but received %', COALESCE(v_latest.report_version, 0) + 1, p_report_id, p_report_version
      USING ERRCODE = 'PT409';
  END IF;

  INSERT INTO public.financial_statement_reports (
    report_id, report_version, company_id, period_year, provenance_origin,
    report_document, content_hash, created_by_firm_member_id
  ) VALUES (
    p_report_id, p_report_version, p_company_id, p_period_year, p_provenance_origin,
    p_report_document, p_content_hash, v_actor
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.save_financial_statement_report(TEXT, INTEGER, UUID, INTEGER, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_financial_statement_report(TEXT, INTEGER, UUID, INTEGER, TEXT, JSONB, TEXT) TO authenticated;

-- ── save_financial_statement_evaluation ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.save_financial_statement_evaluation(
  p_evaluation_run_id  TEXT,
  p_report_id          TEXT,
  p_report_version     INTEGER,
  p_company_id         UUID,
  p_rule_pack_id       TEXT,
  p_rule_pack_version  TEXT,
  p_engine_version     TEXT,
  p_input_hash         TEXT,
  p_findings           JSONB
)
  RETURNS public.financial_statement_evaluations
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor UUID;
  v_row   public.financial_statement_evaluations;
BEGIN
  v_actor := public.fsr_actor_member_id(p_company_id);

  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_evaluations:' || p_evaluation_run_id));

  -- The evaluated report version must exist AND belong to the caller's company.
  IF NOT EXISTS (
    SELECT 1 FROM public.financial_statement_reports fsr
     WHERE fsr.report_id = p_report_id
       AND fsr.report_version = p_report_version
       AND fsr.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'NOT_FOUND: no report % version % for company %', p_report_id, p_report_version, p_company_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_row
    FROM public.financial_statement_evaluations
   WHERE evaluation_run_id = p_evaluation_run_id;

  IF FOUND THEN
    -- Exact replay returns the stored run. Anything else under the same
    -- deterministic id is a conflict, never a silent overwrite.
    IF v_row.report_id = p_report_id
       AND v_row.report_version = p_report_version
       AND v_row.company_id = p_company_id
       AND v_row.input_hash = p_input_hash
       AND v_row.findings = p_findings THEN
      RETURN v_row;
    END IF;
    RAISE EXCEPTION 'REPLAY_CONFLICT: evaluation % already exists with different content', p_evaluation_run_id
      USING ERRCODE = 'PT409';
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
END;
$$;

REVOKE ALL ON FUNCTION public.save_financial_statement_evaluation(TEXT, TEXT, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_financial_statement_evaluation(TEXT, TEXT, INTEGER, UUID, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;

-- ── append_financial_statement_reviewer_decision ────────────────────────

CREATE OR REPLACE FUNCTION public.append_financial_statement_reviewer_decision(
  p_decision_id  TEXT,
  p_report_id    TEXT,
  p_company_id   UUID,
  p_decision     JSONB
)
  RETURNS public.financial_statement_reviewer_decisions
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor UUID;
  v_row   public.financial_statement_reviewer_decisions;
  -- Whatever actor a client embedded in the payload is discarded: the reviewer
  -- is the caller's own membership, stored in its own column.
  v_clean JSONB := p_decision - 'reviewerId';
BEGIN
  v_actor := public.fsr_actor_member_id(p_company_id);

  IF v_clean->>'decisionId' IS DISTINCT FROM p_decision_id THEN
    RAISE EXCEPTION 'INVALID: the decision payload id does not match the decision id argument'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reviewer_decisions:' || p_report_id || ':' || p_decision_id));

  IF NOT EXISTS (
    SELECT 1 FROM public.financial_statement_reports fsr
     WHERE fsr.report_id = p_report_id AND fsr.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'NOT_FOUND: no report lineage % for company %', p_report_id, p_company_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_row
    FROM public.financial_statement_reviewer_decisions
   WHERE report_id = p_report_id AND decision_id = p_decision_id;

  IF FOUND THEN
    IF v_row.company_id = p_company_id AND v_row.decision = v_clean THEN
      RETURN v_row;
    END IF;
    RAISE EXCEPTION 'REPLAY_CONFLICT: decision % already exists with different content', p_decision_id
      USING ERRCODE = 'PT409';
  END IF;

  INSERT INTO public.financial_statement_reviewer_decisions (
    decision_id, report_id, company_id, decision, reviewer_firm_member_id
  ) VALUES (
    p_decision_id, p_report_id, p_company_id, v_clean, v_actor
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.append_financial_statement_reviewer_decision(TEXT, TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_financial_statement_reviewer_decision(TEXT, TEXT, UUID, JSONB) TO authenticated;
