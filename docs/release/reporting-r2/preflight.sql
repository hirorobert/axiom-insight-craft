-- READ-ONLY HOSTED PREFLIGHT for the readiness correction (docs/release/REPORTING_R2_READINESS.md, step 1). Run BEFORE
-- the wrapper. Writes nothing; raises on the first violated expectation.
DO $$
DECLARE
  v_fn regprocedure := to_regprocedure('public.fs_report_readiness(uuid, text, integer)');
BEGIN
  -- 1. The reporting release r1 is in force (20261022100000 is the latest applied source).
  IF position('APPROVER_NOT_AUTHENTICATED' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the reporting release r1 (20261022100000) is not in force';
  END IF;
  -- 2. The readiness function is exactly the reviewed text, still STABLE (the defect), SECURITY DEFINER, authenticated-only.
  IF v_fn IS NULL THEN RAISE EXCEPTION 'PREFLIGHT: public.fs_report_readiness(uuid, text, integer) is missing'; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> '03a4b3e8f1735d853758f1fedd26a3a4' THEN
    RAISE EXCEPTION 'PREFLIGHT: public.fs_report_readiness differs from the reviewed body';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = v_fn) <> 's' THEN
    RAISE EXCEPTION 'PREFLIGHT: public.fs_report_readiness is not STABLE (already corrected, or changed elsewhere)';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'PREFLIGHT: public.fs_report_readiness is not SECURITY DEFINER and authenticated-only';
  END IF;
  -- 3. The sign-off gate it reports is the reviewed one.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fs_publication_blockers(uuid, text, integer)'::regprocedure) <> '5b4a2d3a7360ff83634af1f1cc1b9d3d' THEN
    RAISE EXCEPTION 'PREFLIGHT: public.fs_publication_blockers differs from the reviewed body';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: fs_report_readiness is the reviewed STABLE body; apply the wrapper';
END;
$$;
-- The drafts this release must preserve (report the rows before and after):
SELECT report_id, report_version, document_hash, content_hash, created_at FROM public.financial_statement_reports
 WHERE company_id = '659daa94-116c-4803-99f8-157e0bdd4c62' ORDER BY report_id, report_version;
