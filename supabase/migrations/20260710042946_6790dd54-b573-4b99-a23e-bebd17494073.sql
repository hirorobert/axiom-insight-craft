BEGIN;
ALTER TABLE public.firm_members
  ADD COLUMN IF NOT EXISTS invited_email TEXT NULL;
COMMENT ON COLUMN public.firm_members.invited_email IS
  'Email address used to send the Supabase Auth invitation. Populated by the invite-firm-member edge function. Used for display in FirmManagementPanel before the invitee profile row exists.';
CREATE INDEX IF NOT EXISTS idx_firm_members_user_id
  ON public.firm_members(user_id);
COMMIT;