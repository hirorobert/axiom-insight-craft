-- READ-ONLY INVENTORY: authoritative trial-balance results that were evaluated under rules earlier than the current
-- finding rules (engine generation < 7). Run in BEGIN TRANSACTION READ ONLY; … ROLLBACK;. It changes nothing and reads
-- no file. Each row is a period whose result in force was NOT evaluated under the current checks (required entity
-- decision, database-computed requirements, evaluation manifest): it stays in force, with its history, until it is
-- checked again ("Check again under the current checks" — the one reprocess path).
-- The generation is the engine's own record: tb_certifications.engine_run_id → engine_runs.engine_generation.
SELECT p.company_id, p.period_year, a.id AS certification_id, a.upload_id, r.engine_generation, a.certified_at
  FROM (SELECT DISTINCT company_id, period_year FROM public.tb_certifications) p
  CROSS JOIN LATERAL public.get_authoritative_certification(p.company_id, p.period_year) a
  JOIN public.engine_runs r ON r.id = a.engine_run_id
 WHERE coalesce(r.engine_generation, 0) < 7
 ORDER BY p.company_id, p.period_year;
