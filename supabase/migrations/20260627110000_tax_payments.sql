-- ============================================================
-- Migration: 20260627110000 — tax_payments table
-- Date: 2026-06-27
-- Closes: OD-1 (payment tracking gap)
--
-- PROBLEM:
--   The findings engine compares computed obligation against zero.
--   It has no knowledge of what the company declared or paid.
--   Result: every finding shows GROSS obligation even when the
--   company already paid the full amount.
--
--   Example (Kamanga Medics SDL):
--     Gross obligation: TZS 103,072,691
--     Actually paid:    TZS  61,930,070  (from books — SDL expense account)
--     Net still owed:   TZS  41,142,621  (matches Note 6 outstanding)
--     Engine output:    TZS 103,072,691  (WRONG — 2.5× the real gap)
--
-- FIX:
--   tax_payments table records what the company declared/paid per
--   statutory category per period.
--
--   Sources of payment data:
--     'preparer_declared' — entered manually by the CPA preparer
--     'efdms_matched'     — derived from EFDMS receipt reconciliation
--     'tra_receipt'       — from TRA official receipt / ITAX portal
--
-- ENGINE CHANGE (Step C3, index.ts):
--   After computing gross_obligation_tzs:
--     SELECT SUM(amount_paid_tzs) WHERE company_id + period + category
--     net_variance = gross_obligation - sum_paid
--     Insert finding if net_variance > VARIANCE_THRESHOLD_TZS
--
-- PENALTY COMPUTATION:
--   TRA charges 5% per month on unpaid tax (s.76 Tax Administration Act 2015).
--   Engine will compute penalty_tzs based on months_overdue × 5% × net_variance.
--   months_overdue is derived from period_end to current date.
--
-- ============================================================

BEGIN;

-- ── tax_payments ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tax_payments (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Which statutory category this payment covers
  -- Matches findings.finding_category (e.g. 'sdl', 'nssf', 'nhif', 'wht_undistributed_earnings')
  tax_category        TEXT        NOT NULL,

  -- Period this payment covers
  period_year         INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  period_month        INTEGER     NOT NULL CHECK (period_month BETWEEN 1 AND 12),

  -- Amount paid (TZS)
  amount_paid_tzs     NUMERIC(18,2) NOT NULL CHECK (amount_paid_tzs >= 0),

  -- Date the payment was made or the liability was cleared
  payment_date        DATE        NOT NULL,

  -- Reference (TRA receipt number, ITAX transaction ID, bank reference, etc.)
  payment_reference   TEXT        NULL,

  -- Source of this payment record
  payment_source      TEXT        NOT NULL DEFAULT 'preparer_declared'
                      CHECK (payment_source IN (
                        'preparer_declared',   -- CPA entered manually
                        'efdms_matched',       -- derived from EFDMS reconciliation
                        'tra_receipt'          -- from TRA official receipt / ITAX
                      )),

  -- Optional notes (e.g. "paid in two instalments", "penalty waiver applied")
  notes               TEXT        NULL,

  -- Audit
  created_by          UUID        NOT NULL REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Engine Step C3 query: sum payments for company + category + period
CREATE INDEX IF NOT EXISTS idx_tax_payments_company_category_period
ON public.tax_payments (company_id, tax_category, period_year, period_month);

-- Audit / reporting: all payments for a company
CREATE INDEX IF NOT EXISTS idx_tax_payments_company_id
ON public.tax_payments (company_id, period_year DESC, period_month DESC);

-- ── Updated-at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tax_payments_updated_at ON public.tax_payments;
CREATE TRIGGER trg_tax_payments_updated_at
  BEFORE UPDATE ON public.tax_payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE public.tax_payments ENABLE ROW LEVEL SECURITY;

-- Firm members who have access to this company can read payments
CREATE POLICY "tax_payments_select"
ON public.tax_payments
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_payments.company_id
  )
);

-- Firm members can insert payment records for their companies
CREATE POLICY "tax_payments_insert"
ON public.tax_payments
FOR INSERT
WITH CHECK (
  auth.uid() = created_by
  AND EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_payments.company_id
  )
);

-- Firm members can update payment records (corrections)
CREATE POLICY "tax_payments_update"
ON public.tax_payments
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = tax_payments.company_id
  )
);

-- Only the creator can delete (soft-delete preferred — set notes = 'VOIDED')
CREATE POLICY "tax_payments_delete"
ON public.tax_payments
FOR DELETE
USING (created_by = auth.uid());

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON TABLE public.tax_payments IS
  'Records of statutory payments made by a company per tax category per period. '
  'Used by kinga-findings-engine Step C3 to compute net variance '
  '(gross_obligation - amount_paid) and penalty. '
  'Source: preparer_declared (manual CPA entry), efdms_matched (receipt reconciliation), '
  'or tra_receipt (TRA official receipt).';

COMMENT ON COLUMN public.tax_payments.tax_category IS
  'Matches findings.finding_category. '
  'Examples: sdl, nssf, nhif, wcf, paye, vat, wht_undistributed_earnings, '
  'service_levy, corporate_tax.';

COMMENT ON COLUMN public.tax_payments.amount_paid_tzs IS
  'Amount paid in Tanzanian Shillings. Must be non-negative. '
  'If a payment was reversed, insert a correction record with notes explaining it.';

COMMENT ON COLUMN public.tax_payments.payment_reference IS
  'TRA receipt number, ITAX transaction ID, bank reference, or other '
  'documentary reference linking this record to proof of payment.';

COMMIT;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION (run after applying in Supabase SQL editor)
-- ════════════════════════════════════════════════════════════

-- V1: Table exists with correct columns
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'tax_payments'
-- ORDER BY ordinal_position;
--
-- Expected: id, company_id, tax_category, period_year, period_month,
--           amount_paid_tzs, payment_date, payment_reference,
--           payment_source, notes, created_by, created_at, updated_at

-- V2: RLS enabled
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public' AND tablename = 'tax_payments';
-- Expected: rowsecurity = true

-- V3: Policies exist
-- SELECT policyname, cmd FROM pg_policies
-- WHERE tablename = 'tax_payments'
-- ORDER BY policyname;
-- Expected: 4 rows (select, insert, update, delete)


-- ════════════════════════════════════════════════════════════
-- SEED — Kamanga Medics known payments (run after applying)
-- Matches Note 6: SDL expense account 7104 = 103,072,691 paid
-- Outstanding = 41,142,621 (from balance sheet current liabilities)
-- Therefore paid = 103,072,691 - 41,142,621 = 61,930,070
-- ════════════════════════════════════════════════════════════

-- INSERT INTO public.tax_payments (
--   company_id, tax_category, period_year, period_month,
--   amount_paid_tzs, payment_date, payment_reference,
--   payment_source, notes, created_by
-- ) VALUES (
--   'd48009c7-426d-439a-a9f3-7406a1af97bb',  -- Kamanga Medics
--   'sdl',
--   2025, 12,
--   61930070.00,
--   '2025-12-31',
--   'SDL-PAID-FY2025',
--   'preparer_declared',
--   'SDL paid per books (SDL expense 103,072,691 less outstanding 41,142,621 = 61,930,070 paid)',
--   '4321c7cc-89f7-4f18-bfdf-30b9626caf2f'   -- cpahumphrey@gmail.com
-- );
-- Expected: INSERT 1
-- After this, engine Step C3 will compute:
--   gross_obligation: 103,072,691
--   declared_paid:     61,930,070
--   net_variance:      41,142,621  ← matches Note 6 exactly
--   penalty (5%/mo × months since period_end)
