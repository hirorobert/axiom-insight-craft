/** Server reporting access, re-read by the workspace refresh. Never a browser grant. */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { parseReportingAccess, type ReportingAccess } from "@/lib/reporting/access";
import { useWorkspaceRefresh } from "./useWorkspaceRefresh";
type AccessRpc = { rpc(name: "financial_statements_workspace_access", args: { p_company_id: string }): PromiseLike<{ data: unknown; error: unknown }> };
export function useReportingAccess(companyId: string | null | undefined): ReportingAccess {
  const [state, setState] = useState<ReportingAccess>({ state: "loading" });
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const mine=++sequence.current;
    if (!companyId) { setState({state:"disabled",reason:"NO_COMPANY"}); return false; }
    try {
      const {data,error}=await (supabase as unknown as AccessRpc).rpc("financial_statements_workspace_access",{p_company_id:companyId});
      const next=error ? {state:"disabled",reason:"UNKNOWN"} as const : parseReportingAccess(data);
      if (mine === sequence.current) setState(next);
      return !error && !(next.state === "disabled" && next.reason === "UNKNOWN");
    } catch { if (mine === sequence.current) setState({state:"disabled",reason:"UNKNOWN"}); return false; }
  }, [companyId]);
  useEffect(() => { setState({state:"loading"}); void load(); return () => {++sequence.current;}; }, [load]);
  useWorkspaceRefresh(companyId,load);
  return state;
}
