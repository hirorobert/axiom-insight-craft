-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261226100000 — Statements issued OUTSIDE CFOClose become a reviewed, hash-bound source of the comparative. AUTHORED, NOT
-- APPLIED to any hosted database. Forward-only; requires 20261223100000 (the merged first-period governed review) and the Ready
-- for Reporting pilot (20261225100000); renumbered from 20261218100000 when the stack was consolidated after the merged chain tail.
--
--   THE GAP: a client whose prior year was issued elsewhere can already restate a comparative (fs_propose_restatement /
--   fs_decide_restatement keep the figures as reported beside the restated ones), but nothing tied that restatement to WHAT WAS
--   ISSUED: the restatement's only anchor was a free-text reference. The issued document, its structured comparative schedule and
--   the evidence of the adjustment were not records, so the comparative could silently drift from the issued statements.
--
--   WHAT THIS ADDS (additive; no existing object is altered except one spliced call in fs_publication_blockers):
--     · fs_issued_comparatives — append-only: the issued document's hash and issue date, its structured comparative schedule
--       (every presented line of the comparative, exact minor units) and the evidence of each adjustment (kind, reference,
--       hash, the line and amount it supports);
--     · fs_record_issued_comparative (prepare_close) — validates the schedule against the composed comparative's presented lines;
--     · fs_propose_restatement_from_issued (prepare_close) — derives the restatement from the issued schedule minus the figures as
--       reported, requires evidence for every changed line, and hands it to the EXISTING restatement workflow (a different
--       person with review_close approves it; the comparative approval then binds it as before);
--     · fs_restatement_authorizations / fs_authorize_restatement — IMPORTING the issued comparatives is not a restatement: the issued
--       statements are what was reported, and the restatement rows derived from them only bridge the source ledger to what was issued
--       (reference 'issued:<id>'; the two-person workflow alone authorises them). A GENUINE restatement of an issued figure (a prior-period
--       error, a policy change) is a different act: it needs its own authorization by a third person holding approve_certification, with
--       its basis, and the reconciliation then expects presented = issued + authorized genuine restatements, exactly.
--     · fs_issued_comparative_reconciliation (read) and COMPARATIVE_NOT_AS_ISSUED_EXTERNAL / RESTATEMENT_NOT_AUTHORIZED — while an issued
--       record exists for the period, sign-off is blocked unless the presented comparative equals the issued schedule plus the authorized
--       genuine restatements, line by line, and no approved genuine restatement is left unauthorized.
--   Scopes with no issued record are unchanged. The issued source and the opening bridge remain separate records.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
DECLARE
  v_def text; v_hits integer;
BEGIN
  IF to_regclass('public.fs_issued_comparatives') IS NOT NULL OR to_regclass('public.fs_restatement_authorizations') IS NOT NULL OR to_regprocedure('public.fs_record_issued_comparative(uuid, integer, text, text, date, jsonb, jsonb, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: issued comparative schedules are already applied; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.fs_propose_restatement(uuid, integer, jsonb, text, text, uuid)') IS NULL OR to_regprocedure('public.fs_statement_composition(uuid, integer)') IS NULL
     OR to_regprocedure('public._fs_first_period_pending(uuid, integer)') IS NULL OR to_regprocedure('public._rfr_blockers(uuid, text, integer)') IS NULL
     OR to_regprocedure('public.close_review_events_guard()') IS NULL OR to_regprocedure('public.close_review_readable(uuid)') IS NULL
     OR to_regprocedure('public._fs_restatement_state(uuid)') IS NULL OR to_regprocedure('public._fs_scope_lock(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261020100000 (comparatives), 20261225100000 (readiness) and 20261223100000 (first-period review) must be applied first; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  v_def := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
  IF position('fs_server_compilation_blocker' IN v_def) = 0 OR position('_rfr_blockers' IN v_def) = 0 OR position('_fs_first_period_pending' IN v_def) = 0 OR position('_fs_document_structure_blockers' IN v_def) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: fs_publication_blockers lacks the server-compilation, readiness, first-period or document-structure splice; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF position('_fs_issued_comparative_blockers' IN v_def) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: fs_publication_blockers already carries the issued-comparative call; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, E'\n  RETURN v_out;', ''))) / length(E'\n  RETURN v_out;');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: expected exactly one final RETURN v_out in fs_publication_blockers, found %; nothing was changed', v_hits USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

CREATE TABLE public.fs_issued_comparatives (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq               BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id        UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year       INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  document_name     TEXT        NOT NULL CHECK (length(btrim(document_name)) BETWEEN 3 AND 300),
  document_sha256   TEXT        NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  issued_on         DATE        NOT NULL,
  schedule          JSONB       NOT NULL CHECK (jsonb_typeof(schedule) = 'array' AND jsonb_array_length(schedule) BETWEEN 1 AND 200),
  schedule_sha256   TEXT        NOT NULL CHECK (schedule_sha256 ~ '^[0-9a-f]{64}$'),
  adjustment_evidence JSONB     NOT NULL CHECK (jsonb_typeof(adjustment_evidence) = 'array' AND jsonb_array_length(adjustment_evidence) <= 100),
  request_id        UUID        NOT NULL,
  intent_sha256     TEXT        NOT NULL,
  actor_user_id     UUID        NOT NULL,
  firm_member_id    UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_fsic_request UNIQUE (actor_user_id, request_id)
);
CREATE INDEX idx_fsic_scope ON public.fs_issued_comparatives (company_id, period_year, seq DESC);
CREATE TRIGGER trg_fsic_append_only BEFORE UPDATE OR DELETE ON public.fs_issued_comparatives FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_fsic_no_truncate BEFORE TRUNCATE ON public.fs_issued_comparatives FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();

-- The composed comparative's presented lines: (lineId, section, presented, as reported). Lines with no comparative are absent.
CREATE OR REPLACE FUNCTION public._fs_issued_comparative_lines(p_company_id uuid, p_period_year integer)
RETURNS TABLE (line_id text, section text, presented_minor numeric, as_reported_minor numeric) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT l ->> 'lineId', l ->> 'section', (l -> 'comparative' ->> 'amountMinor')::numeric, (l -> 'comparative' ->> 'asReportedMinor')::numeric
    FROM jsonb_array_elements(public.fs_statement_composition(p_company_id, p_period_year) -> 'lines') l
   WHERE l -> 'comparative' IS NOT NULL AND jsonb_typeof(l -> 'comparative') = 'object' AND (l -> 'comparative' ->> 'amountMinor') IS NOT NULL;
$$;

-- Schedule shape: [{"lineId","section","amountMinor"}] exactly the composed comparative's presented lines. NULL = valid, else the reason.
CREATE OR REPLACE FUNCTION public._fs_issued_schedule_problem(p_company_id uuid, p_period_year integer, p_schedule jsonb)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_bad text;
BEGIN
  IF jsonb_typeof(p_schedule) IS DISTINCT FROM 'array' OR jsonb_array_length(p_schedule) NOT BETWEEN 1 AND 200 THEN RETURN 'schedule_shape'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_schedule) e WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'lineId') IS DISTINCT FROM 'string' OR jsonb_typeof(e -> 'section') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e -> 'amountMinor') IS DISTINCT FROM 'string' OR (e ->> 'amountMinor') !~ '^-?[0-9]{1,30}$' OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('lineId', 'section', 'amountMinor'))) THEN
    RETURN 'schedule_line_shape';
  END IF;
  IF (SELECT count(DISTINCT (e ->> 'lineId', e ->> 'section')) FROM jsonb_array_elements(p_schedule) e) <> jsonb_array_length(p_schedule) THEN RETURN 'schedule_duplicate_line'; END IF;
  SELECT string_agg(x, ',' ORDER BY x) INTO v_bad FROM (SELECT c.line_id || '/' || c.section AS x FROM public._fs_issued_comparative_lines(p_company_id, p_period_year) c
     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_schedule) e WHERE e ->> 'lineId' = c.line_id AND e ->> 'section' = c.section)) q;
  IF v_bad IS NOT NULL THEN RETURN 'schedule_incomplete:' || left(v_bad, 200); END IF;
  SELECT string_agg(x, ',' ORDER BY x) INTO v_bad FROM (SELECT (e ->> 'lineId') || '/' || (e ->> 'section') AS x FROM jsonb_array_elements(p_schedule) e
     WHERE NOT EXISTS (SELECT 1 FROM public._fs_issued_comparative_lines(p_company_id, p_period_year) c WHERE c.line_id = e ->> 'lineId' AND c.section = e ->> 'section')) q;
  IF v_bad IS NOT NULL THEN RETURN 'schedule_unknown_line:' || left(v_bad, 200); END IF;
  RETURN NULL;
END;
$$;

-- Outcomes: recorded | replay | unchanged | forbidden | feature_disabled | invalid_request | request_reused | comparative_not_available | schedule_*.
CREATE OR REPLACE FUNCTION public.fs_record_issued_comparative(p_company_id uuid, p_period_year integer, p_document_name text, p_document_sha256 text,
  p_issued_on date, p_schedule jsonb, p_adjustment_evidence jsonb, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_problem text; v_norm jsonb; v_sha text; v_ev jsonb; v_intent text; v_prior public.fs_issued_comparatives; v_last public.fs_issued_comparatives; v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_document_name IS NULL OR length(btrim(p_document_name)) NOT BETWEEN 3 AND 300
     OR p_document_sha256 IS NULL OR p_document_sha256 !~ '^[0-9a-f]{64}$' OR p_issued_on IS NULL OR p_issued_on > current_date OR p_period_year NOT BETWEEN 2000 AND 2100
     OR p_adjustment_evidence IS NULL OR jsonb_typeof(p_adjustment_evidence) <> 'array' OR jsonb_array_length(p_adjustment_evidence) > 100 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_adjustment_evidence) e WHERE jsonb_typeof(e) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('kind', 'reference', 'sha256', 'lineId', 'amountMinor'))
       OR jsonb_typeof(e -> 'kind') IS DISTINCT FROM 'string' OR (e ->> 'kind') NOT IN ('audit_adjustment_schedule', 'adjustment_journal', 'management_letter', 'other_evidenced')
       OR jsonb_typeof(e -> 'reference') IS DISTINCT FROM 'string' OR length(btrim(e ->> 'reference')) NOT BETWEEN 3 AND 300
       OR jsonb_typeof(e -> 'sha256') IS DISTINCT FROM 'string' OR (e ->> 'sha256') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(e -> 'lineId') IS DISTINCT FROM 'string' OR jsonb_typeof(e -> 'amountMinor') IS DISTINCT FROM 'string' OR (e ->> 'amountMinor') !~ '^-?[1-9][0-9]{0,29}$') THEN
    RETURN jsonb_build_object('outcome', 'invalid_request', 'detail', 'adjustment_evidence');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_comparatives:' || p_company_id::text || ':' || p_period_year::text, 0));
  IF public.fs_statement_composition(p_company_id, p_period_year) -> 'comparative' ->> 'state' IS DISTINCT FROM 'available' THEN RETURN jsonb_build_object('outcome', 'comparative_not_available'); END IF;
  v_problem := public._fs_issued_schedule_problem(p_company_id, p_period_year, p_schedule);
  IF v_problem IS NOT NULL THEN RETURN jsonb_build_object('outcome', split_part(v_problem, ':', 1), 'detail', nullif(substr(v_problem, length(split_part(v_problem, ':', 1)) + 2), '')); END IF;
  v_norm := (SELECT jsonb_agg(jsonb_build_object('lineId', e ->> 'lineId', 'section', e ->> 'section', 'amountMinor', e ->> 'amountMinor') ORDER BY e ->> 'lineId', e ->> 'section') FROM jsonb_array_elements(p_schedule) e);
  v_ev := (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', e ->> 'kind', 'reference', btrim(e ->> 'reference'), 'sha256', e ->> 'sha256', 'lineId', e ->> 'lineId', 'amountMinor', e ->> 'amountMinor') ORDER BY e ->> 'lineId', e ->> 'reference'), '[]'::jsonb) FROM jsonb_array_elements(p_adjustment_evidence) e);
  v_sha := encode(sha256(convert_to(v_norm::text, 'UTF8')), 'hex');
  v_intent := encode(sha256(convert_to(jsonb_build_array(p_company_id, p_period_year, btrim(p_document_name), p_document_sha256, p_issued_on, v_sha, v_ev)::text, 'UTF8')), 'hex');
  SELECT * INTO v_prior FROM public.fs_issued_comparatives c WHERE c.actor_user_id = v_uid AND c.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.intent_sha256 = v_intent THEN RETURN jsonb_build_object('outcome', 'replay', 'issuedId', v_prior.id); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT * INTO v_last FROM public.fs_issued_comparatives c WHERE c.company_id = p_company_id AND c.period_year = p_period_year ORDER BY c.seq DESC LIMIT 1;
  IF v_last.id IS NOT NULL AND v_last.intent_sha256 = v_intent THEN RETURN jsonb_build_object('outcome', 'unchanged', 'issuedId', v_last.id); END IF;
  INSERT INTO public.fs_issued_comparatives (company_id, period_year, document_name, document_sha256, issued_on, schedule, schedule_sha256, adjustment_evidence, request_id, intent_sha256, actor_user_id, firm_member_id)
  VALUES (p_company_id, p_period_year, btrim(p_document_name), p_document_sha256, p_issued_on, v_norm, v_sha, v_ev, p_request_id, v_intent, v_uid, public._cr_member(p_company_id, v_uid)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'issuedId', v_id, 'scheduleSha256', v_sha);
END;
$$;

CREATE TABLE public.fs_restatement_authorizations (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq            BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id     UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year    INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  restatement_id UUID        NOT NULL UNIQUE REFERENCES public.fs_comparative_restatements (id) ON DELETE RESTRICT,
  basis          TEXT        NOT NULL CHECK (basis IN ('prior_period_error', 'accounting_policy_change')),
  reason         TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  evidence_ref   TEXT        NOT NULL CHECK (length(btrim(evidence_ref)) BETWEEN 3 AND 300),
  request_id     UUID        NOT NULL,
  actor_user_id  UUID        NOT NULL,
  firm_member_id UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_fsra_request UNIQUE (actor_user_id, request_id)
);
CREATE TRIGGER trg_fsra_append_only BEFORE UPDATE OR DELETE ON public.fs_restatement_authorizations FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_fsra_no_truncate BEFORE TRUNCATE ON public.fs_restatement_authorizations FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();

-- Approved restatements that are GENUINE (not derived from an issued record) and their authorization state, per period.
CREATE OR REPLACE FUNCTION public._fs_genuine_restatements(p_company_id uuid, p_period_year integer)
RETURNS TABLE (restatement_id uuid, lines jsonb, authorized boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.id, r.lines, EXISTS (SELECT 1 FROM public.fs_restatement_authorizations a WHERE a.restatement_id = r.id)
    FROM public.fs_comparative_restatements r
   WHERE r.company_id = p_company_id AND r.period_year = p_period_year AND r.reference NOT LIKE 'issued:%' AND public._fs_restatement_state(r.id) = 'approved';
$$;
CREATE OR REPLACE FUNCTION public._fs_authorized_restatement_delta(p_company_id uuid, p_period_year integer)
RETURNS TABLE (line_id text, section text, delta numeric) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d ->> 'lineId', d ->> 'section', sum((d ->> 'deltaMinor')::numeric)
    FROM public._fs_genuine_restatements(p_company_id, p_period_year) g CROSS JOIN LATERAL jsonb_array_elements(g.lines) d
   WHERE g.authorized GROUP BY 1, 2;
$$;

-- Presented comparative against the latest issued schedule plus the AUTHORIZED genuine restatements, line by line.
CREATE OR REPLACE FUNCTION public.fs_issued_comparative_reconciliation(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_i public.fs_issued_comparatives; v_diff jsonb; v_unauth integer;
BEGIN
  IF NOT public.close_review_readable(p_company_id) THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  SELECT * INTO v_i FROM public.fs_issued_comparatives c WHERE c.company_id = p_company_id AND c.period_year = p_period_year ORDER BY c.seq DESC LIMIT 1;
  IF v_i.id IS NULL THEN RETURN jsonb_build_object('state', 'none'); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('lineId', x.line_id, 'section', x.section, 'issuedMinor', x.issued::text, 'authorizedRestatementMinor', x.auth::text,
         'presentedMinor', x.presented::text, 'asReportedMinor', x.as_reported::text) ORDER BY x.line_id, x.section), '[]'::jsonb) INTO v_diff
    FROM (SELECT (e ->> 'lineId') AS line_id, (e ->> 'section') AS section, (e ->> 'amountMinor')::numeric AS issued, coalesce(az.delta, 0) AS auth, c.presented_minor AS presented, c.as_reported_minor AS as_reported
            FROM jsonb_array_elements(v_i.schedule) e
            LEFT JOIN public._fs_issued_comparative_lines(p_company_id, p_period_year) c ON c.line_id = e ->> 'lineId' AND c.section = e ->> 'section'
            LEFT JOIN public._fs_authorized_restatement_delta(p_company_id, p_period_year) az ON az.line_id = e ->> 'lineId' AND az.section = e ->> 'section') x
   WHERE x.presented IS DISTINCT FROM x.issued + x.auth;
  SELECT count(*) INTO v_unauth FROM public._fs_genuine_restatements(p_company_id, p_period_year) g WHERE NOT g.authorized;
  RETURN jsonb_build_object('state', CASE WHEN jsonb_array_length(v_diff) = 0 AND v_unauth = 0 THEN 'reconciled' ELSE 'differences' END, 'issuedId', v_i.id, 'documentName', v_i.document_name, 'documentSha256', v_i.document_sha256,
    'issuedOn', v_i.issued_on, 'scheduleSha256', v_i.schedule_sha256, 'differences', v_diff, 'unauthorizedRestatements', v_unauth,
    'authorizedRestatements', (SELECT count(*) FROM public._fs_genuine_restatements(p_company_id, p_period_year) g WHERE g.authorized));
END;
$$;

-- Authorizing a GENUINE restatement of issued figures. Outcomes: recorded | replay | already_authorized | forbidden | feature_disabled | invalid_request |
-- not_found | not_approved | issued_import_needs_no_authorization | no_issued_record | authorizer_is_proposer | authorizer_is_approver | request_reused.
CREATE OR REPLACE FUNCTION public.fs_authorize_restatement(p_restatement_id uuid, p_basis text, p_reason text, p_evidence_ref text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_r public.fs_comparative_restatements; v_prior public.fs_restatement_authorizations; v_approver uuid; v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_restatement_id IS NULL OR p_request_id IS NULL OR p_basis IS NULL OR p_basis NOT IN ('prior_period_error', 'accounting_policy_change')
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 OR p_evidence_ref IS NULL OR length(btrim(p_evidence_ref)) NOT BETWEEN 3 AND 300 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  SELECT * INTO v_r FROM public.fs_comparative_restatements r WHERE r.id = p_restatement_id;
  IF v_r.id IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF NOT public.workspace_capability_allowed(v_r.company_id, v_uid, 'approve_certification') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(v_r.company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_comparatives:' || v_r.company_id::text || ':' || v_r.period_year::text, 0));
  SELECT * INTO v_prior FROM public.fs_restatement_authorizations a WHERE a.actor_user_id = v_uid AND a.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.restatement_id = p_restatement_id AND v_prior.basis = p_basis THEN RETURN jsonb_build_object('outcome', 'replay', 'authorizationId', v_prior.id); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  IF v_r.reference LIKE 'issued:%' THEN RETURN jsonb_build_object('outcome', 'issued_import_needs_no_authorization'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fs_issued_comparatives c WHERE c.company_id = v_r.company_id AND c.period_year = v_r.period_year) THEN RETURN jsonb_build_object('outcome', 'no_issued_record'); END IF;
  IF public._fs_restatement_state(p_restatement_id) <> 'approved' THEN RETURN jsonb_build_object('outcome', 'not_approved'); END IF;
  IF EXISTS (SELECT 1 FROM public.fs_restatement_authorizations a WHERE a.restatement_id = p_restatement_id) THEN RETURN jsonb_build_object('outcome', 'already_authorized'); END IF;
  IF v_r.proposed_by = v_uid THEN RETURN jsonb_build_object('outcome', 'authorizer_is_proposer'); END IF;
  SELECT d.actor_user_id INTO v_approver FROM public.fs_comparative_restatement_decisions d WHERE d.restatement_id = p_restatement_id AND d.decision = 'approved' ORDER BY d.seq DESC LIMIT 1;
  IF v_approver = v_uid THEN RETURN jsonb_build_object('outcome', 'authorizer_is_approver'); END IF;
  INSERT INTO public.fs_restatement_authorizations (company_id, period_year, restatement_id, basis, reason, evidence_ref, request_id, actor_user_id, firm_member_id)
  VALUES (v_r.company_id, v_r.period_year, p_restatement_id, p_basis, btrim(p_reason), btrim(p_evidence_ref), p_request_id, v_uid, public._cr_member(v_r.company_id, v_uid)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'authorizationId', v_id);
END;
$$;

-- Outcomes: recorded (restatementId) | already_equal | already_proposed | delta_unevidenced | no_issued_record | forbidden | feature_disabled | invalid_request | the restatement workflow's own outcomes.
CREATE OR REPLACE FUNCTION public.fs_propose_restatement_from_issued(p_company_id uuid, p_period_year integer, p_issued_id uuid, p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_i public.fs_issued_comparatives; v_deltas jsonb; v_unev text; v_res jsonb; v_pending uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_issued_id IS NULL OR p_request_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_comparatives:' || p_company_id::text || ':' || p_period_year::text, 0));
  SELECT * INTO v_i FROM public.fs_issued_comparatives c WHERE c.id = p_issued_id AND c.company_id = p_company_id AND c.period_year = p_period_year;
  IF v_i.id IS NULL OR v_i.id IS DISTINCT FROM (SELECT c2.id FROM public.fs_issued_comparatives c2 WHERE c2.company_id = p_company_id AND c2.period_year = p_period_year ORDER BY c2.seq DESC LIMIT 1) THEN
    RETURN jsonb_build_object('outcome', 'no_issued_record');
  END IF;
  -- A pending or approved restatement already derived from this issued record: never a second one (a retry or a double click).
  SELECT r.id INTO v_pending FROM public.fs_comparative_restatements r
   WHERE r.company_id = p_company_id AND r.period_year = p_period_year AND r.reference = 'issued:' || v_i.id::text AND public._fs_restatement_state(r.id) IN ('proposed', 'approved') LIMIT 1;
  IF v_pending IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'already_proposed', 'restatementId', v_pending, 'state', public._fs_restatement_state(v_pending)); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('lineId', c.line_id, 'section', c.section, 'deltaMinor', (s.amount - c.as_reported_minor)::text) ORDER BY c.line_id, c.section), '[]'::jsonb) INTO v_deltas
    FROM public._fs_issued_comparative_lines(p_company_id, p_period_year) c
    JOIN (SELECT e ->> 'lineId' AS line_id, e ->> 'section' AS section, (e ->> 'amountMinor')::numeric AS amount FROM jsonb_array_elements(v_i.schedule) e) s ON s.line_id = c.line_id AND s.section = c.section
   WHERE s.amount <> c.as_reported_minor;
  IF jsonb_array_length(v_deltas) = 0 THEN RETURN jsonb_build_object('outcome', 'already_equal'); END IF;
  -- Every changed line is supported by evidence that names the line and states exactly its change.
  SELECT string_agg(d ->> 'lineId', ',' ORDER BY d ->> 'lineId') INTO v_unev FROM jsonb_array_elements(v_deltas) d
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_i.adjustment_evidence) ev WHERE ev ->> 'lineId' = d ->> 'lineId' AND (ev ->> 'amountMinor')::numeric = (d ->> 'deltaMinor')::numeric);
  IF v_unev IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'delta_unevidenced', 'lines', v_unev); END IF;
  v_res := public.fs_propose_restatement(p_company_id, p_period_year, v_deltas, btrim(p_reason), 'issued:' || v_i.id::text, p_request_id);
  RETURN v_res || jsonb_build_object('issuedId', v_i.id, 'deltas', v_deltas);
END;
$$;

-- Sign-off: while an issued record exists for the period and the comparative is presented, it must equal the issued schedule plus the authorized genuine
-- restatements, and no approved genuine restatement may be left unauthorized.
CREATE OR REPLACE FUNCTION public._fs_issued_comparative_blockers(p_company_id uuid, p_period_year integer)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_i public.fs_issued_comparatives; v_n integer; v_first text; v_unauth integer; v_out text[] := '{}';
BEGIN
  SELECT * INTO v_i FROM public.fs_issued_comparatives c WHERE c.company_id = p_company_id AND c.period_year = p_period_year ORDER BY c.seq DESC LIMIT 1;
  IF v_i.id IS NULL THEN RETURN '{}'; END IF;
  IF public.fs_statement_composition(p_company_id, p_period_year) -> 'comparative' ->> 'state' IS DISTINCT FROM 'available' THEN RETURN '{}'; END IF;
  SELECT count(*), min(x.line_id) INTO v_n, v_first FROM (SELECT e ->> 'lineId' AS line_id, c.presented_minor, (e ->> 'amountMinor')::numeric + coalesce(az.delta, 0) AS expected
      FROM jsonb_array_elements(v_i.schedule) e
      LEFT JOIN public._fs_issued_comparative_lines(p_company_id, p_period_year) c ON c.line_id = e ->> 'lineId' AND c.section = e ->> 'section'
      LEFT JOIN public._fs_authorized_restatement_delta(p_company_id, p_period_year) az ON az.line_id = e ->> 'lineId' AND az.section = e ->> 'section') x
   WHERE x.presented_minor IS DISTINCT FROM x.expected;
  IF v_n > 0 THEN v_out := v_out || ('COMPARATIVE_NOT_AS_ISSUED_EXTERNAL:' || v_n || ':' || v_first); END IF;
  SELECT count(*) INTO v_unauth FROM public._fs_genuine_restatements(p_company_id, p_period_year) g WHERE NOT g.authorized;
  IF v_unauth > 0 THEN v_out := v_out || ('RESTATEMENT_NOT_AUTHORIZED:' || v_unauth); END IF;
  RETURN v_out;
END;
$$;

-- Splice the one call into fs_publication_blockers (the live text is the base; asserted, not copied).
DO $splice$
DECLARE
  v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, E'\n  RETURN v_out;', ''))) / length(E'\n  RETURN v_out;') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the final RETURN v_out is not present exactly once' USING ERRCODE = 'P0001';
  END IF;
  v_new := replace(v_def, E'\n  RETURN v_out;', E'\n  -- [20261226100000] A comparative backed by statements issued outside CFOClose must equal them, line by line.\n  v_out := v_out || public._fs_issued_comparative_blockers(p_company_id, v_report.period_year);\n  RETURN v_out;');
  EXECUTE v_new;
END;
$splice$;

ALTER TABLE public.fs_issued_comparatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_restatement_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fs_issued_comparatives, public.fs_restatement_authorizations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.fs_issued_comparatives, public.fs_restatement_authorizations TO authenticated, service_role;
CREATE POLICY fsic_read ON public.fs_issued_comparatives FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY fsra_read ON public.fs_restatement_authorizations FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
REVOKE ALL ON FUNCTION public._fs_issued_comparative_lines(uuid, integer), public._fs_issued_schedule_problem(uuid, integer, jsonb), public._fs_issued_comparative_blockers(uuid, integer), public._fs_genuine_restatements(uuid, integer), public._fs_authorized_restatement_delta(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_authorize_restatement(uuid, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_authorize_restatement(uuid, text, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_record_issued_comparative(uuid, integer, text, text, date, jsonb, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_record_issued_comparative(uuid, integer, text, text, date, jsonb, jsonb, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_issued_comparative_reconciliation(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_issued_comparative_reconciliation(uuid, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_propose_restatement_from_issued(uuid, integer, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_propose_restatement_from_issued(uuid, integer, uuid, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_publication_blockers(uuid, text, integer) FROM PUBLIC, anon, authenticated;

DO $postcondition$
DECLARE v_def text := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
BEGIN
  IF position('_fs_issued_comparative_blockers' IN v_def) = 0 OR position('fs_server_compilation_blocker' IN v_def) = 0 OR position('_rfr_blockers' IN v_def) = 0
     OR position('_fs_first_period_pending' IN v_def) = 0 OR position('_fs_opening_pending' IN v_def) = 0 OR position('_fs_document_structure_blockers' IN v_def) = 0
     OR position('DOCUMENT_FACT_NOT_COMPOSED' IN v_def) = 0 OR position('REVIEW_COMMENT_UNRESOLVED' IN v_def) = 0
     OR has_function_privilege('authenticated', 'public.fs_publication_blockers(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_issued_comparative_blockers(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_record_issued_comparative(uuid, integer, text, text, date, jsonb, jsonb, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_authorize_restatement(uuid, text, text, text, uuid)', 'EXECUTE')
     OR (SELECT count(*) FROM public.fs_issued_comparatives) <> 0 OR (SELECT count(*) FROM public.fs_restatement_authorizations) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: issued comparative schedules are not in the expected state' USING ERRCODE = 'P0001';
  END IF;
END;
$postcondition$;
