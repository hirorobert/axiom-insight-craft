-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261230300000 — QuickBooks realmID protection, Phase B part 2 (disconnect and import evidence: dual write). AUTHORED, NOT APPLIED to any
-- hosted database. Forward-only; needs 20261230200000. Reversible: the plaintext realm_id is still written beside the protection.
--
--   WHAT IT DOES (design: docs/release/qbo-realm-protection-r1/README.md):
--   (1) qbo_begin_disconnect copies the connection's protection (and its verification: the same envelope bytes under the same binding) into the
--       new operation, and returns the operation's envelope and index beside the plaintext. Otherwise the 20261214100000 text, unchanged.
--   (2) qbo_record_pull_intent gains p_realm_envelope / p_realm_index (its 14-argument signature is DROPPED: one function); qbo_record_fiscal_pull_intent
--       passes the CONNECTION's own protection (never a value from the caller); qbo_complete_pull copies the intent's into the provenance row.
--       Historical intents and pulls are untouched and their append-only guards are unchanged; new rows carry the protection.
--   Grants are restated exactly as before.
--
-- PREFLIGHT: 20261230200000 installed and the earlier signatures present; a replay is a no-op. POSTCONDITION: one function per name, the new
-- signature with its defaults, the same grants, the protection copied by all four functions. One DO block: atomic whatever the transaction mode.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_evidence$
DECLARE
  c_old constant text := 'public.qbo_record_pull_intent(uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text)';
  c_new constant text := 'public.qbo_record_pull_intent(uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text,text,text)';
  c_fiscal constant text := 'public.qbo_record_fiscal_pull_intent(uuid,jsonb,uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text)';
BEGIN
  IF to_regprocedure(c_old) IS NULL AND to_regprocedure(c_new) IS NOT NULL AND position('c.realm_envelope,c.realm_index' IN pg_get_functiondef(to_regprocedure(c_fiscal))) > 0 THEN
    RETURN;   -- replay
  END IF;
  IF to_regprocedure('public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261230200000 (realm protection, connect) is not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure(c_old) IS NULL OR to_regprocedure(c_new) IS NOT NULL OR to_regprocedure(c_fiscal) IS NULL OR to_regprocedure('public.qbo_begin_disconnect(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: an earlier QuickBooks function signature is absent (half-installed state); nothing was changed' USING ERRCODE = 'P0001';
  END IF;

  -- (1) disconnect: the operation inherits the connection's protection.
  CREATE OR REPLACE FUNCTION public.qbo_begin_disconnect(p_connection uuid,p_actor uuid,p_request uuid)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
  DECLARE c public.qbo_connections; o public.qbo_disconnect_operations; ticket uuid;
  BEGIN
   SELECT * INTO c FROM public.qbo_connections WHERE id=p_connection;
   IF FOUND THEN PERFORM pg_advisory_xact_lock(hashtextextended('qbo-connect:'||c.environment||':'||c.realm_id,0)); END IF;
   SELECT * INTO c FROM public.qbo_connections WHERE id=p_connection FOR UPDATE;
   IF NOT FOUND OR NOT public.qbo_connector_basis(p_actor,c.company_id) THEN RETURN jsonb_build_object('outcome','forbidden'); END IF;
   IF p_request IS NULL THEN RETURN jsonb_build_object('outcome','invalid_request'); END IF;
   SELECT * INTO o FROM public.qbo_disconnect_operations WHERE connection_id=c.id;
   IF FOUND THEN
    IF o.request_id<>p_request OR o.actor_user_id<>p_actor THEN RETURN jsonb_build_object('outcome','request_conflict'); END IF;
    IF o.outcome='pending' THEN
     IF o.revoke_lease_until>clock_timestamp() THEN RETURN jsonb_build_object('outcome','revocation_busy'); END IF;
     ticket:=gen_random_uuid(); UPDATE public.qbo_disconnect_operations SET revoke_lease_id=ticket,revoke_lease_until=clock_timestamp()+interval '45 seconds' WHERE connection_id=c.id;
    END IF;
    RETURN jsonb_build_object('outcome',o.outcome,'leaseId',ticket,'envelope',o.pending_envelope,'companyId',c.company_id,'realmId',o.realm_id,'environment',c.environment,
      'realmEnvelope',o.realm_envelope,'realmIndex',o.realm_index);
   END IF;
   IF EXISTS(SELECT 1 FROM public.qbo_disconnect_operations WHERE request_id=p_request) THEN RETURN jsonb_build_object('outcome','request_conflict'); END IF;
   IF c.status='disconnected' THEN RETURN jsonb_build_object('outcome','local_only'); END IF;
   IF c.refresh_lease_until>clock_timestamp() THEN RETURN jsonb_build_object('outcome','busy'); END IF;
   IF EXISTS(SELECT 1 FROM public.qbo_connections x WHERE x.id<>c.id AND x.realm_id=c.realm_id AND x.environment=c.environment AND x.status='active') THEN RETURN jsonb_build_object('outcome','shared_connection'); END IF;
   INSERT INTO public.qbo_disconnect_operations(connection_id,request_id,actor_user_id,company_id,realm_id,environment,pending_envelope,outcome,realm_envelope,realm_index,realm_verified_at)
   VALUES(c.id,p_request,p_actor,c.company_id,c.realm_id,c.environment,c.refresh_token_envelope,CASE WHEN c.refresh_token_envelope IS NULL THEN 'local_only' ELSE 'pending' END,
          c.realm_envelope,c.realm_index,c.realm_verified_at);
   UPDATE public.qbo_connections SET status='disconnected',refresh_token_envelope=NULL,envelope_key_id=NULL,refresh_expires_at=NULL,hard_expires_at=NULL,
    refresh_lease_until=NULL,refresh_lease_id=NULL,disconnected_at=clock_timestamp() WHERE id=c.id;
   ticket:=gen_random_uuid(); UPDATE public.qbo_disconnect_operations SET revoke_lease_id=ticket,revoke_lease_until=clock_timestamp()+interval '45 seconds' WHERE connection_id=c.id AND outcome='pending';
   RETURN jsonb_build_object('outcome',CASE WHEN c.refresh_token_envelope IS NULL THEN 'local_only' ELSE 'pending' END,'leaseId',ticket,'envelope',c.refresh_token_envelope,'companyId',c.company_id,
     'realmId',c.realm_id,'environment',c.environment,'realmEnvelope',c.realm_envelope,'realmIndex',c.realm_index);
  END $f$;

  -- (2) import evidence: new rows carry the CONNECTION's protection. Otherwise the earlier texts, unchanged.
  DROP FUNCTION public.qbo_record_pull_intent(uuid, uuid, uuid, text, text, date, date, text, integer, text, integer, text, text, text);
  CREATE FUNCTION public.qbo_record_pull_intent(p_reservation_id uuid, p_connection_id uuid, p_actor_user_id uuid, p_realm_id text, p_environment text,
                                                p_start_date date, p_end_date date, p_accounting_method text, p_minor_version integer, p_currency text,
                                                p_account_count integer, p_raw_sha256 text, p_canonical_sha256 text, p_result_sha256 text,
                                                p_realm_envelope text DEFAULT NULL, p_realm_index text DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE r public.trial_balance_source_reservations%ROWTYPE; e public.qbo_pull_intents%ROWTYPE; v_id uuid; v_prepare text; v_source text;
  BEGIN
    IF p_reservation_id IS NULL OR p_actor_user_id IS NULL THEN
      RAISE EXCEPTION 'FORBIDDEN: a reservation and an actor are required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO r FROM public.trial_balance_source_reservations x WHERE x.id = p_reservation_id;
    IF NOT FOUND OR r.actor_user_id <> p_actor_user_id OR NOT public.qbo_connector_basis(p_actor_user_id, r.company_id) THEN
      RAISE EXCEPTION 'FORBIDDEN: no right to import from QuickBooks into this workspace' USING ERRCODE = '42501';
    END IF;
    v_prepare := public.workspace_authority_basis(p_actor_user_id, r.company_id, 'prepare_trial_balance');
    v_source := public.workspace_authority_basis(p_actor_user_id, r.company_id, 'manage_source_files');
    SELECT * INTO e FROM public.qbo_pull_intents i WHERE i.reservation_id = p_reservation_id;
    IF FOUND THEN
      IF e.raw_sha256 = p_raw_sha256 AND e.canonical_sha256 = p_canonical_sha256 AND e.result_sha256 = p_result_sha256 THEN RETURN e.id; END IF;
      RAISE EXCEPTION 'INTENT_CONFLICT: this reservation already carries different facts' USING ERRCODE = '23505';
    END IF;
    IF r.consumed_at IS NOT NULL OR r.expires_at <= now() THEN
      RAISE EXCEPTION 'RESERVATION_NOT_OPEN: the upload reservation is already used or has expired' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.qbo_pull_intents (reservation_id, company_id, connection_id, actor_user_id, prepare_basis, source_basis, realm_id, environment, report, start_date, end_date,
                                         accounting_method, minor_version, currency, account_count, raw_sha256, canonical_sha256, result_sha256, realm_envelope, realm_index)
    VALUES (p_reservation_id, r.company_id, p_connection_id, p_actor_user_id, v_prepare, v_source, p_realm_id, p_environment, 'TrialBalance', p_start_date, p_end_date, p_accounting_method,
            p_minor_version, p_currency, p_account_count, p_raw_sha256, p_canonical_sha256, p_result_sha256, p_realm_envelope, p_realm_index)
    RETURNING id INTO v_id;
    RETURN v_id;
  END;
  $f$;

  CREATE OR REPLACE FUNCTION public.qbo_record_fiscal_pull_intent(p_period_id uuid,p_fiscal_basis jsonb,p_reservation_id uuid,p_connection_id uuid,p_actor_user_id uuid,p_realm_id text,p_environment text,p_start_date date,p_end_date date,p_accounting_method text,p_minor_version integer,p_currency text,p_account_count integer,p_raw_sha256 text,p_canonical_sha256 text,p_result_sha256 text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
  DECLARE c public.qbo_connections; p public.fiscal_periods; existing public.qbo_fiscal_pull_basis; v uuid;
  BEGIN
   SELECT * INTO c FROM public.qbo_connections WHERE id=p_connection_id FOR UPDATE;
   IF NOT FOUND OR c.status<>'active' OR c.refresh_lease_until IS NULL OR c.refresh_lease_until<=clock_timestamp() OR c.realm_id<>p_realm_id OR c.environment<>p_environment THEN RAISE EXCEPTION 'QBO_CONNECTION_UNAVAILABLE'; END IF;
   SELECT * INTO p FROM public.fiscal_periods WHERE id=p_period_id AND company_id=c.company_id FOR SHARE;
   IF NOT FOUND OR p.dates_basis IS DISTINCT FROM 'confirmed' OR p.reporting_start IS DISTINCT FROM p_start_date OR p.reporting_end IS DISTINCT FROM p_end_date OR p.reporting_currency IS DISTINCT FROM p_currency
   OR (p_fiscal_basis->>'kind') IS DISTINCT FROM 'fiscal-ytd-as-of'
   OR (p_fiscal_basis->>'fiscalStart') IS DISTINCT FROM p_start_date::text OR (p_fiscal_basis->>'asOf') IS DISTINCT FROM p_end_date::text
   OR (p_fiscal_basis->>'currency') IS DISTINCT FROM p_currency OR (p_fiscal_basis->>'accountingMethod') IS DISTINCT FROM p_accounting_method
   OR (p_fiscal_basis->>'operationLeaseId') IS DISTINCT FROM c.refresh_lease_id::text
   OR coalesce(p_fiscal_basis->>'preferencesSha256','') !~ '^[a-f0-9]{64}$'
   OR coalesce(p_fiscal_basis->>'fiscalStartMonth','') !~ '^([1-9]|1[0-2])$'
   OR extract(month FROM p_start_date)::integer<>(p_fiscal_basis->>'fiscalStartMonth')::integer OR extract(day FROM p_start_date)<>1
   OR p_end_date >= (p_start_date+interval '1 year')::date
   THEN RAISE EXCEPTION 'QBO_FISCAL_BASIS_MISMATCH'; END IF;
   SELECT * INTO existing FROM public.qbo_fiscal_pull_basis WHERE reservation_id=p_reservation_id;
   IF FOUND AND (existing.basis IS DISTINCT FROM p_fiscal_basis OR existing.period_id<>p_period_id) THEN RAISE EXCEPTION 'QBO_BASIS_CONFLICT'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.trial_balance_source_reservations WHERE id=p_reservation_id AND company_id=c.company_id AND actor_user_id=p_actor_user_id) THEN RAISE EXCEPTION 'QBO_SCOPE_MISMATCH'; END IF;
   v:=public.qbo_record_pull_intent(p_reservation_id,p_connection_id,p_actor_user_id,p_realm_id,p_environment,p_start_date,p_end_date,p_accounting_method,p_minor_version,p_currency,p_account_count,p_raw_sha256,p_canonical_sha256,p_result_sha256,
     c.realm_envelope,c.realm_index);
   INSERT INTO public.qbo_fiscal_pull_basis(reservation_id,period_id,basis) VALUES(p_reservation_id,p_period_id,p_fiscal_basis) ON CONFLICT DO NOTHING;
   RETURN v;
  END $f$;

  CREATE OR REPLACE FUNCTION public.qbo_complete_pull(p_reservation_id uuid)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE i public.qbo_pull_intents%ROWTYPE; r public.trial_balance_source_reservations%ROWTYPE; n integer;
  BEGIN
    SELECT * INTO i FROM public.qbo_pull_intents x WHERE x.reservation_id = p_reservation_id;
    IF NOT FOUND THEN RETURN 'no_intent'; END IF;
    SELECT * INTO r FROM public.trial_balance_source_reservations x WHERE x.id = p_reservation_id;
    IF NOT FOUND THEN RETURN 'no_reservation'; END IF;
    IF r.consumed_by_upload_id IS NULL THEN RETURN 'not_registered'; END IF;
    IF r.company_id <> i.company_id OR r.actor_user_id <> i.actor_user_id THEN
      RAISE EXCEPTION 'INTENT_MISMATCH: the reservation and the recorded intent disagree about the workspace or the person' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.qbo_pulls (pulled_at, company_id, upload_id, connection_id, actor_user_id, prepare_basis, source_basis, realm_id, environment, report, start_date, end_date,
                                  accounting_method, minor_version, currency, account_count, raw_sha256, canonical_sha256, result_sha256, realm_envelope, realm_index)
    VALUES (i.recorded_at, i.company_id, r.consumed_by_upload_id, i.connection_id, i.actor_user_id, i.prepare_basis, i.source_basis, i.realm_id, i.environment, i.report, i.start_date, i.end_date, i.accounting_method,
            i.minor_version, i.currency, i.account_count, i.raw_sha256, i.canonical_sha256, i.result_sha256, i.realm_envelope, i.realm_index)
    ON CONFLICT (upload_id) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN CASE WHEN n = 1 THEN 'completed' ELSE 'already' END;
  END;
  $f$;

  EXECUTE 'REVOKE ALL ON FUNCTION ' || c_new || ' FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION ' || c_new || ' TO service_role';

  -- POSTCONDITION
  IF to_regprocedure(c_old) IS NOT NULL OR to_regprocedure(c_new) IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'qbo_record_pull_intent') <> 1
     OR (SELECT p.pronargdefaults FROM pg_proc p WHERE p.oid = to_regprocedure(c_new)) <> 2
     OR position('c.realm_envelope,c.realm_index' IN pg_get_functiondef(to_regprocedure(c_fiscal))) = 0
     OR position('realmEnvelope' IN pg_get_functiondef('public.qbo_begin_disconnect(uuid,uuid,uuid)'::regprocedure)) = 0
     OR position('i.realm_envelope, i.realm_index' IN pg_get_functiondef('public.qbo_complete_pull(uuid)'::regprocedure)) = 0
     OR has_function_privilege('authenticated', to_regprocedure(c_new), 'EXECUTE') OR has_function_privilege('anon', to_regprocedure(c_new), 'EXECUTE')
     OR NOT has_function_privilege('service_role', to_regprocedure(c_new), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure(c_fiscal), 'EXECUTE') OR has_function_privilege('authenticated', 'public.qbo_begin_disconnect(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.qbo_complete_pull(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: realm protection (Phase B, evidence) is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_evidence$;
