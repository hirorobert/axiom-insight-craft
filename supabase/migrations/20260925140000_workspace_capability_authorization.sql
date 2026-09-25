-- ════════════════════════════════════════════════════════════════════════════
-- CFO Close: explicit workspace capabilities are the authorization authority, never a job title.
-- Forward-only. No customer row is deleted; no applied migration is edited.
--
-- Capabilities (workspace-scoped, stored per person in workspace_member_capabilities):
--   prepare_close          prepare the close: journals, schedules, statements, classification, workspace setup
--   review_close           review: REVIEWED reports, engagement scope, filing jurisdiction, budgets, materiality
--   approve_certification  approve: FINAL reports, final sign-off / approval of adjustments
--   issue_reporting_pack   issue official Reporting Pack outputs
--   manage_members         manage the workspace's members (invitations)
-- Account-scoped:
--   manage_billing         the billing account holder (companies.user_id / billing_customers.owner_user_id); held by
--                          identity, never by title (choose_active_named_users, cancel_workspace_invitation, ...).
--
-- firm_members.role remains DISPLAY METADATA and a starting TEMPLATE: when a person is added, or their title is
-- changed by the account holder, the matching template capabilities are recorded for them (owner: all five;
-- partner: prepare, review, approve, issue; preparer: prepare, issue; viewer: issue). Every authorization check reads
-- the stored capability, never the title, so a capability can be granted to or withdrawn from a person whatever
-- their title (grant_member_capability / revoke_member_capability, audited). The templates reproduce every access
-- that existed before this migration exactly; the unreachable 'manager' / 'reviewer' / 'approver' branches (the
-- title CHECK never allowed them) are dropped.
--
-- A current plan is required to EXERCISE prepare / review / approve (workspace_capability_allowed): after a plan
-- expires, or with no plan at all, every existing record stays readable (reads use has_workspace_capability) and no
-- new operation is accepted. Official output formats also need their plan feature (reporting_pack_kind_features).
--
-- Redefined, each only where it read a title (the generated manifest is checked by scripts/db-proof/planCapabilities.mjs):
--   30 RLS policies (journals, schedules, tax losses / payments, sign-offs, engagements, management inputs,
--   budgets, materiality, account P&L mapping) and assert_engagement_write_authority, open_engagement_with_scope,
--   set_company_filing_jurisdiction (+ the REGIONAL_PACKS feature), record_engagement_data_start, fs_actor_member_id,
--   fs_set_publication_state, financial_statements_workspace_access (+ can_prepare), resolve_account_review_batch,
--   workspace_authority_basis (+ current plan), issue_reporting_pack and consume_reporting_pack_issuance (+ the
--   format's feature and issue_reporting_pack).
-- New Close Assurance wall: a new upload, reconciliation, validation, tax computation, closing balance or finding
-- needs the workspace account to hold CLOSE_ASSURANCE (i.e. a current plan).
-- Not changed: the integrity guards on the 'owner' title (only company creation assigns it; the last owner cannot be
-- removed or demoted), which are not authorization. Accounting values, certification verdicts and stage locks are
-- untouched.
-- ════════════════════════════════════════════════════════════════════════════

DO $refuse$
BEGIN
  IF to_regclass('public.commercial_plan_features') IS NULL THEN
    RAISE EXCEPTION 'capability migration refused: 20260925130000 is not applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.workspace_member_capabilities') IS NOT NULL THEN
    RAISE EXCEPTION 'capability migration refused: already applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.firm_members WHERE role NOT IN ('owner', 'partner', 'preparer', 'viewer')) THEN
    RAISE EXCEPTION 'capability migration refused: a membership carries an unknown title. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
END
$refuse$;

SET search_path TO public, pg_catalog;

-- ── 1. Stored capabilities ───────────────────────────────────────────────────────────────────
CREATE TABLE public.workspace_member_capabilities (
  id             UUID        NOT NULL DEFAULT gen_random_uuid(),
  company_id     UUID        NOT NULL,
  user_id        UUID        NOT NULL,
  capability     TEXT        NOT NULL,
  source         TEXT        NOT NULL,
  granted_by     UUID        NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ NULL,
  revoked_by     UUID        NULL,
  revoke_reason  TEXT        NULL,
  CONSTRAINT workspace_member_capabilities_pk PRIMARY KEY (id),
  CONSTRAINT fk_wmc_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,
  CONSTRAINT fk_wmc_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT chk_wmc_capability CHECK (capability IN ('prepare_close', 'review_close', 'approve_certification', 'issue_reporting_pack', 'manage_members')),
  CONSTRAINT chk_wmc_source CHECK (source IN ('ROLE_TEMPLATE', 'EXPLICIT_GRANT')),
  CONSTRAINT chk_wmc_revocation CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE UNIQUE INDEX uq_wmc_open ON public.workspace_member_capabilities (company_id, user_id, capability) WHERE revoked_at IS NULL;
CREATE INDEX idx_wmc_user ON public.workspace_member_capabilities (user_id);

-- Append-only: a row is revoked once, never edited otherwise; it is removed only with its workspace or person.
CREATE OR REPLACE FUNCTION public.workspace_member_capabilities_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id) THEN
      RAISE EXCEPTION 'workspace_member_capabilities is append-only: revoke instead of deleting' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.revoked_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.capability IS DISTINCT FROM OLD.capability OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'workspace_member_capabilities is append-only: a capability is revoked once and never edited' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_wmc_guard BEFORE UPDATE OR DELETE ON public.workspace_member_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.workspace_member_capabilities_guard();
CREATE OR REPLACE FUNCTION public.workspace_member_capabilities_no_truncate()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'workspace_member_capabilities is append-only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER trg_wmc_no_truncate BEFORE TRUNCATE ON public.workspace_member_capabilities
  FOR EACH STATEMENT EXECUTE FUNCTION public.workspace_member_capabilities_no_truncate();

-- ── 2. Title templates (applied when a person is added or re-titled; never read by an authorization check) ──
CREATE OR REPLACE FUNCTION public._title_capability_template(p_title TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_title
    WHEN 'owner'    THEN ARRAY['prepare_close', 'review_close', 'approve_certification', 'issue_reporting_pack', 'manage_members']
    WHEN 'partner'  THEN ARRAY['prepare_close', 'review_close', 'approve_certification', 'issue_reporting_pack']
    WHEN 'preparer' THEN ARRAY['prepare_close', 'issue_reporting_pack']
    WHEN 'viewer'   THEN ARRAY['issue_reporting_pack']
    ELSE ARRAY[]::TEXT[]
  END;
$$;

CREATE OR REPLACE FUNCTION public.firm_members_capability_template_sync()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    -- A removed or re-pointed membership: every open capability of that person in that workspace ends. A new title:
    -- template capabilities the new title does not carry end (explicit grants are kept).
    UPDATE public.workspace_member_capabilities c
       SET revoked_at = now(), revoked_by = auth.uid(),
           revoke_reason = CASE WHEN TG_OP = 'DELETE' OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
                                THEN 'MEMBERSHIP_REMOVED' ELSE 'TITLE_CHANGED' END
     WHERE c.company_id = OLD.company_id AND c.user_id = OLD.user_id AND c.revoked_at IS NULL
       AND (TG_OP = 'DELETE' OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR (c.source = 'ROLE_TEMPLATE' AND NOT (public._title_capability_template(NEW.role) @> ARRAY[c.capability])));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO public.workspace_member_capabilities (company_id, user_id, capability, source, granted_by)
    SELECT NEW.company_id, NEW.user_id, t.cap, 'ROLE_TEMPLATE', COALESCE(auth.uid(), NEW.invited_by)
      FROM unnest(public._title_capability_template(NEW.role)) AS t(cap)
    ON CONFLICT (company_id, user_id, capability) WHERE revoked_at IS NULL DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_firm_members_capability_template
  AFTER INSERT OR DELETE OR UPDATE OF role, company_id, user_id ON public.firm_members
  FOR EACH ROW EXECUTE FUNCTION public.firm_members_capability_template_sync();

-- Backfill: every existing membership gets exactly its title's template (the access it has today).
INSERT INTO public.workspace_member_capabilities (company_id, user_id, capability, source, granted_by, granted_at)
SELECT fm.company_id, fm.user_id, t.cap, 'ROLE_TEMPLATE', NULL, now()
  FROM public.firm_members fm CROSS JOIN LATERAL unnest(public._title_capability_template(fm.role)) AS t(cap)
ON CONFLICT (company_id, user_id, capability) WHERE revoked_at IS NULL DO NOTHING;

-- ── 3. The capability authority ─────────────────────────────────────────────────────────────
-- Does this person hold this capability in this workspace? A member with the stored capability (and an active
-- named user), or, for issuing Reporting Pack outputs only, a person with an active explicit workspace grant (the
-- access that grant already gave). An authenticated caller learns nothing about anyone else: named_user_access_active
-- answers false for another person under the authenticated role.
CREATE OR REPLACE FUNCTION public.has_workspace_capability(p_company_id UUID, p_user UUID, p_capability TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_company_id IS NOT NULL AND p_user IS NOT NULL
    AND p_capability IN ('prepare_close', 'review_close', 'approve_certification', 'issue_reporting_pack', 'manage_members')
    AND public.named_user_access_active(p_company_id, p_user)
    AND (
      (EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.company_id = p_company_id AND fm.user_id = p_user)
       AND EXISTS (SELECT 1 FROM public.workspace_member_capabilities c
                    WHERE c.company_id = p_company_id AND c.user_id = p_user AND c.capability = p_capability AND c.revoked_at IS NULL))
      OR (p_capability = 'issue_reporting_pack'
          AND EXISTS (SELECT 1 FROM public.workspace_capability_grants g
                       WHERE g.company_id = p_company_id AND g.grantee_user_id = p_user AND g.revoked_at IS NULL)));
$$;

-- May this person EXERCISE the capability now? Held, and the workspace's account has a current plan (managing
-- members needs no plan: the account holder must be able to reduce the roster).
CREATE OR REPLACE FUNCTION public.workspace_capability_allowed(p_company_id UUID, p_user UUID, p_capability TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.has_workspace_capability(p_company_id, p_user, p_capability)
     AND (p_capability = 'manage_members' OR public.workspace_has_current_plan(p_company_id));
$$;

-- Account-scoped: the billing account holder.
CREATE OR REPLACE FUNCTION public.has_account_capability(p_user UUID, p_capability TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_user IS NOT NULL AND p_capability = 'manage_billing'
    AND (p_user = auth.uid() OR COALESCE(current_setting('role', true), '') NOT IN ('authenticated', 'anon'))
    AND (EXISTS (SELECT 1 FROM public.billing_customers b WHERE b.owner_user_id = p_user)
         OR EXISTS (SELECT 1 FROM public.companies c WHERE c.user_id = p_user));
$$;

-- What the signed-in person may do in this workspace (for the UI; every write is still decided server-side).
CREATE OR REPLACE FUNCTION public.get_my_workspace_capabilities(p_company_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_held TEXT[];
  v_plan BOOLEAN;
BEGIN
  IF v_uid IS NULL OR p_company_id IS NULL OR public._workspace_access_basis(v_uid, p_company_id) IS NULL THEN
    RETURN jsonb_build_object('access', false, 'capabilities', '[]'::jsonb, 'allowed', '[]'::jsonb, 'has_current_plan', NULL, 'manage_billing', false);
  END IF;
  SELECT COALESCE(array_agg(c ORDER BY c), ARRAY[]::TEXT[]) INTO v_held
    FROM unnest(ARRAY['prepare_close', 'review_close', 'approve_certification', 'issue_reporting_pack', 'manage_members']) c
   WHERE public.has_workspace_capability(p_company_id, v_uid, c);
  v_plan := public.workspace_has_current_plan(p_company_id);
  RETURN jsonb_build_object('access', true, 'capabilities', to_jsonb(v_held),
    'allowed', to_jsonb(ARRAY(SELECT c FROM unnest(v_held) c WHERE c = 'manage_members' OR v_plan)),
    'has_current_plan', v_plan,
    'manage_billing', EXISTS (SELECT 1 FROM public.companies co WHERE co.id = p_company_id AND co.user_id = v_uid));
END;
$$;

-- Grant or withdraw an operational capability for a member of this workspace. The caller needs manage_members.
-- manage_members itself follows the account holder (only company creation assigns the owner title) and is not
-- grantable; the account holder's capabilities cannot be withdrawn. Outcomes are structured; a caller without
-- manage_members learns nothing about the workspace ('forbidden' for every target).
CREATE OR REPLACE FUNCTION public.grant_member_capability(p_company_id UUID, p_user UUID, p_capability TEXT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('outcome', 'unauthenticated'); END IF;
  IF NOT public.has_workspace_capability(p_company_id, v_uid, 'manage_members') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF p_capability IS NULL OR p_capability NOT IN ('prepare_close', 'review_close', 'approve_certification', 'issue_reporting_pack') THEN
    RETURN jsonb_build_object('outcome', 'invalid_capability');
  END IF;
  PERFORM 1 FROM public.firm_members fm WHERE fm.company_id = p_company_id AND fm.user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_a_member'); END IF;
  INSERT INTO public.workspace_member_capabilities (company_id, user_id, capability, source, granted_by)
  VALUES (p_company_id, p_user, p_capability, 'EXPLICIT_GRANT', v_uid)
  ON CONFLICT (company_id, user_id, capability) WHERE revoked_at IS NULL DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'already_held'); END IF;
  RETURN jsonb_build_object('outcome', 'granted');
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_member_capability(p_company_id UUID, p_user UUID, p_capability TEXT, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('outcome', 'unauthenticated'); END IF;
  IF NOT public.has_workspace_capability(p_company_id, v_uid, 'manage_members') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF p_capability IS NULL OR p_capability NOT IN ('prepare_close', 'review_close', 'approve_certification', 'issue_reporting_pack') THEN
    RETURN jsonb_build_object('outcome', 'invalid_capability');
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RETURN jsonb_build_object('outcome', 'reason_required'); END IF;
  IF EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id AND c.user_id = p_user) THEN
    RETURN jsonb_build_object('outcome', 'account_holder_locked');
  END IF;
  UPDATE public.workspace_member_capabilities
     SET revoked_at = now(), revoked_by = v_uid, revoke_reason = btrim(p_reason)
   WHERE company_id = p_company_id AND user_id = p_user AND capability = p_capability AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_held'); END IF;
  RETURN jsonb_build_object('outcome', 'revoked');
END;
$$;

ALTER TABLE public.workspace_member_capabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wmc_select_self_or_manager" ON public.workspace_member_capabilities FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_workspace_capability(company_id, auth.uid(), 'manage_members'));
REVOKE ALL ON public.workspace_member_capabilities FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.workspace_member_capabilities TO authenticated, service_role;

-- ── 4. Redefinitions: a title check becomes a capability check (generated; nothing else changes) ──
CREATE OR REPLACE FUNCTION public.assert_engagement_write_authority(p_engagement_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_company UUID;
  v_status  TEXT;
  v_member  UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'IRON DOME: engagement scope changes require an authenticated actor.';
  END IF;

  SELECT company_id, status INTO v_company, v_status
  FROM public.engagements WHERE id = p_engagement_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Engagement % does not exist.', p_engagement_id;
  END IF;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION
      'IRON DOME: engagement % is closed. Closed engagements accept no further mandate or authority events.',
      p_engagement_id USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT fm.id INTO v_member
  FROM public.firm_members fm
  WHERE fm.user_id = auth.uid()
    AND fm.company_id = v_company
    AND fm.accepted_at IS NOT NULL
    AND public.named_user_access_active(fm.company_id, fm.user_id)
    AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'review_close')
  LIMIT 1;

  IF v_member IS NULL THEN
    RAISE EXCEPTION
      'IRON DOME: changing engagement scope or authority needs the review_close capability in this workspace and a current plan.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN v_member;
END;
$function$;

CREATE OR REPLACE FUNCTION public.open_engagement_with_scope(p_company_id uuid, p_period_year integer, p_capabilities text[], p_engagement_type text DEFAULT 'composite'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_member   UUID;
  v_period   UUID;
  v_eng      UUID;
  v_created  BOOLEAN := false;
  v_cap      TEXT;
  v_caps     TEXT[];
  v_granted  TEXT[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF p_period_year IS NULL OR p_period_year < 2000 OR p_period_year > 2100 THEN
    RAISE EXCEPTION 'INVALID: reporting year out of range' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT c ORDER BY c) INTO v_caps FROM unnest(COALESCE(p_capabilities, ARRAY[]::TEXT[])) c;
  IF v_caps IS NULL OR array_length(v_caps, 1) = 0 THEN
    RAISE EXCEPTION 'INVALID: choose at least one service' USING ERRCODE = '22023';
  END IF;
  FOREACH v_cap IN ARRAY v_caps LOOP
    IF v_cap NOT IN ('FINANCIAL_STATEMENTS', 'TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING') THEN
      RAISE EXCEPTION 'INVALID: unknown service %', v_cap USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- 1. authorise from the session (never from the request)
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'review_close') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: choosing services needs the review_close capability in this workspace and a current plan' USING ERRCODE = '42501';
  END IF;

  -- 2. serialise on the company × year identity: every concurrent request for the same workspace queues here
  PERFORM pg_advisory_xact_lock(hashtextextended('open_engagement:' || p_company_id::text || ':' || p_period_year::text, 0));

  -- 3. the reporting period of record (earliest wins; the (company, year-end) UNIQUE key is the backstop)
  SELECT p.id INTO v_period FROM public.fiscal_periods p
   WHERE p.company_id = p_company_id
     AND EXTRACT(YEAR FROM COALESCE(p.reporting_end, p.fiscal_year_end))::INTEGER = p_period_year
   ORDER BY p.created_at, p.id LIMIT 1;
  IF v_period IS NULL THEN
    INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, reporting_start, reporting_end, period_label, created_by)
    VALUES (p_company_id, make_date(p_period_year, 12, 31), make_date(p_period_year, 1, 1), make_date(p_period_year, 12, 31), 'FY' || p_period_year::text, auth.uid())
    ON CONFLICT (company_id, fiscal_year_end) DO NOTHING
    RETURNING id INTO v_period;
    IF v_period IS NULL THEN
      SELECT p.id INTO v_period FROM public.fiscal_periods p
       WHERE p.company_id = p_company_id AND p.fiscal_year_end = make_date(p_period_year, 12, 31);
    END IF;
  END IF;

  -- 4. the open engagement, or exactly one new one (uq_engagements_one_open_per_period is the invariant)
  SELECT g.id INTO v_eng FROM public.engagements g WHERE g.fiscal_period_id = v_period AND g.status = 'open';
  IF v_eng IS NULL THEN
    INSERT INTO public.engagements (fiscal_period_id, company_id, engagement_type, created_by_member_id)
    VALUES (v_period, p_company_id, COALESCE(p_engagement_type, 'composite'), v_member)
    RETURNING id INTO v_eng;
    v_created := true;
  END IF;

  -- 5. grants: only what is missing (each goes through the validated, jurisdiction-aware command)
  FOREACH v_cap IN ARRAY v_caps LOOP
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (e.capability) e.action FROM public.engagement_mandate_events e
         WHERE e.engagement_id = v_eng AND e.capability = v_cap ORDER BY e.capability, e.sequence_no DESC
      ) l WHERE l.action = 'GRANT'
    ) THEN
      PERFORM public.grant_engagement_capability(v_eng, v_cap, 'Selected when the workspace was set up');
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(x.capability ORDER BY x.capability), ARRAY[]::TEXT[]) INTO v_granted FROM (
    SELECT DISTINCT ON (e.capability) e.capability, e.action FROM public.engagement_mandate_events e
     WHERE e.engagement_id = v_eng ORDER BY e.capability, e.sequence_no DESC
  ) x WHERE x.action = 'GRANT';

  RETURN jsonb_build_object('engagementId', v_eng, 'periodId', v_period, 'created', v_created, 'granted', to_jsonb(v_granted));
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_company_filing_jurisdiction(p_company_id uuid, p_jurisdiction text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_member UUID;
  v_code   TEXT := NULLIF(btrim(p_jurisdiction), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF v_code IS NOT NULL AND v_code !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'INVALID: a filing jurisdiction is a two-letter ISO 3166-1 code' USING ERRCODE = '22023';
  END IF;
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'review_close') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: selecting the filing jurisdiction needs the review_close capability in this workspace and a current plan' USING ERRCODE = '42501';
  END IF;
  IF v_code IS NOT NULL THEN
    PERFORM public._require_workspace_capability(p_company_id, 'REGIONAL_PACKS');
  END IF;
  UPDATE public.companies SET filing_jurisdiction = v_code WHERE id = p_company_id;
  RETURN v_code;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_engagement_data_start(p_engagement_id uuid, p_choice text, p_expected_state text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_company UUID;
  v_status  TEXT;
  v_member  UUID;
  v_current TEXT;
  v_seq     BIGINT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF p_choice IS NULL OR p_choice NOT IN ('empty', 'import') THEN
    RAISE EXCEPTION 'INVALID: the choice is "empty" or "import"' USING ERRCODE = '22023';
  END IF;
  IF p_expected_state IS NOT NULL AND p_expected_state NOT IN ('empty', 'import') THEN
    RAISE EXCEPTION 'INVALID: expected state is "empty" or "import"' USING ERRCODE = '22023';
  END IF;

  -- Lock the engagement row: every concurrent decision for this workspace serialises here.
  SELECT g.company_id, g.status INTO v_company, v_status FROM public.engagements g WHERE g.id = p_engagement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no such engagement' USING ERRCODE = 'P0002';
  END IF;

  -- Authorise from the session: an accepted member of THIS engagement's company holding prepare_close.
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = v_company AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: changing the workspace setup needs the prepare_close capability and a current plan' USING ERRCODE = '42501';
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'CONFLICT: the engagement is closed' USING ERRCODE = 'PT409';
  END IF;

  v_current := public.engagement_data_start_state(p_engagement_id);

  -- Exact replay converges: nothing is written.
  IF v_current = p_choice THEN
    RETURN jsonb_build_object('dataStart', v_current, 'changed', false, 'replay', true);
  END IF;

  -- The caller's belief about the current state must match the truth (stale / conflicting concurrent choice).
  IF p_expected_state IS DISTINCT FROM v_current THEN
    RAISE EXCEPTION 'CONFLICT: the workspace setup is already "%" (this request expected "%")', COALESCE(v_current, 'undecided'), COALESCE(p_expected_state, 'undecided')
      USING ERRCODE = 'PT409';
  END IF;

  -- Permitted transitions only: undecided → empty | import, and empty → import.
  IF v_current = 'import' THEN
    RAISE EXCEPTION 'CONFLICT: import has already started; a workspace cannot return to empty' USING ERRCODE = 'PT409';
  END IF;

  SELECT COALESCE(MAX(sequence_no), 0) + 1 INTO v_seq FROM public.engagement_setup_events WHERE engagement_id = p_engagement_id;
  INSERT INTO public.engagement_setup_events (engagement_id, sequence_no, event_type, actor_member_id)
  VALUES (p_engagement_id, v_seq, CASE p_choice WHEN 'empty' THEN 'DATA_START_EMPTY' ELSE 'DATA_START_IMPORT' END, v_member);

  RETURN jsonb_build_object('dataStart', p_choice, 'changed', true, 'replay', false, 'sequence', v_seq);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fs_actor_member_id(p_company_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid    UUID := auth.uid();
  v_member UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;

  SELECT fm.id INTO v_member
    FROM public.firm_members fm
   WHERE fm.user_id = v_uid AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close')
   ORDER BY fm.id LIMIT 1;

  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: the caller is not an accepted member of company % holding prepare_close with a current plan', p_company_id USING ERRCODE = '42501';
  END IF;

  IF NOT public.fs_rollout_allows(p_company_id) THEN
    RAISE EXCEPTION 'FEATURE_DISABLED: the financial-statements workspace is not enabled for this company' USING ERRCODE = 'PT403';
  END IF;

  RETURN v_member;
END;
$function$;

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
BEGIN
  v_actor := public.fs_actor_member_id(p_company_id);

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

  INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id)
       VALUES (p_report_id, p_report_version, p_company_id, p_state, p_reason, v_actor)
    RETURNING * INTO v_row;
  PERFORM public.fs_audit_event(p_company_id, p_report_id, 'PUBLICATION_STATE_SET', jsonb_build_object('reportVersion', p_report_version::text, 'state', p_state, 'reason', p_reason), v_actor);
  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.financial_statements_workspace_access(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_kill BOOLEAN;
  v_role TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;

  -- The caller's title is returned as display metadata only; can_prepare (the prepare_close capability with a current plan) tells the UI
  -- whether to render the workspace read-only. Every write is still decided server-side.
  SELECT fm.role INTO v_role FROM public.firm_members fm
   WHERE fm.user_id = v_uid AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
   ORDER BY (fm.role = 'viewer'), fm.created_at LIMIT 1;  -- a non-viewer row wins, exactly as the actor resolver picks one
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('enabled', false, 'reason', 'NOT_A_MEMBER');
  END IF;

  SELECT s.kill_switch INTO v_kill FROM public.financial_statements_rollout_state s WHERE s.singleton;
  IF v_kill THEN
    RETURN jsonb_build_object('enabled', false, 'reason', 'KILL_SWITCH', 'role', v_role);
  END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN
    RETURN jsonb_build_object('enabled', false, 'reason', 'NOT_ALLOWLISTED', 'role', v_role);
  END IF;
  RETURN jsonb_build_object('enabled', true, 'reason', 'ENABLED', 'role', v_role, 'can_prepare', public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_account_review_batch(p_company_id uuid, p_upload_id uuid, p_client_request_id uuid, p_decisions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_id            UUID := auth.uid();
  v_firm_member_id     UUID;
  v_role               TEXT;
  v_upload_company_id  UUID;
  v_request_hash       TEXT;
  v_existing_batch      RECORD;
  v_batch_id           UUID;
  v_result             JSONB;
  v_decision           JSONB;
  v_sorted_keys        TEXT[];
  v_key                TEXT;
  v_code               TEXT;
  v_norm_name          TEXT;
  v_review_key         TEXT;
  v_proposal_type      TEXT;
  v_decision_action    TEXT;
  v_previous           JSONB;
  v_mappings_written   INTEGER := 0;
  v_decisions_logged   INTEGER := 0;
  v_non_reporting_count INTEGER := 0;
  v_seen_keys          TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  SELECT fm.id, fm.role
    INTO v_firm_member_id, v_role
    FROM public.firm_members fm
   WHERE fm.user_id     = v_user_id
     AND fm.company_id  = p_company_id
     AND fm.accepted_at IS NOT NULL
     AND public.named_user_access_active(fm.company_id, fm.user_id)
   LIMIT 1;

  IF v_firm_member_id IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER_OF_COMPANY' USING ERRCODE = '42501';
  END IF;

  IF NOT public.workspace_capability_allowed(p_company_id, v_user_id, 'prepare_close') THEN
    RAISE EXCEPTION 'CAPABILITY_REQUIRED_FOR_CLASSIFICATION_DECISIONS' USING ERRCODE = '42501';
  END IF;

  SELECT tbu.company_id INTO v_upload_company_id
    FROM public.trial_balance_uploads tbu
   WHERE tbu.id = p_upload_id;

  IF v_upload_company_id IS NULL OR v_upload_company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'UPLOAD_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF p_decisions IS NULL OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DECISION_BATCH' USING ERRCODE = '22023';
  END IF;

  v_request_hash := encode(
    digest(
      p_company_id::TEXT || '|' || p_upload_id::TEXT || '|' ||
      (
        SELECT string_agg(
                 coalesce(elem->>'account_code','') || '::' ||
                 coalesce(elem->>'account_name','') || '::' ||
                 coalesce(elem->>'proposal_type','NONE') || '::' ||
                 coalesce(elem->>'decision_action','') || '::' ||
                 coalesce(elem->>'statement','') || '::' ||
                 coalesce(elem->>'classification','') || '::' ||
                 coalesce(elem->>'line_item','') || '::' ||
                 coalesce(elem->>'normal_balance','') || '::' ||
                 coalesce(elem->>'reason','') || '::' ||
                 coalesce(elem->>'is_cash_account','~') || '::' ||
                 coalesce(elem->>'is_retained_earnings','~') || '::' ||
                 coalesce(elem->>'is_payroll_account','~'),
                 '|' ORDER BY
                   coalesce(elem->>'account_code', elem->>'account_name')
               )
          FROM jsonb_array_elements(p_decisions) elem
      ),
      'sha256'
    ),
    'hex'
  );

  SELECT * INTO v_existing_batch
    FROM public.account_review_batches
   WHERE upload_id = p_upload_id
     AND firm_member_id = v_firm_member_id
     AND client_request_id = p_client_request_id
   LIMIT 1;

  IF FOUND THEN
    IF v_existing_batch.request_hash = v_request_hash THEN
      RETURN v_existing_batch.result_summary;
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' USING ERRCODE = '22023';
    END IF;
  END IF;

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_proposal_type := coalesce(v_decision->>'proposal_type', 'NONE');
    IF v_proposal_type = 'AUTO_MAPPED_RULE' THEN
      RAISE EXCEPTION 'AUTO_MAPPED_RULE_NOT_AUTHORIZED_IN_PHASE_2A' USING ERRCODE = '42501';
    END IF;

    v_decision_action := v_decision->>'decision_action';
    IF v_decision_action IS NULL OR v_decision_action NOT IN
       ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION', 'MARK_NON_REPORTING_ACCOUNT') THEN
      RAISE EXCEPTION 'INVALID_DECISION_ACTION: %', coalesce(v_decision_action, 'NULL') USING ERRCODE = '22023';
    END IF;

    v_code := NULLIF(trim(coalesce(v_decision->>'account_code', '')), '');
    v_norm_name := lower(trim(regexp_replace(regexp_replace(
                     coalesce(v_decision->>'account_name', ''), '[[:punct:]]', '', 'g'),
                     '\s+', ' ', 'g')));
    v_review_key := COALESCE(v_code, v_norm_name);

    IF v_review_key = '' THEN
      RAISE EXCEPTION 'ACCOUNT_IDENTITY_UNRESOLVABLE' USING ERRCODE = '22023';
    END IF;

    IF v_review_key = ANY(v_seen_keys) THEN
      RAISE EXCEPTION 'DUPLICATE_ACCOUNT_IN_BATCH: %', v_review_key USING ERRCODE = '22023';
    END IF;
    v_seen_keys := v_seen_keys || v_review_key;
  END LOOP;

  SELECT array_agg(DISTINCT k ORDER BY k) INTO v_sorted_keys
    FROM unnest(v_seen_keys) AS k;

  FOREACH v_key IN ARRAY v_sorted_keys LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_company_id::TEXT), hashtext(v_key));
  END LOOP;

  INSERT INTO public.account_review_batches (
    id, client_request_id, request_hash, company_id, upload_id, firm_member_id, result_summary
  ) VALUES (
    gen_random_uuid(), p_client_request_id, v_request_hash, p_company_id, p_upload_id, v_firm_member_id, '{}'::jsonb
  ) RETURNING id INTO v_batch_id;

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_code := NULLIF(trim(coalesce(v_decision->>'account_code', '')), '');
    v_norm_name := lower(trim(regexp_replace(regexp_replace(
                     coalesce(v_decision->>'account_name', ''), '[[:punct:]]', '', 'g'),
                     '\s+', ' ', 'g')));
    v_review_key := COALESCE(v_code, v_norm_name);
    v_decision_action := v_decision->>'decision_action';
    v_proposal_type := coalesce(v_decision->>'proposal_type', 'NONE');

    SELECT to_jsonb(am.*) INTO v_previous
      FROM public.account_mappings am
     WHERE am.company_id = p_company_id
       AND am.account_key = v_review_key
     LIMIT 1;

    IF v_decision_action IN ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION') THEN
      INSERT INTO public.account_mappings (
        user_id, company_id, account_code, account_name, normalized_account_name,
        statement, classification, line_item, normal_balance,
        is_cash_account, is_retained_earnings, is_payroll_account,
        confidence_source, approved_at
      ) VALUES (
        v_user_id, p_company_id, v_code, v_decision->>'account_name', v_norm_name,
        (v_decision->>'statement')::public.financial_statement,
        (v_decision->>'classification')::public.account_classification,
        coalesce(v_decision->>'line_item', v_decision->>'account_name'),
        v_decision->>'normal_balance',
        (v_decision->>'is_cash_account')::boolean,
        (v_decision->>'is_retained_earnings')::boolean,
        (v_decision->>'is_payroll_account')::boolean,
        'user_approved', now()
      )
      ON CONFLICT (company_id, account_key) DO UPDATE SET
        account_code             = EXCLUDED.account_code,
        account_name             = EXCLUDED.account_name,
        normalized_account_name  = EXCLUDED.normalized_account_name,
        statement                = EXCLUDED.statement,
        classification           = EXCLUDED.classification,
        line_item                = EXCLUDED.line_item,
        normal_balance           = EXCLUDED.normal_balance,
        is_cash_account          = CASE WHEN v_decision ? 'is_cash_account'
                                         THEN (v_decision->>'is_cash_account')::boolean
                                         ELSE public.account_mappings.is_cash_account END,
        is_retained_earnings     = CASE WHEN v_decision ? 'is_retained_earnings'
                                         THEN (v_decision->>'is_retained_earnings')::boolean
                                         ELSE public.account_mappings.is_retained_earnings END,
        is_payroll_account       = CASE WHEN v_decision ? 'is_payroll_account'
                                         THEN (v_decision->>'is_payroll_account')::boolean
                                         ELSE public.account_mappings.is_payroll_account END,
        confidence_source        = 'user_approved',
        approved_at              = now(),
        updated_at               = now();
      v_mappings_written := v_mappings_written + 1;

    ELSIF v_decision_action = 'MARK_NON_REPORTING_ACCOUNT' THEN
      DELETE FROM public.account_mappings
       WHERE company_id = p_company_id
         AND account_key = v_review_key;
      v_non_reporting_count := v_non_reporting_count + 1;
    END IF;

    INSERT INTO public.account_review_decisions (
      batch_id, company_id, upload_id, firm_member_id,
      account_code, normalized_account_name, review_account_key,
      proposal_type, decision_action, previous_value, new_value, source, reason
    ) VALUES (
      v_batch_id, p_company_id, p_upload_id, v_firm_member_id,
      v_code, v_norm_name, v_review_key,
      v_proposal_type, v_decision_action, v_previous,
      CASE WHEN v_decision_action = 'MARK_NON_REPORTING_ACCOUNT' THEN NULL ELSE v_decision END,
      v_decision->>'source', v_decision->>'reason'
    );
    v_decisions_logged := v_decisions_logged + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'batch_id', v_batch_id,
    'mappings_written', v_mappings_written,
    'decisions_logged', v_decisions_logged,
    'non_reporting_decisions_recorded', v_non_reporting_count
  );

  UPDATE public.account_review_batches SET result_summary = v_result WHERE id = v_batch_id;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.workspace_authority_basis(p_user_id uuid, p_company_id uuid, p_capability text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT CASE
    WHEN p_user_id IS NULL OR p_company_id IS NULL OR p_capability IS NULL
      OR p_capability NOT IN ('manage_source_files', 'prepare_trial_balance', 'review_close', 'administer_workspace') THEN NULL
    WHEN NOT public.workspace_has_current_plan(p_company_id) THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id AND c.user_id = p_user_id) THEN 'workspace_owner'
    WHEN EXISTS (SELECT 1 FROM public.workspace_capability_grants g
                  WHERE g.company_id = p_company_id AND g.grantee_user_id = p_user_id
                    AND g.capability = p_capability AND g.revoked_at IS NULL AND public.named_user_access_active(g.company_id, g.grantee_user_id)) THEN 'explicit_capability'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.issue_reporting_pack(p_company_id uuid, p_period_year integer, p_pack_kind text, p_output_ref text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_user  UUID := auth.uid();
  v_auth  JSONB;
  v_kind_auth JSONB;
  v_row   public.reporting_pack_issuances%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100
     OR p_pack_kind IS NULL OR p_pack_kind NOT IN ('financial_statements_pdf', 'financial_statements_spreadsheet', 'financial_statements_data', 'filing_pack', 'client_pack', 'board_pack', 'management_letter', 'disclosure_notes', 'tax_computation', 'tax_workpaper')
     OR NOT public._reporting_pack_output_ref_valid(p_company_id, p_period_year, p_pack_kind, p_output_ref) THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  v_auth := public._authorize_paid_action(v_user, p_company_id, 'REPORTING_PACK_EXPORT');
  -- The output format's own capability (clean PDF, Excel, filing packs, management letters): reporting_pack_kind_features.
  IF (v_auth->>'allowed')::boolean THEN
    v_kind_auth := public._authorize_paid_action(v_user, p_company_id, (SELECT f.capability_code FROM public.reporting_pack_kind_features f WHERE f.pack_kind = p_pack_kind));
    IF NOT (v_kind_auth->>'allowed')::boolean THEN v_auth := v_kind_auth; END IF;
  END IF;
  -- The person's own capability to issue in this workspace (never a job title).
  IF (v_auth->>'allowed')::boolean AND NOT public.has_workspace_capability(p_company_id, v_user, 'issue_reporting_pack') THEN
    v_auth := jsonb_build_object('allowed', false, 'code', 'CAPABILITY_REQUIRED', 'capability', 'issue_reporting_pack');
  END IF;
  IF NOT (v_auth->>'allowed')::boolean THEN
    IF v_user IS NOT NULL AND v_auth->>'code' IN ('ENTITLEMENT_REQUIRED', 'CAPABILITY_REQUIRED') THEN
      INSERT INTO public.reporting_pack_issuance_events (company_id, actor_user_id, event, detail)
      VALUES (p_company_id, v_user, 'REFUSED', jsonb_build_object('stage', 'issue', 'code', v_auth->>'code', 'capability', v_auth->>'capability', 'pack_kind', p_pack_kind));
    END IF;
    RETURN jsonb_build_object('outcome', lower(v_auth->>'code'), 'capability', v_auth->>'capability', 'required_plan', v_auth->>'required_plan');
  END IF;
  SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE company_id = p_company_id AND issued_by = v_user AND request_id = p_request_id;
  IF v_row.id IS NOT NULL THEN
    IF v_row.period_year <> p_period_year OR v_row.pack_kind <> p_pack_kind OR v_row.output_ref IS DISTINCT FROM p_output_ref THEN
      RETURN jsonb_build_object('outcome', 'request_conflict');
    END IF;
    RETURN jsonb_build_object('outcome', 'already_issued', 'issuance_id', v_row.id, 'expires_at', v_row.expires_at, 'sealed', v_row.consumed_at IS NOT NULL);
  END IF;
  BEGIN
    INSERT INTO public.reporting_pack_issuances (company_id, period_year, pack_kind, request_id, issued_by, plan_code, output_ref, expires_at)
    VALUES (p_company_id, p_period_year, p_pack_kind, p_request_id, v_user, v_auth->>'plan_code', p_output_ref, now() + public.reporting_pack_issuance_ttl())
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE company_id = p_company_id AND issued_by = v_user AND request_id = p_request_id;
    RETURN jsonb_build_object('outcome', 'already_issued', 'issuance_id', v_row.id, 'expires_at', v_row.expires_at, 'sealed', v_row.consumed_at IS NOT NULL);
  END;
  INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail)
  VALUES (v_row.id, p_company_id, v_user, 'ISSUED', jsonb_build_object('pack_kind', p_pack_kind, 'period_year', p_period_year, 'output_ref', p_output_ref, 'plan_code', v_row.plan_code));
  RETURN jsonb_build_object('outcome', 'issued', 'issuance_id', v_row.id, 'expires_at', v_row.expires_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.consume_reporting_pack_issuance(p_issuance_id uuid, p_company_id uuid, p_period_year integer, p_pack_kind text, p_output_ref text, p_content_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_row  public.reporting_pack_issuances%ROWTYPE;
  v_auth JSONB;
  v_kind_auth JSONB;
  v_code TEXT;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;
  IF p_issuance_id IS NULL OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE id = p_issuance_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.issued_by <> v_user THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_row.company_id IS DISTINCT FROM p_company_id OR v_row.period_year IS DISTINCT FROM p_period_year
     OR v_row.pack_kind IS DISTINCT FROM p_pack_kind OR v_row.output_ref IS DISTINCT FROM p_output_ref THEN
    v_code := 'binding_mismatch';
  ELSIF v_row.consumed_at IS NOT NULL THEN
    v_code := 'already_sealed';
  ELSIF v_row.expires_at <= now() THEN
    v_code := 'expired';
  ELSE
    v_auth := public._authorize_paid_action(v_user, v_row.company_id, 'REPORTING_PACK_EXPORT');
    IF (v_auth->>'allowed')::boolean THEN
      v_kind_auth := public._authorize_paid_action(v_user, v_row.company_id, (SELECT f.capability_code FROM public.reporting_pack_kind_features f WHERE f.pack_kind = v_row.pack_kind));
      IF NOT (v_kind_auth->>'allowed')::boolean THEN v_auth := v_kind_auth; END IF;
    END IF;
    IF NOT (v_auth->>'allowed')::boolean THEN
      v_code := lower(v_auth->>'code');
    ELSIF NOT public.has_workspace_capability(v_row.company_id, v_user, 'issue_reporting_pack') THEN
      v_code := 'capability_required';
    END IF;
  END IF;
  IF v_code IS NOT NULL THEN
    INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail)
    VALUES (v_row.id, v_row.company_id, v_user, 'REFUSED', jsonb_build_object('stage', 'seal', 'code', upper(v_code)));
    RETURN jsonb_build_object('outcome', v_code);
  END IF;
  UPDATE public.reporting_pack_issuances
     SET consumed_at = now(), content_sha256 = p_content_sha256, consumed_plan_code = v_auth->>'plan_code'
   WHERE id = v_row.id;
  INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail)
  VALUES (v_row.id, v_row.company_id, v_user, 'SEALED', jsonb_build_object('content_sha256', p_content_sha256, 'pack_kind', v_row.pack_kind));
  RETURN jsonb_build_object('outcome', 'sealed', 'issuance_id', v_row.id);
END;
$function$;

-- ── 5. RLS policies: the same member row, a capability instead of a title (generated) ────────
ALTER POLICY "account_pl_mapping_delete" ON public.account_pl_mapping USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))));
ALTER POLICY "account_pl_mapping_update" ON public.account_pl_mapping USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text)))))) WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))));
ALTER POLICY "account_pl_mapping_write" ON public.account_pl_mapping WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))));
ALTER POLICY "aje_insert" ON public.adjusting_journal_entries WITH CHECK (((auth.uid() = created_by) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))));
ALTER POLICY "aje_select" ON public.adjusting_journal_entries USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "aje_update_draft_preparer" ON public.adjusting_journal_entries USING (((status = 'draft'::text) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text) AND (NOT public.has_workspace_capability(fm.company_id, fm.user_id, 'approve_certification'::text)))))))) WITH CHECK (((status = ANY (ARRAY['draft'::text, 'submitted'::text])) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text) AND (NOT public.has_workspace_capability(fm.company_id, fm.user_id, 'approve_certification'::text))))))));
ALTER POLICY "aje_update_partner_owner" ON public.adjusting_journal_entries USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'approve_certification'::text)))))) WITH CHECK (((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'approve_certification'::text))))) AND ((approved_by IS NULL) OR (approved_by IS DISTINCT FROM created_by)) AND ((status <> ALL (ARRAY['approved'::text, 'reversed'::text])) OR (auth.uid() IS DISTINCT FROM created_by))));
ALTER POLICY "aje_lines_insert" ON public.aje_lines WITH CHECK ((EXISTS ( SELECT 1
   FROM (adjusting_journal_entries a
     JOIN firm_members fm ON ((fm.company_id = a.company_id)))
  WHERE ((a.id = aje_lines.aje_id) AND (fm.user_id = auth.uid()) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "aje_lines_select" ON public.aje_lines USING ((EXISTS ( SELECT 1
   FROM (adjusting_journal_entries a
     JOIN firm_members fm ON ((fm.company_id = a.company_id)))
  WHERE ((a.id = aje_lines.aje_id) AND (fm.user_id = auth.uid()) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "ca_delete" ON public.capital_allowances USING (((created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = capital_allowances.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))));
ALTER POLICY "ca_insert" ON public.capital_allowances WITH CHECK (((auth.uid() = created_by) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = capital_allowances.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))));
ALTER POLICY "ca_select" ON public.capital_allowances USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = capital_allowances.company_id) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "ca_update" ON public.capital_allowances USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = capital_allowances.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = capital_allowances.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "Senior members create engagements" ON public.engagements WITH CHECK (((company_id IN ( SELECT get_member_company_ids() AS get_member_company_ids)) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.id = engagements.created_by_member_id) AND (fm.user_id = auth.uid()) AND (fm.company_id = engagements.company_id) AND (fm.accepted_at IS NOT NULL) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'review_close'::text)))))));
ALTER POLICY "Senior members update engagement status" ON public.engagements USING (((company_id IN ( SELECT get_member_company_ids() AS get_member_company_ids)) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = engagements.company_id) AND (fm.accepted_at IS NOT NULL) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'review_close'::text))))))) WITH CHECK ((company_id IN ( SELECT get_member_company_ids() AS get_member_company_ids)));
ALTER POLICY "mi_insert" ON public.management_inputs WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "mi_select" ON public.management_inputs USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "mi_update" ON public.management_inputs USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "sso_insert" ON public.statement_sign_offs WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "sso_select" ON public.statement_sign_offs USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "sso_update_partner_owner" ON public.statement_sign_offs USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'approve_certification'::text)))))) WITH CHECK (((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'approve_certification'::text))))) AND ((reviewer_signed_at IS NULL) OR (reviewer_id IS DISTINCT FROM preparer_id)) AND ((approver_signed_at IS NULL) OR ((approver_id IS DISTINCT FROM preparer_id) AND (approver_id IS DISTINCT FROM reviewer_id)))));
ALTER POLICY "sso_update_preparer" ON public.statement_sign_offs USING (((locked_at IS NULL) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text) AND (NOT public.has_workspace_capability(fm.company_id, fm.user_id, 'approve_certification'::text)))))))) WITH CHECK (((locked_at IS NULL) AND (reviewer_signed_at IS NULL) AND (approver_signed_at IS NULL) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text) AND (NOT public.has_workspace_capability(fm.company_id, fm.user_id, 'approve_certification'::text))))))));
ALTER POLICY "tl_insert" ON public.tax_losses WITH CHECK (((auth.uid() = created_by) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_losses.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))));
ALTER POLICY "tl_select" ON public.tax_losses USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_losses.company_id) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "tl_update" ON public.tax_losses USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_losses.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_losses.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "tax_payments_delete" ON public.tax_payments USING (((created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_payments.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))));
ALTER POLICY "tax_payments_insert" ON public.tax_payments WITH CHECK (((auth.uid() = created_by) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_payments.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))));
ALTER POLICY "tax_payments_update" ON public.tax_payments USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_payments.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_payments.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))));
ALTER POLICY "budget_approve" ON public.variance_budgets USING (((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))) AND (approved_by IS NULL) AND (submitted_by IS DISTINCT FROM auth.uid()))) WITH CHECK (((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))) AND (submitted_by IS DISTINCT FROM auth.uid()) AND ((approved_by IS NULL) OR (approved_by = auth.uid())) AND (approved_by IS DISTINCT FROM submitted_by)));
ALTER POLICY "variance_materiality_write" ON public.variance_materiality USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))));

-- ── 5b. Close Assurance wall: new preparation and validation outputs need a current plan ─────
-- Close Assurance is included in every plan and in no absence of one. After a plan ends (or with no plan), every
-- existing upload, reconciliation, validation, computation and finding stays readable; a NEW one is refused on every
-- path (client, RPC, service-role engine) with the same structured PT402 as the other walls.
CREATE OR REPLACE FUNCTION public.close_assurance_wall()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_company UUID;
BEGIN
  IF TG_TABLE_NAME = 'safisha_reconciliations' THEN
    SELECT u.company_id INTO v_company FROM public.trial_balance_uploads u WHERE u.id = NEW.tb_upload_id;
  ELSE
    v_company := NEW.company_id;
  END IF;
  IF v_company IS NOT NULL THEN
    PERFORM public._require_workspace_capability(v_company, 'CLOSE_ASSURANCE');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.trial_balance_uploads;
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.trial_balance_uploads FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall();
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.safisha_reconciliations;
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.safisha_reconciliations FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall();
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.hesabu_validations;
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.hesabu_validations FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall();
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.tax_computations;
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.tax_computations FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall();
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.period_closing_balances;
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.period_closing_balances FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall();
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.findings;
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.findings FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall();

-- ── 6. Privileges ────────────────────────────────────────────────────────────────────────────
-- RLS policies call the two predicates as the signed-in user, so authenticated needs EXECUTE; neither discloses
-- anything about another person (see has_workspace_capability).
REVOKE ALL ON FUNCTION public.has_workspace_capability(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_workspace_capability(UUID, UUID, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.workspace_capability_allowed(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_capability_allowed(UUID, UUID, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.has_account_capability(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_account_capability(UUID, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_my_workspace_capabilities(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_workspace_capabilities(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.grant_member_capability(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.grant_member_capability(UUID, UUID, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.revoke_member_capability(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_member_capability(UUID, UUID, TEXT, TEXT) TO authenticated;
-- The TB-lifecycle predicate stays service-only (see 20260925150000).
REVOKE ALL ON FUNCTION public.workspace_authority_basis(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_authority_basis(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public._title_capability_template(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.firm_members_capability_template_sync() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workspace_member_capabilities_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workspace_member_capabilities_no_truncate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.close_assurance_wall() FROM PUBLIC, anon, authenticated;

-- Rollback (forward-fix only): restore the previous definitions of the functions and policies above (the proof keeps
-- both). Capability rows are records and are never deleted.
