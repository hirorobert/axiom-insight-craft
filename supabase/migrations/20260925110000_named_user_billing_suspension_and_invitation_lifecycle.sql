-- ════════════════════════════════════════════════════════════════════════════
-- CFO Close: named-user billing suspension and invitation-reservation lifecycle. Forward-only; builds on
-- 20260925100000 (named-user seats). No membership, grant, attribution or audit row is ever deleted or rewritten.
--
-- INVARIANT   active_named_users(account) <= included_seats + purchased additional seats
--   A named user is ACTIVE on an account only when named_user_access_active() is true:
--     * the account holder (the billing owner, companies.user_id) is always active;
--     * a person with an open billing suspension on the account is not;
--     * when the account's seat capacity is undetermined, or the non-suspended named users exceed the allowance
--       (an unplanned expiry or loss of entitlement that has not been resolved yet), NO ONE but the account holder
--       is active (fail closed);
--     * otherwise every non-suspended named user is active.
--   The predicate is evaluated live, so the invariant holds the instant a licence lapses, with no job and no
--   ordering choice. reconcile_named_user_allowance() then MATERIALISES the unplanned rule as suspension rows (only
--   the account holder stays active) from triggers on every licence and override change, BEFORE and AFTER the
--   change, so restoring capacity never silently reactivates anyone. Reactivation is only ever an explicit
--   selection by the account holder (choose_active_named_users) or a commercial admin applying the account's
--   planned selection (admin_prepare_planned_reduction), atomic, serialised per account, and refused when the
--   roster changed since it was read (roster_version).
--
-- ENFORCEMENT (every path):
--   * One RESTRICTIVE policy on firm_members hides a person's own membership rows while they are not active. Every
--     RLS policy that proves membership with a sub-select on firm_members therefore denies them.
--   * Every SECURITY DEFINER function that confers workspace access through a membership or a capability grant is
--     redefined here with exactly one added conjunct, public.named_user_access_active(...). Nothing else in those
--     functions changes (scripts/db-proof/billingSuspension.mjs proves each body equals its previous definition
--     once that conjunct is removed).
--   * Edge Functions that check membership with the service role ask named_user_access_active() as well.
--   * The seat wall refuses any new membership, reservation or grant for a suspended person, and any lift of a
--     suspension that would exceed the allowance, whoever writes it (client, RPC or service role).
--
-- INVITATION RESERVATIONS
--   A pending invitation (firm_members.accepted_at IS NULL) reserves a seat only until invitation_expires_at and
--   only while it is not cancelled. Expiry releases the seat by definition (no job); cancellation (the account
--   holder, or the invitation function when the email could not be sent) releases it atomically. Acceptance is
--   refused after expiry or cancellation. Reissuing refreshes the same row, never a second reservation.
--   invitation_reservation_ttl() is the ONE duration: 7 days is a PROPOSED value awaiting a product decision; no
--   invitation duration is documented anywhere in this repository.
-- ════════════════════════════════════════════════════════════════════════════
--
-- ATOMIC ENVELOPE (security correction B-3): every statement below runs inside this ONE DO statement. Whatever the
-- runner does (statement by statement, whole file, with or without a transaction, continuing after errors) the
-- migration either applies completely or changes nothing.
DO $cfoclose_suspension$
BEGIN
  EXECUTE $msuspensionaaa$
DO $refuse$
BEGIN
  IF to_regclass('public.commercial_capabilities') IS NULL OR to_regproc('public._seat_capacity_for_account') IS NULL THEN
    RAISE EXCEPTION 'billing-suspension migration refused: 20260925100000 (named-user seats) is not applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.named_user_billing_suspensions') IS NOT NULL THEN
    RAISE EXCEPTION 'billing-suspension migration refused: already applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
END
$refuse$
$msuspensionaaa$;

  EXECUTE $msuspensionaab$
SET search_path TO public, pg_catalog
$msuspensionaab$;

  EXECUTE $msuspensionaac$
-- ── 1. Invitation reservation lifecycle ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.invitation_reservation_ttl()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  -- PROPOSED 7 days — product decision pending (no documented invitation duration exists). Change only here.
  SELECT interval '7 days'
$$
$msuspensionaac$;

  EXECUTE $msuspensionaad$
ALTER TABLE public.firm_members
  ADD COLUMN invitation_expires_at   TIMESTAMPTZ NULL,
  ADD COLUMN invitation_cancelled_at TIMESTAMPTZ NULL,
  ADD COLUMN invitation_cancel_reason TEXT NULL,
  ADD CONSTRAINT chk_fm_invitation_cancel_pair CHECK ((invitation_cancelled_at IS NULL) = (invitation_cancel_reason IS NULL)),
  ADD CONSTRAINT chk_fm_invitation_cancel_reason CHECK (invitation_cancel_reason IS NULL OR invitation_cancel_reason IN ('OWNER_CANCELLED', 'EMAIL_FAILED')),
  ADD CONSTRAINT chk_fm_invitation_cancel_pending CHECK (invitation_cancelled_at IS NULL OR accepted_at IS NULL)
$msuspensionaad$;

  EXECUTE $msuspensionaae$
-- Pending invitations that predate this migration get one full reservation period from now (deterministic; none is
-- expired retroactively). The seat-wall trigger is replaced below, after this backfill.
UPDATE public.firm_members SET invitation_expires_at = now() + public.invitation_reservation_ttl()
 WHERE accepted_at IS NULL AND invitation_expires_at IS NULL
$msuspensionaae$;

  EXECUTE $msuspensionaaf$
-- A pending invitation is VALID (reserves a seat, may be accepted) only until it expires and while not cancelled.
CREATE OR REPLACE FUNCTION public._invitation_valid(p_accepted_at TIMESTAMPTZ, p_expires_at TIMESTAMPTZ, p_cancelled_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT p_accepted_at IS NULL AND p_cancelled_at IS NULL AND p_expires_at IS NOT NULL AND p_expires_at > now()
$$
$msuspensionaaf$;

  EXECUTE $msuspensionaag$
-- ── 2. Billing suspensions (append-only history; a suspension is lifted, never deleted) ──────
CREATE TABLE public.named_user_billing_suspensions (
  id               UUID        NOT NULL DEFAULT gen_random_uuid(),
  account_user_id  UUID        NOT NULL,
  user_id          UUID        NOT NULL,
  reason           TEXT        NOT NULL,
  suspended_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_by     UUID        NULL,
  lifted_at        TIMESTAMPTZ NULL,
  lifted_by        UUID        NULL,
  lift_reason      TEXT        NULL,
  CONSTRAINT named_user_billing_suspensions_pk PRIMARY KEY (id),
  CONSTRAINT fk_nubs_account FOREIGN KEY (account_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_nubs_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_nubs_not_account CHECK (user_id <> account_user_id),
  CONSTRAINT chk_nubs_reason CHECK (reason IN ('ENTITLEMENT_LOST', 'OWNER_SELECTION', 'PLANNED_REDUCTION')),
  CONSTRAINT chk_nubs_lift CHECK ((lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_reason IS NULL)),
  CONSTRAINT chk_nubs_lift_reason CHECK (lift_reason IS NULL OR lift_reason IN ('OWNER_SELECTION', 'PLANNED_SELECTION'))
)
$msuspensionaag$;

  EXECUTE $msuspensionaah$
CREATE UNIQUE INDEX uq_nubs_open ON public.named_user_billing_suspensions (account_user_id, user_id) WHERE lifted_at IS NULL
$msuspensionaah$;

  EXECUTE $msuspensionaai$
CREATE INDEX idx_nubs_user ON public.named_user_billing_suspensions (user_id) WHERE lifted_at IS NULL
$msuspensionaai$;

  EXECUTE $msuspensionaaj$
ALTER TABLE public.named_user_billing_suspensions ENABLE ROW LEVEL SECURITY
$msuspensionaaj$;

  EXECUTE $msuspensionaak$
CREATE POLICY "nubs_select_account" ON public.named_user_billing_suspensions FOR SELECT TO authenticated
  USING (account_user_id = auth.uid() OR public.is_commercial_admin())
$msuspensionaak$;

  EXECUTE $msuspensionaal$
REVOKE ALL ON public.named_user_billing_suspensions FROM PUBLIC, anon, authenticated, service_role
$msuspensionaal$;

  EXECUTE $msuspensionaam$
GRANT SELECT ON public.named_user_billing_suspensions TO authenticated
$msuspensionaam$;

  EXECUTE $msuspensionaan$
-- The service role may record and lift (the guard enforces the allowance); it can never delete or truncate history.
GRANT SELECT, INSERT, UPDATE ON public.named_user_billing_suspensions TO service_role
$msuspensionaan$;

  EXECUTE $msuspensionaao$
CREATE OR REPLACE FUNCTION public._named_user_suspended(p_account UUID, p_user UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.named_user_billing_suspensions s
                  WHERE s.account_user_id = p_account AND s.user_id = p_user AND s.lifted_at IS NULL)
$$
$msuspensionaao$;

  EXECUTE $msuspensionaap$
-- Named users of an account, never counting a suspended person.
--   p_include_pending = true  -> RESERVED: account holder + accepted and VALID pending memberships + active grants
--   p_include_pending = false -> ACTIVE candidates: account holder + accepted memberships + active grants
CREATE OR REPLACE FUNCTION public._account_named_users(
  p_account UUID, p_include_pending BOOLEAN, p_exclude_member UUID DEFAULT NULL, p_exclude_grant UUID DEFAULT NULL)
RETURNS TABLE (named_user_id UUID) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_account WHERE p_account IS NOT NULL
  UNION
  SELECT fm.user_id FROM public.firm_members fm JOIN public.companies c ON c.id = fm.company_id
   WHERE c.user_id = p_account AND fm.id IS DISTINCT FROM p_exclude_member
     AND (fm.accepted_at IS NOT NULL OR (p_include_pending AND public._invitation_valid(fm.accepted_at, fm.invitation_expires_at, fm.invitation_cancelled_at)))
     AND NOT public._named_user_suspended(p_account, fm.user_id)
  UNION
  SELECT g.grantee_user_id FROM public.workspace_capability_grants g JOIN public.companies c ON c.id = g.company_id
   WHERE c.user_id = p_account AND g.revoked_at IS NULL AND g.id IS DISTINCT FROM p_exclude_grant
     AND NOT public._named_user_suspended(p_account, g.grantee_user_id);
$$
$msuspensionaap$;

  EXECUTE $msuspensionaaq$
-- THE activity predicate (see header). Restrictive by construction: it never grants anything on its own; every
-- caller also requires its existing membership / grant / ownership condition.
CREATE OR REPLACE FUNCTION public._account_named_user_access_active(p_account UUID, p_user UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cap JSONB;
BEGIN
  IF p_account IS NULL OR p_user IS NULL THEN
    RETURN false;
  END IF;
  IF p_user = p_account THEN
    RETURN true;
  END IF;
  IF public._named_user_suspended(p_account, p_user) THEN
    RETURN false;
  END IF;
  v_cap := public._seat_capacity_for_account(p_account);
  IF NOT COALESCE((v_cap->>'determined')::boolean, false) THEN
    RETURN false;
  END IF;
  RETURN (SELECT count(*) FROM public._account_named_users(p_account, false)) <= (v_cap->>'allowed_named_users')::integer;
END;
$$
$msuspensionaaq$;

  EXECUTE $msuspensionaar$
-- named_user_access_active is evaluated inside RLS, so signed-in users can execute it; called directly by a signed-in
-- user it only ever answers about that user (it can never be used to probe who is suspended where).
CREATE OR REPLACE FUNCTION public.named_user_access_active(p_company_id UUID, p_user UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_setting('role', true) IN ('authenticated', 'anon') AND p_user IS DISTINCT FROM auth.uid() THEN
    RETURN false;
  END IF;
  RETURN public._account_named_user_access_active((SELECT c.user_id FROM public.companies c WHERE c.id = p_company_id), p_user);
END;
$$
$msuspensionaar$;

  EXECUTE $msuspensionaas$
-- ── 3. A person who is not active cannot see their own membership rows, so every RLS policy that proves
--      membership with a sub-select on firm_members denies them. Other people's rows are unaffected.
CREATE POLICY "firm_members_named_user_active" ON public.firm_members AS RESTRICTIVE FOR ALL TO authenticated
  USING (CASE WHEN user_id = auth.uid() THEN public.named_user_access_active(company_id, user_id) ELSE true END)
  WITH CHECK (CASE WHEN user_id = auth.uid() THEN public.named_user_access_active(company_id, user_id) ELSE true END)
$msuspensionaas$;

  EXECUTE $msuspensionaat$
-- ── 4. Workspace access basis (20260925100000) now requires an active named user ─────────────
CREATE OR REPLACE FUNCTION public._workspace_access_basis(p_user UUID, p_company_id UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_user IS NULL OR p_company_id IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id AND c.user_id = p_user) THEN 'workspace_creator'
    WHEN NOT public.named_user_access_active(p_company_id, p_user) THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.company_id = p_company_id AND fm.user_id = p_user AND fm.accepted_at IS NOT NULL) THEN 'accepted_member'
    WHEN EXISTS (SELECT 1 FROM public.workspace_capability_grants g WHERE g.company_id = p_company_id AND g.grantee_user_id = p_user AND g.revoked_at IS NULL) THEN 'capability_grant'
  END;
$$
$msuspensionaat$;

  EXECUTE $msuspensionaau$
-- ── 5. Every other definer function that confers access: exactly one added conjunct each ─────

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
    AND fm.role IN ('owner','partner','manager')
  LIMIT 1;

  IF v_member IS NULL THEN
    RAISE EXCEPTION
      'IRON DOME: only an owner, partner or manager of this company may change engagement scope or authority.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN v_member;
END;
$function$
$msuspensionaau$;

  EXECUTE $msuspensionaav$
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

  -- The caller's OWN role is returned so the UI can render a viewer read-only; it is a display hint only: every write is still refused server-side.
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
  RETURN jsonb_build_object('enabled', true, 'reason', 'ENABLED', 'role', v_role);
END;
$function$
$msuspensionaav$;

  EXECUTE $msuspensionaaw$
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
     AND fm.role <> 'viewer'
   ORDER BY fm.id LIMIT 1;

  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: the caller is not an accepted, non-viewer member of company %', p_company_id USING ERRCODE = '42501';
  END IF;

  IF NOT public.fs_rollout_allows(p_company_id) THEN
    RAISE EXCEPTION 'FEATURE_DISABLED: the financial-statements workspace is not enabled for this company' USING ERRCODE = 'PT403';
  END IF;

  RETURN v_member;
END;
$function$
$msuspensionaaw$;

  EXECUTE $msuspensionaax$
CREATE OR REPLACE FUNCTION public.get_engagement_setup_state(p_engagement_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_company UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  SELECT g.company_id INTO v_company FROM public.engagements g WHERE g.id = p_engagement_id;
  IF v_company IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.firm_members fm WHERE fm.user_id = auth.uid() AND fm.company_id = v_company AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: an accepted member of the workspace is required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'dataStart', public.engagement_data_start_state(p_engagement_id),
    'sequence', COALESCE((SELECT MAX(sequence_no) FROM public.engagement_setup_events WHERE engagement_id = p_engagement_id), 0)
  );
END;
$function$
$msuspensionaax$;

  EXECUTE $msuspensionaay$
CREATE OR REPLACE FUNCTION public.get_member_company_ids()
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- LANGUAGE plpgsql (not sql): SQL functions validate table references at
-- creation time. firm_members does not exist yet when this function is
-- created (table is created in Section 2). plpgsql defers validation to
-- execution time, allowing the function to be defined before its dependencies.
BEGIN
  RETURN QUERY
    SELECT fm.company_id
    FROM   public.firm_members fm
    WHERE  fm.user_id     = auth.uid()
      AND  fm.accepted_at IS NOT NULL
      AND  public.named_user_access_active(fm.company_id, fm.user_id)
    UNION
    SELECT c.id
    FROM   public.companies c
    WHERE  c.user_id = auth.uid();
END;
$function$
$msuspensionaay$;

  EXECUTE $msuspensionaaz$
CREATE OR REPLACE FUNCTION public.get_workspace_access(p_company_id uuid)
 RETURNS TABLE(company_id uuid, access text, capabilities text[], stages text[], name text, fiscal_year_end text, reporting_framework text, currency text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_company public.companies%ROWTYPE;
  v_caps text[];
  v_all constant text[] := ARRAY['prepare', 'reconcile', 'statements', 'tax', 'compliance', 'filing', 'monitor'];
BEGIN
  IF v_uid IS NULL OR p_company_id IS NULL THEN RETURN; END IF;
  SELECT * INTO v_company FROM public.companies c WHERE c.id = p_company_id;
  IF v_company.id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(array_agg(DISTINCT g.capability ORDER BY g.capability), ARRAY[]::text[]) INTO v_caps
    FROM public.workspace_capability_grants g
   WHERE g.company_id = p_company_id AND g.grantee_user_id = v_uid AND g.revoked_at IS NULL AND public.named_user_access_active(g.company_id, g.grantee_user_id);

  IF v_company.user_id = v_uid THEN
    RETURN QUERY SELECT v_company.id, 'owner'::text, v_caps, v_all, v_company.name, v_company.fiscal_year_end,
      v_company.reporting_framework, v_company.currency, v_company.created_at;
  ELSIF EXISTS (SELECT 1 FROM public.firm_members fm
                 WHERE fm.user_id = v_uid AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)) THEN
    -- Pre-existing membership access, reported so the shell keeps applying the EXISTING rules. Not widened.
    RETURN QUERY SELECT v_company.id, 'member'::text, v_caps, v_all, v_company.name, v_company.fiscal_year_end,
      v_company.reporting_framework, v_company.currency, v_company.created_at;
  ELSIF v_caps && public.tbu_prepare_capabilities() AND COALESCE(v_company.is_active, true) THEN
    RETURN QUERY SELECT v_company.id, 'capability'::text, v_caps, ARRAY['prepare']::text[], v_company.name,
      v_company.fiscal_year_end, v_company.reporting_framework, v_company.currency, v_company.created_at;
  END IF;
END;
$function$
$msuspensionaaz$;

  EXECUTE $msuspensionaaa$
CREATE OR REPLACE FUNCTION public.hesabu_write_validation(p_upload_id uuid, p_company_id uuid, p_period_year integer, p_status text, p_assertions_total integer, p_assertions_passed integer, p_assertions_failed integer, p_assertions_skipped integer, p_sfp_tolerance_used numeric, p_scf_tolerance_used numeric, p_socie_tolerance_used numeric, p_request_id uuid, p_function_version text, p_assertions jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user         UUID;
  v_validation_id UUID;
  v_assertion    JSONB;
BEGIN
  v_user := auth.uid();

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'IRON DOME: hesabu_write_validation requires authenticated user.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.firm_members
    WHERE company_id = p_company_id AND user_id = v_user AND public.named_user_access_active(company_id, user_id)
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of company %.', p_company_id;
  END IF;

  IF p_status NOT IN ('all_pass', 'some_fail', 'blocked_missing_data') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.trial_balance_uploads
    WHERE id = p_upload_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Upload % does not belong to company %.', p_upload_id, p_company_id;
  END IF;

  INSERT INTO public.hesabu_validations (
    upload_id, company_id, period_year,
    status, assertions_total, assertions_passed, assertions_failed, assertions_skipped,
    sfp_tolerance_tzs_used, scf_tolerance_pct_used, socie_tolerance_pct_used,
    request_id, function_version, validated_by
  )
  VALUES (
    p_upload_id, p_company_id, p_period_year,
    p_status, p_assertions_total, p_assertions_passed, p_assertions_failed, p_assertions_skipped,
    p_sfp_tolerance_used, p_scf_tolerance_used, p_socie_tolerance_used,
    p_request_id, p_function_version, v_user
  )
  RETURNING id INTO v_validation_id;

  FOR v_assertion IN SELECT * FROM jsonb_array_elements(p_assertions)
  LOOP
    INSERT INTO public.hesabu_validation_assertions (
      validation_id, assertion_id, assertion_name, source_standard,
      result, skip_reason, expected_value, actual_value, tolerance_used, severity, detail
    )
    VALUES (
      v_validation_id,
      v_assertion->>'assertion_id',
      v_assertion->>'assertion_name',
      v_assertion->>'source_standard',
      v_assertion->>'result',
      v_assertion->>'skip_reason',
      (v_assertion->>'expected_value')::NUMERIC,
      (v_assertion->>'actual_value')::NUMERIC,
      (v_assertion->>'tolerance_used')::NUMERIC,
      v_assertion->>'severity',
      v_assertion->>'detail'
    );
  END LOOP;

  RETURN v_validation_id;
END;
$function$
$msuspensionaaa$;

  EXECUTE $msuspensionaab$
CREATE OR REPLACE FUNCTION public.intake_financial_statement_document(p_company_id uuid, p_period_year integer, p_uploaded_by_firm_member_id uuid, p_original_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 text, p_artifact_class text, p_storage_path text)
 RETURNS financial_statement_documents
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_row public.financial_statement_documents;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.id = p_uploaded_by_firm_member_id
      AND fm.company_id = p_company_id
      AND fm.accepted_at IS NOT NULL
      AND public.named_user_access_active(fm.company_id, fm.user_id)
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: firm member % is not an accepted member of company %', p_uploaded_by_firm_member_id, p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent replay: the same exact file content for this company/period
  -- returns the existing document rather than raising a conflict or
  -- creating a duplicate.
  SELECT * INTO v_row
    FROM public.financial_statement_documents
   WHERE company_id = p_company_id
     AND period_year = p_period_year
     AND sha256 = p_sha256
     AND superseded_at IS NULL
   LIMIT 1;

  IF FOUND THEN
    RETURN v_row;
  END IF;

  INSERT INTO public.financial_statement_documents (
    company_id, period_year, uploaded_by_firm_member_id, original_file_name,
    mime_type, byte_size, sha256, artifact_class, status, storage_path
  ) VALUES (
    p_company_id, p_period_year, p_uploaded_by_firm_member_id, p_original_file_name,
    p_mime_type, p_byte_size, p_sha256, p_artifact_class, 'STORED', p_storage_path
  )
  RETURNING * INTO v_row;

  RETURN v_row;
EXCEPTION
  WHEN unique_violation THEN
    -- Lost a concurrent race against another request inserting the exact
    -- same (company_id, period_year, sha256) simultaneously — re-select
    -- and return the winner's row rather than raising to the caller.
    SELECT * INTO v_row
      FROM public.financial_statement_documents
     WHERE company_id = p_company_id
       AND period_year = p_period_year
       AND sha256 = p_sha256
       AND superseded_at IS NULL
     LIMIT 1;
    RETURN v_row;
END;
$function$
$msuspensionaab$;

  EXECUTE $msuspensionaac$
CREATE OR REPLACE FUNCTION public.list_shared_workspaces()
 RETURNS TABLE(company_id uuid, capabilities text[], name text, fiscal_year_end text, reporting_framework text, currency text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT c.id, array_agg(DISTINCT g.capability ORDER BY g.capability), c.name, c.fiscal_year_end,
         c.reporting_framework, c.currency, c.created_at
    FROM public.workspace_capability_grants g
    JOIN public.companies c ON c.id = g.company_id
   WHERE auth.uid() IS NOT NULL AND g.grantee_user_id = auth.uid() AND g.revoked_at IS NULL AND public.named_user_access_active(g.company_id, g.grantee_user_id)
     AND g.capability = ANY (public.tbu_prepare_capabilities())
     AND c.user_id IS DISTINCT FROM auth.uid() AND COALESCE(c.is_active, true)
   GROUP BY c.id, c.name, c.fiscal_year_end, c.reporting_framework, c.currency, c.created_at
   ORDER BY c.name, c.id;
$function$
$msuspensionaac$;

  EXECUTE $msuspensionaad$
CREATE OR REPLACE FUNCTION public.maono_write_board_pack(p_company_id uuid, p_run_id uuid, p_period_label text, p_pack_type text, p_sections_json jsonb, p_summary_text text, p_generation_model text, p_context_version integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id        UUID;
  v_user      UUID;
  v_member_id UUID;
BEGIN
  v_user := auth.uid();

  IF NOT EXISTS (
    SELECT 1 FROM firm_members
    WHERE company_id = p_company_id AND user_id = v_user AND public.named_user_access_active(company_id, user_id)
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of this company.';
  END IF;

  -- v2.3 Phase 1: resolve firm_members.id
  v_member_id := public.resolve_member_id(v_user, p_company_id);

  IF p_pack_type NOT IN ('monthly', 'quarterly', 'annual') THEN
    RAISE EXCEPTION 'Invalid pack_type: %', p_pack_type;
  END IF;

  INSERT INTO board_packs (
    company_id, run_id, period_label, pack_type,
    sections_json, summary_text,
    generated_by,          -- legacy: auth.users.id
    generated_by_member_id, -- v2.3: firm_members.id
    generation_model, context_version
  )
  VALUES (
    p_company_id, p_run_id, p_period_label, p_pack_type,
    p_sections_json, p_summary_text,
    v_user,       -- auth.users.id
    v_member_id,  -- firm_members.id
    p_generation_model, p_context_version
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$
$msuspensionaad$;

  EXECUTE $msuspensionaae$
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
     AND fm.role IN ('owner', 'partner', 'manager') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: only an owner, partner or manager of this company can choose its services' USING ERRCODE = '42501';
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
$msuspensionaae$;

  EXECUTE $msuspensionaaf$
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

  -- Authorise from the session: a non-viewer accepted member of THIS engagement's company.
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = v_company AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND fm.role IN ('owner', 'partner', 'manager', 'preparer') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: only a non-viewer member of this workspace can change its setup' USING ERRCODE = '42501';
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
$msuspensionaaf$;

  EXECUTE $msuspensionaag$
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

  IF v_role NOT IN ('owner', 'partner', 'preparer') THEN
    RAISE EXCEPTION 'ROLE_NOT_AUTHORIZED_FOR_CLASSIFICATION_DECISIONS' USING ERRCODE = '42501';
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
$msuspensionaag$;

  EXECUTE $msuspensionaah$
CREATE OR REPLACE FUNCTION public.safisha_recon_visible(_recon_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.safisha_reconciliations r
    LEFT JOIN public.trial_balance_uploads u ON u.id = r.tb_upload_id
    WHERE r.id = _recon_id
      AND (
        r.client_id = auth.uid()
        OR (
          u.company_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.firm_members fm
            WHERE fm.company_id = u.company_id
              AND fm.user_id = auth.uid()
              AND fm.accepted_at IS NOT NULL
              AND public.named_user_access_active(fm.company_id, fm.user_id)
          )
        )
      )
  );
$function$
$msuspensionaah$;

  EXECUTE $msuspensionaai$
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
     AND fm.role IN ('owner', 'partner', 'manager') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: only an owner, partner or manager can select the filing jurisdiction' USING ERRCODE = '42501';
  END IF;
  UPDATE public.companies SET filing_jurisdiction = v_code WHERE id = p_company_id;
  RETURN v_code;
END;
$function$
$msuspensionaai$;

  EXECUTE $msuspensionaaj$
CREATE OR REPLACE FUNCTION public.tbu_can_view_workspace_audit(p_company_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id AND c.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.workspace_capability_grants g
                WHERE g.company_id = p_company_id AND g.grantee_user_id = auth.uid() AND g.revoked_at IS NULL AND public.named_user_access_active(g.company_id, g.grantee_user_id)));
$function$
$msuspensionaaj$;

  EXECUTE $msuspensionaak$
CREATE OR REPLACE FUNCTION public.tbu_resolve_processing_actor(p_user_id uuid, p_company_id uuid)
 RETURNS TABLE(actor_type text, firm_member_id uuid, firm_member_role text, authority_basis text, authority_capability text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_member uuid;
  v_role text;
  v_basis text;
  v_cap text := 'prepare_trial_balance';
BEGIN
  IF p_user_id IS NULL OR p_company_id IS NULL THEN RETURN; END IF;
  v_basis := public.workspace_authority_basis(p_user_id, p_company_id, 'prepare_trial_balance');
  IF v_basis IS NULL THEN
    v_cap := 'manage_source_files';
    v_basis := public.workspace_authority_basis(p_user_id, p_company_id, 'manage_source_files');
  END IF;
  SELECT fm.id, fm.role::text INTO v_member, v_role FROM public.firm_members fm
   WHERE fm.user_id = p_user_id AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
   ORDER BY fm.id LIMIT 1;

  IF v_member IS NOT NULL THEN
    RETURN QUERY SELECT 'user'::text, v_member, v_role, COALESCE(v_basis, 'firm_membership'),
                        CASE WHEN v_basis = 'explicit_capability' THEN v_cap END;
  ELSIF v_basis IS NOT NULL THEN
    RETURN QUERY SELECT 'workspace_user'::text, NULL::uuid, NULL::text, v_basis,
                        CASE WHEN v_basis = 'explicit_capability' THEN v_cap END;
  END IF;
END;
$function$
$msuspensionaak$;

  EXECUTE $msuspensionaal$
CREATE OR REPLACE FUNCTION public.workspace_authority_basis(p_user_id uuid, p_company_id uuid, p_capability text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT CASE
    WHEN p_user_id IS NULL OR p_company_id IS NULL OR p_capability IS NULL
      OR p_capability NOT IN ('manage_source_files', 'prepare_trial_balance', 'review_close', 'administer_workspace') THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id AND c.user_id = p_user_id) THEN 'workspace_owner'
    WHEN EXISTS (SELECT 1 FROM public.workspace_capability_grants g
                  WHERE g.company_id = p_company_id AND g.grantee_user_id = p_user_id
                    AND g.capability = p_capability AND g.revoked_at IS NULL AND public.named_user_access_active(g.company_id, g.grantee_user_id)) THEN 'explicit_capability'
  END;
$function$
$msuspensionaal$;

  EXECUTE $msuspensionaam$
CREATE OR REPLACE FUNCTION public.xbrl_write_instance(p_upload_id uuid, p_company_id uuid, p_period_year integer, p_reporting_framework text, p_output_format text, p_taxonomy_version text, p_instance_xml text, p_instance_sha256 text, p_fact_count integer, p_validation_passed boolean, p_validation_errors integer, p_validation_warnings integer, p_validation_info integer, p_request_id uuid, p_function_version text, p_issues jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user      UUID;
  v_member_id UUID;
  v_doc_id    UUID;
  v_issue     JSONB;
BEGIN
  v_user := auth.uid();

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'IRON DOME: xbrl_write_instance requires authenticated user.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM firm_members
    WHERE company_id = p_company_id AND user_id = v_user AND public.named_user_access_active(company_id, user_id)
  ) THEN
    RAISE EXCEPTION 'IRON DOME: User is not a member of company %.', p_company_id;
  END IF;

  -- v2.3 Phase 1: resolve firm_members.id
  v_member_id := public.resolve_member_id(v_user, p_company_id);

  IF NOT EXISTS (
    SELECT 1 FROM trial_balance_uploads
    WHERE id = p_upload_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Upload % does not belong to company %.', p_upload_id, p_company_id;
  END IF;

  IF p_reporting_framework IN ('ipsas_accrual', 'ipsas_cash') THEN
    RAISE EXCEPTION
      'IRON DOME: IPSAS XBRL taxonomy not implemented. '
      'Framework % cannot generate XBRL output. '
      'Use ifrs_for_smes or full_ifrs.', p_reporting_framework;
  END IF;

  IF p_output_format NOT IN ('xbrl_2_1', 'ixbrl_1_1') THEN
    RAISE EXCEPTION 'Invalid output_format: %', p_output_format;
  END IF;

  IF p_instance_sha256 IS NULL OR length(p_instance_sha256) != 64 THEN
    RAISE EXCEPTION
      'IRON DOME: instance_sha256 must be a 64-character hex string. '
      'Received: %', coalesce(p_instance_sha256, 'NULL');
  END IF;

  INSERT INTO xbrl_instance_documents (
    upload_id, company_id, period_year, reporting_framework,
    output_format, taxonomy_version,
    instance_xml, instance_sha256, fact_count,
    validation_passed, validation_errors, validation_warnings, validation_info,
    request_id, function_version,
    generated_by,          -- legacy: auth.users.id
    generated_by_member_id -- v2.3: firm_members.id
  )
  VALUES (
    p_upload_id, p_company_id, p_period_year, p_reporting_framework,
    p_output_format, p_taxonomy_version,
    p_instance_xml, p_instance_sha256, p_fact_count,
    p_validation_passed, p_validation_errors, p_validation_warnings, p_validation_info,
    p_request_id, p_function_version,
    v_user,      -- auth.users.id
    v_member_id  -- firm_members.id
  )
  RETURNING id INTO v_doc_id;

  FOR v_issue IN SELECT * FROM jsonb_array_elements(p_issues)
  LOOP
    INSERT INTO xbrl_validation_issues (
      document_id, severity, arelle_code, message, xbrl_element, fact_value
    )
    VALUES (
      v_doc_id,
      v_issue->>'severity',
      v_issue->>'arelle_code',
      v_issue->>'message',
      v_issue->>'xbrl_element',
      v_issue->>'fact_value'
    );
  END LOOP;

  RETURN v_doc_id;
END;
$function$
$msuspensionaam$;

  EXECUTE $msuspensionaan$
-- ── 6. Seat wall (supersedes 20260925100000): bounded reservations, valid-only acceptance, no suspended person ─
CREATE OR REPLACE FUNCTION public.named_user_seat_wall()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_account   UUID;
  v_user      UUID;
  v_member    UUID;
  v_grant     UUID;
  v_adds      BOOLEAN := false;
  v_activates BOOLEAN := false;
  v_cap       JSONB;
  v_allowed   INTEGER;
  v_ttl       INTERVAL := public.invitation_reservation_ttl();
BEGIN
  IF TG_TABLE_NAME = 'firm_members' THEN
    v_user := NEW.user_id; v_member := NEW.id;
    -- A pending invitation always carries a bounded reservation window (never longer than the one duration).
    IF NEW.accepted_at IS NULL AND NEW.invitation_cancelled_at IS NULL
       AND (TG_OP = 'INSERT' OR NEW.invitation_expires_at IS DISTINCT FROM OLD.invitation_expires_at
            OR OLD.invitation_cancelled_at IS NOT NULL OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
      NEW.invitation_expires_at := LEAST(COALESCE(NEW.invitation_expires_at, now() + v_ttl), now() + v_ttl);
    END IF;
    IF TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      v_adds := NEW.accepted_at IS NOT NULL OR public._invitation_valid(NEW.accepted_at, NEW.invitation_expires_at, NEW.invitation_cancelled_at);
      v_activates := NEW.accepted_at IS NOT NULL;
    ELSE
      IF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
        -- Acceptance only while the reservation is valid.
        IF OLD.invitation_cancelled_at IS NOT NULL THEN
          RAISE EXCEPTION 'INVITATION_CANCELLED' USING ERRCODE = 'PT410', DETAIL = 'INVITATION_CANCELLED';
        END IF;
        IF OLD.invitation_expires_at IS NULL OR OLD.invitation_expires_at <= now() THEN
          RAISE EXCEPTION 'INVITATION_EXPIRED' USING ERRCODE = 'PT410', DETAIL = 'INVITATION_EXPIRED';
        END IF;
        v_activates := true;
      END IF;
      -- A reservation re-opened (reissued) reserves a seat again.
      IF NEW.accepted_at IS NULL AND public._invitation_valid(NEW.accepted_at, NEW.invitation_expires_at, NEW.invitation_cancelled_at)
         AND NOT public._invitation_valid(OLD.accepted_at, OLD.invitation_expires_at, OLD.invitation_cancelled_at) THEN
        v_adds := true;
      END IF;
    END IF;
  ELSE
    IF NEW.revoked_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_user := NEW.grantee_user_id; v_grant := NEW.id;
    IF TG_OP = 'INSERT' OR NEW.grantee_user_id IS DISTINCT FROM OLD.grantee_user_id
       OR NEW.company_id IS DISTINCT FROM OLD.company_id OR OLD.revoked_at IS NOT NULL THEN
      v_adds := true; v_activates := true;
    END IF;
  END IF;
  IF NOT (v_adds OR v_activates) THEN
    RETURN NEW;
  END IF;
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = NEW.company_id;
  IF v_account IS NULL OR v_user IS NULL OR v_user = v_account THEN
    RETURN NEW;  -- the account holder is the included seat (a missing workspace fails on its foreign key)
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.named_user_seats:' || v_account::text, 0));
  IF public._named_user_suspended(v_account, v_user) THEN
    -- Only the account holder's explicit selection reactivates a suspended person.
    RAISE EXCEPTION 'NAMED_USER_SUSPENDED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = 'SUSPENDED';
  END IF;
  v_cap := public._seat_capacity_for_account(v_account);
  IF NOT COALESCE((v_cap->>'determined')::boolean, false) THEN
    RAISE EXCEPTION 'SEAT_CAPACITY_UNDETERMINED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = 'UNDETERMINED';
  END IF;
  v_allowed := (v_cap->>'allowed_named_users')::integer;
  IF v_adds
     AND NOT EXISTS (SELECT 1 FROM public._account_named_users(v_account, true, v_member, v_grant) u WHERE u.named_user_id = v_user)
     AND (SELECT count(*) FROM public._account_named_users(v_account, true, v_member, v_grant)) + 1 > v_allowed THEN
    RAISE EXCEPTION 'SEAT_LIMIT_REACHED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = v_cap->>'plan_code';
  END IF;
  IF v_activates
     AND NOT EXISTS (SELECT 1 FROM public._account_named_users(v_account, false, v_member, v_grant) u WHERE u.named_user_id = v_user)
     AND (SELECT count(*) FROM public._account_named_users(v_account, false, v_member, v_grant)) + 1 > v_allowed THEN
    RAISE EXCEPTION 'SEAT_LIMIT_REACHED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = v_cap->>'plan_code';
  END IF;
  RETURN NEW;
END;
$$
$msuspensionaan$;

  EXECUTE $msuspensionaao$
DROP TRIGGER IF EXISTS trg_firm_members_named_user_seats ON public.firm_members
$msuspensionaao$;

  EXECUTE $msuspensionaap$
CREATE TRIGGER trg_firm_members_named_user_seats
  BEFORE INSERT OR UPDATE OF user_id, company_id, accepted_at, invitation_expires_at, invitation_cancelled_at ON public.firm_members
  FOR EACH ROW EXECUTE FUNCTION public.named_user_seat_wall()
$msuspensionaap$;

  EXECUTE $msuspensionaaq$
-- ── 7. Suspension history guard: append-only; a lift never exceeds the allowance (whoever writes it) ──────
CREATE OR REPLACE FUNCTION public.named_user_billing_suspensions_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cap JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Iron Dome: named-user suspension history is append-only (DELETE refused).' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.lifted_at IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id OR NEW.account_user_id IS DISTINCT FROM OLD.account_user_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at OR NEW.suspended_by IS DISTINCT FROM OLD.suspended_by THEN
    RAISE EXCEPTION 'Iron Dome: a named-user suspension is immutable except for a single lift.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.lifted_at IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.named_user_seats:' || NEW.account_user_id::text, 0));
    v_cap := public._seat_capacity_for_account(NEW.account_user_id);
    IF NOT COALESCE((v_cap->>'determined')::boolean, false) THEN
      RAISE EXCEPTION 'SEAT_CAPACITY_UNDETERMINED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = 'UNDETERMINED';
    END IF;
    IF (SELECT count(*) FROM public._account_named_users(NEW.account_user_id, false)) + 1 > (v_cap->>'allowed_named_users')::integer THEN
      RAISE EXCEPTION 'SEAT_LIMIT_REACHED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = v_cap->>'plan_code';
    END IF;
  END IF;
  RETURN NEW;
END;
$$
$msuspensionaaq$;

  EXECUTE $msuspensionaar$
CREATE TRIGGER trg_nubs_guard BEFORE UPDATE OR DELETE ON public.named_user_billing_suspensions
  FOR EACH ROW EXECUTE FUNCTION public.named_user_billing_suspensions_guard()
$msuspensionaar$;

  EXECUTE $msuspensionaas$
CREATE OR REPLACE FUNCTION public.named_user_billing_suspensions_no_truncate()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: named-user suspension history is append-only (TRUNCATE refused).' USING ERRCODE = 'P0001';
END;
$$
$msuspensionaas$;

  EXECUTE $msuspensionaat$
CREATE TRIGGER trg_nubs_no_truncate BEFORE TRUNCATE ON public.named_user_billing_suspensions
  FOR EACH STATEMENT EXECUTE FUNCTION public.named_user_billing_suspensions_no_truncate()
$msuspensionaat$;

  EXECUTE $msuspensionaau$
-- ── 8. Roster, explicit selection and reactivation ───────────────────────────────────────────
-- Every person who has ever had a place on the account's workspaces (never the account holder), with their state:
--   suspended          an open billing suspension
--   active_candidate   accepted membership or active grant, not suspended
--   pending            a valid (unexpired, uncancelled) invitation only
--   inactive           nothing current (expired / cancelled invitation, revoked grant)
-- roster_version fingerprints the states and the allowance: a selection made from an older roster is refused.
CREATE OR REPLACE FUNCTION public._named_user_roster(p_account UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cap    JSONB := public._seat_capacity_for_account(p_account);
  v_people JSONB;
  v_active INTEGER;
BEGIN
  WITH people AS (
    SELECT fm.user_id AS user_id FROM public.firm_members fm JOIN public.companies c ON c.id = fm.company_id WHERE c.user_id = p_account
    UNION
    SELECT g.grantee_user_id FROM public.workspace_capability_grants g JOIN public.companies c ON c.id = g.company_id WHERE c.user_id = p_account
  ), states AS (
    SELECT p.user_id,
      CASE
        WHEN public._named_user_suspended(p_account, p.user_id) THEN 'suspended'
        WHEN EXISTS (SELECT 1 FROM public.firm_members fm JOIN public.companies c ON c.id = fm.company_id
                      WHERE c.user_id = p_account AND fm.user_id = p.user_id AND fm.accepted_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM public.workspace_capability_grants g JOIN public.companies c ON c.id = g.company_id
                      WHERE c.user_id = p_account AND g.grantee_user_id = p.user_id AND g.revoked_at IS NULL) THEN 'active_candidate'
        WHEN EXISTS (SELECT 1 FROM public.firm_members fm JOIN public.companies c ON c.id = fm.company_id
                      WHERE c.user_id = p_account AND fm.user_id = p.user_id
                        AND public._invitation_valid(fm.accepted_at, fm.invitation_expires_at, fm.invitation_cancelled_at)) THEN 'pending'
        ELSE 'inactive'
      END AS state,
      (SELECT fm.invited_email FROM public.firm_members fm JOIN public.companies c ON c.id = fm.company_id
        WHERE c.user_id = p_account AND fm.user_id = p.user_id AND fm.invited_email IS NOT NULL ORDER BY fm.id LIMIT 1) AS invited_email
      FROM people p WHERE p.user_id IS DISTINCT FROM p_account
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', s.user_id, 'state', s.state, 'invited_email', s.invited_email) ORDER BY s.user_id), '[]'::jsonb),
         count(*) FILTER (WHERE s.state = 'active_candidate')
    INTO v_people, v_active FROM states s;
  RETURN jsonb_build_object(
    'plan_code', v_cap->>'plan_code', 'determined', COALESCE((v_cap->>'determined')::boolean, false),
    'allowed_named_users', v_cap->'allowed_named_users',
    'over_allowance', NOT COALESCE((v_cap->>'determined')::boolean, false) OR v_active + 1 > (v_cap->>'allowed_named_users')::integer,
    'people', v_people,
    'roster_version', md5(COALESCE((SELECT string_agg((e->>'user_id') || ':' || (e->>'state'), ',' ORDER BY e->>'user_id') FROM jsonb_array_elements(v_people) e), '')
                          || '|' || COALESCE(v_cap->>'allowed_named_users', 'undetermined')));
END;
$$
$msuspensionaau$;

  EXECUTE $msuspensionaav$
-- The signed-in account holder's own roster (nobody else's).
CREATE OR REPLACE FUNCTION public.get_named_user_roster()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;
  RETURN public._named_user_roster(auth.uid()) || jsonb_build_object('outcome', 'ok');
END;
$$
$msuspensionaav$;

  EXECUTE $msuspensionaaw$
-- Applies one selection atomically under the account's seat lock. p_keep = the people (never the account holder)
-- who remain or become active; every other active person is suspended; kept suspended people are reactivated.
-- Outcomes: applied | stale_selection | selection_required | invalid_selection | selection_exceeds_allowance |
--           capacity_undetermined
CREATE OR REPLACE FUNCTION public._apply_named_user_selection(
  p_account UUID, p_keep UUID[], p_roster_version TEXT, p_allowed INTEGER, p_actor UUID, p_suspend_reason TEXT, p_lift_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_roster    JSONB;
  v_valid     UUID[];
  v_suspended UUID[];
  v_bc        UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.named_user_seats:' || p_account::text, 0));
  v_roster := public._named_user_roster(p_account);
  IF p_roster_version IS NULL OR p_roster_version <> v_roster->>'roster_version' THEN
    RETURN jsonb_build_object('outcome', 'stale_selection', 'roster_version', v_roster->>'roster_version');
  END IF;
  IF p_keep IS NULL THEN
    RETURN jsonb_build_object('outcome', 'selection_required');
  END IF;
  SELECT array_agg((e->>'user_id')::uuid) INTO v_valid FROM jsonb_array_elements(v_roster->'people') e
   WHERE e->>'state' IN ('active_candidate', 'suspended');
  IF cardinality(p_keep) <> (SELECT count(DISTINCT k) FROM unnest(p_keep) k)
     OR EXISTS (SELECT 1 FROM unnest(p_keep) k WHERE k IS NULL OR k = p_account OR NOT (k = ANY (COALESCE(v_valid, ARRAY[]::uuid[])))) THEN
    RETURN jsonb_build_object('outcome', 'invalid_selection');
  END IF;
  IF p_allowed IS NULL THEN
    RETURN jsonb_build_object('outcome', 'capacity_undetermined');
  END IF;
  IF cardinality(p_keep) + 1 > p_allowed THEN
    RETURN jsonb_build_object('outcome', 'selection_exceeds_allowance', 'allowed_named_users', p_allowed);
  END IF;
  WITH s AS (
    INSERT INTO public.named_user_billing_suspensions (account_user_id, user_id, reason, suspended_by)
    SELECT p_account, (e->>'user_id')::uuid, p_suspend_reason, p_actor FROM jsonb_array_elements(v_roster->'people') e
     WHERE e->>'state' = 'active_candidate' AND NOT ((e->>'user_id')::uuid = ANY (p_keep))
    RETURNING user_id)
  SELECT COALESCE(array_agg(user_id ORDER BY user_id), ARRAY[]::uuid[]) INTO v_suspended FROM s;
  UPDATE public.named_user_billing_suspensions SET lifted_at = now(), lifted_by = p_actor, lift_reason = p_lift_reason
   WHERE account_user_id = p_account AND user_id = ANY (p_keep) AND lifted_at IS NULL;
  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_account LIMIT 1;
  IF v_bc IS NOT NULL THEN
    INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
    VALUES (v_bc, p_actor, 'NAMED_USER_SELECTION_APPLIED', jsonb_build_object('roster_version', p_roster_version),
            jsonb_build_object('active', to_jsonb(p_keep), 'suspended', to_jsonb(v_suspended), 'allowed_named_users', p_allowed), p_suspend_reason);
  END IF;
  RETURN jsonb_build_object('outcome', 'applied', 'active', to_jsonb(p_keep), 'suspended', to_jsonb(v_suspended));
END;
$$
$msuspensionaaw$;

  EXECUTE $msuspensionaax$
-- The account holder chooses who is active within the CURRENT allowance (after a downgrade, an expiry, or when
-- capacity is restored). Nobody is ever reactivated without this explicit choice.
CREATE OR REPLACE FUNCTION public.choose_active_named_users(p_keep UUID[], p_roster_version TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cap JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;
  v_cap := public._seat_capacity_for_account(auth.uid());
  RETURN public._apply_named_user_selection(auth.uid(), p_keep, p_roster_version,
    CASE WHEN COALESCE((v_cap->>'determined')::boolean, false) THEN (v_cap->>'allowed_named_users')::integer END,
    auth.uid(), 'OWNER_SELECTION', 'OWNER_SELECTION');
END;
$$
$msuspensionaax$;

  EXECUTE $msuspensionaay$
-- A PLANNED downgrade or seat reduction: a commercial admin applies the account holder's selection against the
-- FUTURE allowance before changing the plan or seats. Refused when the selection is missing, invalid or stale.
CREATE OR REPLACE FUNCTION public.admin_prepare_planned_reduction(
  p_billing_customer_id UUID, p_future_allowed INTEGER, p_keep UUID[], p_roster_version TEXT, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_account UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_future_allowed IS NULL OR p_future_allowed < 1 THEN RAISE EXCEPTION 'INVALID_FUTURE_ALLOWANCE' USING ERRCODE = '22023'; END IF;
  SELECT owner_user_id INTO v_account FROM public.billing_customers WHERE id = p_billing_customer_id;
  IF v_account IS NULL THEN RAISE EXCEPTION 'BILLING_CUSTOMER_NOT_FOUND' USING ERRCODE = '22023'; END IF;
  RETURN public._apply_named_user_selection(v_account, p_keep, p_roster_version, p_future_allowed, auth.uid(), 'PLANNED_REDUCTION', 'PLANNED_SELECTION');
END;
$$
$msuspensionaay$;

  EXECUTE $msuspensionaaz$
-- ── 9. Unplanned loss: materialise the deterministic rule (only the account holder stays active) ──────────
CREATE OR REPLACE FUNCTION public.reconcile_named_user_allowance(p_account UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cap JSONB;
  v_n   INTEGER := 0;
BEGIN
  IF p_account IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.named_user_seats:' || p_account::text, 0));
  v_cap := public._seat_capacity_for_account(p_account);
  IF COALESCE((v_cap->>'determined')::boolean, false)
     AND (SELECT count(*) FROM public._account_named_users(p_account, false)) <= (v_cap->>'allowed_named_users')::integer THEN
    RETURN 0;
  END IF;
  INSERT INTO public.named_user_billing_suspensions (account_user_id, user_id, reason, suspended_by)
  SELECT p_account, u.named_user_id, 'ENTITLEMENT_LOST', NULL
    FROM public._account_named_users(p_account, false) u WHERE u.named_user_id <> p_account;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$
$msuspensionaaz$;

  EXECUTE $msuspensionaba$
CREATE OR REPLACE FUNCTION public.reconcile_all_named_user_allowances()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r   RECORD;
  v_n INTEGER := 0;
BEGIN
  FOR r IN SELECT DISTINCT c.user_id AS account FROM public.companies c WHERE c.user_id IS NOT NULL ORDER BY 1 LOOP
    v_n := v_n + public.reconcile_named_user_allowance(r.account);
  END LOOP;
  RETURN v_n;
END;
$$
$msuspensionaba$;

  EXECUTE $msuspensionabb$
-- Every licence or override change is reconciled BEFORE (so a lapsed allowance is materialised before any renewal
-- could restore it) and AFTER (so a reduction takes effect at once). A planned reduction has already applied the
-- account holder's selection, so its AFTER reconcile is a no-op.
CREATE OR REPLACE FUNCTION public.commercial_named_user_reconcile_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_bc UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.billing_customer_id ELSE NEW.billing_customer_id END;
BEGIN
  PERFORM public.reconcile_named_user_allowance((SELECT b.owner_user_id FROM public.billing_customers b WHERE b.id = v_bc));
  IF TG_OP = 'UPDATE' AND OLD.billing_customer_id IS DISTINCT FROM NEW.billing_customer_id THEN
    PERFORM public.reconcile_named_user_allowance((SELECT b.owner_user_id FROM public.billing_customers b WHERE b.id = OLD.billing_customer_id));
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$
$msuspensionabb$;

  EXECUTE $msuspensionabc$
CREATE TRIGGER trg_cl_named_user_reconcile_before BEFORE INSERT OR UPDATE OR DELETE ON public.commercial_licences
  FOR EACH ROW EXECUTE FUNCTION public.commercial_named_user_reconcile_trigger()
$msuspensionabc$;

  EXECUTE $msuspensionabd$
CREATE TRIGGER trg_cl_named_user_reconcile_after AFTER INSERT OR UPDATE OR DELETE ON public.commercial_licences
  FOR EACH ROW EXECUTE FUNCTION public.commercial_named_user_reconcile_trigger()
$msuspensionabd$;

  EXECUTE $msuspensionabe$
CREATE TRIGGER trg_eo_named_user_reconcile_before BEFORE INSERT OR UPDATE OR DELETE ON public.entitlement_overrides
  FOR EACH ROW EXECUTE FUNCTION public.commercial_named_user_reconcile_trigger()
$msuspensionabe$;

  EXECUTE $msuspensionabf$
CREATE TRIGGER trg_eo_named_user_reconcile_after AFTER INSERT OR UPDATE OR DELETE ON public.entitlement_overrides
  FOR EACH ROW EXECUTE FUNCTION public.commercial_named_user_reconcile_trigger()
$msuspensionabf$;

  EXECUTE $msuspensionabg$
-- Seat quantities can no longer be reduced below the active named users: a reduction needs the planned selection.
CREATE OR REPLACE FUNCTION public.admin_set_licence_additional_seats(p_licence_id UUID, p_quantity INTEGER, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_lic     RECORD;
  v_cap     JSONB;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_quantity IS NULL OR p_quantity < 0 OR p_quantity > 10000 THEN RAISE EXCEPTION 'INVALID_SEAT_QUANTITY' USING ERRCODE = '22023'; END IF;
  SELECT cl.id, cl.billing_customer_id, cl.additional_seats, cp.code AS plan_code, b.owner_user_id AS account INTO v_lic
    FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
    JOIN public.billing_customers b ON b.id = cl.billing_customer_id
   WHERE cl.id = p_licence_id FOR UPDATE OF cl;
  IF NOT FOUND THEN RAISE EXCEPTION 'LICENCE_NOT_FOUND' USING ERRCODE = '22023'; END IF;
  IF v_lic.plan_code = 'FREE' THEN RAISE EXCEPTION 'FREE_PLAN_HAS_NO_ADDITIONAL_SEATS' USING ERRCODE = '22023'; END IF;
  IF p_quantity < v_lic.additional_seats THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.named_user_seats:' || v_lic.account::text, 0));
    v_cap := public._seat_capacity_for_account(v_lic.account);
    IF COALESCE((v_cap->>'determined')::boolean, false)
       AND (SELECT count(*) FROM public._account_named_users(v_lic.account, false))
           > (v_cap->>'included_seats')::integer + p_quantity THEN
      RAISE EXCEPTION 'SELECTION_REQUIRED: apply the account holder''s selection first (admin_prepare_planned_reduction)' USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE public.commercial_licences SET additional_seats = p_quantity, updated_at = now() WHERE id = p_licence_id;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_lic.billing_customer_id, v_user_id, 'LICENCE_ADDITIONAL_SEATS_SET',
          jsonb_build_object('licence_id', p_licence_id, 'additional_seats', v_lic.additional_seats),
          jsonb_build_object('licence_id', p_licence_id, 'additional_seats', p_quantity), p_reason);
  RETURN jsonb_build_object('licence_id', p_licence_id, 'additional_seats', p_quantity);
END;
$$
$msuspensionabg$;

  EXECUTE $msuspensionabh$
-- ── 10. Invitation reservation RPCs ───────────────────────────────────────────────────────────
-- For the invitation Edge Function (service_role): reserve the seat BEFORE any email is sent. One row per person
-- per workspace: reissuing refreshes that row, never a second reservation.
-- Outcomes: reserved | reissued | refreshed | already_member | seat_limit_reached | capacity_undetermined |
--           named_user_suspended | workspace_not_found | invalid_request
CREATE OR REPLACE FUNCTION public.reserve_workspace_invitation(
  p_company_id UUID, p_user UUID, p_role TEXT, p_invited_by UUID, p_invited_email TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_account UUID;
  v_row     public.firm_members%ROWTYPE;
  v_outcome TEXT;
  v_hint    TEXT;
BEGIN
  IF p_company_id IS NULL OR p_user IS NULL OR p_role IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
  IF v_account IS NULL THEN
    RETURN jsonb_build_object('outcome', 'workspace_not_found');
  END IF;
  IF p_user = v_account THEN
    RETURN jsonb_build_object('outcome', 'already_member');
  END IF;
  -- Row lock first, then (inside the write) the account's seat lock: the same order as acceptance, so an
  -- invitation being reissued, accepted and cancelled at the same moment cannot deadlock.
  SELECT * INTO v_row FROM public.firm_members WHERE company_id = p_company_id AND user_id = p_user FOR UPDATE;
  IF FOUND AND v_row.accepted_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_member', 'member_id', v_row.id);
  END IF;
  BEGIN
    IF FOUND THEN
      v_outcome := CASE WHEN public._invitation_valid(v_row.accepted_at, v_row.invitation_expires_at, v_row.invitation_cancelled_at)
                        THEN 'refreshed' ELSE 'reissued' END;
      UPDATE public.firm_members
         SET invitation_expires_at = now() + public.invitation_reservation_ttl(), invitation_cancelled_at = NULL,
             invitation_cancel_reason = NULL, role = p_role, invited_by = p_invited_by, invited_email = p_invited_email
       WHERE id = v_row.id RETURNING * INTO v_row;
    ELSE
      v_outcome := 'reserved';
      INSERT INTO public.firm_members (company_id, user_id, role, invited_by, invited_email, accepted_at)
      VALUES (p_company_id, p_user, p_role, p_invited_by, p_invited_email, NULL) RETURNING * INTO v_row;
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      -- A concurrent first reservation of the same person won: that one row is the reservation.
      SELECT * INTO v_row FROM public.firm_members WHERE company_id = p_company_id AND user_id = p_user;
      RETURN jsonb_build_object('outcome', CASE WHEN v_row.accepted_at IS NOT NULL THEN 'already_member' ELSE 'refreshed' END,
        'member_id', v_row.id, 'expires_at', v_row.invitation_expires_at);
    WHEN SQLSTATE 'PT402' THEN
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    RETURN jsonb_build_object('outcome', CASE v_hint WHEN 'SUSPENDED' THEN 'named_user_suspended'
                                                     WHEN 'UNDETERMINED' THEN 'capacity_undetermined'
                                                     ELSE 'seat_limit_reached' END);
  END;
  RETURN jsonb_build_object('outcome', v_outcome, 'member_id', v_row.id, 'expires_at', v_row.invitation_expires_at);
END;
$$
$msuspensionabh$;

  EXECUTE $msuspensionabi$
-- Releases a reservation whose email could not be sent (service_role). Never deletes the row.
CREATE OR REPLACE FUNCTION public.release_workspace_invitation(p_member_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.firm_members SET invitation_cancelled_at = now(), invitation_cancel_reason = 'EMAIL_FAILED'
   WHERE id = p_member_id AND accepted_at IS NULL AND invitation_cancelled_at IS NULL;
  RETURN jsonb_build_object('outcome', CASE WHEN FOUND THEN 'released' ELSE 'not_pending' END);
END;
$$
$msuspensionabi$;

  EXECUTE $msuspensionabj$
-- The account holder cancels a pending invitation (the seat is released at once; the row is kept).
-- Outcomes: cancelled | already_cancelled | not_pending | not_found (also for anyone who is not the account holder)
CREATE OR REPLACE FUNCTION public.cancel_workspace_invitation(p_member_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row     public.firm_members%ROWTYPE;
  v_account UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  SELECT fm.* INTO v_row FROM public.firm_members fm WHERE fm.id = p_member_id;
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = v_row.company_id;
  IF v_row.id IS NULL OR v_account IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  -- Cancelling only ever releases a seat, so it needs the row lock alone (the same first lock acceptance takes).
  SELECT fm.* INTO v_row FROM public.firm_members fm WHERE fm.id = p_member_id FOR UPDATE;
  IF v_row.accepted_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'not_pending');
  END IF;
  IF v_row.invitation_cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_cancelled');
  END IF;
  UPDATE public.firm_members SET invitation_cancelled_at = now(), invitation_cancel_reason = 'OWNER_CANCELLED' WHERE id = p_member_id;
  RETURN jsonb_build_object('outcome', 'cancelled');
END;
$$
$msuspensionabj$;

  EXECUTE $msuspensionabk$
-- Acceptance (supersedes 20260925100000): reports expired / cancelled invitations by code.
CREATE OR REPLACE FUNCTION public.accept_workspace_invitations()
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user     UUID := auth.uid();
  r          RECORD;
  v_hint     TEXT;
  v_detail   TEXT;
  v_accepted JSONB := '[]'::jsonb;
  v_blocked  JSONB := '[]'::jsonb;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;
  FOR r IN SELECT fm.id, fm.company_id FROM public.firm_members fm
            WHERE fm.user_id = v_user AND fm.accepted_at IS NULL ORDER BY fm.created_at, fm.id LOOP
    BEGIN
      UPDATE public.firm_members SET accepted_at = now() WHERE id = r.id AND user_id = v_user AND accepted_at IS NULL;
      IF FOUND THEN
        v_accepted := v_accepted || jsonb_build_array(r.company_id);
      END IF;
    EXCEPTION
      WHEN SQLSTATE 'PT402' THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        v_blocked := v_blocked || jsonb_build_array(jsonb_build_object('company_id', r.company_id,
          'code', CASE v_hint WHEN 'UNDETERMINED' THEN 'SEAT_CAPACITY_UNDETERMINED' WHEN 'SUSPENDED' THEN 'NAMED_USER_SUSPENDED' ELSE 'SEAT_LIMIT_REACHED' END));
      WHEN SQLSTATE 'PT410' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        v_blocked := v_blocked || jsonb_build_array(jsonb_build_object('company_id', r.company_id,
          'code', CASE v_detail WHEN 'INVITATION_CANCELLED' THEN 'INVITATION_CANCELLED' ELSE 'INVITATION_EXPIRED' END));
    END;
  END LOOP;
  RETURN jsonb_build_object('outcome', 'ok', 'accepted', v_accepted, 'blocked', v_blocked);
END;
$$
$msuspensionabk$;

  EXECUTE $msuspensionabl$
-- Invitation pre-check (supersedes 20260925100000): a suspended person is reported, never re-admitted.
CREATE OR REPLACE FUNCTION public.seat_check_for_invitation(p_company_id UUID, p_invitee UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_account  UUID;
  v_cap      JSONB;
  v_reserved INTEGER;
BEGIN
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
  IF v_account IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'WORKSPACE_NOT_FOUND');
  END IF;
  IF p_invitee IS NOT NULL AND public._named_user_suspended(v_account, p_invitee) THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'NAMED_USER_SUSPENDED');
  END IF;
  IF p_invitee IS NOT NULL AND EXISTS (SELECT 1 FROM public._account_named_users(v_account, true) u WHERE u.named_user_id = p_invitee) THEN
    RETURN jsonb_build_object('allowed', true, 'code', 'ALREADY_A_NAMED_USER');
  END IF;
  v_cap := public._seat_capacity_for_account(v_account);
  IF NOT COALESCE((v_cap->>'determined')::boolean, false) THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'SEAT_CAPACITY_UNDETERMINED', 'plan_code', v_cap->>'plan_code');
  END IF;
  v_reserved := (SELECT count(*) FROM public._account_named_users(v_account, true));
  IF v_reserved + 1 > (v_cap->>'allowed_named_users')::integer THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'SEAT_LIMIT_REACHED', 'plan_code', v_cap->>'plan_code',
      'allowed_named_users', v_cap->'allowed_named_users', 'reserved_named_users', v_reserved,
      'additional_seats_purchasable', v_cap->'additional_seats_purchasable');
  END IF;
  RETURN jsonb_build_object('allowed', true, 'code', 'ALLOWED');
END;
$$
$msuspensionabl$;

  EXECUTE $msuspensionabm$
-- Seat state (supersedes 20260925100000): also the suspended count and whether the account is over its allowance.
-- A person who is not active gets exactly what an outsider gets.
CREATE OR REPLACE FUNCTION public.get_workspace_seat_capacity(p_company_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_account UUID;
  v_cap     JSONB;
  v_active  INTEGER;
BEGIN
  IF auth.uid() IS NULL OR public._workspace_access_basis(auth.uid(), p_company_id) IS NULL THEN
    RETURN jsonb_build_object('access', false);
  END IF;
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
  v_cap := public._seat_capacity_for_account(v_account);
  v_active := (SELECT count(*) FROM public._account_named_users(v_account, false));
  RETURN v_cap || jsonb_build_object('access', true,
    'active_named_users', v_active,
    'reserved_named_users', (SELECT count(*) FROM public._account_named_users(v_account, true)),
    'suspended_named_users', (SELECT count(*) FROM public.named_user_billing_suspensions s WHERE s.account_user_id = v_account AND s.lifted_at IS NULL),
    'over_allowance', NOT COALESCE((v_cap->>'determined')::boolean, false) OR v_active > (v_cap->>'allowed_named_users')::integer,
    'is_account_holder', v_account = auth.uid());
END;
$$
$msuspensionabm$;

  EXECUTE $msuspensionabn$
-- ── 11. Privileges ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.invitation_reservation_ttl() FROM PUBLIC, anon
$msuspensionabn$;

  EXECUTE $msuspensionabo$
GRANT EXECUTE ON FUNCTION public.invitation_reservation_ttl() TO authenticated, service_role
$msuspensionabo$;

  EXECUTE $msuspensionabp$
REVOKE ALL ON FUNCTION public._invitation_valid(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon
$msuspensionabp$;

  EXECUTE $msuspensionabq$
GRANT EXECUTE ON FUNCTION public._invitation_valid(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role
$msuspensionabq$;

  EXECUTE $msuspensionabr$
REVOKE ALL ON FUNCTION public._named_user_suspended(UUID, UUID) FROM PUBLIC, anon, authenticated
$msuspensionabr$;

  EXECUTE $msuspensionabs$
REVOKE ALL ON FUNCTION public._account_named_users(UUID, BOOLEAN, UUID, UUID) FROM PUBLIC, anon, authenticated
$msuspensionabs$;

  EXECUTE $msuspensionabt$
REVOKE ALL ON FUNCTION public._account_named_user_access_active(UUID, UUID) FROM PUBLIC, anon, authenticated
$msuspensionabt$;

  EXECUTE $msuspensionabu$
REVOKE ALL ON FUNCTION public.named_user_access_active(UUID, UUID) FROM PUBLIC, anon
$msuspensionabu$;

  EXECUTE $msuspensionabv$
GRANT EXECUTE ON FUNCTION public.named_user_access_active(UUID, UUID) TO authenticated, service_role
$msuspensionabv$;

  EXECUTE $msuspensionabw$
REVOKE ALL ON FUNCTION public._workspace_access_basis(UUID, UUID) FROM PUBLIC, anon, authenticated
$msuspensionabw$;

  EXECUTE $msuspensionabx$
REVOKE ALL ON FUNCTION public.named_user_seat_wall() FROM PUBLIC, anon, authenticated
$msuspensionabx$;

  EXECUTE $msuspensionaby$
REVOKE ALL ON FUNCTION public.named_user_billing_suspensions_guard() FROM PUBLIC, anon, authenticated
$msuspensionaby$;

  EXECUTE $msuspensionabz$
REVOKE ALL ON FUNCTION public.named_user_billing_suspensions_no_truncate() FROM PUBLIC, anon, authenticated
$msuspensionabz$;

  EXECUTE $msuspensionaca$
REVOKE ALL ON FUNCTION public._named_user_roster(UUID) FROM PUBLIC, anon, authenticated
$msuspensionaca$;

  EXECUTE $msuspensionacb$
REVOKE ALL ON FUNCTION public._apply_named_user_selection(UUID, UUID[], TEXT, INTEGER, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated
$msuspensionacb$;

  EXECUTE $msuspensionacc$
REVOKE ALL ON FUNCTION public.commercial_named_user_reconcile_trigger() FROM PUBLIC, anon, authenticated
$msuspensionacc$;

  EXECUTE $msuspensionacd$
REVOKE ALL ON FUNCTION public.get_named_user_roster() FROM PUBLIC, anon
$msuspensionacd$;

  EXECUTE $msuspensionace$
GRANT EXECUTE ON FUNCTION public.get_named_user_roster() TO authenticated
$msuspensionace$;

  EXECUTE $msuspensionacf$
REVOKE ALL ON FUNCTION public.choose_active_named_users(UUID[], TEXT) FROM PUBLIC, anon
$msuspensionacf$;

  EXECUTE $msuspensionacg$
GRANT EXECUTE ON FUNCTION public.choose_active_named_users(UUID[], TEXT) TO authenticated
$msuspensionacg$;

  EXECUTE $msuspensionach$
REVOKE ALL ON FUNCTION public.admin_prepare_planned_reduction(UUID, INTEGER, UUID[], TEXT, TEXT) FROM PUBLIC, anon
$msuspensionach$;

  EXECUTE $msuspensionaci$
GRANT EXECUTE ON FUNCTION public.admin_prepare_planned_reduction(UUID, INTEGER, UUID[], TEXT, TEXT) TO authenticated
$msuspensionaci$;

  EXECUTE $msuspensionacj$
REVOKE ALL ON FUNCTION public.reconcile_named_user_allowance(UUID) FROM PUBLIC, anon, authenticated
$msuspensionacj$;

  EXECUTE $msuspensionack$
GRANT EXECUTE ON FUNCTION public.reconcile_named_user_allowance(UUID) TO service_role
$msuspensionack$;

  EXECUTE $msuspensionacl$
REVOKE ALL ON FUNCTION public.reconcile_all_named_user_allowances() FROM PUBLIC, anon, authenticated
$msuspensionacl$;

  EXECUTE $msuspensionacm$
GRANT EXECUTE ON FUNCTION public.reconcile_all_named_user_allowances() TO service_role
$msuspensionacm$;

  EXECUTE $msuspensionacn$
REVOKE ALL ON FUNCTION public.admin_set_licence_additional_seats(UUID, INTEGER, TEXT) FROM PUBLIC, anon
$msuspensionacn$;

  EXECUTE $msuspensionaco$
GRANT EXECUTE ON FUNCTION public.admin_set_licence_additional_seats(UUID, INTEGER, TEXT) TO authenticated
$msuspensionaco$;

  EXECUTE $msuspensionacp$
REVOKE ALL ON FUNCTION public.reserve_workspace_invitation(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated
$msuspensionacp$;

  EXECUTE $msuspensionacq$
GRANT EXECUTE ON FUNCTION public.reserve_workspace_invitation(UUID, UUID, TEXT, UUID, TEXT) TO service_role
$msuspensionacq$;

  EXECUTE $msuspensionacr$
REVOKE ALL ON FUNCTION public.release_workspace_invitation(UUID) FROM PUBLIC, anon, authenticated
$msuspensionacr$;

  EXECUTE $msuspensionacs$
GRANT EXECUTE ON FUNCTION public.release_workspace_invitation(UUID) TO service_role
$msuspensionacs$;

  EXECUTE $msuspensionact$
REVOKE ALL ON FUNCTION public.cancel_workspace_invitation(UUID) FROM PUBLIC, anon
$msuspensionact$;

  EXECUTE $msuspensionacu$
GRANT EXECUTE ON FUNCTION public.cancel_workspace_invitation(UUID) TO authenticated
$msuspensionacu$;

  EXECUTE $msuspensionacv$
REVOKE ALL ON FUNCTION public.accept_workspace_invitations() FROM PUBLIC, anon
$msuspensionacv$;

  EXECUTE $msuspensionacw$
GRANT EXECUTE ON FUNCTION public.accept_workspace_invitations() TO authenticated
$msuspensionacw$;

  EXECUTE $msuspensionacx$
REVOKE ALL ON FUNCTION public.seat_check_for_invitation(UUID, UUID) FROM PUBLIC, anon, authenticated
$msuspensionacx$;

  EXECUTE $msuspensionacy$
REVOKE ALL ON FUNCTION public.workspace_authority_basis(uuid, uuid, text) FROM PUBLIC, anon, authenticated
$msuspensionacy$;

  EXECUTE $msuspensionacz$
GRANT EXECUTE ON FUNCTION public.workspace_authority_basis(uuid, uuid, text) TO service_role
$msuspensionacz$;

  EXECUTE $msuspensionada$
GRANT EXECUTE ON FUNCTION public.seat_check_for_invitation(UUID, UUID) TO service_role
$msuspensionada$;

  EXECUTE $msuspensionadb$
REVOKE ALL ON FUNCTION public.get_workspace_seat_capacity(UUID) FROM PUBLIC, anon
$msuspensionadb$;

  EXECUTE $msuspensionadc$
GRANT EXECUTE ON FUNCTION public.get_workspace_seat_capacity(UUID) TO authenticated
$msuspensionadc$;

  EXECUTE $msuspensionadd$
-- ── 12. Materialise the rule for every account that is already over its allowance (deterministic: only the
--        account holder stays active; every membership, grant and history row is kept).
SELECT public.reconcile_all_named_user_allowances()
$msuspensionadd$;
END
$cfoclose_suspension$;
