-- READ-ONLY HOSTED PREFLIGHT for the work bounds (docs/release/fs-first-slice/RECORD.md §8). Run BEFORE the wrapper of
-- 20261114100000_fs_work_bounds.sql. Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF to_regclass('public.fs_review_comments') IS NULL OR to_regclass('public.fs_review_comment_events') IS NULL
     OR position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the reviewed reporting journey (20261112100000, batch fs-journey-r1) is not in force';
  END IF;
  IF to_regprocedure('public.fs_commit_revision(uuid, text, integer, text, integer, text, jsonb, text, jsonb, text[], jsonb)') IS NULL
     OR to_regclass('public.financial_evidence_batches') IS NULL OR to_regclass('public.financial_statement_reports') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the financial-statements persistence (20260919110000) is not in force';
  END IF;
  IF to_regprocedure('public.fs_work_bounds()') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('trg_feb_work_bounds', 'trg_fsr_work_bounds', 'trg_fsrc_work_bounds', 'trg_fsrce_work_bounds')) THEN
    RAISE EXCEPTION 'PREFLIGHT: the work bounds are already applied, or partly applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply the wrapper';
END;
$$;
-- Nothing in the live data may already exceed a bound the triggers will enforce on NEW rows only (existing rows are never
-- touched; this listing is for the record — every count must be 0):
SELECT 'evidence batches over 20,000 rows' AS what, count(*) FROM public.financial_evidence_batches WHERE jsonb_typeof(batch_document -> 'rows') = 'array' AND jsonb_array_length(batch_document -> 'rows') > 20000
UNION ALL SELECT 'evidence batches over 4 MiB', count(*) FROM public.financial_evidence_batches WHERE octet_length(batch_document::text) > 4194304
UNION ALL SELECT 'report documents over 8 MiB', count(*) FROM public.financial_statement_reports WHERE octet_length(report_document::text) > 8388608
UNION ALL SELECT 'lineages at or over 1,000 versions', count(*) FROM (SELECT report_id FROM public.financial_statement_reports GROUP BY report_id HAVING max(report_version) >= 1000) x
UNION ALL SELECT 'versions at or over 500 comments', count(*) FROM (SELECT report_id, report_version FROM public.fs_review_comments GROUP BY 1, 2 HAVING count(*) >= 500) y
UNION ALL SELECT 'comments at or over 200 events', count(*) FROM (SELECT comment_id FROM public.fs_review_comment_events GROUP BY 1 HAVING count(*) >= 200) z;
-- The sign-offs this release must preserve (record them; compare after):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
