import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { parseWorkspaceCommercialState, type WorkspaceCommercialState } from "@/lib/commercial/paidActions";

/**
 * Reads what the signed-in user may see about one workspace's plan (get_workspace_commercial_state). Explanatory
 * only: every paid action is still refused by the server when not entitled. A read failure yields `state: null`
 * (callers show the action as unavailable-for-now, never as allowed).
 */
export function useWorkspaceCommercialState(companyId: string | null | undefined): {
  state: WorkspaceCommercialState | null;
  loading: boolean;
} {
  const [state, setState] = useState<WorkspaceCommercialState | null>(null);
  const [loading, setLoading] = useState<boolean>(!!companyId);

  useEffect(() => {
    let cancelled = false;
    if (!companyId) {
      setState(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      const { data, error } = await supabase.rpc("get_workspace_commercial_state" as never, { p_company_id: companyId } as never);
      if (cancelled) return;
      setState(error ? null : parseWorkspaceCommercialState(data));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId]);

  return { state, loading };
}
