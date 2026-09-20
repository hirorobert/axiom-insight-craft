/**
 * useDataStart — the data-start decision of ONE workspace (engagement). Server-authoritative and shared: every authorised
 * member, browser and session reads the same value. Nothing here consults a URL parameter, local storage or history.
 *
 * `record` sends the state this client last saw as `expected`, so a stale or conflicting decision is refused by the server
 * with an explicit CONFLICT (the hook then re-reads the truth). An exact replay converges.
 */

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getSetupState, recordDataStart, WorkspaceSetupError, type RpcClient } from "@/lib/workspace/workspaceSetupClient";
import type { DataStartChoice } from "@/lib/workspace/onboardingState";

const client = supabase as unknown as RpcClient;

export function useDataStart(engagementId: string | null) {
  const [choice, setChoice] = useState<DataStartChoice | null>(null);
  const [loading, setLoading] = useState<boolean>(!!engagementId);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!engagementId) {
      setChoice(null);
      setLoading(false);
      return;
    }
    try {
      setChoice((await getSetupState(client, engagementId)).dataStart);
    } catch {
      setChoice(null);
    } finally {
      setLoading(false);
    }
  }, [engagementId]);

  useEffect(() => {
    setLoading(!!engagementId);
    void refresh();
  }, [engagementId, refresh]);

  /** Persists first, then updates local state: the UI never runs ahead of the server. Resolves true on success. */
  const record = useCallback(
    async (next: DataStartChoice): Promise<boolean> => {
      if (!engagementId || saving) return false;
      setSaving(true);
      try {
        const r = await recordDataStart(client, engagementId, next, choice);
        setChoice(r.dataStart);
        return true;
      } catch (e) {
        if (e instanceof WorkspaceSetupError && e.kind === "CONFLICT") await refresh(); // someone else decided first: show the truth
        return false;
      } finally {
        setSaving(false);
      }
    },
    [engagementId, saving, choice, refresh],
  );

  return { choice, loading, saving, record, refresh };
}
