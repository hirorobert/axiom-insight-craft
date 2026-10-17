-- 20261108100000_account_identity_codeless_name.sql — accounts with different codes may share a name
-- (authorised processing-integrity repair B, 2026-10-16). Forward-only; nothing existing is edited.
--
-- The defect: an account's identity is account_key = COALESCE(account_code, normalized_account_name) — unique per
-- company (uq_acct_map_company_key, 20260703120000), and every review write is ON CONFLICT (company_id, account_key).
-- The older partial index uq_acct_map_company_norm_name (company_id, normalized_account_name) WHERE the name is not
-- NULL (20260703100000, kept "as belt-and-suspenders") enforces a DIFFERENT identity — the name, for every account — so
-- two coded accounts with the same name (4000 "Sales", 4100 "Sales") could not both be reviewed: the second review
-- failed with a raw unique violation (23505), as did renaming a coded account to a name another code already used.
--
-- The repair: that index is replaced by uq_acct_map_company_codeless_name — name uniqueness ONLY where the name IS the
-- identity (account_code IS NULL), NULLS NOT DISTINCT as before (one global codeless row per name). Nothing else
-- changes: code uniqueness (uq_acct_map_company_code) and key uniqueness (uq_acct_map_company_key) are untouched;
-- company_id stays in every key (tenant isolation unchanged); no row is rewritten, merged or removed; every account
-- key, decision and its history stays as it is.
--
-- Compatibility (inspected, every writer and reader):
--   * The only writer, resolve_account_review_batch (latest 20261007100000), conflicts on (company_id, account_key); it
--     never relied on name uniqueness. Client writes are refused (account_mappings_client_write_guard, 20261006100000).
--   * Every rule the old index enforced for CODELESS rows still holds: their account_key IS the normalized name, so
--     uq_acct_map_company_key already implied it; the new index states it explicitly.
--   * Readers that key by account_key or account_code (certifiedTbSource cash perimeter, the statements workspace,
--     kinga-findings-engine, get_effective_non_reporting_status by review_account_key) are unaffected.
--   * process-trial-balance's name fallback (Tier 2) used a last-wins Map that was deterministic only because of the
--     old index. Generation 6 of the function (same change set) matches names by counting candidates: zero, one, or
--     several — several is never resolved by picking one; it goes to review. A coded account never takes a decision
--     made for a different code by name.
--   * Older engines (generation 5 and earlier) keep last-wins over coded same-name rows that can now exist; a floor of
--     6 (processing_release_control.min_engine_generation) retires them once generation 6 is deployed.

DO $preflight$
BEGIN
  IF to_regclass('public.uq_acct_map_company_key') IS NULL OR to_regclass('public.uq_acct_map_company_code') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the account key or code identity index is missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regclass('public.uq_acct_map_company_codeless_name') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the codeless name identity is already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

CREATE UNIQUE INDEX uq_acct_map_company_codeless_name
  ON public.account_mappings (company_id, normalized_account_name)
  NULLS NOT DISTINCT
  WHERE account_code IS NULL AND normalized_account_name IS NOT NULL;

DROP INDEX IF EXISTS public.uq_acct_map_company_norm_name;

COMMENT ON INDEX public.uq_acct_map_company_codeless_name IS
  'An account without a code is identified by its normalized name: one per company (one global). Accounts with codes '
  'are identified by their code and may share a name (20261108100000).';

-- ── Rollback (manual) ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Only while no two coded rows of one company share a normalized name (otherwise the old index cannot be rebuilt;
-- such rows are distinct accounts and must not be merged to make it fit):
-- CREATE UNIQUE INDEX uq_acct_map_company_norm_name ON public.account_mappings (company_id, normalized_account_name)
--   NULLS NOT DISTINCT WHERE normalized_account_name IS NOT NULL;
-- DROP INDEX IF EXISTS public.uq_acct_map_company_codeless_name;
