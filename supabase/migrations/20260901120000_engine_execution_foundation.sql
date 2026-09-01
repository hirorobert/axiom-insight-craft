-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ PHASE 0A — ENGINE EXECUTION & IDEMPOTENCY FOUNDATION
--
-- Generic, engine-agnostic execution-control infrastructure for SAFISHA,
-- HESABU, KINGA, MAONO. Answers exactly two questions:
--   engine_runs      — "what executed?"          (reproducibility ledger)
--   idempotency_keys — "should this run again?"  (request deduplication)
--
-- NOT a workflow engine, event bus, job scheduler, domain-table replacement,
-- or second professional-decision ledger. Stores execution provenance only —
-- never accounting content itself.
--
-- Explicitly OUT OF SCOPE for this migration (see SAFF-CLAUDE-CODE-DIRECTIVE.md
-- §Phase 0A decisions for rationale):
--   - trial_balance_uploads.source_file_hash        (belongs to Phase 0)
--   - any domain-result-write + engine-run-completion atomic RPC
--     (each future domain phase provides its own narrowly-scoped one,
--     e.g. a future commit_tb_certification(...) in Phase 0)
--   - retrofitting Phase 2A (account_review_batches/decisions/*) to use
--     this infrastructure — zero modification, zero collision, by design
--   - refactoring KINGA — compatibility only, no behavior change
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: engine_runs — reproducibility ledger
-- Append-once, then EXACTLY ONE terminal transition (running→completed or
-- running→failed), then permanently immutable. This is NOT append-only like
-- Phase 2A's decision ledger — a run genuinely transitions from in-flight to
-- done, and that one transition must be representable.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.engine_runs (
  id               UUID         NOT NULL DEFAULT gen_random_uuid(),
  company_id       UUID         NOT NULL,
  firm_member_id   UUID         NULL,
  actor_type       TEXT         NOT NULL,
  function_name    TEXT         NOT NULL,
  engine_version   TEXT         NOT NULL,
  rule_version     TEXT         NULL,
  request_id       UUID         NULL,
  input_hash       TEXT         NULL,
  output_hash      TEXT         NULL,
  status           TEXT         NOT NULL DEFAULT 'running',
  started_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ  NULL,
  duration_ms      INTEGER      NULL,
  error_code       TEXT         NULL,
  error_detail     JSONB        NULL,
  period_year      INTEGER      NULL,
  source_table     TEXT         NULL,
  source_record_id UUID         NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT engine_runs_pk PRIMARY KEY (id),

  CONSTRAINT fk_er_company
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,

  CONSTRAINT fk_er_firm_member
    FOREIGN KEY (firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,

  -- Server-side actor-type/firm_member_id pairing — a caller can never set
  -- actor_type='system' merely to bypass professional attribution while
  -- still supplying a firm_member_id, nor claim 'user' without one.
  CONSTRAINT chk_er_actor_pairing
    CHECK (
      (actor_type = 'user'   AND firm_member_id IS NOT NULL) OR
      (actor_type = 'system' AND firm_member_id IS NULL)
    ),

  CONSTRAINT chk_er_actor_type
    CHECK (actor_type IN ('user', 'system')),

  CONSTRAINT chk_er_status
    CHECK (status IN ('running', 'completed', 'failed')),

  CONSTRAINT chk_er_completed_at_pairing
    CHECK (
      (status = 'running' AND completed_at IS NULL) OR
      (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
    ),

  -- output_hash only ever meaningful on a genuine success.
  CONSTRAINT chk_er_output_hash_only_on_success
    CHECK (output_hash IS NULL OR status = 'completed'),

  CONSTRAINT chk_er_period_year_sane
    CHECK (period_year IS NULL OR period_year BETWEEN 2000 AND 2100)
);

COMMENT ON TABLE public.engine_runs IS
  'Ω∞ Phase 0A: reproducibility ledger. One row per engine execution. '
  'Append-once, then exactly one terminal transition (running->completed or '
  'running->failed), enforced by trg_er_lifecycle below, then permanently '
  'immutable — no further UPDATE, no DELETE, through any application authority.';

COMMENT ON COLUMN public.engine_runs.engine_version IS
  'Deployed function''s git commit SHA at execution time (matches the '
  'existing VITE_GIT_SHA precedent in vite.config.ts) — never a deployment '
  'timestamp alone.';

COMMENT ON COLUMN public.engine_runs.rule_version IS
  'Domain-rule-set version (e.g. EvidenceLadder ruleVersion), independently '
  'maintained from engine_version — code identity and domain-rule identity '
  'are different provenance facts.';

CREATE INDEX idx_er_company_function_started
  ON public.engine_runs (company_id, function_name, started_at DESC);

CREATE INDEX idx_er_request
  ON public.engine_runs (request_id) WHERE request_id IS NOT NULL;

CREATE INDEX idx_er_source
  ON public.engine_runs (source_table, source_record_id) WHERE source_table IS NOT NULL;

CREATE INDEX idx_er_running
  ON public.engine_runs (started_at) WHERE status = 'running';

-- ── Lifecycle enforcement (DB-level, not application convention) ────────────
-- Permits EXACTLY ONE UPDATE per row: running -> completed or running ->
-- failed, touching only the terminal-transition columns. Every other UPDATE,
-- and every DELETE, is rejected.
CREATE OR REPLACE FUNCTION public.engine_runs_lifecycle_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Iron Dome: engine_runs rows cannot be deleted. [id=%]', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- TG_OP = 'UPDATE' from here.
  IF OLD.status != 'running' THEN
    RAISE EXCEPTION
      'Iron Dome: engine_runs row already reached a terminal state (%). '
      'No further update is permitted. [id=%]', OLD.status, OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION
      'Iron Dome: the only legal transition from running is to completed or '
      'failed. Attempted: %. [id=%]', NEW.status, OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- Every identity/provenance column set at creation must be unchanged.
  IF NEW.company_id       IS DISTINCT FROM OLD.company_id       OR
     NEW.firm_member_id   IS DISTINCT FROM OLD.firm_member_id   OR
     NEW.actor_type       IS DISTINCT FROM OLD.actor_type       OR
     NEW.function_name    IS DISTINCT FROM OLD.function_name    OR
     NEW.engine_version   IS DISTINCT FROM OLD.engine_version   OR
     NEW.rule_version     IS DISTINCT FROM OLD.rule_version     OR
     NEW.request_id       IS DISTINCT FROM OLD.request_id       OR
     NEW.input_hash       IS DISTINCT FROM OLD.input_hash       OR
     NEW.started_at       IS DISTINCT FROM OLD.started_at       OR
     NEW.period_year      IS DISTINCT FROM OLD.period_year      OR
     NEW.source_table     IS DISTINCT FROM OLD.source_table     OR
     NEW.source_record_id IS DISTINCT FROM OLD.source_record_id OR
     NEW.created_at       IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Iron Dome: only status/completed_at/duration_ms/output_hash/'
      'error_code/error_detail may change on the terminal transition. [id=%]',
      OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_er_lifecycle
  BEFORE UPDATE OR DELETE ON public.engine_runs
  FOR EACH ROW EXECUTE FUNCTION public.engine_runs_lifecycle_guard();

ALTER TABLE public.engine_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "er_select" ON public.engine_runs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id    = auth.uid()
         AND fm.company_id = engine_runs.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );

-- No INSERT/UPDATE/DELETE policy for authenticated at all — the only writer
-- is the service-role Edge Function connection.
REVOKE ALL ON public.engine_runs FROM PUBLIC, anon;
GRANT SELECT ON public.engine_runs TO authenticated;
GRANT ALL    ON public.engine_runs TO service_role;
REVOKE ALL ON FUNCTION public.engine_runs_lifecycle_guard() FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: idempotency_keys — request deduplication
-- reserved -> completed OR reserved -> failed. No completed->reserved, no
-- failed->reserved, no DELETE through ordinary application authority.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.idempotency_keys (
  id                UUID         NOT NULL DEFAULT gen_random_uuid(),
  company_id        UUID         NOT NULL,
  firm_member_id    UUID         NULL,
  actor_type        TEXT         NOT NULL,
  function_name     TEXT         NOT NULL,
  client_request_id UUID         NOT NULL,
  request_hash      TEXT         NOT NULL,
  input_hash        TEXT         NULL,
  status            TEXT         NOT NULL DEFAULT 'reserved',
  engine_run_id     UUID         NULL,
  -- Bounded replay envelope — see chk_ik_result_summary_bounded below.
  -- NEVER a store for full accounting content. See column comment.
  replay_result     JSONB        NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ  NULL,

  CONSTRAINT idempotency_keys_pk PRIMARY KEY (id),

  CONSTRAINT fk_ik_company
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,

  CONSTRAINT fk_ik_firm_member
    FOREIGN KEY (firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,

  CONSTRAINT fk_ik_engine_run
    FOREIGN KEY (engine_run_id) REFERENCES public.engine_runs(id) ON DELETE RESTRICT,

  CONSTRAINT chk_ik_actor_pairing
    CHECK (
      (actor_type = 'user'   AND firm_member_id IS NOT NULL) OR
      (actor_type = 'system' AND firm_member_id IS NULL)
    ),

  CONSTRAINT chk_ik_actor_type
    CHECK (actor_type IN ('user', 'system')),

  CONSTRAINT chk_ik_status
    CHECK (status IN ('reserved', 'completed', 'failed')),

  CONSTRAINT chk_ik_resolved_at_pairing
    CHECK (
      (status = 'reserved' AND resolved_at IS NULL) OR
      (status IN ('completed', 'failed') AND resolved_at IS NOT NULL)
    ),

  -- Bounded replay envelope: a small, fixed set of top-level keys only.
  -- Rejects any payload that smuggles full accounting content (a TB, a
  -- statement, raw uploaded data) into what must remain a lightweight
  -- pointer-and-status envelope. See column comment for the exact contract.
  CONSTRAINT chk_ik_replay_result_bounded
    CHECK (
      replay_result IS NULL OR (
        jsonb_typeof(replay_result) = 'object' AND
        (SELECT bool_and(key IN (
            'status', 'reference_id', 'reference_table', 'summary', 'error_code'
          ))
         FROM jsonb_object_keys(replay_result) AS key)
      )
    ),

  -- CORRECTED: firm_member_id + client_request_id: two identical SYSTEM
  -- claims (both firm_member_id IS NULL) must still collide. PostgreSQL's
  -- default UNIQUE treats NULL as distinct from NULL, which would silently
  -- let two system claims both "win". NULLS NOT DISTINCT (PG15+, already
  -- proven in this project — see uq_acct_map_company_code,
  -- 20260703100000_account_mappings_v2_and_keyword_dict.sql) closes this.
  CONSTRAINT uq_ik_claim
    UNIQUE NULLS NOT DISTINCT (company_id, firm_member_id, function_name, client_request_id)
);

COMMENT ON TABLE public.idempotency_keys IS
  'Ω∞ Phase 0A: request-deduplication claims. Answers "should this request '
  'execute again?" — a genuinely different question from engine_runs '
  '("what executed?"). Uniqueness uses NULLS NOT DISTINCT so two '
  'system-triggered (firm_member_id IS NULL) claims for the same '
  '(company_id, function_name, client_request_id) still collide correctly.';

COMMENT ON COLUMN public.idempotency_keys.replay_result IS
  'Bounded replay envelope returned verbatim to a duplicate request. '
  'Permitted top-level keys ONLY: status, reference_id, reference_table, '
  'summary (a small, deterministic, non-sensitive object), error_code. '
  'MUST NEVER contain: a full trial balance, financial statements, raw '
  'uploaded data, JWT/auth material, or an arbitrary HTTP response. '
  'Enforced structurally by chk_ik_replay_result_bounded.';

CREATE INDEX idx_ik_engine_run
  ON public.idempotency_keys (engine_run_id) WHERE engine_run_id IS NOT NULL;

CREATE INDEX idx_ik_reserved
  ON public.idempotency_keys (created_at) WHERE status = 'reserved';

-- ── Lifecycle enforcement ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.idempotency_keys_lifecycle_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Iron Dome: idempotency_keys rows cannot be deleted through ordinary '
      'application authority. [id=%]', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status != 'reserved' THEN
    RAISE EXCEPTION
      'Iron Dome: idempotency_keys row already reached a terminal state '
      '(%). No further update is permitted. [id=%]', OLD.status, OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION
      'Iron Dome: the only legal transition from reserved is to completed '
      'or failed. Attempted: %. [id=%]', NEW.status, OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.company_id        IS DISTINCT FROM OLD.company_id        OR
     NEW.firm_member_id    IS DISTINCT FROM OLD.firm_member_id    OR
     NEW.actor_type        IS DISTINCT FROM OLD.actor_type        OR
     NEW.function_name     IS DISTINCT FROM OLD.function_name     OR
     NEW.client_request_id IS DISTINCT FROM OLD.client_request_id OR
     NEW.request_hash      IS DISTINCT FROM OLD.request_hash      OR
     NEW.input_hash        IS DISTINCT FROM OLD.input_hash        OR
     NEW.created_at        IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Iron Dome: only status/engine_run_id/replay_result/resolved_at may '
      'change on the terminal transition. [id=%]', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ik_lifecycle
  BEFORE UPDATE OR DELETE ON public.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION public.idempotency_keys_lifecycle_guard();

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ik_select" ON public.idempotency_keys
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id    = auth.uid()
         AND fm.company_id = idempotency_keys.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );

REVOKE ALL ON public.idempotency_keys FROM PUBLIC, anon;
GRANT SELECT ON public.idempotency_keys TO authenticated;
GRANT ALL    ON public.idempotency_keys TO service_role;
REVOKE ALL ON FUNCTION public.idempotency_keys_lifecycle_guard() FROM PUBLIC, anon, authenticated;

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- DROP TRIGGER IF EXISTS trg_ik_lifecycle ON public.idempotency_keys;
-- DROP FUNCTION IF EXISTS public.idempotency_keys_lifecycle_guard();
-- DROP TABLE IF EXISTS public.idempotency_keys CASCADE;
-- DROP TRIGGER IF EXISTS trg_er_lifecycle ON public.engine_runs;
-- DROP FUNCTION IF EXISTS public.engine_runs_lifecycle_guard();
-- DROP TABLE IF EXISTS public.engine_runs CASCADE;
