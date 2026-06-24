-- ============================================================
-- Fix 2: Set DEFAULT auth.uid() on user_id columns
-- for account_corrections and audit_logs.
--
-- This removes user_id from client INSERT payloads entirely;
-- the database derives it from the authenticated JWT instead.
-- Existing RLS WITH CHECK (auth.uid() = user_id) is preserved
-- as a second layer.
--
-- CARVE-OUT — logout path in useAuthAudit.ts:
--   That call site still sends user_id: previousSession.user.id
--   explicitly and is intentionally left unchanged. At sign-out
--   the Supabase JWT may already be invalidated by the time the
--   INSERT executes, so DEFAULT auth.uid() could resolve to null
--   and violate the NOT NULL constraint or silently corrupt the
--   row. previousSession.user.id is the only reliable source at
--   that moment. The existing RLS check prevents a valid session
--   from writing a different user's logout record, so the residual
--   risk is accepted and documented here. This applies only to a
--   logout timestamp — no financial data is involved.
-- ============================================================

ALTER TABLE public.account_corrections
  ALTER COLUMN user_id SET DEFAULT auth.uid();

ALTER TABLE public.audit_logs
  ALTER COLUMN user_id SET DEFAULT auth.uid();
