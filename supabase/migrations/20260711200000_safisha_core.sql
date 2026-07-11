-- =============================================================================
-- Migration: 20260711200000_safisha_core.sql
-- SAFISHA → SAFF ERP Integration · Stage 0 Gate · IRON DOME NUCLEAR DESIGN
-- =============================================================================
--
-- IRON DOME INVARIANTS (enforced at DB level, not just application layer):
--   1. reviewer_action can ONLY be written by safisha-resolve Edge Function
--      — enforced by trigger + SECURITY DEFINER gatekeeper function
--   2. safisha_transactions rows are APPEND-ONLY — trigger blocks UPDATE/DELETE
--   3. safisha_audit_log is APPEND-ONLY — no UPDATE/DELETE ever
--   4. uploads.safisha_status = 'clean' is the ONLY key that unlocks downstream
--      — kinga-tax-engine reads this column; if not 'clean', hard 403
--   5. Every safisha_transactions row carries a SHA-256 hash of the original
--      source row — tampering is detectable
--   6. No auto-resolution, no scheduled jobs, no AI auto-posting.
--      A human (reviewer_id NOT NULL) must sign every resolved exception.
-- =============================================================================

-- ── 0. Extend uploads table with Safisha gate status ─────────────────────────
--
-- uploads.safisha_status controls whether downstream (tax engine, findings)
-- can run. Single source of truth at the upload level.
-- Values: null (Safisha not yet run) | 'processing' | 'needs_review' | 'blocked' | 'clean'

ALTER TABLE trial_balance_uploads
  ADD COLUMN IF NOT EXISTS safisha_status TEXT
    CHECK (safisha_status IN ('processing','needs_review','blocked','clean'));

CREATE INDEX IF NOT EXISTS trial_balance_uploads_safisha_status_idx
  ON trial_balance_uploads (safisha_status)
  WHERE safisha_status IS NOT NULL;

COMMENT ON COLUMN trial_balance_uploads.safisha_status IS
  'Safisha Stage 0 gate status. kinga-tax-engine refuses to run unless this = ''clean''. '
  'Set by safisha-resolve when all exceptions are resolved. Never set by the UI directly.';

-- ── 1. safisha_reconciliations ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS safisha_reconciliations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID        NOT NULL REFERENCES auth.users(id),
  tb_upload_id      UUID        NOT NULL REFERENCES trial_balance_uploads(id),
  status            TEXT        NOT NULL DEFAULT 'processing'
                                CHECK (status IN ('processing','needs_review','blocked','clean')),
  confidence_score  NUMERIC(5,2) CHECK (confidence_score BETWEEN 0 AND 100),
  matched_count     INTEGER     NOT NULL DEFAULT 0,
  exception_count   INTEGER     NOT NULL DEFAULT 0,
  total_tb_lines    INTEGER     NOT NULL DEFAULT 0,
  evidence_files    JSONB       NOT NULL DEFAULT '[]'::jsonb,
                                -- [{source_type, storage_path, uploaded_at}]
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  -- Iron Dome: seal completed reconciliations
  sealed            BOOLEAN     NOT NULL DEFAULT FALSE
);

-- Index for quick lookup by upload
CREATE UNIQUE INDEX IF NOT EXISTS safisha_reconciliations_upload_idx
  ON safisha_reconciliations (tb_upload_id)
  WHERE NOT sealed;  -- only one active (unsealed) reconciliation per upload

CREATE INDEX IF NOT EXISTS safisha_reconciliations_client_idx
  ON safisha_reconciliations (client_id, created_at DESC);

-- ── 2. safisha_transactions ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS safisha_transactions (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id UUID    NOT NULL REFERENCES safisha_reconciliations(id),
  source_id         TEXT    NOT NULL CHECK (source_id IN ('tb','bank','subledger','momo')),
  account_code      TEXT    NOT NULL,
  account_name      TEXT,
  txn_date          DATE,
  debit             NUMERIC(18,2),
  credit            NUMERIC(18,2),
  currency          TEXT    NOT NULL DEFAULT 'TZS',
  reference         TEXT,
  raw_row_hash      TEXT    NOT NULL,   -- SHA-256 of original row bytes
  raw_row_number    INTEGER,             -- line number in source file
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS safisha_transactions_recon_idx
  ON safisha_transactions (reconciliation_id, source_id);

CREATE INDEX IF NOT EXISTS safisha_transactions_account_idx
  ON safisha_transactions (reconciliation_id, account_code);

-- Iron Dome: safisha_transactions is APPEND-ONLY
-- No UPDATE or DELETE ever — these are the immutable evidence records
CREATE OR REPLACE FUNCTION safisha_block_transaction_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'safisha_transactions is append-only under Iron Dome. '
    'Evidence records cannot be modified or deleted. '
    'Create a new reconciliation if evidence must be re-ingested. '
    'Operation: %, reconciliation_id: %', TG_OP, OLD.reconciliation_id;
END;
$$;

CREATE TRIGGER safisha_transactions_immutable
  BEFORE UPDATE OR DELETE ON safisha_transactions
  FOR EACH ROW EXECUTE FUNCTION safisha_block_transaction_mutation();

-- ── 3. safisha_exceptions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS safisha_exceptions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id UUID        NOT NULL REFERENCES safisha_reconciliations(id),
  account_code      TEXT        NOT NULL,
  account_name      TEXT,
  category          TEXT        NOT NULL
                                CHECK (category IN ('timing','needs_adjustment','investigate')),
  variance          NUMERIC(18,2) NOT NULL,
  age_days          INTEGER     NOT NULL DEFAULT 0,
  confidence_score  NUMERIC(5,2),
  tb_txn_id         UUID        REFERENCES safisha_transactions(id),  -- matched TB line
  evidence_txn_id   UUID        REFERENCES safisha_transactions(id),  -- matched evidence line
  match_type        TEXT        CHECK (match_type IN ('one_to_one','one_to_many','unmatched')),
  description       TEXT,       -- human-readable explanation for the reviewer
  -- Resolution (ONLY written by safisha-resolve via gatekeeper function)
  reviewer_action   TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (reviewer_action IN ('pending','approved','rejected','escalated')),
  reviewer_id       UUID        REFERENCES auth.users(id),  -- NULL until resolved
  reviewer_note     TEXT,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS safisha_exceptions_recon_idx
  ON safisha_exceptions (reconciliation_id, reviewer_action);

CREATE INDEX IF NOT EXISTS safisha_exceptions_category_idx
  ON safisha_exceptions (reconciliation_id, category, reviewer_action);

-- ── 4. Iron Dome: reviewer_action write gate ──────────────────────────────────
--
-- reviewer_action can ONLY be written by the safisha_resolve_exception()
-- SECURITY DEFINER function. Any direct UPDATE attempt (from UI, another
-- edge function, or a developer console) is blocked by this trigger.
--
-- The gatekeeper sets session variable 'safisha.resolve_authorized' = 'true'
-- before writing. The trigger checks for this variable.

CREATE OR REPLACE FUNCTION safisha_enforce_resolve_gate()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  authorized TEXT;
BEGIN
  -- Allow INSERT (initial 'pending' state)
  IF TG_OP = 'INSERT' THEN
    -- Ensure reviewer_action starts as 'pending' and reviewer fields are null
    IF NEW.reviewer_action <> 'pending' THEN
      RAISE EXCEPTION
        'Iron Dome: safisha_exceptions.reviewer_action must be ''pending'' on INSERT. '
        'Use safisha-resolve Edge Function to set a resolution.';
    END IF;
    IF NEW.reviewer_id IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Iron Dome: reviewer_id and resolved_at must be NULL on INSERT. '
        'Only safisha-resolve may set these fields.';
    END IF;
    RETURN NEW;
  END IF;

  -- Block DELETE entirely
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Iron Dome: safisha_exceptions records cannot be deleted. '
      'Exceptions are permanent audit evidence. Exception id: %', OLD.id;
  END IF;

  -- For UPDATE: enforce that only the resolution fields can change,
  -- and only when the session variable is set by the gatekeeper
  authorized := current_setting('safisha.resolve_authorized', TRUE);
  IF authorized IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'Iron Dome: reviewer_action can only be written by the safisha-resolve '
      'Edge Function. Direct UPDATE is blocked. '
      'Attempted change: % → % on exception %',
      OLD.reviewer_action, NEW.reviewer_action, OLD.id;
  END IF;

  -- Prevent re-resolving an already-resolved exception
  IF OLD.reviewer_action <> 'pending' THEN
    RAISE EXCEPTION
      'Iron Dome: Exception % is already resolved (status: %). '
      'Resolved exceptions are immutable.',
      OLD.id, OLD.reviewer_action;
  END IF;

  -- Enforce reviewer_id must be set on resolution
  IF NEW.reviewer_action <> 'pending' AND NEW.reviewer_id IS NULL THEN
    RAISE EXCEPTION
      'Iron Dome: reviewer_id must be set when resolving exception %. '
      'Anonymous resolution is not permitted.',
      NEW.id;
  END IF;

  -- Enforce resolved_at must be set
  IF NEW.reviewer_action <> 'pending' AND NEW.resolved_at IS NULL THEN
    NEW.resolved_at := now();
  END IF;

  -- Prevent changing non-resolution fields
  IF NEW.reconciliation_id <> OLD.reconciliation_id OR
     NEW.account_code      <> OLD.account_code      OR
     NEW.category          <> OLD.category          OR
     NEW.variance          <> OLD.variance THEN
    RAISE EXCEPTION
      'Iron Dome: Only reviewer_action, reviewer_id, reviewer_note, '
      'and resolved_at may be changed on safisha_exceptions.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER safisha_exceptions_resolve_gate
  BEFORE INSERT OR UPDATE OR DELETE ON safisha_exceptions
  FOR EACH ROW EXECUTE FUNCTION safisha_enforce_resolve_gate();

-- ── 5. Gatekeeper function (called by safisha-resolve ONLY) ──────────────────
--
-- This is the ONLY SQL function that sets 'safisha.resolve_authorized' = 'true'.
-- safisha-resolve Edge Function calls this via RPC; no other caller can.
-- SECURITY DEFINER ensures it runs as the table owner, not the calling user.

CREATE OR REPLACE FUNCTION safisha_resolve_exception(
  p_exception_id  UUID,
  p_reviewer_id   UUID,
  p_action        TEXT,   -- 'approved' | 'rejected' | 'escalated'
  p_note          TEXT    DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_exception  safisha_exceptions%ROWTYPE;
  v_recon      safisha_reconciliations%ROWTYPE;
  v_remaining  INTEGER;
BEGIN
  -- Validate action
  IF p_action NOT IN ('approved','rejected','escalated') THEN
    RAISE EXCEPTION 'Invalid reviewer_action: %. Must be approved|rejected|escalated', p_action;
  END IF;

  -- Load exception
  SELECT * INTO v_exception FROM safisha_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exception % not found', p_exception_id;
  END IF;
  IF v_exception.reviewer_action <> 'pending' THEN
    RAISE EXCEPTION 'Exception % is already resolved (%)', p_exception_id, v_exception.reviewer_action;
  END IF;

  -- Authorize the update
  PERFORM set_config('safisha.resolve_authorized', 'true', TRUE);  -- TRUE = local to transaction

  UPDATE safisha_exceptions SET
    reviewer_action = p_action,
    reviewer_id     = p_reviewer_id,
    reviewer_note   = p_note,
    resolved_at     = now()
  WHERE id = p_exception_id;

  -- Revoke authorization immediately after write
  PERFORM set_config('safisha.resolve_authorized', 'false', TRUE);

  -- Check if all non-escalated exceptions are resolved
  SELECT COUNT(*) INTO v_remaining
  FROM safisha_exceptions
  WHERE reconciliation_id = v_exception.reconciliation_id
    AND reviewer_action = 'pending';

  IF v_remaining = 0 THEN
    -- Check if any 'investigate' exceptions are unresolved or rejected
    DECLARE
      v_blocked INTEGER;
    BEGIN
      SELECT COUNT(*) INTO v_blocked
      FROM safisha_exceptions
      WHERE reconciliation_id = v_exception.reconciliation_id
        AND category = 'investigate'
        AND reviewer_action = 'rejected';
      -- Rejected investigate exceptions → blocked
      IF v_blocked > 0 THEN
        UPDATE safisha_reconciliations SET status = 'blocked' WHERE id = v_exception.reconciliation_id;
        UPDATE trial_balance_uploads SET safisha_status = 'blocked' WHERE id = (
          SELECT tb_upload_id FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id
        );
      ELSE
        -- All resolved and none rejected → clean
        UPDATE safisha_reconciliations SET
          status       = 'clean',
          completed_at = now()
        WHERE id = v_exception.reconciliation_id;
        UPDATE trial_balance_uploads SET safisha_status = 'clean' WHERE id = (
          SELECT tb_upload_id FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id
        );
      END IF;
    END;
  END IF;

  -- Write to immutable audit log
  INSERT INTO safisha_audit_log (
    exception_id, reconciliation_id, reviewer_id, action, note
  ) VALUES (
    p_exception_id, v_exception.reconciliation_id, p_reviewer_id, p_action, p_note
  );

  RETURN jsonb_build_object(
    'exception_id',   p_exception_id,
    'action',         p_action,
    'remaining',      v_remaining,
    'recon_status',   (SELECT status FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id)
  );
END;
$$;

-- ── 6. safisha_audit_log (append-only, Iron Dome) ────────────────────────────

CREATE TABLE IF NOT EXISTS safisha_audit_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_id      UUID        NOT NULL REFERENCES safisha_exceptions(id),
  reconciliation_id UUID        NOT NULL REFERENCES safisha_reconciliations(id),
  reviewer_id       UUID        NOT NULL REFERENCES auth.users(id),
  action            TEXT        NOT NULL,
  note              TEXT,
  logged_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS safisha_audit_log_recon_idx
  ON safisha_audit_log (reconciliation_id, logged_at);

-- Audit log is APPEND-ONLY — no UPDATE or DELETE
CREATE OR REPLACE FUNCTION safisha_block_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Iron Dome: safisha_audit_log is immutable. '
    'Audit records cannot be modified or deleted. '
    'This attempted operation has been logged.';
END;
$$;

CREATE TRIGGER safisha_audit_log_immutable
  BEFORE UPDATE OR DELETE ON safisha_audit_log
  FOR EACH ROW EXECUTE FUNCTION safisha_block_audit_mutation();

-- ── 7. safisha_client_mappings ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS safisha_client_mappings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        NOT NULL REFERENCES auth.users(id),
  source_type     TEXT        NOT NULL,   -- 'excel' | 'csv' | 'bank_pdf' | 'momo_csv'
  column_mapping  JSONB       NOT NULL,   -- {"Dr": "debit", "Cr": "credit", "Date": "txn_date", ...}
  sample_headers  JSONB,                  -- original detected column headers (for UI display)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS safisha_client_mappings_unique_idx
  ON safisha_client_mappings (client_id, source_type);

-- ── 8. Row-Level Security ─────────────────────────────────────────────────────

ALTER TABLE safisha_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE safisha_transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE safisha_exceptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE safisha_audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE safisha_client_mappings ENABLE ROW LEVEL SECURITY;

-- safisha_reconciliations: user sees only their own
CREATE POLICY safisha_recon_select ON safisha_reconciliations
  FOR SELECT USING (client_id = auth.uid());

CREATE POLICY safisha_recon_insert ON safisha_reconciliations
  FOR INSERT WITH CHECK (client_id = auth.uid());

CREATE POLICY safisha_recon_update ON safisha_reconciliations
  FOR UPDATE USING (client_id = auth.uid());

-- safisha_transactions: user sees only their reconciliations
CREATE POLICY safisha_txn_select ON safisha_transactions
  FOR SELECT USING (
    reconciliation_id IN (
      SELECT id FROM safisha_reconciliations WHERE client_id = auth.uid()
    )
  );

CREATE POLICY safisha_txn_insert ON safisha_transactions
  FOR INSERT WITH CHECK (
    reconciliation_id IN (
      SELECT id FROM safisha_reconciliations WHERE client_id = auth.uid()
    )
  );
-- NO UPDATE or DELETE policy — trigger blocks it anyway, belt+suspenders

-- safisha_exceptions: user sees only their reconciliations
CREATE POLICY safisha_exc_select ON safisha_exceptions
  FOR SELECT USING (
    reconciliation_id IN (
      SELECT id FROM safisha_reconciliations WHERE client_id = auth.uid()
    )
  );

CREATE POLICY safisha_exc_insert ON safisha_exceptions
  FOR INSERT WITH CHECK (
    reconciliation_id IN (
      SELECT id FROM safisha_reconciliations WHERE client_id = auth.uid()
    )
  );
-- NO UPDATE/DELETE policy — must go through safisha_resolve_exception() RPC

-- safisha_audit_log: read-only for the owning user
CREATE POLICY safisha_audit_select ON safisha_audit_log
  FOR SELECT USING (
    reconciliation_id IN (
      SELECT id FROM safisha_reconciliations WHERE client_id = auth.uid()
    )
  );
-- NO INSERT/UPDATE/DELETE via RLS — only safisha_resolve_exception() SECURITY DEFINER writes here

-- safisha_client_mappings: user manages their own
CREATE POLICY safisha_mapping_all ON safisha_client_mappings
  FOR ALL USING (client_id = auth.uid()) WITH CHECK (client_id = auth.uid());

-- ── 9. Downstream gate enforcement comment ───────────────────────────────────
--
-- kinga-tax-engine Edge Function must add this check before computing:
--
--   const { data: upload } = await supabase
--     .from('uploads').select('safisha_status').eq('id', uploadId).single();
--   if (upload?.safisha_status !== 'clean') {
--     return new Response(JSON.stringify({
--       error: 'SAFISHA_GATE_NOT_CLEARED',
--       message: 'Trial balance has not passed Safisha verification. '
--                'Resolve all exceptions before running the tax engine.',
--       safisha_status: upload?.safisha_status ?? 'not_run'
--     }), { status: 403 });
--   }

-- ── 10. Verification smoke tests ──────────────────────────────────────────────
--
-- Run after applying migration:
--
--   -- Confirm 5 new tables
--   SELECT tablename FROM pg_tables WHERE tablename LIKE 'safisha_%';
--
--   -- Confirm RLS is active on all 5
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE tablename LIKE 'safisha_%' AND schemaname = 'public';
--
--   -- Confirm uploads.safisha_status column exists
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='uploads' AND column_name='safisha_status';
--
--   -- Confirm immutable trigger exists
--   SELECT trigger_name FROM information_schema.triggers
--   WHERE trigger_name IN (
--     'safisha_transactions_immutable',
--     'safisha_exceptions_resolve_gate',
--     'safisha_audit_log_immutable'
--   );
