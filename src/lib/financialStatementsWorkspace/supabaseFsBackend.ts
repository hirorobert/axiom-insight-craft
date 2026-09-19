// financialStatementsWorkspace/supabaseFsBackend.ts — the ONE adapter between
// FsRpcTransport and the Supabase client.
//
// It uses the caller's own authenticated client (the anon key + the user's JWT):
// every RPC runs as `authenticated` and every read is filtered by RLS to accepted
// members of the company. This module has no service-role reference, never sends
// an actor id, and is constructed only by createWorkspaceTransport() below, which
// refuses to build a transport unless the source-controlled persistence gate is on.

import { supabase } from "@/integrations/supabase/client";
import { FINANCIAL_STATEMENT_PERSISTENCE_ENABLED } from "./persistenceGate";
import { FsRpcTransport, type FsBackend } from "./rpcTransport";

export const supabaseFsBackend: FsBackend = {
  async rpc(fn, args) {
    // The generated client types know only the functions of the generated schema; these RPCs are
    // introduced by an unapplied migration, so the call is intentionally untyped.
    const { data, error } = await (supabase as unknown as { rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message: string } | null }> }).rpc(fn, { ...args });
    return { data, error };
  },
  async select(table, filters) {
    let query = (supabase as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string | number) => unknown } } }).from(table).select("*") as { eq: (k: string, v: string | number) => unknown };
    for (const [k, v] of Object.entries(filters)) query = query.eq(k, v) as typeof query;
    const { data, error } = (await (query as unknown as Promise<{ data: Record<string, unknown>[] | null; error: { code?: string; message: string } | null }>));
    return { data, error };
  },
};

/** Returns a transport only when persistence is enabled in source; otherwise null, and no network call is ever made. */
export function createWorkspaceTransport(gate: boolean = FINANCIAL_STATEMENT_PERSISTENCE_ENABLED): FsRpcTransport | null {
  return gate ? new FsRpcTransport(supabaseFsBackend) : null;
}
