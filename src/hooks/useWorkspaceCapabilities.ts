import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { parseMyWorkspaceCapabilities, type MyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";

/**
 * What the signed-in person may do in one workspace (get_my_workspace_capabilities). Explanatory only: every write is
 * still decided by the database. A read failure yields `state: null` (callers show the action as unavailable).
 */
export function useWorkspaceCapabilities(companyId: string | null | undefined): {
  state: MyWorkspaceCapabilities | null;
  loading: boolean;
  refresh: () => void;
} {
  const [state, setState] = useState<MyWorkspaceCapabilities | null>(null);
  const [loading, setLoading] = useState<boolean>(!!companyId);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (!companyId) {
      setState(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      const { data, error } = await supabase.rpc("get_my_workspace_capabilities" as never, { p_company_id: companyId } as never);
      if (cancelled) return;
      setState(error ? null : parseMyWorkspaceCapabilities(data));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [companyId, tick]);

  return { state, loading, refresh };
}
