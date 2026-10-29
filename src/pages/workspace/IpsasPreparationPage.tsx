/**
 * IPSAS accrual preparation (first chain) at /workspace/:companyId/:periodYear/ipsas. Reads and writes only through the
 * ipsas_* server functions; the server decides access (capability, rollout, framework) and this page shows its answer.
 */
import { useMemo } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceCapabilities } from "@/hooks/useWorkspaceCapabilities";
import { supabase } from "@/integrations/supabase/client";
import { supabaseReportingDb } from "@/lib/reporting/supabaseDb";
import { IpsasPreparation } from "@/components/ipsas/IpsasPreparation";

export default function IpsasPreparationPage() {
  const { companyId, periodYear, company } = useWorkspace();
  const { state: caps } = useWorkspaceCapabilities(companyId);
  const db = useMemo(() => supabaseReportingDb(supabase), []);
  const allowed = caps?.allowed ?? [];
  return (
    <IpsasPreparation key={`${companyId}:${periodYear}`} companyId={companyId} periodYear={periodYear} legalName={company?.name ?? "The entity"} db={db}
      canPrepare={allowed.includes("prepare_close")} canConfirm={allowed.includes("review_close")} prepareHref={`/workspace/${companyId}/${periodYear}/prepare`} />
  );
}
