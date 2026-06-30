-- ============================================================
-- Migration: 20260630100000 — Phase 5A: Period Registry
-- Date: 2026-06-30
-- Standards: IFRS, IPSAS, ITA Cap.332
--
-- PURPOSE:
--   Every TB upload is tagged to a fiscal period so the system
--   can diff current-year vs prior-year figures. This is the
--   foundation required by IPSAS 1 / IAS 1 comparability principle:
--   "An entity shall present comparative information in respect of
--   the preceding period for all amounts reported in the financial
--   statements." (IAS 1.38)
--
-- NEW TABLES:
--   fiscal_periods  — one row per company per year-end
--
-- NEW COLUMNS on existing tables:
--   trial_balance_uploads.period_id        → FK → fiscal_periods
--   trial_balance_uploads.fiscal_year_end  → DATE (denormalized for fast lookup)
--   trial_balance_uploads.company_id       → UUID FK → companies (if not present)
--   capital_allowances.period_id           → FK → fiscal_periods
--   tax_computations.period_id             → FK → fiscal_periods
--
-- PURELY ADDITIVE. No data destroyed.
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════
-- 1. FISCAL PERIODS
-- ════════════════════════════════════════════════════════════
-- One row per company per financial year-end date.
-- Multiple uploads can exist per period (re-uploads, corrections).
-- The "active" upload_id is the one the engines use.

CREATE TABLE IF NOT EXISTS public.fiscal_periods (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Year-end date (e.g. 2025-12-31 for calendar year, 2025-06-30 for June year-end)
  fiscal_year_end   DATE        NOT NULL,

  -- Human label e.g. "FY2025", "Year ended 31 December 2025"
  period_label      TEXT        NOT NULL,

  -- Which periods to use when diffing: prior_period_id chains backwards
  prior_period_id   UUID        REFERENCES public.fiscal_periods(id) ON DELETE SET NULL,

  -- The canonical TB upload for this period (set after upload passes VALID)
  active_upload_id  UUID        REFERENCES public.trial_balance_uploads(id) ON DELETE SET NULL,

  -- Lock prevents edits after CPA signs off
  status            TEXT        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'locked', 'archived')),

  -- Reporting currency (ISO 4217). Axiom default = TZS.
  reporting_currency TEXT       NOT NULL DEFAULT 'TZS',

  -- Basis of preparation
  accounting_basis  TEXT        NOT NULL DEFAULT 'IFRS'
                    CHECK (accounting_basis IN ('IFRS', 'IPSAS', 'IFRS_SME', 'GAAP_TZ')),

  created_by        UUID        NOT NULL REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Each company can have only one period per year-end date
  UNIQUE (company_id, fiscal_year_end)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company_year
  ON public.fiscal_periods (company_id, fiscal_year_end DESC);

ALTER TABLE public.fiscal_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fp_select" ON public.fiscal_periods FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid() AND fm.company_id = fiscal_periods.company_id
  ));

CREATE POLICY "fp_insert" ON public.fiscal_periods FOR INSERT
  WITH CHECK (
    auth.uid() = created_by AND
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.user_id = auth.uid() AND fm.company_id = fiscal_periods.company_id
    )
  );

CREATE POLICY "fp_update" ON public.fiscal_periods FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid() AND fm.company_id = fiscal_periods.company_id
  ));

GRANT SELECT, INSERT, UPDATE ON public.fiscal_periods TO authenticated;
GRANT ALL ON public.fiscal_periods TO service_role;

COMMENT ON TABLE public.fiscal_periods IS
  'One row per company per fiscal year-end. '
  'Implements IAS 1.38 / IPSAS 1 comparability: prior_period_id chains '
  'back through history so comparative-engine can always find last year. '
  'status=locked prevents edits after CPA sign-off.';

COMMENT ON COLUMN public.fiscal_periods.prior_period_id IS
  'FK to the preceding fiscal period for this company. '
  'Enables kinga-comparative-engine to auto-fetch prior-year TB without '
  'the user having to specify it.';

COMMENT ON COLUMN public.fiscal_periods.active_upload_id IS
  'The canonical trial_balance_uploads.id for this period. '
  'Set automatically when an upload passes status=valid. '
  'Can be overridden by CPA if a re-upload supersedes an earlier one.';


-- ════════════════════════════════════════════════════════════
-- 2. TAG trial_balance_uploads WITH PERIOD
-- ════════════════════════════════════════════════════════════

-- company_id UUID (if not already present — safe to run twice via IF NOT EXISTS guard)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'trial_balance_uploads'
      AND column_name  = 'company_id'
  ) THEN
    ALTER TABLE public.trial_balance_uploads
      ADD COLUMN company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_tbu_company_id
      ON public.trial_balance_uploads (company_id);
  END IF;
END $$;

-- period_id FK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'trial_balance_uploads'
      AND column_name  = 'period_id'
  ) THEN
    ALTER TABLE public.trial_balance_uploads
      ADD COLUMN period_id UUID REFERENCES public.fiscal_periods(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_tbu_period_id
      ON public.trial_balance_uploads (period_id);
  END IF;
END $$;

-- fiscal_year_end DATE (denormalized fast lookup — kept in sync by trigger below)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'trial_balance_uploads'
      AND column_name  = 'fiscal_year_end'
  ) THEN
    ALTER TABLE public.trial_balance_uploads
      ADD COLUMN fiscal_year_end DATE;
  END IF;
END $$;

-- Trigger: when period_id is set on an upload, copy fiscal_year_end automatically
CREATE OR REPLACE FUNCTION public.sync_upload_fiscal_year_end()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.period_id IS NOT NULL THEN
    SELECT fiscal_year_end INTO NEW.fiscal_year_end
    FROM public.fiscal_periods
    WHERE id = NEW.period_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_upload_fiscal_year_end ON public.trial_balance_uploads;
CREATE TRIGGER trg_sync_upload_fiscal_year_end
  BEFORE INSERT OR UPDATE OF period_id
  ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.sync_upload_fiscal_year_end();

-- Trigger: when an upload is set to 'valid', auto-promote it to active_upload_id
CREATE OR REPLACE FUNCTION public.promote_valid_upload_to_active()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'valid' AND NEW.period_id IS NOT NULL THEN
    UPDATE public.fiscal_periods
    SET    active_upload_id = NEW.id,
           updated_at       = now()
    WHERE  id = NEW.period_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_promote_valid_upload ON public.trial_balance_uploads;
CREATE TRIGGER trg_promote_valid_upload
  AFTER INSERT OR UPDATE OF status
  ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.promote_valid_upload_to_active();


-- ════════════════════════════════════════════════════════════
-- 3. TAG capital_allowances WITH PERIOD
-- ════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'capital_allowances'
      AND column_name  = 'period_id'
  ) THEN
    ALTER TABLE public.capital_allowances
      ADD COLUMN period_id UUID REFERENCES public.fiscal_periods(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_ca_period_id
      ON public.capital_allowances (period_id);
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════
-- 4. TAG tax_computations WITH PERIOD
-- ════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'tax_computations'
      AND column_name  = 'period_id'
  ) THEN
    ALTER TABLE public.tax_computations
      ADD COLUMN period_id UUID REFERENCES public.fiscal_periods(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_tc_period_id
      ON public.tax_computations (period_id);
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════
-- 5. HELPER VIEW — current + prior period pair
-- ════════════════════════════════════════════════════════════
-- Used by kinga-comparative-engine: one query to get both years.

CREATE OR REPLACE VIEW public.v_period_pairs AS
SELECT
  cur.id                  AS current_period_id,
  cur.company_id,
  cur.fiscal_year_end     AS current_year_end,
  cur.period_label        AS current_label,
  cur.active_upload_id    AS current_upload_id,
  cur.reporting_currency,
  cur.accounting_basis,
  pri.id                  AS prior_period_id,
  pri.fiscal_year_end     AS prior_year_end,
  pri.period_label        AS prior_label,
  pri.active_upload_id    AS prior_upload_id
FROM public.fiscal_periods cur
LEFT JOIN public.fiscal_periods pri ON pri.id = cur.prior_period_id;

COMMENT ON VIEW public.v_period_pairs IS
  'Convenience view: each row is a (current, prior) period pair for one company. '
  'kinga-comparative-engine queries this to get both periods in one round-trip.';


COMMIT;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION SQL (run in Supabase SQL editor after applying)
-- ════════════════════════════════════════════════════════════

-- V1: fiscal_periods table exists
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE schemaname = 'public' AND tablename = 'fiscal_periods';
-- Expected: rowsecurity = true

-- V2: New columns on trial_balance_uploads
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'trial_balance_uploads'
--   AND column_name IN ('period_id', 'fiscal_year_end', 'company_id')
-- ORDER BY column_name;
-- Expected: 3 rows

-- V3: Triggers exist
-- SELECT trigger_name FROM information_schema.triggers
-- WHERE event_object_table = 'trial_balance_uploads'
--   AND trigger_name LIKE '%fiscal%' OR trigger_name LIKE '%upload%';

-- V4: View exists
-- SELECT * FROM public.v_period_pairs LIMIT 1;
