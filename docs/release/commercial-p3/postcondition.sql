-- READ-ONLY HOSTED POSTCONDITION for sandbox licence isolation (batch commercial-p3, 20261031110000). Run AFTER the wrapper,
-- and again after any P3-5 review or restoration. Writes nothing; raises on the first violated expectation.
--
-- PART A (the DO block) proves CONTAINMENT. It must read 'POSTCONDITION OK.' It does NOT require every legacy decision to be
-- made: an unresolved REVIEW_REQUIRED licence or an unrestored term is listed in PART C as an owner decision, never guessed.
--   A1  schema, guard and grants are the reviewed ones
--   A2  no sandbox licence grants: SANDBOX_PAYMENT => SANDBOX or CANCELLED; SANDBOX => SANDBOX_PAYMENT; each one audited
--   A3  for every account holding a sandbox licence, plan, company (entity) capacity and named-user seats come only from a
--       non-sandbox current term, or from none — computed by the live access functions themselves
--   A4  every cancelled sandbox licence is still CANCELLED with the plan, account, seats, source and dates it was cancelled
--       with (its FUTURE_LICENCE_CANCELLED record), and its cancellation record is intact
--   A5  no restoration is guessed: every continuation term restores a term proven genuine (PRODUCTION_PAYMENT or
--       MANUAL_GRANT), starts where that term now ends, ends exactly where the term's own grant record says, and is audited once
--   A6  payments are still disabled
-- PART B: compare with the preflight's section 4 (history preserved). PART C: what was recorded, and what is left to decide.
DO $$
DECLARE
  v_fn TEXT; r RECORD; v_expected TEXT; v_plan TEXT; v_ent JSONB; v_seat JSONB; v_cancel RECORD; v_grant RECORD; v_orig RECORD; v_end TIMESTAMPTZ;
BEGIN
  -- A1
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commercial_licences'
                  AND column_name = 'provenance' AND is_nullable = 'NO' AND column_default LIKE '%REVIEW_REQUIRED%') THEN
    RAISE EXCEPTION 'POSTCONDITION A1: commercial_licences.provenance is missing, nullable or without its REVIEW_REQUIRED default';
  END IF;
  IF position('SANDBOX' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'chk_cl_status'))) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION A1: status SANDBOX is not allowed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cl_provenance_guard' AND tgrelid = 'public.commercial_licences'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTCONDITION A1: the provenance guard trigger is missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_commercial_cancelled_future_licence_guard' AND tgrelid = 'public.commercial_licences'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTCONDITION A1: the cancelled-licence guard trigger is missing or disabled';
  END IF;
  IF position('cfoclose.licence_provenance_review' IN pg_get_functiondef('public.commercial_licence_provenance_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION A1: the provenance guard is not the reviewed one (20261031110000)';
  END IF;
  IF position('SANDBOX_RECORD' IN pg_get_functiondef('public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION A1: the commit still places sandbox payments';
  END IF;
  IF position('grants_access' IN pg_get_functiondef('public.get_checkout_status(text)'::regprocedure)) = 0
     OR position('grants_access' IN pg_get_functiondef('public.get_my_payments()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION A1: the order reads do not say whether an order grants access';
  END IF;
  v_fn := 'public.commit_verified_commercial_payment(uuid,text,text,text,text,bigint,text,text,timestamp with time zone,text,text,text,text)';
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION A1: % is not exactly scoped (service_role only)', v_fn;
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.admin_list_licence_provenance_review()', 'public.admin_resolve_licence_provenance(uuid,text,text)',
                              'public.admin_restore_term_ended_by_sandbox(uuid,text)', 'public.admin_place_paid_licence(uuid,timestamp with time zone,text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION A1: % is not exactly scoped (authenticated commercial administrators only)', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.commercial_licence_provenance_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION A1: the guard function is callable by clients';
  END IF;

  -- A2
  IF EXISTS (SELECT 1 FROM public.commercial_licences WHERE provenance = 'SANDBOX_PAYMENT' AND status NOT IN ('SANDBOX', 'CANCELLED'))
     OR EXISTS (SELECT 1 FROM public.commercial_licences WHERE status = 'SANDBOX' AND provenance <> 'SANDBOX_PAYMENT') THEN
    RAISE EXCEPTION 'POSTCONDITION A2: a sandbox licence can grant, or a non-sandbox licence is SANDBOX';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commercial_licences l WHERE l.provenance = 'SANDBOX_PAYMENT'
              AND NOT EXISTS (SELECT 1 FROM public.billing_audit_events a
                               WHERE a.action IN ('SANDBOX_LICENCE_CONTAINED', 'SANDBOX_PROVENANCE_RECORDED', 'SANDBOX_PROVENANCE_CONFIRMED')
                                 AND a.new_state->>'licence_id' = l.id::text)) THEN
    RAISE EXCEPTION 'POSTCONDITION A2: a sandbox licence was contained or recorded without its audit row';
  END IF;

  -- A3
  FOR r IN SELECT DISTINCT b.id AS bc, b.owner_user_id FROM public.commercial_licences l
             JOIN public.billing_customers b ON b.id = l.billing_customer_id WHERE l.provenance = 'SANDBOX_PAYMENT' LOOP
    SELECT cp.code INTO v_expected FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
     WHERE cl.billing_customer_id = r.bc AND cl.status IN ('ACTIVE', 'GRACE') AND cl.provenance <> 'SANDBOX_PAYMENT'
       AND cl.effective_start <= clock_timestamp() AND (cl.effective_end IS NULL OR cl.effective_end > clock_timestamp())
     ORDER BY cl.effective_start DESC LIMIT 1;
    v_plan := public._account_current_plan_code(r.owner_user_id);
    v_ent  := public._entity_capacity_for_account(r.owner_user_id);
    v_seat := public._seat_capacity_for_account(r.owner_user_id);
    IF v_expected IS NULL THEN
      -- No genuine current term: no plan, no licence-derived company capacity, no licence-derived seats.
      IF v_plan IS NOT NULL OR v_ent->>'plan_code' IS NOT NULL OR v_ent->>'source' = 'ACTIVE_LICENCE' OR v_seat->>'plan_code' IS NOT NULL THEN
        RAISE EXCEPTION 'POSTCONDITION A3: account % (no genuine current term) still has plan %, company capacity % or seats % from a licence',
          r.bc, v_plan, v_ent, v_seat;
      END IF;
    ELSIF v_plan IS DISTINCT FROM v_expected OR COALESCE(v_ent->>'plan_code', v_expected) <> v_expected OR COALESCE(v_seat->>'plan_code', v_expected) <> v_expected THEN
      RAISE EXCEPTION 'POSTCONDITION A3: account % reports plan %, company capacity % or seats % instead of its genuine term %',
        r.bc, v_plan, v_ent, v_seat, v_expected;
    END IF;
  END LOOP;

  -- A4
  FOR r IN SELECT l.* FROM public.commercial_licences l WHERE l.provenance = 'SANDBOX_PAYMENT'
             AND (l.status = 'CANCELLED' OR EXISTS (SELECT 1 FROM public.billing_audit_events a WHERE a.action = 'SANDBOX_PROVENANCE_RECORDED' AND a.new_state->>'licence_id' = l.id::text)) LOOP
    SELECT * INTO v_cancel FROM public.billing_audit_events
     WHERE action = 'FUTURE_LICENCE_CANCELLED' AND new_state->>'licence_id' = r.id::text ORDER BY created_at LIMIT 1;
    IF r.status <> 'CANCELLED' THEN
      RAISE EXCEPTION 'POSTCONDITION A4: cancelled sandbox licence % is now %', r.id, r.status;
    END IF;
    IF v_cancel.id IS NOT NULL AND (
         v_cancel.new_state->>'account_id' IS DISTINCT FROM r.billing_customer_id::text
      OR (v_cancel.new_state->>'effective_start')::timestamptz IS DISTINCT FROM r.effective_start
      OR (v_cancel.new_state->>'effective_end')::timestamptz IS DISTINCT FROM r.effective_end) THEN
      RAISE EXCEPTION 'POSTCONDITION A4: cancelled sandbox licence % no longer has the account and dates it was cancelled with', r.id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.billing_audit_events a WHERE a.action = 'SANDBOX_PROVENANCE_RECORDED' AND a.new_state->>'licence_id' = r.id::text
                AND (a.previous_state->>'status' <> 'CANCELLED' OR a.previous_state->>'source' IS DISTINCT FROM r.source
                     OR (a.previous_state->>'effective_start')::timestamptz IS DISTINCT FROM r.effective_start
                     OR (a.previous_state->>'effective_end')::timestamptz IS DISTINCT FROM r.effective_end)) THEN
      RAISE EXCEPTION 'POSTCONDITION A4: cancelled sandbox licence % changed source, status or dates during containment', r.id;
    END IF;
  END LOOP;

  -- A5
  FOR r IN SELECT c.* FROM public.commercial_licences c WHERE c.source = 'TERM_RESTORED_AFTER_SANDBOX' LOOP
    IF (SELECT count(*) FROM public.billing_audit_events a WHERE a.action = 'TERM_RESTORED_AFTER_SANDBOX' AND a.new_state->>'continuation_licence_id' = r.id::text) <> 1 THEN
      RAISE EXCEPTION 'POSTCONDITION A5: continuation % has no single TERM_RESTORED_AFTER_SANDBOX record', r.id;
    END IF;
    SELECT * INTO v_orig FROM public.commercial_licences WHERE id = (r.provenance_evidence->>'restores_licence_id')::uuid;
    IF v_orig.id IS NULL OR v_orig.provenance NOT IN ('PRODUCTION_PAYMENT', 'MANUAL_GRANT') OR r.provenance IS DISTINCT FROM v_orig.provenance
       OR r.effective_start IS DISTINCT FROM v_orig.effective_end OR r.plan_id IS DISTINCT FROM v_orig.plan_id OR r.billing_customer_id IS DISTINCT FROM v_orig.billing_customer_id THEN
      RAISE EXCEPTION 'POSTCONDITION A5: continuation % does not continue a term proven genuine', r.id;
    END IF;
    SELECT * INTO v_grant FROM public.billing_audit_events
     WHERE action IN ('LICENCE_GRANTED', 'PAID_LICENCE_PLACED') AND new_state->>'licence_id' = v_orig.id::text ORDER BY created_at LIMIT 1;
    v_end := COALESCE((v_grant.new_state->>'period_end')::timestamptz, (v_grant.new_state->>'effective_end')::timestamptz);
    IF v_grant.id IS NULL OR v_end IS NULL OR r.effective_end IS DISTINCT FROM v_end OR (r.provenance_evidence->>'original_grant_audit_event_id') IS DISTINCT FROM v_grant.id::text THEN
      RAISE EXCEPTION 'POSTCONDITION A5: continuation % does not end where its term''s own grant record says', r.id;
    END IF;
  END LOOP;

  -- A6
  IF (SELECT state FROM public.commercial_platform_state WHERE id = true) IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    RAISE EXCEPTION 'POSTCONDITION A6: payments must still be disabled';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;

-- ── PART B. History preserved: every value must equal the preflight's section 4 (licence_terms_md5 excludes continuation
-- terms, which P3-5 may add; they are proven separately by A5). audit_history_md5 covers every audit row except the five
-- p3 actions, none of which exists before p3: it proves no earlier audit row was changed or removed.
SELECT count(*) AS licences,
       coalesce(md5(string_agg(jsonb_build_array(l.id, l.billing_customer_id, l.plan_id, l.source, l.effective_start, l.effective_end, l.additional_seats)::text, '' ORDER BY l.id)), '') AS licence_terms_md5
  FROM public.commercial_licences l WHERE l.source <> 'TERM_RESTORED_AFTER_SANDBOX';
SELECT count(*) AS cancelled_licences,
       coalesce(md5(string_agg(jsonb_build_array(l.id, l.billing_customer_id, l.plan_id, l.source, l.status, l.effective_start, l.effective_end, l.additional_seats)::text, '' ORDER BY l.id)), '') AS cancelled_licences_md5
  FROM public.commercial_licences l WHERE l.status = 'CANCELLED';
SELECT count(*) AS intents, coalesce(md5(string_agg(to_jsonb(i)::text, '' ORDER BY i.id)), '') AS intents_md5 FROM public.payment_checkout_intents i;
SELECT count(*) AS payment_events, coalesce(md5(string_agg(to_jsonb(e)::text, '' ORDER BY e.id)), '') AS payment_events_md5 FROM public.payment_events e;
SELECT count(*) AS audit_history, coalesce(md5(string_agg(to_jsonb(a)::text, '' ORDER BY a.id)), '') AS audit_history_md5
  FROM public.billing_audit_events a
 WHERE a.action NOT IN ('SANDBOX_LICENCE_CONTAINED', 'SANDBOX_PROVENANCE_RECORDED', 'LICENCE_PROVENANCE_CONFIRMED', 'SANDBOX_PROVENANCE_CONFIRMED', 'TERM_RESTORED_AFTER_SANDBOX');
SELECT action, count(*) AS p3_audit_rows FROM public.billing_audit_events
 WHERE action IN ('SANDBOX_LICENCE_CONTAINED', 'SANDBOX_PROVENANCE_RECORDED', 'LICENCE_PROVENANCE_CONFIRMED', 'SANDBOX_PROVENANCE_CONFIRMED', 'TERM_RESTORED_AFTER_SANDBOX')
 GROUP BY action ORDER BY action;

-- ── PART C1. CONTAINMENT — done by the migration (paste into the report).
SELECT provenance, status, count(*) FROM public.commercial_licences GROUP BY provenance, status ORDER BY provenance, status;
SELECT id, status, provenance, provenance_evidence FROM public.commercial_licences WHERE id = 'ba803893-8116-454f-bea2-0f2a7c7f2603';
SELECT a.action, a.new_state->>'licence_id' AS sandbox_licence_id, a.new_state->>'status' AS status_now, b.owner_user_id AS account_owner,
       public._account_current_plan_code(b.owner_user_id) AS plan_now,
       public._entity_capacity_for_account(b.owner_user_id) AS company_capacity_now,
       public._seat_capacity_for_account(b.owner_user_id) AS seats_now, a.created_at
  FROM public.billing_audit_events a JOIN public.billing_customers b ON b.id = a.billing_customer_id
 WHERE a.action IN ('SANDBOX_LICENCE_CONTAINED', 'SANDBOX_PROVENANCE_RECORDED', 'SANDBOX_PROVENANCE_CONFIRMED') ORDER BY a.created_at;

-- ── PART C2. OWNER DECISIONS STILL OPEN — not failures of containment, and never resolved by guessing.
-- Licences whose environment is unproven (resolve each once, with a reason, from the provider's own records):
SELECT id AS review_required_licence_id, billing_customer_id, status, source, effective_start, effective_end, provenance_evidence->>'basis' AS basis
  FROM public.commercial_licences WHERE provenance = 'REVIEW_REQUIRED' ORDER BY created_at;
-- Terms a sandbox payment ended, not yet restored, with what restoration would require:
SELECT a.new_state->>'ended_production_licence_id' AS ended_term_id, a.new_state->>'licence_id' AS by_sandbox_licence_id,
       t.status, t.provenance, t.effective_end AS ends_now,
       COALESCE((g.new_state->>'period_end')::timestamptz, (g.new_state->>'effective_end')::timestamptz) AS recorded_original_end,
       CASE
         WHEN t.provenance NOT IN ('PRODUCTION_PAYMENT', 'MANUAL_GRANT') THEN 'OWNER DECISION: provenance unproven; review it first'
         WHEN t.status NOT IN ('ACTIVE', 'GRACE') THEN 'OWNER DECISION: term no longer granting; not restorable'
         WHEN g.id IS NULL OR COALESCE((g.new_state->>'period_end')::timestamptz, (g.new_state->>'effective_end')::timestamptz) IS NULL
           THEN 'OWNER DECISION: no recorded original end; not restorable by this procedure'
         ELSE 'RESTORABLE with admin_restore_term_ended_by_sandbox (owner authorisation)'
       END AS next_step
  FROM public.billing_audit_events a
  JOIN public.commercial_licences t ON t.id = (a.new_state->>'ended_production_licence_id')::uuid
  LEFT JOIN LATERAL (SELECT * FROM public.billing_audit_events g WHERE g.action IN ('LICENCE_GRANTED', 'PAID_LICENCE_PLACED')
                      AND g.new_state->>'licence_id' = t.id::text ORDER BY g.created_at LIMIT 1) g ON true
 WHERE a.action IN ('SANDBOX_LICENCE_CONTAINED', 'SANDBOX_PROVENANCE_RECORDED', 'SANDBOX_PROVENANCE_CONFIRMED')
   AND a.new_state->>'ended_production_licence_id' IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.billing_audit_events x WHERE x.action = 'TERM_RESTORED_AFTER_SANDBOX' AND x.new_state->>'licence_id' = t.id::text)
 ORDER BY a.created_at;
