-- ACTIVATE one company (canary). Run as the SERVICE ROLE by a named operator, one
-- company at a time. The reason is mandatory (>= 8 characters) and is written to the
-- append-only audit log. Replace the placeholders; never commit real values.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.fs_set_company_rollout('<COMPANY_UUID>'::uuid, true, '<why this company, ticket id>', '<operator name>');
COMMIT;
-- Verify:
--   SELECT * FROM public.financial_statements_rollout_audit ORDER BY seq DESC LIMIT 5;
