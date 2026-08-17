-- ============================================================================
-- Ω∞ Phase 2A — account_review_authority manual verification script
-- Run this in: Supabase Dashboard → SQL Editor, against a project with
-- migration 20260816120000_account_review_authority.sql already applied.
--
-- NOT YET EXECUTED. This environment has no live Supabase project access
-- (established throughout this session — `supabase link` fails with
-- insufficient privileges against every project reachable from here).
-- This script is the test SPECIFICATION for items requiring a real Postgres
-- instance (RLS enforcement, advisory-lock concurrency, cross-tenant
-- rejection) that cannot be exercised by vitest against no database.
--
-- True concurrency proofs (two simultaneous resolve_account_review_batch
-- calls racing on the same account) cannot be expressed as a single serial
-- SQL Editor paste — they require two application-level sessions calling the
-- RPC via supabase.rpc(...) at the same time (e.g. Promise.all of two calls
-- from a small Node/Deno driver script). Sections marked [SERIAL-PROOF-ONLY]
-- verify the mechanism (lock exists, is per-key, is transaction-scoped) but
-- not true concurrent contention; sections marked [NEEDS DRIVER SCRIPT] are
-- listed for completeness and are not executable from SQL Editor alone.
--
-- Replace <COMPANY_A>, <COMPANY_B>, <UPLOAD_A>, <FIRM_MEMBER_A> etc. with
-- real UUIDs from the target project before running each section.
-- ============================================================================

-- ── 1. Objects exist as specified ────────────────────────────────────────────
SELECT relname, relkind FROM pg_class
 WHERE relname IN ('account_review_batches', 'account_review_decisions', 'account_review_decisions_seq')
   AND relnamespace = 'public'::regnamespace;

SELECT proname FROM pg_proc
 WHERE proname IN ('resolve_account_review_batch', 'get_effective_non_reporting_status',
                    'account_review_decisions_immutable')
   AND pronamespace = 'public'::regnamespace;

-- ── 2. RLS enabled, no direct authenticated mutation grants ─────────────────
SELECT c.relname, c.relrowsecurity FROM pg_class c
 WHERE c.relname IN ('account_review_batches', 'account_review_decisions')
   AND c.relnamespace = 'public'::regnamespace;

SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
 WHERE table_name IN ('account_review_batches', 'account_review_decisions')
   AND table_schema = 'public'
 ORDER BY table_name, grantee, privilege_type;
-- EXPECT: authenticated has SELECT only on both tables. No INSERT/UPDATE/DELETE
-- grant to authenticated or anon on either table.

-- ── 3. [AB/AC] Immutability — direct UPDATE/DELETE rejected ─────────────────
-- Run as an authenticated user who is a firm_member of some company with at
-- least one existing decision row (insert one via the RPC first, §5 below).
-- UPDATE public.account_review_decisions SET reason = 'tampered' WHERE id = '<some id>';
-- EXPECT: ERROR — "Iron Dome: account_review_decisions is append-only. UPDATE is not permitted."
-- DELETE FROM public.account_review_decisions WHERE id = '<some id>';
-- EXPECT: ERROR — same message, TG_OP = DELETE.

-- ── 4. [AC] Authenticated direct INSERT rejected (no policy grants it) ──────
-- INSERT INTO public.account_review_decisions
--   (batch_id, company_id, upload_id, firm_member_id, normalized_account_name,
--    review_account_key, decision_action)
-- VALUES (gen_random_uuid(), '<COMPANY_A>', '<UPLOAD_A>', '<FIRM_MEMBER_A>',
--         'forged account', 'forged account', 'USER_MANUAL_CLASSIFICATION');
-- EXPECT: ERROR — permission denied for table account_review_decisions
-- (no INSERT policy exists for role authenticated; RLS default-denies).

-- ── 5. [A/B/F] Basic identity + supersession — manual classification ────────
-- As firm member of <COMPANY_A>, owning/preparer/partner role, with upload
-- <UPLOAD_A> belonging to <COMPANY_A>:
-- SELECT resolve_account_review_batch(
--   '<COMPANY_A>', '<UPLOAD_A>', gen_random_uuid(),
--   '[{"account_code":"6171","account_name":"Office Supplies",
--      "proposal_type":"NONE","decision_action":"USER_MANUAL_CLASSIFICATION",
--      "statement":"income_statement","classification":"operating_expenses",
--      "line_item":"Office Supplies","normal_balance":"debit"}]'::jsonb
-- );
-- EXPECT: {"batch_id": "...", "mappings_written": 1, "decisions_logged": 1, "non_reporting_decisions_recorded": 0}
-- SELECT * FROM account_mappings WHERE company_id = '<COMPANY_A>' AND account_key = '6171';
-- EXPECT: one row, classification = operating_expenses.

-- ── 6. [F/N] Mark non-reporting — company mapping removed, ledger appended ──
-- SELECT resolve_account_review_batch(
--   '<COMPANY_A>', '<UPLOAD_A>', gen_random_uuid(),
--   '[{"account_code":"6171","account_name":"Office Supplies",
--      "proposal_type":"NONE","decision_action":"MARK_NON_REPORTING_ACCOUNT"}]'::jsonb
-- );
-- SELECT * FROM account_mappings WHERE company_id = '<COMPANY_A>' AND account_key = '6171';
-- EXPECT: zero rows (deleted).
-- SELECT decision_action, sequence_no FROM account_review_decisions
--  WHERE company_id = '<COMPANY_A>' AND review_account_key = '6171' ORDER BY sequence_no;
-- EXPECT: two rows — USER_MANUAL_CLASSIFICATION (lower sequence_no) then
-- MARK_NON_REPORTING_ACCOUNT (higher). Both present, neither deleted.

-- ── 7. [G/P] Reverse supersession — manual classification recreates projection ─
-- SELECT resolve_account_review_batch('<COMPANY_A>', '<UPLOAD_A>', gen_random_uuid(),
--   '[{"account_code":"6171","account_name":"Office Supplies",
--      "proposal_type":"NONE","decision_action":"USER_MANUAL_CLASSIFICATION",
--      "statement":"income_statement","classification":"operating_expenses",
--      "line_item":"Office Supplies","normal_balance":"debit"}]'::jsonb);
-- SELECT * FROM account_mappings WHERE company_id = '<COMPANY_A>' AND account_key = '6171';
-- EXPECT: one row again (plain INSERT via the upsert's ON CONFLICT DO UPDATE path).

-- ── 8. [E/I] Identity drift — same code, changed name ────────────────────────
-- SELECT * FROM get_effective_non_reporting_status('<COMPANY_A>',
--   '[{"account_code":"6171","account_name":"Office Supplies"}]'::jsonb);
-- (after §6's exclusion, before §7's reversal — re-run §6 first if needed)
-- EXPECT: suppressed = true, stale_reason = null (name matches exactly).
-- SELECT * FROM get_effective_non_reporting_status('<COMPANY_A>',
--   '[{"account_code":"6171","account_name":"Office Supplies & Consumables"}]'::jsonb);
-- EXPECT: suppressed = false, stale_reason = 'PRIOR_NON_REPORTING_DECISION_STALE_IDENTITY_CHANGED'.

-- ── 9. [D/J/Z] Cross-tenant isolation ────────────────────────────────────────
-- As a user who is a firm_member of <COMPANY_A> only (not <COMPANY_B>):
-- SELECT resolve_account_review_batch('<COMPANY_B>', '<UPLOAD_OF_COMPANY_B>',
--   gen_random_uuid(), '[...]'::jsonb);
-- EXPECT: ERROR — NOT_A_MEMBER_OF_COMPANY.
-- As a firm_member of <COMPANY_A>, but passing an upload_id belonging to <COMPANY_B>:
-- SELECT resolve_account_review_batch('<COMPANY_A>', '<UPLOAD_OF_COMPANY_B>',
--   gen_random_uuid(), '[...]'::jsonb);
-- EXPECT: ERROR — UPLOAD_COMPANY_MISMATCH.

-- ── 10. [O/AD] Global mapping survives a company-specific non-reporting decision ─
-- INSERT INTO account_mappings (user_id, company_id, account_code, account_name,
--   normalized_account_name, statement, classification, line_item, normal_balance,
--   confidence_source, approved_at)
-- VALUES ('<SOME_USER>', NULL, '9100', 'Bank Charges', 'bank charges',
--   'income_statement', 'operating_expenses', 'Bank Charges', 'debit', 'user_approved', now());
-- SELECT resolve_account_review_batch('<COMPANY_A>', '<UPLOAD_A>', gen_random_uuid(),
--   '[{"account_code":"9100","account_name":"Bank Charges",
--      "proposal_type":"NONE","decision_action":"MARK_NON_REPORTING_ACCOUNT"}]'::jsonb);
-- SELECT * FROM account_mappings WHERE company_id IS NULL AND account_key = '9100';
-- EXPECT: the global row still exists, untouched — the DELETE in
-- resolve_account_review_batch is always company_id-qualified.

-- ── 11. Actor-scoped idempotency — same actor/id/hash replays without writing ──
-- (run as the same session/actor twice with the SAME client_request_id literal,
--  e.g. '11111111-1111-1111-1111-111111111111', and the SAME decisions payload)
-- SELECT resolve_account_review_batch('<COMPANY_A>', '<UPLOAD_A>',
--   '11111111-1111-1111-1111-111111111111'::uuid, '[{...}]'::jsonb);
-- SELECT count(*) FROM account_review_decisions WHERE batch_id IN
--   (SELECT id FROM account_review_batches WHERE client_request_id = '11111111-1111-1111-1111-111111111111');
-- Run the identical call again (same client_request_id, same payload):
-- EXPECT: second call returns the SAME result_summary; decision row count above unchanged.

-- ── 12. Same id, different hash → hard reject ────────────────────────────────
-- Re-run with the SAME client_request_id but a DIFFERENT decisions payload:
-- EXPECT: ERROR — IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD.

-- ============================================================================
-- [NEEDS DRIVER SCRIPT] — cannot be run from SQL Editor alone
-- ============================================================================
-- H/X. Two concurrent resolve_account_review_batch calls on the SAME account,
--      issued via Promise.all([supabase.rpc(...), supabase.rpc(...)]) from a
--      Node/Deno script using two different authenticated sessions (or the
--      same session twice with different client_request_id values): the
--      second call must block on pg_advisory_xact_lock until the first
--      transaction commits or rolls back, then observe the first's committed
--      state. Final effective state (§8 fold) must be deterministic and
--      match whichever transaction actually committed last by sequence_no —
--      never a torn/interleaved write.
--
-- I/Y. Two concurrent multi-account batches with reversed account ordering
--      (Batch A: [X, Y], Batch B: [Y, X]) must both complete without a
--      Postgres deadlock error, because resolve_account_review_batch sorts
--      review_account_key before acquiring any advisory lock.
--
-- V/W. Two different actors (different firm_member_id, same company) submit
--      with the SAME client_request_id UUID: verify via
--      SELECT * FROM account_review_batches WHERE client_request_id = '<the id>';
--      that TWO independent rows exist (one per firm_member_id), not one.
-- ============================================================================
