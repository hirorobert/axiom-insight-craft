-- CFOClose — workspace setup authority.
--
-- Makes first-run workspace state SERVER-AUTHORITATIVE and workspace-scoped (never user-scoped), and makes the
-- "one open engagement per reporting period" rule a DATABASE invariant instead of client compensation.
--
--   1. companies.filing_jurisdiction      explicit, never inferred; changes are refused while tax/compliance/filing
--                                         services are in scope
--   2. uq_engagements_one_open_per_period at most ONE open engagement per reporting period, enforced by the database
--   3. engagement_setup_events            append-only setup history (data-start decision), keyed by ENGAGEMENT; the actor
--                                         is recorded for audit and is not part of state identity
--   4. open_engagement_with_scope(...)    transactional create-or-get (advisory lock on company × year) + idempotent grants
--   5. record_engagement_data_start(...)  the only writer of setup events; explicit, race-safe transitions
--   6. get_engagement_setup_state(...)    the one reader every authorised member uses
--   7. grant_engagement_capability(...)   replaced (same contract) to refuse jurisdiction-dependent services while no
--                                         filing jurisdiction is selected
--
-- Forward-only. No historical migration is edited. Nothing here touches financial-statement tables, rollout controls or
-- billing. Pre-flight: the unique index FAILS LOUDLY if a company already has two open engagements for one period
-- (resolve by closing the extra engagement — an UPDATE the senior-member policy already allows — then re-run).

-- ── 1. filing jurisdiction ──────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS filing_jurisdiction TEXT NULL;

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_filing_jurisdiction_chk;
ALTER TABLE public.companies
  ADD CONSTRAINT companies_filing_jurisdiction_chk
  CHECK (filing_jurisdiction IS NULL OR filing_jurisdiction ~ '^[A-Z]{2}$');

COMMENT ON COLUMN public.companies.filing_jurisdiction IS
  'ISO 3166-1 alpha-2 filing jurisdiction, selected explicitly by an owner/partner/manager. NULL = not selected. Never inferred from currency, locale, name or legacy data.';

-- Jurisdiction-dependent services are those whose work is defined by a tax authority's rules.
CREATE OR REPLACE FUNCTION public.capability_needs_jurisdiction(p_capability TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$ SELECT p_capability IN ('TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION'); $$;

-- The jurisdiction may not change or be cleared while a jurisdiction-dependent service is in scope. Enforced for EVERY
-- writer (owner UPDATE through RLS, the RPC below, service role) by a trigger.
CREATE OR REPLACE FUNCTION public.guard_company_filing_jurisdiction()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.filing_jurisdiction IS NOT NULL AND NEW.filing_jurisdiction IS DISTINCT FROM OLD.filing_jurisdiction THEN
    IF EXISTS (
      SELECT 1
        FROM (
          SELECT DISTINCT ON (e.engagement_id, e.capability) e.capability, e.action
            FROM public.engagement_mandate_events e
            JOIN public.engagements g ON g.id = e.engagement_id
           WHERE g.company_id = OLD.id AND g.status = 'open'
           ORDER BY e.engagement_id, e.capability, e.sequence_no DESC
        ) latest
       WHERE latest.action = 'GRANT' AND public.capability_needs_jurisdiction(latest.capability)
    ) THEN
      RAISE EXCEPTION 'JURISDICTION_LOCKED: the filing jurisdiction cannot change while tax, compliance or filing services are in scope; withdraw them first.'
        USING ERRCODE = 'PT409';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_company_filing_jurisdiction ON public.companies;
CREATE TRIGGER trg_guard_company_filing_jurisdiction
  BEFORE UPDATE OF filing_jurisdiction ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.guard_company_filing_jurisdiction();

CREATE OR REPLACE FUNCTION public.set_company_filing_jurisdiction(p_company_id UUID, p_jurisdiction TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member UUID;
  v_code   TEXT := NULLIF(btrim(p_jurisdiction), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF v_code IS NOT NULL AND v_code !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'INVALID: a filing jurisdiction is a two-letter ISO 3166-1 code' USING ERRCODE = '22023';
  END IF;
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL
     AND fm.role IN ('owner', 'partner', 'manager') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: only an owner, partner or manager can select the filing jurisdiction' USING ERRCODE = '42501';
  END IF;
  UPDATE public.companies SET filing_jurisdiction = v_code WHERE id = p_company_id;
  RETURN v_code;
END;
$$;

-- ── 2. one open engagement per reporting period — a database invariant ──────────────────────────────────────────────

DO $$
DECLARE
  v_dupes INTEGER;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT fiscal_period_id FROM public.engagements WHERE status = 'open' GROUP BY fiscal_period_id HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: % reporting period(s) already have more than one open engagement. Close the extra engagement(s) (status = closed) and re-run this migration.', v_dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_engagements_one_open_per_period
  ON public.engagements (fiscal_period_id)
  WHERE status = 'open';

-- An engagement must belong to the company that owns its reporting period.
CREATE OR REPLACE FUNCTION public.engagements_period_company_match()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fiscal_periods p WHERE p.id = NEW.fiscal_period_id AND p.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'INVALID: the engagement company does not own the reporting period' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_engagements_period_company_match ON public.engagements;
CREATE TRIGGER trg_engagements_period_company_match
  BEFORE INSERT ON public.engagements
  FOR EACH ROW EXECUTE FUNCTION public.engagements_period_company_match();

-- ── 3. append-only setup history, keyed by ENGAGEMENT ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.engagement_setup_events (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  engagement_id   UUID        NOT NULL REFERENCES public.engagements(id) ON DELETE RESTRICT,
  sequence_no     BIGINT      NOT NULL,
  event_type      TEXT        NOT NULL,
  -- Audit only: WHO recorded it. Never part of the state's identity (state is per engagement).
  actor_member_id UUID        NOT NULL REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT setup_event_type_chk CHECK (event_type IN ('DATA_START_EMPTY', 'DATA_START_IMPORT')),
  CONSTRAINT setup_seq_unique UNIQUE (engagement_id, sequence_no),
  -- Each decision can be recorded at most once per engagement: the history is at most EMPTY → IMPORT.
  CONSTRAINT setup_one_of_each_type UNIQUE (engagement_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_setup_events_engagement ON public.engagement_setup_events (engagement_id, sequence_no DESC);

-- The only legal histories: [], [EMPTY], [IMPORT], [EMPTY, IMPORT]. Enforced for every writer.
CREATE OR REPLACE FUNCTION public.engagement_setup_event_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_last TEXT;
  v_max  BIGINT;
BEGIN
  SELECT event_type, sequence_no INTO v_last, v_max
    FROM public.engagement_setup_events WHERE engagement_id = NEW.engagement_id ORDER BY sequence_no DESC LIMIT 1;
  IF NEW.sequence_no IS DISTINCT FROM COALESCE(v_max, 0) + 1 THEN
    RAISE EXCEPTION 'CONFLICT: setup event out of sequence' USING ERRCODE = 'PT409';
  END IF;
  IF v_last IS NOT NULL AND NOT (v_last = 'DATA_START_EMPTY' AND NEW.event_type = 'DATA_START_IMPORT') THEN
    RAISE EXCEPTION 'CONFLICT: %→% is not a permitted setup transition (empty → import is the only one)', v_last, NEW.event_type USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_setup_event_guard ON public.engagement_setup_events;
CREATE TRIGGER trg_setup_event_guard BEFORE INSERT ON public.engagement_setup_events
  FOR EACH ROW EXECUTE FUNCTION public.engagement_setup_event_guard();

DROP TRIGGER IF EXISTS trg_setup_events_append_only ON public.engagement_setup_events;
CREATE TRIGGER trg_setup_events_append_only BEFORE UPDATE OR DELETE ON public.engagement_setup_events
  FOR EACH ROW EXECUTE FUNCTION public.engagement_events_append_only();

ALTER TABLE public.engagement_setup_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.engagement_setup_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.engagement_setup_events TO authenticated;
GRANT ALL ON public.engagement_setup_events TO service_role;

DROP POLICY IF EXISTS "Members read setup events" ON public.engagement_setup_events;
CREATE POLICY "Members read setup events" ON public.engagement_setup_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.engagements g
                  WHERE g.id = engagement_setup_events.engagement_id
                    AND g.company_id IN (SELECT public.get_member_company_ids())));

-- ── 4. jurisdiction-aware grant (same contract as before, one extra refusal) ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.grant_engagement_capability(
  p_engagement_id UUID, p_capability TEXT, p_reason TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_member  UUID;
  v_current TEXT;
  v_id      UUID;
  v_j       TEXT;
BEGIN
  v_member := public.assert_engagement_write_authority(p_engagement_id);

  IF public.capability_needs_jurisdiction(p_capability) THEN
    SELECT c.filing_jurisdiction INTO v_j
      FROM public.companies c JOIN public.engagements g ON g.company_id = c.id WHERE g.id = p_engagement_id;
    IF v_j IS NULL THEN
      RAISE EXCEPTION 'JURISDICTION_REQUIRED: select the filing jurisdiction before adding %.', p_capability
        USING ERRCODE = 'PT422';
    END IF;
  END IF;

  SELECT action INTO v_current
  FROM public.engagement_mandate_events
  WHERE engagement_id = p_engagement_id AND capability = p_capability
  ORDER BY sequence_no DESC LIMIT 1;

  IF v_current = 'GRANT' THEN
    RAISE EXCEPTION
      'Capability % is already part of this engagement. A professional file must not record a change that did not occur.',
      p_capability USING ERRCODE = 'restrict_violation';
  END IF;

  INSERT INTO public.engagement_mandate_events (
    engagement_id, capability, action, sequence_no, actor_member_id, reason
  ) VALUES (
    p_engagement_id, p_capability, 'GRANT',
    public.next_engagement_sequence(p_engagement_id), v_member, p_reason
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ── 5. transactional create-or-get with idempotent grants ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.open_engagement_with_scope(
  p_company_id      UUID,
  p_period_year     INTEGER,
  p_capabilities    TEXT[],
  p_engagement_type TEXT DEFAULT 'composite'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member   UUID;
  v_period   UUID;
  v_eng      UUID;
  v_created  BOOLEAN := false;
  v_cap      TEXT;
  v_caps     TEXT[];
  v_granted  TEXT[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF p_period_year IS NULL OR p_period_year < 2000 OR p_period_year > 2100 THEN
    RAISE EXCEPTION 'INVALID: reporting year out of range' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT c ORDER BY c) INTO v_caps FROM unnest(COALESCE(p_capabilities, ARRAY[]::TEXT[])) c;
  IF v_caps IS NULL OR array_length(v_caps, 1) = 0 THEN
    RAISE EXCEPTION 'INVALID: choose at least one service' USING ERRCODE = '22023';
  END IF;
  FOREACH v_cap IN ARRAY v_caps LOOP
    IF v_cap NOT IN ('FINANCIAL_STATEMENTS', 'TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING') THEN
      RAISE EXCEPTION 'INVALID: unknown service %', v_cap USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- 1. authorise from the session (never from the request)
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL
     AND fm.role IN ('owner', 'partner', 'manager') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: only an owner, partner or manager of this company can choose its services' USING ERRCODE = '42501';
  END IF;

  -- 2. serialise on the company × year identity: every concurrent request for the same workspace queues here
  PERFORM pg_advisory_xact_lock(hashtextextended('open_engagement:' || p_company_id::text || ':' || p_period_year::text, 0));

  -- 3. the reporting period of record (earliest wins; the (company, year-end) UNIQUE key is the backstop)
  SELECT p.id INTO v_period FROM public.fiscal_periods p
   WHERE p.company_id = p_company_id
     AND EXTRACT(YEAR FROM COALESCE(p.reporting_end, p.fiscal_year_end))::INTEGER = p_period_year
   ORDER BY p.created_at, p.id LIMIT 1;
  IF v_period IS NULL THEN
    INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, reporting_start, reporting_end, period_label, created_by)
    VALUES (p_company_id, make_date(p_period_year, 12, 31), make_date(p_period_year, 1, 1), make_date(p_period_year, 12, 31), 'FY' || p_period_year::text, auth.uid())
    ON CONFLICT (company_id, fiscal_year_end) DO NOTHING
    RETURNING id INTO v_period;
    IF v_period IS NULL THEN
      SELECT p.id INTO v_period FROM public.fiscal_periods p
       WHERE p.company_id = p_company_id AND p.fiscal_year_end = make_date(p_period_year, 12, 31);
    END IF;
  END IF;

  -- 4. the open engagement, or exactly one new one (uq_engagements_one_open_per_period is the invariant)
  SELECT g.id INTO v_eng FROM public.engagements g WHERE g.fiscal_period_id = v_period AND g.status = 'open';
  IF v_eng IS NULL THEN
    INSERT INTO public.engagements (fiscal_period_id, company_id, engagement_type, created_by_member_id)
    VALUES (v_period, p_company_id, COALESCE(p_engagement_type, 'composite'), v_member)
    RETURNING id INTO v_eng;
    v_created := true;
  END IF;

  -- 5. grants: only what is missing (each goes through the validated, jurisdiction-aware command)
  FOREACH v_cap IN ARRAY v_caps LOOP
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (e.capability) e.action FROM public.engagement_mandate_events e
         WHERE e.engagement_id = v_eng AND e.capability = v_cap ORDER BY e.capability, e.sequence_no DESC
      ) l WHERE l.action = 'GRANT'
    ) THEN
      PERFORM public.grant_engagement_capability(v_eng, v_cap, 'Selected when the workspace was set up');
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(x.capability ORDER BY x.capability), ARRAY[]::TEXT[]) INTO v_granted FROM (
    SELECT DISTINCT ON (e.capability) e.capability, e.action FROM public.engagement_mandate_events e
     WHERE e.engagement_id = v_eng ORDER BY e.capability, e.sequence_no DESC
  ) x WHERE x.action = 'GRANT';

  RETURN jsonb_build_object('engagementId', v_eng, 'periodId', v_period, 'created', v_created, 'granted', to_jsonb(v_granted));
END;
$$;

-- ── 6. data-start decision: explicit, race-safe transitions ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.engagement_data_start_state(p_engagement_id UUID)
RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE e.event_type WHEN 'DATA_START_EMPTY' THEN 'empty' WHEN 'DATA_START_IMPORT' THEN 'import' END
    FROM public.engagement_setup_events e WHERE e.engagement_id = p_engagement_id ORDER BY e.sequence_no DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.record_engagement_data_start(
  p_engagement_id  UUID,
  p_choice         TEXT,
  p_expected_state TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company UUID;
  v_status  TEXT;
  v_member  UUID;
  v_current TEXT;
  v_seq     BIGINT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF p_choice IS NULL OR p_choice NOT IN ('empty', 'import') THEN
    RAISE EXCEPTION 'INVALID: the choice is "empty" or "import"' USING ERRCODE = '22023';
  END IF;
  IF p_expected_state IS NOT NULL AND p_expected_state NOT IN ('empty', 'import') THEN
    RAISE EXCEPTION 'INVALID: expected state is "empty" or "import"' USING ERRCODE = '22023';
  END IF;

  -- Lock the engagement row: every concurrent decision for this workspace serialises here.
  SELECT g.company_id, g.status INTO v_company, v_status FROM public.engagements g WHERE g.id = p_engagement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: no such engagement' USING ERRCODE = 'P0002';
  END IF;

  -- Authorise from the session: a non-viewer accepted member of THIS engagement's company.
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = v_company AND fm.accepted_at IS NOT NULL
     AND fm.role IN ('owner', 'partner', 'manager', 'preparer') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: only a non-viewer member of this workspace can change its setup' USING ERRCODE = '42501';
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'CONFLICT: the engagement is closed' USING ERRCODE = 'PT409';
  END IF;

  v_current := public.engagement_data_start_state(p_engagement_id);

  -- Exact replay converges: nothing is written.
  IF v_current = p_choice THEN
    RETURN jsonb_build_object('dataStart', v_current, 'changed', false, 'replay', true);
  END IF;

  -- The caller's belief about the current state must match the truth (stale / conflicting concurrent choice).
  IF p_expected_state IS DISTINCT FROM v_current THEN
    RAISE EXCEPTION 'CONFLICT: the workspace setup is already "%" (this request expected "%")', COALESCE(v_current, 'undecided'), COALESCE(p_expected_state, 'undecided')
      USING ERRCODE = 'PT409';
  END IF;

  -- Permitted transitions only: undecided → empty | import, and empty → import.
  IF v_current = 'import' THEN
    RAISE EXCEPTION 'CONFLICT: import has already started; a workspace cannot return to empty' USING ERRCODE = 'PT409';
  END IF;

  SELECT COALESCE(MAX(sequence_no), 0) + 1 INTO v_seq FROM public.engagement_setup_events WHERE engagement_id = p_engagement_id;
  INSERT INTO public.engagement_setup_events (engagement_id, sequence_no, event_type, actor_member_id)
  VALUES (p_engagement_id, v_seq, CASE p_choice WHEN 'empty' THEN 'DATA_START_EMPTY' ELSE 'DATA_START_IMPORT' END, v_member);

  RETURN jsonb_build_object('dataStart', p_choice, 'changed', true, 'replay', false, 'sequence', v_seq);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_engagement_setup_state(p_engagement_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_company UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  SELECT g.company_id INTO v_company FROM public.engagements g WHERE g.id = p_engagement_id;
  IF v_company IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.firm_members fm WHERE fm.user_id = auth.uid() AND fm.company_id = v_company AND fm.accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FORBIDDEN: an accepted member of the workspace is required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'dataStart', public.engagement_data_start_state(p_engagement_id),
    'sequence', COALESCE((SELECT MAX(sequence_no) FROM public.engagement_setup_events WHERE engagement_id = p_engagement_id), 0)
  );
END;
$$;

-- ── 7. privileges ───────────────────────────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.open_engagement_with_scope(UUID, INTEGER, TEXT[], TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_engagement_data_start(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_engagement_setup_state(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_company_filing_jurisdiction(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.engagement_data_start_state(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.capability_needs_jurisdiction(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guard_company_filing_jurisdiction() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.engagements_period_company_match() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.engagement_setup_event_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.grant_engagement_capability(UUID, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.open_engagement_with_scope(UUID, INTEGER, TEXT[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_engagement_data_start(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_engagement_setup_state(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_company_filing_jurisdiction(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.engagement_data_start_state(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.capability_needs_jurisdiction(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grant_engagement_capability(UUID, TEXT, TEXT) TO authenticated;
