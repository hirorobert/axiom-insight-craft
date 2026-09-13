-- Lovable managed-migration ledger alias for the canonical Ω3.0 foundation.
--
-- Lovable executed the statements from
--   20260906120000_omega3_0_effective_history_and_platform_state.sql
-- through its managed SQL mechanism and recorded that execution under this
-- generated version. It then committed a second executable copy of the same
-- DDL here. Keeping both executable copies makes a clean ordered replay fail
-- at the second CREATE TABLE and also duplicates triggers and policies.
--
-- This file deliberately preserves Lovable's recorded migration version while
-- acting only as a fail-closed ledger alias on future clean replays. It does
-- not create, replace, alter, drop, insert, update, or delete anything.
--
-- Provenance:
--   original generated file SHA-256:
--     f9b20aebec427be664e7249cf420b1ec0957f40d8ae98d6346b9ae20316ba11b
--   canonical prerequisite SHA-256 at reconciliation:
--     3ad41a7cf2280843d49176b20976395b5cff5bdb10f6abe14b734431cb9f11c7

SET search_path TO public, pg_catalog;

DO $omega3_ledger_alias$
DECLARE
  v_item       RECORD;
  v_count      INTEGER;
  v_function   REGPROCEDURE;
BEGIN
  IF to_regclass('public.commercial_currencies') IS NULL THEN
    RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_MISSING_RELATION: public.commercial_currencies';
  END IF;

  IF to_regclass('public.commercial_platform_state') IS NULL THEN
    RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_MISSING_RELATION: public.commercial_platform_state';
  END IF;

  IF to_regclass('public.commercial_offers') IS NULL THEN
    RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_MISSING_RELATION: public.commercial_offers';
  END IF;

  FOR v_item IN
    SELECT * FROM (VALUES
      ('effective_range'),
      ('effective_history_protected'),
      ('request_fingerprint')
    ) AS required(column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'commercial_offers'
         AND a.attname = v_item.column_name
         AND a.attnum > 0
         AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_MISSING_COLUMN: public.commercial_offers.%',
        v_item.column_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'commercial_offers'
       AND con.conname = 'excl_co_no_overlapping_purchasable_periods'
       AND con.contype = 'x'
  ) THEN
    RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_MISSING_CONSTRAINT: excl_co_no_overlapping_purchasable_periods';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'commercial_catalog_audit_events'
       AND con.conname = 'chk_ccae_entity_type'
       AND con.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_MISSING_CONSTRAINT: chk_ccae_entity_type';
  END IF;

  IF to_regclass('public.uq_co_current_offer') IS NULL THEN
    RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_MISSING_INDEX: public.uq_co_current_offer';
  END IF;

  FOR v_item IN
    SELECT * FROM (VALUES
      ('trg_commercial_offers_effective_history_ratchet'),
      ('trg_commercial_offers_economic_integrity')
    ) AS required(trigger_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = 'commercial_offers'
         AND t.tgname = v_item.trigger_name
         AND NOT t.tgisinternal
         AND t.tgenabled <> 'D'
    ) THEN
      RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_MISSING_OR_DISABLED_TRIGGER: %',
        v_item.trigger_name;
    END IF;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    to_regprocedure('public.commercial_offers_effective_history_ratchet()'),
    to_regprocedure('public.commercial_offers_economic_integrity()'),
    to_regprocedure('public.admin_supersede_commercial_offer(text,text,text,text,text,bigint,smallint,text,smallint,timestamp with time zone,text)'),
    to_regprocedure('public.admin_transition_platform_state(text,text)')
  ]
  LOOP
    IF v_function IS NULL THEN
      RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_MISSING_FUNCTION';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc p
       WHERE p.oid = v_function
         AND p.prosecdef
         AND COALESCE(p.proconfig, ARRAY[]::TEXT[])
             @> ARRAY['search_path=public, pg_catalog']::TEXT[]
    ) THEN
      RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_INSECURE_FUNCTION: %', v_function;
    END IF;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    to_regprocedure('public.commercial_offers_effective_history_ratchet()'),
    to_regprocedure('public.commercial_offers_economic_integrity()')
  ]
  LOOP
    -- anon/authenticated inheriting EXECUTE through PUBLIC is also detected.
    IF has_function_privilege('anon', v_function, 'EXECUTE')
       OR has_function_privilege('authenticated', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_TRIGGER_FUNCTION_EXECUTE_EXPOSED: %',
        v_function;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_count
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND (
       (c.relname = 'commercial_currencies' AND pol.polname = 'cc_select_public')
       OR
       (c.relname = 'commercial_platform_state' AND pol.polname = 'cps_select_admin_only')
     );

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_POLICY_SET_INVALID: expected 2, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM (VALUES
      ('TZS', 0::SMALLINT),
      ('USD', 2::SMALLINT),
      ('KES', 2::SMALLINT),
      ('GBP', 2::SMALLINT),
      ('EUR', 2::SMALLINT)
    ) AS expected(code, exponent)
    LEFT JOIN public.commercial_currencies actual
      ON actual.code = expected.code
     AND actual.exponent = expected.exponent
     AND actual.is_supported
   WHERE actual.code IS NULL;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_CURRENCY_REGISTRY_INVALID: % missing or unsupported',
      v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.commercial_platform_state
   WHERE id = true
     AND state IN (
       'PAYMENTS_DISABLED',
       'SANDBOX_ONLY',
       'LIVE_ACCEPTANCE',
       'CUSTOMER_PAYMENTS_ENABLED'
     );

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'OMEGA3_LEDGER_ALIAS_PLATFORM_SINGLETON_INVALID: expected 1, found %',
      v_count;
  END IF;
END;
$omega3_ledger_alias$;
