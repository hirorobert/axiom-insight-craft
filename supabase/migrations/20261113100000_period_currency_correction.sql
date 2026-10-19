-- 20261113100000_period_currency_correction.sql — correct a reporting period's currency while nothing has been accepted
-- in it (owner-approved currency-recovery repair, 2026-10-19). Forward-only.
--
-- The defect: the period's reporting currency is locked (fiscal_periods_processing_lock, 20261009100000) as soon as ANY
-- trial balance in it has been processed — including a check that was refused BECAUSE of the currency (a blocking
-- CURRENCY_MISMATCH certification). Nothing could correct it: Replace re-checked against the same currency and the
-- period setup refused another currency (CURRENCY_DIFFERS_FROM_EXISTING). A user who picked the wrong currency was stuck.
--
-- The repair: ONE authorised server operation, correct_period_currency, changes the currency only while the period is
-- eligible, recording the old and new currency, the actor, the reason and the time in fiscal_period_events. Nothing
-- else changes: no amount is converted, no source byte touched, no certification or history altered.
--
-- ELIGIBILITY (_period_currency_correction_block; NULL = eligible). The trial balances of the period are the ones
-- _period_has_processing considers (period_id, or the legacy company + year link). Correction is refused when ANY of:
--   1. ACCEPTED_CERTIFICATION   a tb_certifications row of those uploads with is_blocking = false — whether or not it
--                               requires review: a certification that requires review still accepted amounts parsed in
--                               the old currency, and review decisions build on it. Blocking certifications (the check
--                               refused the file, e.g. CURRENCY_MISMATCH) accept nothing and stay as history.
--   2. DOWNSTREAM_RECORD        any row in a table that references those uploads, the period, or their certifications
--                               by foreign key, or that is keyed by the period's company and year — found by a
--                               catalogue scan (so a future table is covered without a change here; unknown = refuse),
--                               except the processing and setup bookkeeping listed in _period_currency_bookkeeping().
--   3. PROCESSING_IN_PROGRESS   a process-trial-balance run on those uploads that is still running within its lease.
--   4. PERIOD_LOCKED            the period itself is locked (status 'locked').
--
-- CONCURRENCY (one protocol with the competing paths):
--   * Lock order is the existing global order: the period's uploads FOR UPDATE (ordered by id), then the period row FOR
--     UPDATE — the order tb_finalize_attempt uses (upload, then the period through the lifecycle trigger). Eligibility is
--     evaluated only after both locks are held, so it is atomic with the change.
--   * Before any row lock, the operation takes a SHARE lock on EVERY dependent table (_period_currency_dependent_relations:
--     every table outside the bookkeeping list that references the uploads, the period or their certifications by foreign
--     key, or is keyed by company and period), one at a time in ascending schema-qualified name order. SHARE conflicts
--     with every INSERT/UPDATE/DELETE: a dependent write that began earlier commits first and is then SEEN by the
--     eligibility scan (refused); one that begins later waits until the correction's transaction ends. No dependent
--     record can commit unseen in between, whether or not it has a foreign key.
--   * LOCK BUDGET: acquiring ALL locks (the table locks, then the row locks) shares ONE 5-second budget, enforced by
--     setting lock_timeout to the remaining budget before each acquisition. It bounds lock WAITING only — not the
--     transaction. Once every lock is held, the rest is a fixed handful of statements on this one period (the
--     eligibility scan, one UPDATE, one INSERT) with no storage, network or edge-function call; the re-checks run
--     afterwards, from the browser, in their own transactions. The caller's statement_timeout (PostgREST's role
--     setting) still bounds the whole call.
--   * Budget exhausted, or a deadlock detected (deadlock_timeout), at ANY point after the request-id lock: everything
--     the operation did is rolled back (one subtransaction) and the answer is 'busy'; nothing changed and the same
--     request id may be retried. Locks taken before the failure are released then.
--   * Cross-company effect: a table lock is table-wide, so a write to a dependent table by ANY company waits while a
--     correction holds its locks (from acquisition to commit: the few statements above). Corrections are rare,
--     explicit, member-initiated operations on refused-currency periods.
--   * Writers that reference an upload or the period by foreign key also take a KEY SHARE lock on it, which FOR UPDATE
--     blocks.
--   * A check that read the old currency cannot certify against the new one: the currency change bumps the '#currency'
--     dependency revision (trg_fiscal_periods_dependency_bump, 20261008100000) and process-trial-balance re-reads the
--     currency after its snapshot, so tb_finalize_attempt refuses it (DEPENDENCY_CHANGED); nothing is certified.
--   * Idempotency: one request id applies once; a retry answers already_corrected with the same event.
--   * Version check: the caller states the currency it is correcting from; a period changed meanwhile answers stale.
--
-- RE-CHECK: the answer names, for each active trial balance of the period, a deterministic re-check operation id
-- (derived from the correction event and the upload), so the browser's normal path — tbu_request_reprocess, then
-- process-trial-balance with the same id — is idempotent across retries and a failed start can be retried exactly.

DO $preflight$
BEGIN
  IF to_regprocedure('public.fiscal_periods_processing_lock()') IS NULL OR to_regprocedure('public._period_has_processing(uuid)') IS NULL
     OR to_regclass('public.fiscal_period_events') IS NULL OR to_regprocedure('public.tb_dependency_bump_period()') IS NULL
     OR to_regprocedure('public.workspace_capability_allowed(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.named_user_access_active(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the period, processing and authority functions this repair extends are missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.correct_period_currency(uuid,text,text,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the period currency correction is already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── The history records the correction ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.fiscal_period_events DROP CONSTRAINT chk_fpe_action;
ALTER TABLE public.fiscal_period_events ADD CONSTRAINT chk_fpe_action
  CHECK (action IN ('created', 'dates_confirmed', 'prior_linked', 'legacy_dates_completed', 'currency_corrected'));
CREATE UNIQUE INDEX uq_fpe_currency_request ON public.fiscal_period_events ((detail->>'request_id'))
  WHERE action = 'currency_corrected';

-- ── The processing lock admits exactly the correction ───────────────────────────────────────────────────────────────
-- Unchanged except one marked branch: the currency (never the dates) may change after processing when, and only when,
-- correct_period_currency set its transaction marker after evaluating eligibility under its locks.
CREATE OR REPLACE FUNCTION public.fiscal_periods_processing_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_legacy BOOLEAN := coalesce(current_setting('axiom.legacy_period_dates', true), '') = txid_current()::text;
  v_correction BOOLEAN := coalesce(current_setting('axiom.period_currency_correction', true), '') = txid_current()::text; -- [20261113100000]
BEGIN
  IF NEW.reporting_currency IS NOT DISTINCT FROM OLD.reporting_currency
     AND NEW.reporting_start IS NOT DISTINCT FROM OLD.reporting_start
     AND NEW.reporting_end IS NOT DISTINCT FROM OLD.reporting_end THEN
    RETURN NEW;
  END IF;
  IF NOT public._period_has_processing(OLD.id) THEN
    RETURN NEW;
  END IF;
  -- The only change allowed after processing: complete_legacy_period_dates completing a legacy period's dates
  -- (never the currency, never dates that were already confirmed).
  IF v_legacy AND NEW.reporting_currency IS NOT DISTINCT FROM OLD.reporting_currency
     AND OLD.dates_basis IS DISTINCT FROM 'confirmed' THEN
    RETURN NEW;
  END IF;
  -- [20261113100000] … and correct_period_currency correcting the currency (never the dates) of an eligible period.
  IF v_correction AND NEW.reporting_start IS NOT DISTINCT FROM OLD.reporting_start
     AND NEW.reporting_end IS NOT DISTINCT FROM OLD.reporting_end THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PERIOD_LOCKED_BY_PROCESSING: the currency and dates of a period are fixed once a trial balance in it has been processed. [period=%]', OLD.id
    USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION public.fiscal_periods_processing_lock() FROM PUBLIC, anon, authenticated;

-- ── Eligibility ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Processing and setup bookkeeping: rows that exist because a file was uploaded, drafted, checked, refused, laid out or
-- set up — never work built on the period's amounts. Everything else that references the period is downstream.
CREATE OR REPLACE FUNCTION public._period_currency_bookkeeping()
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT ARRAY[
    'public.trial_balance_uploads',             -- the uploads themselves (replacement / supersession links)
    'public.fiscal_periods',                    -- the period (active upload pointer, prior-period link)
    'public.fiscal_period_events',              -- the period's own setup history
    'public.engagements',                       -- the engagement the period belongs to
    'public.tb_certifications',                 -- considered explicitly (rule 1): only blocking ones get here
    'public.tb_certification_findings',         -- the complete findings of those blocking certifications
    'public.tb_certification_invalidations',    -- re-check bookkeeping of those certifications
    'public.layout_confirmations',              -- the file's confirmed column layout (no amount, no currency)
    'public.engine_runs',                       -- processing attempts
    'public.trial_balance_draft_commits',       -- draft-to-upload commits
    'public.trial_balance_upload_lifecycle_events',
    'public.trial_balance_upload_operations',
    'public.onboarding_progress',               -- first-run guidance state (no financial content)
    'public.upload_integrity_findings'          -- the scheduled identity sweep's flags (engagement/company/period
                                                -- mismatches): no amount, no currency, nothing built on either
  ]::text[];
$$;
REVOKE ALL ON FUNCTION public._period_currency_bookkeeping() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._period_currency_correction_block(p_period_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_p public.fiscal_periods%ROWTYPE;
  v_year integer;
  v_uploads uuid[];
  v_certs uuid[];
  v_cert record;
  r record;
  v_found boolean;
  v_allow text[] := public._period_currency_bookkeeping();
BEGIN
  SELECT * INTO v_p FROM public.fiscal_periods p WHERE p.id = p_period_id;
  IF v_p.id IS NULL THEN
    RETURN jsonb_build_object('code', 'NOT_FOUND');
  END IF;
  IF to_jsonb(v_p)->>'status' = 'locked' THEN
    RETURN jsonb_build_object('code', 'PERIOD_LOCKED', 'relation', 'public.fiscal_periods', 'record_id', v_p.id);
  END IF;
  v_year := EXTRACT(YEAR FROM v_p.fiscal_year_end)::integer;
  SELECT coalesce(array_agg(t.id ORDER BY t.id), '{}') INTO v_uploads FROM public.trial_balance_uploads t
   WHERE t.period_id = v_p.id OR (t.period_id IS NULL AND t.company_id = v_p.company_id AND t.period_year = v_year);

  -- 1. An accepted certification (requires_review included).
  SELECT c.id, c.upload_id, c.requires_review, c.certified_at INTO v_cert FROM public.tb_certifications c
   WHERE c.upload_id = ANY (v_uploads) AND NOT c.is_blocking ORDER BY c.certified_at LIMIT 1;
  IF v_cert.id IS NOT NULL THEN
    RETURN jsonb_build_object('code', 'ACCEPTED_CERTIFICATION', 'relation', 'public.tb_certifications', 'record_id', v_cert.id,
                              'upload_id', v_cert.upload_id, 'requires_review', v_cert.requires_review, 'certified_at', v_cert.certified_at);
  END IF;
  SELECT coalesce(array_agg(c.id), '{}') INTO v_certs FROM public.tb_certifications c WHERE c.upload_id = ANY (v_uploads);

  -- 3. A check still running within its lease.
  SELECT er.id, er.source_record_id INTO r FROM public.engine_runs er
   WHERE er.function_name = 'process-trial-balance' AND er.status = 'running' AND er.source_record_id = ANY (v_uploads)
     AND (er.lease_expires_at IS NULL OR er.lease_expires_at > clock_timestamp()) LIMIT 1;
  IF r.id IS NOT NULL THEN
    RETURN jsonb_build_object('code', 'PROCESSING_IN_PROGRESS', 'relation', 'public.engine_runs', 'record_id', r.id, 'upload_id', r.source_record_id);
  END IF;

  -- 2. Downstream: every foreign key into the uploads, the period or its certifications …
  FOR r IN
    SELECT c.confrelid AS target, format('%I.%I', n.nspname, cl.relname) AS rel, n.nspname AS sch, cl.relname AS tbl, a.attname AS col
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class cl ON cl.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
       AND c.confrelid IN ('public.trial_balance_uploads'::regclass, 'public.fiscal_periods'::regclass, 'public.tb_certifications'::regclass)
     ORDER BY 2, 5
  LOOP
    CONTINUE WHEN r.rel = ANY (v_allow);
    IF r.target = 'public.trial_balance_uploads'::regclass THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = ANY ($1))', r.sch, r.tbl, r.col) INTO v_found USING v_uploads;
    ELSIF r.target = 'public.fiscal_periods'::regclass THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)', r.sch, r.tbl, r.col) INTO v_found USING v_p.id;
    ELSE
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = ANY ($1))', r.sch, r.tbl, r.col) INTO v_found USING v_certs;
    END IF;
    IF v_found THEN
      RETURN jsonb_build_object('code', 'DOWNSTREAM_RECORD', 'relation', r.rel, 'column', r.col);
    END IF;
  END LOOP;
  -- … and every table keyed by the period's company and year.
  FOR r IN
    SELECT format('%I.%I', t.table_schema, t.table_name) AS rel, t.table_schema AS sch, t.table_name AS tbl
      FROM information_schema.tables t
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = t.table_schema AND k.table_name = t.table_name AND k.column_name = 'company_id')
       AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = t.table_schema AND k.table_name = t.table_name AND k.column_name = 'period_year')
     ORDER BY 1
  LOOP
    CONTINUE WHEN r.rel = ANY (v_allow);
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE company_id = $1 AND period_year = $2)', r.sch, r.tbl) INTO v_found USING v_p.company_id, v_year;
    IF v_found THEN
      RETURN jsonb_build_object('code', 'DOWNSTREAM_RECORD', 'relation', r.rel, 'column', 'company_id, period_year');
    END IF;
  END LOOP;
  -- … and every table keyed by the company and the text reporting period id the financial statements use ('FY' || year).
  FOR r IN
    SELECT format('%I.%I', t.table_schema, t.table_name) AS rel, t.table_schema AS sch, t.table_name AS tbl
      FROM information_schema.tables t
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = t.table_schema AND k.table_name = t.table_name AND k.column_name = 'company_id')
       AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = t.table_schema AND k.table_name = t.table_name AND k.column_name = 'reporting_period_id' AND k.data_type = 'text')
     ORDER BY 1
  LOOP
    CONTINUE WHEN r.rel = ANY (v_allow);
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE company_id = $1 AND reporting_period_id = $2)', r.sch, r.tbl) INTO v_found USING v_p.company_id, 'FY' || v_year::text;
    IF v_found THEN
      RETURN jsonb_build_object('code', 'DOWNSTREAM_RECORD', 'relation', r.rel, 'column', 'company_id, reporting_period_id');
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._period_currency_correction_block(uuid) FROM PUBLIC, anon, authenticated;

-- The caller's authority to change a period's setup: the same rule as period setup (open_engagement_with_period): an
-- accepted, active member holding prepare_close (which includes a current plan). Returns the member id or NULL.
CREATE OR REPLACE FUNCTION public._period_currency_actor(p_company_id uuid, p_user uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT fm.id FROM public.firm_members fm
   WHERE fm.user_id = p_user AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL
     AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close')
   ORDER BY fm.id LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._period_currency_actor(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── Read: may this period's currency be corrected, and if not, which record prevents it ─────────────────────────────
-- Answers only to a member who could correct it (anyone else learns nothing: not_found).
CREATE OR REPLACE FUNCTION public.get_period_currency_correction(p_period_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_p public.fiscal_periods%ROWTYPE;
  v_block jsonb;
  v_last jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('outcome', 'unauthenticated'); END IF;
  SELECT * INTO v_p FROM public.fiscal_periods p WHERE p.id = p_period_id;
  IF v_p.id IS NULL OR public._period_currency_actor(v_p.company_id, auth.uid()) IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  v_block := public._period_currency_correction_block(v_p.id);
  -- The latest recorded correction (with its deterministic re-check ids), so a page reloaded after a correction whose
  -- re-check did not start can still offer that exact re-check. Reason and actor stay in the event, not in this read.
  SELECT jsonb_build_object('event_id', e.id, 'from', e.detail->>'from', 'to', e.detail->>'to',
                            'occurred_at', e.occurred_at, 'rechecks', e.detail->'rechecks')
    INTO v_last
    FROM public.fiscal_period_events e
   WHERE e.period_id = v_p.id AND e.action = 'currency_corrected'
   ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1;
  RETURN jsonb_build_object('outcome', CASE WHEN v_block IS NULL THEN 'eligible' ELSE 'not_eligible' END,
                            'period_id', v_p.id, 'currency', v_p.reporting_currency, 'block', v_block,
                            'last_correction', v_last);
END;
$$;
REVOKE ALL ON FUNCTION public.get_period_currency_correction(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_period_currency_correction(uuid) TO authenticated;

-- Every dependent table (see CONCURRENCY), each once, in a stable order: the tables the eligibility scan reads, outside
-- the bookkeeping list. Read from the catalogue at call time, so a table added later is covered without a change here.
CREATE OR REPLACE FUNCTION public._period_currency_dependent_relations()
RETURNS SETOF regclass LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT d.qualified::regclass FROM (
    SELECT format('%I.%I', n.nspname, cl.relname) AS qualified
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class cl ON cl.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
       AND c.confrelid IN ('public.trial_balance_uploads'::regclass, 'public.fiscal_periods'::regclass, 'public.tb_certifications'::regclass)
    UNION
    SELECT format('%I.%I', t.table_schema, t.table_name)
      FROM information_schema.tables t
     WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = t.table_schema AND k.table_name = t.table_name AND k.column_name = 'company_id')
       AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = t.table_schema AND k.table_name = t.table_name
                    AND (k.column_name = 'period_year' OR (k.column_name = 'reporting_period_id' AND k.data_type = 'text')))
  ) d
  WHERE d.qualified <> ALL (public._period_currency_bookkeeping())
  ORDER BY d.qualified;
$$;
REVOKE ALL ON FUNCTION public._period_currency_dependent_relations() FROM PUBLIC, anon, authenticated;

-- ── The one authorised operation ─────────────────────────────────────────────────────────────────────────────────────
-- Outcomes: corrected | already_corrected | unchanged | stale | not_eligible | busy | not_found | invalid_request |
--           request_conflict | unauthenticated.
CREATE OR REPLACE FUNCTION public.correct_period_currency(p_period_id uuid, p_new_currency text, p_expected_currency text,
                                                          p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_new text := upper(btrim(coalesce(p_new_currency, '')));
  v_expected text := upper(btrim(coalesce(p_expected_currency, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_p public.fiscal_periods%ROWTYPE;
  v_prior public.fiscal_period_events%ROWTYPE;
  v_member uuid;
  v_block jsonb;
  v_event uuid;
  v_year integer;
  v_rechecks jsonb;
  v_rel regclass;
  v_timeout text;
  v_deadline timestamptz;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('outcome', 'unauthenticated'); END IF;
  IF p_period_id IS NULL OR p_request_id IS NULL OR v_new !~ '^[A-Z]{3}$' OR v_expected !~ '^[A-Z]{3}$'
     OR length(v_reason) NOT BETWEEN 3 AND 500 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currency_registry cr WHERE cr.code = v_new) THEN
    RETURN jsonb_build_object('outcome', 'invalid_request', 'code', 'UNKNOWN_CURRENCY');
  END IF;

  -- One decision per request id at a time; a retry of an applied request answers the same event.
  PERFORM pg_advisory_xact_lock(hashtext('correct_period_currency'), hashtext(p_request_id::text));
  SELECT * INTO v_prior FROM public.fiscal_period_events e
   WHERE e.action = 'currency_corrected' AND e.detail->>'request_id' = p_request_id::text;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.period_id <> p_period_id OR v_prior.detail->>'to' <> v_new OR v_prior.detail->>'from' <> v_expected OR v_prior.actor_user_id IS DISTINCT FROM v_uid THEN
      RETURN jsonb_build_object('outcome', 'request_conflict');
    END IF;
    RETURN jsonb_build_object('outcome', 'already_corrected', 'event_id', v_prior.id, 'period_id', v_prior.period_id,
                              'from', v_prior.detail->>'from', 'to', v_prior.detail->>'to', 'rechecks', v_prior.detail->'rechecks');
  END IF;

  -- Authority (read without locks first: a caller without it never holds a lock).
  SELECT * INTO v_p FROM public.fiscal_periods p WHERE p.id = p_period_id;
  IF v_p.id IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  v_member := public._period_currency_actor(v_p.company_id, v_uid);
  IF v_member IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;

  -- Every lock below shares one 5-second acquisition budget (see CONCURRENCY); a lock wait past it, or a deadlock, rolls
  -- this whole block back and answers 'busy'. lock_timeout is set to the REMAINING budget before each acquisition.
  v_timeout := current_setting('lock_timeout');
  v_deadline := clock_timestamp() + interval '5 seconds';
  BEGIN
    -- Serialise with every dependent writer first: SHARE on each dependent table, in ascending name order.
    FOR v_rel IN SELECT r FROM public._period_currency_dependent_relations() r LOOP
      IF clock_timestamp() >= v_deadline THEN RAISE EXCEPTION 'lock budget exhausted' USING ERRCODE = 'lock_not_available'; END IF;
      PERFORM set_config('lock_timeout', greatest(1, floor(extract(epoch FROM (v_deadline - clock_timestamp())) * 1000))::bigint || 'ms', true);
      EXECUTE format('LOCK TABLE %s IN SHARE MODE', v_rel);
    END LOOP;

    -- Row locks, in the global order: the period's uploads (by id), then the period.
    IF clock_timestamp() >= v_deadline THEN RAISE EXCEPTION 'lock budget exhausted' USING ERRCODE = 'lock_not_available'; END IF;
    PERFORM set_config('lock_timeout', greatest(1, floor(extract(epoch FROM (v_deadline - clock_timestamp())) * 1000))::bigint || 'ms', true);
    v_year := EXTRACT(YEAR FROM v_p.fiscal_year_end)::integer;
    PERFORM 1 FROM public.trial_balance_uploads t
     WHERE t.period_id = v_p.id OR (t.period_id IS NULL AND t.company_id = v_p.company_id AND t.period_year = v_year)
     ORDER BY t.id FOR UPDATE;
    IF clock_timestamp() >= v_deadline THEN RAISE EXCEPTION 'lock budget exhausted' USING ERRCODE = 'lock_not_available'; END IF;
    PERFORM set_config('lock_timeout', greatest(1, floor(extract(epoch FROM (v_deadline - clock_timestamp())) * 1000))::bigint || 'ms', true);
    SELECT * INTO v_p FROM public.fiscal_periods p WHERE p.id = p_period_id FOR UPDATE;
    PERFORM set_config('lock_timeout', v_timeout, true);

    IF v_p.reporting_currency IS DISTINCT FROM v_expected THEN
      RETURN jsonb_build_object('outcome', 'stale', 'currency', v_p.reporting_currency);
    END IF;
    IF v_p.reporting_currency = v_new THEN
      RETURN jsonb_build_object('outcome', 'unchanged', 'currency', v_p.reporting_currency);
    END IF;
    v_block := public._period_currency_correction_block(v_p.id);
    IF v_block IS NOT NULL THEN
      RETURN jsonb_build_object('outcome', 'not_eligible', 'currency', v_p.reporting_currency, 'block', v_block);
    END IF;

    v_event := gen_random_uuid();
    -- The active trial balances to re-check, each with a deterministic operation id (retries reuse it).
    SELECT coalesce(jsonb_agg(jsonb_build_object('upload_id', t.id,
             'operation_id', (md5('period-currency-recheck|' || v_event::text || '|' || t.id::text))::uuid) ORDER BY t.id), '[]'::jsonb)
      INTO v_rechecks FROM public.trial_balance_uploads t
     WHERE (t.period_id = v_p.id OR (t.period_id IS NULL AND t.company_id = v_p.company_id AND t.period_year = v_year))
       AND t.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked');

    PERFORM set_config('axiom.period_currency_correction', txid_current()::text, true);
    UPDATE public.fiscal_periods SET reporting_currency = v_new WHERE id = v_p.id;   -- bumps '#currency' (trigger)
    PERFORM set_config('axiom.period_currency_correction', '', true);
    INSERT INTO public.fiscal_period_events (id, period_id, company_id, action, detail, actor_member_id, actor_user_id)
    VALUES (v_event, v_p.id, v_p.company_id, 'currency_corrected',
            jsonb_build_object('from', v_expected, 'to', v_new, 'reason', v_reason, 'request_id', p_request_id::text, 'rechecks', v_rechecks),
            v_member, v_uid);
    v_result := jsonb_build_object('outcome', 'corrected', 'event_id', v_event, 'period_id', v_p.id, 'from', v_expected, 'to', v_new,
                                   'rechecks', v_rechecks);
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    PERFORM set_config('lock_timeout', v_timeout, true);
    RETURN jsonb_build_object('outcome', 'busy');
  END;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.correct_period_currency(uuid, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_period_currency(uuid, text, text, text, uuid) TO authenticated;
