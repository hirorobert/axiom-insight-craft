/**
 * useAccountHome — the account home's one bounded read (get_account_home via accountHome.ts). Replaces the unbounded
 * useActiveEngagements read on the home: no list of companies, engagements or uploads is fetched in full, and no routing
 * decision is taken from a client list. Fails closed: a failed read is `fetchFailed`, never "nothing".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { fetchAccountHome, type AccountHome } from "@/lib/workspace/accountHome";
import { endExpiredSession, resolveActiveSession } from "@/lib/auth/sessionGuard";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export function useAccountHome(): { loading: boolean; home: AccountHome | null; fetchFailed: boolean; refresh: () => Promise<void> } {
  const { user } = useAuth();
  const [state, setState] = useState<{ loading: boolean; home: AccountHome | null; fetchFailed: boolean }>({ loading: true, home: null, fetchFailed: false });
  const run = useRef(0);
  const load = useCallback(async () => {
    const mine = ++run.current;
    const set = (s: typeof state) => { if (run.current === mine) setState(s); };
    if (!user) { set({ loading: false, home: null, fetchFailed: false }); return; }
    set({ loading: true, home: null, fetchFailed: false });
    if (!(await resolveActiveSession())) { set({ loading: false, home: null, fetchFailed: true }); await endExpiredSession(); return; }
    const home = await fetchAccountHome((fn, args) => (supabase.rpc as unknown as Rpc)(fn, args)).catch(() => null);
    set({ loading: false, home, fetchFailed: home === null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  useEffect(() => { void load(); }, [load]);
  return { ...state, refresh: load };
}
