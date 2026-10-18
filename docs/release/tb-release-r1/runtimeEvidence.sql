-- READ-ONLY RUNTIME EVIDENCE for the trial balance release (batch tb-release-r1), recorded SEPARATELY from the catalog
-- postcondition (postcondition.sql). Run in BEGIN TRANSACTION READ ONLY; … ROLLBACK; AFTER the owner's hosted 2,000-account
-- check (HANDOFF step 6, resource-2000-accounts.csv). Writes nothing and invokes no application function.
--
-- Why this is the runtime proof of the service-role-only findings-store probe. process-trial-balance (generation 6) calls
-- tb_certification_findings_supported() through its service-role client whenever a check's findings do not fit the
-- summary budget (32 KiB); if that call fails it REFUSES the certification (FINDINGS_STORE_UNAVAILABLE) and records
-- nothing certified. An invented 2,000-account file produces about one finding per account (CI: 2,003 findings,
-- summarized), so a generation-6 certification that is findings_summarized = true exists ONLY if the probe was invoked
-- by the authorised processing path and answered. The complete findings stored beside it, re-hashed here, show that the
-- store it vouched for works.
--
-- PASS requires, for the owner's check (its row in R1–R3: the newest generation-6 certification of that upload):
--   R1  engine_generation = 6 and the certification exists (the run was not refused);
--   R2  findings_summarized = true (the probe ran on this path);
--   R3  stored = findings_count, and recomputed_sha256 = findings_sha256 (the complete findings are stored, intact);
--   R4  zero generation-6 process-trial-balance runs refused FINDINGS_STORE_UNAVAILABLE.
-- If R2 is false the probe was not exercised by that check: the runtime gate stays INCOMPLETE (use a file with more
-- findings, still invented); it is never inferred from the catalog.

-- R1–R3. Every generation-6 certification, newest first; the owner's 2,000-account upload is the row to record.
SELECT c.id AS certification_id, c.company_id, c.upload_id, c.certified_at, er.engine_generation, er.engine_version,
       c.findings_summarized, c.findings_count, c.findings_sha256,
       (SELECT count(*) FROM public.tb_certification_findings f WHERE f.certification_id = c.id) AS stored,
       (SELECT encode(sha256(convert_to(string_agg(f.finding::text, chr(10) ORDER BY f.ordinal), 'UTF8')), 'hex')
          FROM public.tb_certification_findings f WHERE f.certification_id = c.id) AS recomputed_sha256
  FROM public.tb_certifications c JOIN public.engine_runs er ON er.id = c.engine_run_id
 WHERE er.engine_generation = 6
 ORDER BY c.certified_at DESC
 LIMIT 20;

-- R4. Generation-6 runs refused because the complete findings could not be stored (expected: 0).
SELECT count(*) AS findings_store_refusals
  FROM public.engine_runs er
 WHERE er.function_name = 'process-trial-balance' AND er.engine_generation = 6 AND er.error_code = 'FINDINGS_STORE_UNAVAILABLE';
