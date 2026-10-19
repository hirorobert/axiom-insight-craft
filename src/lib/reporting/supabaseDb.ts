// reporting/supabaseDb.ts — the reporting workbench's transport over the app's Supabase client: RPCs and RLS-scoped
// selects only. It holds no client of its own (the page passes the app's), and it never writes a table.
import type { ReportingDb } from "./signoff";

interface SupabaseLike {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  from(table: string): { select(columns: string): { match(filters: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> } };
  functions?: { invoke(name: string, options: { body: unknown }): PromiseLike<{ data: unknown; error: unknown }> };
}

export function supabaseReportingDb(client: unknown): ReportingDb {
  const c = client as SupabaseLike;
  return {
    rpc: (fn, args) => c.rpc(fn, args),
    select: (table, filters) => c.from(table).select("*").match(filters),
    invoke: async (name, body) => {
      if (!c.functions) return { data: null, error: { message: "Server functions are not reachable from this page." } };
      const r = await c.functions.invoke(name, { body });
      return { data: r.data, error: r.error ? { message: String((r.error as { message?: string }).message ?? r.error) } : null };
    },
  };
}
