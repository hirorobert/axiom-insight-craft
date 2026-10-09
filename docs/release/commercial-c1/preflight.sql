-- READ-ONLY HOSTED PREFLIGHT for the commercial candidate (docs/release/COMMERCIAL_C1_RELEASE.md, step 1). Run BEFORE the
-- three wrappers. Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF to_regclass('public.fs_signoff_policy_events') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the statement sign-off policy (20261024100000, batch reporting-r5) is not applied; apply it first';
  END IF;
  IF to_regprocedure('public.service_enquiry_notification_transition_guard()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the enquiry activation readiness (20260922100000) is not in force';
  END IF;
  IF to_regclass('public.service_enquiry_replies') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the commercial enquiry additions (20261025100000) are already applied, or partly applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'close_review_propose_adjustment') THEN
    RAISE EXCEPTION 'PREFLIGHT: Close Review adjustments (20261015100000) are not in force';
  END IF;
  IF to_regclass('public.workspace_purpose_events') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: workspace purpose (20261027100000) is already applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply 20261025100000, 20261026100000, then 20261027100000';
END;
$$;
-- Record before applying (compare after; neither migration changes a row of these tables):
SELECT count(*) AS legacy_entries, coalesce(md5(string_agg(to_jsonb(a)::text, '' ORDER BY a.id)), '') AS legacy_entries_md5 FROM public.adjusting_journal_entries a;
SELECT count(*) AS legacy_lines, coalesce(md5(string_agg(to_jsonb(l)::text, '' ORDER BY l.id)), '') AS legacy_lines_md5 FROM public.aje_lines l;
SELECT count(*) AS enquiries FROM public.service_enquiries;
