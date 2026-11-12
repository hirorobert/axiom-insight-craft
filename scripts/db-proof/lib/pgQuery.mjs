// NON-PRODUCTION. Translates the small PostgREST-style query a page's Supabase client builds (table, columns, filters, order, limit,
// insert / update / delete) into one parameterised SQL statement that the loopback bridge runs as `authenticated` with the simulated
// user's auth.uid(), so row-level security and grants decide - exactly the mechanism PostgREST uses. Identifiers are validated; values are
// always parameters; embedded resources (`select("a, b(c)")`) are refused rather than guessed.

const IDENT = /^[a-z_][a-z0-9_]*$/;
const bad = (m) => Object.assign(new Error(m), { code: "PGRST100" });
const ident = (s) => { if (!IDENT.test(String(s))) throw bad(`bad identifier ${s}`); return `"${s}"`; };

const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function one(col, op, val, params) {
  const c = ident(col);
  if (op === "is") {
    if (val === null || val === "null") return `${c} IS NULL`;
    if (val === true || val === "true") return `${c} IS TRUE`;
    if (val === false || val === "false") return `${c} IS FALSE`;
    throw bad("bad is value");
  }
  if (op === "in") { params.push(Array.isArray(val) ? val : splitTop(String(val).replace(/^\(|\)$/g, "")).map((x) => x.replace(/^"|"$/g, ""))); return `${c} = ANY($${params.length})`; }
  if (!(op in OPS)) throw bad(`unsupported operator ${op}`);
  if (val === null && op === "eq") return `${c} IS NULL`;
  params.push(val);
  return `${c} ${OPS[op]} $${params.length}`;
}

function condition(f, params) {
  if (f.kind === "not") return `NOT (${one(f.col, f.op, f.val, params)})`;
  if (f.kind === "or") {
    const parts = splitTop(String(f.raw)).map((p) => {
      const m = p.trim().match(/^([a-z_][a-z0-9_]*)\.([a-z]+)\.(.*)$/);
      if (!m) throw bad(`unsupported or() term ${p}`);
      return one(m[1], m[2], m[3], params);
    });
    return `(${parts.join(" OR ")})`;
  }
  return one(f.col, f.kind, f.val, params);
}

function columnsOf(cols) {
  if (!cols || cols.trim() === "*") return "*";
  if (/[()!:]/.test(cols)) throw bad("embedded resources are not supported by the harness");
  return cols.split(",").map((c) => ident(c.trim().split(/\s+/)[0])).join(", ");
}

/** @returns {{sql: string, params: unknown[], readOnly: boolean, countSql?: string, countParams?: unknown[]}} */
export function buildQuery(q) {
  const table = `public.${ident(q.table)}`;
  const params = [];
  const where = () => ((q.filters ?? []).length ? ` WHERE ${q.filters.map((f) => condition(f, params)).join(" AND ")}` : "");
  if (q.op === "insert") {
    const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const vals = rows.map((r) => `(${keys.map((k) => { params.push(r[k] ?? null); return `$${params.length}`; }).join(", ")})`).join(", ");
    return { sql: `INSERT INTO ${table} (${keys.map(ident).join(", ")}) VALUES ${vals} RETURNING *`, params, readOnly: false };
  }
  if (q.op === "update") {
    const keys = Object.keys(q.payload);
    const set = keys.map((k) => { params.push(q.payload[k]); return `${ident(k)} = $${params.length}`; }).join(", ");
    return { sql: `UPDATE ${table} SET ${set}${where()} RETURNING *`, params, readOnly: false };
  }
  if (q.op === "delete") return { sql: `DELETE FROM ${table}${where()} RETURNING *`, params, readOnly: false };
  const w = where();
  const order = (q.orders ?? []).length ? ` ORDER BY ${q.orders.map((o) => `${ident(o.col)} ${o.ascending === false ? "DESC" : "ASC"}${o.nullsFirst === true ? " NULLS FIRST" : o.nullsFirst === false ? " NULLS LAST" : ""}`).join(", ")}` : "";
  const limit = Number.isInteger(q.limit) ? ` LIMIT ${q.limit}` : "";
  const offset = Number.isInteger(q.offset) && q.offset > 0 ? ` OFFSET ${q.offset}` : "";
  const out = { sql: `SELECT ${columnsOf(q.columns)} FROM ${table}${w}${order}${limit}${offset}`, params, readOnly: true };
  if (q.count) out.countSql = `SELECT count(*)::int AS n FROM ${table}${w}`;
  return out;
}

/** Runs the query as the simulated user and shapes the answer as supabase-js does ({data, error, count}). */
export async function runQuery(db, uid, q) {
  const b = buildQuery(q);
  const rows = await db.asRole("authenticated", uid, b.sql, b.params, { readOnly: b.readOnly, rawDates: true });
  const count = b.countSql ? (await db.asRole("authenticated", uid, b.countSql, b.params, { readOnly: true, rawDates: true }))[0].n : null;
  const json = JSON.parse(JSON.stringify(rows));
  const returning = q.op && q.op !== "select";
  if (returning && !q.returning) return { data: null, error: null, count };
  if (q.card === "single") return json.length === 1 ? { data: json[0], error: null, count } : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, count };
  if (q.card === "maybe") return json.length <= 1 ? { data: json[0] ?? null, error: null, count } : { data: null, error: { code: "PGRST116", message: "multiple rows returned" }, count };
  return { data: json, error: null, count };
}

/** An RPC the way PostgREST answers it: a set-returning function is an array of rows, anything else one JSON value. */
export async function runRpc(db, uid, fn, args) {
  if (!IDENT.test(fn)) throw bad("bad function name");
  const sig = await db.one(`SELECT p.proargnames AS names, array(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t) AS types, p.provolatile AS volatility, p.proretset AS retset, p.prorettype::regtype::text AS ret
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname=$1 ORDER BY p.oid DESC LIMIT 1`, [fn]);
  if (!sig) throw Object.assign(new Error(`Could not find the function public.${fn}`), { code: "PGRST202" });
  const types = Object.fromEntries((sig.names ?? []).slice(0, sig.types.length).map((n, i) => [n, sig.types[i]]));
  const keys = Object.keys(args ?? {});
  for (const k of keys) if (!(k in types)) throw Object.assign(new Error(`${fn} has no argument ${k}`), { code: "PGRST202" });
  const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}::${types[k]}`).join(", ")})`;
  const sql = sig.retset ? `SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS r FROM ${call} t`
    : sig.ret === "void" ? `SELECT NULL::jsonb AS r FROM (SELECT ${call}) v` : `SELECT to_jsonb(${call}) AS r`;
  const params = keys.map((k) => (types[k] === "jsonb" && args[k] !== null ? JSON.stringify(args[k]) : args[k]));
  const rows = await db.asRole("authenticated", uid, sql, params, { readOnly: sig.volatility !== "v", rawDates: true });
  return JSON.parse(JSON.stringify(rows[0].r ?? null));
}
