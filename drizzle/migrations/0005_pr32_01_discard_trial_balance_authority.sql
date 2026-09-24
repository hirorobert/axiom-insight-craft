SET search_path TO public, pg_catalog;

CREATE POLICY "Accepted workspace members can delete company uploads"
  ON public.trial_balance_uploads
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id     = auth.uid()
         AND fm.company_id  = trial_balance_uploads.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );

DO $$ BEGIN
  CREATE TYPE public.discard_outcome AS ENUM (
    'deleted_now',
    'already_discarded',
    'forbidden',
    'dependency_conflict'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.discard_trial_balance_upload(p_upload_id uuid)
RETURNS TABLE (
  outcome     public.discard_outcome,
  row_snapshot jsonb,
  file_path    text,
  detail       text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_authorized boolean;
BEGIN
  IF p_upload_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::jsonb, NULL::text, 'No upload id supplied.'::text;
    RETURN;
  END IF;

  SELECT * INTO v_row FROM public.trial_balance_uploads WHERE id = p_upload_id;

  IF v_row.id IS NULL THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::jsonb, NULL::text, 'This trial balance no longer exists.'::text;
    RETURN;
  END IF;

  SELECT
    (v_row.user_id IS NOT NULL AND v_row.user_id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id     = auth.uid()
         AND fm.company_id  = v_row.company_id
         AND fm.accepted_at IS NOT NULL
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::jsonb, NULL::text, 'You are not authorised to discard this trial balance.'::text;
    RETURN;
  END IF;

  BEGIN
    DELETE FROM public.trial_balance_uploads WHERE id = p_upload_id;
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN QUERY SELECT 'dependency_conflict'::public.discard_outcome, NULL::jsonb, NULL::text, 'Other records in this workspace still depend on this trial balance.'::text;
    RETURN;
  END;

  RETURN QUERY SELECT 'deleted_now'::public.discard_outcome, to_jsonb(v_row), v_row.file_path, NULL::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.discard_trial_balance_upload(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.discard_trial_balance_upload(uuid) FROM PUBLIC, anon;