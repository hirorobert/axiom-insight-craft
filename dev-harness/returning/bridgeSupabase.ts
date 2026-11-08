// NON-PRODUCTION HARNESS. A stand-in for src/integrations/supabase/client for the Trial Balance Review page ONLY, answering every call over the
// LOOPBACK bridge of scripts/db-proof/serveReturning.mjs (RETURNING_SCENE=start): a disposable PostgreSQL where row-level security, grants and the
// functions' own checks decide, the REAL process-trial-balance handler runs in the bridge, and uploads go through the same reserve -> signed URL ->
// register sequence the app uses. `x-sim-user` names a fixture user; it is NOT authentication (there is no GoTrue). Refuses any non-loopback bridge.
import { assertLoopback } from "../reporting/bridgeDb";

const q = new URLSearchParams(window.location.search);
export const BRIDGE = q.get("bridge") ?? "http://127.0.0.1:54996";
export const SIM_USER = q.get("as") ?? "preparer";
assertLoopback(BRIDGE);

type Row = Record<string, unknown>;
type Answer = { data: unknown; error: unknown; count?: number | null };
const headers = { "content-type": "application/json", "x-sim-user": SIM_USER };

let seedPromise: Promise<{ users: Record<string, string> }> | null = null;
export function simUserId(): Promise<string> {
  seedPromise ??= fetch(`${BRIDGE}/seed`, { method: "POST", headers, body: "{}" }).then((r) => r.json());
  return seedPromise.then((s) => s.users[SIM_USER]);
}

class Query implements PromiseLike<Answer> {
  private readonly spec: Row = { filters: [] as Row[], orders: [] as Row[], op: "select" };
  constructor(table: string) { this.spec.table = table; }
  private f(x: Row) { (this.spec.filters as Row[]).push(x); return this; }
  select(columns = "*", opts?: { count?: string }) {
    if (this.spec.op !== "select") { this.spec.returning = true; return this; }
    this.spec.columns = columns; if (opts?.count) this.spec.count = true; return this;
  }
  eq(col: string, val: unknown) { return this.f({ kind: "eq", col, val }); }
  neq(col: string, val: unknown) { return this.f({ kind: "neq", col, val }); }
  gt(col: string, val: unknown) { return this.f({ kind: "gt", col, val }); }
  gte(col: string, val: unknown) { return this.f({ kind: "gte", col, val }); }
  lt(col: string, val: unknown) { return this.f({ kind: "lt", col, val }); }
  lte(col: string, val: unknown) { return this.f({ kind: "lte", col, val }); }
  is(col: string, val: unknown) { return this.f({ kind: "is", col, val }); }
  in(col: string, val: unknown[]) { return this.f({ kind: "in", col, val }); }
  not(col: string, op: string, val: unknown) { return this.f({ kind: "not", col, op, val }); }
  or(raw: string) { return this.f({ kind: "or", raw }); }
  order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) { (this.spec.orders as Row[]).push({ col, ascending: o?.ascending !== false, nullsFirst: o?.nullsFirst }); return this; }
  limit(n: number) { this.spec.limit = n; return this; }
  range(a: number, b: number) { this.spec.offset = a; this.spec.limit = b - a + 1; return this; }
  single() { this.spec.card = "single"; return this; }
  maybeSingle() { this.spec.card = "maybe"; return this; }
  insert(payload: Row | Row[]) { this.spec.op = "insert"; this.spec.payload = payload; return this; }
  upsert(payload: Row | Row[]) { return this.insert(payload); }
  update(payload: Row) { this.spec.op = "update"; this.spec.payload = payload; return this; }
  delete() { this.spec.op = "delete"; return this; }
  then<A = Answer, B = never>(ok?: ((v: Answer) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return fetch(`${BRIDGE}/pg/query`, { method: "POST", headers, body: JSON.stringify(this.spec) }).then((r) => r.json() as Promise<Answer>).then(ok, bad);
  }
}

async function rpcCall(name: string, args: Row = {}): Promise<Answer> {
  const r = await fetch(`${BRIDGE}/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
  const json = await r.json().catch(() => null);
  return r.ok ? { data: json, error: null } : { data: null, error: json?.error ?? { message: "rpc failed" } };
}

function rpc(name: string, args: Row = {}) {
  const unwrap = (card: "single" | "maybe") => rpcCall(name, args).then((a) => {
    if (a.error) return a;
    const rows = Array.isArray(a.data) ? a.data : a.data == null ? [] : [a.data];
    return rows.length === 1 || (card === "maybe" && rows.length === 0) ? { data: rows[0] ?? null, error: null } : { data: null, error: { code: "PGRST116", message: "not one row" } };
  });
  const p = rpcCall(name, args);
  return Object.assign(p, { single: () => unwrap("single"), maybeSingle: () => unwrap("maybe") });
}

const user = async () => { const id = await simUserId(); return { id, email: `${SIM_USER}@example.test`, app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: "2026-01-01T00:00:00Z", email_confirmed_at: "2026-01-01T00:00:00Z" }; };

export const supabase = {
  from: (table: string) => new Query(table),
  rpc,
  functions: {
    async invoke(name: string, opts?: { body?: Row }) {
      const r = await fetch(`${BRIDGE}/invoke/${name}`, { method: "POST", headers, body: JSON.stringify(opts?.body ?? {}) });
      const json = await r.json().catch(() => null);
      if (r.ok) return { data: json, error: null };
      return { data: null, error: Object.assign(new Error(json?.error?.message ?? "Edge Function returned a non-2xx status code"), { name: "FunctionsHttpError", context: { status: r.status, json: async () => json } }) };
    },
  },
  storage: {
    from: (_bucket: string) => ({
      async uploadToSignedUrl(path: string, token: string, file: File) {
        const r = await fetch(`${BRIDGE}/storage/upload?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`, { method: "POST", headers: { "x-sim-user": SIM_USER, "content-type": file.type || "application/octet-stream" }, body: file });
        return r.ok ? { data: { path }, error: null } : { data: null, error: { message: "upload failed" } };
      },
      async download() { return { data: null, error: { message: "not available in the harness" } }; },
      async createSignedUrl() { return { data: null, error: { message: "not available in the harness" } }; },
    }),
  },
  auth: {
    getSession: async () => ({ data: { session: { access_token: "harness", expires_at: Math.floor(Date.now() / 1000) + 3600, user: await user() } }, error: null }),
    getUser: async () => ({ data: { user: await user() }, error: null }),
    refreshSession: async () => ({ data: { session: { access_token: "harness" } }, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
  },
  channel: () => { const ch = { on: () => ch, subscribe: () => ch }; return ch; },
  removeChannel: () => undefined,
};
