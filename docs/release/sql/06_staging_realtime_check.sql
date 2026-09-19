-- MANUAL hosted-staging check (STAGING ONLY — never run against production by this package).
-- Realtime must not publish any financial-statements table: the history tables hold
-- client financial data and must be read only through the RLS-scoped REST endpoints.
-- Run in the staging project's SQL editor and attach the output to the acceptance record.
SELECT schemaname, tablename
  FROM pg_publication_tables
 WHERE pubname = 'supabase_realtime'
   AND (tablename LIKE 'financial\_statement%' OR tablename LIKE 'financial\_evidence%');
-- EXPECTED: zero rows.
-- Also confirm RLS is on for every one of them:
SELECT c.relname, c.relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND (c.relname LIKE 'financial\_statement%' OR c.relname LIKE 'financial\_evidence%') AND c.relkind = 'r';
-- EXPECTED: relrowsecurity = true on every row.
