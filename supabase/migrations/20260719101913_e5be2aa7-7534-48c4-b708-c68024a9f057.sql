
-- ── Fix 1: aje_approve_bypass ────────────────────────────────────────────
-- Split the UPDATE policy: preparer/manager can edit only draft rows and
-- may only leave status in draft/submitted. Only owner/partner may set
-- status to approved or reversed, or edit non-draft rows.
DROP POLICY IF EXISTS aje_update ON public.adjusting_journal_entries;

CREATE POLICY aje_update_draft_preparer ON public.adjusting_journal_entries
FOR UPDATE TO authenticated
USING (
  status = 'draft'
  AND EXISTS (
    SELECT 1 FROM firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = adjusting_journal_entries.company_id
      AND fm.role = ANY (ARRAY['preparer','manager'])
  )
)
WITH CHECK (
  status = ANY (ARRAY['draft','submitted'])
  AND EXISTS (
    SELECT 1 FROM firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = adjusting_journal_entries.company_id
      AND fm.role = ANY (ARRAY['preparer','manager'])
  )
);

CREATE POLICY aje_update_partner_owner ON public.adjusting_journal_entries
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = adjusting_journal_entries.company_id
      AND fm.role = ANY (ARRAY['owner','partner'])
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = adjusting_journal_entries.company_id
      AND fm.role = ANY (ARRAY['owner','partner'])
  )
);

-- ── Fix 2: sso_tier_bypass ───────────────────────────────────────────────
-- Split UPDATE on statement_sign_offs: preparers/managers may set only
-- preparer_signed_at (and must not touch reviewer/approver/locked fields).
-- Only owner/partner may set reviewer_signed_at, approver_signed_at, or
-- locked_at.
DROP POLICY IF EXISTS sso_update ON public.statement_sign_offs;

CREATE POLICY sso_update_preparer ON public.statement_sign_offs
FOR UPDATE TO authenticated
USING (
  locked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = statement_sign_offs.company_id
      AND fm.role = ANY (ARRAY['preparer','manager'])
  )
)
WITH CHECK (
  locked_at IS NULL
  AND reviewer_signed_at IS NULL
  AND approver_signed_at IS NULL
  AND EXISTS (
    SELECT 1 FROM firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = statement_sign_offs.company_id
      AND fm.role = ANY (ARRAY['preparer','manager'])
  )
);

CREATE POLICY sso_update_partner_owner ON public.statement_sign_offs
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = statement_sign_offs.company_id
      AND fm.role = ANY (ARRAY['owner','partner'])
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM firm_members fm
    WHERE fm.user_id = auth.uid()
      AND fm.company_id = statement_sign_offs.company_id
      AND fm.role = ANY (ARRAY['owner','partner'])
  )
  AND (
    reviewer_signed_at IS NULL
    OR reviewer_id IS DISTINCT FROM preparer_id
  )
  AND (
    approver_signed_at IS NULL
    OR (approver_id IS DISTINCT FROM preparer_id
        AND approver_id IS DISTINCT FROM reviewer_id)
  )
);
