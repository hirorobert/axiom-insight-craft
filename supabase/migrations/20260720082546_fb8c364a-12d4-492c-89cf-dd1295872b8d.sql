
DROP POLICY IF EXISTS safisha_exc_insert ON public.safisha_exceptions;
CREATE POLICY safisha_exc_insert ON public.safisha_exceptions
  FOR INSERT TO authenticated
  WITH CHECK (
    reconciliation_id IN (
      SELECT id FROM public.safisha_reconciliations WHERE client_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS safisha_txn_insert ON public.safisha_transactions;
CREATE POLICY safisha_txn_insert ON public.safisha_transactions
  FOR INSERT TO authenticated
  WITH CHECK (
    reconciliation_id IN (
      SELECT id FROM public.safisha_reconciliations WHERE client_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS aje_lines_insert ON public.aje_lines;
CREATE POLICY aje_lines_insert ON public.aje_lines
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.adjusting_journal_entries a
      JOIN public.firm_members fm ON fm.company_id = a.company_id
      WHERE a.id = aje_lines.aje_id
        AND fm.user_id = auth.uid()
        AND fm.role = ANY (ARRAY['owner','partner','preparer','manager'])
    )
  );

DROP POLICY IF EXISTS aje_update_partner_owner ON public.adjusting_journal_entries;
CREATE POLICY aje_update_partner_owner ON public.adjusting_journal_entries
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.firm_members fm
            WHERE fm.user_id = auth.uid()
              AND fm.company_id = adjusting_journal_entries.company_id
              AND fm.role = ANY (ARRAY['owner','partner']))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.firm_members fm
            WHERE fm.user_id = auth.uid()
              AND fm.company_id = adjusting_journal_entries.company_id
              AND fm.role = ANY (ARRAY['owner','partner']))
    AND (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by)
    AND (status NOT IN ('approved','reversed') OR auth.uid() IS DISTINCT FROM created_by)
  );

CREATE OR REPLACE FUNCTION public.enforce_sso_distinct_signers()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.reviewer_id IS NOT NULL AND NEW.preparer_id IS NOT NULL
     AND NEW.reviewer_id = NEW.preparer_id THEN
    RAISE EXCEPTION 'IRON DOME: reviewer must differ from preparer on statement_sign_offs (row %)', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.approver_id IS NOT NULL AND NEW.preparer_id IS NOT NULL
     AND NEW.approver_id = NEW.preparer_id THEN
    RAISE EXCEPTION 'IRON DOME: approver must differ from preparer on statement_sign_offs (row %)', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.approver_id IS NOT NULL AND NEW.reviewer_id IS NOT NULL
     AND NEW.approver_id = NEW.reviewer_id THEN
    RAISE EXCEPTION 'IRON DOME: approver must differ from reviewer on statement_sign_offs (row %)', NEW.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_sso_distinct_signers() FROM PUBLIC;

DROP TRIGGER IF EXISTS sso_distinct_signers ON public.statement_sign_offs;
CREATE TRIGGER sso_distinct_signers
  BEFORE INSERT OR UPDATE ON public.statement_sign_offs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sso_distinct_signers();

REVOKE EXECUTE ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.hesabu_write_validation(uuid, uuid, integer, text, integer, integer, integer, integer, numeric, numeric, numeric, uuid, text, jsonb) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.xbrl_write_instance(uuid, uuid, integer, text, text, text, text, text, integer, boolean, integer, integer, integer, uuid, text, jsonb) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.maono_write_alert(uuid, uuid, text, text, text[], text[], text, text) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.safisha_append_evidence_file(uuid, text, text, integer) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.maono_check_safisha_gate(uuid[]) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.maono_compute_confidence(uuid, integer) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.carry_forward_wdv(uuid, integer, integer) FROM PUBLIC, authenticated, anon;

GRANT EXECUTE ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.hesabu_write_validation(uuid, uuid, integer, text, integer, integer, integer, integer, numeric, numeric, numeric, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.xbrl_write_instance(uuid, uuid, integer, text, text, text, text, text, integer, boolean, integer, integer, integer, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.maono_write_alert(uuid, uuid, text, text, text[], text[], text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.safisha_append_evidence_file(uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.maono_check_safisha_gate(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.maono_compute_confidence(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.carry_forward_wdv(uuid, integer, integer) TO service_role;

REVOKE SELECT ON public.safisha_audit_log            FROM authenticated, anon;
REVOKE SELECT ON public.hesabu_validation_assertions FROM authenticated, anon;
REVOKE SELECT ON public.xbrl_validation_issues       FROM authenticated, anon;
REVOKE SELECT ON public.maono_monitor_runs           FROM authenticated, anon;

GRANT ALL ON public.safisha_audit_log            TO service_role;
GRANT ALL ON public.hesabu_validation_assertions TO service_role;
GRANT ALL ON public.xbrl_validation_issues       TO service_role;
GRANT ALL ON public.maono_monitor_runs           TO service_role;
