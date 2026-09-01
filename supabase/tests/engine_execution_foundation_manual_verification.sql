-- ============================================================================
-- Ω∞ Phase 0A — engine_runs / idempotency_keys manual verification script
-- Run this in: Supabase Dashboard → SQL Editor, against a project with
-- migration 20260901120000_engine_execution_foundation.sql already applied.
--
-- NOT YET EXECUTED. This environment has no live Supabase project access
-- (established throughout this project's session history — `supabase link`
-- fails against every reachable project). This is the test SPECIFICATION,
-- not a report of results. Do not treat any line below as a passed test
-- until it has actually been run and its real output captured.
--
-- Concurrency sections require two genuinely simultaneous sessions and
-- cannot be expressed as serial SQL Editor pastes — see [NEEDS DRIVER
-- SCRIPT] at the bottom, matching the pattern already used for Phase 2A's
-- own concurrency verification.
--
-- Replace <COMPANY_A>, <COMPANY_B>, <FIRM_MEMBER_A>, etc. with real UUIDs
-- from the target project before running each section.
-- ============================================================================

-- ── 1. Objects exist as specified ────────────────────────────────────────────
SELECT relname FROM pg_class
 WHERE relname IN ('engine_runs', 'idempotency_keys') AND relnamespace = 'public'::regnamespace;

SELECT proname FROM pg_proc
 WHERE proname IN ('engine_runs_lifecycle_guard', 'idempotency_keys_lifecycle_guard')
   AND pronamespace = 'public'::regnamespace;

-- ── 2. RLS + grants ──────────────────────────────────────────────────────────
SELECT c.relname, c.relrowsecurity FROM pg_class c
 WHERE c.relname IN ('engine_runs', 'idempotency_keys') AND c.relnamespace = 'public'::regnamespace;

SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
 WHERE table_name IN ('engine_runs', 'idempotency_keys') AND table_schema = 'public'
 ORDER BY table_name, grantee, privilege_type;
-- EXPECT: authenticated has SELECT only on both tables. No INSERT/UPDATE/
-- DELETE grant to authenticated or anon on either table.

-- ── 3. Direct authenticated INSERT/UPDATE/DELETE rejected ───────────────────
-- As an authenticated user who is a firm_member of some company:
-- INSERT INTO public.engine_runs (company_id, actor_type, function_name, engine_version)
--   VALUES ('<COMPANY_A>', 'system', 'forged', 'x');
-- EXPECT: ERROR — permission denied for table engine_runs (no INSERT policy exists).
-- (Repeat for idempotency_keys, and for UPDATE/DELETE on any row visible via SELECT.)

-- ── 4. System-actor uniqueness — the mandatory correction ───────────────────
-- As service_role (bypasses RLS by design):
-- INSERT INTO public.idempotency_keys
--   (company_id, firm_member_id, actor_type, function_name, client_request_id, request_hash)
-- VALUES ('<COMPANY_A>', NULL, 'system', 'maono-nightly-scan',
--          '11111111-1111-1111-1111-111111111111', 'hash-a');
-- EXPECT: succeeds.
-- Immediately attempt the identical second system claim:
-- INSERT INTO public.idempotency_keys
--   (company_id, firm_member_id, actor_type, function_name, client_request_id, request_hash)
-- VALUES ('<COMPANY_A>', NULL, 'system', 'maono-nightly-scan',
--          '11111111-1111-1111-1111-111111111111', 'hash-a');
-- EXPECT: ERROR — duplicate key value violates unique constraint uq_ik_claim.
-- This is the proof that UNIQUE NULLS NOT DISTINCT closes the NULL-treated-
-- as-distinct gap a plain UNIQUE constraint would have left open.

-- ── 5. Actor pairing enforced ────────────────────────────────────────────────
-- INSERT INTO public.engine_runs (company_id, firm_member_id, actor_type, function_name, engine_version)
--   VALUES ('<COMPANY_A>', NULL, 'user', 'x', 'x');
-- EXPECT: ERROR — violates check constraint chk_er_actor_pairing (user without firm_member_id).
-- INSERT INTO public.engine_runs (company_id, firm_member_id, actor_type, function_name, engine_version)
--   VALUES ('<COMPANY_A>', '<FIRM_MEMBER_A>', 'system', 'x', 'x');
-- EXPECT: ERROR — violates chk_er_actor_pairing (system with a firm_member_id).

-- ── 6. Engine-run lifecycle — legal transition succeeds ──────────────────────
-- INSERT INTO public.engine_runs (company_id, firm_member_id, actor_type, function_name, engine_version)
--   VALUES ('<COMPANY_A>', '<FIRM_MEMBER_A>', 'user', 'safisha-validate-tb', 'deadbeef')
--   RETURNING id;  -- note the id as <RUN_ID>
-- UPDATE public.engine_runs SET status='completed', completed_at=now(), duration_ms=120
--   WHERE id = '<RUN_ID>';
-- EXPECT: succeeds — exactly the running->completed transition trg_er_lifecycle permits.

-- ── 7. Second terminal transition rejected ───────────────────────────────────
-- UPDATE public.engine_runs SET status='failed', completed_at=now() WHERE id = '<RUN_ID>';
-- EXPECT: ERROR — "already reached a terminal state (completed)".

-- ── 8. Terminal mutation of identity/provenance columns rejected ─────────────
-- (Before completing a fresh run) UPDATE public.engine_runs
--   SET status='completed', completed_at=now(), company_id='<COMPANY_B>' WHERE id = '<RUN_ID_2>';
-- EXPECT: ERROR — company_id is not among the columns trg_er_lifecycle permits changing.

-- ── 9. DELETE rejected on both tables ────────────────────────────────────────
-- DELETE FROM public.engine_runs WHERE id = '<RUN_ID>';
-- EXPECT: ERROR — "rows cannot be deleted".
-- DELETE FROM public.idempotency_keys WHERE id = '<KEY_ID>';
-- EXPECT: ERROR — "cannot be deleted through ordinary application authority".

-- ── 10. Same request replay — no re-execution ────────────────────────────────
-- (application-level test via claimIdempotency, not raw SQL — see
--  [NEEDS DRIVER SCRIPT] below for the concurrency variant.)
-- First claim with client_request_id=X, request_hash=H1 → outcome 'claimed'.
-- Complete it. Second claim with the SAME (company, actor, function, X, H1)
-- → outcome 'replay', returns the stored replay_result, zero new engine_runs row.

-- ── 11. Same ID, different payload — hard reject ─────────────────────────────
-- First claim with client_request_id=X, request_hash=H1 → 'claimed', completed.
-- Second claim with client_request_id=X, request_hash=H2 (H2 != H1) → 'conflict'.
-- EXPECT: zero new rows written by the second call.

-- ── 12. Same input, new request ID — accepted as independent ─────────────────
-- Two claims with the SAME input_hash but DIFFERENT client_request_id values
-- both succeed as independent 'claimed' outcomes — input identity and
-- request identity are deliberately never conflated.

-- ── 13. Cross-company isolation ──────────────────────────────────────────────
-- As a firm_member of <COMPANY_A> only, SELECT engine_runs/idempotency_keys
-- WHERE company_id = '<COMPANY_B>' → zero rows returned (RLS), regardless of
-- whether such rows exist.

-- ── 14. Bounded replay envelope ───────────────────────────────────────────────
-- UPDATE public.idempotency_keys SET status='completed', resolved_at=now(),
--   replay_result = '{"status":"completed","full_tb_rows":[{"account":"x"}]}'::jsonb
--   WHERE id = '<KEY_ID>';
-- EXPECT: ERROR — violates chk_ik_replay_result_bounded (full_tb_rows is not
-- an allowed key). Only status/reference_id/reference_table/summary/
-- error_code are permitted.

-- ============================================================================
-- [NEEDS DRIVER SCRIPT] — cannot be run from SQL Editor alone
-- ============================================================================
-- Concurrent duplicate USER claim: two simultaneous claimIdempotency() calls
-- from a Node/Deno driver with the SAME (company_id, firm_member_id,
-- function_name, client_request_id, request_hash) — exactly one must return
-- 'claimed', the other must return 'in_progress' or 'replay' depending on
-- timing, and exactly one engine_runs row must exist afterward.
--
-- Concurrent duplicate SYSTEM claim: identical test with actor_type='system',
-- firm_member_id=NULL for both — proves UNIQUE NULLS NOT DISTINCT holds
-- under real concurrency, not just serial execution (§4 above proves the
-- constraint exists; this proves it holds under a race).
-- ============================================================================
