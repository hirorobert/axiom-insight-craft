-- KILL SWITCH — engages instantly for EVERY company. Reads of saved history still work
-- (RLS); every write fails with FEATURE_DISABLED (PT403). Release with p_engaged = false.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.fs_set_kill_switch(true, '<incident id and reason>', '<operator name>');
COMMIT;
-- Release:
--   SELECT public.fs_set_kill_switch(false, '<all clear, incident id>', '<operator name>');
