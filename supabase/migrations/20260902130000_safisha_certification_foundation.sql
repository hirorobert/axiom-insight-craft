-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ PHASE 0 — SAFISHA CERTIFICATION FOUNDATION
--
-- Adds the minimum additive schema for immutable SAFISHA certification
-- results and the atomic commit boundary that produces them. Reuses Phase
-- 0A (engine_runs, idempotency_keys, canonicalJson/sha256Hex,
-- resolveFirmMemberActor) and Phase 2A (untouched) unchanged.
--
-- Concepts this migration keeps deliberately separate (Gate 1 hardening):
--   1. RESULT vs ELIGIBILITY — tb_certifications rows are immutable
--      provenance evidence, created for every completed SAFISHA engine_run
--      regardless of outcome. "Downstream eligible" (is_blocking=false AND
--      requires_review=false) is a DERIVED predicate over that same table —
--      never a second, competing record.
--   2. requires_review is an ACCOUNTING CLASSIFICATION completeness fact
--      (unresolved accounts), not organizational bureaucracy. Resolving it
--      means running Phase 2A's existing resolve_account_review_batch —
--      this migration creates no competing review workflow.
--   3. source_file_hash (trial_balance_uploads) is a server-observed,
--      point-in-time fingerprint of the current Storage object;
--      tb_certifications.source_file_hash is an immutable SNAPSHOT of what
--      was actually certified. If they diverge, the historical
--      certification remains valid evidence but is no longer authoritative
--      for the CURRENT source — see get_authoritative_certification below.
--   4. Certification snapshots are bounded (jsonb_typeof + size cap), never
--      an unlimited dump of trial_balance_uploads.processing_result.
--
-- NOT in scope for this migration: process-trial-balance runtime wiring
-- (still zero Phase 0A/0 integration in that function — untouched here),
-- Phase 2A, Phase 0A object definitions, KINGA/HESABU/MAONO.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- trial_balance_uploads.source_file_hash — additive column
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.trial_balance_uploads
  ADD COLUMN IF NOT EXISTS source_file_hash TEXT NULL;

COMMENT ON COLUMN public.trial_balance_uploads.source_file_hash IS
  'Server-observed SHA-256 of the exact Storage object bytes at file_path, '
  'computed by process-trial-balance. A point-in-time OBSERVATION, not '
  'itself governed as immutable history — tb_certifications.source_file_hash '
  'is the immutable snapshot of what was actually certified. NULL until '
  'first computed (existing uploads predate this column).';

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: tb_certifications — immutable SAFISHA certification result
-- ════════════════════════════════════════════════════════════════════════════

CREATE SEQUENCE public.tb_certifications_seq;

CREATE TABLE public.tb_certifications (
  id                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  sequence_no           BIGINT       NOT NULL DEFAULT nextval('public.tb_certifications_seq'),
  company_id            UUID         NOT NULL,
  upload_id             UUID         NOT NULL,
  period_year           INTEGER      NULL,
  source_file_hash      TEXT         NOT NULL,
  normalized_input_hash TEXT         NOT NULL,
  engine_run_id         UUID         NOT NULL,
  is_blocking           BOOLEAN      NOT NULL,
  requires_review       BOOLEAN      NOT NULL,
  -- Bounded exception list. Array of {code, layer, severity, account_code,
  -- message, resolution} objects (SafishaException, src/lib/safisha/types.ts).
  -- Bounded by type + size, not a per-element key allowlist — the
  -- subquery-free bounded-object technique from Phase 0A-1R (jsonb - text[])
  -- only applies to a single JSON OBJECT's keys, not to validating the
  -- shape of every element of a JSON ARRAY, which cannot be expressed
  -- without a subquery. TypeScript typing is the shape authority; this is
  -- a structural + size backstop, not exhaustive per-element validation.
  exceptions            JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- Bounded classified-row snapshot (CertifiedTBRow[]). Genuinely larger
  -- than the tiny pointer-envelopes elsewhere in this project (a real TB
  -- can have hundreds to low thousands of accounts) — capped at 1 MiB,
  -- generous for any realistic TB, still a hard structural ceiling against
  -- a pathological payload. NOT a copy of the full
  -- trial_balance_uploads.processing_result blob (which also carries
  -- parser diagnostics, column-detection metadata, etc. that are not
  -- accounting-meaningful certified content).
  rows_snapshot         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  certified_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT tb_certifications_pk PRIMARY KEY (id),

  CONSTRAINT fk_tbc_company
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,

  CONSTRAINT fk_tbc_upload
    FOREIGN KEY (upload_id) REFERENCES public.trial_balance_uploads(id) ON DELETE CASCADE,

  -- One certification per engine_run — see commit_tb_certification's
  -- procedural enforcement of "only a completed run may be certified"
  -- (not expressible as a cross-table CHECK constraint in PostgreSQL).
  CONSTRAINT fk_tbc_engine_run
    FOREIGN KEY (engine_run_id) REFERENCES public.engine_runs(id) ON DELETE RESTRICT,
  CONSTRAINT uq_tbc_engine_run
    UNIQUE (engine_run_id),

  CONSTRAINT chk_tbc_period_year_sane
    CHECK (period_year IS NULL OR period_year BETWEEN 2000 AND 2100),

  CONSTRAINT chk_tbc_exceptions_bounded
    CHECK (
      jsonb_typeof(exceptions) = 'array' AND
      pg_column_size(exceptions) <= 65536
    ),

  CONSTRAINT chk_tbc_rows_snapshot_bounded
    CHECK (
      jsonb_typeof(rows_snapshot) = 'array' AND
      pg_column_size(rows_snapshot) <= 1048576
    )
);

COMMENT ON TABLE public.tb_certifications IS
  'Ω∞ Phase 0: immutable SAFISHA certification result. One row per '
  'completed SAFISHA engine_run, created ONLY via commit_tb_certification(). '
  'Created regardless of is_blocking/requires_review — a blocking or '
  'review-required result is real, persisted evidence that SAFISHA ran, not '
  'an authority decision. "Downstream eligible" = NOT is_blocking AND NOT '
  'requires_review, computed at read time, never stored separately. '
  'Append-only — see trg_tbc_immutable below.';

COMMENT ON COLUMN public.tb_certifications.sequence_no IS
  'Deterministic, gap-tolerant, concurrency-safe ordering (mirrors '
  'account_review_decisions_seq / engine_runs precedent) — never '
  'timestamp-based. Used both to find the latest certification for a given '
  'upload_id and, more broadly, for a given (company_id, period_year).';

CREATE INDEX idx_tbc_company_period
  ON public.tb_certifications (company_id, period_year, sequence_no DESC);

CREATE INDEX idx_tbc_upload
  ON public.tb_certifications (upload_id, sequence_no DESC);

-- ── Immutability — pure append-only, no legal UPDATE at all (unlike
-- engine_runs/idempotency_keys, which have exactly one legal transition, a
-- certification is born complete — there is no in-flight state to
-- transition from). Mirrors Phase 2A's account_review_decisions pattern.
CREATE OR REPLACE FUNCTION public.tb_certifications_immutable()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION
    'Iron Dome: tb_certifications is append-only. % is not permitted. [id=%]',
    TG_OP, COALESCE(OLD.id::TEXT, 'N/A')
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_tbc_immutable
  BEFORE UPDATE OR DELETE ON public.tb_certifications
  FOR EACH ROW EXECUTE FUNCTION public.tb_certifications_immutable();

ALTER TABLE public.tb_certifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tbc_select" ON public.tb_certifications
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id    = auth.uid()
         AND fm.company_id = tb_certifications.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );

-- Explicit, per-role REVOKE — the Phase 0A-2R lesson applied from the
-- start: never rely on PUBLIC/anon exclusion alone to imply authenticated
-- is also clean under this project's known default-ACL defect
-- (DEFECT-DEFAULT-ACL-AUTHENTICATED-001). authenticated is named
-- explicitly in the REVOKE, not merely omitted from the GRANT.
REVOKE ALL PRIVILEGES ON public.tb_certifications FROM PUBLIC;
REVOKE ALL PRIVILEGES ON public.tb_certifications FROM anon;
REVOKE ALL PRIVILEGES ON public.tb_certifications FROM authenticated;
GRANT SELECT ON public.tb_certifications TO authenticated;
GRANT ALL PRIVILEGES ON public.tb_certifications TO service_role;

REVOKE ALL PRIVILEGES ON SEQUENCE public.tb_certifications_seq FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE public.tb_certifications_seq FROM anon;
REVOKE ALL PRIVILEGES ON SEQUENCE public.tb_certifications_seq FROM authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.tb_certifications_seq TO service_role;

REVOKE ALL ON FUNCTION public.tb_certifications_immutable() FROM PUBLIC, anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: commit_tb_certification(...) — the sole write path
--
-- SAFISHA-domain-specific, not a generic transaction RPC. Atomically:
--   1. replays an existing certification if this engine_run already has one
--      (idempotent on retry)
--   2. validates the referenced engine_run is genuinely running, belongs to
--      the stated company, and is the expected function
--   3. validates the upload belongs to the stated company
--   4. inserts the immutable certification
--   5. completes the engine_run (the one transition trg_er_lifecycle
--      already permits — no trigger change)
--   6. completes the corresponding idempotency reservation, if any
-- Any failure at any step rolls back everything — no half-certified state.
-- A failed engine_run can never be certified — enforced procedurally here,
-- since PostgreSQL CHECK constraints cannot reference another table.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.commit_tb_certification(
  p_engine_run_id          UUID,
  p_expected_function_name TEXT,
  p_upload_id              UUID,
  p_company_id             UUID,
  p_period_year            INTEGER,
  p_source_file_hash       TEXT,
  p_normalized_input_hash  TEXT,
  p_output_hash            TEXT,
  p_is_blocking            BOOLEAN,
  p_requires_review        BOOLEAN,
  p_exceptions             JSONB,
  p_rows_snapshot          JSONB
) RETURNS JSONB
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_run          RECORD;
  v_upload       RECORD;
  v_existing_id  UUID;
  v_cert_id      UUID;
BEGIN
  -- Replay: if this engine_run already produced a certification (e.g. a
  -- retried caller after a lost response), return it — never duplicate.
  SELECT id INTO v_existing_id FROM public.tb_certifications
   WHERE engine_run_id = p_engine_run_id;
  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object('certification_id', v_existing_id, 'replay', true);
  END IF;

  -- Lock and validate the engine_run.
  SELECT * INTO v_run FROM public.engine_runs WHERE id = p_engine_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ENGINE_RUN_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  IF v_run.status = 'failed' THEN
    RAISE EXCEPTION 'CANNOT_CERTIFY_FAILED_ENGINE_RUN' USING ERRCODE = '42501';
  END IF;

  IF v_run.status = 'completed' THEN
    -- Already completed but no certification exists (checked above) —
    -- an inconsistent state this function must never paper over.
    RAISE EXCEPTION 'ENGINE_RUN_ALREADY_COMPLETED_WITHOUT_CERTIFICATION' USING ERRCODE = '42501';
  END IF;

  IF v_run.status != 'running' THEN
    RAISE EXCEPTION 'ENGINE_RUN_NOT_RUNNING: %', v_run.status USING ERRCODE = '42501';
  END IF;

  IF v_run.company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'ENGINE_RUN_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF v_run.function_name IS DISTINCT FROM p_expected_function_name THEN
    RAISE EXCEPTION 'ENGINE_RUN_FUNCTION_MISMATCH: expected %, got %',
      p_expected_function_name, v_run.function_name USING ERRCODE = '42501';
  END IF;

  -- Upload/company consistency.
  SELECT * INTO v_upload FROM public.trial_balance_uploads WHERE id = p_upload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UPLOAD_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_upload.company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'UPLOAD_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- Insert the immutable certification.
  INSERT INTO public.tb_certifications (
    company_id, upload_id, period_year, source_file_hash, normalized_input_hash,
    engine_run_id, is_blocking, requires_review, exceptions, rows_snapshot
  ) VALUES (
    p_company_id, p_upload_id, p_period_year, p_source_file_hash, p_normalized_input_hash,
    p_engine_run_id, p_is_blocking, p_requires_review,
    coalesce(p_exceptions, '[]'::jsonb), coalesce(p_rows_snapshot, '[]'::jsonb)
  ) RETURNING id INTO v_cert_id;

  -- Complete the engine_run — the one legal running->completed transition
  -- trg_er_lifecycle already permits; no trigger change required.
  UPDATE public.engine_runs
     SET status = 'completed',
         completed_at = now(),
         duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer,
         output_hash = p_output_hash
   WHERE id = p_engine_run_id;

  -- Complete the corresponding idempotency reservation, if one is still
  -- reserved for this run (a system-triggered run may have none).
  UPDATE public.idempotency_keys
     SET status = 'completed',
         resolved_at = now(),
         replay_result = jsonb_build_object(
           'status', 'completed',
           'reference_id', v_cert_id::text,
           'reference_table', 'tb_certifications'
         )
   WHERE engine_run_id = p_engine_run_id AND status = 'reserved';

  RETURN jsonb_build_object('certification_id', v_cert_id, 'replay', false);
END;
$$;

-- SECURITY INVOKER (default) — the caller (process-trial-balance's
-- service-role connection) already holds full privileges on every table
-- this function touches; there is no privilege gap to bridge. Matches the
-- Phase 0A-1R lesson: SECURITY DEFINER only when genuinely needed, never
-- for consistency alone.
REVOKE ALL ON FUNCTION public.commit_tb_certification(
  UUID, TEXT, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_tb_certification(
  UUID, TEXT, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, JSONB, JSONB
) TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: get_authoritative_certification(...) — read-only authority query
--
-- "Which certification is currently authoritative for downstream use?"
-- Deliberately answers a NARROWER question than "latest eligible
-- certification anywhere" — see the C1/C2 analysis in the migration header
-- comment block below and in MIGRATION_RECONCILIATION.md / the design
-- record for this slice.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_authoritative_certification(
  p_company_id UUID,
  p_period_year INTEGER
) RETURNS SETOF public.tb_certifications
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_catalog
AS $$
  -- Step 1: the CURRENT source for this company+period is the most
  -- recently created upload. uploaded_at (TIMESTAMP WITH TIME ZONE NOT
  -- NULL DEFAULT now(), server-assigned at INSERT — confirmed against
  -- 20251207114310_9b5d0843-....sql, not client-supplied) is the ordering
  -- signal; id is a pure determinism tiebreak, not a recency signal. TB
  -- uploads are single-user, human-paced, one-INSERT-per-upload actions
  -- (TrialBalanceUpload.tsx) — a genuine microsecond-level uploaded_at tie
  -- between two DIFFERENT uploads for the same company+period is not a
  -- realistic occurrence this architecture needs to defend against. A
  -- dedicated monotonic sequence on trial_balance_uploads (mirroring
  -- tb_certifications_seq) was deliberately NOT added: that table is
  -- pre-existing, out-of-scope for this slice, and no repository evidence
  -- shows uploaded_at is actually ambiguous in practice — inventing a new
  -- primitive to guard a non-observed failure mode would be unwarranted
  -- architecture. We also carry the upload's CURRENT source_file_hash
  -- forward, to detect drift against what the latest certification
  -- actually certified (Step 3).
  WITH latest_upload AS (
    SELECT id, source_file_hash AS current_source_file_hash
      FROM public.trial_balance_uploads
     WHERE company_id = p_company_id
       AND (p_period_year IS NULL OR period_year = p_period_year)
     ORDER BY uploaded_at DESC, id DESC
     LIMIT 1
  ),
  -- Step 2: the LATEST certification attempt for that current upload,
  -- REGARDLESS of eligibility. Ordering by sequence_no DESC (the
  -- dedicated, gap-free, monotonic tb_certifications_seq — a real total
  -- order across every certification ever committed, unlike a timestamp)
  -- and taking exactly one row is what this function evaluates next. This
  -- is the fix: eligibility is no longer part of the WHERE clause that
  -- selects "latest" — a newer blocking/requires_review attempt for the
  -- same upload MUST be the row considered, not silently stepped over in
  -- favour of an older eligible one.
  latest_certification AS (
    SELECT c.*
      FROM public.tb_certifications c, latest_upload lu
     WHERE c.upload_id = lu.id
     ORDER BY c.sequence_no DESC
     LIMIT 1
  )
  -- Step 3: that ONE latest certification is authoritative only if it is
  -- itself eligible AND its own recorded source_file_hash still matches
  -- the upload's current source_file_hash. A NULL current_source_file_hash
  -- means no process has populated the column yet (it exists but is not
  -- wired into any live path this slice) — that is "no drift signal
  -- available", not "drift detected", so it must never block. If the
  -- latest certification is blocking, requires review, or reflects a
  -- source that has since changed, NO row is returned — there is
  -- deliberately no fallback to an older eligible certification for the
  -- same current upload (see C1/C2 analysis above and cases A-I in
  -- supabase/tests/safisha_certification_foundation_manual_verification.sql).
  SELECT lc.*
    FROM latest_certification lc, latest_upload lu
   WHERE lc.is_blocking = false
     AND lc.requires_review = false
     AND (
       lu.current_source_file_hash IS NULL
       OR lu.current_source_file_hash = lc.source_file_hash
     );
$$;

REVOKE ALL ON FUNCTION public.get_authoritative_certification(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_authoritative_certification(UUID, INTEGER) TO authenticated, service_role;

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- DROP FUNCTION IF EXISTS public.get_authoritative_certification(UUID, INTEGER);
-- DROP FUNCTION IF EXISTS public.commit_tb_certification(UUID, TEXT, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, JSONB, JSONB);
-- DROP TRIGGER IF EXISTS trg_tbc_immutable ON public.tb_certifications;
-- DROP FUNCTION IF EXISTS public.tb_certifications_immutable();
-- DROP TABLE IF EXISTS public.tb_certifications CASCADE;
-- DROP SEQUENCE IF EXISTS public.tb_certifications_seq;
-- ALTER TABLE public.trial_balance_uploads DROP COLUMN IF EXISTS source_file_hash;
