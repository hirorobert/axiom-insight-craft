-- READ-ONLY DISPOSITION of impact-report sections A1 and A2 (scripts/db-preflight/processingIntegrityImpact.sql),
-- batch tb-release-r1. Run BEFORE the wrappers, in BEGIN TRANSACTION READ ONLY; … ROLLBACK;. Writes nothing.
--
-- Age alone proves nothing, so each row is classified by RECORDED evidence only (rows are never edited):
-- A1 — process-trial-balance runs that are abandoned, failed or running:
--   in_flight                 running with a live lease: not historical; re-run this query after the lease ends.
--   later_certified           the same upload has a certification recorded AFTER this attempt started: the check
--                             completed; a failed attempt writes no certification (tb_finalize_attempt is atomic).
--   concurrency_control       ATTEMPT_NOT_CURRENT / PREEMPTED / DEPENDENCY_CHANGED / SOURCE_CHANGED / REPROCESS_REQUIRED /
--                             IDEMPOTENCY_KEY_REUSED: the engine's own fences refused a stale or duplicate attempt.
--   release_drain             DRAINED_AT_CUTOVER: abandoned by the recorded S2/E2 cut-over drain.
--   upload_not_current        the upload is retired, superseded, discard_pending or discarded (or UPLOAD_NOT_ACTIVE).
--   explicit_failure          status failed with a recorded error_code (a reported, terminal outcome).
--   capacity_bound_candidate  LEASE_EXPIRED, the upload still active and never certified: the pattern repair A
--                             addresses (a 23514 at the certification bound rolls back and leaves the lease to expire).
--                             The owner re-checks that upload once generation 6 is live (a NEW run; nothing edited).
--   unexplained               none of the above: STOP and report the row.
-- A2 — uploads never certified:
--   not_current               retired / superseded / discard_pending / discarded.
--   never_checked             no process-trial-balance run was ever recorded for it.
--   refused_on_read           blocked with zero accounts read: an explicit, recorded refusal.
--   capacity_bound_candidate  any of its runs is an A1 capacity_bound_candidate.
--   completed_uncertified_outcome  every run completed and none failed: the engine recorded a terminal outcome without a
--                             certification (upload_status / lifecycle_state show which, e.g. blocked with findings).
--   attempts_explained        every unfinished run is in_flight, concurrency_control, release_drain or explicit_failure.
--   unexplained               otherwise: STOP and report the row.

WITH runs AS (
  SELECT er.id AS engine_run_id, er.company_id, er.period_year, er.source_record_id AS upload_id, er.attempt_no, er.status,
         er.error_code, er.started_at, er.completed_at, er.lease_expires_at, t.lifecycle_state, t.status AS upload_status,
         (t.processing_result->'ingestion'->'lineage_summary'->>'account')::int AS accounts_read,
         EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.upload_id = t.id AND c.certified_at > er.started_at) AS certified_later,
         EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.upload_id = t.id) AS ever_certified
    FROM public.engine_runs er JOIN public.trial_balance_uploads t ON t.id = er.source_record_id
   WHERE er.function_name = 'process-trial-balance' AND er.status IN ('abandoned', 'failed', 'running')
), a1 AS (
  SELECT r.*,
         CASE
           WHEN r.status = 'running' AND r.lease_expires_at > now() THEN 'in_flight'
           WHEN r.certified_later THEN 'later_certified'
           WHEN r.error_code IN ('ATTEMPT_NOT_CURRENT', 'PREEMPTED', 'DEPENDENCY_CHANGED', 'SOURCE_CHANGED', 'REPROCESS_REQUIRED', 'IDEMPOTENCY_KEY_REUSED') THEN 'concurrency_control'
           WHEN r.error_code = 'DRAINED_AT_CUTOVER' THEN 'release_drain'
           WHEN r.lifecycle_state IN ('retired', 'superseded', 'discard_pending', 'discarded') OR r.error_code = 'UPLOAD_NOT_ACTIVE' THEN 'upload_not_current'
           WHEN r.status = 'failed' AND r.error_code IS NOT NULL THEN 'explicit_failure'
           WHEN (r.error_code = 'LEASE_EXPIRED' OR (r.status = 'running' AND r.lease_expires_at <= now())) AND NOT r.ever_certified THEN 'capacity_bound_candidate'
           ELSE 'unexplained'
         END AS disposition
    FROM runs r
)
SELECT 'A1' AS section, disposition, company_id, period_year, upload_id, engine_run_id, attempt_no, status, error_code,
       started_at, completed_at, lifecycle_state, accounts_read
  FROM a1
UNION ALL
SELECT 'A2', CASE
         WHEN t.lifecycle_state IN ('retired', 'superseded', 'discard_pending', 'discarded') THEN 'not_current'
         WHEN NOT EXISTS (SELECT 1 FROM public.engine_runs er WHERE er.function_name = 'process-trial-balance' AND er.source_record_id = t.id) THEN 'never_checked'
         WHEN t.lifecycle_state = 'blocked' AND coalesce((t.processing_result->'ingestion'->'lineage_summary'->>'account')::int, 0) = 0 THEN 'refused_on_read'
         WHEN EXISTS (SELECT 1 FROM a1 WHERE a1.upload_id = t.id AND a1.disposition = 'capacity_bound_candidate') THEN 'capacity_bound_candidate'
         WHEN NOT EXISTS (SELECT 1 FROM a1 WHERE a1.upload_id = t.id) THEN 'completed_uncertified_outcome'
         WHEN NOT EXISTS (SELECT 1 FROM a1 WHERE a1.upload_id = t.id AND a1.disposition NOT IN ('in_flight', 'concurrency_control', 'release_drain', 'explicit_failure')) THEN 'attempts_explained'
         ELSE 'unexplained'
       END,
       t.company_id, t.period_year, t.id, NULL::uuid, NULL::integer, t.status, NULL::text, t.uploaded_at, NULL::timestamptz,
       t.lifecycle_state, (t.processing_result->'ingestion'->'lineage_summary'->>'account')::int
  FROM public.trial_balance_uploads t
 WHERE t.company_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.upload_id = t.id)
 ORDER BY 1, 2, 3, 4, 10;
