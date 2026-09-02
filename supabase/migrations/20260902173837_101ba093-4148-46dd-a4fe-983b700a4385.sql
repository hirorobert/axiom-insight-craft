CREATE POLICY "Accepted workspace members can view company uploads"
ON public.trial_balance_uploads
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = trial_balance_uploads.company_id
      AND fm.accepted_at IS NOT NULL
  )
);