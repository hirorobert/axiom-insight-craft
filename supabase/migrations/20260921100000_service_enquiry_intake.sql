-- CFOClose Phase 1 — service enquiry & expert intake authority.
--
-- ONE canonical backend for every public and contextual enquiry (contact form, donor/funder expert intake,
-- jurisdiction-gated tax expert intake). Forward-only and additive: nothing existing is altered or dropped.
--
-- Authority model
--   * No client role (anon, authenticated) and not even service_role can write the canonical tables directly.
--     Every write is a SECURITY DEFINER function, and a trigger additionally refuses any direct UPDATE of the
--     workflow columns (status, assignee) that does not arrive through a transition function.
--   * Submission is service_role-only: the browser never inserts. The `submit-service-enquiry` Edge Function is the
--     single public entry point (optional JWT, honeypot, body cap, hashed rate limiting, UUID idempotency key).
--   * "Platform staff" is a NEW, separate authority (`platform_staff_members`). A company owner, company administrator
--     or workspace member is NOT platform staff. Nobody is seeded here: staff are enrolled only by the service-role
--     functions below, by an operator who has verified the person. No email address is ever trusted as a credential.
--   * Status changes go through ONE transactional function that locks the row, validates the transition matrix and
--     appends the event in the same transaction. Event rows are append-only (UPDATE / DELETE / TRUNCATE are refused).
--   * Notifications use a transactional outbox: the enquiry commits first; a failed or unconfigured email leaves a
--     pending outbox row and never loses or rolls back the enquiry.
--
-- THIS MIGRATION IS NOT APPLIED to any database by its author. Apply only through the project's reviewed, managed
-- process, after the disposable-database proof (scripts/db-proof/serviceEnquiries.mjs) passes.

-- ══ 0. pure validators (IMMUTABLE — usable in CHECK constraints) ═════════════════════════════════════════════════════

-- ISO 3166-1 alpha-2, officially assigned codes. Mirrors ISO_REGION_CODES in src/lib/jurisdiction/registry.ts
-- (a test asserts the two lists are identical).
CREATE OR REPLACE FUNCTION public.is_iso_3166_alpha2(p_code TEXT)
  RETURNS BOOLEAN
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
AS $$
  SELECT p_code = ANY (string_to_array(
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW',
    ' '));
$$;

-- Normalised (lower-case, trimmed) single address; deliberately conservative (no quoted local parts, no IP literals).
CREATE OR REPLACE FUNCTION public.enquiry_email_is_valid(p_email TEXT)
  RETURNS BOOLEAN
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
AS $$
  SELECT p_email IS NOT NULL
     AND char_length(p_email) <= 254
     AND p_email = lower(btrim(p_email))
     AND p_email ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
     AND split_part(p_email, '@', 1) !~ '^\.|\.$|\.\.';
$$;

-- Single-line free text: trimmed, bounded, no control characters.
CREATE OR REPLACE FUNCTION public.enquiry_text_ok(p_text TEXT, p_min INTEGER, p_max INTEGER, p_multiline BOOLEAN)
  RETURNS BOOLEAN
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
AS $$
  SELECT p_text IS NOT NULL
     AND p_text = btrim(p_text)
     AND char_length(p_text) BETWEEN p_min AND p_max
     AND CASE WHEN p_multiline THEN regexp_replace(p_text, '[\n\r\t]', '', 'g') !~ '[[:cntrl:]]'
              ELSE p_text !~ '[[:cntrl:]]' END;
$$;

CREATE OR REPLACE FUNCTION public.service_enquiry_status_is_valid(p_status TEXT)
  RETURNS BOOLEAN
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
AS $$
  SELECT p_status = ANY (ARRAY['submitted','triage','awaiting_client','scoping','proposal_sent','accepted','declined','spam','withdrawn','closed']);
$$;

-- Structured, versioned payload: an object of STRING values only, with a per-service key allowlist. Unknown keys are refused.
-- Version 1 collects only what is needed for initial triage — it never infers donor rules, accounting basis or tax law.
CREATE OR REPLACE FUNCTION public.service_enquiry_payload_valid(p_service TEXT, p_version INTEGER, p_payload JSONB)
  RETURNS BOOLEAN
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_allowed TEXT[];
  v_key     TEXT;
  v_val     JSONB;
  v_text    TEXT;
BEGIN
  IF p_version IS DISTINCT FROM 1 THEN RETURN false; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN RETURN false; END IF;
  IF octet_length(p_payload::text) > 6000 THEN RETURN false; END IF;

  v_allowed := CASE p_service
    WHEN 'donor_reporting'       THEN ARRAY['report_type','donor_name','project_name','reporting_period','reporting_frequency','currency','deadline','additional_context']
    WHEN 'tax_tanzania_preview'  THEN ARRAY['jurisdiction_source','tax_period']
    WHEN 'tax_general'           THEN ARRAY['jurisdiction_source','tax_period']
    ELSE ARRAY[]::TEXT[]
  END;

  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(p_payload) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN RETURN false; END IF;
    IF jsonb_typeof(v_val) <> 'string' THEN RETURN false; END IF;
    v_text := v_val #>> '{}';
    IF v_key = 'report_type' THEN
      IF NOT (v_text = ANY (ARRAY['expenditure_report','budget_vs_actual','fund_accountability','grant_financial_statement','management_report','other'])) THEN RETURN false; END IF;
    ELSIF v_key = 'reporting_frequency' THEN
      IF NOT (v_text = ANY (ARRAY['monthly','quarterly','semi_annual','annual','one_off','other'])) THEN RETURN false; END IF;
    ELSIF v_key = 'currency' THEN
      IF v_text !~ '^[A-Z]{3}$' THEN RETURN false; END IF;
    ELSIF v_key = 'deadline' THEN
      IF v_text !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' THEN RETURN false; END IF;
    ELSIF v_key = 'jurisdiction_source' THEN
      IF NOT (v_text = ANY (ARRAY['user_selected','company_setting_confirmed'])) THEN RETURN false; END IF;
    ELSIF v_key = 'additional_context' THEN
      IF NOT public.enquiry_text_ok(v_text, 1, 2000, true) THEN RETURN false; END IF;
    ELSIF v_key IN ('donor_name','project_name') THEN
      IF NOT public.enquiry_text_ok(v_text, 1, 160, false) THEN RETURN false; END IF;
    ELSE  -- reporting_period, tax_period
      IF NOT public.enquiry_text_ok(v_text, 1, 80, false) THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- Non-guessable, non-sequential public reference: 48 random bits, e.g. CFQ-9F2A-71C0-3BDE. Never a database id or a counter.
CREATE OR REPLACE FUNCTION public.generate_service_enquiry_reference()
  RETURNS TEXT
  LANGUAGE sql
  VOLATILE
  SET search_path = pg_catalog, public
AS $$
  SELECT 'CFQ-' || upper(substr(h, 1, 4)) || '-' || upper(substr(h, 5, 4)) || '-' || upper(substr(h, 9, 4))
    FROM (SELECT replace(gen_random_uuid()::text, '-', '') AS h) s;
$$;

-- ══ 1. platform staff authority ══════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.platform_staff_members (
  user_id            UUID        NOT NULL,
  staff_role         TEXT        NOT NULL,
  is_active          BOOLEAN     NOT NULL DEFAULT true,
  granted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by_label   TEXT        NOT NULL,
  revoked_at         TIMESTAMPTZ NULL,
  revoked_reason     TEXT        NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_staff_members_pk PRIMARY KEY (user_id),
  CONSTRAINT fk_platform_staff_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT chk_platform_staff_role CHECK (staff_role IN ('triage_agent', 'manager')),
  CONSTRAINT chk_platform_staff_active_state CHECK (is_active = (revoked_at IS NULL)),
  CONSTRAINT chk_platform_staff_label CHECK (char_length(btrim(granted_by_label)) >= 2),
  CONSTRAINT chk_platform_staff_revoked_reason CHECK (revoked_at IS NULL OR char_length(btrim(coalesce(revoked_reason, ''))) >= 8)
);

-- Append-only record of every enrolment and revocation. No FK: history outlives the account.
CREATE TABLE public.platform_staff_audit (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  seq             BIGINT      GENERATED ALWAYS AS IDENTITY,
  user_id         UUID        NOT NULL,
  action          TEXT        NOT NULL,
  previous_role   TEXT        NULL,
  new_role        TEXT        NULL,
  reason          TEXT        NOT NULL,
  operator_label  TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_staff_audit_pk PRIMARY KEY (id),
  CONSTRAINT chk_platform_staff_audit_action CHECK (action IN ('GRANT', 'ROLE_CHANGE', 'REVOKE')),
  CONSTRAINT chk_platform_staff_audit_reason CHECK (char_length(btrim(reason)) >= 8),
  CONSTRAINT chk_platform_staff_audit_operator CHECK (char_length(btrim(operator_label)) >= 2)
);

-- ══ 2. canonical enquiry ═════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.service_enquiries (
  id                     UUID        NOT NULL DEFAULT gen_random_uuid(),
  public_reference       TEXT        NOT NULL DEFAULT public.generate_service_enquiry_reference(),
  requester_user_id      UUID        NULL,
  requester_name         TEXT        NOT NULL,
  requester_email        TEXT        NOT NULL,
  organization           TEXT        NULL,
  country_code           TEXT        NULL,
  service_code           TEXT        NOT NULL,
  source_context         TEXT        NOT NULL,
  subject                TEXT        NOT NULL,
  message                TEXT        NOT NULL,
  payload_schema_version INTEGER     NOT NULL DEFAULT 1,
  payload                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status                 TEXT        NOT NULL DEFAULT 'submitted',
  assigned_to_user_id    UUID        NULL,
  idempotency_key        UUID        NOT NULL,
  request_fingerprint    TEXT        NOT NULL,
  submitted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_enquiries_pk PRIMARY KEY (id),
  CONSTRAINT uq_service_enquiries_reference UNIQUE (public_reference),
  CONSTRAINT uq_service_enquiries_idempotency UNIQUE (idempotency_key),
  CONSTRAINT fk_service_enquiries_requester FOREIGN KEY (requester_user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT fk_service_enquiries_assignee FOREIGN KEY (assigned_to_user_id) REFERENCES public.platform_staff_members(user_id) ON DELETE SET NULL,
  CONSTRAINT chk_service_enquiries_reference CHECK (public_reference ~ '^CFQ-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$'),
  CONSTRAINT chk_service_enquiries_name CHECK (public.enquiry_text_ok(requester_name, 1, 120, false)),
  CONSTRAINT chk_service_enquiries_email CHECK (public.enquiry_email_is_valid(requester_email)),
  CONSTRAINT chk_service_enquiries_organization CHECK (organization IS NULL OR public.enquiry_text_ok(organization, 1, 160, false)),
  CONSTRAINT chk_service_enquiries_country CHECK (country_code IS NULL OR public.is_iso_3166_alpha2(country_code)),
  CONSTRAINT chk_service_enquiries_service CHECK (service_code IN ('general', 'support', 'donor_reporting', 'tax_tanzania_preview', 'tax_general')),
  CONSTRAINT chk_service_enquiries_source CHECK (source_context IN ('contact_page', 'site_header', 'site_footer', 'help_support', 'workflow_donor', 'workflow_tax')),
  CONSTRAINT chk_service_enquiries_subject CHECK (public.enquiry_text_ok(subject, 3, 150, false)),
  CONSTRAINT chk_service_enquiries_message CHECK (public.enquiry_text_ok(message, 10, 4000, true)),
  CONSTRAINT chk_service_enquiries_payload CHECK (public.service_enquiry_payload_valid(service_code, payload_schema_version, payload)),
  CONSTRAINT chk_service_enquiries_status CHECK (public.service_enquiry_status_is_valid(status)),
  CONSTRAINT chk_service_enquiries_fingerprint CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  -- A tax enquiry always states its jurisdiction; the private-preview code is reachable only for the preview jurisdiction,
  -- and the general tax code only for every other one — routing can never be mismatched.
  -- Every branch is written to yield TRUE or FALSE, never NULL: a NULL country would otherwise satisfy a CHECK by accident.
  CONSTRAINT chk_service_enquiries_tax_jurisdiction CHECK (
    (service_code = 'tax_tanzania_preview' AND country_code IS NOT NULL AND country_code = 'TZ')
    OR (service_code = 'tax_general' AND country_code IS NOT NULL AND country_code <> 'TZ')
    OR service_code NOT IN ('tax_tanzania_preview', 'tax_general')
  )
);

CREATE INDEX idx_service_enquiries_queue ON public.service_enquiries (status, submitted_at DESC);
CREATE INDEX idx_service_enquiries_service ON public.service_enquiries (service_code, submitted_at DESC);
CREATE INDEX idx_service_enquiries_assignee ON public.service_enquiries (assigned_to_user_id) WHERE assigned_to_user_id IS NOT NULL;
CREATE INDEX idx_service_enquiries_email ON public.service_enquiries (requester_email);

-- ══ 3. append-only event history ═════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.service_enquiry_events (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  seq                 BIGINT      GENERATED ALWAYS AS IDENTITY,
  enquiry_id          UUID        NOT NULL,
  event_kind          TEXT        NOT NULL,
  previous_status     TEXT        NULL,
  new_status          TEXT        NOT NULL,
  actor_kind          TEXT        NOT NULL,
  actor_user_id       UUID        NULL,
  assigned_to_user_id UUID        NULL,
  note                TEXT        NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_enquiry_events_pk PRIMARY KEY (id),
  CONSTRAINT fk_service_enquiry_events_enquiry FOREIGN KEY (enquiry_id) REFERENCES public.service_enquiries(id) ON DELETE RESTRICT,
  CONSTRAINT chk_service_enquiry_events_kind CHECK (event_kind IN ('submitted', 'status_change', 'assignment', 'note')),
  CONSTRAINT chk_service_enquiry_events_actor_kind CHECK (actor_kind IN ('requester', 'system', 'staff')),
  CONSTRAINT chk_service_enquiry_events_statuses CHECK (public.service_enquiry_status_is_valid(new_status) AND (previous_status IS NULL OR public.service_enquiry_status_is_valid(previous_status))),
  CONSTRAINT chk_service_enquiry_events_note CHECK (note IS NULL OR public.enquiry_text_ok(note, 1, 2000, true)),
  CONSTRAINT chk_service_enquiry_events_staff_actor CHECK (actor_kind <> 'staff' OR actor_user_id IS NOT NULL),
  CONSTRAINT chk_service_enquiry_events_shape CHECK (
    (event_kind = 'submitted'     AND previous_status IS NULL AND new_status = 'submitted' AND actor_kind IN ('requester', 'system'))
    OR (event_kind = 'status_change' AND previous_status IS NOT NULL AND previous_status <> new_status AND actor_kind = 'staff')
    OR (event_kind IN ('assignment', 'note') AND previous_status IS NOT NULL AND previous_status = new_status AND actor_kind = 'staff')
  ),
  CONSTRAINT chk_service_enquiry_events_note_required CHECK (event_kind <> 'note' OR note IS NOT NULL)
);

CREATE INDEX idx_service_enquiry_events_enquiry ON public.service_enquiry_events (enquiry_id, seq);

-- The permitted status graph, as data. Changing it requires a new migration.
CREATE TABLE public.service_enquiry_status_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  CONSTRAINT service_enquiry_status_transitions_pk PRIMARY KEY (from_status, to_status),
  CONSTRAINT chk_service_enquiry_transition_from CHECK (public.service_enquiry_status_is_valid(from_status)),
  CONSTRAINT chk_service_enquiry_transition_to CHECK (public.service_enquiry_status_is_valid(to_status) AND to_status <> 'submitted' AND to_status <> from_status)
);

INSERT INTO public.service_enquiry_status_transitions (from_status, to_status) VALUES
  ('submitted',       'triage'),
  ('submitted',       'spam'),
  ('submitted',       'withdrawn'),
  ('triage',          'awaiting_client'),
  ('triage',          'scoping'),
  ('triage',          'declined'),
  ('triage',          'spam'),
  ('awaiting_client', 'triage'),
  ('awaiting_client', 'scoping'),
  ('awaiting_client', 'withdrawn'),
  ('scoping',         'awaiting_client'),
  ('scoping',         'proposal_sent'),
  ('scoping',         'declined'),
  ('proposal_sent',   'accepted'),
  ('proposal_sent',   'declined'),
  ('proposal_sent',   'withdrawn'),
  ('accepted',        'closed'),
  ('declined',        'closed');
  -- spam, withdrawn and closed are terminal: no row has them as from_status.

-- ══ 4. notification outbox and rate limiting ═════════════════════════════════════════════════════════════════════════

CREATE TABLE public.service_enquiry_notifications (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  enquiry_id          UUID        NOT NULL,
  kind                TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'pending',
  attempt_count       INTEGER     NOT NULL DEFAULT 0,
  last_attempt_at     TIMESTAMPTZ NULL,
  last_error_code     TEXT        NULL,
  provider_message_id TEXT        NULL,
  sent_at             TIMESTAMPTZ NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_enquiry_notifications_pk PRIMARY KEY (id),
  CONSTRAINT uq_service_enquiry_notification_kind UNIQUE (enquiry_id, kind),
  CONSTRAINT fk_service_enquiry_notifications_enquiry FOREIGN KEY (enquiry_id) REFERENCES public.service_enquiries(id) ON DELETE RESTRICT,
  CONSTRAINT chk_service_enquiry_notification_kind CHECK (kind IN ('requester_acknowledgement', 'staff_notification')),
  CONSTRAINT chk_service_enquiry_notification_status CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT chk_service_enquiry_notification_attempts CHECK (attempt_count >= 0),
  -- A machine code only: provider error text (which may echo an address) is never stored.
  CONSTRAINT chk_service_enquiry_notification_error CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  CONSTRAINT chk_service_enquiry_notification_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

CREATE INDEX idx_service_enquiry_notifications_pending ON public.service_enquiry_notifications (created_at) WHERE status = 'pending';

-- Fixed-window counters keyed by a keyed HASH of the client identity (the Edge Function never sends a raw IP or address).
CREATE TABLE public.service_enquiry_rate_limits (
  bucket        TEXT        NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  hits          INTEGER     NOT NULL DEFAULT 0,
  CONSTRAINT service_enquiry_rate_limits_pk PRIMARY KEY (bucket, window_start),
  CONSTRAINT chk_service_enquiry_rate_bucket CHECK (bucket ~ '^(ip|email):[0-9a-f]{16,64}/[0-9]{2,5}$|^global:all/[0-9]{2,5}$'),
  CONSTRAINT chk_service_enquiry_rate_hits CHECK (hits >= 0)
);

-- ══ 5. immutability and write-path guards ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.service_enquiry_append_only_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: % is append-only (% is not permitted)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_service_enquiry_events_append_only
  BEFORE UPDATE OR DELETE ON public.service_enquiry_events
  FOR EACH ROW EXECUTE FUNCTION public.service_enquiry_append_only_guard();
CREATE TRIGGER trg_service_enquiry_events_no_truncate
  BEFORE TRUNCATE ON public.service_enquiry_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_enquiry_append_only_guard();

CREATE TRIGGER trg_platform_staff_audit_append_only
  BEFORE UPDATE OR DELETE ON public.platform_staff_audit
  FOR EACH ROW EXECUTE FUNCTION public.service_enquiry_append_only_guard();
CREATE TRIGGER trg_platform_staff_audit_no_truncate
  BEFORE TRUNCATE ON public.platform_staff_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_enquiry_append_only_guard();

CREATE TRIGGER trg_service_enquiry_transitions_immutable
  BEFORE UPDATE OR DELETE ON public.service_enquiry_status_transitions
  FOR EACH ROW EXECUTE FUNCTION public.service_enquiry_append_only_guard();
CREATE TRIGGER trg_service_enquiry_transitions_no_truncate
  BEFORE TRUNCATE ON public.service_enquiry_status_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.service_enquiry_append_only_guard();

-- An enquiry's submitted content is immutable for its whole life; only status and assignee may change, and only inside a
-- transition / assignment function (which sets the transaction-local flag). A direct UPDATE of either — by any role,
-- including service_role — is refused. Deleting an enquiry is refused (its history is retained).
CREATE OR REPLACE FUNCTION public.service_enquiries_write_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Iron Dome: service_enquiries rows cannot be deleted' USING ERRCODE = 'P0001';
  END IF;

  IF (NEW.id, NEW.public_reference, NEW.requester_name, NEW.requester_email, NEW.organization, NEW.country_code,
      NEW.service_code, NEW.source_context, NEW.subject, NEW.message, NEW.payload_schema_version, NEW.payload,
      NEW.idempotency_key, NEW.request_fingerprint, NEW.submitted_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.public_reference, OLD.requester_name, OLD.requester_email, OLD.organization, OLD.country_code,
      OLD.service_code, OLD.source_context, OLD.subject, OLD.message, OLD.payload_schema_version, OLD.payload,
      OLD.idempotency_key, OLD.request_fingerprint, OLD.submitted_at, OLD.created_at) THEN
    RAISE EXCEPTION 'Iron Dome: the submitted content of an enquiry is immutable' USING ERRCODE = 'P0001';
  END IF;

  -- Erasure of the requesting account (FK ON DELETE SET NULL) may clear the link; nothing may set or change it.
  IF NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id AND NEW.requester_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Iron Dome: the requester link is immutable' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR (NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id AND NEW.assigned_to_user_id IS NOT NULL) THEN
    IF coalesce(current_setting('app.service_enquiry_write_path', true), '') <> 'rpc' THEN
      RAISE EXCEPTION 'Iron Dome: status and assignment change only through the staff transition functions' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_service_enquiries_write_guard
  BEFORE UPDATE OR DELETE ON public.service_enquiries
  FOR EACH ROW EXECUTE FUNCTION public.service_enquiries_write_guard();

-- ══ 6. row-level security and table privileges ═══════════════════════════════════════════════════════════════════════
-- RLS is enabled with NO policies: no client role can read or write a row. Access is exclusively through the functions
-- below (owner-executed). Privileges are revoked explicitly because a Supabase project's default privileges grant new
-- public tables to anon / authenticated / service_role.

ALTER TABLE public.platform_staff_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_staff_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_enquiry_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_enquiry_status_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_enquiry_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_enquiry_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.platform_staff_members FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.platform_staff_audit FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.service_enquiries FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.service_enquiry_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.service_enquiry_status_transitions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.service_enquiry_notifications FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.service_enquiry_rate_limits FROM PUBLIC, anon, authenticated, service_role;

-- Read-only for operators/diagnostics. service_role has NO write privilege on any canonical table.
GRANT SELECT ON public.platform_staff_members TO service_role;
GRANT SELECT ON public.platform_staff_audit TO service_role;
GRANT SELECT ON public.service_enquiries TO service_role;
GRANT SELECT ON public.service_enquiry_events TO service_role;
GRANT SELECT ON public.service_enquiry_status_transitions TO service_role;
GRANT SELECT ON public.service_enquiry_notifications TO service_role;

-- ══ 7. platform staff functions ══════════════════════════════════════════════════════════════════════════════════════

-- The caller's own staff role, or NULL. Reveals nothing about anyone else.
CREATE OR REPLACE FUNCTION public.current_platform_staff_role()
  RETURNS TEXT
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT m.staff_role FROM public.platform_staff_members m WHERE m.user_id = auth.uid() AND m.is_active;
$$;

-- Enrolment is an operator action (service_role only): the operator has independently verified the person, and the
-- account must already exist. Nothing here trusts, guesses or derives staff status from an email address.
CREATE OR REPLACE FUNCTION public.platform_staff_grant(
  p_user_id        UUID,
  p_staff_role     TEXT,
  p_reason         TEXT,
  p_operator_label TEXT
)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_previous TEXT;
  v_was_active BOOLEAN;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: platform staff enrolment requires the service role' USING ERRCODE = '42501';
  END IF;
  IF p_staff_role IS NULL OR p_staff_role NOT IN ('triage_agent', 'manager') THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: unknown staff role' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: no such account' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('platform_staff:' || p_user_id::text, 0));
  SELECT m.staff_role, m.is_active INTO v_previous, v_was_active FROM public.platform_staff_members m WHERE m.user_id = p_user_id;

  INSERT INTO public.platform_staff_members (user_id, staff_role, is_active, granted_at, granted_by_label, revoked_at, revoked_reason, updated_at)
       VALUES (p_user_id, p_staff_role, true, now(), p_operator_label, NULL, NULL, now())
  ON CONFLICT (user_id) DO UPDATE
     SET staff_role = EXCLUDED.staff_role, is_active = true, granted_at = now(), granted_by_label = EXCLUDED.granted_by_label,
         revoked_at = NULL, revoked_reason = NULL, updated_at = now();

  INSERT INTO public.platform_staff_audit (user_id, action, previous_role, new_role, reason, operator_label)
       VALUES (p_user_id,
               CASE WHEN v_previous IS NULL THEN 'GRANT' WHEN v_was_active THEN 'ROLE_CHANGE' ELSE 'GRANT' END,
               CASE WHEN v_was_active THEN v_previous ELSE NULL END, p_staff_role, p_reason, p_operator_label);

  RETURN jsonb_build_object('user_id', p_user_id, 'staff_role', p_staff_role, 'is_active', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_staff_revoke(
  p_user_id        UUID,
  p_reason         TEXT,
  p_operator_label TEXT
)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role TEXT;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: platform staff revocation requires the service role' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('platform_staff:' || p_user_id::text, 0));
  SELECT m.staff_role INTO v_role FROM public.platform_staff_members m WHERE m.user_id = p_user_id AND m.is_active;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: no active staff member' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.platform_staff_members SET is_active = false, revoked_at = now(), revoked_reason = p_reason, updated_at = now() WHERE user_id = p_user_id;
  INSERT INTO public.platform_staff_audit (user_id, action, previous_role, new_role, reason, operator_label)
       VALUES (p_user_id, 'REVOKE', v_role, NULL, p_reason, p_operator_label);

  RETURN jsonb_build_object('user_id', p_user_id, 'is_active', false);
END;
$$;

-- Staff directory for the assignment control: active staff only, visible to active staff only.
CREATE OR REPLACE FUNCTION public.staff_list_platform_staff()
  RETURNS JSONB
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.current_platform_staff_role() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: platform staff only' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('user_id', m.user_id, 'staff_role', m.staff_role, 'email', u.email) ORDER BY u.email, m.user_id)
      FROM public.platform_staff_members m
      LEFT JOIN auth.users u ON u.id = m.user_id
     WHERE m.is_active
  ), '[]'::jsonb);
END;
$$;

-- ══ 8. submission (service_role only; called by the Edge Function) ═══════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.service_enquiry_ack_state(p_enquiry_id UUID)
  RETURNS TEXT
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE n.status WHEN 'sent' THEN 'sent' WHEN 'failed' THEN 'unavailable' ELSE 'pending' END
    FROM public.service_enquiry_notifications n
   WHERE n.enquiry_id = p_enquiry_id AND n.kind = 'requester_acknowledgement';
$$;

-- Atomically: idempotency check → rate limit → enquiry → 'submitted' event → both outbox rows. The request has already
-- been validated and normalised by the Edge Function; every rule is re-checked here (constraints + validators).
-- Outcomes are returned, not raised, where the caller needs the side effect to persist (rate counters) or must not
-- retry blindly (idempotency conflict).
CREATE OR REPLACE FUNCTION public.submit_service_enquiry(p_request JSONB)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_key          UUID;
  v_fingerprint  TEXT;
  v_user         UUID;
  v_existing     public.service_enquiries%ROWTYPE;
  v_bucket       JSONB;
  v_window_secs  INTEGER;
  v_limit        INTEGER;
  v_window_start TIMESTAMPTZ;
  v_hits         INTEGER;
  v_retry        INTEGER := 0;
  v_limited      BOOLEAN := false;
  v_id           UUID;
  v_reference    TEXT;
  v_attempt      INTEGER := 0;
  v_ack_id       UUID;
  v_staff_id     UUID;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: enquiry submission requires the service role' USING ERRCODE = '42501';
  END IF;
  IF p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: request must be an object' USING ERRCODE = '22023';
  END IF;

  v_key := (p_request ->> 'idempotency_key')::uuid;
  v_fingerprint := p_request ->> 'request_fingerprint';
  IF v_key IS NULL OR v_fingerprint IS NULL OR v_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: idempotency key and fingerprint are required' USING ERRCODE = '22023';
  END IF;
  v_user := nullif(p_request ->> 'requester_user_id', '')::uuid;

  -- Serialise every attempt that carries the same key, so a double click can never create two rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('service_enquiry:' || v_key::text, 0));

  SELECT * INTO v_existing FROM public.service_enquiries WHERE idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint <> v_fingerprint THEN
      RETURN jsonb_build_object('outcome', 'idempotency_conflict');
    END IF;
    RETURN jsonb_build_object('outcome', 'replayed', 'reference', v_existing.public_reference, 'submitted_at', v_existing.submitted_at,
                              'status', v_existing.status, 'acknowledgement', coalesce(public.service_enquiry_ack_state(v_existing.id), 'pending'),
                              'enquiry_id', v_existing.id);
  END IF;

  -- Rate limiting (fixed windows, keyed hashes only). Counters commit even when the request is refused.
  FOR v_bucket IN SELECT value FROM jsonb_array_elements(coalesce(p_request -> 'rate', '[]'::jsonb)) LOOP
    v_window_secs := (v_bucket ->> 'window_seconds')::integer;
    v_limit := (v_bucket ->> 'limit')::integer;
    IF v_window_secs IS NULL OR v_window_secs NOT BETWEEN 60 AND 86400 OR v_limit IS NULL OR v_limit NOT BETWEEN 1 AND 100000 THEN
      RAISE EXCEPTION 'INVALID_ARGUMENT: malformed rate bucket' USING ERRCODE = '22023';
    END IF;
    v_window_start := to_timestamp(floor(extract(epoch FROM now()) / v_window_secs) * v_window_secs);
    INSERT INTO public.service_enquiry_rate_limits AS r (bucket, window_start, hits)
         VALUES ((v_bucket ->> 'bucket') || '/' || v_window_secs::text, v_window_start, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET hits = r.hits + 1
      RETURNING r.hits INTO v_hits;
    IF v_hits > v_limit THEN
      v_limited := true;
      v_retry := greatest(v_retry, ceil(extract(epoch FROM (v_window_start + make_interval(secs => v_window_secs) - now())))::integer);
    END IF;
  END LOOP;
  DELETE FROM public.service_enquiry_rate_limits WHERE window_start < now() - interval '2 days';
  IF v_limited THEN
    RETURN jsonb_build_object('outcome', 'rate_limited', 'retry_after_seconds', greatest(v_retry, 1));
  END IF;

  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      INSERT INTO public.service_enquiries (
        requester_user_id, requester_name, requester_email, organization, country_code, service_code, source_context,
        subject, message, payload_schema_version, payload, idempotency_key, request_fingerprint)
      VALUES (
        v_user, p_request ->> 'requester_name', p_request ->> 'requester_email', nullif(p_request ->> 'organization', ''),
        nullif(p_request ->> 'country_code', ''), p_request ->> 'service_code', p_request ->> 'source_context',
        p_request ->> 'subject', p_request ->> 'message', coalesce((p_request ->> 'payload_schema_version')::integer, 1),
        coalesce(p_request -> 'payload', '{}'::jsonb), v_key, v_fingerprint)
      RETURNING id, public_reference INTO v_id, v_reference;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- A reference collision (48 random bits) is retried; anything else (the idempotency key) cannot happen under the lock.
      IF v_attempt >= 5 THEN RAISE; END IF;
    END;
  END LOOP;

  INSERT INTO public.service_enquiry_events (enquiry_id, event_kind, previous_status, new_status, actor_kind, actor_user_id)
       VALUES (v_id, 'submitted', NULL, 'submitted', CASE WHEN v_user IS NULL THEN 'system' ELSE 'requester' END, v_user);

  INSERT INTO public.service_enquiry_notifications (enquiry_id, kind) VALUES (v_id, 'requester_acknowledgement') RETURNING id INTO v_ack_id;
  INSERT INTO public.service_enquiry_notifications (enquiry_id, kind) VALUES (v_id, 'staff_notification') RETURNING id INTO v_staff_id;

  -- `enquiry_id` and `notification_ids` are for the calling Edge Function only; it never returns them to a browser.
  RETURN jsonb_build_object('outcome', 'created', 'reference', v_reference, 'submitted_at', (SELECT submitted_at FROM public.service_enquiries WHERE id = v_id),
                            'status', 'submitted', 'acknowledgement', 'pending', 'enquiry_id', v_id,
                            'notification_ids', jsonb_build_object('requester_acknowledgement', v_ack_id, 'staff_notification', v_staff_id));
END;
$$;

-- ══ 9. notification outbox (service_role only) ═══════════════════════════════════════════════════════════════════════

-- Claims due rows (optionally for one enquiry) and returns only what a message needs: never the enquiry's free text.
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

  WITH due AS (
    SELECT n.id
      FROM public.service_enquiry_notifications n
     WHERE n.status = 'pending'
       AND n.attempt_count < 5
       AND (n.last_attempt_at IS NULL OR n.last_attempt_at < now() - interval '5 minutes')
       AND (p_enquiry_id IS NULL OR n.enquiry_id = p_enquiry_id)
     ORDER BY n.created_at
     LIMIT greatest(1, least(coalesce(p_limit, 10), 50))
       FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.service_enquiry_notifications n
       SET attempt_count = n.attempt_count + 1, last_attempt_at = now(), updated_at = now()
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

-- outcome: 'sent' | 'retry' (transient failure, will be retried) | 'failed' (permanent) | 'blocked' (delivery not configured;
-- the row stays pending and no attempt is charged).
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
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'retry', 'failed', 'blocked') THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: unknown outcome' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.service_enquiry_notifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no such notification' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('status', v_row.status, 'changed', false);   -- terminal rows never move again
  END IF;

  IF p_outcome = 'sent' THEN
    UPDATE public.service_enquiry_notifications
       SET status = 'sent', sent_at = now(), provider_message_id = left(p_provider_message_id, 200), last_error_code = NULL, updated_at = now()
     WHERE id = p_id;
  ELSIF p_outcome = 'failed' OR (p_outcome = 'retry' AND v_row.attempt_count >= 5) THEN
    UPDATE public.service_enquiry_notifications
       SET status = 'failed', last_error_code = coalesce(p_error_code, 'DELIVERY_FAILED'), updated_at = now()
     WHERE id = p_id;
  ELSE  -- retry / blocked: stay pending
    UPDATE public.service_enquiry_notifications
       SET last_error_code = coalesce(p_error_code, CASE p_outcome WHEN 'blocked' THEN 'EMAIL_NOT_CONFIGURED' ELSE 'DELIVERY_RETRY' END),
           attempt_count = CASE WHEN p_outcome = 'blocked' THEN greatest(attempt_count - 1, 0) ELSE attempt_count END,
           updated_at = now()
     WHERE id = p_id;
  END IF;

  RETURN jsonb_build_object('status', (SELECT status FROM public.service_enquiry_notifications WHERE id = p_id), 'changed', true);
END;
$$;

-- ══ 10. staff queue (authenticated callers; every function verifies ACTIVE platform staff itself) ════════════════════

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
  v_search TEXT := lower(btrim(coalesce(p_search, '')));
  v_limit  INTEGER := greatest(1, least(coalesce(p_limit, 25), 100));
  v_offset INTEGER := greatest(0, coalesce(p_offset, 0));
  v_result JSONB;
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

  WITH filtered AS (
    SELECT e.*
      FROM public.service_enquiries e
     WHERE (p_status IS NULL OR cardinality(p_status) = 0 OR e.status = ANY (p_status))
       AND (p_service IS NULL OR cardinality(p_service) = 0 OR e.service_code = ANY (p_service))
       AND (p_country IS NULL OR p_country = '' OR e.country_code = p_country)
       AND (p_from IS NULL OR e.submitted_at >= p_from)
       AND (p_to IS NULL OR e.submitted_at < p_to)
       -- Substring search without LIKE, so % and _ in the term are ordinary characters.
       AND (v_search = ''
            OR upper(e.public_reference) = upper(v_search)
            OR position(v_search IN lower(coalesce(e.organization, ''))) > 0
            OR position(v_search IN e.requester_email) > 0)
  ), page AS (
    SELECT f.id, f.submitted_at,
           jsonb_build_object(
             'id', f.id, 'public_reference', f.public_reference, 'requester_name', f.requester_name,
             'requester_email', f.requester_email, 'organization', f.organization, 'country_code', f.country_code,
             'service_code', f.service_code, 'source_context', f.source_context, 'subject', f.subject, 'status', f.status,
             'assigned_to_user_id', f.assigned_to_user_id, 'submitted_at', f.submitted_at,
             'acknowledgement', coalesce(public.service_enquiry_ack_state(f.id), 'pending'),
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
                                          'last_error_code', n.last_error_code, 'sent_at', n.sent_at) ORDER BY n.kind)
        FROM public.service_enquiry_notifications n WHERE n.enquiry_id = v_e.id), '[]'::jsonb)
  );
END;
$$;

-- The ONLY way a status changes. Locks the row, validates the matrix against the row's CURRENT status, updates it and appends
-- the event in the same transaction. `p_expected_status` lets a screen refuse to act on a stale view.
CREATE OR REPLACE FUNCTION public.staff_transition_service_enquiry(
  p_enquiry_id      UUID,
  p_to_status       TEXT,
  p_note            TEXT DEFAULT NULL,
  p_expected_status TEXT DEFAULT NULL
)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_e    public.service_enquiries%ROWTYPE;
  v_note TEXT := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF public.current_platform_staff_role() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: platform staff only' USING ERRCODE = '42501';
  END IF;
  IF p_to_status IS NULL OR NOT public.service_enquiry_status_is_valid(p_to_status) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: unknown status' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND NOT public.enquiry_text_ok(v_note, 1, 2000, true) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: note must be 1-2000 characters without control characters' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_e FROM public.service_enquiries WHERE id = p_enquiry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no such enquiry' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_status IS NOT NULL AND p_expected_status <> v_e.status THEN
    RAISE EXCEPTION 'STATUS_CHANGED: the enquiry is now %', v_e.status USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_enquiry_status_transitions t WHERE t.from_status = v_e.status AND t.to_status = p_to_status) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: % to % is not permitted', v_e.status, p_to_status USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('app.service_enquiry_write_path', 'rpc', true);
  UPDATE public.service_enquiries SET status = p_to_status WHERE id = v_e.id;
  INSERT INTO public.service_enquiry_events (enquiry_id, event_kind, previous_status, new_status, actor_kind, actor_user_id, note)
       VALUES (v_e.id, 'status_change', v_e.status, p_to_status, 'staff', v_uid, v_note);
  PERFORM set_config('app.service_enquiry_write_path', '', true);

  RETURN jsonb_build_object('id', v_e.id, 'previous_status', v_e.status, 'status', p_to_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_assign_service_enquiry(
  p_enquiry_id UUID,
  p_assignee   UUID,
  p_note       TEXT DEFAULT NULL
)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_e    public.service_enquiries%ROWTYPE;
  v_note TEXT := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF public.current_platform_staff_role() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: platform staff only' USING ERRCODE = '42501';
  END IF;
  IF v_note IS NOT NULL AND NOT public.enquiry_text_ok(v_note, 1, 2000, true) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: note must be 1-2000 characters without control characters' USING ERRCODE = '22023';
  END IF;
  IF p_assignee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.platform_staff_members m WHERE m.user_id = p_assignee AND m.is_active) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: the assignee is not active platform staff' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_e FROM public.service_enquiries WHERE id = p_enquiry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no such enquiry' USING ERRCODE = 'P0002';
  END IF;
  IF v_e.assigned_to_user_id IS NOT DISTINCT FROM p_assignee THEN
    RETURN jsonb_build_object('id', v_e.id, 'assigned_to_user_id', v_e.assigned_to_user_id, 'changed', false);
  END IF;

  PERFORM set_config('app.service_enquiry_write_path', 'rpc', true);
  UPDATE public.service_enquiries SET assigned_to_user_id = p_assignee WHERE id = v_e.id;
  INSERT INTO public.service_enquiry_events (enquiry_id, event_kind, previous_status, new_status, actor_kind, actor_user_id, assigned_to_user_id, note)
       VALUES (v_e.id, 'assignment', v_e.status, v_e.status, 'staff', v_uid, p_assignee, v_note);
  PERFORM set_config('app.service_enquiry_write_path', '', true);

  RETURN jsonb_build_object('id', v_e.id, 'assigned_to_user_id', p_assignee, 'changed', true);
END;
$$;

-- Internal notes are append-only events; they are visible only through staff_get_service_enquiry.
CREATE OR REPLACE FUNCTION public.staff_add_service_enquiry_note(p_enquiry_id UUID, p_note TEXT)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_e    public.service_enquiries%ROWTYPE;
  v_note TEXT := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF public.current_platform_staff_role() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: platform staff only' USING ERRCODE = '42501';
  END IF;
  IF v_note IS NULL OR NOT public.enquiry_text_ok(v_note, 1, 2000, true) THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: note must be 1-2000 characters without control characters' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_e FROM public.service_enquiries WHERE id = p_enquiry_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no such enquiry' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.service_enquiry_events (enquiry_id, event_kind, previous_status, new_status, actor_kind, actor_user_id, note)
       VALUES (v_e.id, 'note', v_e.status, v_e.status, 'staff', v_uid, v_note);
  RETURN jsonb_build_object('id', v_e.id, 'status', v_e.status);
END;
$$;

-- ══ 11. function privileges ══════════════════════════════════════════════════════════════════════════════════════════
-- Postgres grants EXECUTE to PUBLIC by default, and Supabase's default privileges grant it to anon / authenticated:
-- revoke everything first, then grant exactly what each caller class needs.

REVOKE ALL ON FUNCTION public.is_iso_3166_alpha2(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enquiry_email_is_valid(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enquiry_text_ok(TEXT, INTEGER, INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_enquiry_status_is_valid(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_enquiry_payload_valid(TEXT, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_service_enquiry_reference() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_enquiry_append_only_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_enquiries_write_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.service_enquiry_ack_state(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.current_platform_staff_role() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_staff_grant(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_staff_revoke(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_service_enquiry(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enquiry_notification_claim(INTEGER, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enquiry_notification_complete(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_list_platform_staff() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_list_service_enquiries(TEXT[], TEXT[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_get_service_enquiry(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_transition_service_enquiry(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_assign_service_enquiry(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.staff_add_service_enquiry_note(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- Operator / Edge Function only.
GRANT EXECUTE ON FUNCTION public.platform_staff_grant(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_staff_revoke(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_service_enquiry(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.enquiry_notification_claim(INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.enquiry_notification_complete(UUID, TEXT, TEXT, TEXT) TO service_role;

-- Signed-in callers; each function itself refuses anyone who is not ACTIVE platform staff (42501).
GRANT EXECUTE ON FUNCTION public.current_platform_staff_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_list_platform_staff() TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_list_service_enquiries(TEXT[], TEXT[], TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_get_service_enquiry(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_transition_service_enquiry(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_assign_service_enquiry(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_add_service_enquiry_note(UUID, TEXT) TO authenticated;
