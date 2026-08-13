-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ DEFECT-CLASSIFICATION-PROVENANCE-001 — RESOLUTION
--
-- DEFECT: audit_status = 'user_approved_current' collapses two distinct
-- professional acts into one value:
--    (a) a human classified the account themselves  (original judgement)
--    (b) a human accepted the machine's suggestion  (review of a proposal)
-- These are NOT the same audit evidence. Review and any TRA challenge turns
-- on who exercised judgement and WHAT THEY WERE LOOKING AT when they did.
-- Because this ledger is append-only, an ambiguous row is unrepairable
-- forever — so the split lands now, while live history is ~zero.
--
-- confirmed_by remains the single deciding-actor column (firm_members.id,
-- the canonical actor identity). No second actor column is introduced:
-- one book, one truth.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ── 1. Provenance columns ────────────────────────────────────────────────────
ALTER TABLE public.account_mapping_memory
  ADD COLUMN IF NOT EXISTS decision_kind    TEXT  NULL,
  ADD COLUMN IF NOT EXISTS suggestion_shown JSONB NULL;

COMMENT ON COLUMN public.account_mapping_memory.decision_kind IS
  'How the decision was reached. MACHINE_RULE = no human in the loop. '
  'ORIGINAL_JUDGEMENT = the professional classified it with no suggestion on '
  'screen. ACCEPTED_SUGGESTION = the professional agreed with the machine''s '
  'proposal. OVERRODE_SUGGESTION = the professional replaced it. Never infer '
  'this from audit_status — audit_status records standing, decision_kind '
  'records the act.';

COMMENT ON COLUMN public.account_mapping_memory.suggestion_shown IS
  'The machine proposal that was visible at the moment of decision, verbatim: '
  '{presentation_code, account_nature, note_code, cash_flow_class, rule_id, '
  'rule_version, confidence}. NULL only when nothing was suggested. This is '
  'what makes an ACCEPTED_SUGGESTION reviewable years later.';

-- ── 2. Vocabulary constraint ─────────────────────────────────────────────────
-- NOT VALID: the ledger is append-only and pre-existing rows (written before
-- this column existed) cannot be updated to satisfy it. New rows are enforced.
ALTER TABLE public.account_mapping_memory
  ADD CONSTRAINT amm_decision_kind_vocabulary
  CHECK (
    decision_kind IS NULL
    OR decision_kind IN (
      'MACHINE_RULE', 'ORIGINAL_JUDGEMENT',
      'ACCEPTED_SUGGESTION', 'OVERRODE_SUGGESTION'
    )
  ) NOT VALID;

-- ── 3. Coherence constraints ─────────────────────────────────────────────────
-- A human decision must say which kind of act it was.
ALTER TABLE public.account_mapping_memory
  ADD CONSTRAINT amm_human_decision_declares_kind
  CHECK (
    audit_status = 'system_rule'
    OR decision_kind IS NOT NULL
  ) NOT VALID;

-- Accepting or overriding a suggestion requires the suggestion on record;
-- an original judgement asserts that none was shown.
ALTER TABLE public.account_mapping_memory
  ADD CONSTRAINT amm_suggestion_evidence_matches_kind
  CHECK (
    decision_kind IS NULL
    OR (decision_kind IN ('ACCEPTED_SUGGESTION', 'OVERRODE_SUGGESTION')
        AND suggestion_shown IS NOT NULL)
    OR (decision_kind = 'ORIGINAL_JUDGEMENT' AND suggestion_shown IS NULL)
    OR (decision_kind = 'MACHINE_RULE')
  ) NOT VALID;

-- A machine row has no deciding professional; a human row must have one
-- (already enforced for audited rows — this closes the mirror case).
ALTER TABLE public.account_mapping_memory
  ADD CONSTRAINT amm_machine_rule_has_no_human_actor
  CHECK (
    decision_kind IS DISTINCT FROM 'MACHINE_RULE'
    OR confirmed_by IS NULL
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_amm_decision_kind
  ON public.account_mapping_memory (company_id, effective_period_year, decision_kind)
  WHERE decision_kind IS NOT NULL;

-- ── 4. Rebuild the helper view so the new provenance is readable ─────────────
-- (SELECT * fixes its column list at creation time, so DROP + CREATE is
--  required; security_invoker is re-asserted immediately.)
DROP VIEW IF EXISTS public.v_latest_account_mapping_memory;

CREATE VIEW public.v_latest_account_mapping_memory AS
  SELECT DISTINCT ON (company_id, natural_account_code, effective_period_year)
    *
  FROM public.account_mapping_memory
  WHERE natural_account_code IS NOT NULL
  ORDER BY company_id, natural_account_code, effective_period_year, created_at DESC;

ALTER VIEW public.v_latest_account_mapping_memory SET (security_invoker = on);

REVOKE ALL  ON public.v_latest_account_mapping_memory FROM anon;
GRANT SELECT ON public.v_latest_account_mapping_memory TO authenticated;
GRANT ALL    ON public.v_latest_account_mapping_memory TO service_role;

COMMENT ON VIEW public.v_latest_account_mapping_memory IS
  'Most recent confirmation per (company, natural_account_code, period) — '
  'consumers read this view, never account_mapping_memory directly, so a '
  'superseding row always wins without any row ever being deleted or updated. '
  'security_invoker=on is mandatory: without it the view runs with its '
  'postgres owner''s privileges and silently bypasses base-table RLS (real '
  'incident in this project, found by live anon-key testing). Carries '
  'decision_kind + suggestion_shown as of this migration.';
