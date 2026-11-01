-- 20261212100000_legacy_financial_write_revocation.sql — the legacy tax tables become server-written only (forward-only; nothing edited).
--
-- Defect closed (independent readiness assessment 2026-11-01, CF-03): public.tax_computations (the tax computation's
-- canonical output), public.tax_payments, public.capital_allowances and public.management_inputs were writable from the
-- browser by any accepted member through PostgREST: table grants of INSERT, UPDATE and DELETE to `authenticated`
-- (20260708081747, 20260627054713, 20260629042520, 20260708070202) under policies that check only that a firm_members row
-- exists for the company (tc_insert / tc_update / tc_delete; tax_payments_insert / _update / _delete; ca_insert / ca_update /
-- ca_delete; mi_insert / mi_update) — no capability, no named reviewer, no engine run. Shipped (withheld, unrouted) panels
-- performed exactly those writes. A member could therefore insert or alter a tax computation, a declared payment, a
-- capital allowance or a management input beside the engine, with no provenance.
--
-- This migration removes every client write path to the four tables:
--   - drops the eleven client write policies named above (every INSERT / UPDATE / DELETE policy on these tables);
--   - revokes INSERT, UPDATE, DELETE and TRUNCATE, at table and column level, from PUBLIC, anon and authenticated.
-- Unchanged: SELECT for authenticated under the existing tc_select / tax_payments_select / ca_select / mi_select policies
-- (what the engine recorded stays readable), and service_role (the only writer: the tax computation,
-- supabase/functions/kinga-tax-engine, through its service-role client; withheld in this release). No row is changed or
-- deleted. The browser components that wrote these tables no longer do (same change, src/jurisdiction-packs/tz/*).
--
-- Not here: statement_sign_offs. Its hardening is the separately reviewed candidate
-- docs/fin-integrity/candidate-migration/20261103100000_signoff_authorization_hardening.sql.

DO $preflight$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['public.tax_computations', 'public.tax_payments', 'public.capital_allowances', 'public.management_inputs'] LOOP
    IF to_regclass(v_table) IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_REFUSED: % does not exist; nothing was changed', v_table USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF NOT has_table_privilege('authenticated', 'public.tax_computations',  'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.tax_payments',      'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.capital_allowances', 'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.management_inputs',  'INSERT')
     AND NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public'
                        AND tablename IN ('tax_computations', 'tax_payments', 'capital_allowances', 'management_inputs')
                        AND cmd <> 'SELECT' AND roles <> ARRAY['service_role']::name[]) THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: browser writes to the legacy tax tables are already retired; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. The client write policies ─────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "tc_insert"           ON public.tax_computations;
DROP POLICY IF EXISTS "tc_update"           ON public.tax_computations;
DROP POLICY IF EXISTS "tc_delete"           ON public.tax_computations;
DROP POLICY IF EXISTS "tax_payments_insert" ON public.tax_payments;
DROP POLICY IF EXISTS "tax_payments_update" ON public.tax_payments;
DROP POLICY IF EXISTS "tax_payments_delete" ON public.tax_payments;
DROP POLICY IF EXISTS "ca_insert"           ON public.capital_allowances;
DROP POLICY IF EXISTS "ca_update"           ON public.capital_allowances;
DROP POLICY IF EXISTS "ca_delete"           ON public.capital_allowances;
DROP POLICY IF EXISTS "mi_insert"           ON public.management_inputs;
DROP POLICY IF EXISTS "mi_update"           ON public.management_inputs;

-- ── 2. The client write privileges, table and column level ───────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.tax_computations   FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.tax_payments       FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.capital_allowances FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.management_inputs  FROM PUBLIC, anon, authenticated;

DO $revoke_columns$
DECLARE
  v_table TEXT;
  v_col   TEXT;
BEGIN
  -- A column-level grant survives a table-level REVOKE (precedent 20261006100000); none may remain for a client role.
  FOREACH v_table IN ARRAY ARRAY['public.tax_computations', 'public.tax_payments', 'public.capital_allowances', 'public.management_inputs'] LOOP
    FOR v_col IN SELECT a.attname FROM pg_attribute a
                  WHERE a.attrelid = v_table::regclass AND a.attnum > 0 AND NOT a.attisdropped LOOP
      EXECUTE format('REVOKE INSERT (%1$I), UPDATE (%1$I) ON TABLE %2$s FROM PUBLIC, anon, authenticated', v_col, v_table);
    END LOOP;
  END LOOP;
END
$revoke_columns$;

COMMENT ON TABLE public.tax_computations IS
  'Tax computation output. Read-only to clients since 20261212100000; written only by the tax computation (service role).';
COMMENT ON TABLE public.tax_payments IS
  'Tax payments recorded against statutory obligations. Read-only to clients since 20261212100000; server functions (service role) only.';
COMMENT ON TABLE public.capital_allowances IS
  'Capital allowances (ITA s.34 wear and tear) register. Read-only to clients since 20261212100000; written only by the tax computation (service role).';
COMMENT ON TABLE public.management_inputs IS
  'Management inputs to the tax computation (dividends, share capital, loan movements). Read-only to clients since 20261212100000; server functions (service role) only.';

DO $postcondition$
DECLARE
  v_role  TEXT;
  v_table TEXT;
  v_priv  TEXT;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_table IN ARRAY ARRAY['public.tax_computations', 'public.tax_payments', 'public.capital_allowances', 'public.management_inputs'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION 'POSTCONDITION_FAILED: % still holds % on %', v_role, v_priv, v_table USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
      IF has_any_column_privilege(v_role, v_table, 'INSERT') OR has_any_column_privilege(v_role, v_table, 'UPDATE') THEN
        RAISE EXCEPTION 'POSTCONDITION_FAILED: % still holds a column-level write privilege on %', v_role, v_table USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public'
                AND tablename IN ('tax_computations', 'tax_payments', 'capital_allowances', 'management_inputs')
                AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL') AND roles <> ARRAY['service_role']::name[]) THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: a client write policy remains on the legacy tax tables' USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['public.tax_computations', 'public.tax_payments', 'public.capital_allowances', 'public.management_inputs'] LOOP
    IF NOT has_table_privilege('authenticated', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDITION_FAILED: what the engine recorded must remain readable (%)', v_table USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$postcondition$;
