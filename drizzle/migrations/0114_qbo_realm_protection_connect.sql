-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261230200000 — QuickBooks realmID protection, Phase B part 1 (connect: dual write; no realm to the browser). AUTHORED, NOT APPLIED to any
-- hosted database. Forward-only; needs 20261230100000. Reversible: the plaintext realm_id is still written beside the protection.
--
--   WHAT IT DOES (design: docs/release/qbo-realm-protection-r1/README.md):
--   (1) qbo_record_oauth_return gains three trailing parameters (the realm sealed to the handoff, and its index for each environment; the
--       state's own environment's index is kept): all three or none, and never without a parked code. qbo_take_oauth_return also returns them.
--   (2) qbo_store_connection gains p_realm_envelope / p_realm_index: both or neither; a new connection stores them; a reconnect keeps the
--       protection already written (it is written once) and refuses a different index for the same realm (QBO_REALM_INDEX_CONFLICT).
--   (3) qbo_connection_status no longer returns realm_id: a member's browser never receives a realm (the page shows "QuickBooks company
--       connected on <date>"; an import names the connection by its id).
--   Each replaced signature is DROPPED in the same transaction (one function per name). The trailing parameters default to NULL so that a function
--   deployed before this release still resolves and keeps working; what it writes unprotected is protected by the backfill (qbo-realm-protect).
--   Grants are restated exactly as before.
--
-- PREFLIGHT: 20261230100000 installed and the earlier signatures present; a replay is a no-op. POSTCONDITION: one function per name, the new
-- signatures with their defaults, the same grants, no realm_id in qbo_connection_status. One DO block: atomic whatever the transaction mode.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_connect$
DECLARE
  c_old constant text[] := ARRAY['public.qbo_record_oauth_return(text,text,text,text)', 'public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz)'];
  c_new constant text[] := ARRAY['public.qbo_record_oauth_return(text,text,text,text,text,text,text)', 'public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)',
    'public.qbo_take_oauth_return(text,uuid)'];
  f text;
BEGIN
  IF (SELECT bool_and(to_regprocedure(x) IS NULL) FROM unnest(c_old) x) AND (SELECT bool_and(to_regprocedure(x) IS NOT NULL) FROM unnest(c_new) x)
     AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.qbo_connection_status(uuid)'::regprocedure AND 'realm_id' = ANY (p.proargnames)) THEN
    RETURN;   -- replay
  END IF;
  IF to_regprocedure('public.qbo_realm_protection_status()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261230100000 (realm protection schema) is not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT bool_or(to_regprocedure(x) IS NULL) FROM unnest(c_old) x) OR to_regprocedure('public.qbo_take_oauth_return(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: an earlier QuickBooks function signature is absent (half-installed state); nothing was changed' USING ERRCODE = 'P0001';
  END IF;

  -- (1) the OAuth return: the realm parked sealed, with the state's own index.
  DROP FUNCTION public.qbo_record_oauth_return(text, text, text, text);
  CREATE FUNCTION public.qbo_record_oauth_return(p_state_hash text, p_realm_id text, p_code_envelope text, p_handoff_hash text,
                                                 p_realm_envelope text DEFAULT NULL, p_realm_index_sandbox text DEFAULT NULL, p_realm_index_production text DEFAULT NULL)
  RETURNS TABLE (company_id uuid, environment text, return_period_year integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE r record; v_park boolean;
  BEGIN
    IF p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
    v_park := p_code_envelope IS NOT NULL;
    IF v_park <> (p_realm_id IS NOT NULL) OR v_park <> (p_handoff_hash IS NOT NULL) THEN RETURN; END IF;
    -- [20261230200000] the protection travels whole or not at all, and only with a parked code: refused before anything changes.
    IF (p_realm_envelope IS NULL) <> (p_realm_index_sandbox IS NULL) OR (p_realm_envelope IS NULL) <> (p_realm_index_production IS NULL)
       OR (p_realm_envelope IS NOT NULL AND NOT v_park) THEN RETURN; END IF;
    UPDATE public.qbo_oauth_states s SET consumed_at = clock_timestamp()
     WHERE s.state_hash = p_state_hash AND s.consumed_at IS NULL AND s.expires_at > clock_timestamp()
    RETURNING s.id AS i, s.company_id AS c, s.actor_user_id AS a, s.environment AS e, s.return_period_year AS y INTO r;
    IF NOT FOUND THEN RETURN; END IF;
    IF NOT public.qbo_connector_basis(r.a, r.c) THEN RETURN; END IF;
    IF v_park THEN
      UPDATE public.qbo_oauth_states SET realm_id = p_realm_id, code_envelope = p_code_envelope, handoff_hash = p_handoff_hash,
             handoff_expires_at = clock_timestamp() + interval '5 minutes', realm_envelope = p_realm_envelope,
             realm_index = CASE r.e WHEN 'sandbox' THEN p_realm_index_sandbox ELSE p_realm_index_production END
       WHERE id = r.i;
    END IF;
    RETURN QUERY SELECT r.c, r.e, r.y;
  END;
  $f$;

  DROP FUNCTION public.qbo_take_oauth_return(text, uuid);
  CREATE FUNCTION public.qbo_take_oauth_return(p_handoff_hash text, p_actor_user_id uuid)
  RETURNS TABLE (outcome text, company_id uuid, environment text, realm_id text, code_envelope text, realm_envelope text, realm_index text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE s public.qbo_oauth_states%ROWTYPE; v text;
  BEGIN
    IF p_handoff_hash IS NULL OR p_handoff_hash !~ '^[0-9a-f]{64}$' OR p_actor_user_id IS NULL THEN
      RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text; RETURN;
    END IF;
    SELECT * INTO s FROM public.qbo_oauth_states x WHERE x.handoff_hash = p_handoff_hash AND x.finished_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text; RETURN; END IF;
    v := CASE WHEN s.actor_user_id <> p_actor_user_id THEN 'not_yours'
              WHEN s.handoff_expires_at <= clock_timestamp() OR s.code_envelope IS NULL THEN 'expired'
              WHEN NOT public.qbo_connector_basis(p_actor_user_id, s.company_id) THEN 'forbidden'
              ELSE 'taken' END;
    UPDATE public.qbo_oauth_states x SET finished_at = clock_timestamp(), finish_outcome = v, code_envelope = NULL WHERE x.id = s.id;
    IF v = 'taken' THEN
      RETURN QUERY SELECT v, s.company_id, s.environment, s.realm_id, s.code_envelope, s.realm_envelope, s.realm_index;
    ELSE
      RETURN QUERY SELECT v, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text;
    END IF;
  END;
  $f$;

  -- (2) store: the protection is stored with a new connection and kept, never replaced, on reconnect.
  DROP FUNCTION public.qbo_store_connection(uuid, uuid, text, text, text, timestamptz, timestamptz);
  CREATE FUNCTION public.qbo_store_connection(p_company_id uuid, p_actor_user_id uuid, p_realm_id text, p_environment text, p_envelope text,
                                              p_refresh_expires_at timestamptz, p_hard_expires_at timestamptz, p_realm_envelope text DEFAULT NULL, p_realm_index text DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE c public.qbo_connections%ROWTYPE; v_id uuid;
  BEGIN
    IF NOT public.qbo_connector_basis(p_actor_user_id, p_company_id) THEN
      RAISE EXCEPTION 'FORBIDDEN: no right to connect QuickBooks in this workspace' USING ERRCODE = '42501';
    END IF;
    IF (p_realm_envelope IS NULL) <> (p_realm_index IS NULL) THEN
      RAISE EXCEPTION 'QBO_REALM_PROTECTION_INCOMPLETE: an envelope and an index, or neither' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('qbo-connect:'||p_environment||':'||p_realm_id,0));
    IF EXISTS(SELECT 1 FROM public.qbo_disconnect_operations WHERE realm_id=p_realm_id AND environment=p_environment AND outcome='pending') THEN RAISE EXCEPTION 'QBO_REVOKE_PENDING' USING ERRCODE='PT409'; END IF;
    IF EXISTS(SELECT 1 FROM public.qbo_connections WHERE company_id=p_company_id AND realm_id=p_realm_id AND environment=p_environment AND refresh_lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'QBO_OPERATION_BUSY' USING ERRCODE='PT409'; END IF;
    SELECT * INTO c FROM public.qbo_connections
     WHERE company_id = p_company_id AND realm_id = p_realm_id AND environment = p_environment AND status <> 'disconnected' FOR UPDATE;
    IF FOUND THEN
      IF c.realm_index IS NOT NULL AND p_realm_index IS NOT NULL AND c.realm_index <> p_realm_index THEN
        RAISE EXCEPTION 'QBO_REALM_INDEX_CONFLICT: this connection already carries a different realm index' USING ERRCODE = '23505';
      END IF;
      UPDATE public.qbo_connections SET status = 'active', refresh_token_envelope = p_envelope, envelope_key_id = split_part(p_envelope, '.', 2),
             refresh_expires_at = p_refresh_expires_at, hard_expires_at = p_hard_expires_at, connected_by_user_id = p_actor_user_id, refresh_lease_until = NULL,
             refresh_lease_id = NULL, realm_envelope = coalesce(c.realm_envelope, p_realm_envelope), realm_index = coalesce(c.realm_index, p_realm_index)
       WHERE id = c.id;
      v_id := c.id;
    ELSE
      INSERT INTO public.qbo_connections (company_id, connected_by_user_id, realm_id, environment, status, refresh_token_envelope, envelope_key_id, refresh_expires_at, hard_expires_at, realm_envelope, realm_index)
      VALUES (p_company_id, p_actor_user_id, p_realm_id, p_environment, 'active', p_envelope, split_part(p_envelope, '.', 2), p_refresh_expires_at, p_hard_expires_at, p_realm_envelope, p_realm_index)
      RETURNING id INTO v_id;
    END IF;
    RETURN v_id;
  END;
  $f$;

  -- (3) members see status, never a realm.
  DROP FUNCTION public.qbo_connection_status(uuid);
  CREATE FUNCTION public.qbo_connection_status(p_company_id uuid)
  RETURNS TABLE (id uuid, environment text, status text, refresh_expires_at timestamptz, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
    SELECT c.id, c.environment, c.status, c.refresh_expires_at, c.created_at
      FROM public.qbo_connections c
     WHERE c.company_id = p_company_id AND auth.uid() IS NOT NULL
       AND public.qbo_connector_basis(auth.uid(), p_company_id)
     ORDER BY c.created_at DESC;
  $f$;

  FOREACH f IN ARRAY c_new LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO service_role';
  END LOOP;
  REVOKE ALL ON FUNCTION public.qbo_connection_status(uuid) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.qbo_connection_status(uuid) TO authenticated;

  -- POSTCONDITION
  IF (SELECT bool_or(to_regprocedure(x) IS NOT NULL) FROM unnest(c_old) x) OR (SELECT bool_or(to_regprocedure(x) IS NULL) FROM unnest(c_new) x)
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
          AND p.proname IN ('qbo_record_oauth_return', 'qbo_store_connection', 'qbo_take_oauth_return', 'qbo_connection_status')) <> 4
     OR (SELECT p.pronargdefaults FROM pg_proc p WHERE p.oid = to_regprocedure(c_new[1])) <> 3
     OR (SELECT p.pronargdefaults FROM pg_proc p WHERE p.oid = to_regprocedure(c_new[2])) <> 2
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(c_new[3]) AND 'realm_envelope' = ANY (p.proargnames))
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.qbo_connection_status(uuid)'::regprocedure AND 'realm_id' = ANY (p.proargnames))
     OR (SELECT bool_or(has_function_privilege('authenticated', x::regprocedure, 'EXECUTE') OR has_function_privilege('anon', x::regprocedure, 'EXECUTE')
                        OR NOT has_function_privilege('service_role', x::regprocedure, 'EXECUTE')) FROM unnest(c_new) x)
     OR has_function_privilege('anon', 'public.qbo_connection_status(uuid)', 'EXECUTE') OR NOT has_function_privilege('authenticated', 'public.qbo_connection_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: realm protection (Phase B, connect) is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_connect$;
