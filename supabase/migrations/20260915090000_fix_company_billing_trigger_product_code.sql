-- 20260915090000_fix_company_billing_trigger_product_code.sql
--
-- TARGETED TRIGGER REPAIR — provision_billing_customer_for_company
--
-- ROOT CAUSE (proven by live 23502 evidence + read-only DB probes):
--   Migration 20260905093408 created provision_billing_customer_for_company()
--   referencing product code 'SAFF_ERP'.
--   Migration 20260912100000 renamed that product to 'CFOCLOSE' (UUID unchanged).
--   The trigger function was not updated.
--   Live DB: SAFF_ERP absent → v_product_id = NULL → billing_customers.product_id
--   NOT NULL violated → 23502 → companies INSERT rolls back.
--
-- SCOPE:
--   A. Fail-closed preflights (read-only assertions — change nothing on failure)
--   B. CREATE OR REPLACE provision_billing_customer_for_company() — CFOCLOSE only
--   C. Privilege revocation (REVOKE ALL FROM PUBLIC, anon, authenticated)
--   D. Postcondition assertions
--
-- INVARIANTS:
--   - Does NOT seed commercial_products
--   - Does NOT seed commercial_plans
--   - Does NOT backfill licences
--   - Does NOT mutate companies
--   - Does NOT alter payment state or commercial_platform_state
--   - Does NOT grant a paid licence
--   - Does NOT drop or recreate the trigger
--   - Does NOT amend any prior migration
--   - Forward-only

SET search_path TO public, pg_catalog;

-- ── A. FAIL-CLOSED PREFLIGHTS ─────────────────────────────────────────────────
-- If any invariant fails, raise EXCEPTION and abort. Nothing changes.

DO $$
DECLARE
  v_cfoclose_count     INTEGER;
  v_saff_erp_count     INTEGER;
  v_free_plan_count    INTEGER;
  v_bc_product_notnull TEXT;
  v_trigger_exists     INTEGER;
  v_trigger_enabled    TEXT;
  v_trigger_fn         TEXT;
BEGIN
  -- P1: exactly one CFOCLOSE product
  SELECT COUNT(*) INTO v_cfoclose_count
    FROM public.commercial_products WHERE code = 'CFOCLOSE';
  IF v_cfoclose_count <> 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED P1: expected exactly 1 commercial_products row with code=CFOCLOSE, found %',
      v_cfoclose_count;
  END IF;

  -- P2: zero SAFF_ERP rows (confirms rename was applied)
  SELECT COUNT(*) INTO v_saff_erp_count
    FROM public.commercial_products WHERE code = 'SAFF_ERP';
  IF v_saff_erp_count <> 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED P2: expected 0 commercial_products rows with code=SAFF_ERP, found %',
      v_saff_erp_count;
  END IF;

  -- P3: exactly one active FREE plan belonging to the CFOCLOSE product
  SELECT COUNT(*) INTO v_free_plan_count
    FROM public.commercial_plans cp
    JOIN public.commercial_products prod ON prod.id = cp.product_id
   WHERE cp.code = 'FREE' AND prod.code = 'CFOCLOSE';
  IF v_free_plan_count <> 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED P3: expected exactly 1 FREE plan for CFOCLOSE product, found %',
      v_free_plan_count;
  END IF;

  -- P4: billing_customers.product_id must be NOT NULL
  SELECT is_nullable INTO v_bc_product_notnull
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'billing_customers'
     AND column_name  = 'product_id';
  IF v_bc_product_notnull IS NULL OR v_bc_product_notnull <> 'NO' THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED P4: billing_customers.product_id is_nullable=%, expected NO',
      v_bc_product_notnull;
  END IF;

  -- P5: trg_provision_billing_customer exists and is enabled on public.companies
  SELECT COUNT(*), MAX(tgenabled::text)
    INTO v_trigger_exists, v_trigger_enabled
    FROM pg_trigger
   WHERE tgrelid = 'public.companies'::regclass
     AND tgname  = 'trg_provision_billing_customer'
     AND NOT tgisinternal;
  IF v_trigger_exists <> 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED P5: trg_provision_billing_customer not found on public.companies';
  END IF;
  IF v_trigger_enabled NOT IN ('O', 'A') THEN
    -- 'O' = origin/local, 'A' = always (both mean "enabled")
    RAISE EXCEPTION
      'PREFLIGHT_FAILED P5: trg_provision_billing_customer is disabled (tgenabled=%)',
      v_trigger_enabled;
  END IF;

  -- P6: the trigger calls provision_billing_customer_for_company
  SELECT pg_get_triggerdef(oid, true) INTO v_trigger_fn
    FROM pg_trigger
   WHERE tgrelid = 'public.companies'::regclass
     AND tgname  = 'trg_provision_billing_customer'
     AND NOT tgisinternal;
  IF v_trigger_fn NOT LIKE '%provision_billing_customer_for_company%' THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED P6: trigger body does not reference provision_billing_customer_for_company: %',
      v_trigger_fn;
  END IF;

  RAISE NOTICE 'PREFLIGHTS PASSED: P1-P6 all confirmed';
END;
$$;


-- ── B. REPLACE TRIGGER FUNCTION ───────────────────────────────────────────────
-- Only change: SAFF_ERP → CFOCLOSE product code lookup.
-- All business logic, error handling, atomicity, and audit trail preserved.

CREATE OR REPLACE FUNCTION public.provision_billing_customer_for_company()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_billing_customer_id UUID;
  v_product_id          UUID;
  v_free_plan_id        UUID;
BEGIN
  -- Resolve existing billing customer for this owner.
  SELECT id INTO v_billing_customer_id
    FROM public.billing_customers
   WHERE owner_user_id = NEW.user_id
   LIMIT 1;

  IF v_billing_customer_id IS NULL THEN
    -- Resolve CFOCLOSE product (the canonical post-rename code).
    -- Explicit failure: a NULL product_id would produce a NOT NULL violation
    -- on billing_customers.product_id — fail here with a named error instead.
    SELECT id INTO v_product_id
      FROM public.commercial_products
     WHERE code = 'CFOCLOSE'
     LIMIT 1;

    IF v_product_id IS NULL THEN
      RAISE EXCEPTION
        'TRIGGER_CONFIG_ERROR: commercial_products has no row with code=CFOCLOSE. '
        'Apply the trigger-repair migration before inserting companies.';
    END IF;

    -- Insert billing customer. ON CONFLICT is intentional: a concurrent
    -- transaction may have already inserted one; DO NOTHING is safe because
    -- the SELECT below re-reads the winning row.
    INSERT INTO public.billing_customers (owner_user_id, product_id)
    VALUES (NEW.user_id, v_product_id)
    ON CONFLICT (owner_user_id) DO NOTHING;

    SELECT id INTO v_billing_customer_id
      FROM public.billing_customers
     WHERE owner_user_id = NEW.user_id
     LIMIT 1;
  END IF;

  -- Provision initial FREE licence if none exists yet.
  IF v_billing_customer_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.commercial_licences
        WHERE billing_customer_id = v_billing_customer_id
     )
  THEN
    -- Resolve active FREE plan for this customer's product.
    -- Explicit failure: avoids silent no-op if the plan was accidentally removed.
    SELECT cp.id INTO v_free_plan_id
      FROM public.commercial_plans cp
      JOIN public.billing_customers bc ON bc.product_id = cp.product_id
     WHERE bc.id = v_billing_customer_id
       AND cp.code = 'FREE'
     LIMIT 1;

    IF v_free_plan_id IS NULL THEN
      RAISE EXCEPTION
        'TRIGGER_CONFIG_ERROR: no FREE plan found for billing_customer_id=%. '
        'Ensure a FREE commercial_plans row exists for the CFOCLOSE product.',
        v_billing_customer_id;
    END IF;

    INSERT INTO public.commercial_licences (
      billing_customer_id, plan_id, status, source, effective_start, effective_end
    ) VALUES (
      v_billing_customer_id,
      v_free_plan_id,
      'ACTIVE',
      'SYSTEM_DEFAULT_FREE',
      now(),
      NULL        -- open-ended FREE licence
    );

    INSERT INTO public.billing_audit_events (
      billing_customer_id, actor_user_id, action,
      previous_state, new_state, reason
    ) VALUES (
      v_billing_customer_id,
      NULL,
      'FREE_LICENCE_AUTO_PROVISIONED',
      NULL,
      jsonb_build_object('plan_code', 'FREE', 'status', 'ACTIVE'),
      'Automatic FREE-plan enrollment on first company creation'
    );
  END IF;

  RETURN NEW;
END;
$$;


-- ── C. PRIVILEGE REVOCATION ───────────────────────────────────────────────────
-- Trigger functions execute under SECURITY DEFINER with the definer's grants;
-- no external role needs EXECUTE access.

REVOKE ALL ON FUNCTION public.provision_billing_customer_for_company()
  FROM PUBLIC, anon, authenticated;


-- ── D. POSTCONDITION ASSERTIONS ───────────────────────────────────────────────
-- Run after the replacement to prove the function is in the correct state.
-- Aborts the transaction if any check fails.

DO $$
DECLARE
  v_fn_source          TEXT;
  v_trigger_enabled    TEXT;
  v_cfoclose_count     INTEGER;
  v_free_plan_count    INTEGER;
BEGIN
  -- D1: function source contains CFOCLOSE
  SELECT pg_get_functiondef(p.oid) INTO v_fn_source
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'provision_billing_customer_for_company';

  IF v_fn_source NOT LIKE '%CFOCLOSE%' THEN
    RAISE EXCEPTION
      'POSTCONDITION_FAILED D1: function source does not contain CFOCLOSE';
  END IF;

  -- D2: function source does NOT contain SAFF_ERP
  IF v_fn_source LIKE '%SAFF_ERP%' THEN
    RAISE EXCEPTION
      'POSTCONDITION_FAILED D2: function source still contains SAFF_ERP';
  END IF;

  -- D3: trigger remains enabled
  SELECT MAX(tgenabled::text) INTO v_trigger_enabled
    FROM pg_trigger
   WHERE tgrelid = 'public.companies'::regclass
     AND tgname  = 'trg_provision_billing_customer'
     AND NOT tgisinternal;
  IF v_trigger_enabled NOT IN ('O', 'A') THEN
    RAISE EXCEPTION
      'POSTCONDITION_FAILED D3: trg_provision_billing_customer is disabled after repair';
  END IF;

  -- D4: exactly one CFOCLOSE product still exists
  SELECT COUNT(*) INTO v_cfoclose_count
    FROM public.commercial_products WHERE code = 'CFOCLOSE';
  IF v_cfoclose_count <> 1 THEN
    RAISE EXCEPTION
      'POSTCONDITION_FAILED D4: expected 1 CFOCLOSE product after repair, found %',
      v_cfoclose_count;
  END IF;

  -- D5: CFOCLOSE active FREE plan still exists
  SELECT COUNT(*) INTO v_free_plan_count
    FROM public.commercial_plans cp
    JOIN public.commercial_products prod ON prod.id = cp.product_id
   WHERE cp.code = 'FREE' AND prod.code = 'CFOCLOSE';
  IF v_free_plan_count <> 1 THEN
    RAISE EXCEPTION
      'POSTCONDITION_FAILED D5: expected 1 FREE plan for CFOCLOSE after repair, found %',
      v_free_plan_count;
  END IF;

  RAISE NOTICE 'POSTCONDITIONS PASSED: D1-D5 all confirmed';
END;
$$;
