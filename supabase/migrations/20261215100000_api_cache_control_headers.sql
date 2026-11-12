-- Intuit security requirement (developer.intuit.com go-live security requirements, read 2026-11-06): "Caching is disabled
-- on all SSL pages and all pages that contain sensitive data by using value no-cache and no-store instead of private in the
-- Cache-Control header." PostgREST (/rest/v1, tables and RPCs) sends no Cache-Control today.
--
-- This migration adds ONE PostgREST pre-request function and points PostgREST at it through the documented in-database
-- configuration (ALTER ROLE authenticator SET pgrst.db_pre_request; NOTIFY pgrst 'reload config'). PostgREST runs it inside
-- every API transaction, as the request's own role, before the main statement. It only sets the transaction-local GUC
-- response.headers; PostgREST turns that into the HTTP header Cache-Control: no-cache, no-store.
--
-- What it does NOT do: read or write any table, change any RLS policy, grant, owner or authorization rule, or touch any other
-- role setting. SECURITY INVOKER; no SET clause (a function-level SET would also scope the header GUC to the call).
-- Compatibility: if ANY pgrst.db_pre_request is already configured on any role or database, the migration REFUSES
-- (API_PRE_REQUEST_HOOK_ALREADY_CONFIGURED) and changes nothing - an existing hook is never replaced; chaining it needs its
-- own reviewed migration. A hook configured only through PostgREST's environment cannot be seen from SQL; the in-database
-- setting would take precedence over it, which is why the release record requires a header check after applying.
-- Coverage is limited to responses whose transaction completed: proven by scripts/db-proof/apiCacheHeaders.mjs against a real
-- PostgREST, which records exactly which error responses do and do not carry the header. Supabase Auth (/auth/v1), Storage
-- (/storage/v1) and Edge Functions are not PostgREST and are not covered here.
-- Rollback (its own journalled migration): ALTER ROLE authenticator RESET pgrst.db_pre_request; NOTIFY pgrst, 'reload config';
-- then DROP FUNCTION public.api_cache_control_pre_request(). Record: docs/release/intuit-security-r1/RECORD.md.
DO $cfoclose_api_cache_headers$
BEGIN
  EXECUTE $mapi_cache_headersaaa$
DO $$
DECLARE
  v_existing text;
BEGIN
  SELECT string_agg(c, ', ' ORDER BY c) INTO v_existing
    FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) AS c
   WHERE c LIKE 'pgrst.db\_pre\_request=%';
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'API_PRE_REQUEST_HOOK_ALREADY_CONFIGURED: %', v_existing
      USING HINT = 'An existing PostgREST pre-request hook is never replaced; chain it in a reviewed migration.';
  END IF;
  IF pg_catalog.to_regprocedure('public.api_cache_control_pre_request()') IS NOT NULL THEN
    RAISE EXCEPTION 'API_CACHE_CONTROL_HOOK_ALREADY_EXISTS';
  END IF;
END
$$
$mapi_cache_headersaaa$;
  EXECUTE $mapi_cache_headersaab$
CREATE FUNCTION public.api_cache_control_pre_request()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $fn$
DECLARE
  v_headers text := pg_catalog.current_setting('response.headers', true);
BEGIN
  -- Reads no table. At pre-request time nothing has set response.headers yet; if something earlier in the same transaction
  -- did (a JSON array of single-key objects, PostgREST's format), the header is appended instead of replacing it.
  IF v_headers IS NULL OR pg_catalog.btrim(v_headers) = '' THEN
    PERFORM pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-cache, no-store"}]', true);
  ELSE
    PERFORM pg_catalog.set_config('response.headers',
      (v_headers::pg_catalog.jsonb OPERATOR(pg_catalog.||) '[{"Cache-Control": "no-cache, no-store"}]'::pg_catalog.jsonb)::text, true);
  END IF;
END
$fn$
$mapi_cache_headersaab$;
  EXECUTE $mapi_cache_headersaac$
COMMENT ON FUNCTION public.api_cache_control_pre_request() IS 'PostgREST db-pre-request hook: sets Cache-Control: no-cache, no-store on API responses (Intuit security requirement). Reads no table; changes no data or authorization. Migration 20261215100000.'
$mapi_cache_headersaac$;
  EXECUTE $mapi_cache_headersaad$
REVOKE ALL ON FUNCTION public.api_cache_control_pre_request() FROM PUBLIC
$mapi_cache_headersaad$;
  EXECUTE $mapi_cache_headersaae$
GRANT EXECUTE ON FUNCTION public.api_cache_control_pre_request() TO anon, authenticated, service_role
$mapi_cache_headersaae$;
  EXECUTE $mapi_cache_headersaaf$
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticator') THEN
    ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.api_cache_control_pre_request';
  ELSE
    -- Only a bare PostgreSQL replay (no Supabase API roles) reaches this branch; a Supabase project always has authenticator.
    RAISE WARNING 'API_CACHE_CONTROL_HOOK_NOT_WIRED: role authenticator does not exist';
  END IF;
END
$$
$mapi_cache_headersaaf$;
  EXECUTE $mapi_cache_headersaag$
NOTIFY pgrst, 'reload config'
$mapi_cache_headersaag$;
END
$cfoclose_api_cache_headers$;
