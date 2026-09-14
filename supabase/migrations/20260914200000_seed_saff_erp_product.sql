-- 20260914200000_seed_saff_erp_product.sql
--
-- TARGETED FIX: provision_billing_customer_for_company trigger (23502 blocker)
--
-- The trigger fires AFTER INSERT on companies. It queries:
--   SELECT id INTO v_product_id FROM commercial_products WHERE code = 'SAFF_ERP';
-- If SAFF_ERP is missing, v_product_id = NULL, and the subsequent INSERT into
-- billing_customers (product_id NOT NULL) fails with PostgreSQL error 23502
-- (not_null_violation), rolling back the companies INSERT entirely.
--
-- This migration ensures SAFF_ERP and the FREE plan exist.
-- Idempotent: all inserts use ON CONFLICT DO NOTHING.
-- Forward-only. Does not amend any prior migration.

SET search_path TO public, pg_catalog;

-- Ensure the SAFF_ERP product exists
INSERT INTO public.commercial_products (code, name)
VALUES ('SAFF_ERP', 'SAFF ERP')
ON CONFLICT (code) DO NOTHING;

-- Ensure the FREE plan exists for SAFF_ERP
INSERT INTO public.commercial_plans (product_id, code, name, feature_codes)
SELECT id, 'FREE', 'Free', ARRAY['SAFISHA_PREVIEW','HESABU_REPORTING']::TEXT[]
FROM public.commercial_products
WHERE code = 'SAFF_ERP'
ON CONFLICT (product_id, code) DO NOTHING;

-- Ensure the PAID plan exists for SAFF_ERP
INSERT INTO public.commercial_plans (product_id, code, name, feature_codes)
SELECT id, 'PAID', 'Firm Licence', ARRAY[
  'SAFISHA_PREVIEW','SAFISHA_CERTIFY','HESABU_REPORTING','HESABU_EXPORT',
  'MAONO_INTELLIGENCE','MULTI_COMPANY','MULTI_PERIOD'
]::TEXT[]
FROM public.commercial_products
WHERE code = 'SAFF_ERP'
ON CONFLICT (product_id, code) DO NOTHING;

-- Back-fill: provision billing_customer rows for any existing companies
-- that were created before this seed existed. Idempotent.
INSERT INTO public.billing_customers (owner_user_id, product_id)
SELECT DISTINCT c.user_id, (SELECT id FROM public.commercial_products WHERE code = 'SAFF_ERP')
FROM public.companies c
WHERE (SELECT id FROM public.commercial_products WHERE code = 'SAFF_ERP') IS NOT NULL
ON CONFLICT (owner_user_id) DO NOTHING;

-- Back-fill: provision FREE licence for any billing_customers without one
INSERT INTO public.commercial_licences (
  billing_customer_id, plan_id, status, source, effective_start, effective_end
)
SELECT bc.id,
       (SELECT cp.id FROM public.commercial_plans cp
        WHERE cp.product_id = bc.product_id AND cp.code = 'FREE'),
       'ACTIVE', 'SYSTEM_DEFAULT_FREE', now(), NULL
FROM public.billing_customers bc
WHERE NOT EXISTS (
  SELECT 1 FROM public.commercial_licences cl WHERE cl.billing_customer_id = bc.id
)
AND (SELECT cp.id FROM public.commercial_plans cp
     WHERE cp.product_id = bc.product_id AND cp.code = 'FREE') IS NOT NULL;
