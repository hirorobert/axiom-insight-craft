import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { parseMyWorkspaceCapabilities, type MyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";
import { reviewActionGate, type ReviewActionGate } from "@/lib/workspace/unavailableService";

/**
 * For each company, what the signed-in person may do there (get_my_workspace_capabilities — the existing authoritative
 * read), projected to the hub's Trial balance review action. Explanatory only: the write is still decided by the server.
 * Until a company's answer arrives its gate is "checking" (never "allowed").
 */
export function useReviewActionAccess(companyIds: readonly string[]): Record<string, ReviewActionGate> {
  const key = [...new Set(companyIds)].sort().join(",");
  const [answers, setAnswers] = useState<Record<string, MyWorkspaceCapabilities | null>>({});
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const ids = key ? key.split(",") : [];
    setAnswers({});
    setDone(new Set());
    for (const id of ids) {
      (async () => {
        let parsed: MyWorkspaceCapabilities | null = null;
        try {
          const { data, error } = await supabase.rpc("get_my_workspace_capabilities" as never, { p_company_id: id } as never);
          parsed = error ? null : parseMyWorkspaceCapabilities(data);
        } catch {
          parsed = null;
        }
        if (cancelled) return;
        setAnswers((a) => ({ ...a, [id]: parsed }));
        setDone((d) => new Set(d).add(id));
      })();
    }
    return () => { cancelled = true; };
  }, [key]);

  return useMemo(() => {
    const out: Record<string, ReviewActionGate> = {};
    for (const id of key ? key.split(",") : []) out[id] = reviewActionGate(!done.has(id), answers[id]);
    return out;
  }, [key, answers, done]);
}
