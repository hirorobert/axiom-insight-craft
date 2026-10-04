// Test double for https://esm.sh/@supabase/supabase-js@2, used ONLY by functionPath.test.ts through import_map.json.
// An in-memory database with the query-builder surface process-trial-balance uses (select/eq/is/in/or/order/limit,
// single/maybeSingle, insert…select, update…eq), programmable RPCs, Storage downloads and auth.getClaims. Every call is
// recorded so the test can assert what the REAL handler did. No network.

export type Row = Record<string, unknown>;
// The real module also exports the client type (actor.ts annotates a parameter with it).
// deno-lint-ignore no-explicit-any
export type SupabaseClient<_D = any, _S = any, _T = any> = any;
export type Answer = { data: unknown; error: { code?: string; message: string } | null };

export interface World {
  tables: Record<string, Row[]>;
  rpc: Record<string, (args: Record<string, unknown>) => Answer | Promise<Answer>>;
  storage: Record<string, Uint8Array>;
  claims: { sub: string; exp: number } | null;
  /** Make a table's reads fail (simulates an unavailable database for that table). */
  failReads: Set<string>;
  calls: { kind: "select" | "insert" | "update" | "rpc" | "download"; target: string; payload?: unknown }[];
  nextId: number;
}

export function newWorld(): World {
  return { tables: {}, rpc: {}, storage: {}, claims: null, failReads: new Set(), calls: [], nextId: 1 };
}

const g = globalThis as unknown as { __ptbWorld?: World };
export function setWorld(w: World): void { g.__ptbWorld = w; }
function world(): World {
  if (!g.__ptbWorld) throw new Error("functionpath: no world set");
  return g.__ptbWorld;
}

type Filter = (r: Row) => boolean;
const UNIQUE: Record<string, string[]> = {
  idempotency_keys: ["company_id", "function_name", "client_request_id", "firm_member_id", "actor_user_id"],
};

class Query implements PromiseLike<Answer> {
  private filters: Filter[] = [];
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row | Row[] | null = null;
  private wantRows = true;
  private cardinality: "many" | "single" | "maybe" = "many";
  constructor(private readonly table: string) {}

  select(_cols?: string) { this.wantRows = true; return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  is(col: string, val: unknown) { this.filters.push((r) => (r[col] ?? null) === val); return this; }
  in(col: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
  or(expr: string) {
    const parts = expr.split(",").map((p) => p.split("."));
    this.filters.push((r) => parts.some(([c, op, v]) => (op === "eq" ? String(r[c]) === v : op === "is" && v === "null" ? (r[c] ?? null) === null : false)));
    return this;
  }
  not(col: string, op: string, val: unknown) { this.filters.push((r) => !(op === "is" ? (r[col] ?? null) === val : r[col] === val)); return this; }
  order() { return this; }
  limit() { return this; }
  single() { this.cardinality = "single"; return this; }
  maybeSingle() { this.cardinality = "maybe"; return this; }
  insert(p: Row | Row[]) { this.mode = "insert"; this.payload = p; this.wantRows = false; return this; }
  update(p: Row) { this.mode = "update"; this.payload = p; return this; }

  private run(): Answer {
    const w = world();
    const rows = (w.tables[this.table] ??= []);
    if (this.mode === "insert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const inserted: Row[] = [];
      for (const p of list) {
        const keys = UNIQUE[this.table];
        if (keys && rows.some((r) => keys.every((k) => (r[k] ?? null) === (p[k] ?? null)))) {
          w.calls.push({ kind: "insert", target: this.table, payload: { rejected: "23505", row: p } });
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        const row: Row = { id: `${this.table}-${w.nextId++}`, started_at: new Date().toISOString(), status: this.table === "idempotency_keys" ? "reserved" : (p.status ?? "running"), ...p };
        rows.push(row);
        inserted.push(row);
      }
      w.calls.push({ kind: "insert", target: this.table, payload: list });
      return this.shape(inserted);
    }
    if (this.mode === "update") {
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of hit) Object.assign(r, this.payload);
      w.calls.push({ kind: "update", target: this.table, payload: { ...(this.payload as Row), matched: hit.length } });
      return { data: hit, error: null };
    }
    w.calls.push({ kind: "select", target: this.table });
    if (w.failReads.has(this.table)) return { data: null, error: { code: "08006", message: "connection failure" } };
    return this.shape(rows.filter((r) => this.filters.every((f) => f(r))));
  }

  // Like a real database, a read returns COPIES: later writes never change a row the caller already holds.
  private shape(rows: Row[]): Answer {
    const found = rows.map((r) => structuredClone(r));
    if (this.cardinality === "single") return found.length === 1 ? { data: found[0], error: null } : { data: null, error: { code: "PGRST116", message: "not exactly one row" } };
    if (this.cardinality === "maybe") return { data: found[0] ?? null, error: null };
    return { data: found, error: null };
  }

  then<A = Answer, B = never>(ok?: ((v: Answer) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.run()).then(ok, bad);
  }
}

// Typed `any` on purpose: index.ts is type-checked against the REAL client types separately (deno check index.ts).
// deno-lint-ignore no-explicit-any
export function createClient(_url: string, _key: string, _opts?: unknown): any {
  return {
    from: (table: string) => new Query(table),
    rpc: async (name: string, args: Record<string, unknown>): Promise<Answer> => {
      const w = world();
      w.calls.push({ kind: "rpc", target: name, payload: args });
      const fn = w.rpc[name];
      if (!fn) return { data: null, error: { code: "42883", message: `no double for ${name}` } };
      return await fn(args);
    },
    storage: {
      from: (_bucket: string) => ({
        download: async (path: string) => {
          const w = world();
          w.calls.push({ kind: "download", target: path });
          const bytes = w.storage[path];
          return bytes ? { data: new Blob([bytes as unknown as BlobPart]), error: null } : { data: null, error: { statusCode: "404", message: "Object not found" } };
        },
      }),
    },
    auth: {
      getClaims: async (_token: string) => {
        const c = world().claims;
        return c ? { data: { claims: c }, error: null } : { data: null, error: { message: "invalid" } };
      },
    },
  };
}
