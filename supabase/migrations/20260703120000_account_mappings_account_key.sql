-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260703120000_account_mappings_account_key
-- Purpose  : Add generated account_key column + full unique index so that
--            PostgREST .upsert({ onConflict: 'company_id,account_key' }) can
--            resolve conflicts atomically.
--
-- Background: the two partial unique indexes from migration 20260703100000
--   (uq_acct_map_company_code / uq_acct_map_company_norm_name) cannot be
--   targeted by PostgREST's ON CONFLICT (col, col) form — Postgres requires
--   an explicit WHERE predicate in the conflict target to match a partial index,
--   which the Supabase JS client does not support.
--
-- Solution  : GENERATED ALWAYS column account_key = COALESCE(account_code,
--             normalized_account_name) + a full (non-partial) unique index on
--             (company_id, account_key). Coded accounts resolve to account_code;
--             codeless accounts resolve to normalized_account_name.
--
-- NOTE: This migration was applied MANUALLY in Supabase on 2026-07-03.
--       This file exists solely so the repo reflects the live DB state.
--       DO NOT re-run against any database.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.account_mappings
  ADD COLUMN IF NOT EXISTS account_key TEXT
    GENERATED ALWAYS AS (COALESCE(account_code, normalized_account_name)) STORED;

-- Full unique index (no WHERE clause) targetable by PostgREST column-list inference.
CREATE UNIQUE INDEX IF NOT EXISTS uq_acct_map_company_key
  ON public.account_mappings (company_id, account_key)
  NULLS NOT DISTINCT;

-- The two partial indexes from migration 20260703100000 are retained as
-- belt-and-suspenders. Drop them in a future cleanup after PART 5 passes.
