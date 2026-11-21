-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261231200000 — QuickBooks realmID protection, Phase C v2 (CUTOVER), part 2 of 4: the database's realm rules move to the keyed index and no NEW
-- row holds a plaintext realm. AUTHORED, NOT APPLIED. *** Phase C is IRREVERSIBLE FOR THE PLAINTEXT once part 4 (20261231300000) runs. ***
--   GATE (before anything changes): as part 1. Needs part 1 applied.
--   WHAT IT DOES (no existing row is changed):
--   (1) uniqueness, the per-realm lock, the pending-revocation and shared-realm checks use realm_index (as v1, PR #282);
--   (2) the OAuth return, store, begin-disconnect and both pull-intent writers require the protection and never store a plaintext realm (as v1);
--   (3) [v2] store and begin-disconnect compare indexes only while every live connection and pending revocation is on ONE index key
--       (qbo_index_key_mixed); mid-rotation they refuse (QBO_INDEX_ROTATION_IN_PROGRESS / 'rotation_in_progress') rather than create a duplicate
--       live connection or revoke a token another workspace still uses. Lock 'qbo-index-rotation': shared here, exclusive in every re-index;
--   (4) the backfill writers, which compare a plaintext that is about to disappear, are dropped (qbo_realm_protection_status stays).
--   Signatures and grants are unchanged.
-- SELF-VERIFYING: it accepts its result only if all five bodies it installs or replaces hash to the digests pinned below (the fiscal wrapper is rebuilt
--   from its live text by exactly one anchored replacement, its old body pinned too); otherwise the whole block fails and nothing changes.
-- PREFLIGHT: part 1 installed; a replay with the reviewed bodies is a no-op; a replay over anything else is refused.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_cutover_functions$
DECLARE v_conn integer; v_ops integer; v_def text;
  pin_f constant text[] := ARRAY['public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)',
    'public.qbo_begin_disconnect(uuid,uuid,uuid)',
    'public.qbo_record_oauth_return(text,text,text,text,text,text,text)',
    'public.qbo_record_pull_intent(uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text,text,text)',
    'public.qbo_record_fiscal_pull_intent(uuid,jsonb,uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text)'];
  pin_d constant text[] := ARRAY['c3d0b5fbf6e27948eae7ee94615d703b2c47458b3830e82afd3901565a4d432a',
    '3782a5b866900544e5d680125d5a775573bb1861a57d4d8c439555a4f0f68f9e',
    '1d83d3736825cdfa71392df83e3ef66e6a7f4a15ca7087f8e1e8d1d6ca473f0a',
    '35035edca3ecaa667be0f246f71c0d9c8ab5f15612e7443eccdad7090b6f65b3',
    '8edb63f9724ea7490923fca43e53015be172f7dad03ddcb1b92ed0b0b15e58e6'];
  c_store constant text := 'public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)';
  c_fiscal constant text := 'public.qbo_record_fiscal_pull_intent(uuid,jsonb,uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text)';
BEGIN
  IF to_regprocedure('public.qbo_protect_connection_realm(uuid,text,text,text)') IS NULL AND to_regprocedure('public.qbo_index_key_mixed(text)') IS NOT NULL THEN   -- replay (part 1 present, writers gone)
    IF EXISTS (SELECT 1 FROM unnest(pin_f, pin_d) v(f, d)
     WHERE (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure(v.f)) IS DISTINCT FROM v.d) THEN
      RAISE EXCEPTION 'PREFLIGHT_REFUSED: the cutover functions are installed with unexpected bodies; nothing was changed' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_realm_present') OR to_regprocedure('public.qbo_protect_connection_realm(uuid,text,text,text)') IS NULL
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_index_key_mixed(text)')) IS DISTINCT FROM '3ec271dcead5afca437eaa4831fdfe3b1f94c6265b679ad173f010b922df93ee' THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection cutover part 1 (20261231100000) is not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES ('public.qbo_record_fiscal_pull_intent(uuid,jsonb,uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text)', '23a522bc9d8441eb4284c7c9ba8a70bd082d0c04f294679b84c54c8c4b39a54b')) v(f, d)
     WHERE (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure(v.f)) IS DISTINCT FROM v.d) THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: qbo_record_fiscal_pull_intent is not the reviewed body; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_conn FROM public.qbo_connections WHERE status <> 'disconnected' AND (realm_envelope IS NULL OR realm_index IS NULL OR (realm_id IS NOT NULL AND realm_verified_at IS NULL));
  SELECT count(*) INTO v_ops FROM public.qbo_disconnect_operations WHERE realm_envelope IS NULL OR realm_index IS NULL OR (realm_id IS NOT NULL AND realm_verified_at IS NULL);
  IF v_conn <> 0 OR v_ops <> 0 THEN
    RAISE EXCEPTION 'QBO_REALM_CUTOVER_REFUSED: % live connection(s) and % disconnect operation(s) are not protected and verified; run qbo-realm-protect protect, then verify; nothing was changed', v_conn, v_ops USING ERRCODE = 'P0001';
  END IF;

  CREATE OR REPLACE FUNCTION public.qbo_record_oauth_return(p_state_hash text, p_realm_id text, p_code_envelope text, p_handoff_hash text,
                                                            p_realm_envelope text DEFAULT NULL, p_realm_index_sandbox text DEFAULT NULL, p_realm_index_production text DEFAULT NULL)
  RETURNS TABLE (company_id uuid, environment text, return_period_year integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE r record; v_park boolean;
  BEGIN
    IF p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
    v_park := p_code_envelope IS NOT NULL;
    -- [20261231100000] a parked code needs its protected realm (envelope and both indexes); a plaintext p_realm_id is never stored.
    IF v_park <> (p_handoff_hash IS NOT NULL) OR v_park <> (p_realm_envelope IS NOT NULL) OR v_park <> (p_realm_index_sandbox IS NOT NULL)
       OR v_park <> (p_realm_index_production IS NOT NULL) OR (p_realm_id IS NOT NULL AND NOT v_park) THEN RETURN; END IF;
    UPDATE public.qbo_oauth_states s SET consumed_at = clock_timestamp()
     WHERE s.state_hash = p_state_hash AND s.consumed_at IS NULL AND s.expires_at > clock_timestamp()
    RETURNING s.id AS i, s.company_id AS c, s.actor_user_id AS a, s.environment AS e, s.return_period_year AS y INTO r;
    IF NOT FOUND THEN RETURN; END IF;
    IF NOT public.qbo_connector_basis(r.a, r.c) THEN RETURN; END IF;
    IF v_park THEN
      UPDATE public.qbo_oauth_states SET code_envelope = p_code_envelope, handoff_hash = p_handoff_hash, handoff_expires_at = clock_timestamp() + interval '5 minutes',
             realm_envelope = p_realm_envelope, realm_index = CASE r.e WHEN 'sandbox' THEN p_realm_index_sandbox ELSE p_realm_index_production END
       WHERE id = r.i;
    END IF;
    RETURN QUERY SELECT r.c, r.e, r.y;
  END;
  $f$;

  CREATE OR REPLACE FUNCTION public.qbo_store_connection(p_company_id uuid, p_actor_user_id uuid, p_realm_id text, p_environment text, p_envelope text,
                                              p_refresh_expires_at timestamptz, p_hard_expires_at timestamptz, p_realm_envelope text DEFAULT NULL, p_realm_index text DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE c public.qbo_connections%ROWTYPE; v_id uuid;
  BEGIN
    IF NOT public.qbo_connector_basis(p_actor_user_id, p_company_id) THEN
      RAISE EXCEPTION 'FORBIDDEN: no right to connect QuickBooks in this workspace' USING ERRCODE = '42501';
    END IF;
    -- [20261231100000] the realm is known to the database only as its envelope and index; p_realm_id (a Phase B caller's) is never stored.
    IF p_realm_envelope IS NULL OR p_realm_index IS NULL THEN
      RAISE EXCEPTION 'QBO_REALM_PROTECTION_REQUIRED: a connection is stored only with its realm envelope and index' USING ERRCODE = '22023';
    END IF;
    -- [Phase C v2] index-key homogeneity: equality on realm_index is only sound while every live row and pending revocation carries an index made
    -- by the same key as this one. During an index rotation it is refused (retry when the rotation completes), never answered by a duplicate.
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('qbo-index-rotation', 0));
    IF public.qbo_index_key_mixed(split_part(p_realm_index, '.', 2)) THEN
      RAISE EXCEPTION 'QBO_INDEX_ROTATION_IN_PROGRESS: an index-key rotation is in progress; try again when it completes' USING ERRCODE = 'PT409';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('qbo-connect:'||p_environment||':'||p_realm_index,0));
    IF EXISTS(SELECT 1 FROM public.qbo_disconnect_operations WHERE realm_index=p_realm_index AND environment=p_environment AND outcome='pending') THEN RAISE EXCEPTION 'QBO_REVOKE_PENDING' USING ERRCODE='PT409'; END IF;
    IF EXISTS(SELECT 1 FROM public.qbo_connections WHERE company_id=p_company_id AND realm_index=p_realm_index AND environment=p_environment AND refresh_lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'QBO_OPERATION_BUSY' USING ERRCODE='PT409'; END IF;
    SELECT * INTO c FROM public.qbo_connections
     WHERE company_id = p_company_id AND realm_index = p_realm_index AND environment = p_environment AND status <> 'disconnected' FOR UPDATE;
    IF FOUND THEN
      UPDATE public.qbo_connections SET status = 'active', refresh_token_envelope = p_envelope, envelope_key_id = split_part(p_envelope, '.', 2),
             refresh_expires_at = p_refresh_expires_at, hard_expires_at = p_hard_expires_at, connected_by_user_id = p_actor_user_id, refresh_lease_until = NULL, refresh_lease_id = NULL
       WHERE id = c.id;
      v_id := c.id;
    ELSE
      INSERT INTO public.qbo_connections (company_id, connected_by_user_id, realm_id, environment, status, refresh_token_envelope, envelope_key_id, refresh_expires_at, hard_expires_at, realm_envelope, realm_index)
      VALUES (p_company_id, p_actor_user_id, NULL, p_environment, 'active', p_envelope, split_part(p_envelope, '.', 2), p_refresh_expires_at, p_hard_expires_at, p_realm_envelope, p_realm_index)
      RETURNING id INTO v_id;
    END IF;
    RETURN v_id;
  END;
  $f$;

  CREATE OR REPLACE FUNCTION public.qbo_begin_disconnect(p_connection uuid,p_actor uuid,p_request uuid)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $f$
  DECLARE c public.qbo_connections; o public.qbo_disconnect_operations; ticket uuid;
  BEGIN
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('qbo-index-rotation', 0));   -- [Phase C v2] no index rotation can commit inside this call
   SELECT * INTO c FROM public.qbo_connections WHERE id=p_connection;
   -- [20261231100000] the per-realm lock and the shared-realm check use the index (a terminal pre-protection row locks on its own id).
   IF FOUND THEN PERFORM pg_advisory_xact_lock(hashtextextended('qbo-connect:'||c.environment||':'||coalesce(c.realm_index,c.id::text),0)); END IF;
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
    RETURN jsonb_build_object('outcome',o.outcome,'leaseId',ticket,'envelope',o.pending_envelope,'companyId',c.company_id,'environment',c.environment,'realmEnvelope',o.realm_envelope,'realmIndex',o.realm_index);
   END IF;
   IF EXISTS(SELECT 1 FROM public.qbo_disconnect_operations WHERE request_id=p_request) THEN RETURN jsonb_build_object('outcome','request_conflict'); END IF;
   IF c.status='disconnected' THEN RETURN jsonb_build_object('outcome','local_only'); END IF;
   IF c.refresh_lease_until>clock_timestamp() THEN RETURN jsonb_build_object('outcome','busy'); END IF;
   -- [Phase C v2] the shared-realm check compares indexes: refused while they could be made by different keys (it would miss a sharer and revoke
   -- a token another workspace still uses).
   IF c.realm_index IS NOT NULL AND public.qbo_index_key_mixed(split_part(c.realm_index, '.', 2)) THEN RETURN jsonb_build_object('outcome','rotation_in_progress'); END IF;
   IF EXISTS(SELECT 1 FROM public.qbo_connections x WHERE x.id<>c.id AND x.realm_index=c.realm_index AND x.environment=c.environment AND x.status='active') THEN RETURN jsonb_build_object('outcome','shared_connection'); END IF;
   INSERT INTO public.qbo_disconnect_operations(connection_id,request_id,actor_user_id,company_id,realm_id,environment,pending_envelope,outcome,realm_envelope,realm_index,realm_verified_at)
   VALUES(c.id,p_request,p_actor,c.company_id,NULL,c.environment,c.refresh_token_envelope,CASE WHEN c.refresh_token_envelope IS NULL THEN 'local_only' ELSE 'pending' END,
          c.realm_envelope,c.realm_index,c.realm_verified_at);
   UPDATE public.qbo_connections SET status='disconnected',refresh_token_envelope=NULL,envelope_key_id=NULL,refresh_expires_at=NULL,hard_expires_at=NULL,
   refresh_lease_until=NULL,refresh_lease_id=NULL,disconnected_at=clock_timestamp() WHERE id=c.id;
   ticket:=gen_random_uuid(); UPDATE public.qbo_disconnect_operations SET revoke_lease_id=ticket,revoke_lease_until=clock_timestamp()+interval '45 seconds' WHERE connection_id=c.id AND outcome='pending';
   RETURN jsonb_build_object('outcome',CASE WHEN c.refresh_token_envelope IS NULL THEN 'local_only' ELSE 'pending' END,'leaseId',ticket,'envelope',c.refresh_token_envelope,'companyId',c.company_id,
     'environment',c.environment,'realmEnvelope',c.realm_envelope,'realmIndex',c.realm_index);
  END $f$;

  -- Import evidence: a new intent carries the connection's protection and no plaintext. The fiscal wrapper no longer compares a plaintext.
  CREATE OR REPLACE FUNCTION public.qbo_record_pull_intent(p_reservation_id uuid, p_connection_id uuid, p_actor_user_id uuid, p_realm_id text, p_environment text,
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
    IF p_realm_envelope IS NULL OR p_realm_index IS NULL THEN
      RAISE EXCEPTION 'QBO_REALM_PROTECTION_REQUIRED: an import is recorded only with the realm envelope and index' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.qbo_pull_intents (reservation_id, company_id, connection_id, actor_user_id, prepare_basis, source_basis, realm_id, environment, report, start_date, end_date,
                                         accounting_method, minor_version, currency, account_count, raw_sha256, canonical_sha256, result_sha256, realm_envelope, realm_index)
    VALUES (p_reservation_id, r.company_id, p_connection_id, p_actor_user_id, v_prepare, v_source, NULL, p_environment, 'TrialBalance', p_start_date, p_end_date, p_accounting_method,
            p_minor_version, p_currency, p_account_count, p_raw_sha256, p_canonical_sha256, p_result_sha256, p_realm_envelope, p_realm_index)
    RETURNING id INTO v_id;
    RETURN v_id;
  END;
  $f$;
  -- The fiscal wrapper, from its live text, with exactly one anchored replacement: the plaintext comparison becomes "the connection is protected".
  v_def := pg_get_functiondef(to_regprocedure(c_fiscal));
  IF (length(v_def) - length(replace(v_def, 'OR c.realm_id<>p_realm_id OR c.environment<>p_environment', ''))) / length('OR c.realm_id<>p_realm_id OR c.environment<>p_environment') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the qbo_record_fiscal_pull_intent anchor is not the 20261230300000 text; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  EXECUTE replace(v_def, 'OR c.realm_id<>p_realm_id OR c.environment<>p_environment', 'OR c.realm_index IS NULL OR c.environment<>p_environment');

  DROP FUNCTION public.qbo_protect_connection_realm(uuid, text, text, text);
  DROP FUNCTION public.qbo_protect_disconnect_realm(uuid, text, text, text);
  DROP FUNCTION public.qbo_verify_connection_realm(uuid, text, text, text);
  DROP FUNCTION public.qbo_verify_disconnect_realm(uuid, text, text, text);

  -- POSTCONDITION: every installed body exactly as reviewed; the writers gone; grants unchanged.
  IF to_regprocedure('public.qbo_verify_connection_realm(uuid,text,text,text)') IS NOT NULL OR to_regprocedure('public.qbo_protect_disconnect_realm(uuid,text,text,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM unnest(pin_f, pin_d) v(f, d)
     WHERE (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure(v.f)) IS DISTINCT FROM v.d)
     OR has_function_privilege('authenticated', to_regprocedure(c_store), 'EXECUTE') OR NOT has_function_privilege('service_role', to_regprocedure(c_store), 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: realm protection cutover (part 2, functions) is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_cutover_functions$;
