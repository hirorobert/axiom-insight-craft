-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261230410000 — QuickBooks token-key reseal: restore the reviewed disconnect-operation guard (forward-only; changes no row).
--   WHY: hosted journal 117 applied 20261230400000 with ONE transcribed line different from the committed source (Lovable's own report,
--   confirmed read-only on 2026-11-19 by the hosted function body digest d087625f… instead of the reviewed ab3855f4…):
--     committed: IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope)
--     applied:   IF (OLD.realm_envelope IS NOT NULL AND OLD.realm_envelope IS DISTINCT FROM OLD.realm_envelope)
--   The applied condition is always false, so an operation's realm envelope could change without a new verification time; before
--   20261230400000 that change was refused unconditionally. Nothing used it: no role can write the table and no function writes a set
--   envelope except qbo_reseal_disconnect_realm (unaffected), and no row changed (hosted fingerprints identical before and after).
--   WHAT: public.qbo_disconnect_operations_guard() is replaced with the reviewed body of 20261230400000, byte for byte.
-- SELF-VERIFYING: the replacement is accepted only if the stored body's sha256 equals the reviewed digest; any transcription difference
--   makes the whole block fail and nothing changes. Already reviewed (a chain applied verbatim, or a replay): no-op. Any body other than
--   the reviewed one or the known hosted variant: refused, nothing changed. Refused if the reseal is missing or the cutover is installed.
-- ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $qbo_reseal_guard_repair$
DECLARE
  v_body text;
BEGIN
  IF to_regprocedure('public.qbo_realm_key_coverage()') IS NULL
     OR position('qbo.realm_reseal' IN pg_get_functiondef('public.qbo_disconnect_operations_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the token-key reseal (20261230400000) is not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_qbo_connections_realm_present') THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the realm protection cutover is installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') INTO v_body FROM pg_proc p WHERE p.oid = 'public.qbo_disconnect_operations_guard()'::regprocedure;
  IF v_body = 'ab3855f445f5d82b68f29dba324745752853a472ee065befdc207b15162099a0' THEN RETURN; END IF;   -- already as reviewed
  IF v_body IS DISTINCT FROM 'd087625f8ffa333d1d90fb407099abc0461418b0425a9486a63e57d70a6ccd18' THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: unexpected disconnect-operation guard body %; nothing was changed', v_body USING ERRCODE = 'P0001';
  END IF;

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

  -- POSTCONDITION: the reviewed body exactly, still an invoker trigger function with its pinned search_path, still attached.
  SELECT encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') INTO v_body FROM pg_proc p WHERE p.oid = 'public.qbo_disconnect_operations_guard()'::regprocedure;
  IF v_body IS DISTINCT FROM 'ab3855f445f5d82b68f29dba324745752853a472ee065befdc207b15162099a0'
     OR (SELECT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] FROM pg_proc p WHERE p.oid = 'public.qbo_disconnect_operations_guard()'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_qbo_disconnect_operations_guard' AND tgrelid = 'public.qbo_disconnect_operations'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTCONDITION: the disconnect-operation guard is not the reviewed body (got %)', v_body USING ERRCODE = 'P0001';
  END IF;
END
$qbo_reseal_guard_repair$;
