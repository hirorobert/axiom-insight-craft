-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261231250000 — QuickBooks realmID protection, Phase C v2, part 3 of 4: token-key and index-key rotation WITHOUT a plaintext realm, forwards only.
-- AUTHORED, NOT APPLIED. Changes no row by itself.
--   WHY: Phase C removes the plaintext realm from every live row. The reseal (20261230400000) and reindex (20261230500000) functions compared it, so
--   after the redaction neither key could ever be rotated again, even after a suspected compromise. This part makes both rotations independent of it.
--   WHAT IT DOES: qbo_reseal_connection_realm, qbo_reseal_disconnect_realm, qbo_reseal_refresh_token, qbo_reindex_connection_realm and
--   qbo_reindex_disconnect_realm are replaced (same signatures, service role only). Per row, by compare-and-swap under a row lock:
--     · the plaintext is compared only while the row still holds one; once redacted the caller sends p_realm_id NULL and it is never read;
--     · a move goes only to a strictly NEWER key version (k<N>, idx<N>): 'downgrade' otherwise (no same-key rewrite, no rollback to an old key);
--     · a re-index holds the advisory lock 'qbo-index-rotation' EXCLUSIVE, so it can never commit inside a connect or disconnect that compares
--       indexes (they hold it shared, part 2);
--     · the guards (part 1) admit exactly these transitions and nothing else.
--   TRUST BOUNDARY: the database never holds a key, so it cannot check that a new envelope opens to the same realm. The Edge Function, which holds
--   the keys, proves it before submitting (it opens the old envelope, recomputes the stored index with the index key it names, seals, opens the
--   new envelope back). A party able to change both the deployed functions and the secrets is outside this boundary (see the release README).
-- SELF-VERIFYING: all five bodies are pinned by SHA-256; any difference fails the block and nothing changes. A replay with them is a no-op.
-- PREFLIGHT: parts 1 and 2 installed.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_rotation_post_redaction$
DECLARE
  pin_f constant text[] := ARRAY['public.qbo_reseal_connection_realm(uuid,text,text,text,text)',
    'public.qbo_reseal_disconnect_realm(uuid,text,text,text,text)',
    'public.qbo_reseal_refresh_token(uuid,text,text)',
    'public.qbo_reindex_connection_realm(uuid,text,text,text,text)',
    'public.qbo_reindex_disconnect_realm(uuid,text,text,text,text)'];
  pin_d constant text[] := ARRAY['88af167f2aad5cf3bef2e709a56115f6145d8639a3d37ecf028ca80923b07506',
    '987a3ca649c8b16ef022667b21b315d8286c69441139ecf6b4152a0baef23bd8',
    'c33f4ce2c3b0c733504c3e5758de798f07308efe51a076f87850c4e768f07e2b',
    'd8296b0591591e6201d82f9f024fdec13d7c0716bb7d45171261444e131bd248',
    'ae763d89e82d4aeaa085a71897e6dc942449255bcd48f242c4bd7c6c8b0feac6'];
BEGIN
  -- Part 2 is recognised by its result (the backfill writers dropped, the reviewed store body), never by a helper part 1 already created.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_realm_present') OR to_regprocedure('public.qbo_index_key_mixed(text)') IS NULL
     OR to_regprocedure('public.qbo_protect_connection_realm(uuid,text,text,text)') IS NOT NULL OR (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure('public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)')) IS DISTINCT FROM 'c3d0b5fbf6e27948eae7ee94615d703b2c47458b3830e82afd3901565a4d432a'
     OR to_regprocedure('public.qbo_reindex_connection_realm(uuid,text,text,text,text)') IS NULL OR to_regprocedure('public.qbo_reseal_refresh_token(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection cutover parts 1 and 2, the reseal and the index rotation must be installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(pin_f, pin_d) v(f, d)
     WHERE (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure(v.f)) IS DISTINCT FROM v.d) THEN RETURN; END IF;   -- replay

  CREATE OR REPLACE FUNCTION public.qbo_reseal_connection_realm(p_connection uuid, p_realm_id text, p_expected_envelope text, p_new_envelope text, p_realm_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE c public.qbo_connections%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_expected_envelope IS NULL OR p_new_envelope IS NULL OR p_realm_index IS NULL
       OR p_new_envelope !~ '^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN RETURN 'invalid'; END IF;
    SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;
    IF c.realm_envelope IS NULL OR c.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF c.realm_envelope = p_new_envelope THEN RETURN 'already_resealed'; END IF;
    IF c.realm_envelope IS DISTINCT FROM p_expected_envelope THEN RETURN 'stale'; END IF;
    -- [Phase C v2] the plaintext, while the row still holds one, must equal the caller's; once redacted it is never sent (p_realm_id NULL) and never read.
    IF p_realm_id IS NOT NULL AND c.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF c.realm_index IS DISTINCT FROM p_realm_index THEN RETURN 'index_mismatch'; END IF;
    IF coalesce(public.qbo_key_version(split_part(p_new_envelope, '.', 2), 'k') <= public.qbo_key_version(split_part(c.realm_envelope, '.', 2), 'k'), true) THEN RETURN 'downgrade'; END IF;
    PERFORM set_config('qbo.realm_reseal', 'connection:' || c.id::text, true);
    UPDATE public.qbo_connections SET realm_envelope = p_new_envelope, realm_verified_at = clock_timestamp() WHERE id = c.id;
    PERFORM set_config('qbo.realm_reseal', '', true);
    RETURN 'resealed';
  END;
  $f$;
  CREATE OR REPLACE FUNCTION public.qbo_reseal_disconnect_realm(p_connection uuid, p_realm_id text, p_expected_envelope text, p_new_envelope text, p_realm_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE o public.qbo_disconnect_operations%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_expected_envelope IS NULL OR p_new_envelope IS NULL OR p_realm_index IS NULL
       OR p_new_envelope !~ '^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN RETURN 'invalid'; END IF;
    SELECT * INTO o FROM public.qbo_disconnect_operations WHERE connection_id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF o.realm_envelope IS NULL OR o.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF o.realm_envelope = p_new_envelope THEN RETURN 'already_resealed'; END IF;
    IF o.realm_envelope IS DISTINCT FROM p_expected_envelope THEN RETURN 'stale'; END IF;
    -- [Phase C v2] the plaintext, while the row still holds one, must equal the caller's; once redacted it is never sent (p_realm_id NULL) and never read.
    IF p_realm_id IS NOT NULL AND o.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF o.realm_index IS DISTINCT FROM p_realm_index THEN RETURN 'index_mismatch'; END IF;
    IF coalesce(public.qbo_key_version(split_part(p_new_envelope, '.', 2), 'k') <= public.qbo_key_version(split_part(o.realm_envelope, '.', 2), 'k'), true) THEN RETURN 'downgrade'; END IF;
    PERFORM set_config('qbo.realm_reseal', 'operation:' || o.connection_id::text, true);
    UPDATE public.qbo_disconnect_operations SET realm_envelope = p_new_envelope, realm_verified_at = clock_timestamp() WHERE connection_id = o.connection_id;
    PERFORM set_config('qbo.realm_reseal', '', true);
    RETURN 'resealed';
  END;
  $f$;
  CREATE OR REPLACE FUNCTION public.qbo_reseal_refresh_token(p_connection uuid, p_expected_envelope text, p_new_envelope text)
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
    IF coalesce(public.qbo_key_version(split_part(p_new_envelope, '.', 2), 'k') <= public.qbo_key_version(split_part(c.refresh_token_envelope, '.', 2), 'k'), true) THEN RETURN 'downgrade'; END IF;
    UPDATE public.qbo_connections SET refresh_token_envelope = p_new_envelope, envelope_key_id = split_part(p_new_envelope, '.', 2) WHERE id = c.id;
    RETURN 'resealed';
  END;
  $f$;
  CREATE OR REPLACE FUNCTION public.qbo_reindex_connection_realm(p_connection uuid, p_realm_id text, p_realm_envelope text, p_expected_index text, p_new_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE c public.qbo_connections%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_realm_envelope IS NULL OR p_expected_index IS NULL OR p_new_index IS NULL
       OR p_new_index !~ '^h1\.[a-z0-9-]{1,32}\.[0-9a-f]{64}$' THEN RETURN 'invalid'; END IF;
    -- [Phase C v2] one index move at a time, and never inside a connect or a disconnect that compares indexes (they hold this lock shared).
    PERFORM pg_advisory_xact_lock(hashtextextended('qbo-index-rotation', 0));
    SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;
    IF c.realm_envelope IS NULL OR c.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF c.realm_index = p_new_index THEN RETURN 'already_reindexed'; END IF;
    IF c.realm_index IS DISTINCT FROM p_expected_index OR c.realm_envelope IS DISTINCT FROM p_realm_envelope THEN RETURN 'stale'; END IF;
    -- [Phase C v2] the plaintext, while the row still holds one, must equal the caller's; once redacted it is never sent (p_realm_id NULL) and never read.
    IF p_realm_id IS NOT NULL AND c.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF coalesce(public.qbo_key_version(split_part(p_new_index, '.', 2), 'idx') <= public.qbo_key_version(split_part(c.realm_index, '.', 2), 'idx'), true) THEN RETURN 'downgrade'; END IF;
    PERFORM set_config('qbo.realm_reindex', 'connection:' || c.id::text, true);
    UPDATE public.qbo_connections SET realm_index = p_new_index, realm_verified_at = clock_timestamp() WHERE id = c.id;
    PERFORM set_config('qbo.realm_reindex', '', true);
    RETURN 'reindexed';
  END;
  $f$;
  CREATE OR REPLACE FUNCTION public.qbo_reindex_disconnect_realm(p_connection uuid, p_realm_id text, p_realm_envelope text, p_expected_index text, p_new_index text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
  DECLARE o public.qbo_disconnect_operations%ROWTYPE;
  BEGIN
    IF p_connection IS NULL OR p_realm_envelope IS NULL OR p_expected_index IS NULL OR p_new_index IS NULL
       OR p_new_index !~ '^h1\.[a-z0-9-]{1,32}\.[0-9a-f]{64}$' THEN RETURN 'invalid'; END IF;
    -- [Phase C v2] one index move at a time, and never inside a connect or a disconnect that compares indexes (they hold this lock shared).
    PERFORM pg_advisory_xact_lock(hashtextextended('qbo-index-rotation', 0));
    SELECT * INTO o FROM public.qbo_disconnect_operations WHERE connection_id = p_connection FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF o.realm_envelope IS NULL OR o.realm_index IS NULL THEN RETURN 'unprotected'; END IF;
    IF o.realm_index = p_new_index THEN RETURN 'already_reindexed'; END IF;
    IF o.realm_index IS DISTINCT FROM p_expected_index OR o.realm_envelope IS DISTINCT FROM p_realm_envelope THEN RETURN 'stale'; END IF;
    -- [Phase C v2] the plaintext, while the row still holds one, must equal the caller's; once redacted it is never sent (p_realm_id NULL) and never read.
    IF p_realm_id IS NOT NULL AND o.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
    IF coalesce(public.qbo_key_version(split_part(p_new_index, '.', 2), 'idx') <= public.qbo_key_version(split_part(o.realm_index, '.', 2), 'idx'), true) THEN RETURN 'downgrade'; END IF;
    PERFORM set_config('qbo.realm_reindex', 'operation:' || o.connection_id::text, true);
    UPDATE public.qbo_disconnect_operations SET realm_index = p_new_index, realm_verified_at = clock_timestamp() WHERE connection_id = o.connection_id;
    PERFORM set_config('qbo.realm_reindex', '', true);
    RETURN 'reindexed';
  END;
  $f$;

  -- POSTCONDITION: every body exactly as reviewed; still executable by the service role only.
  IF EXISTS (SELECT 1 FROM unnest(pin_f, pin_d) v(f, d)
     WHERE (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure(v.f)) IS DISTINCT FROM v.d)
     OR EXISTS (SELECT 1 FROM (VALUES ('public.qbo_reseal_connection_realm(uuid,text,text,text,text)'), ('public.qbo_reseal_disconnect_realm(uuid,text,text,text,text)'), ('public.qbo_reseal_refresh_token(uuid,text,text)'), ('public.qbo_reindex_connection_realm(uuid,text,text,text,text)'), ('public.qbo_reindex_disconnect_realm(uuid,text,text,text,text)')) v(f)
                WHERE has_function_privilege('authenticated', v.f, 'EXECUTE') OR has_function_privilege('anon', v.f, 'EXECUTE')
                   OR NOT has_function_privilege('service_role', v.f, 'EXECUTE')) THEN
    RAISE EXCEPTION 'POSTCONDITION: the post-redaction key rotation is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_rotation_post_redaction$;
