// Runs REAL Edge Function handlers against a disposable PostgreSQL. Only the network edge is replaced:
//   · std `serve` captures the handler;
//   · supabase-js `createClient` returns a small PostgREST-like client that executes every request in its own
//     transaction as the caller's real database role (`authenticated` with the JWT subject, `anon`, or `service_role`),
//     so row-level security, triggers and grants apply exactly as in production;
//   · `fetch` to the functions host is answered locally (function-to-function calls do nothing).
// PostgREST conventions kept: errors are returned (never thrown) with SQLSTATE codes; an undefined function is PGRST202;
// .single() on not-exactly-one row is PGRST116; an INSERT without .select() returns no rows (return=minimal).
//
// Used by scripts/db-proof/reconciliationFunctionMatrix.mjs and scripts/db-proof/safishaIngestion.mjs (bun).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SERVICE_KEY = "service-key";
export const ANON_KEY = "anon-key";
export const FUNCTIONS_HOST = "http://functions.invalid";

const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`); return s; };
const val = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

export function makeClient(pool, role, uid) {
  const run = async (sql, params) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ${role}`);
      await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]);
      const r = await c.query(sql, params);
      await c.query("COMMIT");
      return { rows: r.rows, error: null };
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch { /* */ }
      return { rows: null, error: { code: e.code === "42883" ? "PGRST202" : e.code, message: e.message } };
    } finally { c.release(); }
  };
  return {
    auth: { getUser: async () => (role === "authenticated" && uid ? { data: { user: { id: uid } }, error: null } : { data: { user: null }, error: { message: "no user" } }) },
    async rpc(fn, args = {}) {
      const keys = Object.keys(args);
      const r = await run(`SELECT public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")}) AS r`, keys.map((k) => val(args[k])));
      return r.error ? { data: null, error: r.error } : { data: r.rows[0].r, error: null };
    },
    from(table) {
      ident(table);
      const q = { op: "select", cols: "*", where: [], params: [], values: null, returning: null, single: false, maybe: false, order: "", limit: "" };
      const exec = async () => {
        let sql;
        const where = () => (q.where.length ? ` WHERE ${q.where.join(" AND ")}` : "");
        if (q.op === "select") sql = `SELECT ${q.cols} FROM public.${table}${where()}${q.order}${q.limit}`;
        if (q.op === "delete") sql = `DELETE FROM public.${table}${where()}`;
        if (q.op === "update") {
          const keys = Object.keys(q.values); const base = q.params.length;
          sql = `UPDATE public.${table} SET ${keys.map((k, i) => `${ident(k)} = $${base + i + 1}`).join(", ")}${where()}`;
          q.params.push(...keys.map((k) => val(q.values[k])));
        }
        if (q.op === "insert") {
          const rows = Array.isArray(q.values) ? q.values : [q.values];
          const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
          const tuples = rows.map((r) => `(${keys.map((k) => { q.params.push(val(r[k] ?? null)); return `$${q.params.length}`; }).join(", ")})`);
          sql = `INSERT INTO public.${table} (${keys.map(ident).join(", ")}) VALUES ${tuples.join(", ")}`;
        }
        if (q.returning) sql += ` RETURNING ${q.returning}`;
        const r = await run(sql, q.params);
        if (r.error) return { data: null, error: r.error };
        if (q.single) return r.rows.length === 1 ? { data: r.rows[0], error: null } : { data: null, error: { code: "PGRST116", message: `expected one row, got ${r.rows.length}` } };
        if (q.maybe) return { data: r.rows[0] ?? null, error: null };
        return { data: q.op === "select" || q.returning ? r.rows : null, error: null };
      };
      const b = {
        select(cols = "*") { if (!/^[a-z_, *]+$/.test(cols)) throw new Error(`bad columns ${cols}`); if (q.op === "select") q.cols = cols; else q.returning = cols; return b; },
        insert(v) { q.op = "insert"; q.values = v; return b; },
        update(v) { q.op = "update"; q.values = v; return b; },
        delete() { q.op = "delete"; return b; },
        eq(col, v) { q.params.push(val(v)); q.where.push(`${ident(col)} = $${q.params.length}`); return b; },
        in(col, vs) { q.params.push(vs); q.where.push(`${ident(col)} = ANY($${q.params.length})`); return b; },
        order(col, opts) { q.order = ` ORDER BY ${ident(col)} ${opts?.ascending === false ? "DESC" : "ASC"}`; return b; },
        limit(n) { q.limit = ` LIMIT ${Number(n)}`; return b; },
        single() { q.single = true; return exec(); },
        maybeSingle() { q.maybe = true; return exec(); },
        then(ok, bad) { return exec().then(ok, bad); },
      };
      return b;
    },
  };
}

/** The shared state the loaded handlers use: the database pool the next request runs against. */
export const shim = { pool: null, handler: null };
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: FUNCTIONS_HOST, SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY })[k] } };
globalThis.__fnHarness = {
  serve: (h) => { shim.handler = h; },
  createClient: (_url, key, opts) => {
    if (key === SERVICE_KEY) return makeClient(shim.pool, "service_role", null);
    const uid = (opts?.global?.headers?.Authorization ?? "").replace(/^Bearer\s+/, "");
    return uid && uid !== ANON_KEY ? makeClient(shim.pool, "authenticated", uid) : makeClient(shim.pool, "anon", null);
  },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => (String(u).startsWith(`${FUNCTIONS_HOST}/`) ? new Response("{}", { status: 200 }) : realFetch(u, init));

const SERVE_IMPORT = 'import { serve } from "https://deno.land/std@0.168.0/http/server.ts";';
const CLIENT_IMPORT = 'import { createClient } from "https://esm.sh/@supabase/supabase-js@2";';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fn-harness-"));
process.on("exit", () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

/** Loads a handler from its source text with only the two network imports replaced. */
export async function loadHandler(source, name) {
  if (!source.includes(SERVE_IMPORT) || !source.includes(CLIENT_IMPORT)) throw new Error(`${name}: unexpected imports — the harness must be updated with the function`);
  const file = path.join(tmp, `${name}.ts`);
  fs.writeFileSync(file, source.replace(SERVE_IMPORT, "const { serve } = globalThis.__fnHarness;").replace(CLIENT_IMPORT, "const { createClient } = globalThis.__fnHarness;"));
  shim.handler = null;
  await import(pathToFileURL(file).href);
  if (!shim.handler) throw new Error(`${name}: no handler registered`);
  return shim.handler;
}

/** One request to a loaded handler, as `bearer` (a user id, or null for an anonymous call), against `pool`. */
export async function call(handler, pool, bearer, body) {
  shim.pool = pool;
  const headers = { Authorization: `Bearer ${bearer ?? ANON_KEY}` };
  const init = { method: "POST", headers, body };
  if (!(body instanceof FormData)) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await handler(new Request(`${FUNCTIONS_HOST}/fn`, init));
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { http: res.status, body: json };
}
