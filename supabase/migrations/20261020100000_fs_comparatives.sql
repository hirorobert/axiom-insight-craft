-- 20261020100000_fs_comparatives.sql — comparatives: account bridges, reviewed restatements with retained history,
-- approval bound to the exact comparative, and the comparative requirement enforced by the database.
--
--   1. fs_comparative_bridges                append-only: a prior-year account presented through the current account it
--                                            became (charts change between years); prepare_close.
--   2. fs_comparative_restatements /         a restatement of the comparative is a set of line deltas that keeps the
--      fs_comparative_restatement_decisions  statement of financial position in balance, with its reason and reference;
--                                            proposed by prepare_close, approved or rejected by review_close by someone
--                                            other than the proposer (two-person, no self-approval); an approved one can
--                                            only be withdrawn by a later decision — history is never rewritten. Only
--                                            approved, unwithdrawn restatements apply; the as-reported figure stays
--                                            visible beside the presented one.
--   3. fs_statement_composition (v2)         bridges and approved restatements flow into the comparative column, totals
--                                            and lineage (contract fs-statement-composition/2); everything else exactly
--                                            as version 1.
--   4. fs_comparative_approvals /            the comparative is approved (review_close) against its exact identity
--      fs_comparatives_status                (comparativeSha256); any later change makes the approval stale. States:
--                                            approved | unapproved | approval_stale | accounts_not_presented |
--                                            different_currency (translation deferred: never approvable) | reference_only
--                                            (prior statements held as evidence: shown, never satisfying the requirement)
--                                            | missing | first_period_exception (an approved first-period declaration in
--                                            force). The comparative requirement comes from the pack; absence never
--                                            bypasses it.

DO $preflight$
BEGIN
  IF to_regclass('public.fs_comparative_bridges') IS NOT NULL OR to_regclass('public.fs_comparative_restatements') IS NOT NULL
     OR to_regclass('public.fs_comparative_restatement_decisions') IS NOT NULL OR to_regclass('public.fs_comparative_approvals') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: comparatives objects already exist; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. Bridges ───────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.fs_comparative_bridges (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq                 BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id          UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year         INTEGER     NOT NULL,
  prior_account_key   TEXT        NOT NULL CHECK (length(prior_account_key) BETWEEN 1 AND 200),
  -- NULL = the bridge withdrawn.
  current_account_key TEXT        NULL CHECK (current_account_key IS NULL OR length(current_account_key) BETWEEN 1 AND 200),
  reason              TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  actor_user_id       UUID        NOT NULL,
  firm_member_id      UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  request_id          UUID        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_fscb_distinct CHECK (current_account_key IS NULL OR current_account_key <> prior_account_key),
  CONSTRAINT uq_fscb_request UNIQUE (actor_user_id, request_id)
);
CREATE INDEX idx_fscb_current ON public.fs_comparative_bridges (company_id, period_year, prior_account_key, seq DESC);

-- ── 2. Restatements ──────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.fs_comparative_restatements (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq            BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id     UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year    INTEGER     NOT NULL,
  -- [{"lineId", "section", "deltaMinor"}] — validated and balanced at proposal.
  lines          JSONB       NOT NULL,
  reason         TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  reference      TEXT        NOT NULL CHECK (length(btrim(reference)) BETWEEN 3 AND 300),
  proposed_by    UUID        NOT NULL,
  firm_member_id UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  request_id     UUID        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_fscr_request UNIQUE (proposed_by, request_id)
);
CREATE INDEX idx_fscr_company ON public.fs_comparative_restatements (company_id, period_year, seq);

CREATE TABLE public.fs_comparative_restatement_decisions (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq            BIGINT      GENERATED ALWAYS AS IDENTITY,
  restatement_id UUID        NOT NULL REFERENCES public.fs_comparative_restatements (id) ON DELETE RESTRICT,
  decision       TEXT        NOT NULL CHECK (decision IN ('approved', 'rejected', 'withdrawn')),
  reason         TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  actor_user_id  UUID        NOT NULL,
  firm_member_id UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  request_id     UUID        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_fscrd_request UNIQUE (actor_user_id, request_id)
);
CREATE INDEX idx_fscrd_current ON public.fs_comparative_restatement_decisions (restatement_id, seq DESC);

-- ── 4. Approvals ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.fs_comparative_approvals (
  id                 UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq                BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id         UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year        INTEGER     NOT NULL,
  action             TEXT        NOT NULL CHECK (action IN ('approved', 'withdrawn')),
  comparative_sha256 TEXT        NULL CHECK (comparative_sha256 IS NULL OR comparative_sha256 ~ '^[0-9a-f]{64}$'),
  reason             TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  actor_user_id      UUID        NOT NULL,
  firm_member_id     UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  request_id         UUID        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_fsca_sha CHECK ((action = 'approved') = (comparative_sha256 IS NOT NULL)),
  CONSTRAINT uq_fsca_request UNIQUE (actor_user_id, request_id)
);
CREATE INDEX idx_fsca_current ON public.fs_comparative_approvals (company_id, period_year, seq DESC);

CREATE TRIGGER trg_fscb_append_only BEFORE UPDATE OR DELETE ON public.fs_comparative_bridges FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fscb_no_truncate BEFORE TRUNCATE ON public.fs_comparative_bridges FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fscr_append_only BEFORE UPDATE OR DELETE ON public.fs_comparative_restatements FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fscr_no_truncate BEFORE TRUNCATE ON public.fs_comparative_restatements FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fscrd_append_only BEFORE UPDATE OR DELETE ON public.fs_comparative_restatement_decisions FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fscrd_no_truncate BEFORE TRUNCATE ON public.fs_comparative_restatement_decisions FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fsca_append_only BEFORE UPDATE OR DELETE ON public.fs_comparative_approvals FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fsca_no_truncate BEFORE TRUNCATE ON public.fs_comparative_approvals FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();

-- The latest decision of each restatement; approved = applies.
CREATE OR REPLACE FUNCTION public._fs_restatement_state(p_restatement_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT d.decision FROM public.fs_comparative_restatement_decisions d WHERE d.restatement_id = p_restatement_id ORDER BY d.seq DESC LIMIT 1), 'proposed');
$$;
CREATE OR REPLACE FUNCTION public._fs_approved_restatements(p_company_id uuid, p_period_year integer)
RETURNS TABLE (id uuid, lines jsonb, reason text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.id, r.lines, r.reason FROM public.fs_comparative_restatements r
   WHERE r.company_id = p_company_id AND r.period_year = p_period_year AND public._fs_restatement_state(r.id) = 'approved' ORDER BY r.seq;
$$;

-- ── Bridges RPC ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Outcomes: recorded | unchanged | forbidden | feature_disabled | invalid_request | framework_not_ifrs_for_smes | request_reused.
CREATE OR REPLACE FUNCTION public.fs_bridge_comparative_account(p_company_id uuid, p_period_year integer, p_prior_account_key text,
  p_current_account_key text, p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_refusal text;
  v_prior record;
  v_latest text;
  v_found boolean;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_prior_account_key IS NULL OR length(p_prior_account_key) NOT BETWEEN 1 AND 200
     OR (p_current_account_key IS NOT NULL AND (length(p_current_account_key) NOT BETWEEN 1 AND 200 OR p_current_account_key = p_prior_account_key))
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  v_refusal := public._fs_notes_refusal(p_company_id, v_uid);
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_comparatives:' || p_company_id::text || ':' || p_period_year::text, 0));
  SELECT * INTO v_prior FROM public.fs_comparative_bridges b WHERE b.actor_user_id = v_uid AND b.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.prior_account_key = p_prior_account_key
       AND v_prior.current_account_key IS NOT DISTINCT FROM p_current_account_key THEN RETURN jsonb_build_object('outcome', 'recorded', 'replay', true, 'bridgeId', v_prior.id); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT b.current_account_key, true INTO v_latest, v_found FROM public.fs_comparative_bridges b
   WHERE b.company_id = p_company_id AND b.period_year = p_period_year AND b.prior_account_key = p_prior_account_key ORDER BY b.seq DESC LIMIT 1;
  IF (v_found IS NULL AND p_current_account_key IS NULL) OR (v_found AND v_latest IS NOT DISTINCT FROM p_current_account_key) THEN
    RETURN jsonb_build_object('outcome', 'unchanged');
  END IF;
  INSERT INTO public.fs_comparative_bridges (company_id, period_year, prior_account_key, current_account_key, reason, actor_user_id, firm_member_id, request_id)
  VALUES (p_company_id, p_period_year, p_prior_account_key, p_current_account_key, btrim(p_reason), v_uid, public._cr_member(p_company_id, v_uid), p_request_id)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'bridgeId', v_id);
END;
$$;

-- ── Restatement RPCs ─────────────────────────────────────────────────────────────────────────────────────────────────
-- p_lines: [{"lineId", "section", "deltaMinor"}], 1–50 distinct (lineId, section); the section must fit the line (a
-- statement-of-comprehensive-income line uses section 'sci'); every delta a non-zero integer; and the set must keep the
-- statement of financial position in balance: assets − liabilities − equity − (income − expenses) = 0 over the deltas.
-- Outcomes: recorded | forbidden | feature_disabled | invalid_request | framework_not_ifrs_for_smes | invalid_lines |
-- unbalanced | comparative_not_available | request_reused.
CREATE OR REPLACE FUNCTION public.fs_propose_restatement(p_company_id uuid, p_period_year integer, p_lines jsonb, p_reason text,
  p_reference text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_refusal text;
  v_prior record;
  v_bad jsonb;
  v_effect numeric;
  v_norm jsonb;
  v_comp jsonb;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 50
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 OR p_reference IS NULL OR length(btrim(p_reference)) NOT BETWEEN 3 AND 300 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  v_refusal := public._fs_notes_refusal(p_company_id, v_uid);
  IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome', v_refusal); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('index', o, 'lineId', e ->> 'lineId', 'section', e ->> 'section')), '[]'::jsonb) INTO v_bad
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY t(e, o)
    LEFT JOIN public.fs_presentation_lines l ON l.pack_family = 'ifrs-for-smes' AND l.line_id = e ->> 'lineId'
   WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'deltaMinor') IS DISTINCT FROM 'string' OR (e ->> 'deltaMinor') !~ '^-?[1-9][0-9]{0,30}$'
      OR l.line_id IS NULL
      OR (l.statement = 'SCI' AND e ->> 'section' IS DISTINCT FROM 'sci')
      OR (l.statement = 'SFP' AND public._fs_presentation_status(e ->> 'section', l.line_id, l.statement, l.natures, l.position) <> 'presented');
  IF jsonb_array_length(v_bad) > 0
     OR (SELECT count(DISTINCT (e ->> 'lineId', e ->> 'section')) FROM jsonb_array_elements(p_lines) e) <> jsonb_array_length(p_lines) THEN
    RETURN jsonb_build_object('outcome', 'invalid_lines', 'lines', v_bad);
  END IF;
  SELECT sum(CASE WHEN e ->> 'section' IN ('current_assets', 'non_current_assets') THEN (e ->> 'deltaMinor')::numeric
                  WHEN e ->> 'section' IN ('current_liabilities', 'non_current_liabilities', 'equity') THEN -(e ->> 'deltaMinor')::numeric
                  WHEN e ->> 'lineId' IN ('sci.revenue', 'sci.other_income', 'sci.share_of_associates') THEN -(e ->> 'deltaMinor')::numeric
                  ELSE (e ->> 'deltaMinor')::numeric END)
    INTO v_effect FROM jsonb_array_elements(p_lines) e;
  IF v_effect <> 0 THEN RETURN jsonb_build_object('outcome', 'unbalanced', 'differenceMinor', v_effect::text); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_comparatives:' || p_company_id::text || ':' || p_period_year::text, 0));
  v_norm := (SELECT jsonb_agg(jsonb_build_object('lineId', e ->> 'lineId', 'section', e ->> 'section', 'deltaMinor', e ->> 'deltaMinor') ORDER BY e ->> 'lineId', e ->> 'section') FROM jsonb_array_elements(p_lines) e);
  SELECT * INTO v_prior FROM public.fs_comparative_restatements r WHERE r.proposed_by = v_uid AND r.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.lines = v_norm AND v_prior.reason = btrim(p_reason) AND v_prior.reference = btrim(p_reference)
    THEN RETURN jsonb_build_object('outcome', 'recorded', 'replay', true, 'restatementId', v_prior.id); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  v_comp := public.fs_statement_composition(p_company_id, p_period_year);
  IF v_comp -> 'comparative' ->> 'state' IS DISTINCT FROM 'available' THEN
    RETURN jsonb_build_object('outcome', 'comparative_not_available', 'state', coalesce(v_comp -> 'comparative' ->> 'state', v_comp ->> 'state'));
  END IF;
  INSERT INTO public.fs_comparative_restatements (company_id, period_year, lines, reason, reference, proposed_by, firm_member_id, request_id)
  VALUES (p_company_id, p_period_year, v_norm, btrim(p_reason), btrim(p_reference), v_uid, public._cr_member(p_company_id, v_uid), p_request_id)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'restatementId', v_id);
END;
$$;

-- p_decision: approved | rejected (from proposed) | withdrawn (from approved). review_close, never the proposer.
-- Outcomes: recorded | forbidden | feature_disabled | invalid_request | framework_not_ifrs_for_smes | not_found |
-- not_pending | not_approved | self_decision_not_allowed | request_reused.
CREATE OR REPLACE FUNCTION public.fs_decide_restatement(p_restatement_id uuid, p_decision text, p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_r record;
  v_state text;
  v_prior record;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_restatement_id IS NULL OR p_request_id IS NULL OR p_decision NOT IN ('approved', 'rejected', 'withdrawn')
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  SELECT * INTO v_r FROM public.fs_comparative_restatements r WHERE r.id = p_restatement_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF NOT public.workspace_capability_allowed(v_r.company_id, v_uid, 'review_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(v_r.company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_comparatives:' || v_r.company_id::text || ':' || v_r.period_year::text, 0));
  SELECT * INTO v_prior FROM public.fs_comparative_restatement_decisions d WHERE d.actor_user_id = v_uid AND d.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.restatement_id = p_restatement_id AND v_prior.decision = p_decision THEN RETURN jsonb_build_object('outcome', 'recorded', 'replay', true, 'decisionId', v_prior.id); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  IF v_r.proposed_by = v_uid THEN RETURN jsonb_build_object('outcome', 'self_decision_not_allowed'); END IF;
  v_state := public._fs_restatement_state(p_restatement_id);
  IF p_decision IN ('approved', 'rejected') AND v_state <> 'proposed' THEN RETURN jsonb_build_object('outcome', 'not_pending', 'state', v_state); END IF;
  IF p_decision = 'withdrawn' AND v_state <> 'approved' THEN RETURN jsonb_build_object('outcome', 'not_approved', 'state', v_state); END IF;
  INSERT INTO public.fs_comparative_restatement_decisions (restatement_id, decision, reason, actor_user_id, firm_member_id, request_id)
  VALUES (p_restatement_id, p_decision, btrim(p_reason), v_uid, public._cr_member(v_r.company_id, v_uid), p_request_id)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'decisionId', v_id, 'state', p_decision);
END;
$$;

-- Version 2 (comparatives): bridges and approved restatements. VOLATILE only because it uses a transaction-local working table (dropped before it returns); it writes nothing
-- persistent.
CREATE OR REPLACE FUNCTION public.fs_statement_composition(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_input jsonb;
  v_edition jsonb;
  v_cur jsonb;
  v_cmp jsonb;
  v_cmp_state text;
  v_lines jsonb;
  v_totals jsonb;
  v_accounts jsonb;
  v_blockers text[] := '{}';
  v_body jsonb;
  v_n integer;
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL THEN RETURN jsonb_build_object('state', 'invalid_request'); END IF;
  IF NOT public.close_review_readable(p_company_id) THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  v_input := public.fs_reporting_input(p_company_id, p_period_year);
  IF v_input ->> 'state' IS DISTINCT FROM 'current' THEN
    RETURN jsonb_build_object('state', coalesce(v_input ->> 'state', 'unavailable'), 'periodYear', p_period_year);
  END IF;
  v_cur := v_input -> 'current';
  v_edition := public._fs_smes_edition_decide((SELECT c.reporting_framework FROM public.companies c WHERE c.id = p_company_id),
                                              (v_cur ->> 'reportingStart')::date, public._fs_smes_elected(p_company_id, p_period_year));
  IF v_edition ->> 'state' <> 'resolved' THEN
    RETURN jsonb_build_object('state', 'edition_unresolved', 'reason', v_edition ->> 'reason', 'periodYear', p_period_year, 'inputSha256', v_input ->> 'inputSha256');
  END IF;
  v_cmp := v_input -> 'comparative';
  v_cmp_state := CASE WHEN v_cmp ->> 'state' = 'available' AND (v_cmp ->> 'currency' IS DISTINCT FROM v_cur ->> 'currency' OR v_cmp ->> 'exponent' IS DISTINCT FROM v_cur ->> 'exponent')
                      THEN 'different_currency' ELSE v_cmp ->> 'state' END;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.fs_comp_rows (role text, cert text, k text, code text, name text, classification text, section text,
    debit_net numeric, cert_debit_net numeric, adjustments jsonb, line_id text, statement text, label text, requirement_id text, sort_order integer,
    position text, natures text[], asg_id uuid, asg_seq bigint, status text, amount numeric, cert_amount numeric, kind text, ref uuid) ON COMMIT DROP;
  TRUNCATE pg_temp.fs_comp_rows;
  INSERT INTO pg_temp.fs_comp_rows
  WITH br AS (
    -- Account bridges: a prior-year account presented through the current account it became (latest event wins; a
    -- withdrawal leaves current_account_key NULL, i.e. no bridge).
    SELECT DISTINCT ON (b.prior_account_key) b.prior_account_key, b.current_account_key, b.id FROM public.fs_comparative_bridges b
     WHERE b.company_id = p_company_id AND b.period_year = p_period_year ORDER BY b.prior_account_key, b.seq DESC),
  asg AS (
    SELECT DISTINCT ON (a.account_key) a.account_key, a.line_id, a.id, a.seq FROM public.fs_presentation_assignments a
     WHERE a.company_id = p_company_id AND a.pack_family = 'ifrs-for-smes' ORDER BY a.account_key, a.seq DESC),
  acc AS (
    SELECT 'current'::text AS role, v_cur ->> 'certificationId' AS cert, x AS a FROM jsonb_array_elements(v_cur -> 'accounts') x
    UNION ALL
    SELECT 'comparative', v_cmp ->> 'certificationId', x FROM jsonb_array_elements(CASE WHEN v_cmp_state = 'available' THEN v_cmp -> 'accounts' ELSE '[]'::jsonb END) x),
  base AS (
    SELECT acc.role, acc.cert, acc.a ->> 'accountKey' AS k, acc.a ->> 'accountCode' AS code, acc.a ->> 'accountName' AS name,
           acc.a ->> 'classification' AS classification, public._fs_section(acc.a ->> 'classification') AS section,
           (acc.a ->> 'debitMinor')::numeric - (acc.a ->> 'creditMinor')::numeric AS debit_net,
           (acc.a ->> 'certifiedDebitMinor')::numeric - (acc.a ->> 'certifiedCreditMinor')::numeric AS cert_debit_net,
           coalesce(acc.a -> 'adjustmentIds', '[]'::jsonb) AS adjustments,
           asg.line_id, l.statement, l.label, l.requirement_id, l.sort_order, l.position, l.natures, asg.id AS asg_id, asg.seq AS asg_seq,
           CASE WHEN acc.role = 'comparative' AND br.current_account_key IS NOT NULL THEN br.id END AS bridge_id
      FROM acc
      LEFT JOIN br ON acc.role = 'comparative' AND br.prior_account_key = acc.a ->> 'accountKey'
      LEFT JOIN asg ON asg.account_key = CASE WHEN acc.role = 'comparative' THEN coalesce(br.current_account_key, acc.a ->> 'accountKey') ELSE acc.a ->> 'accountKey' END
      LEFT JOIN public.fs_presentation_lines l ON l.pack_family = 'ifrs-for-smes' AND l.line_id = asg.line_id)
  SELECT b.role, b.cert, b.k, b.code, b.name, b.classification, b.section, b.debit_net, b.cert_debit_net, b.adjustments, b.line_id, b.statement, b.label,
         b.requirement_id, b.sort_order, b.position, b.natures, b.asg_id, b.asg_seq,
         public._fs_presentation_status(b.section, b.line_id, b.statement, b.natures, b.position),
         public._fs_line_amount(b.statement, b.section, b.line_id, b.debit_net), public._fs_line_amount(b.statement, b.section, b.line_id, b.cert_debit_net),
         'account', b.bridge_id
    FROM base b;

  -- Approved restatements of the comparative: each line delta is a presented comparative row of its own, so lines and
  -- totals include it and its lineage names it. Only when the comparative is available in the same currency.
  IF v_cmp_state = 'available' THEN
    INSERT INTO pg_temp.fs_comp_rows
    SELECT 'comparative', v_cmp ->> 'certificationId', 'restatement:' || r.id::text, NULL, r.reason, NULL, x ->> 'section', NULL, NULL, '[]'::jsonb,
           x ->> 'lineId', l.statement, l.label, l.requirement_id, l.sort_order, l.position, l.natures, NULL, NULL,
           'presented', (x ->> 'deltaMinor')::numeric, 0, 'restatement', r.id
      FROM public._fs_approved_restatements(p_company_id, p_period_year) r
      CROSS JOIN LATERAL jsonb_array_elements(r.lines) x
      JOIN public.fs_presentation_lines l ON l.pack_family = 'ifrs-for-smes' AND l.line_id = x ->> 'lineId';
  END IF;

  -- Lines: one per (statement, section, line) for the statement of financial position; one per line for the statement of
  -- comprehensive income. A period's amount is the exact sum of its presented accounts (an account absent from a complete
  -- certified trial balance has no balance); the comparative is null unless the prior year is available in the same
  -- currency.
  WITH g AS (
    SELECT r.statement, CASE WHEN r.statement = 'SFP' THEN r.section ELSE 'sci' END AS grp, r.line_id, min(r.label) AS label, min(r.requirement_id) AS req, min(r.sort_order) AS sort,
           coalesce(sum(r.amount) FILTER (WHERE r.role = 'current'), 0) AS cur_amt, count(*) FILTER (WHERE r.role = 'current') AS cur_n,
           coalesce(sum(r.amount) FILTER (WHERE r.role = 'comparative'), 0) AS cmp_amt, count(*) FILTER (WHERE r.role = 'comparative' AND r.kind = 'account') AS cmp_n,
           coalesce(sum(r.amount) FILTER (WHERE r.role = 'comparative' AND r.kind = 'account'), 0) AS cmp_reported,
           count(*) FILTER (WHERE r.role = 'comparative' AND r.kind = 'restatement') AS cmp_restated,
           jsonb_agg(jsonb_build_object('period', r.role, 'accountKey', r.k, 'accountCode', r.code, 'accountName', r.name, 'certificationId', r.cert,
             'classification', r.classification, 'amountMinor', r.amount::text, 'certifiedAmountMinor', r.cert_amount::text, 'adjustmentIds', r.adjustments,
             'assignmentId', r.asg_id, 'assignmentSeq', r.asg_seq, 'kind', r.kind,
             'bridgeId', CASE WHEN r.kind = 'account' THEN r.ref END, 'restatementId', CASE WHEN r.kind = 'restatement' THEN r.ref END) ORDER BY r.role DESC, r.k) AS lineage
      FROM pg_temp.fs_comp_rows r WHERE r.status = 'presented' GROUP BY 1, 2, 3)
  SELECT coalesce(jsonb_agg(jsonb_build_object('statement', g.statement, 'section', g.grp, 'lineId', g.line_id, 'label', g.label, 'requirementId', g.req,
           'current', jsonb_build_object('amountMinor', g.cur_amt::text, 'accounts', g.cur_n),
           'comparative', CASE WHEN v_cmp_state = 'available' THEN jsonb_build_object('amountMinor', g.cmp_amt::text, 'accounts', g.cmp_n,
                            'asReportedMinor', g.cmp_reported::text, 'restated', g.cmp_restated > 0) END,
           'lineage', g.lineage)
         ORDER BY g.statement DESC, array_position(ARRAY['non_current_assets', 'current_assets', 'equity', 'non_current_liabilities', 'current_liabilities', 'sci'], g.grp), g.sort), '[]'::jsonb)
    INTO v_lines FROM g;

  -- Totals per period, only when every account of that period is presented.
  SELECT jsonb_object_agg(p.role, CASE WHEN p.not_presented > 0 THEN jsonb_build_object('state', 'incomplete', 'notPresented', p.not_presented)
    ELSE jsonb_build_object('state', 'complete',
      'nonCurrentAssetsMinor', p.nca::text, 'currentAssetsMinor', p.ca::text, 'totalAssetsMinor', (p.nca + p.ca)::text,
      'currentLiabilitiesMinor', p.cl::text, 'nonCurrentLiabilitiesMinor', p.ncl::text, 'totalLiabilitiesMinor', (p.cl + p.ncl)::text,
      'equityAccountsMinor', p.eq::text, 'incomeMinor', p.inc::text, 'expensesExcludingTaxMinor', p.exp::text,
      'profitBeforeTaxMinor', (p.inc - p.exp)::text, 'taxExpenseMinor', p.tax::text, 'profitOrLossMinor', (p.inc - p.exp - p.tax)::text,
      'totalEquityMinor', (p.eq + p.inc - p.exp - p.tax)::text,
      'totalEquityAndLiabilitiesMinor', (p.cl + p.ncl + p.eq + p.inc - p.exp - p.tax)::text,
      'balanceDifferenceMinor', ((p.nca + p.ca) - (p.cl + p.ncl + p.eq + p.inc - p.exp - p.tax))::text) END)
    INTO v_totals
    FROM (SELECT r.role,
                 count(*) FILTER (WHERE r.status <> 'presented') AS not_presented,
                 coalesce(sum(r.amount) FILTER (WHERE r.status = 'presented' AND r.statement = 'SFP' AND r.section = 'non_current_assets'), 0) AS nca,
                 coalesce(sum(r.amount) FILTER (WHERE r.status = 'presented' AND r.statement = 'SFP' AND r.section = 'current_assets'), 0) AS ca,
                 coalesce(sum(r.amount) FILTER (WHERE r.status = 'presented' AND r.statement = 'SFP' AND r.section = 'current_liabilities'), 0) AS cl,
                 coalesce(sum(r.amount) FILTER (WHERE r.status = 'presented' AND r.statement = 'SFP' AND r.section = 'non_current_liabilities'), 0) AS ncl,
                 coalesce(sum(r.amount) FILTER (WHERE r.status = 'presented' AND r.statement = 'SFP' AND r.section = 'equity'), 0) AS eq,
                 coalesce(sum(r.amount) FILTER (WHERE r.status = 'presented' AND r.statement = 'SCI' AND r.line_id IN ('sci.revenue', 'sci.other_income', 'sci.share_of_associates')), 0) AS inc,
                 coalesce(sum(r.amount) FILTER (WHERE r.status = 'presented' AND r.statement = 'SCI' AND r.line_id NOT IN ('sci.revenue', 'sci.other_income', 'sci.share_of_associates', 'sci.tax_expense')), 0) AS exp,
                 coalesce(sum(r.amount) FILTER (WHERE r.status = 'presented' AND r.statement = 'SCI' AND r.line_id = 'sci.tax_expense'), 0) AS tax
            FROM pg_temp.fs_comp_rows r GROUP BY r.role) p;

  SELECT coalesce(jsonb_agg(jsonb_build_object('period', r.role, 'accountKey', r.k, 'accountCode', r.code, 'accountName', r.name,
           'classification', r.classification, 'status', r.status, 'lineId', r.line_id) ORDER BY r.role DESC, r.status, r.k), '[]'::jsonb)
    INTO v_accounts FROM pg_temp.fs_comp_rows r WHERE r.status <> 'presented';

  SELECT count(*) INTO v_n FROM pg_temp.fs_comp_rows r WHERE r.role = 'current' AND r.status = 'unassigned';
  IF v_n > 0 THEN v_blockers := v_blockers || ('PRESENTATION_UNASSIGNED:' || v_n); END IF;
  SELECT count(*) INTO v_n FROM pg_temp.fs_comp_rows r WHERE r.role = 'current' AND r.status = 'incompatible';
  IF v_n > 0 THEN v_blockers := v_blockers || ('PRESENTATION_INCOMPATIBLE:' || v_n); END IF;
  SELECT count(*) INTO v_n FROM pg_temp.fs_comp_rows r WHERE r.role = 'current' AND r.status = 'excluded';
  IF v_n > 0 THEN v_blockers := v_blockers || ('ACCOUNTS_NOT_PRESENTABLE:' || v_n); END IF;
  -- 5.11: one analysis of expenses — by function or by nature, never both.
  IF EXISTS (SELECT 1 FROM pg_temp.fs_comp_rows r WHERE r.role = 'current' AND r.status = 'presented' AND r.line_id IN ('sci.cost_of_sales', 'sci.operating_expenses_by_function'))
     AND EXISTS (SELECT 1 FROM pg_temp.fs_comp_rows r WHERE r.role = 'current' AND r.status = 'presented' AND r.line_id IN ('sci.employee_benefits_expense', 'sci.depreciation_and_amortisation', 'sci.other_expenses_by_nature')) THEN
    v_blockers := v_blockers || 'EXPENSE_ANALYSIS_MIXED'::text;
  END IF;
  IF v_totals -> 'current' ->> 'state' = 'complete' AND (v_totals -> 'current' ->> 'balanceDifferenceMinor')::numeric <> 0 THEN
    v_blockers := v_blockers || ('BALANCE_DIFFERENCE:' || (v_totals -> 'current' ->> 'balanceDifferenceMinor'));
  END IF;

  v_body := jsonb_build_object(
    'contract', 'fs-statement-composition/2',
    'pack', jsonb_build_object('family', 'ifrs-for-smes', 'linesVersion', '1.0.0', 'packId', v_edition ->> 'packId', 'earlyApplication', (v_edition ->> 'earlyApplication')::boolean),
    'inputSha256', v_input ->> 'inputSha256',
    'current', jsonb_build_object('periodYear', p_period_year, 'certificationId', v_cur ->> 'certificationId', 'currency', v_cur ->> 'currency',
                                  'exponent', (v_cur ->> 'exponent')::integer, 'reportingStart', v_cur ->> 'reportingStart', 'reportingEnd', v_cur ->> 'reportingEnd'),
    'comparative', jsonb_build_object('state', v_cmp_state, 'periodYear', (v_cmp ->> 'periodYear')::integer, 'certificationId', v_cmp ->> 'certificationId',
                                      'currency', v_cmp ->> 'currency',
                                      'bridgeIds', (SELECT coalesce(jsonb_agg(DISTINCT r.ref ORDER BY r.ref), '[]'::jsonb) FROM pg_temp.fs_comp_rows r WHERE r.kind = 'account' AND r.ref IS NOT NULL),
                                      'restatementIds', (SELECT coalesce(jsonb_agg(DISTINCT r.ref ORDER BY r.ref), '[]'::jsonb) FROM pg_temp.fs_comp_rows r WHERE r.kind = 'restatement')),
    'lines', v_lines,
    'totals', coalesce(v_totals, '{}'::jsonb),
    'accountsNotPresented', v_accounts,
    'blockers', to_jsonb(v_blockers));
  DROP TABLE pg_temp.fs_comp_rows;
  RETURN jsonb_build_object('state', 'composed') || v_body
    || jsonb_build_object('compositionSha256', encode(sha256(convert_to(v_body::text, 'UTF8')), 'hex'));
END;
$$;
-- ── 4. Comparative status and approval ──────────────────────────────────────────────────────────────────────────────
-- Prior-year statements held as evidence (reference only): the latest version of a PRIOR_PERIOD_STATEMENTS series for
-- the year validated.
CREATE OR REPLACE FUNCTION public._fs_reference_statements_present(p_company_id uuid, p_period_year integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM (SELECT DISTINCT ON (b.series_key, b.period_role) b.validation_status FROM public.financial_evidence_batches b
                    WHERE b.company_id = p_company_id AND b.reporting_period_id = 'FY' || p_period_year::text AND b.evidence_type = 'PRIOR_PERIOD_STATEMENTS'
                    ORDER BY b.series_key, b.period_role, b.version DESC) latest
     WHERE latest.validation_status IN ('VALID', 'VALID_WITH_WARNINGS'));
$$;

-- VOLATILE because it reads fs_statement_composition; writes nothing.
CREATE OR REPLACE FUNCTION public.fs_comparatives_status(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_comp jsonb;
  v_cmp_state text;
  v_state text;
  v_sha text;
  v_appr record;
  v_unpresented integer;
  v_blockers text[] := '{}';
  v_first boolean;
  v_body jsonb;
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL THEN RETURN jsonb_build_object('state', 'invalid_request'); END IF;
  v_comp := public.fs_statement_composition(p_company_id, p_period_year);
  IF v_comp ->> 'state' IS DISTINCT FROM 'composed' THEN RETURN v_comp; END IF;
  v_cmp_state := v_comp -> 'comparative' ->> 'state';
  v_first := public.fs_first_period_declared(p_company_id, p_period_year);
  SELECT a.id, a.action, a.comparative_sha256, a.actor_user_id, a.created_at INTO v_appr FROM public.fs_comparative_approvals a
   WHERE a.company_id = p_company_id AND a.period_year = p_period_year ORDER BY a.seq DESC LIMIT 1;
  IF v_cmp_state = 'available' THEN
    -- The comparative's exact identity: the prior certification, every comparative figure (presented and as reported),
    -- the comparative totals, the bridges and restatements applied, and what is not presented.
    v_sha := encode(sha256(convert_to(jsonb_build_object(
      'certificationId', v_comp -> 'comparative' ->> 'certificationId',
      'lines', (SELECT coalesce(jsonb_agg(jsonb_build_array(l ->> 'lineId', l ->> 'section', l -> 'comparative' ->> 'amountMinor', l -> 'comparative' ->> 'asReportedMinor') ORDER BY l ->> 'lineId', l ->> 'section'), '[]'::jsonb)
                  FROM jsonb_array_elements(v_comp -> 'lines') l WHERE l -> 'comparative' IS NOT NULL AND jsonb_typeof(l -> 'comparative') = 'object'),
      'totals', v_comp -> 'totals' -> 'comparative',
      'bridgeIds', v_comp -> 'comparative' -> 'bridgeIds', 'restatementIds', v_comp -> 'comparative' -> 'restatementIds',
      'notPresented', (SELECT coalesce(jsonb_agg(a ORDER BY a ->> 'accountKey'), '[]'::jsonb) FROM jsonb_array_elements(v_comp -> 'accountsNotPresented') a WHERE a ->> 'period' = 'comparative')
    )::text, 'UTF8')), 'hex');
    SELECT count(*) INTO v_unpresented FROM jsonb_array_elements(v_comp -> 'accountsNotPresented') a WHERE a ->> 'period' = 'comparative';
    IF v_unpresented > 0 THEN
      v_state := 'accounts_not_presented'; v_blockers := v_blockers || ('COMPARATIVE_ACCOUNTS_NOT_PRESENTED:' || v_unpresented);
    ELSIF v_comp -> 'totals' -> 'comparative' ->> 'state' = 'complete' AND (v_comp -> 'totals' -> 'comparative' ->> 'balanceDifferenceMinor')::numeric <> 0 THEN
      v_state := 'unbalanced'; v_blockers := v_blockers || ('COMPARATIVE_BALANCE_DIFFERENCE:' || (v_comp -> 'totals' -> 'comparative' ->> 'balanceDifferenceMinor'));
    ELSIF v_appr.action = 'approved' AND v_appr.comparative_sha256 = v_sha THEN
      v_state := 'approved';
    ELSIF v_appr.action = 'approved' THEN
      v_state := 'approval_stale'; v_blockers := v_blockers || 'COMPARATIVE_APPROVAL_STALE'::text;
    ELSE
      v_state := 'unapproved'; v_blockers := v_blockers || 'COMPARATIVE_NOT_APPROVED'::text;
    END IF;
  ELSIF v_cmp_state = 'different_currency' THEN
    v_state := 'different_currency'; v_blockers := v_blockers || 'COMPARATIVE_TRANSLATION_DEFERRED'::text;
  ELSIF v_first THEN
    v_state := 'first_period_exception';
  ELSIF public._fs_reference_statements_present(p_company_id, p_period_year) THEN
    v_state := 'reference_only'; v_blockers := v_blockers || 'COMPARATIVE_REQUIRED_MISSING'::text;
  ELSE
    v_state := 'missing'; v_blockers := v_blockers || 'COMPARATIVE_REQUIRED_MISSING'::text;
  END IF;
  v_body := jsonb_build_object('contract', 'fs-comparatives-status/1', 'periodYear', p_period_year, 'state', v_state, 'composedComparativeState', v_cmp_state,
    'required', true, 'firstPeriodDeclared', v_first, 'comparativeSha256', v_sha, 'compositionSha256', v_comp ->> 'compositionSha256',
    'approval', CASE WHEN v_appr.id IS NOT NULL THEN jsonb_build_object('id', v_appr.id, 'action', v_appr.action, 'comparativeSha256', v_appr.comparative_sha256, 'by', v_appr.actor_user_id, 'at', v_appr.created_at) END,
    'blockers', to_jsonb(v_blockers));
  RETURN jsonb_build_object('state', 'evaluated', 'comparative', v_body) || jsonb_build_object('statusSha256', encode(sha256(convert_to(v_body::text, 'UTF8')), 'hex'));
END;
$$;

-- review_close approves the comparative as it is NOW (only an available, fully presented, balanced comparative); a
-- withdrawal is a new event. Outcomes: recorded | unchanged | forbidden | feature_disabled | invalid_request |
-- framework_not_ifrs_for_smes | not_approvable (with the state) | request_reused.
CREATE OR REPLACE FUNCTION public.fs_approve_comparatives(p_company_id uuid, p_period_year integer, p_approve boolean, p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status jsonb;
  v_prior record;
  v_latest record;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_approve IS NULL OR p_request_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'review_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  IF (SELECT c.reporting_framework FROM public.companies c WHERE c.id = p_company_id) IS DISTINCT FROM 'ifrs_for_smes' THEN
    RETURN jsonb_build_object('outcome', 'framework_not_ifrs_for_smes');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fs_comparatives:' || p_company_id::text || ':' || p_period_year::text, 0));
  SELECT * INTO v_prior FROM public.fs_comparative_approvals a WHERE a.actor_user_id = v_uid AND a.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND (v_prior.action = 'approved') = p_approve THEN
      RETURN jsonb_build_object('outcome', 'recorded', 'replay', true, 'approvalId', v_prior.id);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  v_status := public.fs_comparatives_status(p_company_id, p_period_year) -> 'comparative';
  SELECT a.action INTO v_latest FROM public.fs_comparative_approvals a WHERE a.company_id = p_company_id AND a.period_year = p_period_year ORDER BY a.seq DESC LIMIT 1;
  IF p_approve THEN
    IF v_status ->> 'state' = 'approved' THEN RETURN jsonb_build_object('outcome', 'unchanged'); END IF;
    IF v_status ->> 'state' NOT IN ('unapproved', 'approval_stale') THEN RETURN jsonb_build_object('outcome', 'not_approvable', 'state', coalesce(v_status ->> 'state', 'unavailable')); END IF;
  ELSE
    IF v_latest.action IS DISTINCT FROM 'approved' THEN RETURN jsonb_build_object('outcome', 'unchanged'); END IF;
  END IF;
  INSERT INTO public.fs_comparative_approvals (company_id, period_year, action, comparative_sha256, reason, actor_user_id, firm_member_id, request_id)
  VALUES (p_company_id, p_period_year, CASE WHEN p_approve THEN 'approved' ELSE 'withdrawn' END, CASE WHEN p_approve THEN v_status ->> 'comparativeSha256' END,
          btrim(p_reason), v_uid, public._cr_member(p_company_id, v_uid), p_request_id)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'approvalId', v_id, 'comparativeSha256', CASE WHEN p_approve THEN v_status ->> 'comparativeSha256' END);
END;
$$;

-- ── Access ───────────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.fs_comparative_bridges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_comparative_restatements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_comparative_restatement_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_comparative_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fs_comparative_bridges, public.fs_comparative_restatements, public.fs_comparative_restatement_decisions, public.fs_comparative_approvals
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.fs_comparative_bridges, public.fs_comparative_restatements, public.fs_comparative_restatement_decisions, public.fs_comparative_approvals TO authenticated;
CREATE POLICY fscb_read ON public.fs_comparative_bridges FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY fscr_read ON public.fs_comparative_restatements FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY fscrd_read ON public.fs_comparative_restatement_decisions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.fs_comparative_restatements r WHERE r.id = restatement_id AND public.close_review_readable(r.company_id)));
CREATE POLICY fsca_read ON public.fs_comparative_approvals FOR SELECT TO authenticated USING (public.close_review_readable(company_id));

REVOKE ALL ON FUNCTION public._fs_restatement_state(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_approved_restatements(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_reference_statements_present(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_bridge_comparative_account(uuid, integer, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_bridge_comparative_account(uuid, integer, text, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_propose_restatement(uuid, integer, jsonb, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_propose_restatement(uuid, integer, jsonb, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_decide_restatement(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_decide_restatement(uuid, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_comparatives_status(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_comparatives_status(uuid, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_approve_comparatives(uuid, integer, boolean, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_approve_comparatives(uuid, integer, boolean, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_statement_composition(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_statement_composition(uuid, integer) TO authenticated;
