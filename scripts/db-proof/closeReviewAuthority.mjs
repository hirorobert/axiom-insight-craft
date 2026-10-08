#!/usr/bin/env bun
// Real-PostgreSQL proof of Close Review (roadmap increments 8-10), starting with the append-only timeline.
//
//   rollout      nothing is written or readable while the financial-statements rollout is off for the company
//                (allow-list) or the kill switch is engaged;
//   authority    comments need prepare_close or review_close exercised now; a member without either is read-only;
//                only the author revises a comment; another workspace reads nothing and writes nothing;
//   history      an edit is a new event naming the original, which never changes; append-only for every role;
//                idempotent per request; one ordered timeline per subject.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/closeReviewAuthority.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const TIMELINE_FILE = "20261013100000_close_review_timeline.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const uuid = () => crypto.randomUUID();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") { results.push({ group: currentGroup, name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)?.slice(0, 700)}`); }
  catch (e) { record(name, false, `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}`); }
}
async function refused(name, code, fn, text) {
  try { await fn(); record(name, false, "no error was raised"); }
  catch (e) { record(name, e.code === code && (!text || String(e.message).includes(text)), `expected ${code}${text ? ` ${text}` : ""}, got ${e.code}: ${String(e.message).split("\n")[0]}`); }
}

let pool, admin, server = null, dir = null;
async function startDatabase() {
  if ((process.env.DB_PROOF_MODE ?? "embedded") === "external") {
    const conn = process.env.DB_PROOF_CONN ?? "";
    const u = new URL(conn);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname) || conn.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a loopback database");
    return conn;
  }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-close-review-proof-"));
  const port = 58000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE close_review_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/close_review_proof`;
}
async function stopDatabase() {
  const step = (p) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  await step(pool?.end() ?? Promise.resolve()); await step(admin?.end() ?? Promise.resolve());
  if (server) await step(server.stop());
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}
async function asRole(role, uid, sql, params) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]);
    const r = await c.query(sql, params); await c.query("COMMIT"); return r.rows;
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
}
const asUser = async (uid, sql, p) => (await asRole("authenticated", uid, sql, p))[0];
const asService = async (sql, p) => (await asRole("service_role", null, sql, p))[0];
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
const count = async (sql, p = []) => Number((await one(sql, p)).n);


async function setup() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 40 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);
  group("Replay — the whole chain");
  await check(`${TIMELINE_FILE} is in the chain and the whole chain applies`, async () => {
    if (!files.includes(TIMELINE_FILE)) return `${TIMELINE_FILE} missing`;
    for (const f of files) {
      let t = migrationSql(REPO, f);
      if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      try { await admin.query(t); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; }
    }
    return true;
  });
  await refused("applying the timeline migration again is refused by its preflight", "P0001", () => admin.query(migrationSql(REPO, TIMELINE_FILE)), "PREFLIGHT_REFUSED");

  const U = { owner: uuid(), preparer: uuid(), partner: uuid(), viewer: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "FIRM", 50]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic B') RETURNING id", [U.ownerB])).id;
  for (const k of ["preparer", "partner", "viewer"]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], k]);
  const rollout = (company, on) => asService("SELECT public.fs_set_company_rollout($1,$2,'proof rollout change','proof')", [company, on]);
  return { U, A, B, rollout };
}

async function timelineProof({ U, A, B, rollout }) {
  const comment = (uid, body, { company = A, kind = "finding", subject = "F-1", request = uuid(), revises = null } = {}) =>
    asUser(uid, "SELECT public.close_review_comment($1,$2,$3,$4,$5,$6) r", [company, kind, subject, body, request, revises]).then((r) => r.r);
  const timeline = (uid, subject = "F-1") => asRole("authenticated", uid, "SELECT event_type, body, revises_event_id, actor_user_id FROM public.close_review_events WHERE subject_kind='finding' AND subject_id=$1 ORDER BY seq", [subject]);

  group("Timeline — rollout");
  await check("rollout off for the company: nothing is written (feature_disabled)", async () => {
    const r = await comment(U.preparer, "Looks wrong");
    return r.outcome === "feature_disabled" && (await count("SELECT count(*) n FROM public.close_review_events")) === 0 ? true : r;
  });
  await rollout(A, true); await rollout(B, true);

  group("Timeline — authority");
  let first;
  await check("a preparer comments (prepare_close); the actor is the user and the firm member", async () => {
    first = await comment(U.preparer, "Rent looks doubled");
    const row = await one("SELECT * FROM public.close_review_events WHERE id=$1", [first.eventId]);
    const member = (await one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.preparer])).id;
    return first.outcome === "recorded" && row.event_type === "comment" && row.actor_user_id === U.preparer && row.firm_member_id === member ? true : { first, row };
  });
  await check("a partner (review_close) comments", async () => (await comment(U.partner, "Agreed — see lease")).outcome === "recorded" ? true : "refused");
  await check("a member with neither capability is read-only (forbidden), and can read the timeline", async () => {
    const r = await comment(U.viewer, "x");
    const rows = await timeline(U.viewer);
    return r.outcome === "forbidden" && rows.length === 2 ? true : { r, n: rows.length };
  });
  await check("another workspace's owner can neither comment on this workspace nor read its timeline", async () => {
    const r = await comment(U.ownerB, "x");
    const rows = await timeline(U.ownerB);
    return r.outcome === "forbidden" && rows.length === 0 ? true : { r, n: rows.length };
  });

  group("Timeline — history");
  await check("the author revises: a new 'comment_revised' event names the original; the original is unchanged", async () => {
    const before = await one("SELECT body FROM public.close_review_events WHERE id=$1", [first.eventId]);
    const r = await comment(U.preparer, "Rent is doubled in March", { revises: first.eventId });
    const rows = await timeline(U.owner);
    const after = await one("SELECT body FROM public.close_review_events WHERE id=$1", [first.eventId]);
    return r.outcome === "recorded" && before.body === after.body && rows.length === 3 && rows[2].event_type === "comment_revised" && rows[2].revises_event_id === first.eventId ? true : { r, rows };
  });
  await check("someone else cannot revise it (not_author)", async () => (await comment(U.partner, "edit", { revises: first.eventId })).outcome === "not_author" ? true : "allowed");
  await check("a revision must name a comment of the same subject (not_found)", async () => (await comment(U.preparer, "edit", { subject: "F-2", revises: first.eventId })).outcome === "not_found" ? true : "allowed");
  await check("a retried request records once; the same request id with other content is refused", async () => {
    const request = uuid();
    const a = await comment(U.preparer, "Once", { request });
    const b = await comment(U.preparer, "Once", { request });
    const c = await comment(U.preparer, "Different", { request });
    return a.eventId === b.eventId && b.replay === true && c.outcome === "request_reused" ? true : { a, b, c };
  });
  await check("an empty or oversized comment is refused", async () => {
    const a = await comment(U.preparer, "   ");
    const b = await comment(U.preparer, "x".repeat(4001));
    return a.outcome === "invalid_request" && b.outcome === "invalid_request" ? true : { a, b };
  });
  for (const [label, sql] of [["updated", "UPDATE public.close_review_events SET body='x'"], ["deleted", "DELETE FROM public.close_review_events"], ["truncated", "TRUNCATE public.close_review_events"]]) {
    await refused(`events cannot be ${label} — not even by the database owner`, "42501", () => admin.query(sql));
  }
  await refused("clients cannot insert events directly", "42501", () => asRole("authenticated", U.owner, "INSERT INTO public.close_review_events (company_id, subject_kind, subject_id, event_type, body) VALUES ($1,'finding','F-1','comment','x')", [A]));
  await refused("clients cannot call the internal writer", "42501", () => asRole("authenticated", U.owner, "SELECT public._close_review_append($1,'finding','F-1','comment','x',NULL,'{}',$2,NULL,NULL)", [A, U.owner]));
  await refused("the service role cannot call the internal writer either", "42501", () => asRole("service_role", null, "SELECT public._close_review_append($1,'finding','F-1','comment','x',NULL,'{}',NULL,NULL,NULL)", [A]));

  group("Timeline — kill switch");
  await check("kill switch engaged: nothing is written and the timeline is not readable", async () => {
    await asService("SELECT public.fs_set_kill_switch(true,'proof kill switch','proof')");
    const r = await comment(U.preparer, "x");
    const rows = await timeline(U.owner);
    await asService("SELECT public.fs_set_kill_switch(false,'proof kill switch off','proof')");
    return r.outcome === "feature_disabled" && rows.length === 0 ? true : { r, n: rows.length };
  });
}

async function main() {
  const ctx = await setup();
  await timelineProof(ctx);
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "CLOSE_REVIEW_AUTHORITY: ALL PASSED" : "CLOSE_REVIEW_AUTHORITY: FAILED");
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await stopDatabase();
process.exit(ok ? 0 : 1);
