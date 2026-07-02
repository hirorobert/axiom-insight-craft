-- ============================================================
-- MIGRATION: Add reporting_framework to companies table
-- Migration: 20260701000001_companies_reporting_framework
-- Date: 2026-07-01
--
-- Adds a reporting_framework column so users can tag each
-- company with their statutory reporting standard.
-- The value determines statement header labels and
-- output format across SAFF ERP engines.
--
-- Values:
--   ifrs_for_smes   → IFRS for SMEs (default — private companies)
--   full_ifrs       → Full IFRS (listed, large entities)
--   ipsas_accrual   → IPSAS Accrual (public sector, government)
--   ipsas_cash      → IPSAS Cash Basis (smaller government entities)
-- ============================================================

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS reporting_framework TEXT
    NOT NULL DEFAULT 'ifrs_for_smes'
    CHECK (reporting_framework IN (
      'ifrs_for_smes',
      'full_ifrs',
      'ipsas_accrual',
      'ipsas_cash'
    ));

COMMENT ON COLUMN public.companies.reporting_framework IS
  'Statutory reporting framework: ifrs_for_smes (default) | full_ifrs | ipsas_accrual | ipsas_cash';
