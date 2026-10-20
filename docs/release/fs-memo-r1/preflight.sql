-- READ-ONLY HOSTED PREFLIGHT for the transaction memo (docs/release/fs-first-slice/RECORD.md §8). Run BEFORE the wrapper of
-- 20261116100000_fs_transaction_memo.sql. Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF to_regprocedure('public.fs_account_capacity(uuid, integer)') IS NULL
     OR position('over_capacity' IN pg_get_functiondef('public.fs_statement_composition(uuid, integer)'::regprocedure)) = 0
     OR (public.fs_work_bounds() ->> 'contract') IS DISTINCT FROM 'fs-work-bounds/2' THEN
    RAISE EXCEPTION 'PREFLIGHT: the account capacity (20261115100000, batch fs-capacity-r1) is not in force';
  END IF;
  IF to_regprocedure('public._fs_statement_composition_compute(uuid, integer)') IS NOT NULL OR to_regprocedure('public._fs_memo_get(text)') IS NOT NULL
     OR position('_fs_memo_get' IN pg_get_functiondef('public.fs_statement_composition(uuid, integer)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the transaction memo is already applied, or partly applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply the wrapper';
END;
$$;
-- The sign-offs this release must preserve (record them; compare after):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
