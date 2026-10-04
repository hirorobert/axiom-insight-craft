-- 20261004100000_reconciliation_server_authority.sql
--
-- Reconciliation readiness becomes a SERVER fact. Found by the disposable-PostgreSQL reconciliation proofs:
--   · safisha_resolve_exception marked a reconciliation and its upload 'clean' while an exception was only ESCALATED
--     (and treated a rejected non-investigate exception as resolved);
--   · the account owner could set trial_balance_uploads.safisha_status = 'clean' directly;
--   · the owner and firm members could rewrite safisha_reconciliations.status / matched_count / total_tb_lines directly;
--   · maono_check_safisha_gate trusted the raw 'clean';
--   · an escalated exception could never be decided (resolved exceptions are immutable), and a re-run of the matcher
--     appended duplicate exceptions (its "remove pending" step can never run: exceptions are never deleted);
--   · a trial-balance line added after matching left a 'clean' reconciliation 'clean'.
-- The SAFISHA functions write with the caller's JWT, so at the database their writes were indistinguishable from a forged
-- direct write. This migration moves the authority into the database:
--
--   1. Completeness is computed from server rows, never from an editable count (safisha_reconciliation_coverage): at least
--      one trial-balance line; exactly the lines the matcher recorded (total_tb_lines, server-written); every line either
--      without an exception (matched by the matcher) or with only APPROVED exceptions; nothing pending, escalated or
--      rejected. One verdict for every writer (_safisha_record_verdict): a rejected investigate exception → 'blocked';
--      complete → 'clean'; otherwise 'needs_review'.
--   2. safisha_record_match_result(recon, actor, exceptions) — service-role only: the ONE way the matcher records a run.
--      Locks the reconciliation, authorizes the actor (current plan + prepare_close), validates every exception against
--      this reconciliation's own rows, inserts each one only if the same finding (TB line, evidence line, category, match
--      type, variance) is not already recorded in any state — so a retry or re-run is idempotent and a reviewer's
--      decision is never duplicated or bypassed — derives the counts and records the verdict.
--   3. safisha_decide_exception(exception, reviewer, action, note) — service-role only: the reviewer decision. Locks the
--      reconciliation BEFORE the exception (the same order as the matcher, so concurrent match and resolve serialize and
--      never deadlock). A pending exception may be approved, rejected or escalated by a prepare_close holder. An ESCALATED
--      exception stays open until a different person holding review_close (owner or partner) approves or rejects it.
--      Approved and rejected decisions stay final. The verdict is recomputed after every decision.
--      safisha_resolve_exception keeps its signature and grants and now calls it. safisha-resolve calls the new name, so
--      a new function deployed against the old schema finds no function and changes nothing.
--   4. Guards for client roles (authenticated / anon), after the existing write wall: a client may create a
--      reconciliation only as 'processing' with no results, may never change its counts, sealing or completion, may move
--      its status only to 'processing' / 'needs_review', may not insert exceptions, and may never set an upload's
--      safisha_status to 'clean' or 'blocked'. For EVERY role, 'clean' (reconciliation or upload) is accepted only when
--      complete.
--   5. Freshness: adding a trial-balance line or an exception to a 'clean' reconciliation returns it, and its upload, to
--      'needs_review' (under the reconciliation lock, so it cannot interleave with a match or a decision).
--   6. maono_check_safisha_gate: an upload is unblocked only when 'clean' AND its latest reconciliation is complete.
--   7. TRUNCATE on the reconciliation tables is revoked from client roles (not reachable through the API; it would bypass
--      row-level security and every row trigger).
--
-- Preserved: upload registration and every other upload write; creating a reconciliation, ingesting transactions,
-- categorizing and scoring (safisha-ingest / -categorize / -score keep their client writes); the evidence-attachment RPC.
-- No existing row is read-modified or removed. Forward-only and replay-safe (CREATE OR REPLACE; triggers dropped and
-- recreated by name).

-- ── 1. Completeness and the verdict, from server rows ───────────────────────────────────────────────────────────────
-- p_recorded_total: the trial-balance line count the matcher recorded; NULL reads it from the reconciliation (a trigger
-- passes the row being written).
CREATE OR REPLACE FUNCTION public.safisha_reconciliation_coverage(p_recon_id uuid, p_recorded_total integer DEFAULT NULL)
  RETURNS TABLE(total_tb_lines integer, recorded_tb_lines integer, matched_tb_lines integer, approved_tb_lines integer,
                pending integer, escalated integer, rejected integer, rejected_investigate integer, complete boolean)
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  WITH tb AS (
    SELECT t.id FROM public.safisha_transactions t WHERE t.reconciliation_id = p_recon_id AND t.source_id = 'tb'
  ), x AS (
    SELECT e.tb_txn_id, e.reviewer_action, e.category FROM public.safisha_exceptions e WHERE e.reconciliation_id = p_recon_id
  ), per_line AS (
    SELECT tb.id,
           count(x.*)                                                AS exceptions,
           count(x.*) FILTER (WHERE x.reviewer_action <> 'approved') AS unresolved
      FROM tb LEFT JOIN x ON x.tb_txn_id = tb.id
     GROUP BY tb.id
  ), counts AS (
    SELECT (SELECT count(*) FROM per_line)::integer                                                   AS total,
           COALESCE(p_recorded_total, (SELECT r.total_tb_lines FROM public.safisha_reconciliations r WHERE r.id = p_recon_id)) AS recorded,
           (SELECT count(*) FROM per_line WHERE exceptions = 0)::integer                              AS matched,
           (SELECT count(*) FROM per_line WHERE exceptions > 0 AND unresolved = 0)::integer            AS approved,
           (SELECT count(*) FROM x WHERE reviewer_action = 'pending')::integer                        AS pending,
           (SELECT count(*) FROM x WHERE reviewer_action = 'escalated')::integer                      AS escalated,
           (SELECT count(*) FROM x WHERE reviewer_action = 'rejected')::integer                       AS rejected,
           (SELECT count(*) FROM x WHERE reviewer_action = 'rejected' AND category = 'investigate')::integer AS rejected_investigate
  )
  SELECT total, recorded, matched, approved, pending, escalated, rejected, rejected_investigate,
         (total > 0 AND recorded IS NOT DISTINCT FROM total AND pending = 0 AND escalated = 0 AND rejected = 0
          AND matched + approved = total)
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

-- One verdict, for the matcher and the reviewer alike, recorded on the reconciliation and its upload in one statement
-- each. p_total: the trial-balance line count the matcher is recording now (NULL keeps the recorded one). The caller
-- holds the reconciliation lock.
CREATE OR REPLACE FUNCTION public._safisha_record_verdict(p_recon_id uuid, p_total integer DEFAULT NULL)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cov    record;
  v_status text;
  v_upload uuid;
BEGIN
  SELECT * INTO v_cov FROM public.safisha_reconciliation_coverage(p_recon_id, p_total);
  v_status := CASE WHEN v_cov.rejected_investigate > 0 THEN 'blocked' WHEN v_cov.complete THEN 'clean' ELSE 'needs_review' END;
  UPDATE public.safisha_reconciliations SET
    total_tb_lines  = v_cov.recorded_tb_lines,
    matched_count   = v_cov.matched_tb_lines,
    exception_count = (SELECT count(*)::integer FROM public.safisha_exceptions WHERE reconciliation_id = p_recon_id),
    status          = v_status,
    completed_at    = CASE WHEN v_status = 'clean' THEN COALESCE(completed_at, now()) ELSE NULL END
  WHERE id = p_recon_id
  RETURNING tb_upload_id INTO v_upload;
  UPDATE public.trial_balance_uploads SET safisha_status = v_status
   WHERE id = v_upload AND safisha_status IS DISTINCT FROM v_status;
  RETURN v_status;
END;
$$;

-- Whether p_actor may change this reconciliation: its account has a current plan, and p_actor holds p_capability in the
-- workspace (a personal, company-less reconciliation: p_actor is its owner). Returns the workspace (NULL when personal).
CREATE OR REPLACE FUNCTION public._safisha_authorize(p_recon_id uuid, p_actor uuid, p_capability text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid;
  v_account uuid;
BEGIN
  SELECT u.company_id, COALESCE(c.user_id, u.user_id, r.client_id) INTO v_company, v_account
    FROM public.safisha_reconciliations r
    JOIN public.trial_balance_uploads u ON u.id = r.tb_upload_id
    LEFT JOIN public.companies c ON c.id = u.company_id
   WHERE r.id = p_recon_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECONCILIATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public._account_has_current_plan(v_account) THEN
    RAISE EXCEPTION 'RECONCILIATION_READ_ONLY' USING ERRCODE = 'PT402', DETAIL = 'CLOSE_ASSURANCE', HINT = 'NO_PLAN';
  END IF;
  IF p_actor IS NULL
     OR (v_company IS NOT NULL AND NOT public.workspace_capability_allowed(v_company, p_actor, p_capability))
     OR (v_company IS NULL AND p_actor IS DISTINCT FROM v_account) THEN
    RAISE EXCEPTION 'CAPABILITY_REQUIRED: this reconciliation change needs % in this workspace', p_capability USING ERRCODE = '42501';
  END IF;
  RETURN v_company;
END;
$$;

-- ── 2. The matcher's run, recorded by the database ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.safisha_record_match_result(p_recon_id uuid, p_actor uuid, p_exceptions jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_recon    public.safisha_reconciliations%ROWTYPE;
  v_e        jsonb;
  v_tb       uuid;
  v_ev       uuid;
  v_variance numeric;
  v_age      integer;
  v_inserted integer := 0;
  v_existing integer := 0;
  v_status   text;
  v_cov      record;
  v_total    integer;
BEGIN
  SELECT * INTO v_recon FROM public.safisha_reconciliations WHERE id = p_recon_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECONCILIATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_recon.sealed THEN
    RAISE EXCEPTION 'RECONCILIATION_SEALED' USING ERRCODE = '55000';
  END IF;
  PERFORM public._safisha_authorize(p_recon_id, p_actor, 'prepare_close');
  IF p_exceptions IS NULL OR jsonb_typeof(p_exceptions) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_MATCH_RESULT: exceptions must be an array' USING ERRCODE = '22023';
  END IF;
  SELECT count(*)::integer INTO v_total FROM public.safisha_transactions WHERE reconciliation_id = p_recon_id AND source_id = 'tb';
  IF v_total = 0 THEN
    RAISE EXCEPTION 'INVALID_MATCH_RESULT: the reconciliation has no trial-balance lines' USING ERRCODE = '22023';
  END IF;

  FOR v_e IN SELECT * FROM jsonb_array_elements(p_exceptions) LOOP
    BEGIN
      v_tb       := (v_e->>'tb_txn_id')::uuid;
      v_ev       := NULLIF(v_e->>'evidence_txn_id', '')::uuid;
      v_variance := (v_e->>'variance')::numeric;
      v_age      := GREATEST(COALESCE((v_e->>'age_days')::integer, 0), 0);
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'INVALID_MATCH_RESULT: malformed exception' USING ERRCODE = '22023';
    END;
    -- Every finding names one of THIS reconciliation's trial-balance lines, and at most one of its evidence lines.
    IF v_tb IS NULL OR NOT EXISTS (SELECT 1 FROM public.safisha_transactions WHERE id = v_tb AND reconciliation_id = p_recon_id AND source_id = 'tb')
       OR (v_ev IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.safisha_transactions WHERE id = v_ev AND reconciliation_id = p_recon_id AND source_id <> 'tb'))
       OR v_variance IS NULL
       OR COALESCE(v_e->>'category', '') NOT IN ('timing', 'needs_adjustment', 'investigate')
       OR COALESCE(v_e->>'match_type', '') NOT IN ('one_to_one', 'one_to_many', 'unmatched')
       OR COALESCE(v_e->>'account_code', '') = '' THEN
      RAISE EXCEPTION 'INVALID_MATCH_RESULT: an exception does not belong to this reconciliation or is incomplete' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.safisha_exceptions x
                WHERE x.reconciliation_id = p_recon_id AND x.tb_txn_id = v_tb
                  AND x.evidence_txn_id IS NOT DISTINCT FROM v_ev
                  AND x.category = v_e->>'category' AND x.match_type IS NOT DISTINCT FROM v_e->>'match_type'
                  AND x.variance = v_variance) THEN
      v_existing := v_existing + 1;    -- already recorded (pending or decided): never duplicated, never re-opened
    ELSE
      INSERT INTO public.safisha_exceptions (reconciliation_id, account_code, account_name, category, variance, age_days,
                                             tb_txn_id, evidence_txn_id, match_type, description)
      VALUES (p_recon_id, v_e->>'account_code', v_e->>'account_name', v_e->>'category', v_variance, v_age,
              v_tb, v_ev, v_e->>'match_type', v_e->>'description');
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  v_status := public._safisha_record_verdict(p_recon_id, v_total);
  SELECT * INTO v_cov FROM public.safisha_reconciliation_coverage(p_recon_id);
  RETURN jsonb_build_object(
    'reconciliation_id', p_recon_id, 'status', v_status,
    'total_tb_lines', v_cov.total_tb_lines, 'matched_tb_lines', v_cov.matched_tb_lines, 'approved_tb_lines', v_cov.approved_tb_lines,
    'pending', v_cov.pending, 'escalated', v_cov.escalated, 'rejected', v_cov.rejected,
    'open_exceptions', v_cov.pending + v_cov.escalated + v_cov.rejected,
    'exceptions_recorded', v_inserted, 'exceptions_already_recorded', v_existing);
END;
$$;

-- ── 3. The reviewer's decision ──────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.safisha_decide_exception(p_exception_id uuid, p_reviewer_id uuid, p_action text, p_note text DEFAULT NULL::text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_recon_id  uuid;
  v_exception public.safisha_exceptions%ROWTYPE;
  v_company   uuid;
  v_member_id uuid;
  v_remaining integer;
  v_status    text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('approved', 'rejected', 'escalated') THEN
    RAISE EXCEPTION 'Invalid reviewer_action: %. Must be approved|rejected|escalated', p_action USING ERRCODE = '22023';
  END IF;
  SELECT reconciliation_id INTO v_recon_id FROM public.safisha_exceptions WHERE id = p_exception_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exception % not found', p_exception_id USING ERRCODE = 'P0002';
  END IF;
  -- Lock order: the reconciliation, then the exception (the matcher takes the same reconciliation lock first).
  PERFORM 1 FROM public.safisha_reconciliations WHERE id = v_recon_id FOR UPDATE;
  SELECT * INTO v_exception FROM public.safisha_exceptions WHERE id = p_exception_id FOR UPDATE;

  v_company := public._safisha_authorize(v_recon_id, p_reviewer_id, 'prepare_close');
  IF v_exception.reviewer_action = 'escalated' THEN
    -- Escalated is open: it waits for a different person holding review_close (owner or partner), who approves or
    -- rejects it. A personal workspace has one person, who decides.
    IF p_action = 'escalated' THEN
      RAISE EXCEPTION 'Exception % is already escalated', p_exception_id USING ERRCODE = '55000';
    END IF;
    IF v_company IS NOT NULL THEN
      PERFORM public._safisha_authorize(v_recon_id, p_reviewer_id, 'review_close');
      IF p_reviewer_id IS NOT DISTINCT FROM v_exception.reviewer_id THEN
        RAISE EXCEPTION 'SEPARATE_REVIEWER_REQUIRED: an escalated exception is decided by a different reviewer' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF v_exception.reviewer_action <> 'pending' THEN
    RAISE EXCEPTION 'Exception % is already resolved (%)', p_exception_id, v_exception.reviewer_action USING ERRCODE = '55000';
  END IF;

  SELECT fm.id INTO v_member_id
    FROM public.firm_members fm
    JOIN public.trial_balance_uploads tbu ON tbu.company_id = fm.company_id
    JOIN public.safisha_reconciliations sr ON sr.tb_upload_id = tbu.id AND sr.id = v_recon_id
   WHERE fm.user_id = p_reviewer_id
   LIMIT 1;

  PERFORM set_config('safisha.resolve_authorized', 'true', true);
  UPDATE public.safisha_exceptions SET
    reviewer_action    = p_action,
    reviewer_id        = p_reviewer_id,
    reviewer_member_id = v_member_id,
    reviewer_note      = p_note,
    resolved_at        = now()
  WHERE id = p_exception_id;
  PERFORM set_config('safisha.resolve_authorized', 'false', true);

  INSERT INTO public.safisha_audit_log (exception_id, reconciliation_id, reviewer_id, reviewer_member_id, action, note)
  VALUES (p_exception_id, v_recon_id, p_reviewer_id, v_member_id, p_action, p_note);

  v_status := public._safisha_record_verdict(v_recon_id);
  SELECT count(*)::integer INTO v_remaining FROM public.safisha_exceptions WHERE reconciliation_id = v_recon_id AND reviewer_action = 'pending';
  RETURN jsonb_build_object('exception_id', p_exception_id, 'action', p_action, 'remaining', v_remaining, 'recon_status', v_status);
END;
$$;

-- The established name keeps its signature and grants (service role only) and now decides through the same authority.
CREATE OR REPLACE FUNCTION public.safisha_resolve_exception(p_exception_id uuid, p_reviewer_id uuid, p_action text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.safisha_decide_exception(p_exception_id, p_reviewer_id, p_action, p_note);
$function$;

-- The audit gate: its 20260711200000 definition, except that an ESCALATED exception (still open) may be decided —
-- approved or rejected — through the authorized decision, and the matched lines (tb_txn_id, evidence_txn_id,
-- match_type) are immutable like the other finding fields. Approved and rejected stay immutable.
CREATE OR REPLACE FUNCTION public.safisha_enforce_resolve_gate()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  authorized TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reviewer_action <> 'pending' THEN
      RAISE EXCEPTION
        'Iron Dome: safisha_exceptions.reviewer_action must be ''pending'' on INSERT. '
        'Use safisha-resolve Edge Function to set a resolution.';
    END IF;
    IF NEW.reviewer_id IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Iron Dome: reviewer_id and resolved_at must be NULL on INSERT. '
        'Only safisha-resolve may set these fields.';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Iron Dome: safisha_exceptions records cannot be deleted. '
      'Exceptions are permanent audit evidence. Exception id: %', OLD.id;
  END IF;

  authorized := current_setting('safisha.resolve_authorized', TRUE);
  IF authorized IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'Iron Dome: reviewer_action can only be written by the safisha-resolve '
      'Edge Function. Direct UPDATE is blocked. '
      'Attempted change: % → % on exception %',
      OLD.reviewer_action, NEW.reviewer_action, OLD.id;
  END IF;

  IF NOT (OLD.reviewer_action = 'pending'
          OR (OLD.reviewer_action = 'escalated' AND NEW.reviewer_action IN ('approved', 'rejected'))) THEN
    RAISE EXCEPTION
      'Iron Dome: Exception % is already resolved (status: %). '
      'Resolved exceptions are immutable.',
      OLD.id, OLD.reviewer_action;
  END IF;

  IF NEW.reviewer_action <> 'pending' AND NEW.reviewer_id IS NULL THEN
    RAISE EXCEPTION
      'Iron Dome: reviewer_id must be set when resolving exception %. '
      'Anonymous resolution is not permitted.',
      NEW.id;
  END IF;

  IF NEW.reviewer_action <> 'pending' AND NEW.resolved_at IS NULL THEN
    NEW.resolved_at := now();
  END IF;

  IF NEW.reconciliation_id <> OLD.reconciliation_id OR
     NEW.account_code      <> OLD.account_code      OR
     NEW.category          <> OLD.category          OR
     NEW.variance          <> OLD.variance          OR
     NEW.tb_txn_id       IS DISTINCT FROM OLD.tb_txn_id       OR
     NEW.evidence_txn_id IS DISTINCT FROM OLD.evidence_txn_id OR
     NEW.match_type      IS DISTINCT FROM OLD.match_type THEN
    RAISE EXCEPTION
      'Iron Dome: Only reviewer_action, reviewer_id, reviewer_note, '
      'and resolved_at may be changed on safisha_exceptions.';
  END IF;

  RETURN NEW;
END;
$$;

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
  IF NEW.status = 'clean' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'clean' OR NEW.total_tb_lines IS DISTINCT FROM OLD.total_tb_lines)
     AND NOT COALESCE((SELECT c.complete FROM public.safisha_reconciliation_coverage(NEW.id, NEW.total_tb_lines) c), false) THEN
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

-- Exceptions are matcher output: a client role never records one (safisha-match records through
-- safisha_record_match_result).
CREATE OR REPLACE FUNCTION public.safisha_exception_authority()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'RECONCILIATION_RESULT_SERVER_ONLY: exceptions are recorded by the server' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 5. Freshness: new trial-balance lines or exceptions re-open a 'clean' reconciliation ────────────────────────────
-- SECURITY DEFINER: it records the server's own consequence of a write the caller was already allowed to make. It takes
-- the reconciliation lock, so it serializes with a match or a decision.
CREATE OR REPLACE FUNCTION public.safisha_reconciliation_freshness()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
  v_upload uuid;
BEGIN
  IF TG_TABLE_NAME = 'safisha_transactions' AND (to_jsonb(NEW)->>'source_id') IS DISTINCT FROM 'tb' THEN
    RETURN NEW;                                    -- evidence lines do not change which trial-balance lines exist
  END IF;
  SELECT status, tb_upload_id INTO v_status, v_upload FROM public.safisha_reconciliations WHERE id = NEW.reconciliation_id FOR UPDATE;
  IF v_status = 'clean' THEN
    UPDATE public.safisha_reconciliations SET status = 'needs_review', completed_at = NULL WHERE id = NEW.reconciliation_id;
    UPDATE public.trial_balance_uploads SET safisha_status = 'needs_review' WHERE id = v_upload AND safisha_status = 'clean';
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

DROP TRIGGER IF EXISTS ab_exception_authority ON public.safisha_exceptions;
CREATE TRIGGER ab_exception_authority BEFORE INSERT ON public.safisha_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.safisha_exception_authority();

DROP TRIGGER IF EXISTS ac_reconciliation_freshness ON public.safisha_transactions;
CREATE TRIGGER ac_reconciliation_freshness BEFORE INSERT ON public.safisha_transactions
  FOR EACH ROW EXECUTE FUNCTION public.safisha_reconciliation_freshness();

DROP TRIGGER IF EXISTS ac_reconciliation_freshness ON public.safisha_exceptions;
CREATE TRIGGER ac_reconciliation_freshness BEFORE INSERT ON public.safisha_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.safisha_reconciliation_freshness();

-- ── 6. The MAONO gate trusts completeness, not the raw status ───────────────────────────────────────────────────────
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
REVOKE ALL ON FUNCTION public.safisha_reconciliation_coverage(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.safisha_reconciliation_complete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.safisha_upload_reconciliation_complete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safisha_reconciliation_coverage(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.safisha_reconciliation_complete(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.safisha_upload_reconciliation_complete(uuid) TO authenticated, service_role;
-- Recording a match and deciding an exception: the safisha-match / safisha-resolve functions only (service role, actor
-- from the verified JWT).
REVOKE ALL ON FUNCTION public.safisha_record_match_result(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safisha_record_match_result(uuid, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.safisha_decide_exception(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safisha_decide_exception(uuid, uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) TO service_role;
-- Internal helpers and trigger functions are never called directly.
REVOKE ALL ON FUNCTION public._safisha_record_verdict(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._safisha_authorize(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.safisha_reconciliation_authority() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.safisha_upload_status_authority() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.safisha_exception_authority() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.safisha_reconciliation_freshness() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.safisha_enforce_resolve_gate() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.maono_check_safisha_gate(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.maono_check_safisha_gate(uuid[]) TO service_role;
-- TRUNCATE bypasses row-level security and every row trigger; no client path uses it.
REVOKE TRUNCATE ON public.safisha_reconciliations, public.safisha_transactions, public.safisha_exceptions, public.safisha_audit_log FROM anon, authenticated;
