-- READ-ONLY HOSTED POSTCONDITION for the period-currency correction (batch currency-c1; migration 20261113100000).
-- Run AFTER the wrapper, in BEGIN TRANSACTION READ ONLY; … ROLLBACK;. CATALOG READS ONLY: it invokes no application
-- function and reads no tenant row, so a read-only, non-owner role can run it. Raises on the first violated
-- expectation; ends with NOTICE 'POSTCONDITION OK.'.
DO $$
DECLARE v_def text;
BEGIN
  -- 1. The history accepts the new action, and one request id records at most one correction.
  IF position('currency_corrected' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'chk_fpe_action'))) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fiscal_period_events.chk_fpe_action does not admit currency_corrected';
  END IF;
  IF to_regclass('public.uq_fpe_currency_request') IS NULL
     OR NOT (SELECT indisunique FROM pg_index WHERE indexrelid = 'public.uq_fpe_currency_request'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: the unique request index uq_fpe_currency_request is missing';
  END IF;

  -- 2. The processing lock still refuses every currency/date change except the operation's own marked change.
  v_def := pg_get_functiondef('public.fiscal_periods_processing_lock()'::regprocedure);
  IF position('axiom.period_currency_correction' IN v_def) = 0 OR position('PERIOD_LOCKED_BY_PROCESSING' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fiscal_periods_processing_lock is not the reviewed definition';
  END IF;

  -- 3. Clients reach exactly the read and the operation; the internal helpers are callable by nobody outside.
  IF NOT has_function_privilege('authenticated', 'public.get_period_currency_correction(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_period_currency_correction(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.correct_period_currency(uuid,text,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.correct_period_currency(uuid,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the read or the operation has the wrong client privileges';
  END IF;
  IF has_function_privilege('authenticated', 'public._period_currency_correction_block(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._period_currency_actor(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._period_currency_bookkeeping()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._period_currency_dependent_relations()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: an internal helper is callable by a client';
  END IF;

  -- 4. The operation checks authority, eligibility and the expected currency, and records the history.
  v_def := pg_get_functiondef('public.correct_period_currency(uuid,text,text,text,uuid)'::regprocedure);
  IF position('_period_currency_actor' IN v_def) = 0 OR position('_period_currency_correction_block' IN v_def) = 0
     OR position('stale' IN v_def) = 0 OR position('currency_corrected' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: correct_period_currency is not the reviewed definition';
  END IF;
  IF position('IN SHARE MODE' IN v_def) = 0 OR position('_period_currency_dependent_relations' IN v_def) = 0 OR position('busy' IN v_def) = 0
     OR position('v_deadline' IN v_def) = 0 OR position('deadlock_detected' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: correct_period_currency does not serialise with dependent writers';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.correct_period_currency(uuid,text,text,text,uuid)'::regprocedure) IS NOT TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION: correct_period_currency is not SECURITY DEFINER';
  END IF;

  RAISE NOTICE 'POSTCONDITION OK.';
END $$;
