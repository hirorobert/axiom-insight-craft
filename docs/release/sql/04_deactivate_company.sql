-- DEACTIVATE one company. Its saved history stays readable; writes stop immediately (PT403).
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.fs_set_company_rollout('<COMPANY_UUID>'::uuid, false, '<why withdrawn, ticket id>', '<operator name>');
COMMIT;
