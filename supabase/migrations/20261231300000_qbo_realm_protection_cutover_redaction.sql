-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261231300000 — QuickBooks realmID protection, Phase C (CUTOVER), part 3 of 3: the plaintext realm is removed. AUTHORED, NOT APPLIED.
-- *** IRREVERSIBLE FOR THE PLAINTEXT ***: afterwards no live connection, no disconnect operation and no OAuth state holds a realmID in clear;
-- restoring it needs the Edge Functions' token key. Backups taken before this migration still contain the plaintext until they age out.
--   GATE (before anything changes): every live connection and every disconnect operation carries an envelope and an index, and every one that
--   still holds a plaintext realm carries a recorded verification (a function holding the keys opened its envelope to exactly that plaintext).
--   Otherwise QBO_REALM_CUTOVER_REFUSED and nothing changes. Needs Phase B (20261230100000-20261230300000) applied, the Phase B functions deployed,
--   qbo-realm-protect "verify" at 100 %, A DATABASE BACKUP and the owner's explicit go. Design and order: docs/release/qbo-realm-protection-r1/README.md.
--
--   WHAT IT DOES:
--   (1) an OAuth attempt parked in clear before Phase B ends (its code is cleared; the person connects again) and its state row, short-lived and
--       already consumed, is removed as qbo_housekeeping would; every other state's plaintext is cleared;
--   (2) realm_id of every live connection and every disconnect operation is set to NULL (the guards permit it only for a verified row);
--   (3) final rules: a live connection, an operation and a state hold no plaintext and keep their protection; uq_qbo_connections_live (the
--       plaintext rule) is dropped: uq_qbo_connections_live_protected holds for every live row.
--   Disconnected (terminal) connections cannot change and keep their plaintext; historical intents and pulls keep theirs (append-only, unchanged);
--   qbo_realm_protection_status() counts both.
-- PREFLIGHT: parts 1 and 2 installed; a replay is a no-op. POSTCONDITION: no plaintext in a live connection, an operation or a state. One DO block.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_cutover_redaction$
DECLARE v_conn integer; v_ops integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_live_no_plaintext') THEN RETURN; END IF;   -- replay
  IF to_regprocedure('public.qbo_protect_connection_realm(uuid,text,text,text)') IS NOT NULL
     OR position('p_realm_index,0' IN pg_get_functiondef('public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection cutover parts 1 and 2 (20261231100000, 20261231200000) are not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_conn FROM public.qbo_connections WHERE status <> 'disconnected' AND (realm_envelope IS NULL OR realm_index IS NULL OR (realm_id IS NOT NULL AND realm_verified_at IS NULL));
  SELECT count(*) INTO v_ops FROM public.qbo_disconnect_operations WHERE realm_envelope IS NULL OR realm_index IS NULL OR (realm_id IS NOT NULL AND realm_verified_at IS NULL);
  IF v_conn <> 0 OR v_ops <> 0 THEN
    RAISE EXCEPTION 'QBO_REALM_CUTOVER_REFUSED: % live connection(s) and % disconnect operation(s) are not protected and verified; run qbo-realm-protect protect, then verify; nothing was changed', v_conn, v_ops USING ERRCODE = 'P0001';
  END IF;

  -- (1) OAuth states: attempts parked in clear end; the plaintext of every other state is cleared.
  UPDATE public.qbo_oauth_states SET code_envelope = NULL WHERE code_envelope IS NOT NULL AND realm_envelope IS NULL;
  DELETE FROM public.qbo_oauth_states WHERE realm_id IS NOT NULL AND realm_envelope IS NULL;
  UPDATE public.qbo_oauth_states SET realm_id = NULL WHERE realm_id IS NOT NULL;
  -- (2) the plaintext of every live connection and every disconnect operation.
  UPDATE public.qbo_connections SET realm_id = NULL WHERE status <> 'disconnected' AND realm_id IS NOT NULL;
  UPDATE public.qbo_disconnect_operations SET realm_id = NULL WHERE realm_id IS NOT NULL;
  -- (3) final rules.
  ALTER TABLE public.qbo_connections ADD CONSTRAINT chk_qbo_connections_live_no_plaintext
    CHECK (status = 'disconnected' OR (realm_id IS NULL AND realm_envelope IS NOT NULL AND realm_index IS NOT NULL));
  ALTER TABLE public.qbo_disconnect_operations ADD CONSTRAINT chk_qbo_disconnect_operations_no_plaintext CHECK (realm_id IS NULL AND realm_envelope IS NOT NULL AND realm_index IS NOT NULL);
  ALTER TABLE public.qbo_oauth_states ADD CONSTRAINT chk_qbo_oauth_states_no_plaintext CHECK (realm_id IS NULL AND (code_envelope IS NULL OR realm_envelope IS NOT NULL));
  DROP INDEX public.uq_qbo_connections_live;

  -- POSTCONDITION
  IF EXISTS (SELECT 1 FROM public.qbo_connections WHERE status <> 'disconnected' AND realm_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.qbo_disconnect_operations WHERE realm_id IS NOT NULL) OR EXISTS (SELECT 1 FROM public.qbo_oauth_states WHERE realm_id IS NOT NULL)
     OR to_regclass('public.uq_qbo_connections_live') IS NOT NULL OR to_regclass('public.uq_qbo_connections_live_protected') IS NULL
     OR (SELECT count(*) FROM pg_constraint WHERE conname IN ('chk_qbo_connections_live_no_plaintext', 'chk_qbo_disconnect_operations_no_plaintext', 'chk_qbo_oauth_states_no_plaintext')) <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION: realm protection cutover (part 3, redaction) is not complete' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_cutover_redaction$;
