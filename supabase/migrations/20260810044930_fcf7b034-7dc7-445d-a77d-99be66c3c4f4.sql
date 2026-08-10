CREATE TABLE public.upload_integrity_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL REFERENCES public.trial_balance_uploads(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  engagement_id uuid,
  issue_type text NOT NULL CHECK (issue_type IN ('ENGAGEMENT_COMPANY_MISMATCH', 'ENGAGEMENT_PERIOD_MISMATCH')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX upload_integrity_findings_open_uniq
  ON public.upload_integrity_findings (upload_id, issue_type)
  WHERE resolved_at IS NULL;

CREATE INDEX upload_integrity_findings_company_idx
  ON public.upload_integrity_findings (company_id, resolved_at);

GRANT SELECT ON public.upload_integrity_findings TO authenticated;
GRANT ALL ON public.upload_integrity_findings TO service_role;

ALTER TABLE public.upload_integrity_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read integrity findings for their companies"
  ON public.upload_integrity_findings
  FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.get_member_company_ids()));

CREATE TRIGGER update_upload_integrity_findings_updated_at
  BEFORE UPDATE ON public.upload_integrity_findings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.scan_upload_engagement_integrity()
RETURNS TABLE(opened integer, resolved integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_opened integer := 0;
  v_resolved integer := 0;
BEGIN
  CREATE TEMP TABLE _mismatch ON COMMIT DROP AS
  SELECT u.id AS upload_id,
         u.company_id,
         u.engagement_id,
         'ENGAGEMENT_COMPANY_MISMATCH'::text AS issue_type,
         jsonb_build_object(
           'upload_company_id', u.company_id,
           'engagement_company_id', e.company_id
         ) AS detail
    FROM public.trial_balance_uploads u
    JOIN public.engagements e ON e.id = u.engagement_id
   WHERE u.engagement_id IS NOT NULL
     AND e.company_id IS DISTINCT FROM u.company_id
  UNION ALL
  SELECT u.id,
         u.company_id,
         u.engagement_id,
         'ENGAGEMENT_PERIOD_MISMATCH'::text,
         jsonb_build_object(
           'upload_period_id', u.period_id,
           'engagement_fiscal_period_id', e.fiscal_period_id
         )
    FROM public.trial_balance_uploads u
    JOIN public.engagements e ON e.id = u.engagement_id
   WHERE u.engagement_id IS NOT NULL
     AND u.period_id IS NOT NULL
     AND e.fiscal_period_id IS DISTINCT FROM u.period_id;

  WITH ins AS (
    INSERT INTO public.upload_integrity_findings
      (upload_id, company_id, engagement_id, issue_type, detail)
    SELECT m.upload_id, m.company_id, m.engagement_id, m.issue_type, m.detail
      FROM _mismatch m
     WHERE NOT EXISTS (
       SELECT 1 FROM public.upload_integrity_findings f
        WHERE f.upload_id = m.upload_id
          AND f.issue_type = m.issue_type
          AND f.resolved_at IS NULL
     )
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_opened FROM ins;

  WITH fixed AS (
    UPDATE public.upload_integrity_findings f
       SET resolved_at = now()
     WHERE f.resolved_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM _mismatch m
          WHERE m.upload_id = f.upload_id
            AND m.issue_type = f.issue_type
       )
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_resolved FROM fixed;

  RETURN QUERY SELECT v_opened, v_resolved;
END;
$$;

REVOKE ALL ON FUNCTION public.scan_upload_engagement_integrity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scan_upload_engagement_integrity() TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.unschedule('scan-upload-engagement-integrity')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scan-upload-engagement-integrity');

SELECT cron.schedule(
  'scan-upload-engagement-integrity',
  '15 2 * * *',
  $$SELECT public.scan_upload_engagement_integrity();$$
);