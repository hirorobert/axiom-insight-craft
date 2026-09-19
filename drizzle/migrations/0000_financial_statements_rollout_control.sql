-- CFOClose financial-statements workspace — server-authoritative rollout control.
--
-- The workspace is DEFAULT DENIED. A company can use it only when (1) the
-- global kill switch is not engaged AND (2) the company has been explicitly
-- allowlisted by an operator. This state lives in the database, is enforced by
-- the persistence functions themselves (see 20260919110000), and can be read
-- by a signed-in company member through one function. There is no URL,
-- localStorage, VITE variable or other browser-side override, and no table
-- privilege for `anon`/`authenticated`: only the two operator functions below
-- (service_role only) can change it, and every change is written to an
-- append-only audit log with a mandatory reason.
--
-- THIS MIGRATION IS NOT APPLIED to any database by its author. Apply only through
-- the project's reviewed, managed process, after the disposable-database proof
-- (scripts/db-proof) passes and the release package checklist is complete.

-- ── state ───────────────────────────────────────────────────────────────────

CREATE TABLE public.financial_statements_rollout_state (
  singleton    BOOLEAN     NOT NULL DEFAULT true,
  kill_switch  BOOLEAN     NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fs_rollout_state_pk PRIMARY KEY (singleton),
  CONSTRAINT fs_rollout_state_singleton CHECK (singleton)
);

INSERT INTO public.financial_statements_rollout_state (singleton, kill_switch) VALUES (true, false);

CREATE TABLE public.financial_statements_rollout_companies (
  company_id  UUID        NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fs_rollout_companies_pk PRIMARY KEY (company_id),
  CONSTRAINT fk_fs_rollout_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE
);

-- Append-only. No FK on company_id: activation history must outlive a company.
CREATE TABLE public.financial_statements_rollout_audit (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  seq             BIGINT      GENERATED ALWAYS AS IDENTITY,
  scope           TEXT        NOT NULL,
  company_id      UUID        NULL,
  previous_state  BOOLEAN     NULL,
  new_state       BOOLEAN     NOT NULL,
  reason          TEXT        NOT NULL,
  -- A human/operator label recorded for the audit trail. It is a LABEL, never authority:
  -- the function is callable only by service_role.
  operator_label  TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fs_rollout_audit_pk PRIMARY KEY (id),
  CONSTRAINT chk_fs_rollout_audit_scope CHECK (scope IN ('COMPANY', 'KILL_SWITCH')),
  CONSTRAINT chk_fs_rollout_audit_company CHECK ((scope = 'COMPANY') = (company_id IS NOT NULL)),
  CONSTRAINT chk_fs_rollout_audit_reason CHECK (length(btrim(reason)) >= 8),
  CONSTRAINT chk_fs_rollout_audit_operator CHECK (length(btrim(operator_label)) >= 2)
);

CREATE OR REPLACE FUNCTION public.fs_rollout_audit_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: financial_statements_rollout_audit is append-only (% is not permitted)', TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_fs_rollout_audit_guard
  BEFORE UPDATE OR DELETE ON public.financial_statements_rollout_audit
  FOR EACH ROW EXECUTE FUNCTION public.fs_rollout_audit_guard();

-- No row-level access for any client role; operators reach the tables only through the functions.
ALTER TABLE public.financial_statements_rollout_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_statements_rollout_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_statements_rollout_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_statements_rollout_state FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.financial_statements_rollout_companies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.financial_statements_rollout_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.financial_statements_rollout_state TO service_role;
GRANT SELECT ON public.financial_statements_rollout_companies TO service_role;
GRANT SELECT ON public.financial_statements_rollout_audit TO service_role;

-- ── internal decision (not callable by any client role) ─────────────────────

CREATE OR REPLACE FUNCTION public.fs_rollout_allows(p_company_id UUID)
  RETURNS BOOLEAN
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  -- FAIL CLOSED: a missing state row or a missing company row is a denial, never an implicit allow (NULL would otherwise pass `NOT`).
  SELECT COALESCE((SELECT NOT s.kill_switch FROM public.financial_statements_rollout_state s WHERE s.singleton), false)
     AND COALESCE((SELECT c.enabled FROM public.financial_statements_rollout_companies c WHERE c.company_id = p_company_id), false);
$$;

REVOKE ALL ON FUNCTION public.fs_rollout_allows(UUID) FROM PUBLIC, anon, authenticated;

-- ── member-facing read: may this signed-in member use the workspace? ────────

CREATE OR REPLACE FUNCTION public.financial_statements_workspace_access(p_company_id UUID)
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_kill BOOLEAN;
  v_role TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;

  -- The caller's OWN role is returned so the UI can render a viewer read-only; it is a display hint only: every write is still refused server-side.
  SELECT fm.role INTO v_role FROM public.firm_members fm
   WHERE fm.user_id = v_uid AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL
   ORDER BY (fm.role = 'viewer'), fm.created_at LIMIT 1;  -- a non-viewer row wins, exactly as the actor resolver picks one
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('enabled', false, 'reason', 'NOT_A_MEMBER');
  END IF;

  SELECT s.kill_switch INTO v_kill FROM public.financial_statements_rollout_state s WHERE s.singleton;
  IF v_kill THEN
    RETURN jsonb_build_object('enabled', false, 'reason', 'KILL_SWITCH', 'role', v_role);
  END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN
    RETURN jsonb_build_object('enabled', false, 'reason', 'NOT_ALLOWLISTED', 'role', v_role);
  END IF;
  RETURN jsonb_build_object('enabled', true, 'reason', 'ENABLED', 'role', v_role);
END;
$$;

REVOKE ALL ON FUNCTION public.financial_statements_workspace_access(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_statements_workspace_access(UUID) TO authenticated;

-- ── operator controls (service_role only; every change audited) ─────────────

CREATE OR REPLACE FUNCTION public.fs_set_company_rollout(
  p_company_id     UUID,
  p_enabled        BOOLEAN,
  p_reason         TEXT,
  p_operator_label TEXT
)
  RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_previous BOOLEAN;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: operator controls require the service role' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: company % does not exist', p_company_id USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('financial_statements_rollout:' || p_company_id::text));
  SELECT c.enabled INTO v_previous FROM public.financial_statements_rollout_companies c WHERE c.company_id = p_company_id;

  INSERT INTO public.financial_statements_rollout_companies (company_id, enabled, updated_at)
       VALUES (p_company_id, p_enabled, now())
  ON CONFLICT (company_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();

  INSERT INTO public.financial_statements_rollout_audit (scope, company_id, previous_state, new_state, reason, operator_label)
       VALUES ('COMPANY', p_company_id, v_previous, p_enabled, p_reason, p_operator_label);
END;
$$;

CREATE OR REPLACE FUNCTION public.fs_set_kill_switch(
  p_engaged        BOOLEAN,
  p_reason         TEXT,
  p_operator_label TEXT
)
  RETURNS VOID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_previous BOOLEAN;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: operator controls require the service role' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('financial_statements_rollout:kill_switch'));
  SELECT s.kill_switch INTO v_previous FROM public.financial_statements_rollout_state s WHERE s.singleton;

  UPDATE public.financial_statements_rollout_state SET kill_switch = p_engaged, updated_at = now() WHERE singleton;

  INSERT INTO public.financial_statements_rollout_audit (scope, company_id, previous_state, new_state, reason, operator_label)
       VALUES ('KILL_SWITCH', NULL, v_previous, p_engaged, p_reason, p_operator_label);
END;
$$;

REVOKE ALL ON FUNCTION public.fs_set_company_rollout(UUID, BOOLEAN, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fs_set_kill_switch(BOOLEAN, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fs_set_company_rollout(UUID, BOOLEAN, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fs_set_kill_switch(BOOLEAN, TEXT, TEXT) TO service_role;