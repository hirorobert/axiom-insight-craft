INSERT INTO cfoclose_release.staged_artifacts (batch, kind, body) VALUES ('fs-capacity-r1', 'preflight', $cfoclose_stage_0e86b0fa2b059e96$-- READ-ONLY HOSTED PREFLIGHT for the account capacity (docs/release/fs-first-slice/RECORD.md §8). Run BEFORE the wrapper of
-- 20261115100000_fs_account_capacity.sql. Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF to_regprocedure('public.fs_work_bounds()') IS NULL OR (public.fs_work_bounds() ->> 'contract') IS DISTINCT FROM 'fs-work-bounds/1' THEN
    RAISE EXCEPTION 'PREFLIGHT: the work bounds (20261114100000, batch fs-bounds-r1, fs-work-bounds/1) are not in force';
  END IF;
  IF position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0
     OR to_regprocedure('public._cr_certified_accounts(uuid)') IS NULL OR to_regprocedure('public.get_authoritative_certification(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the reviewed reporting journey (20261112100000) or the Close Review authorities are not in force';
  END IF;
  IF to_regprocedure('public.fs_account_capacity(uuid, integer)') IS NOT NULL
     OR position('over_capacity' IN pg_get_functiondef('public.fs_statement_composition(uuid, integer)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the account capacity is already applied, or partly applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply the wrapper';
END;
$$;
-- Which companies would be over the envelope (1000 certified accounts read across the current and comparative periods)
-- for their open reporting years? For the record: these companies keep every saved version and issued pack, and are told
-- so on the pages; none should be an activated financial-statements company at this release.
WITH years AS (
  SELECT DISTINCT fp.company_id, extract(year FROM fp.fiscal_year_end)::int AS period_year FROM public.fiscal_periods fp
), counts AS (
  SELECT y.company_id, y.period_year,
         (SELECT count(DISTINCT a.account_key) FROM public.get_authoritative_certification(y.company_id, y.period_year) c, public._cr_certified_accounts(c.id) a) AS current_accounts,
         (SELECT count(DISTINCT a.account_key) FROM public.get_authoritative_certification(y.company_id, y.period_year - 1) c, public._cr_certified_accounts(c.id) a) AS comparative_accounts
    FROM years y
)
SELECT company_id, period_year, current_accounts, comparative_accounts, current_accounts + comparative_accounts AS total_read
  FROM counts WHERE current_accounts + comparative_accounts > 1000 ORDER BY total_read DESC;
-- The sign-offs this release must preserve (record them; compare after):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
$cfoclose_stage_0e86b0fa2b059e96$);
