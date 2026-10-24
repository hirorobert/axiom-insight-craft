-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261125100000 — One current FINAL per reporting scope: the financial-statements FINAL authority, explicit and concurrency-safe.
-- Forward-only; builds on 20261124100000 (the publication integrity gate). Resolves DEFECT-FS-PARALLEL-LINEAGE-FINAL-001.
--
--   THE SCOPE: a company's reporting period (company_id, period_year). Draft lineages (report_id) of one scope may coexist;
--   the scope has at most ONE current FINAL authority: fs_report_authority (one row per scope; FK to the exact FINAL
--   publication and version) with an append-only history fs_report_authority_events (ESTABLISHED, SUCCEEDED within the
--   lineage, REPLACED across lineages, DESIGNATED after a legacy conflict, CONFLICT_DETECTED at backfill).
--
--   THE RULES (all decided under ONE transaction-scoped advisory lock per scope, _fs_scope_lock, taken FIRST):
--     · no authority → the first FINAL of the scope establishes it;
--     · same lineage → a later FINAL version succeeds it (a correction is a new version of the same lineage - existing rule);
--     · another lineage → refused by name (AUTHORITY_CONFLICT, PT409) unless the FINAL is recorded as an EXPLICIT replacement
--       naming exactly the current authority (fs_replace_final_authority: approve_certification, the same review/approval
--       separation, bound to the exact replaced version; REPLACED event with both identities); the replaced FINAL's document,
--       bindings and sealed packs are immutable history, disclosed as superseded;
--     · more than one FINAL lineage with no designated authority (legacy data) → nothing is chosen: every FINAL, issue and seal of
--       the scope refuses AUTHORITY_CONFLICT_UNRESOLVED / authority_unresolved and the next period's comparative is blocked
--       (PRIOR_FINAL_AUTHORITY_UNRESOLVED) until a holder of approve_certification designates one existing FINAL version
--       (fs_designate_final_authority, DESIGNATED event). The backfill records such scopes as CONFLICT_DETECTED, never resolves them.
--   WHO READS IT: fs_set_publication_state v4 (FINAL), the binding trigger (claims and records), issue_official_reporting_pack v3
--   and _reporting_pack_seal_refusal v3 (is_authority or refused), seal_reporting_pack_server v2 (scope lock after the issuance
--   row lock), reporting_pack_sealed_object v3 (superseded + authority disclosed to verify/retrieve), _fs_prior_final_differences
--   v2 (the comparative's prior FINAL is the explicit authority), fs_list_saved_versions v3 and fs_report_readiness v2 (authority
--   relation for the pages). Without the pointer row a scope whose FINALs are all in ONE lineage has that lineage's latest FINAL as
--   its authority (the explicit succession rule; the backfill records it); the pointer is the record of every decision since.
--   LOCK ORDER (documented, shared): scope -> lineage -> version -> tb_official_output_lock (FINAL);
--   issuance row -> scope -> tb_official_output_lock (seal); scope only (issue). remove_trial_balance_upload takes
--   tb_official_output_lock and never the scope lock, so no order cycles.
--   WHAT STAYS: every existing table, column, policy and grant; every saved version, binding and sealed pack; two-person
--   approval and the solo-owner policy; reviewer-only clearing and withdrawal; rollout and kill switch.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regclass('public.fs_report_authority') IS NOT NULL OR to_regprocedure('public._fs_scope_lock(uuid, integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the FINAL authority is already applied; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public._fs_final_superseded_by(text, integer)') IS NULL
     OR position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR position('withdrawing a recorded review needs the review_close capability' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR to_regprocedure('public.tb_official_output_lock(uuid, integer)') IS NULL
     OR to_regprocedure('public.close_review_readable(uuid)') IS NULL
     OR to_regprocedure('public.fs_try_jsonb(text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'trg_fsp_bind' AND t.tgrelid = 'public.financial_statement_publications'::regclass) THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261124100000 (the publication integrity gate), 20260927100000 and 20261021100000 must be applied first; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. The authority record ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.fs_report_authority (
  company_id       UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year      INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  report_id        TEXT        NOT NULL,
  report_version   INTEGER     NOT NULL,
  publication_id   UUID        NOT NULL REFERENCES public.financial_statement_publications (id) ON DELETE RESTRICT,
  authority_seq    INTEGER     NOT NULL CHECK (authority_seq >= 1),
  established_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fs_report_authority_pk PRIMARY KEY (company_id, period_year),
  CONSTRAINT fk_fsra_version FOREIGN KEY (report_id, report_version) REFERENCES public.financial_statement_reports (report_id, report_version) ON DELETE RESTRICT
);
CREATE TABLE public.fs_report_authority_events (
  id                          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq                         BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id                  UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year                 INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  kind                        TEXT        NOT NULL CHECK (kind IN ('ESTABLISHED', 'SUCCEEDED', 'REPLACED', 'DESIGNATED', 'CONFLICT_DETECTED')),
  report_id                   TEXT        NULL,
  report_version              INTEGER     NULL,
  publication_id              UUID        NULL REFERENCES public.financial_statement_publications (id) ON DELETE RESTRICT,
  previous_report_id          TEXT        NULL,
  previous_report_version     INTEGER     NULL,
  previous_publication_id     UUID        NULL REFERENCES public.financial_statement_publications (id) ON DELETE RESTRICT,
  detail                      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  actor_firm_member_id        UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  actor_user_id               UUID        NULL,
  reason                      TEXT        NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_fsrae_scope ON public.fs_report_authority_events (company_id, period_year, seq);
CREATE TRIGGER trg_fsrae_append_only BEFORE UPDATE OR DELETE ON public.fs_report_authority_events FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fsrae_no_truncate BEFORE TRUNCATE ON public.fs_report_authority_events FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fsra_no_truncate BEFORE TRUNCATE ON public.fs_report_authority FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();
ALTER TABLE public.fs_report_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_report_authority_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY fsra_read ON public.fs_report_authority FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY fsrae_read ON public.fs_report_authority_events FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
REVOKE ALL ON public.fs_report_authority FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.fs_report_authority_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.fs_report_authority TO authenticated;
GRANT SELECT ON public.fs_report_authority_events TO authenticated;

-- ── 2. The scope lock and the authority reads ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._fs_scope_lock(p_company_id uuid, p_period_year integer)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.fs_report_authority:' || p_company_id::text || ':' || p_period_year::text, 0));
END;
$$;

-- The scope's current FINAL authority: the pointer when recorded; else the single FINAL lineage's latest FINAL version (the
-- succession rule); else none; more than one FINAL lineage without a pointer is 'unresolved' (candidates named, nothing chosen).
CREATE OR REPLACE FUNCTION public._fs_scope_authority(p_company_id uuid, p_period_year integer, p_exclude_publication uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_ptr public.fs_report_authority;
  v_lineages text[];
  v_rid text; v_ver integer; v_pub uuid;
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL THEN RETURN jsonb_build_object('state', 'none', 'holder', NULL); END IF;
  SELECT * INTO v_ptr FROM public.fs_report_authority a WHERE a.company_id = p_company_id AND a.period_year = p_period_year;
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'held', 'source', 'recorded', 'authoritySeq', v_ptr.authority_seq,
      'holder', jsonb_build_object('reportId', v_ptr.report_id, 'reportVersion', v_ptr.report_version, 'publicationId', v_ptr.publication_id));
  END IF;
  SELECT array_agg(DISTINCT p.report_id ORDER BY p.report_id) INTO v_lineages
    FROM public.financial_statement_publications p
    JOIN public.financial_statement_reports r ON r.report_id = p.report_id AND r.report_version = p.report_version
   WHERE p.company_id = p_company_id AND r.company_id = p_company_id AND r.period_year = p_period_year AND p.state = 'FINAL'
     AND (p_exclude_publication IS NULL OR p.id <> p_exclude_publication);
  IF v_lineages IS NULL THEN RETURN jsonb_build_object('state', 'none', 'holder', NULL); END IF;
  IF array_length(v_lineages, 1) > 1 THEN RETURN jsonb_build_object('state', 'unresolved', 'holder', NULL, 'candidates', to_jsonb(v_lineages)); END IF;
  SELECT p.report_id, p.report_version, p.id INTO v_rid, v_ver, v_pub
    FROM public.financial_statement_publications p
    JOIN public.financial_statement_reports r ON r.report_id = p.report_id AND r.report_version = p.report_version
   WHERE p.company_id = p_company_id AND r.company_id = p_company_id AND r.period_year = p_period_year AND p.state = 'FINAL' AND p.report_id = v_lineages[1]
     AND (p_exclude_publication IS NULL OR p.id <> p_exclude_publication)
   ORDER BY p.report_version DESC, p.seq ASC LIMIT 1;
  RETURN jsonb_build_object('state', 'held', 'source', 'single_lineage', 'holder', jsonb_build_object('reportId', v_rid, 'reportVersion', v_ver, 'publicationId', v_pub));
END;
$$;

-- One version's relation to its scope's authority: none | is_authority | same_lineage | other_lineage | unresolved.
CREATE OR REPLACE FUNCTION public._fs_authority_relation(p_report_id text, p_report_version integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_company uuid; v_period integer; v_scope jsonb; v_final boolean; v_rel text;
BEGIN
  SELECT r.company_id, r.period_year INTO v_company, v_period FROM public.financial_statement_reports r WHERE r.report_id = p_report_id AND r.report_version = p_report_version;
  IF NOT FOUND THEN RETURN jsonb_build_object('relation', 'none', 'isFinal', false, 'superseded', false, 'scope', NULL); END IF;
  v_scope := public._fs_scope_authority(v_company, v_period);
  v_final := EXISTS (SELECT 1 FROM public.financial_statement_publications p WHERE p.report_id = p_report_id AND p.report_version = p_report_version AND p.state = 'FINAL');
  v_rel := CASE WHEN v_scope ->> 'state' = 'unresolved' THEN 'unresolved'
                WHEN v_scope ->> 'state' = 'none' THEN 'none'
                WHEN (v_scope -> 'holder' ->> 'reportId') = p_report_id AND (v_scope -> 'holder' ->> 'reportVersion')::integer = p_report_version THEN 'is_authority'
                WHEN (v_scope -> 'holder' ->> 'reportId') = p_report_id THEN 'same_lineage'
                ELSE 'other_lineage' END;
  RETURN jsonb_build_object('relation', v_rel, 'isFinal', v_final, 'superseded', v_final AND v_rel IN ('same_lineage', 'other_lineage'), 'periodYear', v_period, 'scope', v_scope);
END;
$$;

-- v2: superseded = no longer the scope's authority (within the lineage or across lineages); the holder's version is named.
CREATE OR REPLACE FUNCTION public._fs_final_superseded_by(p_report_id TEXT, p_report_version INTEGER)
RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN (r ->> 'superseded')::boolean THEN (r -> 'scope' -> 'holder' ->> 'reportVersion')::integer END
    FROM public._fs_authority_relation(p_report_id, p_report_version) r;
$$;

-- ── 3. The claim: establish, succeed, replace (explicit) or refuse, under the scope lock, with its event ───────────────
CREATE OR REPLACE FUNCTION public._fs_claim_final_authority(p_company_id uuid, p_period_year integer, p_report_id text, p_report_version integer, p_publication_id uuid, p_actor_firm_member_id uuid, p_replace jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_auth jsonb; v_holder jsonb; v_kind text; v_seq integer;
BEGIN
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  -- The AFTER INSERT trigger claims for a FINAL row that already exists: the scope is read without it.
  v_auth := public._fs_scope_authority(p_company_id, p_period_year, p_publication_id);
  v_holder := v_auth -> 'holder';
  IF v_auth ->> 'state' = 'unresolved' THEN
    RAISE EXCEPTION 'AUTHORITY_CONFLICT_UNRESOLVED: FY% holds FINAL versions in more than one lineage (%) and no designated authority; designate one with fs_designate_final_authority before any further FINAL', p_period_year, v_auth ->> 'candidates' USING ERRCODE = 'PT409';
  END IF;
  IF v_auth ->> 'state' = 'none' THEN
    v_kind := 'ESTABLISHED';
  ELSIF (v_holder ->> 'reportId') = p_report_id THEN
    IF (v_holder ->> 'reportVersion')::integer >= p_report_version THEN
      RAISE EXCEPTION 'AUTHORITY_SUCCESSION: version % of % cannot succeed its lineage''s FINAL version %', p_report_version, p_report_id, v_holder ->> 'reportVersion' USING ERRCODE = 'PT409';
    END IF;
    v_kind := 'SUCCEEDED';
  ELSE
    IF p_replace IS NULL OR (p_replace ->> 'reportId') IS DISTINCT FROM (v_holder ->> 'reportId') OR (p_replace ->> 'reportVersion')::integer IS DISTINCT FROM (v_holder ->> 'reportVersion')::integer THEN
      RAISE EXCEPTION 'AUTHORITY_CONFLICT: % v% is the current FINAL of FY%; a FINAL in lineage % replaces it only as an explicit replacement naming that version (fs_replace_final_authority)', v_holder ->> 'reportId', v_holder ->> 'reportVersion', p_period_year, p_report_id USING ERRCODE = 'PT409';
    END IF;
    v_kind := 'REPLACED';
  END IF;
  INSERT INTO public.fs_report_authority (company_id, period_year, report_id, report_version, publication_id, authority_seq)
  VALUES (p_company_id, p_period_year, p_report_id, p_report_version, p_publication_id, 1)
  ON CONFLICT (company_id, period_year) DO UPDATE
     SET report_id = EXCLUDED.report_id, report_version = EXCLUDED.report_version, publication_id = EXCLUDED.publication_id,
         authority_seq = public.fs_report_authority.authority_seq + 1, established_at = clock_timestamp()
  RETURNING authority_seq INTO v_seq;
  INSERT INTO public.fs_report_authority_events (company_id, period_year, kind, report_id, report_version, publication_id, previous_report_id, previous_report_version, previous_publication_id, detail, actor_firm_member_id, actor_user_id)
  VALUES (p_company_id, p_period_year, v_kind, p_report_id, p_report_version, p_publication_id,
          v_holder ->> 'reportId', (v_holder ->> 'reportVersion')::integer, (v_holder ->> 'publicationId')::uuid,
          jsonb_build_object('authoritySeq', v_seq, 'previousSource', v_auth ->> 'source', 'explicitReplacement', p_replace IS NOT NULL), p_actor_firm_member_id, auth.uid());
END;
$$;

-- ── 4. The publication state v4 (the 20261124100000 text + the scope lock first and the authority decision) ───────────
CREATE OR REPLACE FUNCTION public.fs_set_publication_state(p_report_id text, p_report_version integer, p_company_id uuid, p_state text, p_reason text)
 RETURNS financial_statement_publications
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor   UUID;
  v_current public.financial_statement_publications;
  v_latest_version INTEGER;
  v_row     public.financial_statement_publications;
  v_blockers TEXT[];
  v_period  INTEGER;
  v_auth    JSONB;
  v_replace JSONB;
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);

  -- [20261125100000] The reporting scope's lock (company + period) is taken FIRST, before the lineage and version locks:
  -- every FINAL transition of the scope - any lineage - and every official-pack issue/seal serialise on it, so the
  -- "current FINAL of FY<period>" is decided at one point. The version row is immutable, so reading its period before the
  -- locks is safe; a missing row is refused here exactly as it was after the locks.
  SELECT r.period_year INTO v_period FROM public.financial_statement_reports r
   WHERE r.report_id = p_report_id AND r.report_version = p_report_version AND r.company_id = p_company_id;
  IF v_period IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no report % version % for this company', p_report_id, p_report_version USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._fs_scope_lock(p_company_id, v_period);

  -- 20261111100000: approvals and version commits of one lineage are serialised on the lineage lock fs_commit_revision
  -- and fs_save_report_version take; the per-version lock below keeps its own ordering of replays and conflicts.
  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reports:' || p_report_id));
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
  -- [20261124100000] Withdrawing a recorded review (REVIEWED back to DRAFT) is a reviewer's act and needs review_close;
  -- before, any member holding prepare_close could silently un-review a version.
  IF p_state = 'DRAFT' AND v_current.id IS NOT NULL AND v_current.state = 'REVIEWED' AND NOT public.workspace_capability_allowed(p_company_id, auth.uid(), 'review_close') THEN
    RAISE EXCEPTION 'FORBIDDEN: withdrawing a recorded review needs the review_close capability' USING ERRCODE = '42501';
  END IF;

  IF (p_state = 'REVIEWED' AND NOT public.workspace_capability_allowed(p_company_id, auth.uid(), 'review_close'))
     OR (p_state = 'FINAL' AND NOT public.workspace_capability_allowed(p_company_id, auth.uid(), 'approve_certification')) THEN
    RAISE EXCEPTION 'FORBIDDEN: REVIEWED needs the review_close capability and FINAL needs approve_certification' USING ERRCODE = '42501';
  END IF;

  IF p_state IN ('REVIEWED', 'FINAL') THEN
    IF NOT EXISTS (SELECT 1 FROM public.financial_statement_evaluations e WHERE e.report_id = p_report_id AND e.report_version = p_report_version) THEN
      RAISE EXCEPTION 'NOT_EVALUATED: this report version has no evaluation; validate it before marking it %', p_state USING ERRCODE = 'PT409';
    END IF;
    IF p_state = 'FINAL' THEN
      SELECT max(r.report_version) INTO v_latest_version FROM public.financial_statement_reports r WHERE r.report_id = p_report_id;
      IF v_latest_version <> p_report_version THEN
        RAISE EXCEPTION 'STALE_REPORT_VERSION: only the latest version can be FINAL' USING ERRCODE = 'PT409';
      END IF;
    END IF;
    v_blockers := public.fs_publication_blockers(p_company_id, p_report_id, p_report_version);
    IF coalesce(array_length(v_blockers, 1), 0) > 0 THEN
      RAISE EXCEPTION 'BLOCKED: % requirement(s) unmet, the report cannot be marked %: %', array_length(v_blockers, 1), p_state, array_to_string(v_blockers, '; ') USING ERRCODE = 'PT409';
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

  -- [20261125100000] One current FINAL per reporting scope. An explicit replacement of another lineage's FINAL is named by
  -- fs_replace_final_authority through a transaction-local setting (never by a request body); it must name EXACTLY the
  -- scope's current authority. Without it, a FINAL in a lineage that does not hold the authority is refused by name. The
  -- binding trigger (fs_bind_publication) re-checks and records the authority in the same transaction.
  IF p_state = 'FINAL' THEN
    v_auth := public._fs_scope_authority(p_company_id, v_period);
    v_replace := public.fs_try_jsonb(nullif(current_setting('cfoclose.fs_replace_authority', true), ''));
    IF v_auth ->> 'state' = 'unresolved' THEN
      RAISE EXCEPTION 'AUTHORITY_CONFLICT_UNRESOLVED: FY% holds FINAL versions in more than one lineage (%) and no designated authority; a holder of approve_certification designates one with fs_designate_final_authority before any further FINAL', v_period, v_auth ->> 'candidates' USING ERRCODE = 'PT409';
    END IF;
    IF v_replace IS NOT NULL THEN
      IF v_auth ->> 'state' IS DISTINCT FROM 'held' THEN
        RAISE EXCEPTION 'AUTHORITY_MISMATCH: FY% has no current FINAL to replace; finalise this version without a replacement target', v_period USING ERRCODE = 'PT409';
      END IF;
      IF (v_auth -> 'holder' ->> 'reportId') IS DISTINCT FROM (v_replace ->> 'reportId') OR (v_auth -> 'holder' ->> 'reportVersion')::integer IS DISTINCT FROM (v_replace ->> 'reportVersion')::integer THEN
        RAISE EXCEPTION 'AUTHORITY_MISMATCH: the replacement names % v% but the current FINAL of FY% is % v%; read the current authority and decide again', v_replace ->> 'reportId', v_replace ->> 'reportVersion', v_period, v_auth -> 'holder' ->> 'reportId', v_auth -> 'holder' ->> 'reportVersion' USING ERRCODE = 'PT409';
      END IF;
      IF (v_replace ->> 'reportId') = p_report_id THEN
        RAISE EXCEPTION 'AUTHORITY_REPLACE_SAME_LINEAGE: a later version of the same lineage succeeds its FINAL without a replacement target' USING ERRCODE = '22023';
      END IF;
    ELSIF v_auth ->> 'state' = 'held' AND (v_auth -> 'holder' ->> 'reportId') <> p_report_id THEN
      RAISE EXCEPTION 'AUTHORITY_CONFLICT: % v% is the current FINAL of FY%; version % of lineage % is another lineage - continue the current lineage, or finalise this one as an explicit replacement (fs_replace_final_authority, approve_certification) naming that FINAL', v_auth -> 'holder' ->> 'reportId', v_auth -> 'holder' ->> 'reportVersion', v_period, p_report_version, p_report_id USING ERRCODE = 'PT409';
    END IF;
  END IF;

  INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id)
       VALUES (p_report_id, p_report_version, p_company_id, p_state, p_reason, v_actor)
    RETURNING * INTO v_row;
  PERFORM public.fs_audit_event(p_company_id, p_report_id, 'PUBLICATION_STATE_SET', jsonb_build_object('reportVersion', p_report_version::text, 'state', p_state, 'reason', p_reason)
    || CASE WHEN p_state = 'FINAL' AND v_replace IS NOT NULL THEN jsonb_build_object('replacesFinal', v_replace) ELSE '{}'::jsonb END, v_actor);
  RETURN v_row;
END;
$function$;

-- ── 5. Explicit cross-lineage replacement and legacy designation ───────────────────────────────────────────────────────
-- A FINAL that REPLACES another lineage's current FINAL of the same scope: the same transition (capabilities, blockers,
-- review/approval separation, locks), with the replaced identity named explicitly and bound. Retry-safe: once FINAL, the
-- same call is the exact replay fs_set_publication_state answers.
CREATE OR REPLACE FUNCTION public.fs_replace_final_authority(p_company_id uuid, p_report_id text, p_report_version integer, p_replaces_report_id text, p_replaces_report_version integer, p_reason text)
RETURNS public.financial_statement_publications LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.financial_statement_publications;
BEGIN
  IF p_replaces_report_id IS NULL OR p_replaces_report_version IS NULL OR p_report_id IS NULL OR p_report_version IS NULL THEN
    RAISE EXCEPTION 'INVALID: a replacement names the replacing version and the exact FINAL it replaces' USING ERRCODE = '22023';
  END IF;
  IF p_replaces_report_id = p_report_id THEN
    RAISE EXCEPTION 'AUTHORITY_REPLACE_SAME_LINEAGE: a later version of the same lineage succeeds its FINAL without a replacement target' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('cfoclose.fs_replace_authority', jsonb_build_object('reportId', p_replaces_report_id, 'reportVersion', p_replaces_report_version)::text, true);
  v_row := public.fs_set_publication_state(p_report_id, p_report_version, p_company_id, 'FINAL', p_reason);
  PERFORM set_config('cfoclose.fs_replace_authority', '', true);
  RETURN v_row;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('cfoclose.fs_replace_authority', '', true);
  RAISE;
END;
$$;

-- A legacy scope with FINAL versions in more than one lineage and no recorded authority: a holder of approve_certification
-- designates ONE existing FINAL version as the authority (recorded, audited); nothing else is changed and nothing is chosen
-- by order. Replay-safe: designating the recorded holder again answers already_designated.
CREATE OR REPLACE FUNCTION public.fs_designate_final_authority(p_company_id uuid, p_period_year integer, p_report_id text, p_report_version integer, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_actor uuid; v_auth jsonb; v_pub uuid;
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);
  IF NOT public.workspace_capability_allowed(p_company_id, auth.uid(), 'approve_certification') THEN
    RAISE EXCEPTION 'FORBIDDEN: designating the FINAL authority needs the approve_certification capability' USING ERRCODE = '42501';
  END IF;
  IF p_period_year IS NULL OR p_report_id IS NULL OR p_report_version IS NULL OR length(btrim(coalesce(p_reason, ''))) < 8 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  v_auth := public._fs_scope_authority(p_company_id, p_period_year);
  IF v_auth ->> 'state' = 'held' AND (v_auth -> 'holder' ->> 'reportId') = p_report_id AND (v_auth -> 'holder' ->> 'reportVersion')::integer = p_report_version THEN
    RETURN jsonb_build_object('outcome', 'already_designated', 'authority', v_auth);
  END IF;
  IF v_auth ->> 'state' IS DISTINCT FROM 'unresolved' THEN
    RETURN jsonb_build_object('outcome', 'not_unresolved', 'authority', v_auth);
  END IF;
  SELECT p.id INTO v_pub FROM public.financial_statement_publications p
    JOIN public.financial_statement_reports r ON r.report_id = p.report_id AND r.report_version = p.report_version
   WHERE p.company_id = p_company_id AND r.company_id = p_company_id AND r.period_year = p_period_year AND p.report_id = p_report_id AND p.report_version = p_report_version AND p.state = 'FINAL'
   ORDER BY p.seq LIMIT 1;
  IF v_pub IS NULL THEN RETURN jsonb_build_object('outcome', 'not_final'); END IF;
  INSERT INTO public.fs_report_authority (company_id, period_year, report_id, report_version, publication_id, authority_seq)
  VALUES (p_company_id, p_period_year, p_report_id, p_report_version, v_pub, 1);
  INSERT INTO public.fs_report_authority_events (company_id, period_year, kind, report_id, report_version, publication_id, detail, actor_firm_member_id, actor_user_id, reason)
  VALUES (p_company_id, p_period_year, 'DESIGNATED', p_report_id, p_report_version, v_pub, jsonb_build_object('candidates', v_auth -> 'candidates'), v_actor, auth.uid(), btrim(p_reason));
  PERFORM public.fs_audit_event(p_company_id, p_report_id, 'PUBLICATION_STATE_SET',
    jsonb_build_object('reportVersion', p_report_version::text, 'state', 'FINAL', 'reason', btrim(p_reason), 'authorityDesignated', true, 'candidates', v_auth -> 'candidates'), v_actor);
  RETURN jsonb_build_object('outcome', 'designated', 'authority', public._fs_scope_authority(p_company_id, p_period_year));
END;
$$;

-- ── 6. The binding trigger v5: FINAL records the authority in the same transaction ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fs_bind_publication()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_report public.financial_statement_reports;
  v_deps jsonb;
  v_uid uuid := auth.uid();
  v_member public.firm_members;
  v_policy text;
  v_policy_event uuid;
  v_reviewer uuid;
  v_same boolean := NULL;
BEGIN
  IF NEW.state NOT IN ('REVIEWED', 'FINAL') THEN RETURN NEW; END IF;
  SELECT * INTO v_report FROM public.financial_statement_reports r WHERE r.report_id = NEW.report_id AND r.report_version = NEW.report_version;
  -- [20261111100000] Only an IFRS for SMEs report derived from the authoritative trial balance can be signed; every other
  -- framework or provenance is refused here too, so no publication written behind the canonical path can bypass it.
  IF v_report.provenance_origin IS DISTINCT FROM 'TRIAL_BALANCE_DERIVED' OR v_report.report_document #>> '{framework,kind}' IS DISTINCT FROM 'IFRS_FOR_SMES' THEN
    RAISE EXCEPTION 'PUBLICATION_PATH_UNSUPPORTED: only an IFRS for SMEs report derived from the authoritative trial balance can be reviewed or finalised (framework %, provenance %)',
      coalesce(v_report.report_document #>> '{framework,kind}', 'unknown'), coalesce(v_report.provenance_origin, 'unknown') USING ERRCODE = 'PT409';
  END IF;
  v_deps := public.fs_reporting_dependencies(NEW.company_id, v_report.period_year);
  IF v_deps ->> 'state' IS DISTINCT FROM 'current' OR v_report.report_document #>> '{reportingDependencies,dependenciesSha256}' IS DISTINCT FROM v_deps ->> 'dependenciesSha256' THEN
    RAISE EXCEPTION 'BINDING_STALE: the report is not bound to its current reporting dependencies; save a new version' USING ERRCODE = 'PT409';
  END IF;
  -- [20261111100000] The supported edition only (the 2015 edition's verified requirement texts).
  IF v_deps ->> 'packId' IS DISTINCT FROM 'ifrs-for-smes/2015' THEN
    RAISE EXCEPTION 'FRAMEWORK_EDITION_UNSUPPORTED: only a report under the IFRS for SMEs 2015 edition can be reviewed or finalised (this period resolves to %)', coalesce(v_deps ->> 'packId', 'unknown') USING ERRCODE = 'PT409';
  END IF;
  -- The approver is the AUTHENTICATED caller, and the publication's actor must be that caller's own membership of this
  -- company (20261022100000). A publication written without a session, or naming another member, is refused.
  SELECT * INTO v_member FROM public.firm_members m WHERE m.id = NEW.actor_firm_member_id;
  IF v_uid IS NULL OR NOT FOUND OR v_member.user_id IS DISTINCT FROM v_uid OR v_member.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'APPROVER_NOT_AUTHENTICATED: a sign-off is recorded only for the authenticated member who makes it' USING ERRCODE = '42501';
  END IF;
  -- [20261024100000] The statement sign-off policy in force. FINAL by the person who recorded REVIEWED is permitted only
  -- for the owner under the recorded solo_owner policy; otherwise two different people sign.
  SELECT s.policy, s.event_id INTO v_policy, v_policy_event FROM public._fs_signoff_policy(NEW.company_id) s;
  IF NEW.state = 'FINAL' THEN
    SELECT b.approver_user_id INTO v_reviewer FROM public.fs_publication_bindings b
     WHERE b.report_id = NEW.report_id AND b.report_version = NEW.report_version AND b.state = 'REVIEWED' ORDER BY b.approved_at DESC NULLS LAST LIMIT 1;
    IF v_reviewer IS NULL THEN
      RAISE EXCEPTION 'SIGNOFF_REVIEWER_UNKNOWN: the reviewer of this version is not recorded; save a new version and sign it again' USING ERRCODE = '42501';
    END IF;
    v_same := v_reviewer = v_uid;
    IF v_same AND NOT (v_policy = 'solo_owner' AND v_member.role = 'owner') THEN
      RAISE EXCEPTION 'SIGNOFF_SEPARATE_APPROVERS_REQUIRED: the final approval must be recorded by someone other than the reviewer (the company''s sign-off policy is %)', v_policy
        USING ERRCODE = '42501';
    END IF;
  END IF;
  INSERT INTO public.fs_publication_bindings (publication_id, company_id, report_id, report_version, state, document_sha256, declared_content_hash, dependencies_sha256, dependencies,
                                              approver_user_id, approver_firm_member_id, approver_role, approver_display_name, approved_at,
                                              signoff_policy, signoff_policy_event_id, same_approver)
  VALUES (NEW.id, NEW.company_id, NEW.report_id, NEW.report_version, NEW.state, encode(sha256(convert_to(v_report.report_document::text, 'UTF8')), 'hex'),
          v_report.content_hash, v_deps ->> 'dependenciesSha256', v_deps,
          v_uid, v_member.id, v_member.role,
          -- The name on record at the moment of approval (NULL when none is recorded; never invented).
          (SELECT nullif(btrim(pr.display_name), '') FROM public.profiles pr WHERE pr.user_id = v_uid),
          NEW.created_at,
          v_policy, v_policy_event, v_same);
  -- [20261125100000] A FINAL publication claims its reporting scope's authority in the same transaction, under the scope
  -- lock the transition took first (re-entrant here). An explicit cross-lineage replacement is named by the transaction-
  -- local setting fs_replace_final_authority writes; a FINAL inserted behind the canonical path carries none and is refused
  -- when another lineage holds the authority. The pointer and its event are written here or the whole FINAL rolls back.
  IF NEW.state = 'FINAL' THEN
    PERFORM public._fs_claim_final_authority(NEW.company_id, v_report.period_year, NEW.report_id, NEW.report_version, NEW.id, NEW.actor_firm_member_id,
      public.fs_try_jsonb(nullif(current_setting('cfoclose.fs_replace_authority', true), '')));
  END IF;
  RETURN NEW;
END;
$$;

-- ── 7. The prior year's FINAL for the comparative is the explicit authority ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._fs_prior_final_differences(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_comp jsonb;
  v_prior record;
  v_diffs jsonb;
  v_auth jsonb;
BEGIN
  v_comp := public.fs_statement_composition(p_company_id, p_period_year);
  IF v_comp ->> 'state' IS DISTINCT FROM 'composed' THEN RETURN jsonb_build_object('state', coalesce(v_comp ->> 'state', 'unavailable'), 'reason', v_comp ->> 'reason'); END IF;
  -- [20261125100000] The prior year's issued statements are its reporting scope's CURRENT FINAL authority (one per company
  -- and period, explicit) - never the latest publication by order. More than one FINAL lineage without a designated authority
  -- is an unresolved conflict the next period cannot reconcile to (named, blocking); nothing is chosen.
  v_auth := public._fs_scope_authority(p_company_id, p_period_year - 1);
  IF v_auth ->> 'state' = 'unresolved' THEN
    RETURN jsonb_build_object('state', 'prior_authority_unresolved', 'periodYear', p_period_year, 'priorPeriodYear', p_period_year - 1, 'candidates', v_auth -> 'candidates');
  END IF;
  IF v_auth ->> 'state' IS DISTINCT FROM 'held' THEN RETURN jsonb_build_object('state', 'no_prior_final', 'periodYear', p_period_year, 'priorPeriodYear', p_period_year - 1); END IF;
  SELECT r.report_id, r.report_version, encode(sha256(convert_to(r.report_document::text, 'UTF8')), 'hex') AS doc_sha, p.created_at, r.report_document AS doc
    INTO v_prior
    FROM public.financial_statement_publications p
    JOIN public.financial_statement_reports r ON r.report_id = p.report_id AND r.report_version = p.report_version
   WHERE p.id = (v_auth -> 'holder' ->> 'publicationId')::uuid AND p.company_id = p_company_id AND r.company_id = p_company_id AND r.period_year = p_period_year - 1 AND p.state = 'FINAL'
     AND r.provenance_origin = 'TRIAL_BALANCE_DERIVED' AND r.report_document #>> '{framework,kind}' = 'IFRS_FOR_SMES';
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'no_prior_final', 'periodYear', p_period_year, 'priorPeriodYear', p_period_year - 1); END IF;
  IF v_comp -> 'comparative' ->> 'state' IS DISTINCT FROM 'available' OR (v_comp -> 'comparative' ->> 'periodYear')::integer IS DISTINCT FROM p_period_year - 1 THEN
    RETURN jsonb_build_object('state', 'comparative_unavailable', 'periodYear', p_period_year,
      'priorFinal', jsonb_build_object('reportId', v_prior.report_id, 'reportVersion', v_prior.report_version, 'documentSha256', v_prior.doc_sha, 'issuedAt', v_prior.created_at));
  END IF;
  SELECT coalesce(jsonb_agg(d ORDER BY d ->> 'factId'), '[]'::jsonb) INTO v_diffs FROM (
    SELECT jsonb_build_object('factId', coalesce(c.fid, f.fid), 'issuedMinor', f.issued, 'comparativeAsReportedMinor', c.rep, 'comparativePresentedMinor', c.pres,
             'differenceMinor', CASE WHEN c.rep IS NOT NULL AND f.issued IS NOT NULL THEN (c.rep::numeric - f.issued::numeric)::text END) AS d
      FROM (SELECT 'fact:comparative:' || (l ->> 'section') || ':' || (l ->> 'lineId') AS fid, l -> 'comparative' ->> 'asReportedMinor' AS rep, l -> 'comparative' ->> 'amountMinor' AS pres
              FROM jsonb_array_elements(v_comp -> 'lines') l WHERE jsonb_typeof(l -> 'comparative') = 'object') c
      FULL JOIN (SELECT replace(x ->> 'factId', 'fact:current:', 'fact:comparative:') AS fid, x #>> '{value,minorUnits,__bigint__}' AS issued
                   FROM jsonb_array_elements(v_prior.doc -> 'facts') x
                  WHERE x ->> 'factId' LIKE 'fact:current:%' AND x ->> 'factId' NOT LIKE 'fact:current:account:%' AND x ->> 'factId' NOT LIKE 'fact:current:total:%') f
        ON f.fid = c.fid
     WHERE c.rep IS DISTINCT FROM f.issued) s;
  RETURN jsonb_build_object('state', CASE WHEN v_diffs = '[]'::jsonb THEN 'reconciled' ELSE 'differences' END, 'periodYear', p_period_year,
    'priorFinal', jsonb_build_object('reportId', v_prior.report_id, 'reportVersion', v_prior.report_version, 'documentSha256', v_prior.doc_sha, 'issuedAt', v_prior.created_at),
    'comparativeCertificationId', v_comp -> 'comparative' ->> 'certificationId', 'differences', v_diffs,
    'differencesSha256', encode(sha256(convert_to(v_diffs::text, 'UTF8')), 'hex'));
END;
$$;

CREATE OR REPLACE FUNCTION public.fs_prior_final_reconciliation(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_d jsonb;
  v_acc record;
  v_blockers text[] := '{}';
  v_body jsonb;
  v_state text;
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL THEN RETURN jsonb_build_object('state', 'invalid_request'); END IF;
  v_d := public._fs_prior_final_differences(p_company_id, p_period_year);
  -- [20261125100000] An unresolved prior-year authority blocks the new period by name until it is designated.
  IF v_d ->> 'state' = 'prior_authority_unresolved' THEN
    RETURN v_d || jsonb_build_object('blockers', jsonb_build_array('PRIOR_FINAL_AUTHORITY_UNRESOLVED:' || (p_period_year - 1)::text));
  END IF;
  IF v_d ->> 'state' NOT IN ('reconciled', 'differences') THEN RETURN v_d; END IF;
  SELECT * INTO v_acc FROM public.fs_prior_final_acceptances a WHERE a.company_id = p_company_id AND a.period_year = p_period_year ORDER BY a.seq DESC LIMIT 1;
  IF v_d ->> 'state' = 'differences' AND NOT (FOUND AND v_acc.action = 'accepted' AND v_acc.differences_sha256 = v_d ->> 'differencesSha256') THEN
    SELECT coalesce(array_agg('COMPARATIVE_NOT_AS_ISSUED:' || (d ->> 'factId') || ':' || coalesce(d ->> 'differenceMinor', CASE WHEN d ->> 'issuedMinor' IS NULL THEN 'not_issued' ELSE 'not_presented' END) ORDER BY d ->> 'factId'), '{}')
      INTO v_blockers FROM jsonb_array_elements(v_d -> 'differences') d;
  END IF;
  v_state := CASE WHEN v_d ->> 'state' = 'reconciled' THEN 'reconciled' WHEN v_blockers = '{}' THEN 'accepted_differences' ELSE 'differences' END;
  v_body := jsonb_build_object('contract', 'fs-prior-final-reconciliation/2', 'periodYear', p_period_year, 'priorFinal', v_d -> 'priorFinal',
    'comparativeCertificationId', v_d -> 'comparativeCertificationId', 'differences', v_d -> 'differences', 'differencesSha256', v_d ->> 'differencesSha256',
    'acceptance', CASE WHEN FOUND AND v_acc.action = 'accepted' THEN jsonb_build_object('acceptanceId', v_acc.id, 'differencesSha256', v_acc.differences_sha256, 'reason', v_acc.reason, 'at', v_acc.created_at,
                                                                     'inForce', v_acc.differences_sha256 = v_d ->> 'differencesSha256') END,
    'blockers', to_jsonb(v_blockers));
  RETURN jsonb_build_object('state', v_state) || v_body || jsonb_build_object('reconciliationSha256', encode(sha256(convert_to(v_body::text, 'UTF8')), 'hex'));
END;
$$;

-- ── 8. The official Reporting Pack: issue, prepare/seal refusal, seal (scope lock), disclosure ───────────────────────────
CREATE OR REPLACE FUNCTION public.issue_official_reporting_pack(p_company_id uuid, p_period_year integer, p_output_ref text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_pub  UUID;
  m      TEXT[];
  v_rel  JSONB;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('outcome', 'unauthenticated'); END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL
     OR NOT public._reporting_pack_officially_sealable('financial_statements_data', p_output_ref)
     OR NOT public._reporting_pack_output_ref_valid(p_company_id, p_period_year, 'financial_statements_data', p_output_ref) THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  -- Nothing about publication state is disclosed to a person without access to the workspace.
  IF public._workspace_access_basis(v_user, p_company_id) IS NULL THEN
    RETURN jsonb_build_object('outcome', 'workspace_access_denied');
  END IF;
  v_pub := public._final_publication_for(p_company_id, p_period_year, p_output_ref);
  IF v_pub IS NULL THEN
    INSERT INTO public.reporting_pack_issuance_events (company_id, actor_user_id, event, detail)
    VALUES (p_company_id, v_user, 'REFUSED', jsonb_build_object('stage', 'issue', 'code', 'FINAL_PUBLICATION_REQUIRED', 'output_ref', p_output_ref));
    RETURN jsonb_build_object('outcome', 'final_publication_required');
  END IF;
  -- [20261125100000] Under the reporting scope's lock (the lock every FINAL transition takes first): only the scope's CURRENT
  -- FINAL authority is issued officially. A version another FINAL replaced or succeeded is history (its sealed packs stay
  -- retrievable and verifiable, disclosed as superseded); a scope with an unresolved authority issues nothing.
  m := regexp_match(p_output_ref, '^fs-report:([A-Za-z0-9_-]{1,120}):v([0-9]{1,6})$');
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  v_rel := public._fs_authority_relation(m[1], m[2]::integer);
  IF v_rel ->> 'relation' = 'unresolved' THEN
    INSERT INTO public.reporting_pack_issuance_events (company_id, actor_user_id, event, detail)
    VALUES (p_company_id, v_user, 'REFUSED', jsonb_build_object('stage', 'issue', 'code', 'AUTHORITY_UNRESOLVED', 'output_ref', p_output_ref));
    RETURN jsonb_build_object('outcome', 'authority_unresolved');
  END IF;
  IF v_rel ->> 'relation' IS DISTINCT FROM 'is_authority' THEN
    INSERT INTO public.reporting_pack_issuance_events (company_id, actor_user_id, event, detail)
    VALUES (p_company_id, v_user, 'REFUSED', jsonb_build_object('stage', 'issue', 'code', 'SUPERSEDED_FINAL_VERSION', 'output_ref', p_output_ref, 'authority', v_rel -> 'scope' -> 'holder'));
    RETURN jsonb_build_object('outcome', 'superseded_final_version', 'authority', v_rel -> 'scope' -> 'holder');
  END IF;
  RETURN public._issue_reporting_pack(p_company_id, p_period_year, 'financial_statements_data', p_output_ref, p_request_id, v_pub);
END;
$function$;

CREATE OR REPLACE FUNCTION public._reporting_pack_seal_refusal(p_user UUID, p_issuance_id UUID, OUT p_code TEXT, OUT p_plan TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row  public.reporting_pack_issuances%ROWTYPE;
  v_auth JSONB;
  v_kind_auth JSONB;
  m TEXT[];
  v_rel JSONB;
BEGIN
  SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE id = p_issuance_id;
  IF v_row.id IS NULL OR v_row.issued_by IS DISTINCT FROM p_user THEN
    p_code := 'not_found'; RETURN;
  END IF;
  IF v_row.consumed_at IS NOT NULL THEN p_code := 'already_sealed'; RETURN; END IF;
  IF v_row.expires_at <= clock_timestamp() THEN p_code := 'expired'; RETURN; END IF;
  IF NOT public._reporting_pack_output_ref_valid(v_row.company_id, v_row.period_year, v_row.pack_kind, v_row.output_ref) THEN
    p_code := 'binding_mismatch'; RETURN;
  END IF;
  IF NOT public._reporting_pack_officially_sealable(v_row.pack_kind, v_row.output_ref) THEN
    p_code := 'official_sealing_unavailable'; RETURN;
  END IF;
  IF v_row.final_publication_id IS NULL
     OR v_row.final_publication_id IS DISTINCT FROM public._final_publication_for(v_row.company_id, v_row.period_year, v_row.output_ref) THEN
    p_code := 'final_publication_required'; RETURN;
  END IF;
  -- [20261125100000] The version must be its scope's CURRENT FINAL authority at preparation and again at sealing (the seal
  -- holds the scope lock, so a FINAL that lands first is seen; one that lands later waits for the seal to commit).
  m := regexp_match(v_row.output_ref, '^fs-report:([A-Za-z0-9_-]{1,120}):v([0-9]{1,6})$');
  IF m IS NOT NULL THEN
    v_rel := public._fs_authority_relation(m[1], m[2]::integer);
    IF v_rel ->> 'relation' = 'unresolved' THEN p_code := 'authority_unresolved'; RETURN; END IF;
    IF v_rel ->> 'relation' IS DISTINCT FROM 'is_authority' THEN p_code := 'superseded_final_version'; RETURN; END IF;
  END IF;
  v_auth := public._authorize_paid_action(p_user, v_row.company_id, 'REPORTING_PACK_EXPORT');
  IF (v_auth->>'allowed')::boolean THEN
    v_kind_auth := public._authorize_paid_action(p_user, v_row.company_id, (SELECT f.capability_code FROM public.reporting_pack_kind_features f WHERE f.pack_kind = v_row.pack_kind));
    IF NOT (v_kind_auth->>'allowed')::boolean THEN v_auth := v_kind_auth; END IF;
  END IF;
  IF NOT (v_auth->>'allowed')::boolean THEN
    p_code := lower(v_auth->>'code'); RETURN;
  END IF;
  IF NOT public.has_workspace_capability(v_row.company_id, p_user, 'issue_reporting_pack') THEN
    p_code := 'capability_required'; RETURN;
  END IF;
  p_plan := v_auth->>'plan_code';
END;
$$;

CREATE OR REPLACE FUNCTION public.seal_reporting_pack_server(p_user UUID, p_issuance_id UUID, p_storage_path TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row  public.reporting_pack_issuances%ROWTYPE;
  v_ref  RECORD;
  v_doc  TEXT;
  v_sha  TEXT;
  v_size BIGINT;
BEGIN
  IF p_user IS NULL OR p_issuance_id IS NULL OR p_storage_path IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE id = p_issuance_id FOR UPDATE;
  -- [20261125100000] Linearisation point of sealing against FINAL replacement: after this issuance's row lock, the
  -- reporting scope's lock (the one every FINAL transition takes first). Order: issuance row -> scope -> (seal trigger)
  -- tb_official_output_lock; a FINAL transition takes scope -> lineage -> version -> tb_official_output_lock; nothing takes
  -- the scope lock after the tb lock, so the orders never cycle.
  IF v_row.id IS NOT NULL THEN PERFORM public._fs_scope_lock(v_row.company_id, v_row.period_year); END IF;
  SELECT * INTO v_ref FROM public._reporting_pack_seal_refusal(p_user, p_issuance_id);
  IF v_ref.p_code IS NULL AND p_storage_path IS DISTINCT FROM (v_row.company_id::text || '/' || v_row.id::text || '.json') THEN
    v_ref.p_code := 'binding_mismatch';
  END IF;
  IF v_ref.p_code IS NULL THEN
    v_doc := public._official_reporting_pack_document(p_issuance_id);
    -- Never seal without the stored object: it must exist, with exactly the canonical document's size.
    IF NOT public._reporting_pack_object_matches(p_storage_path, octet_length(convert_to(v_doc, 'UTF8'))::bigint) THEN
      v_ref.p_code := 'object_missing';
    END IF;
  END IF;
  IF v_ref.p_code IS NOT NULL THEN
    IF v_row.id IS NOT NULL AND v_ref.p_code <> 'not_found' THEN
      INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail)
      VALUES (v_row.id, v_row.company_id, p_user, 'REFUSED', jsonb_build_object('stage', 'seal', 'code', upper(v_ref.p_code)));
    END IF;
    RETURN jsonb_build_object('outcome', v_ref.p_code);
  END IF;
  v_sha  := public.fs_sha256_hex(v_doc);
  v_size := octet_length(convert_to(v_doc, 'UTF8'));
  UPDATE public.reporting_pack_issuances
     SET consumed_at = clock_timestamp(), content_sha256 = v_sha, consumed_plan_code = v_ref.p_plan,
         storage_path = p_storage_path, byte_size = v_size
   WHERE id = v_row.id;
  INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail)
  VALUES (v_row.id, v_row.company_id, p_user, 'SEALED', jsonb_build_object('content_sha256', v_sha, 'pack_kind', v_row.pack_kind,
          'storage_path', p_storage_path, 'byte_size', v_size, 'generated_by', 'database', 'renderer', 'cfoclose.official-reporting-pack.v1'));
  RETURN jsonb_build_object('outcome', 'sealed', 'issuance_id', v_row.id, 'content_sha256', v_sha, 'byte_size', v_size);
END;
$$;

CREATE OR REPLACE FUNCTION public.reporting_pack_sealed_object(p_issuance_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.reporting_pack_issuances%ROWTYPE;
  v_doc TEXT;
  m     TEXT[];
  v_rel JSONB;
BEGIN
  SELECT * INTO v_row FROM public.reporting_pack_issuances i WHERE i.id = p_issuance_id AND i.consumed_at IS NOT NULL;
  IF v_row.id IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(v_row.output_ref, '^fs-report:([A-Za-z0-9_-]{1,120}):v([0-9]{1,6})$');
  v_rel := public._fs_authority_relation(m[1], m[2]::integer);
  BEGIN
    v_doc := public._official_reporting_pack_document(v_row.id);
  EXCEPTION WHEN OTHERS THEN
    v_doc := NULL;
  END;
  RETURN jsonb_build_object('issuance_id', v_row.id, 'company_id', v_row.company_id, 'storage_path', v_row.storage_path,
                            'content_sha256', v_row.content_sha256, 'byte_size', v_row.byte_size,
                            'canonical_sha256', CASE WHEN v_doc IS NULL THEN NULL ELSE public.fs_sha256_hex(v_doc) END,
                            'object_present', public._reporting_pack_object_matches(v_row.storage_path, v_row.byte_size),
                            -- [20261125100000] Disclosed to verify/retrieve: the version is no longer its scope's current FINAL authority
                            -- (succeeded within its lineage or replaced by another lineage); the holder is named.
                            'superseded', coalesce((v_rel ->> 'superseded')::boolean, false),
                            'authority', v_rel);
END;
$$;

-- ── 9. Saved versions and readiness carry the authority relation ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fs_list_saved_versions(p_company_id UUID, p_period_year INTEGER)
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_company_id NOT IN (SELECT public.get_member_company_ids()) THEN
    RAISE EXCEPTION 'FORBIDDEN: an accepted member of the company is required' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'reportId', r.report_id,
             'reportVersion', r.report_version,
             'createdAt', r.created_at,
             'creatorRole', fm.role,
             'creatorRef', left(public.fs_sha256_hex(r.created_by_firm_member_id::text), 8),
             'contentHash', r.content_hash,
             'evidenceBatchIds', to_jsonb(r.evidence_batch_ids),
             'state', coalesce((SELECT p.state FROM public.financial_statement_publications p
                                 WHERE p.report_id = r.report_id AND p.report_version = r.report_version ORDER BY p.seq DESC LIMIT 1), 'DRAFT'),
             'isLatest', r.report_version = (SELECT max(x.report_version) FROM public.financial_statement_reports x WHERE x.report_id = r.report_id),
             -- [20261124100000] The first later version of the lineage that is FINAL, or null: a superseded FINAL is shown as such.
             'supersededByFinal', public._fs_final_superseded_by(r.report_id, r.report_version),
             -- [20261125100000] This version's relation to its reporting scope's FINAL authority (is_authority / same_lineage / other_lineage / unresolved / none).
             'authority', public._fs_authority_relation(r.report_id, r.report_version)
           ) ORDER BY r.report_id, r.report_version)
      FROM public.financial_statement_reports r
      JOIN public.firm_members fm ON fm.id = r.created_by_firm_member_id
     WHERE r.company_id = p_company_id AND r.period_year = p_period_year), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.fs_report_readiness(p_company_id UUID, p_report_id TEXT, p_report_version INTEGER)
  RETURNS JSONB
  LANGUAGE plpgsql
  VOLATILE -- 20261023100000 (D-2): it composes through temporary tables; a STABLE declaration fails under PostgREST's READ ONLY transaction
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_blockers TEXT[];
BEGIN
  IF auth.uid() IS NULL OR p_company_id NOT IN (SELECT public.get_member_company_ids()) THEN
    RAISE EXCEPTION 'FORBIDDEN: an accepted member of the company is required' USING ERRCODE = '42501';
  END IF;
  v_blockers := public.fs_publication_blockers(p_company_id, p_report_id, p_report_version);
  -- [20261125100000] The version's relation to its reporting scope's FINAL authority rides with the readiness answer, so the
  -- page can say that finalising this version would replace another lineage's FINAL (an explicit, separate decision).
  RETURN jsonb_build_object('ready', coalesce(array_length(v_blockers, 1), 0) = 0, 'blockers', to_jsonb(v_blockers), 'authority', public._fs_authority_relation(p_report_id, p_report_version));
END;
$$;

-- ── 10. Backfill: one pointer per scope whose FINALs are in ONE lineage (its latest FINAL version); scopes with FINALs in
--        more than one lineage are recorded as CONFLICT_DETECTED and left for fs_designate_final_authority ────────────────
INSERT INTO public.fs_report_authority (company_id, period_year, report_id, report_version, publication_id, authority_seq)
SELECT s.company_id, s.period_year, s.report_id, s.report_version, s.publication_id, 1
  FROM (SELECT DISTINCT ON (r.company_id, r.period_year) r.company_id, r.period_year, p.report_id, p.report_version, p.id AS publication_id
          FROM public.financial_statement_publications p
          JOIN public.financial_statement_reports r ON r.report_id = p.report_id AND r.report_version = p.report_version AND r.company_id = p.company_id
         WHERE p.state = 'FINAL'
         ORDER BY r.company_id, r.period_year, p.report_version DESC, p.seq ASC) s
 WHERE (SELECT count(DISTINCT p2.report_id) FROM public.financial_statement_publications p2
          JOIN public.financial_statement_reports r2 ON r2.report_id = p2.report_id AND r2.report_version = p2.report_version AND r2.company_id = p2.company_id
         WHERE r2.company_id = s.company_id AND r2.period_year = s.period_year AND p2.state = 'FINAL') = 1;
INSERT INTO public.fs_report_authority_events (company_id, period_year, kind, report_id, report_version, publication_id, detail)
SELECT a.company_id, a.period_year, 'ESTABLISHED', a.report_id, a.report_version, a.publication_id, jsonb_build_object('backfill', true, 'migration', '20261125100000')
  FROM public.fs_report_authority a;
INSERT INTO public.fs_report_authority_events (company_id, period_year, kind, detail)
SELECT x.company_id, x.period_year, 'CONFLICT_DETECTED', jsonb_build_object('backfill', true, 'migration', '20261125100000', 'candidates', x.lineages)
  FROM (SELECT r.company_id, r.period_year, jsonb_agg(DISTINCT p.report_id) AS lineages, count(DISTINCT p.report_id) AS n
          FROM public.financial_statement_publications p
          JOIN public.financial_statement_reports r ON r.report_id = p.report_id AND r.report_version = p.report_version AND r.company_id = p.company_id
         WHERE p.state = 'FINAL' GROUP BY r.company_id, r.period_year) x
 WHERE x.n > 1;

-- ── Access (restated for every redefined public name; nothing widens) ────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._fs_scope_lock(UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_scope_authority(UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_authority_relation(TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_final_superseded_by(TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_claim_final_authority(UUID, INTEGER, TEXT, INTEGER, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_bind_publication() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_prior_final_differences(UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_prior_final_reconciliation(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_prior_final_reconciliation(UUID, INTEGER) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_set_publication_state(TEXT, INTEGER, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_set_publication_state(TEXT, INTEGER, UUID, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_replace_final_authority(UUID, TEXT, INTEGER, TEXT, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_replace_final_authority(UUID, TEXT, INTEGER, TEXT, INTEGER, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_designate_final_authority(UUID, INTEGER, TEXT, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_designate_final_authority(UUID, INTEGER, TEXT, INTEGER, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.issue_official_reporting_pack(UUID, INTEGER, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_official_reporting_pack(UUID, INTEGER, TEXT, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public._reporting_pack_seal_refusal(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seal_reporting_pack_server(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seal_reporting_pack_server(UUID, UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.reporting_pack_sealed_object(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reporting_pack_sealed_object(UUID) TO service_role;
REVOKE ALL ON FUNCTION public.fs_list_saved_versions(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_list_saved_versions(UUID, INTEGER) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_report_readiness(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_report_readiness(UUID, TEXT, INTEGER) TO authenticated;

DO $postcondition$
BEGIN
  IF to_regclass('public.fs_report_authority') IS NULL OR to_regclass('public.fs_report_authority_events') IS NULL
     OR to_regprocedure('public._fs_scope_lock(uuid, integer)') IS NULL
     OR to_regprocedure('public.fs_replace_final_authority(uuid, text, integer, text, integer, text)') IS NULL
     OR to_regprocedure('public.fs_designate_final_authority(uuid, integer, text, integer, text)') IS NULL
     OR position('_fs_scope_lock' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR position('AUTHORITY_CONFLICT' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR position('financial_statement_reports:'' || p_report_id' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR position('withdrawing a recorded review needs the review_close capability' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) = 0
     OR position('_fs_claim_final_authority' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0
     OR position('SIGNOFF_SEPARATE_APPROVERS_REQUIRED' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0
     OR position('_fs_scope_authority' IN pg_get_functiondef('public._fs_prior_final_differences(uuid, integer)'::regprocedure)) = 0
     OR position('PRIOR_FINAL_AUTHORITY_UNRESOLVED' IN pg_get_functiondef('public.fs_prior_final_reconciliation(uuid, integer)'::regprocedure)) = 0
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.fs_report_readiness(uuid, text, integer)'::regprocedure) <> 'v'
     OR position('_fs_authority_relation' IN pg_get_functiondef('public.issue_official_reporting_pack(uuid, integer, text, uuid)'::regprocedure)) = 0
     OR position('_fs_scope_lock' IN pg_get_functiondef('public.issue_official_reporting_pack(uuid, integer, text, uuid)'::regprocedure)) = 0
     OR position('_fs_authority_relation' IN pg_get_functiondef('public._reporting_pack_seal_refusal(uuid, uuid)'::regprocedure)) = 0
     OR position('_fs_scope_lock' IN pg_get_functiondef('public.seal_reporting_pack_server(uuid, uuid, text)'::regprocedure)) = 0
     OR position('''authority''' IN pg_get_functiondef('public.reporting_pack_sealed_object(uuid)'::regprocedure)) = 0
     OR position('''authority''' IN pg_get_functiondef('public.fs_list_saved_versions(uuid, integer)'::regprocedure)) = 0
     OR position('''authority''' IN pg_get_functiondef('public.fs_report_readiness(uuid, text, integer)'::regprocedure)) = 0
     OR has_table_privilege('authenticated', 'public.fs_report_authority', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('authenticated', 'public.fs_report_authority_events', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('anon', 'public.fs_report_authority', 'SELECT')
     OR has_function_privilege('authenticated', 'public._fs_scope_authority(uuid, integer, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_claim_final_authority(uuid, integer, text, integer, uuid, uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_replace_final_authority(uuid, text, integer, text, integer, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_replace_final_authority(uuid, text, integer, text, integer, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_designate_final_authority(uuid, integer, text, integer, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.seal_reporting_pack_server(uuid, uuid, text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM (SELECT r.company_id, r.period_year, count(DISTINCT p.report_id) n
                                 FROM public.financial_statement_publications p JOIN public.financial_statement_reports r ON r.report_id = p.report_id AND r.report_version = p.report_version
                                WHERE p.state = 'FINAL' GROUP BY 1, 2) s
                 LEFT JOIN public.fs_report_authority a ON a.company_id = s.company_id AND a.period_year = s.period_year
                WHERE (s.n = 1 AND a.company_id IS NULL) OR (s.n > 1 AND a.company_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: the FINAL authority is not in its reviewed state' USING ERRCODE = 'P0001';
  END IF;
END;
$postcondition$;
