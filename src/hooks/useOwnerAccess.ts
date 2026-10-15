import { useCallback, useEffect, useState } from "react";
import { callAccessRpc } from "@/lib/access/accessRpc";

export interface EntityCapacity {
  capacity: number | null;
  unlimited: boolean;
  determined: boolean;
  plan_code: string | null;
  source: string | null;
}
export interface AccessOverride {
  id: string;
  feature_code: string;
  capacity_value: number | null;
  unlimited: boolean;
  effective_end: string | null;
  reason: string;
}
export interface AccessAccount {
  billing_customer_id: string;
  owner_user_id: string;
  is_platform_owner: boolean;
  entity_capacity: EntityCapacity;
  active_overrides: AccessOverride[];
}
export interface AccessMatrix {
  capabilities: string[];
  roles: Record<string, string[]>;
}
export interface GrantEvent {
  id: string;
  recipient_user_id: string;
  grant_kind: string;
  capability: string | null;
  source: string;
  allowance: unknown;
  effective_end: string | null;
  actor_user_id: string;
  reason: string;
  created_at: string;
}

/** Read-only projections for the Access console. The server (an active commercial_admins row) decides who may read. */
export function useOwnerAccess() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [matrix, setMatrix] = useState<AccessMatrix | null>(null);
  const [accounts, setAccounts] = useState<AccessAccount[]>([]);
  const [history, setHistory] = useState<GrantEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const ov = await callAccessRpc("get_access_overview");
    if (ov.error) {
      const forbidden = ov.error.code === "42501" || /NOT_AN_ADMIN/.test(ov.error.message);
      setAllowed(forbidden ? false : null);
      if (!forbidden) setError("Access administration is temporarily unavailable.");
      setLoading(false);
      return;
    }
    setAllowed(true);
    const o = ov.data as { accounts?: AccessAccount[] } | null;
    setAccounts(Array.isArray(o?.accounts) ? o!.accounts : []);
    const [mx, h] = await Promise.all([
      callAccessRpc("get_access_matrix"),
      callAccessRpc("get_access_grant_history", { p_recipient_user_id: null, p_limit: 200 }),
    ]);
    if (!mx.error) setMatrix(mx.data as AccessMatrix);
    if (!h.error) {
      const hd = h.data as { events?: GrantEvent[] } | null;
      setHistory(Array.isArray(hd?.events) ? hd!.events : []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  return { allowed, loading, matrix, accounts, history, error, reload: load };
}
