-- QuickBooks Online connector (charter B9, R14): storage for connections, OAuth state and import provenance.
-- Design: docs/architecture/QUICKBOOKS_ONLINE_CONNECTOR_PLAN.md section 12, approved by the owner (decisions D3, 2026-11-01).
-- UNAPPLIED candidate migration: nothing here is applied to any hosted database, and no Edge Function uses these tables yet.
--
-- WHAT THIS STORES, AND WHAT IT NEVER STORES
--   qbo_connections  one live connection per company + QuickBooks company (realm) + environment. The refresh token is stored ONLY as an
--                    AES-256-GCM envelope (supabase/functions/_shared/qboTokenEnvelope.ts: key from the Edge Function runtime, bound to workspace,
--                    connection and purpose). The database never holds a key, an access token, a client secret or a clear refresh token.
--                    A connection that is not 'active' holds NO token at all (a dead or disconnected token is deleted, not kept).
--   qbo_oauth_states single-use, short-lived (60 s to 30 min) anti-forgery state, stored as a SHA-256 hash only.
--   qbo_pull_intents append-only, written BEFORE the file is stored or registered: what was asked of QuickBooks and the SHA-256 of the raw response,
--                    of the canonical file and of the normalised accounting result, keyed by the upload reservation. If this cannot be written, nothing is
--                    imported. If everything after it fails, the intent is the record that a report was fetched and not imported.
--   qbo_pulls        append-only provenance, one row per imported report: the intent's facts plus the upload it became. It is written from the intent
--                    and the reservation's own record of the upload it created (never from a caller-supplied upload id) by qbo_complete_pull, which is
--                    idempotent and can be re-run by qbo_complete_pending_pulls, so a failure between "upload registered" and "provenance linked" is
--                    recovered, not lost. Plain uuid columns, no foreign keys (a record must outlive a deleted upload or workspace, and a foreign key
--                    to trial_balance_uploads makes uploads undeletable).
--
-- WHO MAY DO WHAT
--   Clients (anon, authenticated) have NO access to qbo_connections or qbo_oauth_states: not to read, not to write. Only the service role, through
--   the SECURITY DEFINER functions below, writes any of the three tables. The authority to connect, disconnect or record a pull is judged INSIDE
--   each function with public.workspace_authority_basis(actor, company, 'prepare_trial_balance'), exactly as other writes in this repository: no
--   function trusts a caller-supplied identity without that check, and an unknown company or a missing right is refused.
--   Importing needs TWO rights, both required, neither implying the other: prepare_trial_balance (the connector's own: connect, disconnect, status,
--   refresh, record) and manage_source_files (the existing upload steps reserve_trial_balance_source and register_trial_balance_upload, which judge
--   the person themself). qbo_record_pull_intent enforces both again, so the stored evidence can never be written for a person who lacks either.
--   The workspace owner may read the company's provenance rows (qbo_pull_intents, qbo_pulls). Members see connection STATUS through
--   qbo_connection_status(), which returns no secret, no envelope and no key id.
--
-- ROTATION. Intuit's refresh tokens roll over. Two protections, in this order:
--   1 qbo_acquire_refresh_lease: a short lease (compare-and-set on the connection row) is taken BEFORE Intuit is called, so two simultaneous imports can
--     never present the same refresh token to Intuit at the same time; the second is told "busy" without any call to Intuit.
--   2 qbo_rotate_refresh_token is a compare-and-swap on the stored envelope: the caller names the envelope it used, and the new one is stored only if
--     that is still the current one (and clears the lease). If the lease lapsed (a crashed import) and two refreshes did happen, only one can win.
--   A lease that is never released simply lapses (at most p_seconds, 10 to 300). What happens if Intuit has already invalidated a token that was in
--   flight is documented in docs/release/qbo-connector-storage-r1/README.md; the recovery is always "reconnect" (the dead token is deleted).
--
-- RETENTION. qbo_oauth_states past their day of grace and active connections past their refresh expiry are removed by qbo_housekeeping() (opportunistic,
--   no scheduler needed). qbo_pull_intents and qbo_pulls are evidence: append-only, no deletion mechanism ships here, and none is needed for years;
--   qbo_provenance_past_retention() only COUNTS rows past a retention interval for the day a purge is approved. See the release record.
--
-- ACTOR. Like the other recent workspace-authority tables (trial_balance_source_download_events), the actor is the authenticated user id recorded
--   as actor_user_id, judged through workspace_authority_basis. This differs from the older firm_members.id convention in CLAUDE.md section 4.3; it
--   follows the repository's current authority model and is flagged for the independent reviewer.

-- ── 1. connections ──────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.qbo_connections (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,   -- deleting a workspace deletes its connections and their tokens
  connected_by_user_id uuid NOT NULL,
  realm_id text NOT NULL CHECK (realm_id ~ '^[0-9]{1,20}$'),                       -- QuickBooks's company id
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reconnect_needed', 'disconnected')),
  refresh_token_envelope text,
  envelope_key_id text,
  refresh_expires_at timestamptz,
  hard_expires_at timestamptz,
  refresh_lease_until timestamptz,   -- held only while one import is refreshing the token; lapses by itself; never a secret
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disconnected_at timestamptz,
  CONSTRAINT chk_qbo_conn_envelope_shape CHECK (refresh_token_envelope IS NULL
    OR refresh_token_envelope ~ '^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  CONSTRAINT chk_qbo_conn_key_matches CHECK (refresh_token_envelope IS NULL
    OR envelope_key_id = split_part(refresh_token_envelope, '.', 2)),
  -- A token exists exactly while the connection is active; a dead or disconnected connection holds none.
  CONSTRAINT chk_qbo_conn_token_iff_active CHECK ((status = 'active') = (refresh_token_envelope IS NOT NULL AND envelope_key_id IS NOT NULL AND refresh_expires_at IS NOT NULL)),
  CONSTRAINT chk_qbo_conn_inactive_has_no_token CHECK (status = 'active' OR (refresh_token_envelope IS NULL AND envelope_key_id IS NULL AND refresh_expires_at IS NULL AND hard_expires_at IS NULL AND refresh_lease_until IS NULL)),
  CONSTRAINT chk_qbo_conn_disconnected_at CHECK ((status = 'disconnected') = (disconnected_at IS NOT NULL))
);
COMMENT ON TABLE public.qbo_connections IS
  'QuickBooks Online connections. The refresh token is an AES-256-GCM envelope only; a connection that is not active holds no token. Clients have no access; the service role writes through the qbo_* functions.';
CREATE UNIQUE INDEX uq_qbo_connections_live ON public.qbo_connections (company_id, realm_id, environment) WHERE status <> 'disconnected';
CREATE INDEX idx_qbo_connections_company ON public.qbo_connections (company_id);
ALTER TABLE public.qbo_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qbo_connections FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.qbo_connections TO service_role;   -- the Edge Function reads the envelope to open it; every write goes through the functions below

CREATE OR REPLACE FUNCTION public.qbo_connections_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status = 'disconnected' THEN
    RAISE EXCEPTION 'QBO_CONNECTION_TERMINAL: a disconnected connection cannot change. [id=%]', OLD.id USING ERRCODE = '23001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.realm_id IS DISTINCT FROM OLD.realm_id
     OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'QBO_CONNECTION_IDENTITY_FIXED: company, realm, environment and creation time never change. [id=%]', OLD.id USING ERRCODE = '23001';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.qbo_connections_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_qbo_connections_guard BEFORE UPDATE ON public.qbo_connections
  FOR EACH ROW EXECUTE FUNCTION public.qbo_connections_guard();

-- ── 2. OAuth state ──────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.qbo_oauth_states (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),           -- SHA-256 of the state; the state itself is never stored
  company_id uuid NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  return_period_year integer NOT NULL CHECK (return_period_year BETWEEN 2000 AND 2100),   -- where the browser is sent back to: the workspace's period page
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT chk_qbo_state_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes'),
  CONSTRAINT chk_qbo_state_consumed CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
COMMENT ON TABLE public.qbo_oauth_states IS 'Single-use anti-forgery state for the QuickBooks authorisation redirect, stored as a SHA-256 hash, valid at most 30 minutes. Clients have no access.';
CREATE INDEX idx_qbo_oauth_states_expiry ON public.qbo_oauth_states (expires_at);
ALTER TABLE public.qbo_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qbo_oauth_states FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. provenance (append-only) ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.qbo_pulls (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pulled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  company_id uuid NOT NULL,        -- not FKs: the record must outlive a deleted upload, connection or workspace
  upload_id uuid NOT NULL UNIQUE,  -- one import, one upload
  connection_id uuid,
  actor_user_id uuid NOT NULL,
  realm_id text NOT NULL CHECK (realm_id ~ '^[0-9]{1,20}$'),
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  report text NOT NULL CHECK (report = 'TrialBalance'),
  start_date date NOT NULL,
  end_date date NOT NULL,
  accounting_method text CHECK (accounting_method IS NULL OR accounting_method IN ('Accrual', 'Cash')),
  minor_version integer CHECK (minor_version IS NULL OR minor_version BETWEEN 0 AND 999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  account_count integer NOT NULL CHECK (account_count >= 0),
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),                  -- the response exactly as received
  canonical_sha256 text NOT NULL CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),      -- the canonical file the upload steps received
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),            -- the normalised accounting result (charter A2 parity, "up to date" on refresh)
  CONSTRAINT chk_qbo_pulls_dates CHECK (start_date <= end_date)
);
COMMENT ON TABLE public.qbo_pulls IS 'Append-only provenance of QuickBooks Online imports: request parameters, currency and the SHA-256 of the raw response, the canonical file and the normalised result. No token, no URL, no payload.';
CREATE INDEX idx_qbo_pulls_company_time ON public.qbo_pulls (company_id, pulled_at DESC);
ALTER TABLE public.qbo_pulls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qbo_pulls FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.qbo_pulls TO authenticated, service_role;   -- reads only: qbo_record_pull is the only writer
CREATE POLICY "Workspace owner reads QuickBooks pulls" ON public.qbo_pulls FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.companies c WHERE c.id = qbo_pulls.company_id AND c.user_id = auth.uid()));
CREATE TRIGGER trg_qbo_pulls_append_only BEFORE UPDATE OR DELETE ON public.qbo_pulls
  FOR EACH ROW EXECUTE FUNCTION public.tbu_append_only_guard();
CREATE OR REPLACE FUNCTION public.qbo_evidence_no_truncate()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: % is append-only. TRUNCATE is not permitted.', TG_TABLE_NAME USING ERRCODE = '23001';
END;
$$;
REVOKE ALL ON FUNCTION public.qbo_evidence_no_truncate() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_qbo_pulls_no_truncate BEFORE TRUNCATE ON public.qbo_pulls
  FOR EACH STATEMENT EXECUTE FUNCTION public.qbo_evidence_no_truncate();

-- ── 3b. intents (append-only; written BEFORE the file is stored or registered) ─────────────────────────────────────
-- The same facts as a pull, keyed by the upload RESERVATION (which exists before the upload does). A report is never put into the upload steps unless
-- this row is already written; so an upload can never exist for a QuickBooks import without its evidence.
CREATE TABLE public.qbo_pull_intents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reservation_id uuid NOT NULL UNIQUE,   -- trial_balance_source_reservations.id; not an FK: the evidence outlives the reservation and the workspace
  company_id uuid NOT NULL,
  connection_id uuid,
  actor_user_id uuid NOT NULL,
  realm_id text NOT NULL CHECK (realm_id ~ '^[0-9]{1,20}$'),
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  report text NOT NULL CHECK (report = 'TrialBalance'),
  start_date date NOT NULL,
  end_date date NOT NULL,
  accounting_method text CHECK (accounting_method IS NULL OR accounting_method IN ('Accrual', 'Cash')),
  minor_version integer CHECK (minor_version IS NULL OR minor_version BETWEEN 0 AND 999),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  account_count integer NOT NULL CHECK (account_count >= 0),
  raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_sha256 text NOT NULL CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_qbo_intents_dates CHECK (start_date <= end_date)
);
COMMENT ON TABLE public.qbo_pull_intents IS 'Append-only: the facts of a QuickBooks Online report recorded before its file is stored, keyed by the upload reservation. No token, no URL, no payload.';
CREATE INDEX idx_qbo_intents_company_time ON public.qbo_pull_intents (company_id, recorded_at DESC);
ALTER TABLE public.qbo_pull_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qbo_pull_intents FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.qbo_pull_intents TO authenticated, service_role;   -- reads only: qbo_record_pull_intent is the only writer
CREATE POLICY "Workspace owner reads QuickBooks pull intents" ON public.qbo_pull_intents FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.companies c WHERE c.id = qbo_pull_intents.company_id AND c.user_id = auth.uid()));
CREATE TRIGGER trg_qbo_intents_append_only BEFORE UPDATE OR DELETE ON public.qbo_pull_intents
  FOR EACH ROW EXECUTE FUNCTION public.tbu_append_only_guard();
CREATE TRIGGER trg_qbo_intents_no_truncate BEFORE TRUNCATE ON public.qbo_pull_intents
  FOR EACH STATEMENT EXECUTE FUNCTION public.qbo_evidence_no_truncate();

-- ── 4. the only writers (service role; each judges the actor's authority itself) ─────────────────────────────────────

-- Starts an authorisation: stores the state's hash. 'created' | 'forbidden' (no authority in that workspace) | 'invalid' (bad input or a repeated state).
CREATE FUNCTION public.qbo_start_oauth_state(p_state_hash text, p_company_id uuid, p_actor_user_id uuid, p_environment text, p_ttl_seconds integer, p_return_period_year integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' OR p_company_id IS NULL OR p_actor_user_id IS NULL
     OR p_environment IS NULL OR p_environment NOT IN ('production', 'sandbox') OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 1800
     OR p_return_period_year IS NULL OR p_return_period_year NOT BETWEEN 2000 AND 2100 THEN
    RETURN 'invalid';
  END IF;
  IF public.workspace_authority_basis(p_actor_user_id, p_company_id, 'prepare_trial_balance') IS NULL THEN RETURN 'forbidden'; END IF;
  INSERT INTO public.qbo_oauth_states (state_hash, company_id, actor_user_id, environment, return_period_year, expires_at)
  VALUES (p_state_hash, p_company_id, p_actor_user_id, p_environment, p_return_period_year, clock_timestamp() + make_interval(secs => p_ttl_seconds));
  RETURN 'created';
EXCEPTION WHEN unique_violation THEN
  RETURN 'invalid';
END;
$$;

-- Consumes a state exactly once. Returns the row only if the state was unused and unexpired AND the actor still holds the right; otherwise nothing.
-- A state that was valid but whose actor lost the right is consumed all the same (it cannot be tried again).
CREATE FUNCTION public.qbo_consume_oauth_state(p_state_hash text)
RETURNS TABLE (company_id uuid, actor_user_id uuid, environment text, return_period_year integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record;
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  UPDATE public.qbo_oauth_states s SET consumed_at = clock_timestamp()
   WHERE s.state_hash = p_state_hash AND s.consumed_at IS NULL AND s.expires_at > clock_timestamp()
  RETURNING s.company_id AS c, s.actor_user_id AS a, s.environment AS e, s.return_period_year AS y INTO r;
  IF NOT FOUND THEN RETURN; END IF;
  IF public.workspace_authority_basis(r.a, r.c, 'prepare_trial_balance') IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT r.c, r.a, r.e, r.y;
END;
$$;

-- Stores (or replaces, on reconnect) the one live connection of a company + realm + environment. Raises FORBIDDEN without the right.
CREATE FUNCTION public.qbo_store_connection(p_company_id uuid, p_actor_user_id uuid, p_realm_id text, p_environment text, p_envelope text,
                                            p_refresh_expires_at timestamptz, p_hard_expires_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_actor_user_id IS NULL OR public.workspace_authority_basis(p_actor_user_id, p_company_id, 'prepare_trial_balance') IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: no right to connect QuickBooks in this workspace' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_id FROM public.qbo_connections
   WHERE company_id = p_company_id AND realm_id = p_realm_id AND environment = p_environment AND status <> 'disconnected' FOR UPDATE;
  IF FOUND THEN
    UPDATE public.qbo_connections SET status = 'active', refresh_token_envelope = p_envelope, envelope_key_id = split_part(p_envelope, '.', 2),
           refresh_expires_at = p_refresh_expires_at, hard_expires_at = p_hard_expires_at, connected_by_user_id = p_actor_user_id, refresh_lease_until = NULL
     WHERE id = v_id;
  ELSE
    INSERT INTO public.qbo_connections (company_id, connected_by_user_id, realm_id, environment, status, refresh_token_envelope, envelope_key_id, refresh_expires_at, hard_expires_at)
    VALUES (p_company_id, p_actor_user_id, p_realm_id, p_environment, 'active', p_envelope, split_part(p_envelope, '.', 2), p_refresh_expires_at, p_hard_expires_at)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

-- Takes the refresh lease BEFORE Intuit is called: true for exactly one caller at a time (compare-and-set on the row, so a concurrent second caller waits
-- for the row lock, re-reads the lease and gets false). The lease names the envelope the caller will present, so a caller holding an out-of-date envelope
-- never gets it. Lapses by itself after p_seconds (10 to 300) if the caller dies.
CREATE FUNCTION public.qbo_acquire_refresh_lease(p_connection_id uuid, p_expected_envelope text, p_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  IF p_connection_id IS NULL OR p_expected_envelope IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 10 AND 300 THEN RETURN false; END IF;
  UPDATE public.qbo_connections SET refresh_lease_until = clock_timestamp() + make_interval(secs => p_seconds)
   WHERE id = p_connection_id AND status = 'active' AND refresh_token_envelope = p_expected_envelope
     AND (refresh_lease_until IS NULL OR refresh_lease_until <= clock_timestamp());
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END;
$$;

-- Gives the lease back when the refresh did not happen (Intuit unavailable, for example) so the next attempt need not wait for it to lapse.
CREATE FUNCTION public.qbo_release_refresh_lease(p_connection_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.qbo_connections SET refresh_lease_until = NULL WHERE id = p_connection_id AND status = 'active' AND refresh_lease_until IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END;
$$;

-- Compare-and-swap rotation: stores the new envelope only if p_expected_envelope is still the stored one and the connection is active. Clears the lease.
CREATE FUNCTION public.qbo_rotate_refresh_token(p_connection_id uuid, p_expected_envelope text, p_new_envelope text, p_refresh_expires_at timestamptz, p_hard_expires_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.qbo_connections SET refresh_token_envelope = p_new_envelope, envelope_key_id = split_part(p_new_envelope, '.', 2),
         refresh_expires_at = p_refresh_expires_at, hard_expires_at = p_hard_expires_at, refresh_lease_until = NULL
   WHERE id = p_connection_id AND status = 'active' AND refresh_token_envelope = p_expected_envelope;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END;
$$;

-- Intuit refused the refresh token (or it expired): the dead token is deleted and the user must reconnect.
CREATE FUNCTION public.qbo_mark_reconnect_needed(p_connection_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.qbo_connections SET status = 'reconnect_needed', refresh_token_envelope = NULL, envelope_key_id = NULL, refresh_expires_at = NULL, hard_expires_at = NULL,
         refresh_lease_until = NULL
   WHERE id = p_connection_id AND status = 'active';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END;
$$;

-- Disconnect: judged for the actor, the token is deleted, the row stays as a terminal record. 'disconnected' | 'already' | 'forbidden' | 'unknown'.
CREATE FUNCTION public.qbo_disconnect(p_connection_id uuid, p_actor_user_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.qbo_connections;
BEGIN
  SELECT * INTO c FROM public.qbo_connections WHERE id = p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF p_actor_user_id IS NULL OR public.workspace_authority_basis(p_actor_user_id, c.company_id, 'prepare_trial_balance') IS NULL THEN RETURN 'forbidden'; END IF;
  IF c.status = 'disconnected' THEN RETURN 'already'; END IF;
  UPDATE public.qbo_connections SET status = 'disconnected', refresh_token_envelope = NULL, envelope_key_id = NULL, refresh_expires_at = NULL, hard_expires_at = NULL,
         refresh_lease_until = NULL, disconnected_at = clock_timestamp()
   WHERE id = p_connection_id;
  RETURN 'disconnected';
END;
$$;

-- Records the facts of a fetched report BEFORE its file is stored or registered. Raises FORBIDDEN unless the reservation is the actor's own AND the actor holds
-- BOTH rights an import needs (prepare_trial_balance for the connector, manage_source_files for the upload steps). The workspace comes from the reservation,
-- never from the caller. Idempotent for a retry with the same facts; the same reservation with different facts raises INTENT_CONFLICT.
CREATE FUNCTION public.qbo_record_pull_intent(p_reservation_id uuid, p_connection_id uuid, p_actor_user_id uuid, p_realm_id text, p_environment text,
                                              p_start_date date, p_end_date date, p_accounting_method text, p_minor_version integer, p_currency text,
                                              p_account_count integer, p_raw_sha256 text, p_canonical_sha256 text, p_result_sha256 text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.trial_balance_source_reservations%ROWTYPE;
  e public.qbo_pull_intents%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_reservation_id IS NULL OR p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: a reservation and an actor are required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO r FROM public.trial_balance_source_reservations x WHERE x.id = p_reservation_id;
  IF NOT FOUND OR r.actor_user_id <> p_actor_user_id
     OR public.workspace_authority_basis(p_actor_user_id, r.company_id, 'prepare_trial_balance') IS NULL
     OR public.workspace_authority_basis(p_actor_user_id, r.company_id, 'manage_source_files') IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: no right to import from QuickBooks into this workspace' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM public.qbo_pull_intents i WHERE i.reservation_id = p_reservation_id;
  IF FOUND THEN
    IF e.raw_sha256 = p_raw_sha256 AND e.canonical_sha256 = p_canonical_sha256 AND e.result_sha256 = p_result_sha256 THEN RETURN e.id; END IF;
    RAISE EXCEPTION 'INTENT_CONFLICT: this reservation already carries different facts' USING ERRCODE = '23505';
  END IF;
  IF r.consumed_at IS NOT NULL OR r.expires_at <= now() THEN
    RAISE EXCEPTION 'RESERVATION_NOT_OPEN: the upload reservation is already used or has expired' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.qbo_pull_intents (reservation_id, company_id, connection_id, actor_user_id, realm_id, environment, report, start_date, end_date, accounting_method,
                                       minor_version, currency, account_count, raw_sha256, canonical_sha256, result_sha256)
  VALUES (p_reservation_id, r.company_id, p_connection_id, p_actor_user_id, p_realm_id, p_environment, 'TrialBalance', p_start_date, p_end_date, p_accounting_method,
          p_minor_version, p_currency, p_account_count, p_raw_sha256, p_canonical_sha256, p_result_sha256)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Links the intent to the upload the reservation created, by writing the provenance row. The upload id is the RESERVATION's own record (consumed_by_upload_id),
-- never a caller-supplied value. Idempotent. 'completed' | 'already' | 'not_registered' (the upload was never created) | 'no_intent' | 'no_reservation'.
-- It re-judges no right: it copies facts already authorised at intent time and at registration, so a right revoked in between cannot lose evidence.
CREATE FUNCTION public.qbo_complete_pull(p_reservation_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  i public.qbo_pull_intents%ROWTYPE;
  r public.trial_balance_source_reservations%ROWTYPE;
  n integer;
BEGIN
  SELECT * INTO i FROM public.qbo_pull_intents x WHERE x.reservation_id = p_reservation_id;
  IF NOT FOUND THEN RETURN 'no_intent'; END IF;
  SELECT * INTO r FROM public.trial_balance_source_reservations x WHERE x.id = p_reservation_id;
  IF NOT FOUND THEN RETURN 'no_reservation'; END IF;
  IF r.consumed_by_upload_id IS NULL THEN RETURN 'not_registered'; END IF;
  IF r.company_id <> i.company_id OR r.actor_user_id <> i.actor_user_id THEN
    RAISE EXCEPTION 'INTENT_MISMATCH: the reservation and the recorded intent disagree about the workspace or the person' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.qbo_pulls (pulled_at, company_id, upload_id, connection_id, actor_user_id, realm_id, environment, report, start_date, end_date, accounting_method,
                                minor_version, currency, account_count, raw_sha256, canonical_sha256, result_sha256)
  VALUES (i.recorded_at, i.company_id, r.consumed_by_upload_id, i.connection_id, i.actor_user_id, i.realm_id, i.environment, i.report, i.start_date, i.end_date, i.accounting_method,
          i.minor_version, i.currency, i.account_count, i.raw_sha256, i.canonical_sha256, i.result_sha256)
  ON CONFLICT (upload_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN CASE WHEN n = 1 THEN 'completed' ELSE 'already' END;
END;
$$;

-- Recovery: completes every intent whose upload exists but whose provenance row is missing (at most 500 per call; one bad row never stops the rest).
-- Returns how many it completed. Called opportunistically by the Edge Functions; a scheduler may call it too, none is added here.
CREATE FUNCTION public.qbo_complete_pending_pulls()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE x record; n integer := 0;
BEGIN
  FOR x IN
    SELECT i.reservation_id FROM public.qbo_pull_intents i
      JOIN public.trial_balance_source_reservations r ON r.id = i.reservation_id
     WHERE r.consumed_by_upload_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.qbo_pulls p WHERE p.upload_id = r.consumed_by_upload_id)
     ORDER BY i.recorded_at LIMIT 500
  LOOP
    BEGIN
      IF public.qbo_complete_pull(x.reservation_id) = 'completed' THEN n := n + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;   -- a row that cannot be linked (a mismatch) is left for a person to look at; the rest still complete
    END;
  END LOOP;
  RETURN n;
END;
$$;

-- Housekeeping: removes OAuth states more than a day past their expiry (at most 1000 per call) and turns active connections whose refresh token has
-- expired into 'reconnect_needed' (their dead token is deleted). Evidence (qbo_pull_intents, qbo_pulls) is never touched.
CREATE FUNCTION public.qbo_housekeeping()
RETURNS TABLE (states_removed integer, connections_expired integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a integer; b integer;
BEGIN
  DELETE FROM public.qbo_oauth_states WHERE id IN (SELECT s.id FROM public.qbo_oauth_states s WHERE s.expires_at < clock_timestamp() - interval '1 day' ORDER BY s.expires_at LIMIT 1000);
  GET DIAGNOSTICS a = ROW_COUNT;
  UPDATE public.qbo_connections SET status = 'reconnect_needed', refresh_token_envelope = NULL, envelope_key_id = NULL, refresh_expires_at = NULL, hard_expires_at = NULL, refresh_lease_until = NULL
   WHERE status = 'active' AND (refresh_expires_at <= clock_timestamp() OR (hard_expires_at IS NOT NULL AND hard_expires_at <= clock_timestamp()));
  GET DIAGNOSTICS b = ROW_COUNT;
  RETURN QUERY SELECT a, b;
END;
$$;

-- Counts (never deletes) the evidence older than a retention interval, so a purge can be sized and approved when the day comes. At least one year.
CREATE FUNCTION public.qbo_provenance_past_retention(p_retention interval)
RETURNS TABLE (intents bigint, pulls bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_retention IS NULL OR p_retention < interval '1 year' THEN RAISE EXCEPTION 'RETENTION_TOO_SHORT: at least one year' USING ERRCODE = '22023'; END IF;
  RETURN QUERY SELECT (SELECT count(*) FROM public.qbo_pull_intents WHERE recorded_at < clock_timestamp() - p_retention),
                      (SELECT count(*) FROM public.qbo_pulls WHERE pulled_at < clock_timestamp() - p_retention);
END;
$$;

-- What a member may see of the connections: status only, never an envelope, key id or token. Returns nothing without the right.
CREATE FUNCTION public.qbo_connection_status(p_company_id uuid)
RETURNS TABLE (id uuid, realm_id text, environment text, status text, refresh_expires_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id, c.realm_id, c.environment, c.status, c.refresh_expires_at, c.created_at
    FROM public.qbo_connections c
   WHERE c.company_id = p_company_id AND auth.uid() IS NOT NULL
     AND public.workspace_authority_basis(auth.uid(), p_company_id, 'prepare_trial_balance') IS NOT NULL
   ORDER BY c.created_at DESC;
$$;

-- Grants: the writers are for the service role only; members call only the status function.
REVOKE ALL ON FUNCTION public.qbo_start_oauth_state(text, uuid, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_consume_oauth_state(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_store_connection(uuid, uuid, text, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_acquire_refresh_lease(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_release_refresh_lease(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_rotate_refresh_token(uuid, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_mark_reconnect_needed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_disconnect(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_record_pull_intent(uuid, uuid, uuid, text, text, date, date, text, integer, text, integer, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_complete_pull(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_complete_pending_pulls() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_housekeeping() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_provenance_past_retention(interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_connection_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qbo_start_oauth_state(text, uuid, uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_consume_oauth_state(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_store_connection(uuid, uuid, text, text, text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_acquire_refresh_lease(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_release_refresh_lease(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_rotate_refresh_token(uuid, text, text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_mark_reconnect_needed(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_disconnect(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_record_pull_intent(uuid, uuid, uuid, text, text, date, date, text, integer, text, integer, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_complete_pull(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_complete_pending_pulls() TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_housekeeping() TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_provenance_past_retention(interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_connection_status(uuid) TO authenticated;
