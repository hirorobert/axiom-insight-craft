// reporting/supabaseDb.ts — the reporting workbench's transport over the app's Supabase client: RPCs and RLS-scoped
// selects only. It holds no client of its own (the page passes the app's), and it never writes a table.
import type { ReportingDb } from "./signoff";

interface SupabaseLike {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  from(table: string): { select(columns: string): { match(filters: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> } };
}

export function supabaseReportingDb(client: unknown): ReportingDb {
  const c = client as SupabaseLike;
  return {
    rpc: (fn, args) => c.rpc(fn, args),
    select: (table, filters) => c.from(table).select("*").match(filters),
  };
}
