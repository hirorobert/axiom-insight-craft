-- INERT CANDIDATE — NOT A MIGRATION. Awaiting Intuit's written clarification (case 00232331) on whether "Encrypt and store the refresh
-- token and realmID in persistent memory" requires APPLICATION-level encryption of realmID in addition to the platform's disk encryption.
-- Never apply this file directly. If adopted, it becomes an authored, registered migration after the then-current head, through the canonical
-- journalled migrator. Design: release/candidates/qbo-realm-protection-r0/DESIGN.md. Proof: scripts/db-proof/qboRealmProtectionCandidate.mjs.
--
-- Phase A is ADDITIVE ONLY: two nullable columns, one constraint, one partial unique index and one service-only backfill function on
-- public.qbo_connections. No existing column, row, constraint, index, function, policy or grant changes; realm_id stays as it is, so every
-- existing connection, its refresh-token envelope (bound to the plaintext realm through connectionBinding) and every current reader keep working.
-- The plaintext is removed only in a later, separately approved Phase C (DESIGN.md), after Phase B (functions dual-write, backfill verified).
BEGIN;

ALTER TABLE public.qbo_connections
  ADD COLUMN realm_envelope text,
  ADD COLUMN realm_index text;

ALTER TABLE public.qbo_connections ADD CONSTRAINT chk_qbo_conn_realm_protection CHECK (
  (realm_envelope IS NULL) = (realm_index IS NULL)
  AND (realm_envelope IS NULL OR realm_envelope ~ '^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
  AND (realm_index IS NULL OR realm_index ~ '^h1\.[a-z0-9-]{1,32}\.[0-9a-f]{64}$')
);

-- The same one-live-connection rule as uq_qbo_connections_live, on the keyed index (in force for protected rows; Phase C makes it the only one).
CREATE UNIQUE INDEX uq_qbo_connections_live_protected ON public.qbo_connections (company_id, realm_index, environment)
  WHERE status <> 'disconnected' AND realm_index IS NOT NULL;

COMMENT ON COLUMN public.qbo_connections.realm_envelope IS 'realmID sealed with AES-256-GCM (refresh-token envelope format, purpose qbo-realm-id, bound to company and environment). Key held only by the Edge Functions.';
COMMENT ON COLUMN public.qbo_connections.realm_index IS 'Keyed HMAC-SHA256 equality index of (environment, realmID): uniqueness, shared-realm checks and per-realm locks without the plaintext.';

-- Backfill of ONE existing connection. Service role only. The caller (an Edge Function holding the keys) seals and verifies the round trip
-- first; the database refuses unless the supplied plaintext equals the row's realm_id, never overwrites a protected row, and never touches a
-- disconnected (terminal) row. Fills only the two new columns; the guard trigger keeps identity fixed and stamps updated_at.
CREATE FUNCTION public.qbo_protect_connection_realm(p_connection uuid, p_realm_id text, p_realm_envelope text, p_realm_index text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.qbo_connections%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF c.status = 'disconnected' THEN RETURN 'terminal_unchanged'; END IF;
  IF c.realm_id IS DISTINCT FROM p_realm_id THEN RETURN 'realm_mismatch'; END IF;
  IF c.realm_envelope IS NOT NULL THEN RETURN CASE WHEN c.realm_index = p_realm_index THEN 'already_protected' ELSE 'index_conflict' END; END IF;
  UPDATE public.qbo_connections SET realm_envelope = p_realm_envelope, realm_index = p_realm_index WHERE id = p_connection;
  RETURN 'protected';
END;
$$;
REVOKE ALL ON FUNCTION public.qbo_protect_connection_realm(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qbo_protect_connection_realm(uuid, text, text, text) TO service_role;

COMMIT;
