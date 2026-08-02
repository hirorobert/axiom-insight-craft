DROP POLICY IF EXISTS "Users can create their own corrections" ON public.account_corrections;
CREATE POLICY "Users can create their own corrections" ON public.account_corrections FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
DROP POLICY IF EXISTS "Users can delete their own corrections" ON public.account_corrections;
CREATE POLICY "Users can delete their own corrections" ON public.account_corrections FOR DELETE TO authenticated USING ((auth.uid() = user_id));
DROP POLICY IF EXISTS "Users can update their own corrections" ON public.account_corrections;
CREATE POLICY "Users can update their own corrections" ON public.account_corrections FOR UPDATE TO authenticated USING ((auth.uid() = user_id));
DROP POLICY IF EXISTS "Users can view their own corrections" ON public.account_corrections;
CREATE POLICY "Users can view their own corrections" ON public.account_corrections FOR SELECT TO authenticated USING ((auth.uid() = user_id));
DROP POLICY IF EXISTS "account_pl_mapping_read" ON public.account_pl_mapping;
CREATE POLICY "account_pl_mapping_read" ON public.account_pl_mapping FOR SELECT TO authenticated USING (((company_id IS NULL) OR (company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid())))));
DROP POLICY IF EXISTS "account_pl_mapping_write" ON public.account_pl_mapping;
CREATE POLICY "account_pl_mapping_write" ON public.account_pl_mapping FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (firm_members.role = ANY (ARRAY['owner'::text, 'partner'::text, 'manager'::text]))))));
DROP POLICY IF EXISTS "Users can insert their own audit logs" ON public.audit_logs;
CREATE POLICY "Users can insert their own audit logs" ON public.audit_logs FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
DROP POLICY IF EXISTS "Users can view their own audit logs" ON public.audit_logs;
CREATE POLICY "Users can view their own audit logs" ON public.audit_logs FOR SELECT TO authenticated USING ((auth.uid() = user_id));
DROP POLICY IF EXISTS "board_packs_insert" ON public.board_packs;
CREATE POLICY "board_packs_insert" ON public.board_packs FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "board_packs_read" ON public.board_packs;
CREATE POLICY "board_packs_read" ON public.board_packs FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "cashflow_insert" ON public.cashflow_forecasts;
CREATE POLICY "cashflow_insert" ON public.cashflow_forecasts FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "cashflow_read" ON public.cashflow_forecasts;
CREATE POLICY "cashflow_read" ON public.cashflow_forecasts FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "efdms_recon_read" ON public.efdms_reconciliation;
CREATE POLICY "efdms_recon_read" ON public.efdms_reconciliation FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "efdms_recon_write" ON public.efdms_reconciliation;
CREATE POLICY "efdms_recon_write" ON public.efdms_reconciliation FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "efdms_insert" ON public.efdms_z_reports;
CREATE POLICY "efdms_insert" ON public.efdms_z_reports FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "efdms_read" ON public.efdms_z_reports;
CREATE POLICY "efdms_read" ON public.efdms_z_reports FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "fp_insert" ON public.fiscal_periods;
CREATE POLICY "fp_insert" ON public.fiscal_periods FOR INSERT TO authenticated WITH CHECK (((auth.uid() = created_by) AND (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = fiscal_periods.company_id))))));
DROP POLICY IF EXISTS "fp_select" ON public.fiscal_periods;
CREATE POLICY "fp_select" ON public.fiscal_periods FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = fiscal_periods.company_id)))));
DROP POLICY IF EXISTS "fp_update" ON public.fiscal_periods;
CREATE POLICY "fp_update" ON public.fiscal_periods FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = fiscal_periods.company_id)))));
DROP POLICY IF EXISTS "hesabu_assert_read" ON public.hesabu_validation_assertions;
CREATE POLICY "hesabu_assert_read" ON public.hesabu_validation_assertions FOR SELECT TO authenticated USING ((validation_id IN ( SELECT hv.id
   FROM hesabu_validations hv
  WHERE (hv.company_id IN ( SELECT firm_members.company_id
           FROM firm_members
          WHERE (firm_members.user_id = auth.uid()))))));
DROP POLICY IF EXISTS "hesabu_val_read" ON public.hesabu_validations;
CREATE POLICY "hesabu_val_read" ON public.hesabu_validations FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "mi_insert" ON public.management_inputs;
CREATE POLICY "mi_insert" ON public.management_inputs FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (fm.role = ANY (ARRAY['owner'::text, 'partner'::text, 'preparer'::text]))))));
DROP POLICY IF EXISTS "mi_select" ON public.management_inputs;
CREATE POLICY "mi_select" ON public.management_inputs FOR SELECT TO authenticated USING (EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE fm.user_id = auth.uid()
    AND fm.company_id = management_inputs.company_id
    AND fm.role = ANY (ARRAY['owner'::text,'partner'::text,'preparer'::text])));
DROP POLICY IF EXISTS "mi_update" ON public.management_inputs;
CREATE POLICY "mi_update" ON public.management_inputs FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (fm.role = ANY (ARRAY['owner'::text, 'partner'::text, 'preparer'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = management_inputs.company_id) AND (fm.role = ANY (ARRAY['owner'::text, 'partner'::text, 'preparer'::text]))))));
DROP POLICY IF EXISTS "maono_context_read" ON public.maono_context;
CREATE POLICY "maono_context_read" ON public.maono_context FOR SELECT TO authenticated USING ((is_active = true));
DROP POLICY IF EXISTS "insights_insert" ON public.maono_insights;
CREATE POLICY "insights_insert" ON public.maono_insights FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "insights_read" ON public.maono_insights;
CREATE POLICY "insights_read" ON public.maono_insights FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "pcb_insert" ON public.period_closing_balances;
CREATE POLICY "pcb_insert" ON public.period_closing_balances FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = period_closing_balances.company_id)))));
DROP POLICY IF EXISTS "pcb_select" ON public.period_closing_balances;
CREATE POLICY "pcb_select" ON public.period_closing_balances FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = period_closing_balances.company_id)))));
DROP POLICY IF EXISTS "pcb_update" ON public.period_closing_balances;
CREATE POLICY "pcb_update" ON public.period_closing_balances FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = period_closing_balances.company_id)))));
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE TO authenticated USING ((auth.uid() = user_id));
DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;
CREATE POLICY "Users can view their own profile" ON public.profiles FOR SELECT TO authenticated USING ((auth.uid() = user_id));
DROP POLICY IF EXISTS "tax_payments_select" ON public.tax_payments;
CREATE POLICY "tax_payments_select" ON public.tax_payments FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM firm_members fm
  WHERE ((fm.user_id = auth.uid()) AND (fm.company_id = tax_payments.company_id)))));
DROP POLICY IF EXISTS "alerts_acknowledge" ON public.variance_alerts;
CREATE POLICY "alerts_acknowledge" ON public.variance_alerts FOR UPDATE TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "alerts_read" ON public.variance_alerts;
CREATE POLICY "alerts_read" ON public.variance_alerts FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "analyses_insert" ON public.variance_analyses;
CREATE POLICY "analyses_insert" ON public.variance_analyses FOR INSERT TO authenticated WITH CHECK ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "analyses_read" ON public.variance_analyses;
CREATE POLICY "analyses_read" ON public.variance_analyses FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "budget_approve" ON public.variance_budgets;
CREATE POLICY "budget_approve" ON public.variance_budgets FOR UPDATE TO authenticated USING (((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (firm_members.role = ANY (ARRAY['owner'::text, 'partner'::text, 'manager'::text]))))) AND (approved_by IS NULL)));
DROP POLICY IF EXISTS "budget_read" ON public.variance_budgets;
CREATE POLICY "budget_read" ON public.variance_budgets FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "budget_submit" ON public.variance_budgets;
CREATE POLICY "budget_submit" ON public.variance_budgets FOR INSERT TO authenticated WITH CHECK (((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))) AND (submitted_by = auth.uid()) AND (approved_by IS NULL)));
DROP POLICY IF EXISTS "variance_materiality_read" ON public.variance_materiality;
CREATE POLICY "variance_materiality_read" ON public.variance_materiality FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "variance_materiality_write" ON public.variance_materiality;
CREATE POLICY "variance_materiality_write" ON public.variance_materiality FOR ALL TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE ((firm_members.user_id = auth.uid()) AND (firm_members.role = ANY (ARRAY['owner'::text, 'partner'::text, 'manager'::text]))))));
DROP POLICY IF EXISTS "runs_insert" ON public.variance_runs;
CREATE POLICY "runs_insert" ON public.variance_runs FOR INSERT TO authenticated WITH CHECK (((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))) AND (triggered_by = auth.uid())));
DROP POLICY IF EXISTS "runs_read" ON public.variance_runs;
CREATE POLICY "runs_read" ON public.variance_runs FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "xbrl_concept_map_read" ON public.xbrl_concept_map;
CREATE POLICY "xbrl_concept_map_read" ON public.xbrl_concept_map FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "xbrl_doc_read" ON public.xbrl_instance_documents;
CREATE POLICY "xbrl_doc_read" ON public.xbrl_instance_documents FOR SELECT TO authenticated USING ((company_id IN ( SELECT firm_members.company_id
   FROM firm_members
  WHERE (firm_members.user_id = auth.uid()))));
DROP POLICY IF EXISTS "xbrl_issues_read" ON public.xbrl_validation_issues;
CREATE POLICY "xbrl_issues_read" ON public.xbrl_validation_issues FOR SELECT TO authenticated USING ((document_id IN ( SELECT xd.id
   FROM xbrl_instance_documents xd
  WHERE (xd.company_id IN ( SELECT firm_members.company_id
           FROM firm_members
          WHERE (firm_members.user_id = auth.uid()))))));

-- account_pl_mapping: allow role-gated correction and removal of company-specific mapping rules
DROP POLICY IF EXISTS "account_pl_mapping_update" ON public.account_pl_mapping;
CREATE POLICY "account_pl_mapping_update" ON public.account_pl_mapping FOR UPDATE TO authenticated
  USING (company_id IN ( SELECT firm_members.company_id FROM firm_members
    WHERE firm_members.user_id = auth.uid()
      AND firm_members.role = ANY (ARRAY['owner'::text,'partner'::text])))
  WITH CHECK (company_id IN ( SELECT firm_members.company_id FROM firm_members
    WHERE firm_members.user_id = auth.uid()
      AND firm_members.role = ANY (ARRAY['owner'::text,'partner'::text])));
DROP POLICY IF EXISTS "account_pl_mapping_delete" ON public.account_pl_mapping;
CREATE POLICY "account_pl_mapping_delete" ON public.account_pl_mapping FOR DELETE TO authenticated
  USING (company_id IN ( SELECT firm_members.company_id FROM firm_members
    WHERE firm_members.user_id = auth.uid()
      AND firm_members.role = ANY (ARRAY['owner'::text,'partner'::text])));