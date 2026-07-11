-- 20260711200000_safisha_core.sql (verbatim)
ALTER TABLE trial_balance_uploads
  ADD COLUMN IF NOT EXISTS safisha_status TEXT
    CHECK (safisha_status IN ('processing','needs_review','blocked','clean'));

CREATE INDEX IF NOT EXISTS trial_balance_uploads_safisha_status_idx
  ON trial_balance_uploads (safisha_status)
  WHERE safisha_status IS NOT NULL;

COMMENT ON COLUMN trial_balance_uploads.safisha_status IS
  'Safisha Stage 0 gate status. kinga-tax-engine refuses to run unless this = ''clean''. Set by safisha-resolve when all exceptions are resolved. Never set by the UI directly.';

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
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  sealed            BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS safisha_reconciliations_upload_idx
  ON safisha_reconciliations (tb_upload_id)
  WHERE NOT sealed;

CREATE INDEX IF NOT EXISTS safisha_reconciliations_client_idx
  ON safisha_reconciliations (client_id, created_at DESC);

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
  raw_row_hash      TEXT    NOT NULL,
  raw_row_number    INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS safisha_transactions_recon_idx
  ON safisha_transactions (reconciliation_id, source_id);

CREATE INDEX IF NOT EXISTS safisha_transactions_account_idx
  ON safisha_transactions (reconciliation_id, account_code);

CREATE OR REPLACE FUNCTION safisha_block_transaction_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'safisha_transactions is append-only under Iron Dome. Evidence records cannot be modified or deleted. Create a new reconciliation if evidence must be re-ingested. Operation: %, reconciliation_id: %', TG_OP, OLD.reconciliation_id;
END;
$$;

DROP TRIGGER IF EXISTS safisha_transactions_immutable ON safisha_transactions;
CREATE TRIGGER safisha_transactions_immutable
  BEFORE UPDATE OR DELETE ON safisha_transactions
  FOR EACH ROW EXECUTE FUNCTION safisha_block_transaction_mutation();

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
  tb_txn_id         UUID        REFERENCES safisha_transactions(id),
  evidence_txn_id   UUID        REFERENCES safisha_transactions(id),
  match_type        TEXT        CHECK (match_type IN ('one_to_one','one_to_many','unmatched')),
  description       TEXT,
  reviewer_action   TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (reviewer_action IN ('pending','approved','rejected','escalated')),
  reviewer_id       UUID        REFERENCES auth.users(id),
  reviewer_note     TEXT,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS safisha_exceptions_recon_idx
  ON safisha_exceptions (reconciliation_id, reviewer_action);

CREATE INDEX IF NOT EXISTS safisha_exceptions_category_idx
  ON safisha_exceptions (reconciliation_id, category, reviewer_action);

CREATE OR REPLACE FUNCTION safisha_enforce_resolve_gate()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  authorized TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reviewer_action <> 'pending' THEN
      RAISE EXCEPTION
        'Iron Dome: safisha_exceptions.reviewer_action must be ''pending'' on INSERT. Use safisha-resolve Edge Function to set a resolution.';
    END IF;
    IF NEW.reviewer_id IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Iron Dome: reviewer_id and resolved_at must be NULL on INSERT. Only safisha-resolve may set these fields.';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Iron Dome: safisha_exceptions records cannot be deleted. Exceptions are permanent audit evidence. Exception id: %', OLD.id;
  END IF;

  authorized := current_setting('safisha.resolve_authorized', TRUE);
  IF authorized IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'Iron Dome: reviewer_action can only be written by the safisha-resolve Edge Function. Direct UPDATE is blocked. Attempted change: % -> % on exception %',
      OLD.reviewer_action, NEW.reviewer_action, OLD.id;
  END IF;

  IF OLD.reviewer_action <> 'pending' THEN
    RAISE EXCEPTION
      'Iron Dome: Exception % is already resolved (status: %). Resolved exceptions are immutable.',
      OLD.id, OLD.reviewer_action;
  END IF;

  IF NEW.reviewer_action <> 'pending' AND NEW.reviewer_id IS NULL THEN
    RAISE EXCEPTION
      'Iron Dome: reviewer_id must be set when resolving exception %. Anonymous resolution is not permitted.',
      NEW.id;
  END IF;

  IF NEW.reviewer_action <> 'pending' AND NEW.resolved_at IS NULL THEN
    NEW.resolved_at := now();
  END IF;

  IF NEW.reconciliation_id <> OLD.reconciliation_id OR
     NEW.account_code      <> OLD.account_code      OR
     NEW.category          <> OLD.category          OR
     NEW.variance          <> OLD.variance THEN
    RAISE EXCEPTION
      'Iron Dome: Only reviewer_action, reviewer_id, reviewer_note, and resolved_at may be changed on safisha_exceptions.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS safisha_exceptions_resolve_gate ON safisha_exceptions;
CREATE TRIGGER safisha_exceptions_resolve_gate
  BEFORE INSERT OR UPDATE OR DELETE ON safisha_exceptions
  FOR EACH ROW EXECUTE FUNCTION safisha_enforce_resolve_gate();

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

CREATE OR REPLACE FUNCTION safisha_block_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Iron Dome: safisha_audit_log is immutable. Audit records cannot be modified or deleted. This attempted operation has been logged.';
END;
$$;

DROP TRIGGER IF EXISTS safisha_audit_log_immutable ON safisha_audit_log;
CREATE TRIGGER safisha_audit_log_immutable
  BEFORE UPDATE OR DELETE ON safisha_audit_log
  FOR EACH ROW EXECUTE FUNCTION safisha_block_audit_mutation();

CREATE OR REPLACE FUNCTION safisha_resolve_exception(
  p_exception_id  UUID,
  p_reviewer_id   UUID,
  p_action        TEXT,
  p_note          TEXT    DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_exception  safisha_exceptions%ROWTYPE;
  v_remaining  INTEGER;
BEGIN
  IF p_action NOT IN ('approved','rejected','escalated') THEN
    RAISE EXCEPTION 'Invalid reviewer_action: %. Must be approved|rejected|escalated', p_action;
  END IF;

  SELECT * INTO v_exception FROM safisha_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exception % not found', p_exception_id;
  END IF;
  IF v_exception.reviewer_action <> 'pending' THEN
    RAISE EXCEPTION 'Exception % is already resolved (%)', p_exception_id, v_exception.reviewer_action;
  END IF;

  PERFORM set_config('safisha.resolve_authorized', 'true', TRUE);

  UPDATE safisha_exceptions SET
    reviewer_action = p_action,
    reviewer_id     = p_reviewer_id,
    reviewer_note   = p_note,
    resolved_at     = now()
  WHERE id = p_exception_id;

  PERFORM set_config('safisha.resolve_authorized', 'false', TRUE);

  SELECT COUNT(*) INTO v_remaining
  FROM safisha_exceptions
  WHERE reconciliation_id = v_exception.reconciliation_id
    AND reviewer_action = 'pending';

  IF v_remaining = 0 THEN
    DECLARE
      v_blocked INTEGER;
    BEGIN
      SELECT COUNT(*) INTO v_blocked
      FROM safisha_exceptions
      WHERE reconciliation_id = v_exception.reconciliation_id
        AND category = 'investigate'
        AND reviewer_action = 'rejected';
      IF v_blocked > 0 THEN
        UPDATE safisha_reconciliations SET status = 'blocked' WHERE id = v_exception.reconciliation_id;
        UPDATE trial_balance_uploads SET safisha_status = 'blocked' WHERE id = (
          SELECT tb_upload_id FROM safisha_reconciliations WHERE id = v_exception.reconciliation_id
        );
      ELSE
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

CREATE TABLE IF NOT EXISTS safisha_client_mappings (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        NOT NULL REFERENCES auth.users(id),
  source_type     TEXT        NOT NULL,
  column_mapping  JSONB       NOT NULL,
  sample_headers  JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS safisha_client_mappings_unique_idx
  ON safisha_client_mappings (client_id, source_type);

GRANT SELECT, INSERT, UPDATE ON safisha_reconciliations TO authenticated;
GRANT ALL ON safisha_reconciliations TO service_role;
GRANT SELECT, INSERT ON safisha_transactions TO authenticated;
GRANT ALL ON safisha_transactions TO service_role;
GRANT SELECT, INSERT, UPDATE ON safisha_exceptions TO authenticated;
GRANT ALL ON safisha_exceptions TO service_role;
GRANT SELECT ON safisha_audit_log TO authenticated;
GRANT ALL ON safisha_audit_log TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON safisha_client_mappings TO authenticated;
GRANT ALL ON safisha_client_mappings TO service_role;

ALTER TABLE safisha_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE safisha_transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE safisha_exceptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE safisha_audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE safisha_client_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY safisha_recon_select ON safisha_reconciliations
  FOR SELECT USING (client_id = auth.uid());
CREATE POLICY safisha_recon_insert ON safisha_reconciliations
  FOR INSERT WITH CHECK (client_id = auth.uid());
CREATE POLICY safisha_recon_update ON safisha_reconciliations
  FOR UPDATE USING (client_id = auth.uid());

CREATE POLICY safisha_txn_select ON safisha_transactions
  FOR SELECT USING (
    reconciliation_id IN (SELECT id FROM safisha_reconciliations WHERE client_id = auth.uid())
  );
CREATE POLICY safisha_txn_insert ON safisha_transactions
  FOR INSERT WITH CHECK (
    reconciliation_id IN (SELECT id FROM safisha_reconciliations WHERE client_id = auth.uid())
  );

CREATE POLICY safisha_exc_select ON safisha_exceptions
  FOR SELECT USING (
    reconciliation_id IN (SELECT id FROM safisha_reconciliations WHERE client_id = auth.uid())
  );
CREATE POLICY safisha_exc_insert ON safisha_exceptions
  FOR INSERT WITH CHECK (
    reconciliation_id IN (SELECT id FROM safisha_reconciliations WHERE client_id = auth.uid())
  );

CREATE POLICY safisha_audit_select ON safisha_audit_log
  FOR SELECT USING (
    reconciliation_id IN (SELECT id FROM safisha_reconciliations WHERE client_id = auth.uid())
  );

CREATE POLICY safisha_mapping_all ON safisha_client_mappings
  FOR ALL USING (client_id = auth.uid()) WITH CHECK (client_id = auth.uid());