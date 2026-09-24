-- ════════════════════════════════════════════════════════════════════════════
-- CFO Close: global capability names, one entitlement authority, product walls and the pricing catalogue.
-- Forward-only. No historical row is deleted; no applied migration is edited.
--
-- 1. Canonical capabilities replace the internal engine vocabulary:
--      SAFISHA_CERTIFY    -> STATEMENT_CERTIFICATION  (paid)      "Close Certification"
--      HESABU_EXPORT      -> REPORTING_PACK_EXPORT    (paid)      "Reporting Pack"
--      MAONO_INTELLIGENCE -> CLOSE_INSIGHTS           (paid)      "Close Insights"
--      MULTI_PERIOD       -> COMPARATIVE_REPORTING    (included)  "Comparative Reporting" - never a paywall
--      MULTI_COMPANY      -> ENTITY_CAPACITY          (capacity)  "Entity Capacity" - a number per plan
--      SAFISHA_PREVIEW, HESABU_REPORTING -> CLOSE_ASSURANCE (included) "Close Assurance" - the always-on
--        integrity layer (preview, validation, readiness); it was never chargeable and is not now.
--    Legacy codes stay resolvable through commercial_capability_aliases (compatibility lookup).
-- 2. Plans FREE / PRACTICE / FIRM / ENTERPRISE with entity and user capacity. The legacy PAID plan
--    ("CFOClose Professional", never sold: payments were never enabled) is kept for any existing licence,
--    grandfathered with every paid capability and Firm capacity, and withdrawn from the public catalogue.
--    Its $49 / $499 offers are retired (never deleted). New USD offers are seeded non-purchasable:
--    Practice $99 / $990, Firm $299 / $2,990. Enterprise is contact-sales (no offer).
-- 3. One authority: _authorize_paid_action(user, workspace, capability) =
--      authenticated user AND workspace access (creator, accepted member or active capability grant - never an
--      occupational title) AND capability known AND the WORKSPACE's billing account is entitled.
--    An entitlement never grants workspace access; workspace access never grants a paid capability; a paid
--    user cannot carry their plan into another account's workspace.
-- 4. Walls at the database boundary (every path: client, RPC, service role):
--      Close Certification  new sign-off events on statement_sign_offs; FINAL on financial_statement_publications
--      Reporting Pack       issue_reporting_pack() is the only way to issue a formal pack (reporting_pack_issuances)
--      Close Insights       new variance runs, insights, forecasts and alerts
--      Entity Capacity      activating a workspace (insert, reactivation, re-assignment), serialised per account
--    Nothing here reads or writes accounting values, certifications, stage locks or audit evidence. Expiry or
--    downgrade only stops NEW paid actions; every existing record stays readable under its existing access rules.
-- 5. The statement sign-off gate's messages lose the internal engine name (logic unchanged).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 0. Existing-state refusal (reads only; before any DDL) ───────────────────────────────────
DO $refuse$
DECLARE
  v_product uuid;
  v_unexpected text;
BEGIN
  SELECT id INTO v_product FROM public.commercial_products WHERE code = 'CFOCLOSE';
  IF v_product IS NULL THEN
    RAISE EXCEPTION 'capability migration refused: commercial product CFOCLOSE is missing. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(code, ',') INTO v_unexpected FROM public.commercial_plans WHERE product_id = v_product AND code NOT IN ('FREE', 'PAID');
  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'capability migration refused: unexpected plan(s) % already exist (already applied, or an unreviewed catalogue). Nothing was changed.', v_unexpected USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commercial_plans WHERE product_id = v_product AND code = 'FREE') IS NOT TRUE THEN
    RAISE EXCEPTION 'capability migration refused: the FREE plan is missing. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
END
$refuse$;

SET search_path TO public, pg_catalog;

-- ── 1. Capability registry and legacy aliases ────────────────────────────────────────────────
CREATE TABLE public.commercial_capabilities (
  code          TEXT        NOT NULL,
  kind          TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  description   TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commercial_capabilities_pk PRIMARY KEY (code),
  CONSTRAINT chk_ccap_code CHECK (code ~ '^[A-Z][A-Z_]{2,63}$'),
  CONSTRAINT chk_ccap_kind CHECK (kind IN ('included', 'paid', 'capacity'))
);
ALTER TABLE public.commercial_capabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ccap_select_public" ON public.commercial_capabilities FOR SELECT USING (true);
REVOKE ALL ON public.commercial_capabilities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.commercial_capabilities TO anon, authenticated;
GRANT ALL ON public.commercial_capabilities TO service_role;

INSERT INTO public.commercial_capabilities (code, kind, display_name, description) VALUES
  ('CLOSE_ASSURANCE',         'included', 'Close Assurance',       'Always-on integrity and authorization: validations, readiness checks and statement preview.'),
  ('COMPARATIVE_REPORTING',   'included', 'Comparative Reporting', 'The prior-period comparative the reporting framework requires. Included in every plan.'),
  ('STATEMENT_CERTIFICATION', 'paid',     'Close Certification',   'Record a certified close: statement sign-offs and final report versions.'),
  ('REPORTING_PACK_EXPORT',   'paid',     'Reporting Pack',        'Issue formal deliverables: financial statement PDFs and spreadsheets, filing and client packs.'),
  ('CLOSE_INSIGHTS',          'paid',     'Close Insights',        'Advanced analysis: variance and trend interpretation, risk commentary, forecasts and recommendations.'),
  ('ENTITY_CAPACITY',         'capacity', 'Entity Capacity',       'How many active entities (workspaces) the plan includes.');

CREATE TABLE public.commercial_capability_aliases (
  legacy_code     TEXT NOT NULL,
  canonical_code  TEXT NOT NULL,
  CONSTRAINT commercial_capability_aliases_pk PRIMARY KEY (legacy_code),
  CONSTRAINT fk_ccal_canonical FOREIGN KEY (canonical_code) REFERENCES public.commercial_capabilities(code) ON DELETE RESTRICT
);
ALTER TABLE public.commercial_capability_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ccal_select_public" ON public.commercial_capability_aliases FOR SELECT USING (true);
REVOKE ALL ON public.commercial_capability_aliases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.commercial_capability_aliases TO anon, authenticated;
GRANT ALL ON public.commercial_capability_aliases TO service_role;

INSERT INTO public.commercial_capability_aliases (legacy_code, canonical_code) VALUES
  ('SAFISHA_PREVIEW',    'CLOSE_ASSURANCE'),
  ('HESABU_REPORTING',   'CLOSE_ASSURANCE'),
  ('SAFISHA_CERTIFY',    'STATEMENT_CERTIFICATION'),
  ('HESABU_EXPORT',      'REPORTING_PACK_EXPORT'),
  ('MAONO_INTELLIGENCE', 'CLOSE_INSIGHTS'),
  ('MULTI_COMPANY',      'ENTITY_CAPACITY'),
  ('MULTI_PERIOD',       'COMPARATIVE_REPORTING');

-- Canonical code for a canonical or legacy input; NULL when unknown.
CREATE OR REPLACE FUNCTION public.commercial_canonical_capability(p_code TEXT)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    (SELECT c.code FROM public.commercial_capabilities c WHERE c.code = p_code),
    (SELECT a.canonical_code FROM public.commercial_capability_aliases a WHERE a.legacy_code = p_code));
$$;

-- ── 2. Plans: canonical codes, capacities, catalogue metadata ───────────────────────────────
ALTER TABLE public.commercial_plans DROP CONSTRAINT chk_cp_feature_codes;
ALTER TABLE public.commercial_plans
  ADD COLUMN entity_capacity INTEGER NULL,
  ADD COLUMN user_capacity   INTEGER NULL,
  ADD COLUMN is_public       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN display_order   INTEGER NULL,
  ADD COLUMN sales_mode      TEXT    NOT NULL DEFAULT 'legacy';

-- Legacy codes -> canonical (deterministic, de-duplicated, sorted). Every plan also carries the always-on
-- capabilities and the capacity marker.
UPDATE public.commercial_plans cp
   SET feature_codes = (
     SELECT array_agg(DISTINCT c ORDER BY c) FROM (
       SELECT a.canonical_code AS c FROM unnest(cp.feature_codes) f JOIN public.commercial_capability_aliases a ON a.legacy_code = f
       UNION SELECT 'CLOSE_ASSURANCE' UNION SELECT 'COMPARATIVE_REPORTING' UNION SELECT 'ENTITY_CAPACITY') s);

UPDATE public.commercial_plans cp SET entity_capacity = 1, user_capacity = 1, is_public = true, display_order = 1, sales_mode = 'free'
  FROM public.commercial_products p WHERE p.id = cp.product_id AND p.code = 'CFOCLOSE' AND cp.code = 'FREE';
-- Legacy PAID: grandfathered (every paid capability, Firm capacity), no longer offered.
UPDATE public.commercial_plans cp
   SET feature_codes = ARRAY['CLOSE_ASSURANCE','CLOSE_INSIGHTS','COMPARATIVE_REPORTING','ENTITY_CAPACITY','REPORTING_PACK_EXPORT','STATEMENT_CERTIFICATION']::TEXT[],
       entity_capacity = 25, user_capacity = 10, is_public = false, display_order = NULL, sales_mode = 'legacy'
  FROM public.commercial_products p WHERE p.id = cp.product_id AND p.code = 'CFOCLOSE' AND cp.code = 'PAID';

INSERT INTO public.commercial_plans (product_id, code, name, feature_codes, entity_capacity, user_capacity, is_public, display_order, sales_mode)
SELECT p.id, v.code, v.name,
       ARRAY['CLOSE_ASSURANCE','CLOSE_INSIGHTS','COMPARATIVE_REPORTING','ENTITY_CAPACITY','REPORTING_PACK_EXPORT','STATEMENT_CERTIFICATION']::TEXT[],
       v.entities, v.users, true, v.ord, v.mode
  FROM public.commercial_products p
 CROSS JOIN (VALUES ('PRACTICE',   'Practice',   5,    3,    2, 'self_serve'),
                    ('FIRM',       'Firm',       25,   10,   3, 'self_serve'),
                    ('ENTERPRISE', 'Enterprise', NULL, NULL, 4, 'contact_sales')) AS v(code, name, entities, users, ord, mode)
 WHERE p.code = 'CFOCLOSE';

ALTER TABLE public.commercial_plans
  ADD CONSTRAINT chk_cp_feature_codes CHECK (feature_codes <@ ARRAY[
    'CLOSE_ASSURANCE','COMPARATIVE_REPORTING','STATEMENT_CERTIFICATION','REPORTING_PACK_EXPORT','CLOSE_INSIGHTS','ENTITY_CAPACITY'
  ]::TEXT[]),
  ADD CONSTRAINT chk_cp_always_on CHECK (feature_codes @> ARRAY['CLOSE_ASSURANCE','COMPARATIVE_REPORTING','ENTITY_CAPACITY']::TEXT[]),
  ADD CONSTRAINT chk_cp_code CHECK (code IN ('FREE','PRACTICE','FIRM','ENTERPRISE','PAID')),
  ADD CONSTRAINT chk_cp_entity_capacity CHECK (entity_capacity IS NULL OR entity_capacity > 0),
  ADD CONSTRAINT chk_cp_user_capacity CHECK (user_capacity IS NULL OR user_capacity > 0),
  ADD CONSTRAINT chk_cp_sales_mode CHECK (sales_mode IN ('free','self_serve','contact_sales','legacy')),
  ADD CONSTRAINT chk_cp_capacity_known CHECK (entity_capacity IS NOT NULL OR sales_mode = 'contact_sales');

-- ── 3. Overrides: canonical codes; entity capacity carries its number ───────────────────────
ALTER TABLE public.entitlement_overrides DROP CONSTRAINT chk_eo_feature_code;
ALTER TABLE public.entitlement_overrides ADD COLUMN capacity_value INTEGER NULL;
-- A legacy MULTI_COMPANY override meant "more than one company": carried as Firm capacity (25).
UPDATE public.entitlement_overrides eo
   SET capacity_value = CASE WHEN eo.feature_code = 'MULTI_COMPANY' THEN 25 END,
       feature_code = a.canonical_code
  FROM public.commercial_capability_aliases a
 WHERE a.legacy_code = eo.feature_code;
ALTER TABLE public.entitlement_overrides
  ADD CONSTRAINT chk_eo_feature_code CHECK (feature_code IN (
    'CLOSE_ASSURANCE','COMPARATIVE_REPORTING','STATEMENT_CERTIFICATION','REPORTING_PACK_EXPORT','CLOSE_INSIGHTS','ENTITY_CAPACITY')),
  ADD CONSTRAINT chk_eo_capacity CHECK (
    (feature_code = 'ENTITY_CAPACITY' AND capacity_value IS NOT NULL AND capacity_value > 0)
    OR (feature_code <> 'ENTITY_CAPACITY' AND capacity_value IS NULL));

-- ── 4. Offers: retire the $49 / $499 legacy offers; seed Practice and Firm (non-purchasable) ──
UPDATE public.commercial_offers
   SET is_active = false, is_purchasable = false, effective_end = GREATEST(now(), effective_start + interval '1 second'), updated_at = now()
 WHERE offer_code IN ('CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY', 'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_ANNUAL');

INSERT INTO public.commercial_offers (offer_code, plan_id, market_code, currency_code, amount_minor, currency_exponent, billing_interval, billing_interval_count)
SELECT v.offer_code, cp.id, 'GLOBAL', 'USD', v.amount, 2, v.billing_interval, 1
  FROM public.commercial_plans cp
  JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
  JOIN (VALUES ('PRACTICE', 'CFOCLOSE_PRACTICE_GLOBAL_USD_MONTHLY',  9900::bigint, 'MONTHLY'),
               ('PRACTICE', 'CFOCLOSE_PRACTICE_GLOBAL_USD_ANNUAL',  99000::bigint, 'ANNUAL'),
               ('FIRM',     'CFOCLOSE_FIRM_GLOBAL_USD_MONTHLY',     29900::bigint, 'MONTHLY'),
               ('FIRM',     'CFOCLOSE_FIRM_GLOBAL_USD_ANNUAL',     299000::bigint, 'ANNUAL')) AS v(plan_code, offer_code, amount, billing_interval)
    ON v.plan_code = cp.code;

-- ── 5. The entitlement resolver (supersedes 20260905093408) ─────────────────────────────────
-- For one billing account and one capability (canonical or legacy code). UNKNOWN != NOT_ENTITLED != ENTITLED.
-- Included capabilities are ENTITLED for everyone, with or without a billing record.
CREATE OR REPLACE FUNCTION public._resolve_entitlement_for_owner(p_owner_user_id UUID, p_feature_code TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cap     TEXT := public.commercial_canonical_capability(p_feature_code);
  v_kind    TEXT;
  v_bc      UUID;
  v_licence RECORD;
  v_result  JSONB;
BEGIN
  IF v_cap IS NULL THEN
    RETURN jsonb_build_object('status','UNKNOWN','reason','UNKNOWN_FEATURE_CODE','capability',NULL,'licence_status',NULL,'plan_code',NULL,'source',NULL);
  END IF;
  SELECT kind INTO v_kind FROM public.commercial_capabilities WHERE code = v_cap;
  IF v_kind = 'included' THEN
    RETURN jsonb_build_object('status','ENTITLED','reason','INCLUDED_IN_EVERY_PLAN','capability',v_cap,'licence_status',NULL,'plan_code',NULL,'source','INCLUDED');
  END IF;
  IF p_owner_user_id IS NULL THEN
    RETURN jsonb_build_object('status','UNKNOWN','reason','NO_OWNER_IDENTITY','capability',v_cap,'licence_status',NULL,'plan_code',NULL,'source',NULL);
  END IF;
  IF v_kind = 'capacity' THEN
    v_result := public._entity_capacity_for_account(p_owner_user_id);
    RETURN jsonb_build_object('status', CASE WHEN (v_result->>'determined')::boolean THEN 'ENTITLED' ELSE 'UNKNOWN' END,
      'reason', CASE WHEN (v_result->>'determined')::boolean THEN 'CAPACITY_DETERMINED' ELSE 'CAPACITY_UNDETERMINED' END,
      'capability', v_cap, 'licence_status', NULL, 'plan_code', v_result->>'plan_code', 'source', v_result->>'source',
      'capacity', v_result->'capacity');
  END IF;

  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_owner_user_id LIMIT 1;
  IF v_bc IS NULL THEN
    RETURN jsonb_build_object('status','NOT_ENTITLED','reason','NO_BILLING_CUSTOMER','capability',v_cap,'licence_status',NULL,'plan_code','FREE','source',NULL);
  END IF;

  IF EXISTS (SELECT 1 FROM public.entitlement_overrides eo
              WHERE eo.billing_customer_id = v_bc AND eo.feature_code = v_cap AND eo.revoked_at IS NULL
                AND eo.effective_start <= now() AND (eo.effective_end IS NULL OR eo.effective_end > now())) THEN
    RETURN jsonb_build_object('status','ENTITLED','reason','ADMIN_OVERRIDE_ACTIVE','capability',v_cap,'licence_status',NULL,'plan_code',NULL,'source','ADMIN_OVERRIDE');
  END IF;

  SELECT cl.status AS licence_status, cp.code AS plan_code, cp.feature_codes AS feature_codes INTO v_licence
    FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE cl.billing_customer_id = v_bc AND cl.status IN ('ACTIVE','GRACE')
     AND cl.effective_start <= now() AND (cl.effective_end IS NULL OR cl.effective_end > now())
   ORDER BY cl.effective_start DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','NOT_ENTITLED','reason','NO_CURRENT_LICENCE_PERIOD','capability',v_cap,'licence_status',NULL,'plan_code','FREE','source',NULL);
  END IF;
  IF v_licence.plan_code NOT IN ('FREE','PRACTICE','FIRM','ENTERPRISE','PAID') THEN
    RETURN jsonb_build_object('status','NOT_ENTITLED','reason','UNKNOWN_PLAN','capability',v_cap,'licence_status',v_licence.licence_status,'plan_code',NULL,'source',NULL);
  END IF;
  IF v_licence.feature_codes @> ARRAY[v_cap]::TEXT[] THEN
    RETURN jsonb_build_object('status','ENTITLED','reason','ACTIVE_LICENCE_INCLUDES_FEATURE','capability',v_cap,'licence_status',v_licence.licence_status,'plan_code',v_licence.plan_code,'source','ACTIVE_LICENCE');
  END IF;
  RETURN jsonb_build_object('status','NOT_ENTITLED','reason','PLAN_DOES_NOT_INCLUDE_FEATURE','capability',v_cap,'licence_status',v_licence.licence_status,'plan_code',v_licence.plan_code,'source',NULL);
END;
$$;

-- Entity capacity of one billing account: the current plan's capacity (Free when there is no current licence),
-- raised by an active ENTITY_CAPACITY override. determined = false (and creation refused) when neither a plan
-- number nor an override exists (e.g. an Enterprise licence whose contract capacity was never recorded).
CREATE OR REPLACE FUNCTION public._entity_capacity_for_account(p_account UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_bc        UUID;
  v_plan_code TEXT := 'FREE';
  v_plan_cap  INTEGER;
  v_override  INTEGER;
  v_source    TEXT := 'FREE_PLAN';
BEGIN
  SELECT cp.entity_capacity INTO v_plan_cap
    FROM public.commercial_plans cp JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
   WHERE cp.code = 'FREE';
  IF p_account IS NOT NULL THEN
    SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_account LIMIT 1;
  END IF;
  IF v_bc IS NOT NULL THEN
    SELECT cp.code, cp.entity_capacity INTO v_plan_code, v_plan_cap
      FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
     WHERE cl.billing_customer_id = v_bc AND cl.status IN ('ACTIVE','GRACE')
       AND cl.effective_start <= now() AND (cl.effective_end IS NULL OR cl.effective_end > now())
     ORDER BY cl.effective_start DESC LIMIT 1;
    IF FOUND THEN
      v_source := 'ACTIVE_LICENCE';
    ELSE
      v_plan_code := 'FREE';
      SELECT cp.entity_capacity INTO v_plan_cap
        FROM public.commercial_plans cp JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
       WHERE cp.code = 'FREE';
    END IF;
    SELECT max(eo.capacity_value) INTO v_override FROM public.entitlement_overrides eo
     WHERE eo.billing_customer_id = v_bc AND eo.feature_code = 'ENTITY_CAPACITY' AND eo.revoked_at IS NULL
       AND eo.effective_start <= now() AND (eo.effective_end IS NULL OR eo.effective_end > now());
    IF v_override IS NOT NULL AND v_override > COALESCE(v_plan_cap, 0) THEN
      v_plan_cap := v_override; v_source := 'ADMIN_OVERRIDE';
    END IF;
  END IF;
  RETURN jsonb_build_object('capacity', v_plan_cap, 'determined', v_plan_cap IS NOT NULL, 'plan_code', v_plan_code, 'source', v_source);
END;
$$;

-- ── 6. Workspace access and THE paid-action authority ───────────────────────────────────────
-- How a user reaches a workspace: the account that created it, an accepted membership, or an active explicit
-- capability grant. A membership's occupational label is never read.
CREATE OR REPLACE FUNCTION public._workspace_access_basis(p_user UUID, p_company_id UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_user IS NULL OR p_company_id IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id AND c.user_id = p_user) THEN 'workspace_creator'
    WHEN EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.company_id = p_company_id AND fm.user_id = p_user AND fm.accepted_at IS NOT NULL) THEN 'accepted_member'
    WHEN EXISTS (SELECT 1 FROM public.workspace_capability_grants g WHERE g.company_id = p_company_id AND g.grantee_user_id = p_user AND g.revoked_at IS NULL) THEN 'capability_grant'
  END;
$$;

-- AUTHORIZED = authenticated user AND workspace access AND known capability AND the workspace's billing account is
-- entitled. Every failure denies with a stable code. Operation-specific invariants (lifecycle state, validation
-- gates, stage locks) remain the job of the operation itself and are never relaxed by this.
CREATE OR REPLACE FUNCTION public._authorize_paid_action(p_user UUID, p_company_id UUID, p_capability TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cap     TEXT := public.commercial_canonical_capability(p_capability);
  v_kind    TEXT;
  v_account UUID;
  v_ent     JSONB;
BEGIN
  IF p_user IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'UNAUTHENTICATED', 'capability', v_cap);
  END IF;
  IF v_cap IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'UNKNOWN_CAPABILITY', 'capability', NULL);
  END IF;
  SELECT kind INTO v_kind FROM public.commercial_capabilities WHERE code = v_cap;
  IF v_kind = 'capacity' THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'NOT_AN_ACTION', 'capability', v_cap);
  END IF;
  IF public._workspace_access_basis(p_user, p_company_id) IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'code', 'WORKSPACE_ACCESS_DENIED', 'capability', v_cap);
  END IF;
  IF v_kind = 'included' THEN
    RETURN jsonb_build_object('allowed', true, 'code', 'ALLOWED', 'capability', v_cap, 'source', 'INCLUDED');
  END IF;
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
  v_ent := public._resolve_entitlement_for_owner(v_account, v_cap);
  IF v_ent->>'status' = 'ENTITLED' THEN
    RETURN jsonb_build_object('allowed', true, 'code', 'ALLOWED', 'capability', v_cap, 'plan_code', v_ent->>'plan_code', 'source', v_ent->>'source');
  END IF;
  RETURN jsonb_build_object('allowed', false, 'code', 'ENTITLEMENT_REQUIRED', 'capability', v_cap,
    'plan_code', v_ent->>'plan_code', 'required_plan', 'PRACTICE', 'reason', v_ent->>'reason');
END;
$$;

-- For the signed-in user (authenticated). Explanatory for the UI and callable by clients; never trusted alone.
CREATE OR REPLACE FUNCTION public.authorize_paid_action(p_company_id UUID, p_capability TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public._authorize_paid_action(auth.uid(), p_company_id, p_capability);
$$;

-- For Edge Functions (service_role), which pass the user id they derived from the verified JWT.
CREATE OR REPLACE FUNCTION public.authorize_paid_action_for_user(p_user UUID, p_company_id UUID, p_capability TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public._authorize_paid_action(p_user, p_company_id, p_capability);
$$;

-- For scheduled, system-initiated work with no user (service_role): is this workspace's account entitled?
CREATE OR REPLACE FUNCTION public.workspace_capability_entitled(p_company_id UUID, p_capability TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((public._resolve_entitlement_for_owner(
    (SELECT c.user_id FROM public.companies c WHERE c.id = p_company_id), p_capability))->>'status' = 'ENTITLED', false);
$$;

-- The database-mutation wall used by triggers: the workspace's account must hold the capability. Raises SQLSTATE
-- PT402 (HTTP 402 through PostgREST) with the capability code as the structured DETAIL.
CREATE OR REPLACE FUNCTION public._require_workspace_capability(p_company_id UUID, p_capability TEXT)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.workspace_capability_entitled(p_company_id, p_capability) THEN
    RAISE EXCEPTION 'ENTITLEMENT_REQUIRED'
      USING ERRCODE = 'PT402', DETAIL = public.commercial_canonical_capability(p_capability), HINT = 'PRACTICE';
  END IF;
END;
$$;

-- What the signed-in user may see about a workspace's commercial state (explanatory only).
CREATE OR REPLACE FUNCTION public.get_workspace_commercial_state(p_company_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user    UUID := auth.uid();
  v_basis   TEXT := public._workspace_access_basis(auth.uid(), p_company_id);
  v_caps    JSONB := '{}'::jsonb;
  r         RECORD;
  v_account UUID;
BEGIN
  IF v_user IS NULL OR v_basis IS NULL THEN
    RETURN jsonb_build_object('access', false);
  END IF;
  FOR r IN SELECT code FROM public.commercial_capabilities WHERE kind IN ('paid', 'included') ORDER BY code LOOP
    v_caps := v_caps || jsonb_build_object(r.code, public._authorize_paid_action(v_user, p_company_id, r.code) - 'reason');
  END LOOP;
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
  RETURN jsonb_build_object('access', true,
    'plan_code', COALESCE(public._entity_capacity_for_account(v_account)->>'plan_code', 'FREE'),
    'capabilities', v_caps);
END;
$$;

-- ── 7. Close Certification wall ──────────────────────────────────────────────────────────────
-- A NEW sign-off event (a tier newly signed, or the status newly advanced beyond draft) needs the capability.
-- Drafts, reads and existing sign-offs are untouched.
CREATE OR REPLACE FUNCTION public.statement_sign_off_certification_wall()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND (NEW.preparer_signed_at IS NOT NULL OR NEW.reviewer_signed_at IS NOT NULL
                            OR NEW.approver_signed_at IS NOT NULL OR NEW.status <> 'draft'))
     OR (TG_OP = 'UPDATE' AND ((OLD.preparer_signed_at IS NULL AND NEW.preparer_signed_at IS NOT NULL)
                            OR (OLD.reviewer_signed_at IS NULL AND NEW.reviewer_signed_at IS NOT NULL)
                            OR (OLD.approver_signed_at IS NULL AND NEW.approver_signed_at IS NOT NULL)
                            OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'draft'))) THEN
    PERFORM public._require_workspace_capability(NEW.company_id, 'STATEMENT_CERTIFICATION');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sso_statement_certification_wall ON public.statement_sign_offs;
CREATE TRIGGER trg_sso_statement_certification_wall
  BEFORE INSERT OR UPDATE ON public.statement_sign_offs
  FOR EACH ROW EXECUTE FUNCTION public.statement_sign_off_certification_wall();

-- A report version newly marked FINAL is a certified close.
CREATE OR REPLACE FUNCTION public.financial_statement_final_certification_wall()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state = 'FINAL' THEN
    PERFORM public._require_workspace_capability(NEW.company_id, 'STATEMENT_CERTIFICATION');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_fsp_statement_certification_wall ON public.financial_statement_publications;
CREATE TRIGGER trg_fsp_statement_certification_wall
  BEFORE INSERT ON public.financial_statement_publications
  FOR EACH ROW EXECUTE FUNCTION public.financial_statement_final_certification_wall();

-- ── 8. Close Insights wall ───────────────────────────────────────────────────────────────────
-- Every Close Insights table carries its workspace (company_id NOT NULL).
CREATE OR REPLACE FUNCTION public.close_insights_wall()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public._require_workspace_capability(NEW.company_id, 'CLOSE_INSIGHTS');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_close_insights_wall ON public.variance_runs;
CREATE TRIGGER trg_close_insights_wall BEFORE INSERT ON public.variance_runs FOR EACH ROW EXECUTE FUNCTION public.close_insights_wall();
DROP TRIGGER IF EXISTS trg_close_insights_wall ON public.maono_insights;
CREATE TRIGGER trg_close_insights_wall BEFORE INSERT ON public.maono_insights FOR EACH ROW EXECUTE FUNCTION public.close_insights_wall();
DROP TRIGGER IF EXISTS trg_close_insights_wall ON public.cashflow_forecasts;
CREATE TRIGGER trg_close_insights_wall BEFORE INSERT ON public.cashflow_forecasts FOR EACH ROW EXECUTE FUNCTION public.close_insights_wall();
DROP TRIGGER IF EXISTS trg_close_insights_wall ON public.variance_alerts;
CREATE TRIGGER trg_close_insights_wall BEFORE INSERT ON public.variance_alerts FOR EACH ROW EXECUTE FUNCTION public.close_insights_wall();

-- ── 9. Reporting Pack wall ───────────────────────────────────────────────────────────────────
CREATE TABLE public.reporting_pack_issuances (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL,
  period_year INTEGER     NOT NULL,
  pack_kind   TEXT        NOT NULL,
  request_id  UUID        NOT NULL,
  issued_by   UUID        NOT NULL,
  plan_code   TEXT        NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reporting_pack_issuances_pk PRIMARY KEY (id),
  CONSTRAINT fk_rpi_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT chk_rpi_period CHECK (period_year BETWEEN 2000 AND 2100),
  CONSTRAINT chk_rpi_kind CHECK (pack_kind IN ('financial_statements_pdf', 'financial_statements_spreadsheet', 'filing_pack', 'client_pack', 'board_pack', 'management_letter')),
  CONSTRAINT uq_rpi_request UNIQUE (company_id, issued_by, request_id)
);
CREATE INDEX idx_rpi_company_period ON public.reporting_pack_issuances (company_id, period_year, issued_at DESC);
ALTER TABLE public.reporting_pack_issuances ENABLE ROW LEVEL SECURITY;

-- Workspace-scoped read for the signed-in user; used by RLS, so the querying role executes it (it only ever
-- answers for auth.uid()).
CREATE OR REPLACE FUNCTION public.can_access_workspace(p_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public._workspace_access_basis(auth.uid(), p_company_id) IS NOT NULL;
$$;
CREATE POLICY "rpi_select_workspace" ON public.reporting_pack_issuances FOR SELECT USING (public.can_access_workspace(company_id));
REVOKE ALL ON public.reporting_pack_issuances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reporting_pack_issuances TO authenticated;
GRANT SELECT ON public.reporting_pack_issuances TO service_role;

CREATE OR REPLACE FUNCTION public.reporting_pack_issuances_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: reporting_pack_issuances is append-only (% refused).', TG_OP USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER trg_rpi_immutable BEFORE UPDATE OR DELETE ON public.reporting_pack_issuances
  FOR EACH ROW EXECUTE FUNCTION public.reporting_pack_issuances_immutable();

-- The only way to issue a formal Reporting Pack. Idempotent per (workspace, user, request id).
-- Outcomes: issued | already_issued | entitlement_required | workspace_access_denied | unauthenticated | invalid_request
CREATE OR REPLACE FUNCTION public.issue_reporting_pack(p_company_id UUID, p_period_year INTEGER, p_pack_kind TEXT, p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user  UUID := auth.uid();
  v_auth  JSONB;
  v_id    UUID;
BEGIN
  IF p_request_id IS NULL OR p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100
     OR p_pack_kind IS NULL OR p_pack_kind NOT IN ('financial_statements_pdf', 'financial_statements_spreadsheet', 'filing_pack', 'client_pack', 'board_pack', 'management_letter') THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  v_auth := public._authorize_paid_action(v_user, p_company_id, 'REPORTING_PACK_EXPORT');
  IF NOT (v_auth->>'allowed')::boolean THEN
    RETURN jsonb_build_object('outcome', lower(v_auth->>'code'), 'capability', 'REPORTING_PACK_EXPORT', 'required_plan', v_auth->>'required_plan');
  END IF;
  SELECT id INTO v_id FROM public.reporting_pack_issuances WHERE company_id = p_company_id AND issued_by = v_user AND request_id = p_request_id;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_issued', 'issuance_id', v_id);
  END IF;
  BEGIN
    INSERT INTO public.reporting_pack_issuances (company_id, period_year, pack_kind, request_id, issued_by, plan_code)
    VALUES (p_company_id, p_period_year, p_pack_kind, p_request_id, v_user, v_auth->>'plan_code')
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_id FROM public.reporting_pack_issuances WHERE company_id = p_company_id AND issued_by = v_user AND request_id = p_request_id;
    RETURN jsonb_build_object('outcome', 'already_issued', 'issuance_id', v_id);
  END;
  RETURN jsonb_build_object('outcome', 'issued', 'issuance_id', v_id);
END;
$$;

-- ── 10. Entity Capacity wall ─────────────────────────────────────────────────────────────────
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS creation_request_id UUID NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_creation_request
  ON public.companies (user_id, creation_request_id) WHERE creation_request_id IS NOT NULL;

-- Activating a workspace (insert, reactivation, or moving it to another account) counts against that account's
-- capacity. Serialised per account with a transaction-scoped advisory lock, so simultaneous requests cannot
-- exceed it. Deactivation, renaming and every other change are never blocked; nothing is ever hidden or removed.
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
  SELECT count(*) INTO v_used FROM public.companies c
   WHERE c.user_id = NEW.user_id AND COALESCE(c.is_active, true) AND c.id <> NEW.id;
  IF v_used >= (v_cap->>'capacity')::integer THEN
    RAISE EXCEPTION 'ENTITY_CAPACITY_REACHED' USING ERRCODE = 'PT402', DETAIL = 'ENTITY_CAPACITY', HINT = v_cap->>'plan_code';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_companies_entity_capacity ON public.companies;
CREATE TRIGGER trg_companies_entity_capacity
  BEFORE INSERT OR UPDATE OF is_active, user_id ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.company_entity_capacity_wall();

-- Capacity of the signed-in user's own account.
CREATE OR REPLACE FUNCTION public.get_my_entity_capacity()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user UUID := auth.uid();
  v_cap  JSONB;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('determined', false, 'code', 'UNAUTHENTICATED');
  END IF;
  v_cap := public._entity_capacity_for_account(v_user);
  RETURN v_cap || jsonb_build_object('used',
    (SELECT count(*) FROM public.companies c WHERE c.user_id = v_user AND COALESCE(c.is_active, true)));
END;
$$;

-- Creates a workspace for the signed-in user. Idempotent per request id: a retry returns the same workspace.
-- Runs as the caller (RLS and every trigger apply). Outcomes: created | already_created | capacity_reached |
-- capacity_undetermined | unauthenticated | invalid_request
CREATE OR REPLACE FUNCTION public.create_entity(
  p_request_id UUID, p_name TEXT, p_fiscal_year_end DATE, p_currency TEXT, p_reporting_framework TEXT,
  p_code TEXT DEFAULT NULL, p_tin TEXT DEFAULT NULL, p_description TEXT DEFAULT NULL, p_industry TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user UUID := auth.uid();
  v_id   UUID;
  v_cap  JSONB;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;
  IF p_request_id IS NULL OR p_name IS NULL OR btrim(p_name) = '' THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  SELECT c.id INTO v_id FROM public.companies c WHERE c.user_id = v_user AND c.creation_request_id = p_request_id;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_created', 'company_id', v_id);
  END IF;
  BEGIN
    INSERT INTO public.companies (name, fiscal_year_end, currency, reporting_framework, code, tin, description, industry, user_id, creation_request_id)
    VALUES (btrim(p_name), p_fiscal_year_end, p_currency, p_reporting_framework, NULLIF(btrim(p_code), ''), NULLIF(btrim(p_tin), ''),
            NULLIF(p_description, ''), NULLIF(p_industry, ''), v_user, p_request_id)
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT c.id INTO v_id FROM public.companies c WHERE c.user_id = v_user AND c.creation_request_id = p_request_id;
      IF v_id IS NULL THEN RAISE; END IF;
      RETURN jsonb_build_object('outcome', 'already_created', 'company_id', v_id);
    WHEN SQLSTATE 'PT402' THEN
      v_cap := public.get_my_entity_capacity();
      RETURN jsonb_build_object('outcome', CASE WHEN (v_cap->>'determined')::boolean THEN 'capacity_reached' ELSE 'capacity_undetermined' END,
        'capability', 'ENTITY_CAPACITY', 'capacity', v_cap->'capacity', 'used', v_cap->'used', 'plan_code', v_cap->>'plan_code');
  END;
  RETURN jsonb_build_object('outcome', 'created', 'company_id', v_id);
END;
$$;

-- ── 11. Admin overrides: canonical codes; capacity through its own audited RPC ───────────────
CREATE OR REPLACE FUNCTION public.admin_grant_entitlement_override(
  p_billing_customer_id UUID, p_feature_code TEXT, p_reason TEXT, p_effective_end TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_override_id UUID;
  v_cap         TEXT := public.commercial_canonical_capability(p_feature_code);
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF v_cap IS NULL THEN RAISE EXCEPTION 'UNKNOWN_FEATURE_CODE: %', p_feature_code USING ERRCODE = '22023'; END IF;
  IF v_cap = 'ENTITY_CAPACITY' THEN RAISE EXCEPTION 'USE_ADMIN_GRANT_ENTITY_CAPACITY_OVERRIDE' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.billing_customers WHERE id = p_billing_customer_id) THEN
    RAISE EXCEPTION 'BILLING_CUSTOMER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, granted_by, reason, effective_start, effective_end)
  VALUES (p_billing_customer_id, v_cap, v_user_id, p_reason, now(), p_effective_end) RETURNING id INTO v_override_id;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (p_billing_customer_id, v_user_id, 'ENTITLEMENT_OVERRIDE_GRANTED', NULL,
          jsonb_build_object('override_id', v_override_id, 'feature_code', v_cap, 'effective_end', p_effective_end), p_reason);
  RETURN jsonb_build_object('override_id', v_override_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_grant_entity_capacity_override(
  p_billing_customer_id UUID, p_capacity INTEGER, p_reason TEXT, p_effective_end TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_override_id UUID;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_capacity IS NULL OR p_capacity < 1 THEN RAISE EXCEPTION 'INVALID_CAPACITY' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.billing_customers WHERE id = p_billing_customer_id) THEN
    RAISE EXCEPTION 'BILLING_CUSTOMER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, capacity_value, granted_by, reason, effective_start, effective_end)
  VALUES (p_billing_customer_id, 'ENTITY_CAPACITY', p_capacity, v_user_id, p_reason, now(), p_effective_end) RETURNING id INTO v_override_id;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (p_billing_customer_id, v_user_id, 'ENTITLEMENT_OVERRIDE_GRANTED', NULL,
          jsonb_build_object('override_id', v_override_id, 'feature_code', 'ENTITY_CAPACITY', 'capacity', p_capacity, 'effective_end', p_effective_end), p_reason);
  RETURN jsonb_build_object('override_id', v_override_id);
END;
$$;

-- get_effective_entitlement (Ω1 signature kept): access now follows the same neutral workspace basis.
CREATE OR REPLACE FUNCTION public.get_effective_entitlement(p_company_id UUID, p_feature_code TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_account UUID;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = v_user_id AND ca.active)
     AND public._workspace_access_basis(v_user_id, p_company_id) IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER_OF_COMPANY' USING ERRCODE = '42501';
  END IF;
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
  IF v_account IS NULL THEN
    RETURN jsonb_build_object('status','UNKNOWN','reason','COMPANY_NOT_FOUND','licence_status',NULL,'plan_code',NULL,'source',NULL);
  END IF;
  RETURN public._resolve_entitlement_for_owner(v_account, p_feature_code);
END;
$$;

-- ── 12. Sign-off gate: neutral wording, identical logic (supersedes 20260713090437) ──────────
CREATE OR REPLACE FUNCTION public.hesabu_block_signoff()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_upload_id  UUID;
  v_pass_count INTEGER;
  v_fail_run   hesabu_validations%ROWTYPE;
BEGIN
  IF NEW.preparer_signed_at IS NULL THEN
    RETURN NEW;
  END IF;
  v_upload_id := NEW.upload_id;
  SELECT COUNT(*) INTO v_pass_count FROM public.hesabu_validations WHERE upload_id = v_upload_id AND gate_satisfied = TRUE;
  IF v_pass_count = 0 THEN
    SELECT * INTO v_fail_run FROM public.hesabu_validations WHERE upload_id = v_upload_id ORDER BY validated_at DESC LIMIT 1;
    IF v_fail_run.id IS NULL THEN
      RAISE EXCEPTION
        'IRON DOME — STATEMENT VALIDATION GATE: Financial statements have not been validated. '
        'Run statement validation before signing off. Upload: %', v_upload_id
        USING ERRCODE = 'restrict_violation';
    ELSE
      RAISE EXCEPTION
        'IRON DOME — STATEMENT VALIDATION GATE: Last validation run (%) has status=%. '
        '% assertion(s) failed. Resolve all failures and rerun validation before signing off. '
        'Upload: %',
        v_fail_run.id, v_fail_run.status, v_fail_run.assertions_failed, v_upload_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 13. Privileges ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.commercial_canonical_capability(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._resolve_entitlement_for_owner(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._entity_capacity_for_account(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._workspace_access_basis(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._authorize_paid_action(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._require_workspace_capability(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.statement_sign_off_certification_wall() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.financial_statement_final_certification_wall() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.close_insights_wall() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_entity_capacity_wall() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reporting_pack_issuances_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.authorize_paid_action_for_user(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workspace_capability_entitled(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_paid_action_for_user(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.workspace_capability_entitled(UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.authorize_paid_action(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_paid_action(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.get_workspace_commercial_state(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_workspace_commercial_state(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.can_access_workspace(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_workspace(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.issue_reporting_pack(UUID, INTEGER, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_reporting_pack(UUID, INTEGER, TEXT, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.get_my_entity_capacity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_entity_capacity() TO authenticated;
REVOKE ALL ON FUNCTION public.create_entity(UUID, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_entity(UUID, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_grant_entitlement_override(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_entitlement_override(UUID, TEXT, TEXT, TIMESTAMPTZ) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_grant_entity_capacity_override(UUID, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_entity_capacity_override(UUID, INTEGER, TEXT, TIMESTAMPTZ) TO authenticated;
REVOKE ALL ON FUNCTION public.get_effective_entitlement(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_effective_entitlement(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.hesabu_block_signoff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hesabu_block_signoff() TO authenticated;

-- ── 14. Deterministic catalogue proof (the migration fails if the state is not exactly this) ──
DO $assert$
DECLARE
  v RECORD;
BEGIN
  FOR v IN SELECT * FROM (VALUES
      ('FREE',       1,    1,    'free',          false),
      ('PRACTICE',   5,    3,    'self_serve',    true),
      ('FIRM',       25,   10,   'self_serve',    true),
      ('ENTERPRISE', NULL, NULL, 'contact_sales', true)) AS e(code, entities, users, mode, paid) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.commercial_plans cp JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
       WHERE cp.code = v.code AND cp.entity_capacity IS NOT DISTINCT FROM v.entities AND cp.user_capacity IS NOT DISTINCT FROM v.users
         AND cp.sales_mode = v.mode AND cp.is_public
         AND (cp.feature_codes @> ARRAY['STATEMENT_CERTIFICATION','REPORTING_PACK_EXPORT','CLOSE_INSIGHTS']::TEXT[]) = v.paid
         AND cp.feature_codes @> ARRAY['CLOSE_ASSURANCE','COMPARATIVE_REPORTING','ENTITY_CAPACITY']::TEXT[]) THEN
      RAISE EXCEPTION 'CATALOGUE_ASSERTION_FAILED: plan %', v.code;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.commercial_offers o JOIN public.commercial_plans cp ON cp.id = o.plan_id
       WHERE o.is_active AND o.currency_code = 'USD' AND o.market_code = 'GLOBAL'
         AND ((cp.code, o.billing_interval, o.amount_minor) IN (('PRACTICE','MONTHLY',9900), ('PRACTICE','ANNUAL',99000), ('FIRM','MONTHLY',29900), ('FIRM','ANNUAL',299000))))
     <> 4 THEN
    RAISE EXCEPTION 'CATALOGUE_ASSERTION_FAILED: offers';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commercial_offers o WHERE o.is_active AND o.amount_minor IN (4900, 49900)) THEN
    RAISE EXCEPTION 'CATALOGUE_ASSERTION_FAILED: a $49 / $499 offer is still active';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commercial_offers o JOIN public.commercial_plans cp ON cp.id = o.plan_id WHERE cp.code = 'ENTERPRISE') THEN
    RAISE EXCEPTION 'CATALOGUE_ASSERTION_FAILED: Enterprise must be contact-sales (no offer)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.entitlement_overrides WHERE feature_code NOT IN (SELECT code FROM public.commercial_capabilities)) THEN
    RAISE EXCEPTION 'CATALOGUE_ASSERTION_FAILED: a non-canonical override remains';
  END IF;
END
$assert$;

-- ── Rollback (NOT executed; for reference only; review before use) ──────────────────────────
-- Drop the walls (trg_sso_statement_certification_wall, trg_fsp_statement_certification_wall, trg_close_insights_wall
-- on four tables, trg_companies_entity_capacity), issue_reporting_pack / create_entity / the authority functions and
-- the two new tables; restore the 20260905093408 resolver and override CHECKs (mapping canonical codes back through
-- commercial_capability_aliases), the 20260713090437 sign-off gate, and re-activate the retired offers only after a
-- product decision. Plans and offers added here are data: deactivate, never delete, once referenced.
