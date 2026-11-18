-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261230400000 — QuickBooks token-key rotation: re-seal live rows from a retiring envelope key to the new one (owner custody of k1 cannot be
-- established; Lovable Cloud does not export a stored secret). AUTHORED, NOT APPLIED. Forward-only; changes no row by itself.
--   WHY: every live refresh token and realm envelope was sealed with token key k1, whose value exists only in the platform's secret store. The
--   functions now accept a NEXT key (QBO_TOKEN_KEY_NEXT_*, owner-generated and owner-vaulted) that seals while k1 still opens. This migration
--   lets the Edge Function that holds both keys move each LIVE row onto the new key, so nothing operational depends on k1 afterwards.
--   WHAT IT DOES (no existing row is changed here):
--   (1) qbo_reseal_connection_realm / qbo_reseal_disconnect_realm: replace ONE row's realm envelope with an envelope under a DIFFERENT key,
--       only while the plaintext still exists and equals the caller's, only with the row's unchanged keyed index (the index key idx1 is not
--       rotated), only if the row still holds the envelope the caller opened (compare-and-swap: a concurrent change answers 'stale'), and
--       records the fresh verification time (the caller opened the new envelope back to that plaintext). Never on a terminal connection.
--   (2) qbo_reseal_refresh_token: replace ONE live connection's refresh-token envelope by compare-and-swap, never under an import's lease.
--   (3) the connection and operation guards allow exactly that transition, and only inside those functions (a transaction-local marker that
--       names the one row): realm_envelope to an envelope under another key, realm_verified_at refreshed, realm_index and realm_id unchanged.
--   (4) qbo_realm_key_coverage(): counts of stored envelopes by key id per record type (no envelope, realm, index or row id leaves it).
--   Service role only. Historical rows (terminal connections, import intents and pulls, consumed OAuth states) are never opened by any function
--   and keep their original envelopes (append-only provenance; their plaintext realm also remains).
-- PREFLIGHT: Phase B installed, the cutover NOT installed (re-sealing compares the plaintext); a replay is a no-op.
-- POSTCONDITION: the four functions exist, service role only, and the guards carry the reseal rule.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_key_reseal$
BEGIN
  IF to_regprocedure('public.qbo_realm_key_coverage()') IS NOT NULL THEN RETURN; END IF;   -- replay
  IF to_regprocedure('public.qbo_protect_connection_realm(uuid,text,text,text)') IS NULL
     OR to_regprocedure('public.qbo_verify_disconnect_realm(uuid,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection Phase B (20261230100000-20261230300000) is not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_realm_present') THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the realm protection cutover is installed; re-sealing needs the plaintext; nothing was changed' USING ERRCODE = 'P0001';
  END IF;

  -- (3) the guards: the 20261230100000 rules unchanged, plus the one reseal transition.
  CREATE OR REPLACE FUNCTION public.qbo_connections_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $g$
  BEGIN
    IF OLD.status = 'disconnected' THEN
      RAISE EXCEPTION 'QBO_CONNECTION_TERMINAL: a disconnected connection cannot change. [id=%]', OLD.id USING ERRCODE = '23001';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.realm_id IS DISTINCT FROM OLD.realm_id
       OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'QBO_CONNECTION_IDENTITY_FIXED: company, realm, environment and creation time never change. [id=%]', OLD.id USING ERRCODE = '23001';
    END IF;
    -- [20261230100000] an envelope, an index and a verification, once written, are never changed or removed;
    -- [20261230400000] except by qbo_reseal_connection_realm for this one row: the envelope under ANOTHER key, the index unchanged, a fresh verification.
    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope) OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN
      IF NOT (coalesce(current_setting('qbo.realm_reseal', true), '') = 'connection:' || OLD.id::text
              AND OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS NOT NULL
              AND split_part(NEW.realm_envelope, '.', 2) <> split_part(OLD.realm_envelope, '.', 2)
              AND NEW.realm_index IS NOT DISTINCT FROM OLD.realm_index AND NEW.realm_verified_at IS NOT NULL) THEN
        RAISE EXCEPTION 'QBO_REALM_PROTECTION_FIXED: the realm protection of a connection is written once. [id=%]', OLD.id USING ERRCODE = '23001';
      END IF;
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END;
  $g$;
  CREATE OR REPLACE FUNCTION public.qbo_disconnect_operations_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $g$
  BEGIN
    IF NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.realm_id IS DISTINCT FROM OLD.realm_id
       OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
       OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index) THEN
      RAISE EXCEPTION 'QBO_DISCONNECT_IDENTITY_FIXED: an operation''s identity and its realm protection never change. [connection=%]', OLD.connection_id USING ERRCODE = '23001';
    END IF;
    -- [20261230400000] the envelope and its verification change only through qbo_reseal_disconnect_realm for this one operation (another key).
    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN
      IF NOT (coalesce(current_setting('qbo.realm_reseal', true), '') = 'operation:' || OLD.connection_id::text
              AND OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS NOT NULL
              AND split_part(NEW.realm_envelope, '.', 2) <> split_part(OLD.realm_envelope, '.', 2) AND NEW.realm_verified_at IS NOT NULL) THEN
        RAISE EXCEPTION 'QBO_DISCONNECT_IDENTITY_FIXED: an operation''s identity and its realm protection never change. [connection=%]', OLD.connection_id USING ERRCODE = '23001';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $g$;

  -- (1) re-seal one live connection's realm envelope.
  CREATE FUNCTION public.qbo_reseal_connection_realm(p_connection uuid, p_realm_id text, p_expected_envelope text, p_new_envelope text, p_realm_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE c public.qbo_connections%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_realm_id IS NULL OR p_expected_envelope IS NULL OR p_new_envelope IS NULL OR p_realm_index IS NULL
       OR p_new_envelope !~ '^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN RETURN 'invalid'; END IF;
    SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;
    IF c.realm_envelope IS NULL OR c.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF c.realm_envelope = p_new_envelope THEN RETURN 'already_resealed'; END IF;
    IF c.realm_envelope IS DISTINCT FROM p_expected_envelope THEN RETURN 'stale'; END IF;
    IF c.realm_id IS NULL OR c.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF c.realm_index IS DISTINCT FROM p_realm_index THEN RETURN 'index_mismatch'; END IF;
    IF split_part(p_new_envelope, '.', 2) = split_part(c.realm_envelope, '.', 2) THEN RETURN 'same_key'; END IF;
    PERFORM set_config('qbo.realm_reseal', 'connection:' || c.id::text, true);
    UPDATE public.qbo_connections SET realm_envelope = p_new_envelope, realm_verified_at = clock_timestamp() WHERE id = c.id;
    PERFORM set_config('qbo.realm_reseal', '', true);
    RETURN 'resealed';
  END;
  $f$;
  CREATE FUNCTION public.qbo_reseal_disconnect_realm(p_connection uuid, p_realm_id text, p_expected_envelope text, p_new_envelope text, p_realm_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE o public.qbo_disconnect_operations%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_realm_id IS NULL OR p_expected_envelope IS NULL OR p_new_envelope IS NULL OR p_realm_index IS NULL
       OR p_new_envelope !~ '^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN RETURN 'invalid'; END IF;
    SELECT * INTO o FROM public.qbo_disconnect_operations WHERE connection_id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF o.realm_envelope IS NULL OR o.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF o.realm_envelope = p_new_envelope THEN RETURN 'already_resealed'; END IF;
    IF o.realm_envelope IS DISTINCT FROM p_expected_envelope THEN RETURN 'stale'; END IF;
    IF o.realm_id IS NULL OR o.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF o.realm_index IS DISTINCT FROM p_realm_index THEN RETURN 'index_mismatch'; END IF;
    IF split_part(p_new_envelope, '.', 2) = split_part(o.realm_envelope, '.', 2) THEN RETURN 'same_key'; END IF;
    PERFORM set_config('qbo.realm_reseal', 'operation:' || o.connection_id::text, true);
    UPDATE public.qbo_disconnect_operations SET realm_envelope = p_new_envelope, realm_verified_at = clock_timestamp() WHERE connection_id = o.connection_id;
    PERFORM set_config('qbo.realm_reseal', '', true);
    RETURN 'resealed';
  END;
  $f$;

  -- (2) re-seal one live connection's refresh token (compare-and-swap; an import holding the lease rotates the token itself).
  CREATE FUNCTION public.qbo_reseal_refresh_token(p_connection uuid, p_expected_envelope text, p_new_envelope text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE c public.qbo_connections%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_expected_envelope IS NULL OR p_new_envelope IS NULL
       OR p_new_envelope !~ '^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN RETURN 'invalid'; END IF;
    SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;
    IF c.refresh_token_envelope IS NULL THEN RETURN 'no_token'; END IF;
    IF c.refresh_token_envelope = p_new_envelope THEN RETURN 'already_resealed'; END IF;
    IF c.refresh_lease_until IS NOT NULL AND c.refresh_lease_until > clock_timestamp() THEN RETURN 'busy'; END IF;
    IF c.refresh_token_envelope IS DISTINCT FROM p_expected_envelope THEN RETURN 'stale'; END IF;
    IF split_part(p_new_envelope, '.', 2) = split_part(c.refresh_token_envelope, '.', 2) THEN RETURN 'same_key'; END IF;
    UPDATE public.qbo_connections SET refresh_token_envelope = p_new_envelope, envelope_key_id = split_part(p_new_envelope, '.', 2) WHERE id = c.id;
    RETURN 'resealed';
  END;
  $f$;

  -- (4) envelope counts by key id (aggregates only).
  CREATE FUNCTION public.qbo_realm_key_coverage()
  RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
    SELECT coalesce(jsonb_object_agg(kind || ':' || key_id, n), '{}'::jsonb) FROM (
      SELECT 'live_refresh_token' kind, split_part(refresh_token_envelope, '.', 2) key_id, count(*) n FROM public.qbo_connections WHERE status <> 'disconnected' AND refresh_token_envelope IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'live_realm', split_part(realm_envelope, '.', 2), count(*) FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_envelope IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'operation_realm', split_part(realm_envelope, '.', 2), count(*) FROM public.qbo_disconnect_operations WHERE realm_envelope IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'pending_revocation_token', split_part(pending_envelope, '.', 2), count(*) FROM public.qbo_disconnect_operations WHERE outcome = 'pending' AND pending_envelope IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'terminal_realm', split_part(realm_envelope, '.', 2), count(*) FROM public.qbo_connections WHERE status = 'disconnected' AND realm_envelope IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'intent_realm', split_part(realm_envelope, '.', 2), count(*) FROM public.qbo_pull_intents WHERE realm_envelope IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'pull_realm', split_part(realm_envelope, '.', 2), count(*) FROM public.qbo_pulls WHERE realm_envelope IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'oauth_state', split_part(coalesce(realm_envelope, code_envelope), '.', 2), count(*) FROM public.qbo_oauth_states WHERE coalesce(realm_envelope, code_envelope) IS NOT NULL GROUP BY 2
    ) t;
  $f$;

  REVOKE ALL ON FUNCTION public.qbo_reseal_connection_realm(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.qbo_reseal_disconnect_realm(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.qbo_reseal_refresh_token(uuid, text, text) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.qbo_realm_key_coverage() FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.qbo_reseal_connection_realm(uuid, text, text, text, text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.qbo_reseal_disconnect_realm(uuid, text, text, text, text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.qbo_reseal_refresh_token(uuid, text, text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.qbo_realm_key_coverage() TO service_role;

  -- POSTCONDITION
  IF to_regprocedure('public.qbo_realm_key_coverage()') IS NULL OR to_regprocedure('public.qbo_reseal_refresh_token(uuid,text,text)') IS NULL
     OR has_function_privilege('authenticated', 'public.qbo_reseal_connection_realm(uuid,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.qbo_reseal_disconnect_realm(uuid,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.qbo_realm_key_coverage()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.qbo_reseal_refresh_token(uuid,text,text)', 'EXECUTE')
     OR position('qbo.realm_reseal' IN pg_get_functiondef('public.qbo_connections_guard()'::regprocedure)) = 0
     OR position('qbo.realm_reseal' IN pg_get_functiondef('public.qbo_disconnect_operations_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: the QuickBooks key reseal is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_key_reseal$;
