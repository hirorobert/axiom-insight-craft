#!/usr/bin/env node
// Starts a DISPOSABLE PostgreSQL 16 (embedded), replays every migration, seeds a
// small tenancy fixture, and keeps running so that
//   * the transport/save-flow proof (vitest, env-gated) can connect to it, and
//   * the non-production browser E2E can use the HTTP bridge below.
//
// LOOPBACK ONLY. It reads no Supabase credential and cannot reach a hosted project.
// The bridge simulates PostgREST for the authenticated role: the caller names a
// fixture user in the `x-sim-user` header, and each RPC/select runs in its own
// transaction as `authenticated` with that user's auth.uid() — the same GUC mechanism
// PostgREST uses. It is NOT GoTrue: no password, token or session is involved, and
// that limitation is stated in the release documentation.
//
// Usage: DB_PROOF_MODULES_DIR=<dir with node_modules/{pg,embedded-postgres}> node scripts/db-proof/serve.mjs
//   env: DB_PROOF_SEED_FILE (default <os temp dir>/cfoclose-db-proof-seed.json, outside the repository), DB_PROOF_BRIDGE_PORT (default 54999)

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR ? path.resolve(process.env.DB_PROOF_MODULES_DIR) : REPO;
const SEED_FILE = path.resolve(process.env.DB_PROOF_SEED_FILE ?? path.join(os.tmpdir(), "cfoclose-db-proof-seed.json"));
const BRIDGE_PORT = Number(process.env.DB_PROOF_BRIDGE_PORT ?? 54999);
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";

const { Client, Pool } = createRequire(path.join(MODULES_DIR, "noop.js"))("pg");
const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(MODULES_DIR, "node_modules/embedded-postgres/dist/index.js")).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-serve-"));
const port = 55000 + Math.floor(Math.random() * 900);
const server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
await server.initialise();
await server.start();
const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
await boot.connect();
await boot.query("CREATE DATABASE e2e");
await boot.end();
const url = `postgres://postgres:postgres@localhost:${port}/e2e`;
if (url.includes(PRODUCTION_REF)) throw new Error("REFUSED");
const admin = new Client({ connectionString: url });
await admin.connect();

await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
const migDir = path.join(REPO, "supabase/migrations");
for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) {
  let text = fs.readFileSync(path.join(migDir, f), "utf8");
  if (f === PG_CRON_FILE) {
    const lines = text.split("\n");
    text = lines.slice(0, lines.findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  }
  await admin.query(text);
}

const uuid = () => globalThis.crypto.randomUUID();
const users = { owner: uuid(), partner: uuid(), preparer: uuid(), viewer: uuid(), outsider: uuid(), ownerB: uuid() };
for (const [k, id] of Object.entries(users)) await admin.query("INSERT INTO auth.users (id, email) VALUES ($1,$2)", [id, `${k}@example.test`]);
const companyA = (await admin.query("INSERT INTO public.companies (user_id, name, currency) VALUES ($1,'Acme Audit Client Ltd','TZS') RETURNING id", [users.owner])).rows[0].id;
const companyB = (await admin.query("INSERT INTO public.companies (user_id, name, currency) VALUES ($1,'Other Client Ltd','TZS') RETURNING id", [users.ownerB])).rows[0].id;
for (const [k, role] of [["partner", "partner"], ["preparer", "preparer"], ["viewer", "viewer"]]) {
  await admin.query("INSERT INTO public.firm_members (company_id, user_id, role, accepted_at) VALUES ($1,$2,$3,now())", [companyA, users[k], role]);
}
// Company A is allowlisted through the audited operator function, exactly as production would do it.
await admin.query("BEGIN");
await admin.query("SET LOCAL ROLE service_role");
await admin.query("SELECT set_config('request.jwt.claim.role','service_role',true)");
await admin.query("SELECT public.fs_set_company_rollout($1,true,'disposable e2e allowlist','serve.mjs')", [companyA]);
await admin.query("COMMIT");

fs.writeFileSync(SEED_FILE, JSON.stringify({ url, users, companyA, companyB, bridge: `http://127.0.0.1:${BRIDGE_PORT}` }, null, 2));

const pool = new Pool({ connectionString: url, max: 8 });
const ALLOWED_RPC = /^(fs_ingest_evidence_batch|fs_save_report_version|fs_save_evaluation|fs_append_decision|fs_apply_correction_group|fs_set_publication_state|fs_list_saved_versions|fs_report_readiness|financial_statements_workspace_access)$/;
const ALLOWED_TABLES = /^(financial_evidence_batches|financial_statement_reports|financial_statement_evaluations|financial_statement_reviewer_decisions|financial_statement_correction_groups|financial_statement_publications|companies|account_mappings)$/;

async function asUser(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-sim-user", "access-control-allow-methods": "POST,OPTIONS", "content-type": "application/json" };
const bridge = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  const sim = String(req.headers["x-sim-user"] ?? "");
  const uid = users[sim];
  try {
    if (!uid) throw Object.assign(new Error("unknown simulated user"), { code: "42501" });
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/seed") {
      res.writeHead(200, cors);
      return res.end(JSON.stringify({ companyA, companyB, users: Object.keys(users) }));
    }
    if (u.pathname.startsWith("/rpc/")) {
      const fn = u.pathname.slice(5);
      if (!ALLOWED_RPC.test(fn)) throw Object.assign(new Error("function not exposed"), { code: "42883" });
      const keys = Object.keys(body);
      const JSON_KEYS = /^p_(batch_document|diagnostics|report_document|findings|decision|steps|decisions|evaluation)$/;
      const sql = `SELECT to_jsonb(public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${JSON_KEYS.test(k) ? "::jsonb" : ""}`).join(", ")})) AS r`;
      const params = keys.map((k) => (JSON_KEYS.test(k) && body[k] !== null ? JSON.stringify(body[k]) : body[k]));
      const rows = await asUser(uid, (c) => c.query(sql, params).then((r) => r.rows));
      res.writeHead(200, cors);
      return res.end(JSON.stringify(rows[0].r));
    }
    if (u.pathname.startsWith("/select/")) {
      const table = u.pathname.slice(8);
      if (!ALLOWED_TABLES.test(table)) throw Object.assign(new Error("table not exposed"), { code: "42501" });
      const filters = Object.entries(body);
      const where = filters.length ? `WHERE ${filters.map(([k], i) => `"${k.replace(/[^a-z_]/g, "")}" = $${i + 1}`).join(" AND ")}` : "";
      const rows = await asUser(uid, (c) => c.query(`SELECT * FROM public.${table} ${where}`, filters.map(([, v]) => v)).then((r) => r.rows));
      res.writeHead(200, cors);
      return res.end(JSON.stringify(rows));
    }
    res.writeHead(404, cors);
    res.end("{}");
  } catch (e) {
    res.writeHead(400, cors);
    res.end(JSON.stringify({ error: { code: e.code ?? null, message: e.message } }));
  }
});
bridge.listen(BRIDGE_PORT, "127.0.0.1");

console.log(`READY seed=${SEED_FILE} pg=${url} bridge=127.0.0.1:${BRIDGE_PORT}`);
const stop = async () => {
  bridge.close();
  await pool.end().catch(() => {});
  await admin.end().catch(() => {});
  await server.stop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(SEED_FILE, { force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
