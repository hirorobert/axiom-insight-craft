-- ============================================================
-- Axiom Policy Audit Query
-- Run this in: Supabase Dashboard → SQL Editor
-- Paste the full output back for review.
-- ============================================================

-- ── 1. RLS enabled status for all public-schema tables ──────────────────────
SELECT
  c.relname                                        AS table_name,
  CASE WHEN c.relrowsecurity THEN 'YES' ELSE 'NO' END AS rls_enabled,
  CASE WHEN c.relforcerowsecurity THEN 'YES' ELSE 'NO' END AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname;

-- ── 2. All RLS policies on public-schema tables ──────────────────────────────
SELECT
  tablename                                        AS table_name,
  policyname                                       AS policy_name,
  CASE WHEN permissive = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS type,
  cmd                                              AS operation,
  roles                                            AS roles,
  qual                                             AS using_expr,
  with_check                                       AS with_check_expr
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, type DESC, policyname;

-- ── 2b. Focused view: permissive vs restrictive breakdown for the three
--        core tables touched by Fixes 2, 3, and 4 — confirms RESTRICTIVE
--        policies are present and distinct from PERMISSIVE ones. ────────────
SELECT
  tablename                                        AS table_name,
  policyname                                       AS policy_name,
  CASE WHEN permissive = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS type,
  cmd                                              AS operation,
  qual                                             AS using_expr,
  with_check                                       AS with_check_expr
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('account_corrections', 'trial_balance_uploads', 'companies')
ORDER BY tablename,
         CASE WHEN permissive = 'PERMISSIVE' THEN 1 ELSE 0 END DESC,
         cmd,
         policyname;

-- ── 3. All RLS policies on storage.objects (bucket-level enforcement) ────────
SELECT
  policyname                                       AS policy_name,
  CASE WHEN permissive = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS type,
  cmd                                              AS operation,
  roles                                            AS roles,
  qual                                             AS using_expr,
  with_check                                       AS with_check_expr
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename  = 'objects'
ORDER BY type DESC, policyname;

-- ── 4. Public flag and RLS status on the two application buckets ─────────────
SELECT
  b.id                                             AS bucket_id,
  b.name                                           AS bucket_name,
  CASE WHEN b.public THEN 'PUBLIC' ELSE 'PRIVATE' END AS visibility,
  CASE WHEN c.relrowsecurity THEN 'YES' ELSE 'NO' END  AS rls_enabled
FROM storage.buckets b
JOIN pg_class c     ON c.relname = 'objects'
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'storage'
WHERE b.id IN ('trial-balance-files', 'avatars')
ORDER BY b.id;
