-- READ-ONLY HOSTED PREFLIGHT for the publication controls (docs/release/fs-first-slice/RECORD.md §8). Run BEFORE the
-- wrapper of 20261111100000_fs_publication_controls.sql. Writes nothing; raises on the first violated expectation.
DO $$
BEGIN
  IF to_regclass('public.fs_signoff_policy_events') IS NULL
     OR position('SIGNOFF_SEPARATE_APPROVERS_REQUIRED' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the statement sign-off policy (20261024100000) is not in force';
  END IF;
  IF to_regprocedure('public._fs_comprehensive_income(uuid, integer, jsonb)') IS NULL OR to_regprocedure('public.fs_comparatives_status(uuid, integer)') IS NULL
     OR to_regprocedure('public.fs_reporting_input(uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: the reporting release r1 (20261016100000–20261022100000) is not in force';
  END IF;
  IF (SELECT count(*) FROM public.fs_pack_requirements r WHERE r.pack_family = 'ifrs-for-smes') <> 50
     OR (SELECT max(r.pack_version) FROM public.fs_pack_requirements r WHERE r.pack_family = 'ifrs-for-smes') <> '1.1.0' THEN
    RAISE EXCEPTION 'PREFLIGHT: fs_pack_requirements is not at pack 1.1.0 with 50 rows';
  END IF;
  IF to_regprocedure('public.fs_evidence_statements(uuid, integer)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.fs_pack_requirements r WHERE r.requirement_id = 'smes.note.going_concern')
     OR position('PUBLICATION_PATH_UNSUPPORTED' IN pg_get_functiondef('public.fs_bind_publication()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: the publication controls are already applied, or partly applied';
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: apply the wrapper';
END;
$$;
-- The sign-offs this release must preserve (record them; compare after):
SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq;
