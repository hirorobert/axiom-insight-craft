-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ PHASE 2A — PROFESSIONAL ACCOUNT-REVIEW AUTHORITY
--
-- Replaces AccountReviewPanel's direct frontend writes to account_mappings /
-- trial_balance_uploads with a single, atomic, idempotent, actor-scoped
-- SECURITY DEFINER command: resolve_account_review_batch(...).
--
-- Constitutional laws frozen for this slice (see session record, Phase 2A-1):
--   1. Professional review decisions are immutable historical evidence.
--   2. account_mappings remains the mutable CURRENT projection.
--   3. Latest effective professional decision (by sequence_no) wins.
--   4. Effective MARK_NON_REPORTING_ACCOUNT authority is evaluated BEFORE
--      classifyAccountTiered() runs in process-trial-balance.
--   5. Global (company_id IS NULL) mappings are never deleted by a
--      company-specific professional decision.
--   6. Identity drift (same code, materially changed normalized name)
--      invalidates inherited non-reporting suppression.
--   7. Actor identity is derived server-side from auth.uid(), never trusted
--      from client input. Idempotency namespace is actor-scoped.
--   8. classifyAccountTiered, its 6 tiers, framework inference, statement/
--      cash-flow/tax logic are NOT touched by this migration.
--
-- Does NOT implement idempotency_keys / engine_runs (CLAUDE.md's documented,
-- still-unapplied WIP infrastructure) — this migration's idempotency and
-- ordering mechanisms are purpose-built for this command only, per the
-- explicit instruction not to invent guessed general-purpose infrastructure.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

SET search_path TO public, pg_catalog;

-- ── Deterministic event ordering ─────────────────────────────────────────────
-- Provides strict ordering of COMMITTED decisions only. A rolled-back
-- transaction may consume and lose a value — accepted; gaps are harmless.
-- This is NOT the concurrency-safety mechanism (see advisory locks below).
CREATE SEQUENCE public.account_review_decisions_seq;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: account_review_batches — actor-scoped request idempotency ledger
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.account_review_batches (
  id                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  client_request_id  UUID         NOT NULL,
  request_hash       TEXT         NOT NULL,
  company_id         UUID         NOT NULL,
  upload_id          UUID         NOT NULL,
  firm_member_id     UUID         NOT NULL,
  result_summary     JSONB        NOT NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT account_review_batches_pk PRIMARY KEY (id),

  CONSTRAINT fk_arb_company
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,

  CONSTRAINT fk_arb_upload
    FOREIGN KEY (upload_id) REFERENCES public.trial_balance_uploads(id) ON DELETE CASCADE,

  CONSTRAINT fk_arb_firm_member
    FOREIGN KEY (firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,

  -- Actor-scoped idempotency namespace (Phase 2A-1 §7 amendment):
  -- different actors reusing the same client-generated UUID never collide.
  CONSTRAINT uq_batch_request
    UNIQUE (upload_id, firm_member_id, client_request_id)
);

COMMENT ON TABLE public.account_review_batches IS
  'Ω∞ Phase 2A: one row per successfully processed resolve_account_review_batch '
  'call. Uniqueness is actor-scoped (upload_id, firm_member_id, client_request_id) '
  'so identity is never trusted from the client for idempotency purposes. '
  'Written only by resolve_account_review_batch(); no direct authenticated writes.';

CREATE INDEX idx_arb_company ON public.account_review_batches (company_id);

ALTER TABLE public.account_review_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "arb_select" ON public.account_review_batches
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id    = auth.uid()
         AND fm.company_id = account_review_batches.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );

REVOKE ALL ON public.account_review_batches FROM anon;
GRANT SELECT ON public.account_review_batches TO authenticated;
GRANT ALL    ON public.account_review_batches TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: account_review_decisions — append-only professional decision ledger
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.account_review_decisions (
  id                        UUID         NOT NULL DEFAULT gen_random_uuid(),
  batch_id                  UUID         NOT NULL,
  sequence_no               BIGINT       NOT NULL DEFAULT nextval('public.account_review_decisions_seq'),
  company_id                UUID         NOT NULL,
  upload_id                 UUID         NOT NULL,
  firm_member_id            UUID         NOT NULL,
  account_code              TEXT         NULL,
  normalized_account_name   TEXT         NOT NULL,
  review_account_key        TEXT         NOT NULL,
  proposal_type             TEXT         NOT NULL DEFAULT 'NONE'
    CHECK (proposal_type IN ('NONE', 'MACHINE_SUGGESTION', 'AUTO_MAPPED_RULE')),
  decision_action            TEXT        NOT NULL
    CHECK (decision_action IN (
      'USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION', 'MARK_NON_REPORTING_ACCOUNT'
    )),
  previous_value             JSONB       NULL,
  new_value                  JSONB       NULL,
  source                     TEXT        NULL,
  reason                     TEXT        NULL,
  rule_id                    TEXT        NULL,
  rule_version                TEXT       NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT account_review_decisions_pk PRIMARY KEY (id),

  CONSTRAINT fk_ard_batch
    FOREIGN KEY (batch_id) REFERENCES public.account_review_batches(id) ON DELETE CASCADE,

  CONSTRAINT fk_ard_company
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,

  CONSTRAINT fk_ard_upload
    FOREIGN KEY (upload_id) REFERENCES public.trial_balance_uploads(id) ON DELETE CASCADE,

  CONSTRAINT fk_ard_firm_member
    FOREIGN KEY (firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT
);

COMMENT ON TABLE public.account_review_decisions IS
  'Ω∞ Phase 2A: append-only ledger of every professional account-review '
  'decision. Immutable — see trg_ard_immutable below. Effective state for '
  '(company_id, review_account_key) is the row with the highest sequence_no; '
  'MARK_NON_REPORTING_ACCOUNT is additionally subject to the identity-drift '
  'guard at read time (normalized_account_name comparison) before it may '
  'suppress an account from review — see get_effective_non_reporting_status().';

COMMENT ON COLUMN public.account_review_decisions.review_account_key IS
  'COALESCE(account_code, normalized_account_name) — identical formula to '
  'account_mappings.account_key (20260703120000). Computed server-side only; '
  'never accepted from client input.';

CREATE INDEX idx_ard_effective_state
  ON public.account_review_decisions (company_id, review_account_key, sequence_no DESC);

CREATE INDEX idx_ard_batch
  ON public.account_review_decisions (batch_id);

-- ── Immutability (append-only ledger, DB-enforced not UI-convention) ────────
CREATE OR REPLACE FUNCTION public.account_review_decisions_immutable()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    'Iron Dome: account_review_decisions is append-only. % is not permitted. [id=%]',
    TG_OP, COALESCE(OLD.id::TEXT, 'N/A')
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_ard_immutable
  BEFORE UPDATE OR DELETE ON public.account_review_decisions
  FOR EACH ROW EXECUTE FUNCTION public.account_review_decisions_immutable();

ALTER TABLE public.account_review_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ard_select" ON public.account_review_decisions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id    = auth.uid()
         AND fm.company_id = account_review_decisions.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );

-- No authenticated INSERT/UPDATE/DELETE policy exists at all — the only
-- writer is resolve_account_review_batch(), executing as the function owner.
REVOKE ALL ON public.account_review_decisions FROM anon;
GRANT SELECT ON public.account_review_decisions TO authenticated;
GRANT ALL    ON public.account_review_decisions TO service_role;

-- Trigger function itself: no direct client execution needed.
REVOKE ALL ON FUNCTION public.account_review_decisions_immutable() FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: resolve_account_review_batch(...)
-- The sole authorized write path for professional account-review decisions.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.resolve_account_review_batch(
  p_company_id         UUID,
  p_upload_id          UUID,
  p_client_request_id  UUID,
  p_decisions          JSONB
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id            UUID := auth.uid();
  v_firm_member_id     UUID;
  v_role               TEXT;
  v_upload_company_id  UUID;
  v_request_hash       TEXT;
  v_existing_batch      RECORD;
  v_batch_id           UUID;
  v_result             JSONB;
  v_decision           JSONB;
  v_sorted_keys        TEXT[];
  v_key                TEXT;
  v_code               TEXT;
  v_norm_name          TEXT;
  v_review_key         TEXT;
  v_proposal_type      TEXT;
  v_decision_action    TEXT;
  v_previous           JSONB;
  v_mappings_written   INTEGER := 0;
  v_decisions_logged   INTEGER := 0;
  v_non_reporting_count INTEGER := 0;
  v_seen_keys          TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- 1. Actor identity — server-derived only. NEVER accept from client.
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  -- 2. Resolve accepted firm_members membership + role server-side.
  --    Classification authority: owner/partner/preparer. 'viewer' excluded.
  --    ('manager' is not a value chk_firm_member_role permits and never will match.)
  SELECT fm.id, fm.role
    INTO v_firm_member_id, v_role
    FROM public.firm_members fm
   WHERE fm.user_id     = v_user_id
     AND fm.company_id  = p_company_id
     AND fm.accepted_at IS NOT NULL
   LIMIT 1;

  IF v_firm_member_id IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER_OF_COMPANY' USING ERRCODE = '42501';
  END IF;

  IF v_role NOT IN ('owner', 'partner', 'preparer') THEN
    RAISE EXCEPTION 'ROLE_NOT_AUTHORIZED_FOR_CLASSIFICATION_DECISIONS' USING ERRCODE = '42501';
  END IF;

  -- 3/4. Resolve upload's authoritative company_id server-side; cross-company
  --      mismatch aborts atomically before anything is read or written.
  SELECT tbu.company_id INTO v_upload_company_id
    FROM public.trial_balance_uploads tbu
   WHERE tbu.id = p_upload_id;

  IF v_upload_company_id IS NULL OR v_upload_company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'UPLOAD_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- Reject empty batches early.
  IF p_decisions IS NULL OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DECISION_BATCH' USING ERRCODE = '22023';
  END IF;

  -- 5. Actor-scoped idempotency check.
  v_request_hash := encode(
    digest(
      p_company_id::TEXT || '|' || p_upload_id::TEXT || '|' ||
      (
        SELECT string_agg(
                 coalesce(elem->>'account_code','') || '::' ||
                 coalesce(elem->>'account_name','') || '::' ||
                 coalesce(elem->>'proposal_type','NONE') || '::' ||
                 coalesce(elem->>'decision_action','') || '::' ||
                 coalesce(elem->>'statement','') || '::' ||
                 coalesce(elem->>'classification','') || '::' ||
                 coalesce(elem->>'line_item','') || '::' ||
                 coalesce(elem->>'normal_balance','') || '::' ||
                 coalesce(elem->>'reason',''),
                 '|' ORDER BY
                   coalesce(elem->>'account_code', elem->>'account_name')
               )
          FROM jsonb_array_elements(p_decisions) elem
      ),
      'sha256'
    ),
    'hex'
  );

  SELECT * INTO v_existing_batch
    FROM public.account_review_batches
   WHERE upload_id = p_upload_id
     AND firm_member_id = v_firm_member_id
     AND client_request_id = p_client_request_id
   LIMIT 1;

  IF FOUND THEN
    IF v_existing_batch.request_hash = v_request_hash THEN
      RETURN v_existing_batch.result_summary;               -- exact replay, nothing written
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 6. Canonicalize decisions: compute review_account_key for each, reject
  --    duplicates within one batch, reject AUTO_MAPPED_RULE (item 9 boundary).
  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_proposal_type := coalesce(v_decision->>'proposal_type', 'NONE');
    IF v_proposal_type = 'AUTO_MAPPED_RULE' THEN
      RAISE EXCEPTION 'AUTO_MAPPED_RULE_NOT_AUTHORIZED_IN_PHASE_2A' USING ERRCODE = '42501';
    END IF;

    v_decision_action := v_decision->>'decision_action';
    IF v_decision_action IS NULL OR v_decision_action NOT IN
       ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION', 'MARK_NON_REPORTING_ACCOUNT') THEN
      RAISE EXCEPTION 'INVALID_DECISION_ACTION: %', coalesce(v_decision_action, 'NULL') USING ERRCODE = '22023';
    END IF;

    v_code := NULLIF(trim(coalesce(v_decision->>'account_code', '')), '');
    v_norm_name := lower(trim(regexp_replace(regexp_replace(
                     coalesce(v_decision->>'account_name', ''), '[[:punct:]]', '', 'g'),
                     '\s+', ' ', 'g')));
    v_review_key := COALESCE(v_code, v_norm_name);

    IF v_review_key = '' THEN
      RAISE EXCEPTION 'ACCOUNT_IDENTITY_UNRESOLVABLE' USING ERRCODE = '22023';
    END IF;

    IF v_review_key = ANY(v_seen_keys) THEN
      RAISE EXCEPTION 'DUPLICATE_ACCOUNT_IN_BATCH: %', v_review_key USING ERRCODE = '22023';
    END IF;
    v_seen_keys := v_seen_keys || v_review_key;
  END LOOP;

  -- 7. Deterministic sorted lock order (deadlock avoidance across concurrent
  --    multi-account batches, regardless of payload ordering).
  SELECT array_agg(DISTINCT k ORDER BY k) INTO v_sorted_keys
    FROM unnest(v_seen_keys) AS k;

  FOREACH v_key IN ARRAY v_sorted_keys LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_company_id::TEXT), hashtext(v_key));
  END LOOP;

  -- 8-11. Under lock: read previous state, apply projection law, log ledger.
  INSERT INTO public.account_review_batches (
    id, client_request_id, request_hash, company_id, upload_id, firm_member_id, result_summary
  ) VALUES (
    gen_random_uuid(), p_client_request_id, v_request_hash, p_company_id, p_upload_id, v_firm_member_id, '{}'::jsonb
  ) RETURNING id INTO v_batch_id;

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_code := NULLIF(trim(coalesce(v_decision->>'account_code', '')), '');
    v_norm_name := lower(trim(regexp_replace(regexp_replace(
                     coalesce(v_decision->>'account_name', ''), '[[:punct:]]', '', 'g'),
                     '\s+', ' ', 'g')));
    v_review_key := COALESCE(v_code, v_norm_name);
    v_decision_action := v_decision->>'decision_action';
    v_proposal_type := coalesce(v_decision->>'proposal_type', 'NONE');

    SELECT to_jsonb(am.*) INTO v_previous
      FROM public.account_mappings am
     WHERE am.company_id = p_company_id
       AND am.account_key = v_review_key
     LIMIT 1;

    IF v_decision_action IN ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION') THEN
      INSERT INTO public.account_mappings (
        user_id, company_id, account_code, account_name, normalized_account_name,
        statement, classification, line_item, normal_balance,
        is_cash_account, is_retained_earnings, is_payroll_account,
        confidence_source, approved_at
      ) VALUES (
        v_user_id, p_company_id, v_code, v_decision->>'account_name', v_norm_name,
        (v_decision->>'statement')::public.financial_statement,
        (v_decision->>'classification')::public.account_classification,
        coalesce(v_decision->>'line_item', v_decision->>'account_name'),
        v_decision->>'normal_balance',
        coalesce((v_decision->>'is_cash_account')::boolean, false),
        coalesce((v_decision->>'is_retained_earnings')::boolean, false),
        coalesce((v_decision->>'is_payroll_account')::boolean, false),
        'user_approved', now()
      )
      ON CONFLICT (company_id, account_key) DO UPDATE SET
        account_code            = EXCLUDED.account_code,
        account_name             = EXCLUDED.account_name,
        normalized_account_name  = EXCLUDED.normalized_account_name,
        statement                = EXCLUDED.statement,
        classification           = EXCLUDED.classification,
        line_item                = EXCLUDED.line_item,
        normal_balance           = EXCLUDED.normal_balance,
        is_cash_account          = EXCLUDED.is_cash_account,
        is_retained_earnings     = EXCLUDED.is_retained_earnings,
        is_payroll_account       = EXCLUDED.is_payroll_account,
        confidence_source        = 'user_approved',
        approved_at              = now(),
        updated_at               = now();
      v_mappings_written := v_mappings_written + 1;

    ELSIF v_decision_action = 'MARK_NON_REPORTING_ACCOUNT' THEN
      -- Model B: clear ONLY the company-specific projection. company_id is
      -- always p_company_id here, never NULL — a global mapping row can
      -- never satisfy this predicate, structurally.
      DELETE FROM public.account_mappings
       WHERE company_id = p_company_id
         AND account_key = v_review_key;
      v_non_reporting_count := v_non_reporting_count + 1;
    END IF;

    INSERT INTO public.account_review_decisions (
      batch_id, company_id, upload_id, firm_member_id,
      account_code, normalized_account_name, review_account_key,
      proposal_type, decision_action, previous_value, new_value, source, reason
    ) VALUES (
      v_batch_id, p_company_id, p_upload_id, v_firm_member_id,
      v_code, v_norm_name, v_review_key,
      v_proposal_type, v_decision_action, v_previous,
      CASE WHEN v_decision_action = 'MARK_NON_REPORTING_ACCOUNT' THEN NULL ELSE v_decision END,
      v_decision->>'source', v_decision->>'reason'
    );
    v_decisions_logged := v_decisions_logged + 1;
  END LOOP;

  -- 12. Result is deterministic and describes ONLY what this transaction
  --     committed. trial_balance_uploads status is NOT touched here — that
  --     remains process-trial-balance's exclusive responsibility, invoked by
  --     the frontend only after this function returns successfully.
  v_result := jsonb_build_object(
    'batch_id', v_batch_id,
    'mappings_written', v_mappings_written,
    'decisions_logged', v_decisions_logged,
    'non_reporting_decisions_recorded', v_non_reporting_count
  );

  UPDATE public.account_review_batches SET result_summary = v_result WHERE id = v_batch_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_account_review_batch(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_account_review_batch(UUID, UUID, UUID, JSONB) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: get_effective_non_reporting_status(...)
-- Batched, authoritative professional-state reader for process-trial-balance.
-- Called via the service-role connection only — never by a browser session.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_effective_non_reporting_status(
  p_company_id UUID,
  p_accounts   JSONB   -- [{account_code, account_name}, ...]
) RETURNS TABLE (
  account_code  TEXT,
  account_name  TEXT,
  suppressed    BOOLEAN,
  stale_reason  TEXT
)
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_acct        JSONB;
  v_code        TEXT;
  v_name        TEXT;
  v_norm_name   TEXT;
  v_review_key  TEXT;
  v_latest      RECORD;
BEGIN
  FOR v_acct IN SELECT * FROM jsonb_array_elements(p_accounts)
  LOOP
    v_code := NULLIF(trim(coalesce(v_acct->>'account_code', '')), '');
    v_name := coalesce(v_acct->>'account_name', '');
    v_norm_name := lower(trim(regexp_replace(regexp_replace(
                     v_name, '[[:punct:]]', '', 'g'), '\s+', ' ', 'g')));
    v_review_key := COALESCE(v_code, v_norm_name);

    SELECT ard.decision_action, ard.normalized_account_name
      INTO v_latest
      FROM public.account_review_decisions ard
     WHERE ard.company_id = p_company_id
       AND ard.review_account_key = v_review_key
     ORDER BY ard.sequence_no DESC
     LIMIT 1;

    account_code := v_code;
    account_name := v_name;

    IF v_latest.decision_action IS DISTINCT FROM 'MARK_NON_REPORTING_ACCOUNT' THEN
      suppressed   := false;
      stale_reason := NULL;
    ELSIF v_latest.normalized_account_name = v_norm_name THEN
      suppressed   := true;                      -- no drift, inherited state effective
      stale_reason := NULL;
    ELSE
      suppressed   := false;                      -- drift detected, stale, review required
      stale_reason := 'PRIOR_NON_REPORTING_DECISION_STALE_IDENTITY_CHANGED';
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.get_effective_non_reporting_status(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_effective_non_reporting_status(UUID, JSONB) TO service_role;