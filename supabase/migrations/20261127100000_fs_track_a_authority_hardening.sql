-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261127100000 — Track A authority hardening (release batch track-a-r1, migration 1 of 2). Forward-only; builds on
-- 20261126100000. Additive except where it removes privileges that no reviewed path uses.
--
--   1. FINAL AUTHORITY (finding D-05). The authority pointer fs_report_authority and its history fs_report_authority_events
--      are written only by the reviewed SECURITY DEFINER functions (_fs_claim_final_authority, fs_designate_final_authority),
--      which run as their owner. service_role loses INSERT/UPDATE/DELETE/TRUNCATE on both (SELECT kept). Defence in depth
--      that does not depend on privileges: the pointer cannot be DELETEd, its scope identity cannot change, and at commit
--      (deferred constraint triggers on the pointer AND on the events) every pointer must equal the publication named by the
--      scope's latest authority event and be a FINAL of exactly its report version, company and period; a scope without a
--      pointer has no non-conflict event.
--   2. REPLACEMENT INTENT (no caller-settable authorization). fs_replace_final_authority no longer signals a replacement with
--      the transaction-local setting cfoclose.fs_replace_authority (any session can set a custom setting). It records an
--      intent row keyed by the current top-level transaction id in an owner-only table; fs_set_publication_state v5 and
--      fs_bind_publication v6 read ONLY that row (bodies otherwise byte-identical to 20261125100000; asserted below).
--   3. SERIALIZATION (framework change vs publication). _fs_scope_lock v2 first takes the company's SHARED advisory lock
--      cfoclose.fr_company:<company>; set_company_reporting_framework takes it EXCLUSIVE. Every path that takes the scope
--      lock (transitions, replacement, designation, claim, issue, seal) therefore cannot interleave with a framework change:
--      one commits before the other starts deciding. One company-level key covers every period, so a change spanning
--      periods needs no multi-scope lock order. Order: company (shared|exclusive) -> scope -> lineage -> version ->
--      tb_official_output_lock; seal keeps issuance row -> company -> scope -> tb lock.
--   4. HISTORY TRUNCATE (finding D-06). Fifteen reporting and certification history tables had no TRUNCATE refusal and
--      service_role held TRUNCATE on them (RLS never applies to TRUNCATE). Each gets a BEFORE TRUNCATE trigger and TRUNCATE
--      is revoked from every application role. Their existing UPDATE/DELETE rules are unchanged.
--   5. GOVERNED FRAMEWORK CHANGE (finding D-01), additive part: append-only company_framework_events and the RPC
--      set_company_reporting_framework (owner only; audited; idempotent per request; refused while a check runs and, for a
--      change of an existing decision, once any certification or saved report exists). Enforcement on companies is
--      20261128100000, applied only after the frontend that calls this RPC is published. New certifications and report
--      versions take the company lock SHARED as they are written, so "locked once certified or reported" is linearizable.
--
--   NOT CHANGED: every row of every table; every other function; the blockers; the server compilation receipt.
--   LIMITS: privileges and triggers constrain anon/authenticated/service_role. A database owner or administrator can alter
--   or disable them; that actor is outside this control (docs/architecture/FINANCIAL_REPORTING_MASTER_SPEC.md §4).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 0. Preconditions: refuse (nothing applied) unless the definitions this migration replaces are the reviewed ones ────
DO $pre$
DECLARE v_def text; v_missing text;
BEGIN
  v_def := pg_get_functiondef('public.fs_set_publication_state(text,integer,uuid,text,text)'::regprocedure);
  IF position('current_setting(''cfoclose.fs_replace_authority'', true)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'TRACK_A_BASELINE_CHANGED: fs_set_publication_state is not the 20261125100000 definition' USING ERRCODE = '55000';
  END IF;
  v_def := pg_get_functiondef('public.fs_bind_publication()'::regprocedure);
  IF position('current_setting(''cfoclose.fs_replace_authority'', true)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'TRACK_A_BASELINE_CHANGED: fs_bind_publication is not the 20261125100000 definition' USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(t, ', ') INTO v_missing FROM unnest(ARRAY['financial_evidence_batches', 'financial_statement_audit_events', 'financial_statement_correction_groups', 'financial_statement_documents', 'financial_statement_evaluations', 'financial_statement_framework_requirements', 'financial_statement_publications', 'financial_statement_reports', 'financial_statement_reviewer_decisions', 'financial_statements_rollout_audit', 'fs_signoff_policy_events', 'tb_certification_findings', 'tb_certification_invalidations', 'tb_certifications', 'tb_reprocess_requests', 'fs_report_authority', 'fs_report_authority_events']) t
   WHERE to_regclass('public.' || t) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'TRACK_A_BASELINE_CHANGED: missing tables %', v_missing USING ERRCODE = '55000';
  END IF;
END;
$pre$;

-- ── 1. The scope lock v2: the company's shared lock first ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._fs_scope_lock(p_company_id uuid, p_period_year integer)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- [20261127100000] A framework change takes this key EXCLUSIVE (set_company_reporting_framework); every scope decision
  -- holds it SHARED until its transaction ends, so no framework change can commit between its validation and its commit.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('cfoclose.fr_company:' || p_company_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.fs_report_authority:' || p_company_id::text || ':' || p_period_year::text, 0));
END;
$$;

-- ── 2. Replacement intents: owner-only, keyed by the current top-level transaction ────────────────────────────────────
CREATE TABLE public.fs_authority_replacement_intents (
  txid                     xid8        NOT NULL,
  company_id               uuid        NOT NULL,
  report_id                text        NOT NULL,
  report_version           integer     NOT NULL,
  replaces_report_id       text        NOT NULL,
  replaces_report_version  integer     NOT NULL,
  actor_user_id            uuid        NULL,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fs_authority_replacement_intents_pk PRIMARY KEY (txid, company_id, report_id, report_version)
);
ALTER TABLE public.fs_authority_replacement_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fs_authority_replacement_intents FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_fsari_append_only BEFORE UPDATE OR DELETE ON public.fs_authority_replacement_intents FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_fsari_no_truncate BEFORE TRUNCATE ON public.fs_authority_replacement_intents FOR EACH STATEMENT EXECUTE FUNCTION public.fs_presentation_append_only();

-- The replacement this transaction declared for exactly this version, or NULL. Only fs_replace_final_authority writes it.
CREATE OR REPLACE FUNCTION public._fs_replacement_intent(p_company_id uuid, p_report_id text, p_report_version integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('reportId', i.replaces_report_id, 'reportVersion', i.replaces_report_version)
    FROM public.fs_authority_replacement_intents i
   WHERE i.txid = pg_current_xact_id() AND i.company_id = p_company_id AND i.report_id = p_report_id AND i.report_version = p_report_version;
$$;

-- ── 3. fs_set_publication_state v5 (the 20261125100000 text; the replacement is read from the intent, never a setting) ──
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
    v_replace := public._fs_replacement_intent(p_company_id, p_report_id, p_report_version);
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

-- ── 3b. Explicit cross-lineage replacement ─────────────────────────────────────────────────────────────────────────────
-- fs_replace_final_authority v2: records the intent (owner-only row) instead of a transaction-local setting.
CREATE OR REPLACE FUNCTION public.fs_replace_final_authority(p_company_id uuid, p_report_id text, p_report_version integer, p_replaces_report_id text, p_replaces_report_version integer, p_reason text)
RETURNS public.financial_statement_publications LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_replaces_report_id IS NULL OR p_replaces_report_version IS NULL OR p_report_id IS NULL OR p_report_version IS NULL OR p_company_id IS NULL THEN
    RAISE EXCEPTION 'INVALID: a replacement names the replacing version and the exact FINAL it replaces' USING ERRCODE = '22023';
  END IF;
  IF p_replaces_report_id = p_report_id THEN
    RAISE EXCEPTION 'AUTHORITY_REPLACE_SAME_LINEAGE: a later version of the same lineage succeeds its FINAL without a replacement target' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.fs_authority_replacement_intents (txid, company_id, report_id, report_version, replaces_report_id, replaces_report_version, actor_user_id)
  VALUES (pg_current_xact_id(), p_company_id, p_report_id, p_report_version, p_replaces_report_id, p_replaces_report_version, auth.uid())
  ON CONFLICT (txid, company_id, report_id, report_version) DO NOTHING;
  IF public._fs_replacement_intent(p_company_id, p_report_id, p_report_version) IS DISTINCT FROM
     jsonb_build_object('reportId', p_replaces_report_id, 'reportVersion', p_replaces_report_version) THEN
    RAISE EXCEPTION 'AUTHORITY_MISMATCH: this transaction already declared a different replacement for % v%', p_report_id, p_report_version USING ERRCODE = 'PT409';
  END IF;
  RETURN public.fs_set_publication_state(p_report_id, p_report_version, p_company_id, 'FINAL', p_reason);
END;
$$;

-- ── 4. fs_bind_publication v6 (the 20261125100000 text; the replacement is read from the intent, never a setting) ──────
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
      public._fs_replacement_intent(NEW.company_id, NEW.report_id, NEW.report_version));
  END IF;
  RETURN NEW;
END;
$$;

-- ── 5. The FINAL authority pointer and its history: owner-only writes, scope identity fixed, pointer = latest event ────
REVOKE ALL ON public.fs_report_authority FROM service_role;
REVOKE ALL ON public.fs_report_authority_events FROM service_role;
GRANT SELECT ON public.fs_report_authority TO service_role;
GRANT SELECT ON public.fs_report_authority_events TO service_role;

CREATE OR REPLACE FUNCTION public.fs_report_authority_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AUTHORITY_POINTER_IMMUTABLE: a FINAL authority is never deleted; it is succeeded, replaced or designated' USING ERRCODE = '42501';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.period_year IS DISTINCT FROM OLD.period_year THEN
    RAISE EXCEPTION 'AUTHORITY_POINTER_IMMUTABLE: the reporting scope of an authority never changes' USING ERRCODE = '42501';
  END IF;
  IF NEW.authority_seq <> OLD.authority_seq + 1 THEN
    RAISE EXCEPTION 'AUTHORITY_POINTER_SEQUENCE: an authority change advances its sequence by exactly one' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_fsra_guard BEFORE UPDATE OR DELETE ON public.fs_report_authority FOR EACH ROW EXECUTE FUNCTION public.fs_report_authority_guard();

-- At commit, for every scope touched (pointer written or authority event recorded): if the scope has a pointer, its latest
-- non-conflict authority event names the pointer's publication, and that publication is a FINAL of exactly the pointer's
-- report version, company and period; if it has no pointer, it has no non-conflict event (a legacy unresolved scope holds
-- only CONFLICT_DETECTED). Reads the to-be-committed rows, not NEW, so several decisions in one transaction are checked
-- against their final state. Deferred: SET CONSTRAINTS can make it fire earlier (inside the decision function, before
-- its event row exists, which refuses that caller's own decision) but never skip it.
CREATE OR REPLACE FUNCTION public._fs_authority_scope_check(p_company_id uuid, p_period_year integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_ptr public.fs_report_authority; v_kind text; v_pub uuid; v_ok boolean;
BEGIN
  SELECT * INTO v_ptr FROM public.fs_report_authority a WHERE a.company_id = p_company_id AND a.period_year = p_period_year;
  SELECT e.kind, e.publication_id INTO v_kind, v_pub FROM public.fs_report_authority_events e
   WHERE e.company_id = p_company_id AND e.period_year = p_period_year AND e.kind <> 'CONFLICT_DETECTED'
   ORDER BY e.seq DESC LIMIT 1;
  IF v_ptr.company_id IS NULL THEN
    IF v_kind IS NOT NULL THEN
      RAISE EXCEPTION 'AUTHORITY_EVENT_WITHOUT_POINTER: FY% of company % records % for publication % but has no authority pointer', p_period_year, p_company_id, v_kind, v_pub
        USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('ESTABLISHED', 'SUCCEEDED', 'REPLACED', 'DESIGNATED') OR v_pub IS DISTINCT FROM v_ptr.publication_id THEN
    RAISE EXCEPTION 'AUTHORITY_POINTER_WITHOUT_EVENT: FY% of company % names publication % but its latest authority event names %', p_period_year, p_company_id, v_ptr.publication_id, v_pub
      USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.financial_statement_publications p
                   JOIN public.financial_statement_reports r ON r.report_id = p.report_id AND r.report_version = p.report_version
                  WHERE p.id = v_ptr.publication_id AND p.state = 'FINAL' AND p.company_id = p_company_id
                    AND p.report_id = v_ptr.report_id AND p.report_version = v_ptr.report_version
                    AND r.company_id = p_company_id AND r.period_year = p_period_year) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'AUTHORITY_POINTER_IDENTITY: FY% of company % names % v% / publication %, which is not a FINAL of that version, company and period', p_period_year, p_company_id, v_ptr.report_id, v_ptr.report_version, v_ptr.publication_id
      USING ERRCODE = '42501';
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.fs_report_authority_event_consistency()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public._fs_authority_scope_check(NEW.company_id, NEW.period_year);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trg_fsra_event_consistency AFTER INSERT OR UPDATE ON public.fs_report_authority
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fs_report_authority_event_consistency();
CREATE CONSTRAINT TRIGGER trg_fsrae_event_consistency AFTER INSERT ON public.fs_report_authority_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fs_report_authority_event_consistency();

-- ── 6. Append-only tables refuse TRUNCATE ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fs_refuse_truncate()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY: TRUNCATE on % is refused; history is never erased', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER trg_financial_evidence_batches_no_truncate BEFORE TRUNCATE ON public.financial_evidence_batches FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.financial_evidence_batches FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_financial_statement_audit_events_no_truncate BEFORE TRUNCATE ON public.financial_statement_audit_events FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.financial_statement_audit_events FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_financial_statement_correction_groups_no_truncate BEFORE TRUNCATE ON public.financial_statement_correction_groups FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.financial_statement_correction_groups FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_financial_statement_documents_no_truncate BEFORE TRUNCATE ON public.financial_statement_documents FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.financial_statement_documents FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_financial_statement_evaluations_no_truncate BEFORE TRUNCATE ON public.financial_statement_evaluations FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.financial_statement_evaluations FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_financial_statement_framework_requirements_no_truncate BEFORE TRUNCATE ON public.financial_statement_framework_requirements FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.financial_statement_framework_requirements FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_financial_statement_publications_no_truncate BEFORE TRUNCATE ON public.financial_statement_publications FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.financial_statement_publications FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_financial_statement_reports_no_truncate BEFORE TRUNCATE ON public.financial_statement_reports FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.financial_statement_reports FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_financial_statement_reviewer_decisions_no_truncate BEFORE TRUNCATE ON public.financial_statement_reviewer_decisions FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.financial_statement_reviewer_decisions FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_financial_statements_rollout_audit_no_truncate BEFORE TRUNCATE ON public.financial_statements_rollout_audit FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.financial_statements_rollout_audit FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_fs_signoff_policy_events_no_truncate BEFORE TRUNCATE ON public.fs_signoff_policy_events FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.fs_signoff_policy_events FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_tb_certification_findings_no_truncate BEFORE TRUNCATE ON public.tb_certification_findings FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.tb_certification_findings FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_tb_certification_invalidations_no_truncate BEFORE TRUNCATE ON public.tb_certification_invalidations FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.tb_certification_invalidations FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_tb_certifications_no_truncate BEFORE TRUNCATE ON public.tb_certifications FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.tb_certifications FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_tb_reprocess_requests_no_truncate BEFORE TRUNCATE ON public.tb_reprocess_requests FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();
REVOKE TRUNCATE ON public.tb_reprocess_requests FROM PUBLIC, anon, authenticated, service_role;

-- ── 7. Governed framework changes (additive; enforcement on companies is 20261128100000) ───────────────────────────────
CREATE TABLE public.company_framework_events (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq             bigint      GENERATED ALWAYS AS IDENTITY,
  company_id      uuid        NOT NULL,
  from_framework  text        NULL,
  to_framework    text        NOT NULL CHECK (to_framework IN ('ifrs_for_smes', 'full_ifrs', 'ipsas_accrual', 'ipsas_cash')),
  reason          text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 500),
  actor_user_id   uuid        NOT NULL,
  request_id      uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The writing transaction: 20261128100000's guard admits a change only with this transaction's own event.
  txid            xid8        NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT uq_cfe_request UNIQUE (company_id, actor_user_id, request_id)
);
CREATE INDEX idx_cfe_company ON public.company_framework_events (company_id, seq);
ALTER TABLE public.company_framework_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_framework_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.company_framework_events TO authenticated, service_role;
CREATE POLICY cfe_read ON public.company_framework_events FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.get_member_company_ids()) OR EXISTS (SELECT 1 FROM public.companies c WHERE c.id = company_id AND c.user_id = auth.uid()));
CREATE TRIGGER trg_cfe_append_only BEFORE UPDATE OR DELETE ON public.company_framework_events FOR EACH ROW EXECUTE FUNCTION public.fs_presentation_append_only();
CREATE TRIGGER trg_cfe_no_truncate BEFORE TRUNCATE ON public.company_framework_events FOR EACH STATEMENT EXECUTE FUNCTION public.fs_refuse_truncate();

-- The one writer of companies.reporting_framework after creation. Policy (docs/architecture/FINANCIAL_REPORTING_MASTER_SPEC.md §5.4):
--   · only the company's owner (companies.user_id), the same authority as the existing owner UPDATE policy;
--   · a first decision (NULL -> framework) is allowed at any time except while a check runs;
--   · a change of an existing decision is refused once any certification or saved report exists (outcome refused,
--     code FRAMEWORK_LOCKED) —
--     the same rule the browser enforces (companyFieldLock.ts); a corrected engagement is the path then;
--   · audited (company_framework_events), idempotent per request id, optimistic on the expected current value;
--   · serialized against every reporting decision by the company's exclusive advisory lock.
CREATE OR REPLACE FUNCTION public.set_company_reporting_framework(p_company_id uuid, p_framework text, p_expected_framework text, p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_company public.companies;
  v_prior public.company_framework_events;
  v_event uuid;
BEGIN
  PERFORM public.tb_require_read_committed();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF p_company_id IS NULL OR p_request_id IS NULL OR p_framework IS NULL
     OR p_framework NOT IN ('ifrs_for_smes', 'full_ifrs', 'ipsas_accrual', 'ipsas_cash')
     OR length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 8 AND 500 THEN
    RAISE EXCEPTION 'INVALID: a framework change names the company, a supported framework, a request id and a reason of 8-500 characters' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.fr_company:' || p_company_id::text, 0));
  SELECT * INTO v_company FROM public.companies c WHERE c.id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_company.user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'FORBIDDEN: only the company''s owner changes its reporting framework' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_prior FROM public.company_framework_events e WHERE e.company_id = p_company_id AND e.actor_user_id = v_uid AND e.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.to_framework IS DISTINCT FROM p_framework OR v_prior.reason IS DISTINCT FROM btrim(p_reason) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: request % was already used for a different framework change', p_request_id USING ERRCODE = 'PT409';
    END IF;
    RETURN jsonb_build_object('outcome', 'replayed', 'from', v_prior.from_framework, 'to', v_prior.to_framework, 'eventId', v_prior.id);
  END IF;
  IF v_company.reporting_framework IS NOT DISTINCT FROM p_framework THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'from', v_company.reporting_framework, 'to', p_framework);
  END IF;
  IF v_company.reporting_framework IS DISTINCT FROM p_expected_framework THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'STALE_FRAMEWORK', 'current', v_company.reporting_framework);
  END IF;
  -- A check in flight: an attempt-fenced run (20261008100000) whose lease is live. A pre-attempt legacy row (no attempt,
  -- no lease) is not a running check and never blocks.
  IF EXISTS (SELECT 1 FROM public.engine_runs er JOIN public.trial_balance_uploads u ON u.id = er.source_record_id
              WHERE u.company_id = p_company_id AND er.function_name = 'process-trial-balance' AND er.status = 'running'
                AND er.attempt_no IS NOT NULL AND er.lease_expires_at > clock_timestamp()) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'PROCESSING_IN_PROGRESS', 'current', v_company.reporting_framework);
  END IF;
  IF v_company.reporting_framework IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.tb_certifications tc JOIN public.trial_balance_uploads u ON u.id = tc.upload_id WHERE u.company_id = p_company_id)
       OR EXISTS (SELECT 1 FROM public.financial_statement_reports r WHERE r.company_id = p_company_id)) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'FRAMEWORK_LOCKED', 'current', v_company.reporting_framework);
  END IF;
  -- The event first: 20261128100000's guard admits the UPDATE only with this transaction's own matching event.
  INSERT INTO public.company_framework_events (company_id, from_framework, to_framework, reason, actor_user_id, request_id)
  VALUES (p_company_id, v_company.reporting_framework, p_framework, btrim(p_reason), v_uid, p_request_id)
  RETURNING id INTO v_event;
  UPDATE public.companies SET reporting_framework = p_framework WHERE id = p_company_id;
  RETURN jsonb_build_object('outcome', 'changed', 'from', v_company.reporting_framework, 'to', p_framework, 'eventId', v_event);
END;
$$;

-- Every new certification and every new saved report version takes the company's lock SHARED as it is written, so a
-- framework change (EXCLUSIVE) and the first certification or report of a company are ordered: either the row commits
-- first and the change is refused FRAMEWORK_LOCKED, or the change commits first and the row is written after it (its
-- content then stale by the #framework dependency, refused at review and approval). Nothing else changes for writers.
CREATE OR REPLACE FUNCTION public._fs_company_decision_lock()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('cfoclose.fr_company:' || NEW.company_id::text, 0));
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tbc_company_decision_lock BEFORE INSERT ON public.tb_certifications FOR EACH ROW EXECUTE FUNCTION public._fs_company_decision_lock();
CREATE TRIGGER trg_fsr_company_decision_lock BEFORE INSERT ON public.financial_statement_reports FOR EACH ROW EXECUTE FUNCTION public._fs_company_decision_lock();

-- ── 8. Access (restated; nothing widens) ───────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._fs_scope_lock(UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_replacement_intent(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_bind_publication() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_report_authority_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_report_authority_event_consistency() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_refuse_truncate() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_authority_scope_check(UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_company_decision_lock() FROM PUBLIC, anon, authenticated, service_role;
-- Designation is a member decision (auth.uid() and approve_certification); the service credential never designates.
REVOKE EXECUTE ON FUNCTION public.fs_designate_final_authority(UUID, INTEGER, TEXT, INTEGER, TEXT) FROM service_role;
REVOKE ALL ON FUNCTION public.fs_set_publication_state(TEXT, INTEGER, UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fs_set_publication_state(TEXT, INTEGER, UUID, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_replace_final_authority(UUID, TEXT, INTEGER, TEXT, INTEGER, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fs_replace_final_authority(UUID, TEXT, INTEGER, TEXT, INTEGER, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.set_company_reporting_framework(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_company_reporting_framework(UUID, TEXT, TEXT, TEXT, UUID) TO authenticated;
