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
--   qbo_pulls        append-only provenance, one row per imported report: what was asked of QuickBooks, which upload it became, and the SHA-256 of
--                    the raw response, of the canonical file and of the normalised accounting result. Plain uuid columns, no foreign keys (a
--                    record must outlive a deleted upload or workspace, and a foreign key to trial_balance_uploads makes uploads undeletable).
--
-- WHO MAY DO WHAT
--   Clients (anon, authenticated) have NO access to qbo_connections or qbo_oauth_states: not to read, not to write. Only the service role, through
--   the SECURITY DEFINER functions below, writes any of the three tables. The authority to connect, disconnect or record a pull is judged INSIDE
--   each function with public.workspace_authority_basis(actor, company, 'prepare_trial_balance'), exactly as other writes in this repository: no
--   function trusts a caller-supplied identity without that check, and an unknown company or a missing right is refused.
--   The workspace owner may read the company's provenance rows (qbo_pulls). Members see connection STATUS through qbo_connection_status(), which
--   returns no secret, no envelope and no key id.
--
-- ROTATION. Intuit's refresh tokens roll over. qbo_rotate_refresh_token is a compare-and-swap on the stored envelope: the caller names the envelope
--   it used, and the new one is stored only if that is still the current one. Two concurrent refreshes cannot both win, and the loser must re-read.
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
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disconnected_at timestamptz,
  CONSTRAINT chk_qbo_conn_envelope_shape CHECK (refresh_token_envelope IS NULL
    OR refresh_token_envelope ~ '^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  CONSTRAINT chk_qbo_conn_key_matches CHECK (refresh_token_envelope IS NULL
    OR envelope_key_id = split_part(refresh_token_envelope, '.', 2)),
  -- A token exists exactly while the connection is active; a dead or disconnected connection holds none.
  CONSTRAINT chk_qbo_conn_token_iff_active CHECK ((status = 'active') = (refresh_token_envelope IS NOT NULL AND envelope_key_id IS NOT NULL AND refresh_expires_at IS NOT NULL)),
  CONSTRAINT chk_qbo_conn_inactive_has_no_token CHECK (status = 'active' OR (refresh_token_envelope IS NULL AND envelope_key_id IS NULL AND refresh_expires_at IS NULL AND hard_expires_at IS NULL)),
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
CREATE OR REPLACE FUNCTION public.qbo_pulls_no_truncate()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: qbo_pulls is append-only. TRUNCATE is not permitted.' USING ERRCODE = '23001';
END;
$$;
REVOKE ALL ON FUNCTION public.qbo_pulls_no_truncate() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_qbo_pulls_no_truncate BEFORE TRUNCATE ON public.qbo_pulls
  FOR EACH STATEMENT EXECUTE FUNCTION public.qbo_pulls_no_truncate();

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
           refresh_expires_at = p_refresh_expires_at, hard_expires_at = p_hard_expires_at, connected_by_user_id = p_actor_user_id
     WHERE id = v_id;
  ELSE
    INSERT INTO public.qbo_connections (company_id, connected_by_user_id, realm_id, environment, status, refresh_token_envelope, envelope_key_id, refresh_expires_at, hard_expires_at)
    VALUES (p_company_id, p_actor_user_id, p_realm_id, p_environment, 'active', p_envelope, split_part(p_envelope, '.', 2), p_refresh_expires_at, p_hard_expires_at)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

-- Compare-and-swap rotation: stores the new envelope only if p_expected_envelope is still the stored one and the connection is active.
CREATE FUNCTION public.qbo_rotate_refresh_token(p_connection_id uuid, p_expected_envelope text, p_new_envelope text, p_refresh_expires_at timestamptz, p_hard_expires_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.qbo_connections SET refresh_token_envelope = p_new_envelope, envelope_key_id = split_part(p_new_envelope, '.', 2),
         refresh_expires_at = p_refresh_expires_at, hard_expires_at = p_hard_expires_at
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
  UPDATE public.qbo_connections SET status = 'reconnect_needed', refresh_token_envelope = NULL, envelope_key_id = NULL, refresh_expires_at = NULL, hard_expires_at = NULL
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
         disconnected_at = clock_timestamp()
   WHERE id = p_connection_id;
  RETURN 'disconnected';
END;
$$;

-- Records one import's provenance. Raises FORBIDDEN without the right; the table's checks refuse malformed values.
CREATE FUNCTION public.qbo_record_pull(p_company_id uuid, p_upload_id uuid, p_connection_id uuid, p_actor_user_id uuid, p_realm_id text, p_environment text,
                                       p_start_date date, p_end_date date, p_accounting_method text, p_minor_version integer, p_currency text,
                                       p_account_count integer, p_raw_sha256 text, p_canonical_sha256 text, p_result_sha256 text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_actor_user_id IS NULL OR public.workspace_authority_basis(p_actor_user_id, p_company_id, 'prepare_trial_balance') IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: no right to record a QuickBooks import in this workspace' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.qbo_pulls (company_id, upload_id, connection_id, actor_user_id, realm_id, environment, report, start_date, end_date, accounting_method,
                                minor_version, currency, account_count, raw_sha256, canonical_sha256, result_sha256)
  VALUES (p_company_id, p_upload_id, p_connection_id, p_actor_user_id, p_realm_id, p_environment, 'TrialBalance', p_start_date, p_end_date, p_accounting_method,
          p_minor_version, p_currency, p_account_count, p_raw_sha256, p_canonical_sha256, p_result_sha256)
  RETURNING id INTO v_id;
  RETURN v_id;
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
REVOKE ALL ON FUNCTION public.qbo_rotate_refresh_token(uuid, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_mark_reconnect_needed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_disconnect(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_record_pull(uuid, uuid, uuid, uuid, text, text, date, date, text, integer, text, integer, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qbo_connection_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qbo_start_oauth_state(text, uuid, uuid, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_consume_oauth_state(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_store_connection(uuid, uuid, text, text, text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_rotate_refresh_token(uuid, text, text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_mark_reconnect_needed(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_disconnect(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_record_pull(uuid, uuid, uuid, uuid, text, text, date, date, text, integer, text, integer, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qbo_connection_status(uuid) TO authenticated;
