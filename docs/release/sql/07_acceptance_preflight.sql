-- ACCEPTANCE PREFLIGHT (read-only). Run in the SQL editor before the hosted reporting acceptance. Replace
-- <DEMO_COMPANY_UUID> once (the demo company, 659daa94-116c-4803-99f8-157e0bdd4c62). One SELECT; it writes nothing.
--
-- It answers, row by row (status OK / INFO / BLOCKED), and ends with the VERDICT row:
--   PATH_A  an existing dated period other than FY2026 has a current reviewed trial balance, and so does the year
--           before it — run the journey on that year (docs/release/ACCEPTANCE_R1_DEMO_SETUP.md, Path A)
--   PATH_B  no such year; the dedicated synthetic engagement (FY2025 current, FY2024 comparative,
--           docs/release/acceptance-r1/) can be created without touching anything that exists — Path B
--   BLOCKED something listed above it must be decided by the owner first; do NOT proceed and do NOT repair anything
-- FY2026 is never a candidate (it may hold real or protected data; it is neither used nor changed).
WITH params AS (SELECT '<DEMO_COMPANY_UUID>'::uuid AS company_id),
fixture_codes(code) AS (VALUES ('91000'),('91100'),('91200'),('91500'),('91510'),('92000'),('92100'),('92500'),('93000'),
  ('93100'),('94000'),('94100'),('95000'),('96000'),('96100'),('96200'),('96300'),('97000')),
company AS (SELECT c.id, c.reporting_framework FROM public.companies c JOIN params p ON p.company_id = c.id),
rollout AS (
  SELECT (SELECT kill_switch FROM public.financial_statements_rollout_state LIMIT 1) AS kill_switch,
         (SELECT count(*) FROM public.financial_statements_rollout_companies WHERE enabled) AS enabled_n,
         (SELECT coalesce(bool_or(r.company_id = p.company_id), false) FROM public.financial_statements_rollout_companies r, params p WHERE r.enabled) AS demo_enabled),
-- Years with a dated period (start, end, currency all recorded) AND a current authoritative certification.
dated AS (
  SELECT f.id, extract(year FROM f.reporting_end)::int AS y, f.reporting_start, f.reporting_end, f.reporting_currency
    FROM public.fiscal_periods f JOIN params p ON p.company_id = f.company_id
   WHERE f.reporting_start IS NOT NULL AND f.reporting_end IS NOT NULL AND f.reporting_currency IS NOT NULL),
certified AS (SELECT d.* FROM dated d, params p WHERE EXISTS (SELECT 1 FROM public.get_authoritative_certification(p.company_id, d.y))),
path_a AS (
  SELECT c.y, c.reporting_start, c.reporting_end, c.reporting_currency FROM certified c
   WHERE c.y <> 2026 AND EXISTS (SELECT 1 FROM certified q WHERE q.y = c.y - 1)
   ORDER BY c.y DESC LIMIT 1),
-- Path B must not meet anything that already exists: the two years, and the fixture accounts (codes or names).
b_years AS (
  SELECT (SELECT count(*) FROM public.fiscal_periods f, params p WHERE f.company_id = p.company_id AND extract(year FROM f.fiscal_year_end) IN (2024, 2025)) AS periods,
         (SELECT count(*) FROM public.trial_balance_uploads u, params p WHERE u.company_id = p.company_id AND u.period_year IN (2024, 2025)) AS uploads,
         (SELECT count(*) FROM public.financial_statement_reports r, params p WHERE r.company_id = p.company_id AND r.period_year IN (2024, 2025)) AS reports),
b_accounts AS (
  SELECT (SELECT count(*) FROM public.account_mappings m, params p WHERE m.company_id = p.company_id
           AND (m.account_key IN (SELECT code FROM fixture_codes) OR m.account_name ILIKE '%(acceptance r1)%')) AS mappings,
         (SELECT count(*) FROM public.fs_presentation_assignments a, params p WHERE a.company_id = p.company_id
           AND a.account_key IN (SELECT code FROM fixture_codes)) AS presentation),
checks(ord, chk, status, detail) AS (
  SELECT 1, 'company exists', CASE WHEN EXISTS (SELECT 1 FROM company) THEN 'OK' ELSE 'BLOCKED' END,
         coalesce((SELECT id::text FROM company), 'no company with this id')
  UNION ALL SELECT 2, 'framework is IFRS for SMEs', CASE WHEN (SELECT reporting_framework FROM company) = 'ifrs_for_smes' THEN 'OK' ELSE 'BLOCKED' END,
         coalesce((SELECT reporting_framework FROM company), 'not set') || ' (the owner sets it; never changed by this procedure)'
  UNION ALL SELECT 3, 'kill switch off', CASE WHEN NOT coalesce((SELECT kill_switch FROM rollout), false) THEN 'OK' ELSE 'BLOCKED' END,
         'kill_switch=' || coalesce((SELECT kill_switch FROM rollout)::text, 'false')
  UNION ALL SELECT 4, 'only the demo company is enabled',
         CASE WHEN (SELECT enabled_n FROM rollout) = 0 THEN 'INFO' WHEN (SELECT enabled_n FROM rollout) = 1 AND (SELECT demo_enabled FROM rollout) THEN 'OK' ELSE 'BLOCKED' END,
         'enabled companies=' || (SELECT enabled_n FROM rollout) || ', demo enabled=' || (SELECT demo_enabled FROM rollout)
  UNION ALL SELECT 5, 'certified dated years', 'INFO',
         coalesce((SELECT string_agg(y || ' ' || reporting_start || '..' || reporting_end || ' ' || reporting_currency, '; ' ORDER BY y) FROM certified), 'none')
  UNION ALL SELECT 6, 'Path A candidate (not FY2026; prior year also certified)', CASE WHEN EXISTS (SELECT 1 FROM path_a) THEN 'OK' ELSE 'INFO' END,
         coalesce((SELECT 'FY' || y || ' ' || reporting_start || '..' || reporting_end || ' ' || reporting_currency FROM path_a), 'none')
  UNION ALL SELECT 7, 'Path B years 2024/2025 are empty', CASE WHEN (SELECT periods + uploads + reports FROM b_years) = 0 THEN 'OK' ELSE 'BLOCKED' END,
         (SELECT 'periods=' || periods || ' uploads=' || uploads || ' reports=' || reports FROM b_years)
  UNION ALL SELECT 8, 'Path B accounts 91000-97000 / "(acceptance r1)" unused', CASE WHEN (SELECT mappings + presentation FROM b_accounts) = 0 THEN 'OK' ELSE 'BLOCKED' END,
         (SELECT 'mappings=' || mappings || ' presentation=' || presentation FROM b_accounts))
SELECT ord, chk, status, detail FROM checks
UNION ALL
SELECT 99, 'VERDICT',
  CASE WHEN EXISTS (SELECT 1 FROM checks WHERE ord IN (1, 2, 3, 4) AND status = 'BLOCKED') THEN 'BLOCKED'
       WHEN EXISTS (SELECT 1 FROM path_a) THEN 'PATH_A'
       WHEN EXISTS (SELECT 1 FROM checks WHERE ord IN (7, 8) AND status = 'BLOCKED') THEN 'BLOCKED'
       ELSE 'PATH_B' END,
  'see docs/release/ACCEPTANCE_R1_DEMO_SETUP.md'
ORDER BY ord;
