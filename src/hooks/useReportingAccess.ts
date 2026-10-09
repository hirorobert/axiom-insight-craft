/**
 * useReportingAccess — the server's answer to "may this signed-in member use reporting for this company?"
 * (financial_statements_workspace_access: membership, kill switch, rollout allow-list). Reads only; fails closed.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { parseReportingAccess, type ReportingAccess } from "@/lib/reporting/access";

type AccessRpc = { rpc(name: "financial_statements_workspace_access", args: { p_company_id: string }): PromiseLike<{ data: unknown; error: unknown }> };

export function useReportingAccess(companyId: string | null | undefined): ReportingAccess {
  const [state, setState] = useState<ReportingAccess>({ state: "loading" });
  useEffect(() => {
    let live = true;
    if (!companyId) { setState({ state: "disabled", reason: "NO_COMPANY" }); return; }
    setState({ state: "loading" });
    (supabase as unknown as AccessRpc).rpc("financial_statements_workspace_access", { p_company_id: companyId }).then(
      ({ data, error }) => { if (live) setState(error ? { state: "disabled", reason: "UNKNOWN" } : parseReportingAccess(data)); },
      () => { if (live) setState({ state: "disabled", reason: "UNKNOWN" }); },
    );
    return () => { live = false; };
  }, [companyId]);
  return state;
}
