-- ============================================================
-- Migration: 20260626170000 — flat_tax_tzs + audit_action extension
-- ============================================================
--
-- Scope:
--   A. Extend public.audit_action enum with 15 Kinga Phase 2 event types.
--      Rationale: the findings engine, canonical ingestion pipeline, and
--      evidence-request workflow all produce audit events not covered by
--      the 13 values currently in the enum.  Extending here (not in the
--      Phase 2 base migration) follows the pattern established by
--      20260108145353 and 20260122083339.
--
--   B. Add flat_tax_tzs NUMERIC(20,2) NULL column to statutory_rules.
--      Rationale: three existing presumptive-tax rows reuse threshold_amount
--      as a proxy for a flat TZS amount (band3_noncompliant TZS 100,000;
--      band4_noncompliant TZS 250,000; band4_compliant base TZS 90,000).
--      This is a documented semantic stretch that must be resolved before
--      the presumptive-tax findings engine module is built.  A dedicated
--      flat_tax_tzs column eliminates the ambiguity cleanly:
--        — threshold_amount remains the eligibility-ceiling column
--          (only used by presumptive_tax_threshold, rate_is_threshold = true).
--        — flat_tax_tzs carries the TZS base component for flat and compound
--          (base-plus-rate) rules.
--      The existing chk_rate_or_threshold constraint is widened to accept
--      rows whose only computable value is flat_tax_tzs.
--      A new chk_no_threshold_and_flat_tax guard prevents a row from being
--      both a threshold rule AND carrying a flat tax component.
--
-- Data mutations (fully verified with GET DIAGNOSTICS + row-count assertions):
--   3 rows updated (band3_noncompliant, band4_noncompliant, band4_compliant).
--   0 rows inserted.  0 rows deleted.
--
-- Smoke tests (run in a separate read-only transaction after applying):
--   See bottom of this file.
--
-- Prerequisites already in DB:
--   public.audit_action enum          (20260102084718 + 20260108145353 + 20260122083339)
--   public.statutory_rules table      (20260625100000)
--   active presumptive tax rows       (20260626160000)
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- SECTION A — audit_action enum extension
-- ────────────────────────────────────────────────────────────
--
-- Current enum values (13 total across three prior migrations):
--   upload_trial_balance, process_trial_balance, correct_account_mapping,
--   generate_disclosure_notes, export_statements,
--   create_company, update_company, delete_company,
--   create_account_mapping, update_account_mapping, delete_account_mapping,
--   validation_failed, validation_passed
--
-- Values added here (15 new, grouped by subsystem):

-- ── Canonical ingestion pipeline ────────────────────────────
-- Fired by the EFDMS CSV Edge Function as it transitions
-- ingestion_batches.status through its state machine.
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'canonical_ingestion_started';
  -- ingestion_batches row created (status = 'pending' → 'processing').
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'canonical_ingestion_completed';
  -- ingestion_batches.status = 'completed'; all records processed.
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'canonical_ingestion_failed';
  -- ingestion_batches.status = 'failed'; error_summary populated.

-- ── Reconciliation engine ────────────────────────────────────
-- Fired by the findings-engine Edge Function for each engine run.
-- One event per run (not one per finding — that is finding_generated below).
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'reconciliation_run';
  -- Module A (EFDMS diff) or Module B (rule trigger) engine completed a pass.
  -- metadata JSONB: {module, company_id, period_year, period_month,
  --                  findings_generated, engine_version}

-- ── Findings lifecycle ───────────────────────────────────────
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'finding_generated';
  -- Auto-generated finding inserted by the findings engine.
  -- metadata JSONB: {finding_id, finding_type, trigger_category,
  --                  exposure_amount_tzs}
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'finding_status_changed';
  -- finding.status changed (any transition: open→in_progress, etc.).
  -- metadata JSONB: {finding_id, from_status, to_status}
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'finding_disputed';
  -- Convenience alias for finding_status_changed where to_status='disputed'.
  -- Retained as a distinct value to allow precise audit log filtering.
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'finding_resolved';
  -- Convenience alias for finding_status_changed where to_status='resolved'.

-- ── Evidence request workflow ────────────────────────────────
-- Maps to evidence_requests state machine transitions.
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'evidence_requested';
  -- evidence_requests row created (current_step = 1).
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'evidence_received';
  -- evidence_requests.current_step advanced to 3 (evidence submitted).
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'response_pack_generated';
  -- Response pack PDF generated; findings.response_pack_ready set to TRUE.
  -- metadata JSONB: {finding_id, evidence_request_id, generated_at}

-- ── Governance ───────────────────────────────────────────────
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'statutory_rule_verified';
  -- statutory_rules.verified_at set (post-Presidential Assent confirmation).
  -- metadata JSONB: {rule_id, trigger_category, jurisdiction, effective_from,
  --                  rate_pct, verified_by}

-- ── Firm member management ───────────────────────────────────
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'firm_member_invited';
  -- firm_members row created; invitation email queued.
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'firm_member_accepted';
  -- Invited user accepted; firm_members.accepted_at set.
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'firm_member_removed';
  -- firm_members row soft-deleted or hard-deleted by firm owner.


-- ────────────────────────────────────────────────────────────
-- SECTION B — flat_tax_tzs column + constraint refactor
-- ────────────────────────────────────────────────────────────

-- ── B1. Add column ──────────────────────────────────────────

ALTER TABLE public.statutory_rules
  ADD COLUMN IF NOT EXISTS flat_tax_tzs NUMERIC(20,2) NULL;

COMMENT ON COLUMN public.statutory_rules.flat_tax_tzs IS
  'Fixed TZS amount component for flat-tax and compound (base-plus-rate) rules. '
  'NULL for pure-percentage rules (e.g. SDL 3.5%, VAT withholding 6%) and for '
  'eligibility-threshold rules (rate_is_threshold = true). '
  'For flat-tax-only rules (e.g. band3_noncompliant TZS 100,000): '
  '  rate_is_threshold = false, rate_pct = NULL, flat_tax_tzs = 100000.00. '
  'For compound rules (base + rate, e.g. band4_compliant TZS 90,000 + 3%): '
  '  rate_is_threshold = false, rate_pct = 3.0000, flat_tax_tzs = 90000.00. '
  'Engine contract: tax = flat_tax_tzs + (rate_pct / 100) * base_amount_tzs, '
  'where NULL components are treated as zero in the sum. '
  'Added by migration 20260626170000 to replace the semantic overloading of '
  'threshold_amount for flat-tax values (documented stretch in 20260626160000).';


-- ── B2. Widen chk_rate_or_threshold ─────────────────────────
--
-- Old: rate_is_threshold = true OR rate_pct IS NOT NULL
--   Problem: a row with rate_is_threshold = false, rate_pct = NULL,
--   flat_tax_tzs = 100000.00 would fail the old constraint even though it is
--   semantically valid (a flat-tax rule with a known computable value).
--
-- New: rate_is_threshold = true OR rate_pct IS NOT NULL OR flat_tax_tzs IS NOT NULL
--   Accepts all three encodings:
--     (1) Eligibility threshold  — rate_is_threshold = true
--     (2) Percentage rate        — rate_pct IS NOT NULL
--     (3) Flat / compound tax    — flat_tax_tzs IS NOT NULL
--
-- Pre-condition: all existing rows satisfy the new constraint before any
-- UPDATE is applied (rate_is_threshold rows still have rate_is_threshold=true;
-- the flat-tax rows being updated still have rate_is_threshold=true at this
-- point; all pure-rate rows have rate_pct IS NOT NULL).
-- The ADD CONSTRAINT below will validate existing rows and will ERROR if any
-- row does not satisfy — which is the intended guard.

ALTER TABLE public.statutory_rules
  DROP CONSTRAINT chk_rate_or_threshold;

ALTER TABLE public.statutory_rules
  ADD CONSTRAINT chk_rate_or_threshold
  CHECK (
    rate_is_threshold = true
    OR rate_pct IS NOT NULL
    OR flat_tax_tzs IS NOT NULL
  );

COMMENT ON CONSTRAINT chk_rate_or_threshold ON public.statutory_rules IS
  'Every rule row must carry at least one computable value: '
  '(1) rate_is_threshold=true (eligibility ceiling in threshold_amount), OR '
  '(2) rate_pct IS NOT NULL (percentage obligation), OR '
  '(3) flat_tax_tzs IS NOT NULL (flat or compound TZS amount). '
  'A row failing all three has no value the engine can compute.';


-- ── B3. Add guard: threshold and flat_tax_tzs are mutually exclusive ────────
--
-- A row cannot simultaneously be a threshold-eligibility rule (rate_is_threshold=true,
-- threshold_amount = the ceiling) AND carry a flat_tax_tzs component.
-- These encode completely different engine behaviors:
--   rate_is_threshold = true  → engine computes: is turnover ≤ threshold_amount?
--   flat_tax_tzs IS NOT NULL  → engine computes: tax = flat_tax_tzs + ...
-- Allowing both on the same row would create an incoherent rule the engine
-- cannot interpret without an additional disambiguation column.

ALTER TABLE public.statutory_rules
  ADD CONSTRAINT chk_no_threshold_and_flat_tax
  CHECK (rate_is_threshold = false OR flat_tax_tzs IS NULL);

COMMENT ON CONSTRAINT chk_no_threshold_and_flat_tax ON public.statutory_rules IS
  'Prevents a row from encoding both an eligibility threshold (rate_is_threshold=true) '
  'and a flat tax component (flat_tax_tzs IS NOT NULL). '
  'These are mutually exclusive engine behaviors.';


-- ── B4. Migrate flat-tax rows ────────────────────────────────
--
-- Three presumptive-tax rows previously encoded flat TZS amounts in
-- threshold_amount (with rate_is_threshold=true as the only way to satisfy
-- the old chk_rate_or_threshold when rate_pct was NULL).  Now that
-- flat_tax_tzs exists, we migrate them correctly:
--
--   band3_noncompliant:  threshold_amount=100000  → flat_tax_tzs=100000,  rate_is_threshold=false
--   band4_noncompliant:  threshold_amount=250000  → flat_tax_tzs=250000,  rate_is_threshold=false
--   band4_compliant:     threshold_amount=90000   → flat_tax_tzs=90000,   rate_is_threshold=false
--                        (rate_pct=3.0000 remains; this is the compound base+rate row)
--
-- presumptive_tax_threshold (threshold_amount=200000000) is intentionally NOT
-- changed — it is a genuine eligibility ceiling, not a tax amount.
-- rate_is_threshold=true and threshold_amount=200000000 remain correct for it.

DO $$
DECLARE
  v_affected INTEGER;
BEGIN
  -- ── band3_noncompliant ──
  UPDATE public.statutory_rules
  SET
    flat_tax_tzs      = 100000.00,
    threshold_amount  = NULL,
    rate_is_threshold = false,
    notes             = COALESCE(notes, '')
                        || ' | 2026-06-26 migration 20260626170000: moved flat '
                        || 'amount from threshold_amount to dedicated flat_tax_tzs column.'
  WHERE trigger_category = 'presumptive_tax_band3_noncompliant'
    AND jurisdiction      = 'TZ'
    AND effective_to      IS NULL
    AND rate_is_threshold = true
    AND threshold_amount  = 100000.00;

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  IF v_affected = 0 THEN
    RAISE EXCEPTION
      'ABORT: Expected to update presumptive_tax_band3_noncompliant active row '
      '(threshold_amount=100000) but found 0 matching rows. '
      'Possible causes: row was already migrated, category name changed, '
      'or threshold_amount differs from expected 100000.00.'
      USING ERRCODE = 'no_data_found';
  ELSIF v_affected > 1 THEN
    RAISE EXCEPTION
      'ABORT: Updated % rows for presumptive_tax_band3_noncompliant (expected exactly 1). '
      'Check uq_statutory_rule_active partial index for duplicate active rows.',
      v_affected
      USING ERRCODE = 'too_many_rows';
  END IF;

  RAISE NOTICE 'band3_noncompliant: migrated threshold_amount=100000 → flat_tax_tzs=100000 ✓';

  -- ── band4_noncompliant ──
  UPDATE public.statutory_rules
  SET
    flat_tax_tzs      = 250000.00,
    threshold_amount  = NULL,
    rate_is_threshold = false,
    notes             = COALESCE(notes, '')
                        || ' | 2026-06-26 migration 20260626170000: moved flat '
                        || 'amount from threshold_amount to dedicated flat_tax_tzs column.'
  WHERE trigger_category = 'presumptive_tax_band4_noncompliant'
    AND jurisdiction      = 'TZ'
    AND effective_to      IS NULL
    AND rate_is_threshold = true
    AND threshold_amount  = 250000.00;

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  IF v_affected = 0 THEN
    RAISE EXCEPTION
      'ABORT: Expected to update presumptive_tax_band4_noncompliant active row '
      '(threshold_amount=250000) but found 0 matching rows.'
      USING ERRCODE = 'no_data_found';
  ELSIF v_affected > 1 THEN
    RAISE EXCEPTION
      'ABORT: Updated % rows for presumptive_tax_band4_noncompliant (expected exactly 1).',
      v_affected
      USING ERRCODE = 'too_many_rows';
  END IF;

  RAISE NOTICE 'band4_noncompliant: migrated threshold_amount=250000 → flat_tax_tzs=250000 ✓';

  -- ── band4_compliant (compound: TZS 90,000 base + 3% of excess) ──
  -- rate_pct=3.0000 is retained; only the base component moves.
  UPDATE public.statutory_rules
  SET
    flat_tax_tzs      = 90000.00,
    threshold_amount  = NULL,
    rate_is_threshold = false,
    notes             = COALESCE(notes, '')
                        || ' | 2026-06-26 migration 20260626170000: moved base '
                        || 'TZS 90,000 from threshold_amount to flat_tax_tzs; '
                        || 'rate_pct=3.0000 retained for compound computation. '
                        || 'Engine reads: tax = flat_tax_tzs + (rate_pct/100) * (turnover - 7000000).'
  WHERE trigger_category = 'presumptive_tax_band4_compliant'
    AND jurisdiction      = 'TZ'
    AND effective_to      IS NULL
    AND rate_is_threshold = true
    AND threshold_amount  = 90000.00
    AND rate_pct          = 3.0000;

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  IF v_affected = 0 THEN
    RAISE EXCEPTION
      'ABORT: Expected to update presumptive_tax_band4_compliant active row '
      '(threshold_amount=90000, rate_pct=3.0000) but found 0 matching rows.'
      USING ERRCODE = 'no_data_found';
  ELSIF v_affected > 1 THEN
    RAISE EXCEPTION
      'ABORT: Updated % rows for presumptive_tax_band4_compliant (expected exactly 1).',
      v_affected
      USING ERRCODE = 'too_many_rows';
  END IF;

  RAISE NOTICE 'band4_compliant: migrated threshold_amount=90000 → flat_tax_tzs=90000; rate_pct=3.0000 retained ✓';

END; $$;


-- ════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES
-- Run these after applying the migration.  All must return the
-- expected results before the migration is considered clean.
-- ════════════════════════════════════════════════════════════

-- V1 — confirm new enum values are present
-- SELECT e.enumlabel FROM pg_enum e
-- JOIN pg_type t ON t.oid = e.enumtypid
-- WHERE t.typname = 'audit_action'
-- ORDER BY e.enumsortorder;
-- Expected: 28 rows (13 original + 15 new)

-- V2 — confirm flat_tax_tzs column exists with correct type
-- SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name   = 'statutory_rules'
--   AND column_name  = 'flat_tax_tzs';
-- Expected: flat_tax_tzs | numeric | 20 | 2 | YES

-- V3 — confirm new constraints exist
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.statutory_rules'::regclass
--   AND conname IN ('chk_rate_or_threshold', 'chk_no_threshold_and_flat_tax');
-- Expected: 2 rows; chk_rate_or_threshold must contain 'flat_tax_tzs IS NOT NULL'

-- V4 — verify migrated rows have correct values
-- SELECT trigger_category, rate_is_threshold, rate_pct, threshold_amount, flat_tax_tzs
-- FROM public.statutory_rules
-- WHERE trigger_category IN (
--     'presumptive_tax_band3_noncompliant',
--     'presumptive_tax_band4_noncompliant',
--     'presumptive_tax_band4_compliant',
--     'presumptive_tax_threshold'       -- must NOT change
-- )
-- AND effective_to IS NULL
-- ORDER BY trigger_category;
--
-- Expected:
--   band3_noncompliant: rate_is_threshold=false, rate_pct=NULL,    threshold_amount=NULL,  flat_tax_tzs=100000.00
--   band4_compliant:    rate_is_threshold=false, rate_pct=3.0000,  threshold_amount=NULL,  flat_tax_tzs=90000.00
--   band4_noncompliant: rate_is_threshold=false, rate_pct=NULL,    threshold_amount=NULL,  flat_tax_tzs=250000.00
--   threshold:          rate_is_threshold=true,  rate_pct=NULL,    threshold_amount=200000000.00, flat_tax_tzs=NULL

-- V5 — confirm zero rows violate either constraint
-- SELECT trigger_category, rate_is_threshold, rate_pct, threshold_amount, flat_tax_tzs
-- FROM public.statutory_rules
-- WHERE NOT (
--     rate_is_threshold = true
--     OR rate_pct IS NOT NULL
--     OR flat_tax_tzs IS NOT NULL
-- );
-- Expected: 0 rows

-- V6 — confirm zero threshold rows also carry flat_tax_tzs (mutual exclusion)
-- SELECT trigger_category, rate_is_threshold, flat_tax_tzs
-- FROM public.statutory_rules
-- WHERE rate_is_threshold = true AND flat_tax_tzs IS NOT NULL;
-- Expected: 0 rows
