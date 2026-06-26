-- ============================================================
-- Required Decision 3 — Verified statutory rule enforcement
--
-- Migration: 20260625140000_c4e8a291-6d3b-4f7e-a052-b9e1d5c7f384
-- Author: Axiom / Kinga engineering
-- Date: 2026-06-25
--
-- DEPENDENCY: public.findings must exist (created by
--   20260625100000_b3e5c891-7f4a-4d2e-9c18-a6f0d2e8b347.sql).
--   public.statutory_rules must exist (same migration).
--   Apply 20260625100000 first if it has not already been applied.
--
-- PURELY ADDITIVE. No existing table, column, index, policy, or
-- constraint is modified. One trigger function + two triggers on
-- public.findings.
--
-- ── WHY A TRIGGER, NOT RLS, NOT A CHECK CONSTRAINT ──────────────
--
-- Option A — CHECK constraint: PostgreSQL's CHECK constraint is
--   evaluated using only the values present in the row being
--   inserted or updated. It cannot perform a subquery into another
--   table. A constraint like:
--     CHECK ((SELECT verified_at FROM statutory_rules
--              WHERE id = statutory_rule_id) IS NOT NULL)
--   is syntactically illegal in PostgreSQL and will be rejected at
--   DDL time. CHECK constraints are structurally incapable of
--   enforcing cross-table invariants. Ruled out entirely.
--
-- Option B — Row Level Security (RLS WITH CHECK): RLS policies are
--   enforced for the authenticating role. The service_role key
--   bypasses ALL RLS — this is a deliberate Supabase design choice
--   to allow backend services to operate without RLS friction.
--   The findings engine will run as service_role (same pattern as
--   the EFDMS ingestion function and every SECURITY DEFINER trigger
--   in the canonical layer). An RLS WITH CHECK guard on findings
--   would provide zero protection against service_role INSERTs —
--   which is precisely the path this guard is meant to protect.
--   Ruled out: wrong enforcement layer for the real threat model.
--
-- Option C — BEFORE INSERT / BEFORE UPDATE trigger: PostgreSQL
--   triggers fire regardless of calling role. service_role, the
--   postgres superuser, an authenticated user via the PostgREST
--   layer — all of them cause triggers to fire. A trigger is the
--   only mechanism that provides uniform enforcement across all
--   callers. This matches the enforcement pattern already used for
--   append-only constraints on canonical_financial_records and
--   ingestion_batches. CHOSEN.
--
-- ── SECURITY DEFINER ANALYSIS ───────────────────────────────────
--
-- The trigger function reads statutory_rules.verified_at. Today,
-- statutory_rules has a SELECT-open-to-all-authenticated-users
-- policy. From that, SECURITY DEFINER appears unnecessary for
-- authenticated callers, and service_role bypasses RLS anyway.
--
-- However: SECURITY DEFINER is used deliberately for three reasons:
--
-- 1. Project consistency. Every integrity-enforcement trigger in
--    this codebase that performs a cross-table read is SECURITY
--    DEFINER (validate_canonical_record, create_owner_firm_member,
--    prevent_unauthorized_owner_insert, prevent_last_owner_delete,
--    prevent_last_owner_demote). The pattern is established and
--    meaningful: data-integrity triggers are definer-security so
--    they operate on the schema as designed, not as filtered by the
--    calling context.
--
-- 2. Future-proofing. If a RESTRICTIVE policy is later added to
--    statutory_rules — for example, to scope access by jurisdiction,
--    subscription tier, or firm — a non-SECURITY DEFINER trigger on
--    findings would silently start failing for authenticated callers
--    whose RLS context excludes the referenced rule. The data
--    integrity invariant must not depend on the caller's access
--    policy to the table being checked.
--
-- 3. Defense in depth. The invariant is a correctness guarantee,
--    not a user-facing access control. It must fire identically for
--    every caller. SECURITY DEFINER delivers that unconditionally.
--
-- Escalation risk: none. Trigger functions are not directly
-- callable by users. They execute only when their associated
-- trigger fires, making SECURITY DEFINER on a trigger function
-- categorically different from SECURITY DEFINER on a user-callable
-- function.
--
-- ── FINDINGS TABLE FINDING_TYPE VALUES (confirmed from schema) ───
--
-- finding_type TEXT NOT NULL
--   CHECK (finding_type IN ('efdms_diff', 'rule_trigger', 'manual'))
--
--   'rule_trigger'  — detected statutory obligation from rules engine.
--                     statutory_rule_id MUST NOT be NULL: the engine
--                     found a violation of a specific rule, and that
--                     rule must be recorded. A rule_trigger finding
--                     with no rule_id is incoherent.
--
--   'efdms_diff'    — GL vs EFDMS amount variance. statutory_rule_id
--                     MAY be NULL when the diff does not map to a
--                     specific named statutory obligation.
--
--   'manual'        — preparer-entered finding (TRA notice etc).
--                     statutory_rule_id MAY be NULL.
--
-- For ALL three types: if statutory_rule_id IS NOT NULL, the
-- referenced rule MUST have verified_at IS NOT NULL.
--
-- ── INVARIANTS ENFORCED ──────────────────────────────────────────
--
-- V1: finding_type = 'rule_trigger' → statutory_rule_id IS NOT NULL
--     (structural: a rule-trigger must name the rule that triggered)
--
-- V2: statutory_rule_id IS NOT NULL → referenced rule.verified_at
--     IS NOT NULL (correctness: findings must cite verified law)
--
-- ── CAN statutory_rule_id CHANGE POST-INSERT? ────────────────────
--
-- Yes. The UPDATE policy on findings ("Users can update findings
-- for their companies") applies no column-level restriction. No
-- trigger currently prevents a post-insert change to
-- statutory_rule_id. Therefore a BEFORE UPDATE trigger is required
-- in addition to BEFORE INSERT, scoped to fire only when
-- statutory_rule_id or finding_type actually changes.
-- ============================================================


BEGIN;


-- ════════════════════════════════════════════════════════════
-- 0.  TRIGGER FUNCTION: enforce_verified_statutory_rule
-- ════════════════════════════════════════════════════════════
--
-- Purpose:
--   Enforces two data integrity invariants on every INSERT into
--   public.findings, and on every UPDATE that changes
--   statutory_rule_id or finding_type:
--
--     V1: A 'rule_trigger' finding must always reference a
--         statutory rule (statutory_rule_id IS NOT NULL).
--
--     V2: Any finding that references a statutory rule must
--         reference a VERIFIED one (verified_at IS NOT NULL).
--
--   This is the database-layer gate that prevents the findings
--   engine from emitting compliance findings based on draft,
--   unvalidated, or conflicted statutory rates (e.g. the SDL
--   rate conflict flagged in the architecture review).
--
-- Why this mechanism:
--   CHECK constraints cannot query other tables. RLS is bypassed
--   by service_role, which is the role the findings engine runs
--   under. A BEFORE trigger fires for all roles without exception.
--   Full reasoning is in the migration header above.
--
-- SECURITY DEFINER:
--   Reads statutory_rules.verified_at. Uses SECURITY DEFINER so
--   the read is not subject to the caller's RLS context on
--   statutory_rules, insulating this invariant from future RLS
--   changes on that table. See full trace in migration header.
--
-- Error codes:
--   Both exceptions use ERRCODE 'integrity_constraint_violation'
--   (SQLSTATE 23514) — the same code Postgres uses for CHECK
--   constraint violations. Callers that catch 23514 will receive
--   this error alongside CHECK failures, which is correct: both
--   are data integrity violations. The HINT field carries
--   actionable resolution guidance.

CREATE OR REPLACE FUNCTION public.enforce_verified_statutory_rule()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule RECORD;
BEGIN

  -- ── V1: rule_trigger findings must reference a statutory rule ──
  --
  -- A finding produced by the rules engine must always record
  -- WHICH rule it triggered on. A rule_trigger finding with
  -- statutory_rule_id = NULL is incoherent — it claims a rule
  -- fired but names no rule. Block at the gate.

  IF NEW.finding_type = 'rule_trigger' AND NEW.statutory_rule_id IS NULL THEN
    RAISE EXCEPTION
      'V1 violation: findings with finding_type = ''rule_trigger'' '
      'require a non-NULL statutory_rule_id. '
      'The rules engine must record the specific statutory_rules row '
      'that produced this finding. '
      '(finding.title: %, finding.company_id: %)',
      NEW.title,
      NEW.company_id
    USING
      ERRCODE = 'integrity_constraint_violation',
      HINT    = 'Ensure the rules engine passes statutory_rule_id when '
                'inserting rule_trigger findings. If this finding does not '
                'correspond to a named statutory obligation, use '
                'finding_type = ''efdms_diff'' or ''manual'' instead.';
  END IF;


  -- ── V2: any citing finding must cite a verified rule ───────────
  --
  -- If a finding references a statutory rule, that rule must have
  -- been verified against primary statute (verified_at IS NOT NULL).
  -- This is the gate that prevents the findings engine from emitting
  -- findings grounded in unverified or conflicted rates.
  --
  -- We SELECT all diagnostic fields in one round trip so the
  -- exception message is maximally informative without a second
  -- query.

  IF NEW.statutory_rule_id IS NOT NULL THEN

    SELECT
      sr.verified_at,
      sr.trigger_category,
      sr.jurisdiction,
      sr.effective_from,
      sr.rate_pct,
      sr.threshold_amount
    INTO v_rule
    FROM public.statutory_rules sr
    WHERE sr.id = NEW.statutory_rule_id;

    -- NOT FOUND: the FK constraint on findings.statutory_rule_id
    -- will also catch this, but we raise first with a clear message.
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'V2 violation: statutory_rule_id % does not exist in '
        'statutory_rules. (finding_type: %, company_id: %)',
        NEW.statutory_rule_id,
        NEW.finding_type,
        NEW.company_id
      USING
        ERRCODE = 'integrity_constraint_violation',
        HINT    = 'Verify the statutory_rule_id passed by the rules '
                  'engine is a valid UUID from the statutory_rules table.';
    END IF;

    IF v_rule.verified_at IS NULL THEN
      RAISE EXCEPTION
        'V2 violation: statutory_rules row % has verified_at = NULL — '
        'this rule has not been verified against primary statute and '
        'may not be used as the basis for findings. '
        '(trigger_category: %, jurisdiction: %, effective_from: %, '
        'rate_pct: %, threshold_amount: %, finding_type: %, '
        'finding.company_id: %)',
        NEW.statutory_rule_id,
        v_rule.trigger_category,
        v_rule.jurisdiction,
        v_rule.effective_from,
        v_rule.rate_pct,
        v_rule.threshold_amount,
        NEW.finding_type,
        NEW.company_id
      USING
        ERRCODE = 'integrity_constraint_violation',
        HINT    = 'Set statutory_rules.verified_at to a non-NULL '
                  'timestamp once the rate has been confirmed against '
                  'the primary Finance Act text. Until then, no finding '
                  'may reference this rule.';
    END IF;

  END IF;

  RETURN NEW;

END;
$$;

COMMENT ON FUNCTION public.enforce_verified_statutory_rule() IS
  'BEFORE INSERT/UPDATE trigger on findings. '
  'V1: rule_trigger findings must have statutory_rule_id IS NOT NULL. '
  'V2: any finding referencing a statutory rule must reference a '
  'verified one (verified_at IS NOT NULL). '
  'SECURITY DEFINER: insulates the statutory_rules read from caller RLS context. '
  'Required Decision 3 — see migration 20260625140000 header for full reasoning.';


-- ════════════════════════════════════════════════════════════
-- 1.  TRIGGER: INSERT guard
-- ════════════════════════════════════════════════════════════
--
-- Fires BEFORE every INSERT on findings where the WHEN clause
-- is satisfied.
--
-- WHEN clause: skip entirely if statutory_rule_id IS NULL AND
-- finding_type != 'rule_trigger'. This covers:
--   • manual findings with no rule reference         → no check needed
--   • efdms_diff findings with no rule reference     → no check needed
-- And still fires for:
--   • rule_trigger + NULL statutory_rule_id          → V1 fires
--   • any finding_type + non-NULL statutory_rule_id  → V2 fires
--
-- This scoping eliminates trigger overhead for the majority of
-- findings that do not cite a specific statutory rule at all.

CREATE TRIGGER trg_enforce_verified_statutory_rule_insert
BEFORE INSERT ON public.findings
FOR EACH ROW
WHEN (
  NEW.statutory_rule_id IS NOT NULL
  OR NEW.finding_type = 'rule_trigger'
)
EXECUTE FUNCTION public.enforce_verified_statutory_rule();

COMMENT ON TRIGGER trg_enforce_verified_statutory_rule_insert
  ON public.findings IS
  'Required Decision 3 INSERT guard. '
  'Enforces V1 (rule_trigger needs a rule) and V2 (cited rule must be verified). '
  'WHEN clause skips the trigger entirely for null-rule non-rule-trigger inserts.';


-- ════════════════════════════════════════════════════════════
-- 2.  TRIGGER: UPDATE guard
-- ════════════════════════════════════════════════════════════
--
-- Fires BEFORE UPDATE on findings ONLY when statutory_rule_id
-- or finding_type actually changes.
--
-- statutory_rule_id CAN change post-insert (no column-level
-- immutability trigger exists; the UPDATE policy on findings
-- applies no restriction). Re-pointing a finding from one rule
-- to an unverified rule, or changing finding_type to 'rule_trigger'
-- without a rule, must be blocked.
--
-- The WHEN clause uses IS DISTINCT FROM (handles NULL correctly)
-- to avoid firing on the common UPDATE path (status changes,
-- response_pack_ready, updated_at) where neither constraint-
-- relevant column changes.

CREATE TRIGGER trg_enforce_verified_statutory_rule_update
BEFORE UPDATE ON public.findings
FOR EACH ROW
WHEN (
  NEW.statutory_rule_id IS DISTINCT FROM OLD.statutory_rule_id
  OR NEW.finding_type   IS DISTINCT FROM OLD.finding_type
)
EXECUTE FUNCTION public.enforce_verified_statutory_rule();

COMMENT ON TRIGGER trg_enforce_verified_statutory_rule_update
  ON public.findings IS
  'Required Decision 3 UPDATE guard. '
  'Same V1/V2 logic as INSERT guard. '
  'WHEN clause fires only when statutory_rule_id or finding_type changes, '
  'adding zero overhead to status/response_pack_ready/updated_at updates.';


COMMIT;


-- ============================================================
-- VERIFICATION QUERIES
-- Run these in the Supabase SQL Editor after applying this
-- migration. All four queries must return the expected results
-- before this migration is considered verified.
-- ============================================================

-- ── V1. Trigger function registered with correct attributes ───

SELECT
  p.proname                        AS func_name,
  p.prosecdef                      AS security_definer,
  l.lanname                        AS language,
  p.provolatile                    AS volatile_class  -- 'v' = VOLATILE, 's' = STABLE
FROM   pg_proc        p
JOIN   pg_language    l ON l.oid = p.prolang
WHERE  p.proname = 'enforce_verified_statutory_rule';

-- Expected:
--   func_name                        | security_definer | language | volatile_class
--   enforce_verified_statutory_rule  | true             | plpgsql  | v

-- ── V2. Both triggers registered on findings ──────────────────

SELECT
  t.trigger_name,
  t.event_manipulation        AS event,
  t.action_timing             AS timing,
  t.action_orientation        AS level
FROM   information_schema.triggers t
WHERE  t.event_object_table = 'findings'
  AND  t.trigger_name LIKE 'trg_enforce%'
ORDER  BY t.trigger_name;

-- Expected (2 rows):
--   trigger_name                                      | event  | timing | level
--   trg_enforce_verified_statutory_rule_insert        | INSERT | BEFORE | ROW
--   trg_enforce_verified_statutory_rule_update        | UPDATE | BEFORE | ROW

-- ── V3. All triggers now on findings (complete picture) ───────

SELECT
  t.trigger_name,
  t.event_manipulation        AS event,
  t.action_timing             AS timing
FROM   information_schema.triggers t
WHERE  t.event_object_table = 'findings'
ORDER  BY t.trigger_name;

-- Expected (3 rows total):
--   trg_enforce_verified_statutory_rule_insert  | INSERT | BEFORE
--   trg_enforce_verified_statutory_rule_update  | UPDATE | BEFORE
--   update_findings_updated_at                  | UPDATE | BEFORE


-- ── V4. Smoke test A — should SUCCEED ────────────────────────
--
-- finding_type = 'manual', statutory_rule_id = NULL.
-- WHEN clause prevents the trigger from firing at all.
-- Requires a real company_id from your database; substitute below.
-- This test is wrapped in BEGIN/ROLLBACK so it leaves no permanent row.
--
-- IMPORTANT: Substitute a real company_id before running.
-- Find one with: SELECT id FROM public.companies LIMIT 1;
--
-- BEGIN;
-- INSERT INTO public.findings (
--   company_id,
--   statutory_rule_id,
--   finding_type,
--   title,
--   period_start,
--   period_end,
--   exposure_amount_tzs,
--   source_detail,
--   created_by
-- )
-- VALUES (
--   '<your-company-id>',          -- substitute real UUID
--   NULL,                         -- no rule → trigger WHEN clause is false → trigger skipped
--   'manual',
--   'Smoke test A — manual, no rule, should succeed',
--   '2025-07-01',
--   '2025-09-30',
--   0.00,
--   '{"smoke_test": true}',
--   auth.uid()
-- );
-- ROLLBACK;
-- Expected: INSERT 0 1 (within BEGIN/ROLLBACK → no permanent row)


-- ── V5. Smoke test B — should FAIL (V2: unverified SDL rule) ──
--
-- References the live SDL statutory_rules row which has
-- verified_at = NULL. Must raise exception with SQLSTATE 23514.
-- The ROLLBACK at the end is a safety net; the exception itself
-- prevents the INSERT from landing.
--
-- BEGIN;
-- INSERT INTO public.findings (
--   company_id,
--   statutory_rule_id,
--   finding_type,
--   title,
--   period_start,
--   period_end,
--   exposure_amount_tzs,
--   source_detail,
--   created_by
-- )
-- SELECT
--   c.id,
--   sr.id,
--   'rule_trigger',
--   'Smoke test B — unverified rule, should FAIL',
--   '2025-07-01',
--   '2025-09-30',
--   0.00,
--   '{"smoke_test": true}',
--   auth.uid()
-- FROM
--   public.companies        c
--   CROSS JOIN public.statutory_rules sr
-- WHERE sr.trigger_category = 'sdl'
--   AND sr.verified_at      IS NULL
-- LIMIT 1;
-- ROLLBACK;
-- Expected:
--   ERROR:  V2 violation: statutory_rules row <uuid> has verified_at = NULL ...
--   DETAIL: trigger_category: sdl, jurisdiction: TZ, ...
--   SQLSTATE: 23514


-- ── V6. Smoke test C — should FAIL (V1: rule_trigger + NULL rule)

-- BEGIN;
-- INSERT INTO public.findings (
--   company_id,
--   statutory_rule_id,
--   finding_type,
--   title,
--   period_start,
--   period_end,
--   exposure_amount_tzs,
--   source_detail,
--   created_by
-- )
-- SELECT
--   c.id,
--   NULL,                     -- rule_trigger with no rule → V1 fires
--   'rule_trigger',
--   'Smoke test C — rule_trigger + NULL, should FAIL',
--   '2025-07-01',
--   '2025-09-30',
--   0.00,
--   '{"smoke_test": true}',
--   auth.uid()
-- FROM public.companies c LIMIT 1;
-- ROLLBACK;
-- Expected:
--   ERROR:  V1 violation: findings with finding_type = 'rule_trigger'
--           require a non-NULL statutory_rule_id ...
--   SQLSTATE: 23514
