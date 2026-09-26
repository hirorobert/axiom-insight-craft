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
-- 2. Plans FREE / PRACTICE / FIRM / ENTERPRISE with entity capacity and named-user seats. The legacy PAID plan
--    ("CFOClose Professional", never sold: payments were never enabled) is kept for any existing licence,
--    grandfathered with every paid capability and Firm entity capacity, and withdrawn from the public catalogue.
--    Its $49 / $499 offers are retired (never deleted). New USD offers are seeded non-purchasable:
--    Practice $99 / $990, Firm $299 / $2,990. Enterprise is contact-sales (no offer).
--    Seats: every plan includes exactly ONE named user (Enterprise: negotiated). Practice and Firm may add separately
--    purchased named-user seats ($20 / month or $200 / year each; non-purchasable here, no checkout). The purchased
--    quantity is commercial_licences.additional_seats (recorded by an audited admin RPC until a payment provider
--    exists). allowed_named_users = included_seats + additional_seats. Free is always exactly one named user.
--    Every human uses their own authenticated account; seats count distinct people, never shared sign-ins.
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
--      Named-user seats     a person newly invited, added, granted or activated on any of the account's workspaces
--                           (firm_members, workspace_capability_grants), serialised per account
--    Nothing here reads or writes accounting values, certifications, stage locks or audit evidence. Expiry or
--    downgrade only stops NEW paid actions and new people; every existing record and membership is kept.
-- 5. The statement sign-off gate's messages lose the internal engine name (logic unchanged).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 0. Existing-state refusal (reads only; before any DDL) ───────────────────────────────────
--
-- ATOMIC ENVELOPE (security correction B-3): every statement below runs inside this ONE DO statement. Whatever the
-- runner does (statement by statement, whole file, with or without a transaction, continuing after errors) the
-- migration either applies completely or changes nothing.
DO $cfoclose_entitlements$
BEGIN
  EXECUTE $mentitlementsaaa$
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
$refuse$
$mentitlementsaaa$;

  EXECUTE $mentitlementsaab$
SET search_path TO public, pg_catalog
$mentitlementsaab$;

  EXECUTE $mentitlementsaac$
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
)
$mentitlementsaac$;

  EXECUTE $mentitlementsaad$
ALTER TABLE public.commercial_capabilities ENABLE ROW LEVEL SECURITY
$mentitlementsaad$;

  EXECUTE $mentitlementsaae$
CREATE POLICY "ccap_select_public" ON public.commercial_capabilities FOR SELECT USING (true)
$mentitlementsaae$;

  EXECUTE $mentitlementsaaf$
REVOKE ALL ON public.commercial_capabilities FROM PUBLIC, anon, authenticated
$mentitlementsaaf$;

  EXECUTE $mentitlementsaag$
GRANT SELECT ON public.commercial_capabilities TO anon, authenticated
$mentitlementsaag$;

  EXECUTE $mentitlementsaah$
GRANT ALL ON public.commercial_capabilities TO service_role
$mentitlementsaah$;

  EXECUTE $mentitlementsaai$
INSERT INTO public.commercial_capabilities (code, kind, display_name, description) VALUES
  ('CLOSE_ASSURANCE',         'included', 'Close Assurance',       'Always-on integrity and authorization: validations, readiness checks and statement preview.'),
  ('COMPARATIVE_REPORTING',   'included', 'Comparative Reporting', 'The prior-period comparative the reporting framework requires. Included in every plan.'),
  ('STATEMENT_CERTIFICATION', 'paid',     'Close Certification',   'Record a certified close: statement sign-offs and final report versions.'),
  ('REPORTING_PACK_EXPORT',   'paid',     'Reporting Pack',        'Issue formal deliverables: financial statement PDFs and spreadsheets, filing and client packs.'),
  ('CLOSE_INSIGHTS',          'paid',     'Close Insights',        'Advanced analysis: variance and trend interpretation, risk commentary, forecasts and recommendations.'),
  ('ENTITY_CAPACITY',         'capacity', 'Entity Capacity',       'How many active entities (workspaces) the plan includes.'),
  ('NAMED_USER_SEATS',        'capacity', 'Named Users',           'How many people may use the account, each with their own sign-in: one included in every plan, plus additional seats purchased on Practice and Firm.')
$mentitlementsaai$;

  EXECUTE $mentitlementsaaj$
CREATE TABLE public.commercial_capability_aliases (
  legacy_code     TEXT NOT NULL,
  canonical_code  TEXT NOT NULL,
  CONSTRAINT commercial_capability_aliases_pk PRIMARY KEY (legacy_code),
  CONSTRAINT fk_ccal_canonical FOREIGN KEY (canonical_code) REFERENCES public.commercial_capabilities(code) ON DELETE RESTRICT
)
$mentitlementsaaj$;

  EXECUTE $mentitlementsaak$
ALTER TABLE public.commercial_capability_aliases ENABLE ROW LEVEL SECURITY
$mentitlementsaak$;

  EXECUTE $mentitlementsaal$
CREATE POLICY "ccal_select_public" ON public.commercial_capability_aliases FOR SELECT USING (true)
$mentitlementsaal$;

  EXECUTE $mentitlementsaam$
REVOKE ALL ON public.commercial_capability_aliases FROM PUBLIC, anon, authenticated
$mentitlementsaam$;

  EXECUTE $mentitlementsaan$
GRANT SELECT ON public.commercial_capability_aliases TO anon, authenticated
$mentitlementsaan$;

  EXECUTE $mentitlementsaao$
GRANT ALL ON public.commercial_capability_aliases TO service_role
$mentitlementsaao$;

  EXECUTE $mentitlementsaap$
INSERT INTO public.commercial_capability_aliases (legacy_code, canonical_code) VALUES
  ('SAFISHA_PREVIEW',    'CLOSE_ASSURANCE'),
  ('HESABU_REPORTING',   'CLOSE_ASSURANCE'),
  ('SAFISHA_CERTIFY',    'STATEMENT_CERTIFICATION'),
  ('HESABU_EXPORT',      'REPORTING_PACK_EXPORT'),
  ('MAONO_INTELLIGENCE', 'CLOSE_INSIGHTS'),
  ('MULTI_COMPANY',      'ENTITY_CAPACITY'),
  ('MULTI_PERIOD',       'COMPARATIVE_REPORTING')
$mentitlementsaap$;

  EXECUTE $mentitlementsaaq$
-- Canonical code for a canonical or legacy input; NULL when unknown.
CREATE OR REPLACE FUNCTION public.commercial_canonical_capability(p_code TEXT)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    (SELECT c.code FROM public.commercial_capabilities c WHERE c.code = p_code),
    (SELECT a.canonical_code FROM public.commercial_capability_aliases a WHERE a.legacy_code = p_code));
$$
$mentitlementsaaq$;

  EXECUTE $mentitlementsaar$
-- ── 2. Plans: canonical codes, capacities, catalogue metadata ───────────────────────────────
ALTER TABLE public.commercial_plans DROP CONSTRAINT chk_cp_feature_codes
$mentitlementsaar$;

  EXECUTE $mentitlementsaas$
ALTER TABLE public.commercial_plans
  ADD COLUMN entity_capacity                INTEGER NULL,
  ADD COLUMN included_seats                 INTEGER NULL,
  ADD COLUMN additional_seats_purchasable   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN is_public                      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN display_order                  INTEGER NULL,
  ADD COLUMN sales_mode                     TEXT    NOT NULL DEFAULT 'legacy'
$mentitlementsaas$;

  EXECUTE $mentitlementsaat$
-- Legacy codes -> canonical (deterministic, de-duplicated, sorted). Every plan also carries the always-on
-- capabilities and the two capacity markers.
UPDATE public.commercial_plans cp
   SET feature_codes = (
     SELECT array_agg(DISTINCT c ORDER BY c) FROM (
       SELECT a.canonical_code AS c FROM unnest(cp.feature_codes) f JOIN public.commercial_capability_aliases a ON a.legacy_code = f
       UNION SELECT 'CLOSE_ASSURANCE' UNION SELECT 'COMPARATIVE_REPORTING' UNION SELECT 'ENTITY_CAPACITY' UNION SELECT 'NAMED_USER_SEATS') s)
$mentitlementsaat$;

  EXECUTE $mentitlementsaau$
UPDATE public.commercial_plans cp
   SET entity_capacity = 1, included_seats = 1, additional_seats_purchasable = false, is_public = true, display_order = 1, sales_mode = 'free'
  FROM public.commercial_products p WHERE p.id = cp.product_id AND p.code = 'CFOCLOSE' AND cp.code = 'FREE'
$mentitlementsaau$;

  EXECUTE $mentitlementsaav$
-- Legacy PAID: grandfathered (every paid capability, Firm entity capacity), one included named user like every
-- plan, no self-serve seat purchase; no longer offered.
UPDATE public.commercial_plans cp
   SET feature_codes = ARRAY['CLOSE_ASSURANCE','CLOSE_INSIGHTS','COMPARATIVE_REPORTING','ENTITY_CAPACITY','NAMED_USER_SEATS','REPORTING_PACK_EXPORT','STATEMENT_CERTIFICATION']::TEXT[],
       entity_capacity = 25, included_seats = 1, additional_seats_purchasable = false, is_public = false, display_order = NULL, sales_mode = 'legacy'
  FROM public.commercial_products p WHERE p.id = cp.product_id AND p.code = 'CFOCLOSE' AND cp.code = 'PAID'
$mentitlementsaav$;

  EXECUTE $mentitlementsaaw$
INSERT INTO public.commercial_plans (product_id, code, name, feature_codes, entity_capacity, included_seats, additional_seats_purchasable, is_public, display_order, sales_mode)
SELECT p.id, v.code, v.name,
       ARRAY['CLOSE_ASSURANCE','CLOSE_INSIGHTS','COMPARATIVE_REPORTING','ENTITY_CAPACITY','NAMED_USER_SEATS','REPORTING_PACK_EXPORT','STATEMENT_CERTIFICATION']::TEXT[],
       v.entities, v.seats, v.buy_seats, true, v.ord, v.mode
  FROM public.commercial_products p
 CROSS JOIN (VALUES ('PRACTICE',   'Practice',   5,    1,    true,  2, 'self_serve'),
                    ('FIRM',       'Firm',       25,   1,    true,  3, 'self_serve'),
                    ('ENTERPRISE', 'Enterprise', NULL, NULL, false, 4, 'contact_sales')) AS v(code, name, entities, seats, buy_seats, ord, mode)
 WHERE p.code = 'CFOCLOSE'
$mentitlementsaaw$;

  EXECUTE $mentitlementsaax$
ALTER TABLE public.commercial_plans
  ADD CONSTRAINT chk_cp_feature_codes CHECK (feature_codes <@ ARRAY[
    'CLOSE_ASSURANCE','COMPARATIVE_REPORTING','STATEMENT_CERTIFICATION','REPORTING_PACK_EXPORT','CLOSE_INSIGHTS','ENTITY_CAPACITY','NAMED_USER_SEATS'
  ]::TEXT[]),
  ADD CONSTRAINT chk_cp_always_on CHECK (feature_codes @> ARRAY['CLOSE_ASSURANCE','COMPARATIVE_REPORTING','ENTITY_CAPACITY','NAMED_USER_SEATS']::TEXT[]),
  ADD CONSTRAINT chk_cp_code CHECK (code IN ('FREE','PRACTICE','FIRM','ENTERPRISE','PAID')),
  ADD CONSTRAINT chk_cp_entity_capacity CHECK (entity_capacity IS NULL OR entity_capacity > 0),
  -- Exactly one included named user on every plan; only a contact-sales plan negotiates it (recorded per account).
  ADD CONSTRAINT chk_cp_included_seats CHECK (included_seats = 1 OR (included_seats IS NULL AND sales_mode = 'contact_sales')),
  -- Free can never buy seats.
  ADD CONSTRAINT chk_cp_free_seats CHECK (code <> 'FREE' OR (included_seats = 1 AND NOT additional_seats_purchasable)),
  ADD CONSTRAINT chk_cp_sales_mode CHECK (sales_mode IN ('free','self_serve','contact_sales','legacy')),
  ADD CONSTRAINT chk_cp_capacity_known CHECK (entity_capacity IS NOT NULL OR sales_mode = 'contact_sales')
$mentitlementsaax$;

  EXECUTE $mentitlementsaay$
-- Purchased additional named-user seats: the quantity on the licence. Never missing, never negative (a licence
-- that recorded nothing has 0). Free licences never carry seats (enforced where the quantity is set, and ignored
-- by the resolver regardless).
ALTER TABLE public.commercial_licences
  ADD COLUMN additional_seats INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_cl_additional_seats CHECK (additional_seats BETWEEN 0 AND 10000)
$mentitlementsaay$;

  EXECUTE $mentitlementsaaz$
-- ── 3. Overrides: canonical codes; entity capacity carries its number ───────────────────────
ALTER TABLE public.entitlement_overrides DROP CONSTRAINT chk_eo_feature_code
$mentitlementsaaz$;

  EXECUTE $mentitlementsaba$
ALTER TABLE public.entitlement_overrides ADD COLUMN capacity_value INTEGER NULL
$mentitlementsaba$;

  EXECUTE $mentitlementsabb$
-- A legacy MULTI_COMPANY override meant "more than one company": carried as Firm capacity (25).
UPDATE public.entitlement_overrides eo
   SET capacity_value = CASE WHEN eo.feature_code = 'MULTI_COMPANY' THEN 25 END,
       feature_code = a.canonical_code
  FROM public.commercial_capability_aliases a
 WHERE a.legacy_code = eo.feature_code
$mentitlementsabb$;

  EXECUTE $mentitlementsabc$
ALTER TABLE public.entitlement_overrides
  ADD CONSTRAINT chk_eo_feature_code CHECK (feature_code IN (
    'CLOSE_ASSURANCE','COMPARATIVE_REPORTING','STATEMENT_CERTIFICATION','REPORTING_PACK_EXPORT','CLOSE_INSIGHTS','ENTITY_CAPACITY','NAMED_USER_SEATS')),
  -- A capacity override carries its number: ENTITY_CAPACITY (entities) or NAMED_USER_SEATS (the negotiated included
  -- named users, e.g. an Enterprise contract).
  ADD CONSTRAINT chk_eo_capacity CHECK (
    (feature_code IN ('ENTITY_CAPACITY','NAMED_USER_SEATS') AND capacity_value IS NOT NULL AND capacity_value > 0)
    OR (feature_code NOT IN ('ENTITY_CAPACITY','NAMED_USER_SEATS') AND capacity_value IS NULL))
$mentitlementsabc$;

  EXECUTE $mentitlementsabd$
-- ── 4. Offers: retire the $49 / $499 legacy offers; seed Practice and Firm (non-purchasable) ──
UPDATE public.commercial_offers
   SET is_active = false, is_purchasable = false, effective_end = GREATEST(now(), effective_start + interval '1 second'), updated_at = now()
 WHERE offer_code IN ('CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY', 'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_ANNUAL')
$mentitlementsabd$;

  EXECUTE $mentitlementsabe$
INSERT INTO public.commercial_offers (offer_code, plan_id, market_code, currency_code, amount_minor, currency_exponent, billing_interval, billing_interval_count)
SELECT v.offer_code, cp.id, 'GLOBAL', 'USD', v.amount, 2, v.billing_interval, 1
  FROM public.commercial_plans cp
  JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
  JOIN (VALUES ('PRACTICE', 'CFOCLOSE_PRACTICE_GLOBAL_USD_MONTHLY',  9900::bigint, 'MONTHLY'),
               ('PRACTICE', 'CFOCLOSE_PRACTICE_GLOBAL_USD_ANNUAL',  99000::bigint, 'ANNUAL'),
               ('FIRM',     'CFOCLOSE_FIRM_GLOBAL_USD_MONTHLY',     29900::bigint, 'MONTHLY'),
               ('FIRM',     'CFOCLOSE_FIRM_GLOBAL_USD_ANNUAL',     299000::bigint, 'ANNUAL')) AS v(plan_code, offer_code, amount, billing_interval)
    ON v.plan_code = cp.code
$mentitlementsabe$;

  EXECUTE $mentitlementsabf$
-- Additional named-user seat prices: separate from the base-plan offers (a seat is never a plan). USD, per seat,
-- per interval. Not purchasable: there is no checkout; the purchased quantity lives on the licence.
CREATE TABLE public.commercial_additional_seat_prices (
  id                 UUID        NOT NULL DEFAULT gen_random_uuid(),
  price_code         TEXT        NOT NULL,
  plan_id            UUID        NOT NULL,
  market_code        TEXT        NOT NULL,
  currency_code      TEXT        NOT NULL,
  currency_exponent  SMALLINT    NOT NULL,
  amount_minor       BIGINT      NOT NULL,
  billing_interval   TEXT        NOT NULL,
  is_active          BOOLEAN     NOT NULL DEFAULT true,
  is_purchasable     BOOLEAN     NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commercial_additional_seat_prices_pk PRIMARY KEY (id),
  CONSTRAINT uq_casp_price_code UNIQUE (price_code),
  CONSTRAINT fk_casp_plan FOREIGN KEY (plan_id) REFERENCES public.commercial_plans(id) ON DELETE RESTRICT,
  CONSTRAINT chk_casp_amount CHECK (amount_minor > 0),
  CONSTRAINT chk_casp_interval CHECK (billing_interval IN ('MONTHLY', 'ANNUAL')),
  CONSTRAINT chk_casp_currency CHECK (currency_code ~ '^[A-Z]{3}$' AND currency_exponent BETWEEN 0 AND 4)
)
$mentitlementsabf$;

  EXECUTE $mentitlementsabg$
CREATE UNIQUE INDEX uq_casp_active_price ON public.commercial_additional_seat_prices (plan_id, market_code, currency_code, billing_interval) WHERE is_active
$mentitlementsabg$;

  EXECUTE $mentitlementsabh$
ALTER TABLE public.commercial_additional_seat_prices ENABLE ROW LEVEL SECURITY
$mentitlementsabh$;

  EXECUTE $mentitlementsabi$
CREATE POLICY "casp_select_public" ON public.commercial_additional_seat_prices FOR SELECT USING (true)
$mentitlementsabi$;

  EXECUTE $mentitlementsabj$
REVOKE ALL ON public.commercial_additional_seat_prices FROM PUBLIC, anon, authenticated
$mentitlementsabj$;

  EXECUTE $mentitlementsabk$
GRANT SELECT ON public.commercial_additional_seat_prices TO anon, authenticated
$mentitlementsabk$;

  EXECUTE $mentitlementsabl$
GRANT ALL ON public.commercial_additional_seat_prices TO service_role
$mentitlementsabl$;

  EXECUTE $mentitlementsabm$
INSERT INTO public.commercial_additional_seat_prices (price_code, plan_id, market_code, currency_code, currency_exponent, amount_minor, billing_interval)
SELECT v.price_code, cp.id, 'GLOBAL', 'USD', 2, v.amount, v.billing_interval
  FROM public.commercial_plans cp
  JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
  JOIN (VALUES ('PRACTICE', 'CFOCLOSE_PRACTICE_SEAT_GLOBAL_USD_MONTHLY',  2000::bigint, 'MONTHLY'),
               ('PRACTICE', 'CFOCLOSE_PRACTICE_SEAT_GLOBAL_USD_ANNUAL',  20000::bigint, 'ANNUAL'),
               ('FIRM',     'CFOCLOSE_FIRM_SEAT_GLOBAL_USD_MONTHLY',      2000::bigint, 'MONTHLY'),
               ('FIRM',     'CFOCLOSE_FIRM_SEAT_GLOBAL_USD_ANNUAL',      20000::bigint, 'ANNUAL')) AS v(plan_code, price_code, amount, billing_interval)
    ON v.plan_code = cp.code
$mentitlementsabm$;

  EXECUTE $mentitlementsabn$
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
    v_result := CASE v_cap WHEN 'ENTITY_CAPACITY' THEN public._entity_capacity_for_account(p_owner_user_id)
                           ELSE public._seat_capacity_for_account(p_owner_user_id) END;
    RETURN jsonb_build_object('status', CASE WHEN (v_result->>'determined')::boolean THEN 'ENTITLED' ELSE 'UNKNOWN' END,
      'reason', CASE WHEN (v_result->>'determined')::boolean THEN 'CAPACITY_DETERMINED' ELSE 'CAPACITY_UNDETERMINED' END,
      'capability', v_cap, 'licence_status', NULL, 'plan_code', v_result->>'plan_code', 'source', v_result->>'source',
      'capacity', CASE v_cap WHEN 'ENTITY_CAPACITY' THEN v_result->'capacity' ELSE v_result->'allowed_named_users' END);
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
$$
$mentitlementsabn$;

  EXECUTE $mentitlementsabo$
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
$$
$mentitlementsabo$;

  EXECUTE $mentitlementsabp$
-- Named-user seats of one billing account:
--   allowed_named_users = included_seats + additional_seats
-- Free (no billing record, no current licence, or a FREE licence) is ALWAYS one named user with no additional
-- seats, whatever else is recorded. On a paid plan the included seat is the plan's one (or a larger active
-- NAMED_USER_SEATS override: a negotiated contract) and additional_seats is the licence's purchased quantity.
-- determined = false (and every new person refused) when any part is unknown, negative or malformed.
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
       AND cl.effective_start <= now() AND (cl.effective_end IS NULL OR cl.effective_end > now())
     ORDER BY cl.effective_start DESC LIMIT 1;
    v_found := FOUND;
  END IF;
  IF NOT v_found OR v_lic.plan_code = 'FREE' THEN
    RETURN jsonb_build_object('determined', true, 'plan_code', 'FREE', 'included_seats', 1, 'additional_seats', 0,
      'allowed_named_users', 1, 'additional_seats_purchasable', false, 'source', 'FREE_PLAN');
  END IF;
  IF v_lic.plan_code NOT IN ('PRACTICE','FIRM','ENTERPRISE','PAID') THEN
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
  v_ok := v_included IS NOT NULL AND v_included >= 1 AND v_purchased IS NOT NULL AND v_purchased >= 0;
  RETURN jsonb_build_object('determined', v_ok, 'plan_code', v_lic.plan_code,
    'included_seats', v_included, 'additional_seats', v_purchased,
    'allowed_named_users', CASE WHEN v_ok THEN v_included + v_purchased END,
    'additional_seats_purchasable', v_lic.additional_seats_purchasable, 'source', v_source);
END;
$$
$mentitlementsabp$;

  EXECUTE $mentitlementsabq$
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
$$
$mentitlementsabq$;

  EXECUTE $mentitlementsabr$
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
$$
$mentitlementsabr$;

  EXECUTE $mentitlementsabs$
-- For the signed-in user (authenticated). Explanatory for the UI and callable by clients; never trusted alone.
CREATE OR REPLACE FUNCTION public.authorize_paid_action(p_company_id UUID, p_capability TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public._authorize_paid_action(auth.uid(), p_company_id, p_capability);
$$
$mentitlementsabs$;

  EXECUTE $mentitlementsabt$
-- For Edge Functions (service_role), which pass the user id they derived from the verified JWT.
CREATE OR REPLACE FUNCTION public.authorize_paid_action_for_user(p_user UUID, p_company_id UUID, p_capability TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public._authorize_paid_action(p_user, p_company_id, p_capability);
$$
$mentitlementsabt$;

  EXECUTE $mentitlementsabu$
-- For scheduled, system-initiated work with no user (service_role): is this workspace's account entitled?
CREATE OR REPLACE FUNCTION public.workspace_capability_entitled(p_company_id UUID, p_capability TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((public._resolve_entitlement_for_owner(
    (SELECT c.user_id FROM public.companies c WHERE c.id = p_company_id), p_capability))->>'status' = 'ENTITLED', false);
$$
$mentitlementsabu$;

  EXECUTE $mentitlementsabv$
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
$$
$mentitlementsabv$;

  EXECUTE $mentitlementsabw$
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
$$
$mentitlementsabw$;

  EXECUTE $mentitlementsabx$
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
$$
$mentitlementsabx$;

  EXECUTE $mentitlementsaby$
DROP TRIGGER IF EXISTS trg_sso_statement_certification_wall ON public.statement_sign_offs
$mentitlementsaby$;

  EXECUTE $mentitlementsabz$
CREATE TRIGGER trg_sso_statement_certification_wall
  BEFORE INSERT OR UPDATE ON public.statement_sign_offs
  FOR EACH ROW EXECUTE FUNCTION public.statement_sign_off_certification_wall()
$mentitlementsabz$;

  EXECUTE $mentitlementsaca$
-- A report version newly marked FINAL is a certified close.
CREATE OR REPLACE FUNCTION public.financial_statement_final_certification_wall()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.state = 'FINAL' THEN
    PERFORM public._require_workspace_capability(NEW.company_id, 'STATEMENT_CERTIFICATION');
  END IF;
  RETURN NEW;
END;
$$
$mentitlementsaca$;

  EXECUTE $mentitlementsacb$
DROP TRIGGER IF EXISTS trg_fsp_statement_certification_wall ON public.financial_statement_publications
$mentitlementsacb$;

  EXECUTE $mentitlementsacc$
CREATE TRIGGER trg_fsp_statement_certification_wall
  BEFORE INSERT ON public.financial_statement_publications
  FOR EACH ROW EXECUTE FUNCTION public.financial_statement_final_certification_wall()
$mentitlementsacc$;

  EXECUTE $mentitlementsacd$
-- ── 8. Close Insights wall ───────────────────────────────────────────────────────────────────
-- Every Close Insights table carries its workspace (company_id NOT NULL).
CREATE OR REPLACE FUNCTION public.close_insights_wall()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public._require_workspace_capability(NEW.company_id, 'CLOSE_INSIGHTS');
  RETURN NEW;
END;
$$
$mentitlementsacd$;

  EXECUTE $mentitlementsace$
DROP TRIGGER IF EXISTS trg_close_insights_wall ON public.variance_runs
$mentitlementsace$;

  EXECUTE $mentitlementsacf$
CREATE TRIGGER trg_close_insights_wall BEFORE INSERT ON public.variance_runs FOR EACH ROW EXECUTE FUNCTION public.close_insights_wall()
$mentitlementsacf$;

  EXECUTE $mentitlementsacg$
DROP TRIGGER IF EXISTS trg_close_insights_wall ON public.maono_insights
$mentitlementsacg$;

  EXECUTE $mentitlementsach$
CREATE TRIGGER trg_close_insights_wall BEFORE INSERT ON public.maono_insights FOR EACH ROW EXECUTE FUNCTION public.close_insights_wall()
$mentitlementsach$;

  EXECUTE $mentitlementsaci$
DROP TRIGGER IF EXISTS trg_close_insights_wall ON public.cashflow_forecasts
$mentitlementsaci$;

  EXECUTE $mentitlementsacj$
CREATE TRIGGER trg_close_insights_wall BEFORE INSERT ON public.cashflow_forecasts FOR EACH ROW EXECUTE FUNCTION public.close_insights_wall()
$mentitlementsacj$;

  EXECUTE $mentitlementsack$
DROP TRIGGER IF EXISTS trg_close_insights_wall ON public.variance_alerts
$mentitlementsack$;

  EXECUTE $mentitlementsacl$
CREATE TRIGGER trg_close_insights_wall BEFORE INSERT ON public.variance_alerts FOR EACH ROW EXECUTE FUNCTION public.close_insights_wall()
$mentitlementsacl$;

  EXECUTE $mentitlementsacm$
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
  CONSTRAINT chk_rpi_kind CHECK (pack_kind IN ('financial_statements_pdf', 'financial_statements_spreadsheet', 'financial_statements_data', 'filing_pack', 'client_pack', 'board_pack', 'management_letter', 'disclosure_notes', 'tax_computation', 'tax_workpaper')),
  CONSTRAINT uq_rpi_request UNIQUE (company_id, issued_by, request_id)
)
$mentitlementsacm$;

  EXECUTE $mentitlementsacn$
CREATE INDEX idx_rpi_company_period ON public.reporting_pack_issuances (company_id, period_year, issued_at DESC)
$mentitlementsacn$;

  EXECUTE $mentitlementsaco$
ALTER TABLE public.reporting_pack_issuances ENABLE ROW LEVEL SECURITY
$mentitlementsaco$;

  EXECUTE $mentitlementsacp$
-- Workspace-scoped read for the signed-in user; used by RLS, so the querying role executes it (it only ever
-- answers for auth.uid()).
CREATE OR REPLACE FUNCTION public.can_access_workspace(p_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public._workspace_access_basis(auth.uid(), p_company_id) IS NOT NULL;
$$
$mentitlementsacp$;

  EXECUTE $mentitlementsacq$
CREATE POLICY "rpi_select_workspace" ON public.reporting_pack_issuances FOR SELECT USING (public.can_access_workspace(company_id))
$mentitlementsacq$;

  EXECUTE $mentitlementsacr$
REVOKE ALL ON public.reporting_pack_issuances FROM PUBLIC, anon, authenticated
$mentitlementsacr$;

  EXECUTE $mentitlementsacs$
GRANT SELECT ON public.reporting_pack_issuances TO authenticated
$mentitlementsacs$;

  EXECUTE $mentitlementsact$
GRANT SELECT ON public.reporting_pack_issuances TO service_role
$mentitlementsact$;

  EXECUTE $mentitlementsacu$
CREATE OR REPLACE FUNCTION public.reporting_pack_issuances_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: reporting_pack_issuances is append-only (% refused).', TG_OP USING ERRCODE = 'P0001';
END;
$$
$mentitlementsacu$;

  EXECUTE $mentitlementsacv$
CREATE TRIGGER trg_rpi_immutable BEFORE UPDATE OR DELETE ON public.reporting_pack_issuances
  FOR EACH ROW EXECUTE FUNCTION public.reporting_pack_issuances_immutable()
$mentitlementsacv$;

  EXECUTE $mentitlementsacw$
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
     OR p_pack_kind IS NULL OR p_pack_kind NOT IN ('financial_statements_pdf', 'financial_statements_spreadsheet', 'financial_statements_data', 'filing_pack', 'client_pack', 'board_pack', 'management_letter', 'disclosure_notes', 'tax_computation', 'tax_workpaper') THEN
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
$$
$mentitlementsacw$;

  EXECUTE $mentitlementsacx$
-- ── 10. Entity Capacity wall ─────────────────────────────────────────────────────────────────
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS creation_request_id UUID NULL
$mentitlementsacx$;

  EXECUTE $mentitlementsacy$
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_creation_request
  ON public.companies (user_id, creation_request_id) WHERE creation_request_id IS NOT NULL
$mentitlementsacy$;

  EXECUTE $mentitlementsacz$
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
$$
$mentitlementsacz$;

  EXECUTE $mentitlementsada$
DROP TRIGGER IF EXISTS trg_companies_entity_capacity ON public.companies
$mentitlementsada$;

  EXECUTE $mentitlementsadb$
CREATE TRIGGER trg_companies_entity_capacity
  BEFORE INSERT OR UPDATE OF is_active, user_id ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.company_entity_capacity_wall()
$mentitlementsadb$;

  EXECUTE $mentitlementsadc$
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
$$
$mentitlementsadc$;

  EXECUTE $mentitlementsadd$
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
$$
$mentitlementsadd$;

  EXECUTE $mentitlementsade$
-- ── 10b. Named-user seat wall ────────────────────────────────────────────────────────────────
-- A named user is a distinct HUMAN account (auth.users) with a place on any of the billing account's workspaces:
--   the account holder itself (always, the included seat) ∪ firm_members (pending invitations reserve a seat) ∪
--   active workspace_capability_grants.
-- Service identities, the service role, internal system actors and scheduled jobs never hold a membership or grant
-- row, so they are never counted. Every human signs in with their own account; nothing here supports sharing one.
--   reserved = every membership row (pending or accepted) + active grants   -> bounds invitations and additions
--   active   = accepted memberships + active grants                          -> bounds activation (acceptance)
CREATE OR REPLACE FUNCTION public._account_named_users(
  p_account UUID, p_include_pending BOOLEAN, p_exclude_member UUID DEFAULT NULL, p_exclude_grant UUID DEFAULT NULL)
RETURNS TABLE (named_user_id UUID) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p_account WHERE p_account IS NOT NULL
  UNION
  SELECT fm.user_id FROM public.firm_members fm JOIN public.companies c ON c.id = fm.company_id
   WHERE c.user_id = p_account AND (p_include_pending OR fm.accepted_at IS NOT NULL) AND fm.id IS DISTINCT FROM p_exclude_member
  UNION
  SELECT g.grantee_user_id FROM public.workspace_capability_grants g JOIN public.companies c ON c.id = g.company_id
   WHERE c.user_id = p_account AND g.revoked_at IS NULL AND g.id IS DISTINCT FROM p_exclude_grant;
$$
$mentitlementsade$;

  EXECUTE $mentitlementsadf$
-- Fires when a person is newly invited, added, moved onto a workspace, granted access, or activated (an invitation
-- accepted). Serialised per billing account with a transaction-scoped advisory lock, so simultaneous invitations,
-- acceptances and grants cannot exceed the allowance. Removals, revocations, role changes and every other update
-- are never blocked, and nothing is ever deleted: after an expiry or downgrade, existing members keep exactly the
-- access they had; only NEW people (and pending invitations beyond the allowance) are refused.
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
BEGIN
  IF TG_TABLE_NAME = 'firm_members' THEN
    v_user := NEW.user_id; v_member := NEW.id;
    IF TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      v_adds := true; v_activates := NEW.accepted_at IS NOT NULL;
    ELSIF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
      v_activates := true;
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
$mentitlementsadf$;

  EXECUTE $mentitlementsadg$
DROP TRIGGER IF EXISTS trg_firm_members_named_user_seats ON public.firm_members
$mentitlementsadg$;

  EXECUTE $mentitlementsadh$
CREATE TRIGGER trg_firm_members_named_user_seats
  BEFORE INSERT OR UPDATE OF user_id, company_id, accepted_at ON public.firm_members
  FOR EACH ROW EXECUTE FUNCTION public.named_user_seat_wall()
$mentitlementsadh$;

  EXECUTE $mentitlementsadi$
DROP TRIGGER IF EXISTS trg_wcg_named_user_seats ON public.workspace_capability_grants
$mentitlementsadi$;

  EXECUTE $mentitlementsadj$
CREATE TRIGGER trg_wcg_named_user_seats
  BEFORE INSERT OR UPDATE OF grantee_user_id, company_id, revoked_at ON public.workspace_capability_grants
  FOR EACH ROW EXECUTE FUNCTION public.named_user_seat_wall()
$mentitlementsadj$;

  EXECUTE $mentitlementsadk$
-- Seat state of a workspace's billing account, for anyone with access to that workspace (explanatory only).
CREATE OR REPLACE FUNCTION public.get_workspace_seat_capacity(p_company_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_account UUID;
BEGIN
  IF auth.uid() IS NULL OR public._workspace_access_basis(auth.uid(), p_company_id) IS NULL THEN
    RETURN jsonb_build_object('access', false);
  END IF;
  SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
  RETURN public._seat_capacity_for_account(v_account) || jsonb_build_object('access', true,
    'active_named_users', (SELECT count(*) FROM public._account_named_users(v_account, false)),
    'reserved_named_users', (SELECT count(*) FROM public._account_named_users(v_account, true)));
END;
$$
$mentitlementsadk$;

  EXECUTE $mentitlementsadl$
-- Pre-check for the invitation Edge Function (service_role), BEFORE any email is sent or account created. The seat
-- wall above remains the authority; this only avoids sending an invitation that could never be recorded.
-- p_invitee NULL = a person without an account yet (always a new named user).
-- Codes: ALLOWED | ALREADY_A_NAMED_USER | SEAT_LIMIT_REACHED | SEAT_CAPACITY_UNDETERMINED | WORKSPACE_NOT_FOUND
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
$mentitlementsadl$;

  EXECUTE $mentitlementsadm$
-- Accepts the signed-in user's pending invitations one by one (runs as the caller; RLS and the seat wall apply).
-- An invitation the inviting account has no seat for stays pending (nothing is deleted) and is reported by code.
CREATE OR REPLACE FUNCTION public.accept_workspace_invitations()
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user     UUID := auth.uid();
  r          RECORD;
  v_hint     TEXT;
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
      v_accepted := v_accepted || jsonb_build_array(r.company_id);
    EXCEPTION WHEN SQLSTATE 'PT402' THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      v_blocked := v_blocked || jsonb_build_array(jsonb_build_object('company_id', r.company_id,
        'code', CASE WHEN v_hint = 'UNDETERMINED' THEN 'SEAT_CAPACITY_UNDETERMINED' ELSE 'SEAT_LIMIT_REACHED' END));
    END;
  END LOOP;
  RETURN jsonb_build_object('outcome', 'ok', 'accepted', v_accepted, 'blocked', v_blocked);
END;
$$
$mentitlementsadm$;

  EXECUTE $mentitlementsadn$
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
  IF v_cap = 'NAMED_USER_SEATS' THEN RAISE EXCEPTION 'USE_ADMIN_GRANT_NAMED_USER_SEATS_OVERRIDE' USING ERRCODE = '22023'; END IF;
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
$$
$mentitlementsadn$;

  EXECUTE $mentitlementsado$
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
$$
$mentitlementsado$;

  EXECUTE $mentitlementsadp$
-- The negotiated included named users of an account (e.g. an Enterprise contract). Ignored on Free.
CREATE OR REPLACE FUNCTION public.admin_grant_named_user_seats_override(
  p_billing_customer_id UUID, p_included_seats INTEGER, p_reason TEXT, p_effective_end TIMESTAMPTZ)
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
  IF p_included_seats IS NULL OR p_included_seats < 1 THEN RAISE EXCEPTION 'INVALID_SEAT_QUANTITY' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.billing_customers WHERE id = p_billing_customer_id) THEN
    RAISE EXCEPTION 'BILLING_CUSTOMER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, capacity_value, granted_by, reason, effective_start, effective_end)
  VALUES (p_billing_customer_id, 'NAMED_USER_SEATS', p_included_seats, v_user_id, p_reason, now(), p_effective_end) RETURNING id INTO v_override_id;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (p_billing_customer_id, v_user_id, 'ENTITLEMENT_OVERRIDE_GRANTED', NULL,
          jsonb_build_object('override_id', v_override_id, 'feature_code', 'NAMED_USER_SEATS', 'included_seats', p_included_seats, 'effective_end', p_effective_end), p_reason);
  RETURN jsonb_build_object('override_id', v_override_id);
END;
$$
$mentitlementsadp$;

  EXECUTE $mentitlementsadq$
-- Records the purchased additional named-user seats on a licence (until a payment provider records them). This does
-- not take or pretend any payment. Refused on a Free licence; a reduction never removes anyone.
CREATE OR REPLACE FUNCTION public.admin_set_licence_additional_seats(p_licence_id UUID, p_quantity INTEGER, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_lic     RECORD;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_quantity IS NULL OR p_quantity < 0 OR p_quantity > 10000 THEN RAISE EXCEPTION 'INVALID_SEAT_QUANTITY' USING ERRCODE = '22023'; END IF;
  SELECT cl.id, cl.billing_customer_id, cl.additional_seats, cp.code AS plan_code INTO v_lic
    FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE cl.id = p_licence_id FOR UPDATE OF cl;
  IF NOT FOUND THEN RAISE EXCEPTION 'LICENCE_NOT_FOUND' USING ERRCODE = '22023'; END IF;
  IF v_lic.plan_code = 'FREE' THEN RAISE EXCEPTION 'FREE_PLAN_HAS_NO_ADDITIONAL_SEATS' USING ERRCODE = '22023'; END IF;
  UPDATE public.commercial_licences SET additional_seats = p_quantity, updated_at = now() WHERE id = p_licence_id;
  INSERT INTO public.billing_audit_events (billing_customer_id, actor_user_id, action, previous_state, new_state, reason)
  VALUES (v_lic.billing_customer_id, v_user_id, 'LICENCE_ADDITIONAL_SEATS_SET',
          jsonb_build_object('licence_id', p_licence_id, 'additional_seats', v_lic.additional_seats),
          jsonb_build_object('licence_id', p_licence_id, 'additional_seats', p_quantity), p_reason);
  RETURN jsonb_build_object('licence_id', p_licence_id, 'additional_seats', p_quantity);
END;
$$
$mentitlementsadq$;

  EXECUTE $mentitlementsadr$
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
$$
$mentitlementsadr$;

  EXECUTE $mentitlementsads$
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
$$
$mentitlementsads$;

  EXECUTE $mentitlementsadt$
-- ── 13. Privileges ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.commercial_canonical_capability(TEXT) FROM PUBLIC, anon, authenticated
$mentitlementsadt$;

  EXECUTE $mentitlementsadu$
REVOKE ALL ON FUNCTION public._resolve_entitlement_for_owner(UUID, TEXT) FROM PUBLIC, anon, authenticated
$mentitlementsadu$;

  EXECUTE $mentitlementsadv$
REVOKE ALL ON FUNCTION public._entity_capacity_for_account(UUID) FROM PUBLIC, anon, authenticated
$mentitlementsadv$;

  EXECUTE $mentitlementsadw$
REVOKE ALL ON FUNCTION public._workspace_access_basis(UUID, UUID) FROM PUBLIC, anon, authenticated
$mentitlementsadw$;

  EXECUTE $mentitlementsadx$
REVOKE ALL ON FUNCTION public._authorize_paid_action(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated
$mentitlementsadx$;

  EXECUTE $mentitlementsady$
REVOKE ALL ON FUNCTION public._require_workspace_capability(UUID, TEXT) FROM PUBLIC, anon, authenticated
$mentitlementsady$;

  EXECUTE $mentitlementsadz$
REVOKE ALL ON FUNCTION public.statement_sign_off_certification_wall() FROM PUBLIC, anon, authenticated
$mentitlementsadz$;

  EXECUTE $mentitlementsaea$
REVOKE ALL ON FUNCTION public.financial_statement_final_certification_wall() FROM PUBLIC, anon, authenticated
$mentitlementsaea$;

  EXECUTE $mentitlementsaeb$
REVOKE ALL ON FUNCTION public.close_insights_wall() FROM PUBLIC, anon, authenticated
$mentitlementsaeb$;

  EXECUTE $mentitlementsaec$
REVOKE ALL ON FUNCTION public.company_entity_capacity_wall() FROM PUBLIC, anon, authenticated
$mentitlementsaec$;

  EXECUTE $mentitlementsaed$
REVOKE ALL ON FUNCTION public.reporting_pack_issuances_immutable() FROM PUBLIC, anon, authenticated
$mentitlementsaed$;

  EXECUTE $mentitlementsaee$
REVOKE ALL ON FUNCTION public.authorize_paid_action_for_user(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated
$mentitlementsaee$;

  EXECUTE $mentitlementsaef$
REVOKE ALL ON FUNCTION public.workspace_capability_entitled(UUID, TEXT) FROM PUBLIC, anon, authenticated
$mentitlementsaef$;

  EXECUTE $mentitlementsaeg$
GRANT EXECUTE ON FUNCTION public.authorize_paid_action_for_user(UUID, UUID, TEXT) TO service_role
$mentitlementsaeg$;

  EXECUTE $mentitlementsaeh$
GRANT EXECUTE ON FUNCTION public.workspace_capability_entitled(UUID, TEXT) TO service_role
$mentitlementsaeh$;

  EXECUTE $mentitlementsaei$
REVOKE ALL ON FUNCTION public.authorize_paid_action(UUID, TEXT) FROM PUBLIC, anon
$mentitlementsaei$;

  EXECUTE $mentitlementsaej$
GRANT EXECUTE ON FUNCTION public.authorize_paid_action(UUID, TEXT) TO authenticated
$mentitlementsaej$;

  EXECUTE $mentitlementsaek$
REVOKE ALL ON FUNCTION public.get_workspace_commercial_state(UUID) FROM PUBLIC, anon
$mentitlementsaek$;

  EXECUTE $mentitlementsael$
GRANT EXECUTE ON FUNCTION public.get_workspace_commercial_state(UUID) TO authenticated
$mentitlementsael$;

  EXECUTE $mentitlementsaem$
REVOKE ALL ON FUNCTION public.can_access_workspace(UUID) FROM PUBLIC, anon
$mentitlementsaem$;

  EXECUTE $mentitlementsaen$
GRANT EXECUTE ON FUNCTION public.can_access_workspace(UUID) TO authenticated
$mentitlementsaen$;

  EXECUTE $mentitlementsaeo$
REVOKE ALL ON FUNCTION public.issue_reporting_pack(UUID, INTEGER, TEXT, UUID) FROM PUBLIC, anon
$mentitlementsaeo$;

  EXECUTE $mentitlementsaep$
GRANT EXECUTE ON FUNCTION public.issue_reporting_pack(UUID, INTEGER, TEXT, UUID) TO authenticated
$mentitlementsaep$;

  EXECUTE $mentitlementsaeq$
REVOKE ALL ON FUNCTION public.get_my_entity_capacity() FROM PUBLIC, anon
$mentitlementsaeq$;

  EXECUTE $mentitlementsaer$
GRANT EXECUTE ON FUNCTION public.get_my_entity_capacity() TO authenticated
$mentitlementsaer$;

  EXECUTE $mentitlementsaes$
REVOKE ALL ON FUNCTION public.create_entity(UUID, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon
$mentitlementsaes$;

  EXECUTE $mentitlementsaet$
GRANT EXECUTE ON FUNCTION public.create_entity(UUID, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated
$mentitlementsaet$;

  EXECUTE $mentitlementsaeu$
REVOKE ALL ON FUNCTION public.admin_grant_entitlement_override(UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon
$mentitlementsaeu$;

  EXECUTE $mentitlementsaev$
GRANT EXECUTE ON FUNCTION public.admin_grant_entitlement_override(UUID, TEXT, TEXT, TIMESTAMPTZ) TO authenticated
$mentitlementsaev$;

  EXECUTE $mentitlementsaew$
REVOKE ALL ON FUNCTION public.admin_grant_entity_capacity_override(UUID, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon
$mentitlementsaew$;

  EXECUTE $mentitlementsaex$
GRANT EXECUTE ON FUNCTION public.admin_grant_entity_capacity_override(UUID, INTEGER, TEXT, TIMESTAMPTZ) TO authenticated
$mentitlementsaex$;

  EXECUTE $mentitlementsaey$
REVOKE ALL ON FUNCTION public.get_effective_entitlement(UUID, TEXT) FROM PUBLIC, anon
$mentitlementsaey$;

  EXECUTE $mentitlementsaez$
GRANT EXECUTE ON FUNCTION public.get_effective_entitlement(UUID, TEXT) TO authenticated
$mentitlementsaez$;

  EXECUTE $mentitlementsafa$
REVOKE ALL ON FUNCTION public._seat_capacity_for_account(UUID) FROM PUBLIC, anon, authenticated
$mentitlementsafa$;

  EXECUTE $mentitlementsafb$
REVOKE ALL ON FUNCTION public._account_named_users(UUID, BOOLEAN, UUID, UUID) FROM PUBLIC, anon, authenticated
$mentitlementsafb$;

  EXECUTE $mentitlementsafc$
REVOKE ALL ON FUNCTION public.named_user_seat_wall() FROM PUBLIC, anon, authenticated
$mentitlementsafc$;

  EXECUTE $mentitlementsafd$
REVOKE ALL ON FUNCTION public.seat_check_for_invitation(UUID, UUID) FROM PUBLIC, anon, authenticated
$mentitlementsafd$;

  EXECUTE $mentitlementsafe$
GRANT EXECUTE ON FUNCTION public.seat_check_for_invitation(UUID, UUID) TO service_role
$mentitlementsafe$;

  EXECUTE $mentitlementsaff$
REVOKE ALL ON FUNCTION public.get_workspace_seat_capacity(UUID) FROM PUBLIC, anon
$mentitlementsaff$;

  EXECUTE $mentitlementsafg$
GRANT EXECUTE ON FUNCTION public.get_workspace_seat_capacity(UUID) TO authenticated
$mentitlementsafg$;

  EXECUTE $mentitlementsafh$
REVOKE ALL ON FUNCTION public.accept_workspace_invitations() FROM PUBLIC, anon
$mentitlementsafh$;

  EXECUTE $mentitlementsafi$
GRANT EXECUTE ON FUNCTION public.accept_workspace_invitations() TO authenticated
$mentitlementsafi$;

  EXECUTE $mentitlementsafj$
REVOKE ALL ON FUNCTION public.admin_grant_named_user_seats_override(UUID, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon
$mentitlementsafj$;

  EXECUTE $mentitlementsafk$
GRANT EXECUTE ON FUNCTION public.admin_grant_named_user_seats_override(UUID, INTEGER, TEXT, TIMESTAMPTZ) TO authenticated
$mentitlementsafk$;

  EXECUTE $mentitlementsafl$
REVOKE ALL ON FUNCTION public.admin_set_licence_additional_seats(UUID, INTEGER, TEXT) FROM PUBLIC, anon
$mentitlementsafl$;

  EXECUTE $mentitlementsafm$
GRANT EXECUTE ON FUNCTION public.admin_set_licence_additional_seats(UUID, INTEGER, TEXT) TO authenticated
$mentitlementsafm$;

  EXECUTE $mentitlementsafn$
REVOKE ALL ON FUNCTION public.hesabu_block_signoff() FROM PUBLIC
$mentitlementsafn$;

  EXECUTE $mentitlementsafo$
GRANT EXECUTE ON FUNCTION public.hesabu_block_signoff() TO authenticated
$mentitlementsafo$;

  EXECUTE $mentitlementsafp$
-- ── 14. Deterministic catalogue proof (the migration fails if the state is not exactly this) ──
DO $assert$
DECLARE
  v RECORD;
BEGIN
  FOR v IN SELECT * FROM (VALUES
      ('FREE',       1,    1,    false, 'free',          false),
      ('PRACTICE',   5,    1,    true,  'self_serve',    true),
      ('FIRM',       25,   1,    true,  'self_serve',    true),
      ('ENTERPRISE', NULL, NULL, false, 'contact_sales', true)) AS e(code, entities, seats, buy_seats, mode, paid) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.commercial_plans cp JOIN public.commercial_products p ON p.id = cp.product_id AND p.code = 'CFOCLOSE'
       WHERE cp.code = v.code AND cp.entity_capacity IS NOT DISTINCT FROM v.entities AND cp.included_seats IS NOT DISTINCT FROM v.seats
         AND cp.additional_seats_purchasable = v.buy_seats AND cp.sales_mode = v.mode AND cp.is_public
         AND (cp.feature_codes @> ARRAY['STATEMENT_CERTIFICATION','REPORTING_PACK_EXPORT','CLOSE_INSIGHTS']::TEXT[]) = v.paid
         AND cp.feature_codes @> ARRAY['CLOSE_ASSURANCE','COMPARATIVE_REPORTING','ENTITY_CAPACITY','NAMED_USER_SEATS']::TEXT[]) THEN
      RAISE EXCEPTION 'CATALOGUE_ASSERTION_FAILED: plan %', v.code;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.commercial_additional_seat_prices s JOIN public.commercial_plans cp ON cp.id = s.plan_id
       WHERE s.is_active AND NOT s.is_purchasable AND s.currency_code = 'USD' AND s.market_code = 'GLOBAL'
         AND ((cp.code, s.billing_interval, s.amount_minor) IN (('PRACTICE','MONTHLY',2000), ('PRACTICE','ANNUAL',20000), ('FIRM','MONTHLY',2000), ('FIRM','ANNUAL',20000))))
     <> 4
     OR EXISTS (SELECT 1 FROM public.commercial_additional_seat_prices s JOIN public.commercial_plans cp ON cp.id = s.plan_id WHERE cp.code NOT IN ('PRACTICE','FIRM')) THEN
    RAISE EXCEPTION 'CATALOGUE_ASSERTION_FAILED: additional seat prices';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commercial_licences WHERE additional_seats <> 0) THEN
    RAISE EXCEPTION 'CATALOGUE_ASSERTION_FAILED: no additional seat was ever sold, so every existing licence must carry 0';
  END IF;
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
$assert$
$mentitlementsafp$;
END
$cfoclose_entitlements$;
