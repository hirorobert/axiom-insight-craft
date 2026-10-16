-- 20261107100000_certification_findings_capacity.sql — a certification keeps EVERY finding, durably, whatever its size
-- (authorised processing-integrity repair A, 2026-10-16). Forward-only; nothing existing is edited.
--
-- The defect: tb_certifications.exceptions is bounded (chk_tbc_exceptions_bounded: pg_column_size <= 65,536 bytes, evaluated
-- on the uncompressed value). process-trial-balance records one NEEDS_REVIEW finding per unclassified account (about 190
-- bytes each with realistic names), so a first upload of roughly 340 or more unclassified accounts — the exact point depends
-- on the names — was refused by the CHECK (23514) and the whole attempt failed with a server error. The bound is right (the
-- row is read on every readiness check); the representation was wrong.
--
-- The repair:
--   * tb_certification_findings — the COMPLETE findings, one row per finding, in recorded order, append-only, written only
--     by tb_finalize_attempt inside the attempt fence (the certification's run must be the upload's current, running
--     attempt). Each row names its certification, which names the upload, the attempt (engine_run_id) and the engine
--     version that produced it (engine_runs.engine_version). A retry or a concurrent attempt has its own certification, so
--     findings of different attempts can never mix.
--   * tb_certifications.exceptions becomes, when the findings do not fit, a bounded SUMMARY: for every kind of finding
--     (layer, code, severity) a few verbatim examples and one count record {…, "summary": {"omitted": n, "total": t}}
--     carrying the same layer, code and severity. Every kind is represented, so every gate that reads the row (is_blocking
--     and requires_review, which are unchanged; readiness's error and layer checks) sees every unresolved finding.
--     tb_finalize_attempt REFUSES a summary that does not agree with the complete findings: a kind missing, an example
--     that is not one of the findings, or a count that differs.
--   * findings_count, findings_sha256 (SHA-256 of the complete findings, computed HERE from what is stored) and
--     findings_summarized are recorded on the certification. NULL on every earlier certification: there the exceptions
--     column is itself the complete list (it always was). Earlier certifications, their hashes and signed history are
--     not touched (the table stays append-only; adding nullable columns rewrites no row).
--   * tb_snapshot_dependencies keeps recording EVERY dependency key; it takes the per-account advisory locks only up to
--     a bound (tb_dependency_lock_limit() = 1,000 accounts' keys). Those locks only make an in-flight review finish first
--     (fewer "changed while it ran" retries); correctness never rested on them — tb_finalize_attempt and
--     tb_run_authoritative compare every recorded revision. Above the bound one run could otherwise take thousands of
--     locks in one transaction and exhaust the shared lock table (measured: 20,000 in one transaction → 53200 "out of
--     shared memory" at the default max_locks_per_transaction).
--
-- Compatibility: an engine that does not send "findings" (generation 4 and earlier) is served exactly as before. One that
-- does (generation 5) needs this migration first (rollout order: migration, then the function); it probes
-- tb_certification_findings_supported() before it sends a summary, so on a database without this migration it fails the
-- attempt explicitly instead of storing a summary without the complete findings.

DO $preflight$
BEGIN
  IF to_regprocedure('public.tb_finalize_attempt(uuid,jsonb)') IS NULL
     OR to_regprocedure('public.tb_snapshot_dependencies(uuid,jsonb)') IS NULL
     OR to_regprocedure('public._tb_attempt_writer_active()') IS NULL
     OR to_regclass('public.tb_certifications') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the processing attempt authority is missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regclass('public.tb_certification_findings') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: certification findings are already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. What a certification records about its findings ──────────────────────────────────────────────────────────────
ALTER TABLE public.tb_certifications
  ADD COLUMN findings_count integer NULL CONSTRAINT chk_tbc_findings_count CHECK (findings_count IS NULL OR findings_count >= 0),
  ADD COLUMN findings_sha256 text NULL CONSTRAINT chk_tbc_findings_sha256 CHECK (findings_sha256 IS NULL OR findings_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN findings_summarized boolean NULL,
  ADD CONSTRAINT chk_tbc_findings_all_or_none CHECK (
    (findings_count IS NULL) = (findings_sha256 IS NULL) AND (findings_count IS NULL) = (findings_summarized IS NULL));

COMMENT ON COLUMN public.tb_certifications.findings_count IS
  'Number of findings recorded in full in tb_certification_findings. NULL = an earlier certification, whose exceptions '
  'column is itself the complete list.';
COMMENT ON COLUMN public.tb_certifications.findings_sha256 IS
  'SHA-256 (hex) of the complete findings: each finding''s jsonb text in recorded order, joined by a newline. Computed by '
  'tb_finalize_attempt from what it stores; recomputable from tb_certification_findings.';
COMMENT ON COLUMN public.tb_certifications.findings_summarized IS
  'True when exceptions is a bounded summary of the complete findings (examples and count records per kind of finding).';

-- ── 2. The complete findings ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.tb_certification_findings (
  certification_id uuid NOT NULL REFERENCES public.tb_certifications(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  finding jsonb NOT NULL CHECK (jsonb_typeof(finding) = 'object' AND pg_column_size(finding) <= 65536),
  PRIMARY KEY (certification_id, ordinal)
);
COMMENT ON TABLE public.tb_certification_findings IS
  'Every finding of a certification, in recorded order. Append-only; written only by tb_finalize_attempt for the upload''s '
  'current attempt. Readable by whoever can read the certification.';

CREATE OR REPLACE FUNCTION public.tb_certification_findings_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: tb_certification_findings is append-only. % is not permitted.', TG_OP USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER trg_tbcf_append_only BEFORE UPDATE OR DELETE ON public.tb_certification_findings
  FOR EACH ROW EXECUTE FUNCTION public.tb_certification_findings_append_only();

-- Written only inside tb_finalize_attempt, for a certification of the upload's current, running attempt.
CREATE OR REPLACE FUNCTION public.tb_certification_findings_attempt_fence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public._tb_attempt_writer_active() THEN
    RAISE EXCEPTION 'ENGINE_COMMIT_RETIRED: certification findings are written only by tb_finalize_attempt' USING ERRCODE = 'PT410';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tb_certifications c
                   JOIN public.trial_balance_uploads t ON t.id = c.upload_id
                   JOIN public.engine_runs er ON er.id = c.engine_run_id
                  WHERE c.id = NEW.certification_id AND t.current_engine_run_id = er.id AND er.status = 'running') THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_CURRENT' USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tbcf_attempt_fence BEFORE INSERT ON public.tb_certification_findings
  FOR EACH ROW EXECUTE FUNCTION public.tb_certification_findings_attempt_fence();

ALTER TABLE public.tb_certification_findings ENABLE ROW LEVEL SECURITY;
-- Exactly the certification's readers: the subquery is itself filtered by tb_certifications' own policies.
CREATE POLICY "tbcf_select_with_certification" ON public.tb_certification_findings
  FOR SELECT USING (EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.id = tb_certification_findings.certification_id));
REVOKE ALL PRIVILEGES ON public.tb_certification_findings FROM PUBLIC;
REVOKE ALL PRIVILEGES ON public.tb_certification_findings FROM anon;
REVOKE ALL PRIVILEGES ON public.tb_certification_findings FROM authenticated;
GRANT SELECT ON public.tb_certification_findings TO authenticated;
GRANT SELECT, INSERT ON public.tb_certification_findings TO service_role;
REVOKE ALL ON FUNCTION public.tb_certification_findings_append_only() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tb_certification_findings_attempt_fence() FROM PUBLIC, anon, authenticated;

-- The engine asks this before sending a summary: present only once the complete findings can be stored.
CREATE OR REPLACE FUNCTION public.tb_certification_findings_supported()
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.tb_certification_findings_supported() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_certification_findings_supported() TO service_role;

-- The most findings one certification records (the account bound is far lower; this bounds a malformed request).
CREATE OR REPLACE FUNCTION public.tb_certification_findings_limit()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$ SELECT 50000 $$;
-- The most per-account dependency keys (company scope) a snapshot takes advisory locks for.
CREATE OR REPLACE FUNCTION public.tb_dependency_lock_limit()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$ SELECT 1000 $$;
REVOKE ALL ON FUNCTION public.tb_certification_findings_limit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tb_dependency_lock_limit() FROM PUBLIC, anon, authenticated;

-- ── 3. tb_finalize_attempt — the 20261008100000 definition with exactly the marked [20261107100000] blocks added ───────
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
  -- [20261107100000]
  v_exc jsonb;
  v_findings jsonb;
  v_findings_count integer;
  v_findings_sha text;
  v_summarized boolean;
  -- [/20261107100000]
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

  -- [20261107100000] The complete findings and the summary must agree before anything is written.
  IF v_outcome = 'certified' THEN
    v_exc := coalesce(v_c->'exceptions', '[]'::jsonb);
    IF jsonb_typeof(v_exc) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'INVALID_RESULT: exceptions must be an array' USING ERRCODE = '22023';
    END IF;
    IF v_c ? 'findings' THEN
      v_findings := v_c->'findings';
      IF jsonb_typeof(v_findings) IS DISTINCT FROM 'array' OR jsonb_array_length(v_findings) > public.tb_certification_findings_limit() THEN
        RAISE EXCEPTION 'INVALID_RESULT: findings must be an array of at most % entries', public.tb_certification_findings_limit() USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f
                  WHERE jsonb_typeof(f) IS DISTINCT FROM 'object' OR jsonb_typeof(f->'code') IS DISTINCT FROM 'string'
                     OR (f->>'layer') IS NULL OR (f->>'layer') NOT IN ('1', '2', '3', '4', '5', '6')
                     OR jsonb_typeof(f->'layer') IS DISTINCT FROM 'number'
                     OR (f->>'severity') IS NULL OR (f->>'severity') NOT IN ('error', 'warning', 'info')
                     OR f ? 'summary') THEN
        RAISE EXCEPTION 'INVALID_RESULT: a finding is malformed' USING ERRCODE = '22023';
      END IF;
      -- Every kind of finding is represented in the summary (by an example or its count record).
      IF EXISTS (SELECT 1 FROM (SELECT DISTINCT f->'layer' l, f->'code' c, f->'severity' s FROM jsonb_array_elements(v_findings) f) k
                  WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_exc) e
                                     WHERE e->'layer' = k.l AND e->'code' = k.c AND e->'severity' = k.s)) THEN
        RAISE EXCEPTION 'INVALID_RESULT: a kind of finding is missing from the summary' USING ERRCODE = '22023';
      END IF;
      -- Each summary entry is one of the findings, verbatim, or the one count record of its kind with the true counts.
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_exc) e
                  WHERE NOT (e ? 'summary')
                    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_findings) f WHERE f = e)) THEN
        RAISE EXCEPTION 'INVALID_RESULT: a summary example is not one of the findings' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_exc) e
                  WHERE e ? 'summary' AND (
                        jsonb_typeof(e->'summary'->'total') IS DISTINCT FROM 'number'
                     OR jsonb_typeof(e->'summary'->'omitted') IS DISTINCT FROM 'number'
                     OR (e->'summary'->>'omitted') !~ '^[1-9][0-9]*$'
                     OR (e->'summary'->>'total')::bigint IS DISTINCT FROM
                          (SELECT count(*) FROM jsonb_array_elements(v_findings) f
                            WHERE f->'layer' = e->'layer' AND f->'code' = e->'code' AND f->'severity' = e->'severity')
                     OR (e->'summary'->>'total')::bigint - (e->'summary'->>'omitted')::bigint IS DISTINCT FROM
                          (SELECT count(*) FROM jsonb_array_elements(v_exc) x
                            WHERE NOT (x ? 'summary') AND x->'layer' = e->'layer' AND x->'code' = e->'code' AND x->'severity' = e->'severity')
                     OR (SELECT count(*) FROM jsonb_array_elements(v_exc) y
                          WHERE y ? 'summary' AND y->'layer' = e->'layer' AND y->'code' = e->'code' AND y->'severity' = e->'severity') <> 1)) THEN
        RAISE EXCEPTION 'INVALID_RESULT: a summary count does not agree with the findings' USING ERRCODE = '22023';
      END IF;
      v_findings_count := jsonb_array_length(v_findings);
      SELECT encode(sha256(convert_to(coalesce(string_agg(f::text, E'\n' ORDER BY o), ''), 'UTF8')), 'hex')
        INTO v_findings_sha FROM jsonb_array_elements(v_findings) WITH ORDINALITY x(f, o);
      v_summarized := v_exc IS DISTINCT FROM v_findings;
    ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(v_exc) e WHERE e ? 'summary') THEN
      RAISE EXCEPTION 'INVALID_RESULT: a summary needs the complete findings' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- [/20261107100000]

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
                                          engine_run_id, is_blocking, requires_review, exceptions, rows_snapshot,
                                          findings_count, findings_sha256, findings_summarized) -- [20261107100000]
    VALUES (v_row.company_id, v_row.id, v_row.period_year, v_row.source_file_hash, v_c->>'normalized_input_hash',
            v_run.id, (v_c->>'is_blocking')::boolean, (v_c->>'requires_review')::boolean,
            v_exc, coalesce(v_c->'rows_snapshot', '[]'::jsonb),
            v_findings_count, v_findings_sha, v_summarized) -- [20261107100000]
    RETURNING id INTO v_cert;
    -- [20261107100000] The complete findings, under the same fence and in the same transaction as the certification.
    IF v_findings IS NOT NULL THEN
      INSERT INTO public.tb_certification_findings (certification_id, ordinal, finding)
      SELECT v_cert, o::integer, f FROM jsonb_array_elements(v_findings) WITH ORDINALITY x(f, o);
    END IF;
    -- [/20261107100000]
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

  RETURN jsonb_build_object('outcome', v_outcome, 'certification_id', v_cert, 'error_code', CASE WHEN v_outcome = 'failed' THEN v_code END,
                            'findings_count', v_findings_count); -- [20261107100000]
END;
$$;
REVOKE ALL ON FUNCTION public.tb_finalize_attempt(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tb_finalize_attempt(uuid, jsonb) TO service_role;

-- ── 4. tb_snapshot_dependencies — the 20261010100000 definition with exactly the marked [20261107100000] lines changed ─
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
                 OR (e->>'key') !~ '^(code:.+|name:.*|#framework|#currency|#dictionary|#layout_confirmation:[0-9a-f-]{36})$'
                 -- A2: the layout key names the run's own upload, in the company's scope.
                 OR ((e->>'key') LIKE '#layout_confirmation:%' AND ((e->>'scope') <> v_run.company_id::text
                      OR substring(e->>'key' FROM 22) <> v_run.source_record_id::text))) THEN
    RAISE EXCEPTION 'INVALID_DEPENDENCIES' USING ERRCODE = '22023';
  END IF;
  -- L2: the review RPC's per-account advisory lock (company scope), in sorted order, so a review in flight on the same
  -- account completes first. Shared-chart keys are not written by the review RPC.
  -- [20261107100000] Only up to tb_dependency_lock_limit() keys: the locks reduce retries, they do not carry correctness
  -- (every key is still recorded below and compared at finalize and at read time).
  IF (SELECT count(DISTINCT substring(e->>'key' FROM 6)) FROM jsonb_array_elements(p_keys) e
       WHERE e->>'scope' = v_run.company_id::text AND (e->>'key' LIKE 'code:%' OR e->>'key' LIKE 'name:%')) <= public.tb_dependency_lock_limit() THEN
  FOR r IN
    SELECT DISTINCT substring(e->>'key' FROM 6) AS k
      FROM jsonb_array_elements(p_keys) e
     WHERE e->>'scope' = v_run.company_id::text AND (e->>'key' LIKE 'code:%' OR e->>'key' LIKE 'name:%')
     ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_run.company_id::text), hashtext(r.k));
  END LOOP;
  END IF; -- [/20261107100000]
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

-- ── Rollback (manual; only before any generation-5 certification exists) ─────────────────────────────────────────────
-- Re-run the 20261008100000 tb_finalize_attempt and the 20261010100000 tb_snapshot_dependencies definitions, then:
-- DROP FUNCTION IF EXISTS public.tb_certification_findings_supported(), public.tb_certification_findings_limit(),
--   public.tb_dependency_lock_limit();
-- DROP TABLE IF EXISTS public.tb_certification_findings;
-- ALTER TABLE public.tb_certifications DROP CONSTRAINT IF EXISTS chk_tbc_findings_all_or_none,
--   DROP COLUMN IF EXISTS findings_summarized, DROP COLUMN IF EXISTS findings_sha256, DROP COLUMN IF EXISTS findings_count;
-- DROP FUNCTION IF EXISTS public.tb_certification_findings_attempt_fence(), public.tb_certification_findings_append_only();
