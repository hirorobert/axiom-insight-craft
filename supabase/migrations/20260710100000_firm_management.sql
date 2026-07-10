-- ============================================================
-- Firm Management — Sprint 5 (roadmap item 8)
-- Migration: 20260710100000_firm_management.sql
-- Date: 2026-07-10
-- Depends on: 20260625130000_7a1e4d92 (firm_members table)
--
-- Changes:
--   1. Add invited_email TEXT NULL to firm_members
--      — stores the email used when the invitation was sent,
--        so the panel can display it before the invitee accepts
--        and their profile row is created.
--   2. Add index on firm_members(user_id) — used in auto-accept query
-- ============================================================

BEGIN;

-- 1. invited_email column
ALTER TABLE public.firm_members
  ADD COLUMN IF NOT EXISTS invited_email TEXT NULL;

COMMENT ON COLUMN public.firm_members.invited_email IS
  'Email address used to send the Supabase Auth invitation. '
  'Populated by the invite-firm-member edge function. '
  'Used for display in FirmManagementPanel before the invitee ''s profile row exists.';

-- 2. Index: auto-accept lookup (UPDATE WHERE user_id = auth.uid() AND accepted_at IS NULL)
CREATE INDEX IF NOT EXISTS idx_firm_members_user_id
  ON public.firm_members(user_id);

-- 3. Index: panel fetch (SELECT WHERE company_id = $1)
-- Already exists via FK constraint index — no action needed.

COMMIT;
