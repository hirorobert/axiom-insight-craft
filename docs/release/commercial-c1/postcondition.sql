-- READ-ONLY HOSTED POSTCONDITION for the commercial candidate (docs/release/COMMERCIAL_C1_RELEASE.md, step 3). Run AFTER
-- all three wrappers. Writes nothing; raises on the first violated expectation.
DO $$
DECLARE
  v_role TEXT; v_table TEXT; v_priv TEXT;
BEGIN
  -- 20261025100000: activation requests, specialist enquiries, tracked replies.
  IF to_regclass('public.service_enquiry_replies') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: service_enquiry_replies is missing (20261025100000 is not applied)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.service_enquiry_replies')) THEN
    RAISE EXCEPTION 'POSTCONDITION: service_enquiry_replies is without row-level security';
  END IF;
  IF has_table_privilege('anon', 'public.service_enquiry_replies', 'SELECT')
     OR has_table_privilege('authenticated', 'public.service_enquiry_replies', 'SELECT')
     OR has_table_privilege('authenticated', 'public.service_enquiry_replies', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDITION: service_enquiry_replies is readable or writable by a client role';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.staff_reply_service_enquiry(uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.staff_reply_service_enquiry(uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enquiry_notification_claim(integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: the reply/claim functions are not exactly scoped';
  END IF;
  IF position('plan_activation' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'chk_service_enquiries_service'))) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: plan_activation is not an accepted service';
  END IF;
  -- 20261026100000: no client write to the legacy adjusting journal; history still readable.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_table IN ARRAY ARRAY['public.adjusting_journal_entries', 'public.aje_lines'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION 'POSTCONDITION: % still holds % on % (20261026100000 is not applied)', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('adjusting_journal_entries', 'aje_lines') AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION: a client write policy remains on the legacy adjusting journal';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.adjusting_journal_entries', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDITION: earlier adjusting entries are no longer readable';
  END IF;
  -- 20261027100000: workspace purpose, append-only, owner-recorded, member-readable.
  IF to_regclass('public.workspace_purpose_events') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION: workspace_purpose_events is missing (20261027100000 is not applied)';
  END IF;
  IF has_table_privilege('authenticated', 'public.workspace_purpose_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.workspace_purpose_events', 'UPDATE')
     OR has_table_privilege('anon', 'public.workspace_purpose_events', 'SELECT')
     OR NOT has_function_privilege('authenticated', 'public.set_workspace_purpose(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_workspace_purpose(uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION: workspace purpose grants are not exactly scoped';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wpe_append_only' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'POSTCONDITION: workspace purpose events are not append-only';
  END IF;
  RAISE NOTICE 'POSTCONDITION OK.';
END;
$$;
-- The same counts and digests as recorded by the preflight (unchanged):
SELECT count(*) AS legacy_entries, coalesce(md5(string_agg(to_jsonb(a)::text, '' ORDER BY a.id)), '') AS legacy_entries_md5 FROM public.adjusting_journal_entries a;
SELECT count(*) AS legacy_lines, coalesce(md5(string_agg(to_jsonb(l)::text, '' ORDER BY l.id)), '') AS legacy_lines_md5 FROM public.aje_lines l;
SELECT count(*) AS enquiries FROM public.service_enquiries;
