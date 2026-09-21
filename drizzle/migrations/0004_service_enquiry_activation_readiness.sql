-- CFOClose Phase 1 service enquiries — pre-activation hardening (forward-only; 20260921100000 is not edited).
--
-- 1. EMAIL-STATUS TRUTHFULNESS. The outbox previously knew only pending / sent / failed, and 'sent' was easy to read as
--    "delivered". The outbox now separates six facts:
--        queued      created (or re-queued after a transient failure), waiting to be attempted
--        processing  claimed by a dispatcher; a lease, so a crashed dispatcher cannot strand the row
--        accepted    the email PROVIDER accepted the message. This is all a send call can prove. It is NOT delivery.
--        delivered   confirmed by a VERIFIED provider event. No provider event ingestion exists yet, so nothing writes this state.
--        failed      permanent failure, retries exhausted, or a non-deliverable (test/reserved) address
--        bounced     reported by a VERIFIED provider event. Nothing writes this state yet either.
--    A guard trigger enforces the transition graph and refuses delivered/bounced unless a future, verified provider-event
--    function deliberately sets app.enquiry_provider_event = 'verified'. Delivery is never inferred from acceptance.
--    Existing rows are converted: pending -> queued, sent -> accepted (the 'sent' state only ever meant provider acceptance).
--
-- 2. PUBLIC-REFERENCE SEARCH. The staff queue now finds an enquiry from a complete or partial public reference, in any case,
--    with or without the CFQ- prefix or dashes, and with stray whitespace. No dynamic SQL and no LIKE on user input: the
--    reference branch only ever sees a term already proven to be 'CFQ' + hex, and uses an index range scan.
--
-- Authorization is unchanged: every staff_* function still refuses (42501) anyone who is not ACTIVE platform staff before it
-- reads a row; the outbox functions remain service_role only.

-- ══ 1. outbox status model ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.service_enquiry_notifications DROP CONSTRAINT IF EXISTS chk_service_enquiry_notification_status;
ALTER TABLE public.service_enquiry_notifications DROP CONSTRAINT IF EXISTS chk_service_enquiry_notification_sent;
DROP INDEX IF EXISTS public.idx_service_enquiry_notifications_pending;

-- The guard below is created after this data conversion, so the conversion is not itself a "transition".
UPDATE public.service_enquiry_notifications SET status = 'queued'   WHERE status = 'pending';
UPDATE public.service_enquiry_notifications SET status = 'accepted' WHERE status = 'sent';

ALTER TABLE public.service_enquiry_notifications ALTER COLUMN status SET DEFAULT 'queued';

ALTER TABLE public.service_enquiry_notifications
  ADD CONSTRAINT chk_service_enquiry_notification_status
      CHECK (status IN ('queued', 'processing', 'accepted', 'delivered', 'failed', 'bounced'));

-- sent_at is the time the PROVIDER ACCEPTED the message (kept under its original name; it is exposed as accepted_at).
ALTER TABLE public.service_enquiry_notifications
  ADD CONSTRAINT chk_service_enquiry_notification_accepted
      CHECK ((status IN ('accepted', 'delivered', 'bounced')) = (sent_at IS NOT NULL));

CREATE INDEX idx_service_enquiry_notifications_due
  ON public.service_enquiry_notifications (created_at) WHERE status IN ('queued', 'processing');

CREATE OR REPLACE FUNCTION public.service_enquiry_notification_transition_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'queued'     AND NEW.status = 'processing')
    OR (OLD.status = 'processing' AND NEW.status IN ('accepted', 'queued', 'failed'))
    OR (OLD.status = 'accepted'   AND NEW.status IN ('delivered', 'bounced'))
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: notification % -> % is not permitted', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- Delivery and bounce are facts only a verified provider event can establish. Acceptance is not delivery.
  IF NEW.status IN ('delivered', 'bounced') AND coalesce(current_setting('app.enquiry_provider_event', true), '') <> 'verified' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: % requires a verified provider event', NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_enquiry_notification_transition ON public.service_enquiry_notifications;
CREATE TRIGGER trg_service_enquiry_notification_transition
  BEFORE UPDATE OF status ON public.service_enquiry_notifications
  FOR EACH ROW EXECUTE FUNCTION public.service_enquiry_notification_transition_guard();

REVOKE ALL ON FUNCTION public.service_enquiry_notification_transition_guard() FROM PUBLIC, anon, authenticated;

-- The requester-facing state. Deliberately coarse and truthful: 'sent' means the provider ACCEPTED an acknowledgement — the
-- receipt never claims delivery.
CREATE OR REPLACE FUNCTION public.service_enquiry_ack_state(p_enquiry_id UUID)
  RETURNS TEXT
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE n.status
           WHEN 'accepted'  THEN 'sent'
           WHEN 'delivered' THEN 'sent'
           WHEN 'failed'    THEN 'unavailable'
           WHEN 'bounced'   THEN 'unavailable'
           ELSE 'pending'
         END
    FROM public.service_enquiry_notifications n
   WHERE n.enquiry_id = p_enquiry_id AND n.kind = 'requester_acknowledgement';
$$;

-- Claims due rows (optionally for one enquiry) and returns only what a message needs: never the enquiry's free text.
-- A row is due when it is queued, or when its processing lease (10 minutes) has expired — a crashed dispatcher's row is retried;
-- the provider de-duplicates on the row's idempotency identity, so the retry cannot send a second message.
CREATE OR REPLACE FUNCTION public.enquiry_notification_claim(p_limit INTEGER DEFAULT 10, p_enquiry_id UUID DEFAULT NULL)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rows JSONB;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: notification dispatch requires the service role' USING ERRCODE = '42501';
  END IF;

  -- An expired lease on a row that has already used every attempt can never be retried: it is a failure, not a limbo state.
  UPDATE public.service_enquiry_notifications
     SET status = 'failed', last_error_code = 'LEASE_EXPIRED', updated_at = now()
   WHERE status = 'processing' AND attempt_count >= 5 AND last_attempt_at < now() - interval '10 minutes';

  WITH due AS (
    SELECT n.id
      FROM public.service_enquiry_notifications n
     WHERE n.attempt_count < 5
       AND (p_enquiry_id IS NULL OR n.enquiry_id = p_enquiry_id)
       AND ((n.status = 'queued' AND (n.last_attempt_at IS NULL OR n.last_attempt_at < now() - interval '5 minutes'))
         OR (n.status = 'processing' AND n.last_attempt_at < now() - interval '10 minutes'))
     ORDER BY n.created_at
     LIMIT greatest(1, least(coalesce(p_limit, 10), 50))
       FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.service_enquiry_notifications n
       SET status = 'processing', attempt_count = n.attempt_count + 1, last_attempt_at = now(), updated_at = now()
      FROM due WHERE n.id = due.id
    RETURNING n.id, n.enquiry_id, n.kind, n.attempt_count
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'kind', c.kind, 'attempt', c.attempt_count,
           'reference', e.public_reference, 'service_code', e.service_code, 'source_context', e.source_context,
           'country_code', e.country_code, 'submitted_at', e.submitted_at,
           'requester_name', CASE WHEN c.kind = 'requester_acknowledgement' THEN e.requester_name END,
           'requester_email', CASE WHEN c.kind = 'requester_acknowledgement' THEN e.requester_email END
         ) ORDER BY e.submitted_at), '[]'::jsonb)
    INTO v_rows
    FROM claimed c JOIN public.service_enquiries e ON e.id = c.enquiry_id;

  RETURN v_rows;
END;
$$;

-- outcome: 'accepted' (the provider accepted the message) | 'retry' (transient failure: back to queued) | 'failed' (permanent)
--        | 'blocked' (delivery is not configured: back to queued, no attempt charged).
-- Only a row that is currently 'processing' can be completed, so a duplicate or late completion changes nothing.
CREATE OR REPLACE FUNCTION public.enquiry_notification_complete(
  p_id                  UUID,
  p_outcome             TEXT,
  p_provider_message_id TEXT DEFAULT NULL,
  p_error_code          TEXT DEFAULT NULL
)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.service_enquiry_notifications%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: notification dispatch requires the service role' USING ERRCODE = '42501';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted', 'retry', 'failed', 'blocked') THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: unknown outcome' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.service_enquiry_notifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no such notification' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'processing' THEN
    RETURN jsonb_build_object('status', v_row.status, 'changed', false);   -- only an in-flight row can be completed
  END IF;

  IF p_outcome = 'accepted' THEN
    UPDATE public.service_enquiry_notifications
       SET status = 'accepted', sent_at = now(), provider_message_id = left(p_provider_message_id, 200), last_error_code = NULL, updated_at = now()
     WHERE id = p_id;
  ELSIF p_outcome = 'failed' OR (p_outcome = 'retry' AND v_row.attempt_count >= 5) THEN
    UPDATE public.service_enquiry_notifications
       SET status = 'failed', last_error_code = coalesce(p_error_code, 'DELIVERY_FAILED'), updated_at = now()
     WHERE id = p_id;
  ELSE  -- retry / blocked: back to the queue
    UPDATE public.service_enquiry_notifications
       SET status = 'queued',
           last_error_code = coalesce(p_error_code, CASE p_outcome WHEN 'blocked' THEN 'EMAIL_NOT_CONFIGURED' ELSE 'DELIVERY_RETRY' END),
           attempt_count = CASE WHEN p_outcome = 'blocked' THEN greatest(attempt_count - 1, 0) ELSE attempt_count END,
           updated_at = now()
     WHERE id = p_id;
  END IF;

  RETURN jsonb_build_object('status', (SELECT status FROM public.service_enquiry_notifications WHERE id = p_id), 'changed', true);
END;
$$;

-- ══ 2. staff queue: reference search and honest notification states ══════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_service_enquiries_reference_compact
  ON public.service_enquiries ((replace(public_reference, '-', '') COLLATE "C"));

CREATE OR REPLACE FUNCTION public.staff_list_service_enquiries(
  p_status  TEXT[]       DEFAULT NULL,
  p_service TEXT[]       DEFAULT NULL,
  p_country TEXT         DEFAULT NULL,
  p_from    TIMESTAMPTZ  DEFAULT NULL,
  p_to      TIMESTAMPTZ  DEFAULT NULL,
  p_search  TEXT         DEFAULT NULL,
  p_limit   INTEGER      DEFAULT 25,
  p_offset  INTEGER      DEFAULT 0
)
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Whitespace-normalised, lower-cased and length-capped: the term is bounded before it touches any row.
  v_term     TEXT := left(regexp_replace(lower(btrim(coalesce(p_search, ''))), '\s+', ' ', 'g'), 100);
  -- The same term with every space and dash removed, upper-cased: the only form the reference branch ever sees.
  v_compact  TEXT;
  v_ref_low  TEXT := NULL;
  v_ref_only BOOLEAN := false;
  v_text     BOOLEAN;
  v_limit    INTEGER := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset   INTEGER := greatest(0, coalesce(p_offset, 0));
  v_result   JSONB;
BEGIN
  IF public.current_platform_staff_role() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: platform staff only' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(p_status) s WHERE NOT public.service_enquiry_status_is_valid(s)) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: unknown status filter' USING ERRCODE = '22023';
  END IF;
  IF p_service IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(p_service) s WHERE s NOT IN ('general', 'support', 'donor_reporting', 'tax_tanzania_preview', 'tax_general')) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: unknown service filter' USING ERRCODE = '22023';
  END IF;
  IF p_country IS NOT NULL AND p_country <> '' AND NOT public.is_iso_3166_alpha2(p_country) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: unknown country filter' USING ERRCODE = '22023';
  END IF;

  v_compact := upper(regexp_replace(v_term, '[\s-]+', '', 'g'));
  IF v_compact ~ '^CFQ[0-9A-F]{1,12}$' THEN
    v_ref_low := v_compact;              -- 'CFQ-C63D-C27A' / 'cfq c63d' / 'CFQC63D': unmistakably a reference (prefix)
    v_ref_only := true;
  ELSIF v_compact ~ '^[0-9A-F]{4,12}$' THEN
    v_ref_low := 'CFQ' || v_compact;     -- 'C63D-C27A-D191': a reference typed without its prefix; may also be an organisation/email fragment
  END IF;
  -- Organisation / email substring search is unchanged (literal, no LIKE); a reference-shaped 'CFQ…' term searches references only.
  v_text := NOT v_ref_only AND v_term <> '';

  WITH ref_hits AS (
    -- Index range scan on the compact reference, capped. v_ref_low contains only 'CFQ' + hex, so it can hold no wildcard.
    SELECT r.id
      FROM public.service_enquiries r
     WHERE v_ref_low IS NOT NULL
       AND replace(r.public_reference, '-', '') COLLATE "C" >= v_ref_low
       AND replace(r.public_reference, '-', '') COLLATE "C" <  v_ref_low || chr(127)
     LIMIT 200
  ), filtered AS (
    SELECT e.*
      FROM public.service_enquiries e
     WHERE (p_status IS NULL OR cardinality(p_status) = 0 OR e.status = ANY (p_status))
       AND (p_service IS NULL OR cardinality(p_service) = 0 OR e.service_code = ANY (p_service))
       AND (p_country IS NULL OR p_country = '' OR e.country_code = p_country)
       AND (p_from IS NULL OR e.submitted_at >= p_from)
       AND (p_to IS NULL OR e.submitted_at < p_to)
       AND (v_term = ''
            OR (v_ref_low IS NOT NULL AND e.id IN (SELECT h.id FROM ref_hits h))
            -- Substring search without LIKE, so % and _ in the term are ordinary characters.
            OR (v_text AND (position(v_term IN lower(coalesce(e.organization, ''))) > 0
                            OR position(v_term IN e.requester_email) > 0)))
  ), page AS (
    SELECT f.id, f.submitted_at,
           jsonb_build_object(
             'id', f.id, 'public_reference', f.public_reference, 'requester_name', f.requester_name,
             'requester_email', f.requester_email, 'organization', f.organization, 'country_code', f.country_code,
             'service_code', f.service_code, 'source_context', f.source_context, 'subject', f.subject, 'status', f.status,
             'assigned_to_user_id', f.assigned_to_user_id, 'submitted_at', f.submitted_at,
             -- Raw outbox statuses (queued / processing / accepted / delivered / failed / bounced), never a blended "sent".
             'acknowledgement', (SELECT n.status FROM public.service_enquiry_notifications n WHERE n.enquiry_id = f.id AND n.kind = 'requester_acknowledgement'),
             'staff_notification', (SELECT n.status FROM public.service_enquiry_notifications n WHERE n.enquiry_id = f.id AND n.kind = 'staff_notification')
           ) AS row_json
      FROM filtered f
     ORDER BY f.submitted_at DESC, f.id
     LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
           'total', (SELECT count(*) FROM filtered), 'limit', v_limit, 'offset', v_offset,
           'rows', coalesce((SELECT jsonb_agg(p.row_json ORDER BY p.submitted_at DESC, p.id) FROM page p), '[]'::jsonb))
    INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_get_service_enquiry(p_enquiry_id UUID)
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_e public.service_enquiries%ROWTYPE;
BEGIN
  IF public.current_platform_staff_role() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: platform staff only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_e FROM public.service_enquiries WHERE id = p_enquiry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no such enquiry' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'enquiry', jsonb_build_object(
      'id', v_e.id, 'public_reference', v_e.public_reference, 'requester_name', v_e.requester_name,
      'requester_email', v_e.requester_email, 'requester_is_account', v_e.requester_user_id IS NOT NULL, 'organization', v_e.organization,
      'country_code', v_e.country_code, 'service_code', v_e.service_code, 'source_context', v_e.source_context,
      'subject', v_e.subject, 'message', v_e.message, 'payload_schema_version', v_e.payload_schema_version, 'payload', v_e.payload,
      'status', v_e.status, 'assigned_to_user_id', v_e.assigned_to_user_id, 'submitted_at', v_e.submitted_at, 'updated_at', v_e.updated_at),
    'allowed_transitions', coalesce((SELECT jsonb_agg(t.to_status ORDER BY t.to_status) FROM public.service_enquiry_status_transitions t WHERE t.from_status = v_e.status), '[]'::jsonb),
    'events', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', ev.id, 'seq', ev.seq, 'event_kind', ev.event_kind, 'previous_status', ev.previous_status, 'new_status', ev.new_status,
               'actor_kind', ev.actor_kind, 'actor_user_id', ev.actor_user_id, 'actor_email', au.email,
               'assigned_to_user_id', ev.assigned_to_user_id, 'note', ev.note, 'created_at', ev.created_at) ORDER BY ev.seq)
        FROM public.service_enquiry_events ev
        LEFT JOIN auth.users au ON au.id = ev.actor_user_id AND ev.actor_kind = 'staff'
       WHERE ev.enquiry_id = v_e.id), '[]'::jsonb),
    'notifications', coalesce((
      SELECT jsonb_agg(jsonb_build_object('kind', n.kind, 'status', n.status, 'attempt_count', n.attempt_count,
                                          'last_error_code', n.last_error_code, 'accepted_at', n.sent_at) ORDER BY n.kind)
        FROM public.service_enquiry_notifications n WHERE n.enquiry_id = v_e.id), '[]'::jsonb)
  );
END;
$$;
