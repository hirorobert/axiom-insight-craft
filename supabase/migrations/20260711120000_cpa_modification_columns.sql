-- Migration: 20260711120000_cpa_modification_columns.sql
-- Phase 1-E — Iron Dome Nuclear Design: AddBacksWorkpaper CPA modification audit trail
--
-- Adds three columns to tax_computations to track when a CPA manually modifies
-- the JSONB add_backs or deductions arrays via the AddBacksWorkpaper UI.
--
-- Purpose:
--   When a CPA appends a manual line, the engine totals (taxable_income_tzs,
--   cit_at_30pct_tzs) are no longer correct — only the engine can recompute them.
--   Rather than having the frontend recompute those totals (which caused the
--   "dual CIT computation" divergence discovered in the Sprint 8+9 hardening audit),
--   we now record WHO modified the JSONB and WHEN, and set is_committed=false.
--   The CPA is shown a banner: "re-run Tax Engine to update totals, then re-commit."
--
-- Iron Dome invariant: taxable_income_tzs and cit_at_30pct_tzs are ONLY written
-- by the kinga-tax-engine Edge Function. This migration enforces that by removing
-- the frontend's ability to produce meaningful values for those columns.

ALTER TABLE tax_computations
  ADD COLUMN IF NOT EXISTS cpa_modified_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cpa_modified_by       UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS cpa_modification_note TEXT;

-- Index for audit queries: "show me all CPA-modified computations"
CREATE INDEX IF NOT EXISTS tax_computations_cpa_modified_at_idx
  ON tax_computations (cpa_modified_at)
  WHERE cpa_modified_at IS NOT NULL;

-- Comment on columns for Supabase dashboard clarity
COMMENT ON COLUMN tax_computations.cpa_modified_at IS
  'Timestamp of last manual CPA modification to add_backs or deductions JSONB. '
  'NULL = never manually modified. Non-null = engine totals are stale; re-run required.';

COMMENT ON COLUMN tax_computations.cpa_modified_by IS
  'auth.users ID of the CPA who last modified the JSONB arrays manually.';

COMMENT ON COLUMN tax_computations.cpa_modification_note IS
  'Human-readable note describing the CPA modification (e.g. "Manual add-back: disallowed penalty").';
