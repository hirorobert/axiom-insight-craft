-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261230100000 — QuickBooks realmID protection, Phase A (additive schema). AUTHORED, NOT APPLIED to any hosted database.
-- Forward-only; additive; reversible (the new columns hold only derived data while the plaintext realm_id is unchanged).
--
--   WHY: Intuit (support case 00232331, answer of 9 Nov 2026): "Refresh tokens and realmID must both be encrypted in persistent storage (AES
--   preferred), with the key in separate server-side configuration. Host encryption at rest is not enough for realmID if the app stores it in the
--   clear." The refresh token is already an AES-256-GCM envelope; the realmID is stored in clear in five tables. This migration adds the columns
--   that hold it protected; 20261230200000 (Phase B) makes the functions write them; a later, separately approved cutover removes the plaintext.
--   Design: docs/release/qbo-realm-protection-r1/README.md. Module: supabase/functions/_shared/qboRealmProtection.ts.
--
--   WHAT IT DOES (nothing existing is rewritten; every current function keeps working unmodified):
--   (1) realm_envelope (the realm sealed with the token key ring, purpose qbo-realm-id) and realm_index (keyed HMAC-SHA256 equality index,
--       its own key) on qbo_connections, qbo_disconnect_operations, qbo_oauth_states, qbo_pull_intents and qbo_pulls, both NULL or both set,
--       shape-checked; realm_verified_at on connections and disconnect operations (set only by the verification pass). The append-only
--       intents and pulls keep their guards: historical rows are never touched (option (a) of the design); new rows carry the protection.
--   (2) uq_qbo_connections_live_protected: one live connection per (workspace, realm index, environment).
--   (3) qbo_connections_guard (re-created): as before, plus the protection is written once and never changed or removed. A new guard on
--       qbo_disconnect_operations does the same and keeps an operation's identity fixed.
--   (4) Service-role-only functions: qbo_protect_connection_realm / qbo_protect_disconnect_realm (fill the protection of ONE existing row;
--       refuse unless the supplied plaintext equals the row's; never overwrite; never touch a terminal connection), qbo_verify_connection_realm /
--       qbo_verify_disconnect_realm (record that a function holding the keys opened the stored envelope to exactly the stored plaintext), and
--       qbo_realm_protection_status() (counts only).
--
-- PREFLIGHT: the QuickBooks tables (20261213100000, 20261214100000) exist and none of the new objects does. A replay (everything present) is a
-- no-op. POSTCONDITION: every column, constraint, index, guard and function installed exactly as reviewed; the new functions executable by
-- service_role only. One DO block: atomic whatever the migrator's transaction mode.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_schema$
DECLARE
  c_fns constant text[] := ARRAY['public.qbo_protect_connection_realm(uuid,text,text,text)', 'public.qbo_protect_disconnect_realm(uuid,text,text,text)',
    'public.qbo_verify_connection_realm(uuid,text,text,text)', 'public.qbo_verify_disconnect_realm(uuid,text,text,text)', 'public.qbo_realm_protection_status()'];
  c_tables constant text[] := ARRAY['qbo_connections', 'qbo_disconnect_operations', 'qbo_oauth_states', 'qbo_pull_intents', 'qbo_pulls'];
  f text; t text; v_present integer;
BEGIN
  SELECT count(*) INTO v_present FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY (c_tables) AND column_name IN ('realm_envelope', 'realm_index', 'realm_verified_at');
  IF v_present = 12 AND (SELECT bool_and(to_regprocedure(x) IS NOT NULL) FROM unnest(c_fns) x) THEN RETURN; END IF;   -- replay
  FOREACH t IN ARRAY c_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE EXCEPTION 'PREFLIGHT_REFUSED: public.% is absent (20261213100000/20261214100000 first); nothing was changed', t USING ERRCODE = 'P0001'; END IF;
  END LOOP;
  IF v_present <> 0 OR (SELECT bool_or(to_regprocedure(x) IS NOT NULL) FROM unnest(c_fns) x) THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection is partly installed (% columns); nothing was changed', v_present USING ERRCODE = 'P0001';
  END IF;

  -- (1) columns and their shapes. Adding a nullable column rewrites no row and fires no row trigger.
  ALTER TABLE public.qbo_connections ADD COLUMN realm_envelope text, ADD COLUMN realm_index text, ADD COLUMN realm_verified_at timestamptz;
  ALTER TABLE public.qbo_disconnect_operations ADD COLUMN realm_envelope text, ADD COLUMN realm_index text, ADD COLUMN realm_verified_at timestamptz;
  ALTER TABLE public.qbo_oauth_states ADD COLUMN realm_envelope text, ADD COLUMN realm_index text;
  ALTER TABLE public.qbo_pull_intents ADD COLUMN realm_envelope text, ADD COLUMN realm_index text;
  ALTER TABLE public.qbo_pulls ADD COLUMN realm_envelope text, ADD COLUMN realm_index text;
  FOREACH t IN ARRAY c_tables LOOP
    EXECUTE format($c$ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ((realm_envelope IS NULL) = (realm_index IS NULL)
      AND (realm_envelope IS NULL OR realm_envelope ~ '^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
      AND (realm_index IS NULL OR realm_index ~ '^h1\.[a-z0-9-]{1,32}\.[0-9a-f]{64}$'))$c$, t, 'chk_' || t || '_realm_protection');
    EXECUTE format('COMMENT ON COLUMN public.%I.realm_envelope IS %L', t, 'realmID sealed with AES-256-GCM (refresh-token envelope format, purpose qbo-realm-id). Key held only by the Edge Functions.');
    EXECUTE format('COMMENT ON COLUMN public.%I.realm_index IS %L', t, 'Keyed HMAC-SHA256 equality index of (environment, realmID): uniqueness, shared-realm checks and per-realm locks without the plaintext.');
  END LOOP;
  ALTER TABLE public.qbo_connections ADD CONSTRAINT chk_qbo_connections_realm_verified CHECK (realm_verified_at IS NULL OR realm_envelope IS NOT NULL);
  ALTER TABLE public.qbo_disconnect_operations ADD CONSTRAINT chk_qbo_disconnect_operations_realm_verified CHECK (realm_verified_at IS NULL OR realm_envelope IS NOT NULL);
  ALTER TABLE public.qbo_oauth_states ADD CONSTRAINT chk_qbo_oauth_states_realm_parked CHECK (realm_envelope IS NULL OR handoff_hash IS NOT NULL);

  -- (2) the one-live-connection rule on the keyed index (in force for protected rows; the cutover makes it the only one).
  CREATE UNIQUE INDEX uq_qbo_connections_live_protected ON public.qbo_connections (company_id, realm_index, environment)
    WHERE status <> 'disconnected' AND realm_index IS NOT NULL;

  -- (3) the protection is written once. The connection guard is re-created with its original rules unchanged and one rule added.
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
    -- [20261230100000] an envelope, an index and a verification, once written, are never changed or removed.
    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope) OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN
      RAISE EXCEPTION 'QBO_REALM_PROTECTION_FIXED: the realm protection of a connection is written once. [id=%]', OLD.id USING ERRCODE = '23001';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END;
  $g$;
  CREATE FUNCTION public.qbo_disconnect_operations_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $g$
  BEGIN
    IF NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.realm_id IS DISTINCT FROM OLD.realm_id
       OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
       OR (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope) OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN
      RAISE EXCEPTION 'QBO_DISCONNECT_IDENTITY_FIXED: an operation''s identity and its realm protection never change. [connection=%]', OLD.connection_id USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END;
  $g$;
  REVOKE ALL ON FUNCTION public.qbo_disconnect_operations_guard() FROM PUBLIC, anon, authenticated, service_role;
  CREATE TRIGGER trg_qbo_disconnect_operations_guard BEFORE UPDATE ON public.qbo_disconnect_operations FOR EACH ROW EXECUTE FUNCTION public.qbo_disconnect_operations_guard();

  -- (4a) protect ONE existing row. The caller (an Edge Function holding the keys) has sealed the realm and opened it back; the database refuses
  -- unless the plaintext equals the row's, never overwrites, never touches a terminal connection. Fills only the protection columns.
  CREATE FUNCTION public.qbo_protect_connection_realm(p_connection uuid, p_realm_id text, p_realm_envelope text, p_realm_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE c public.qbo_connections%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_realm_id IS NULL OR p_realm_envelope IS NULL OR p_realm_index IS NULL THEN RETURN 'invalid'; END IF;
    SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;
    IF c.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF c.realm_envelope IS NOT NULL THEN RETURN CASE WHEN c.realm_index = p_realm_index THEN 'already_protected' ELSE 'index_conflict' END; END IF;
    UPDATE public.qbo_connections SET realm_envelope = p_realm_envelope, realm_index = p_realm_index WHERE id = p_connection;
    RETURN 'protected';
  END;
  $f$;
  CREATE FUNCTION public.qbo_protect_disconnect_realm(p_connection uuid, p_realm_id text, p_realm_envelope text, p_realm_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE o public.qbo_disconnect_operations%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_realm_id IS NULL OR p_realm_envelope IS NULL OR p_realm_index IS NULL THEN RETURN 'invalid'; END IF;
    SELECT * INTO o FROM public.qbo_disconnect_operations WHERE connection_id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF o.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF o.realm_envelope IS NOT NULL THEN RETURN CASE WHEN o.realm_index = p_realm_index THEN 'already_protected' ELSE 'index_conflict' END; END IF;
    UPDATE public.qbo_disconnect_operations SET realm_envelope = p_realm_envelope, realm_index = p_realm_index WHERE connection_id = p_connection;
    RETURN 'protected';
  END;
  $f$;

  -- (4b) record a verification: a function holding the keys opened THIS stored envelope to exactly THIS stored plaintext, and recomputed the index.
  CREATE FUNCTION public.qbo_verify_connection_realm(p_connection uuid, p_realm_id text, p_realm_envelope text, p_realm_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE c public.qbo_connections%ROWTYPE;
  BEGIN
    SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;
    IF c.realm_envelope IS NULL THEN RETURN 'unprotected'; END IF;
    IF c.realm_envelope IS DISTINCT FROM p_realm_envelope OR c.realm_index IS DISTINCT FROM p_realm_index THEN RETURN 'envelope_mismatch'; END IF;
    IF p_realm_id IS NULL OR c.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF c.realm_verified_at IS NOT NULL THEN RETURN 'already_verified'; END IF;
    UPDATE public.qbo_connections SET realm_verified_at = clock_timestamp() WHERE id = p_connection;
    RETURN 'verified';
  END;
  $f$;
  CREATE FUNCTION public.qbo_verify_disconnect_realm(p_connection uuid, p_realm_id text, p_realm_envelope text, p_realm_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE o public.qbo_disconnect_operations%ROWTYPE;
  BEGIN
    SELECT * INTO o FROM public.qbo_disconnect_operations WHERE connection_id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF o.realm_envelope IS NULL THEN RETURN 'unprotected'; END IF;
    IF o.realm_envelope IS DISTINCT FROM p_realm_envelope OR o.realm_index IS DISTINCT FROM p_realm_index THEN RETURN 'envelope_mismatch'; END IF;
    IF p_realm_id IS NULL OR o.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF o.realm_verified_at IS NOT NULL THEN RETURN 'already_verified'; END IF;
    UPDATE public.qbo_disconnect_operations SET realm_verified_at = clock_timestamp() WHERE connection_id = p_connection;
    RETURN 'verified';
  END;
  $f$;

  -- (4c) counts only: what is protected, verified and still plaintext. Never a realm, an envelope or an index.
  CREATE FUNCTION public.qbo_realm_protection_status()
  RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
    SELECT jsonb_build_object(
      'live_connections', (SELECT count(*) FROM public.qbo_connections WHERE status <> 'disconnected'),
      'live_protected', (SELECT count(*) FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_envelope IS NOT NULL),
      'live_verified', (SELECT count(*) FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_verified_at IS NOT NULL),
      'live_plaintext', (SELECT count(*) FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_id IS NOT NULL),
      'terminal_plaintext', (SELECT count(*) FROM public.qbo_connections WHERE status = 'disconnected' AND realm_id IS NOT NULL),
      'operations', (SELECT count(*) FROM public.qbo_disconnect_operations),
      'operations_protected', (SELECT count(*) FROM public.qbo_disconnect_operations WHERE realm_envelope IS NOT NULL),
      'operations_verified', (SELECT count(*) FROM public.qbo_disconnect_operations WHERE realm_verified_at IS NOT NULL),
      'operations_plaintext', (SELECT count(*) FROM public.qbo_disconnect_operations WHERE realm_id IS NOT NULL),
      'open_states_unprotected', (SELECT count(*) FROM public.qbo_oauth_states WHERE code_envelope IS NOT NULL AND realm_envelope IS NULL),
      'intents_protected', (SELECT count(*) FROM public.qbo_pull_intents WHERE realm_envelope IS NOT NULL),
      'intents_plaintext_only', (SELECT count(*) FROM public.qbo_pull_intents WHERE realm_envelope IS NULL),
      'pulls_protected', (SELECT count(*) FROM public.qbo_pulls WHERE realm_envelope IS NOT NULL),
      'pulls_plaintext_only', (SELECT count(*) FROM public.qbo_pulls WHERE realm_envelope IS NULL));
  $f$;
  FOREACH f IN ARRAY c_fns LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO service_role';
  END LOOP;

  -- POSTCONDITION
  SELECT count(*) INTO v_present FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY (c_tables) AND column_name IN ('realm_envelope', 'realm_index', 'realm_verified_at');
  IF v_present <> 12 OR to_regclass('public.uq_qbo_connections_live_protected') IS NULL
     OR (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'chk\_qbo\_%\_realm\_%') <> 8
     OR position('QBO_REALM_PROTECTION_FIXED' IN pg_get_functiondef('public.qbo_connections_guard()'::regprocedure)) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_qbo_disconnect_operations_guard' AND tgrelid = 'public.qbo_disconnect_operations'::regclass)
     OR (SELECT bool_or(has_function_privilege('authenticated', x::regprocedure, 'EXECUTE') OR has_function_privilege('anon', x::regprocedure, 'EXECUTE')
                        OR NOT has_function_privilege('service_role', x::regprocedure, 'EXECUTE')) FROM unnest(c_fns) x) THEN
    RAISE EXCEPTION 'POSTCONDITION: realm protection (Phase A) is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_schema$;
