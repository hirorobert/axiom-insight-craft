import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { parseMyWorkspaceCapabilities, type MyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";
import { accessQueryKey, gatesForKey, type ReviewActionGate } from "@/lib/workspace/unavailableService";

export interface ReviewActionAccess {
  gates: Record<string, ReviewActionGate>;
  /** Re-read every company's answer (e.g. after a refused or failed grant). Gates show "checking" until it returns. */
  refresh: () => void;
}

/**
 * For each company, what the signed-in person may do there (get_my_workspace_capabilities — the existing authoritative
 * read), projected to the hub's Trial balance review action. Explanatory only: the write is still decided by the server.
 *
 * The answers belong to ONE authenticated identity. They are keyed by the user id as well as the companies and a refresh
 * generation (accessQueryKey), so a sign-out, a sign-in as someone else or a refresh discards every earlier answer at
 * once, and a late answer for an earlier key is dropped. Until a company's answer arrives for the current key its gate
 * is "checking" (never "allowed"). No identity → no reads; every gate stays "checking".
 */
export function useReviewActionAccess(companyIds: readonly string[]): ReviewActionAccess {
  const { user } = useAuth();
  const [generation, setGeneration] = useState(0);
  const key = accessQueryKey(user?.id ?? null, companyIds, generation);
  const [answers, setAnswers] = useState<{ keyId: string; byCompany: Record<string, MyWorkspaceCapabilities | null> }>({ keyId: key.id, byCompany: {} });

  useEffect(() => {
    let cancelled = false;
    setAnswers({ keyId: key.id, byCompany: {} });
    if (!key.userId) return () => { cancelled = true; };
    for (const id of key.companyIds) {
      (async () => {
        let parsed: MyWorkspaceCapabilities | null = null;
        try {
          const { data, error } = await supabase.rpc("get_my_workspace_capabilities" as never, { p_company_id: id } as never);
          parsed = error ? null : parseMyWorkspaceCapabilities(data);
        } catch {
          parsed = null;
        }
        if (cancelled) return;
        // Only an answer for the CURRENT identity + company set + refresh generation is kept.
        setAnswers((a) => (a.keyId === key.id ? { keyId: a.keyId, byCompany: { ...a.byCompany, [id]: parsed } } : a));
      })();
    }
    return () => { cancelled = true; };
    // key.id captures the user id, the companies and the refresh generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key.id]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const gates = useMemo(() => gatesForKey(key, answers), [key.id, answers]);
  return { gates, refresh };
}
