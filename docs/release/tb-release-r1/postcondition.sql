-- READ-ONLY HOSTED POSTCONDITION for the trial balance release (batch tb-release-r1; main 365b370, PRs #151 + #153).
-- Run AFTER the four wrappers, in BEGIN TRANSACTION READ ONLY; … ROLLBACK;. Writes nothing; raises on the first violated
-- expectation and ends with NOTICE 'POSTCONDITION OK.'. Every permission check reads the catalog (has_*_privilege), so
-- it needs no role switch and no signed-in user.
DO $$
DECLARE v_def text; v_n integer;
BEGIN
  -- 1. Drafts (20261106100000): two tables, RLS on, no client table privilege; the client RPCs for authenticated only.
  IF to_regclass('public.trial_balance_drafts') IS NULL OR to_regclass('public.trial_balance_draft_commits') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: the trial balance draft tables are missing';
  END IF;
  IF NOT (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.trial_balance_drafts'::regclass, 'public.trial_balance_draft_commits'::regclass)) THEN
    RAISE EXCEPTION 'POSTCONDITION: row level security is off on a draft table';
  END IF;
  IF has_table_privilege('authenticated', 'public.trial_balance_drafts', 'SELECT') OR has_table_privilege('authenticated', 'public.trial_balance_drafts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.trial_balance_draft_commits', 'SELECT') OR has_table_privilege('authenticated', 'public.trial_balance_draft_commits', 'INSERT')
     OR has_table_privilege('anon', 'public.trial_balance_drafts', 'SELECT') OR has_table_privilege('anon', 'public.trial_balance_draft_commits', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION: a client has a table privilege on a draft table';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.reserve_trial_balance_draft(text,bigint,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reserve_trial_balance_draft(text,bigint,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tbd_begin_commit(uuid,uuid,text,uuid,integer,uuid,uuid,jsonb,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tbd_finish_commit(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: draft RPC privileges are not as reviewed (client reserve for authenticated only; commit steps service_role only)';
  END IF;
  IF position('''draft''' IN pg_get_functiondef('public.tbu_sweeper_candidates(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the source sweeper does not list draft objects';
  END IF;

  -- 2. Certification findings (20261107100000): append-only, RLS on, read-only for authenticated, the store present.
  IF to_regclass('public.tb_certification_findings') IS NULL THEN RAISE EXCEPTION 'POSTCONDITION: tb_certification_findings is missing'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tb_certification_findings'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: row level security is off on tb_certification_findings';
  END IF;
  IF has_table_privilege('authenticated', 'public.tb_certification_findings', 'INSERT') OR has_table_privilege('authenticated', 'public.tb_certification_findings', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.tb_certification_findings', 'DELETE') OR has_table_privilege('anon', 'public.tb_certification_findings', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION: a client can write (or anon read) tb_certification_findings';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tbcf_append_only' AND tgrelid = 'public.tb_certification_findings'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTCONDITION: the findings append-only trigger is missing or disabled';
  END IF;
  IF to_regprocedure('public.tb_certification_findings_supported()') IS NULL OR public.tb_certification_findings_supported() IS NOT TRUE
     OR has_function_privilege('authenticated', 'public.tb_certification_findings_supported()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: tb_certification_findings_supported() is missing, not true, or callable by authenticated';
  END IF;
  IF has_function_privilege('authenticated', 'public.tb_finalize_attempt(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tb_snapshot_dependencies(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the processing attempt writers are callable by authenticated';
  END IF;

  -- 3. Account identity (20261108100000): the codeless index in force, no all-names index (by DEFINITION), key and code kept.
  SELECT count(*) INTO v_n FROM pg_index i
   WHERE i.indrelid = 'public.account_mappings'::regclass AND i.indisunique AND i.indisvalid AND i.indnullsnotdistinct
     AND i.indexrelid = 'public.uq_acct_map_company_codeless_name'::regclass
     AND pg_get_expr(i.indpred, i.indrelid) = '((account_code IS NULL) AND (normalized_account_name IS NOT NULL))';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION: uq_acct_map_company_codeless_name is missing or not the reviewed definition'; END IF;
  IF EXISTS (SELECT 1 FROM pg_index i
              WHERE i.indrelid = 'public.account_mappings'::regclass AND i.indisunique
                AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) = ARRAY['company_id', 'normalized_account_name']
                AND pg_get_expr(i.indpred, i.indrelid) = '(normalized_account_name IS NOT NULL)') THEN
    RAISE EXCEPTION 'POSTCONDITION: an all-names unique index remains on account_mappings';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'public.account_mappings'::regclass AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
                    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) = ARRAY['company_id', 'account_key'])
     OR NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'public.account_mappings'::regclass AND i.indisunique AND i.indisvalid
                    AND pg_get_expr(i.indpred, i.indrelid) = '(account_code IS NOT NULL)'
                    AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) = ARRAY['company_id', 'account_code']) THEN
    RAISE EXCEPTION 'POSTCONDITION: the account key or code identity index is missing';
  END IF;

  -- 4. Refused-replacement restore (20261109100000): both helpers internal; the two RPCs carry the restore branches.
  IF to_regprocedure('public.tbu_refused_replacement_block(uuid)') IS NULL OR to_regprocedure('public.tbu_upload_dependent_evidence(uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: a refused-replacement helper is missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.tbu_refused_replacement_block(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tbu_upload_dependent_evidence(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tbu_refused_replacement_block(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tbu_upload_dependent_evidence(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: a refused-replacement helper is callable by a client';
  END IF;
  v_def := pg_get_functiondef('public.cancel_trial_balance_replacement(uuid,bigint)'::regprocedure);
  IF position('already_restored' IN v_def) = 0 OR position('tbu_refused_replacement_block' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: cancel_trial_balance_replacement does not carry the restore branch';
  END IF;
  IF position('restore_previous' IN pg_get_functiondef('public.get_trial_balance_removal_eligibility(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: get_trial_balance_removal_eligibility does not offer restore_previous';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.cancel_trial_balance_replacement(uuid,bigint)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_trial_balance_removal_eligibility(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cancel_trial_balance_replacement(uuid,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the replacement RPC privileges changed';
  END IF;

  RAISE NOTICE 'POSTCONDITION OK.';
END $$;
