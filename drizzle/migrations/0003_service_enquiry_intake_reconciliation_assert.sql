-- Reconciliation of migration 20260921100000_service_enquiry_intake.sql into the
-- authoritative Drizzle migration journal.
--
-- Context: the service-enquiry intake schema was applied through the elevated SQL
-- path, so it carries a legacy supabase_migrations.schema_migrations row but no entry
-- in the active drizzle.__drizzle_migrations authority. This migration creates,
-- alters and drops NOTHING. It is a pure fail-closed assertion that the live schema
-- matches the committed source, and its only effect is to give that already-applied
-- work an authoritative journal entry. Any divergence aborts the migration.

DO $reconcile$
DECLARE
  expected_tables TEXT[] := ARRAY[
    'platform_staff_audit',
    'platform_staff_members',
    'service_enquiries',
    'service_enquiry_events',
    'service_enquiry_notifications',
    'service_enquiry_rate_limits',
    'service_enquiry_status_transitions'
  ];
  expected_triggers TEXT[] := ARRAY[
    'platform_staff_audit:trg_platform_staff_audit_append_only',
    'platform_staff_audit:trg_platform_staff_audit_no_truncate',
    'service_enquiries:trg_service_enquiries_write_guard',
    'service_enquiry_events:trg_service_enquiry_events_append_only',
    'service_enquiry_events:trg_service_enquiry_events_no_truncate',
    'service_enquiry_status_transitions:trg_service_enquiry_transitions_immutable',
    'service_enquiry_status_transitions:trg_service_enquiry_transitions_no_truncate'
  ];
  expected_constraints TEXT[] := ARRAY[
    'service_enquiries:uq_service_enquiries_reference',
    'service_enquiries:uq_service_enquiries_idempotency',
    'service_enquiries:fk_service_enquiries_requester',
    'service_enquiries:fk_service_enquiries_assignee',
    'service_enquiry_events:fk_service_enquiry_events_enquiry',
    'service_enquiry_notifications:uq_service_enquiry_notification_kind',
    'service_enquiry_notifications:fk_service_enquiry_notifications_enquiry',
    'platform_staff_members:fk_platform_staff_user',
    'platform_staff_members:chk_platform_staff_role',
    'platform_staff_members:chk_platform_staff_active_state'
  ];
  expected_routines TEXT[][] := ARRAY[
    ['current_platform_staff_role','26f44a5817fa953f022133b943774bf2'],
    ['enquiry_email_is_valid','53c40dc624e5ef632ea1e7b33379820a'],
    ['enquiry_notification_claim','15f3f0cb9bfea2937e89186d3eb05542'],
    ['enquiry_notification_complete','8d1991e8d788dd652a7a68ae097842a4'],
    ['enquiry_text_ok','0e96bfd96f7059442d3da056e71f6a91'],
    ['generate_service_enquiry_reference','3b5504594d42a23fcf25b150d7e996b5'],
    ['is_iso_3166_alpha2','99bccd9c33e189e25a2a042f946d7d3c'],
    ['platform_staff_grant','9429e84d2b91553265744fef8e07e3a6'],
    ['platform_staff_revoke','80a3024fa8249e53027eab9f3037f493'],
    ['service_enquiry_ack_state','a53d7b468b66d7a8ef8ea33fa21dc0a0'],
    ['service_enquiry_append_only_guard','89b717ead825c899e8a078613e6f31da'],
    ['service_enquiry_payload_valid','36a7d526ab3b06f1a94cd9eed170fe05'],
    ['service_enquiry_status_is_valid','a038958ae10bbd4dc6b3a5145a26a5e4'],
    ['staff_add_service_enquiry_note','d1cbca0dc9fb8196898782b03ad8322f'],
    ['staff_assign_service_enquiry','85e1797dfa8672b1787a19e1d8da98cc'],
    ['staff_get_service_enquiry','8ceaf551472dee284fce2c88a740490b'],
    ['staff_list_platform_staff','b2a340b22965a16aaba22b16bce87c16'],
    ['staff_transition_service_enquiry','c2a6c8473d240de24b026997887adec6'],
    ['submit_service_enquiry','4f4501790514950a6635c99cd2487ae4']
  ];
  t TEXT;
  pair TEXT;
  i INT;
  actual_md5 TEXT;
  n INT;
BEGIN
  -- 1. Tables exist, RLS enabled, no RLS policies (service-role-only by design).
  FOREACH t IN ARRAY expected_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION 'RECONCILIATION FAILED: missing table public.%', t;
    END IF;
    IF NOT (
      SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relname = t
    ) THEN
      RAISE EXCEPTION 'RECONCILIATION FAILED: RLS not enabled on public.%', t;
    END IF;
    SELECT count(*) INTO n
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relname = t;
    IF n <> 0 THEN
      RAISE EXCEPTION 'RECONCILIATION FAILED: unexpected % RLS policies on public.%', n, t;
    END IF;
  END LOOP;

  -- 2. No client-role table privileges anywhere in this subsystem.
  SELECT count(*) INTO n
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, '{}'::aclitem[])) AS a
  WHERE ns.nspname = 'public'
    AND c.relname = ANY (expected_tables)
    AND pg_get_userbyid(a.grantee) IN ('anon', 'authenticated');
  IF n <> 0 THEN
    RAISE EXCEPTION 'RECONCILIATION FAILED: % client-role table grant(s) present on enquiry tables', n;
  END IF;

  -- 3. Append-only / immutability triggers present.
  FOREACH pair IN ARRAY expected_triggers LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND NOT tg.tgisinternal
        AND c.relname = split_part(pair, ':', 1)
        AND tg.tgname = split_part(pair, ':', 2)
    ) THEN
      RAISE EXCEPTION 'RECONCILIATION FAILED: missing trigger %', pair;
    END IF;
  END LOOP;

  -- 4. Integrity constraints present.
  FOREACH pair IN ARRAY expected_constraints LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public'
        AND c.relname = split_part(pair, ':', 1)
        AND con.conname = split_part(pair, ':', 2)
    ) THEN
      RAISE EXCEPTION 'RECONCILIATION FAILED: missing constraint %', pair;
    END IF;
  END LOOP;

  -- 5. Routine-body identity: every routine must match the definition recorded from
  --    the committed migration source at reconciliation time.
  FOR i IN 1 .. array_length(expected_routines, 1) LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO actual_md5
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname = expected_routines[i][1];

    IF actual_md5 IS NULL THEN
      RAISE EXCEPTION 'RECONCILIATION FAILED: missing routine public.%', expected_routines[i][1];
    END IF;
    IF actual_md5 <> expected_routines[i][2] THEN
      RAISE EXCEPTION 'RECONCILIATION FAILED: routine body drift in public.% (expected %, found %)',
        expected_routines[i][1], expected_routines[i][2], actual_md5;
    END IF;
  END LOOP;

  -- 6. Status-transition authority intact: 18 seeded edges, no self-loops,
  --    nothing entering or leaving the terminal 'submitted' entry state.
  SELECT count(*) INTO n FROM public.service_enquiry_status_transitions;
  IF n <> 18 THEN
    RAISE EXCEPTION 'RECONCILIATION FAILED: expected 18 status transitions, found %', n;
  END IF;
  SELECT count(*) INTO n FROM public.service_enquiry_status_transitions
  WHERE from_status = to_status OR to_status = 'submitted';
  IF n <> 0 THEN
    RAISE EXCEPTION 'RECONCILIATION FAILED: % invalid status transition edge(s)', n;
  END IF;

  -- 7. Dark-launch posture: nobody enrolled as platform staff by this reconciliation.
  SELECT count(*) INTO n FROM public.platform_staff_members;
  IF n <> 0 THEN
    RAISE NOTICE 'RECONCILIATION NOTE: % platform staff row(s) already present (not modified)', n;
  END IF;

  RAISE NOTICE 'RECONCILIATION OK: service-enquiry intake schema matches committed source.';
END
$reconcile$;