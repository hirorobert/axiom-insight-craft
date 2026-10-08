-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Close Review I2 — findings (roadmap increment 9): tb-anomaly-catalogue/1, deterministic, on the AUTHORITATIVE
-- trial balance only, in exact minor units.
--
--   close_review_finding_runs  one per (authoritative certification, authoritative prior-year certification or none,
--                              catalogue version). Generating again for the same authority is a replay; a new authority
--                              (a re-check, a new mapping, a replaced file) is a new run. Each run records, per rule,
--                              whether it was evaluated or NOT EVALUATED and why — a rule is never silently skipped.
--   close_review_findings      the findings of a run (append-only): rule, severity, whether the finding is mandatory
--                              (no accept / not-applicable path), the resolution it needs (explanation, evidence or a
--                              review/adjustment), the account and its exact amounts.
--   Lifecycle                  open → explained | accepted | not_applicable | adjusted (I3) | reopened, as events on the
--                              shared append-only timeline (close_review_events, subject 'finding').
--
-- Rules evaluated now (no threshold or unknown fact needed):
--   A01 abnormal sign — a balance on the side opposite to its class (assets/expenses in credit; liabilities/equity/income
--       in debit), except a closing-stock credit whose treatment a reviewer confirmed (H1b). warning · explanation.
--   A03 negative cash — an account designated cash (is_cash_account = true) in credit while mapped as an asset, i.e. not
--       mapped as an overdraft. blocking · mandatory · review (reclassify, or adjust).
--   A10 machine classification — an account certified on a machine suggestion (evidence tier 4–5). warning · explanation.
--   T01 income-tax workpaper — tax accounts with a balance need a preparer-supplied computation workpaper (revision 5
--       §1.5): blocking · mandatory · evidence. No tax engine is called, read or awaited.
-- Not evaluated in this catalogue version, with the recorded reason: A07 (cannot reach a certified trial balance: names
-- are unique per workspace in the classification authority and duplicates are refused at intake), A02 (no authoritative suspense/clearing designation
-- exists), A04 (needs the pack's trial-balance basis — before or after closing entries — and an authoritative prior year),
-- A05, A06 and A08 (need the framework pack's thresholds, I4), A09 (needs the pack's statutory liability classes, I4).
--
-- Who: generating and explaining (with evidence) need prepare_close; accepting, marking not applicable and reopening need
-- review_close; all exercised now (current plan). Behind the financial-statements rollout (allow-list + kill switch).
-- A legacy certification (before exact row amounts, tb-row/1) is refused: re-check the trial balance first.
--
-- PREFLIGHT: the objects do not exist yet; the migration refuses if they do.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regclass('public.close_review_finding_runs') IS NOT NULL OR to_regclass('public.close_review_findings') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: close review findings already exist; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

CREATE TABLE public.close_review_finding_runs (
  id                       UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id               UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year              INTEGER     NOT NULL,
  upload_id                UUID        NOT NULL,
  certification_id         UUID        NOT NULL REFERENCES public.tb_certifications (id) ON DELETE RESTRICT,
  prior_certification_id   UUID        NULL REFERENCES public.tb_certifications (id) ON DELETE RESTRICT,
  catalogue_version        TEXT        NOT NULL CHECK (catalogue_version = 'tb-anomaly-catalogue/1'),
  currency                 TEXT        NOT NULL,
  exponent                 INTEGER     NOT NULL CHECK (exponent BETWEEN 0 AND 4),
  rule_status              JSONB       NOT NULL,
  generated_by             UUID        NOT NULL,
  firm_member_id           UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX uq_crfr_authority ON public.close_review_finding_runs
  (certification_id, COALESCE(prior_certification_id, '00000000-0000-0000-0000-000000000000'::uuid), catalogue_version);
CREATE INDEX idx_crfr_company ON public.close_review_finding_runs (company_id, period_year, created_at DESC);

CREATE TABLE public.close_review_findings (
  id                   UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id               UUID        NOT NULL REFERENCES public.close_review_finding_runs (id) ON DELETE RESTRICT,
  company_id           UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  rule_id              TEXT        NOT NULL CHECK (rule_id IN ('A01', 'A03', 'A10', 'T01')),
  rule_version         INTEGER     NOT NULL CHECK (rule_version = 1),
  finding_key          TEXT        NOT NULL,
  severity             TEXT        NOT NULL CHECK (severity IN ('blocking', 'warning')),
  mandatory            BOOLEAN     NOT NULL,
  required_resolution  TEXT        NOT NULL CHECK (required_resolution IN ('explanation', 'evidence', 'review')),
  account_key          TEXT        NULL,
  account_code         TEXT        NULL,
  account_name         TEXT        NULL,
  classification       TEXT        NULL,
  debit_minor          NUMERIC     NULL,
  credit_minor         NUMERIC     NULL,
  class_side_minor     NUMERIC     NULL,
  detail               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_crf_key UNIQUE (run_id, finding_key),
  CONSTRAINT chk_crf_mandatory_blocking CHECK (NOT mandatory OR severity = 'blocking')
);
CREATE INDEX idx_crf_run ON public.close_review_findings (run_id, severity, rule_id);

CREATE TRIGGER trg_crfr_append_only BEFORE UPDATE OR DELETE ON public.close_review_finding_runs FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_crfr_no_truncate BEFORE TRUNCATE ON public.close_review_finding_runs FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_crf_append_only BEFORE UPDATE OR DELETE ON public.close_review_findings FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_crf_no_truncate BEFORE TRUNCATE ON public.close_review_findings FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();

-- The account name normalization of process-trial-balance (CANONICAL NORMALIZE v1).
CREATE OR REPLACE FUNCTION public._cr_normalize_name(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT lower(btrim(regexp_replace(regexp_replace(COALESCE(p_name, ''), '[[:punct:]]', '', 'g'), '\s+', ' ', 'g')));
$$;

-- The certified accounts of one certification, aggregated over dimension rows, in exact minor units. NULL rows when the
-- certification predates exact amounts (tb-row/1).
CREATE OR REPLACE FUNCTION public._cr_certified_accounts(p_certification_id uuid)
RETURNS TABLE (account_key text, account_code text, account_name text, classification text,
               debit_minor numeric, credit_minor numeric, class_side_minor numeric, max_tier integer, exact boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH r AS (
    SELECT e AS row FROM public.tb_certifications c, jsonb_array_elements(c.rows_snapshot) e WHERE c.id = p_certification_id
  )
  SELECT COALESCE(NULLIF(row->>'accountCode', ''), public._cr_normalize_name(row->>'accountName')) AS account_key,
         min(NULLIF(row->>'accountCode', '')), min(row->>'accountName'), min(row->>'subNature'),
         sum((row->>'debitMinor')::numeric), sum((row->>'creditMinor')::numeric), sum((row->>'classSideMinor')::numeric),
         max((row->>'evidenceTier')::integer),
         bool_and(row->>'rowContract' = 'tb-row/1' AND row->>'debitMinor' ~ '^(0|-?[1-9][0-9]*)$'
                  AND row->>'creditMinor' ~ '^(0|-?[1-9][0-9]*)$' AND row->>'classSideMinor' ~ '^(0|-?[1-9][0-9]*)$')
    FROM r
   GROUP BY 1;
$$;

CREATE OR REPLACE FUNCTION public._cr_member(p_company_id uuid, p_user uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT fm.id FROM public.firm_members fm
   WHERE fm.company_id = p_company_id AND fm.user_id = p_user AND fm.accepted_at IS NOT NULL AND fm.invitation_cancelled_at IS NULL
   ORDER BY fm.created_at LIMIT 1;
$$;

-- Generate (or replay) the findings of the CURRENT authority. Outcomes: generated | unchanged | forbidden |
-- feature_disabled | no_authority | legacy_certification | currency_unknown | invalid_request.
CREATE OR REPLACE FUNCTION public.close_review_refresh_findings(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cert public.tb_certifications%ROWTYPE;
  v_prior public.tb_certifications%ROWTYPE;
  v_upload public.trial_balance_uploads%ROWTYPE;
  v_run public.close_review_finding_runs%ROWTYPE;
  v_currency text;
  v_exponent integer;
  v_treated text[];
  v_status jsonb;
  v_member uuid;
  v_n integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('close_review_findings:' || p_company_id::text || ':' || p_period_year::text, 0));

  SELECT * INTO v_cert FROM public.get_authoritative_certification(p_company_id, p_period_year);
  IF v_cert.id IS NULL THEN RETURN jsonb_build_object('outcome', 'no_authority'); END IF;
  SELECT * INTO v_prior FROM public.get_authoritative_certification(p_company_id, p_period_year - 1);
  SELECT * INTO v_run FROM public.close_review_finding_runs r
   WHERE r.certification_id = v_cert.id AND r.prior_certification_id IS NOT DISTINCT FROM v_prior.id AND r.catalogue_version = 'tb-anomaly-catalogue/1';
  IF v_run.id IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'unchanged', 'runId', v_run.id); END IF;

  IF EXISTS (SELECT 1 FROM public._cr_certified_accounts(v_cert.id) a WHERE NOT a.exact) THEN
    RETURN jsonb_build_object('outcome', 'legacy_certification');
  END IF;
  SELECT * INTO v_upload FROM public.trial_balance_uploads t WHERE t.id = v_cert.upload_id;
  SELECT p.reporting_currency INTO v_currency FROM public.fiscal_periods p WHERE p.id = v_upload.period_id AND p.company_id = p_company_id;
  SELECT cr.exponent INTO v_exponent FROM public.currency_registry cr WHERE cr.code = v_currency;
  IF v_currency IS NULL OR v_exponent IS NULL THEN RETURN jsonb_build_object('outcome', 'currency_unknown'); END IF;

  -- Closing-stock credits a reviewer confirmed as kept (H1b): their account keys.
  SELECT COALESCE(array_agg(DISTINCT req->>'account_key'), '{}') INTO v_treated
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_upload.processing_result->'treatment_requests') = 'array'
                                   THEN v_upload.processing_result->'treatment_requests' ELSE '[]'::jsonb END) req
   WHERE req->>'request_id' IN (SELECT t.request_id FROM public.get_confirmed_treatments(p_company_id,
           ARRAY(SELECT x->>'request_id' FROM jsonb_array_elements(v_upload.processing_result->'treatment_requests') x)) t);

  v_status := jsonb_build_object(
    'A01', jsonb_build_object('evaluated', true),
    'A02', jsonb_build_object('evaluated', false, 'reason', 'No authoritative suspense or clearing designation exists for accounts.'),
    'A03', jsonb_build_object('evaluated', true),
    'A04', jsonb_build_object('evaluated', false, 'reason', CASE WHEN v_prior.id IS NULL
      THEN 'No authoritative prior-year trial balance.'
      ELSE 'Needs the framework pack''s trial-balance basis (before or after closing entries).' END),
    'A05', jsonb_build_object('evaluated', false, 'reason', 'Needs the framework pack''s materiality threshold.'),
    'A06', jsonb_build_object('evaluated', false, 'reason', 'Needs the framework pack''s variance threshold.'),
    'A07', jsonb_build_object('evaluated', false, 'reason', 'Cannot occur on a certified trial balance: account names are unique per workspace in the classification authority, and duplicate names are refused at intake.'),
    'A08', jsonb_build_object('evaluated', false, 'reason', 'Needs the framework pack''s round-amount threshold.'),
    'A09', jsonb_build_object('evaluated', false, 'reason', 'Needs the framework pack''s statutory liability classes.'),
    'A10', jsonb_build_object('evaluated', true),
    'T01', jsonb_build_object('evaluated', true));

  v_member := public._cr_member(p_company_id, v_uid);
  INSERT INTO public.close_review_finding_runs (company_id, period_year, upload_id, certification_id, prior_certification_id,
    catalogue_version, currency, exponent, rule_status, generated_by, firm_member_id)
  VALUES (p_company_id, p_period_year, v_cert.upload_id, v_cert.id, v_prior.id, 'tb-anomaly-catalogue/1', v_currency, v_exponent, v_status, v_uid, v_member)
  RETURNING * INTO v_run;

  INSERT INTO public.close_review_findings (run_id, company_id, rule_id, rule_version, finding_key, severity, mandatory, required_resolution,
    account_key, account_code, account_name, classification, debit_minor, credit_minor, class_side_minor, detail)
  -- A01 abnormal sign
  SELECT v_run.id, p_company_id, 'A01', 1, 'A01:' || a.account_key, 'warning', false, 'explanation',
         a.account_key, a.account_code, a.account_name, a.classification, a.debit_minor, a.credit_minor, a.class_side_minor, '{}'::jsonb
    FROM public._cr_certified_accounts(v_cert.id) a
   WHERE a.class_side_minor < 0 AND NOT (a.account_key = ANY (v_treated))
  UNION ALL
  -- A03 negative cash (designated cash, mapped as an asset, in credit)
  SELECT v_run.id, p_company_id, 'A03', 1, 'A03:' || a.account_key, 'blocking', true, 'review',
         a.account_key, a.account_code, a.account_name, a.classification, a.debit_minor, a.credit_minor, a.class_side_minor, '{}'::jsonb
    FROM public._cr_certified_accounts(v_cert.id) a
    JOIN public.account_mappings m ON m.company_id = p_company_id AND m.account_key = a.account_key
   WHERE m.is_cash_account IS TRUE AND a.classification IN ('current_assets', 'non_current_assets') AND a.debit_minor < a.credit_minor
  UNION ALL
  -- A10 machine classification
  SELECT v_run.id, p_company_id, 'A10', 1, 'A10:' || a.account_key, 'warning', false, 'explanation',
         a.account_key, a.account_code, a.account_name, a.classification, a.debit_minor, a.credit_minor, a.class_side_minor,
         jsonb_build_object('evidenceTier', a.max_tier)
    FROM public._cr_certified_accounts(v_cert.id) a
   WHERE a.max_tier >= 4
  UNION ALL
  -- T01 income-tax computation workpaper (one per period, listing the tax accounts with a balance)
  SELECT v_run.id, p_company_id, 'T01', 1, 'T01', 'blocking', true, 'evidence', NULL, NULL, NULL, 'taxes', NULL, NULL, NULL,
         jsonb_build_object('accounts', jsonb_agg(jsonb_build_object('accountKey', a.account_key, 'accountName', a.account_name,
           'debitMinor', a.debit_minor::text, 'creditMinor', a.credit_minor::text) ORDER BY a.account_key))
    FROM public._cr_certified_accounts(v_cert.id) a
   WHERE a.classification = 'taxes' AND a.debit_minor <> a.credit_minor
  HAVING count(*) > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM public._close_review_append(p_company_id, 'upload', v_cert.upload_id::text, 'findings_generated', NULL, NULL,
    jsonb_build_object('runId', v_run.id, 'certificationId', v_cert.id, 'priorCertificationId', v_prior.id, 'findings', v_n,
                       'catalogue', 'tb-anomaly-catalogue/1'), v_uid, v_member, NULL);
  RETURN jsonb_build_object('outcome', 'generated', 'runId', v_run.id, 'findings', v_n);
END;
$$;

-- The current status of one finding: its latest lifecycle event (open when none).
CREATE OR REPLACE FUNCTION public.close_review_finding_status(p_finding_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT CASE e.event_type WHEN 'finding_explained' THEN 'explained' WHEN 'finding_accepted' THEN 'accepted'
                            WHEN 'finding_not_applicable' THEN 'not_applicable' WHEN 'finding_adjusted' THEN 'adjusted' ELSE 'open' END
                     FROM public.close_review_events e
                    WHERE e.subject_kind = 'finding' AND e.subject_id = p_finding_id::text
                      AND e.event_type IN ('finding_explained', 'finding_accepted', 'finding_not_applicable', 'finding_adjusted', 'finding_reopened')
                    ORDER BY e.seq DESC LIMIT 1), 'open');
$$;

-- Is a finding resolved for publication? Blocking findings resolve only by their required resolution.
CREATE OR REPLACE FUNCTION public.close_review_finding_resolved(p_finding_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN f.severity = 'warning' THEN public.close_review_finding_status(f.id) IN ('explained', 'accepted', 'not_applicable', 'adjusted')
    WHEN f.required_resolution = 'explanation' THEN public.close_review_finding_status(f.id) IN ('explained', 'adjusted')
    WHEN f.required_resolution = 'evidence' THEN public.close_review_finding_status(f.id) = 'explained'
         AND (SELECT e.detail ? 'evidenceRef' FROM public.close_review_events e
               WHERE e.subject_kind = 'finding' AND e.subject_id = f.id::text AND e.event_type = 'finding_explained'
               ORDER BY e.seq DESC LIMIT 1)
    ELSE public.close_review_finding_status(f.id) = 'adjusted'
  END
  FROM public.close_review_findings f WHERE f.id = p_finding_id;
$$;

-- A lifecycle action on a finding of the CURRENT authority. Outcomes: recorded (also a replay) | forbidden |
-- feature_disabled | not_found | stale_authority | mandatory_finding | evidence_required | invalid_request |
-- invalid_transition | request_reused.
CREATE OR REPLACE FUNCTION public.close_review_finding_action(p_finding_id uuid, p_action text, p_text text, p_evidence_ref text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_f public.close_review_findings%ROWTYPE;
  v_run public.close_review_finding_runs%ROWTYPE;
  v_cert uuid;
  v_prior_cert uuid;
  v_status text;
  v_prior public.close_review_events%ROWTYPE;
  v_cap text;
  v_event text;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_finding_id IS NULL OR p_request_id IS NULL OR p_action NOT IN ('explain', 'accept', 'not_applicable', 'reopen') THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  v_event := 'finding_' || (CASE p_action WHEN 'explain' THEN 'explained' WHEN 'accept' THEN 'accepted' WHEN 'reopen' THEN 'reopened' ELSE 'not_applicable' END);
  SELECT * INTO v_prior FROM public.close_review_events e WHERE e.actor_user_id = v_uid AND e.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.subject_kind = 'finding' AND v_prior.subject_id = p_finding_id::text AND v_prior.event_type = v_event THEN
      RETURN jsonb_build_object('outcome', 'recorded', 'eventId', v_prior.id, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT * INTO v_f FROM public.close_review_findings f WHERE f.id = p_finding_id;
  IF v_f.id IS NULL OR NOT public.can_access_workspace(v_f.company_id) THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF p_action = 'explain' THEN v_cap := 'prepare_close'; ELSE v_cap := 'review_close'; END IF;
  IF NOT public.workspace_capability_allowed(v_f.company_id, v_uid, v_cap) THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(v_f.company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  SELECT * INTO v_run FROM public.close_review_finding_runs r WHERE r.id = v_f.run_id;
  -- Serialized per finding; only a finding of the authority that is current NOW may change.
  PERFORM pg_advisory_xact_lock(hashtextextended('close_review_finding:' || v_f.id::text, 0));
  -- The finding's run must be the run of BOTH authorities as they are now (current year and prior year).
  SELECT c.id INTO v_cert FROM public.get_authoritative_certification(v_f.company_id, v_run.period_year) c;
  SELECT c.id INTO v_prior_cert FROM public.get_authoritative_certification(v_f.company_id, v_run.period_year - 1) c;
  IF v_cert IS DISTINCT FROM v_run.certification_id OR v_prior_cert IS DISTINCT FROM v_run.prior_certification_id THEN
    RETURN jsonb_build_object('outcome', 'stale_authority');
  END IF;
  v_status := public.close_review_finding_status(v_f.id);
  IF p_action IN ('accept', 'not_applicable') AND v_f.mandatory THEN RETURN jsonb_build_object('outcome', 'mandatory_finding'); END IF;
  IF p_action = 'reopen' AND v_status = 'open' THEN RETURN jsonb_build_object('outcome', 'invalid_transition'); END IF;
  IF p_action <> 'reopen' AND v_status <> 'open' THEN RETURN jsonb_build_object('outcome', 'invalid_transition'); END IF;
  IF p_text IS NULL OR length(btrim(p_text)) NOT BETWEEN 3 AND 4000 THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  IF p_action = 'explain' AND v_f.required_resolution = 'evidence'
     AND (p_evidence_ref IS NULL OR length(btrim(p_evidence_ref)) NOT BETWEEN 3 AND 300) THEN
    RETURN jsonb_build_object('outcome', 'evidence_required');
  END IF;
  v_id := public._close_review_append(v_f.company_id, 'finding', v_f.id::text, v_event, btrim(p_text), NULL,
    CASE WHEN p_evidence_ref IS NOT NULL AND length(btrim(p_evidence_ref)) BETWEEN 3 AND 300
         THEN jsonb_build_object('evidenceRef', btrim(p_evidence_ref)) ELSE '{}'::jsonb END,
    v_uid, public._cr_member(v_f.company_id, v_uid), p_request_id);
  RETURN jsonb_build_object('outcome', 'recorded', 'eventId', v_id, 'status', public.close_review_finding_status(v_f.id), 'replay', false);
END;
$$;

-- The findings state of a period, for the page and (I8) the publication blockers: the current authority's run (or why
-- there is none), the rule statuses, and counts. A run of an earlier authority is reported as stale, never as current.
CREATE OR REPLACE FUNCTION public.close_review_findings_summary(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cert uuid;
  v_prior uuid;
  v_run public.close_review_finding_runs%ROWTYPE;
BEGIN
  IF NOT public.close_review_readable(p_company_id) THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  SELECT c.id INTO v_cert FROM public.get_authoritative_certification(p_company_id, p_period_year) c;
  IF v_cert IS NULL THEN RETURN jsonb_build_object('state', 'no_authority'); END IF;
  SELECT c.id INTO v_prior FROM public.get_authoritative_certification(p_company_id, p_period_year - 1) c;
  SELECT * INTO v_run FROM public.close_review_finding_runs r
   WHERE r.certification_id = v_cert AND r.prior_certification_id IS NOT DISTINCT FROM v_prior AND r.catalogue_version = 'tb-anomaly-catalogue/1';
  IF v_run.id IS NULL THEN
    RETURN jsonb_build_object('state', CASE WHEN EXISTS (SELECT 1 FROM public.close_review_finding_runs r WHERE r.company_id = p_company_id AND r.period_year = p_period_year)
                                            THEN 'stale' ELSE 'not_generated' END);
  END IF;
  RETURN jsonb_build_object('state', 'current', 'runId', v_run.id, 'currency', v_run.currency, 'exponent', v_run.exponent,
    'ruleStatus', v_run.rule_status, 'generatedAt', v_run.created_at,
    'total', (SELECT count(*) FROM public.close_review_findings f WHERE f.run_id = v_run.id),
    'unresolvedBlocking', (SELECT count(*) FROM public.close_review_findings f WHERE f.run_id = v_run.id AND f.severity = 'blocking' AND NOT public.close_review_finding_resolved(f.id)),
    'unresolved', (SELECT count(*) FROM public.close_review_findings f WHERE f.run_id = v_run.id AND NOT public.close_review_finding_resolved(f.id)));
END;
$$;

ALTER TABLE public.close_review_finding_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.close_review_findings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.close_review_finding_runs, public.close_review_findings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.close_review_finding_runs, public.close_review_findings TO authenticated, service_role;
CREATE POLICY crfr_read ON public.close_review_finding_runs FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY crf_read ON public.close_review_findings FOR SELECT TO authenticated USING (public.close_review_readable(company_id));

REVOKE ALL ON FUNCTION public._cr_normalize_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._cr_certified_accounts(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._cr_member(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.close_review_refresh_findings(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_review_refresh_findings(uuid, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.close_review_finding_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_review_finding_status(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.close_review_finding_resolved(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_review_finding_resolved(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.close_review_finding_action(uuid, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_review_finding_action(uuid, text, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.close_review_findings_summary(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_review_findings_summary(uuid, integer) TO authenticated;
