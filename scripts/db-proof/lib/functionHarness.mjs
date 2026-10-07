// Runs REAL Edge Function handlers against a disposable PostgreSQL. Only the network edge is replaced:
//   · std `serve` captures the handler;
//   · supabase-js `createClient` returns a small PostgREST-like client that executes every request in its own
//     transaction as the caller's real database role (`authenticated` with the JWT subject, `anon`, or `service_role`),
//     so row-level security, triggers and grants apply exactly as in production;
//   · `fetch` to the functions host is answered locally (function-to-function calls do nothing).
// PostgREST conventions kept: errors are returned (never thrown) with SQLSTATE codes; an undefined function is PGRST202;
// .single() on not-exactly-one row is PGRST116; an INSERT without .select() returns no rows (return=minimal).
//   · Storage downloads are served from `shim.storage` (bucket/path → bytes) set by the proof;
//   · `auth.getClaims(jwt)` decodes the test token's payload (the platform verifies signatures; the proofs mint tokens).
// Supported query surface (anything else throws, so a handler change that needs more fails loudly): select, insert, update,
// delete, eq, in, is (null/true/false), or ("col.eq.v" / "col.is.null|true|false" terms only), order, limit, single,
// maybeSingle, rpc (scalar and set-returning, as PostgREST answers them).
//
// Used by scripts/db-proof/reconciliationFunctionMatrix.mjs, scripts/db-proof/safishaIngestion.mjs and
// scripts/db-proof/tbHandlerCharacterization.mjs (bun).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

export const SERVICE_KEY = "service-key";
export const ANON_KEY = "anon-key";
export const FUNCTIONS_HOST = "http://functions.invalid";

const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`); return s; };
const b64urlJson = (part) => JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
/** The JWT subject of a three-part test token, or null. */
export function jwtSubject(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try { const c = b64urlJson(parts[1]); return typeof c.sub === "string" ? c.sub : null; } catch { return null; }
}
/** A three-part test token (unsigned: the harness stands in for the platform's verification). */
export function mintTestJwt(sub, { expiresIn = 3600 } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + expiresIn })}.harness`;
}
const setReturning = new Map(); // function name → proretset (PostgREST answers a set-returning RPC with an array of rows)
const arrayParams = new Map(); // function name → its input parameters declared as SQL arrays (bound as PostgreSQL arrays)
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
    auth: {
      getUser: async () => (role === "authenticated" && uid ? { data: { user: { id: uid } }, error: null } : { data: { user: null }, error: { message: "no user" } }),
      getClaims: async (token) => {
        const parts = String(token ?? "").split(".");
        if (parts.length !== 3) return { data: null, error: { message: "invalid JWT" } };
        try { return { data: { claims: b64urlJson(parts[1]) }, error: null }; } catch { return { data: null, error: { message: "invalid JWT" } }; }
      },
    },
    storage: {
      from: (bucket) => ({
        download: async (p) => {
          const bytes = shim.storage.get(`${bucket}/${p}`);
          return bytes ? { data: new Blob([bytes]), error: null } : { data: null, error: { message: "Object not found", statusCode: "404" } };
        },
      }),
    },
    async rpc(fn, args = {}) {
      const keys = Object.keys(args);
      const call = `public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")})`;
      if (!setReturning.has(fn)) {
        const c = await pool.connect();
        try {
          setReturning.set(fn, (await c.query("SELECT bool_or(proretset) s FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1", [fn])).rows[0].s === true);
          // Input parameters declared as SQL arrays: PostgREST turns a JSON array argument into a PostgreSQL array for these.
          arrayParams.set(fn, new Set((await c.query(`SELECT a.name FROM pg_proc p,
              LATERAL unnest(p.proargnames, COALESCE(p.proallargtypes, p.proargtypes::oid[]),
                             COALESCE(p.proargmodes, array_fill('i'::"char", ARRAY[cardinality(p.proargtypes::oid[])]))) AS a(name, type, mode)
             WHERE p.pronamespace='public'::regnamespace AND p.proname=$1 AND a.mode IN ('i','b','v') AND format_type(a.type, NULL) LIKE '%[]'`, [fn])).rows.map((x) => x.name)));
        } finally { c.release(); }
      }
      const bind = (k) => (Array.isArray(args[k]) && arrayParams.get(fn).has(k) ? args[k] : val(args[k]));
      if (setReturning.get(fn)) {
        const r = await run(`SELECT * FROM ${call}`, keys.map(bind));
        return r.error ? { data: null, error: r.error } : { data: r.rows, error: null };
      }
      const r = await run(`SELECT ${call} AS r`, keys.map(bind));
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
        is(col, v) {
          if (v !== null && v !== true && v !== false) throw new Error(`is(${col}): only null/true/false`);
          q.where.push(`${ident(col)} IS ${v === null ? "NULL" : v ? "TRUE" : "FALSE"}`); return b;
        },
        or(expr) {
          // PostgREST "a.eq.v,b.is.null" — only eq and is terms; values never contain commas or parentheses here.
          const terms = String(expr).split(",").map((t) => {
            const m = /^([a-z_][a-z0-9_]*)\.(eq|is)\.(.*)$/.exec(t.trim());
            if (!m) throw new Error(`or(): unsupported term ${t}`);
            if (m[2] === "is") {
              if (!["null", "true", "false"].includes(m[3])) throw new Error(`or(): unsupported is value ${m[3]}`);
              return `${ident(m[1])} IS ${m[3].toUpperCase()}`;
            }
            q.params.push(m[3]); return `${ident(m[1])}::text = $${q.params.length}`;
          });
          q.where.push(`(${terms.join(" OR ")})`); return b;
        },
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
export const shim = { pool: null, handler: null, storage: new Map() };
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: FUNCTIONS_HOST, SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY })[k] } };
globalThis.__fnHarness = {
  serve: (h) => { shim.handler = h; },
  createClient: (_url, key, opts) => {
    if (key === SERVICE_KEY) return makeClient(shim.pool, "service_role", null);
    const bearer = (opts?.global?.headers?.Authorization ?? "").replace(/^Bearer\s+/, "");
    // A three-part token acts as its JWT subject (as PostgREST does); a bare id keeps the older proofs' convention.
    const uid = jwtSubject(bearer) ?? bearer;
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

/**
 * Loads a handler that imports sibling and ../_shared modules: the function directory and _shared are copied to a temporary
 * tree and ONLY these remote specifiers are rewritten — std serve and supabase-js to the harness, esm.sh xlsx@0.18.5 to the
 * identical npm package in node_modules. Every other byte is the repository's. Returns the handler and the SHA-256 of the
 * function's unmodified index.ts.
 */
/**
 * Writes `fnName` and `_shared` exactly as they are at git commit `ref` into a fresh directory (for running a previous
 * engine beside the current one). The commit must be present locally (CI fetches it). Returns that functions directory.
 */
export function functionsAtCommit(repo, ref, fnName) {
  const dir = fs.mkdtempSync(path.join(tmp, `at-${ref.slice(0, 7)}-`));
  const prefixes = [`supabase/functions/${fnName}/`, "supabase/functions/_shared/"];
  const files = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", ref, ...prefixes], { encoding: "utf8" }).split("\n").filter(Boolean);
  if (!files.some((f) => f === `supabase/functions/${fnName}/index.ts`)) throw new Error(`${fnName}/index.ts not found at ${ref}`);
  for (const f of files) {
    const out = path.join(dir, f.slice("supabase/functions/".length));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, execFileSync("git", ["-C", repo, "show", `${ref}:${f}`], { maxBuffer: 64 * 1024 * 1024 }));
  }
  return dir;
}

/**
 * Loads a function's handler. `functionsDir` (default: the working tree's supabase/functions) selects another copy, e.g.
 * functionsAtCommit(); `patch(relativePath, text)` may rewrite a source file after the remote imports are mapped (fault
 * injection — the caller asserts the patch applied). The reported SHA-256 is of the unpatched index.ts.
 */
export async function loadFunctionTree(repo, fnName, { functionsDir = path.join(repo, "supabase/functions"), patch = null } = {}) {
  const crypto = await import("node:crypto");
  const root = fs.mkdtempSync(path.join(tmp, `${fnName}-`));
  for (const d of [fnName, "_shared"]) fs.cpSync(path.join(functionsDir, d), path.join(root, d), { recursive: true });
  const harnessSupabase = path.join(root, "__harness_supabase.mjs");
  const harnessServe = path.join(root, "__harness_serve.mjs");
  fs.writeFileSync(harnessSupabase, "export const createClient = (...a) => globalThis.__fnHarness.createClient(...a);\n");
  fs.writeFileSync(harnessServe, "export const serve = (h) => globalThis.__fnHarness.serve(h);\n");
  const xlsx = pathToFileURL(path.join(repo, "node_modules/xlsx/xlsx.mjs")).href;
  const REMOTE = {
    "https://esm.sh/@supabase/supabase-js@2": (dir) => rel(dir, harnessSupabase),
    "https://deno.land/std@0.168.0/http/server.ts": (dir) => rel(dir, harnessServe),
    "https://esm.sh/xlsx@0.18.5": () => xlsx,
  };
  const rel = (dir, p) => { const r = path.relative(dir, p).split(path.sep).join("/"); return r.startsWith(".") ? r : `./${r}`; };
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      // Test files and the Deno function-path doubles are never part of a handler's import graph.
      if (e.isDirectory()) { if (e.name !== "functionpath") walk(p); continue; }
      if (!/\.ts$/.test(e.name) || /(_test|\.test)\.ts$/.test(e.name)) continue;
      let t = fs.readFileSync(p, "utf8");
      for (const [spec, to] of Object.entries(REMOTE)) t = t.split(`"${spec}"`).join(JSON.stringify(to(path.dirname(p))));
      if (/from\s+"https?:/.test(t)) throw new Error(`${path.relative(root, p)}: a remote import the harness does not map`);
      if (patch) t = patch(path.relative(root, p).split(path.sep).join("/"), t);
      fs.writeFileSync(p, t);
    }
  };
  walk(root);
  const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(functionsDir, fnName, "index.ts"))).digest("hex");
  shim.handler = null;
  await import(pathToFileURL(path.join(root, fnName, "index.ts")).href);
  if (!shim.handler) throw new Error(`${fnName}: no handler registered`);
  return { handler: shim.handler, sourceSha256 };
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
