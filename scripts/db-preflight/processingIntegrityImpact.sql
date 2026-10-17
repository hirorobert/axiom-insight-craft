-- scripts/db-preflight/processingIntegrityImpact.sql — READ-ONLY impact detection for repairs A, B and C (16 October 2026).
--
-- Run by the OWNER against the hosted database in a read-only session, e.g.:
--   BEGIN TRANSACTION READ ONLY;  \i scripts/db-preflight/processingIntegrityImpact.sql  ROLLBACK;
-- Every statement is a SELECT. Nothing is changed, and nothing found here is to be corrected by rewriting history:
-- certifications, decisions and sealed issuances are append-only evidence. A finding is resolved by a NEW review and a
-- NEW check (a linked, later version), never by editing the old row.
--
-- What each query can and cannot establish is stated with it. Absence of log lines alone does not establish absence of
-- impact (log retention is limited; a refused request leaves no database row); the database queries below look at what
-- WAS recorded.

-- ── B1. Possible past wrong-code reuse (the silent case) ──────────────────────────────────────────────────────────────
-- Before generation 6, an account whose code had no reviewed mapping could be classified by NAME from a reviewed
-- mapping recorded under a DIFFERENT code (Tier 2), and stand without review. A certification records each certified
-- account's evidence tier. Candidates: certified accounts with a code, certified by a company name mapping (tier 2),
-- where a reviewed decision for the same normalized name existed under another code before the certification.
-- Establishes: candidates to re-review. Cannot establish: which mapping row the engine used (not recorded), so each
-- candidate needs a reviewer, not an automatic correction.
SELECT c.company_id, c.period_year, c.upload_id, c.id AS certification_id, c.certified_at,
       r->>'accountCode' AS certified_code, r->>'accountName' AS certified_name, r->>'subNature' AS certified_as,
       d.review_account_key AS decision_code, d.new_value->'mapping'->>'classification' AS decision_classification,
       d.created_at AS decision_at
  FROM public.tb_certifications c
  CROSS JOIN LATERAL jsonb_array_elements(c.rows_snapshot) r
  JOIN public.account_review_decisions d
    ON d.company_id = c.company_id
   AND d.normalized_account_name = lower(trim(regexp_replace(regexp_replace(coalesce(r->>'accountName', ''), '[[:punct:]]', '', 'g'), '\s+', ' ', 'g')))
   AND d.account_code IS NOT NULL
   AND d.account_code <> (r->>'accountCode')
   AND d.created_at < c.certified_at
   AND d.decision_action IN ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION')
 WHERE (r->>'evidenceTier') = '2'
   AND coalesce(r->>'accountCode', '') <> ''
 ORDER BY c.company_id, c.period_year, c.certified_at, certified_code;

-- B2. Scale of B1 per company and year (for prioritising re-review).
SELECT c.company_id, c.period_year, count(DISTINCT c.id) AS certifications, count(*) AS certified_rows_by_name
  FROM public.tb_certifications c CROSS JOIN LATERAL jsonb_array_elements(c.rows_snapshot) r
 WHERE (r->>'evidenceTier') = '2' AND coalesce(r->>'accountCode', '') <> ''
 GROUP BY 1, 2 ORDER BY 1, 2;

-- ── A. Explicit processing failures at the certification bound ────────────────────────────────────────────────────────
-- A1. Attempts that never finished: a 23514 refusal of tb_finalize_attempt rolls back, so the attempt stays running until
-- its lease expires and is then abandoned (LEASE_EXPIRED). Large uploads among them are the candidates. Establishes:
-- uploads whose check did not complete. Cannot establish the cause by itself — compare with the function log line
-- "[PTB] tb_finalize_attempt refused: 23514" (log retention permitting).
SELECT er.company_id, er.period_year, er.source_record_id AS upload_id, er.attempt_no, er.status, er.error_code,
       er.started_at, er.completed_at, t.file_name, t.status AS upload_status,
       (t.processing_result->'ingestion'->'lineage_summary'->>'account')::int AS accounts_read
  FROM public.engine_runs er JOIN public.trial_balance_uploads t ON t.id = er.source_record_id
 WHERE er.function_name = 'process-trial-balance' AND er.status IN ('abandoned', 'failed', 'running')
 ORDER BY er.started_at DESC;

-- A2. Uploads never certified at all (no certification for any attempt), with how many accounts they hold.
SELECT t.company_id, t.period_year, t.id AS upload_id, t.status, t.uploaded_at,
       (t.processing_result->'ingestion'->'lineage_summary'->>'account')::int AS accounts_read
  FROM public.trial_balance_uploads t
 WHERE t.company_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.upload_id = t.id)
 ORDER BY t.uploaded_at DESC;

-- A3. Certifications whose exceptions are close to the bound (evidence the bound was being approached).
SELECT id, company_id, period_year, jsonb_array_length(exceptions) AS entries, pg_column_size(exceptions) AS bytes
  FROM public.tb_certifications WHERE pg_column_size(exceptions) > 49152 ORDER BY bytes DESC;

-- ── B3. Explicit review errors ───────────────────────────────────────────────────────────────────────────────────────
-- A refused review (23505 on uq_acct_map_company_norm_name) rolls back and records nothing in the database; only the API
-- / database logs show it ("duplicate key value violates unique constraint \"uq_acct_map_company_norm_name\"").
-- What the database CAN show: an upload whose accounts needing review include two codes with one name (the pattern in
-- which reviewing the second failed), and whether each code has a reviewed decision now.
SELECT t.company_id, t.id AS upload_id, a->>'account_code' AS code, a->>'account_name' AS name,
       EXISTS (SELECT 1 FROM public.account_review_decisions d WHERE d.company_id = t.company_id AND d.review_account_key = a->>'account_code') AS reviewed
  FROM public.trial_balance_uploads t
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.processing_result->'needs_review_accounts', '[]'::jsonb)) a
 WHERE coalesce(a->>'account_code', '') <> ''
   AND lower(a->>'account_name') IN (
     SELECT lower(b->>'account_name') FROM jsonb_array_elements(coalesce(t.processing_result->'needs_review_accounts', '[]'::jsonb)) b
      WHERE coalesce(b->>'account_code', '') <> '' GROUP BY 1 HAVING count(DISTINCT b->>'account_code') > 1)
 ORDER BY 1, 2, 4, 3;

-- ── C. Sealed Reporting Packs without their stored object ─────────────────────────────────────────────────────────────
-- Establishes directly: any sealed issuance whose object is missing or of the wrong size (the race repair C removes).
-- Such a pack never verifies as official; it is re-issued as a NEW issuance, the sealed row is kept as history.
SELECT i.id AS issuance_id, i.company_id, i.period_year, i.consumed_at, i.storage_path, i.byte_size
  FROM public.reporting_pack_issuances i
 WHERE i.consumed_at IS NOT NULL
   AND NOT public._reporting_pack_object_matches(i.storage_path, i.byte_size)
 ORDER BY i.consumed_at DESC;
