-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261231300000 — QuickBooks realmID protection, Phase C (CUTOVER), part 4 of 4 (v2): the plaintext realm is removed from LIVE rows. AUTHORED, NOT APPLIED.
-- *** IRREVERSIBLE FOR THE PLAINTEXT ***: afterwards no live connection, no PENDING disconnect operation and no OAuth state holds a realmID in clear;
-- restoring it needs the Edge Functions' token key. Backups taken before this migration still contain the plaintext until they age out.
--   GATE (before anything changes): every live connection and every disconnect operation carries an envelope and an index, and every one that
--   still holds a plaintext realm carries a recorded verification (a function holding the keys opened its envelope to exactly that plaintext).
--   Otherwise QBO_REALM_CUTOVER_REFUSED and nothing changes. Needs Phase B (20261230100000-20261230300000) applied, the Phase B functions deployed,
--   qbo-realm-protect "verify" at 100 %, A DATABASE BACKUP and the owner's explicit go. Design and order: docs/release/qbo-realm-protection-r1/README.md.
--
--   WHAT IT DOES:
--   (1) an OAuth attempt parked in clear before Phase B ends (its code is cleared; the person connects again) and its state row, short-lived and
--       already consumed, is removed as qbo_housekeeping would; every other state's plaintext is cleared;
--   (2) realm_id of every live connection and every PENDING disconnect operation is set to NULL (the guards permit it only for a verified row);
--   (3) final rules: a live connection, a pending operation and a state hold no plaintext; every connection and operation keeps its protection; uq_qbo_connections_live (the
--       plaintext rule) is dropped: uq_qbo_connections_live_protected holds for every live row.
--   [v2] HISTORICAL EVIDENCE IS NOT MODIFIED: disconnected (terminal) connections, FINISHED disconnect operations (revoked, local_only) and every
--   import intent and provenance row keep their plaintext and protection byte for byte (proven by a digest taken before and after). Whether
--   that history must also be encrypted is an open compliance question, decided outside this migration;
--   qbo_realm_protection_status() counts both.
-- [v2] It also refuses unless every function body Phase C v2 installed (parts 1-3) is exactly as reviewed (post-redaction rotation available,
--   index homogeneity enforced, the guards' rotation rules present), so the plaintext can never be removed while key rotation depends on it.
-- PREFLIGHT: parts 1, 2 and 3 installed; a replay is a no-op. POSTCONDITION: no plaintext in a live connection, a pending operation or a state; history unchanged. One DO block.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_cutover_redaction$
DECLARE v_conn integer; v_ops integer; v_history text;
  pin_f constant text[] := ARRAY['public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)',
    'public.qbo_begin_disconnect(uuid,uuid,uuid)',
    'public.qbo_record_oauth_return(text,text,text,text,text,text,text)',
    'public.qbo_record_pull_intent(uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text,text,text)',
    'public.qbo_record_fiscal_pull_intent(uuid,jsonb,uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text)',
    'public.qbo_reseal_connection_realm(uuid,text,text,text,text)',
    'public.qbo_reseal_disconnect_realm(uuid,text,text,text,text)',
    'public.qbo_reseal_refresh_token(uuid,text,text)',
    'public.qbo_reindex_connection_realm(uuid,text,text,text,text)',
    'public.qbo_reindex_disconnect_realm(uuid,text,text,text,text)',
    'public.qbo_index_key_mixed(text)',
    'public.qbo_key_version(text,text)',
    'public.qbo_connections_guard()',
    'public.qbo_disconnect_operations_guard()'];
  pin_d constant text[] := ARRAY['c3d0b5fbf6e27948eae7ee94615d703b2c47458b3830e82afd3901565a4d432a',
    '3782a5b866900544e5d680125d5a775573bb1861a57d4d8c439555a4f0f68f9e',
    '1d83d3736825cdfa71392df83e3ef66e6a7f4a15ca7087f8e1e8d1d6ca473f0a',
    '35035edca3ecaa667be0f246f71c0d9c8ab5f15612e7443eccdad7090b6f65b3',
    '8edb63f9724ea7490923fca43e53015be172f7dad03ddcb1b92ed0b0b15e58e6',
    '88af167f2aad5cf3bef2e709a56115f6145d8639a3d37ecf028ca80923b07506',
    '987a3ca649c8b16ef022667b21b315d8286c69441139ecf6b4152a0baef23bd8',
    'c33f4ce2c3b0c733504c3e5758de798f07308efe51a076f87850c4e768f07e2b',
    'd8296b0591591e6201d82f9f024fdec13d7c0716bb7d45171261444e131bd248',
    'ae763d89e82d4aeaa085a71897e6dc942449255bcd48f242c4bd7c6c8b0feac6',
    '3ec271dcead5afca437eaa4831fdfe3b1f94c6265b679ad173f010b922df93ee',
    'fa28da58adf87491e1891abb434c7c9e631de6ba5ce6731933746db4271496d6',
    '134b19428d51440b8d30009b780d7296791b8e633145a20c03a0f540a0e33db3',
    'd526950c94cc230a9f1f8e204415abd01ed810fbab104ff9d5cbcba7dbdbd39f'];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_live_no_plaintext') THEN RETURN; END IF;   -- replay
  IF to_regprocedure('public.qbo_protect_connection_realm(uuid,text,text,text)') IS NOT NULL
     OR position('p_realm_index,0' IN pg_get_functiondef('public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection cutover parts 1 and 2 (20261231100000, 20261231200000) are not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(pin_f, pin_d) v(f, d)
     WHERE (SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') FROM pg_proc p WHERE p.oid = to_regprocedure(v.f)) IS DISTINCT FROM v.d) THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the Phase C v2 functions and guards are not installed exactly as reviewed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_conn FROM public.qbo_connections WHERE status <> 'disconnected' AND (realm_envelope IS NULL OR realm_index IS NULL OR (realm_id IS NOT NULL AND realm_verified_at IS NULL));
  SELECT count(*) INTO v_ops FROM public.qbo_disconnect_operations WHERE realm_envelope IS NULL OR realm_index IS NULL OR (realm_id IS NOT NULL AND realm_verified_at IS NULL);
  IF v_conn <> 0 OR v_ops <> 0 THEN
    RAISE EXCEPTION 'QBO_REALM_CUTOVER_REFUSED: % live connection(s) and % disconnect operation(s) are not protected and verified; run qbo-realm-protect protect, then verify; nothing was changed', v_conn, v_ops USING ERRCODE = 'P0001';
  END IF;

  v_history := encode(sha256(convert_to(concat_ws('|',
      (SELECT string_agg(ROW(id, realm_id, realm_envelope, realm_index, realm_verified_at, status)::text, ';' ORDER BY id) FROM public.qbo_connections WHERE status = 'disconnected'),
      (SELECT string_agg(ROW(connection_id, realm_id, realm_envelope, realm_index, realm_verified_at, outcome)::text, ';' ORDER BY connection_id) FROM public.qbo_disconnect_operations WHERE outcome <> 'pending'),
      (SELECT string_agg(ROW(id, realm_id, realm_envelope, realm_index)::text, ';' ORDER BY id) FROM public.qbo_pull_intents),
      (SELECT string_agg(ROW(id, realm_id, realm_envelope, realm_index)::text, ';' ORDER BY id) FROM public.qbo_pulls), ''), 'UTF8')), 'hex');
  -- (1) OAuth states: attempts parked in clear end; the plaintext of every other state is cleared.
  UPDATE public.qbo_oauth_states SET code_envelope = NULL WHERE code_envelope IS NOT NULL AND realm_envelope IS NULL;
  DELETE FROM public.qbo_oauth_states WHERE realm_id IS NOT NULL AND realm_envelope IS NULL;
  UPDATE public.qbo_oauth_states SET realm_id = NULL WHERE realm_id IS NOT NULL;
  -- (2) the plaintext of every live connection and every disconnect operation.
  UPDATE public.qbo_connections SET realm_id = NULL WHERE status <> 'disconnected' AND realm_id IS NOT NULL;
  UPDATE public.qbo_disconnect_operations SET realm_id = NULL WHERE outcome = 'pending' AND realm_id IS NOT NULL;
  -- (3) final rules.
  ALTER TABLE public.qbo_connections ADD CONSTRAINT chk_qbo_connections_live_no_plaintext
    CHECK (status = 'disconnected' OR (realm_id IS NULL AND realm_envelope IS NOT NULL AND realm_index IS NOT NULL));
  ALTER TABLE public.qbo_disconnect_operations ADD CONSTRAINT chk_qbo_disconnect_operations_no_plaintext CHECK (realm_envelope IS NOT NULL AND realm_index IS NOT NULL AND (outcome <> 'pending' OR realm_id IS NULL));
  ALTER TABLE public.qbo_oauth_states ADD CONSTRAINT chk_qbo_oauth_states_no_plaintext CHECK (realm_id IS NULL AND (code_envelope IS NULL OR realm_envelope IS NOT NULL));
  DROP INDEX public.uq_qbo_connections_live;

  -- POSTCONDITION
  IF EXISTS (SELECT 1 FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.qbo_disconnect_operations WHERE outcome = 'pending' AND realm_id IS NOT NULL) OR EXISTS (SELECT 1 FROM public.qbo_oauth_states WHERE realm_id IS NOT NULL)
     OR encode(sha256(convert_to(concat_ws('|',
      (SELECT string_agg(ROW(id, realm_id, realm_envelope, realm_index, realm_verified_at, status)::text, ';' ORDER BY id) FROM public.qbo_connections WHERE status = 'disconnected'),
      (SELECT string_agg(ROW(connection_id, realm_id, realm_envelope, realm_index, realm_verified_at, outcome)::text, ';' ORDER BY connection_id) FROM public.qbo_disconnect_operations WHERE outcome <> 'pending'),
      (SELECT string_agg(ROW(id, realm_id, realm_envelope, realm_index)::text, ';' ORDER BY id) FROM public.qbo_pull_intents),
      (SELECT string_agg(ROW(id, realm_id, realm_envelope, realm_index)::text, ';' ORDER BY id) FROM public.qbo_pulls), ''), 'UTF8')), 'hex') IS DISTINCT FROM v_history
     OR to_regclass('public.uq_qbo_connections_live') IS NOT NULL OR to_regclass('public.uq_qbo_connections_live_protected') IS NULL
     OR (SELECT count(*) FROM pg_constraint WHERE conname IN ('chk_qbo_connections_live_no_plaintext', 'chk_qbo_disconnect_operations_no_plaintext', 'chk_qbo_oauth_states_no_plaintext')) <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION: realm protection cutover (part 4, redaction) is not complete or changed historical evidence' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_cutover_redaction$;
