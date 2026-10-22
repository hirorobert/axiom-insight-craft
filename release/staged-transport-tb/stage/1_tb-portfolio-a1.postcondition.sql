INSERT INTO cfoclose_tb_release.staged_artifacts(batch, kind, body) VALUES ('tb-portfolio-a1', 'postcondition', $cfoclose_tb_stage_80c6181a3f03261a$-- READ-ONLY HOSTED POSTCONDITION for the engagements portfolio (batch tb-portfolio-a1; migration 20261117100000).
-- Run AFTER the wrapper, in BEGIN TRANSACTION READ ONLY; … ROLLBACK;. CATALOG READS ONLY: it invokes no application
-- function and reads no tenant row. Raises on the first violated expectation; ends with NOTICE 'POSTCONDITION OK.'.
DO $$
DECLARE v_def text;
BEGIN
  -- 1. The revision table exists, has RLS on and no client privilege.
  IF to_regclass('public.portfolio_revisions') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.portfolio_revisions'::regclass)
     OR has_table_privilege('authenticated', 'public.portfolio_revisions', 'SELECT')
     OR has_table_privilege('anon', 'public.portfolio_revisions', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION: portfolio_revisions is missing, has RLS off, or is readable by a client';
  END IF;

  -- 2. The reads for authenticated only; the helpers for nobody outside.
  IF NOT has_function_privilege('authenticated', 'public.list_portfolio_engagements(text,text[],text[],integer,text,integer,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.list_portfolio_engagements(text,text[],text[],integer,text,integer,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.list_portfolio_entities(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.list_portfolio_entities(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the portfolio reads have the wrong client privileges';
  END IF;
  -- The account home: exact totals with bounded samples, for authenticated only, a STABLE SECURITY DEFINER read.
  IF NOT has_function_privilege('authenticated', 'public.get_account_home(text[],integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_account_home(text[],integer)', 'EXECUTE')
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_account_home(text[],integer)'::regprocedure) IS NOT TRUE
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.get_account_home(text[],integer)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'POSTCONDITION: get_account_home is missing or has the wrong privileges or kind';
  END IF;
  IF has_function_privilege('authenticated', 'public._portfolio_visible_companies(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._portfolio_bump(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: a portfolio helper is callable by a client';
  END IF;

  -- 3. Visibility is the platform's workspace-access rule; the read is SECURITY DEFINER, STABLE, keyset-paged.
  v_def := pg_get_functiondef('public._portfolio_visible_companies(uuid)'::regprocedure);
  IF position('_workspace_access_basis' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: _portfolio_visible_companies does not apply _workspace_access_basis';
  END IF;
  v_def := pg_get_functiondef('public.list_portfolio_engagements(text,text[],text[],integer,text,integer,jsonb)'::regprocedure);
  IF position('INVALID_CURSOR' IN v_def) = 0 OR position('view_token' IN v_def) = 0 OR position('get_authoritative_certification' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: list_portfolio_engagements is not the reviewed definition';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.list_portfolio_engagements(text,text[],text[],integer,text,integer,jsonb)'::regprocedure) IS NOT TRUE
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.list_portfolio_engagements(text,text[],text[],integer,text,integer,jsonb)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'POSTCONDITION: list_portfolio_engagements is not a STABLE SECURITY DEFINER read';
  END IF;

  -- 4. Every revision trigger is present (a visible change moves the view token).
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND p.proname IN ('_portfolio_bump_company_row', '_portfolio_bump_invalidation')) < 9 THEN
    RAISE EXCEPTION 'POSTCONDITION: a portfolio revision trigger is missing';
  END IF;

  -- 5. The paging indexes exist.
  IF to_regclass('public.idx_engagements_company_status') IS NULL OR to_regclass('public.idx_tbu_period_active') IS NULL
     OR to_regclass('public.idx_tbu_company_year_active') IS NULL OR to_regclass('public.idx_tbc_upload_seq') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: a portfolio index is missing';
  END IF;

  RAISE NOTICE 'POSTCONDITION OK.';
END
$$;
$cfoclose_tb_stage_80c6181a3f03261a$);
