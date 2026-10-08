-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Close Review I3 — approved adjustments (roadmap increment 10): adjustment/1 and approval-policy/1.
--
--   An adjustment is an exact, balanced journal (minor units; every line one side only; Σ debit = Σ credit > 0) on
--   accounts the workspace has classified, proposed against the AUTHORITATIVE trial balance of its period and bound to
--   that authority. It is append-only: proposed → approved | rejected | withdrawn, decided once. A reversal is a NEW
--   adjustment (the server negates the original's lines) that is itself approved.
--
--   The adjusted trial balance is a LAYER: the authoritative certification plus the approved adjustments bound to it. The
--   uploaded trial balance and its certification never change. When the authority changes (a re-check, a new mapping, a
--   replaced file), adjustments bound to the earlier authority stop applying and are shown as such — never silently
--   carried forward.
--
--   Approval (revision 5 §3):
--     two_person           an approver other than the proposer, holding review_close.
--     owner_self_approval  the proposer may approve their own adjustment only while the policy is set AND exactly one
--                          active member holds approve_certification (or the holder of manage_members recorded an
--                          override), holding approve_certification, with a reason and an explicit disclosure
--                          acknowledgement; stamped self_approved and disclosed (sign-off pack, export audit appendix).
--   The policy is a workspace setting changed only with manage_members, each change an append-only event. No row means
--   two_person.
--
--   Approving an adjustment that names findings of the current run records 'finding_adjusted' on each (resolves A03).
--   Behind the financial-statements rollout (allow-list + kill switch). Every write is one of these functions.
--
-- PREFLIGHT: the objects do not exist yet; the migration refuses if they do.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regclass('public.close_review_adjustments') IS NOT NULL OR to_regclass('public.close_review_adjustment_lines') IS NOT NULL
     OR to_regclass('public.close_review_approval_policy_events') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: close review adjustments already exist; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

CREATE TABLE public.close_review_approval_policy_events (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq            BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id     UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  policy         TEXT        NOT NULL CHECK (policy IN ('two_person', 'owner_self_approval')),
  -- Keeps self-approval available although more than one member holds approve_certification (R3 override).
  override_multiple_approvers BOOLEAN NOT NULL DEFAULT false,
  reason         TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  actor_user_id  UUID        NOT NULL,
  firm_member_id UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_crape_override CHECK (NOT override_multiple_approvers OR policy = 'owner_self_approval')
);
CREATE INDEX idx_crape_company ON public.close_review_approval_policy_events (company_id, seq DESC);

CREATE TABLE public.close_review_adjustments (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year       INTEGER     NOT NULL,
  number            INTEGER     NOT NULL CHECK (number > 0),
  certification_id  UUID        NOT NULL REFERENCES public.tb_certifications (id) ON DELETE RESTRICT,
  kind              TEXT        NOT NULL CHECK (kind IN ('adjustment', 'reversal')),
  reverses_id       UUID        NULL REFERENCES public.close_review_adjustments (id) ON DELETE RESTRICT,
  reason            TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 2000),
  evidence_ref      TEXT        NULL CHECK (evidence_ref IS NULL OR length(btrim(evidence_ref)) BETWEEN 3 AND 300),
  finding_ids       UUID[]      NOT NULL DEFAULT '{}',
  lines_sha256      TEXT        NOT NULL CHECK (lines_sha256 ~ '^[0-9a-f]{64}$'),
  total_minor       NUMERIC     NOT NULL CHECK (total_minor > 0),
  proposer_user_id  UUID        NOT NULL,
  proposer_member_id UUID       NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  request_id        UUID        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_cra_number UNIQUE (company_id, period_year, number),
  CONSTRAINT uq_cra_request UNIQUE (proposer_user_id, request_id),
  CONSTRAINT chk_cra_reversal CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL))
);
CREATE INDEX idx_cra_period ON public.close_review_adjustments (company_id, period_year, certification_id);

CREATE TABLE public.close_review_adjustment_lines (
  adjustment_id   UUID        NOT NULL REFERENCES public.close_review_adjustments (id) ON DELETE RESTRICT,
  line_no         INTEGER     NOT NULL CHECK (line_no BETWEEN 1 AND 200),
  account_key     TEXT        NOT NULL,
  account_code    TEXT        NULL,
  account_name    TEXT        NOT NULL,
  classification  TEXT        NOT NULL,
  debit_minor     NUMERIC     NOT NULL CHECK (debit_minor >= 0 AND debit_minor = trunc(debit_minor)),
  credit_minor    NUMERIC     NOT NULL CHECK (credit_minor >= 0 AND credit_minor = trunc(credit_minor)),
  memo            TEXT        NULL CHECK (memo IS NULL OR length(memo) <= 300),
  CONSTRAINT pk_cral PRIMARY KEY (adjustment_id, line_no),
  CONSTRAINT chk_cral_one_side CHECK ((debit_minor > 0) <> (credit_minor > 0))
);

CREATE TRIGGER trg_crape_append_only BEFORE UPDATE OR DELETE ON public.close_review_approval_policy_events FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_crape_no_truncate BEFORE TRUNCATE ON public.close_review_approval_policy_events FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_cra_append_only BEFORE UPDATE OR DELETE ON public.close_review_adjustments FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_cra_no_truncate BEFORE TRUNCATE ON public.close_review_adjustments FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_cral_append_only BEFORE UPDATE OR DELETE ON public.close_review_adjustment_lines FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_cral_no_truncate BEFORE TRUNCATE ON public.close_review_adjustment_lines FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();

-- ── Policy ───────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._cr_approval_policy(p_company_id uuid)
RETURNS TABLE (policy text, override_multiple_approvers boolean, approver_count integer, self_approval_available boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH p AS (
    SELECT e.policy, e.override_multiple_approvers FROM public.close_review_approval_policy_events e
     WHERE e.company_id = p_company_id ORDER BY e.seq DESC LIMIT 1
  ), a AS (
    -- Active members holding approve_certification. Counted from the capability tables directly: has_workspace_capability
    -- is caller-relative for other people inside a member's request (named_user_access_active), which would undercount.
    SELECT count(DISTINCT fm.user_id)::integer AS n FROM public.firm_members fm
     WHERE fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL AND fm.invitation_cancelled_at IS NULL
       AND EXISTS (SELECT 1 FROM public.workspace_member_capabilities c
                    WHERE c.company_id = p_company_id AND c.user_id = fm.user_id AND c.capability = 'approve_certification' AND c.revoked_at IS NULL)
       AND NOT public._capability_withheld(p_company_id, fm.user_id, 'approve_certification')
       AND public._account_named_user_access_active((SELECT co.user_id FROM public.companies co WHERE co.id = p_company_id), fm.user_id)
  )
  SELECT COALESCE((SELECT policy FROM p), 'two_person'), COALESCE((SELECT override_multiple_approvers FROM p), false), a.n,
         COALESCE((SELECT policy FROM p), 'two_person') = 'owner_self_approval'
           AND (a.n = 1 OR COALESCE((SELECT override_multiple_approvers FROM p), false))
    FROM a;
$$;

CREATE OR REPLACE FUNCTION public.close_review_set_approval_policy(p_company_id uuid, p_policy text, p_override_multiple_approvers boolean, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_policy NOT IN ('two_person', 'owner_self_approval') OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000
     OR (COALESCE(p_override_multiple_approvers, false) AND p_policy <> 'owner_self_approval') THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'manage_members') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  INSERT INTO public.close_review_approval_policy_events (company_id, policy, override_multiple_approvers, reason, actor_user_id, firm_member_id)
  VALUES (p_company_id, p_policy, COALESCE(p_override_multiple_approvers, false), btrim(p_reason), v_uid, public._cr_member(p_company_id, v_uid));
  RETURN jsonb_build_object('outcome', 'recorded', 'policy', p_policy);
END;
$$;

-- ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────────────
-- proposed | approved | rejected | withdrawn: the one decision recorded on the shared timeline (subject 'adjustment').
CREATE OR REPLACE FUNCTION public._cr_adjustment_status(p_adjustment_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT CASE e.event_type WHEN 'adjustment_approved' THEN 'approved' WHEN 'adjustment_rejected' THEN 'rejected' ELSE 'withdrawn' END
                     FROM public.close_review_events e
                    WHERE e.subject_kind = 'adjustment' AND e.subject_id = p_adjustment_id::text
                      AND e.event_type IN ('adjustment_approved', 'adjustment_rejected', 'adjustment_withdrawn')
                    ORDER BY e.seq LIMIT 1), 'proposed');
$$;

-- ── Propose ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- p_lines: [{accountKey, debitMinor, creditMinor, memo?}] (minor units as decimal strings). For a reversal, p_lines is
-- ignored: the server negates the original. Outcomes: proposed (also a replay) | forbidden | feature_disabled |
-- no_authority | invalid_request | unbalanced | unknown_account | finding_not_current | not_reversible | request_reused.
CREATE OR REPLACE FUNCTION public.close_review_propose_adjustment(p_company_id uuid, p_period_year integer, p_reason text, p_evidence_ref text,
  p_lines jsonb, p_finding_ids uuid[], p_request_id uuid, p_reverses uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prior public.close_review_adjustments%ROWTYPE;
  v_orig public.close_review_adjustments%ROWTYPE;
  v_cert uuid;
  v_prior_cert uuid;
  v_run uuid;
  v_lines jsonb;
  v_n integer;
  v_bad integer;
  v_dr numeric;
  v_cr numeric;
  v_number integer;
  v_id uuid;
  v_member uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000
     OR (p_evidence_ref IS NOT NULL AND length(btrim(p_evidence_ref)) NOT BETWEEN 3 AND 300) THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  SELECT * INTO v_prior FROM public.close_review_adjustments a WHERE a.proposer_user_id = v_uid AND a.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.reverses_id IS NOT DISTINCT FROM p_reverses THEN
      RETURN jsonb_build_object('outcome', 'proposed', 'adjustmentId', v_prior.id, 'number', v_prior.number, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('close_review_adjustments:' || p_company_id::text || ':' || p_period_year::text, 0));
  SELECT c.id INTO v_cert FROM public.get_authoritative_certification(p_company_id, p_period_year) c;
  IF v_cert IS NULL THEN RETURN jsonb_build_object('outcome', 'no_authority'); END IF;

  IF p_reverses IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.close_review_adjustments a WHERE a.id = p_reverses AND a.company_id = p_company_id AND a.period_year = p_period_year;
    IF v_orig.id IS NULL OR v_orig.kind <> 'adjustment' OR v_orig.certification_id <> v_cert
       OR public._cr_adjustment_status(v_orig.id) <> 'approved'
       OR EXISTS (SELECT 1 FROM public.close_review_adjustments r WHERE r.reverses_id = v_orig.id
                   AND public._cr_adjustment_status(r.id) IN ('proposed', 'approved')) THEN
      RETURN jsonb_build_object('outcome', 'not_reversible');
    END IF;
    SELECT jsonb_agg(jsonb_build_object('accountKey', l.account_key, 'debitMinor', l.credit_minor::text, 'creditMinor', l.debit_minor::text,
                                        'memo', 'Reversal of line ' || l.line_no) ORDER BY l.line_no)
      INTO v_lines FROM public.close_review_adjustment_lines l WHERE l.adjustment_id = v_orig.id;
  ELSE
    v_lines := p_lines;
  END IF;

  IF v_lines IS NULL OR jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) NOT BETWEEN 2 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  -- Every line: an account key, exact non-negative integer minor amounts, exactly one side.
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_lines) l
   WHERE jsonb_typeof(l) <> 'object' OR COALESCE(l->>'accountKey', '') = ''
      OR COALESCE(l->>'debitMinor', '') !~ '^(0|[1-9][0-9]{0,20})$' OR COALESCE(l->>'creditMinor', '') !~ '^(0|[1-9][0-9]{0,20})$'
      OR ((l->>'debitMinor')::numeric > 0) = ((l->>'creditMinor')::numeric > 0)
      OR (l ? 'memo' AND jsonb_typeof(l->'memo') = 'string' AND length(l->>'memo') > 300);
  IF v_bad > 0 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  SELECT sum((l->>'debitMinor')::numeric), sum((l->>'creditMinor')::numeric) INTO v_dr, v_cr FROM jsonb_array_elements(v_lines) l;
  IF v_dr <> v_cr OR v_dr <= 0 THEN RETURN jsonb_build_object('outcome', 'unbalanced', 'debitMinor', v_dr::text, 'creditMinor', v_cr::text); END IF;
  -- Every account must be classified in this workspace (its statement placement is known).
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_lines) l
   WHERE NOT EXISTS (SELECT 1 FROM public.account_mappings m WHERE m.company_id = p_company_id AND m.account_key = l->>'accountKey');
  IF v_bad > 0 THEN RETURN jsonb_build_object('outcome', 'unknown_account'); END IF;
  -- Findings named must belong to the run of the current authorities.
  IF COALESCE(array_length(p_finding_ids, 1), 0) > 0 AND p_reverses IS NULL THEN
    SELECT c.id INTO v_prior_cert FROM public.get_authoritative_certification(p_company_id, p_period_year - 1) c;
    SELECT r.id INTO v_run FROM public.close_review_finding_runs r
     WHERE r.certification_id = v_cert AND r.prior_certification_id IS NOT DISTINCT FROM v_prior_cert AND r.catalogue_version = 'tb-anomaly-catalogue/1';
    IF v_run IS NULL OR EXISTS (SELECT 1 FROM unnest(p_finding_ids) f(id)
                                 WHERE NOT EXISTS (SELECT 1 FROM public.close_review_findings x WHERE x.id = f.id AND x.run_id = v_run)) THEN
      RETURN jsonb_build_object('outcome', 'finding_not_current');
    END IF;
  END IF;

  SELECT COALESCE(max(a.number), 0) + 1 INTO v_number FROM public.close_review_adjustments a WHERE a.company_id = p_company_id AND a.period_year = p_period_year;
  v_member := public._cr_member(p_company_id, v_uid);
  INSERT INTO public.close_review_adjustments (company_id, period_year, number, certification_id, kind, reverses_id, reason, evidence_ref,
    finding_ids, lines_sha256, total_minor, proposer_user_id, proposer_member_id, request_id)
  VALUES (p_company_id, p_period_year, v_number, v_cert, CASE WHEN p_reverses IS NULL THEN 'adjustment' ELSE 'reversal' END, p_reverses,
    btrim(p_reason), NULLIF(btrim(COALESCE(p_evidence_ref, '')), ''), CASE WHEN p_reverses IS NULL THEN COALESCE(p_finding_ids, '{}') ELSE '{}' END,
    encode(sha256(convert_to(v_lines::text, 'UTF8')), 'hex'), v_dr, v_uid, v_member, p_request_id)
  RETURNING id INTO v_id;
  INSERT INTO public.close_review_adjustment_lines (adjustment_id, line_no, account_key, account_code, account_name, classification, debit_minor, credit_minor, memo)
  SELECT v_id, l.ord::integer, l.v->>'accountKey', m.account_code, m.account_name, m.classification::text,
         (l.v->>'debitMinor')::numeric, (l.v->>'creditMinor')::numeric, NULLIF(l.v->>'memo', '')
    FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS l(v, ord)
    JOIN public.account_mappings m ON m.company_id = p_company_id AND m.account_key = l.v->>'accountKey';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> jsonb_array_length(v_lines) THEN RAISE EXCEPTION 'ADJUSTMENT_LINES_INCOMPLETE' USING ERRCODE = 'P0001'; END IF;
  PERFORM public._close_review_append(p_company_id, 'adjustment', v_id::text, 'adjustment_proposed', NULL, NULL,
    jsonb_build_object('number', v_number, 'kind', CASE WHEN p_reverses IS NULL THEN 'adjustment' ELSE 'reversal' END, 'reverses', p_reverses,
                       'totalMinor', v_dr::text, 'certificationId', v_cert), v_uid, v_member, NULL);
  RETURN jsonb_build_object('outcome', 'proposed', 'adjustmentId', v_id, 'number', v_number, 'replay', false);
END;
$$;

-- ── Decide ───────────────────────────────────────────────────────────────────────────────────────────────────────────
-- p_decision: approve | reject | withdraw. Outcomes: recorded (also a replay) | forbidden | feature_disabled | not_found |
-- already_decided | stale_authority | self_approval_not_allowed | acknowledgement_required | invalid_request | request_reused.
CREATE OR REPLACE FUNCTION public.close_review_decide_adjustment(p_adjustment_id uuid, p_decision text, p_reason text,
  p_acknowledge_self_approval boolean, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_a public.close_review_adjustments%ROWTYPE;
  v_prior public.close_review_events%ROWTYPE;
  v_policy record;
  v_cert uuid;
  v_event text;
  v_self boolean := false;
  v_member uuid;
  v_id uuid;
  v_f uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_adjustment_id IS NULL OR p_request_id IS NULL OR p_decision NOT IN ('approve', 'reject', 'withdraw') THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF p_decision = 'approve' THEN v_event := 'adjustment_approved';
  ELSIF p_decision = 'reject' THEN v_event := 'adjustment_rejected';
  ELSE v_event := 'adjustment_withdrawn'; END IF;
  SELECT * INTO v_prior FROM public.close_review_events e WHERE e.actor_user_id = v_uid AND e.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.subject_kind = 'adjustment' AND v_prior.subject_id = p_adjustment_id::text AND v_prior.event_type = v_event THEN
      RETURN jsonb_build_object('outcome', 'recorded', 'eventId', v_prior.id, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT * INTO v_a FROM public.close_review_adjustments a WHERE a.id = p_adjustment_id;
  IF v_a.id IS NULL OR NOT public.can_access_workspace(v_a.company_id) THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF NOT public.fs_rollout_allows(v_a.company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 2000 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  -- One decision per adjustment, serialized.
  PERFORM pg_advisory_xact_lock(hashtextextended('close_review_adjustment:' || v_a.id::text, 0));
  IF public._cr_adjustment_status(v_a.id) <> 'proposed' THEN RETURN jsonb_build_object('outcome', 'already_decided'); END IF;

  IF p_decision = 'withdraw' THEN
    IF v_a.proposer_user_id <> v_uid THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  ELSE
    SELECT c.id INTO v_cert FROM public.get_authoritative_certification(v_a.company_id, v_a.period_year) c;
    IF v_cert IS DISTINCT FROM v_a.certification_id THEN RETURN jsonb_build_object('outcome', 'stale_authority'); END IF;
    IF v_a.proposer_user_id <> v_uid THEN
      IF NOT public.workspace_capability_allowed(v_a.company_id, v_uid, 'review_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
    ELSIF p_decision = 'reject' THEN
      RETURN jsonb_build_object('outcome', 'forbidden');   -- the proposer withdraws; rejecting is someone else's decision
    ELSE
      SELECT * INTO v_policy FROM public._cr_approval_policy(v_a.company_id);
      IF NOT v_policy.self_approval_available OR NOT public.workspace_capability_allowed(v_a.company_id, v_uid, 'approve_certification') THEN
        RETURN jsonb_build_object('outcome', 'self_approval_not_allowed', 'policy', v_policy.policy, 'approvers', v_policy.approver_count);
      END IF;
      IF p_acknowledge_self_approval IS NOT TRUE THEN RETURN jsonb_build_object('outcome', 'acknowledgement_required'); END IF;
      v_self := true;
    END IF;
  END IF;

  v_member := public._cr_member(v_a.company_id, v_uid);
  v_id := public._close_review_append(v_a.company_id, 'adjustment', v_a.id::text, v_event, btrim(p_reason), NULL,
    jsonb_build_object('selfApproved', v_self, 'policy', CASE WHEN v_self THEN 'owner_self_approval' WHEN p_decision = 'approve' THEN 'two_person' ELSE NULL END,
                       'disclosureAcknowledged', v_self),
    v_uid, v_member, p_request_id);
  IF p_decision = 'approve' THEN
    FOREACH v_f IN ARRAY v_a.finding_ids LOOP
      PERFORM public._close_review_append(v_a.company_id, 'finding', v_f::text, 'finding_adjusted', 'Resolved by adjustment ' || v_a.number, NULL,
        jsonb_build_object('adjustmentId', v_a.id, 'number', v_a.number), v_uid, v_member, NULL);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('outcome', 'recorded', 'eventId', v_id, 'status', public._cr_adjustment_status(v_a.id), 'selfApproved', v_self, 'replay', false);
END;
$$;

-- ── The adjusted trial balance (a layer; nothing underneath changes) ─────────────────────────────────────────────────
-- Per account: the authoritative certified amounts, the approved adjustments bound to that authority, and the adjusted
-- result, in exact minor units. Empty when there is no authority or the caller cannot read the workspace.
CREATE OR REPLACE FUNCTION public.close_review_adjusted_trial_balance(p_company_id uuid, p_period_year integer)
RETURNS TABLE (account_key text, account_code text, account_name text, classification text,
               certified_debit_minor numeric, certified_credit_minor numeric, adjustment_debit_minor numeric, adjustment_credit_minor numeric,
               adjusted_debit_minor numeric, adjusted_credit_minor numeric, certification_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cert uuid;
BEGIN
  IF NOT public.close_review_readable(p_company_id) THEN RETURN; END IF;
  SELECT c.id INTO v_cert FROM public.get_authoritative_certification(p_company_id, p_period_year) c;
  IF v_cert IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH cert AS (
    SELECT a.account_key, a.account_code, a.account_name, a.classification, a.debit_minor, a.credit_minor FROM public._cr_certified_accounts(v_cert) a
  ), adj AS (
    SELECT l.account_key, min(l.account_code) AS account_code, min(l.account_name) AS account_name, min(l.classification) AS classification,
           sum(l.debit_minor) AS d, sum(l.credit_minor) AS c
      FROM public.close_review_adjustments x JOIN public.close_review_adjustment_lines l ON l.adjustment_id = x.id
     WHERE x.company_id = p_company_id AND x.period_year = p_period_year AND x.certification_id = v_cert
       AND public._cr_adjustment_status(x.id) = 'approved'
     GROUP BY l.account_key
  )
  SELECT COALESCE(cert.account_key, adj.account_key), COALESCE(cert.account_code, adj.account_code), COALESCE(cert.account_name, adj.account_name),
         COALESCE(cert.classification, adj.classification),
         COALESCE(cert.debit_minor, 0), COALESCE(cert.credit_minor, 0), COALESCE(adj.d, 0), COALESCE(adj.c, 0),
         COALESCE(cert.debit_minor, 0) + COALESCE(adj.d, 0), COALESCE(cert.credit_minor, 0) + COALESCE(adj.c, 0), v_cert
    FROM cert FULL OUTER JOIN adj ON adj.account_key = cert.account_key
   ORDER BY 1;
END;
$$;

-- What the page needs about the period's adjustments (status, binding to the current authority, self-approval).
CREATE OR REPLACE FUNCTION public.close_review_adjustments_summary(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cert uuid;
  v_policy record;
  v_currency text;
  v_exponent integer;
BEGIN
  IF NOT public.close_review_readable(p_company_id) THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  SELECT c.id INTO v_cert FROM public.get_authoritative_certification(p_company_id, p_period_year) c;
  SELECT * INTO v_policy FROM public._cr_approval_policy(p_company_id);
  SELECT p.reporting_currency, cr.exponent INTO v_currency, v_exponent
    FROM public.tb_certifications c JOIN public.trial_balance_uploads t ON t.id = c.upload_id
    JOIN public.fiscal_periods p ON p.id = t.period_id AND p.company_id = p_company_id
    JOIN public.currency_registry cr ON cr.code = p.reporting_currency
   WHERE c.id = v_cert;
  RETURN jsonb_build_object('state', CASE WHEN v_cert IS NULL THEN 'no_authority' ELSE 'current' END, 'certificationId', v_cert,
    'currency', v_currency, 'exponent', v_exponent,
    'policy', v_policy.policy, 'selfApprovalAvailable', v_policy.self_approval_available, 'approvers', v_policy.approver_count,
    'adjustments', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'number', a.number, 'kind', a.kind, 'reverses', a.reverses_id,
        'status', public._cr_adjustment_status(a.id), 'current', COALESCE(a.certification_id = v_cert, false), 'totalMinor', a.total_minor::text,
        'proposer', a.proposer_user_id, 'reason', a.reason, 'evidenceRef', a.evidence_ref, 'findingIds', to_jsonb(a.finding_ids),
        'selfApproved', COALESCE((SELECT (e.detail->>'selfApproved')::boolean FROM public.close_review_events e
                                   WHERE e.subject_kind = 'adjustment' AND e.subject_id = a.id::text AND e.event_type = 'adjustment_approved' LIMIT 1), false),
        'reversedBy', (SELECT r.id FROM public.close_review_adjustments r WHERE r.reverses_id = a.id AND public._cr_adjustment_status(r.id) = 'approved' LIMIT 1),
        'lines', (SELECT jsonb_agg(jsonb_build_object('lineNo', l.line_no, 'accountKey', l.account_key, 'accountCode', l.account_code, 'accountName', l.account_name,
                   'classification', l.classification, 'debitMinor', l.debit_minor::text, 'creditMinor', l.credit_minor::text, 'memo', l.memo) ORDER BY l.line_no)
                    FROM public.close_review_adjustment_lines l WHERE l.adjustment_id = a.id)) ORDER BY a.number)
      FROM public.close_review_adjustments a WHERE a.company_id = p_company_id AND a.period_year = p_period_year), '[]'::jsonb));
END;
$$;

ALTER TABLE public.close_review_approval_policy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.close_review_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.close_review_adjustment_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.close_review_approval_policy_events, public.close_review_adjustments, public.close_review_adjustment_lines
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.close_review_approval_policy_events, public.close_review_adjustments, public.close_review_adjustment_lines TO authenticated, service_role;
CREATE POLICY crape_read ON public.close_review_approval_policy_events FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY cra_read ON public.close_review_adjustments FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY cral_read ON public.close_review_adjustment_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.close_review_adjustments a WHERE a.id = adjustment_id AND public.close_review_readable(a.company_id)));

REVOKE ALL ON FUNCTION public._cr_approval_policy(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._cr_adjustment_status(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.close_review_set_approval_policy(uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_review_set_approval_policy(uuid, text, boolean, text) TO authenticated;
REVOKE ALL ON FUNCTION public.close_review_propose_adjustment(uuid, integer, text, text, jsonb, uuid[], uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_review_propose_adjustment(uuid, integer, text, text, jsonb, uuid[], uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.close_review_decide_adjustment(uuid, text, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_review_decide_adjustment(uuid, text, text, boolean, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.close_review_adjusted_trial_balance(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_review_adjusted_trial_balance(uuid, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.close_review_adjustments_summary(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_review_adjustments_summary(uuid, integer) TO authenticated;
