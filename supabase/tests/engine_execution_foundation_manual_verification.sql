-- ============================================================================
-- Ω∞ Phase 0A — engine_runs / idempotency_keys manual verification script
-- (HARDENED — Phase 0A-1R revision)
-- Run this in: Supabase Dashboard → SQL Editor, against a project with
-- migration 20260901120000_engine_execution_foundation.sql already applied.
--
-- UNEXECUTED. No live Supabase project access exists in this environment
-- (established throughout this project's session history). Every case
-- below is the SPECIFICATION, not a report of results. Do not treat any
-- line as a passed test until it has actually been run and its real output
-- captured. Concurrency sections require two genuinely simultaneous
-- sessions and are marked [NEEDS DRIVER SCRIPT] at the bottom.
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

-- Confirm the lifecycle guard functions are SECURITY INVOKER (default),
-- not SECURITY DEFINER — the Phase 0A-1R correction.
SELECT proname, prosecdef FROM pg_proc
 WHERE proname IN ('engine_runs_lifecycle_guard', 'idempotency_keys_lifecycle_guard');
-- EXPECT: prosecdef = false for both.

-- ── 2. RLS + grants (including the broadened trigger-function revoke) ───────
SELECT c.relname, c.relrowsecurity FROM pg_class c
 WHERE c.relname IN ('engine_runs', 'idempotency_keys') AND c.relnamespace = 'public'::regnamespace;

SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
 WHERE table_name IN ('engine_runs', 'idempotency_keys') AND table_schema = 'public'
 ORDER BY table_name, grantee, privilege_type;
-- EXPECT: authenticated has SELECT only on both tables. No INSERT/UPDATE/
-- DELETE grant to authenticated or anon on either table.

SELECT grantee, routine_name FROM information_schema.role_routine_grants
 WHERE routine_name IN ('engine_runs_lifecycle_guard', 'idempotency_keys_lifecycle_guard');
-- EXPECT: zero rows — EXECUTE revoked from every role, including
-- service_role (trigger firing never requires a direct EXECUTE grant).

-- ── 3. Direct authenticated INSERT/UPDATE/DELETE rejected ───────────────────
-- As an authenticated user who is a firm_member of some company:
-- INSERT INTO public.engine_runs (company_id, actor_type, function_name, engine_version)
--   VALUES ('<COMPANY_A>', 'system', 'forged', 'x');
-- EXPECT: ERROR — permission denied for table engine_runs (no INSERT policy exists).
-- (Repeat for idempotency_keys, and for UPDATE/DELETE on any row visible via SELECT.)

-- ── 4. System-actor uniqueness — re-proven per gate §6 ───────────────────────
-- 4a. USER: same company/actor/function/request → duplicate blocked.
-- INSERT INTO public.idempotency_keys
--   (company_id, firm_member_id, actor_type, function_name, client_request_id, request_hash, engine_run_id)
-- VALUES ('<COMPANY_A>', '<FIRM_MEMBER_A>', 'user', 'safisha-validate-tb',
--          '11111111-1111-1111-1111-111111111111', 'hash-a', '<RUN_ID_1>');
-- (repeat identically) EXPECT: ERROR — duplicate key value violates uq_ik_claim.

-- 4b. SYSTEM: firm_member_id NULL, same company/function/request → duplicate blocked.
-- INSERT INTO public.idempotency_keys
--   (company_id, firm_member_id, actor_type, function_name, client_request_id, request_hash, engine_run_id)
-- VALUES ('<COMPANY_A>', NULL, 'system', 'maono-nightly-scan',
--          '22222222-2222-2222-2222-222222222222', 'hash-b', '<RUN_ID_2>');
-- (repeat identically, NULL firm_member_id both times)
-- EXPECT: ERROR — duplicate key value violates uq_ik_claim. Proves
-- UNIQUE NULLS NOT DISTINCT closes the gap a plain UNIQUE would leave open.

-- 4c. DIFFERENT COMPANY, same other fields → allowed independently.
-- Same client_request_id as 4a but company_id = '<COMPANY_B>' → succeeds,
-- a fully independent claim.

-- 4d. DIFFERENT ACTOR, same client_request_id → separate namespace.
-- Same client_request_id as 4a but firm_member_id = '<FIRM_MEMBER_B>' (also
-- a member of <COMPANY_A>) → succeeds, independent of 4a's claim.

-- ── 5. Actor pairing enforced ────────────────────────────────────────────────
-- INSERT INTO public.engine_runs (company_id, firm_member_id, actor_type, function_name, engine_version)
--   VALUES ('<COMPANY_A>', NULL, 'user', 'x', 'x');
-- EXPECT: ERROR — violates chk_er_actor_pairing (user without firm_member_id).
-- INSERT INTO public.engine_runs (company_id, firm_member_id, actor_type, function_name, engine_version)
--   VALUES ('<COMPANY_A>', '<FIRM_MEMBER_A>', 'system', 'x', 'x');
-- EXPECT: ERROR — violates chk_er_actor_pairing (system with a firm_member_id).

-- ── 6. Engine-run lifecycle — legal transition succeeds ──────────────────────
-- INSERT INTO public.engine_runs (company_id, firm_member_id, actor_type, function_name, engine_version)
--   VALUES ('<COMPANY_A>', '<FIRM_MEMBER_A>', 'user', 'safisha-validate-tb', 'deadbeef')
--   RETURNING id;  -- <RUN_ID>
-- UPDATE public.engine_runs SET status='completed', completed_at=now(), duration_ms=120
--   WHERE id = '<RUN_ID>';
-- EXPECT: succeeds.

-- ── 7. Second terminal transition rejected ───────────────────────────────────
-- UPDATE public.engine_runs SET status='failed', completed_at=now() WHERE id = '<RUN_ID>';
-- EXPECT: ERROR — "already reached a terminal state (completed)".

-- ── 8. Terminal mutation of identity/provenance columns rejected ─────────────
-- UPDATE public.engine_runs
--   SET status='completed', completed_at=now(), company_id='<COMPANY_B>' WHERE id = '<RUN_ID_2>';
-- EXPECT: ERROR — company_id is not among the columns trg_er_lifecycle permits changing.

-- ── 9. DELETE rejected on both tables ────────────────────────────────────────
-- DELETE FROM public.engine_runs WHERE id = '<RUN_ID>';
-- EXPECT: ERROR — "rows cannot be deleted".
-- DELETE FROM public.idempotency_keys WHERE id = '<KEY_ID>';
-- EXPECT: ERROR — "cannot be deleted through ordinary application authority".

-- ── 10. engine_run_id — first binding succeeds, at creation ──────────────────
-- INSERT INTO public.engine_runs (company_id, firm_member_id, actor_type, function_name, engine_version)
--   VALUES ('<COMPANY_A>', '<FIRM_MEMBER_A>', 'user', 'x', 'x') RETURNING id; -- <RUN_ID_3>
-- INSERT INTO public.idempotency_keys
--   (company_id, firm_member_id, actor_type, function_name, client_request_id, request_hash, engine_run_id)
-- VALUES ('<COMPANY_A>', '<FIRM_MEMBER_A>', 'user', 'x',
--          '33333333-3333-3333-3333-333333333333', 'hash-c', '<RUN_ID_3>')
-- RETURNING id; -- <KEY_ID_3>
-- EXPECT: succeeds — engine_run_id bound in the same INSERT that creates the claim.

-- ── 11. engine_run_id — second binding (rebind) rejected ─────────────────────
-- INSERT INTO public.engine_runs (company_id, firm_member_id, actor_type, function_name, engine_version)
--   VALUES ('<COMPANY_A>', '<FIRM_MEMBER_A>', 'user', 'x', 'x') RETURNING id; -- <RUN_ID_4>
-- UPDATE public.idempotency_keys SET status='completed', resolved_at=now(),
--   engine_run_id = '<RUN_ID_4>'
--   WHERE id = '<KEY_ID_3>';
-- EXPECT: ERROR — trg_ik_lifecycle rejects engine_run_id changing on ANY
-- update, including the one legal terminal transition. It is immutable
-- once bound, permanently, with no exception.

-- ── 12. replay_result — valid bounded envelope accepted ──────────────────────
-- UPDATE public.idempotency_keys SET status='completed', resolved_at=now(),
--   replay_result = '{"status":"completed","reference_id":"abc-123","summary":{"tbRowCount":42}}'::jsonb
--   WHERE id = '<KEY_ID_3>';
-- EXPECT: succeeds — status/reference_id/summary are all permitted keys.

-- ── 13. replay_result — extra key rejected ────────────────────────────────────
-- (fresh reserved row) UPDATE public.idempotency_keys SET status='completed', resolved_at=now(),
--   replay_result = '{"status":"completed","full_tb_rows":[{"account":"x"}]}'::jsonb
--   WHERE id = '<KEY_ID_5>';
-- EXPECT: ERROR — violates chk_ik_replay_result_bounded (full_tb_rows is not permitted).

-- ── 14. replay_result — wrong JSON type rejected ──────────────────────────────
-- ... replay_result = '["completed"]'::jsonb ...   -- array
-- EXPECT: ERROR — jsonb_typeof(replay_result) != 'object'.
-- ... replay_result = '"completed"'::jsonb ...      -- scalar string
-- EXPECT: ERROR — same reason.

-- ── 15. replay_result — oversized object rejected ─────────────────────────────
-- ... replay_result = jsonb_build_object('status','completed','summary',
--       jsonb_build_object('padding', repeat('x', 4000))) ...
-- EXPECT: ERROR — pg_column_size(replay_result) > 2048.

-- ── 16. replay_result — NULL allowed where lifecycle permits ─────────────────
-- A 'reserved' row's replay_result is NULL by default and this is valid;
-- a 'completed'/'failed' row MAY also have replay_result NULL (the CHECK
-- only bounds it WHEN present) — confirm no constraint forces a non-NULL
-- replay_result on terminal rows.

-- ── 17. error_detail — same bounded-envelope proof, mirrored ─────────────────
-- UPDATE public.engine_runs SET status='failed', completed_at=now(), duration_ms=1,
--   error_code='SAFISHA_L3_FAIL',
--   error_detail='{"stage":"L3","safe_message":"debits != credits"}'::jsonb
--   WHERE id = '<RUN_ID_5>';
-- EXPECT: succeeds.
-- ... error_detail='{"stack":"Error: ..."}'::jsonb ...
-- EXPECT: ERROR — "stack" is not a permitted key (chk_er_error_detail_bounded).

-- ── 18. Cross-company isolation (RLS read) ────────────────────────────────────
-- As a firm_member of <COMPANY_A> only, SELECT engine_runs/idempotency_keys
-- WHERE company_id = '<COMPANY_B>' → zero rows returned, regardless of
-- whether such rows exist.

-- ── 19. Cross-company actor mismatch — documented residual trust boundary ────
-- This CANNOT be proven at the DB level by this migration (see the
-- fk_er_firm_member / fk_ik_firm_member comments in the migration file):
-- a service-role caller COULD theoretically insert
-- (company_id=<COMPANY_A>, firm_member_id=<a real member of COMPANY_B>)
-- and no FK/CHECK in this migration would reject it, because doing so would
-- require a composite (id, company_id) unique index + FK on firm_members,
-- which this migration must not alter (out of scope). The only real control
-- is that every caller obtains (firmMemberId, companyId) together from
-- resolveFirmMemberActor()'s single return value, never assembled from two
-- sources. This section exists to record that this is NOT DB-proven, not
-- to claim it is.

-- ============================================================================
-- [NEEDS DRIVER SCRIPT] — cannot be run from SQL Editor alone
-- ============================================================================
-- Concurrent duplicate USER claim: two simultaneous claimIdempotency() calls
-- from a Node/Deno driver with the SAME (company_id, firm_member_id,
-- function_name, client_request_id, request_hash) — exactly one must return
-- 'claimed', the other 'in_progress' or 'replay' depending on timing, and
-- exactly one non-orphaned (status != 'failed' with error_code
-- IDEMPOTENCY_LOST_RACE) engine_runs row must exist afterward — the loser's
-- provisional engine_runs row must show status='failed',
-- error_code='IDEMPOTENCY_LOST_RACE'.
--
-- Concurrent duplicate SYSTEM claim: identical test with actor_type='system',
-- firm_member_id=NULL for both — proves UNIQUE NULLS NOT DISTINCT holds
-- under real concurrency, not just serial execution (§4b above proves the
-- constraint exists; this proves it holds under a race).
-- ============================================================================
