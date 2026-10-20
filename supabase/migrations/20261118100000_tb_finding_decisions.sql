-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Trial balance findings: recorded decisions, the requirement model, the evaluation manifest, the entity dependency and
-- bounded, stored investigation.
--
--   1. tb_decision_rules + tb_decision_actions — fixed by migration. A finding code's REQUIREMENT is defined, never
--      inferred: 'always' (ENTITY_NAME_DIFFERS — a file naming another entity is not accepted until the person states
--      whose it is), 'policy' (CLEARING_ACCOUNT_BALANCE — a review indicator by default; an explanation with evidence is
--      required only where the workspace's recorded policy says so) or 'never' (UNRECOGNISED_TRAILING_TEXT — amount-free
--      text after the last amount row is a review indicator; it may be acknowledged, never a blanket blocker). Amount-
--      bearing rows without an account are not decisions at all: they block as MISSING_ACCOUNT_CODE and are resolved by
--      a layout correction or a corrected file — never by dropping them. Nothing here adjusts an amount, adds a row or
--      plugs a difference: a decision only states a fact about the file.
--   2. tb_finding_policies — append-only, per workspace and code, set only by someone with review_close
--      (set_tb_finding_policy, reason required, expected revision, idempotent). A change bumps '#finding_policy', so a
--      result evaluated under the previous policy stops being authoritative at once.
--   3. tb_finding_decisions — append-only. A decision names a finding of ONE certification by the engine's stored identity
--      (code + subject), binds the upload and its source hash, the file's layout revision ('#layout_confirmation:<upload>')
--      and — for entity findings — the workspace's identity revision ('#entity'); the actor is derived from auth.uid() with
--      prepare_close. Replay, IDEMPOTENCY_KEY_REUSED, STALE_EVALUATION, VERSION_CONFLICT, unchanged. Recording one
--      invalidates the evaluation it was made against in the same transaction and bumps '#finding_decisions:<upload>'.
--      SAFE CARRY-FORWARD: a decision is reused only by a later check of the SAME upload (same source bytes) while its
--      layout revision — and for an entity finding the entity revision — is unchanged and the finding (code + subject)
--      reappears. A replacement file, a changed title (a new subject), a new layout confirmation or a renamed entity
--      requires a new decision. Nothing carries across files or across a company's uploads.
--   4. The evaluation manifest (engine generation 7): every rule of tb_evaluation_rules(7) exactly once, consistent with
--      the findings; every decision-taking finding carries its subject and a decision_required flag that the DATABASE
--      recomputes from the rule and the workspace policy; a cited decision must be current; a non-resolving decision
--      makes the result blocking; an accepted result leaves no REQUIRED finding without a current resolving decision.
--      Unknown generations are refused; an engine below 7 is refused for an upload that has decisions.
--   5. tb_investigations + tb_investigation_rows — a durable, unique reservation per upload (partial unique index, not an
--      advisory lock) with a recoverable lease; the reader's own rows (included and excluded, source location, exact
--      parsed minor amounts) are stored ONCE and read page by page (get_tb_investigation_rows) — the file is never parsed
--      again for a page. Bounded: ≤ 20,000 rows, ≤ 2,000 per write, ≤ 200 per page, ≤ 50 leads.
--
-- The trusted-handler boundary: the database cannot re-parse the file. It verifies what it can — every rule reported,
-- outcomes consistent with the findings, requirements recomputed from rule and policy, every cited decision current and
-- resolving, identities taken from the certification's own stored findings — and trusts the service-role engine
-- (process-trial-balance, generation 7) to have evaluated each rule truthfully. A manifest does not prove that. Generation
-- 7 is not enforced for uploads without decisions until processing_release_control.min_engine_generation is raised to 7.
--
-- PREFLIGHT: refuses if any object exists already or a prerequisite is missing; nothing is replaced silently.
-- Release order: this migration → process-trial-balance (generation 7) + trial-balance-layout (investigate) → frontend →
-- minimum generation 7.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regclass('public.tb_certification_findings') IS NULL OR to_regclass('public.layout_confirmations') IS NULL
     OR to_regprocedure('public._tb_bump_dependency(text, text)') IS NULL
     OR to_regprocedure('public._layout_actor(uuid, uuid)') IS NULL
     OR to_regprocedure('public.can_access_workspace(uuid)') IS NULL
     OR to_regprocedure('public.workspace_capability_allowed(uuid, uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: a prerequisite (findings, layouts, dependency revisions, workspace access) is missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regclass('public.tb_decision_actions') IS NOT NULL OR to_regclass('public.tb_decision_rules') IS NOT NULL
     OR to_regclass('public.tb_finding_decisions') IS NOT NULL OR to_regclass('public.tb_finding_policies') IS NOT NULL
     OR to_regclass('public.tb_investigations') IS NOT NULL OR to_regclass('public.tb_investigation_rows') IS NOT NULL
     OR to_regprocedure('public.record_tb_finding_decision(uuid, uuid, text, text, text, jsonb, text, integer, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: finding decisions are already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. The rules and the decision registry (fixed) ───────────────────────────────────────────────────────────────────
CREATE TABLE public.tb_decision_rules (
  code        text NOT NULL,
  requirement text NOT NULL,
  CONSTRAINT tb_decision_rules_pkey PRIMARY KEY (code),
  CONSTRAINT chk_tdr_code CHECK (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  CONSTRAINT chk_tdr_requirement CHECK (requirement IN ('always', 'policy', 'never'))
);
INSERT INTO public.tb_decision_rules (code, requirement) VALUES
  ('ENTITY_NAME_DIFFERS',        'always'),
  ('CLEARING_ACCOUNT_BALANCE',   'policy'),
  ('UNRECOGNISED_TRAILING_TEXT', 'never');
COMMENT ON TABLE public.tb_decision_rules IS
  'Whether a finding code must be decided before a trial balance can be accepted: always, by workspace policy, or never (a review indicator that may be acknowledged). Fixed by migration.';

CREATE TABLE public.tb_decision_actions (
  code     text    NOT NULL,
  action   text    NOT NULL,
  resolves boolean NOT NULL,
  CONSTRAINT tb_decision_actions_pkey PRIMARY KEY (code, action),
  CONSTRAINT fk_tda_rule FOREIGN KEY (code) REFERENCES public.tb_decision_rules(code),
  CONSTRAINT chk_tda_action CHECK (action ~ '^[a-z][a-z_]{2,63}$')
);
INSERT INTO public.tb_decision_actions (code, action, resolves) VALUES
  ('ENTITY_NAME_DIFFERS',        'same_entity',               true),
  ('ENTITY_NAME_DIFFERS',        'different_entity',          false),
  ('UNRECOGNISED_TRAILING_TEXT', 'not_part_of_trial_balance', true),
  ('UNRECOGNISED_TRAILING_TEXT', 'part_of_trial_balance',     false),
  ('CLEARING_ACCOUNT_BALANCE',   'explained',                 true);
COMMENT ON TABLE public.tb_decision_actions IS
  'The closed registry of decisions a finding may receive. resolves = the finding is settled; a non-resolving action (different_entity, part_of_trial_balance) makes the result blocking with its recovery. Fixed by migration.';
CREATE OR REPLACE FUNCTION public.tb_decision_registry_fixed()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: % is fixed by migration. % is not permitted.', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.tb_decision_registry_fixed() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_tdr_fixed BEFORE INSERT OR UPDATE OR DELETE ON public.tb_decision_rules
  FOR EACH ROW EXECUTE FUNCTION public.tb_decision_registry_fixed();
CREATE TRIGGER trg_tdr_no_truncate BEFORE TRUNCATE ON public.tb_decision_rules
  FOR EACH STATEMENT EXECUTE FUNCTION public.tb_decision_registry_fixed();
CREATE TRIGGER trg_tda_fixed BEFORE INSERT OR UPDATE OR DELETE ON public.tb_decision_actions
  FOR EACH ROW EXECUTE FUNCTION public.tb_decision_registry_fixed();
CREATE TRIGGER trg_tda_no_truncate BEFORE TRUNCATE ON public.tb_decision_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.tb_decision_registry_fixed();
ALTER TABLE public.tb_decision_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tb_decision_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_decision_rules, public.tb_decision_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tb_decision_rules, public.tb_decision_actions TO authenticated, service_role;
CREATE POLICY tdr_read ON public.tb_decision_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY tda_read ON public.tb_decision_actions FOR SELECT TO authenticated USING (true);

-- The rules an engine generation must report on every certification (the evaluation manifest), and the newest generation
-- this database understands. Generation 7 is the first with a manifest.
CREATE OR REPLACE FUNCTION public.tb_evaluation_rules(p_generation integer)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p_generation >= 7 THEN
    ARRAY['source_read', 'columns', 'period_and_currency', 'duplicate_identities', 'balance', 'entity_name', 'trailing_text',
          'clearing_accounts', 'classification']::text[]
  ELSE NULL END;
$$;
CREATE OR REPLACE FUNCTION public.tb_max_engine_generation()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT 7 $$;
-- Which manifest rule a finding code is reported under (a finding of that code means the rule's outcome is 'finding').
CREATE OR REPLACE FUNCTION public.tb_finding_rule(p_code text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_code
    WHEN 'ENTITY_NAME_DIFFERS' THEN 'entity_name'
    WHEN 'ENTITY_WRONG_DESTINATION' THEN 'entity_name'
    WHEN 'UNRECOGNISED_TRAILING_TEXT' THEN 'trailing_text'
    WHEN 'LAYOUT_CORRECTION_REQUIRED' THEN 'trailing_text'
    WHEN 'CLEARING_ACCOUNT_BALANCE' THEN 'clearing_accounts'
    WHEN 'TRIAL_BALANCE_IMBALANCE' THEN 'balance'
    ELSE NULL END;
$$;
REVOKE ALL ON FUNCTION public.tb_evaluation_rules(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tb_max_engine_generation() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tb_finding_rule(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tb_evaluation_rules(integer), public.tb_max_engine_generation(), public.tb_finding_rule(text)
  TO authenticated, service_role;

-- ── 2. Workspace policy (explicit, recorded) ─────────────────────────────────────────────────────────────────────────
CREATE TABLE public.tb_finding_policies (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL,
  code          text        NOT NULL,
  mode          text        NOT NULL,
  revision      integer     NOT NULL,
  reason        text        NOT NULL,
  request_id    uuid        NOT NULL,
  actor_user_id uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tb_finding_policies_pkey PRIMARY KEY (id),
  CONSTRAINT fk_tfp_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tfp_rule FOREIGN KEY (code) REFERENCES public.tb_decision_rules(code),
  CONSTRAINT uq_tfp_revision UNIQUE (company_id, code, revision),
  CONSTRAINT uq_tfp_request UNIQUE (company_id, request_id),
  CONSTRAINT chk_tfp_mode CHECK (mode IN ('review', 'require_decision')),
  CONSTRAINT chk_tfp_revision CHECK (revision > 0),
  CONSTRAINT chk_tfp_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000)
);
COMMENT ON TABLE public.tb_finding_policies IS
  'Append-only workspace policies for policy-controlled findings (today: CLEARING_ACCOUNT_BALANCE). Absent = review indicator. Written only by set_tb_finding_policy.';

-- Whether a finding code must be decided before acceptance, for this workspace now.
CREATE OR REPLACE FUNCTION public.tb_finding_required(p_company_id uuid, p_code text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE r.requirement
    WHEN 'always' THEN true
    WHEN 'never' THEN false
    ELSE coalesce((SELECT p.mode = 'require_decision' FROM public.tb_finding_policies p
                    WHERE p.company_id = p_company_id AND p.code = p_code ORDER BY p.revision DESC LIMIT 1), false) END
    FROM public.tb_decision_rules r WHERE r.code = p_code;
$$;
REVOKE ALL ON FUNCTION public.tb_finding_required(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_finding_required(uuid, text) TO service_role;

-- The engine's read: every decision-taking code with its current requirement for the workspace.
CREATE OR REPLACE FUNCTION public.tb_finding_requirements(p_company_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(jsonb_object_agg(r.code, public.tb_finding_required(p_company_id, r.code)), '{}'::jsonb) FROM public.tb_decision_rules r;
$$;
REVOKE ALL ON FUNCTION public.tb_finding_requirements(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_finding_requirements(uuid) TO service_role;

-- The browser's read: the workspace's policy for each policy-controlled code, and who may change it.
CREATE OR REPLACE FUNCTION public.get_tb_finding_policies(p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('outcome', 'unauthenticated'); END IF;
  IF p_company_id IS NULL OR NOT public.can_access_workspace(p_company_id) THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  RETURN jsonb_build_object('outcome', 'ok',
    'may_change', public.workspace_capability_allowed(p_company_id, v_uid, 'review_close'),
    'policies', coalesce((SELECT jsonb_agg(jsonb_build_object('code', r.code,
        'mode', coalesce(p.mode, 'review'), 'revision', coalesce(p.revision, 0), 'reason', p.reason, 'set_at', p.created_at) ORDER BY r.code)
      FROM public.tb_decision_rules r
      LEFT JOIN LATERAL (SELECT * FROM public.tb_finding_policies x WHERE x.company_id = p_company_id AND x.code = r.code
                          ORDER BY x.revision DESC LIMIT 1) p ON true
     WHERE r.requirement = 'policy'), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.get_tb_finding_policies(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tb_finding_policies(uuid) TO authenticated;

-- Sets a workspace's policy for one policy-controlled code (review_close; reason; expected revision; idempotent).
CREATE OR REPLACE FUNCTION public.set_tb_finding_policy(p_company_id uuid, p_code text, p_mode text, p_reason text,
  p_expected_revision integer, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prior public.tb_finding_policies%ROWTYPE;
  v_latest public.tb_finding_policies%ROWTYPE;
  v_rev integer;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'UNAUTHENTICATED'); END IF;
  IF p_company_id IS NULL OR p_code IS NULL OR p_mode IS NULL OR p_mode NOT IN ('review', 'require_decision')
     OR p_expected_revision IS NULL OR p_expected_revision < 0 OR p_request_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'INVALID_REQUEST');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'REASON_REQUIRED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tb_decision_rules r WHERE r.code = p_code AND r.requirement = 'policy') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'NOT_POLICY_CONTROLLED');
  END IF;
  IF NOT public.can_access_workspace(p_company_id) THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'NOT_FOUND'); END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'review_close') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'FORBIDDEN');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tb_finding_policy'), hashtext(p_company_id::text || ':' || p_code));
  SELECT * INTO v_prior FROM public.tb_finding_policies p WHERE p.company_id = p_company_id AND p.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.code = p_code AND v_prior.mode = p_mode AND v_prior.actor_user_id = v_uid THEN
      RETURN jsonb_build_object('outcome', 'recorded', 'revision', v_prior.revision, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED');
  END IF;
  SELECT * INTO v_latest FROM public.tb_finding_policies p WHERE p.company_id = p_company_id AND p.code = p_code ORDER BY p.revision DESC LIMIT 1;
  IF coalesce(v_latest.revision, 0) <> p_expected_revision THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'VERSION_CONFLICT', 'current_revision', coalesce(v_latest.revision, 0));
  END IF;
  IF coalesce(v_latest.mode, 'review') = p_mode THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'revision', coalesce(v_latest.revision, 0));
  END IF;
  v_rev := coalesce(v_latest.revision, 0) + 1;
  PERFORM set_config('axiom.tb_decision_writer', txid_current()::text, true);
  INSERT INTO public.tb_finding_policies (company_id, code, mode, revision, reason, request_id, actor_user_id)
  VALUES (p_company_id, p_code, p_mode, v_rev, btrim(p_reason), p_request_id, v_uid);
  PERFORM set_config('axiom.tb_decision_writer', '', true);
  -- Every result evaluated under the previous policy stops being authoritative at once.
  PERFORM public._tb_bump_dependency(p_company_id::text, '#finding_policy');
  RETURN jsonb_build_object('outcome', 'recorded', 'revision', v_rev);
END;
$$;
REVOKE ALL ON FUNCTION public.set_tb_finding_policy(uuid, text, text, text, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_tb_finding_policy(uuid, text, text, text, integer, uuid) TO authenticated;

-- ── 3. Decisions ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.tb_finding_decisions (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  upload_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  certification_id uuid        NOT NULL,
  code             text        NOT NULL,
  subject          text        NOT NULL,
  finding_key      text        NOT NULL,
  action           text        NOT NULL,
  revision         integer     NOT NULL,
  payload          jsonb       NOT NULL,
  reason           text        NOT NULL,
  source_file_hash text        NOT NULL,
  layout_revision  bigint      NOT NULL,
  entity_revision  bigint      NOT NULL,
  request_id       uuid        NOT NULL,
  request_hash     text        NOT NULL,
  actor_type       text        NOT NULL,
  firm_member_id   uuid        NULL,
  actor_user_id    uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tb_finding_decisions_pkey PRIMARY KEY (id),
  CONSTRAINT fk_tfd_upload FOREIGN KEY (upload_id) REFERENCES public.trial_balance_uploads(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tfd_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tfd_certification FOREIGN KEY (certification_id) REFERENCES public.tb_certifications(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tfd_action FOREIGN KEY (code, action) REFERENCES public.tb_decision_actions(code, action),
  CONSTRAINT fk_tfd_member FOREIGN KEY (firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  CONSTRAINT uq_tfd_revision UNIQUE (upload_id, finding_key, revision),
  CONSTRAINT uq_tfd_request UNIQUE (company_id, request_id),
  CONSTRAINT chk_tfd_key CHECK (finding_key = code || ':' || subject),
  CONSTRAINT chk_tfd_subject CHECK (length(subject) BETWEEN 1 AND 500),
  CONSTRAINT chk_tfd_revision CHECK (revision > 0),
  CONSTRAINT chk_tfd_payload CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8000),
  CONSTRAINT chk_tfd_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT chk_tfd_hashes CHECK (source_file_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_tfd_actor CHECK ((actor_type = 'user' AND firm_member_id IS NOT NULL) OR (actor_type = 'workspace_user' AND firm_member_id IS NULL))
);
CREATE INDEX idx_tfd_upload ON public.tb_finding_decisions (upload_id, finding_key, revision DESC);
COMMENT ON TABLE public.tb_finding_decisions IS
  'Append-only decisions about trial-balance findings: bound to the certification, source hash, layout revision and (entity findings) entity revision they were made under, the finding''s server-checked identity (code + subject) and the actor. Written only by record_tb_finding_decision.';

CREATE OR REPLACE FUNCTION public.tb_decision_records_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF coalesce(current_setting('axiom.tb_decision_writer', true), '') <> txid_current()::text THEN
      RAISE EXCEPTION 'DECISION_RECORD_FENCED: % rows are written only by the decision functions', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- tb_investigations: a running reservation may be closed (completed, failed or abandoned) by the fenced functions only.
  -- (Nested: the row's fields are read only for that table.)
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'tb_investigations'
     AND coalesce(current_setting('axiom.tb_decision_writer', true), '') = txid_current()::text THEN
    IF to_jsonb(OLD)->>'status' = 'running' AND to_jsonb(NEW)->>'status' IN ('completed', 'failed', 'abandoned')
       AND (to_jsonb(NEW) - ARRAY['status', 'result', 'error_code', 'completed_at']) = (to_jsonb(OLD) - ARRAY['status', 'result', 'error_code', 'completed_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Iron Dome: % is append-only. % is not permitted.', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.tb_decision_records_fence() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_tfd_fence BEFORE INSERT OR UPDATE OR DELETE ON public.tb_finding_decisions
  FOR EACH ROW EXECUTE FUNCTION public.tb_decision_records_fence();
CREATE TRIGGER trg_tfd_no_truncate BEFORE TRUNCATE ON public.tb_finding_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.tb_decision_records_fence();
CREATE TRIGGER trg_tfp_fence BEFORE INSERT OR UPDATE OR DELETE ON public.tb_finding_policies
  FOR EACH ROW EXECUTE FUNCTION public.tb_decision_records_fence();
CREATE TRIGGER trg_tfp_no_truncate BEFORE TRUNCATE ON public.tb_finding_policies
  FOR EACH STATEMENT EXECUTE FUNCTION public.tb_decision_records_fence();
ALTER TABLE public.tb_finding_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tb_finding_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_finding_decisions, public.tb_finding_policies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tb_finding_decisions, public.tb_finding_policies TO authenticated, service_role;
CREATE POLICY tfd_workspace_read ON public.tb_finding_decisions FOR SELECT TO authenticated
  USING (public.can_access_workspace(company_id));
CREATE POLICY tfp_workspace_read ON public.tb_finding_policies FOR SELECT TO authenticated
  USING (public.can_access_workspace(company_id));

ALTER TABLE public.tb_certification_invalidations DROP CONSTRAINT tb_certification_invalidations_reason_check;
ALTER TABLE public.tb_certification_invalidations
  ADD CONSTRAINT tb_certification_invalidations_reason_check CHECK (reason IN ('reprocess_requested', 'period_dates_completed', 'finding_decision'));

-- The context revisions a decision is bound to, as they stand now.
CREATE OR REPLACE FUNCTION public._tb_revision(p_scope text, p_key text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT r.revision FROM public.tb_dependency_revisions r WHERE r.scope = p_scope AND r.dep_key = p_key), 0);
$$;
REVOKE ALL ON FUNCTION public._tb_revision(text, text) FROM PUBLIC, anon, authenticated;

-- The decisions that apply to an upload NOW: its own newest decision per finding, made against its current source bytes,
-- under the current layout revision and — for an entity finding — the current entity revision. Anything else needs a new
-- decision. Nothing from another upload ever applies.
CREATE OR REPLACE FUNCTION public.tb_current_finding_decisions(p_upload_id uuid)
RETURNS TABLE (decision_id uuid, code text, subject text, action text, resolves boolean, revision integer, payload jsonb,
               reason text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH u AS (
    SELECT t.id, t.company_id, t.source_file_hash,
           public._tb_revision(t.company_id::text, '#layout_confirmation:' || t.id::text) AS layout_rev,
           public._tb_revision(t.company_id::text, '#entity') AS entity_rev
      FROM public.trial_balance_uploads t WHERE t.id = p_upload_id
  ), latest AS (
    SELECT DISTINCT ON (d.finding_key) d.*
      FROM public.tb_finding_decisions d JOIN u ON d.upload_id = u.id
     ORDER BY d.finding_key, d.revision DESC
  )
  SELECT l.id, l.code, l.subject, l.action, a.resolves, l.revision, l.payload, l.reason, l.created_at
    FROM latest l JOIN u ON true JOIN public.tb_decision_actions a ON a.code = l.code AND a.action = l.action
   WHERE l.source_file_hash = u.source_file_hash AND l.layout_revision = u.layout_rev
     AND (l.code <> 'ENTITY_NAME_DIFFERS' OR l.entity_revision = u.entity_rev);
$$;
REVOKE ALL ON FUNCTION public.tb_current_finding_decisions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_current_finding_decisions(uuid) TO service_role;

-- The browser's read: the current decisions of an upload the caller may see, the newest revision recorded for every
-- finding (the expected revision of the next decision, current or not) and the number of recorded decisions.
CREATE OR REPLACE FUNCTION public.get_tb_finding_decisions(p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_company uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('outcome', 'unauthenticated'); END IF;
  SELECT t.company_id INTO v_company FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_company IS NULL OR NOT public.can_access_workspace(v_company) THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  RETURN jsonb_build_object('outcome', 'ok',
    'decisions', coalesce((SELECT jsonb_agg(jsonb_build_object('decision_id', d.decision_id, 'code', d.code, 'subject', d.subject,
                     'action', d.action, 'resolves', d.resolves, 'revision', d.revision, 'payload', d.payload, 'reason', d.reason,
                     'created_at', d.created_at) ORDER BY d.code, d.subject)
                     FROM public.tb_current_finding_decisions(p_upload_id) d), '[]'::jsonb),
    'latest_revisions', coalesce((SELECT jsonb_agg(jsonb_build_object('code', x.code, 'subject', x.subject, 'revision', x.revision) ORDER BY x.code, x.subject)
                     FROM (SELECT DISTINCT ON (y.finding_key) y.code, y.subject, y.revision FROM public.tb_finding_decisions y
                            WHERE y.upload_id = p_upload_id ORDER BY y.finding_key, y.revision DESC) x), '[]'::jsonb),
    'recorded', (SELECT count(*) FROM public.tb_finding_decisions x WHERE x.upload_id = p_upload_id));
END;
$$;
REVOKE ALL ON FUNCTION public.get_tb_finding_decisions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tb_finding_decisions(uuid) TO authenticated;

-- Records one decision. Serialized with tb_begin_attempt and layout confirmations (the same per-upload lock).
CREATE OR REPLACE FUNCTION public.record_tb_finding_decision(
  p_upload_id uuid, p_certification_id uuid, p_code text, p_subject text, p_action text, p_payload jsonb, p_reason text,
  p_expected_revision integer, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.trial_balance_uploads%ROWTYPE;
  v_actor record;
  v_prior public.tb_finding_decisions%ROWTYPE;
  v_latest public.tb_finding_decisions%ROWTYPE;
  v_cur public.engine_runs%ROWTYPE;
  v_cert public.tb_certifications%ROWTYPE;
  v_finding jsonb;
  v_act public.tb_decision_actions%ROWTYPE;
  v_hash text;
  v_key text;
  v_id uuid;
  v_rev integer;
  v_entity_rev bigint;
  v_layout_rev bigint;
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'UNAUTHENTICATED'); END IF;
  IF p_upload_id IS NULL OR p_certification_id IS NULL OR p_code IS NULL OR p_subject IS NULL OR p_action IS NULL
     OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_request_id IS NULL OR length(p_subject) NOT BETWEEN 1 AND 500 OR octet_length(p_payload::text) > 8000 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'INVALID_REQUEST');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'REASON_REQUIRED');
  END IF;
  v_key := p_code || ':' || p_subject;
  v_hash := encode(sha256(convert_to(jsonb_build_object('upload', p_upload_id, 'certification', p_certification_id, 'code', p_code,
              'subject', p_subject, 'action', p_action, 'payload', p_payload, 'reason', btrim(p_reason),
              'expected', p_expected_revision)::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtext('tb_begin_attempt'), hashtext(p_upload_id::text));
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.company_id IS NULL OR NOT public.can_access_workspace(v_row.company_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_FOUND');
  END IF;
  -- The same request replays its recorded decision; the same request id with other content is a conflict.
  SELECT * INTO v_prior FROM public.tb_finding_decisions d WHERE d.company_id = v_row.company_id AND d.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.request_hash = v_hash AND v_prior.actor_user_id = v_uid THEN
      RETURN jsonb_build_object('outcome', 'recorded', 'decision_id', v_prior.id, 'revision', v_prior.revision, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED');
  END IF;
  SELECT * INTO v_actor FROM public._layout_actor(v_uid, v_row.company_id);
  IF v_actor.actor_type IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'FORBIDDEN'); END IF;
  IF v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_ACTIVE');
  END IF;
  IF v_row.current_engine_run_id IS NOT NULL THEN
    SELECT * INTO v_cur FROM public.engine_runs er WHERE er.id = v_row.current_engine_run_id;
    IF v_cur.status = 'running' AND v_cur.lease_expires_at > now() THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'IN_PROGRESS');
    END IF;
  END IF;
  -- Only the evaluation the person is looking at, and only while it is the upload's current one.
  SELECT * INTO v_cert FROM public.tb_certifications c WHERE c.upload_id = p_upload_id ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_cert.id IS DISTINCT FROM p_certification_id
     OR EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = v_cert.id)
     OR v_cert.source_file_hash IS DISTINCT FROM v_row.source_file_hash THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'STALE_EVALUATION', 'current_certification_id', v_cert.id);
  END IF;
  -- The finding's identity is the engine's, stored with the certification — never the caller's word.
  SELECT f.finding INTO v_finding FROM public.tb_certification_findings f
   WHERE f.certification_id = v_cert.id AND f.finding->>'code' = p_code AND f.finding->>'subject' = p_subject
   ORDER BY f.ordinal LIMIT 1;
  IF v_finding IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'FINDING_NOT_FOUND'); END IF;
  SELECT * INTO v_act FROM public.tb_decision_actions a WHERE a.code = p_code AND a.action = p_action;
  IF v_act.code IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'ACTION_NOT_AVAILABLE'); END IF;

  -- Required confirmations, per action (server-enforced; the browser only offers them).
  IF p_code = 'ENTITY_NAME_DIFFERS' THEN
    IF (p_payload->'confirmed') IS DISTINCT FROM 'true'::jsonb OR (p_payload->>'file_entity') IS DISTINCT FROM (v_finding->>'file_entity')
       OR (p_payload->>'workspace_entity') IS DISTINCT FROM (SELECT c.name FROM public.companies c WHERE c.id = v_row.company_id) THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'CONFIRMATION_REQUIRED');
    END IF;
  ELSIF p_code = 'UNRECOGNISED_TRAILING_TEXT' THEN
    SELECT coalesce(jsonb_agg(x ORDER BY x::text::integer), '[]'::jsonb) INTO v_rows
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload->'rows') = 'array' THEN p_payload->'rows' ELSE '[]'::jsonb END) x
     WHERE jsonb_typeof(x) = 'number';
    IF (p_payload->'confirmed') IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(v_finding->'rows') IS DISTINCT FROM 'array'
       OR v_rows IS DISTINCT FROM (SELECT coalesce(jsonb_agg(x ORDER BY x::text::integer), '[]'::jsonb) FROM jsonb_array_elements(v_finding->'rows') x)
       OR jsonb_array_length(v_rows) <> jsonb_array_length(p_payload->'rows') THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'CONFIRMATION_REQUIRED');
    END IF;
  ELSIF p_code = 'CLEARING_ACCOUNT_BALANCE' THEN
    IF (p_payload->>'nature') IS NULL OR (p_payload->>'nature') NOT IN ('in_transit', 'timing', 'other')
       OR length(btrim(coalesce(p_payload->>'explanation', ''))) NOT BETWEEN 10 AND 1000
       OR jsonb_typeof(p_payload->'evidence') IS DISTINCT FROM 'object'
       OR (p_payload->'evidence'->>'kind') IS NULL OR (p_payload->'evidence'->>'kind') NOT IN ('reconciliation', 'document')
       OR length(btrim(coalesce(p_payload->'evidence'->>'reference', ''))) NOT BETWEEN 3 AND 200 THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'EVIDENCE_REQUIRED');
    END IF;
  END IF;

  v_layout_rev := public._tb_revision(v_row.company_id::text, '#layout_confirmation:' || p_upload_id::text);
  v_entity_rev := public._tb_revision(v_row.company_id::text, '#entity');
  SELECT * INTO v_latest FROM public.tb_finding_decisions d WHERE d.upload_id = p_upload_id AND d.finding_key = v_key
   ORDER BY d.revision DESC LIMIT 1;
  IF coalesce(v_latest.revision, 0) <> p_expected_revision THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'VERSION_CONFLICT', 'current_revision', coalesce(v_latest.revision, 0));
  END IF;
  -- The same decision, still current in the same context, is unchanged; under a changed context it is recorded again.
  IF v_latest.id IS NOT NULL AND v_latest.action = p_action AND v_latest.payload = p_payload
     AND v_latest.source_file_hash = v_row.source_file_hash AND v_latest.layout_revision = v_layout_rev
     AND (p_code <> 'ENTITY_NAME_DIFFERS' OR v_latest.entity_revision = v_entity_rev) THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'decision_id', v_latest.id, 'revision', v_latest.revision);
  END IF;

  v_rev := coalesce(v_latest.revision, 0) + 1;
  PERFORM set_config('axiom.tb_decision_writer', txid_current()::text, true);
  INSERT INTO public.tb_finding_decisions (upload_id, company_id, certification_id, code, subject, finding_key, action, revision,
                                           payload, reason, source_file_hash, layout_revision, entity_revision, request_id,
                                           request_hash, actor_type, firm_member_id, actor_user_id)
  VALUES (p_upload_id, v_row.company_id, v_cert.id, p_code, p_subject, v_key, p_action, v_rev, p_payload, btrim(p_reason),
          v_row.source_file_hash, v_layout_rev, v_entity_rev, p_request_id, v_hash, v_actor.actor_type,
          CASE WHEN v_actor.actor_type = 'user' THEN v_actor.firm_member_id END, v_uid)
  RETURNING id INTO v_id;
  PERFORM set_config('axiom.tb_decision_writer', '', true);
  -- Immediately: the evaluation it was made against is no longer authoritative, and nothing built without it can be.
  INSERT INTO public.tb_certification_invalidations (certification_id, company_id, upload_id, reason, operation_id, actor_user_id)
  VALUES (v_cert.id, v_cert.company_id, v_cert.upload_id, 'finding_decision', v_id, v_uid);
  PERFORM public._tb_bump_dependency(v_row.company_id::text, '#finding_decisions:' || p_upload_id::text);
  RETURN jsonb_build_object('outcome', 'recorded', 'decision_id', v_id, 'revision', v_rev, 'invalidated_certification_id', v_cert.id);
END;
$$;
REVOKE ALL ON FUNCTION public.record_tb_finding_decision(uuid, uuid, text, text, text, jsonb, text, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_tb_finding_decision(uuid, uuid, text, text, text, jsonb, text, integer, uuid) TO authenticated;

-- ── 4. The entity dependency ─────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tb_dependency_bump_entity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.code IS DISTINCT FROM OLD.code OR NEW.tin IS DISTINCT FROM OLD.tin THEN
    PERFORM public._tb_bump_dependency(NEW.id::text, '#entity');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tb_dependency_bump_entity() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_companies_bump_entity AFTER UPDATE OF name, code, tin ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.tb_dependency_bump_entity();


-- ── 5. Investigations ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.tb_investigations (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  upload_id        uuid        NOT NULL,
  company_id       uuid        NOT NULL,
  certification_id uuid        NOT NULL,
  source_file_hash text        NOT NULL,
  request_id       uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'running',
  lease_expires_at timestamptz NOT NULL,
  result           jsonb       NULL,
  error_code       text        NULL,
  actor_type       text        NOT NULL,
  firm_member_id   uuid        NULL,
  actor_user_id    uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz NULL,
  CONSTRAINT tb_investigations_pkey PRIMARY KEY (id),
  CONSTRAINT fk_tbi_upload FOREIGN KEY (upload_id) REFERENCES public.trial_balance_uploads(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tbi_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tbi_certification FOREIGN KEY (certification_id) REFERENCES public.tb_certifications(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tbi_member FOREIGN KEY (firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  CONSTRAINT uq_tbi_request UNIQUE (upload_id, request_id),
  CONSTRAINT chk_tbi_status CHECK (status IN ('running', 'completed', 'failed', 'abandoned')),
  CONSTRAINT chk_tbi_hash CHECK (source_file_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_tbi_result CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 200000)),
  CONSTRAINT chk_tbi_closed CHECK ((status = 'running') = (completed_at IS NULL)
                                   AND (status <> 'completed' OR result IS NOT NULL)
                                   AND (status <> 'failed' OR error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'))
);
-- The durable reservation: at most one running investigation per upload.
CREATE UNIQUE INDEX uq_tbi_one_running ON public.tb_investigations (upload_id) WHERE status = 'running';
CREATE INDEX idx_tbi_certification ON public.tb_investigations (certification_id, created_at DESC);
COMMENT ON TABLE public.tb_investigations IS
  'Imbalance investigations: a durable reservation (one running per upload, uq_tbi_one_running) with a lease; closed only by the fenced functions. Results are bounded leads about the file, never adjustments.';
CREATE TRIGGER trg_tbi_fence BEFORE INSERT OR UPDATE OR DELETE ON public.tb_investigations
  FOR EACH ROW EXECUTE FUNCTION public.tb_decision_records_fence();
CREATE TRIGGER trg_tbi_no_truncate BEFORE TRUNCATE ON public.tb_investigations
  FOR EACH STATEMENT EXECUTE FUNCTION public.tb_decision_records_fence();
ALTER TABLE public.tb_investigations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_investigations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tb_investigations TO authenticated, service_role;
CREATE POLICY tbi_workspace_read ON public.tb_investigations FOR SELECT TO authenticated
  USING (public.can_access_workspace(company_id));

-- The reader's own rows, stored ONCE per investigation (never re-parsed for a page): every row the reader saw, whether it
-- was included as an account or excluded (and why), where it is in the file, and its exact parsed amounts in minor units.
CREATE TABLE public.tb_investigation_rows (
  investigation_id uuid    NOT NULL,
  ordinal          integer NOT NULL,
  row_number       integer NOT NULL,
  included         boolean NOT NULL,
  disposition      text    NOT NULL,
  account_code     text    NULL,
  account_name     text    NULL,
  debit_minor      numeric NULL,
  credit_minor     numeric NULL,
  reason           text    NULL,
  CONSTRAINT tb_investigation_rows_pkey PRIMARY KEY (investigation_id, ordinal),
  CONSTRAINT fk_tbir_investigation FOREIGN KEY (investigation_id) REFERENCES public.tb_investigations(id) ON DELETE RESTRICT,
  CONSTRAINT chk_tbir_ordinal CHECK (ordinal > 0 AND row_number > 0),
  CONSTRAINT chk_tbir_disposition CHECK (disposition IN ('preamble', 'header', 'blank', 'heading', 'total', 'zero_balance', 'account', 'rejected')),
  CONSTRAINT chk_tbir_amounts CHECK ((debit_minor IS NULL OR debit_minor = trunc(debit_minor)) AND (credit_minor IS NULL OR credit_minor = trunc(credit_minor))),
  CONSTRAINT chk_tbir_text CHECK (length(coalesce(account_code, '')) <= 200 AND length(coalesce(account_name, '')) <= 500 AND length(coalesce(reason, '')) <= 500)
);
CREATE INDEX idx_tbir_included ON public.tb_investigation_rows (investigation_id, included, ordinal);
COMMENT ON TABLE public.tb_investigation_rows IS
  'Rows of one investigation as the processing reader saw them (included/excluded, source row, exact minor amounts). Written once, by the running reservation only; read page by page through get_tb_investigation_rows.';
CREATE OR REPLACE FUNCTION public.tb_investigation_rows_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND coalesce(current_setting('axiom.tb_decision_writer', true), '') = txid_current()::text THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Iron Dome: tb_investigation_rows is written once by the investigation functions. % is not permitted.', TG_OP USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.tb_investigation_rows_fence() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_tbir_fence BEFORE INSERT OR UPDATE OR DELETE ON public.tb_investigation_rows
  FOR EACH ROW EXECUTE FUNCTION public.tb_investigation_rows_fence();
CREATE TRIGGER trg_tbir_no_truncate BEFORE TRUNCATE ON public.tb_investigation_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.tb_investigation_rows_fence();
ALTER TABLE public.tb_investigation_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_investigation_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tb_investigation_rows TO service_role;

-- Reserves (or answers) an investigation of the upload's current, blocking, out-of-balance evaluation. Called by the
-- trial-balance-layout function with the signed-in user; the actor is derived here.
CREATE OR REPLACE FUNCTION public.tb_investigation_reserve(p_user_id uuid, p_upload_id uuid, p_certification_id uuid,
  p_request_id uuid, p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_actor record;
  v_cert public.tb_certifications%ROWTYPE;
  v_inv public.tb_investigations%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_upload_id IS NULL OR p_certification_id IS NULL OR p_request_id IS NULL
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tb_investigation'), hashtext(p_upload_id::text));
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_row.id IS NULL OR v_row.company_id IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_FOUND'); END IF;
  SELECT * INTO v_actor FROM public._layout_actor(p_user_id, v_row.company_id);
  IF v_actor.actor_type IS NULL THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'FORBIDDEN'); END IF;
  -- The same request: its investigation as it stands.
  SELECT * INTO v_inv FROM public.tb_investigations i WHERE i.upload_id = p_upload_id AND i.request_id = p_request_id;
  IF v_inv.id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', v_inv.status, 'investigation_id', v_inv.id, 'result', v_inv.result, 'error_code', v_inv.error_code,
                              'replay', true);
  END IF;
  SELECT * INTO v_cert FROM public.tb_certifications c WHERE c.upload_id = p_upload_id ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_cert.id IS DISTINCT FROM p_certification_id
     OR EXISTS (SELECT 1 FROM public.tb_certification_invalidations x WHERE x.certification_id = v_cert.id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'STALE_EVALUATION', 'current_certification_id', v_cert.id);
  END IF;
  IF NOT v_cert.is_blocking OR NOT EXISTS (SELECT 1 FROM public.tb_certification_findings f
                                            WHERE f.certification_id = v_cert.id AND f.finding->>'code' = 'TRIAL_BALANCE_IMBALANCE') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'NOT_APPLICABLE');
  END IF;
  -- A completed investigation of this evaluation is the answer (computed once).
  SELECT * INTO v_inv FROM public.tb_investigations i WHERE i.certification_id = v_cert.id AND i.status = 'completed'
   ORDER BY i.created_at DESC LIMIT 1;
  IF v_inv.id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'completed', 'investigation_id', v_inv.id, 'result', v_inv.result);
  END IF;
  -- One running at a time; an expired reservation is abandoned (its worker is then fenced out at completion).
  SELECT * INTO v_inv FROM public.tb_investigations i WHERE i.upload_id = p_upload_id AND i.status = 'running' FOR UPDATE;
  IF v_inv.id IS NOT NULL THEN
    IF v_inv.lease_expires_at > now() THEN
      RETURN jsonb_build_object('outcome', 'in_progress', 'investigation_id', v_inv.id);
    END IF;
    PERFORM set_config('axiom.tb_decision_writer', txid_current()::text, true);
    UPDATE public.tb_investigations i SET status = 'abandoned', completed_at = now() WHERE i.id = v_inv.id;
  END IF;
  PERFORM set_config('axiom.tb_decision_writer', txid_current()::text, true);
  INSERT INTO public.tb_investigations (upload_id, company_id, certification_id, source_file_hash, request_id, lease_expires_at,
                                        actor_type, firm_member_id, actor_user_id)
  VALUES (p_upload_id, v_row.company_id, v_cert.id, v_cert.source_file_hash, p_request_id, now() + make_interval(secs => p_lease_seconds),
          v_actor.actor_type, CASE WHEN v_actor.actor_type = 'user' THEN v_actor.firm_member_id END, p_user_id)
  RETURNING id INTO v_id;
  PERFORM set_config('axiom.tb_decision_writer', '', true);
  RETURN jsonb_build_object('outcome', 'reserved', 'investigation_id', v_id, 'source_file_hash', v_cert.source_file_hash,
                            'file_path', v_row.file_path);
END;
$$;
REVOKE ALL ON FUNCTION public.tb_investigation_reserve(uuid, uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_investigation_reserve(uuid, uuid, uuid, uuid, integer) TO service_role;

-- Appends the next rows of a running reservation: at most 2,000 per call, ordinals contiguous from the stored count,
-- 20,000 in all. A worker whose reservation was abandoned is refused.
CREATE OR REPLACE FUNCTION public.tb_investigation_add_rows(p_investigation_id uuid, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_inv public.tb_investigations%ROWTYPE;
  v_have integer;
  v_n integer;
BEGIN
  IF p_investigation_id IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'INVALID_ROWS' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_inv FROM public.tb_investigations i WHERE i.id = p_investigation_id;
  IF v_inv.id IS NULL THEN RAISE EXCEPTION 'INVESTIGATION_NOT_CURRENT' USING ERRCODE = 'PT409'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tb_investigation'), hashtext(v_inv.upload_id::text));
  SELECT * INTO v_inv FROM public.tb_investigations i WHERE i.id = p_investigation_id FOR UPDATE;
  IF v_inv.status <> 'running' THEN RAISE EXCEPTION 'INVESTIGATION_NOT_CURRENT' USING ERRCODE = 'PT409'; END IF;
  SELECT count(*) INTO v_have FROM public.tb_investigation_rows r WHERE r.investigation_id = p_investigation_id;
  v_n := jsonb_array_length(p_rows);
  IF v_have + v_n > 20000 THEN RAISE EXCEPTION 'INVESTIGATION_TOO_LARGE' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) WITH ORDINALITY x(r, o)
              WHERE jsonb_typeof(r) <> 'object' OR jsonb_typeof(r->'ordinal') IS DISTINCT FROM 'number'
                 OR (r->>'ordinal')::integer <> v_have + o::integer
                 OR jsonb_typeof(r->'row_number') IS DISTINCT FROM 'number' OR jsonb_typeof(r->'included') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'INVALID_ROWS' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('axiom.tb_decision_writer', txid_current()::text, true);
  INSERT INTO public.tb_investigation_rows (investigation_id, ordinal, row_number, included, disposition, account_code, account_name,
                                            debit_minor, credit_minor, reason)
  SELECT p_investigation_id, (r->>'ordinal')::integer, (r->>'row_number')::integer, (r->>'included')::boolean, r->>'disposition',
         r->>'account_code', r->>'account_name', (r->>'debit_minor')::numeric, (r->>'credit_minor')::numeric, r->>'reason'
    FROM jsonb_array_elements(p_rows) r;
  PERFORM set_config('axiom.tb_decision_writer', '', true);
  RETURN jsonb_build_object('stored', v_have + v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.tb_investigation_add_rows(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_investigation_add_rows(uuid, jsonb) TO service_role;

-- Closes the caller's reservation. A worker whose reservation was abandoned (lease expired, taken over) is refused.
CREATE OR REPLACE FUNCTION public.tb_investigation_complete(p_investigation_id uuid, p_status text, p_result jsonb, p_error_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_inv public.tb_investigations%ROWTYPE;
BEGIN
  IF p_investigation_id IS NULL OR p_status NOT IN ('completed', 'failed')
     OR (p_status = 'completed' AND (p_result IS NULL OR jsonb_typeof(p_result) <> 'object' OR octet_length(p_result::text) > 200000
         OR jsonb_typeof(p_result->'leads') IS DISTINCT FROM 'array' OR jsonb_array_length(p_result->'leads') > 50))
     OR (p_status = 'failed' AND (p_error_code IS NULL OR p_error_code !~ '^[A-Z][A-Z0-9_]{2,63}$')) THEN
    RAISE EXCEPTION 'INVALID_RESULT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_inv FROM public.tb_investigations i WHERE i.id = p_investigation_id;
  IF v_inv.id IS NULL THEN RAISE EXCEPTION 'INVESTIGATION_NOT_CURRENT' USING ERRCODE = 'PT409'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tb_investigation'), hashtext(v_inv.upload_id::text));
  SELECT * INTO v_inv FROM public.tb_investigations i WHERE i.id = p_investigation_id FOR UPDATE;
  IF v_inv.status <> 'running' THEN RAISE EXCEPTION 'INVESTIGATION_NOT_CURRENT' USING ERRCODE = 'PT409'; END IF;
  -- A completed investigation states how many rows it stored, and they must all be there.
  IF p_status = 'completed' AND (jsonb_typeof(p_result->'row_count') IS DISTINCT FROM 'number'
       OR (p_result->>'row_count')::integer <> (SELECT count(*) FROM public.tb_investigation_rows r WHERE r.investigation_id = p_investigation_id)) THEN
    RAISE EXCEPTION 'INVALID_RESULT: the stored rows do not match the result' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('axiom.tb_decision_writer', txid_current()::text, true);
  UPDATE public.tb_investigations i
     SET status = p_status, result = CASE WHEN p_status = 'completed' THEN p_result END,
         error_code = CASE WHEN p_status = 'failed' THEN p_error_code END, completed_at = now()
   WHERE i.id = p_investigation_id;
  PERFORM set_config('axiom.tb_decision_writer', '', true);
  RETURN jsonb_build_object('outcome', p_status, 'investigation_id', p_investigation_id);
END;
$$;
REVOKE ALL ON FUNCTION public.tb_investigation_complete(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_investigation_complete(uuid, text, jsonb, text) TO service_role;

-- One page of a completed investigation's stored rows (never a new parse): 'all', 'included' or 'excluded', after an
-- ordinal, at most 200; for someone who may see the workspace.
CREATE OR REPLACE FUNCTION public.get_tb_investigation_rows(p_investigation_id uuid, p_filter text, p_after integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_inv public.tb_investigations%ROWTYPE;
  v_limit integer := coalesce(p_limit, 50);
  v_page jsonb;
  v_more boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('outcome', 'unauthenticated'); END IF;
  IF p_filter IS NULL OR p_filter NOT IN ('all', 'included', 'excluded') OR v_limit NOT BETWEEN 1 AND 200 OR coalesce(p_after, 0) < 0 THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'INVALID_REQUEST');
  END IF;
  SELECT * INTO v_inv FROM public.tb_investigations i WHERE i.id = p_investigation_id;
  IF v_inv.id IS NULL OR NOT public.can_access_workspace(v_inv.company_id) THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_inv.status <> 'completed' THEN RETURN jsonb_build_object('outcome', 'refused', 'code', 'NOT_COMPLETED'); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('ordinal', r.ordinal, 'row_number', r.row_number, 'included', r.included,
           'disposition', r.disposition, 'account_code', r.account_code, 'account_name', r.account_name,
           'debit_minor', r.debit_minor::text, 'credit_minor', r.credit_minor::text, 'reason', r.reason) ORDER BY r.ordinal), '[]'::jsonb)
    INTO v_page
    FROM (SELECT * FROM public.tb_investigation_rows r
           WHERE r.investigation_id = p_investigation_id AND r.ordinal > coalesce(p_after, 0)
             AND (p_filter = 'all' OR r.included = (p_filter = 'included'))
           ORDER BY r.ordinal LIMIT v_limit) r;
  v_more := jsonb_array_length(v_page) = v_limit AND EXISTS (
    SELECT 1 FROM public.tb_investigation_rows r WHERE r.investigation_id = p_investigation_id
       AND r.ordinal > (v_page->(v_limit - 1)->>'ordinal')::integer AND (p_filter = 'all' OR r.included = (p_filter = 'included')));
  RETURN jsonb_build_object('outcome', 'ok', 'rows', v_page,
    'next_after', CASE WHEN v_more THEN (v_page->(v_limit - 1)->>'ordinal')::integer END,
    'total', (SELECT count(*) FROM public.tb_investigation_rows r WHERE r.investigation_id = p_investigation_id
               AND (p_filter = 'all' OR r.included = (p_filter = 'included'))));
END;
$$;
REVOKE ALL ON FUNCTION public.get_tb_investigation_rows(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tb_investigation_rows(uuid, text, integer, integer) TO authenticated;

-- ── 6. The attempt functions — each its 20261107100000 definition with exactly the marked [20261118100000] lines ─────
CREATE OR REPLACE FUNCTION public.tb_snapshot_dependencies(p_engine_run_id uuid, p_keys jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_run public.engine_runs%ROWTYPE;
  r record;
  v_n integer := 0;
BEGIN
  IF p_keys IS NULL OR jsonb_typeof(p_keys) <> 'array' OR jsonb_array_length(p_keys) = 0 OR jsonb_array_length(p_keys) > 20000 THEN
    RAISE EXCEPTION 'INVALID_DEPENDENCIES' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.engine_runs er WHERE er.id = p_engine_run_id;
  IF v_run.id IS NULL OR v_run.attempt_no IS NULL OR v_run.status <> 'running'
     OR NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t WHERE t.id = v_run.source_record_id AND t.current_engine_run_id = v_run.id) THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_CURRENT' USING ERRCODE = 'PT409';
  END IF;
  IF EXISTS (SELECT 1 FROM public.engine_run_dependencies d WHERE d.engine_run_id = p_engine_run_id) THEN
    RAISE EXCEPTION 'DEPENDENCIES_ALREADY_RECORDED' USING ERRCODE = '55000';
  END IF;
  -- Each entry must be this company's scope or the shared scope, with a known key form.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_keys) e
              WHERE jsonb_typeof(e) <> 'object' OR (e->>'scope') IS NULL OR (e->>'key') IS NULL
                 OR (e->>'scope') NOT IN (v_run.company_id::text, 'global')
                 OR (e->>'key') !~ '^(code:.+|name:.*|#framework|#currency|#dictionary|#layout_confirmation:[0-9a-f-]{36}|#entity|#finding_policy|#finding_decisions:[0-9a-f-]{36})$' -- [20261118100000] three keys
                 -- A2: the layout key names the run's own upload, in the company's scope.
                 OR ((e->>'key') LIKE '#layout_confirmation:%' AND ((e->>'scope') <> v_run.company_id::text
                      OR substring(e->>'key' FROM 22) <> v_run.source_record_id::text))
                 -- [20261118100000] the decisions key names the run's own upload; the entity keys are company scope.
                 OR ((e->>'key') LIKE '#finding_decisions:%' AND ((e->>'scope') <> v_run.company_id::text
                      OR substring(e->>'key' FROM 20) <> v_run.source_record_id::text))
                 OR ((e->>'key') IN ('#entity', '#finding_policy') AND (e->>'scope') <> v_run.company_id::text)) THEN -- [/20261118100000]
    RAISE EXCEPTION 'INVALID_DEPENDENCIES' USING ERRCODE = '22023';
  END IF;
  -- L2: the review RPC's per-account advisory lock (company scope), in sorted order, so a review in flight on the same
  -- account completes first. Shared-chart keys are not written by the review RPC.
  -- [20261107100000] Only up to tb_dependency_lock_limit() keys: the locks reduce retries, they do not carry correctness
  -- (every key is still recorded below and compared at finalize and at read time).
  IF (SELECT count(DISTINCT substring(e->>'key' FROM 6)) FROM jsonb_array_elements(p_keys) e
       WHERE e->>'scope' = v_run.company_id::text AND (e->>'key' LIKE 'code:%' OR e->>'key' LIKE 'name:%')) <= public.tb_dependency_lock_limit() THEN
  FOR r IN
    SELECT DISTINCT substring(e->>'key' FROM 6) AS k
      FROM jsonb_array_elements(p_keys) e
     WHERE e->>'scope' = v_run.company_id::text AND (e->>'key' LIKE 'code:%' OR e->>'key' LIKE 'name:%')
     ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_run.company_id::text), hashtext(r.k));
  END LOOP;
  END IF; -- [/20261107100000]
  INSERT INTO public.engine_run_dependencies (engine_run_id, scope, dep_key, revision)
  SELECT DISTINCT ON (e->>'scope', e->>'key') p_engine_run_id, e->>'scope', e->>'key', coalesce(rv.revision, 0)
    FROM jsonb_array_elements(p_keys) e
    LEFT JOIN public.tb_dependency_revisions rv ON rv.scope = e->>'scope' AND rv.dep_key = e->>'key'
   ORDER BY e->>'scope', e->>'key';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('recorded', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.tb_snapshot_dependencies(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_snapshot_dependencies(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.tb_begin_attempt(
  p_upload_id uuid, p_client_request_id uuid, p_request_hash text, p_input_hash text, p_source_file_hash text,
  p_engine_version text, p_engine_generation integer, p_actor_type text, p_firm_member_id uuid, p_actor_user_id uuid,
  p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_key public.idempotency_keys%ROWTYPE;
  v_cur public.engine_runs%ROWTYPE;
  v_cert uuid;
  v_run uuid;
  v_started timestamptz;
  v_key_id uuid;
  v_attempt integer;
  v_constraint text;
BEGIN
  IF p_upload_id IS NULL OR p_client_request_id IS NULL OR p_request_hash IS NULL OR p_engine_version IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  IF p_source_file_hash IS NULL OR p_source_file_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'INVALID_LEASE' USING ERRCODE = '22023';
  END IF;

  -- L1: one begin per upload at a time.
  PERFORM pg_advisory_xact_lock(hashtext('tb_begin_attempt'), hashtext(p_upload_id::text));

  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_FOUND');
  END IF;
  IF v_row.company_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'COMPANY_REQUIRED');
  END IF;
  -- A2: an engine generation below 4 cannot read layout confirmations, so it never processes an upload that has one
  -- (refused here, before anything is written).
  IF coalesce(p_engine_generation, 0) < 4 AND EXISTS (SELECT 1 FROM public.layout_confirmations lc WHERE lc.upload_id = p_upload_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'LAYOUT_REQUIRES_CURRENT_ENGINE');
  END IF;
  -- [20261118100000] An engine below generation 7 cannot read finding decisions, and one newer than this database is not
  -- understood by tb_finalize_attempt: both are refused here, before anything is written.
  IF coalesce(p_engine_generation, 0) < 7 AND EXISTS (SELECT 1 FROM public.tb_finding_decisions d WHERE d.upload_id = p_upload_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'DECISIONS_REQUIRE_CURRENT_ENGINE');
  END IF;
  IF p_engine_generation > public.tb_max_engine_generation() THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'ENGINE_GENERATION_UNSUPPORTED');
  END IF;
  -- [/20261118100000]

  -- Idempotency: the same request replays its recorded outcome; reuse with other content is a conflict.
  SELECT * INTO v_key FROM public.idempotency_keys k
   WHERE k.company_id = v_row.company_id AND k.function_name = 'process-trial-balance'
     AND k.client_request_id = p_client_request_id
     AND k.firm_member_id IS NOT DISTINCT FROM p_firm_member_id AND k.actor_user_id IS NOT DISTINCT FROM p_actor_user_id;
  IF v_key.id IS NOT NULL THEN
    IF v_key.request_hash IS DISTINCT FROM p_request_hash THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED');
    END IF;
    IF v_key.status = 'reserved' THEN
      -- [20261107100000] A worker killed mid-check leaves its own request reserved. Once that attempt's lease has
      -- expired, the same request abandons it (upload locked first, then the run: tb_expire_attempts' order) and is
      -- answered as a run that did not finish — never "in progress" forever. A new request then checks the file.
      IF EXISTS (SELECT 1 FROM public.engine_runs er WHERE er.id = v_key.engine_run_id AND er.status = 'running'
                    AND er.lease_expires_at <= now()) THEN
        PERFORM 1 FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
        IF public._tb_abandon_run(v_key.engine_run_id, 'LEASE_EXPIRED') THEN
          PERFORM public._tb_attempt_writer(false);
          RETURN jsonb_build_object('outcome', 'replay', 'result', jsonb_build_object('status', 'failed', 'error_code', 'LEASE_EXPIRED'));
        END IF;
      END IF;
      -- [/20261107100000]
      RETURN jsonb_build_object('outcome', 'in_progress', 'engine_run_id', v_key.engine_run_id);
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'result', coalesce(v_key.replay_result, jsonb_build_object('status', v_key.status)));
  END IF;

  -- L4: the upload.
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
  IF v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_ACTIVE');
  END IF;
  IF v_row.source_file_hash IS NOT NULL AND v_row.source_file_hash IS DISTINCT FROM p_source_file_hash THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'SOURCE_CHANGED');
  END IF;
  -- A new attempt never runs over a certification still in force: re-checks go through tbu_request_reprocess first.
  SELECT c.id INTO v_cert FROM public.tb_certifications c WHERE c.upload_id = p_upload_id ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_cert IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = v_cert) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'REPROCESS_REQUIRED');
  END IF;
  -- L7: the current attempt, if one is running.
  IF v_row.current_engine_run_id IS NOT NULL THEN
    SELECT * INTO v_cur FROM public.engine_runs er WHERE er.id = v_row.current_engine_run_id FOR UPDATE;
    IF v_cur.status = 'running' THEN
      IF v_cur.lease_expires_at > now() THEN
        RETURN jsonb_build_object('outcome', 'refused', 'code', 'IN_PROGRESS', 'engine_run_id', v_cur.id);
      END IF;
      PERFORM public._tb_abandon_run(v_cur.id, 'LEASE_EXPIRED');
    END IF;
  END IF;

  PERFORM public._tb_attempt_writer(true);
  v_attempt := v_row.processing_attempt + 1;
  -- The run, its key and the upload's pointer are one unit: the same request id claimed concurrently for ANOTHER upload
  -- (the per-upload lock above does not serialize that) loses on uq_ik_claim and is a recorded conflict, with nothing left
  -- behind — never a raw error.
  BEGIN
    INSERT INTO public.engine_runs (company_id, firm_member_id, actor_user_id, actor_type, function_name, engine_version,
                                    engine_generation, input_hash, period_year, source_table, source_record_id, attempt_no,
                                    lease_expires_at)
    VALUES (v_row.company_id, p_firm_member_id, p_actor_user_id, p_actor_type, 'process-trial-balance', p_engine_version,
            p_engine_generation, p_input_hash, v_row.period_year, 'trial_balance_uploads', p_upload_id, v_attempt,
            now() + make_interval(secs => p_lease_seconds))
    RETURNING id, started_at INTO v_run, v_started;
    INSERT INTO public.idempotency_keys (company_id, firm_member_id, actor_user_id, actor_type, function_name,
                                         client_request_id, request_hash, input_hash, engine_run_id)
    VALUES (v_row.company_id, p_firm_member_id, p_actor_user_id, p_actor_type, 'process-trial-balance',
            p_client_request_id, p_request_hash, p_input_hash, v_run)
    RETURNING id INTO v_key_id;
    UPDATE public.trial_balance_uploads t
       SET current_engine_run_id = v_run, processing_attempt = v_attempt, status = 'validating',
           source_file_hash = coalesce(t.source_file_hash, p_source_file_hash)
     WHERE t.id = p_upload_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'uq_ik_claim' THEN RAISE; END IF;
    PERFORM public._tb_attempt_writer(false);
    RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED');
  END;
  PERFORM public._tb_attempt_writer(false);

  RETURN jsonb_build_object('outcome', 'claimed', 'engine_run_id', v_run, 'key_id', v_key_id, 'started_at', v_started,
                            'attempt_no', v_attempt, 'prior_status', v_row.status);
END;
$$;
REVOKE ALL ON FUNCTION public.tb_begin_attempt(uuid, uuid, text, text, text, text, integer, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_begin_attempt(uuid, uuid, text, text, text, text, integer, text, uuid, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.tb_finalize_attempt(p_engine_run_id uuid, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_upload_id uuid;
  v_row public.trial_balance_uploads%ROWTYPE;
  v_run public.engine_runs%ROWTYPE;
  v_outcome text := p_result->>'outcome';
  v_up jsonb := p_result->'upload';
  v_c jsonb := p_result->'certification';
  v_code text := p_result->>'error_code';
  v_cert uuid;
  -- [20261107100000]
  v_exc jsonb;
  v_findings jsonb;
  v_findings_count integer;
  v_findings_sha text;
  v_summarized boolean;
  -- [/20261107100000]
  -- [20261118100000]
  v_gen integer;
  v_eval jsonb;
  v_rules text[];
  -- [/20261118100000]
BEGIN
  IF v_outcome IS NULL OR v_outcome NOT IN ('certified', 'failed') OR jsonb_typeof(v_up) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_up->'status') IS DISTINCT FROM 'string' OR jsonb_typeof(v_up->'is_valid') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'INVALID_RESULT' USING ERRCODE = '22023';
  END IF;
  IF v_outcome = 'failed' AND (v_code IS NULL OR v_code !~ '^[A-Z][A-Z0-9_]{2,63}$') THEN
    RAISE EXCEPTION 'INVALID_RESULT: a failure needs an error code' USING ERRCODE = '22023';
  END IF;
  IF v_outcome = 'certified' AND (jsonb_typeof(v_c) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_c->'is_blocking') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_c->'requires_review') IS DISTINCT FROM 'boolean'
       OR (v_c->>'normalized_input_hash') IS NULL OR (v_c->>'output_hash') IS NULL) THEN
    RAISE EXCEPTION 'INVALID_RESULT: a certification is incomplete' USING ERRCODE = '22023';
  END IF;

  -- [20261107100000] The complete findings and the summary must agree before anything is written.
  IF v_outcome = 'certified' THEN
    v_exc := coalesce(v_c->'exceptions', '[]'::jsonb);
    IF jsonb_typeof(v_exc) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'INVALID_RESULT: exceptions must be an array' USING ERRCODE = '22023';
    END IF;
    IF v_c ? 'findings' THEN
      v_findings := v_c->'findings';
      IF jsonb_typeof(v_findings) IS DISTINCT FROM 'array' OR jsonb_array_length(v_findings) > public.tb_certification_findings_limit() THEN
        RAISE EXCEPTION 'INVALID_RESULT: findings must be an array of at most % entries', public.tb_certification_findings_limit() USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f
                  WHERE jsonb_typeof(f) IS DISTINCT FROM 'object' OR jsonb_typeof(f->'code') IS DISTINCT FROM 'string'
                     OR (f->>'layer') IS NULL OR (f->>'layer') NOT IN ('1', '2', '3', '4', '5', '6')
                     OR jsonb_typeof(f->'layer') IS DISTINCT FROM 'number'
                     OR (f->>'severity') IS NULL OR (f->>'severity') NOT IN ('error', 'warning', 'info')
                     OR f ? 'summary') THEN
        RAISE EXCEPTION 'INVALID_RESULT: a finding is malformed' USING ERRCODE = '22023';
      END IF;
      -- Every kind of finding is represented in the summary (by an example or its count record).
      IF EXISTS (SELECT 1 FROM (SELECT DISTINCT f->'layer' l, f->'code' c, f->'severity' s FROM jsonb_array_elements(v_findings) f) k
                  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_exc) e
                                     WHERE e->'layer' = k.l AND e->'code' = k.c AND e->'severity' = k.s)) THEN
        RAISE EXCEPTION 'INVALID_RESULT: a kind of finding is missing from the summary' USING ERRCODE = '22023';
      END IF;
      -- Each summary entry is one of the findings, verbatim, or the one count record of its kind with the true counts.
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_exc) e
                  WHERE NOT (e ? 'summary')
                    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f WHERE f = e)) THEN
        RAISE EXCEPTION 'INVALID_RESULT: a summary example is not one of the findings' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_exc) e
                  WHERE e ? 'summary' AND (
                        jsonb_typeof(e->'summary'->'total') IS DISTINCT FROM 'number'
                     OR jsonb_typeof(e->'summary'->'omitted') IS DISTINCT FROM 'number'
                     OR (e->'summary'->>'omitted') !~ '^[1-9][0-9]*$'
                     OR (e->'summary'->>'total')::bigint IS DISTINCT FROM
                          (SELECT count(*) FROM jsonb_array_elements(v_findings) f
                            WHERE f->'layer' = e->'layer' AND f->'code' = e->'code' AND f->'severity' = e->'severity')
                     OR (e->'summary'->>'total')::bigint - (e->'summary'->>'omitted')::bigint IS DISTINCT FROM
                          (SELECT count(*) FROM jsonb_array_elements(v_exc) x
                            WHERE NOT (x ? 'summary') AND x->'layer' = e->'layer' AND x->'code' = e->'code' AND x->'severity' = e->'severity')
                     OR (SELECT count(*) FROM jsonb_array_elements(v_exc) y
                          WHERE y ? 'summary' AND y->'layer' = e->'layer' AND y->'code' = e->'code' AND y->'severity' = e->'severity') <> 1)) THEN
        RAISE EXCEPTION 'INVALID_RESULT: a summary count does not agree with the findings' USING ERRCODE = '22023';
      END IF;
      v_findings_count := jsonb_array_length(v_findings);
      SELECT encode(sha256(convert_to(coalesce(string_agg(f::text, E'\n' ORDER BY o), ''), 'UTF8')), 'hex')
        INTO v_findings_sha FROM jsonb_array_elements(v_findings) WITH ORDINALITY x(f, o);
      v_summarized := v_exc IS DISTINCT FROM v_findings;
    ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(v_exc) e WHERE e ? 'summary') THEN
      RAISE EXCEPTION 'INVALID_RESULT: a summary needs the complete findings' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- [/20261107100000]
  -- [20261118100000] Generations this database does not know are refused; from generation 7 the evaluation manifest must
  -- name every required rule exactly once, agree with the findings, and every finding that takes a decision names its
  -- subject (the identity a decision binds to).
  SELECT er.engine_generation INTO v_gen FROM public.engine_runs er WHERE er.id = p_engine_run_id;
  IF v_gen > public.tb_max_engine_generation() THEN
    RAISE EXCEPTION 'ENGINE_GENERATION_UNSUPPORTED: generation % is newer than this database', v_gen USING ERRCODE = '22023';
  END IF;
  IF v_outcome = 'certified' AND coalesce(v_gen, 0) >= 7 THEN
    v_rules := public.tb_evaluation_rules(v_gen);
    v_eval := v_c->'evaluation';
    IF v_findings IS NULL THEN
      RAISE EXCEPTION 'INVALID_RESULT: this generation must record its complete findings' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_eval) IS DISTINCT FROM 'object' OR (v_eval->>'format') IS DISTINCT FROM 'tb-evaluation/1'
       OR jsonb_typeof(v_eval->'rules') IS DISTINCT FROM 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_eval->'rules') r
                   WHERE jsonb_typeof(r) IS DISTINCT FROM 'object' OR jsonb_typeof(r->'rule') IS DISTINCT FROM 'string'
                      OR (r->>'outcome') IS NULL OR (r->>'outcome') NOT IN ('passed', 'finding', 'not_applicable', 'not_reached')) THEN
      RAISE EXCEPTION 'INVALID_RESULT: the evaluation manifest is malformed' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_rules) q
                WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_eval->'rules') r WHERE r->>'rule' = q)) THEN
      RAISE EXCEPTION 'INVALID_RESULT: the evaluation omits a required rule' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_eval->'rules') r WHERE NOT ((r->>'rule') = ANY (v_rules)))
       OR jsonb_array_length(v_eval->'rules') <> cardinality(v_rules) THEN
      RAISE EXCEPTION 'INVALID_RESULT: the evaluation names an unknown rule or repeats one' USING ERRCODE = '22023';
    END IF;
    IF NOT (v_c->>'is_blocking')::boolean
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_eval->'rules') r WHERE r->>'outcome' = 'not_reached') THEN
      RAISE EXCEPTION 'INVALID_RESULT: only a blocking result may leave a rule unevaluated' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f
                WHERE public.tb_finding_rule(f->>'code') IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_eval->'rules') r
                                   WHERE r->>'rule' = public.tb_finding_rule(f->>'code') AND r->>'outcome' = 'finding'))
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_eval->'rules') r
                   WHERE r->>'outcome' = 'finding' AND (r->>'rule') IN ('entity_name', 'trailing_text', 'clearing_accounts', 'balance')
                     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f WHERE public.tb_finding_rule(f->>'code') = r->>'rule')) THEN
      RAISE EXCEPTION 'INVALID_RESULT: the evaluation does not agree with the findings' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f
                WHERE EXISTS (SELECT 1 FROM public.tb_decision_rules r WHERE r.code = f->>'code')
                  AND (jsonb_typeof(f->'subject') IS DISTINCT FROM 'string' OR length(f->>'subject') NOT BETWEEN 1 AND 500
                       OR jsonb_typeof(f->'decision_required') IS DISTINCT FROM 'boolean')) THEN
      RAISE EXCEPTION 'INVALID_RESULT: a finding that takes a decision has no subject or requirement' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- [/20261118100000]

  -- L4 then L7 (the run's upload is looked up unlocked, then locked first).
  SELECT er.source_record_id INTO v_upload_id FROM public.engine_runs er WHERE er.id = p_engine_run_id;
  IF v_upload_id IS NULL THEN RAISE EXCEPTION 'ATTEMPT_NOT_CURRENT' USING ERRCODE = 'PT409'; END IF;
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = v_upload_id FOR UPDATE;
  SELECT * INTO v_run FROM public.engine_runs er WHERE er.id = p_engine_run_id FOR UPDATE;
  -- The fence: only the upload's current, running attempt may finish. A late worker (preempted, expired, drained,
  -- superseded) is refused and changes nothing.
  IF v_row.id IS NULL OR v_run.attempt_no IS NULL OR v_run.status <> 'running' OR v_row.current_engine_run_id IS DISTINCT FROM v_run.id THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_CURRENT' USING ERRCODE = 'PT409';
  END IF;

  PERFORM public._tb_attempt_writer(true);

  IF v_outcome = 'certified' THEN
    -- An accepted (non-blocking, no-review) result must rest on recorded dependencies, all still current.
    IF NOT (v_c->>'is_blocking')::boolean AND NOT (v_c->>'requires_review')::boolean
       AND NOT EXISTS (SELECT 1 FROM public.engine_run_dependencies d WHERE d.engine_run_id = v_run.id) THEN
      RAISE EXCEPTION 'DEPENDENCIES_REQUIRED: an accepted result needs its dependencies recorded' USING ERRCODE = '55000';
    END IF;
    IF NOT public.tb_run_dependencies_current(v_run.id) THEN
      v_outcome := 'failed';
      v_code := 'DEPENDENCY_CHANGED';
      v_up := jsonb_build_object(
        'status', 'error', 'is_valid', false,
        'accounting_errors', jsonb_build_array(jsonb_build_object('code', 'DEPENDENCY_CHANGED',
          'message', 'A mapping, decision or setting this check used changed while it ran. Run the check again.')),
        'processing_result', jsonb_build_object('status', 'blocked', 'statements', NULL,
          'errors', jsonb_build_array(jsonb_build_object('code', 'DEPENDENCY_CHANGED',
            'message', 'A mapping, decision or setting this check used changed while it ran. Run the check again.')),
          'validation_report', '{}'::jsonb),
        'validation_report', NULL);
    END IF;
  END IF;

  -- [20261118100000] The requirement each decision-taking finding states is the database's own (rule + workspace policy);
  -- every decision a finding cites is current for this upload; a non-resolving decision makes the result blocking; and an
  -- accepted result leaves no REQUIRED finding without a current, resolving decision.
  IF v_outcome = 'certified' AND coalesce(v_gen, 0) >= 7 THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f
                WHERE EXISTS (SELECT 1 FROM public.tb_decision_rules r WHERE r.code = f->>'code')
                  AND (f->'decision_required') IS DISTINCT FROM to_jsonb(public.tb_finding_required(v_row.company_id, f->>'code'))) THEN
      RAISE EXCEPTION 'INVALID_RESULT: a finding states a requirement the workspace does not have' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f
                WHERE f ? 'decision' AND NOT EXISTS (
                  SELECT 1 FROM public.tb_current_finding_decisions(v_row.id) d
                   WHERE d.decision_id::text = f->'decision'->>'id' AND d.code = f->>'code' AND d.subject = f->>'subject'
                     AND d.action = f->'decision'->>'action')) THEN
      RAISE EXCEPTION 'INVALID_RESULT: a finding cites a decision that is not current' USING ERRCODE = '22023';
    END IF;
    IF NOT (v_c->>'is_blocking')::boolean
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f
                    JOIN public.tb_current_finding_decisions(v_row.id) d ON d.decision_id::text = f->'decision'->>'id'
                   WHERE NOT d.resolves) THEN
      RAISE EXCEPTION 'INVALID_RESULT: a non-resolving decision must block the result' USING ERRCODE = '22023';
    END IF;
    IF NOT (v_c->>'is_blocking')::boolean AND NOT (v_c->>'requires_review')::boolean
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f
                    WHERE (f->'decision_required') = 'true'::jsonb
                      AND NOT EXISTS (SELECT 1 FROM public.tb_current_finding_decisions(v_row.id) d
                                       WHERE d.decision_id::text = f->'decision'->>'id' AND d.resolves)) THEN
      RAISE EXCEPTION 'INVALID_RESULT: an accepted result has a finding that needs a decision' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- [/20261118100000]

  IF v_outcome = 'certified' THEN
    IF v_row.source_file_hash IS NULL THEN RAISE EXCEPTION 'SOURCE_HASH_MISSING' USING ERRCODE = '55000'; END IF;
    -- L8.
    INSERT INTO public.tb_certifications (company_id, upload_id, period_year, source_file_hash, normalized_input_hash,
                                          engine_run_id, is_blocking, requires_review, exceptions, rows_snapshot,
                                          findings_count, findings_sha256, findings_summarized) -- [20261107100000]
    VALUES (v_row.company_id, v_row.id, v_row.period_year, v_row.source_file_hash, v_c->>'normalized_input_hash',
            v_run.id, (v_c->>'is_blocking')::boolean, (v_c->>'requires_review')::boolean,
            v_exc, coalesce(v_c->'rows_snapshot', '[]'::jsonb),
            v_findings_count, v_findings_sha, v_summarized) -- [20261107100000]
    RETURNING id INTO v_cert;
    -- [20261107100000] The complete findings, under the same fence and in the same transaction as the certification.
    IF v_findings IS NOT NULL THEN
      INSERT INTO public.tb_certification_findings (certification_id, ordinal, finding)
      SELECT v_cert, o::integer, f FROM jsonb_array_elements(v_findings) WITH ORDINALITY x(f, o);
    END IF;
    -- [/20261107100000]
  END IF;

  UPDATE public.trial_balance_uploads t
     SET status            = v_up->>'status',
         is_valid          = (v_up->>'is_valid')::boolean,
         processing_result = v_up->'processing_result',
         validation_report = CASE WHEN jsonb_typeof(v_up->'validation_report') = 'object' THEN v_up->'validation_report' ELSE NULL END,
         accounting_errors = coalesce(v_up->'accounting_errors', '[]'::jsonb),
         processed_at      = now()
   WHERE t.id = v_row.id;

  UPDATE public.engine_runs er
     SET status = CASE WHEN v_outcome = 'certified' THEN 'completed' ELSE 'failed' END,
         completed_at = now(),
         duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - er.started_at)) * 1000)::integer,
         output_hash = CASE WHEN v_outcome = 'certified' THEN v_c->>'output_hash' END,
         error_code = CASE WHEN v_outcome = 'failed' THEN v_code END
   WHERE er.id = v_run.id;
  UPDATE public.idempotency_keys k
     SET status = CASE WHEN v_outcome = 'certified' THEN 'completed' ELSE 'failed' END,
         resolved_at = now(),
         replay_result = CASE WHEN v_outcome = 'certified'
           THEN jsonb_build_object('status', 'completed', 'reference_id', v_cert::text, 'reference_table', 'tb_certifications')
           ELSE jsonb_build_object('status', 'failed', 'error_code', v_code) END
   WHERE k.engine_run_id = v_run.id AND k.status = 'reserved';
  PERFORM public._tb_attempt_writer(false);

  RETURN jsonb_build_object('outcome', v_outcome, 'certification_id', v_cert, 'error_code', CASE WHEN v_outcome = 'failed' THEN v_code END,
                            'findings_count', v_findings_count); -- [20261107100000]
END;
$$;
REVOKE ALL ON FUNCTION public.tb_finalize_attempt(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_finalize_attempt(uuid, jsonb) TO service_role;

-- ── Rollback (manual; only before any decision or generation-7 certification exists) ─────────────────────────────────
-- Re-run the 20261107100000 definitions of tb_snapshot_dependencies, tb_begin_attempt and tb_finalize_attempt; then
-- DROP TRIGGER trg_companies_bump_entity ON public.companies; DROP TABLE public.tb_investigations,
-- public.tb_finding_decisions, public.tb_decision_actions; restore tb_certification_invalidations_reason_check without
-- 'finding_decision'; and drop the functions this migration created.
