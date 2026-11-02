import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { QBO_ENVIRONMENT } from "@/lib/workspace/qboConnectorClient";
import { optedIn, sandboxActor, type SandboxAccessDeps, type SandboxScope } from "@/lib/workspace/qboSandboxAccess";

export const sandboxAccessDeps: SandboxAccessDeps = {
  currentUser: async () => { const { data, error } = await supabase.auth.getUser(); return error ? null : data.user?.id ?? null; },
  platformOwner: async (userId) => { const { data, error } = await supabase.rpc("is_platform_owner", { p_user: userId }); return !error && data === true; },
  workspaceOwner: async (companyId) => { const { data, error } = await supabase.from("companies").select("user_id").eq("id", companyId).maybeSingle(); return error ? null : data?.user_id ?? null; },
  hasSources: async (companyId) => { const { data, error } = await supabase.from("trial_balance_uploads").select("id").eq("company_id", companyId).limit(1); return error || !Array.isArray(data) ? null : data.length > 0; },
};
export const sandboxStorage = () => { try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; } };

/** A per-tab opt-in plus fresh platform-owner and workspace-owner reads. Ordinary customers make no extra reads. */
export function useQboSandboxAccess(scope: SandboxScope, check: boolean): boolean {
  const [verified, setVerified] = useState<(SandboxScope & { actor: string }) | null>(null);
  const actorRef = useRef<string | null>(null);
  const { companyId, periodYear } = scope;
  useEffect(() => {
    const scope = { companyId, periodYear };
    setVerified(null); actorRef.current = null;
    if (!check || QBO_ENVIRONMENT !== "sandbox" || !optedIn(sandboxStorage(), scope)) return;
    let live = true, generation = 0;
    const verify = () => {
      if (!live) return;
      const ticket = ++generation;
      setVerified(null);
      void sandboxActor(sandboxAccessDeps, scope.companyId).then(actor => {
        if (live && ticket === generation && actor && optedIn(sandboxStorage(), scope) === actor) {
          actorRef.current = actor; setVerified({ ...scope, actor });
        }
      });
    };
    verify();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      // A normal token refresh must not unmount an in-flight import. An identity change must invalidate it immediately.
      if ((session?.user?.id ?? null) !== actorRef.current) { generation++; setVerified(null); queueMicrotask(verify); }
    });
    return () => { live = false; generation++; data.subscription.unsubscribe(); };
  }, [companyId, periodYear, check]);
  return check && QBO_ENVIRONMENT === "sandbox" && verified?.companyId === scope.companyId && verified.periodYear === scope.periodYear;
}
