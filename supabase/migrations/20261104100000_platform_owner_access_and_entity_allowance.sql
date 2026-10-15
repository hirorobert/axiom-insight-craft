-- 20261104100000_platform_owner_access_and_entity_allowance.sql
--
-- Platform-owner administration, complimentary (non-payment) access, and an EXPLICIT unlimited entity allowance.
-- This migration EXTENDS the canonical systems in place; it introduces no parallel permission check.
--   * cross-tenant admin authority  -> extends public.commercial_admins (adds an `authority` tier; platform_owner ⊇ commercial)
--   * complimentary capability access-> extends public._resolve_entitlement_for_owner (platform-owner branch, RELEASED only)
--   * unlimited entity allowance     -> extends public.entitlement_overrides + public._entity_capacity_for_account
--                                        + public.company_entity_capacity_wall (an EXPLICIT boolean, never a sentinel number)
-- Non-waivers (unchanged by this migration): tenant isolation / company membership, the sign-off / distinct-signer /
-- validation / immutable-history triggers, the withheld-module gate (public.capability_customer_available), and audit logging.
-- No payment, subscription or revenue row is ever created by any grant here.
-- Packaging: this migration contains NO transaction-control statement. Atomicity is provided by the authoritative hosted
-- runner's self-checking wrapper (one DO statement; see release/wrappers/ + docs/release/access-a1) — the same reviewed
-- pattern every migration since 20261011100000 uses. The runner wraps application and journal registration in one transaction.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Platform-owner tier on the one canonical cross-tenant admin table
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.commercial_admins
  ADD COLUMN IF NOT EXISTS authority TEXT NOT NULL DEFAULT 'commercial';
ALTER TABLE public.commercial_admins
  DROP CONSTRAINT IF EXISTS chk_ca_authority;
ALTER TABLE public.commercial_admins
  ADD CONSTRAINT chk_ca_authority CHECK (authority IN ('commercial', 'platform_owner'));

COMMENT ON COLUMN public.commercial_admins.authority IS
  'commercial = billing/commercial administrator (existing behaviour). platform_owner = the strict superset: every existing '
  'commercial_admins check (active) still passes, plus platform-owner-only RPCs. Still never overloads firm_members.role.';

-- A platform owner is an ACTIVE commercial_admins row at the platform_owner tier. STABLE so entitlement resolvers can call it.
CREATE OR REPLACE FUNCTION public.is_platform_owner(p_user UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.commercial_admins ca
     WHERE ca.user_id = p_user AND ca.active AND ca.authority = 'platform_owner'
  );
$$;
REVOKE ALL ON FUNCTION public.is_platform_owner(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_owner(UUID) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Explicit unlimited entity allowance on entitlement_overrides
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.entitlement_overrides
  ADD COLUMN IF NOT EXISTS unlimited BOOLEAN NOT NULL DEFAULT false;

-- Replace the capacity constraint: ENTITY_CAPACITY may be a positive number XOR an explicit unlimited; NAMED_USER_SEATS is
-- always a positive number; non-capacity overrides carry neither. "Unlimited" is an explicit boolean, never a large integer.
ALTER TABLE public.entitlement_overrides DROP CONSTRAINT IF EXISTS chk_eo_capacity;
ALTER TABLE public.entitlement_overrides
  ADD CONSTRAINT chk_eo_capacity CHECK (
       (feature_code = 'ENTITY_CAPACITY' AND (
             (unlimited = false AND capacity_value IS NOT NULL AND capacity_value > 0)
          OR (unlimited = true  AND capacity_value IS NULL)))
    OR (feature_code = 'NAMED_USER_SEATS' AND unlimited = false AND capacity_value IS NOT NULL AND capacity_value > 0)
    OR (feature_code NOT IN ('ENTITY_CAPACITY','NAMED_USER_SEATS') AND unlimited = false AND capacity_value IS NULL)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Append-only access-administration ledger (directive §6)
--    Records every grant/revoke: recipient, scope, capability, source, allowance, expiry, actor, reason, timestamps.
--    FK-free on user/scope columns (like audit_logs) so history survives a later user/company removal.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.access_grant_events (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  recipient_user_id   UUID        NOT NULL,
  billing_customer_id UUID        NULL,
  company_id          UUID        NULL,
  grant_kind          TEXT        NOT NULL,
  capability          TEXT        NULL,
  source              TEXT        NOT NULL,
  allowance           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  effective_start     TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_end       TIMESTAMPTZ NULL,
  actor_user_id       UUID        NOT NULL,
  reason              TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT access_grant_events_pk PRIMARY KEY (id),
  CONSTRAINT chk_age_kind CHECK (grant_kind IN (
    'PLATFORM_OWNER_GRANT','PLATFORM_OWNER_REVOKE','COMPLIMENTARY_CAPABILITY','ENTITY_ALLOWANCE','ACCESS_REVOKE')),
  CONSTRAINT chk_age_reason CHECK (length(trim(reason)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_age_recipient ON public.access_grant_events (recipient_user_id, created_at DESC);

ALTER TABLE public.access_grant_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS age_select_admin_or_self ON public.access_grant_events;
CREATE POLICY age_select_admin_or_self ON public.access_grant_events
  FOR SELECT USING (
    recipient_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
  );
REVOKE ALL ON public.access_grant_events FROM anon, authenticated;
GRANT SELECT ON public.access_grant_events TO authenticated;
GRANT ALL    ON public.access_grant_events TO service_role;

CREATE OR REPLACE FUNCTION public.access_grant_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'access_grant_events is append-only; % is not permitted.', TG_OP USING ERRCODE = 'P0001';
END;
$$;
DROP TRIGGER IF EXISTS trg_access_grant_events_immutable ON public.access_grant_events;
CREATE TRIGGER trg_access_grant_events_immutable
  BEFORE UPDATE OR DELETE ON public.access_grant_events
  FOR EACH ROW EXECUTE FUNCTION public.access_grant_events_immutable();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Recent-reauthentication gate (directive §7)
--    privileged_reauth holds short-lived single-use nonces minted by the `reauthenticate` edge function AFTER it verifies
--    the caller's password server-side. The table is service-role-only (no RLS policy => authenticated cannot read tokens).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.privileged_reauth (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  nonce       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  CONSTRAINT privileged_reauth_pk PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_privileged_reauth_lookup
  ON public.privileged_reauth (user_id, nonce) WHERE consumed_at IS NULL;
ALTER TABLE public.privileged_reauth ENABLE ROW LEVEL SECURITY;  -- no policy: only service_role / SECURITY DEFINER touch it
REVOKE ALL ON public.privileged_reauth FROM anon, authenticated;
GRANT ALL ON public.privileged_reauth TO service_role;

-- Minted by the edge function (service role) after a successful password re-verification. Never logs the password.
CREATE OR REPLACE FUNCTION public.record_privileged_reauth(p_user UUID, p_nonce TEXT, p_ttl_seconds INTEGER DEFAULT 300)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_user IS NULL OR p_nonce IS NULL OR length(trim(p_nonce)) = 0 THEN
    RAISE EXCEPTION 'INVALID_REAUTH' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.privileged_reauth (user_id, nonce, expires_at)
  VALUES (p_user, p_nonce, now() + make_interval(secs => GREATEST(30, LEAST(COALESCE(p_ttl_seconds,300), 900))));
END;
$$;
REVOKE ALL ON FUNCTION public.record_privileged_reauth(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_privileged_reauth(UUID, TEXT, INTEGER) TO service_role;

-- Consumed inside the privileged grant RPCs (single use). Internal only.
CREATE OR REPLACE FUNCTION public._consume_privileged_reauth(p_user UUID, p_nonce TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id UUID;
BEGIN
  IF p_user IS NULL OR p_nonce IS NULL OR length(trim(p_nonce)) = 0 THEN RETURN false; END IF;
  UPDATE public.privileged_reauth SET consumed_at = now()
   WHERE id = (SELECT id FROM public.privileged_reauth
                WHERE user_id = p_user AND nonce = p_nonce AND consumed_at IS NULL AND expires_at > now()
                ORDER BY created_at DESC LIMIT 1)
   RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._consume_privileged_reauth(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- Platform-owner + recent-reauth gate shared by every privileged grant RPC. Honours an aal2 JWT claim (MFA) when present,
-- otherwise requires a freshly-minted reauth nonce. Returns the actor uid or raises.
CREATE OR REPLACE FUNCTION public._require_platform_owner_reauth(p_reauth_nonce TEXT)
RETURNS UUID LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_aal  TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT public.is_platform_owner(v_uid) THEN RAISE EXCEPTION 'NOT_A_PLATFORM_OWNER' USING ERRCODE = '42501'; END IF;
  BEGIN
    v_aal := (current_setting('request.jwt.claims', true)::jsonb) ->> 'aal';
  EXCEPTION WHEN others THEN v_aal := NULL;
  END;
  IF v_aal IS DISTINCT FROM 'aal2' AND NOT public._consume_privileged_reauth(v_uid, p_reauth_nonce) THEN
    RAISE EXCEPTION 'REAUTH_REQUIRED' USING ERRCODE = 'PT401', HINT = 'recent reauthentication or MFA required';
  END IF;
  RETURN v_uid;
END;
$$;
REVOKE ALL ON FUNCTION public._require_platform_owner_reauth(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Canonical resolver extensions (platform-owner complimentary + explicit unlimited)
-- ─────────────────────────────────────────────────────────────────────────────

-- 5a. Entity capacity: platform-owner → unlimited; else honour an explicit unlimited override; else MAX(numeric override, plan).
CREATE OR REPLACE FUNCTION public._entity_capacity_for_account(p_account UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_bc        UUID;
  v_plan_code TEXT;
  v_plan_cap  INTEGER;
  v_override  INTEGER;
  v_source    TEXT;
  v_found     BOOLEAN := false;
  v_unltd     BOOLEAN := false;
BEGIN
  IF p_account IS NULL THEN
    RETURN jsonb_build_object('capacity', NULL, 'determined', false, 'unlimited', false, 'plan_code', NULL, 'source', NULL);
  END IF;
  -- Platform owner: explicit unlimited, complimentary (no licence, no payment).
  IF public.is_platform_owner(p_account) THEN
    RETURN jsonb_build_object('capacity', NULL, 'determined', true, 'unlimited', true, 'plan_code', NULL, 'source', 'PLATFORM_OWNER_COMPLIMENTARY');
  END IF;
  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_account LIMIT 1;
  IF v_bc IS NOT NULL THEN
    SELECT cp.code, cp.entity_capacity INTO v_plan_code, v_plan_cap
      FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
     WHERE cl.billing_customer_id = v_bc AND cl.status IN ('ACTIVE','GRACE')
       AND cl.effective_start <= clock_timestamp() AND (cl.effective_end IS NULL OR cl.effective_end > clock_timestamp())
     ORDER BY cl.effective_start DESC LIMIT 1;
    v_found := FOUND;
  END IF;
  IF NOT v_found OR v_plan_code = 'FREE' THEN
    v_plan_code := NULL; v_plan_cap := 0; v_source := 'NO_CURRENT_PLAN';
  ELSIF v_plan_code NOT IN ('SOLO','PRACTICE','FIRM','ENTERPRISE','PAID') THEN
    RETURN jsonb_build_object('capacity', NULL, 'determined', false, 'unlimited', false, 'plan_code', NULL, 'source', 'UNKNOWN_PLAN');
  ELSE
    v_source := 'ACTIVE_LICENCE';
  END IF;
  IF v_bc IS NOT NULL THEN
    -- An explicit unlimited ENTITY_CAPACITY override wins outright.
    SELECT true INTO v_unltd FROM public.entitlement_overrides eo
     WHERE eo.billing_customer_id = v_bc AND eo.feature_code = 'ENTITY_CAPACITY' AND eo.unlimited AND eo.revoked_at IS NULL
       AND eo.effective_start <= now() AND (eo.effective_end IS NULL OR eo.effective_end > now()) LIMIT 1;
    IF COALESCE(v_unltd, false) THEN
      RETURN jsonb_build_object('capacity', NULL, 'determined', true, 'unlimited', true, 'plan_code', v_plan_code, 'source', 'ADMIN_OVERRIDE');
    END IF;
    -- Otherwise a numeric override raises the plan number (MAX semantics, unchanged).
    SELECT max(eo.capacity_value) INTO v_override FROM public.entitlement_overrides eo
     WHERE eo.billing_customer_id = v_bc AND eo.feature_code = 'ENTITY_CAPACITY' AND eo.capacity_value IS NOT NULL
       AND eo.revoked_at IS NULL AND eo.effective_start <= now() AND (eo.effective_end IS NULL OR eo.effective_end > now());
    IF v_override IS NOT NULL AND v_override > COALESCE(v_plan_cap, 0) THEN
      v_plan_cap := v_override; v_source := 'ADMIN_OVERRIDE';
    END IF;
  END IF;
  RETURN jsonb_build_object('capacity', v_plan_cap, 'determined', v_plan_cap IS NOT NULL, 'unlimited', false, 'plan_code', v_plan_code, 'source', v_source);
END;
$$;

-- 5b. Entitlement resolver: platform-owner → complimentary ENTITLED for every RELEASED (customer-available) capability.
--     Capacity kinds still flow through _entity_capacity_for_account (which already handles platform-owner unlimited).
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
      'capacity', CASE v_cap WHEN 'ENTITY_CAPACITY' THEN v_result->'capacity' ELSE v_result->'allowed_named_users' END);
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

-- 5c. Entity wall: an unlimited allowance skips the count (still under the existing per-account advisory lock).
CREATE OR REPLACE FUNCTION public.company_entity_capacity_wall()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cap  JSONB;
  v_used INTEGER;
BEGIN
  IF NOT COALESCE(NEW.is_active, true) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.is_active, true) AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose.entity_capacity:' || NEW.user_id::text, 0));
  v_cap := public._entity_capacity_for_account(NEW.user_id);
  IF NOT (v_cap->>'determined')::boolean THEN
    RAISE EXCEPTION 'ENTITY_CAPACITY_UNDETERMINED' USING ERRCODE = 'PT402', DETAIL = 'ENTITY_CAPACITY', HINT = 'ENTERPRISE';
  END IF;
  IF COALESCE((v_cap->>'unlimited')::boolean, false) THEN
    RETURN NEW;  -- explicit unlimited allowance: no count check
  END IF;
  SELECT count(*) INTO v_used FROM public.companies c
   WHERE c.user_id = NEW.user_id AND COALESCE(c.is_active, true) AND c.id <> NEW.id;
  IF v_used >= (v_cap->>'capacity')::integer THEN
    RAISE EXCEPTION 'ENTITY_CAPACITY_REACHED' USING ERRCODE = 'PT402', DETAIL = 'ENTITY_CAPACITY', HINT = COALESCE(v_cap->>'plan_code', 'NO_PLAN');
  END IF;
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Bootstrap + grant / revoke RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- First platform owner only: service-role / database-owner, naming a verified auth.users.id. Refuses once one exists.
CREATE OR REPLACE FUNCTION public.bootstrap_first_platform_owner(p_user_id UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_existing INTEGER;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'USER_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_existing FROM public.commercial_admins WHERE active AND authority = 'platform_owner';
  IF v_existing > 0 THEN RAISE EXCEPTION 'PLATFORM_OWNER_ALREADY_EXISTS' USING ERRCODE = '42501', HINT = 'use grant_platform_owner'; END IF;
  INSERT INTO public.commercial_admins (user_id, granted_by, active, authority)
  VALUES (p_user_id, p_user_id, true, 'platform_owner')
  ON CONFLICT (user_id) DO UPDATE SET active = true, authority = 'platform_owner';
  INSERT INTO public.access_grant_events (recipient_user_id, grant_kind, source, allowance, actor_user_id, reason)
  VALUES (p_user_id, 'PLATFORM_OWNER_GRANT', 'BOOTSTRAP', jsonb_build_object('authority','platform_owner'), p_user_id, p_reason);
  RETURN jsonb_build_object('user_id', p_user_id, 'authority', 'platform_owner', 'bootstrap', true);
END;
$$;
REVOKE ALL ON FUNCTION public.bootstrap_first_platform_owner(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_first_platform_owner(UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.grant_platform_owner(p_user_id UUID, p_reason TEXT, p_reauth_nonce TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_actor UUID;
BEGIN
  v_actor := public._require_platform_owner_reauth(p_reauth_nonce);
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'USER_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.commercial_admins (user_id, granted_by, active, authority)
  VALUES (p_user_id, v_actor, true, 'platform_owner')
  ON CONFLICT (user_id) DO UPDATE SET active = true, authority = 'platform_owner', granted_by = v_actor;
  INSERT INTO public.access_grant_events (recipient_user_id, grant_kind, source, allowance, actor_user_id, reason)
  VALUES (p_user_id, 'PLATFORM_OWNER_GRANT', 'ADMIN', jsonb_build_object('authority','platform_owner'), v_actor, p_reason);
  RETURN jsonb_build_object('user_id', p_user_id, 'authority', 'platform_owner');
END;
$$;
REVOKE ALL ON FUNCTION public.grant_platform_owner(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grant_platform_owner(UUID, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_platform_owner(p_user_id UUID, p_reason TEXT, p_reauth_nonce TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_actor UUID; v_remaining INTEGER;
BEGIN
  v_actor := public._require_platform_owner_reauth(p_reauth_nonce);
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'USER_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  -- Last-active-owner protection: at least one active platform owner must remain.
  SELECT count(*) INTO v_remaining FROM public.commercial_admins
   WHERE active AND authority = 'platform_owner' AND user_id <> p_user_id;
  IF v_remaining = 0 THEN RAISE EXCEPTION 'LAST_PLATFORM_OWNER' USING ERRCODE = '42501', HINT = 'cannot remove the last active platform owner'; END IF;
  UPDATE public.commercial_admins SET active = false WHERE user_id = p_user_id AND authority = 'platform_owner';
  INSERT INTO public.access_grant_events (recipient_user_id, grant_kind, source, allowance, actor_user_id, reason)
  VALUES (p_user_id, 'PLATFORM_OWNER_REVOKE', 'ADMIN', jsonb_build_object('authority','platform_owner'), v_actor, p_reason);
  RETURN jsonb_build_object('user_id', p_user_id, 'revoked', true, 'remaining_owners', v_remaining);
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_platform_owner(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_platform_owner(UUID, TEXT, TEXT) TO authenticated;

-- Complimentary access to one RELEASED capability for a recipient (no payment / no revenue). Entity capacity has its own RPC.
CREATE OR REPLACE FUNCTION public.owner_grant_complimentary_access(
  p_recipient_user_id UUID, p_capability TEXT, p_reason TEXT, p_effective_end TIMESTAMPTZ, p_reauth_nonce TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_actor UUID; v_cap TEXT; v_bc UUID; v_override_id UUID;
BEGIN
  v_actor := public._require_platform_owner_reauth(p_reauth_nonce);
  IF p_recipient_user_id IS NULL THEN RAISE EXCEPTION 'USER_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  v_cap := public.commercial_canonical_capability(p_capability);
  IF v_cap IS NULL THEN RAISE EXCEPTION 'UNKNOWN_CAPABILITY' USING ERRCODE = '22023'; END IF;
  IF v_cap IN ('ENTITY_CAPACITY','NAMED_USER_SEATS') THEN RAISE EXCEPTION 'USE_ENTITY_ALLOWANCE_RPC' USING ERRCODE = '22023'; END IF;
  IF NOT public.capability_customer_available(v_cap) THEN RAISE EXCEPTION 'CAPABILITY_WITHHELD' USING ERRCODE = 'PT422'; END IF;
  v_bc := (public.admin_ensure_billing_customer(p_recipient_user_id, p_reason) ->> 'billing_customer_id')::uuid;
  INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, granted_by, reason, effective_start, effective_end)
  VALUES (v_bc, v_cap, v_actor, p_reason, now(), p_effective_end) RETURNING id INTO v_override_id;
  INSERT INTO public.access_grant_events (recipient_user_id, billing_customer_id, grant_kind, capability, source, allowance, effective_end, actor_user_id, reason)
  VALUES (p_recipient_user_id, v_bc, 'COMPLIMENTARY_CAPABILITY', v_cap, 'ADMIN_OVERRIDE', jsonb_build_object('override_id', v_override_id), p_effective_end, v_actor, p_reason);
  RETURN jsonb_build_object('override_id', v_override_id, 'capability', v_cap, 'billing_customer_id', v_bc);
END;
$$;
REVOKE ALL ON FUNCTION public.owner_grant_complimentary_access(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_grant_complimentary_access(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;

-- Entity allowance for a recipient: an explicit number OR explicit unlimited (never a sentinel). No payment / no revenue.
CREATE OR REPLACE FUNCTION public.owner_grant_entity_allowance(
  p_recipient_user_id UUID, p_capacity INTEGER, p_unlimited BOOLEAN, p_reason TEXT, p_effective_end TIMESTAMPTZ, p_reauth_nonce TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_actor UUID; v_bc UUID; v_override_id UUID;
BEGIN
  v_actor := public._require_platform_owner_reauth(p_reauth_nonce);
  IF p_recipient_user_id IS NULL THEN RAISE EXCEPTION 'USER_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF COALESCE(p_unlimited, false) THEN
    IF p_capacity IS NOT NULL THEN RAISE EXCEPTION 'UNLIMITED_EXCLUDES_NUMBER' USING ERRCODE = '22023'; END IF;
  ELSE
    IF p_capacity IS NULL OR p_capacity < 1 THEN RAISE EXCEPTION 'INVALID_CAPACITY' USING ERRCODE = '22023'; END IF;
  END IF;
  v_bc := (public.admin_ensure_billing_customer(p_recipient_user_id, p_reason) ->> 'billing_customer_id')::uuid;
  INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, capacity_value, unlimited, granted_by, reason, effective_start, effective_end)
  VALUES (v_bc, 'ENTITY_CAPACITY', CASE WHEN COALESCE(p_unlimited,false) THEN NULL ELSE p_capacity END, COALESCE(p_unlimited,false), v_actor, p_reason, now(), p_effective_end)
  RETURNING id INTO v_override_id;
  INSERT INTO public.access_grant_events (recipient_user_id, billing_customer_id, grant_kind, capability, source, allowance, effective_end, actor_user_id, reason)
  VALUES (p_recipient_user_id, v_bc, 'ENTITY_ALLOWANCE', 'ENTITY_CAPACITY', 'ADMIN_OVERRIDE',
          jsonb_build_object('override_id', v_override_id, 'capacity', p_capacity, 'unlimited', COALESCE(p_unlimited,false)), p_effective_end, v_actor, p_reason);
  RETURN jsonb_build_object('override_id', v_override_id, 'unlimited', COALESCE(p_unlimited,false), 'capacity', p_capacity, 'billing_customer_id', v_bc);
END;
$$;
REVOKE ALL ON FUNCTION public.owner_grant_entity_allowance(UUID, INTEGER, BOOLEAN, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_grant_entity_allowance(UUID, INTEGER, BOOLEAN, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;

-- Revoke any override grant. Effective server-side immediately (entitlement is resolved per request; no page refresh needed).
CREATE OR REPLACE FUNCTION public.revoke_access_grant(p_override_id UUID, p_reason TEXT, p_reauth_nonce TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_actor UUID; v_bc UUID; v_recipient UUID; v_cap TEXT;
BEGIN
  v_actor := public._require_platform_owner_reauth(p_reauth_nonce);
  IF p_override_id IS NULL THEN RAISE EXCEPTION 'OVERRIDE_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  UPDATE public.entitlement_overrides SET revoked_at = now(), revoked_by = v_actor
   WHERE id = p_override_id AND revoked_at IS NULL
   RETURNING billing_customer_id, feature_code INTO v_bc, v_cap;
  IF v_bc IS NULL THEN RAISE EXCEPTION 'OVERRIDE_NOT_FOUND_OR_ALREADY_REVOKED' USING ERRCODE = '22023'; END IF;
  SELECT owner_user_id INTO v_recipient FROM public.billing_customers WHERE id = v_bc;
  INSERT INTO public.access_grant_events (recipient_user_id, billing_customer_id, grant_kind, capability, source, allowance, actor_user_id, reason)
  VALUES (COALESCE(v_recipient, v_actor), v_bc, 'ACCESS_REVOKE', v_cap, 'ADMIN_OVERRIDE', jsonb_build_object('override_id', p_override_id), v_actor, p_reason);
  RETURN jsonb_build_object('override_id', p_override_id, 'revoked', true);
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_access_grant(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_access_grant(UUID, TEXT, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Read projections for the Access console (no new authority — read-only)
-- ─────────────────────────────────────────────────────────────────────────────

-- Role × capability template matrix (the stored authority is per-member; this is the starting template for display).
CREATE OR REPLACE FUNCTION public.get_access_matrix()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'capabilities', ARRAY['prepare_close','review_close','approve_certification','issue_reporting_pack','manage_members'],
    'roles', jsonb_build_object(
      'owner',    public._title_capability_template('owner'),
      'partner',  public._title_capability_template('partner'),
      'preparer', public._title_capability_template('preparer'),
      'viewer',   public._title_capability_template('viewer')));
$$;
GRANT EXECUTE ON FUNCTION public.get_access_matrix() TO authenticated;

-- Account overview for platform owners / commercial admins: each billing account's plan, entity usage and active overrides.
CREATE OR REPLACE FUNCTION public.get_access_overview()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_uid UUID := auth.uid(); v_rows JSONB;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = v_uid AND ca.active) THEN
    RAISE EXCEPTION 'NOT_AN_ADMIN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'owner_user_id'), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object(
      'billing_customer_id', bc.id,
      'owner_user_id', bc.owner_user_id,
      'is_platform_owner', public.is_platform_owner(bc.owner_user_id),
      'entity_capacity', public._entity_capacity_for_account(bc.owner_user_id),
      'active_overrides', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',eo.id,'feature_code',eo.feature_code,'capacity_value',eo.capacity_value,
                 'unlimited',eo.unlimited,'effective_end',eo.effective_end,'reason',eo.reason)), '[]'::jsonb)
          FROM public.entitlement_overrides eo
         WHERE eo.billing_customer_id = bc.id AND eo.revoked_at IS NULL
           AND eo.effective_start <= now() AND (eo.effective_end IS NULL OR eo.effective_end > now()))
    ) AS row FROM public.billing_customers bc
  ) t;
  RETURN jsonb_build_object('accounts', v_rows);
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_access_overview() TO authenticated;

-- Grant/revoke history. Platform owners / commercial admins see all; an ordinary user sees only grants to themselves.
CREATE OR REPLACE FUNCTION public.get_access_grant_history(p_recipient_user_id UUID DEFAULT NULL, p_limit INTEGER DEFAULT 200)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_uid UUID := auth.uid(); v_admin BOOLEAN; v_rows JSONB;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  v_admin := EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = v_uid AND ca.active);
  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC), '[]'::jsonb) INTO v_rows FROM (
    SELECT * FROM public.access_grant_events age
     WHERE (v_admin OR age.recipient_user_id = v_uid)
       AND (p_recipient_user_id IS NULL OR age.recipient_user_id = p_recipient_user_id)
     ORDER BY age.created_at DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit,200), 1000))
  ) e;
  RETURN jsonb_build_object('events', v_rows);
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_access_grant_history(UUID, INTEGER) TO authenticated;
