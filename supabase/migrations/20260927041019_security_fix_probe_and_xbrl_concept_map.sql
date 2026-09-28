-- ════════════════════════════════════════════════════════════════════════════
-- Canonical source for Lovable's hosted journal entry 0023_security_fix_probe_and_xbrl_concept_map (applied to
-- production on 2026-09-27 04:10:19 UTC; drizzle/migrations/0023_… SHA-256
-- 351fe7e91dc4bee1c98b119c7febb4806609e38b05477d78628258e3c928fe4e, 613 bytes). Forward-only; no applied migration
-- is edited.
--
-- What 0023 changed in production, and nothing else:
--   1. ALTER TABLE public._pr34_probe ENABLE ROW LEVEL SECURITY — the release-only probe table (created by hosted
--      entry 0013 only; it has no source migration and is pending cleanup). RLS with no policy: no client role can
--      read or write it.
--   2. xbrl_concept_map_read (reference data) — from FOR SELECT TO authenticated USING (true) (20260802154244) to
--      FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL). Same audience; no role gains anything.
-- No customer or accounting data is changed; no client-role privilege is granted.
--
-- A byte-equal copy cannot be the source: _pr34_probe exists only where hosted entry 0013 ran, so a clean replay would
-- fail. This migration applies (2) exactly, and (1) only where the probe table exists. A clean replay and the
-- production history therefore converge on the same application schema (the probe is release-only and absent from a
-- clean replay by design). The migration-authority guard maps 0023 to this file by exact SHA-256 of BOTH files and a
-- structural check (scripts/ci/assertMigrationAuthority.mjs, rule canonical_equivalent) — not an allow-list.
--
-- Idempotent: applying it again, or on production where 0023 already ran, changes nothing. One atomic statement.
-- ════════════════════════════════════════════════════════════════════════════
--
-- ATOMIC ENVELOPE (security correction B-3): every statement below runs inside this ONE DO statement. Whatever the
-- runner does (statement by statement, whole file, with or without a transaction, continuing after errors) the
-- migration either applies completely or changes nothing.
DO $cfoclose_xbrlpolicy$
BEGIN
  EXECUTE $mxbrlpolicyaaa$
DO $refuse$
BEGIN
  IF to_regclass('public.xbrl_concept_map') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'xbrl policy migration refused: public.xbrl_concept_map or auth.uid() is missing. Nothing was changed.' USING ERRCODE = '55000';
  END IF;
END
$refuse$
$mxbrlpolicyaaa$;

  EXECUTE $mxbrlpolicyaab$
DROP POLICY IF EXISTS xbrl_concept_map_read ON public.xbrl_concept_map
$mxbrlpolicyaab$;

  EXECUTE $mxbrlpolicyaac$
CREATE POLICY xbrl_concept_map_read ON public.xbrl_concept_map
  FOR SELECT TO authenticated
  USING (auth.uid() IS NOT NULL)
$mxbrlpolicyaac$;

  EXECUTE $mxbrlpolicyaad$
DO $probe$
BEGIN
  -- Release-only object: present only where hosted entry 0013 created it. Never created here.
  IF to_regclass('public._pr34_probe') IS NOT NULL THEN
    ALTER TABLE public._pr34_probe ENABLE ROW LEVEL SECURITY;
  END IF;
END
$probe$
$mxbrlpolicyaad$;

  EXECUTE $mxbrlpolicyaae$
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'xbrl_concept_map'
                   AND policyname = 'xbrl_concept_map_read' AND cmd = 'SELECT' AND roles = '{authenticated}'::name[]
                   AND qual = '(auth.uid() IS NOT NULL)')
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'xbrl_concept_map') <> 1
     OR NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.xbrl_concept_map'::regclass)
     OR (to_regclass('public._pr34_probe') IS NOT NULL
         AND NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public._pr34_probe'))) THEN
    RAISE EXCEPTION 'xbrl policy postcondition failed' USING ERRCODE = '55000';
  END IF;
END
$post$
$mxbrlpolicyaae$;
END
$cfoclose_xbrlpolicy$;
