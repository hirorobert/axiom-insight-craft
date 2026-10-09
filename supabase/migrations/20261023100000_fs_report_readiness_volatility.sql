-- 20261023100000_fs_report_readiness_volatility.sql — sign-off readiness is readable through the API (DEFECT D-2).
--
-- public.fs_report_readiness(uuid, text, integer) was declared STABLE (20260919110000). PostgREST runs a STABLE or
-- IMMUTABLE function inside a READ ONLY transaction, but the readiness check composes the statements it binds
-- (fs_publication_blockers → fs_reporting_dependencies → fs_statement_composition), and composition uses a temporary
-- table. Every hosted call therefore failed with 25006 "cannot execute CREATE TABLE in a read-only transaction", and the
-- Sign-off page could not read any version's readiness. The declaration was wrong: the function calls VOLATILE ones.
--
-- The one change: the function is declared VOLATILE, so PostgREST runs it in an ordinary transaction. Its text, owner,
-- SECURITY DEFINER, search_path, grants and every check it makes are unchanged (asserted below). It still writes nothing
-- persistent: it returns {ready, blockers} for one saved version, and sign-off and stale-result refusal are enforced at
-- publication by the same fs_publication_blockers / binding trigger as before. No table, row or other function changes.

DO $preflight$
DECLARE
  v_fn regprocedure := to_regprocedure('public.fs_report_readiness(uuid, text, integer)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: public.fs_report_readiness(uuid, text, integer) is missing; 20260919110000 must be applied first. Nothing was changed.' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = v_fn) <> 's' THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: public.fs_report_readiness is not STABLE (already applied or changed elsewhere); nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn)
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: public.fs_report_readiness is not in its reviewed state (SECURITY DEFINER; authenticated only); nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

ALTER FUNCTION public.fs_report_readiness(uuid, text, integer) VOLATILE;

DO $postcondition$
DECLARE
  v_fn regprocedure := to_regprocedure('public.fs_report_readiness(uuid, text, integer)');
  v_p  pg_proc;
BEGIN
  SELECT * INTO v_p FROM pg_proc WHERE oid = v_fn;
  IF v_p.provolatile <> 'v' OR NOT v_p.prosecdef
     OR NOT (v_p.proconfig @> ARRAY['search_path=pg_catalog, public'])
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: public.fs_report_readiness is not VOLATILE, SECURITY DEFINER, search_path-pinned and authenticated-only' USING ERRCODE = 'P0001';
  END IF;
END;
$postcondition$;
