/**
 * useDataStart — the persisted data choice for one workspace (company × period year), for the signed-in user.
 * Reads on mount, so a refresh, a new tab or a fresh session resolves to exactly the same state.
 */

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { readDataStart, recordDataStart, supabaseDataStartPort } from "@/lib/workspace/dataStartStore";
import type { DataStartChoice } from "@/lib/workspace/onboardingState";

export function useDataStart(companyId: string, periodYear: number) {
  const { user } = useAuth();
  const [choice, setChoice] = useState<DataStartChoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!user || !companyId || !periodYear) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void readDataStart(supabaseDataStartPort(supabase, user.id), companyId, periodYear)
      .then((c) => !cancelled && setChoice(c))
      .catch(() => !cancelled && setChoice(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [user, companyId, periodYear]);

  /** Persists first, then updates local state: the UI never runs ahead of the server. Resolves true on success. */
  const record = useCallback(
    async (next: DataStartChoice): Promise<boolean> => {
      if (!user || saving) return false;
      setSaving(true);
      try {
        await recordDataStart(supabaseDataStartPort(supabase, user.id), companyId, periodYear, next);
        setChoice(next);
        return true;
      } catch {
        return false;
      } finally {
        setSaving(false);
      }
    },
    [user, companyId, periodYear, saving],
  );

  return { choice, loading, saving, record };
}
