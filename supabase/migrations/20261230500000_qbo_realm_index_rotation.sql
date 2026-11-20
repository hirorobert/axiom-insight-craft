-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261230500000 — QuickBooks realm INDEX key rotation: move live rows' keyed realm index from a retiring index key to a new one (owner
-- custody of idx1 cannot be established: it was entered only into Lovable's write-only secret store). AUTHORED, NOT APPLIED. Forward-only;
-- changes no row by itself.
--   WHY: the realm index ("h1.<indexKeyId>.<HMAC>") is the equality key of a QuickBooks company: live-connection uniqueness, the reconnect
--   check and (after the cutover) the shared-company and pending-revocation checks. The functions now accept a NEXT index key
--   (QBO_REALM_INDEX_KEY_NEXT_*, owner-generated and owner-vaulted) that makes every new index while the configured key still RECOGNISES the
--   indexes it made. This migration lets the Edge Function that holds both keys move each LIVE row's index onto the new key.
--   WHAT IT DOES (no existing row is changed here):
--   (1) qbo_reindex_connection_realm / qbo_reindex_disconnect_realm: replace ONE row's realm index with an index under a DIFFERENT index key,
--       only while the plaintext still exists and equals the caller's, only with the row's unchanged envelope, only if the row still holds the
--       index the caller recognised (compare-and-swap: a concurrent change answers 'stale'), and records the fresh verification time (the
--       caller opened the envelope and recomputed both indexes). Never on a terminal connection.
--   (2) the connection and operation guards allow exactly that transition, and only inside those functions (a transaction-local marker that
--       names the one row): realm_index to an index under another key, realm_verified_at refreshed, realm_envelope and realm_id unchanged.
--       The 20261230400000 reseal transition is kept; on the operation guard it now states "index unchanged" explicitly (the index left the
--       identity rule, which used to refuse any index change outright).
--   (3) qbo_realm_index_coverage(): counts of stored indexes by index key id per record type (no index, realm or row id leaves it).
--   Service role only. Historical rows (terminal connections, import intents and pulls, consumed OAuth states) keep their indexes: no
--   comparison reads them, and their tables stay append-only.
-- SELF-VERIFYING (hosted journal 117 was applied with one transcribed line): the two guards must be EXACTLY the reviewed bodies before it
--   starts (sha256 of each body), and every body it installs must hash to the digest pinned below afterwards; any difference fails the whole
--   block and nothing changes.
-- PREFLIGHT: the token-key reseal (20261230400000) and its guard repair (20261230410000) installed; the cutover NOT installed (re-indexing
--   compares the plaintext); a replay with the reviewed bodies is a no-op.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_index_rotation$
BEGIN
  IF to_regprocedure('public.qbo_realm_index_coverage()') IS NOT NULL THEN   -- replay: only the reviewed result is accepted
    IF (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_connections_guard()')) IS DISTINCT FROM 'db305b361f0dfc402501a21437dfe7282cbe95769eef8e3d3a95dc162d38d0c8'
       OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_disconnect_operations_guard()')) IS DISTINCT FROM '819623c9a8339c85513f4acf0c922629d9438f844cd2a99f6ceaa19918f4ce69' THEN
      RAISE EXCEPTION 'PREFLIGHT_REFUSED: the index rotation is installed with unexpected guard bodies; nothing was changed' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;
  IF to_regprocedure('public.qbo_realm_key_coverage()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the token-key reseal (20261230400000) is not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_realm_present') THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the realm protection cutover is installed; re-indexing needs the plaintext; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_connections_guard()')) IS DISTINCT FROM 'b3c9dcc9e504b27f60340fb3a77a97fe205bbf1e28704258b535d0f9897bc44a'
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_disconnect_operations_guard()')) IS DISTINCT FROM 'ab3855f445f5d82b68f29dba324745752853a472ee065befdc207b15162099a0' THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the realm guards are not the reviewed 20261230400000/20261230410000 bodies; nothing was changed' USING ERRCODE = 'P0001';
  END IF;

  -- (2) the guards: every earlier rule unchanged, plus the one reindex transition.
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
    -- [20261230400000] except by qbo_reseal_connection_realm for this one row: the envelope under ANOTHER key, the index unchanged, a fresh verification;
    -- [20261230500000] or by qbo_reindex_connection_realm for this one row: the index under ANOTHER index key, the envelope unchanged, a fresh verification.
    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope) OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN
      IF NOT ((coalesce(current_setting('qbo.realm_reseal', true), '') = 'connection:' || OLD.id::text
               AND OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS NOT NULL
               AND split_part(NEW.realm_envelope, '.', 2) <> split_part(OLD.realm_envelope, '.', 2)
               AND NEW.realm_index IS NOT DISTINCT FROM OLD.realm_index AND NEW.realm_verified_at IS NOT NULL)
           OR (coalesce(current_setting('qbo.realm_reindex', true), '') = 'connection:' || OLD.id::text
               AND OLD.realm_index IS NOT NULL AND NEW.realm_index IS NOT NULL
               AND split_part(NEW.realm_index, '.', 2) <> split_part(OLD.realm_index, '.', 2)
               AND NEW.realm_envelope IS NOT DISTINCT FROM OLD.realm_envelope AND NEW.realm_verified_at IS NOT NULL)) THEN
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
       OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id THEN
      RAISE EXCEPTION 'QBO_DISCONNECT_IDENTITY_FIXED: an operation''s identity and its realm protection never change. [connection=%]', OLD.connection_id USING ERRCODE = '23001';
    END IF;
    -- [20261230400000] the envelope and its verification change only through qbo_reseal_disconnect_realm for this one operation (another key,
    -- the index unchanged); [20261230500000] the index and its verification only through qbo_reindex_disconnect_realm for this one operation
    -- (another index key, the envelope unchanged). Anything else is refused, as before.
    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope)
       OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN
      IF NOT ((coalesce(current_setting('qbo.realm_reseal', true), '') = 'operation:' || OLD.connection_id::text
               AND OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS NOT NULL
               AND split_part(NEW.realm_envelope, '.', 2) <> split_part(OLD.realm_envelope, '.', 2)
               AND NEW.realm_index IS NOT DISTINCT FROM OLD.realm_index AND NEW.realm_verified_at IS NOT NULL)
           OR (coalesce(current_setting('qbo.realm_reindex', true), '') = 'operation:' || OLD.connection_id::text
               AND OLD.realm_index IS NOT NULL AND NEW.realm_index IS NOT NULL
               AND split_part(NEW.realm_index, '.', 2) <> split_part(OLD.realm_index, '.', 2)
               AND NEW.realm_envelope IS NOT DISTINCT FROM OLD.realm_envelope AND NEW.realm_verified_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'QBO_DISCONNECT_IDENTITY_FIXED: an operation''s identity and its realm protection never change. [connection=%]', OLD.connection_id USING ERRCODE = '23001';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $g$;

  -- (1) re-index one live connection / one disconnect operation.
  CREATE FUNCTION public.qbo_reindex_connection_realm(p_connection uuid, p_realm_id text, p_realm_envelope text, p_expected_index text, p_new_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE c public.qbo_connections%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_realm_id IS NULL OR p_realm_envelope IS NULL OR p_expected_index IS NULL OR p_new_index IS NULL
       OR p_new_index !~ '^h1\.[a-z0-9-]{1,32}\.[0-9a-f]{64}$' THEN RETURN 'invalid'; END IF;
    SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;
    IF c.realm_envelope IS NULL OR c.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF c.realm_index = p_new_index THEN RETURN 'already_reindexed'; END IF;
    IF c.realm_index IS DISTINCT FROM p_expected_index OR c.realm_envelope IS DISTINCT FROM p_realm_envelope THEN RETURN 'stale'; END IF;
    IF c.realm_id IS NULL OR c.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF split_part(p_new_index, '.', 2) = split_part(c.realm_index, '.', 2) THEN RETURN 'same_key'; END IF;
    PERFORM set_config('qbo.realm_reindex', 'connection:' || c.id::text, true);
    UPDATE public.qbo_connections SET realm_index = p_new_index, realm_verified_at = clock_timestamp() WHERE id = c.id;
    PERFORM set_config('qbo.realm_reindex', '', true);
    RETURN 'reindexed';
  END;
  $f$;
  CREATE FUNCTION public.qbo_reindex_disconnect_realm(p_connection uuid, p_realm_id text, p_realm_envelope text, p_expected_index text, p_new_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE o public.qbo_disconnect_operations%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_realm_id IS NULL OR p_realm_envelope IS NULL OR p_expected_index IS NULL OR p_new_index IS NULL
       OR p_new_index !~ '^h1\.[a-z0-9-]{1,32}\.[0-9a-f]{64}$' THEN RETURN 'invalid'; END IF;
    SELECT * INTO o FROM public.qbo_disconnect_operations WHERE connection_id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF o.realm_envelope IS NULL OR o.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF o.realm_index = p_new_index THEN RETURN 'already_reindexed'; END IF;
    IF o.realm_index IS DISTINCT FROM p_expected_index OR o.realm_envelope IS DISTINCT FROM p_realm_envelope THEN RETURN 'stale'; END IF;
    IF o.realm_id IS NULL OR o.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF split_part(p_new_index, '.', 2) = split_part(o.realm_index, '.', 2) THEN RETURN 'same_key'; END IF;
    PERFORM set_config('qbo.realm_reindex', 'operation:' || o.connection_id::text, true);
    UPDATE public.qbo_disconnect_operations SET realm_index = p_new_index, realm_verified_at = clock_timestamp() WHERE connection_id = o.connection_id;
    PERFORM set_config('qbo.realm_reindex', '', true);
    RETURN 'reindexed';
  END;
  $f$;

  -- (3) index counts by index key id (aggregates only).
  CREATE FUNCTION public.qbo_realm_index_coverage()
  RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
    SELECT coalesce(jsonb_object_agg(kind || ':' || key_id, n), '{}'::jsonb) FROM (
      SELECT 'live_index' kind, split_part(realm_index, '.', 2) key_id, count(*) n FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_index IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'operation_index', split_part(realm_index, '.', 2), count(*) FROM public.qbo_disconnect_operations WHERE realm_index IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'terminal_index', split_part(realm_index, '.', 2), count(*) FROM public.qbo_connections WHERE status = 'disconnected' AND realm_index IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'intent_index', split_part(realm_index, '.', 2), count(*) FROM public.qbo_pull_intents WHERE realm_index IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'pull_index', split_part(realm_index, '.', 2), count(*) FROM public.qbo_pulls WHERE realm_index IS NOT NULL GROUP BY 2
      UNION ALL SELECT 'oauth_index', split_part(realm_index, '.', 2), count(*) FROM public.qbo_oauth_states WHERE realm_index IS NOT NULL GROUP BY 2
    ) t;
  $f$;

  REVOKE ALL ON FUNCTION public.qbo_reindex_connection_realm(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.qbo_reindex_disconnect_realm(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.qbo_realm_index_coverage() FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.qbo_reindex_connection_realm(uuid, text, text, text, text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.qbo_reindex_disconnect_realm(uuid, text, text, text, text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.qbo_realm_index_coverage() TO service_role;

  -- POSTCONDITION: every installed body exactly as reviewed; guards still invoker functions with their pinned search_path and attached;
  -- the new functions service role only.
  IF (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_connections_guard()')) IS DISTINCT FROM 'db305b361f0dfc402501a21437dfe7282cbe95769eef8e3d3a95dc162d38d0c8'
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_disconnect_operations_guard()')) IS DISTINCT FROM '819623c9a8339c85513f4acf0c922629d9438f844cd2a99f6ceaa19918f4ce69'
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_reindex_connection_realm(uuid,text,text,text,text)')) IS DISTINCT FROM 'cf5083bbffc82057ac7976fbdb455dc9ceae6b25e0c0ae7ea5032812e85941ed'
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_reindex_disconnect_realm(uuid,text,text,text,text)')) IS DISTINCT FROM 'eb59609f084ea523766e529e295c4f4c8b11e78983ddb5abf5e19b6ee540d5fb'
     OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_realm_index_coverage()')) IS DISTINCT FROM 'ac498844fef544c3316e309c04f345c2f90ae87b1405f1aff633ec77079bd1d8'
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.qbo_connections_guard()'::regprocedure, 'public.qbo_disconnect_operations_guard()'::regprocedure)
                AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']))
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_qbo_disconnect_operations_guard' AND tgrelid = 'public.qbo_disconnect_operations'::regclass AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.qbo_connections'::regclass AND tgfoid = 'public.qbo_connections_guard()'::regprocedure AND tgenabled = 'O')
     OR has_function_privilege('authenticated', 'public.qbo_reindex_connection_realm(uuid,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.qbo_reindex_disconnect_realm(uuid,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.qbo_realm_index_coverage()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.qbo_reindex_connection_realm(uuid,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.qbo_reindex_disconnect_realm(uuid,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the QuickBooks index-key rotation is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_index_rotation$;
