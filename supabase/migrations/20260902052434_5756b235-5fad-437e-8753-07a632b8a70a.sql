-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ PHASE 0A — ENGINE EXECUTION & IDEMPOTENCY FOUNDATION (HARDENED)
--
-- Generic, engine-agnostic execution-control infrastructure for SAFISHA,
-- HESABU, KINGA, MAONO. Answers exactly two questions:
--   engine_runs      — "what executed?"          (reproducibility ledger)
--   idempotency_keys — "should this run again?"  (request deduplication)
--
-- Hardening corrections applied in this revision (Phase 0A-1R gate):
--   1. chk_ik_replay_result_bounded / chk_er_error_detail_bounded rewritten
--      to be subquery-free (jsonb - text[] set-difference), since
--      PostgreSQL CHECK constraints cannot contain subqueries at all —
--      the prior revision's SELECT/jsonb_object_keys form was invalid DDL.
--   2. idempotency_keys.engine_run_id is now bound EXACTLY ONCE, at the
--      same INSERT that creates the reservation (the engine_runs row is
--      created first, in the same claim call) — never a later UPDATE while
--      status='reserved'. This removes any need for a special-cased
--      "reserved, still reserved" transition and keeps the lifecycle
--      trigger's rule to exactly one thing: reserved -> terminal, nothing
--      else, ever.
--   3. Both lifecycle trigger functions changed from SECURITY DEFINER to
--      the default (SECURITY INVOKER) — they only inspect OLD/NEW and
--      RAISE/RETURN, never touching another table, so there is no real
--      privilege gap to bridge. search_path remains pinned regardless.
--   4. EXECUTE explicitly revoked from service_role too on both trigger
--      functions (harmless and clarifying — trigger firing never requires
--      direct EXECUTE privilege from the invoking role in the first place).
--
-- NOT a workflow engine, event bus, job scheduler, domain-table replacement,
-- or second professional-decision ledger. Stores execution provenance only.
--
-- Explicitly OUT OF SCOPE for this migration:
--   - trial_balance_uploads.source_file_hash        (belongs to Phase 0)
--   - any domain-result-write + engine-run-completion atomic RPC
--   - retrofitting Phase 2A (account_review_batches/decisions/*)
--   - refactoring KINGA
--   - altering firm_members (a composite (id, company_id) unique index +
--     FK would let engine_runs/idempotency_keys enforce firm_member_id
--     genuinely belongs to company_id at the DB level, but firm_members is
--     an existing table this migration must not touch — see the
--     "residual trust boundary" note on resolveFirmMemberActor below)
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: engine_runs — reproducibility ledger
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
  -- Bounded structured error envelope — see chk_er_error_detail_bounded.
  -- Permitted keys ONLY: stage, safe_message, reference_id. NEVER a raw
  -- Error object, stack trace, request body, JWT, or service-role secret.
  error_detail     JSONB        NULL,
  period_year      INTEGER      NULL,
  source_table     TEXT         NULL,
  source_record_id UUID         NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT engine_runs_pk PRIMARY KEY (id),

  CONSTRAINT fk_er_company
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Residual trust boundary (documented, not silently claimed as DB-proven):
  -- this FK confirms firm_member_id references a REAL firm_members row, but
  -- does NOT prove that row's company_id equals THIS row's company_id — that
  -- would require a composite (id, company_id) unique index on firm_members
  -- plus a composite FK here, which would mean altering firm_members, out of
  -- scope for this migration. The only current guarantee that the pairing is
  -- correct is that every caller MUST obtain (firmMemberId, companyId)
  -- together from resolveFirmMemberActor()'s single return value — never
  -- assembled from two different sources. See _shared/actor.ts.
  CONSTRAINT fk_er_firm_member
    FOREIGN KEY (firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,

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

  CONSTRAINT chk_er_output_hash_only_on_success
    CHECK (output_hash IS NULL OR status = 'completed'),

  CONSTRAINT chk_er_period_year_sane
    CHECK (period_year IS NULL OR period_year BETWEEN 2000 AND 2100),

  -- CORRECTED (Phase 0A-1R): subquery-free. jsonb - text[] removes every
  -- permitted key; if what remains is the empty object, only permitted keys
  -- were present. jsonb_typeof rejects arrays/scalars. pg_column_size bounds
  -- the payload so this can never become a dump of arbitrary content.
  CONSTRAINT chk_er_error_detail_bounded
    CHECK (
      error_detail IS NULL OR (
        jsonb_typeof(error_detail) = 'object' AND
        (error_detail - ARRAY['stage', 'safe_message', 'reference_id']::text[]) = '{}'::jsonb AND
        pg_column_size(error_detail) <= 2048
      )
    )
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

COMMENT ON COLUMN public.engine_runs.error_detail IS
  'Bounded structured error envelope. Permitted top-level keys ONLY: stage, '
  'safe_message, reference_id. error_code (a sibling column) already carries '
  'the machine-readable code — do not duplicate it here. NEVER a raw '
  'exception object, stack trace, request body, JWT, or secret. Enforced by '
  'chk_er_error_detail_bounded, not documentation alone.';

CREATE INDEX idx_er_company_function_started
  ON public.engine_runs (company_id, function_name, started_at DESC);

CREATE INDEX idx_er_request
  ON public.engine_runs (request_id) WHERE request_id IS NOT NULL;

CREATE INDEX idx_er_source
  ON public.engine_runs (source_table, source_record_id) WHERE source_table IS NOT NULL;

CREATE INDEX idx_er_running
  ON public.engine_runs (started_at) WHERE status = 'running';

-- ── Lifecycle enforcement ────────────────────────────────────────────────────
-- CORRECTED (Phase 0A-1R): default SECURITY INVOKER — this function only
-- ever reads OLD/NEW (already supplied by the firing statement) and either
-- RAISEs or RETURNs. It never queries another table, so there is no
-- privilege gap for SECURITY DEFINER to bridge. search_path is still pinned
-- as a general hardening practice, independent of the DEFINER/INVOKER choice.
CREATE OR REPLACE FUNCTION public.engine_runs_lifecycle_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Iron Dome: engine_runs rows cannot be deleted. [id=%]', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

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

REVOKE ALL ON public.engine_runs FROM PUBLIC, anon;
GRANT SELECT ON public.engine_runs TO authenticated;
GRANT ALL    ON public.engine_runs TO service_role;
-- Trigger functions are invoked by the firing mechanism, never called
-- directly by any session — no role, including service_role, needs EXECUTE.
REVOKE ALL ON FUNCTION public.engine_runs_lifecycle_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: idempotency_keys — request deduplication
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
  -- CORRECTED (Phase 0A-1R): NOT NULL. The engine_runs row is now always
  -- created FIRST, in the same claim call, and its id supplied in THIS
  -- INSERT — never bound by a later UPDATE while status='reserved'. See
  -- _shared/idempotency.ts claimIdempotency().
  engine_run_id     UUID         NOT NULL,
  -- Bounded replay envelope — see chk_ik_replay_result_bounded. NEVER a
  -- store for full accounting content.
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

  -- CORRECTED (Phase 0A-1R): subquery-free, same technique as
  -- chk_er_error_detail_bounded. Permitted keys match ReplayResult exactly
  -- (_shared/idempotency.ts): status, reference_id, reference_table,
  -- summary, error_code.
  CONSTRAINT chk_ik_replay_result_bounded
    CHECK (
      replay_result IS NULL OR (
        jsonb_typeof(replay_result) = 'object' AND
        (replay_result - ARRAY['status', 'reference_id', 'reference_table', 'summary', 'error_code']::text[]) = '{}'::jsonb AND
        pg_column_size(replay_result) <= 2048
      )
    ),

  -- System-actor uniqueness correction (Phase 0A design gate): plain UNIQUE
  -- treats NULL as distinct from NULL, which would silently let two
  -- system-triggered (firm_member_id IS NULL) claims both "win" for the
  -- same (company_id, function_name, client_request_id). NULLS NOT DISTINCT
  -- (PG15+, already proven live in this project — see
  -- uq_acct_map_company_code, 20260703100000) closes this gap.
  CONSTRAINT uq_ik_claim
    UNIQUE NULLS NOT DISTINCT (company_id, firm_member_id, function_name, client_request_id)
);

COMMENT ON TABLE public.idempotency_keys IS
  'Ω∞ Phase 0A: request-deduplication claims. Answers "should this request '
  'execute again?" — a genuinely different question from engine_runs '
  '("what executed?"). Uniqueness uses NULLS NOT DISTINCT so two '
  'system-triggered (firm_member_id IS NULL) claims for the same '
  '(company_id, function_name, client_request_id) still collide correctly. '
  'engine_run_id is bound exactly once, at claim time — never mutated.';

COMMENT ON COLUMN public.idempotency_keys.replay_result IS
  'Bounded replay envelope returned verbatim to a duplicate request. '
  'Permitted top-level keys ONLY: status, reference_id, reference_table, '
  'summary (a small, deterministic, non-sensitive object), error_code. '
  'MUST NEVER contain a full trial balance, financial statements, raw '
  'uploaded data, or JWT/auth material. Enforced structurally by '
  'chk_ik_replay_result_bounded, not documentation alone.';

CREATE INDEX idx_ik_engine_run
  ON public.idempotency_keys (engine_run_id);

CREATE INDEX idx_ik_reserved
  ON public.idempotency_keys (created_at) WHERE status = 'reserved';

-- ── Lifecycle enforcement ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.idempotency_keys_lifecycle_guard()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
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

  -- CORRECTED (Phase 0A-1R): engine_run_id is now permanently fixed at
  -- creation, so it is REMOVED from the set of columns permitted to change
  -- during the terminal transition — only status/replay_result/resolved_at
  -- may change. Any attempt to rebind engine_run_id, ever, is rejected.
  IF NEW.company_id        IS DISTINCT FROM OLD.company_id        OR
     NEW.firm_member_id    IS DISTINCT FROM OLD.firm_member_id    OR
     NEW.actor_type        IS DISTINCT FROM OLD.actor_type        OR
     NEW.function_name     IS DISTINCT FROM OLD.function_name     OR
     NEW.client_request_id IS DISTINCT FROM OLD.client_request_id OR
     NEW.request_hash      IS DISTINCT FROM OLD.request_hash      OR
     NEW.input_hash        IS DISTINCT FROM OLD.input_hash        OR
     NEW.engine_run_id     IS DISTINCT FROM OLD.engine_run_id     OR
     NEW.created_at        IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Iron Dome: only status/replay_result/resolved_at may change on the '
      'terminal transition. engine_run_id is immutable once bound. [id=%]',
      OLD.id
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
REVOKE ALL ON FUNCTION public.idempotency_keys_lifecycle_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- DROP TRIGGER IF EXISTS trg_ik_lifecycle ON public.idempotency_keys;
-- DROP FUNCTION IF EXISTS public.idempotency_keys_lifecycle_guard();
-- DROP TABLE IF EXISTS public.idempotency_keys CASCADE;
-- DROP TRIGGER IF EXISTS trg_er_lifecycle ON public.engine_runs;
-- DROP FUNCTION IF EXISTS public.engine_runs_lifecycle_guard();
-- DROP TABLE IF EXISTS public.engine_runs CASCADE;