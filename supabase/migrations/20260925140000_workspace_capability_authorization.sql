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
-- firm_members.role remains DISPLAY METADATA and a starting TEMPLATE: when a person is ADDED, the matching template
-- capabilities are recorded for them (a later title change never adds or restores one; it can only narrow) (owner: all five;
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
-- New reconciliation write wall (section 5c): every reconciliation / EFDMS mutation needs a current plan and
-- prepare_close; safisha_resolve_exception checks the reviewer the same way.
-- New Close Assurance wall: a new upload, reconciliation, validation, tax computation, closing balance or finding
-- needs the workspace account to hold CLOSE_ASSURANCE (i.e. a current plan).
-- Not changed: the integrity guards on the 'owner' title (only company creation assigns it; the last owner cannot be
-- removed or demoted), which are not authorization. Accounting values, certification verdicts and stage locks are
-- untouched.
-- ════════════════════════════════════════════════════════════════════════════
--
-- ATOMIC ENVELOPE (security correction B-3): every statement below runs inside this ONE DO statement. Whatever the
-- runner does (statement by statement, whole file, with or without a transaction, continuing after errors) the
-- migration either applies completely or changes nothing.
DO $cfoclose_capabilities$
BEGIN
  EXECUTE $mcapabilitiesaaa$
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
$refuse$
$mcapabilitiesaaa$;

  EXECUTE $mcapabilitiesaab$
SET search_path TO public, pg_catalog
$mcapabilitiesaab$;

  EXECUTE $mcapabilitiesaac$
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
)
$mcapabilitiesaac$;

  EXECUTE $mcapabilitiesaad$
CREATE UNIQUE INDEX uq_wmc_open ON public.workspace_member_capabilities (company_id, user_id, capability) WHERE revoked_at IS NULL
$mcapabilitiesaad$;

  EXECUTE $mcapabilitiesaae$
CREATE INDEX idx_wmc_user ON public.workspace_member_capabilities (user_id)
$mcapabilitiesaae$;

  EXECUTE $mcapabilitiesaaf$
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
$$
$mcapabilitiesaaf$;

  EXECUTE $mcapabilitiesaag$
CREATE TRIGGER trg_wmc_guard BEFORE UPDATE OR DELETE ON public.workspace_member_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.workspace_member_capabilities_guard()
$mcapabilitiesaag$;

  EXECUTE $mcapabilitiesaah$
CREATE OR REPLACE FUNCTION public.workspace_member_capabilities_no_truncate()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'workspace_member_capabilities is append-only' USING ERRCODE = '42501';
END;
$$
$mcapabilitiesaah$;

  EXECUTE $mcapabilitiesaai$
CREATE TRIGGER trg_wmc_no_truncate BEFORE TRUNCATE ON public.workspace_member_capabilities
  FOR EACH STATEMENT EXECUTE FUNCTION public.workspace_member_capabilities_no_truncate()
$mcapabilitiesaai$;

  EXECUTE $mcapabilitiesaaj$
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
$$
$mcapabilitiesaaj$;

  EXECUTE $mcapabilitiesaak$
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
  -- Only a NEW membership receives its title's template, chosen by the inviter / the server when it was created. Saving
  -- or changing a title never adds or restores a capability (security correction B-1): grants are explicit.
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.workspace_member_capabilities (company_id, user_id, capability, source, granted_by)
    SELECT NEW.company_id, NEW.user_id, t.cap, 'ROLE_TEMPLATE', COALESCE(auth.uid(), NEW.invited_by)
      FROM unnest(public._title_capability_template(NEW.role)) AS t(cap)
    ON CONFLICT (company_id, user_id, capability) WHERE revoked_at IS NULL DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$
$mcapabilitiesaak$;

  EXECUTE $mcapabilitiesaal$
CREATE TRIGGER trg_firm_members_capability_template
  AFTER INSERT OR DELETE OR UPDATE OF role, company_id, user_id ON public.firm_members
  FOR EACH ROW EXECUTE FUNCTION public.firm_members_capability_template_sync()
$mcapabilitiesaal$;

  EXECUTE $mcapabilitiesaam$
-- Backfill: every existing membership gets exactly its title's template (the access it has today).
INSERT INTO public.workspace_member_capabilities (company_id, user_id, capability, source, granted_by, granted_at)
SELECT fm.company_id, fm.user_id, t.cap, 'ROLE_TEMPLATE', NULL, now()
  FROM public.firm_members fm CROSS JOIN LATERAL unnest(public._title_capability_template(fm.role)) AS t(cap)
ON CONFLICT (company_id, user_id, capability) WHERE revoked_at IS NULL DO NOTHING
$mcapabilitiesaam$;

  EXECUTE $mcapabilitiesaan$
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
$$
$mcapabilitiesaan$;

  EXECUTE $mcapabilitiesaao$
-- May this person EXERCISE the capability now? Held, and the workspace's account has a current plan (managing
-- members needs no plan: the account holder must be able to reduce the roster).
-- (workspace_capability_allowed: defined in section 5e, under the plan linearization lock.)

-- Account-scoped: the billing account holder.
CREATE OR REPLACE FUNCTION public.has_account_capability(p_user UUID, p_capability TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_user IS NOT NULL AND p_capability = 'manage_billing'
    AND (p_user = auth.uid() OR COALESCE(current_setting('role', true), '') NOT IN ('authenticated', 'anon'))
    AND (EXISTS (SELECT 1 FROM public.billing_customers b WHERE b.owner_user_id = p_user)
         OR EXISTS (SELECT 1 FROM public.companies c WHERE c.user_id = p_user));
$$
$mcapabilitiesaao$;

  EXECUTE $mcapabilitiesaap$
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
$$
$mcapabilitiesaap$;

  EXECUTE $mcapabilitiesaaq$
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
$$
$mcapabilitiesaaq$;

  EXECUTE $mcapabilitiesaar$
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
$$
$mcapabilitiesaar$;

  EXECUTE $mcapabilitiesaas$
ALTER TABLE public.workspace_member_capabilities ENABLE ROW LEVEL SECURITY
$mcapabilitiesaas$;

  EXECUTE $mcapabilitiesaat$
CREATE POLICY "wmc_select_self_or_manager" ON public.workspace_member_capabilities FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_workspace_capability(company_id, auth.uid(), 'manage_members'))
$mcapabilitiesaat$;

  EXECUTE $mcapabilitiesaau$
REVOKE ALL ON public.workspace_member_capabilities FROM PUBLIC, anon, authenticated, service_role
$mcapabilitiesaau$;

  EXECUTE $mcapabilitiesaav$
GRANT SELECT ON public.workspace_member_capabilities TO authenticated, service_role
$mcapabilitiesaav$;

  EXECUTE $mcapabilitiesaaw$
-- ── 5d. Membership integrity: accepting an invitation changes nothing but the acceptance (security correction B-1) ──
-- The policy firm_members_update_accept_invitation lets an invitee update their own pending row, and RLS cannot limit
-- the columns. This guard runs before every UPDATE on firm_members, for every role:
--   * the owner title is assigned only by company creation: no UPDATE may make anyone an owner (no second billing
--     owner can ever be created);
--   * a membership's workspace and person are immutable (no re-pointing, no detaching);
--   * the person themselves (not the account holder) may only accept: accepted_at from NULL to now, every other column
--     unchanged (title, invitation fields, inviter, email). A crafted payload, a repeated acceptance and an acceptance
--     of an expired or cancelled invitation (the seat wall, PT410) all fail and change nothing.
CREATE OR REPLACE FUNCTION public.firm_members_update_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF NEW.role = 'owner' AND OLD.role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'OWNER_TITLE_NOT_ASSIGNABLE: the owner title is assigned only when a company is created' USING ERRCODE = '42501';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'MEMBERSHIP_SCOPE_IMMUTABLE: a membership cannot move to another workspace or person' USING ERRCODE = '42501';
  END IF;
  IF v_uid IS NOT NULL AND v_uid = OLD.user_id
     AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id AND c.user_id = v_uid) THEN
    IF OLD.accepted_at IS NOT NULL OR NEW.accepted_at IS NULL
       OR (to_jsonb(NEW) - 'accepted_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'accepted_at' - 'updated_at') THEN
      RAISE EXCEPTION 'ACCEPTANCE_ONLY: an invitee may only accept their own pending invitation' USING ERRCODE = '42501';
    END IF;
    NEW.accepted_at := now();
  END IF;
  RETURN NEW;
END;
$$
$mcapabilitiesaaw$;

  EXECUTE $mcapabilitiesaax$
DROP TRIGGER IF EXISTS aa_firm_members_update_guard ON public.firm_members
$mcapabilitiesaax$;

  EXECUTE $mcapabilitiesaay$
CREATE TRIGGER aa_firm_members_update_guard BEFORE UPDATE ON public.firm_members
  FOR EACH ROW EXECUTE FUNCTION public.firm_members_update_guard()
$mcapabilitiesaay$;

  EXECUTE $mcapabilitiesaaz$
-- ── 5e. Expiry linearization (security correction B-6) ─────────────────────────────────────────────────────────
-- A financial write and a plan change of the same account serialise on one advisory key: every write path (the
-- reconciliation and Close Assurance walls, workspace_capability_allowed) takes it SHARED before reading the plan; every
-- licence or override change takes it EXCLUSIVE. Whichever commits first wins deterministically: a write that waited
-- for an expiry re-reads the plan after the lock and is refused; an expiry that waited for a write lands after it. The
-- plan is read with clock_timestamp(), never the transaction's start time.
CREATE OR REPLACE FUNCTION public._plan_lock_key(p_account UUID)
RETURNS BIGINT LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT hashtextextended('cfoclose.plan:' || COALESCE(p_account::text, ''), 0);
$$
$mcapabilitiesaaz$;

  EXECUTE $mcapabilitiesaaa$
CREATE OR REPLACE FUNCTION public._plan_write_lock(p_account UUID)
RETURNS VOID LANGUAGE sql VOLATILE SET search_path = pg_catalog, public AS $$
  SELECT pg_advisory_xact_lock_shared(public._plan_lock_key(p_account));
$$
$mcapabilitiesaaa$;

  EXECUTE $mcapabilitiesaab$
CREATE OR REPLACE FUNCTION public.commercial_plan_change_lock()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_bc UUID;
  v_account UUID;
BEGIN
  FOREACH v_bc IN ARRAY ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.billing_customer_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.billing_customer_id END] LOOP
    IF v_bc IS NOT NULL THEN
      SELECT b.owner_user_id INTO v_account FROM public.billing_customers b WHERE b.id = v_bc;
      PERFORM pg_advisory_xact_lock(public._plan_lock_key(v_account));
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$
$mcapabilitiesaab$;

  EXECUTE $mcapabilitiesaac$
DROP TRIGGER IF EXISTS aa_commercial_plan_change_lock ON public.commercial_licences
$mcapabilitiesaac$;

  EXECUTE $mcapabilitiesaad$
CREATE TRIGGER aa_commercial_plan_change_lock BEFORE INSERT OR UPDATE OR DELETE ON public.commercial_licences
  FOR EACH ROW EXECUTE FUNCTION public.commercial_plan_change_lock()
$mcapabilitiesaad$;

  EXECUTE $mcapabilitiesaae$
DROP TRIGGER IF EXISTS aa_commercial_plan_change_lock ON public.entitlement_overrides
$mcapabilitiesaae$;

  EXECUTE $mcapabilitiesaaf$
CREATE TRIGGER aa_commercial_plan_change_lock BEFORE INSERT OR UPDATE OR DELETE ON public.entitlement_overrides
  FOR EACH ROW EXECUTE FUNCTION public.commercial_plan_change_lock()
$mcapabilitiesaaf$;

  EXECUTE $mcapabilitiesaag$
-- Exercising a capability: held, and (under the shared plan lock) a current plan.
CREATE OR REPLACE FUNCTION public.workspace_capability_allowed(p_company_id UUID, p_user UUID, p_capability TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_account UUID;
BEGIN
  IF NOT public.has_workspace_capability(p_company_id, p_user, p_capability) THEN RETURN false; END IF;
  IF p_capability = 'manage_members' THEN RETURN true; END IF;
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
  PERFORM public._plan_write_lock(v_account);
  RETURN public._account_has_current_plan(v_account);
END;
$$
$mcapabilitiesaag$;

  EXECUTE $mcapabilitiesaah$
-- ── 5f. Evidence attachment (security correction B-5) ──────────────────────────────────────────────────────────
-- Called by safisha-ingest with the signed-in person's own client. Pinned search_path; runs only for a person who can
-- see the reconciliation, under the reconciliation write wall (current plan + prepare_close); validated inputs; the
-- caller must treat any error as a failure. Attaches exactly one entry or nothing.
DROP FUNCTION IF EXISTS public.safisha_append_evidence_file(uuid, text, text, integer)
$mcapabilitiesaah$;

  EXECUTE $mcapabilitiesaai$
CREATE OR REPLACE FUNCTION public.safisha_append_evidence_file(p_recon_id uuid, p_source_type text, p_filename text, p_rows integer)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF auth.uid() IS NULL AND COALESCE(current_setting('role', true), '') IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;
  IF p_recon_id IS NULL OR p_source_type IS NULL OR p_source_type NOT IN ('tb', 'bank', 'subledger', 'momo')
     OR p_filename IS NULL OR length(p_filename) NOT BETWEEN 1 AND 255 OR p_filename ~ '[[:cntrl:]]'
     OR p_rows IS NULL OR p_rows < 0 THEN
    RAISE EXCEPTION 'INVALID_EVIDENCE_ATTACHMENT' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.safisha_recon_visible(p_recon_id) THEN
    RAISE EXCEPTION 'RECONCILIATION_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  UPDATE public.safisha_reconciliations
     SET evidence_files = evidence_files || jsonb_build_array(jsonb_build_object(
           'source_type', p_source_type, 'filename', p_filename, 'rows', p_rows,
           'uploaded_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
   WHERE id = p_recon_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'RECONCILIATION_NOT_FOUND' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('outcome', 'attached', 'reconciliation_id', p_recon_id);
END;
$$
$mcapabilitiesaai$;

  EXECUTE $mcapabilitiesaaj$
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
$function$
$mcapabilitiesaaj$;

  EXECUTE $mcapabilitiesaak$
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
$function$
$mcapabilitiesaak$;

  EXECUTE $mcapabilitiesaal$
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
$function$
$mcapabilitiesaal$;

  EXECUTE $mcapabilitiesaam$
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
$function$
$mcapabilitiesaam$;

  EXECUTE $mcapabilitiesaan$
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
$function$
$mcapabilitiesaan$;

  EXECUTE $mcapabilitiesaao$
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
$function$
$mcapabilitiesaao$;

  EXECUTE $mcapabilitiesaap$
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
$function$
$mcapabilitiesaap$;

  EXECUTE $mcapabilitiesaaq$
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
$function$
$mcapabilitiesaaq$;

  EXECUTE $mcapabilitiesaar$
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
$function$
$mcapabilitiesaar$;

  EXECUTE $mcapabilitiesaas$
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
$function$
$mcapabilitiesaas$;

  EXECUTE $mcapabilitiesaat$
-- The OFFICIAL bytes are hashed by the server (20260925140000, security correction B-4). A browser-supplied hash can
-- never make a file official: consume_reporting_pack_issuance (which accepted one) is removed. The seal-reporting-pack
-- Edge Function receives the exact bytes, computes their SHA-256 itself, stores them in the private reporting-packs
-- bucket (no client write, no overwrite) and only then calls seal_reporting_pack_server, which is executable by the
-- service role alone and takes the user id from the verified JWT. The stored object's path and size are sealed with
-- the hash, so a later substitution of the object is detectable (verify-by-rehash in the Edge Function).
DROP FUNCTION public.consume_reporting_pack_issuance(UUID, UUID, INTEGER, TEXT, TEXT, TEXT)
$mcapabilitiesaat$;

  EXECUTE $mcapabilitiesaau$
ALTER TABLE public.reporting_pack_issuances DISABLE TRIGGER trg_rpi_immutable
$mcapabilitiesaau$;

  EXECUTE $mcapabilitiesaav$
ALTER TABLE public.reporting_pack_issuances
  ADD COLUMN storage_path TEXT   NULL,
  ADD COLUMN byte_size    BIGINT NULL,
  DROP CONSTRAINT chk_rpi_seal,
  -- A seal made before this migration (client-supplied hash) keeps its row but has no stored object and is never
  -- official (verify_reporting_pack below requires the server-stored object).
  ADD CONSTRAINT chk_rpi_seal CHECK ((consumed_at IS NULL) = (content_sha256 IS NULL) AND (consumed_at IS NULL) = (consumed_plan_code IS NULL)
                                     AND (storage_path IS NULL) = (byte_size IS NULL) AND (storage_path IS NULL OR consumed_at IS NOT NULL)),
  ADD CONSTRAINT chk_rpi_storage_path CHECK (storage_path IS NULL OR storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|xlsx|csv|json|txt|xml|zip)$'),
  ADD CONSTRAINT chk_rpi_byte_size CHECK (byte_size IS NULL OR byte_size BETWEEN 1 AND 52428800)
$mcapabilitiesaav$;

  EXECUTE $mcapabilitiesaaw$
ALTER TABLE public.reporting_pack_issuances ENABLE TRIGGER trg_rpi_immutable
$mcapabilitiesaaw$;

  EXECUTE $mcapabilitiesaax$
-- Immutable except ONE seal (hash, plan, stored object and size, from NULL); never deleted.
CREATE OR REPLACE FUNCTION public.reporting_pack_issuances_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
     AND (to_jsonb(NEW) - 'consumed_at' - 'content_sha256' - 'consumed_plan_code' - 'storage_path' - 'byte_size')
       = (to_jsonb(OLD) - 'consumed_at' - 'content_sha256' - 'consumed_plan_code' - 'storage_path' - 'byte_size') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Iron Dome: reporting_pack_issuances is append-only except for a single seal (% refused).', TG_OP USING ERRCODE = 'P0001';
END;
$$
$mcapabilitiesaax$;

  EXECUTE $mcapabilitiesaay$
-- Closed, format-specific output references: each kind accepts only its own reference forms, and every reference must
-- name a record of THIS workspace and period. Free text, drafts and unknown forms are refused.
CREATE OR REPLACE FUNCTION public._reporting_pack_output_ref_valid(p_company_id UUID, p_period_year INTEGER, p_kind TEXT, p_output_ref TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  m TEXT[];
  v_uuid TEXT := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_kind IS NULL OR p_output_ref IS NULL OR length(p_output_ref) > 200 THEN
    RETURN false;
  END IF;
  -- A saved financial-statements report version.
  m := regexp_match(p_output_ref, '^fs-report:([A-Za-z0-9_-]{1,120}):v([0-9]{1,6})$');
  IF m IS NOT NULL THEN
    RETURN p_kind IN ('financial_statements_pdf', 'financial_statements_spreadsheet', 'financial_statements_data', 'client_pack', 'filing_pack')
       AND EXISTS (SELECT 1 FROM public.financial_statement_reports r
                    WHERE r.report_id = m[1] AND r.report_version = m[2]::integer AND r.company_id = p_company_id AND r.period_year = p_period_year);
  END IF;
  -- A trial balance upload of this workspace and period.
  m := regexp_match(p_output_ref, '^upload:(' || v_uuid || ')$');
  IF m IS NOT NULL THEN
    RETURN p_kind IN ('financial_statements_pdf', 'financial_statements_spreadsheet', 'financial_statements_data', 'filing_pack',
                      'management_letter', 'disclosure_notes', 'tax_computation')
       AND EXISTS (SELECT 1 FROM public.trial_balance_uploads u WHERE u.id = m[1]::uuid AND u.company_id = p_company_id AND u.period_year = p_period_year);
  END IF;
  -- A variance run of this workspace (board pack).
  m := regexp_match(p_output_ref, '^variance-run:(' || v_uuid || ')$');
  IF m IS NOT NULL THEN
    RETURN p_kind = 'board_pack' AND EXISTS (SELECT 1 FROM public.variance_runs v WHERE v.id = m[1]::uuid AND v.company_id = p_company_id);
  END IF;
  -- Tax workpaper schedules of this workspace and period.
  m := regexp_match(p_output_ref, '^(capital-allowances|audit-manifest):(' || v_uuid || '):FY([0-9]{4})$');
  IF m IS NOT NULL THEN
    RETURN p_kind = 'tax_workpaper' AND m[2]::uuid = p_company_id AND m[3]::integer = p_period_year;
  END IF;
  RETURN false;
END;
$$
$mcapabilitiesaay$;

  EXECUTE $mcapabilitiesaaz$
-- Outcomes: sealed | not_found (unknown, or issued to someone else) | binding_mismatch | already_sealed | expired |
--           entitlement_required | capability_required | workspace_access_denied | invalid_request
CREATE OR REPLACE FUNCTION public.seal_reporting_pack_server(
  p_user UUID, p_issuance_id UUID, p_company_id UUID, p_period_year INTEGER, p_pack_kind TEXT, p_output_ref TEXT,
  p_content_sha256 TEXT, p_storage_path TEXT, p_byte_size BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row  public.reporting_pack_issuances%ROWTYPE;
  v_auth JSONB;
  v_kind_auth JSONB;
  v_code TEXT;
BEGIN
  IF p_user IS NULL OR p_issuance_id IS NULL OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_storage_path IS NULL OR p_byte_size IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE id = p_issuance_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.issued_by <> p_user THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_row.company_id IS DISTINCT FROM p_company_id OR v_row.period_year IS DISTINCT FROM p_period_year
     OR v_row.pack_kind IS DISTINCT FROM p_pack_kind OR v_row.output_ref IS DISTINCT FROM p_output_ref
     OR p_storage_path IS DISTINCT FROM (v_row.company_id::text || '/' || v_row.id::text || '.' || split_part(p_storage_path, '.', 2)) THEN
    v_code := 'binding_mismatch';
  ELSIF v_row.consumed_at IS NOT NULL THEN
    v_code := 'already_sealed';
  ELSIF v_row.expires_at <= clock_timestamp() THEN
    v_code := 'expired';
  ELSIF NOT public._reporting_pack_output_ref_valid(v_row.company_id, v_row.period_year, v_row.pack_kind, v_row.output_ref) THEN
    v_code := 'binding_mismatch';
  ELSE
    v_auth := public._authorize_paid_action(p_user, v_row.company_id, 'REPORTING_PACK_EXPORT');
    IF (v_auth->>'allowed')::boolean THEN
      v_kind_auth := public._authorize_paid_action(p_user, v_row.company_id, (SELECT f.capability_code FROM public.reporting_pack_kind_features f WHERE f.pack_kind = v_row.pack_kind));
      IF NOT (v_kind_auth->>'allowed')::boolean THEN v_auth := v_kind_auth; END IF;
    END IF;
    IF NOT (v_auth->>'allowed')::boolean THEN
      v_code := lower(v_auth->>'code');
    ELSIF NOT public.has_workspace_capability(v_row.company_id, p_user, 'issue_reporting_pack') THEN
      v_code := 'capability_required';
    END IF;
  END IF;
  IF v_code IS NOT NULL THEN
    INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail)
    VALUES (v_row.id, v_row.company_id, p_user, 'REFUSED', jsonb_build_object('stage', 'seal', 'code', upper(v_code)));
    RETURN jsonb_build_object('outcome', v_code);
  END IF;
  UPDATE public.reporting_pack_issuances
     SET consumed_at = clock_timestamp(), content_sha256 = p_content_sha256, consumed_plan_code = v_auth->>'plan_code',
         storage_path = p_storage_path, byte_size = p_byte_size
   WHERE id = v_row.id;
  INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail)
  VALUES (v_row.id, v_row.company_id, p_user, 'SEALED', jsonb_build_object('content_sha256', p_content_sha256, 'pack_kind', v_row.pack_kind,
          'storage_path', p_storage_path, 'byte_size', p_byte_size, 'hashed_by', 'server'));
  RETURN jsonb_build_object('outcome', 'sealed', 'issuance_id', v_row.id, 'content_sha256', p_content_sha256);
END;
$$
$mcapabilitiesaaz$;

  EXECUTE $mcapabilitiesaba$
-- Official = sealed by the server with its stored object. A pre-migration client-hash seal is never official.
CREATE OR REPLACE FUNCTION public.verify_reporting_pack(p_content_sha256 TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $vrp$
DECLARE
  v_row public.reporting_pack_issuances%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('official', false);
  END IF;
  SELECT i.* INTO v_row FROM public.reporting_pack_issuances i
   WHERE i.content_sha256 = p_content_sha256 AND i.consumed_at IS NOT NULL AND i.storage_path IS NOT NULL AND public.can_access_workspace(i.company_id)
   ORDER BY i.consumed_at DESC LIMIT 1;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('official', false);
  END IF;
  RETURN jsonb_build_object('official', true, 'issuance_id', v_row.id, 'company_id', v_row.company_id, 'period_year', v_row.period_year,
    'pack_kind', v_row.pack_kind, 'output_ref', v_row.output_ref, 'issued_at', v_row.issued_at, 'sealed_at', v_row.consumed_at,
    'hashed_by', 'server');
END;
$vrp$
$mcapabilitiesaba$;

  EXECUTE $mcapabilitiesabb$
-- The stored object of a sealed issuance, for the Edge Function's verify-by-rehash (service role only).
CREATE OR REPLACE FUNCTION public.reporting_pack_sealed_object(p_issuance_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('issuance_id', i.id, 'company_id', i.company_id, 'storage_path', i.storage_path,
                            'content_sha256', i.content_sha256, 'byte_size', i.byte_size)
    FROM public.reporting_pack_issuances i WHERE i.id = p_issuance_id AND i.consumed_at IS NOT NULL;
$$
$mcapabilitiesabb$;

  EXECUTE $mcapabilitiesabc$
-- Private bucket for sealed official bytes: no client policy exists on it (the service role writes, never overwrites).
INSERT INTO storage.buckets (id, name, public) VALUES ('reporting-packs', 'reporting-packs', false) ON CONFLICT (id) DO NOTHING
$mcapabilitiesabc$;

  EXECUTE $mcapabilitiesabd$
REVOKE ALL ON FUNCTION public.seal_reporting_pack_server(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated
$mcapabilitiesabd$;

  EXECUTE $mcapabilitiesabe$
GRANT EXECUTE ON FUNCTION public.seal_reporting_pack_server(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, BIGINT) TO service_role
$mcapabilitiesabe$;

  EXECUTE $mcapabilitiesabf$
REVOKE ALL ON FUNCTION public.reporting_pack_sealed_object(UUID) FROM PUBLIC, anon, authenticated
$mcapabilitiesabf$;

  EXECUTE $mcapabilitiesabg$
GRANT EXECUTE ON FUNCTION public.reporting_pack_sealed_object(UUID) TO service_role
$mcapabilitiesabg$;

  EXECUTE $mcapabilitiesabh$
REVOKE ALL ON FUNCTION public._reporting_pack_output_ref_valid(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated
$mcapabilitiesabh$;

  EXECUTE $mcapabilitiesabi$
-- ── 5. RLS policies: the same member row, a capability instead of a title (generated) ────────
ALTER POLICY "account_pl_mapping_delete" ON public.account_pl_mapping USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))))
$mcapabilitiesabi$;

  EXECUTE $mcapabilitiesabj$
ALTER POLICY "account_pl_mapping_update" ON public.account_pl_mapping USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text)))))) WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))))
$mcapabilitiesabj$;

  EXECUTE $mcapabilitiesabk$
ALTER POLICY "account_pl_mapping_write" ON public.account_pl_mapping WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))))
$mcapabilitiesabk$;

  EXECUTE $mcapabilitiesabl$
ALTER POLICY "aje_insert" ON public.adjusting_journal_entries WITH CHECK (((auth.uid() = created_by) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))))
$mcapabilitiesabl$;

  EXECUTE $mcapabilitiesabm$
ALTER POLICY "aje_select" ON public.adjusting_journal_entries USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesabm$;

  EXECUTE $mcapabilitiesabn$
ALTER POLICY "aje_update_draft_preparer" ON public.adjusting_journal_entries USING (((status = 'draft'::text) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text) AND (NOT public.has_workspace_capability(fm.company_id, fm.user_id, 'approve_certification'::text)))))))) WITH CHECK (((status = ANY (ARRAY['draft'::text, 'submitted'::text])) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text) AND (NOT public.has_workspace_capability(fm.company_id, fm.user_id, 'approve_certification'::text))))))))
$mcapabilitiesabn$;

  EXECUTE $mcapabilitiesabo$
ALTER POLICY "aje_update_partner_owner" ON public.adjusting_journal_entries USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'approve_certification'::text)))))) WITH CHECK (((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = adjusting_journal_entries.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'approve_certification'::text))))) AND ((approved_by IS NULL) OR (approved_by IS DISTINCT FROM created_by)) AND ((status <> ALL (ARRAY['approved'::text, 'reversed'::text])) OR (auth.uid() IS DISTINCT FROM created_by))))
$mcapabilitiesabo$;

  EXECUTE $mcapabilitiesabp$
ALTER POLICY "aje_lines_insert" ON public.aje_lines WITH CHECK ((EXISTS ( SELECT 1
   FROM (adjusting_journal_entries a
     JOIN firm_members fm ON ((fm.company_id = a.company_id)))
  WHERE ((a.id = aje_lines.aje_id) AND (fm.user_id = auth.uid()) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesabp$;

  EXECUTE $mcapabilitiesabq$
ALTER POLICY "aje_lines_select" ON public.aje_lines USING ((EXISTS ( SELECT 1
   FROM (adjusting_journal_entries a
     JOIN firm_members fm ON ((fm.company_id = a.company_id)))
  WHERE ((a.id = aje_lines.aje_id) AND (fm.user_id = auth.uid()) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesabq$;

  EXECUTE $mcapabilitiesabr$
ALTER POLICY "ca_delete" ON public.capital_allowances USING (((created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = capital_allowances.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))))
$mcapabilitiesabr$;

  EXECUTE $mcapabilitiesabs$
ALTER POLICY "ca_insert" ON public.capital_allowances WITH CHECK (((auth.uid() = created_by) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = capital_allowances.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))))
$mcapabilitiesabs$;

  EXECUTE $mcapabilitiesabt$
ALTER POLICY "ca_select" ON public.capital_allowances USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = capital_allowances.company_id) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesabt$;

  EXECUTE $mcapabilitiesabu$
ALTER POLICY "ca_update" ON public.capital_allowances USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = capital_allowances.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = capital_allowances.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesabu$;

  EXECUTE $mcapabilitiesabv$
ALTER POLICY "Senior members create engagements" ON public.engagements WITH CHECK (((company_id IN ( SELECT get_member_company_ids() AS get_member_company_ids)) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.id = engagements.created_by_member_id) AND (fm.user_id = auth.uid()) AND (fm.company_id = engagements.company_id) AND (fm.accepted_at IS NOT NULL) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'review_close'::text)))))))
$mcapabilitiesabv$;

  EXECUTE $mcapabilitiesabw$
ALTER POLICY "Senior members update engagement status" ON public.engagements USING (((company_id IN ( SELECT get_member_company_ids() AS get_member_company_ids)) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = engagements.company_id) AND (fm.accepted_at IS NOT NULL) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'review_close'::text))))))) WITH CHECK ((company_id IN ( SELECT get_member_company_ids() AS get_member_company_ids)))
$mcapabilitiesabw$;

  EXECUTE $mcapabilitiesabx$
ALTER POLICY "mi_insert" ON public.management_inputs WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesabx$;

  EXECUTE $mcapabilitiesaby$
ALTER POLICY "mi_select" ON public.management_inputs USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesaby$;

  EXECUTE $mcapabilitiesabz$
ALTER POLICY "mi_update" ON public.management_inputs USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesabz$;

  EXECUTE $mcapabilitiesaca$
ALTER POLICY "sso_insert" ON public.statement_sign_offs WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesaca$;

  EXECUTE $mcapabilitiesacb$
ALTER POLICY "sso_select" ON public.statement_sign_offs USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesacb$;

  EXECUTE $mcapabilitiesacc$
ALTER POLICY "sso_update_partner_owner" ON public.statement_sign_offs USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'approve_certification'::text)))))) WITH CHECK (((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'approve_certification'::text))))) AND ((reviewer_signed_at IS NULL) OR (reviewer_id IS DISTINCT FROM preparer_id)) AND ((approver_signed_at IS NULL) OR ((approver_id IS DISTINCT FROM preparer_id) AND (approver_id IS DISTINCT FROM reviewer_id)))))
$mcapabilitiesacc$;

  EXECUTE $mcapabilitiesacd$
ALTER POLICY "sso_update_preparer" ON public.statement_sign_offs USING (((locked_at IS NULL) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text) AND (NOT public.has_workspace_capability(fm.company_id, fm.user_id, 'approve_certification'::text)))))))) WITH CHECK (((locked_at IS NULL) AND (reviewer_signed_at IS NULL) AND (approver_signed_at IS NULL) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = statement_sign_offs.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text) AND (NOT public.has_workspace_capability(fm.company_id, fm.user_id, 'approve_certification'::text))))))))
$mcapabilitiesacd$;

  EXECUTE $mcapabilitiesace$
ALTER POLICY "tl_insert" ON public.tax_losses WITH CHECK (((auth.uid() = created_by) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_losses.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))))
$mcapabilitiesace$;

  EXECUTE $mcapabilitiesacf$
ALTER POLICY "tl_select" ON public.tax_losses USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_losses.company_id) AND (public.has_workspace_capability(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesacf$;

  EXECUTE $mcapabilitiesacg$
ALTER POLICY "tl_update" ON public.tax_losses USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_losses.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_losses.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesacg$;

  EXECUTE $mcapabilitiesach$
ALTER POLICY "tax_payments_delete" ON public.tax_payments USING (((created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_payments.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))))
$mcapabilitiesach$;

  EXECUTE $mcapabilitiesaci$
ALTER POLICY "tax_payments_insert" ON public.tax_payments WITH CHECK (((auth.uid() = created_by) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_payments.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))))
$mcapabilitiesaci$;

  EXECUTE $mcapabilitiesacj$
ALTER POLICY "tax_payments_update" ON public.tax_payments USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_payments.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_payments.company_id) AND (public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close'::text))))))
$mcapabilitiesacj$;

  EXECUTE $mcapabilitiesack$
ALTER POLICY "budget_approve" ON public.variance_budgets USING (((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))) AND (approved_by IS NULL) AND (submitted_by IS DISTINCT FROM auth.uid()))) WITH CHECK (((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))) AND (submitted_by IS DISTINCT FROM auth.uid()) AND ((approved_by IS NULL) OR (approved_by = auth.uid())) AND (approved_by IS DISTINCT FROM submitted_by)))
$mcapabilitiesack$;

  EXECUTE $mcapabilitiesacl$
ALTER POLICY "variance_materiality_write" ON public.variance_materiality USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (public.workspace_capability_allowed(firm_members.company_id, firm_members.user_id, 'review_close'::text))))))
$mcapabilitiesacl$;

  EXECUTE $mcapabilitiesacm$
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
    PERFORM public._plan_write_lock((SELECT c.user_id FROM public.companies c WHERE c.id = v_company));
    PERFORM public._require_workspace_capability(v_company, 'CLOSE_ASSURANCE');
  END IF;
  RETURN NEW;
END;
$$
$mcapabilitiesacm$;

  EXECUTE $mcapabilitiesacn$
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.trial_balance_uploads
$mcapabilitiesacn$;

  EXECUTE $mcapabilitiesaco$
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.trial_balance_uploads FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall()
$mcapabilitiesaco$;

  EXECUTE $mcapabilitiesacp$
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.safisha_reconciliations
$mcapabilitiesacp$;

  EXECUTE $mcapabilitiesacq$
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.safisha_reconciliations FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall()
$mcapabilitiesacq$;

  EXECUTE $mcapabilitiesacr$
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.hesabu_validations
$mcapabilitiesacr$;

  EXECUTE $mcapabilitiesacs$
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.hesabu_validations FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall()
$mcapabilitiesacs$;

  EXECUTE $mcapabilitiesact$
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.tax_computations
$mcapabilitiesact$;

  EXECUTE $mcapabilitiesacu$
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.tax_computations FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall()
$mcapabilitiesacu$;

  EXECUTE $mcapabilitiesacv$
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.period_closing_balances
$mcapabilitiesacv$;

  EXECUTE $mcapabilitiesacw$
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.period_closing_balances FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall()
$mcapabilitiesacw$;

  EXECUTE $mcapabilitiesacx$
DROP TRIGGER IF EXISTS trg_close_assurance_wall ON public.findings
$mcapabilitiesacx$;

  EXECUTE $mcapabilitiesacy$
CREATE TRIGGER trg_close_assurance_wall BEFORE INSERT ON public.findings FOR EACH ROW EXECUTE FUNCTION public.close_assurance_wall()
$mcapabilitiesacy$;

  EXECUTE $mcapabilitiesacz$
-- ── 5c. Reconciliation write wall: every reconciliation mutation needs a current plan and the capability ─────────
-- Inventory (every write path to reconciliation state; nothing else writes these tables):
--   safisha_reconciliations  INSERT (safisha-ingest, client RLS), UPDATE (safisha-match / -categorize / -score, client
--                            RLS; safisha_append_evidence_file; safisha_resolve_exception), DELETE (no policy; service)
--   safisha_transactions     INSERT (safisha-ingest, client RLS); UPDATE / DELETE already refused (immutable)
--   safisha_exceptions       INSERT (safisha-categorize, client RLS); UPDATE only through safisha_resolve_exception
--                            (safisha-resolve); DELETE already refused
--   safisha_audit_log        INSERT only through safisha_resolve_exception; UPDATE / DELETE already refused
--   efdms_reconciliation, efdms_records, efdms_z_reports  INSERT (safisha-efdms-ingest, client RLS / service role)
-- The wall runs BEFORE every INSERT, UPDATE and DELETE on all seven tables, on every path (client, RPC, service role):
--   the reconciliation's account (the workspace owner; for a personal upload, its owner) must have a current plan,
--   else PT402 (DETAIL CLOSE_ASSURANCE, HINT NO_PLAN); and a signed-in actor must hold prepare_close in the workspace
--   (a personal reconciliation: be its owner), else 42501. A refused statement writes nothing. Reads are untouched:
--   history stays readable to whoever could read it. A row whose parent is already gone (a cascade) is not blocked.
-- safisha_client_mappings is the signed-in person's own column-mapping preference (no workspace, no reconciliation
-- state) and is deliberately outside the wall.
CREATE OR REPLACE FUNCTION public.reconciliation_write_wall()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  -- UPDATE and DELETE are authorized against the row's EXISTING scope (OLD); INSERT against the new one.
  v_row     JSONB := to_jsonb(CASE WHEN TG_OP = 'INSERT' THEN NEW ELSE OLD END);
  v_recon   UUID;
  v_upload  UUID;
  v_company UUID;
  v_account UUID;
  v_found   BOOLEAN := false;
  v_actor   UUID := auth.uid();
BEGIN
  -- A record's scope binding never changes after creation (no re-pointing or detaching across workspaces, companies,
  -- uploads or reconciliations), for every role including the service role (security correction B-2).
  IF TG_OP = 'UPDATE' AND (
       (TG_TABLE_NAME LIKE 'efdms%' AND (to_jsonb(NEW)->>'company_id') IS DISTINCT FROM (to_jsonb(OLD)->>'company_id'))
    OR (TG_TABLE_NAME = 'safisha_reconciliations' AND ((to_jsonb(NEW)->>'tb_upload_id') IS DISTINCT FROM (to_jsonb(OLD)->>'tb_upload_id')
                                                    OR (to_jsonb(NEW)->>'client_id') IS DISTINCT FROM (to_jsonb(OLD)->>'client_id')))
    OR (TG_TABLE_NAME IN ('safisha_transactions', 'safisha_exceptions', 'safisha_audit_log')
        AND (to_jsonb(NEW)->>'reconciliation_id') IS DISTINCT FROM (to_jsonb(OLD)->>'reconciliation_id'))
    OR (TG_TABLE_NAME = 'efdms_z_reports' AND (to_jsonb(NEW)->>'upload_id') IS DISTINCT FROM (to_jsonb(OLD)->>'upload_id'))) THEN
    RAISE EXCEPTION 'RECONCILIATION_SCOPE_IMMUTABLE: a record cannot be moved to another workspace, upload or reconciliation' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME LIKE 'efdms%' THEN
    v_company := (v_row->>'company_id')::uuid;
    SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = v_company;
    v_found := FOUND;
  ELSE
    IF TG_TABLE_NAME = 'safisha_reconciliations' THEN
      v_upload := (v_row->>'tb_upload_id')::uuid;
      SELECT u.company_id, COALESCE(c.user_id, u.user_id, (v_row->>'client_id')::uuid) INTO v_company, v_account
        FROM public.trial_balance_uploads u LEFT JOIN public.companies c ON c.id = u.company_id WHERE u.id = v_upload;
      v_found := FOUND;
    ELSE
      v_recon := (v_row->>'reconciliation_id')::uuid;
      SELECT u.company_id, COALESCE(c.user_id, u.user_id, r.client_id) INTO v_company, v_account
        FROM public.safisha_reconciliations r
        JOIN public.trial_balance_uploads u ON u.id = r.tb_upload_id
        LEFT JOIN public.companies c ON c.id = u.company_id
       WHERE r.id = v_recon;
      v_found := FOUND;
    END IF;
  END IF;
  IF NOT v_found THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;              -- the parent is already gone: a cascade
    RAISE EXCEPTION 'RECONCILIATION_SCOPE_UNKNOWN' USING ERRCODE = '42501';
  END IF;
  PERFORM public._plan_write_lock(v_account);
  IF NOT public._account_has_current_plan(v_account) THEN
    RAISE EXCEPTION 'RECONCILIATION_READ_ONLY: this account has no current plan' USING ERRCODE = 'PT402', DETAIL = 'CLOSE_ASSURANCE', HINT = 'NO_PLAN';
  END IF;
  IF v_actor IS NOT NULL AND (
       (v_company IS NOT NULL AND NOT public.workspace_capability_allowed(v_company, v_actor, 'prepare_close'))
       OR (v_company IS NULL AND v_actor IS DISTINCT FROM v_account)) THEN
    RAISE EXCEPTION 'CAPABILITY_REQUIRED: reconciliation changes need prepare_close in this workspace' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$
$mcapabilitiesacz$;

  EXECUTE $mcapabilitiesada$
DROP TRIGGER IF EXISTS aa_reconciliation_write_wall ON public.safisha_reconciliations
$mcapabilitiesada$;

  EXECUTE $mcapabilitiesadb$
CREATE TRIGGER aa_reconciliation_write_wall BEFORE INSERT OR UPDATE OR DELETE ON public.safisha_reconciliations FOR EACH ROW EXECUTE FUNCTION public.reconciliation_write_wall()
$mcapabilitiesadb$;

  EXECUTE $mcapabilitiesadc$
DROP TRIGGER IF EXISTS aa_reconciliation_write_wall ON public.safisha_transactions
$mcapabilitiesadc$;

  EXECUTE $mcapabilitiesadd$
CREATE TRIGGER aa_reconciliation_write_wall BEFORE INSERT OR UPDATE OR DELETE ON public.safisha_transactions FOR EACH ROW EXECUTE FUNCTION public.reconciliation_write_wall()
$mcapabilitiesadd$;

  EXECUTE $mcapabilitiesade$
DROP TRIGGER IF EXISTS aa_reconciliation_write_wall ON public.safisha_exceptions
$mcapabilitiesade$;

  EXECUTE $mcapabilitiesadf$
CREATE TRIGGER aa_reconciliation_write_wall BEFORE INSERT OR UPDATE OR DELETE ON public.safisha_exceptions FOR EACH ROW EXECUTE FUNCTION public.reconciliation_write_wall()
$mcapabilitiesadf$;

  EXECUTE $mcapabilitiesadg$
DROP TRIGGER IF EXISTS aa_reconciliation_write_wall ON public.safisha_audit_log
$mcapabilitiesadg$;

  EXECUTE $mcapabilitiesadh$
CREATE TRIGGER aa_reconciliation_write_wall BEFORE INSERT OR UPDATE OR DELETE ON public.safisha_audit_log FOR EACH ROW EXECUTE FUNCTION public.reconciliation_write_wall()
$mcapabilitiesadh$;

  EXECUTE $mcapabilitiesadi$
DROP TRIGGER IF EXISTS aa_reconciliation_write_wall ON public.efdms_reconciliation
$mcapabilitiesadi$;

  EXECUTE $mcapabilitiesadj$
CREATE TRIGGER aa_reconciliation_write_wall BEFORE INSERT OR UPDATE OR DELETE ON public.efdms_reconciliation FOR EACH ROW EXECUTE FUNCTION public.reconciliation_write_wall()
$mcapabilitiesadj$;

  EXECUTE $mcapabilitiesadk$
DROP TRIGGER IF EXISTS aa_reconciliation_write_wall ON public.efdms_records
$mcapabilitiesadk$;

  EXECUTE $mcapabilitiesadl$
CREATE TRIGGER aa_reconciliation_write_wall BEFORE INSERT OR UPDATE OR DELETE ON public.efdms_records FOR EACH ROW EXECUTE FUNCTION public.reconciliation_write_wall()
$mcapabilitiesadl$;

  EXECUTE $mcapabilitiesadm$
DROP TRIGGER IF EXISTS aa_reconciliation_write_wall ON public.efdms_z_reports
$mcapabilitiesadm$;

  EXECUTE $mcapabilitiesadn$
CREATE TRIGGER aa_reconciliation_write_wall BEFORE INSERT OR UPDATE OR DELETE ON public.efdms_z_reports FOR EACH ROW EXECUTE FUNCTION public.reconciliation_write_wall()
$mcapabilitiesadn$;

  EXECUTE $mcapabilitiesado$
-- The exception resolver (safisha-resolve, service role, reviewer id from the verified JWT): identical to its previous
-- definition except the plan and capability check before any write.
CREATE OR REPLACE FUNCTION public.safisha_resolve_exception(p_exception_id uuid, p_reviewer_id uuid, p_action text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_exception  safisha_exceptions%ROWTYPE;
  v_recon      safisha_reconciliations%ROWTYPE;
  v_remaining  INTEGER;
  v_member_id  UUID;
  v_company    UUID;
  v_account    UUID;
BEGIN
  IF p_action NOT IN ('approved','rejected','escalated') THEN
    RAISE EXCEPTION 'Invalid reviewer_action: %. Must be approved|rejected|escalated', p_action;
  END IF;

  SELECT * INTO v_exception FROM safisha_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exception % not found', p_exception_id;
  END IF;
  -- 20260925140000: the reviewer must hold prepare_close in this workspace and its account must have a current plan
  -- (a personal, company-less reconciliation: the reviewer must be its owner). Checked before anything is written.
  SELECT u.company_id, COALESCE(c.user_id, u.user_id, r.client_id) INTO v_company, v_account
    FROM public.safisha_reconciliations r
    JOIN public.trial_balance_uploads u ON u.id = r.tb_upload_id
    LEFT JOIN public.companies c ON c.id = u.company_id
   WHERE r.id = v_exception.reconciliation_id;
  IF NOT public._account_has_current_plan(v_account) THEN
    RAISE EXCEPTION 'RECONCILIATION_READ_ONLY' USING ERRCODE = 'PT402', DETAIL = 'CLOSE_ASSURANCE', HINT = 'NO_PLAN';
  END IF;
  IF (v_company IS NOT NULL AND NOT public.workspace_capability_allowed(v_company, p_reviewer_id, 'prepare_close'))
     OR (v_company IS NULL AND p_reviewer_id IS DISTINCT FROM v_account) THEN
    RAISE EXCEPTION 'CAPABILITY_REQUIRED: resolving a reconciliation exception needs prepare_close in this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_exception.reviewer_action <> 'pending' THEN
    RAISE EXCEPTION 'Exception % is already resolved (%)', p_exception_id, v_exception.reviewer_action;
  END IF;

  -- v2.3 Phase 1: resolve firm_members.id via reconciliation → upload → company
  SELECT fm.id INTO v_member_id
  FROM public.firm_members fm
  JOIN public.trial_balance_uploads tbu ON tbu.company_id = fm.company_id
  JOIN public.safisha_reconciliations sr
    ON sr.tb_upload_id = tbu.id AND sr.id = v_exception.reconciliation_id
  WHERE fm.user_id = p_reviewer_id
  LIMIT 1;
  -- v_member_id may be NULL if reviewer has no firm membership for this company
  -- (e.g. service_role pipeline call). This is intentional — NULL is acceptable.

  PERFORM set_config('safisha.resolve_authorized', 'true', TRUE);

  UPDATE safisha_exceptions SET
    reviewer_action    = p_action,
    reviewer_id        = p_reviewer_id,   -- legacy: auth.users.id
    reviewer_member_id = v_member_id,     -- v2.3: firm_members.id (nullable)
    reviewer_note      = p_note,
    resolved_at        = now()
  WHERE id = p_exception_id;

  PERFORM set_config('safisha.resolve_authorized', 'false', TRUE);

  SELECT COUNT(*) INTO v_remaining
  FROM safisha_exceptions
  WHERE reconciliation_id = v_exception.reconciliation_id
    AND reviewer_action = 'pending';

  IF v_remaining = 0 THEN
    DECLARE
      v_blocked INTEGER;
    BEGIN
      SELECT COUNT(*) INTO v_blocked
      FROM safisha_exceptions
      WHERE reconciliation_id = v_exception.reconciliation_id
        AND category = 'investigate'
        AND reviewer_action = 'rejected';
      IF v_blocked > 0 THEN
        UPDATE safisha_reconciliations SET status = 'blocked' WHERE id = v_exception.reconciliation_id;
        UPDATE trial_balance_uploads SET safisha_status = 'blocked' WHERE id = (
          SELECT tb_upload_id FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id
        );
      ELSE
        UPDATE safisha_reconciliations SET
          status       = 'clean',
          completed_at = now()
        WHERE id = v_exception.reconciliation_id;
        UPDATE trial_balance_uploads SET safisha_status = 'clean' WHERE id = (
          SELECT tb_upload_id FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id
        );
      END IF;
    END;
  END IF;

  -- Append-only audit log write (INSERT only — trigger blocks UPDATE/DELETE)
  INSERT INTO safisha_audit_log (
    exception_id, reconciliation_id,
    reviewer_id,         -- legacy: auth.users.id
    reviewer_member_id,  -- v2.3: firm_members.id
    action, note
  ) VALUES (
    p_exception_id, v_exception.reconciliation_id,
    p_reviewer_id,
    v_member_id,
    p_action, p_note
  );

  RETURN jsonb_build_object(
    'exception_id',   p_exception_id,
    'action',         p_action,
    'remaining',      v_remaining,
    'recon_status',   (SELECT status FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id)
  );
END;
$function$
$mcapabilitiesado$;

  EXECUTE $mcapabilitiesadp$
-- ── 6. Privileges ────────────────────────────────────────────────────────────────────────────
-- RLS policies call the two predicates as the signed-in user, so authenticated needs EXECUTE; neither discloses
-- anything about another person (see has_workspace_capability).
REVOKE ALL ON FUNCTION public.has_workspace_capability(UUID, UUID, TEXT) FROM PUBLIC, anon
$mcapabilitiesadp$;

  EXECUTE $mcapabilitiesadq$
GRANT EXECUTE ON FUNCTION public.has_workspace_capability(UUID, UUID, TEXT) TO authenticated, service_role
$mcapabilitiesadq$;

  EXECUTE $mcapabilitiesadr$
REVOKE ALL ON FUNCTION public.workspace_capability_allowed(UUID, UUID, TEXT) FROM PUBLIC, anon
$mcapabilitiesadr$;

  EXECUTE $mcapabilitiesads$
GRANT EXECUTE ON FUNCTION public.workspace_capability_allowed(UUID, UUID, TEXT) TO authenticated, service_role
$mcapabilitiesads$;

  EXECUTE $mcapabilitiesadt$
REVOKE ALL ON FUNCTION public.has_account_capability(UUID, TEXT) FROM PUBLIC, anon
$mcapabilitiesadt$;

  EXECUTE $mcapabilitiesadu$
GRANT EXECUTE ON FUNCTION public.has_account_capability(UUID, TEXT) TO authenticated, service_role
$mcapabilitiesadu$;

  EXECUTE $mcapabilitiesadv$
REVOKE ALL ON FUNCTION public.get_my_workspace_capabilities(UUID) FROM PUBLIC, anon, service_role
$mcapabilitiesadv$;

  EXECUTE $mcapabilitiesadw$
GRANT EXECUTE ON FUNCTION public.get_my_workspace_capabilities(UUID) TO authenticated
$mcapabilitiesadw$;

  EXECUTE $mcapabilitiesadx$
REVOKE ALL ON FUNCTION public.grant_member_capability(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role
$mcapabilitiesadx$;

  EXECUTE $mcapabilitiesady$
GRANT EXECUTE ON FUNCTION public.grant_member_capability(UUID, UUID, TEXT, TEXT) TO authenticated
$mcapabilitiesady$;

  EXECUTE $mcapabilitiesadz$
REVOKE ALL ON FUNCTION public.revoke_member_capability(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role
$mcapabilitiesadz$;

  EXECUTE $mcapabilitiesaea$
GRANT EXECUTE ON FUNCTION public.revoke_member_capability(UUID, UUID, TEXT, TEXT) TO authenticated
$mcapabilitiesaea$;

  EXECUTE $mcapabilitiesaeb$
-- The TB-lifecycle predicate stays service-only (see 20260925150000).
REVOKE ALL ON FUNCTION public.workspace_authority_basis(uuid, uuid, text) FROM PUBLIC, anon, authenticated
$mcapabilitiesaeb$;

  EXECUTE $mcapabilitiesaec$
GRANT EXECUTE ON FUNCTION public.workspace_authority_basis(uuid, uuid, text) TO service_role
$mcapabilitiesaec$;

  EXECUTE $mcapabilitiesaed$
REVOKE ALL ON FUNCTION public._title_capability_template(TEXT) FROM PUBLIC, anon, authenticated
$mcapabilitiesaed$;

  EXECUTE $mcapabilitiesaee$
REVOKE ALL ON FUNCTION public.firm_members_capability_template_sync() FROM PUBLIC, anon, authenticated
$mcapabilitiesaee$;

  EXECUTE $mcapabilitiesaef$
REVOKE ALL ON FUNCTION public.workspace_member_capabilities_guard() FROM PUBLIC, anon, authenticated
$mcapabilitiesaef$;

  EXECUTE $mcapabilitiesaeg$
REVOKE ALL ON FUNCTION public.workspace_member_capabilities_no_truncate() FROM PUBLIC, anon, authenticated
$mcapabilitiesaeg$;

  EXECUTE $mcapabilitiesaeh$
REVOKE ALL ON FUNCTION public.close_assurance_wall() FROM PUBLIC, anon, authenticated
$mcapabilitiesaeh$;

  EXECUTE $mcapabilitiesaei$
REVOKE ALL ON FUNCTION public.reconciliation_write_wall() FROM PUBLIC, anon, authenticated
$mcapabilitiesaei$;

  EXECUTE $mcapabilitiesaej$
REVOKE ALL ON FUNCTION public.firm_members_update_guard() FROM PUBLIC, anon, authenticated
$mcapabilitiesaej$;

  EXECUTE $mcapabilitiesaek$
REVOKE ALL ON FUNCTION public.commercial_plan_change_lock() FROM PUBLIC, anon, authenticated
$mcapabilitiesaek$;

  EXECUTE $mcapabilitiesael$
REVOKE ALL ON FUNCTION public._plan_write_lock(UUID) FROM PUBLIC, anon
$mcapabilitiesael$;

  EXECUTE $mcapabilitiesaem$
GRANT EXECUTE ON FUNCTION public._plan_write_lock(UUID) TO authenticated, service_role
$mcapabilitiesaem$;

  EXECUTE $mcapabilitiesaen$
REVOKE ALL ON FUNCTION public.safisha_append_evidence_file(uuid, text, text, integer) FROM PUBLIC, anon
$mcapabilitiesaen$;

  EXECUTE $mcapabilitiesaeo$
GRANT EXECUTE ON FUNCTION public.safisha_append_evidence_file(uuid, text, text, integer) TO authenticated, service_role
$mcapabilitiesaeo$;

  EXECUTE $mcapabilitiesaep$
REVOKE ALL ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated
$mcapabilitiesaep$;

  EXECUTE $mcapabilitiesaeq$
GRANT EXECUTE ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) TO service_role
$mcapabilitiesaeq$;
END
$cfoclose_capabilities$;
