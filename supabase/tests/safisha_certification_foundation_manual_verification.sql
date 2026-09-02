-- ============================================================================
-- Ω∞ Phase 0 — tb_certifications / commit_tb_certification manual verification
-- Run this in: Supabase Dashboard → SQL Editor, against a project with
-- migration 20260902130000_safisha_certification_foundation.sql applied.
--
-- UNEXECUTED. This environment has no live Supabase project access
-- (established throughout this project's history). Every case below is the
-- test SPECIFICATION, not a report of results. Do not treat any line as a
-- passed test until it has actually been run and its real output captured.
--
-- Replace <COMPANY_A>, <COMPANY_B>, <UPLOAD_A>, <FIRM_MEMBER_A>, etc. with
-- real UUIDs from the target project before running each section.
-- ============================================================================

-- ── 1. Objects exist as specified ────────────────────────────────────────────
SELECT relname FROM pg_class
 WHERE relname IN ('tb_certifications', 'tb_certifications_seq') AND relnamespace = 'public'::regnamespace;

SELECT proname, prosecdef FROM pg_proc
 WHERE proname IN ('commit_tb_certification', 'get_authoritative_certification', 'tb_certifications_immutable');
-- EXPECT: prosecdef = false for all three (SECURITY INVOKER — no privilege
-- gap exists to justify DEFINER on any of them).

SELECT column_name FROM information_schema.columns
 WHERE table_name = 'trial_balance_uploads' AND column_name = 'source_file_hash';

-- ── 2. FKs ────────────────────────────────────────────────────────────────────
SELECT conname, confrelid::regclass FROM pg_constraint
 WHERE conrelid = 'public.tb_certifications'::regclass AND contype = 'f';
-- EXPECT: fk_tbc_company -> companies, fk_tbc_upload -> trial_balance_uploads,
-- fk_tbc_engine_run -> engine_runs.

SELECT conname FROM pg_constraint
 WHERE conrelid = 'public.tb_certifications'::regclass AND contype = 'u';
-- EXPECT: uq_tbc_engine_run present.

-- ── 3. Indexes ────────────────────────────────────────────────────────────────
SELECT indexname FROM pg_indexes WHERE tablename = 'tb_certifications';
-- EXPECT: idx_tbc_company_period, idx_tbc_upload, plus the PK and UNIQUE indexes.

-- ── 4. RLS + ACL (explicit per-role, per the Phase 0A-2R lesson) ────────────
SELECT relrowsecurity FROM pg_class WHERE relname = 'tb_certifications';

SELECT grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_name = 'tb_certifications' AND table_schema = 'public'
 ORDER BY grantee, privilege_type;
-- EXPECT: authenticated = SELECT only. No INSERT/UPDATE/DELETE for
-- authenticated or anon. service_role = full.

SELECT grantee, privilege_type FROM information_schema.role_routine_grants
 WHERE routine_name = 'commit_tb_certification';
-- EXPECT: service_role EXECUTE only — never authenticated or anon.

SELECT grantee, privilege_type FROM information_schema.role_routine_grants
 WHERE routine_name = 'get_authoritative_certification';
-- EXPECT: authenticated AND service_role EXECUTE — this is a read-only
-- query, unlike commit_tb_certification.

-- ── 5. Browser mutation denial ───────────────────────────────────────────────
-- As authenticated, a member of <COMPANY_A>:
-- INSERT INTO public.tb_certifications (company_id, upload_id, source_file_hash,
--   normalized_input_hash, engine_run_id, is_blocking, requires_review)
-- VALUES ('<COMPANY_A>', '<UPLOAD_A>', 'x', 'x', '<SOME_RUN_ID>', false, false);
-- EXPECT: ERROR — permission denied (no INSERT policy/grant exists).
-- UPDATE/DELETE similarly denied.

-- ── 6. Immutability — even service_role cannot mutate a committed row ───────
-- As service_role (bypasses RLS, but the trigger still fires — triggers are
-- not an RLS mechanism and apply regardless of role):
-- UPDATE public.tb_certifications SET is_blocking = true WHERE id = '<CERT_ID>';
-- EXPECT: ERROR — "tb_certifications is append-only. UPDATE is not permitted."
-- DELETE FROM public.tb_certifications WHERE id = '<CERT_ID>';
-- EXPECT: ERROR — same message, TG_OP=DELETE.

-- ── 7. Company isolation (RLS read) ──────────────────────────────────────────
-- As a firm_member of <COMPANY_A> only, SELECT * FROM tb_certifications
-- WHERE company_id = '<COMPANY_B>' → zero rows, regardless of whether such
-- rows exist.

-- ── 8. Atomic success ─────────────────────────────────────────────────────────
-- Precondition: a 'running' engine_run exists for function_name
-- 'process-trial-balance', company_id=<COMPANY_A>.
-- SELECT commit_tb_certification(
--   '<RUN_ID>', 'process-trial-balance', '<UPLOAD_A>', '<COMPANY_A>', 2026,
--   'sourcehash123', 'inputhash456', 'outputhash789', false, false,
--   '[]'::jsonb, '[]'::jsonb
-- );
-- EXPECT: returns {"certification_id": "...", "replay": false}.
-- SELECT status, output_hash FROM engine_runs WHERE id = '<RUN_ID>';
-- EXPECT: status='completed', output_hash='outputhash789'.
-- SELECT status FROM idempotency_keys WHERE engine_run_id = '<RUN_ID>';
-- EXPECT: status='completed' (if a reservation existed for this run).

-- ── 9. Atomic rollback — company mismatch aborts the whole transaction ──────
-- (fresh 'running' engine_run for COMPANY_A) SELECT commit_tb_certification(
--   '<RUN_ID_2>', 'process-trial-balance', '<UPLOAD_A>', '<COMPANY_B>', 2026,
--   'x', 'x', 'x', false, false, '[]'::jsonb, '[]'::jsonb
-- );
-- EXPECT: ERROR — ENGINE_RUN_COMPANY_MISMATCH.
-- SELECT count(*) FROM tb_certifications WHERE engine_run_id = '<RUN_ID_2>';
-- EXPECT: 0 — nothing committed.
-- SELECT status FROM engine_runs WHERE id = '<RUN_ID_2>';
-- EXPECT: still 'running' — untouched by the failed attempt.

-- ── 10. Upload mismatch rejection ────────────────────────────────────────────
-- (fresh 'running' engine_run for COMPANY_A, upload belonging to COMPANY_B)
-- EXPECT: ERROR — UPLOAD_COMPANY_MISMATCH. Same zero-side-effect proof as §9.

-- ── 11. Double-call replay — no duplicate, no re-execution ──────────────────
-- Call commit_tb_certification a second time with the SAME <RUN_ID> from §8:
-- EXPECT: returns {"certification_id": "<same id as §8>", "replay": true}.
-- SELECT count(*) FROM tb_certifications WHERE engine_run_id = '<RUN_ID>';
-- EXPECT: still exactly 1.

-- ── 12. Failed-run rejection ──────────────────────────────────────────────────
-- (an engine_run manually failed via the normal failIdempotency/
--  recordEngineRunFailed path, status='failed')
-- SELECT commit_tb_certification('<FAILED_RUN_ID>', ...);
-- EXPECT: ERROR — CANNOT_CERTIFY_FAILED_ENGINE_RUN. No certification created.

-- ── 13. Function-mismatch rejection ──────────────────────────────────────────
-- Call with p_expected_function_name = 'some-other-function' against a
-- 'process-trial-balance' engine_run:
-- EXPECT: ERROR — ENGINE_RUN_FUNCTION_MISMATCH.

-- ── 14. Bounded snapshot rejection ───────────────────────────────────────────
-- SELECT commit_tb_certification(..., p_rows_snapshot => '{"not":"an array"}'::jsonb);
-- EXPECT: ERROR — violates chk_tbc_rows_snapshot_bounded (jsonb_typeof != 'array').
-- SELECT commit_tb_certification(..., p_exceptions => jsonb_build_array(repeat('x', 70000)));
-- EXPECT: ERROR — violates chk_tbc_exceptions_bounded (pg_column_size > 65536).

-- ── 15. Blocking-result eligibility (is_blocking=true excluded) ─────────────
-- Commit a certification with is_blocking=true for the latest upload of
-- COMPANY_A/2026. SELECT * FROM get_authoritative_certification('<COMPANY_A>', 2026);
-- EXPECT: zero rows — a blocking result is real evidence but never
-- downstream-authoritative.

-- ── 16. Review-required eligibility (requires_review=true excluded) ─────────
-- Same as §15 with requires_review=true instead. EXPECT: zero rows.

-- ── 17. Deterministic authority selection — the C1/C2 scenario, proven ──────
-- Upload V1 for COMPANY_A/2026 → commit an ELIGIBLE certification C1
-- (is_blocking=false, requires_review=false).
-- SELECT * FROM get_authoritative_certification('<COMPANY_A>', 2026);
-- EXPECT: returns C1.
--
-- Now INSERT a NEW trial_balance_uploads row (Upload V2, same company/period,
-- a later uploaded_at) and commit a BLOCKING certification C2 against it.
-- SELECT * FROM get_authoritative_certification('<COMPANY_A>', 2026);
-- EXPECT: zero rows — NOT C1. This proves the explicit design decision: the
-- existence of a newer source with no eligible certification of its own
-- WITHDRAWS the older certification's downstream authority, rather than
-- silently falling back to it. C1 remains queryable directly by id/
-- sequence_no as permanent historical evidence — only its status as "the
-- current answer to get_authoritative_certification" changes.
--
-- Finally commit a second, ELIGIBLE certification C3 against Upload V2
-- (e.g. after fixing the imbalance and reprocessing).
-- SELECT * FROM get_authoritative_certification('<COMPANY_A>', 2026);
-- EXPECT: returns C3 — authority resumes once the CURRENT upload has its
-- own eligible certification.
-- ============================================================================

-- ── Slice 1R — authority-selection hardening (cases A-I) ─────────────────────
-- Fixes the real defect: the original query filtered to ELIGIBLE rows
-- BEFORE ordering by sequence_no DESC, so a newer blocking/requires_review
-- certification for the SAME upload could be silently skipped in favour of
-- an older eligible one. The corrected function finds the latest
-- certification for the current upload FIRST (regardless of eligibility),
-- then evaluates ONLY that row's eligibility — never falling back.
--
-- Fresh company (<COMPANY_R>) recommended for this section to avoid any
-- interaction with rows created in §17 above.

-- ── CASE A — single eligible certification is authoritative ─────────────────
-- Upload U1 (COMPANY_R/2026). Commit certification C1 against U1:
--   is_blocking=false, requires_review=false, sequence_no=100 (assigned).
-- SELECT * FROM get_authoritative_certification('<COMPANY_R>', 2026);
-- EXPECT: returns C1.

-- ── CASE B — newer BLOCKING certification on the SAME upload withdraws C1 ───
-- Same U1. Commit a second certification C2 against the SAME U1:
--   is_blocking=true, requires_review=false, sequence_no=101 (> C1's 100).
-- SELECT * FROM get_authoritative_certification('<COMPANY_R>', 2026);
-- EXPECT: zero rows — NOT C1. This is the exact defect this gate fixes:
-- the old query would have returned C1 (the only eligible row) because it
-- filtered on eligibility before ordering by sequence_no. C1 remains
-- queryable directly by id/sequence_no as permanent historical evidence.

-- ── CASE C — newer REQUIRES_REVIEW certification on the SAME upload ─────────
-- Same U1 (fresh company/period to isolate from Case B, or continue from a
-- state where C2 is the latest). Commit C2' against U1:
--   is_blocking=false, requires_review=true, sequence_no > the prior latest.
-- SELECT * FROM get_authoritative_certification('<COMPANY_R>', <period>);
-- EXPECT: zero rows. requires_review alone is sufficient to withdraw
-- authority from the latest attempt, exactly like is_blocking.

-- ── CASE D — newer upload exists with NO certification at all ───────────────
-- Fresh period. U1 has eligible C1. Insert a NEW trial_balance_uploads row
-- U2 (same company/period, later uploaded_at) with NO certification
-- committed against it yet.
-- SELECT * FROM get_authoritative_certification('<COMPANY_R>', <period>);
-- EXPECT: zero rows — NOT C1. U2 is now the current upload; it has no
-- certification (latest_certification CTE returns no row for U2), so
-- nothing is authoritative. This proves the function does not fall back
-- across uploads any more than it falls back within one.

-- ── CASE E — newer upload's latest certification is BLOCKING ────────────────
-- Continuing Case D: commit C2 against U2 with is_blocking=true.
-- SELECT * FROM get_authoritative_certification('<COMPANY_R>', <period>);
-- EXPECT: zero rows.

-- ── CASE F — newer upload's latest certification is ELIGIBLE ────────────────
-- Continuing Case E: commit C3 against U2 with is_blocking=false,
-- requires_review=false, sequence_no > C2's.
-- SELECT * FROM get_authoritative_certification('<COMPANY_R>', <period>);
-- EXPECT: returns C3. Authority moves to the current upload's own latest
-- eligible certification; U1/C1 is not involved at all (different
-- upload_id, never considered once U2 is current).

-- ── CASE G — source_file_hash drift on the current upload ───────────────────
-- Fresh period. U2 is the current upload. Commit C2 against U2 with
-- source_file_hash = 'hash-at-certification-time', is_blocking=false,
-- requires_review=false. Then, simulate drift: UPDATE
-- trial_balance_uploads SET source_file_hash = 'hash-DIFFERENT' WHERE id =
-- '<U2>' (only possible as service_role; this column has no live writer
-- yet, so this step is a direct-SQL simulation of a future wiring, not a
-- reachable app path today).
-- SELECT * FROM get_authoritative_certification('<COMPANY_R>', <period>);
-- EXPECT: zero rows — the latest certification's own source_file_hash no
-- longer matches the upload's current source_file_hash, so it cannot be
-- authoritative even though is_blocking=false AND requires_review=false.

-- ── CASE H — higher sequence_no among two eligible certifications wins ──────
-- Fresh period. U2 current upload. Commit C2a against U2: is_blocking=false,
-- requires_review=false, sequence_no=200. Commit C2b against U2 (e.g. a
-- re-run): is_blocking=false, requires_review=false, sequence_no=201 (>
-- C2a's 200). Both share the SAME source_file_hash as the current upload
-- (no drift).
-- SELECT * FROM get_authoritative_certification('<COMPANY_R>', <period>);
-- EXPECT: returns C2b — the higher sequence_no is "latest", regardless of
-- certified_at wall-clock ordering (sequence_no, not certified_at, is the
-- deterministic total order this function relies on).

-- ── CASE I — latest by sequence_no is BLOCKING even though an earlier one
--            on the same upload was eligible — never fall back to it ───────
-- Continuing a fresh instance of Case H's setup: C2a (sequence_no=200,
-- eligible) then C2b (sequence_no=201, is_blocking=true).
-- SELECT * FROM get_authoritative_certification('<COMPANY_R>', <period>);
-- EXPECT: zero rows — NOT C2a. This is the canonical counterexample from
-- the Slice 1R hardening request: the existence of ANY eligible
-- certification earlier in the same upload's history must never be used
-- as a fallback once a later attempt on that same upload is blocking or
-- requires review. Only the single latest-by-sequence_no row is ever
-- evaluated.
-- ============================================================================
