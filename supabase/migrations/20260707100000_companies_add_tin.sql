-- Migration: add tin column to companies table
-- TIN (Tax Identification Number) is the TRA-issued 9-digit number,
-- distinct from the internal company code used for filing reference.
-- Format: Tanzania TIN is typically "NNN-NNN-NNN" or "XXXXXXXXX".

ALTER TABLE companies ADD COLUMN IF NOT EXISTS tin text;

COMMENT ON COLUMN companies.tin IS
  'Tanzania Revenue Authority Tax Identification Number (TIN). '
  'Format: 9-digit numeric string, optionally hyphenated (100-123-456). '
  'Distinct from the internal company code field.';

-- No NOT NULL constraint — existing companies may not have TIN entered yet.
-- The export layer displays "—" when null.
