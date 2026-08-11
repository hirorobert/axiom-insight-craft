-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ PUBLIC-SECTOR / FRAMEWORK INTELLIGENCE ENGINE — SLICE 12
-- account_mapping_memory — versioned, provenanced, period-scoped classification
-- confirmations (directive Section XV: "Audited-Mapping Memory").
--
-- Additive only. APPEND-ONLY ledger. Does NOT replace account_mappings.
-- Rollback statements are at the bottom of this file, commented out.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE public.account_mapping_memory (
  id                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  company_id            UUID         NOT NULL,
  source_system         TEXT         NOT NULL DEFAULT 'UNKNOWN',
  natural_account_code  TEXT         NULL,
  normalized_account_name TEXT       NOT NULL,
  reporting_framework   TEXT         NOT NULL,
  account_nature        TEXT         NOT NULL,
  presentation_code     TEXT         NOT NULL,
  presentation_label    TEXT         NULL,
  note_code              TEXT         NULL,
  cash_flow_class        TEXT         NULL,
  effective_period_year  INTEGER      NOT NULL,
  evidence_source        TEXT         NOT NULL
    CHECK (evidence_source IN (
      'DOCUMENTED_COMPLIANCE_STATEMENT', 'PRIOR_PROFESSIONAL_CONFIRMATION',
      'CONFIGURED_ENGAGEMENT_CONTEXT', 'SOURCE_SYSTEM_SIGNATURE',
      'LEGAL_FORM_EVIDENCE', 'LEXICAL_SIGNAL', 'USER_MANUAL_ENTRY', 'UNKNOWN'
    )),
  audit_status            TEXT        NOT NULL DEFAULT 'system_rule'
    CHECK (audit_status IN (
      'cag_external_audited', 'saff_professionally_approved',
      'user_approved_current', 'system_rule'
    )),
  rule_id                 TEXT        NULL,
  rule_version             TEXT        NULL,
  confirmed_by             UUID        NULL,
  confirmed_at             TIMESTAMPTZ NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_mapping_memory_pk
    PRIMARY KEY (id),
  CONSTRAINT fk_amm_company
    FOREIGN KEY (company_id)
    REFERENCES public.companies(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_amm_confirmed_by
    FOREIGN KEY (confirmed_by)
    REFERENCES public.firm_members(id)
    ON DELETE SET NULL,
  CONSTRAINT amm_confirmed_fields_required_when_audited
    CHECK (
      audit_status = 'system_rule'
      OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
    ),
  CONSTRAINT amm_period_year_sane
    CHECK (effective_period_year BETWEEN 2000 AND 2100)
);

COMMENT ON TABLE public.account_mapping_memory IS
  'Ω∞ Slice 12: append-only, period-scoped, provenanced classification '
  'confirmations. Does not replace account_mappings (the live classifier''s '
  'lookup source) — this is the audit trail account_mappings itself lacks. '
  'A correction is a NEW row with a later created_at, never an UPDATE to '
  'an existing one (see trg_amm_immutable below).';

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX idx_amm_company_period
  ON public.account_mapping_memory (company_id, effective_period_year);

CREATE INDEX idx_amm_company_code_period
  ON public.account_mapping_memory (company_id, natural_account_code, effective_period_year)
  WHERE natural_account_code IS NOT NULL;

CREATE INDEX idx_amm_company_normalized_name_period
  ON public.account_mapping_memory (company_id, normalized_account_name, effective_period_year);

-- ── Immutability (append-only ledger) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.account_mapping_memory_immutable()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Iron Dome: account_mapping_memory is append-only. % is not permitted. [id=%]',
    TG_OP, COALESCE(OLD.id::TEXT, 'N/A')
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_amm_immutable
  BEFORE UPDATE OR DELETE ON public.account_mapping_memory
  FOR EACH ROW EXECUTE FUNCTION public.account_mapping_memory_immutable();

-- ── "Latest confirmed mapping per (company, code, period)" helper view ───────
CREATE OR REPLACE VIEW public.v_latest_account_mapping_memory AS
  SELECT DISTINCT ON (company_id, natural_account_code, effective_period_year)
    *
  FROM public.account_mapping_memory
  WHERE natural_account_code IS NOT NULL
  ORDER BY company_id, natural_account_code, effective_period_year, created_at DESC;

COMMENT ON VIEW public.v_latest_account_mapping_memory IS
  'Most recent confirmation per (company, natural_account_code, period) — '
  'consumers read this view, never account_mapping_memory directly, so a '
  'superseding row always wins without any row ever being deleted or updated.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.account_mapping_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "amm_select" ON public.account_mapping_memory
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id    = auth.uid()
         AND fm.company_id = account_mapping_memory.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );

-- INSERT: service_role only (Edge Functions hold sole write authority).
GRANT SELECT ON public.account_mapping_memory TO authenticated;
GRANT SELECT ON public.v_latest_account_mapping_memory TO authenticated;
GRANT ALL    ON public.account_mapping_memory TO service_role;

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- DROP VIEW IF EXISTS public.v_latest_account_mapping_memory;
-- DROP TRIGGER IF EXISTS trg_amm_immutable ON public.account_mapping_memory;
-- DROP FUNCTION IF EXISTS public.account_mapping_memory_immutable();
-- DROP TABLE IF EXISTS public.account_mapping_memory CASCADE;
