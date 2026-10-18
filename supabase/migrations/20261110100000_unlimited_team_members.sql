-- 20261110100000_unlimited_team_members.sql — unlimited team members on Solo, Practice and Firm (owner decision,
-- 2026-10-18). Forward-only. Adds ONE plan column; redefines the named-user capacity functions; deletes nothing.
--
-- The decision: Solo, Practice and Firm include unlimited team members. That replaces the named-user allowance (one
-- included user, plus additional seats on Practice and Firm at a proposed USD 200 per year that was never sold
-- online). Prices, active-entity capacities, 12-month terms and renewal conditions are unchanged. Enterprise keeps its
-- agreed terms (a numeric allowance).
--
-- How it is expressed: commercial_plans.members_unlimited, an explicit boolean. It is never a large integer, and NULL
-- never means "unlimited" (Iron Dome: NULL means not computed). _seat_capacity_for_account answers
-- {unlimited: true, determined: true, allowed_named_users: NULL} for those plans, and every consumer of that answer
-- tests the flag explicitly before comparing a count.
--
-- What does NOT change:
--   * who may invite, accept, revoke or hold a role. Invitation authorisation, roles, the sign-off role gate and RLS
--     are not touched. Membership never confers reviewer or approver authority.
--   * the invitation lifecycle: bounded reservation window, expiry, cancellation, and acceptance only while valid.
--   * billing suspensions: append-only history; a suspended person stays without access until the account holder lifts
--     it. Loss of the plan (no current licence) still falls back to the account holder only, and reconciliation still
--     suspends everyone else in that case.
--   * the per-account advisory lock that serialises membership changes, active-entity capacity, and tenant isolation.
--   * recorded history: commercial_licences.additional_seats, commercial_plans.included_seats, NAMED_USER_SEATS
--     overrides and every audit row are kept as recorded and still reported. Purchased seats on an unlimited-members
--     plan can be lowered (recorded) but never raised. Nothing here refunds or alters an agreement.
--   * no usage, storage, processing or invitation-rate control is removed (none of them is a seat count).
--
-- Catalogue audit: commercial_catalog_audit_events requires a human actor, which a migration does not have, so this
-- header is the record of the plan change. The previous values are: members_unlimited absent; Practice and Firm
-- additional_seats_purchasable = true; Solo false; the four Practice/Firm additional-seat price rows active and not
-- purchasable.

DO $preflight$
BEGIN
  IF to_regprocedure('public._seat_capacity_for_account(uuid)') IS NULL
     OR to_regprocedure('public.named_user_seat_wall()') IS NULL
     OR to_regprocedure('public._named_user_roster(uuid)') IS NULL
     OR to_regprocedure('public.choose_active_named_users(uuid[],text)') IS NULL
     OR to_regprocedure('public.seat_check_for_invitation(uuid,uuid)') IS NULL
     OR to_regprocedure('public.get_workspace_seat_capacity(uuid)') IS NULL
     OR to_regprocedure('public.reconcile_named_user_allowance(uuid)') IS NULL
     OR to_regprocedure('public.admin_set_licence_additional_seats(uuid,integer,text)') IS NULL
     OR to_regprocedure('public._resolve_entitlement_for_owner(uuid,text)') IS NULL
     OR to_regprocedure('public.is_platform_owner(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the named-user and entitlement authority this change extends is missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commercial_plans' AND column_name = 'members_unlimited') THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: unlimited team members are already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM public.commercial_plans cp JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
       WHERE cp.code IN ('SOLO','PRACTICE','FIRM')) <> 3 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: expected exactly the CFOClose Solo, Practice and Firm plans; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 0. The plan flag ──────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.commercial_plans ADD COLUMN members_unlimited BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN public.commercial_plans.members_unlimited IS
  'Unlimited team members (20261110100000). true: membership has no named-user number; included_seats and any purchased seats are history only. Never inferred from a NULL or a large number.';
COMMENT ON COLUMN public.commercial_plans.included_seats IS
  'Named users included by a plan WITHOUT unlimited team members (Enterprise, retired plans). Kept as recorded on unlimited-members plans; not used to bound membership there.';

UPDATE public.commercial_plans SET members_unlimited = true, additional_seats_purchasable = false
 WHERE code IN ('SOLO','PRACTICE','FIRM')
   AND product_id = (SELECT id FROM public.commercial_products WHERE code = 'CFOCLOSE');

-- Unlimited membership is the published offer for these three plans only (Enterprise is agreed per contract), and a plan
-- with unlimited members never sells seats.
ALTER TABLE public.commercial_plans ADD CONSTRAINT chk_cp_members_unlimited_plans
  CHECK (NOT members_unlimited OR code IN ('SOLO','PRACTICE','FIRM'));
ALTER TABLE public.commercial_plans ADD CONSTRAINT chk_cp_members_unlimited_no_seat_sales
  CHECK (NOT members_unlimited OR NOT additional_seats_purchasable);

-- The proposed additional-seat price (USD 20 per month / USD 200 per year on Practice and Firm; never purchasable) is
-- retired, not deleted: its rows stay, inactive.
UPDATE public.commercial_additional_seat_prices SET is_active = false
 WHERE is_active AND plan_id IN (SELECT cp.id FROM public.commercial_plans cp JOIN public.commercial_products p ON p.id = cp.product_id
                                  WHERE p.code = 'CFOCLOSE' AND cp.code IN ('PRACTICE','FIRM'));

UPDATE public.commercial_capabilities
   SET description = 'Who may use the account, each with their own sign-in. Solo, Practice and Firm: unlimited team members. Enterprise: as agreed.'
 WHERE code = 'NAMED_USER_SEATS';

-- ── 1. Capacity: an explicit unlimited answer (never a large number). Everything else is unchanged.
CREATE OR REPLACE FUNCTION public._seat_capacity_for_account(p_account UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_bc        UUID;
  v_lic       RECORD;
  v_found     BOOLEAN := false;
  v_included  INTEGER;
  v_purchased INTEGER;
  v_override  INTEGER;
  v_source    TEXT := 'ACTIVE_LICENCE';
  v_ok        BOOLEAN;
BEGIN
  IF p_account IS NULL THEN
    RETURN jsonb_build_object('unlimited', false, 'determined', false, 'plan_code', NULL, 'included_seats', NULL, 'additional_seats', NULL,
      'allowed_named_users', NULL, 'additional_seats_purchasable', false, 'source', NULL);
  END IF;
  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_account LIMIT 1;
  IF v_bc IS NOT NULL THEN
    SELECT cp.code AS plan_code, cp.included_seats, cp.additional_seats_purchasable, cl.additional_seats, cp.members_unlimited INTO v_lic
      FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
     WHERE cl.billing_customer_id = v_bc AND cl.status IN ('ACTIVE','GRACE')
       AND cl.effective_start <= clock_timestamp() AND (cl.effective_end IS NULL OR cl.effective_end > clock_timestamp())
     ORDER BY cl.effective_start DESC LIMIT 1;
    v_found := FOUND;
  END IF;
  IF NOT v_found OR v_lic.plan_code = 'FREE' THEN
    RETURN jsonb_build_object('unlimited', false, 'determined', true, 'plan_code', NULL, 'included_seats', 1, 'additional_seats', 0,
      'allowed_named_users', 1, 'additional_seats_purchasable', false, 'source', 'NO_CURRENT_PLAN');
  END IF;
  IF v_lic.plan_code NOT IN ('SOLO','PRACTICE','FIRM','ENTERPRISE','PAID') THEN
    RETURN jsonb_build_object('unlimited', false, 'determined', false, 'plan_code', NULL, 'included_seats', NULL, 'additional_seats', NULL,
      'allowed_named_users', NULL, 'additional_seats_purchasable', false, 'source', 'UNKNOWN_PLAN');
  END IF;
  -- Unlimited team members (20261110100000): the plan's offer has no named-user number. Recorded included seats, purchased
  -- seats and numeric overrides are kept as history and reported, but they no longer bound membership.
  IF v_lic.members_unlimited THEN
    RETURN jsonb_build_object('unlimited', true, 'determined', true, 'plan_code', v_lic.plan_code,
      'included_seats', v_lic.included_seats, 'additional_seats', v_lic.additional_seats,
      'allowed_named_users', NULL, 'additional_seats_purchasable', false, 'source', 'PLAN_UNLIMITED_TEAM_MEMBERS');
  END IF;
  v_included := v_lic.included_seats;
  SELECT max(eo.capacity_value) INTO v_override FROM public.entitlement_overrides eo
   WHERE eo.billing_customer_id = v_bc AND eo.feature_code = 'NAMED_USER_SEATS' AND eo.revoked_at IS NULL
     AND eo.effective_start <= now() AND (eo.effective_end IS NULL OR eo.effective_end > now());
  IF v_override IS NOT NULL AND v_override > COALESCE(v_included, 0) THEN
    v_included := v_override; v_source := 'ADMIN_OVERRIDE';
  END IF;
  v_purchased := v_lic.additional_seats;
  v_ok := v_included IS NOT NULL AND v_included >= 1 AND v_purchased IS NOT NULL AND v_purchased >= 0
          AND (v_lic.plan_code <> 'SOLO' OR v_purchased = 0);
  RETURN jsonb_build_object('unlimited', false, 'determined', v_ok, 'plan_code', v_lic.plan_code,
    'included_seats', v_included, 'additional_seats', v_purchased,
    'allowed_named_users', CASE WHEN v_ok THEN v_included + v_purchased END,
    'additional_seats_purchasable', v_lic.additional_seats_purchasable, 'source', v_source);
END;
$$;

-- ── 2. Activity: unlimited membership is active for every non-suspended member (suspension still ends access).
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
  RETURN COALESCE((v_cap->>'unlimited')::boolean, false)
      OR (SELECT count(*) FROM public._account_named_users(p_account, false)) <= (v_cap->>'allowed_named_users')::integer;
END;
$$;

-- ── 3. Seat wall: no count under unlimited membership; every other check before it is unchanged.
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
  IF COALESCE((v_cap->>'unlimited')::boolean, false) THEN
    RETURN NEW;  -- unlimited team members: no count. Invitation validity, suspension and the account lock above still apply.
  END IF;
  v_allowed := (v_cap->>'allowed_named_users')::integer;
  IF v_adds
     AND NOT EXISTS (SELECT 1 FROM public._account_named_users(v_account, true, v_member, v_grant) u WHERE u.named_user_id = v_user)
     AND (SELECT count(*) FROM public._account_named_users(v_account, true, v_member, v_grant)) + 1 > v_allowed THEN
    RAISE EXCEPTION 'SEAT_LIMIT_REACHED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = COALESCE(v_cap->>'plan_code', 'NO_PLAN');
  END IF;
  IF v_activates
     AND NOT EXISTS (SELECT 1 FROM public._account_named_users(v_account, false, v_member, v_grant) u WHERE u.named_user_id = v_user)
     AND (SELECT count(*) FROM public._account_named_users(v_account, false, v_member, v_grant)) + 1 > v_allowed THEN
    RAISE EXCEPTION 'SEAT_LIMIT_REACHED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = COALESCE(v_cap->>'plan_code', 'NO_PLAN');
  END IF;
  RETURN NEW;
END;
$$;

-- ── 4. Suspension lift: allowed without a count under unlimited membership (history stays append-only).
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
    IF NOT COALESCE((v_cap->>'unlimited')::boolean, false)
       AND (SELECT count(*) FROM public._account_named_users(NEW.account_user_id, false)) + 1 > (v_cap->>'allowed_named_users')::integer THEN
      RAISE EXCEPTION 'SEAT_LIMIT_REACHED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = COALESCE(v_cap->>'plan_code', 'NO_PLAN');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 5. Roster: never over its allowance under unlimited membership; the version changes when the allowance does.
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
    'unlimited', COALESCE((v_cap->>'unlimited')::boolean, false),
    'over_allowance', NOT COALESCE((v_cap->>'determined')::boolean, false)
      OR (NOT COALESCE((v_cap->>'unlimited')::boolean, false) AND v_active + 1 > (v_cap->>'allowed_named_users')::integer),
    'people', v_people,
    'roster_version', md5(COALESCE((SELECT string_agg((e->>'user_id') || ':' || (e->>'state'), ',' ORDER BY e->>'user_id') FROM jsonb_array_elements(v_people) e), '')
                          || '|' || CASE WHEN COALESCE((v_cap->>'unlimited')::boolean, false) THEN 'unlimited' ELSE COALESCE(v_cap->>'allowed_named_users', 'undetermined') END));
END;
$$;

-- ── 6. Selection under unlimited membership: reactivation only (never suspends for capacity). Internal; not executable by clients.
CREATE OR REPLACE FUNCTION public._lift_named_user_suspensions_unlimited(p_account UUID, p_keep UUID[], p_roster_version TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_roster JSONB;
  v_valid  UUID[];
  v_lifted UUID[];
  v_bc     UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.named_user_seats:' || p_account::text, 0));
  v_roster := public._named_user_roster(p_account);
  IF NOT COALESCE((v_roster->>'unlimited')::boolean, false) THEN
    RETURN jsonb_build_object('outcome', 'stale_selection', 'roster_version', v_roster->>'roster_version');
  END IF;
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
  WITH l AS (
    UPDATE public.named_user_billing_suspensions SET lifted_at = now(), lifted_by = p_account, lift_reason = 'OWNER_SELECTION'
     WHERE account_user_id = p_account AND user_id = ANY (p_keep) AND lifted_at IS NULL
    RETURNING user_id)
  SELECT COALESCE(array_agg(user_id ORDER BY user_id), ARRAY[]::uuid[]) INTO v_lifted FROM l;
  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_account LIMIT 1;
  IF v_bc IS NOT NULL THEN
    INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
    VALUES (v_bc, p_account, 'NAMED_USER_SELECTION_APPLIED', jsonb_build_object('roster_version', p_roster_version),
            jsonb_build_object('active', to_jsonb(p_keep), 'suspended', '[]'::jsonb, 'lifted', to_jsonb(v_lifted), 'unlimited', true), 'OWNER_SELECTION');
  END IF;
  RETURN jsonb_build_object('outcome', 'applied', 'active', to_jsonb(p_keep), 'suspended', '[]'::jsonb, 'lifted', to_jsonb(v_lifted));
END;
$$;

-- ── 7. The account holder's selection: unchanged under a numeric allowance; reactivation only under unlimited membership.
CREATE OR REPLACE FUNCTION public.choose_active_named_users(p_keep UUID[], p_roster_version TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cap JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;
  v_cap := public._seat_capacity_for_account(auth.uid());
  IF COALESCE((v_cap->>'unlimited')::boolean, false) THEN
    -- Unlimited team members: a selection only REACTIVATES the people it names (lifting their billing suspension).
    -- Nobody is suspended for capacity. Removing a person is a membership action, never a billing suspension.
    RETURN public._lift_named_user_suspensions_unlimited(auth.uid(), p_keep, p_roster_version);
  END IF;
  RETURN public._apply_named_user_selection(auth.uid(), p_keep, p_roster_version,
    CASE WHEN COALESCE((v_cap->>'determined')::boolean, false) THEN (v_cap->>'allowed_named_users')::integer END,
    auth.uid(), 'OWNER_SELECTION', 'OWNER_SELECTION');
END;
$$;

-- ── 8. Reconciliation: nobody is suspended for capacity under unlimited membership; loss of the plan still suspends.
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
     AND (COALESCE((v_cap->>'unlimited')::boolean, false) OR (SELECT count(*) FROM public._account_named_users(p_account, false)) <= (v_cap->>'allowed_named_users')::integer) THEN
    RETURN 0;
  END IF;
  INSERT INTO public.named_user_billing_suspensions (account_user_id, user_id, reason, suspended_by)
  SELECT p_account, u.named_user_id, 'ENTITLEMENT_LOST', NULL
    FROM public._account_named_users(p_account, false) u WHERE u.named_user_id <> p_account;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ── 9. Invitation check: no seat count under unlimited membership (who may invite is decided elsewhere and is unchanged).
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
  IF COALESCE((v_cap->>'unlimited')::boolean, false) THEN
    RETURN jsonb_build_object('allowed', true, 'code', 'ALLOWED', 'unlimited', true, 'plan_code', v_cap->>'plan_code');
  END IF;
  v_reserved := (SELECT count(*) FROM public._account_named_users(v_account, true));
  IF v_reserved + 1 > (v_cap->>'allowed_named_users')::integer THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'SEAT_LIMIT_REACHED', 'plan_code', v_cap->>'plan_code',
      'allowed_named_users', v_cap->'allowed_named_users', 'reserved_named_users', v_reserved,
      'additional_seats_purchasable', v_cap->'additional_seats_purchasable');
  END IF;
  RETURN jsonb_build_object('allowed', true, 'code', 'ALLOWED');
END;
$$;

-- ── 10. Seat state: never over its allowance under unlimited membership (v_cap carries unlimited = true).
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
    'over_allowance', NOT COALESCE((v_cap->>'determined')::boolean, false)
      OR (NOT COALESCE((v_cap->>'unlimited')::boolean, false) AND v_active > (v_cap->>'allowed_named_users')::integer),
    'is_account_holder', v_account = auth.uid());
END;
$$;

-- ── 11. Purchased seats: never raised on an unlimited-members plan; recorded history is kept, and lowering it needs no selection.
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
  SELECT cl.id, cl.billing_customer_id, cl.additional_seats, cp.code AS plan_code, cp.members_unlimited, b.owner_user_id AS account INTO v_lic
    FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
    JOIN public.billing_customers b ON b.id = cl.billing_customer_id
   WHERE cl.id = p_licence_id FOR UPDATE OF cl;
  IF NOT FOUND THEN RAISE EXCEPTION 'LICENCE_NOT_FOUND' USING ERRCODE = '22023'; END IF;
  IF v_lic.plan_code = 'FREE' THEN RAISE EXCEPTION 'FREE_PLAN_HAS_NO_ADDITIONAL_SEATS' USING ERRCODE = '22023'; END IF;
  IF v_lic.plan_code = 'SOLO' AND p_quantity <> 0 THEN RAISE EXCEPTION 'SOLO_PLAN_HAS_NO_ADDITIONAL_SEATS' USING ERRCODE = '22023'; END IF;
  -- Unlimited team members: no seats are sold. A recorded quantity (history) may be lowered, never raised.
  IF v_lic.members_unlimited AND p_quantity > v_lic.additional_seats THEN
    RAISE EXCEPTION 'PLAN_HAS_UNLIMITED_TEAM_MEMBERS' USING ERRCODE = '22023';
  END IF;
  IF p_quantity < v_lic.additional_seats AND NOT v_lic.members_unlimited THEN
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
$$;

-- ── 12. Entitlement resolver: identical except that a capacity answer also states whether it is unlimited.
CREATE OR REPLACE FUNCTION public._resolve_entitlement_for_owner(p_owner_user_id UUID, p_feature_code TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cap      TEXT := public.commercial_canonical_capability(p_feature_code);
  v_kind     TEXT;
  v_bc       UUID;
  v_licence  RECORD;
  v_included BOOLEAN;
  v_result   JSONB;
BEGIN
  IF v_cap IS NULL THEN
    RETURN jsonb_build_object('status','UNKNOWN','reason','UNKNOWN_FEATURE_CODE','capability',NULL,'licence_status',NULL,'plan_code',NULL,'source',NULL);
  END IF;
  SELECT kind INTO v_kind FROM public.commercial_capabilities WHERE code = v_cap;
  IF p_owner_user_id IS NULL THEN
    RETURN jsonb_build_object('status','UNKNOWN','reason','NO_OWNER_IDENTITY','capability',v_cap,'licence_status',NULL,'plan_code',NULL,'source',NULL);
  END IF;
  IF v_kind = 'capacity' THEN
    v_result := CASE v_cap WHEN 'ENTITY_CAPACITY' THEN public._entity_capacity_for_account(p_owner_user_id)
                           ELSE public._seat_capacity_for_account(p_owner_user_id) END;
    RETURN jsonb_build_object('status', CASE WHEN (v_result->>'determined')::boolean THEN 'ENTITLED' ELSE 'UNKNOWN' END,
      'reason', CASE WHEN (v_result->>'determined')::boolean THEN 'CAPACITY_DETERMINED' ELSE 'CAPACITY_UNDETERMINED' END,
      'capability', v_cap, 'licence_status', NULL, 'plan_code', v_result->>'plan_code', 'source', v_result->>'source',
      'capacity', CASE v_cap WHEN 'ENTITY_CAPACITY' THEN v_result->'capacity' ELSE v_result->'allowed_named_users' END,
      'unlimited', COALESCE((v_result->>'unlimited')::boolean, false));
  END IF;

  -- Platform owner: complimentary access to every RELEASED customer capability. No licence, no payment, no revenue.
  -- Withheld modules (capability_customer_available = false) and unknown features are never granted here (fail closed).
  IF public.is_platform_owner(p_owner_user_id) AND public.capability_customer_available(v_cap) THEN
    RETURN jsonb_build_object('status','ENTITLED','reason','PLATFORM_OWNER_COMPLIMENTARY','capability',v_cap,'licence_status',NULL,'plan_code',NULL,'source','PLATFORM_OWNER_COMPLIMENTARY');
  END IF;

  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_owner_user_id LIMIT 1;
  IF v_bc IS NULL THEN
    RETURN jsonb_build_object('status','NOT_ENTITLED','reason','NO_CURRENT_PLAN','capability',v_cap,'licence_status',NULL,'plan_code',NULL,'source',NULL);
  END IF;

  IF EXISTS (SELECT 1 FROM public.entitlement_overrides eo
              WHERE eo.billing_customer_id = v_bc AND eo.feature_code = v_cap AND eo.revoked_at IS NULL
                AND eo.effective_start <= now() AND (eo.effective_end IS NULL OR eo.effective_end > now())) THEN
    RETURN jsonb_build_object('status','ENTITLED','reason','ADMIN_OVERRIDE_ACTIVE','capability',v_cap,'licence_status',NULL,'plan_code',NULL,'source','ADMIN_OVERRIDE');
  END IF;

  SELECT cl.status AS licence_status, cp.id AS plan_id, cp.code AS plan_code INTO v_licence
    FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE cl.billing_customer_id = v_bc AND cl.status IN ('ACTIVE','GRACE')
     AND cl.effective_start <= clock_timestamp() AND (cl.effective_end IS NULL OR cl.effective_end > clock_timestamp())
   ORDER BY cl.effective_start DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','NOT_ENTITLED','reason','NO_CURRENT_PLAN','capability',v_cap,'licence_status',NULL,'plan_code',NULL,'source',NULL);
  END IF;
  IF v_licence.plan_code = 'FREE' THEN
    RETURN jsonb_build_object('status','NOT_ENTITLED','reason','RETIRED_PLAN','capability',v_cap,'licence_status',v_licence.licence_status,'plan_code',NULL,'source',NULL);
  END IF;
  IF v_licence.plan_code NOT IN ('SOLO','PRACTICE','FIRM','ENTERPRISE','PAID') THEN
    RETURN jsonb_build_object('status','NOT_ENTITLED','reason','UNKNOWN_PLAN','capability',v_cap,'licence_status',v_licence.licence_status,'plan_code',NULL,'source',NULL);
  END IF;
  SELECT f.included INTO v_included FROM public.commercial_plan_features f WHERE f.plan_id = v_licence.plan_id AND f.capability_code = v_cap;
  IF v_included IS NULL THEN
    RETURN jsonb_build_object('status','NOT_ENTITLED','reason','NOT_IN_PLAN_MATRIX','capability',v_cap,'licence_status',v_licence.licence_status,'plan_code',v_licence.plan_code,'source',NULL);
  END IF;
  IF v_included THEN
    RETURN jsonb_build_object('status','ENTITLED','reason','ACTIVE_LICENCE_INCLUDES_FEATURE','capability',v_cap,'licence_status',v_licence.licence_status,'plan_code',v_licence.plan_code,'source','ACTIVE_LICENCE');
  END IF;
  RETURN jsonb_build_object('status','NOT_ENTITLED','reason','PLAN_DOES_NOT_INCLUDE_FEATURE','capability',v_cap,'licence_status',v_licence.licence_status,'plan_code',v_licence.plan_code,'source',NULL);
END;
$$;

-- ── Privileges. CREATE OR REPLACE keeps every existing grant; only the new internal helper needs its own. ──────────
REVOKE ALL ON FUNCTION public._lift_named_user_suspensions_unlimited(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
