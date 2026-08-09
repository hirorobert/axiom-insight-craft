-- ── STEP 1: fiscal_periods extension + first-class engagements ───────────────

ALTER TABLE public.fiscal_periods
  ADD COLUMN IF NOT EXISTS reporting_start      DATE,
  ADD COLUMN IF NOT EXISTS reporting_end        DATE,
  ADD COLUMN IF NOT EXISTS reporting_framework  TEXT;

CREATE TABLE public.engagements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_period_id      UUID NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  company_id            UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  firm_id               UUID,
  engagement_type       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open',
  opened_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at             TIMESTAMPTZ,
  created_by_member_id  UUID NOT NULL REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engagements_status_chk CHECK (status IN ('open','closed')),
  CONSTRAINT engagements_type_chk CHECK (engagement_type IN (
    'financial_statements','tax','compliance_review','filing','restatement',
    'successor_review','monitoring','composite'
  ))
);

CREATE INDEX idx_engagements_period  ON public.engagements(fiscal_period_id);
CREATE INDEX idx_engagements_company ON public.engagements(company_id, status);

GRANT SELECT, INSERT, UPDATE ON public.engagements TO authenticated;
GRANT ALL ON public.engagements TO service_role;

ALTER TABLE public.engagements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read engagements"
  ON public.engagements FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.get_member_company_ids()));

CREATE POLICY "Senior members create engagements"
  ON public.engagements FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (SELECT public.get_member_company_ids())
    AND EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.id = created_by_member_id
        AND fm.user_id = auth.uid()
        AND fm.company_id = engagements.company_id
        AND fm.accepted_at IS NOT NULL
        AND fm.role IN ('owner','partner','manager')
    )
  );

CREATE POLICY "Senior members update engagement status"
  ON public.engagements FOR UPDATE TO authenticated
  USING (
    company_id IN (SELECT public.get_member_company_ids())
    AND EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.user_id = auth.uid()
        AND fm.company_id = engagements.company_id
        AND fm.accepted_at IS NOT NULL
        AND fm.role IN ('owner','partner','manager')
    )
  )
  WITH CHECK (company_id IN (SELECT public.get_member_company_ids()));

CREATE TRIGGER trg_engagements_updated_at
  BEFORE UPDATE ON public.engagements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── STEP 2: append-only mandate and authority event streams ──────────────────

CREATE TABLE public.engagement_mandate_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id    UUID NOT NULL REFERENCES public.engagements(id) ON DELETE RESTRICT,
  capability       TEXT NOT NULL,
  action           TEXT NOT NULL,
  sequence_no      BIGINT NOT NULL,
  actor_member_id  UUID NOT NULL REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason           TEXT,
  source           TEXT NOT NULL DEFAULT 'app',
  CONSTRAINT mandate_capability_chk CHECK (capability IN (
    'FINANCIAL_STATEMENTS','TAX_COMPUTATION','COMPLIANCE_REVIEW',
    'FILING_PREPARATION','MONITORING'
  )),
  CONSTRAINT mandate_action_chk CHECK (action IN ('GRANT','REVOKE')),
  CONSTRAINT mandate_seq_unique UNIQUE (engagement_id, sequence_no)
);

CREATE INDEX idx_mandate_events_fold
  ON public.engagement_mandate_events(engagement_id, capability, sequence_no DESC);

CREATE TABLE public.engagement_authority_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id         UUID NOT NULL REFERENCES public.engagements(id) ON DELETE RESTRICT,
  authority_type        TEXT NOT NULL,
  action                TEXT NOT NULL,
  sequence_no           BIGINT NOT NULL,
  granted_to_member_id  UUID REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  actor_member_id       UUID NOT NULL REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  jurisdiction          TEXT,
  filing_type           TEXT,
  effective_from        TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason                TEXT,
  source                TEXT NOT NULL DEFAULT 'app',
  CONSTRAINT authority_type_chk CHECK (authority_type IN (
    'SUBMIT_CIT_RETURN','SUBMIT_VAT_RETURN','SUBMIT_WHT_RETURN',
    'SUBMIT_REGULATORY_PACKAGE'
  )),
  CONSTRAINT authority_action_chk CHECK (action IN ('GRANT','REVOKE')),
  CONSTRAINT authority_seq_unique UNIQUE (engagement_id, sequence_no)
);

CREATE INDEX idx_authority_events_fold
  ON public.engagement_authority_events(engagement_id, authority_type, sequence_no DESC);

GRANT SELECT ON public.engagement_mandate_events   TO authenticated;
GRANT ALL    ON public.engagement_mandate_events   TO service_role;
GRANT SELECT ON public.engagement_authority_events TO authenticated;
GRANT ALL    ON public.engagement_authority_events TO service_role;

ALTER TABLE public.engagement_mandate_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_authority_events ENABLE ROW LEVEL SECURITY;

-- SELECT only. No INSERT/UPDATE/DELETE policies: writes go through the
-- security-definer commands below; append-only is structural, not advisory.
CREATE POLICY "Members read mandate events"
  ON public.engagement_mandate_events FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.engagements e
    WHERE e.id = engagement_mandate_events.engagement_id
      AND e.company_id IN (SELECT public.get_member_company_ids())
  ));

CREATE POLICY "Members read authority events"
  ON public.engagement_authority_events FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.engagements e
    WHERE e.id = engagement_authority_events.engagement_id
      AND e.company_id IN (SELECT public.get_member_company_ids())
  ));

-- Defence in depth: block mutation even for privileged callers.
CREATE OR REPLACE FUNCTION public.engagement_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION
    'IRON DOME: % is append-only. Mandate and authority history cannot be modified or deleted; append a new event instead.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER trg_mandate_events_append_only
  BEFORE UPDATE OR DELETE ON public.engagement_mandate_events
  FOR EACH ROW EXECUTE FUNCTION public.engagement_events_append_only();

CREATE TRIGGER trg_authority_events_append_only
  BEFORE UPDATE OR DELETE ON public.engagement_authority_events
  FOR EACH ROW EXECUTE FUNCTION public.engagement_events_append_only();

-- ── STEP 3: fold readers + validated write commands ──────────────────────────

CREATE OR REPLACE FUNCTION public.fold_engagement_mandate(p_engagement_id UUID)
RETURNS TABLE(capability TEXT, granted BOOLEAN, sequence_no BIGINT, occurred_at TIMESTAMPTZ)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT DISTINCT ON (e.capability)
    e.capability,
    e.action = 'GRANT' AS granted,
    e.sequence_no,
    e.occurred_at
  FROM public.engagement_mandate_events e
  JOIN public.engagements g ON g.id = e.engagement_id
  WHERE e.engagement_id = p_engagement_id
    AND g.company_id IN (SELECT public.get_member_company_ids())
  ORDER BY e.capability, e.sequence_no DESC;
$$;

CREATE OR REPLACE FUNCTION public.fold_engagement_authority(p_engagement_id UUID)
RETURNS TABLE(
  authority_type TEXT, granted BOOLEAN, granted_to_member_id UUID,
  jurisdiction TEXT, filing_type TEXT, effective_from TIMESTAMPTZ,
  expires_at TIMESTAMPTZ, sequence_no BIGINT
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT DISTINCT ON (e.authority_type)
    e.authority_type,
    e.action = 'GRANT' AND (e.expires_at IS NULL OR e.expires_at > now()) AS granted,
    e.granted_to_member_id, e.jurisdiction, e.filing_type,
    e.effective_from, e.expires_at, e.sequence_no
  FROM public.engagement_authority_events e
  JOIN public.engagements g ON g.id = e.engagement_id
  WHERE e.engagement_id = p_engagement_id
    AND g.company_id IN (SELECT public.get_member_company_ids())
  ORDER BY e.authority_type, e.sequence_no DESC;
$$;

-- Shared guard: locks the engagement, asserts open status and senior role,
-- returns the acting firm_members.id (never taken from the client).
CREATE OR REPLACE FUNCTION public.assert_engagement_write_authority(p_engagement_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_company UUID;
  v_status  TEXT;
  v_member  UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'IRON DOME: engagement scope changes require an authenticated actor.';
  END IF;

  SELECT company_id, status INTO v_company, v_status
  FROM public.engagements WHERE id = p_engagement_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Engagement % does not exist.', p_engagement_id;
  END IF;

  IF v_status <> 'open' THEN
    RAISE EXCEPTION
      'IRON DOME: engagement % is closed. Closed engagements accept no further mandate or authority events.',
      p_engagement_id USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT fm.id INTO v_member
  FROM public.firm_members fm
  WHERE fm.user_id = auth.uid()
    AND fm.company_id = v_company
    AND fm.accepted_at IS NOT NULL
    AND fm.role IN ('owner','partner','manager')
  LIMIT 1;

  IF v_member IS NULL THEN
    RAISE EXCEPTION
      'IRON DOME: only an owner, partner or manager of this company may change engagement scope or authority.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN v_member;
END;
$$;

CREATE OR REPLACE FUNCTION public.next_engagement_sequence(p_engagement_id UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT GREATEST(
    COALESCE((SELECT MAX(sequence_no) FROM public.engagement_mandate_events   WHERE engagement_id = p_engagement_id), 0),
    COALESCE((SELECT MAX(sequence_no) FROM public.engagement_authority_events WHERE engagement_id = p_engagement_id), 0)
  ) + 1;
$$;

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
BEGIN
  v_member := public.assert_engagement_write_authority(p_engagement_id);

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

CREATE OR REPLACE FUNCTION public.revoke_engagement_capability(
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
BEGIN
  v_member := public.assert_engagement_write_authority(p_engagement_id);

  SELECT action INTO v_current
  FROM public.engagement_mandate_events
  WHERE engagement_id = p_engagement_id AND capability = p_capability
  ORDER BY sequence_no DESC LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION
      'Capability % was never part of this engagement, so it cannot be withdrawn.',
      p_capability USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_current = 'REVOKE' THEN
    RAISE EXCEPTION
      'Capability % has already been withdrawn from this engagement.',
      p_capability USING ERRCODE = 'restrict_violation';
  END IF;

  INSERT INTO public.engagement_mandate_events (
    engagement_id, capability, action, sequence_no, actor_member_id, reason
  ) VALUES (
    p_engagement_id, p_capability, 'REVOKE',
    public.next_engagement_sequence(p_engagement_id), v_member, p_reason
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_engagement_authority(
  p_engagement_id UUID, p_authority_type TEXT, p_granted_to_member_id UUID,
  p_jurisdiction TEXT DEFAULT NULL, p_filing_type TEXT DEFAULT NULL,
  p_effective_from TIMESTAMPTZ DEFAULT NULL, p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_member  UUID;
  v_current TEXT;
  v_id      UUID;
BEGIN
  v_member := public.assert_engagement_write_authority(p_engagement_id);

  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'Authority expiry must be in the future.';
  END IF;

  SELECT action INTO v_current
  FROM public.engagement_authority_events
  WHERE engagement_id = p_engagement_id AND authority_type = p_authority_type
  ORDER BY sequence_no DESC LIMIT 1;

  IF v_current = 'GRANT' THEN
    RAISE EXCEPTION
      'Authority % is already granted on this engagement.',
      p_authority_type USING ERRCODE = 'restrict_violation';
  END IF;

  INSERT INTO public.engagement_authority_events (
    engagement_id, authority_type, action, sequence_no, granted_to_member_id,
    actor_member_id, jurisdiction, filing_type, effective_from, expires_at, reason
  ) VALUES (
    p_engagement_id, p_authority_type, 'GRANT',
    public.next_engagement_sequence(p_engagement_id), p_granted_to_member_id,
    v_member, p_jurisdiction, p_filing_type, p_effective_from, p_expires_at, p_reason
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_engagement_authority(
  p_engagement_id UUID, p_authority_type TEXT, p_reason TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_member  UUID;
  v_current TEXT;
  v_id      UUID;
BEGIN
  v_member := public.assert_engagement_write_authority(p_engagement_id);

  SELECT action INTO v_current
  FROM public.engagement_authority_events
  WHERE engagement_id = p_engagement_id AND authority_type = p_authority_type
  ORDER BY sequence_no DESC LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION
      'Authority % was never granted on this engagement, so it cannot be withdrawn.',
      p_authority_type USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_current = 'REVOKE' THEN
    RAISE EXCEPTION
      'Authority % has already been withdrawn on this engagement.',
      p_authority_type USING ERRCODE = 'restrict_violation';
  END IF;

  INSERT INTO public.engagement_authority_events (
    engagement_id, authority_type, action, sequence_no,
    actor_member_id, reason
  ) VALUES (
    p_engagement_id, p_authority_type, 'REVOKE',
    public.next_engagement_sequence(p_engagement_id), v_member, p_reason
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_engagement_write_authority(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.next_engagement_sequence(UUID) FROM PUBLIC, anon;
