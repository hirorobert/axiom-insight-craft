-- 20261005100000_safisha_ingestion_authority.sql
--
-- Evidence ingestion becomes one authoritative, serialized database operation. Found by scripts/db-proof/safishaIngestion.mjs
-- running main's safisha-ingest handler against disposable PostgreSQL:
--   · creating a reconciliation always failed: the handler inserted it WITH RETURNING, and the reconciliation SELECT
--     policy (safisha_recon_company_scoped(id)) cannot see the row inside its own INSERT statement — every first ingest
--     answered 500 "new row violates row-level security policy";
--   · the upload's safisha_status was set only when the handler itself created the reconciliation, with an unchecked
--     UPDATE: a retry after a partial failure, or a preparer (no upload UPDATE policy: a silent 0-row update), left it NULL;
--   · deduplication was read-then-insert: 8 simultaneous identical ingests of a 3-row file wrote 24 rows and 8 evidence
--     entries, permanently (transactions are append-only);
--   · identity was the hash of the row's cells alone: a legitimately repeated line in one statement was dropped, and a row
--     of one source silently suppressed an identical row of another source.
--
-- Row identity (this migration's definition). A stored source row is identified by
--     (reconciliation_id, source_id, raw_row_hash, row_occurrence)
-- where raw_row_hash is the SHA-256 of the row's cells (unchanged) and row_occurrence is the k-th time that exact row
-- appears WITHIN ONE ingested file (k = 1, 2, …, in file order). Consequences:
--   · retrying or re-uploading the same file adds nothing (its rows and occurrences already exist);
--   · a line that legitimately appears twice in one statement is stored twice (multiplicity preserved);
--   · sources never collide (source_id is part of the identity);
--   · a later file overlapping an earlier one adds a shared row once; a file containing MORE copies of a row than any
--     earlier file adds only the extra copies (per row, the stored count is the largest count seen in any one file);
--   · provenance: every row stored from now on records source_file_sha256 (the SHA-256 of the file it came from) next to
--     its existing raw_row_number.
--   Limit: two different files that each contain a separate, cell-for-cell identical transaction (same date, amount,
--   reference, every column) are indistinguishable from an overlap and are stored once.
-- Rows stored before this migration keep row_occurrence and source_file_sha256 NULL (history is not rewritten); they count
-- toward the occurrences already present, and the uniqueness index covers only rows with an occurrence, so existing
-- duplicates can neither block this migration nor be multiplied further.
--
-- One path: safisha_ingest_evidence(upload, actor, source_type, file_name, file_sha256, rows) — service-role only, called
-- by safisha-ingest with the actor from the verified JWT. In one transaction it serializes on the upload, authorizes the
-- actor (current plan + prepare_close; a personal workspace: its owner), finds or creates the upload's one unsealed
-- reconciliation, guarantees the upload's safisha_status is started (verified, not assumed), records only the rows not
-- already present, and records the evidence file once per (source, file SHA-256). Client roles can no longer insert
-- transactions directly.
--
-- Additive and forward-only: two nullable columns, one partial unique index, one function, one trigger. No row is
-- changed or removed. Replay-safe (IF NOT EXISTS / CREATE OR REPLACE / trigger dropped and recreated by name).

-- ── 1. Provenance and identity ──────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.safisha_transactions
  ADD COLUMN IF NOT EXISTS row_occurrence integer
    CONSTRAINT safisha_transactions_row_occurrence_check CHECK (row_occurrence >= 1),
  ADD COLUMN IF NOT EXISTS source_file_sha256 text
    CONSTRAINT safisha_transactions_source_file_sha256_check CHECK (source_file_sha256 ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS safisha_transactions_source_row_identity
  ON public.safisha_transactions (reconciliation_id, source_id, raw_row_hash, row_occurrence)
  WHERE row_occurrence IS NOT NULL;

-- ── 2. The ingestion ────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.safisha_ingest_evidence(
  p_upload_id   uuid,
  p_actor       uuid,
  p_source_type text,
  p_file_name   text,
  p_file_sha256 text,
  p_rows        jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company   uuid;
  v_account   uuid;
  v_recon     uuid;
  v_created   boolean := false;
  v_status    text;
  v_n         integer;
  v_inserted  integer := 0;
  v_total     integer;
BEGIN
  IF p_upload_id IS NULL OR p_actor IS NULL
     OR p_source_type IS NULL OR p_source_type NOT IN ('tb', 'bank', 'subledger', 'momo')
     OR p_file_name IS NULL OR length(p_file_name) NOT BETWEEN 1 AND 255 OR p_file_name ~ '[[:cntrl:]]'
     OR p_file_sha256 IS NULL OR p_file_sha256 !~ '^[0-9a-f]{64}$'
     OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_EVIDENCE: source, file name, file SHA-256 and a row array are required' USING ERRCODE = '22023';
  END IF;

  -- Serialize every ingestion into this upload (one at a time; others wait and then see what it stored).
  PERFORM pg_advisory_xact_lock(hashtextextended('safisha_ingest_evidence:' || p_upload_id::text, 0));

  SELECT u.company_id, COALESCE(c.user_id, u.user_id) INTO v_company, v_account
    FROM public.trial_balance_uploads u LEFT JOIN public.companies c ON c.id = u.company_id
   WHERE u.id = p_upload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UPLOAD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public._account_has_current_plan(v_account) THEN
    RAISE EXCEPTION 'RECONCILIATION_READ_ONLY' USING ERRCODE = 'PT402', DETAIL = 'CLOSE_ASSURANCE', HINT = 'NO_PLAN';
  END IF;
  IF (v_company IS NOT NULL AND NOT public.workspace_capability_allowed(v_company, p_actor, 'prepare_close'))
     OR (v_company IS NULL AND p_actor IS DISTINCT FROM v_account) THEN
    RAISE EXCEPTION 'CAPABILITY_REQUIRED: evidence ingestion needs prepare_close in this workspace' USING ERRCODE = '42501';
  END IF;

  -- Every row must be complete before anything is stored (the call is all-or-nothing).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) e
     WHERE jsonb_typeof(e) <> 'object'
        OR COALESCE(e->>'raw_row_hash', '') !~ '^[0-9a-f]{64}$'
        OR COALESCE(e->>'account_code', '') = ''
        OR COALESCE(e->>'raw_row_number', '') !~ '^[1-9][0-9]{0,8}$'
        OR (e->>'txn_date' IS NOT NULL AND e->>'txn_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
        OR (e->>'debit'  IS NOT NULL AND e->>'debit'  !~ '^-?[0-9]+(\.[0-9]+)?$')
        OR (e->>'credit' IS NOT NULL AND e->>'credit' !~ '^-?[0-9]+(\.[0-9]+)?$')) THEN
    RAISE EXCEPTION 'INVALID_EVIDENCE: a row is incomplete or malformed' USING ERRCODE = '22023';
  END IF;

  -- The upload's one unsealed reconciliation (created here when absent; a concurrent creator elsewhere is tolerated).
  SELECT id INTO v_recon FROM public.safisha_reconciliations WHERE tb_upload_id = p_upload_id AND NOT sealed;
  IF NOT FOUND THEN
    INSERT INTO public.safisha_reconciliations (client_id, tb_upload_id, status)
    VALUES (p_actor, p_upload_id, 'processing')
    ON CONFLICT (tb_upload_id) WHERE NOT sealed DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_created := v_n = 1;
    SELECT id INTO v_recon FROM public.safisha_reconciliations WHERE tb_upload_id = p_upload_id AND NOT sealed;
  END IF;
  -- Lock order: the reconciliation, then the upload (as matching and decisions do).
  PERFORM 1 FROM public.safisha_reconciliations WHERE id = v_recon FOR UPDATE;

  -- The upload's reconciliation status is started — verified by the row count, on every call, so a retry completes a
  -- status a previous attempt never set.
  SELECT safisha_status INTO v_status FROM public.trial_balance_uploads WHERE id = p_upload_id;
  IF v_status IS NULL THEN
    UPDATE public.trial_balance_uploads SET safisha_status = 'processing' WHERE id = p_upload_id AND safisha_status IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'UPLOAD_STATUS_NOT_RECORDED' USING ERRCODE = '40001';
    END IF;
    v_status := 'processing';
  END IF;

  -- Only the rows not already present (see the identity definition above).
  WITH payload AS (
    SELECT e, ord FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS x(e, ord)
  ), numbered AS (
    SELECT e, ord, row_number() OVER (PARTITION BY e->>'raw_row_hash' ORDER BY ord)::integer AS occurrence FROM payload
  ), present AS (
    SELECT raw_row_hash, count(*)::integer AS n FROM public.safisha_transactions
     WHERE reconciliation_id = v_recon AND source_id = p_source_type GROUP BY raw_row_hash
  ), ins AS (
    INSERT INTO public.safisha_transactions (reconciliation_id, source_id, account_code, account_name, txn_date, debit, credit,
                                             currency, reference, raw_row_hash, raw_row_number, dqc_polarity_warning,
                                             dqc_sign_detail, row_occurrence, source_file_sha256)
    SELECT v_recon, p_source_type, n.e->>'account_code', n.e->>'account_name', (n.e->>'txn_date')::date,
           (n.e->>'debit')::numeric, (n.e->>'credit')::numeric, COALESCE(NULLIF(n.e->>'currency', ''), 'TZS'), n.e->>'reference',
           n.e->>'raw_row_hash', (n.e->>'raw_row_number')::integer, COALESCE((n.e->>'dqc_polarity_warning')::boolean, false),
           n.e->>'dqc_sign_detail', n.occurrence, p_file_sha256
      FROM numbered n LEFT JOIN present p ON p.raw_row_hash = n.e->>'raw_row_hash'
     WHERE n.occurrence > COALESCE(p.n, 0)
     ORDER BY n.ord
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_inserted FROM ins;

  -- The evidence file, once per (source, file SHA-256).
  v_total := jsonb_array_length(p_rows);
  IF v_total > 0 AND NOT EXISTS (
       SELECT 1 FROM public.safisha_reconciliations r, jsonb_array_elements(r.evidence_files) f
        WHERE r.id = v_recon AND f->>'source_type' = p_source_type AND f->>'sha256' = p_file_sha256) THEN
    UPDATE public.safisha_reconciliations
       SET evidence_files = evidence_files || jsonb_build_array(jsonb_build_object(
             'source_type', p_source_type, 'filename', p_file_name, 'rows', v_inserted, 'sha256', p_file_sha256,
             'uploaded_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
     WHERE id = v_recon;
  END IF;

  RETURN jsonb_build_object('reconciliation_id', v_recon, 'reconciliation_created', v_created, 'inserted', v_inserted,
                            'already_present', v_total - v_inserted, 'upload_status', v_status);
END;
$$;

-- ── 3. No client role inserts transactions directly ─────────────────────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: current_user is the writer's role. Runs after the existing write wall (aa_).
CREATE OR REPLACE FUNCTION public.safisha_transaction_authority()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'EVIDENCE_SERVER_ONLY: evidence rows are recorded by the server' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ab_transaction_authority ON public.safisha_transactions;
CREATE TRIGGER ab_transaction_authority BEFORE INSERT ON public.safisha_transactions
  FOR EACH ROW EXECUTE FUNCTION public.safisha_transaction_authority();

-- ── Privileges ──────────────────────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.safisha_ingest_evidence(uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.safisha_ingest_evidence(uuid, uuid, text, text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.safisha_transaction_authority() FROM PUBLIC, anon, authenticated;
