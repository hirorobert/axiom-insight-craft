-- ════════════════════════════════════════════════════════════════════════════
-- CFO Close: the OFFICIAL Reporting Pack is a server-bound, single-use, verifiable issuance. Forward-only; builds on
-- 20260925100000 (issue_reporting_pack) and 20260925110000 (named-user activity).
--
-- A downloadable deliverable is rendered in the browser from data the user can already see, so a client check can
-- never stop someone rebuilding a look-alike file from the preview. What this migration makes authoritative is the
-- OFFICIAL artifact:
--   1. issue_reporting_pack(workspace, period, kind, output_ref, request_id) creates an issuance bound to the signed-in
--      user, the workspace (and so its account), the fiscal period, the saved output / version it is issued for, the
--      export format (kind) and the entitlement at issue time, with a server-generated id and a short expiry.
--   2. consume_reporting_pack_issuance(...) seals it ONCE with the SHA-256 of the exact bytes produced, after
--      re-checking every binding and the entitlement at that moment (a downgrade between issue and generation is
--      refused). Other users, workspaces, periods, versions and formats are refused; an issuance cannot be replayed.
--   3. verify_reporting_pack(sha256) answers, for a workspace member, whether a file is an official issued pack.
--   4. Every issue, seal and refusal is an append-only audit event.
-- A file that was not sealed this way is not an official Reporting Pack, whatever it looks like.
-- ════════════════════════════════════════════════════════════════════════════

DO $refuse$
BEGIN
  IF to_regclass('public.reporting_pack_issuances') IS NULL OR to_regproc('public.named_user_access_active') IS NULL THEN
    RAISE EXCEPTION 'issuance-binding migration refused: 20260925100000 / 20260925110000 are not applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.reporting_pack_issuance_events') IS NOT NULL THEN
    RAISE EXCEPTION 'issuance-binding migration refused: already applied. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
END
$refuse$;

SET search_path TO public, pg_catalog;

-- ── 1. Issuance bindings, expiry and single-use seal ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reporting_pack_issuance_ttl()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$ SELECT interval '10 minutes' $$;

ALTER TABLE public.reporting_pack_issuances DISABLE TRIGGER trg_rpi_immutable;
ALTER TABLE public.reporting_pack_issuances
  ADD COLUMN output_ref         TEXT        NULL,
  ADD COLUMN expires_at         TIMESTAMPTZ NULL,
  ADD COLUMN consumed_at        TIMESTAMPTZ NULL,
  ADD COLUMN content_sha256     TEXT        NULL,
  ADD COLUMN consumed_plan_code TEXT        NULL;
-- Any issuance created before this migration is already expired and can never be sealed.
UPDATE public.reporting_pack_issuances SET expires_at = issued_at WHERE expires_at IS NULL;
ALTER TABLE public.reporting_pack_issuances
  ALTER COLUMN expires_at SET NOT NULL,
  DROP CONSTRAINT chk_rpi_kind,
  ADD CONSTRAINT chk_rpi_kind CHECK (pack_kind IN ('financial_statements_pdf', 'financial_statements_spreadsheet', 'financial_statements_data', 'filing_pack', 'client_pack', 'board_pack', 'management_letter', 'disclosure_notes', 'tax_computation', 'tax_workpaper')),
  ADD CONSTRAINT chk_rpi_output_ref CHECK (output_ref IS NULL OR (length(output_ref) BETWEEN 1 AND 200 AND output_ref !~ '[[:cntrl:]]')),
  ADD CONSTRAINT chk_rpi_seal CHECK ((consumed_at IS NULL) = (content_sha256 IS NULL) AND (consumed_at IS NULL) = (consumed_plan_code IS NULL)),
  ADD CONSTRAINT chk_rpi_sha256 CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE public.reporting_pack_issuances ENABLE TRIGGER trg_rpi_immutable;
CREATE INDEX idx_rpi_content_sha256 ON public.reporting_pack_issuances (content_sha256) WHERE content_sha256 IS NOT NULL;

-- Immutable except ONE seal (consumed_at, content_sha256, consumed_plan_code from NULL); never deleted.
CREATE OR REPLACE FUNCTION public.reporting_pack_issuances_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
     AND NEW.id = OLD.id AND NEW.company_id = OLD.company_id AND NEW.period_year = OLD.period_year AND NEW.pack_kind = OLD.pack_kind
     AND NEW.request_id = OLD.request_id AND NEW.issued_by = OLD.issued_by AND NEW.plan_code IS NOT DISTINCT FROM OLD.plan_code
     AND NEW.issued_at = OLD.issued_at AND NEW.output_ref IS NOT DISTINCT FROM OLD.output_ref AND NEW.expires_at = OLD.expires_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Iron Dome: reporting_pack_issuances is append-only except for a single seal (% refused).', TG_OP USING ERRCODE = 'P0001';
END;
$$;

-- ── 2. Append-only audit of every issue, seal and refusal ────────────────────────────────────
CREATE TABLE public.reporting_pack_issuance_events (
  id           UUID        NOT NULL DEFAULT gen_random_uuid(),
  issuance_id  UUID        NULL,
  company_id   UUID        NULL,
  actor_user_id UUID       NULL,
  event        TEXT        NOT NULL,
  detail       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reporting_pack_issuance_events_pk PRIMARY KEY (id),
  CONSTRAINT chk_rpie_event CHECK (event IN ('ISSUED', 'SEALED', 'REFUSED'))
);
CREATE INDEX idx_rpie_issuance ON public.reporting_pack_issuance_events (issuance_id, occurred_at);
ALTER TABLE public.reporting_pack_issuance_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rpie_select_workspace" ON public.reporting_pack_issuance_events FOR SELECT TO authenticated
  USING (company_id IS NOT NULL AND public.can_access_workspace(company_id));
REVOKE ALL ON public.reporting_pack_issuance_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.reporting_pack_issuance_events TO authenticated, service_role;
-- Issuances are written only by issue_reporting_pack / consume_reporting_pack_issuance (definer): nobody else,
-- including the service role, writes them directly.
REVOKE ALL ON public.reporting_pack_issuances FROM service_role;
GRANT SELECT ON public.reporting_pack_issuances TO service_role;
CREATE OR REPLACE FUNCTION public.reporting_pack_issuance_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: reporting_pack_issuance_events is append-only (% refused).', TG_OP USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER trg_rpie_immutable BEFORE UPDATE OR DELETE ON public.reporting_pack_issuance_events
  FOR EACH ROW EXECUTE FUNCTION public.reporting_pack_issuance_events_immutable();
CREATE TRIGGER trg_rpie_no_truncate BEFORE TRUNCATE ON public.reporting_pack_issuance_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reporting_pack_issuance_events_immutable();

-- A saved financial-statements version is named "fs-report:<report_id>:v<version>"; it must exist for the workspace
-- and period. Any other output reference is recorded as given (bound, not interpreted).
CREATE OR REPLACE FUNCTION public._reporting_pack_output_ref_valid(p_company_id UUID, p_period_year INTEGER, p_kind TEXT, p_output_ref TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  m TEXT[];
BEGIN
  IF p_output_ref IS NULL OR length(p_output_ref) NOT BETWEEN 1 AND 200 OR p_output_ref ~ '[[:cntrl:]]' THEN
    RETURN false;
  END IF;
  m := regexp_match(p_output_ref, '^fs-report:([^:]{1,120}):v([0-9]{1,6})$');
  IF m IS NULL THEN
    RETURN p_output_ref !~ '^fs-report:';
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.financial_statement_reports r
                  WHERE r.report_id = m[1] AND r.report_version = m[2]::integer AND r.company_id = p_company_id AND r.period_year = p_period_year);
END;
$$;

-- ── 3. Issue (supersedes the 4-argument 20260925100000 version) ───────────────────────────────
-- Outcomes: issued | already_issued | request_conflict | entitlement_required | workspace_access_denied |
--           unauthenticated | invalid_request
DROP FUNCTION public.issue_reporting_pack(UUID, INTEGER, TEXT, UUID);
CREATE OR REPLACE FUNCTION public.issue_reporting_pack(
  p_company_id UUID, p_period_year INTEGER, p_pack_kind TEXT, p_output_ref TEXT, p_request_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user  UUID := auth.uid();
  v_auth  JSONB;
  v_row   public.reporting_pack_issuances%ROWTYPE;
BEGIN
  IF p_request_id IS NULL OR p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100
     OR p_pack_kind IS NULL OR p_pack_kind NOT IN ('financial_statements_pdf', 'financial_statements_spreadsheet', 'financial_statements_data', 'filing_pack', 'client_pack', 'board_pack', 'management_letter', 'disclosure_notes', 'tax_computation', 'tax_workpaper')
     OR NOT public._reporting_pack_output_ref_valid(p_company_id, p_period_year, p_pack_kind, p_output_ref) THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  v_auth := public._authorize_paid_action(v_user, p_company_id, 'REPORTING_PACK_EXPORT');
  IF NOT (v_auth->>'allowed')::boolean THEN
    IF v_user IS NOT NULL AND v_auth->>'code' = 'ENTITLEMENT_REQUIRED' THEN
      INSERT INTO public.reporting_pack_issuance_events (company_id, actor_user_id, event, detail)
      VALUES (p_company_id, v_user, 'REFUSED', jsonb_build_object('stage', 'issue', 'code', 'ENTITLEMENT_REQUIRED', 'pack_kind', p_pack_kind));
    END IF;
    RETURN jsonb_build_object('outcome', lower(v_auth->>'code'), 'capability', 'REPORTING_PACK_EXPORT', 'required_plan', v_auth->>'required_plan');
  END IF;
  SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE company_id = p_company_id AND issued_by = v_user AND request_id = p_request_id;
  IF v_row.id IS NOT NULL THEN
    IF v_row.period_year <> p_period_year OR v_row.pack_kind <> p_pack_kind OR v_row.output_ref IS DISTINCT FROM p_output_ref THEN
      RETURN jsonb_build_object('outcome', 'request_conflict');
    END IF;
    RETURN jsonb_build_object('outcome', 'already_issued', 'issuance_id', v_row.id, 'expires_at', v_row.expires_at, 'sealed', v_row.consumed_at IS NOT NULL);
  END IF;
  BEGIN
    INSERT INTO public.reporting_pack_issuances (company_id, period_year, pack_kind, request_id, issued_by, plan_code, output_ref, expires_at)
    VALUES (p_company_id, p_period_year, p_pack_kind, p_request_id, v_user, v_auth->>'plan_code', p_output_ref, now() + public.reporting_pack_issuance_ttl())
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE company_id = p_company_id AND issued_by = v_user AND request_id = p_request_id;
    RETURN jsonb_build_object('outcome', 'already_issued', 'issuance_id', v_row.id, 'expires_at', v_row.expires_at, 'sealed', v_row.consumed_at IS NOT NULL);
  END;
  INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail)
  VALUES (v_row.id, p_company_id, v_user, 'ISSUED', jsonb_build_object('pack_kind', p_pack_kind, 'period_year', p_period_year, 'output_ref', p_output_ref, 'plan_code', v_row.plan_code));
  RETURN jsonb_build_object('outcome', 'issued', 'issuance_id', v_row.id, 'expires_at', v_row.expires_at);
END;
$$;

-- ── 4. Seal once, with the exact bytes' SHA-256 ───────────────────────────────────────────────
-- Outcomes: sealed | not_found (unknown, or issued to someone else) | binding_mismatch | already_sealed | expired |
--           entitlement_required | workspace_access_denied | invalid_request | unauthenticated
CREATE OR REPLACE FUNCTION public.consume_reporting_pack_issuance(
  p_issuance_id UUID, p_company_id UUID, p_period_year INTEGER, p_pack_kind TEXT, p_output_ref TEXT, p_content_sha256 TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user UUID := auth.uid();
  v_row  public.reporting_pack_issuances%ROWTYPE;
  v_auth JSONB;
  v_code TEXT;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unauthenticated');
  END IF;
  IF p_issuance_id IS NULL OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  SELECT * INTO v_row FROM public.reporting_pack_issuances WHERE id = p_issuance_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.issued_by <> v_user THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_row.company_id IS DISTINCT FROM p_company_id OR v_row.period_year IS DISTINCT FROM p_period_year
     OR v_row.pack_kind IS DISTINCT FROM p_pack_kind OR v_row.output_ref IS DISTINCT FROM p_output_ref THEN
    v_code := 'binding_mismatch';
  ELSIF v_row.consumed_at IS NOT NULL THEN
    v_code := 'already_sealed';
  ELSIF v_row.expires_at <= now() THEN
    v_code := 'expired';
  ELSE
    v_auth := public._authorize_paid_action(v_user, v_row.company_id, 'REPORTING_PACK_EXPORT');
    IF NOT (v_auth->>'allowed')::boolean THEN
      v_code := lower(v_auth->>'code');
    END IF;
  END IF;
  IF v_code IS NOT NULL THEN
    INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail)
    VALUES (v_row.id, v_row.company_id, v_user, 'REFUSED', jsonb_build_object('stage', 'seal', 'code', upper(v_code)));
    RETURN jsonb_build_object('outcome', v_code);
  END IF;
  UPDATE public.reporting_pack_issuances
     SET consumed_at = now(), content_sha256 = p_content_sha256, consumed_plan_code = v_auth->>'plan_code'
   WHERE id = v_row.id;
  INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail)
  VALUES (v_row.id, v_row.company_id, v_user, 'SEALED', jsonb_build_object('content_sha256', p_content_sha256, 'pack_kind', v_row.pack_kind));
  RETURN jsonb_build_object('outcome', 'sealed', 'issuance_id', v_row.id);
END;
$$;

-- ── 5. Verification: is this file an official issued pack? (for anyone with access to its workspace) ──
CREATE OR REPLACE FUNCTION public.verify_reporting_pack(p_content_sha256 TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.reporting_pack_issuances%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('official', false);
  END IF;
  SELECT i.* INTO v_row FROM public.reporting_pack_issuances i
   WHERE i.content_sha256 = p_content_sha256 AND i.consumed_at IS NOT NULL AND public.can_access_workspace(i.company_id)
   ORDER BY i.consumed_at DESC LIMIT 1;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('official', false);
  END IF;
  RETURN jsonb_build_object('official', true, 'issuance_id', v_row.id, 'company_id', v_row.company_id, 'period_year', v_row.period_year,
    'pack_kind', v_row.pack_kind, 'output_ref', v_row.output_ref, 'issued_at', v_row.issued_at, 'sealed_at', v_row.consumed_at);
END;
$$;

-- ── 6. Privileges ──────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.reporting_pack_issuance_ttl() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reporting_pack_issuance_ttl() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public._reporting_pack_output_ref_valid(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reporting_pack_issuances_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reporting_pack_issuance_events_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.issue_reporting_pack(UUID, INTEGER, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_reporting_pack(UUID, INTEGER, TEXT, TEXT, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.consume_reporting_pack_issuance(UUID, UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_reporting_pack_issuance(UUID, UUID, INTEGER, TEXT, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.verify_reporting_pack(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_reporting_pack(TEXT) TO authenticated;

-- ── 7. Durable deployment approvals (the Free-retirement production interlock of 20260925130000) ──────────────
-- 20260925130000 turns every open Free licence into EXPIRED_READ_ONLY. It runs only against a recorded, unexpired,
-- unconsumed approval for THIS environment whose inventory matches the licences it would end, and it consumes that
-- approval in the same statement (single use). An approval is recorded by a commercial administrator through
-- admin_record_deployment_approval (inventory count, notification reference, activation path) and is append-only.
-- Nothing reads a session or database setting: the interlock cannot be satisfied by a GUC or a role default.
-- Direct INSERT / UPDATE / DELETE is refused for every application role (anon, authenticated, service_role hold
-- SELECT at most); a row can be created only by admin_record_deployment_approval, whose approver must be an active
-- commercial administrator (foreign key to commercial_admins, re-checked by the insert guard) and the caller itself.
-- Scope of this control: a true database superuser (or the table owner acting outside the function) stands outside
-- every application-level control — it can disable triggers or replicate rows. That boundary is operational
-- (who holds superuser credentials on the hosted project), not something a migration can enforce.
CREATE OR REPLACE FUNCTION public._environment_fingerprint()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_sys TEXT := '';
BEGIN
  BEGIN
    SELECT system_identifier::text INTO v_sys FROM pg_control_system();
  EXCEPTION WHEN insufficient_privilege OR undefined_function THEN
    v_sys := '';
  END;
  RETURN md5(COALESCE(v_sys, '') || ':' || (SELECT d.oid::text FROM pg_database d WHERE d.datname = current_database()) || ':' || current_database());
END;
$$;

-- The open Free licences a retirement would end, as a count and a digest of their ids (an approval must match both).
CREATE OR REPLACE FUNCTION public._free_plan_inventory()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('open_free_licences', count(*), 'inventory_digest', md5(COALESCE(string_agg(cl.id::text, ',' ORDER BY cl.id), '')))
    FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE cp.code = 'FREE' AND cl.status IN ('PENDING', 'ACTIVE', 'GRACE');
$$;

CREATE TABLE public.deployment_approvals (
  id                      UUID        NOT NULL DEFAULT gen_random_uuid(),
  purpose                 TEXT        NOT NULL,
  environment_fingerprint TEXT        NOT NULL,
  environment_label       TEXT        NOT NULL,
  evidence                JSONB       NOT NULL,
  approved_by             UUID        NOT NULL,
  approved_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ NOT NULL,
  consumed_at             TIMESTAMPTZ NULL,
  consumed_by             TEXT        NULL,
  CONSTRAINT deployment_approvals_pk PRIMARY KEY (id),
  CONSTRAINT chk_da_purpose CHECK (purpose IN ('FREE_PLAN_RETIREMENT')),
  CONSTRAINT chk_da_label CHECK (length(environment_label) BETWEEN 1 AND 64 AND environment_label !~ '[[:cntrl:]]'),
  CONSTRAINT chk_da_window CHECK (expires_at > approved_at AND expires_at <= approved_at + interval '72 hours'),
  CONSTRAINT chk_da_consumed CHECK ((consumed_at IS NULL) = (consumed_by IS NULL)),
  CONSTRAINT fk_da_approved_by FOREIGN KEY (approved_by) REFERENCES public.commercial_admins(user_id) ON DELETE RESTRICT
);
-- Creation only through admin_record_deployment_approval: it marks its own transaction immediately before its INSERT
-- (and clears the mark after). The approver must be the calling, ACTIVE commercial administrator; the row is created
-- unconsumed, approved now, for this environment. (A superuser can forge the mark: see the scope note above.)
CREATE OR REPLACE FUNCTION public.deployment_approvals_insert_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF COALESCE(current_setting('cfoclose.deployment_approval_writer', true), '') IS DISTINCT FROM txid_current()::text THEN
    RAISE EXCEPTION 'deployment approvals are recorded only through admin_record_deployment_approval' USING ERRCODE = '42501';
  END IF;
  IF NEW.approved_by IS DISTINCT FROM auth.uid()
     OR NOT EXISTS (SELECT 1 FROM public.commercial_admins a WHERE a.user_id = NEW.approved_by AND a.active) THEN
    RAISE EXCEPTION 'the approver must be the calling, active commercial administrator' USING ERRCODE = '42501';
  END IF;
  IF NEW.consumed_at IS NOT NULL OR NEW.consumed_by IS NOT NULL
     OR NEW.environment_fingerprint IS DISTINCT FROM public._environment_fingerprint() THEN
    RAISE EXCEPTION 'a deployment approval is created unconsumed, for this environment' USING ERRCODE = '42501';
  END IF;
  NEW.approved_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_da_insert_guard BEFORE INSERT ON public.deployment_approvals FOR EACH ROW EXECUTE FUNCTION public.deployment_approvals_insert_guard();
CREATE OR REPLACE FUNCTION public.deployment_approvals_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
     AND (to_jsonb(NEW) - 'consumed_at' - 'consumed_by') = (to_jsonb(OLD) - 'consumed_at' - 'consumed_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'deployment_approvals is append-only (an approval is consumed once, never edited or deleted)' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER trg_da_guard BEFORE UPDATE OR DELETE ON public.deployment_approvals FOR EACH ROW EXECUTE FUNCTION public.deployment_approvals_guard();
CREATE TRIGGER trg_da_no_truncate BEFORE TRUNCATE ON public.deployment_approvals FOR EACH STATEMENT EXECUTE FUNCTION public.deployment_approvals_guard();
ALTER TABLE public.deployment_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "da_select_commercial_admin" ON public.deployment_approvals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.commercial_admins a WHERE a.user_id = auth.uid() AND a.active));
REVOKE ALL ON public.deployment_approvals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.deployment_approvals TO authenticated;

-- A commercial administrator records the approval after the release sequence: the inventory they reviewed must be the
-- current one, a notification reference and the activation path are required, and it expires within 72 hours.
CREATE OR REPLACE FUNCTION public.admin_record_deployment_approval(
  p_purpose TEXT, p_environment_label TEXT, p_expected_open_free_licences INTEGER, p_notification_reference TEXT,
  p_activation_path TEXT, p_valid_hours INTEGER DEFAULT 24)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_inv JSONB := public._free_plan_inventory();
  v_id  UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_uid AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_purpose IS DISTINCT FROM 'FREE_PLAN_RETIREMENT' THEN RAISE EXCEPTION 'UNKNOWN_PURPOSE' USING ERRCODE = '22023'; END IF;
  IF p_activation_path IS NULL OR p_activation_path NOT IN ('CHECKOUT', 'MANUAL_ADMIN') THEN RAISE EXCEPTION 'ACTIVATION_PATH_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_notification_reference IS NULL OR length(btrim(p_notification_reference)) NOT BETWEEN 3 AND 200 THEN
    RAISE EXCEPTION 'NOTIFICATION_REFERENCE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_expected_open_free_licences IS DISTINCT FROM (v_inv->>'open_free_licences')::integer THEN
    RAISE EXCEPTION 'INVENTORY_MISMATCH: the reviewed inventory is not the current one' USING ERRCODE = '22023';
  END IF;
  IF p_valid_hours IS NULL OR p_valid_hours NOT BETWEEN 1 AND 72 THEN RAISE EXCEPTION 'INVALID_VALIDITY' USING ERRCODE = '22023'; END IF;
  PERFORM set_config('cfoclose.deployment_approval_writer', txid_current()::text, true);
  INSERT INTO public.deployment_approvals (purpose, environment_fingerprint, environment_label, evidence, approved_by, expires_at)
  VALUES (p_purpose, public._environment_fingerprint(), btrim(p_environment_label),
          v_inv || jsonb_build_object('notification_reference', btrim(p_notification_reference), 'activation_path', p_activation_path),
          v_uid, now() + make_interval(hours => p_valid_hours))
  RETURNING id INTO v_id;
  PERFORM set_config('cfoclose.deployment_approval_writer', '', true);
  RETURN jsonb_build_object('approval_id', v_id, 'inventory', v_inv);
END;
$$;
REVOKE ALL ON FUNCTION public._environment_fingerprint() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._free_plan_inventory() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deployment_approvals_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deployment_approvals_insert_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_record_deployment_approval(TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_record_deployment_approval(TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER) TO authenticated;

-- ── Rollback (NOT executed; for reference only) ─────────────────────────────────────────────
-- Issuances and events are records: never delete them. Restore 20260925100000's issue_reporting_pack(4 args) and
-- immutable trigger function; drop consume_/verify_ and the ttl/ref helpers. The added columns may stay.
