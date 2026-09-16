-- Ω∞ CFOCLOSE Document Review — financial_statement_documents (Phase 7)
--
-- Canonical, immutable ingestion boundary for the statement-review outcome
-- ("review-statements" in src/lib/product/outcomes.ts). A source document
-- (PDF/DOCX/XLSX/iXBRL) is evidence, never accounting truth: this table
-- records what was uploaded, by whom, and its classification/processing
-- state — it NEVER writes to trial_balance_uploads, account_mappings,
-- tax_computations, period_closing_balances, or any prepared-statement
-- table. See Phase 9 of the North-Star document-review directive for the
-- full "source → candidate → finding → reviewer decision → accepted fact"
-- authority chain this table is the root of; only the root (this table) is
-- built here — the candidate/finding/reviewer-decision layers are future
-- work, deliberately not spéculated into a schema here.
--
-- THIS MIGRATION IS UNAPPLIED. It has not been run against any database —
-- committed to the repository only, per the assessment-and-design
-- authorization it was written under. Do not run `supabase db push` (or
-- paste this into a live SQL editor) without separate, explicit
-- authorization.
--
-- Design notes on the status state machine (see CHECK constraint below):
-- the directive's full literal state list is SELECTED -> UPLOADING ->
-- STORED -> CLASSIFYING -> EXTRACTING -> READY_FOR_REVIEW, with failure
-- states UPLOAD_FAILED, CLASSIFICATION_FAILED, EXTRACTION_FAILED,
-- QUARANTINED. SELECTED/UPLOADING/UPLOAD_FAILED describe states that exist
-- only in the browser before any server call succeeds —
-- financial-statement-intake (the Edge Function that is this table's sole
-- write path) receives the complete file in one request and only creates a
-- row once the bytes are durably stored, so a persisted row's status always
-- starts at STORED. Acceptance-repair correction: these three were
-- previously kept in the CHECK constraint "for schema completeness" —
-- removed. No real server transition can legally produce them, and a
-- persisted-but-unreachable enum value is exactly the kind of speculative
-- schema surface this migration otherwise avoids. They can be reintroduced
-- in a future migration alongside the async/multi-part upload flow that
-- would actually use them. (TEXT + CHECK, not a native Postgres ENUM type —
-- matches this repository's established convention for status columns, see
-- tb_certifications/hesabu_validations.)

CREATE TABLE public.financial_statement_documents (
  id                          UUID        NOT NULL DEFAULT gen_random_uuid(),
  company_id                  UUID        NOT NULL,
  period_year                 INTEGER     NOT NULL,
  uploaded_by_firm_member_id  UUID        NOT NULL,
  original_file_name          TEXT        NOT NULL,
  mime_type                   TEXT        NOT NULL,
  byte_size                   BIGINT      NOT NULL,
  sha256                      TEXT        NOT NULL,
  artifact_class               TEXT       NOT NULL,
  status                      TEXT        NOT NULL DEFAULT 'STORED',
  storage_path                TEXT        NOT NULL,
  source_version               INTEGER    NOT NULL DEFAULT 1,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at                TIMESTAMPTZ NULL,

  CONSTRAINT fsd_pk PRIMARY KEY (id),

  CONSTRAINT fk_fsd_company
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
    -- RESTRICT, not CASCADE: acceptance-repair correction. An immutable
    -- evidence record must never be silently removed as a side effect of
    -- deleting its company — that is exactly the kind of implicit
    -- destruction this table's append-only design exists to prevent. A
    -- company with financial_statement_documents rows cannot be deleted
    -- until those rows are handled by a deliberate, separate process (which
    -- does not exist yet — this table has no delete path of its own at all,
    -- see trg_fsd_guard below).

  CONSTRAINT fk_fsd_uploaded_by
    FOREIGN KEY (uploaded_by_firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,
    -- RESTRICT, not CASCADE/SET NULL: the actor identity on an immutable
    -- evidence record must never silently disappear. A firm member cannot
    -- be hard-deleted while they are the recorded uploader of a document
    -- still in scope; membership removal (accepted_at handling) is a
    -- separate, softer concept elsewhere in the schema.

  CONSTRAINT chk_fsd_period_year
    CHECK (period_year BETWEEN 2000 AND 2100),

  CONSTRAINT chk_fsd_byte_size
    CHECK (byte_size > 0 AND byte_size <= 52428800), -- 50MB ceiling, mirrors the Edge Function's own hard cap

  CONSTRAINT chk_fsd_sha256
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),

  CONSTRAINT chk_fsd_artifact_class
    CHECK (artifact_class IN (
      'trial_balance', 'financial_statements', 'mixed_workbook',
      'scanned_document', 'structured_xbrl', 'unsupported', 'ambiguous'
    )),

  CONSTRAINT chk_fsd_status
    CHECK (status IN (
      'STORED', 'CLASSIFYING', 'EXTRACTING', 'READY_FOR_REVIEW',
      'CLASSIFICATION_FAILED', 'EXTRACTION_FAILED', 'QUARANTINED'
    )),

  CONSTRAINT chk_fsd_source_version
    CHECK (source_version >= 1)
);

COMMENT ON TABLE public.financial_statement_documents IS
  'Immutable source-document ledger for the statement-review intake surface. '
  'Never accounting truth — see Phase 9 evidence chain in this migration''s header comment.';

-- One document per exact byte content per company/period — a retried
-- upload of the identical file returns the existing row instead of creating
-- a duplicate. Scoped to non-superseded rows only, so a genuine replacement
-- (a new version of a previously superseded document) is not blocked by
-- its own predecessor's hash.
CREATE UNIQUE INDEX uq_fsd_company_period_sha256
  ON public.financial_statement_documents (company_id, period_year, sha256)
  WHERE superseded_at IS NULL;

CREATE INDEX idx_fsd_company_period
  ON public.financial_statement_documents (company_id, period_year);

-- ── Immutability + legal status-transition enforcement ──────────────────
--
-- DELETE is unconditionally rejected — append-only, no exception. A row
-- only ever exists once the file is durably stored (see header note), so
-- "deletion is prohibited after processing begins" is satisfied as the
-- strict (simpler, safer) case of "deletion is prohibited, full stop."
--
-- UPDATE is rejected unless it is EITHER a legal status transition (status
-- changes to an allowed next value; every other column identical) OR a
-- supersession (superseded_at set from NULL to NOT NULL; every other
-- column, including status, identical). No update may ever touch
-- company_id, period_year, uploaded_by_firm_member_id, original_file_name,
-- mime_type, byte_size, sha256, artifact_class, storage_path,
-- source_version, or created_at — the immutable source fields.

CREATE OR REPLACE FUNCTION public.financial_statement_documents_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_allowed_next TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Iron Dome: financial_statement_documents is append-only. DELETE is not permitted. [id=%]',
      OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- TG_OP = 'UPDATE' from here.
  IF NEW.company_id                 IS DISTINCT FROM OLD.company_id
     OR NEW.period_year             IS DISTINCT FROM OLD.period_year
     OR NEW.uploaded_by_firm_member_id IS DISTINCT FROM OLD.uploaded_by_firm_member_id
     OR NEW.original_file_name      IS DISTINCT FROM OLD.original_file_name
     OR NEW.mime_type               IS DISTINCT FROM OLD.mime_type
     OR NEW.byte_size               IS DISTINCT FROM OLD.byte_size
     OR NEW.sha256                  IS DISTINCT FROM OLD.sha256
     OR NEW.artifact_class          IS DISTINCT FROM OLD.artifact_class
     OR NEW.storage_path            IS DISTINCT FROM OLD.storage_path
     OR NEW.source_version          IS DISTINCT FROM OLD.source_version
     OR NEW.created_at              IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Iron Dome: financial_statement_documents source fields are immutable. [id=%]',
      OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- Supersession: superseded_at may be set exactly once (NULL -> NOT NULL),
  -- with status left untouched by this same update.
  IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    IF OLD.superseded_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Iron Dome: financial_statement_documents.superseded_at may only be set once. [id=%]',
        OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.superseded_at IS NULL OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION
        'Iron Dome: superseded_at may only transition NULL -> NOT NULL, alone. [id=%]',
        OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- Status transition: legal next-state list per the directive's state
  -- machine. No arbitrary jumps.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_allowed_next := CASE OLD.status
      WHEN 'STORED'                 THEN ARRAY['CLASSIFYING', 'QUARANTINED']
      WHEN 'CLASSIFYING'            THEN ARRAY['EXTRACTING', 'CLASSIFICATION_FAILED', 'QUARANTINED']
      WHEN 'EXTRACTING'             THEN ARRAY['READY_FOR_REVIEW', 'EXTRACTION_FAILED', 'QUARANTINED']
      WHEN 'CLASSIFICATION_FAILED'  THEN ARRAY['QUARANTINED']
      WHEN 'EXTRACTION_FAILED'      THEN ARRAY['QUARANTINED']
      ELSE ARRAY[]::TEXT[] -- READY_FOR_REVIEW and QUARANTINED are terminal for this table
    END;
    IF NOT (NEW.status = ANY(v_allowed_next)) THEN
      RAISE EXCEPTION
        'Iron Dome: illegal status transition % -> % for financial_statement_documents. [id=%]',
        OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- Neither superseded_at nor status changed, and no immutable field
  -- changed either — this is a genuine no-op update; permit it (keeps the
  -- idempotent-insert helper function below simple; see its own comment).
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fsd_guard
  BEFORE UPDATE OR DELETE ON public.financial_statement_documents
  FOR EACH ROW EXECUTE FUNCTION public.financial_statement_documents_guard();

-- ── RLS — cross-firm access is denied structurally, not by convention ───

ALTER TABLE public.financial_statement_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fsd_select" ON public.financial_statement_documents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.company_id = financial_statement_documents.company_id
        AND fm.user_id = auth.uid()
        AND fm.accepted_at IS NOT NULL
    )
  );

-- No INSERT/UPDATE/DELETE policy for `authenticated` or `anon` at all —
-- every write goes through intake_financial_statement_document() below,
-- a SECURITY DEFINER function called only by the financial-statement-intake
-- Edge Function's service-role client (RLS does not apply to that role, but
-- the function independently re-verifies firm membership itself — see its
-- own body — so a compromised anon/authenticated key alone can never write
-- this table under any circumstance).

REVOKE ALL ON public.financial_statement_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.financial_statement_documents TO authenticated;

-- ── Sole write path — idempotent insert-or-return-existing ──────────────
--
-- Re-verifies firm membership from firmMemberId + companyId itself (does
-- not trust the caller's own prior check) — defense in depth matching this
-- repository's established pattern (see resolve_account_review_batch,
-- commit_tb_certification). The browser never calls this function directly;
-- only the Edge Function's service-role admin client does, after its own
-- resolveFirmMemberActor() check.

CREATE OR REPLACE FUNCTION public.intake_financial_statement_document(
  p_company_id                 UUID,
  p_period_year                INTEGER,
  p_uploaded_by_firm_member_id UUID,
  p_original_file_name         TEXT,
  p_mime_type                  TEXT,
  p_byte_size                  BIGINT,
  p_sha256                     TEXT,
  p_artifact_class             TEXT,
  p_storage_path                TEXT
)
  RETURNS public.financial_statement_documents
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.financial_statement_documents;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.id = p_uploaded_by_firm_member_id
      AND fm.company_id = p_company_id
      AND fm.accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: firm member % is not an accepted member of company %', p_uploaded_by_firm_member_id, p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent replay: the same exact file content for this company/period
  -- returns the existing document rather than raising a conflict or
  -- creating a duplicate.
  SELECT * INTO v_row
    FROM public.financial_statement_documents
   WHERE company_id = p_company_id
     AND period_year = p_period_year
     AND sha256 = p_sha256
     AND superseded_at IS NULL
   LIMIT 1;

  IF FOUND THEN
    RETURN v_row;
  END IF;

  INSERT INTO public.financial_statement_documents (
    company_id, period_year, uploaded_by_firm_member_id, original_file_name,
    mime_type, byte_size, sha256, artifact_class, status, storage_path
  ) VALUES (
    p_company_id, p_period_year, p_uploaded_by_firm_member_id, p_original_file_name,
    p_mime_type, p_byte_size, p_sha256, p_artifact_class, 'STORED', p_storage_path
  )
  RETURNING * INTO v_row;

  RETURN v_row;
EXCEPTION
  WHEN unique_violation THEN
    -- Lost a concurrent race against another request inserting the exact
    -- same (company_id, period_year, sha256) simultaneously — re-select
    -- and return the winner's row rather than raising to the caller.
    SELECT * INTO v_row
      FROM public.financial_statement_documents
     WHERE company_id = p_company_id
       AND period_year = p_period_year
       AND sha256 = p_sha256
       AND superseded_at IS NULL
     LIMIT 1;
    RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.intake_financial_statement_document(UUID, INTEGER, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_financial_statement_document(UUID, INTEGER, UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT) TO service_role;
-- Explicit GRANT to service_role, explicit REVOKE from everyone else — the
-- browser (anon/authenticated) can never call this under any circumstance;
-- only the Edge Function's service-role key (held solely in its server-side
-- environment, never shipped to the client) may execute it.

-- A read-only hash-replay lookup is deliberately NOT added as a separate
-- function: intake_financial_statement_document() above already performs
-- the identical SELECT-before-INSERT atomically, inside the same
-- transaction/advisory scope as the insert itself. A separate lookup
-- function would only reintroduce the check-then-act race this one avoids.

-- ── Advance status (CLASSIFYING/EXTRACTING/READY_FOR_REVIEW/failure) ────
-- Thin wrapper so the state machine's legal-transition enforcement (the
-- trigger above) is the single source of truth; this function adds nothing
-- beyond "call it as the service role."

CREATE OR REPLACE FUNCTION public.advance_financial_statement_document_status(
  p_document_id UUID,
  p_next_status TEXT
)
  RETURNS public.financial_statement_documents
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.financial_statement_documents;
BEGIN
  UPDATE public.financial_statement_documents
     SET status = p_next_status
   WHERE id = p_document_id
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no financial_statement_documents row with id %', p_document_id
      USING ERRCODE = 'P0002';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_financial_statement_document_status(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_financial_statement_document_status(UUID, TEXT) TO service_role;

-- ── Private storage bucket ────────────────────────────────────────────────
-- Path convention (server-generated only, never client-chosen; acceptance-
-- repair correction — content-addressed, not a random UUID, so a retried
-- upload of identical bytes always resolves to the identical object):
--   {company_id}/{period_year}/{sha256}.{canonical_extension}
-- No INSERT/UPDATE/DELETE storage policy exists for authenticated/anon —
-- only the Edge Function's service-role client writes bytes, after its own
-- MIME-signature/size/membership checks. SELECT is company-membership-
-- scoped for short-lived signed-URL reads (e.g. a reviewer opening the
-- original document) — signed URLs are still required; a private bucket
-- SELECT policy alone does not make objects publicly listable/fetchable.

INSERT INTO storage.buckets (id, name, public)
VALUES ('financial-statement-documents', 'financial-statement-documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "fsd_storage_select" ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'financial-statement-documents'
    AND EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.user_id = auth.uid()
        AND fm.accepted_at IS NOT NULL
        AND fm.company_id::text = (storage.foldername(name))[1]
    )
  );
