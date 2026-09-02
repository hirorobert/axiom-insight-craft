SET search_path TO public, pg_catalog;

REVOKE ALL PRIVILEGES ON public.engine_runs FROM PUBLIC;
REVOKE ALL PRIVILEGES ON public.engine_runs FROM anon;
REVOKE ALL PRIVILEGES ON public.engine_runs FROM authenticated;
GRANT SELECT ON public.engine_runs TO authenticated;
GRANT ALL PRIVILEGES ON public.engine_runs TO service_role;

REVOKE ALL PRIVILEGES ON public.idempotency_keys FROM PUBLIC;
REVOKE ALL PRIVILEGES ON public.idempotency_keys FROM anon;
REVOKE ALL PRIVILEGES ON public.idempotency_keys FROM authenticated;
GRANT SELECT ON public.idempotency_keys TO authenticated;
GRANT ALL PRIVILEGES ON public.idempotency_keys TO service_role;