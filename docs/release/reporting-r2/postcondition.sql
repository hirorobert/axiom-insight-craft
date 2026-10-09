-- READ-ONLY HOSTED POSTCONDITION for the readiness correction (docs/release/REPORTING_R2_READINESS.md, step 3). Run AFTER
-- the wrapper. Writes nothing; raises on the first violated expectation.
DO $$
DECLARE
  v_fn regprocedure := to_regprocedure('public.fs_report_readiness(uuid, text, integer)');
  v_p  pg_proc;
BEGIN
  SELECT * INTO v_p FROM pg_proc WHERE oid = v_fn;
  -- 1. VOLATILE, and nothing else about it changed: the same body, SECURITY DEFINER, pinned search_path, authenticated-only.
  IF v_p.provolatile <> 'v' THEN RAISE EXCEPTION 'POSTCONDITION: public.fs_report_readiness is not VOLATILE'; END IF;
  IF md5(v_p.prosrc) <> '03a4b3e8f1735d853758f1fedd26a3a4' THEN RAISE EXCEPTION 'POSTCONDITION: public.fs_report_readiness body changed'; END IF;
  IF NOT v_p.prosecdef OR NOT (v_p.proconfig @> ARRAY['search_path=pg_catalog, public'])
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: public.fs_report_readiness is not SECURITY DEFINER, search_path-pinned and authenticated-only';
  END IF;
  -- 2. The sign-off gate and the binding trigger are untouched.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fs_publication_blockers(uuid, text, integer)'::regprocedure) <> '5b4a2d3a7360ff83634af1f1cc1b9d3d' THEN
    RAISE EXCEPTION 'POSTCONDITION: public.fs_publication_blockers changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fsp_bind' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'POSTCONDITION: the sign-off binding trigger trg_fsp_bind is missing or disabled';
  END IF;
  -- Next: NOTIFY pgrst, 'reload schema'; (docs/release/REPORTING_R2_READINESS.md, step 4).
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
-- The same drafts, unchanged (compare with the preflight's rows):
SELECT report_id, report_version, document_hash, content_hash, created_at FROM public.financial_statement_reports
 WHERE company_id = '659daa94-116c-4803-99f8-157e0bdd4c62' ORDER BY report_id, report_version;
