-- READ-ONLY HOSTED POSTCONDITION for trial-balance finding decisions (batch tb-decisions-b1; migration 20261118100000).
-- Run AFTER the wrapper, in BEGIN TRANSACTION READ ONLY; … ROLLBACK;. CATALOG READS ONLY: it invokes no application
-- function and reads no tenant row. Raises on the first violated expectation; ends with NOTICE 'POSTCONDITION OK.'.
DO $$
DECLARE v_def text;
BEGIN
  -- 1. The registry holds exactly the five reviewed actions, and is fixed (insert/update/delete refused by trigger).
  IF to_regclass('public.tb_decision_actions') IS NULL
     OR (SELECT count(*) FROM public.tb_decision_actions) <> 5
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tda_fixed' AND tgrelid = 'public.tb_decision_actions'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: tb_decision_actions is missing, altered, or not fixed';
  END IF;

  -- 2. Decisions and investigations are append-only/fenced, RLS on, never writable by a client.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tfd_fence' AND tgrelid = 'public.tb_finding_decisions'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_tbi_fence' AND tgrelid = 'public.tb_investigations'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tb_finding_decisions'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tb_investigations'::regclass)
     OR has_table_privilege('authenticated', 'public.tb_finding_decisions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.tb_investigations', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION: decisions or investigations are not fenced, or are writable by a client';
  END IF;
  IF to_regclass('public.uq_tbi_one_running') IS NULL OR NOT (SELECT indisunique FROM pg_index WHERE indexrelid = 'public.uq_tbi_one_running'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: the durable investigation reservation index is missing';
  END IF;

  -- 3. Clients reach the decision operation and read only; the engine helpers and investigation writers are service-only.
  IF NOT has_function_privilege('authenticated', 'public.record_tb_finding_decision(uuid,uuid,text,text,text,jsonb,text,integer,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.record_tb_finding_decision(uuid,uuid,text,text,text,jsonb,text,integer,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_tb_finding_decisions(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tb_current_finding_decisions(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tb_investigation_reserve(uuid,uuid,uuid,uuid,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tb_investigation_complete(uuid,text,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: decision or investigation functions have the wrong client privileges';
  END IF;

  -- 4. The operation derives the actor, checks the evaluation is current, takes the identity from the stored findings, and
  --    invalidates the evaluation in the same transaction.
  v_def := pg_get_functiondef('public.record_tb_finding_decision(uuid,uuid,text,text,text,jsonb,text,integer,uuid)'::regprocedure);
  IF position('_layout_actor' IN v_def) = 0 OR position('STALE_EVALUATION' IN v_def) = 0 OR position('tb_certification_findings' IN v_def) = 0
     OR position('finding_decision' IN v_def) = 0 OR position('VERSION_CONFLICT' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: record_tb_finding_decision is not the reviewed definition';
  END IF;
  IF position('finding_decision' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'tb_certification_invalidations_reason_check'))) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: tb_certification_invalidations does not admit finding_decision';
  END IF;

  -- 5. The attempt functions carry the reviewed additions.
  v_def := pg_get_functiondef('public.tb_finalize_attempt(uuid,jsonb)'::regprocedure);
  IF position('tb-evaluation/1' IN v_def) = 0 OR position('omits a required rule' IN v_def) = 0
     OR position('ENGINE_GENERATION_UNSUPPORTED' IN v_def) = 0 OR position('needs a decision' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: tb_finalize_attempt does not enforce the evaluation manifest';
  END IF;
  v_def := pg_get_functiondef('public.tb_begin_attempt(uuid,uuid,text,text,text,text,integer,text,uuid,uuid,integer)'::regprocedure);
  IF position('DECISIONS_REQUIRE_CURRENT_ENGINE' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: tb_begin_attempt does not refuse engines that cannot read decisions';
  END IF;
  v_def := pg_get_functiondef('public.tb_snapshot_dependencies(uuid,jsonb)'::regprocedure);
  IF position('#finding_decisions:' IN v_def) = 0 OR position('#entity_decisions' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: tb_snapshot_dependencies does not accept the decision keys';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_companies_bump_entity' AND tgrelid = 'public.companies'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: the #entity dependency trigger is missing';
  END IF;
  IF position('SELECT 7' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.tb_max_engine_generation()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: tb_max_engine_generation is not 7';
  END IF;

  RAISE NOTICE 'POSTCONDITION OK.';
END
$$;
