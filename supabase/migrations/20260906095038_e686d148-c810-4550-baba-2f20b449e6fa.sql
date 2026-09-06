DROP POLICY IF EXISTS budget_approve ON public.variance_budgets;
CREATE POLICY budget_approve ON public.variance_budgets
FOR UPDATE
TO authenticated
USING (
  company_id IN (
    SELECT firm_members.company_id FROM public.firm_members
    WHERE firm_members.user_id = auth.uid()
      AND firm_members.role = ANY (ARRAY['owner'::text,'partner'::text,'manager'::text])
  )
  AND approved_by IS NULL
  AND submitted_by IS DISTINCT FROM auth.uid()
)
WITH CHECK (
  company_id IN (
    SELECT firm_members.company_id FROM public.firm_members
    WHERE firm_members.user_id = auth.uid()
      AND firm_members.role = ANY (ARRAY['owner'::text,'partner'::text,'manager'::text])
  )
  AND submitted_by IS DISTINCT FROM auth.uid()
  AND (approved_by IS NULL OR approved_by = auth.uid())
  AND approved_by IS DISTINCT FROM submitted_by
);