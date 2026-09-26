-- ════════════════════════════════════════════════════════════════════════════
-- CFO Close: no permanent free plan; Solo; one plan / feature matrix.
-- Forward-only. No customer row is deleted; no applied migration is edited.
--
-- 1. The permanent Free plan is RETIRED (kept for history, never offered, never provisioned, confers nothing).
--    Every open FREE licence is ended (status EXPIRED, effective_end = now), one audited event each. Nothing else is
--    touched: entities, members, uploads, statements, sign-offs, certifications and outputs stay exactly as they are
--    and stay readable. There is no trial.
-- 2. Solo is added: $49 / month or $490 / year, 1 active entity, 1 named user, no additional seats.
--    Canonical public plans: Solo, Practice ($99 / $990, 5 entities), Firm ($299 / $2,990, 25 entities), Enterprise
--    (negotiated). Practice and Firm keep additional named users at $20 / month or $200 / year each.
-- 3. An account WITHOUT a current plan (no licence, an ended licence or the retired Free plan) holds nothing: no
--    capability (Close Assurance and Comparative Reporting are included in every plan, not free), entity capacity 0
--    (existing entities are kept and readable; none can be added or reactivated) and one named user: the account
--    holder. The same holds after a paid plan expires.
-- 4. commercial_plan_features is the ONE plan x capability matrix. The resolver reads it; the pricing page mirrors it
--    (src/lib/commercial/pricingCatalogue.ts, held in lockstep by pricingCatalogue.test.ts). A plan or capability
--    that is unknown, or missing from the matrix, is NOT entitled (fail closed).
-- 5. reporting_pack_kind_features binds every official output format to the capability it needs (clean PDF, Excel,
--    filing packs, management letters); enforced by issue_reporting_pack / consume in 20260925140000.
-- Nothing here reads or writes accounting values, certification verdicts or stage locks.
-- ════════════════════════════════════════════════════════════════════════════

-- The matching approval for the Free retirement, or NULL. With no open Free licence nothing needs approving and the
-- answer is the sentinel all-zero id. (Defined first: the refusal below and the retirement statement both use it.)
--
-- ATOMIC ENVELOPE (security correction B-3): every statement below runs inside this ONE DO statement. Whatever the
-- runner does (statement by statement, whole file, with or without a transaction, continuing after errors) the
-- migration either applies completely or changes nothing.
DO $cfoclose_retirement$
BEGIN
  EXECUTE $mretirementaaa$
CREATE OR REPLACE FUNCTION public._free_retirement_approval_id()
RETURNS UUID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_inv JSONB := public._free_plan_inventory();
  v_id  UUID;
BEGIN
  IF (v_inv->>'open_free_licences')::integer = 0 THEN RETURN '00000000-0000-0000-0000-000000000000'::uuid; END IF;
  SELECT a.id INTO v_id FROM public.deployment_approvals a
   WHERE a.purpose = 'FREE_PLAN_RETIREMENT' AND a.consumed_at IS NULL AND a.expires_at > clock_timestamp()
     AND a.environment_fingerprint = public._environment_fingerprint()
     AND a.evidence->>'inventory_digest' = v_inv->>'inventory_digest'
     AND (a.evidence->>'open_free_licences')::integer = (v_inv->>'open_free_licences')::integer
   ORDER BY a.approved_at DESC LIMIT 1;
  RETURN v_id;
END;
$$
$mretirementaaa$;

  EXECUTE $mretirementaab$
-- Consumes the approval (single use) or raises; called INSIDE the retirement statement, so no runner can end a Free
-- licence without it, whatever it does with errors or transactions.
CREATE OR REPLACE FUNCTION public._consume_free_retirement_approval(p_by TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_id UUID := public._free_retirement_approval_id();
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'production interlock: no matching Free-retirement approval for this environment' USING ERRCODE = '55000';
  END IF;
  IF v_id <> '00000000-0000-0000-0000-000000000000'::uuid THEN
    UPDATE public.deployment_approvals SET consumed_at = clock_timestamp(), consumed_by = p_by WHERE id = v_id AND consumed_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'production interlock: the approval was consumed concurrently' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN true;
END;
$$
$mretirementaab$;

  EXECUTE $mretirementaac$
REVOKE ALL ON FUNCTION public._free_retirement_approval_id() FROM PUBLIC, anon, authenticated
$mretirementaac$;

  EXECUTE $mretirementaad$
REVOKE ALL ON FUNCTION public._consume_free_retirement_approval(TEXT) FROM PUBLIC, anon, authenticated
$mretirementaad$;

  EXECUTE $mretirementaae$
DO $refuse$
BEGIN
  IF to_regclass('public.deployment_approvals') IS NULL THEN
    RAISE EXCEPTION 'plan catalogue migration refused: 20260925120000 (deployment approvals) is not applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.reporting_pack_issuance_events') IS NULL THEN
    RAISE EXCEPTION 'plan catalogue migration refused: 20260925120000 is not applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.commercial_plan_features') IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.commercial_plans WHERE code = 'SOLO') THEN
    RAISE EXCEPTION 'plan catalogue migration refused: already applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_plans cp JOIN public.commercial_products p ON p.id = cp.product_id
                  WHERE p.code = 'CFOCLOSE' AND cp.code = 'FREE') THEN
    RAISE EXCEPTION 'plan catalogue migration refused: the FREE plan is missing. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
  -- PRODUCTION DEPLOYMENT INTERLOCK (early, friendly refusal; the binding check is inside the retirement statement).
  -- Over open Free licences this migration needs a recorded, unexpired, unconsumed FREE_PLAN_RETIREMENT approval for
  -- THIS environment whose inventory matches the licences it would end (admin_record_deployment_approval, 20260925120000).
  IF public._free_retirement_approval_id() IS NULL THEN
    RAISE EXCEPTION 'plan catalogue migration refused (production interlock): open Free licences exist and no matching Free-retirement approval is recorded for this environment. Nothing was changed.'
      USING ERRCODE = '55000', HINT = 'See docs/release/PR34_STAGING_DEPLOYMENT_PLAN.md, Production deployment interlock.';
  END IF;
END
$refuse$
$mretirementaae$;

  EXECUTE $mretirementaaf$
SET search_path TO public, pg_catalog
$mretirementaaf$;

  EXECUTE $mretirementaag$
-- ── 1. Capability vocabulary: plan features ─────────────────────────────────────────────────
ALTER TABLE public.commercial_capabilities DROP CONSTRAINT chk_ccap_kind
$mretirementaag$;

  EXECUTE $mretirementaah$
ALTER TABLE public.commercial_capabilities ADD CONSTRAINT chk_ccap_kind CHECK (kind IN ('included', 'paid', 'capacity', 'feature'))
$mretirementaah$;

  EXECUTE $mretirementaai$
UPDATE public.commercial_capabilities SET description = 'Integrity checks: validations, readiness checks and statement preview. Included in every plan.' WHERE code = 'CLOSE_ASSURANCE'
$mretirementaai$;

  EXECUTE $mretirementaaj$
UPDATE public.commercial_capabilities SET description = 'The prior-period comparative the reporting framework requires. Included in every plan, never charged separately.' WHERE code = 'COMPARATIVE_REPORTING'
$mretirementaaj$;

  EXECUTE $mretirementaak$
UPDATE public.commercial_capabilities SET description = 'How many people may use the account, each with their own sign-in: one included in every plan, plus additional seats purchased on Practice and Firm.' WHERE code = 'NAMED_USER_SEATS'
$mretirementaak$;

  EXECUTE $mretirementaal$
INSERT INTO public.commercial_capabilities (code, kind, display_name, description) VALUES
  ('CLEAN_PDF',              'feature', 'Clean PDF',                    'Official PDF deliverables without the draft marking.'),
  ('EXCEL_EXPORT',           'feature', 'Excel',                        'Official spreadsheet and data exports.'),
  ('FILING_PACKS',           'feature', 'XBRL and regional filing packs', 'Official filing packs, including XBRL instances.'),
  ('MANAGEMENT_LETTERS',     'feature', 'Management letters',           'Official management letters.'),
  ('MULTI_ENTITY_REPORTING', 'feature', 'Multi-entity reporting',       'Reporting across more than one active entity.'),
  ('CONSOLIDATION',          'feature', 'Consolidation',                'Group consolidation. Not offered on any plan.'),
  ('REGIONAL_PACKS',         'feature', 'Regional packs',               'Jurisdiction-specific statutory packs.')
$mretirementaal$;

  EXECUTE $mretirementaam$
-- ── 2. Plans: retire Free; add Solo ─────────────────────────────────────────────────────────
ALTER TABLE public.commercial_plans DROP CONSTRAINT chk_cp_code
$mretirementaam$;

  EXECUTE $mretirementaan$
ALTER TABLE public.commercial_plans ADD CONSTRAINT chk_cp_code CHECK (code IN ('FREE','SOLO','PRACTICE','FIRM','ENTERPRISE','PAID'))
$mretirementaan$;

  EXECUTE $mretirementaao$
ALTER TABLE public.commercial_plans DROP CONSTRAINT chk_cp_sales_mode
$mretirementaao$;

  EXECUTE $mretirementaap$
ALTER TABLE public.commercial_plans ADD CONSTRAINT chk_cp_sales_mode CHECK (sales_mode IN ('free','self_serve','contact_sales','legacy','retired'))
$mretirementaap$;

  EXECUTE $mretirementaaq$
-- Solo never buys seats (like the retired Free plan).
ALTER TABLE public.commercial_plans ADD CONSTRAINT chk_cp_solo_seats CHECK (code <> 'SOLO' OR (included_seats = 1 AND NOT additional_seats_purchasable AND entity_capacity = 1))
$mretirementaaq$;

  EXECUTE $mretirementaar$
UPDATE public.commercial_plans cp
   SET is_active = false, is_public = false, display_order = NULL, sales_mode = 'retired'
  FROM public.commercial_products p WHERE p.id = cp.product_id AND p.code = 'CFOCLOSE' AND cp.code = 'FREE'
$mretirementaar$;

  EXECUTE $mretirementaas$
-- No plan may be offered free of charge again.
ALTER TABLE public.commercial_plans ADD CONSTRAINT chk_cp_no_free_sales CHECK (sales_mode <> 'free')
$mretirementaas$;

  EXECUTE $mretirementaat$
INSERT INTO public.commercial_plans (product_id, code, name, feature_codes, entity_capacity, included_seats, additional_seats_purchasable, is_public, display_order, sales_mode)
SELECT p.id, 'SOLO', 'Solo',
       ARRAY['CLOSE_ASSURANCE','CLOSE_INSIGHTS','COMPARATIVE_REPORTING','ENTITY_CAPACITY','NAMED_USER_SEATS','REPORTING_PACK_EXPORT','STATEMENT_CERTIFICATION']::TEXT[],
       1, 1, false, true, 1, 'self_serve'
  FROM public.commercial_products p WHERE p.code = 'CFOCLOSE'
$mretirementaat$;

  EXECUTE $mretirementaau$
INSERT INTO public.commercial_offers (offer_code, plan_id, market_code, currency_code, amount_minor, currency_exponent, billing_interval, billing_interval_count)
SELECT v.offer_code, cp.id, 'GLOBAL', 'USD', v.amount, 2, v.billing_interval, 1
  FROM public.commercial_plans cp
  JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
  JOIN (VALUES ('SOLO', 'CFOCLOSE_SOLO_GLOBAL_USD_MONTHLY',  4900::bigint, 'MONTHLY'),
               ('SOLO', 'CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL',  49000::bigint, 'ANNUAL')) AS v(plan_code, offer_code, amount, billing_interval)
    ON v.plan_code = cp.code
$mretirementaau$;

  EXECUTE $mretirementaav$
-- ── 3. The plan x capability matrix (the one authority) ────────────────────────────────────
CREATE TABLE public.commercial_plan_features (
  plan_id          UUID        NOT NULL,
  capability_code  TEXT        NOT NULL,
  included         BOOLEAN     NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commercial_plan_features_pk PRIMARY KEY (plan_id, capability_code),
  CONSTRAINT fk_cpf_plan FOREIGN KEY (plan_id) REFERENCES public.commercial_plans(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cpf_capability FOREIGN KEY (capability_code) REFERENCES public.commercial_capabilities(code) ON DELETE RESTRICT
)
$mretirementaav$;

  EXECUTE $mretirementaaw$
ALTER TABLE public.commercial_plan_features ENABLE ROW LEVEL SECURITY
$mretirementaaw$;

  EXECUTE $mretirementaax$
CREATE POLICY "cpf_select_public" ON public.commercial_plan_features FOR SELECT USING (true)
$mretirementaax$;

  EXECUTE $mretirementaay$
REVOKE ALL ON public.commercial_plan_features FROM PUBLIC, anon, authenticated, service_role
$mretirementaay$;

  EXECUTE $mretirementaaz$
GRANT SELECT ON public.commercial_plan_features TO anon, authenticated, service_role
$mretirementaaz$;

  EXECUTE $mretirementaba$
-- Rows: every plan x every capability that is not a capacity. The retired Free plan includes nothing.
INSERT INTO public.commercial_plan_features (plan_id, capability_code, included)
SELECT cp.id, m.capability, m.plans @> ARRAY[cp.code]::TEXT[]
  FROM public.commercial_plans cp
  JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
 CROSS JOIN (VALUES
   ('CLOSE_ASSURANCE',         ARRAY['SOLO','PRACTICE','FIRM','ENTERPRISE','PAID']),
   ('COMPARATIVE_REPORTING',   ARRAY['SOLO','PRACTICE','FIRM','ENTERPRISE','PAID']),
   ('STATEMENT_CERTIFICATION', ARRAY['SOLO','PRACTICE','FIRM','ENTERPRISE','PAID']),
   ('REPORTING_PACK_EXPORT',   ARRAY['SOLO','PRACTICE','FIRM','ENTERPRISE','PAID']),
   ('CLOSE_INSIGHTS',          ARRAY['SOLO','PRACTICE','FIRM','ENTERPRISE','PAID']),
   ('CLEAN_PDF',               ARRAY['SOLO','PRACTICE','FIRM','ENTERPRISE','PAID']),
   ('EXCEL_EXPORT',            ARRAY['SOLO','PRACTICE','FIRM','ENTERPRISE','PAID']),
   ('FILING_PACKS',            ARRAY['SOLO','PRACTICE','FIRM','ENTERPRISE','PAID']),
   ('MANAGEMENT_LETTERS',      ARRAY['SOLO','PRACTICE','FIRM','ENTERPRISE','PAID']),
   ('MULTI_ENTITY_REPORTING',  ARRAY['PRACTICE','FIRM','ENTERPRISE','PAID']),
   ('CONSOLIDATION',           ARRAY[]::TEXT[]),
   ('REGIONAL_PACKS',          ARRAY['SOLO','PRACTICE','FIRM','ENTERPRISE','PAID'])) AS m(capability, plans)
$mretirementaba$;

  EXECUTE $mretirementabb$
-- Every official output format and the capability it needs besides REPORTING_PACK_EXPORT.
CREATE TABLE public.reporting_pack_kind_features (
  pack_kind        TEXT NOT NULL,
  capability_code  TEXT NOT NULL,
  CONSTRAINT reporting_pack_kind_features_pk PRIMARY KEY (pack_kind),
  CONSTRAINT fk_rpkf_capability FOREIGN KEY (capability_code) REFERENCES public.commercial_capabilities(code) ON DELETE RESTRICT
)
$mretirementabb$;

  EXECUTE $mretirementabc$
ALTER TABLE public.reporting_pack_kind_features ENABLE ROW LEVEL SECURITY
$mretirementabc$;

  EXECUTE $mretirementabd$
CREATE POLICY "rpkf_select_public" ON public.reporting_pack_kind_features FOR SELECT USING (true)
$mretirementabd$;

  EXECUTE $mretirementabe$
REVOKE ALL ON public.reporting_pack_kind_features FROM PUBLIC, anon, authenticated, service_role
$mretirementabe$;

  EXECUTE $mretirementabf$
GRANT SELECT ON public.reporting_pack_kind_features TO anon, authenticated, service_role
$mretirementabf$;

  EXECUTE $mretirementabg$
INSERT INTO public.reporting_pack_kind_features (pack_kind, capability_code) VALUES
  ('financial_statements_pdf',         'CLEAN_PDF'),
  ('financial_statements_spreadsheet', 'EXCEL_EXPORT'),
  ('financial_statements_data',        'EXCEL_EXPORT'),
  ('filing_pack',                      'FILING_PACKS'),
  ('client_pack',                      'CLEAN_PDF'),
  ('board_pack',                       'EXCEL_EXPORT'),
  ('management_letter',                'MANAGEMENT_LETTERS'),
  ('disclosure_notes',                 'CLEAN_PDF'),
  ('tax_computation',                  'CLEAN_PDF'),
  ('tax_workpaper',                    'EXCEL_EXPORT')
$mretirementabg$;

  EXECUTE $mretirementabh$
-- ── 4. Current plan of an account ───────────────────────────────────────────────────────────
-- The plan code of the account's current (ACTIVE / GRACE, in effect) licence, or NULL when there is none.
CREATE OR REPLACE FUNCTION public._account_current_plan_code(p_account UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT cp.code
    FROM public.billing_customers b
    JOIN public.commercial_licences cl ON cl.billing_customer_id = b.id
    JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE b.owner_user_id = p_account AND cl.status IN ('ACTIVE','GRACE')
     AND cl.effective_start <= clock_timestamp() AND (cl.effective_end IS NULL OR cl.effective_end > clock_timestamp())
   ORDER BY cl.effective_start DESC LIMIT 1;
$$
$mretirementabh$;

  EXECUTE $mretirementabi$
-- TRUE only for a current licence on a plan that is sold or grandfathered. The retired Free plan, no licence or an
-- ended licence is never a current plan.
CREATE OR REPLACE FUNCTION public._account_has_current_plan(p_account UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(public._account_current_plan_code(p_account) IN ('SOLO','PRACTICE','FIRM','ENTERPRISE','PAID'), false);
$$
$mretirementabi$;

  EXECUTE $mretirementabj$
CREATE OR REPLACE FUNCTION public.workspace_has_current_plan(p_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(public._account_has_current_plan((SELECT c.user_id FROM public.companies c WHERE c.id = p_company_id)), false);
$$
$mretirementabj$;

  EXECUTE $mretirementabk$
-- ── 5. The entitlement resolver (supersedes 20260925100000) ─────────────────────────────────
-- Every capability that is not a capacity comes from the matrix of the account's current plan. No capability is
-- entitled without a current plan (an active admin override excepted, which is recorded and audited).
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
$$
$mretirementabk$;

  EXECUTE $mretirementabl$
-- Entity capacity: the current plan's number, raised by an active ENTITY_CAPACITY override. No current plan
-- (including the retired Free plan) = 0: existing entities are kept, none can be added or reactivated.
CREATE OR REPLACE FUNCTION public._entity_capacity_for_account(p_account UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_bc        UUID;
  v_plan_code TEXT;
  v_plan_cap  INTEGER;
  v_override  INTEGER;
  v_source    TEXT;
  v_found     BOOLEAN := false;
BEGIN
  IF p_account IS NULL THEN
    RETURN jsonb_build_object('capacity', NULL, 'determined', false, 'plan_code', NULL, 'source', NULL);
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
    RETURN jsonb_build_object('capacity', NULL, 'determined', false, 'plan_code', NULL, 'source', 'UNKNOWN_PLAN');
  ELSE
    v_source := 'ACTIVE_LICENCE';
  END IF;
  IF v_bc IS NOT NULL THEN
    SELECT max(eo.capacity_value) INTO v_override FROM public.entitlement_overrides eo
     WHERE eo.billing_customer_id = v_bc AND eo.feature_code = 'ENTITY_CAPACITY' AND eo.revoked_at IS NULL
       AND eo.effective_start <= now() AND (eo.effective_end IS NULL OR eo.effective_end > now());
    IF v_override IS NOT NULL AND v_override > COALESCE(v_plan_cap, 0) THEN
      v_plan_cap := v_override; v_source := 'ADMIN_OVERRIDE';
    END IF;
  END IF;
  RETURN jsonb_build_object('capacity', v_plan_cap, 'determined', v_plan_cap IS NOT NULL, 'plan_code', v_plan_code, 'source', v_source);
END;
$$
$mretirementabl$;

  EXECUTE $mretirementabm$
-- Named users: allowed = included + purchased. No current plan (or the retired Free plan) = the account holder
-- only. Solo is exactly one and can never carry purchased seats (a Solo licence recording any is malformed and
-- fails closed).
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
    RETURN jsonb_build_object('determined', false, 'plan_code', NULL, 'included_seats', NULL, 'additional_seats', NULL,
      'allowed_named_users', NULL, 'additional_seats_purchasable', false, 'source', NULL);
  END IF;
  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_account LIMIT 1;
  IF v_bc IS NOT NULL THEN
    SELECT cp.code AS plan_code, cp.included_seats, cp.additional_seats_purchasable, cl.additional_seats INTO v_lic
      FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
     WHERE cl.billing_customer_id = v_bc AND cl.status IN ('ACTIVE','GRACE')
       AND cl.effective_start <= clock_timestamp() AND (cl.effective_end IS NULL OR cl.effective_end > clock_timestamp())
     ORDER BY cl.effective_start DESC LIMIT 1;
    v_found := FOUND;
  END IF;
  IF NOT v_found OR v_lic.plan_code = 'FREE' THEN
    RETURN jsonb_build_object('determined', true, 'plan_code', NULL, 'included_seats', 1, 'additional_seats', 0,
      'allowed_named_users', 1, 'additional_seats_purchasable', false, 'source', 'NO_CURRENT_PLAN');
  END IF;
  IF v_lic.plan_code NOT IN ('SOLO','PRACTICE','FIRM','ENTERPRISE','PAID') THEN
    RETURN jsonb_build_object('determined', false, 'plan_code', NULL, 'included_seats', NULL, 'additional_seats', NULL,
      'allowed_named_users', NULL, 'additional_seats_purchasable', false, 'source', 'UNKNOWN_PLAN');
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
  RETURN jsonb_build_object('determined', v_ok, 'plan_code', v_lic.plan_code,
    'included_seats', v_included, 'additional_seats', v_purchased,
    'allowed_named_users', CASE WHEN v_ok THEN v_included + v_purchased END,
    'additional_seats_purchasable', v_lic.additional_seats_purchasable, 'source', v_source);
END;
$$
$mretirementabm$;

  EXECUTE $mretirementabn$
-- ── 6. The paid-action authority: every non-capacity capability needs the workspace account's plan ──────
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
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
  v_ent := public._resolve_entitlement_for_owner(v_account, v_cap);
  IF v_ent->>'status' = 'ENTITLED' THEN
    RETURN jsonb_build_object('allowed', true, 'code', 'ALLOWED', 'capability', v_cap, 'plan_code', v_ent->>'plan_code', 'source', v_ent->>'source');
  END IF;
  RETURN jsonb_build_object('allowed', false, 'code', 'ENTITLEMENT_REQUIRED', 'capability', v_cap,
    'plan_code', v_ent->>'plan_code', 'required_plan', CASE WHEN v_cap = 'MULTI_ENTITY_REPORTING' THEN 'PRACTICE' ELSE 'SOLO' END,
    'reason', v_ent->>'reason');
END;
$$
$mretirementabn$;

  EXECUTE $mretirementabo$
CREATE OR REPLACE FUNCTION public._require_workspace_capability(p_company_id UUID, p_capability TEXT)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.workspace_capability_entitled(p_company_id, p_capability) THEN
    RAISE EXCEPTION 'ENTITLEMENT_REQUIRED'
      USING ERRCODE = 'PT402', DETAIL = public.commercial_canonical_capability(p_capability), HINT = 'SOLO';
  END IF;
END;
$$
$mretirementabo$;

  EXECUTE $mretirementabp$
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
  FOR r IN SELECT code FROM public.commercial_capabilities WHERE kind IN ('paid', 'included', 'feature') ORDER BY code LOOP
    v_caps := v_caps || jsonb_build_object(r.code, public._authorize_paid_action(v_user, p_company_id, r.code) - 'reason');
  END LOOP;
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
  RETURN jsonb_build_object('access', true,
    'plan_code', public._entity_capacity_for_account(v_account)->>'plan_code',
    'has_current_plan', public._account_has_current_plan(v_account),
    'capabilities', v_caps);
END;
$$
$mretirementabp$;

  EXECUTE $mretirementabq$
-- ── 7. Seats: Solo (like the retired Free plan) never records purchased seats ───────────────
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
  IF v_lic.plan_code = 'SOLO' AND p_quantity <> 0 THEN RAISE EXCEPTION 'SOLO_PLAN_HAS_NO_ADDITIONAL_SEATS' USING ERRCODE = '22023'; END IF;
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
$mretirementabq$;

  EXECUTE $mretirementabr$
-- ── 7b. Capacity walls: without a current plan the refusal still carries a structured hint ──────
-- Identical to their previous definitions (20260925100000 / 20260925110000) except that the HINT is NO_PLAN when the
-- account has no current plan (a NULL hint would make the refusal itself fail).
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
    RAISE EXCEPTION 'ENTITY_CAPACITY_REACHED' USING ERRCODE = 'PT402', DETAIL = 'ENTITY_CAPACITY', HINT = COALESCE(v_cap->>'plan_code', 'NO_PLAN');
  END IF;
  RETURN NEW;
END;
$$
$mretirementabr$;

  EXECUTE $mretirementabs$
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
    RAISE EXCEPTION 'SEAT_LIMIT_REACHED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = COALESCE(v_cap->>'plan_code', 'NO_PLAN');
  END IF;
  IF v_activates
     AND NOT EXISTS (SELECT 1 FROM public._account_named_users(v_account, false, v_member, v_grant) u WHERE u.named_user_id = v_user)
     AND (SELECT count(*) FROM public._account_named_users(v_account, false, v_member, v_grant)) + 1 > v_allowed THEN
    RAISE EXCEPTION 'SEAT_LIMIT_REACHED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = COALESCE(v_cap->>'plan_code', 'NO_PLAN');
  END IF;
  RETURN NEW;
END;
$$
$mretirementabs$;

  EXECUTE $mretirementabt$
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
      RAISE EXCEPTION 'SEAT_LIMIT_REACHED' USING ERRCODE = 'PT402', DETAIL = 'NAMED_USER_SEATS', HINT = COALESCE(v_cap->>'plan_code', 'NO_PLAN');
    END IF;
  END IF;
  RETURN NEW;
END;
$$
$mretirementabt$;

  EXECUTE $mretirementabu$
-- ── 8. Provisioning: a billing record only; never a licence ─────────────────────────────────
-- Creating a company no longer enrols anyone in a plan (there is no free plan). The billing record lets a commercial
-- administrator record the account's plan. (Company creation itself needs a plan: the entity-capacity wall.)
CREATE OR REPLACE FUNCTION public.provision_billing_customer_for_company()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_product_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.billing_customers WHERE owner_user_id = NEW.user_id) THEN
    SELECT id INTO v_product_id FROM public.commercial_products WHERE code = 'CFOCLOSE' LIMIT 1;
    IF v_product_id IS NULL THEN
      RAISE EXCEPTION 'TRIGGER_CONFIG_ERROR: commercial_products has no row with code=CFOCLOSE.';
    END IF;
    INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES (NEW.user_id, v_product_id)
    ON CONFLICT (owner_user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$
$mretirementabu$;

  EXECUTE $mretirementabv$
REVOKE ALL ON FUNCTION public.provision_billing_customer_for_company() FROM PUBLIC, anon, authenticated
$mretirementabv$;

  EXECUTE $mretirementabw$
-- A commercial administrator records a new customer's billing record (needed before a plan can be granted to
-- someone who has no entity yet). Idempotent; audited.
CREATE OR REPLACE FUNCTION public.admin_ensure_billing_customer(p_owner_user_id UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_bc      UUID;
  v_product UUID;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_owner_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_owner_user_id) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_bc FROM public.billing_customers WHERE owner_user_id = p_owner_user_id;
  IF v_bc IS NOT NULL THEN
    RETURN jsonb_build_object('billing_customer_id', v_bc, 'created', false);
  END IF;
  SELECT id INTO v_product FROM public.commercial_products WHERE code = 'CFOCLOSE';
  INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES (p_owner_user_id, v_product) RETURNING id INTO v_bc;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_bc, v_user_id, 'BILLING_CUSTOMER_CREATED', NULL, jsonb_build_object('owner_user_id', p_owner_user_id), p_reason);
  RETURN jsonb_build_object('billing_customer_id', v_bc, 'created', true);
END;
$$
$mretirementabw$;

  EXECUTE $mretirementabx$
REVOKE ALL ON FUNCTION public.admin_ensure_billing_customer(UUID, TEXT) FROM PUBLIC, anon, service_role
$mretirementabx$;

  EXECUTE $mretirementaby$
GRANT EXECUTE ON FUNCTION public.admin_ensure_billing_customer(UUID, TEXT) TO authenticated
$mretirementaby$;

  EXECUTE $mretirementabz$
-- ── 9. Conversion from Free: end every open Free licence (the licence row, not data) ────────
-- FREE -> EXPIRED_READ_ONLY. No plan is granted here; a plan is only ever recorded by an explicit administrator action.
-- The reconcile triggers of 20260925110000 run for each account: a Free account already had one named user, so
-- nobody's access changes except that the account now has no current plan (read-only until a plan is recorded).
WITH authorized AS MATERIALIZED (
  SELECT public._consume_free_retirement_approval('20260925130000') AS ok
), ended AS (
  UPDATE public.commercial_licences cl
     SET status = 'EXPIRED', effective_end = GREATEST(now(), cl.effective_start + interval '1 second'), updated_at = now()
    FROM public.commercial_plans cp
   WHERE (SELECT ok FROM authorized) AND cp.id = cl.plan_id AND cp.code = 'FREE' AND cl.status IN ('PENDING','ACTIVE','GRACE')
  RETURNING cl.id, cl.billing_customer_id, cl.status AS new_status
)
INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
SELECT e.billing_customer_id, NULL, 'FREE_PLAN_RETIRED',
       jsonb_build_object('licence_id', e.id, 'plan_code', 'FREE'),
       jsonb_build_object('licence_id', e.id, 'status', e.new_status),
       'The permanent Free plan is retired (20260925130000). No data was changed or deleted.'
  FROM ended e
$mretirementabz$;

  EXECUTE $mretirementaca$
-- ── 10. Privileges ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._account_current_plan_code(UUID) FROM PUBLIC, anon, authenticated
$mretirementaca$;

  EXECUTE $mretirementacb$
REVOKE ALL ON FUNCTION public._account_has_current_plan(UUID) FROM PUBLIC, anon, authenticated
$mretirementacb$;

  EXECUTE $mretirementacc$
REVOKE ALL ON FUNCTION public.workspace_has_current_plan(UUID) FROM PUBLIC, anon, authenticated
$mretirementacc$;

  EXECUTE $mretirementacd$
GRANT EXECUTE ON FUNCTION public.workspace_has_current_plan(UUID) TO service_role
$mretirementacd$;

  EXECUTE $mretirementace$
REVOKE ALL ON FUNCTION public._resolve_entitlement_for_owner(UUID, TEXT) FROM PUBLIC, anon, authenticated
$mretirementace$;

  EXECUTE $mretirementacf$
REVOKE ALL ON FUNCTION public._entity_capacity_for_account(UUID) FROM PUBLIC, anon, authenticated
$mretirementacf$;

  EXECUTE $mretirementacg$
REVOKE ALL ON FUNCTION public._seat_capacity_for_account(UUID) FROM PUBLIC, anon, authenticated
$mretirementacg$;

  EXECUTE $mretirementach$
REVOKE ALL ON FUNCTION public._authorize_paid_action(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated
$mretirementach$;

  EXECUTE $mretirementaci$
REVOKE ALL ON FUNCTION public._require_workspace_capability(UUID, TEXT) FROM PUBLIC, anon, authenticated
$mretirementaci$;

  EXECUTE $mretirementacj$
REVOKE ALL ON FUNCTION public.get_workspace_commercial_state(UUID) FROM PUBLIC, anon
$mretirementacj$;

  EXECUTE $mretirementack$
GRANT EXECUTE ON FUNCTION public.get_workspace_commercial_state(UUID) TO authenticated
$mretirementack$;

  EXECUTE $mretirementacl$
REVOKE ALL ON FUNCTION public.admin_set_licence_additional_seats(UUID, INTEGER, TEXT) FROM PUBLIC, anon
$mretirementacl$;

  EXECUTE $mretirementacm$
GRANT EXECUTE ON FUNCTION public.admin_set_licence_additional_seats(UUID, INTEGER, TEXT) TO authenticated
$mretirementacm$;
END
$cfoclose_retirement$;
