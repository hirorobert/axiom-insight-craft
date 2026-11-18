-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261231100000 — QuickBooks realmID protection, Phase C (CUTOVER), part 1 of 3: the schema accepts rows without a plaintext realm. AUTHORED,
-- NOT APPLIED. *** Phase C is IRREVERSIBLE FOR THE PLAINTEXT once part 3 (20261231300000) runs. ***
--   GATE (before anything changes): every live connection and every disconnect operation carries an envelope and an index, and every one that
--   still holds a plaintext realm carries a recorded verification (a function holding the keys opened its envelope to exactly that plaintext).
--   Otherwise QBO_REALM_CUTOVER_REFUSED and nothing changes. Needs Phase B (20261230100000-20261230300000) applied, the Phase B functions deployed,
--   qbo-realm-protect "verify" at 100 %, A DATABASE BACKUP and the owner's explicit go. Design and order: docs/release/qbo-realm-protection-r1/README.md.
--
--   WHAT IT DOES (no row is changed): realm_id becomes nullable on connections, disconnect operations, intents and pulls, and every row must hold
--   the plaintext or the protection; the OAuth state's handoff is paired with the plaintext or the protected realm; the connection and operation
--   guards allow exactly one more transition, a VERIFIED row's realm_id to NULL (never back, never another value). Append-only guards and RLS are
--   untouched (a NOT NULL relaxed and a CHECK added change no row).
-- PREFLIGHT: Phase B installed; a replay is a no-op. POSTCONDITION: four realm_present checks, nullable plaintext, the redaction-aware guards.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_realm_cutover_schema$
DECLARE v_conn integer; v_ops integer; t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_realm_present') THEN RETURN; END IF;   -- replay
  IF to_regprocedure('public.qbo_record_pull_intent(uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text,text,text)') IS NULL
     OR to_regprocedure('public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: realm protection Phase B (20261230100000-20261230300000) is not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_conn FROM public.qbo_connections WHERE status <> 'disconnected' AND (realm_envelope IS NULL OR realm_index IS NULL OR (realm_id IS NOT NULL AND realm_verified_at IS NULL));
  SELECT count(*) INTO v_ops FROM public.qbo_disconnect_operations WHERE realm_envelope IS NULL OR realm_index IS NULL OR (realm_id IS NOT NULL AND realm_verified_at IS NULL);
  IF v_conn <> 0 OR v_ops <> 0 THEN
    RAISE EXCEPTION 'QBO_REALM_CUTOVER_REFUSED: % live connection(s) and % disconnect operation(s) are not protected and verified; run qbo-realm-protect protect, then verify; nothing was changed', v_conn, v_ops USING ERRCODE = 'P0001';
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
    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope) OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN
      RAISE EXCEPTION 'QBO_REALM_PROTECTION_FIXED: the realm protection of a connection is written once. [id=%]', OLD.id USING ERRCODE = '23001';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END;
  $g$;
  CREATE OR REPLACE FUNCTION public.qbo_disconnect_operations_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $g$
  BEGIN
    IF NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR (NEW.realm_id IS DISTINCT FROM OLD.realm_id AND NOT (NEW.realm_id IS NULL AND OLD.realm_index IS NOT NULL AND OLD.realm_verified_at IS NOT NULL))
       OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
       OR (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope) OR (OLD.realm_index IS NOT NULL AND NEW.realm_index IS DISTINCT FROM OLD.realm_index)
       OR (OLD.realm_verified_at IS NOT NULL AND NEW.realm_verified_at IS DISTINCT FROM OLD.realm_verified_at) THEN
      RAISE EXCEPTION 'QBO_DISCONNECT_IDENTITY_FIXED: an operation''s identity and its realm protection never change. [connection=%]', OLD.connection_id USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END;
  $g$;


  -- POSTCONDITION
  IF (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'chk\_qbo\_%\_realm\_present') <> 4
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('qbo_connections', 'qbo_disconnect_operations', 'qbo_pull_intents', 'qbo_pulls')
                AND column_name = 'realm_id' AND is_nullable = 'NO')
     OR position('OLD.realm_verified_at IS NOT NULL))' IN pg_get_functiondef('public.qbo_connections_guard()'::regprocedure)) = 0
     OR position('OLD.realm_verified_at IS NOT NULL))' IN pg_get_functiondef('public.qbo_disconnect_operations_guard()'::regprocedure)) = 0
     OR position('realm_envelope IS NOT NULL' IN (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_qbo_state_handoff')) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: realm protection cutover (part 1, schema) is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;
END
$qbo_realm_cutover_schema$;
