INSERT INTO cfoclose_tra_release.staged_artifacts(batch, kind, body) VALUES ('tra-2-framework-guard', 'postcondition', $cfoclose_tra_stage_1694dcdd99014105$-- HOSTED POSTCONDITION 2 of release batch track-a-r1: after 20261128100000_companies_framework_change_guard.sql (applied
-- only once the frontend that calls set_company_reporting_framework is published). The staged apply of batch 2 executes
-- it inside its own transaction. Writes nothing; raises on the first violated expectation.
DO $$
DECLARE
  v_owner name;
  v_role text;
BEGIN
  IF to_regprocedure('public.guard_company_reporting_framework()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgname = 'trg_guard_company_reporting_framework' AND g.tgrelid = 'public.companies'::regclass
                     AND g.tgenabled = 'O' AND NOT g.tgisinternal AND (g.tgtype & 1) <> 0 AND (g.tgtype & 2) <> 0 AND (g.tgtype & 16) <> 0) THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: the framework-change guard is missing, disabled, or not a BEFORE UPDATE row trigger on companies';
  END IF;
  -- Scoped to exactly the reporting_framework column (tgattr), not inferred from the trigger's name.
  IF (SELECT g.tgattr::int2[] FROM pg_trigger g WHERE g.tgname = 'trg_guard_company_reporting_framework' AND g.tgrelid = 'public.companies'::regclass)
     IS DISTINCT FROM ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.companies'::regclass AND a.attname = 'reporting_framework')]::int2[] THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: the framework-change guard is not scoped to exactly companies.reporting_framework';
  END IF;
  IF position('company_framework_events' IN pg_get_functiondef('public.guard_company_reporting_framework()'::regprocedure)) = 0
     OR position('pg_current_xact_id()' IN pg_get_functiondef('public.guard_company_reporting_framework()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: the framework-change guard does not require this transaction''s audited event';
  END IF;
  -- The one writer it admits is the owner of the audited function; that owner is never an API role.
  SELECT pg_get_userbyid(p.proowner) INTO v_owner FROM pg_proc p WHERE p.oid = 'public.set_company_reporting_framework(uuid, text, text, text, uuid)'::regprocedure;
  IF v_owner IS NULL OR v_owner IN ('anon', 'authenticated', 'service_role', 'authenticator') THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: set_company_reporting_framework is owned by %, an API role', v_owner;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.set_company_reporting_framework(uuid, text, text, text, uuid)'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.guard_company_reporting_framework()'::regprocedure) THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: the function must be SECURITY DEFINER and the guard SECURITY INVOKER';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role)
       AND (has_function_privilege(v_role, 'public.guard_company_reporting_framework()', 'EXECUTE')
            OR pg_has_role(v_role, v_owner, 'MEMBER')) THEN
      RAISE EXCEPTION 'TRA_POSTCONDITION: % can act as the framework writer', v_role;
    END IF;
  END LOOP;
  -- Batch 1 still in force.
  IF to_regclass('public.company_framework_events') IS NULL
     OR position('cfoclose.fs_replace_authority' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) > 0
     OR has_table_privilege('service_role', 'public.fs_report_authority', 'UPDATE')
     OR has_table_privilege('service_role', 'public.tb_certifications', 'TRUNCATE') THEN
    RAISE EXCEPTION 'TRA_POSTCONDITION: batch 1 (20261127100000) is not in force';
  END IF;
  PERFORM public._fs_authority_scope_check(s.company_id, s.period_year)
     FROM (SELECT company_id, period_year FROM public.fs_report_authority UNION SELECT company_id, period_year FROM public.fs_report_authority_events) s;
  RAISE NOTICE 'TRA_POSTCONDITION 2 OK';
END;
$$;
$cfoclose_tra_stage_1694dcdd99014105$);
