-- 20261008100000_processing_attempt_authority.sql
--
-- S2 of the R0 integrity programme (design Amendment 2, C5/C6; docs/release/R0_CONTRACT_CORRECTIONS.md §1 and §4).
-- Forward-only; PENDING HOSTED APPLICATION (no hosted journal number, hash or applied timestamp is stated anywhere until a
-- hosted read confirms it). Requires S1 (20261006100000) and H1 (20261007100000). Applied only inside the C-S2 window:
-- processing held and drained first; E2 (the handler on these RPCs) deployed in the same window.
--
-- 1. Attempts (correction 1: controlled transitions + append-only events). Every process-trial-balance run is an attempt:
--    engine_runs gains attempt_no and lease_expires_at, and the terminal state 'abandoned' (preempted, lease expired,
--    upload left active use, drained at cut-over). An attempt's status changes only inside the S2 functions (a
--    transaction-scoped writer marker); terminal states never change again; every transition of a process-trial-balance
--    run is appended to engine_run_events (insert-only).
-- 2. The fence. trial_balance_uploads gains current_engine_run_id and processing_attempt. Beginning attempt n points the
--    upload at it, so attempt n-1 can never finalize ("ATTEMPT_NOT_CURRENT") and its certification is never current again.
--    The processing fields (status, is_valid, processing_result, validation_report, accounting_errors, processed_at,
--    source_file_hash), the attempt fields, process-trial-balance run inserts and every tb_certifications insert are refused
--    for EVERY role outside the S2 functions and the existing lifecycle RPCs — the previous handler's first write (its
--    status claim) is refused, and commit_tb_certification is retired (PT410 ENGINE_COMMIT_RETIRED).
-- 3. RPCs (service role only):
--      tb_begin_attempt        idempotent claim (replay / in progress / conflict), REPROCESS_REQUIRED, SOURCE_CHANGED,
--                              IN_PROGRESS; abandons an attempt whose lease expired; starts the attempt and points the upload.
--      tb_snapshot_dependencies records the revision of every dependency key the run will consult (accounts by code and by
--                              normalized name in the company and the shared chart, the framework, the period currency, the
--                              keyword dictionary) BEFORE the engine reads them — absent keys as revision 0.
--      tb_finalize_attempt     fenced, all or nothing: certification (when any), the upload's processing fields, the run and
--                              its idempotency key. A dependency that changed since the snapshot fails the attempt
--                              (DEPENDENCY_CHANGED) instead of certifying stale inputs.
--      tb_expire_attempts      abandons attempts whose lease has expired (LEASE_EXPIRED).
-- 4. Dependency revisions. tb_dependency_revisions is bumped by triggers on every write that can change a classification
--    input: account_mappings (company and shared rows; code and name keys), account_review_decisions (non-reporting and
--    treatment decisions), companies.reporting_framework, fiscal_periods.reporting_currency, keyword_dictionary.
-- 5. Read-time authority. get_authoritative_certification additionally requires: the certification's run is the upload's
--    CURRENT attempt and completed; every recorded dependency is still at its recorded revision; the run is an S2 attempt.
--    Certifications written before S2 stay as history and are never authoritative again (OD1: "Needs re-check").
--    tb_upload_authority(upload) explains the answer for one upload, and tb_upload_attempts(upload) lists its processing
--    attempts (members only) — what the review screens show as "Needs re-check", "Processing stopped" and the history.
-- 6. Preemption. tbu_request_reprocess (re-created from H1 with only the marked S2 change): an authorized request (the
--    existing prepare_close, plan and hold checks) on an upload whose current attempt is running abandons it (PREEMPTED)
--    instead of answering IN_PROGRESS. Lifecycle: an upload leaving active use abandons its running attempt.
-- 7. Lock order (C5, correction 4). One global order: L1 operation-identity advisory locks; L2 dependency-key advisory
--    locks, sorted; L3 mapping and revision rows; L4 upload rows; L5 reservation rows; L6 upload-operation rows; L7 engine
--    runs; L8 certification and invalidation inserts. Reordered here: complete_trial_balance_discard, tbu_abort_discard
--    and tbu_sweeper_complete('stale_discard') lock the upload before the operation (they locked operation → upload);
--    admin_drain_processing locks uploads before runs; commit_tb_certification (run → upload) is retired.
--    Deliberate, documented differences from the Amendment text:
--      * the snapshot takes L2 (the review RPC's own per-key advisory lock form, (hashtext(company), hashtext(key)), so
--        resolve_account_review_batch is unchanged) but reads revisions WITHOUT L3 FOR SHARE: the review bumps code and
--        name revisions in its own per-account order, and FOR SHARE in sorted order could invert with it. Correctness does
--        not depend on that lock: finalize re-checks every revision, and read-time authority re-checks them again;
--      * restore_trial_balance_upload has no upload row to lock first (it re-inserts a discarded upload); it keeps
--        operation → insert, covered by the lock proof.
--
-- Not here: E2 (the handler on these RPCs; consumers on authority), F2, any frontend publication.

-- ── 1. Attempts on engine_runs ───────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.engine_runs ADD COLUMN IF NOT EXISTS attempt_no integer;
ALTER TABLE public.engine_runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE public.engine_runs DROP CONSTRAINT IF EXISTS chk_er_status;
ALTER TABLE public.engine_runs ADD CONSTRAINT chk_er_status CHECK (status IN ('running', 'completed', 'failed', 'abandoned'));
ALTER TABLE public.engine_runs DROP CONSTRAINT IF EXISTS chk_er_completed_at_pairing;
ALTER TABLE public.engine_runs ADD CONSTRAINT chk_er_completed_at_pairing CHECK (
  (status = 'running' AND completed_at IS NULL) OR (status IN ('completed', 'failed', 'abandoned') AND completed_at IS NOT NULL));
ALTER TABLE public.engine_runs DROP CONSTRAINT IF EXISTS chk_er_attempt_pairing;
ALTER TABLE public.engine_runs ADD CONSTRAINT chk_er_attempt_pairing CHECK (
  (attempt_no IS NULL AND lease_expires_at IS NULL) OR (attempt_no > 0 AND lease_expires_at IS NOT NULL));
ALTER TABLE public.engine_runs DROP CONSTRAINT IF EXISTS chk_er_abandoned_has_code;
ALTER TABLE public.engine_runs ADD CONSTRAINT chk_er_abandoned_has_code CHECK (status <> 'abandoned' OR error_code IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_er_ptb_running_lease ON public.engine_runs (lease_expires_at)
  WHERE function_name = 'process-trial-balance' AND status = 'running' AND attempt_no IS NOT NULL;

-- The S2 writer marker: set by the S2 functions for their own transaction only.
CREATE OR REPLACE FUNCTION public._tb_attempt_writer(p_on boolean)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM set_config('axiom.tb_attempt_writer', CASE WHEN p_on THEN txid_current()::text ELSE '' END, true);
END;
$$;
CREATE OR REPLACE FUNCTION public._tb_attempt_writer_active()
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT coalesce(current_setting('axiom.tb_attempt_writer', true), '') = txid_current()::text;
$$;
REVOKE ALL ON FUNCTION public._tb_attempt_writer(boolean) FROM PUBLIC, anon, authenticated, service_role;
-- _tb_attempt_writer_active() keeps its default EXECUTE: the fence triggers call it as the caller's role.

-- Re-created from H1 (20261007100000) with the S2 additions marked.
CREATE OR REPLACE FUNCTION public.engine_runs_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Iron Dome: engine_runs rows cannot be deleted. [id=%]', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status != 'running' THEN
    RAISE EXCEPTION
      'Iron Dome: engine_runs row already reached a terminal state (%). '
      'No further update is permitted. [id=%]', OLD.status, OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- S2: 'abandoned' is a terminal state too (preempted, lease expired, upload left active use, drained at cut-over).
  IF NEW.status NOT IN ('completed', 'failed', 'abandoned') THEN
    RAISE EXCEPTION
      'Iron Dome: the only legal transition from running is to completed, '
      'failed or abandoned. Attempted: %. [id=%]', NEW.status, OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- S2: an attempt (a process-trial-balance run begun by tb_begin_attempt) changes state only inside the S2 functions,
  -- or through the H1 drain control.
  IF OLD.attempt_no IS NOT NULL AND NOT public._tb_attempt_writer_active()
     AND coalesce(current_setting('axiom.processing_control_writer', true), '') IS DISTINCT FROM txid_current()::text THEN
    RAISE EXCEPTION 'ATTEMPT_TRANSITION_FENCED: an attempt changes state only through the attempt functions. [id=%]', OLD.id
      USING ERRCODE = 'PT409';
  END IF;

  IF NEW.company_id       IS DISTINCT FROM OLD.company_id       OR
     NEW.firm_member_id   IS DISTINCT FROM OLD.firm_member_id   OR
     NEW.actor_type       IS DISTINCT FROM OLD.actor_type       OR
     NEW.function_name    IS DISTINCT FROM OLD.function_name    OR
     NEW.engine_version   IS DISTINCT FROM OLD.engine_version   OR
     NEW.engine_generation IS DISTINCT FROM OLD.engine_generation OR
     NEW.attempt_no       IS DISTINCT FROM OLD.attempt_no       OR
     NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at OR
     NEW.rule_version     IS DISTINCT FROM OLD.rule_version     OR
     NEW.request_id       IS DISTINCT FROM OLD.request_id       OR
     NEW.input_hash       IS DISTINCT FROM OLD.input_hash       OR
     NEW.started_at       IS DISTINCT FROM OLD.started_at       OR
     NEW.period_year      IS DISTINCT FROM OLD.period_year      OR
     NEW.source_table     IS DISTINCT FROM OLD.source_table     OR
     NEW.source_record_id IS DISTINCT FROM OLD.source_record_id OR
     NEW.created_at       IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Iron Dome: only status/completed_at/duration_ms/output_hash/'
      'error_code/error_detail may change on the terminal transition. [id=%]',
      OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

-- S2: a process-trial-balance run is created only by tb_begin_attempt (as an attempt). The previous handler's own run
-- insert (claimIdempotency) is refused for every role.
CREATE OR REPLACE FUNCTION public.engine_runs_attempt_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.function_name = 'process-trial-balance' AND (NOT public._tb_attempt_writer_active() OR NEW.attempt_no IS NULL) THEN
    RAISE EXCEPTION 'ATTEMPT_BEGIN_REQUIRED: a trial balance run starts only through tb_begin_attempt' USING ERRCODE = 'PT409';
  END IF;
  IF NEW.function_name IS DISTINCT FROM 'process-trial-balance' AND (NEW.attempt_no IS NOT NULL OR NEW.lease_expires_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ATTEMPT_FIELDS_RESERVED' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_er_attempt_fence ON public.engine_runs;
CREATE TRIGGER trg_er_attempt_fence BEFORE INSERT ON public.engine_runs FOR EACH ROW EXECUTE FUNCTION public.engine_runs_attempt_fence();
REVOKE ALL ON FUNCTION public.engine_runs_attempt_fence() FROM PUBLIC, anon, authenticated;

-- Append-only transition history of every process-trial-balance run.
CREATE TABLE IF NOT EXISTS public.engine_run_events (
  id            bigserial PRIMARY KEY,
  engine_run_id uuid NOT NULL REFERENCES public.engine_runs(id) ON DELETE RESTRICT,
  company_id    uuid NOT NULL,
  attempt_no    integer,
  from_status   text,
  to_status     text NOT NULL CHECK (to_status IN ('running', 'completed', 'failed', 'abandoned')),
  code          text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ere_run ON public.engine_run_events (engine_run_id, id);
ALTER TABLE public.engine_run_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.engine_run_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.engine_run_events TO authenticated;
GRANT SELECT ON TABLE public.engine_run_events TO service_role;
DROP POLICY IF EXISTS "ere_select_members" ON public.engine_run_events;
CREATE POLICY "ere_select_members" ON public.engine_run_events FOR SELECT TO authenticated USING (public.tbu_can_read_prepare(company_id));

CREATE OR REPLACE FUNCTION public.engine_run_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: engine_run_events is append-only. % is not permitted.', TG_OP USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_ere_append_only ON public.engine_run_events;
CREATE TRIGGER trg_ere_append_only BEFORE UPDATE OR DELETE ON public.engine_run_events
  FOR EACH ROW EXECUTE FUNCTION public.engine_run_events_append_only();

CREATE OR REPLACE FUNCTION public.engine_runs_record_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.engine_run_events (engine_run_id, company_id, attempt_no, from_status, to_status, code)
    VALUES (NEW.id, NEW.company_id, NEW.attempt_no, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
            CASE WHEN NEW.status IN ('failed', 'abandoned') THEN NEW.error_code END);
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_er_record_event ON public.engine_runs;
CREATE TRIGGER trg_er_record_event AFTER INSERT OR UPDATE OF status ON public.engine_runs
  FOR EACH ROW WHEN (NEW.function_name = 'process-trial-balance') EXECUTE FUNCTION public.engine_runs_record_event();
REVOKE ALL ON FUNCTION public.engine_runs_record_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.engine_run_events_append_only() FROM PUBLIC, anon, authenticated;

-- ── 2. The fence on uploads ──────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.trial_balance_uploads ADD COLUMN IF NOT EXISTS current_engine_run_id uuid REFERENCES public.engine_runs(id) ON DELETE RESTRICT;
ALTER TABLE public.trial_balance_uploads ADD COLUMN IF NOT EXISTS processing_attempt integer NOT NULL DEFAULT 0;
ALTER TABLE public.trial_balance_uploads DROP CONSTRAINT IF EXISTS chk_tbu_processing_attempt;
ALTER TABLE public.trial_balance_uploads ADD CONSTRAINT chk_tbu_processing_attempt CHECK (
  processing_attempt >= 0 AND ((processing_attempt = 0) = (current_engine_run_id IS NULL)));

CREATE OR REPLACE FUNCTION public.trial_balance_upload_attempt_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Client roles are answered by S1's server-owned-fields guard (42501), unchanged.
  IF current_user IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  -- The S2 functions, the existing lifecycle RPCs (their own transaction-scoped marker) and the H1 drain control.
  IF public._tb_attempt_writer_active()
     OR coalesce(current_setting('axiom.tbu_lifecycle_op', true), '') <> ''
     OR coalesce(current_setting('axiom.processing_control_writer', true), '') = txid_current()::text THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_engine_run_id IS NOT NULL OR NEW.processing_attempt <> 0 THEN
      RAISE EXCEPTION 'ATTEMPT_FIELDS_FENCED' USING ERRCODE = 'PT409';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.current_engine_run_id IS DISTINCT FROM OLD.current_engine_run_id OR NEW.processing_attempt IS DISTINCT FROM OLD.processing_attempt
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.is_valid IS DISTINCT FROM OLD.is_valid
     OR NEW.processing_result IS DISTINCT FROM OLD.processing_result OR NEW.validation_report IS DISTINCT FROM OLD.validation_report
     OR NEW.accounting_errors IS DISTINCT FROM OLD.accounting_errors OR NEW.processed_at IS DISTINCT FROM OLD.processed_at
     OR NEW.source_file_hash IS DISTINCT FROM OLD.source_file_hash THEN
    RAISE EXCEPTION 'PROCESSING_FENCED: an upload''s processing fields change only inside a processing attempt (tb_begin_attempt / tb_finalize_attempt). [id=%]', OLD.id
      USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tbu_attempt_fence ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_attempt_fence BEFORE INSERT OR UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.trial_balance_upload_attempt_fence();
REVOKE ALL ON FUNCTION public.trial_balance_upload_attempt_fence() FROM PUBLIC, anon, authenticated;

-- The source-hash guard (20260902150000), re-created: besides the service role, the attempt writer may RECORD a hash that
-- was never recorded (tb_begin_attempt runs as the function owner). Changing a recorded hash stays refused to it.
CREATE OR REPLACE FUNCTION public.trial_balance_uploads_protect_source_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Only source_file_hash is guarded. Any other column change on this row
  -- proceeds exactly as the existing RLS policies already allow.
  IF NEW.source_file_hash IS DISTINCT FROM OLD.source_file_hash
     AND current_user <> 'service_role'
     AND NOT (public._tb_attempt_writer_active() AND OLD.source_file_hash IS NULL) THEN
    RAISE EXCEPTION
      'source_file_hash is server-authoritative (set only by process-trial-balance via the service role) and cannot be changed by role %',
      current_user
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Every certification is written by tb_finalize_attempt, for the upload's current attempt.
CREATE OR REPLACE FUNCTION public.tb_certifications_attempt_fence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public._tb_attempt_writer_active() THEN
    RAISE EXCEPTION 'ENGINE_COMMIT_RETIRED: certifications are written only by tb_finalize_attempt' USING ERRCODE = 'PT410';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t JOIN public.engine_runs er ON er.id = t.current_engine_run_id
                  WHERE t.id = NEW.upload_id AND er.id = NEW.engine_run_id AND er.status = 'running') THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_CURRENT' USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tbc_attempt_fence ON public.tb_certifications;
CREATE TRIGGER trg_tbc_attempt_fence BEFORE INSERT ON public.tb_certifications
  FOR EACH ROW EXECUTE FUNCTION public.tb_certifications_attempt_fence();
REVOKE ALL ON FUNCTION public.tb_certifications_attempt_fence() FROM PUBLIC, anon, authenticated;

-- The previous engine's commit path is retired (it locked the run before the upload — the C5 inversion).
CREATE OR REPLACE FUNCTION public.commit_tb_certification(p_engine_run_id uuid, p_expected_function_name text, p_upload_id uuid, p_company_id uuid, p_period_year integer, p_source_file_hash text, p_normalized_input_hash text, p_output_hash text, p_is_blocking boolean, p_requires_review boolean, p_exceptions jsonb, p_rows_snapshot jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  RAISE EXCEPTION 'ENGINE_COMMIT_RETIRED: certifications are written only by tb_finalize_attempt' USING ERRCODE = 'PT410';
END;
$function$;

-- ── 3. Dependency revisions ──────────────────────────────────────────────────────────────────────────────────────────
-- scope: a company id (text) or 'global' (the shared chart and the keyword dictionary).
-- dep_key: 'code:<code>', 'name:<normalized name>', '#framework', '#currency', '#dictionary'.
CREATE TABLE IF NOT EXISTS public.tb_dependency_revisions (
  scope      text NOT NULL,
  dep_key    text NOT NULL,
  revision   bigint NOT NULL CHECK (revision > 0),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, dep_key)
);
ALTER TABLE public.tb_dependency_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_dependency_revisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tb_dependency_revisions TO service_role;

CREATE OR REPLACE FUNCTION public._tb_bump_dependency(p_scope text, p_key text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.tb_dependency_revisions AS r (scope, dep_key, revision) VALUES (p_scope, p_key, 1)
  ON CONFLICT (scope, dep_key) DO UPDATE SET revision = r.revision + 1, changed_at = now();
$$;
REVOKE ALL ON FUNCTION public._tb_bump_dependency(text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tb_dependency_bump_mapping()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT s, k FROM (
      SELECT coalesce(OLD.company_id::text, 'global') s, 'code:' || OLD.account_code k WHERE TG_OP <> 'INSERT' AND OLD.account_code IS NOT NULL
      UNION ALL SELECT coalesce(OLD.company_id::text, 'global'), 'name:' || OLD.normalized_account_name WHERE TG_OP <> 'INSERT' AND OLD.normalized_account_name IS NOT NULL
      UNION ALL SELECT coalesce(NEW.company_id::text, 'global'), 'code:' || NEW.account_code WHERE TG_OP <> 'DELETE' AND NEW.account_code IS NOT NULL
      UNION ALL SELECT coalesce(NEW.company_id::text, 'global'), 'name:' || NEW.normalized_account_name WHERE TG_OP <> 'DELETE' AND NEW.normalized_account_name IS NOT NULL
    ) x ORDER BY s, k
  LOOP
    PERFORM public._tb_bump_dependency(r.s, r.k);
  END LOOP;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_am_dependency_bump ON public.account_mappings;
CREATE TRIGGER trg_am_dependency_bump AFTER INSERT OR UPDATE OR DELETE ON public.account_mappings
  FOR EACH ROW EXECUTE FUNCTION public.tb_dependency_bump_mapping();

CREATE OR REPLACE FUNCTION public.tb_dependency_bump_decision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- A decision on an account (classification, non-reporting, treatment) changes what the engine must conclude for it.
  IF NEW.account_code IS NOT NULL THEN PERFORM public._tb_bump_dependency(NEW.company_id::text, 'code:' || NEW.account_code); END IF;
  PERFORM public._tb_bump_dependency(NEW.company_id::text, 'name:' || NEW.normalized_account_name);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_ard_dependency_bump ON public.account_review_decisions;
CREATE TRIGGER trg_ard_dependency_bump AFTER INSERT ON public.account_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.tb_dependency_bump_decision();

CREATE OR REPLACE FUNCTION public.tb_dependency_bump_company()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.reporting_framework IS DISTINCT FROM OLD.reporting_framework THEN
    PERFORM public._tb_bump_dependency(NEW.id::text, '#framework');
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_companies_dependency_bump ON public.companies;
CREATE TRIGGER trg_companies_dependency_bump AFTER UPDATE OF reporting_framework ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.tb_dependency_bump_company();

CREATE OR REPLACE FUNCTION public.tb_dependency_bump_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.reporting_currency IS DISTINCT FROM OLD.reporting_currency THEN
    PERFORM public._tb_bump_dependency(NEW.company_id::text, '#currency');
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_fiscal_periods_dependency_bump ON public.fiscal_periods;
CREATE TRIGGER trg_fiscal_periods_dependency_bump AFTER UPDATE OF reporting_currency ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.tb_dependency_bump_period();

CREATE OR REPLACE FUNCTION public.tb_dependency_bump_dictionary()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public._tb_bump_dependency('global', '#dictionary');
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_keyword_dictionary_dependency_bump ON public.keyword_dictionary;
CREATE TRIGGER trg_keyword_dictionary_dependency_bump AFTER INSERT OR UPDATE OR DELETE ON public.keyword_dictionary
  FOR EACH STATEMENT EXECUTE FUNCTION public.tb_dependency_bump_dictionary();
REVOKE ALL ON FUNCTION public.tb_dependency_bump_mapping() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tb_dependency_bump_decision() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tb_dependency_bump_company() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tb_dependency_bump_period() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tb_dependency_bump_dictionary() FROM PUBLIC, anon, authenticated;

-- What a run consulted, at the revision it consulted it (0 = absent). Insert-only.
CREATE TABLE IF NOT EXISTS public.engine_run_dependencies (
  engine_run_id uuid NOT NULL REFERENCES public.engine_runs(id) ON DELETE RESTRICT,
  scope         text NOT NULL,
  dep_key       text NOT NULL,
  revision      bigint NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (engine_run_id, scope, dep_key)
);
ALTER TABLE public.engine_run_dependencies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.engine_run_dependencies FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.engine_run_dependencies TO service_role;
CREATE OR REPLACE FUNCTION public.engine_run_dependencies_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: engine_run_dependencies is append-only. % is not permitted.', TG_OP USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_erd_append_only ON public.engine_run_dependencies;
CREATE TRIGGER trg_erd_append_only BEFORE UPDATE OR DELETE ON public.engine_run_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.engine_run_dependencies_append_only();
REVOKE ALL ON FUNCTION public.engine_run_dependencies_append_only() FROM PUBLIC, anon, authenticated;

-- Whether every dependency a run recorded is still at its recorded revision.
CREATE OR REPLACE FUNCTION public.tb_run_dependencies_current(p_engine_run_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.engine_run_dependencies d
      LEFT JOIN public.tb_dependency_revisions r ON r.scope = d.scope AND r.dep_key = d.dep_key
     WHERE d.engine_run_id = p_engine_run_id AND coalesce(r.revision, 0) <> d.revision);
$$;
REVOKE ALL ON FUNCTION public.tb_run_dependencies_current(uuid) FROM PUBLIC, anon, authenticated;

-- Whether a certification's run may carry authority: an S2 attempt, completed, every dependency still current. SECURITY
-- DEFINER so get_authoritative_certification (run as its caller) is never answered "no" by a row-level policy on
-- engine_runs; it reveals one boolean about a run id.
CREATE OR REPLACE FUNCTION public.tb_run_authoritative(p_engine_run_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.engine_runs er
                  WHERE er.id = p_engine_run_id AND er.status = 'completed' AND er.attempt_no IS NOT NULL)
     AND public.tb_run_dependencies_current(p_engine_run_id);
$$;
REVOKE ALL ON FUNCTION public.tb_run_authoritative(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tb_run_authoritative(uuid) TO authenticated, service_role;

-- ── 4. Attempt RPCs (service role only) ──────────────────────────────────────────────────────────────────────────────
-- Abandons a running run (the caller holds the upload lock: L4 → L7). Fails its reserved key. Returns whether it changed.
CREATE OR REPLACE FUNCTION public._tb_abandon_run(p_run_id uuid, p_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_status text;
BEGIN
  SELECT er.status INTO v_status FROM public.engine_runs er WHERE er.id = p_run_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'running' THEN RETURN false; END IF;
  PERFORM public._tb_attempt_writer(true);
  UPDATE public.engine_runs er
     SET status = 'abandoned', completed_at = now(), error_code = p_code,
         duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - er.started_at)) * 1000)::integer
   WHERE er.id = p_run_id;
  UPDATE public.idempotency_keys k SET status = 'failed', resolved_at = now(),
         replay_result = jsonb_build_object('status', 'failed', 'error_code', p_code)
   WHERE k.engine_run_id = p_run_id AND k.status = 'reserved';
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public._tb_abandon_run(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tb_begin_attempt(
  p_upload_id uuid, p_client_request_id uuid, p_request_hash text, p_input_hash text, p_source_file_hash text,
  p_engine_version text, p_engine_generation integer, p_actor_type text, p_firm_member_id uuid, p_actor_user_id uuid,
  p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_key public.idempotency_keys%ROWTYPE;
  v_cur public.engine_runs%ROWTYPE;
  v_cert uuid;
  v_run uuid;
  v_started timestamptz;
  v_key_id uuid;
  v_attempt integer;
  v_constraint text;
BEGIN
  IF p_upload_id IS NULL OR p_client_request_id IS NULL OR p_request_hash IS NULL OR p_engine_version IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  IF p_source_file_hash IS NULL OR p_source_file_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'INVALID_LEASE' USING ERRCODE = '22023';
  END IF;

  -- L1: one begin per upload at a time.
  PERFORM pg_advisory_xact_lock(hashtext('tb_begin_attempt'), hashtext(p_upload_id::text));

  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_FOUND');
  END IF;
  IF v_row.company_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'COMPANY_REQUIRED');
  END IF;

  -- Idempotency: the same request replays its recorded outcome; reuse with other content is a conflict.
  SELECT * INTO v_key FROM public.idempotency_keys k
   WHERE k.company_id = v_row.company_id AND k.function_name = 'process-trial-balance'
     AND k.client_request_id = p_client_request_id
     AND k.firm_member_id IS NOT DISTINCT FROM p_firm_member_id AND k.actor_user_id IS NOT DISTINCT FROM p_actor_user_id;
  IF v_key.id IS NOT NULL THEN
    IF v_key.request_hash IS DISTINCT FROM p_request_hash THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED');
    END IF;
    IF v_key.status = 'reserved' THEN
      RETURN jsonb_build_object('outcome', 'in_progress', 'engine_run_id', v_key.engine_run_id);
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'result', coalesce(v_key.replay_result, jsonb_build_object('status', v_key.status)));
  END IF;

  -- L4: the upload.
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
  IF v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_ACTIVE');
  END IF;
  IF v_row.source_file_hash IS NOT NULL AND v_row.source_file_hash IS DISTINCT FROM p_source_file_hash THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'SOURCE_CHANGED');
  END IF;
  -- A new attempt never runs over a certification still in force: re-checks go through tbu_request_reprocess first.
  SELECT c.id INTO v_cert FROM public.tb_certifications c WHERE c.upload_id = p_upload_id ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_cert IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = v_cert) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'REPROCESS_REQUIRED');
  END IF;
  -- L7: the current attempt, if one is running.
  IF v_row.current_engine_run_id IS NOT NULL THEN
    SELECT * INTO v_cur FROM public.engine_runs er WHERE er.id = v_row.current_engine_run_id FOR UPDATE;
    IF v_cur.status = 'running' THEN
      IF v_cur.lease_expires_at > now() THEN
        RETURN jsonb_build_object('outcome', 'refused', 'code', 'IN_PROGRESS', 'engine_run_id', v_cur.id);
      END IF;
      PERFORM public._tb_abandon_run(v_cur.id, 'LEASE_EXPIRED');
    END IF;
  END IF;

  PERFORM public._tb_attempt_writer(true);
  v_attempt := v_row.processing_attempt + 1;
  -- The run, its key and the upload's pointer are one unit: the same request id claimed concurrently for ANOTHER upload
  -- (the per-upload lock above does not serialize that) loses on uq_ik_claim and is a recorded conflict, with nothing left
  -- behind — never a raw error.
  BEGIN
    INSERT INTO public.engine_runs (company_id, firm_member_id, actor_user_id, actor_type, function_name, engine_version,
                                    engine_generation, input_hash, period_year, source_table, source_record_id, attempt_no,
                                    lease_expires_at)
    VALUES (v_row.company_id, p_firm_member_id, p_actor_user_id, p_actor_type, 'process-trial-balance', p_engine_version,
            p_engine_generation, p_input_hash, v_row.period_year, 'trial_balance_uploads', p_upload_id, v_attempt,
            now() + make_interval(secs => p_lease_seconds))
    RETURNING id, started_at INTO v_run, v_started;
    INSERT INTO public.idempotency_keys (company_id, firm_member_id, actor_user_id, actor_type, function_name,
                                         client_request_id, request_hash, input_hash, engine_run_id)
    VALUES (v_row.company_id, p_firm_member_id, p_actor_user_id, p_actor_type, 'process-trial-balance',
            p_client_request_id, p_request_hash, p_input_hash, v_run)
    RETURNING id INTO v_key_id;
    UPDATE public.trial_balance_uploads t
       SET current_engine_run_id = v_run, processing_attempt = v_attempt, status = 'validating',
           source_file_hash = coalesce(t.source_file_hash, p_source_file_hash)
     WHERE t.id = p_upload_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'uq_ik_claim' THEN RAISE; END IF;
    PERFORM public._tb_attempt_writer(false);
    RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED');
  END;
  PERFORM public._tb_attempt_writer(false);

  RETURN jsonb_build_object('outcome', 'claimed', 'engine_run_id', v_run, 'key_id', v_key_id, 'started_at', v_started,
                            'attempt_no', v_attempt, 'prior_status', v_row.status);
END;
$$;
REVOKE ALL ON FUNCTION public.tb_begin_attempt(uuid, uuid, text, text, text, text, integer, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_begin_attempt(uuid, uuid, text, text, text, text, integer, text, uuid, uuid, integer) TO service_role;

-- Records the current revision of each dependency key (absent = 0) for the current, running attempt; L2 first.
-- p_keys: [{ "scope": "<company id>"|"global", "key": "code:…"|"name:…"|"#framework"|"#currency"|"#dictionary" }, …]
CREATE OR REPLACE FUNCTION public.tb_snapshot_dependencies(p_engine_run_id uuid, p_keys jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_run public.engine_runs%ROWTYPE;
  r record;
  v_n integer := 0;
BEGIN
  IF p_keys IS NULL OR jsonb_typeof(p_keys) <> 'array' OR jsonb_array_length(p_keys) = 0 OR jsonb_array_length(p_keys) > 20000 THEN
    RAISE EXCEPTION 'INVALID_DEPENDENCIES' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.engine_runs er WHERE er.id = p_engine_run_id;
  IF v_run.id IS NULL OR v_run.attempt_no IS NULL OR v_run.status <> 'running'
     OR NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t WHERE t.id = v_run.source_record_id AND t.current_engine_run_id = v_run.id) THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_CURRENT' USING ERRCODE = 'PT409';
  END IF;
  IF EXISTS (SELECT 1 FROM public.engine_run_dependencies d WHERE d.engine_run_id = p_engine_run_id) THEN
    RAISE EXCEPTION 'DEPENDENCIES_ALREADY_RECORDED' USING ERRCODE = '55000';
  END IF;
  -- Each entry must be this company's scope or the shared scope, with a known key form.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_keys) e
              WHERE jsonb_typeof(e) <> 'object' OR (e->>'scope') IS NULL OR (e->>'key') IS NULL
                 OR (e->>'scope') NOT IN (v_run.company_id::text, 'global')
                 OR (e->>'key') !~ '^(code:.+|name:.*|#framework|#currency|#dictionary)$') THEN
    RAISE EXCEPTION 'INVALID_DEPENDENCIES' USING ERRCODE = '22023';
  END IF;
  -- L2: the review RPC's per-account advisory lock (company scope), in sorted order, so a review in flight on the same
  -- account completes first. Shared-chart keys are not written by the review RPC.
  FOR r IN
    SELECT DISTINCT substring(e->>'key' FROM 6) AS k
      FROM jsonb_array_elements(p_keys) e
     WHERE e->>'scope' = v_run.company_id::text AND (e->>'key' LIKE 'code:%' OR e->>'key' LIKE 'name:%')
     ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_run.company_id::text), hashtext(r.k));
  END LOOP;
  INSERT INTO public.engine_run_dependencies (engine_run_id, scope, dep_key, revision)
  SELECT DISTINCT ON (e->>'scope', e->>'key') p_engine_run_id, e->>'scope', e->>'key', coalesce(rv.revision, 0)
    FROM jsonb_array_elements(p_keys) e
    LEFT JOIN public.tb_dependency_revisions rv ON rv.scope = e->>'scope' AND rv.dep_key = e->>'key'
   ORDER BY e->>'scope', e->>'key';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('recorded', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.tb_snapshot_dependencies(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_snapshot_dependencies(uuid, jsonb) TO service_role;

-- Ends the current attempt, all or nothing. p_result:
--   { "outcome": "certified", "upload": {status, is_valid, processing_result, validation_report, accounting_errors},
--     "certification": {normalized_input_hash, output_hash, is_blocking, requires_review, exceptions, rows_snapshot} }
--   { "outcome": "failed", "error_code": "…", "upload": {…} }
CREATE OR REPLACE FUNCTION public.tb_finalize_attempt(p_engine_run_id uuid, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_upload_id uuid;
  v_row public.trial_balance_uploads%ROWTYPE;
  v_run public.engine_runs%ROWTYPE;
  v_outcome text := p_result->>'outcome';
  v_up jsonb := p_result->'upload';
  v_c jsonb := p_result->'certification';
  v_code text := p_result->>'error_code';
  v_cert uuid;
BEGIN
  IF v_outcome IS NULL OR v_outcome NOT IN ('certified', 'failed') OR jsonb_typeof(v_up) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_up->'status') IS DISTINCT FROM 'string' OR jsonb_typeof(v_up->'is_valid') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'INVALID_RESULT' USING ERRCODE = '22023';
  END IF;
  IF v_outcome = 'failed' AND (v_code IS NULL OR v_code !~ '^[A-Z][A-Z0-9_]{2,63}$') THEN
    RAISE EXCEPTION 'INVALID_RESULT: a failure needs an error code' USING ERRCODE = '22023';
  END IF;
  IF v_outcome = 'certified' AND (jsonb_typeof(v_c) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_c->'is_blocking') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_c->'requires_review') IS DISTINCT FROM 'boolean'
       OR (v_c->>'normalized_input_hash') IS NULL OR (v_c->>'output_hash') IS NULL) THEN
    RAISE EXCEPTION 'INVALID_RESULT: a certification is incomplete' USING ERRCODE = '22023';
  END IF;

  -- L4 then L7 (the run's upload is looked up unlocked, then locked first).
  SELECT er.source_record_id INTO v_upload_id FROM public.engine_runs er WHERE er.id = p_engine_run_id;
  IF v_upload_id IS NULL THEN RAISE EXCEPTION 'ATTEMPT_NOT_CURRENT' USING ERRCODE = 'PT409'; END IF;
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = v_upload_id FOR UPDATE;
  SELECT * INTO v_run FROM public.engine_runs er WHERE er.id = p_engine_run_id FOR UPDATE;
  -- The fence: only the upload's current, running attempt may finish. A late worker (preempted, expired, drained,
  -- superseded) is refused and changes nothing.
  IF v_row.id IS NULL OR v_run.attempt_no IS NULL OR v_run.status <> 'running' OR v_row.current_engine_run_id IS DISTINCT FROM v_run.id THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_CURRENT' USING ERRCODE = 'PT409';
  END IF;

  PERFORM public._tb_attempt_writer(true);

  IF v_outcome = 'certified' THEN
    -- An accepted (non-blocking, no-review) result must rest on recorded dependencies, all still current.
    IF NOT (v_c->>'is_blocking')::boolean AND NOT (v_c->>'requires_review')::boolean
       AND NOT EXISTS (SELECT 1 FROM public.engine_run_dependencies d WHERE d.engine_run_id = v_run.id) THEN
      RAISE EXCEPTION 'DEPENDENCIES_REQUIRED: an accepted result needs its dependencies recorded' USING ERRCODE = '55000';
    END IF;
    IF NOT public.tb_run_dependencies_current(v_run.id) THEN
      v_outcome := 'failed';
      v_code := 'DEPENDENCY_CHANGED';
      v_up := jsonb_build_object(
        'status', 'error', 'is_valid', false,
        'accounting_errors', jsonb_build_array(jsonb_build_object('code', 'DEPENDENCY_CHANGED',
          'message', 'A mapping, decision or setting this check used changed while it ran. Run the check again.')),
        'processing_result', jsonb_build_object('status', 'blocked', 'statements', NULL,
          'errors', jsonb_build_array(jsonb_build_object('code', 'DEPENDENCY_CHANGED',
            'message', 'A mapping, decision or setting this check used changed while it ran. Run the check again.')),
          'validation_report', '{}'::jsonb),
        'validation_report', NULL);
    END IF;
  END IF;

  IF v_outcome = 'certified' THEN
    IF v_row.source_file_hash IS NULL THEN RAISE EXCEPTION 'SOURCE_HASH_MISSING' USING ERRCODE = '55000'; END IF;
    -- L8.
    INSERT INTO public.tb_certifications (company_id, upload_id, period_year, source_file_hash, normalized_input_hash,
                                          engine_run_id, is_blocking, requires_review, exceptions, rows_snapshot)
    VALUES (v_row.company_id, v_row.id, v_row.period_year, v_row.source_file_hash, v_c->>'normalized_input_hash',
            v_run.id, (v_c->>'is_blocking')::boolean, (v_c->>'requires_review')::boolean,
            coalesce(v_c->'exceptions', '[]'::jsonb), coalesce(v_c->'rows_snapshot', '[]'::jsonb))
    RETURNING id INTO v_cert;
  END IF;

  UPDATE public.trial_balance_uploads t
     SET status            = v_up->>'status',
         is_valid          = (v_up->>'is_valid')::boolean,
         processing_result = v_up->'processing_result',
         validation_report = CASE WHEN jsonb_typeof(v_up->'validation_report') = 'object' THEN v_up->'validation_report' ELSE NULL END,
         accounting_errors = coalesce(v_up->'accounting_errors', '[]'::jsonb),
         processed_at      = now()
   WHERE t.id = v_row.id;

  UPDATE public.engine_runs er
     SET status = CASE WHEN v_outcome = 'certified' THEN 'completed' ELSE 'failed' END,
         completed_at = now(),
         duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - er.started_at)) * 1000)::integer,
         output_hash = CASE WHEN v_outcome = 'certified' THEN v_c->>'output_hash' END,
         error_code = CASE WHEN v_outcome = 'failed' THEN v_code END
   WHERE er.id = v_run.id;
  UPDATE public.idempotency_keys k
     SET status = CASE WHEN v_outcome = 'certified' THEN 'completed' ELSE 'failed' END,
         resolved_at = now(),
         replay_result = CASE WHEN v_outcome = 'certified'
           THEN jsonb_build_object('status', 'completed', 'reference_id', v_cert::text, 'reference_table', 'tb_certifications')
           ELSE jsonb_build_object('status', 'failed', 'error_code', v_code) END
   WHERE k.engine_run_id = v_run.id AND k.status = 'reserved';
  PERFORM public._tb_attempt_writer(false);

  RETURN jsonb_build_object('outcome', v_outcome, 'certification_id', v_cert, 'error_code', CASE WHEN v_outcome = 'failed' THEN v_code END);
END;
$$;
REVOKE ALL ON FUNCTION public.tb_finalize_attempt(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_finalize_attempt(uuid, jsonb) TO service_role;

-- Crash recovery: abandons attempts whose lease has expired (uploads locked first, in id order).
CREATE OR REPLACE FUNCTION public.tb_expire_attempts()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  FOR r IN
    SELECT t.id AS upload_id, er.id AS run_id
      FROM public.engine_runs er JOIN public.trial_balance_uploads t ON t.current_engine_run_id = er.id
     WHERE er.function_name = 'process-trial-balance' AND er.status = 'running' AND er.attempt_no IS NOT NULL
       AND er.lease_expires_at <= now()
     ORDER BY t.id
  LOOP
    PERFORM 1 FROM public.trial_balance_uploads t WHERE t.id = r.upload_id FOR UPDATE;
    IF public._tb_abandon_run(r.run_id, 'LEASE_EXPIRED') THEN v_n := v_n + 1; END IF;
  END LOOP;
  PERFORM public._tb_attempt_writer(false);
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.tb_expire_attempts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_expire_attempts() TO service_role;

-- An upload leaving active use (retired, superseded, discard pending, …) abandons its running attempt. The lifecycle RPC
-- already holds the upload (L4); the run is L7.
CREATE OR REPLACE FUNCTION public.trial_balance_upload_abandon_on_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.current_engine_run_id IS NOT NULL
     AND NEW.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    PERFORM public._tb_abandon_run(NEW.current_engine_run_id, 'UPLOAD_' || upper(NEW.lifecycle_state));
    PERFORM public._tb_attempt_writer(false);
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_tbu_abandon_on_lifecycle ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_abandon_on_lifecycle AFTER UPDATE OF lifecycle_state ON public.trial_balance_uploads
  FOR EACH ROW WHEN (OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state)
  EXECUTE FUNCTION public.trial_balance_upload_abandon_on_lifecycle();
REVOKE ALL ON FUNCTION public.trial_balance_upload_abandon_on_lifecycle() FROM PUBLIC, anon, authenticated;

-- ── 5. Read-time authority ───────────────────────────────────────────────────────────────────────────────────────────
-- Re-created from S1 (20261006100000) with the S2 conditions marked.
CREATE OR REPLACE FUNCTION public.get_authoritative_certification(p_company_id uuid, p_period_year integer)
 RETURNS SETOF tb_certifications
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH latest_upload AS (
    SELECT id, source_file_hash AS current_source_file_hash, current_engine_run_id
      FROM public.trial_balance_uploads
     WHERE company_id = p_company_id
       AND (p_period_year IS NULL OR period_year = p_period_year)
       AND lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')
     ORDER BY uploaded_at DESC, id DESC
     LIMIT 1
  ),
  latest_certification AS (
    SELECT c.*
      FROM public.tb_certifications c, latest_upload lu
     WHERE c.upload_id = lu.id
     ORDER BY c.sequence_no DESC
     LIMIT 1
  )
  SELECT lc.*
    FROM latest_certification lc, latest_upload lu
   WHERE lc.is_blocking = false
     AND lc.requires_review = false
     AND lu.current_source_file_hash IS NOT NULL
     AND lu.current_source_file_hash = lc.source_file_hash
     AND NOT EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = lc.id)
     -- S2: the certification belongs to the upload's CURRENT attempt, which completed, and every input it used is still
     -- what it was (a later mapping, decision or setting change makes it a re-check). Pre-S2 certifications never qualify.
     AND lu.current_engine_run_id = lc.engine_run_id
     AND public.tb_run_authoritative(lc.engine_run_id);
$function$;

-- Why one upload's latest certification is, or is not, authoritative (members of the company, or its owner).
CREATE OR REPLACE FUNCTION public.tb_upload_authority(p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_cert public.tb_certifications%ROWTYPE;
  v_run public.engine_runs%ROWTYPE;
  v_cur public.engine_runs%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  -- Only a signed-in person who can read this upload's workspace (the same answer for "absent" and "not yours").
  IF auth.uid() IS NULL OR v_row.id IS NULL OR NOT (
       (v_row.company_id IS NOT NULL AND public.tbu_can_read_prepare(v_row.company_id))
    OR EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.user_id = auth.uid() AND fm.company_id = v_row.company_id AND fm.accepted_at IS NOT NULL
                  AND public.named_user_access_active(fm.company_id, fm.user_id))
    OR (v_row.company_id IS NULL AND v_row.user_id = auth.uid())) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_cert FROM public.tb_certifications c WHERE c.upload_id = p_upload_id ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_row.current_engine_run_id IS NOT NULL THEN
    SELECT * INTO v_cur FROM public.engine_runs er WHERE er.id = v_row.current_engine_run_id;
  END IF;
  IF v_cert.id IS NOT NULL THEN
    SELECT * INTO v_run FROM public.engine_runs er WHERE er.id = v_cert.engine_run_id;
  END IF;
  v_reason := CASE
    WHEN v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN 'upload_not_active'
    WHEN v_cur.id IS NOT NULL AND v_cur.status = 'running' THEN 'attempt_running'
    WHEN v_cur.id IS NOT NULL AND v_cur.status IN ('failed', 'abandoned') THEN 'attempt_' || v_cur.status
    WHEN v_cert.id IS NULL THEN 'not_certified'
    WHEN v_run.attempt_no IS NULL THEN 'legacy_certification'
    WHEN v_row.current_engine_run_id IS DISTINCT FROM v_cert.engine_run_id THEN 'superseded_attempt'
    WHEN EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = v_cert.id) THEN 'invalidated'
    WHEN v_row.source_file_hash IS DISTINCT FROM v_cert.source_file_hash THEN 'source_changed'
    WHEN NOT public.tb_run_dependencies_current(v_cert.engine_run_id) THEN 'dependency_changed'
    WHEN v_cert.is_blocking THEN 'blocked'
    WHEN v_cert.requires_review THEN 'needs_review'
    ELSE 'current' END;
  RETURN jsonb_build_object('upload_id', p_upload_id, 'authoritative', v_reason = 'current', 'reason', v_reason,
                            'certification_id', v_cert.id, 'current_engine_run_id', v_row.current_engine_run_id,
                            'current_attempt_status', v_cur.status, 'current_attempt_code', v_cur.error_code,
                            'current_attempt_lease_expired', v_cur.status = 'running' AND v_cur.lease_expires_at <= now(),
                            'processing_attempt', v_row.processing_attempt);
END;
$$;
REVOKE ALL ON FUNCTION public.tb_upload_authority(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.tb_upload_authority(uuid) TO authenticated;

-- One upload's processing attempts, newest first (members of its workspace, or its owner; the same answer for "absent"
-- and "not yours"): attempt number, state, the reason it ended, and when.
CREATE OR REPLACE FUNCTION public.tb_upload_attempts(p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF auth.uid() IS NULL OR v_row.id IS NULL OR NOT (
       (v_row.company_id IS NOT NULL AND public.tbu_can_read_prepare(v_row.company_id))
    OR EXISTS (SELECT 1 FROM public.firm_members fm WHERE fm.user_id = auth.uid() AND fm.company_id = v_row.company_id AND fm.accepted_at IS NOT NULL
                  AND public.named_user_access_active(fm.company_id, fm.user_id))
    OR (v_row.company_id IS NULL AND v_row.user_id = auth.uid())) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('attempt_no', er.attempt_no, 'status', er.status, 'code', er.error_code,
                                        'started_at', er.started_at, 'completed_at', er.completed_at)
                     ORDER BY er.attempt_no DESC)
      FROM public.engine_runs er
     WHERE er.function_name = 'process-trial-balance' AND er.source_record_id = p_upload_id AND er.attempt_no IS NOT NULL), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.tb_upload_attempts(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.tb_upload_attempts(uuid) TO authenticated;

-- ── 6. Preemption: tbu_request_reprocess (re-created from H1 with the S2 change marked) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.tbu_request_reprocess(p_upload_id uuid, p_operation_id uuid, p_expected_source_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_hash text;
  v_prior public.tb_reprocess_requests%ROWTYPE;
  v_row public.trial_balance_uploads%ROWTYPE;
  v_member uuid;
  v_basis text;
  v_code text;
  v_cert uuid;
  v_to text;
  v_preempted uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;
  IF p_upload_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST: upload id and operation id are required' USING ERRCODE = '22023';
  END IF;

  -- Same operation id → one decision at a time (taken before the upload lock; nothing else takes this lock).
  PERFORM pg_advisory_xact_lock(hashtext('tbu_request_reprocess'), hashtext(p_operation_id::text));
  v_hash := encode(extensions.digest(p_upload_id::text || '|' || COALESCE(p_expected_source_hash, '') || '|' || v_uid::text, 'sha256'), 'hex');

  SELECT * INTO v_prior FROM public.tb_reprocess_requests r WHERE r.operation_id = p_operation_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.request_hash <> v_hash THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED', 'upload_id', p_upload_id,
                                'operation_id', p_operation_id, 'invalidated_certification_id', NULL);
    END IF;
    RETURN jsonb_build_object('outcome', CASE WHEN v_prior.outcome = 'accepted' THEN 'replayed' ELSE 'refused' END,
                              'code', v_prior.code, 'upload_id', v_prior.upload_id, 'operation_id', p_operation_id,
                              'invalidated_certification_id', v_prior.invalidated_certification_id, 'replayed', true);
  END IF;

  -- Authorization (read without a lock first: a caller with no authority never holds the upload lock).
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_row.id IS NULL THEN
    v_code := 'NOT_A_MEMBER_OF_COMPANY';
  ELSIF v_row.company_id IS NOT NULL THEN
    SELECT fm.id INTO v_member FROM public.firm_members fm
     WHERE fm.user_id = v_uid AND fm.company_id = v_row.company_id AND fm.accepted_at IS NOT NULL
       AND public.named_user_access_active(fm.company_id, fm.user_id)
     ORDER BY fm.id LIMIT 1;
    IF v_member IS NULL THEN
      v_code := 'NOT_A_MEMBER_OF_COMPANY';
    ELSIF NOT public.has_workspace_capability(v_row.company_id, v_uid, 'prepare_close') THEN
      v_code := 'CAPABILITY_REQUIRED';
    END IF;
  ELSIF v_row.user_id IS DISTINCT FROM v_uid THEN
    v_code := 'NOT_A_MEMBER_OF_COMPANY';
  END IF;
  IF v_code IS NULL AND COALESCE((public.authorize_trial_balance_processing(v_uid, p_upload_id))->>'allowed', 'false') <> 'true' THEN
    v_code := 'ENTITLEMENT_REQUIRED';
  END IF;
  -- H1a: while processing is held (a release cut-over), a new check is refused and the refusal recorded.
  IF v_code IS NULL AND NOT public.processing_control_allows(v_row.company_id) THEN
    v_code := 'PROCESSING_HELD';
  END IF;

  IF v_code IS NULL THEN
    -- Lifecycle checks under the upload row lock (upload lock only, the global lock order).
    SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
    IF v_row.id IS NULL OR v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
      v_code := 'UPLOAD_NOT_ACTIVE';
    ELSIF NOT public.tbu_upload_source_bound(p_upload_id) THEN
      v_code := 'SOURCE_NOT_BOUND';
    ELSIF v_row.source_file_hash IS NOT NULL AND v_row.source_file_hash IS DISTINCT FROM p_expected_source_hash THEN
      v_code := 'SOURCE_CHANGED';
    ELSIF EXISTS (SELECT 1 FROM public.trial_balance_upload_operations o
                   WHERE o.upload_id = p_upload_id AND o.state IN ('pending', 'purging', 'storage_cleanup_pending')) THEN
      -- A discard / sweeper / storage-cleanup claim is held.
      v_code := 'IN_PROGRESS';
    END IF;
    -- S2: a running attempt no longer answers IN_PROGRESS to an authorized request — it is preempted (abandoned,
    -- recorded), so its worker can never finish (the fence) and the new check starts clean. L4 (held) → L7.
    IF v_code IS NULL AND v_row.current_engine_run_id IS NOT NULL
       AND public._tb_abandon_run(v_row.current_engine_run_id, 'PREEMPTED') THEN
      v_preempted := v_row.current_engine_run_id;
      PERFORM public._tb_attempt_writer(false);
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    INSERT INTO public.tb_reprocess_requests (operation_id, request_hash, upload_id, company_id, actor_user_id, outcome, code)
    VALUES (p_operation_id, v_hash, p_upload_id, v_row.company_id, v_uid, 'refused', v_code);
    RETURN jsonb_build_object('outcome', 'refused', 'code', v_code, 'upload_id', p_upload_id, 'operation_id', p_operation_id,
                              'invalidated_certification_id', NULL);
  END IF;

  -- Accepted: invalidate the upload's current certification (kept unchanged as history), mark the upload for a new
  -- check, and record it — one transaction.
  SELECT c.id INTO v_cert FROM public.tb_certifications c
   WHERE c.upload_id = p_upload_id ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_cert IS NOT NULL AND EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = v_cert) THEN
    v_cert := NULL; -- already invalidated by an earlier request
  END IF;
  IF v_cert IS NOT NULL THEN
    INSERT INTO public.tb_certification_invalidations (certification_id, company_id, upload_id, reason, operation_id, actor_user_id)
    SELECT c.id, c.company_id, c.upload_id, 'reprocess_requested', p_operation_id, v_uid FROM public.tb_certifications c WHERE c.id = v_cert;
  END IF;

  v_to := CASE WHEN v_row.lifecycle_state IN ('active_processed', 'blocked') THEN 'active_processing' ELSE v_row.lifecycle_state END;
  PERFORM set_config('axiom.tbu_lifecycle_op', 'reprocess_request', true);
  UPDATE public.trial_balance_uploads t
     SET status = 'processing', is_valid = false,
         lifecycle_state = v_to,
         version = CASE WHEN v_to IS DISTINCT FROM v_row.lifecycle_state THEN t.version + 1 ELSE t.version END
   WHERE t.id = p_upload_id;
  v_basis := CASE WHEN EXISTS (SELECT 1 FROM public.companies c WHERE c.id = v_row.company_id AND c.user_id = v_uid)
                  THEN 'workspace_owner' ELSE 'explicit_capability' END;
  PERFORM public.tbu_log_event(p_upload_id, v_row.company_id, v_row.engagement_id, v_row.period_year,
    v_row.lifecycle_state, v_to, 'user', v_uid, v_member, v_basis, 'prepare_close', 'applied', p_operation_id,
    'Reprocess requested' || CASE WHEN v_cert IS NOT NULL THEN '; certification ' || v_cert::text || ' invalidated' ELSE '' END
      || CASE WHEN v_preempted IS NOT NULL THEN '; running check ' || v_preempted::text || ' preempted' ELSE '' END);
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  INSERT INTO public.tb_reprocess_requests (operation_id, request_hash, upload_id, company_id, actor_user_id, outcome, code, invalidated_certification_id)
  VALUES (p_operation_id, v_hash, p_upload_id, v_row.company_id, v_uid, 'accepted', 'ACCEPTED', v_cert);

  RETURN jsonb_build_object('outcome', 'accepted', 'code', 'ACCEPTED', 'upload_id', p_upload_id, 'operation_id', p_operation_id,
                            'invalidated_certification_id', v_cert, 'preempted_engine_run_id', v_preempted);
END;
$function$;

-- ── 7. Lock order: upload (L4) before operation (L6) ─────────────────────────────────────────────────────────────────
-- Re-created from 20260923140000/20260927100000 text with only the lock order changed: the upload id is read unlocked,
-- the upload is locked, then the operation, and the operation's state is re-read under its lock.
CREATE OR REPLACE FUNCTION public.tbu_abort_discard(p_operation_id uuid, p_actor_kind text, p_actor uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_row public.trial_balance_uploads%ROWTYPE;
  v_target text;
  v_upload uuid;
BEGIN
  SELECT o.upload_id INTO v_upload FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard';
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = v_upload FOR UPDATE;
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard' FOR UPDATE;
  IF v_op.id IS NULL OR v_op.state <> 'pending' THEN RETURN 'not_eligible'; END IF;
  PERFORM set_config('axiom.tbu_lifecycle_op', 'discard_abort', true);
  IF v_row.id IS NOT NULL AND v_row.lifecycle_state = 'discard_pending' THEN
    IF v_row.company_id IS NOT NULL AND v_row.period_year IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.trial_balance_uploads t
          WHERE t.company_id = v_row.company_id AND t.period_year = v_row.period_year AND t.id <> v_row.id
            AND t.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')) THEN
      v_target := 'retired';
      UPDATE public.trial_balance_uploads t
         SET lifecycle_state = 'retired', retired_at = now(), version = t.version + 1,
             retired_reason = 'Discard not completed while another trial balance became active for this period; kept as history.'
       WHERE t.id = v_row.id;
    ELSE
      v_target := public.tbu_derived_active_state(v_row);
      UPDATE public.trial_balance_uploads t SET lifecycle_state = v_target, version = t.version + 1 WHERE t.id = v_row.id;
    END IF;
    PERFORM public.tbu_log_event(v_row.id, v_row.company_id, v_row.engagement_id, v_row.period_year, 'discard_pending', v_target,
      p_actor_kind, p_actor, NULL, CASE WHEN p_actor_kind = 'engine' THEN 'engine' ELSE v_op.authority_basis END, NULL,
      'applied', v_op.id, p_reason);
  END IF;
  UPDATE public.trial_balance_upload_operations o SET state = 'aborted', completed_at = now() WHERE o.id = v_op.id;
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);
  RETURN 'aborted';
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_trial_balance_discard(p_operation_id uuid)
 RETURNS TABLE(outcome discard_outcome, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_row public.trial_balance_uploads%ROWTYPE;
  v_auth record;
  v_upload uuid;
BEGIN
  -- S2 lock order: the upload (L4) before the operation (L6).
  SELECT o.upload_id INTO v_upload FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard';
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = v_upload FOR UPDATE;
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard' FOR UPDATE;
  IF v_op.id IS NULL THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, 'This discard has already completed or was never started.'::text; RETURN;
  END IF;

  SELECT * INTO v_auth FROM public.tbu_authorize(v_op.company_id);
  IF v_auth.basis IS NULL THEN
    PERFORM public.tbu_log_event(v_op.upload_id, v_op.company_id, NULL, v_op.period_year, 'discard_pending', NULL,
      'user', auth.uid(), NULL, NULL, 'manage_source_files', 'denied', v_op.id, 'discard completion refused: no workspace authority');
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, 'You don''t have permission to manage this workspace''s source files.'::text; RETURN;
  END IF;

  IF v_op.state = 'aborted' THEN
    RETURN QUERY SELECT 'stale_version'::public.discard_outcome,
      'This discard was not completed in time and was cancelled; the trial balance was kept. Refresh and try again.'::text; RETURN;
  END IF;
  IF v_op.state <> 'pending' THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::text; RETURN;
  END IF;

  IF v_row.id IS NOT NULL AND public.tbu_upload_evidence(v_row.id) IS NOT NULL THEN
    PERFORM public.tbu_abort_discard(v_op.id, 'user', auth.uid(), 'Discard aborted: evidence appeared during the saga');
    RETURN QUERY SELECT 'replacement_required'::public.discard_outcome,
      'This trial balance acquired processing history during the discard. Upload a replacement instead.'::text; RETURN;
  END IF;

  PERFORM set_config('axiom.tbu_lifecycle_op', 'discard', true);
  IF v_row.id IS NOT NULL THEN
    DELETE FROM public.trial_balance_uploads t WHERE t.id = v_row.id AND t.lifecycle_state = 'discard_pending';
    PERFORM public.tbu_log_event(v_row.id, v_row.company_id, v_row.engagement_id, v_row.period_year, 'discard_pending', 'discarded',
      'user', auth.uid(), v_auth.membership_id, v_auth.basis, v_auth.capability, 'applied', v_op.id, 'Hard discard completed');
  END IF;
  UPDATE public.trial_balance_upload_operations o SET state = 'completed', completed_at = now() WHERE o.id = v_op.id;
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  RETURN QUERY SELECT 'deleted_now'::public.discard_outcome, NULL::text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tbu_sweeper_complete(p_kind text, p_target_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_res public.trial_balance_source_reservations%ROWTYPE;
  v_upload uuid;
BEGIN
  IF p_kind = 'stale_discard' THEN
    -- S2 lock order: the upload (L4) before the operation (L6).
    SELECT o.upload_id INTO v_upload FROM public.trial_balance_upload_operations o WHERE o.id = p_target_id AND o.kind = 'discard';
    PERFORM 1 FROM public.trial_balance_uploads t WHERE t.id = v_upload FOR UPDATE;
    SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_target_id AND o.kind = 'discard' FOR UPDATE;
    IF v_op.id IS NULL THEN RETURN 'stale'; END IF;
    IF v_op.state <> 'pending' OR v_op.created_at > now() - public.tbu_stale_discard_grace() THEN RETURN 'not_eligible'; END IF;
    RETURN public.tbu_abort_discard(v_op.id, 'engine', NULL, 'Discard never completed; resolved by the scheduled source sweeper');
  END IF;

  IF p_kind IN ('discard', 'cancel_replacement') THEN
    SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_target_id AND o.kind = p_kind FOR UPDATE;
    IF v_op.id IS NULL THEN RETURN 'stale'; END IF;

    IF p_kind = 'discard' THEN
      IF v_op.state = 'purged' THEN RETURN 'already_done'; END IF;
      IF v_op.state NOT IN ('completed', 'purging') OR v_op.completed_at > now() - public.tbu_undo_window() THEN RETURN 'not_eligible'; END IF;
      IF public.tbu_storage_object_exists(v_op.file_path) THEN RETURN 'storage_cleanup_pending'; END IF;
      UPDATE public.trial_balance_upload_operations o SET state = 'purged' WHERE o.id = v_op.id;
      PERFORM public.tbu_log_event(v_op.upload_id, v_op.company_id, NULL, v_op.period_year, 'discarded', 'discarded',
        'engine', NULL, NULL, 'engine', NULL, 'applied', v_op.id, 'Discarded source purged by the scheduled source sweeper after the undo window');
      RETURN 'purged';
    END IF;

    IF v_op.state = 'completed' THEN RETURN 'already_done'; END IF;
    IF v_op.state <> 'storage_cleanup_pending' THEN RETURN 'not_eligible'; END IF;
    IF public.tbu_storage_object_exists(v_op.file_path) THEN RETURN 'storage_cleanup_pending'; END IF;
    UPDATE public.trial_balance_upload_operations o SET state = 'completed', completed_at = now() WHERE o.id = v_op.id;
    RETURN 'completed';
  END IF;

  IF p_kind = 'reservation' THEN
    SELECT * INTO v_res FROM public.trial_balance_source_reservations s WHERE s.id = p_target_id FOR UPDATE;
    IF v_res.id IS NULL THEN RETURN 'stale'; END IF;
    IF v_res.consumed_at IS NOT NULL OR v_res.expires_at > now() - public.tbu_reservation_sweep_grace() THEN RETURN 'not_eligible'; END IF;
    IF public.tbu_storage_object_exists(v_res.object_path) THEN RETURN 'storage_cleanup_pending'; END IF;
    UPDATE public.trial_balance_source_reservations s SET swept_at = now() WHERE s.id = v_res.id;
    RETURN 'reclaimed';
  END IF;

  RETURN 'invalid_request';
END;
$function$;

-- H1's drain, re-created: closes pre-hold runs as ABANDONED (DRAINED_AT_CUTOVER), locking their uploads (L4) before the
-- runs (L7), and returns only ACTIVE uploads to the queue (H1 also tried to re-queue a historical upload left at
-- 'validating', which its history guard refuses — the whole drain then failed); otherwise unchanged.
CREATE OR REPLACE FUNCTION public.admin_drain_processing(p_minimum_hold_seconds integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_c public.processing_release_control%ROWTYPE;
  v_runs uuid[];
  v_keys integer;
  v_uploads integer;
  v_detail jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_uid AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF p_minimum_hold_seconds IS NULL OR p_minimum_hold_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'INVALID_DRAIN_BOUND' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_c FROM public.processing_release_control c WHERE c.singleton FOR UPDATE;
  IF NOT v_c.hold THEN RAISE EXCEPTION 'NOT_HELD' USING ERRCODE = '55000'; END IF;
  IF now() < v_c.held_at + make_interval(secs => p_minimum_hold_seconds) THEN
    RAISE EXCEPTION 'DRAIN_TOO_EARLY: the hold must last at least % seconds', p_minimum_hold_seconds USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('axiom.processing_control_writer', txid_current()::text, true);
  -- L4 before L7: the uploads of the runs to close, in id order.
  PERFORM 1 FROM public.trial_balance_uploads t
   WHERE t.id IN (SELECT er.source_record_id FROM public.engine_runs er
                   WHERE er.function_name = 'process-trial-balance' AND er.status = 'running' AND er.started_at < v_c.held_at)
   ORDER BY t.id FOR UPDATE;
  WITH closed AS (
    UPDATE public.engine_runs er
       SET status = 'abandoned', completed_at = now(),
           duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - er.started_at)) * 1000)::integer,
           error_code = 'DRAINED_AT_CUTOVER'
     WHERE er.function_name = 'process-trial-balance' AND er.status = 'running' AND er.started_at < v_c.held_at
    RETURNING er.id)
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_runs FROM closed;
  UPDATE public.idempotency_keys k SET status = 'failed', resolved_at = now()
   WHERE k.engine_run_id = ANY (v_runs) AND k.status = 'reserved';
  GET DIAGNOSTICS v_keys = ROW_COUNT;
  -- An upload left 'validating' with no live run for it goes back to the queue; one a live (post-hold canary) run is
  -- processing is left alone.
  UPDATE public.trial_balance_uploads t SET status = 'processing'
   WHERE t.status = 'validating'
     AND t.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')
     AND NOT EXISTS (SELECT 1 FROM public.engine_runs er
                      WHERE er.function_name = 'process-trial-balance' AND er.status = 'running'
                        AND er.source_record_id = t.id);
  GET DIAGNOSTICS v_uploads = ROW_COUNT;
  PERFORM set_config('axiom.processing_control_writer', '', true);
  v_detail := jsonb_build_object('runs_closed', coalesce(array_length(v_runs, 1), 0), 'run_ids', to_jsonb(v_runs),
                                 'keys_failed', v_keys, 'uploads_requeued', v_uploads, 'minimum_hold_seconds', p_minimum_hold_seconds);
  INSERT INTO public.processing_release_control_events (actor_user_id, action, before_state, after_state, reason, detail)
  VALUES (v_uid, 'drain', public._processing_control_state(), public._processing_control_state(), btrim(p_reason), v_detail);
  RETURN v_detail;
END;
$function$;
