-- READ-ONLY HOSTED POSTCONDITION for the transaction memo (docs/release/fs-first-slice/RECORD.md §8). Run AFTER the wrapper of
-- 20261116100000_fs_transaction_memo.sql. Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF to_regprocedure('public._fs_statement_composition_compute(uuid, integer)') IS NULL OR to_regprocedure('public._fs_reporting_input_compute(uuid, integer)') IS NULL
     OR to_regprocedure('public._fs_memo_get(text)') IS NULL OR to_regprocedure('public._fs_memo_put(text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: a memo function is missing (the wrapper is not applied)';
  END IF;
  IF position('_fs_memo_get' IN pg_get_functiondef('public.fs_statement_composition(uuid, integer)'::regprocedure)) = 0
     OR position('_fs_memo_get' IN pg_get_functiondef('public.fs_reporting_input(uuid, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the public names are not the memoising wrappers';
  END IF;
  -- The heavy bodies carry every accepted control: the capacity guard, the edition refusal and the comparative handling.
  IF position('over_capacity' IN pg_get_functiondef('public._fs_statement_composition_compute(uuid, integer)'::regprocedure)) = 0
     OR position('edition_unresolved' IN pg_get_functiondef('public._fs_statement_composition_compute(uuid, integer)'::regprocedure)) = 0
     OR position('adjustmentsRequiringRevalidation' IN pg_get_functiondef('public._fs_reporting_input_compute(uuid, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: a compute body lost an accepted control';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fs_statement_composition(uuid, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_reporting_input(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_statement_composition_compute(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_reporting_input_compute(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_memo_get(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_memo_put(text, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_statement_composition(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the grants are not exactly as before (public names to authenticated; compute and memo internal)';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.fs_reporting_input(uuid, integer)'::regprocedure) <> 's'
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.fs_statement_composition(uuid, integer)'::regprocedure) <> 'v' THEN
    RAISE EXCEPTION 'POSTCONDITION: a public name changed volatility';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
-- The same sign-offs, unchanged (compare with the preflight's listing):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
