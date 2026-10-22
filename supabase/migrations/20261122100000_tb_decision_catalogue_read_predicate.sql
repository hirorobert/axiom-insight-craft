-- The fixed Trial Balance decision catalogues (tb_decision_rules, tb_decision_actions) hold no tenant data, but their read
-- policies used USING (true). Same visibility, explicit predicate (precedent: xbrl_concept_map_read, 20260927041019):
-- only a signed-in session may read them. Grants, rows and triggers are unchanged.
DROP POLICY IF EXISTS tdr_read ON public.tb_decision_rules;
CREATE POLICY tdr_read ON public.tb_decision_rules FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS tda_read ON public.tb_decision_actions;
CREATE POLICY tda_read ON public.tb_decision_actions FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
