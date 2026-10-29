/**
 * IPSAS accrual preparation (first chain) at /workspace/:companyId/:periodYear/ipsas. Reads and writes only through the
 * ipsas_* server functions; the server decides access (capability, rollout, framework) and this page shows its answer.
 */
import { useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceCapabilities } from "@/hooks/useWorkspaceCapabilities";
import { supabase } from "@/integrations/supabase/client";
import { supabaseReportingDb } from "@/lib/reporting/supabaseDb";
import { IpsasPreparation } from "@/components/ipsas/IpsasPreparation";

export default function IpsasPreparationPage() {
  const { companyId, periodYear, company } = useWorkspace();
  const { state: caps } = useWorkspaceCapabilities(companyId);
  const { user } = useAuth();
  const actor = user?.id ?? "signed-out";
  // One mounted preparation per company, period AND signed-in actor: any of the three changing remounts it, so no in-flight answer, draft,
  // request identity or recovery state can cross to another scope or person (and the component also guards this itself).
  const db = useMemo(() => supabaseReportingDb(supabase), [actor]); // eslint-disable-line react-hooks/exhaustive-deps
  const allowed = caps?.allowed ?? [];
  return (
    <IpsasPreparation key={`${companyId}:${periodYear}:${actor}`} companyId={companyId} periodYear={periodYear} legalName={company?.name ?? "The entity"} db={db}
      canPrepare={allowed.includes("prepare_close")} canConfirm={allowed.includes("review_close")} prepareHref={`/workspace/${companyId}/${periodYear}/prepare`} />
  );
}
