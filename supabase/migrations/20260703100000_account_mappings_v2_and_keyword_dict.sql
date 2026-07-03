-- ============================================================
-- Migration: 20260703100000 — account_mappings v2 + keyword_dictionary
-- Part 1 of Task 1b: Manual Account Mapping + Learning Dictionary
-- SCHEMA ONLY — no RLS changes (flagged note at bottom)
--
-- Applied manually via Supabase SQL Editor on 2026-07-03.
-- Committed for repo/migration-history sync. Do not re-run.
-- ============================================================

BEGIN;

-- ══════════════════════════════════════════════════════════════
-- SECTION A — Backfill guard
-- Aborts if any existing row cannot have company_id derived
-- unambiguously (user owns 0 or >1 active companies).
-- Expected: no-op (database cleaned to 0 rows on 2026-07-03).
-- ══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_undecidable INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_undecidable
  FROM public.account_mappings am
  WHERE (
    SELECT COUNT(*)
    FROM   public.companies c
    WHERE  c.user_id   = am.user_id
      AND  c.is_active = true
  ) <> 1;

  IF v_undecidable > 0 THEN
    RAISE EXCEPTION
      'BACKFILL BLOCKED: % row(s) in account_mappings cannot have '
      'company_id derived — user owns 0 or >1 active companies. '
      'Inspect manually before running this migration.',
      v_undecidable;
  END IF;
END;
$$;

-- ══════════════════════════════════════════════════════════════
-- SECTION B — Alter account_mappings
-- ══════════════════════════════════════════════════════════════

-- B1. Add new columns
ALTER TABLE public.account_mappings
  ADD COLUMN IF NOT EXISTS company_id               UUID        NULL
    REFERENCES public.companies(id),
  ADD COLUMN IF NOT EXISTS normalized_account_name  TEXT        NULL,
  ADD COLUMN IF NOT EXISTS confidence_source        TEXT        NOT NULL DEFAULT 'user_approved',
  ADD COLUMN IF NOT EXISTS approved_at              TIMESTAMPTZ NOT NULL DEFAULT now();

-- B2. Drop NOT NULL on account_code
ALTER TABLE public.account_mappings
  ALTER COLUMN account_code DROP NOT NULL;

-- B3. CHECK: every row must have at least one identifier
ALTER TABLE public.account_mappings
  ADD CONSTRAINT chk_account_mappings_has_identifier
    CHECK (account_code IS NOT NULL OR normalized_account_name IS NOT NULL);

-- B4. Drop old unique constraint (user_id + account_code)
ALTER TABLE public.account_mappings
  DROP CONSTRAINT IF EXISTS unique_user_account_mapping;

-- B5. Partial unique indexes with NULLS NOT DISTINCT
--
-- NULLS NOT DISTINCT (PG 15+): required because company_id = NULL means
-- "global mapping". Without it PostgreSQL treats (NULL, 'audit fee') as
-- distinct from another (NULL, 'audit fee'), allowing duplicate globals.
--
CREATE UNIQUE INDEX IF NOT EXISTS uq_acct_map_company_code
  ON public.account_mappings (company_id, account_code)
  NULLS NOT DISTINCT
  WHERE account_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_acct_map_company_norm_name
  ON public.account_mappings (company_id, normalized_account_name)
  NULLS NOT DISTINCT
  WHERE normalized_account_name IS NOT NULL;

-- B6. Backfill company_id for any existing rows (no-op if table empty)
UPDATE public.account_mappings am
SET company_id = (
  SELECT c.id
  FROM   public.companies c
  WHERE  c.user_id   = am.user_id
    AND  c.is_active = true
  LIMIT 1
)
WHERE am.company_id IS NULL;

-- B7. Backfill normalized_account_name from account_name (no-op if empty)
-- Normalization: strip punctuation → collapse whitespace → trim → lowercase
UPDATE public.account_mappings
SET normalized_account_name = lower(trim(
  regexp_replace(
    regexp_replace(account_name, '[[:punct:]]', '', 'g'),
    '\s+', ' ', 'g'
  )
))
WHERE normalized_account_name IS NULL;

-- B8. Column comments
COMMENT ON COLUMN public.account_mappings.company_id IS
  'Scopes the mapping to a specific company. '
  'NULL = global (applies to all companies for this user). '
  'Enforced unique per (company_id, account_code) and '
  'per (company_id, normalized_account_name) via partial indexes.';

COMMENT ON COLUMN public.account_mappings.normalized_account_name IS
  'Lowercase, punctuation-stripped, whitespace-collapsed version of '
  'account_name. Used for fuzzy lookup when account_code is absent. '
  'Normalization: lower(trim(strip_punct(collapse_ws(account_name)))).';

COMMENT ON COLUMN public.account_mappings.confidence_source IS
  'How this mapping was established. '
  'Values: user_approved | auto_classified | keyword_dict | fuzzy_match.';

COMMENT ON COLUMN public.account_mappings.approved_at IS
  'Timestamp of last approval or classification. '
  'For auto_classified rows: classification timestamp. '
  'For user_approved rows: when the user confirmed the mapping.';

-- ══════════════════════════════════════════════════════════════
-- SECTION C — keyword_dictionary (new table)
--
-- 10 valid classification targets: all BS/IS classes.
-- cash_flow classes (operating_activities, investing_activities,
-- financing_activities) intentionally excluded — keyword lookup
-- cannot reliably target cash flow sections from a GL name alone.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.keyword_dictionary (
  id             UUID  NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  term           TEXT  NOT NULL,
  language       TEXT  NOT NULL
                   CHECK (language IN ('en', 'sw')),
  classification TEXT  NOT NULL
                   CHECK (classification IN (
                     'current_assets',
                     'non_current_assets',
                     'current_liabilities',
                     'non_current_liabilities',
                     'equity',
                     'revenue',
                     'cost_of_goods_sold',
                     'operating_expenses',
                     'other_income',
                     'taxes'
                     -- 'operating_activities', 'investing_activities',
                     -- 'financing_activities' excluded by design
                   )),
  match_type     TEXT  NOT NULL DEFAULT 'contains'
                   CHECK (match_type IN ('exact', 'contains')),
  CONSTRAINT uq_keyword_dict_term_lang
    UNIQUE (term, language)
);

ALTER TABLE public.keyword_dictionary ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read; writes are migration-only (service role).
CREATE POLICY "Authenticated users can read keyword dictionary"
  ON public.keyword_dictionary FOR SELECT
  TO authenticated
  USING (true);

CREATE INDEX IF NOT EXISTS idx_keyword_dict_term
  ON public.keyword_dictionary (term);

CREATE INDEX IF NOT EXISTS idx_keyword_dict_classification
  ON public.keyword_dictionary (classification);

COMMENT ON TABLE public.keyword_dictionary IS
  'Global lookup dictionary for account name → classification. '
  'Seeded by migration 20260703110000. '
  'English and Swahili terms for common Tanzanian SME accounts. '
  'Tier 3 in the classifier lookup order: after account_mappings, '
  'before autoClassifyAccount regex rules.';

-- ══════════════════════════════════════════════════════════════
-- RLS NOTE (flagged — not changed in this migration)
-- ══════════════════════════════════════════════════════════════
-- The four existing RLS policies on account_mappings use:
--   USING (auth.uid() = user_id)
-- Once company_id is in use, these need extending to also permit
-- access via firm_members (company-scoped non-owner users):
--
--   USING (
--     auth.uid() = user_id
--     OR EXISTS (
--       SELECT 1 FROM public.firm_members fm
--       WHERE fm.company_id = account_mappings.company_id
--         AND fm.user_id    = auth.uid()
--     )
--   )
--
-- This change is deferred to a separate RLS migration.
-- ══════════════════════════════════════════════════════════════

COMMIT;
