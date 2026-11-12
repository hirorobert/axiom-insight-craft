-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- READ-ONLY preflight for 20261223100000 (first-period governed review, standalone on main). Run it BEFORE applying that migration, as the migration
-- owner, in a read-only transaction. It writes nothing and does not need any object the migration creates.
--
--   WHAT IT ANSWERS: which workspaces rely, TODAY, on a legacy first-period declaration (20261017100000) to satisfy the
--   comparative requirement - a declaration that stays recorded after the migration but becomes a CLAIM only - and which open
--   engagements (report lineages without a FINAL) depend on it. After the migration none of them is promoted to a verified
--   decision; each shows FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED and one next action until a governed review is recorded.
--
--   ISSUED HISTORY: a FINAL version is never touched. final_lineages_without_comparatives counts issued reports that carry no
--   comparative period while a legacy declaration was in force: they are reported for review, never changed or revoked.
--
--   Usage:   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/release/first-period-governed-review/preflight.sql
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
BEGIN READ ONLY;

-- One read-only statement: a JSON report with the summary counts and one entry per affected workspace and period.
WITH latest AS (
  SELECT DISTINCT ON (d.company_id, d.period_year) d.company_id, d.period_year, d.action, d.evidence_kind, d.evidence_ref, d.evidence_date, d.created_at
    FROM public.fs_first_period_declarations d
   ORDER BY d.company_id, d.period_year, d.seq DESC
), active AS (
  -- In force under the OLD rule: the latest record declares it AND no earlier-period trial balance exists now.
  SELECT l.* FROM latest l WHERE l.action = 'declared' AND public._fs_earlier_period_history(l.company_id, l.period_year) IS NULL
), scope AS (
  SELECT a.company_id, c.name AS company_name, a.period_year, a.created_at::date AS declared_on, a.evidence_kind, a.evidence_date, per.reporting_start AS period_start, per.reporting_end AS period_end,
         (per.reporting_start IS NOT NULL AND a.evidence_date < per.reporting_start) AS evidence_predates_period,
         (SELECT count(DISTINCT r.report_id) FROM public.financial_statement_reports r
           WHERE r.company_id = a.company_id AND r.period_year = a.period_year
             AND NOT EXISTS (SELECT 1 FROM public.financial_statement_publications p WHERE p.report_id = r.report_id AND p.company_id = r.company_id AND p.state = 'FINAL'))::int AS open_report_lineages,
         (SELECT count(DISTINCT r.report_id) FROM public.financial_statement_reports r
           WHERE r.company_id = a.company_id AND r.period_year = a.period_year
             AND jsonb_array_length(coalesce(r.report_document -> 'comparativePeriods', '[]'::jsonb)) = 0
             AND EXISTS (SELECT 1 FROM public.financial_statement_publications p WHERE p.report_id = r.report_id AND p.company_id = r.company_id AND p.state = 'FINAL'))::int AS final_lineages_without_comparatives
    FROM active a
    JOIN public.companies c ON c.id = a.company_id
    LEFT JOIN LATERAL (
      SELECT fp.reporting_start, fp.reporting_end
        FROM public.get_authoritative_certification(a.company_id, a.period_year) cert
        JOIN public.trial_balance_uploads u ON u.id = cert.upload_id
        JOIN public.fiscal_periods fp ON fp.id = u.period_id
       LIMIT 1
    ) per ON true
)
SELECT jsonb_build_object(
  'summary', jsonb_build_object(
    'activeLegacyDeclarations',          (SELECT count(*) FROM scope),
    'withOpenEngagement',                (SELECT count(*) FROM scope WHERE open_report_lineages > 0),
    'openReportLineages',                (SELECT coalesce(sum(open_report_lineages), 0) FROM scope),
    'certificatePredatesPeriod',         (SELECT count(*) FROM scope WHERE evidence_predates_period),
    'periodNotDeterminable',             (SELECT count(*) FROM scope WHERE period_start IS NULL),
    'withIssuedFinalWithoutComparatives', (SELECT count(*) FROM scope WHERE final_lineages_without_comparatives > 0),
    'finalLineagesWithoutComparatives',  (SELECT coalesce(sum(final_lineages_without_comparatives), 0) FROM scope),
    'declarationRowsTotal',              (SELECT count(*) FROM public.fs_first_period_declarations),
    'actionUsersWillSee',                'FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED: record the first-period facts, cite the registration evidence, and have a different partner or manager review them'),
  'workspaces', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.evidence_predates_period DESC, s.open_report_lineages DESC, s.company_name, s.period_year) FROM scope s), '[]'::jsonb)
) AS preflight;

ROLLBACK;
