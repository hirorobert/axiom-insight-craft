-- 20261004100000_reconciliation_server_authority.sql
--
-- Reconciliation readiness becomes a SERVER fact. Found by the disposable-PostgreSQL reconciliation proof:
--   · safisha_resolve_exception marked a reconciliation and its upload 'clean' while an exception was only ESCALATED
--     (and treated a rejected non-investigate exception as resolved);
--   · the account owner could set trial_balance_uploads.safisha_status = 'clean' directly;
--   · the owner and firm members could rewrite safisha_reconciliations.status / matched_count / total_tb_lines directly;
--   · maono_check_safisha_gate trusted the raw 'clean' status.
-- The SAFISHA functions write with the caller's JWT, so at the database their writes were indistinguishable from a
-- forged direct write. This migration moves the authority into the database:
--
--   1. Completeness is computed from server rows, never from an editable count:
--        safisha_reconciliation_complete(recon) — at least one trial-balance line; every trial-balance line either has no
--        exception (matched) or only APPROVED exceptions; no exception pending, escalated or rejected.
--   2. safisha_record_match_result(recon, actor) — NEW, service-role only, SECURITY DEFINER: the one way the matcher
--      records a result. Authorizes the actor exactly like safisha_resolve_exception (current plan + prepare_close),
--      DERIVES total and matched lines from safisha_transactions / safisha_exceptions, and sets 'clean' (reconciliation
--      and upload) only when complete; otherwise 'needs_review'.
--   3. safisha_resolve_exception — its current definition with ONE change: when nothing is pending, the reconciliation
--      becomes 'blocked' for a rejected investigate exception (unchanged), 'clean' ONLY when complete, and otherwise stays
--      'needs_review' (escalated and rejected exceptions stay unresolved).
--   4. Guards for direct writes by client roles (authenticated / anon), placed after the existing reconciliation write
--      wall: a client may create a reconciliation only as 'processing' with zero counts, may never change its counts,
--      sealing or completion, and may move its status only back to 'processing' / 'needs_review'; a client may never set
--      an upload's safisha_status to 'clean' or 'blocked'. For EVERY role, 'clean' (reconciliation or upload) is
--      accepted only when the reconciliation is complete.
--   5. maono_check_safisha_gate — an upload is unblocked only when 'clean' AND its latest reconciliation is complete.
--
-- Preserved: upload registration and every other upload write; creating a reconciliation, ingesting transactions,
-- categorizing and scoring (safisha-ingest / -categorize / -score keep their client writes); reviewer resolution through
-- safisha_resolve_exception (called by safisha-resolve with the service role after verifying the reviewer's JWT).
-- No existing row is read, changed or removed. Forward-only and replay-safe (CREATE OR REPLACE; triggers dropped and
-- recreated by name).

-- ── 1. Completeness, from server rows ───────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.safisha_reconciliation_coverage(p_recon_id uuid)
  RETURNS TABLE(total_tb_lines integer, matched_tb_lines integer, approved_tb_lines integer,
                pending integer, escalated integer, rejected integer, complete boolean)
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  WITH tb AS (
    SELECT t.id FROM public.safisha_transactions t WHERE t.reconciliation_id = p_recon_id AND t.source_id = 'tb'
  ), x AS (
    SELECT e.tb_txn_id, e.reviewer_action FROM public.safisha_exceptions e WHERE e.reconciliation_id = p_recon_id
  ), per_line AS (
    SELECT tb.id,
           count(x.*)                                          AS exceptions,
           count(x.*) FILTER (WHERE x.reviewer_action <> 'approved') AS unresolved
      FROM tb LEFT JOIN x ON x.tb_txn_id = tb.id
     GROUP BY tb.id
  ), counts AS (
    SELECT (SELECT count(*) FROM per_line)::integer                                        AS total,
           (SELECT count(*) FROM per_line WHERE exceptions = 0)::integer                   AS matched,
           (SELECT count(*) FROM per_line WHERE exceptions > 0 AND unresolved = 0)::integer AS approved,
           (SELECT count(*) FROM x WHERE reviewer_action = 'pending')::integer             AS pending,
           (SELECT count(*) FROM x WHERE reviewer_action = 'escalated')::integer           AS escalated,
           (SELECT count(*) FROM x WHERE reviewer_action = 'rejected')::integer            AS rejected
  )
  SELECT total, matched, approved, pending, escalated, rejected,
         (total > 0 AND pending = 0 AND escalated = 0 AND rejected = 0 AND matched + approved = total)
    FROM counts;
$$;

CREATE OR REPLACE FUNCTION public.safisha_reconciliation_complete(p_recon_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE((SELECT c.complete FROM public.safisha_reconciliation_coverage(p_recon_id) c), false);
$$;

-- The upload's LATEST reconciliation is 'clean' and complete.
CREATE OR REPLACE FUNCTION public.safisha_upload_reconciliation_complete(p_upload_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE((
    SELECT r.status = 'clean' AND public.safisha_reconciliation_complete(r.id)
      FROM public.safisha_reconciliations r
     WHERE r.tb_upload_id = p_upload_id
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 1), false);
$$;

-- ── 2. The matcher's result, recorded by the database ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.safisha_record_match_result(p_recon_id uuid, p_actor uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_recon   public.safisha_reconciliations%ROWTYPE;
  v_company uuid;
  v_account uuid;
  v_cov     record;
  v_status  text;
BEGIN
  SELECT * INTO v_recon FROM public.safisha_reconciliations WHERE id = p_recon_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECONCILIATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_recon.sealed THEN
    RAISE EXCEPTION 'RECONCILIATION_SEALED' USING ERRCODE = '55000';
  END IF;
  -- The same authority as safisha_resolve_exception: a current plan, and prepare_close in this workspace (a personal,
  -- company-less reconciliation: the actor must be its owner). Checked before anything is written.
  SELECT u.company_id, COALESCE(c.user_id, u.user_id, v_recon.client_id) INTO v_company, v_account
    FROM public.trial_balance_uploads u LEFT JOIN public.companies c ON c.id = u.company_id
   WHERE u.id = v_recon.tb_upload_id;
  IF NOT public._account_has_current_plan(v_account) THEN
    RAISE EXCEPTION 'RECONCILIATION_READ_ONLY' USING ERRCODE = 'PT402', DETAIL = 'CLOSE_ASSURANCE', HINT = 'NO_PLAN';
  END IF;
  IF p_actor IS NULL
     OR (v_company IS NOT NULL AND NOT public.workspace_capability_allowed(v_company, p_actor, 'prepare_close'))
     OR (v_company IS NULL AND p_actor IS DISTINCT FROM v_account) THEN
    RAISE EXCEPTION 'CAPABILITY_REQUIRED: recording a reconciliation needs prepare_close in this workspace' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_cov FROM public.safisha_reconciliation_coverage(p_recon_id);
  v_status := CASE WHEN v_cov.complete THEN 'clean' ELSE 'needs_review' END;

  UPDATE public.safisha_reconciliations SET
    total_tb_lines  = v_cov.total_tb_lines,
    matched_count   = v_cov.matched_tb_lines,
    exception_count = (SELECT count(*)::integer FROM public.safisha_exceptions WHERE reconciliation_id = p_recon_id),
    status          = v_status,
    completed_at    = CASE WHEN v_cov.complete THEN now() ELSE NULL END
  WHERE id = p_recon_id;

  UPDATE public.trial_balance_uploads
     SET safisha_status = CASE WHEN v_cov.complete THEN 'clean' ELSE 'needs_review' END
   WHERE id = v_recon.tb_upload_id;

  RETURN jsonb_build_object(
    'reconciliation_id', p_recon_id, 'status', v_status,
    'total_tb_lines', v_cov.total_tb_lines, 'matched_tb_lines', v_cov.matched_tb_lines,
    'approved_tb_lines', v_cov.approved_tb_lines, 'pending', v_cov.pending, 'escalated', v_cov.escalated, 'rejected', v_cov.rejected);
END;
$$;

-- ── 3. The resolver: escalated / rejected stay unresolved; 'clean' only when complete ───────────────────────────────
-- Identical to its 20260925140000 definition except the block after "IF v_remaining = 0".
CREATE OR REPLACE FUNCTION public.safisha_resolve_exception(p_exception_id uuid, p_reviewer_id uuid, p_action text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_exception  safisha_exceptions%ROWTYPE;
  v_recon      safisha_reconciliations%ROWTYPE;
  v_remaining  INTEGER;
  v_member_id  UUID;
  v_company    UUID;
  v_account    UUID;
BEGIN
  IF p_action NOT IN ('approved','rejected','escalated') THEN
    RAISE EXCEPTION 'Invalid reviewer_action: %. Must be approved|rejected|escalated', p_action;
  END IF;

  SELECT * INTO v_exception FROM safisha_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exception % not found', p_exception_id;
  END IF;
  -- 20260925140000: the reviewer must hold prepare_close in this workspace and its account must have a current plan
  -- (a personal, company-less reconciliation: the reviewer must be its owner). Checked before anything is written.
  SELECT u.company_id, COALESCE(c.user_id, u.user_id, r.client_id) INTO v_company, v_account
    FROM public.safisha_reconciliations r
    JOIN public.trial_balance_uploads u ON u.id = r.tb_upload_id
    LEFT JOIN public.companies c ON c.id = u.company_id
   WHERE r.id = v_exception.reconciliation_id;
  IF NOT public._account_has_current_plan(v_account) THEN
    RAISE EXCEPTION 'RECONCILIATION_READ_ONLY' USING ERRCODE = 'PT402', DETAIL = 'CLOSE_ASSURANCE', HINT = 'NO_PLAN';
  END IF;
  IF (v_company IS NOT NULL AND NOT public.workspace_capability_allowed(v_company, p_reviewer_id, 'prepare_close'))
     OR (v_company IS NULL AND p_reviewer_id IS DISTINCT FROM v_account) THEN
    RAISE EXCEPTION 'CAPABILITY_REQUIRED: resolving a reconciliation exception needs prepare_close in this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_exception.reviewer_action <> 'pending' THEN
    RAISE EXCEPTION 'Exception % is already resolved (%)', p_exception_id, v_exception.reviewer_action;
  END IF;

  -- v2.3 Phase 1: resolve firm_members.id via reconciliation → upload → company
  SELECT fm.id INTO v_member_id
  FROM public.firm_members fm
  JOIN public.trial_balance_uploads tbu ON tbu.company_id = fm.company_id
  JOIN public.safisha_reconciliations sr
    ON sr.tb_upload_id = tbu.id AND sr.id = v_exception.reconciliation_id
  WHERE fm.user_id = p_reviewer_id
  LIMIT 1;
  -- v_member_id may be NULL if reviewer has no firm membership for this company
  -- (e.g. service_role pipeline call). This is intentional — NULL is acceptable.

  PERFORM set_config('safisha.resolve_authorized', 'true', TRUE);

  UPDATE safisha_exceptions SET
    reviewer_action    = p_action,
    reviewer_id        = p_reviewer_id,   -- legacy: auth.users.id
    reviewer_member_id = v_member_id,     -- v2.3: firm_members.id (nullable)
    reviewer_note      = p_note,
    resolved_at        = now()
  WHERE id = p_exception_id;

  PERFORM set_config('safisha.resolve_authorized', 'false', TRUE);

  SELECT COUNT(*) INTO v_remaining
  FROM safisha_exceptions
  WHERE reconciliation_id = v_exception.reconciliation_id
    AND reviewer_action = 'pending';

  IF v_remaining = 0 THEN
    DECLARE
      v_blocked INTEGER;
    BEGIN
      SELECT COUNT(*) INTO v_blocked
      FROM safisha_exceptions
      WHERE reconciliation_id = v_exception.reconciliation_id
        AND category = 'investigate'
        AND reviewer_action = 'rejected';
      IF v_blocked > 0 THEN
        UPDATE safisha_reconciliations SET status = 'blocked' WHERE id = v_exception.reconciliation_id;
        UPDATE trial_balance_uploads SET safisha_status = 'blocked' WHERE id = (
          SELECT tb_upload_id FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id
        );
      ELSIF public.safisha_reconciliation_complete(v_exception.reconciliation_id) THEN
        -- 20261004100000: 'clean' only when every trial-balance line is matched or approved and nothing is escalated
        -- or rejected (an escalated or rejected exception is not a resolution).
        UPDATE safisha_reconciliations SET
          status       = 'clean',
          completed_at = now()
        WHERE id = v_exception.reconciliation_id;
        UPDATE trial_balance_uploads SET safisha_status = 'clean' WHERE id = (
          SELECT tb_upload_id FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id
        );
      ELSE
        UPDATE safisha_reconciliations SET status = 'needs_review' WHERE id = v_exception.reconciliation_id;
        UPDATE trial_balance_uploads SET safisha_status = 'needs_review' WHERE id = (
          SELECT tb_upload_id FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id
        );
      END IF;
    END;
  END IF;

  -- Append-only audit log write (INSERT only — trigger blocks UPDATE/DELETE)
  INSERT INTO safisha_audit_log (
    exception_id, reconciliation_id,
    reviewer_id,         -- legacy: auth.users.id
    reviewer_member_id,  -- v2.3: firm_members.id
    action, note
  ) VALUES (
    p_exception_id, v_exception.reconciliation_id,
    p_reviewer_id,
    v_member_id,
    p_action, p_note
  );

  RETURN jsonb_build_object(
    'exception_id',   p_exception_id,
    'action',         p_action,
    'remaining',      v_remaining,
    'recon_status',   (SELECT status FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id)
  );
END;
$function$;

-- ── 4. Guards: client roles cannot forge; nobody records an incomplete 'clean' ──────────────────────────────────────
-- SECURITY INVOKER on purpose: current_user is the writer's role ('authenticated' / 'anon' for a client, 'service_role'
-- for an edge function's service client, the function owner inside a SECURITY DEFINER function).
CREATE OR REPLACE FUNCTION public.safisha_reconciliation_authority()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status IS DISTINCT FROM 'processing' OR COALESCE(NEW.matched_count, 0) <> 0 OR COALESCE(NEW.exception_count, 0) <> 0
         OR COALESCE(NEW.total_tb_lines, 0) <> 0 OR NEW.sealed OR NEW.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'RECONCILIATION_RESULT_SERVER_ONLY: a reconciliation starts as processing with no results' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.matched_count IS DISTINCT FROM OLD.matched_count OR NEW.exception_count IS DISTINCT FROM OLD.exception_count
         OR NEW.total_tb_lines IS DISTINCT FROM OLD.total_tb_lines OR NEW.sealed IS DISTINCT FROM OLD.sealed
         OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
         OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('processing', 'needs_review')) THEN
        RAISE EXCEPTION 'RECONCILIATION_RESULT_SERVER_ONLY: results and completion are recorded by the server' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  IF NEW.status = 'clean' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'clean')
     AND NOT public.safisha_reconciliation_complete(NEW.id) THEN
    RAISE EXCEPTION 'RECONCILIATION_INCOMPLETE: every trial-balance line must be matched or approved, with nothing pending, escalated or rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.safisha_upload_status_authority()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.safisha_status IS NOT DISTINCT FROM OLD.safisha_status THEN
    RETURN NEW;
  END IF;
  IF current_user IN ('authenticated', 'anon') AND NEW.safisha_status IN ('clean', 'blocked') THEN
    RAISE EXCEPTION 'RECONCILIATION_STATUS_SERVER_ONLY: a reconciliation result is recorded by the server' USING ERRCODE = '42501';
  END IF;
  IF NEW.safisha_status = 'clean' AND NOT public.safisha_upload_reconciliation_complete(NEW.id) THEN
    RAISE EXCEPTION 'RECONCILIATION_INCOMPLETE: the upload''s latest reconciliation is not complete' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ab_reconciliation_authority ON public.safisha_reconciliations;
CREATE TRIGGER ab_reconciliation_authority BEFORE INSERT OR UPDATE ON public.safisha_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.safisha_reconciliation_authority();

DROP TRIGGER IF EXISTS ab_upload_reconciliation_status_authority ON public.trial_balance_uploads;
CREATE TRIGGER ab_upload_reconciliation_status_authority BEFORE INSERT OR UPDATE OF safisha_status ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.safisha_upload_status_authority();

-- ── 5. The MAONO gate trusts completeness, not the raw status ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.maono_check_safisha_gate(p_upload_ids uuid[])
RETURNS TABLE(upload_id uuid, safisha_status text, is_blocked boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT
    u.id AS upload_id,
    COALESCE(u.safisha_status, 'not_started') AS safisha_status,
    NOT (COALESCE(u.safisha_status, 'not_started') = 'clean' AND public.safisha_upload_reconciliation_complete(u.id)) AS is_blocked
  FROM public.trial_balance_uploads u
  WHERE u.id = ANY(p_upload_ids)
  ORDER BY u.id;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- The completeness readers are SECURITY INVOKER: a client sees only what row-level security already shows it.
REVOKE ALL ON FUNCTION public.safisha_reconciliation_coverage(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.safisha_reconciliation_complete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.safisha_upload_reconciliation_complete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safisha_reconciliation_coverage(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.safisha_reconciliation_complete(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.safisha_upload_reconciliation_complete(uuid) TO authenticated, service_role;
-- Recording a match result: the safisha-match function only (service role, actor from the verified JWT).
REVOKE ALL ON FUNCTION public.safisha_record_match_result(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safisha_record_match_result(uuid, uuid) TO service_role;
-- Trigger functions are never called directly.
REVOKE ALL ON FUNCTION public.safisha_reconciliation_authority() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.safisha_upload_status_authority() FROM PUBLIC, anon, authenticated;
-- Unchanged grants restated (CREATE OR REPLACE keeps them; stated so a replay on a fresh database is identical).
REVOKE ALL ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.maono_check_safisha_gate(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.maono_check_safisha_gate(uuid[]) TO service_role;
