-- ============================================================
-- Kinga Phase 2 — Canonical Ingestion Layer
--
-- Migration: 20260625120000_3c7d9f14-8a2e-4b6c-a915-d0e4f8b3c762
-- Date: 2026-06-26
-- Depends on: 20260625100000_b3e5c891-* (companies, findings, etc.)
--
-- Creates:
--   public.ingestion_batches              — batch-level provenance
--   public.canonical_financial_records    — normalized canonical store
--
-- Architecture invariants enforced:
--   Invariant 1 (Source Independence): findings engine reads ONLY from
--     canonical_financial_records, never from efdms_records directly.
--   Invariant 3 (Idempotency): UNIQUE(company_id, normalized_hash) on
--     canonical_financial_records enforces cross-source deduplication.
--   Invariant 4 (Auditability): raw_payload JSONB on every canonical
--     record preserves the original source data verbatim.
--
-- Two-layer enforcement discipline:
--   Layer 1 — RLS: restricts authenticated role access by company ownership.
--   Layer 2 — Triggers: enforce append-only, field immutability, and
--     business invariants that cannot be bypassed by service role key.
--     Service role used in Edge Functions bypasses RLS entirely;
--     triggers fire regardless of role.
--
-- PURELY ADDITIVE. No existing tables are modified.
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════
-- SECTION 0 — TRIGGER FUNCTIONS
-- Defined before tables so CREATE TRIGGER statements can
-- reference them immediately after each table is created.
-- ════════════════════════════════════════════════════════════

-- ── 0a. ingestion_batches: prevent provenance field mutation ──────────────
--
-- Only six mutable fields are permitted post-INSERT:
--   status, inserted_count, skipped_count, error_count,
--   error_summary, completed_at
--
-- All other fields are immutable provenance records. A service-role
-- UPDATE that changes company_id, source_type, import_batch_id, etc.
-- would silently corrupt the audit trail. This trigger catches it
-- regardless of caller role.

CREATE OR REPLACE FUNCTION public.prevent_batch_field_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.company_id                 IS DISTINCT FROM OLD.company_id                 OR
     NEW.source_type                IS DISTINCT FROM OLD.source_type                OR
     NEW.provider_name              IS DISTINCT FROM OLD.provider_name              OR
     NEW.import_batch_id            IS DISTINCT FROM OLD.import_batch_id            OR
     NEW.ingestion_contract_version IS DISTINCT FROM OLD.ingestion_contract_version OR
     NEW.source_file_reference      IS DISTINCT FROM OLD.source_file_reference      OR
     NEW.record_count               IS DISTINCT FROM OLD.record_count               OR
     NEW.imported_by                IS DISTINCT FROM OLD.imported_by                OR
     NEW.imported_at                IS DISTINCT FROM OLD.imported_at
  THEN
    RAISE EXCEPTION
      'ingestion_batches provenance fields are immutable after insert. '
      'Only status, inserted_count, skipped_count, error_count, '
      'error_summary, and completed_at may be updated. (batch id: %)',
      OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;


-- ── 0b. ingestion_batches: prevent DELETE ────────────────────────────────
--
-- Batches are append-only audit records. Deleting a batch would orphan
-- any canonical_financial_records rows that reference it (FK RESTRICT
-- would block the DELETE anyway if records exist, but this trigger fires
-- even on batches with zero records and provides a clear error message).

CREATE OR REPLACE FUNCTION public.prevent_batch_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'ingestion_batches is append-only. DELETE is not permitted. '
    'Batches are permanent audit records. (batch id: %)',
    OLD.id
  USING ERRCODE = 'integrity_constraint_violation';
  RETURN NULL;
END;
$$;


-- ── 0c. canonical_financial_records: BEFORE INSERT validation ────────────
--
-- Enforces four invariants that cannot be expressed as CHECK constraints
-- because they require cross-table lookups or multi-column conditional
-- logic that CHECK does not support:
--
--   V1 — company_id must match the batch's company_id.
--         Prevents a caller from submitting records to a batch they
--         own while forging a different company_id on the canonical row.
--
--   V2 — manual_entry records must always have:
--         requires_secondary_review = true  (no source document to re-check)
--         adapter_confidence <= 0.60        (lower reliability floor)
--         Violation: EXCEPTION (reject, not clamp — see architecture §3)
--
--   V3 — tin_absent = true, non-manual records must have:
--         adapter_confidence <= 0.70
--         Violation: EXCEPTION (reject, not clamp — hiding adapter bugs
--         is worse than a failed insert that forces the caller to comply)
--
--   V4 — tin_absent = true AND counterparty_name IS NULL:
--         requires_secondary_review is forced to true.
--         This is a SET on NEW, not a rejection, because the caller
--         cannot know the downstream dedup risk from a single field.
--         The only case in this layer where silent correction is
--         preferable to rejection.

CREATE OR REPLACE FUNCTION public.validate_canonical_record()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_company_id UUID;
BEGIN
  -- V1: company_id consistency with batch ──────────────────────────────
  SELECT company_id
    INTO v_batch_company_id
    FROM public.ingestion_batches
   WHERE id = NEW.batch_id;

  IF v_batch_company_id IS NULL THEN
    RAISE EXCEPTION
      'batch_id % does not exist in ingestion_batches. '
      'Create the batch record before inserting canonical records.',
      NEW.batch_id
    USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.company_id IS DISTINCT FROM v_batch_company_id THEN
    RAISE EXCEPTION
      'canonical_financial_records.company_id (%) does not match '
      'ingestion_batches.company_id (%) for batch_id %. '
      'Records may only be inserted under the company that owns the batch.',
      NEW.company_id, v_batch_company_id, NEW.batch_id
    USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- V2: manual_entry enforcement ───────────────────────────────────────
  IF NEW.source_type = 'manual_entry' THEN
    IF NEW.requires_secondary_review = false THEN
      RAISE EXCEPTION
        'manual_entry records must have requires_secondary_review = true. '
        'There is no source document to re-check; secondary review is mandatory. '
        '(batch_id: %, company_id: %)',
        NEW.batch_id, NEW.company_id
      USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.adapter_confidence > 0.60 THEN
      RAISE EXCEPTION
        'manual_entry records may not exceed adapter_confidence 0.60. '
        'Submitted value: %. Correct the adapter and resubmit. '
        '(batch_id: %, company_id: %)',
        NEW.adapter_confidence, NEW.batch_id, NEW.company_id
      USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- V3: tin_absent confidence cap ──────────────────────────────────────
  -- manual_entry has its own floor (V2); skip double-evaluation.
  IF NEW.tin_absent = true AND NEW.source_type != 'manual_entry' THEN
    IF NEW.adapter_confidence > 0.70 THEN
      RAISE EXCEPTION
        'adapter_confidence % exceeds the 0.70 ceiling for tin_absent records. '
        'A record with no counterparty TIN cannot carry high confidence. '
        'Correct the adapter and resubmit. '
        '(source_type: %, batch_id: %, company_id: %)',
        NEW.adapter_confidence, NEW.source_type, NEW.batch_id, NEW.company_id
      USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- V4: tin_absent + no name → force requires_secondary_review ─────────
  -- A record with no TIN and no counterparty name cannot be reliably
  -- deduplicated. The trigger sets the flag rather than rejecting because
  -- the caller cannot determine the dedup risk from a single field alone.
  IF NEW.tin_absent = true AND NEW.counterparty_name IS NULL THEN
    NEW.requires_secondary_review := true;
  END IF;

  RETURN NEW;
END;
$$;


-- ── 0d. canonical_financial_records: prevent UPDATE ──────────────────────
--
-- canonical_financial_records is permanently append-only.
-- To correct a record: mark the source batch as partial/failed,
-- re-ingest the corrected records under a new batch. The original
-- record is retained as an immutable audit trail entry.
-- This trigger fires regardless of caller role, including service role.

CREATE OR REPLACE FUNCTION public.prevent_canonical_record_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'canonical_financial_records is append-only. UPDATE is not permitted. '
    'To correct a record, mark the source batch as partial/failed '
    'and re-ingest corrected records under a new batch. (record id: %)',
    OLD.id
  USING ERRCODE = 'integrity_constraint_violation';
  RETURN NULL;
END;
$$;


-- ── 0e. canonical_financial_records: prevent DELETE ──────────────────────

CREATE OR REPLACE FUNCTION public.prevent_canonical_record_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'canonical_financial_records is append-only. DELETE is not permitted. '
    'Financial records are permanent audit entries. (record id: %)',
    OLD.id
  USING ERRCODE = 'integrity_constraint_violation';
  RETURN NULL;
END;
$$;


-- ════════════════════════════════════════════════════════════
-- SECTION 1 — ingestion_batches
-- ════════════════════════════════════════════════════════════

CREATE TABLE public.ingestion_batches (
  id                         UUID         NOT NULL DEFAULT gen_random_uuid(),
  company_id                 UUID         NOT NULL,
  source_type                TEXT         NOT NULL,
  provider_name              TEXT         NOT NULL,
  import_batch_id            TEXT         NOT NULL,
  ingestion_contract_version TEXT         NOT NULL DEFAULT '1.0',
  source_file_reference      TEXT         NULL,
  record_count               INTEGER      NOT NULL,
  status                     TEXT         NOT NULL DEFAULT 'pending',
  inserted_count             INTEGER      NULL,
  skipped_count              INTEGER      NULL,
  error_count                INTEGER      NULL,
  error_summary              JSONB        NULL,
  imported_by                UUID         NOT NULL,
  imported_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at               TIMESTAMPTZ  NULL,

  CONSTRAINT ingestion_batches_pk
    PRIMARY KEY (id),

  CONSTRAINT fk_batch_company
    FOREIGN KEY (company_id)
    REFERENCES public.companies(id)
    ON DELETE RESTRICT,
    -- RESTRICT: a company with ingestion history cannot be deleted without
    -- first resolving its canonical records. Prevents silent orphaning
    -- of the full financial audit trail.

  CONSTRAINT uq_ingestion_batch
    UNIQUE (company_id, import_batch_id),
    -- Caller-supplied idempotency key. If an Edge Function crashes after
    -- writing the batch row but before processing records, re-submission
    -- finds the existing batch row and can resume rather than create a
    -- duplicate batch with the same caller reference.

  CONSTRAINT chk_batch_source_type
    CHECK (source_type IN ('efdms_csv', 'manual_entry', 'tra_api', 'vfd_api')),
    -- 'tra_api' and 'vfd_api' are reserved. Inserting them requires an
    -- adapter implementation that does not yet exist. Reserved here so
    -- future adapters require no schema change to the constraint.

  CONSTRAINT chk_batch_contract_version
    CHECK (ingestion_contract_version IN ('1.0')),
    -- Expands with each contract revision via ALTER TABLE ... DROP CONSTRAINT
    -- + ADD CONSTRAINT. Old version strings on existing rows remain valid;
    -- only new rows must use a current version.

  CONSTRAINT chk_batch_status
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'partial')),

  CONSTRAINT chk_batch_record_count
    CHECK (record_count > 0),

  CONSTRAINT chk_batch_inserted_count
    CHECK (inserted_count IS NULL OR inserted_count >= 0),

  CONSTRAINT chk_batch_skipped_count
    CHECK (skipped_count IS NULL OR skipped_count >= 0),

  CONSTRAINT chk_batch_error_count
    CHECK (error_count IS NULL OR error_count >= 0),

  CONSTRAINT chk_batch_completed_at
    CHECK (completed_at IS NULL OR status IN ('completed', 'failed', 'partial')),
    -- completed_at must be NULL while the batch is still pending/processing.

  CONSTRAINT chk_batch_counts_when_terminal
    CHECK (
      status NOT IN ('completed', 'partial')
      OR (inserted_count IS NOT NULL
          AND skipped_count IS NOT NULL
          AND error_count   IS NOT NULL)
    )
    -- A completed or partially-completed batch must report result counts.
    -- 'failed' batches may have NULLs if processing never began.
);

ALTER TABLE public.ingestion_batches ENABLE ROW LEVEL SECURITY;

-- Triggers on ingestion_batches
CREATE TRIGGER trg_prevent_batch_field_mutation
BEFORE UPDATE ON public.ingestion_batches
FOR EACH ROW
EXECUTE FUNCTION public.prevent_batch_field_mutation();

CREATE TRIGGER trg_prevent_batch_delete
BEFORE DELETE ON public.ingestion_batches
FOR EACH ROW
EXECUTE FUNCTION public.prevent_batch_delete();

-- RLS — ingestion_batches
-- SELECT: company owner sees their own batches
CREATE POLICY "ingestion_batches_select"
ON public.ingestion_batches FOR SELECT TO authenticated
USING (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
);

-- INSERT (PERMISSIVE): company owner submits batches for their companies
CREATE POLICY "ingestion_batches_insert"
ON public.ingestion_batches FOR INSERT TO authenticated
WITH CHECK (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
);

-- INSERT (RESTRICTIVE): defense-in-depth
-- ANDs unconditionally with the PERMISSIVE policy above.
-- Even if a future PERMISSIVE policy is added with looser conditions,
-- this RESTRICTIVE policy cannot be overridden.
CREATE POLICY "ingestion_batches_insert_restrictive"
ON public.ingestion_batches AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
);

-- No UPDATE policy for authenticated role.
-- Status transitions (pending → processing → completed/failed/partial)
-- are performed by Edge Functions using the service role key.
-- The prevent_batch_field_mutation trigger enforces that only the six
-- permitted fields can change, even under service role.

-- No DELETE policy.
-- prevent_batch_delete trigger enforces append-only for all roles.

-- Indexes — ingestion_batches
CREATE INDEX idx_batches_company_id
ON public.ingestion_batches (company_id);
-- RLS semi-join: WHERE company_id IN (SELECT id FROM companies WHERE user_id = auth.uid())

CREATE INDEX idx_batches_status_pending
ON public.ingestion_batches (company_id)
WHERE status IN ('pending', 'processing');
-- Partial index for active batch dashboard. Partial keeps the index small:
-- most rows reach terminal status (completed/failed/partial) quickly.


-- ════════════════════════════════════════════════════════════
-- SECTION 2 — canonical_financial_records
-- ════════════════════════════════════════════════════════════

CREATE TABLE public.canonical_financial_records (
  id                         UUID          NOT NULL DEFAULT gen_random_uuid(),
  batch_id                   UUID          NOT NULL,
  company_id                 UUID          NOT NULL,
  -- company_id is intentionally denormalized from ingestion_batches.
  -- Rationale: (a) RLS semi-join requires a direct column; a join through
  -- batch_id on every query would be expensive. (b) All findings-engine
  -- queries filter on (company_id, period_year, period_month).
  -- (c) Audit independence: each record carries its own ownership proof.
  -- Consistency enforced by validate_canonical_record() trigger (V1).

  -- Financial event (source-agnostic)
  record_type                TEXT          NOT NULL,
  canonical_date             DATE          NOT NULL,
  period_year                INTEGER       NOT NULL,
  period_month               INTEGER       NOT NULL,
  amount_tzs                 NUMERIC(20,2) NOT NULL,
  vat_amount_tzs             NUMERIC(20,2) NOT NULL DEFAULT 0,
  counterparty_tin           TEXT          NULL,
  counterparty_name          TEXT          NULL,
  tin_absent                 BOOLEAN       NOT NULL DEFAULT false,
  -- tin_absent = true: adapter confirmed the counterparty has no TIN.
  -- tin_absent = false with counterparty_tin IS NULL: TIN not in source.
  -- Distinction matters for counterparty resolution and confidence scoring.
  -- See Required Decision 2 in architecture review §7.

  -- Provenance metadata (copied from batch at INSERT — denormalized for
  -- audit independence and query performance)
  source_type                TEXT          NOT NULL,
  provider_name              TEXT          NOT NULL,
  import_batch_id            TEXT          NOT NULL,
  ingestion_contract_version TEXT          NOT NULL,
  source_file_reference      TEXT          NULL,

  -- Idempotency
  source_identifier          TEXT          NULL,
  -- Authoritative business ID when the source provides one
  -- (e.g., efdms_transaction_id). NULL for manual entry and
  -- sources without business-level identifiers.
  payload_hash               TEXT          NOT NULL,
  -- SHA-256 hex of raw_payload bytes. Verifies the raw record
  -- has not been altered after ingestion.
  normalized_hash            TEXT          NOT NULL,
  -- SHA-256 hex of canonical fields per ingestion contract v1.0.
  -- See architecture review §7.2 for exact field composition,
  -- normalization rules, and null handling.
  -- UNIQUE(company_id, normalized_hash) enforces cross-source
  -- deduplication: the same financial event cannot appear twice
  -- regardless of which adapter submitted it.

  -- Adapter quality metadata
  imported_by                UUID          NOT NULL,
  -- Calling user UUID, set explicitly by the Edge Function from the
  -- authenticated user's JWT. Never relies on DEFAULT auth.uid()
  -- because auth.uid() returns NULL under the service role key.
  imported_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  adapter_confidence         NUMERIC(3,2)  NOT NULL DEFAULT 1.00,
  requires_secondary_review  BOOLEAN       NOT NULL DEFAULT false,

  -- Full audit trail
  raw_payload                JSONB         NOT NULL,
  -- Original record exactly as received, before any normalization.
  -- For CSV: {row_number, raw_headers, raw_values}.
  -- For manual entry: {entered_values, justification, supporting_evidence}.
  -- For API sources: verbatim API response object for the record.

  CONSTRAINT canonical_financial_records_pk
    PRIMARY KEY (id),

  CONSTRAINT fk_canonical_batch
    FOREIGN KEY (batch_id)
    REFERENCES public.ingestion_batches(id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_canonical_company
    FOREIGN KEY (company_id)
    REFERENCES public.companies(id)
    ON DELETE RESTRICT,

  CONSTRAINT uq_canonical_hash
    UNIQUE (company_id, normalized_hash),
    -- Primary cross-source idempotency enforcement.
    -- ON CONFLICT DO NOTHING on this constraint gives exact skip counts
    -- without raising an error for expected duplicates (re-ingested batches).

  CONSTRAINT chk_canonical_record_type
    CHECK (record_type IN ('sale', 'purchase')),

  CONSTRAINT chk_canonical_amount
    CHECK (amount_tzs > 0),
    -- Amounts are always positive. Direction is encoded in record_type.
    -- A zero-amount record is a data quality failure, not a valid event.

  CONSTRAINT chk_canonical_vat
    CHECK (vat_amount_tzs >= 0),
    -- VAT may be zero (non-VAT-registered counterparty, exempt supply).
    -- It may never be negative.

  CONSTRAINT chk_canonical_confidence
    CHECK (adapter_confidence BETWEEN 0.00 AND 1.00),

  CONSTRAINT chk_canonical_source_type
    CHECK (source_type IN ('efdms_csv', 'manual_entry', 'tra_api', 'vfd_api')),

  CONSTRAINT chk_canonical_period
    CHECK (
      period_year  = EXTRACT(YEAR  FROM canonical_date)::INTEGER
      AND period_month = EXTRACT(MONTH FROM canonical_date)::INTEGER
    ),
    -- Period fields must be consistent with canonical_date.
    -- Prevents a caller from setting period_year = 2024 on a record
    -- with canonical_date = '2025-01-15'.

  CONSTRAINT chk_canonical_hash_length
    CHECK (
      char_length(normalized_hash) = 64
      AND char_length(payload_hash) = 64
    ),
    -- SHA-256 hex output is always exactly 64 characters.
    -- Rejects truncated hashes, empty strings, and placeholder values.

  CONSTRAINT chk_canonical_tin_absent
    CHECK (
      -- If TIN is present, tin_absent must be false.
      -- (You cannot have a TIN and claim it is absent.)
      (counterparty_tin IS NOT NULL AND tin_absent = false)
      OR counterparty_tin IS NULL
      -- counterparty_tin IS NULL AND tin_absent = false: TIN not in source.
      -- counterparty_tin IS NULL AND tin_absent = true: confirmed absent.
      -- Both are valid states.
    )
);

ALTER TABLE public.canonical_financial_records ENABLE ROW LEVEL SECURITY;

-- Triggers on canonical_financial_records
CREATE TRIGGER trg_validate_canonical_record
BEFORE INSERT ON public.canonical_financial_records
FOR EACH ROW
EXECUTE FUNCTION public.validate_canonical_record();

CREATE TRIGGER trg_prevent_canonical_record_update
BEFORE UPDATE ON public.canonical_financial_records
FOR EACH ROW
EXECUTE FUNCTION public.prevent_canonical_record_update();

CREATE TRIGGER trg_prevent_canonical_record_delete
BEFORE DELETE ON public.canonical_financial_records
FOR EACH ROW
EXECUTE FUNCTION public.prevent_canonical_record_delete();

-- RLS — canonical_financial_records
CREATE POLICY "canonical_records_select"
ON public.canonical_financial_records FOR SELECT TO authenticated
USING (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
);

CREATE POLICY "canonical_records_insert"
ON public.canonical_financial_records FOR INSERT TO authenticated
WITH CHECK (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
);

CREATE POLICY "canonical_records_insert_restrictive"
ON public.canonical_financial_records AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
);

-- No UPDATE policy — prevent_canonical_record_update trigger enforces this
-- for all roles including service role.
-- No DELETE policy — prevent_canonical_record_delete trigger enforces this
-- for all roles including service role.

-- Indexes — canonical_financial_records
-- uq_canonical_hash UNIQUE(company_id, normalized_hash) creates its own
-- B-tree index — no separate index needed for normalized_hash lookups.

CREATE INDEX idx_canonical_company_period
ON public.canonical_financial_records (company_id, period_year, period_month);
-- Primary findings-engine access pattern: all rule evaluations group by
-- (company_id, period_year, period_month). This is the most important index
-- in the canonical layer.

CREATE INDEX idx_canonical_batch_id
ON public.canonical_financial_records (batch_id);
-- Batch-level reporting: inserted_count / skipped_count verification,
-- batch result queries, and batch-scoped error investigation.

CREATE INDEX idx_canonical_source_type
ON public.canonical_financial_records (source_type, company_id);
-- Adapter breakdown reporting and source-specific audit queries.
-- Compound with company_id so the index covers common filtered queries.

CREATE INDEX idx_canonical_review_required
ON public.canonical_financial_records (company_id)
WHERE requires_secondary_review = true;
-- Review queue: which records for this company need human review?
-- Partial index only covers the minority of records requiring review.
-- Index remains small even as the table grows.

CREATE INDEX idx_canonical_tin_absent
ON public.canonical_financial_records (company_id)
WHERE tin_absent = true;
-- Counterparty resolution queue: which records need TIN enrichment?
-- Partial index for the same reason as idx_canonical_review_required.


COMMIT;

-- ============================================================
-- Post-migration verification queries (run separately):
--
-- -- 1. Tables and RLS
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN ('ingestion_batches', 'canonical_financial_records');
-- Expected: 2 rows, both rowsecurity = true.
--
-- -- 2. Trigger functions
-- SELECT proname, prosecdef
-- FROM pg_proc
-- WHERE proname IN (
--   'prevent_batch_field_mutation',
--   'prevent_batch_delete',
--   'validate_canonical_record',
--   'prevent_canonical_record_update',
--   'prevent_canonical_record_delete'
-- );
-- Expected: 5 rows.
-- validate_canonical_record: prosecdef = true (SECURITY DEFINER).
-- Others: prosecdef = false (no elevated access needed).
--
-- -- 3. Triggers wired
-- SELECT event_object_table, trigger_name, event_manipulation, action_timing
-- FROM information_schema.triggers
-- WHERE trigger_schema = 'public'
--   AND event_object_table IN ('ingestion_batches', 'canonical_financial_records')
-- ORDER BY event_object_table, trigger_name;
-- Expected: 5 trigger rows.
--
-- -- 4. RLS policies
-- SELECT tablename, policyname, permissive, cmd
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN ('ingestion_batches', 'canonical_financial_records')
-- ORDER BY tablename, permissive DESC, cmd;
-- Expected: 6 policy rows total (3 per table).
--
-- -- 5. Indexes
-- SELECT tablename, indexname
-- FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename IN ('ingestion_batches', 'canonical_financial_records')
-- ORDER BY tablename, indexname;
-- Expected: PKs + uq_ingestion_batch + uq_canonical_hash
--   + idx_batches_company_id + idx_batches_status_pending
--   + idx_canonical_company_period + idx_canonical_batch_id
--   + idx_canonical_source_type + idx_canonical_review_required
--   + idx_canonical_tin_absent
-- ============================================================
