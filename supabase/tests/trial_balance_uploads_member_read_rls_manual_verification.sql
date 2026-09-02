-- ============================================================================
-- Ω∞ Phase 0 Slice 4B — trial_balance_uploads member-read RLS manual verification
-- Run this in: Supabase Dashboard → SQL Editor, against a project with
-- migration 20260902160000_trial_balance_uploads_member_read_rls.sql applied.
--
-- UNEXECUTED. This environment has no live Supabase project access
-- (established throughout this project's history). Every case below is the
-- test SPECIFICATION, not a report of results. Do not treat any line as a
-- passed test until it has actually been run and its real output captured.
--
-- Fixture setup assumed for all cases below:
--   Company A, Company B — two distinct companies.
--   User Uploader  — firm_members row in Company A, accepted_at set, is the
--                     user_id on trial_balance_uploads row <UPLOAD_A>.
--   User MemberB    — a SECOND, DIFFERENT firm_members row in Company A,
--                     accepted_at set, did NOT upload <UPLOAD_A>.
--   User OutsiderC  — firm_members row in Company B only (different company),
--                     accepted_at set. No membership in Company A at all.
--   User Unrelated  — a real authenticated user with NO firm_members row for
--                     EITHER company (e.g. signed up but never joined a firm).
--   <UPLOAD_A>      — trial_balance_uploads row: company_id = Company A,
--                     user_id = Uploader.
--   A real eligible tb_certifications row exists for Company A / the current
--   period, committed against <UPLOAD_A> (so get_authoritative_certification
--   would return it if visibility were correct).
-- ============================================================================

-- ── 1. Policy exists, additive, correctly scoped ─────────────────────────────
SELECT policyname, cmd, qual FROM pg_policies
 WHERE tablename = 'trial_balance_uploads' AND schemaname = 'public'
 ORDER BY policyname;
-- EXPECT: TWO SELECT policies present —
--   "Users can view their own uploads"                         (unchanged, pre-existing)
--   "Accepted workspace members can view company uploads"      (new, this migration)
-- Neither replaced the other. INSERT/UPDATE/DELETE policies (uploads_company_
-- ownership_insert/update, and any legacy write policy) are unchanged in count.

-- ── 2. Table GRANTs unchanged by this migration ──────────────────────────────
SELECT grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_name = 'trial_balance_uploads' AND table_schema = 'public'
 ORDER BY grantee, privilege_type;
-- EXPECT: identical to the pre-migration grant set (this migration issues
-- zero GRANT/REVOKE statements — only a new RLS POLICY, which cannot alter
-- table-level privileges). Report whatever this shows as the CURRENT
-- baseline — this file does not assert what that baseline should be, only
-- that this migration did not change it.

-- ── 3. Direct SELECT — Uploader sees their own upload (unchanged behavior) ──
-- As Uploader:
-- SELECT id FROM public.trial_balance_uploads WHERE id = '<UPLOAD_A>';
-- EXPECT: 1 row. (Matches the pre-existing "Users can view their own
-- uploads" policy — proves that policy still works, untouched.)

-- ── 4. Direct SELECT — same-company non-uploader now sees it (THE FIX) ──────
-- As MemberB:
-- SELECT id FROM public.trial_balance_uploads WHERE id = '<UPLOAD_A>';
-- EXPECT: 1 row. Before this migration: 0 rows (the defect). After: 1 row,
-- via the NEW "Accepted workspace members can view company uploads" policy.

-- ── 5. Direct SELECT — different-company member cannot see it ───────────────
-- As OutsiderC:
-- SELECT id FROM public.trial_balance_uploads WHERE id = '<UPLOAD_A>';
-- EXPECT: 0 rows. OutsiderC's only firm_members row is for Company B, so
-- fm.company_id = trial_balance_uploads.company_id (Company A) never
-- matches — no cross-tenant leak.

-- ── 6. Direct SELECT — unrelated authenticated user (no membership anywhere) ─
-- As Unrelated:
-- SELECT id FROM public.trial_balance_uploads WHERE id = '<UPLOAD_A>';
-- EXPECT: 0 rows. No firm_members row exists for this user at all, so the
-- EXISTS subquery in both SELECT policies is false, and auth.uid() != the
-- uploader's uid either.

-- ── 7. Direct SELECT — anon ──────────────────────────────────────────────────
-- As anon (no Authorization header / anon key only):
-- SELECT id FROM public.trial_balance_uploads WHERE id = '<UPLOAD_A>';
-- EXPECT: 0 rows. auth.uid() is NULL for anon, matching neither policy's
-- USING clause. (Also gated by table-level GRANTs to anon, unaffected by
-- this migration — see case 2.)

-- ── 8. RPC — Uploader sees the authoritative certification (unchanged) ──────
-- As Uploader:
-- SELECT * FROM get_authoritative_certification('<COMPANY_A>', <PERIOD_YEAR>);
-- EXPECT: 1 row — the eligible certification. Was already correct before
-- this migration (Uploader's own upload was always visible to them).

-- ── 9. RPC — same-company non-uploader now sees the SAME certification ──────
-- As MemberB:
-- SELECT * FROM get_authoritative_certification('<COMPANY_A>', <PERIOD_YEAR>);
-- EXPECT: 1 row, the SAME certification id as case 8. Before this
-- migration: 0 rows (the defect this migration exists to close) — the
-- latest_upload CTE returned nothing because <UPLOAD_A> was RLS-invisible
-- to MemberB, so the whole function short-circuited to empty regardless of
-- whether a real certification existed.

-- ── 10. RPC — different-company / non-member still correctly returns nothing ─
-- As OutsiderC:
-- SELECT * FROM get_authoritative_certification('<COMPANY_A>', <PERIOD_YEAR>);
-- EXPECT: 0 rows. Fails closed exactly as before — this migration only ADDS
-- visibility for genuine Company A members, never grants anything to a
-- Company B-only member.
--
-- As Unrelated:
-- SELECT * FROM get_authoritative_certification('<COMPANY_A>', <PERIOD_YEAR>);
-- EXPECT: 0 rows, same reasoning.

-- ── 11. Stale/non-authoritative certification remains fail-closed ───────────
-- Using the Slice 1R Case B/H/I setup (a newer blocking/requires_review
-- certification exists on the SAME upload, superseding an older eligible
-- one) or the Slice 2 source-hash-drift setup (Case G/J from the SAFISHA
-- foundation manual verification spec):
-- As MemberB (now correctly able to see the upload row):
-- SELECT * FROM get_authoritative_certification('<COMPANY_A>', <PERIOD_YEAR>);
-- EXPECT: 0 rows — identical to what Uploader would see in the same state.
-- This migration only fixes WHO can reach a correct answer; it does not
-- touch the authority predicate itself (latest-upload selection, source-
-- hash matching, blocking/requires_review rules, or the NULL-fails-closed
-- semantics from the source-hash-authority-hardening migration). Confirms
-- the fix is purely visibility, not a relaxation of any authority rule.

-- ── 12. Mutation privileges genuinely unaffected ─────────────────────────────
-- As MemberB (now has new SELECT visibility via case 4):
-- UPDATE public.trial_balance_uploads SET file_name = 'tampered' WHERE id = '<UPLOAD_A>';
-- EXPECT: 0 rows affected / permission denied per whatever the EXISTING
-- UPDATE policy already required (uploads_company_ownership_update and any
-- legacy "Users can update their own uploads" policy) — this migration
-- added a SELECT-only policy; it cannot and does not grant any write
-- capability. If this migration accidentally granted MemberB write access
-- that they should not have, that is a defect in this migration, not an
-- acceptable side effect — this case exists specifically to disprove that.
-- ============================================================================
