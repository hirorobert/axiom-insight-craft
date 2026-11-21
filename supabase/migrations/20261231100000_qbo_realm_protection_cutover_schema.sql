-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261231100000 — QuickBooks realmID protection, Phase C v2 (CUTOVER), part 1 of 4: the schema accepts rows without a plaintext realm, and the
-- realm guards keep every earlier rule. AUTHORED, NOT APPLIED. *** Phase C is IRREVERSIBLE FOR THE PLAINTEXT once part 4 (20261231300000) runs. ***
--   SUPERSEDES PR #282 (v1, acdee94), whose part 1 replaced both guards with bodies that predate the token-key reseal (20261230400000), its guard
--   repair (20261230410000) and the index-key rotation (20261230500000): applying v1 would have silently removed both key-rotation paths.
--   GATE (before anything changes): every live connection and every disconnect operation carries an envelope and an index, every one that still
--   holds a plaintext realm carries a recorded verification, and every envelope and index names a VERSIONED key (k<N>, idx<N>). Otherwise
--   QBO_REALM_CUTOVER_REFUSED and nothing changes. Needs 20261230500000 applied (the guards must be exactly its reviewed bodies), qbo-realm-protect
--   "verify" at 100 %, A CONFIRMED DATABASE BACKUP and the owner's explicit go. Design and order: docs/release/qbo-realm-protection-r1/README.md.
--   WHAT IT DOES (no row is changed): realm_id becomes nullable on connections, disconnect operations, intents and pulls, and every row must hold
--   the plaintext or the protection; the OAuth state's handoff is paired with the plaintext or the protected realm; public.qbo_key_version()
--   reads a key id's version; public.qbo_index_key_mixed() says whether live indexes are on more than one index key (used from part 2; executable
--   by its owner only); the connection and operation guards keep every rule they have and allow exactly:
--     (a) a VERIFIED row's realm_id to NULL (never back, never another value: plaintext can never be reintroduced);
--     (b) the reseal transition, now only onto a strictly NEWER token key version (no downgrade, no same-key rewrite);
--     (c) the reindex transition, now only onto a strictly NEWER index key version.
--   Append-only guards and RLS are untouched.
-- SELF-VERIFYING: it refuses unless the two guards are exactly the reviewed 20261230500000 bodies, and it accepts its result only if every body it
--   installs hashes to the digest pinned below; any transcription difference fails the whole block and nothing changes. A replay with the reviewed
--   bodies is a no-op; a replay over anything else is refused.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_cutover_schema$
DECLARE v_conn integer; v_ops integer; v_unversioned integer; t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_realm_present') THEN   -- replay: only the reviewed result is accepted
    IF (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_connections_guard()')) IS DISTINCT FROM '134b19428d51440b8d30009b780d7296791b8e633145a20c03a0f540a0e33db3'
       OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_disconnect_operations_guard()')) IS DISTINCT FROM 'd526950c94cc230a9f1f8e204415abd01ed810fbab104ff9d5cbcba7dbdbd39f'
       OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_key_version(text,text)')) IS DISTINCT FROM 'fa28da58adf87491e1891abb434c7c9e631de6ba5ce6731933746db4271496d6'
       OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_index_key_mixed(text)')) IS DISTINCT FROM '3ec271dcead5afca437eaa4831fdfe3b1f94c6265b679ad173f010b922df93ee' THEN
      RAISE EXCEPTION 'PREFLIGHT_REFUSED: the cutover schema is installed with unexpected guard bodies; nothing was changed' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;
  IF to_regprocedure('public.qbo_realm_index_coverage()') IS NULL
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_connections_guard()')) IS DISTINCT FROM 'db305b361f0dfc402501a21437dfe7282cbe95769eef8e3d3a95dc162d38d0c8'
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_disconnect_operations_guard()')) IS DISTINCT FROM '819623c9a8339c85513f4acf0c922629d9438f844cd2a99f6ceaa19918f4ce69' THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the realm guards are not the reviewed 20261230500000 bodies (the reseal, its repair and the index rotation must be installed first); nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_conn FROM public.qbo_connections WHERE status <> 'disconnected' AND (realm_envelope IS NULL OR realm_index IS NULL OR (realm_id IS NOT NULL AND realm_verified_at IS NULL));
  SELECT count(*) INTO v_ops FROM public.qbo_disconnect_operations WHERE realm_envelope IS NULL OR realm_index IS NULL OR (realm_id IS NOT NULL AND realm_verified_at IS NULL);
  IF v_conn <> 0 OR v_ops <> 0 THEN
    RAISE EXCEPTION 'QBO_REALM_CUTOVER_REFUSED: % live connection(s) and % disconnect operation(s) are not protected and verified; run qbo-realm-protect protect, then verify; nothing was changed', v_conn, v_ops USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_unversioned FROM (
    SELECT realm_envelope e, realm_index i FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_envelope IS NOT NULL
    UNION ALL SELECT realm_envelope, realm_index FROM public.qbo_disconnect_operations WHERE realm_envelope IS NOT NULL) x
   WHERE split_part(x.e, '.', 2) !~ '^k[1-9][0-9]{0,8}$' OR split_part(x.i, '.', 2) !~ '^idx[1-9][0-9]{0,8}$';
  IF v_unversioned <> 0 THEN
    RAISE EXCEPTION 'QBO_REALM_CUTOVER_REFUSED: % protected row(s) name an unversioned key; nothing was changed', v_unversioned USING ERRCODE = 'P0001';
  END IF;

  -- The plaintext becomes optional; every row keeps one of the two.
  FOREACH t IN ARRAY ARRAY['qbo_connections', 'qbo_disconnect_operations', 'qbo_pull_intents', 'qbo_pulls'] LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN realm_id DROP NOT NULL', t);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (realm_id IS NOT NULL OR (realm_envelope IS NOT NULL AND realm_index IS NOT NULL))', t, 'chk_' || t || '_realm_present');
  END LOOP;
  ALTER TABLE public.qbo_oauth_states DROP CONSTRAINT chk_qbo_state_handoff;
  ALTER TABLE public.qbo_oauth_states ADD CONSTRAINT chk_qbo_state_handoff CHECK ((handoff_hash IS NULL) = (handoff_expires_at IS NULL)
    AND (handoff_hash IS NOT NULL OR (realm_id IS NULL AND realm_envelope IS NULL))
    AND (handoff_hash IS NULL OR realm_id IS NOT NULL OR realm_envelope IS NOT NULL)
    AND (handoff_hash IS NULL OR (consumed_at IS NOT NULL AND handoff_expires_at > consumed_at AND handoff_expires_at <= consumed_at + interval '10 minutes')));

  CREATE FUNCTION public.qbo_key_version(p_key_id text, p_kind text)
  RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $f$
    SELECT CASE WHEN p_key_id ~ ('^' || p_kind || '[1-9][0-9]{0,8}$') THEN substring(p_key_id FROM length(p_kind) + 1)::integer END;
  $f$;
  REVOKE ALL ON FUNCTION public.qbo_key_version(text, text) FROM PUBLIC, anon, authenticated;
  CREATE FUNCTION public.qbo_index_key_mixed(p_key_id text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
    SELECT EXISTS (SELECT 1 FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_index IS NOT NULL AND split_part(realm_index, '.', 2) IS DISTINCT FROM p_key_id)
        OR EXISTS (SELECT 1 FROM public.qbo_disconnect_operations WHERE outcome = 'pending' AND realm_index IS NOT NULL AND split_part(realm_index, '.', 2) IS DISTINCT FROM p_key_id);
  $f$;
  REVOKE ALL ON FUNCTION public.qbo_index_key_mixed(text) FROM PUBLIC, anon, authenticated, service_role;

  CREATE OR REPLACE FUNCTION public.qbo_connections_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $g$
  BEGIN
    IF OLD.status = 'disconnected' THEN
      RAISE EXCEPTION 'QBO_CONNECTION_TERMINAL: a disconnected connection cannot change. [id=%]', OLD.id USING ERRCODE = '23001';
    END IF;
    -- [20261231100000] the one transition of the plaintext realm: a verified row's realm_id to NULL; never back, never another value.
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR (NEW.realm_id IS DISTINCT FROM OLD.realm_id AND NOT (NEW.realm_id IS NULL AND OLD.realm_index IS NOT NULL AND OLD.realm_verified_at IS NOT NULL))
       OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'QBO_CONNECTION_IDENTITY_FIXED: company, realm, environment and creation time never change. [id=%]', OLD.id USING ERRCODE = '23001';
    END IF;
    -- [20261230100000] an envelope, an index and a verification, once written, are never changed or removed, except:
    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope) OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN
      -- [20261230400000/20261231100000] reseal: the envelope under a strictly NEWER token key, the index unchanged, a fresh verification;
      -- [20261230500000/20261231100000] reindex: the index under a strictly NEWER index key, the envelope unchanged, a fresh verification.
      IF NOT coalesce(
           (coalesce(current_setting('qbo.realm_reseal', true), '') = 'connection:' || OLD.id::text
            AND OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS NOT NULL
            AND public.qbo_key_version(split_part(NEW.realm_envelope, '.', 2), 'k') > public.qbo_key_version(split_part(OLD.realm_envelope, '.', 2), 'k')
            AND NEW.realm_index IS NOT DISTINCT FROM OLD.realm_index AND NEW.realm_verified_at IS NOT NULL)
        OR (coalesce(current_setting('qbo.realm_reindex', true), '') = 'connection:' || OLD.id::text
            AND OLD.realm_index IS NOT NULL AND NEW.realm_index IS NOT NULL
            AND public.qbo_key_version(split_part(NEW.realm_index, '.', 2), 'idx') > public.qbo_key_version(split_part(OLD.realm_index, '.', 2), 'idx')
            AND NEW.realm_envelope IS NOT DISTINCT FROM OLD.realm_envelope AND NEW.realm_verified_at IS NOT NULL), false) THEN
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
    -- [20261231100000] the one transition of the plaintext realm: a verified operation's realm_id to NULL; never back, never another value.
    IF NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR (NEW.realm_id IS DISTINCT FROM OLD.realm_id AND NOT (NEW.realm_id IS NULL AND OLD.realm_index IS NOT NULL AND OLD.realm_verified_at IS NOT NULL))
       OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id THEN
      RAISE EXCEPTION 'QBO_DISCONNECT_IDENTITY_FIXED: an operation''s identity and its realm protection never change. [connection=%]', OLD.connection_id USING ERRCODE = '23001';
    END IF;
    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope)
       OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN
      -- [20261230400000/20261231100000] reseal: the envelope under a strictly NEWER token key, the index unchanged, a fresh verification;
      -- [20261230500000/20261231100000] reindex: the index under a strictly NEWER index key, the envelope unchanged, a fresh verification.
      IF NOT coalesce(
           (coalesce(current_setting('qbo.realm_reseal', true), '') = 'operation:' || OLD.connection_id::text
            AND OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS NOT NULL
            AND public.qbo_key_version(split_part(NEW.realm_envelope, '.', 2), 'k') > public.qbo_key_version(split_part(OLD.realm_envelope, '.', 2), 'k')
            AND NEW.realm_index IS NOT DISTINCT FROM OLD.realm_index AND NEW.realm_verified_at IS NOT NULL)
        OR (coalesce(current_setting('qbo.realm_reindex', true), '') = 'operation:' || OLD.connection_id::text
            AND OLD.realm_index IS NOT NULL AND NEW.realm_index IS NOT NULL
            AND public.qbo_key_version(split_part(NEW.realm_index, '.', 2), 'idx') > public.qbo_key_version(split_part(OLD.realm_index, '.', 2), 'idx')
            AND NEW.realm_envelope IS NOT DISTINCT FROM OLD.realm_envelope AND NEW.realm_verified_at IS NOT NULL), false) THEN
        RAISE EXCEPTION 'QBO_DISCONNECT_IDENTITY_FIXED: an operation''s identity and its realm protection never change. [connection=%]', OLD.connection_id USING ERRCODE = '23001';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $g$;

  -- POSTCONDITION: the schema as reviewed, and every installed body exactly as reviewed, still invoker guards with their pinned search_path, attached.
  IF (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'chk\_qbo\_%\_realm\_present') <> 4
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('qbo_connections', 'qbo_disconnect_operations', 'qbo_pull_intents', 'qbo_pulls')
                AND column_name = 'realm_id' AND is_nullable = 'NO')
     OR position('realm_envelope IS NOT NULL' IN (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_qbo_state_handoff')) = 0
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_connections_guard()')) IS DISTINCT FROM '134b19428d51440b8d30009b780d7296791b8e633145a20c03a0f540a0e33db3'
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_disconnect_operations_guard()')) IS DISTINCT FROM 'd526950c94cc230a9f1f8e204415abd01ed810fbab104ff9d5cbcba7dbdbd39f'
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_key_version(text,text)')) IS DISTINCT FROM 'fa28da58adf87491e1891abb434c7c9e631de6ba5ce6731933746db4271496d6'
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_index_key_mixed(text)')) IS DISTINCT FROM '3ec271dcead5afca437eaa4831fdfe3b1f94c6265b679ad173f010b922df93ee'
     OR has_function_privilege('service_role', 'public.qbo_index_key_mixed(text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.qbo_index_key_mixed(text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.qbo_connections_guard()'::regprocedure, 'public.qbo_disconnect_operations_guard()'::regprocedure)
                AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']))
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_qbo_disconnect_operations_guard' AND tgrelid = 'public.qbo_disconnect_operations'::regclass AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_qbo_connections_guard' AND tgrelid = 'public.qbo_connections'::regclass AND tgenabled = 'O')
     OR has_function_privilege('authenticated', 'public.qbo_key_version(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: realm protection cutover (part 1, schema) is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_cutover_schema$;
