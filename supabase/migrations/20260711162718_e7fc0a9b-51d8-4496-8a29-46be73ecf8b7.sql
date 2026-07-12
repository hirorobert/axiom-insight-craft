-- 20260711120000_cpa_modification_columns.sql
ALTER TABLE tax_computations
  ADD COLUMN IF NOT EXISTS cpa_modified_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cpa_modified_by       UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS cpa_modification_note TEXT;

CREATE INDEX IF NOT EXISTS tax_computations_cpa_modified_at_idx
  ON tax_computations (cpa_modified_at)
  WHERE cpa_modified_at IS NOT NULL;

COMMENT ON COLUMN tax_computations.cpa_modified_at IS
  'Timestamp of last manual CPA modification to add_backs or deductions JSONB. NULL = never manually modified. Non-null = engine totals are stale; re-run required.';

COMMENT ON COLUMN tax_computations.cpa_modified_by IS
  'auth.users ID of the CPA who last modified the JSONB arrays manually.';

COMMENT ON COLUMN tax_computations.cpa_modification_note IS
  'Human-readable note describing the CPA modification (e.g. "Manual add-back: disallowed penalty").';