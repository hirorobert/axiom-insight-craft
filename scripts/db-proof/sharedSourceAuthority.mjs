#!/usr/bin/env bun
// Real-PostgreSQL proof of I1-B — one file, two years (migration 20261011100000).
//
//   registration   one reservation → a current-year and a prior-year upload, independent datasets sharing one source
//                  object; both bound; adjacency, workspace, actor, expiry, storage and active-slot refusals write nothing;
//   atomicity      a failure injected at EACH write step leaves no object, no upload, no registration, no event and a
//                  reservation that still registers afterwards;
//   idempotency    a retry of the same request returns the same pair; 12 concurrent identical requests → one pair;
//                  another request for a consumed reservation is refused with the existing pair;
//   guards         clients (and the service role) cannot link an upload to a source object; the link and the object's
//                  identity are immutable; objects are never deleted; workspace-scoped reads;
//   shared source  discarding one year keeps the file for the other ('source_shared'); a restore works; the file is
//                  deleted only after the last reference and every undo window end — exactly once, also when both years
//                  are discarded concurrently and when two sweeps race (the REAL sweeper orchestration is used);
//   compatibility  single-file registration and replacement are unchanged (no source object).
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/sharedSourceAuthority.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";
import { runSourceSweep } from "../../supabase/functions/_shared/sourceSweeper.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const I1B_FILE = "20261011100000_two_period_shared_source.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const uuid = () => crypto.randomUUID();

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-shared-source-proof-"));
  const port = 56000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE shared_source_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/shared_source_proof`;
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
const asService = (sql, p) => asRole("service_role", null, sql, p);
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
const count = async (sql, p = []) => Number((await one(sql, p)).n);

async function main() {
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

  group("Replay — the whole chain, I1-B last");
  await check(`${I1B_FILE} is the newest migration and the whole chain applies`, async () => {
    if (files[files.length - 1] !== I1B_FILE) return `newest is ${files[files.length - 1]}`;
    for (const f of files) {
      let t = migrationSql(REPO, f);
      if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      try { await admin.query(t); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; }
    }
    return true;
  });
  await refused("applying I1-B again is refused by its preflight (nothing is replaced)", "P0001", () => admin.query(migrationSql(REPO, I1B_FILE)), "PREFLIGHT_REFUSED");

  const U = { owner: uuid(), viewer: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "FIRM", 50]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic B') RETURNING id", [U.ownerB])).id;
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'viewer',now())", [A, U.viewer]);

  const period = async (company, y, { dated = true } = {}) => (await one(
    "INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$6) RETURNING id",
    [company, `${y}-12-31`, `FY${y}`, company === A ? U.owner : U.ownerB, dated ? `${y}-01-01` : null, dated ? `${y}-12-31` : null])).id;
  const putObject = (p) => admin.query("INSERT INTO storage.objects (bucket_id, name) VALUES ('trial-balance-files', $1)", [p]);
  const objectExists = async (p) => (await count("SELECT count(*) n FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [p])) === 1;
  const reserve = async (who = U.owner, company = A, { put = true } = {}) => {
    const r = await asUser(who, "SELECT * FROM public.reserve_trial_balance_source($1,'two-years.xlsx')", [company]);
    if (r.outcome !== "reserved") throw new Error(`reserve ${r.outcome}`);
    if (put) await putObject(r.object_path);
    return r;
  };
  const register2 = (who, res, request, cur, pri, size = 10) => asUser(who,
    "SELECT * FROM public.register_two_period_uploads($1,$2,$3,$4,$5)", [res, request, size, cur, pri]);
  const row = (id) => one("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [id]);
  const bound = async (id) => (await one("SELECT public.tbu_upload_source_bound($1) b", [id])).b;
  const totals = async () => JSON.stringify(await one(`SELECT (SELECT count(*) FROM public.tb_source_objects)::int o, (SELECT count(*) FROM public.trial_balance_uploads)::int u,
    (SELECT count(*) FROM public.tb_two_period_registrations)::int g, (SELECT count(*) FROM public.trial_balance_upload_lifecycle_events)::int e`));
  const reservation = (id) => one("SELECT consumed_at, consumed_by_upload_id FROM public.trial_balance_source_reservations WHERE id=$1", [id]);
  const discardBegin = (who, id) => row(id).then((r) => asUser(who, "SELECT * FROM public.discard_trial_balance_upload($1,$2)", [id, Number(r.version)]));
  const discardComplete = (who, op) => asUser(who, "SELECT * FROM public.complete_trial_balance_discard($1)", [op]);
  const expire = (op) => admin.query("UPDATE public.trial_balance_upload_operations SET completed_at = now() - public.tbu_undo_window() - interval '1 minute' WHERE id=$1", [op]);
  const purge = (who, op) => asUser(who, "SELECT * FROM public.purge_trial_balance_discard($1)", [op]);

  // The REAL sweeper orchestration (supabase/functions/_shared/sourceSweeper.ts) against this database; Storage deletion
  // is the only double, and it counts every object it actually removes.
  const deletions = [];
  const sweepDeps = {
    redeemTicket: async () => true,
    listCandidates: async (n) => asService("SELECT * FROM public.tbu_sweeper_candidates($1)", [n]),
    claim: async (k, id) => (await asService("SELECT public.tbu_sweeper_claim($1,$2) r", [k, id]))[0].r === "claimed",
    removeObject: async (p) => { const r = await admin.query("DELETE FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [p]); if (r.rowCount) deletions.push(p); return true; },
    objectExists: async (p) => objectExists(p),
    complete: async (k, id) => (await asService("SELECT public.tbu_sweeper_complete($1,$2) r", [k, id]))[0].r,
  };
  const sweep = () => runSourceSweep(sweepDeps, "a".repeat(64));

  let y = 2000;
  const pair = async () => { const pri = await period(A, ++y); const cur = await period(A, ++y); return { cur, pri, curYear: y, priYear: y - 1 }; };

  group("Registration — one file, two independent years");
  const P = await pair();
  const R = await reserve();
  let reg;
  await check("registered: two uploads (current and prior), one shared source object, both bound, reservation consumed by the current year", async () => {
    reg = await register2(U.owner, R.reservation_id, uuid(), P.cur, P.pri);
    if (reg.outcome !== "registered") return reg;
    const c = await row(reg.current_upload_id), p = await row(reg.prior_upload_id);
    const o = await one("SELECT * FROM public.tb_source_objects WHERE id=$1", [reg.source_object_id]);
    const res = await reservation(R.reservation_id);
    return c.period_year === P.curYear && p.period_year === P.priYear && c.period_id === P.cur && p.period_id === P.pri
      && c.file_path === R.object_path && p.file_path === R.object_path && c.source_object_id === o.id && p.source_object_id === o.id
      && o.state === "active" && o.storage_path === R.object_path && o.reservation_id === R.reservation_id
      && (await bound(c.id)) && (await bound(p.id)) && res.consumed_by_upload_id === c.id
      && c.lifecycle_state === "active_unprocessed" && p.lifecycle_state === "active_unprocessed" ? true : { c, p, o, res };
  });
  await check("one registration record and one lifecycle event per year", async () =>
    (await count("SELECT count(*) n FROM public.tb_two_period_registrations WHERE reservation_id=$1", [R.reservation_id])) === 1
    && (await count("SELECT count(*) n FROM public.trial_balance_upload_lifecycle_events WHERE upload_id IN ($1,$2)", [reg.current_upload_id, reg.prior_upload_id])) === 2 ? true : "counts");
  await check("the datasets are independent: a processing attempt on the prior year leaves the current year untouched", async () => {
    const Q = await pair(); const res = await reserve();
    const g = await register2(U.owner, res.reservation_id, uuid(), Q.cur, Q.pri);
    const before = await row(g.current_upload_id);
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v4',4,'workspace_user',NULL,$4,600) r", [g.prior_upload_id, uuid(), "b".repeat(64), U.owner]))[0].r;
    const c = await row(g.current_upload_id), p = await row(g.prior_upload_id);
    return b.outcome === "claimed" && p.processing_attempt === 1 && c.processing_attempt === 0
      && JSON.stringify(c) === JSON.stringify(before) ? true : { b, c: c.processing_attempt, p: p.processing_attempt };
  });

  group("Idempotency");
  await check("a retry of the same request: the same pair, nothing new", async () => {
    const before = await totals();
    const again = await register2(U.owner, R.reservation_id, (await one("SELECT request_id FROM public.tb_two_period_registrations WHERE reservation_id=$1", [R.reservation_id])).request_id, P.cur, P.pri);
    return again.outcome === "registered" && again.detail === "replay" && again.current_upload_id === reg.current_upload_id
      && again.prior_upload_id === reg.prior_upload_id && (await totals()) === before ? true : again;
  });
  await check("another request for the consumed reservation: already_registered with the existing pair, nothing new", async () => {
    const before = await totals();
    const r = await register2(U.owner, R.reservation_id, uuid(), P.cur, P.pri);
    return r.outcome === "already_registered" && r.current_upload_id === reg.current_upload_id && r.prior_upload_id === reg.prior_upload_id
      && (await totals()) === before ? true : r;
  });
  await check("12 concurrent identical requests → exactly one pair; every answer names it", async () => {
    const Q = await pair(); const res = await reserve(); const request = uuid();
    const rs = await Promise.all(Array.from({ length: 12 }, () => register2(U.owner, res.reservation_id, request, Q.cur, Q.pri)));
    const ids = new Set(rs.map((r) => `${r.current_upload_id}/${r.prior_upload_id}`));
    return rs.every((r) => r.outcome === "registered") && ids.size === 1
      && (await count("SELECT count(*) n FROM public.trial_balance_uploads WHERE file_path=$1", [res.object_path])) === 2 ? true : rs.map((r) => r.outcome);
  });

  group("Refusals — nothing is written, the reservation stays usable");
  const refusal = async (label, expected, run, setup) => check(`${label}: ${expected}; nothing written`, async () => {
    const ctx = await setup();
    const before = await totals();
    const r = await run(ctx);
    const res = await reservation(ctx.res.reservation_id);
    return r.outcome === expected && (await totals()) === before && res.consumed_at === null ? true : { r, res };
  });
  const fresh = async () => ({ ...(await pair()), res: await reserve() });
  await refusal("periods that are not adjacent", "periods_not_adjacent", (c) => register2(U.owner, c.res.reservation_id, uuid(), c.cur, c.far),
    async () => { const c = await fresh(); return { ...c, far: await period(A, 2500 + y) }; });
  await refusal("undated periods that are not consecutive years", "periods_not_adjacent", (c) => register2(U.owner, c.res.reservation_id, uuid(), c.cur, c.pri),
    async () => { y += 3; return { cur: await period(A, y, { dated: false }), pri: await period(A, y - 2, { dated: false }), res: await reserve() }; });
  await refusal("a period of another workspace", "invalid_period", (c) => register2(U.owner, c.res.reservation_id, uuid(), c.cur, c.other),
    async () => ({ ...(await fresh()), other: await period(B, 1990) }));
  await refusal("the same period twice", "invalid_request", (c) => register2(U.owner, c.res.reservation_id, uuid(), c.cur, c.cur), fresh);
  await refusal("another user's reservation", "forbidden", (c) => register2(U.ownerB, c.res.reservation_id, uuid(), c.cur, c.pri), fresh);
  await refusal("a viewer", "forbidden", (c) => register2(U.viewer, c.res.reservation_id, uuid(), c.cur, c.pri), fresh);
  await refusal("the file never reached storage", "object_missing", (c) => register2(U.owner, c.res.reservation_id, uuid(), c.cur, c.pri),
    async () => ({ ...(await pair()), res: await reserve(U.owner, A, { put: false }) }));
  await refusal("an expired reservation", "expired", (c) => register2(U.owner, c.res.reservation_id, uuid(), c.cur, c.pri),
    async () => { const c = await fresh(); await admin.query("UPDATE public.trial_balance_source_reservations SET expires_at = now() - interval '1 second' WHERE id=$1", [c.res.reservation_id]); return c; });
  await refusal("a year whose active slot is taken", "active_upload_exists", (c) => register2(U.owner, c.res.reservation_id, uuid(), P.cur, P.pri), fresh);

  group("Atomicity — a failure injected at each write step");
  const steps = [
    ["the source object", "public.tb_source_objects", "BEFORE INSERT", "true"],
    ["the current-year upload", "public.trial_balance_uploads", "BEFORE INSERT", "NEW.period_year = current_setting('proof.cur_year')::int"],
    ["the prior-year upload", "public.trial_balance_uploads", "BEFORE INSERT", "NEW.period_year = current_setting('proof.pri_year')::int"],
    ["the reservation's consumption", "public.trial_balance_source_reservations", "BEFORE UPDATE", "NEW.consumed_at IS NOT NULL"],
    ["the registration record", "public.tb_two_period_registrations", "BEFORE INSERT", "true"],
    ["the prior year's lifecycle event (the last write)", "public.trial_balance_upload_lifecycle_events", "BEFORE INSERT", "NEW.reason LIKE '%prior year%'"],
  ];
  for (const [label, table, when, cond] of steps) {
    await check(`failure at ${label}: rejected; no object, upload, registration or event; the reservation then registers`, async () => {
      const c = await fresh();
      const cy = (await one("SELECT EXTRACT(YEAR FROM fiscal_year_end)::int y FROM public.fiscal_periods WHERE id=$1", [c.cur])).y;
      await admin.query(`CREATE OR REPLACE FUNCTION public.proof_inject() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN IF ${cond.replaceAll("current_setting('proof.cur_year')::int", String(cy)).replaceAll("current_setting('proof.pri_year')::int", String(cy - 1))} THEN
          RAISE EXCEPTION 'INJECTED_FAILURE'; END IF; RETURN NEW; END $f$`);
      await admin.query(`CREATE TRIGGER proof_inject ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.proof_inject()`);
      const before = await totals();
      let r;
      try { r = await register2(U.owner, c.res.reservation_id, uuid(), c.cur, c.pri); }
      finally { await admin.query(`DROP TRIGGER proof_inject ON ${table}`); }
      const after = await totals();
      const res = await reservation(c.res.reservation_id);
      const retry = await register2(U.owner, c.res.reservation_id, uuid(), c.cur, c.pri);
      return r.outcome === "rejected" && /INJECTED_FAILURE/.test(r.detail) && after === before && res.consumed_at === null
        && retry.outcome === "registered" ? true : { r, before, after, res, retry: retry.outcome };
    });
  }

  group("Guards — the link is server-only and immutable; objects are never deleted");
  await refused("an authenticated client cannot link an upload to a source object", "42501", () => asRole("authenticated", U.owner,
    "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year,source_object_id) VALUES ('x',$1,1,'processing',$2,$3,1999,$4)",
    [R.object_path, U.owner, A, reg.source_object_id]));
  await refused("the service role cannot link an upload to a source object", "42501", () => asService(
    "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year,source_object_id) VALUES ('x',$1,1,'processing',$2,$3,1999,$4)",
    [R.object_path, U.owner, A, reg.source_object_id]), "SOURCE_OBJECT_SERVER_ONLY");
  await refused("an upload's source object cannot be changed — not even by the owner", "42501", () => admin.query("UPDATE public.trial_balance_uploads SET source_object_id=NULL WHERE id=$1", [reg.prior_upload_id]), "SOURCE_OBJECT_REFERENCE_IMMUTABLE");
  await refused("a source object cannot be deleted", "42501", () => admin.query("DELETE FROM public.tb_source_objects WHERE id=$1", [reg.source_object_id]), "SOURCE_OBJECT_APPEND_ONLY");
  await refused("a source object's path cannot change", "42501", () => admin.query("UPDATE public.tb_source_objects SET storage_path=storage_path||'x' WHERE id=$1", [reg.source_object_id]), "SOURCE_OBJECT_IMMUTABLE");
  await refused("clients cannot write source objects", "42501", () => asRole("authenticated", U.owner, "INSERT INTO public.tb_source_objects (company_id,reservation_id,storage_path,created_by) VALUES ($1,$2,$3,$4)", [A, uuid(), `workspaces/${A}/x`, U.owner]));
  await refused("an upload cannot link to an object of another path", "42501", () => admin.query(
    "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year,source_object_id) VALUES ('x',$1,1,'processing',$2,$3,1998,$4)",
    [`workspaces/${A}/other.csv`, U.owner, A, reg.source_object_id]), "SOURCE_OBJECT_UNAVAILABLE");
  await check("members read their workspace's source objects and registrations; another workspace reads none", async () => {
    const mine = await asUser(U.viewer, "SELECT (SELECT count(*) FROM public.tb_source_objects)::int o, (SELECT count(*) FROM public.tb_two_period_registrations)::int g");
    const theirs = await asUser(U.ownerB, "SELECT (SELECT count(*) FROM public.tb_source_objects)::int o, (SELECT count(*) FROM public.tb_two_period_registrations)::int g");
    return mine.o > 0 && mine.g > 0 && theirs.o === 0 && theirs.g === 0 ? true : { mine, theirs };
  });
  await refused("an authenticated user cannot call the sweeper functions", "42501", () => asUser(U.owner, "SELECT public.tbu_sweeper_claim('source_object',$1)", [reg.source_object_id]));

  group("Shared source — kept while either year references it");
  let priorOp;
  await check("discarding the prior year: the operation owns no path; the file stays; the current year is still bound", async () => {
    const b = await discardBegin(U.owner, reg.prior_upload_id);
    const c = await discardComplete(U.owner, b.operation_id);
    priorOp = b.operation_id;
    return b.file_path === null && c.outcome === "deleted_now" && (await objectExists(R.object_path)) && (await bound(reg.current_upload_id)) ? true : { path: b.file_path, c, exists: await objectExists(R.object_path), bound: await bound(reg.current_upload_id) };
  });
  await check("within the undo window the prior year is restored, still linked to the shared source", async () => {
    const r = await asUser(U.owner, "SELECT * FROM public.restore_trial_balance_upload($1)", [priorOp]);
    const p = await row(reg.prior_upload_id);
    return r.outcome === "restored" && p?.source_object_id === reg.source_object_id && (await bound(p.id)) ? true : { r, p };
  });
  await check("discarded again and past the undo window: purge answers 'source_shared'; the file is still there", async () => {
    const b = await discardBegin(U.owner, reg.prior_upload_id);
    await discardComplete(U.owner, b.operation_id); await expire(b.operation_id); priorOp = b.operation_id;
    const p = await purge(U.owner, b.operation_id);
    const again = await purge(U.owner, b.operation_id);
    return p.outcome === "source_shared" && again.outcome === "source_shared" && (await objectExists(R.object_path)) ? true : { p, again };
  });
  await check("a sweep deletes nothing while the current year references the file", async () => {
    deletions.length = 0;
    const s = await sweep();
    return s.outcome === "swept" && deletions.length === 0 && (await objectExists(R.object_path)) ? true : { s, deletions };
  });
  await check("replacing the current year keeps the file (the superseded row is history that still references it)", async () => {
    const rep = await reserve(U.owner, A);
    const cur = await row(reg.current_upload_id);
    const r = await asUser(U.owner, "SELECT * FROM public.retire_trial_balance_upload($1,$2,$3,20,'proof')", [cur.id, Number(cur.version), rep.reservation_id]);
    deletions.length = 0; await sweep();
    const n = await row(r.new_upload_id);
    return r.outcome === "replaced" && n.source_object_id === null && deletions.length === 0 && (await objectExists(R.object_path)) ? true : { r, deletions };
  });

  group("Shared source — purged exactly once after the last reference");
  const concurrentPair = async () => { const Q = await pair(); const res = await reserve(); const g = await register2(U.owner, res.reservation_id, uuid(), Q.cur, Q.pri); return { ...g, path: res.object_path }; };
  let C2;
  await check("both years discarded concurrently: neither operation owns the path; nothing is deleted inside the undo windows", async () => {
    C2 = await concurrentPair();
    const begins = await Promise.all([discardBegin(U.owner, C2.current_upload_id), discardBegin(U.owner, C2.prior_upload_id)]);
    await Promise.all(begins.map((b) => discardComplete(U.owner, b.operation_id)));
    C2.ops = begins.map((b) => b.operation_id);
    deletions.length = 0; await sweep();
    return begins.every((b) => b.file_path === null) && deletions.length === 0 && (await objectExists(C2.path)) ? true : { begins, deletions };
  });
  await check("after the undo windows: two concurrent sweeps delete the file exactly once; the object is purged; both discards purged", async () => {
    for (const op of C2.ops) await expire(op);
    deletions.length = 0;
    await Promise.all([sweep(), sweep()]);
    await sweep();
    const o = await one("SELECT state, purged_at FROM public.tb_source_objects WHERE id=$1", [C2.source_object_id]);
    const ops = (await admin.query("SELECT state FROM public.trial_balance_upload_operations WHERE id = ANY($1)", [C2.ops])).rows.map((r) => r.state);
    return deletions.filter((p) => p === C2.path).length === 1 && !(await objectExists(C2.path)) && o.state === "purged" && o.purged_at
      && ops.every((s) => s === "purged") ? true : { deletions, o, ops };
  });
  await check("a purged source cannot be linked again", async () => {
    try {
      await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year,source_object_id) VALUES ('x',$1,1,'processing',$2,$3,1997,$4)", [C2.path, U.owner, A, C2.source_object_id]);
      return "inserted";
    } catch (e) { return e.code === "42501" && /SOURCE_OBJECT_UNAVAILABLE/.test(e.message) ? true : e.message; }
  });
  await check("one year discarded after the other's undo window: the last discard owns the path and the file is deleted once", async () => {
    const S = await concurrentPair();
    const a = await discardBegin(U.owner, S.prior_upload_id); await discardComplete(U.owner, a.operation_id); await expire(a.operation_id);
    const b = await discardBegin(U.owner, S.current_upload_id); await discardComplete(U.owner, b.operation_id);
    deletions.length = 0; await sweep();
    const inside = deletions.length;
    await expire(b.operation_id);
    await sweep(); await sweep();
    const o = await one("SELECT state FROM public.tb_source_objects WHERE id=$1", [S.source_object_id]);
    return a.file_path === null && b.file_path === S.path && inside === 0 && deletions.filter((p) => p === S.path).length === 1
      && !(await objectExists(S.path)) && o.state === "purged" ? true : { a: a.file_path, b: b.file_path, inside, deletions, o };
  });
  await check("a claimed source is released if a reference reappears (the completion re-checks)", async () => {
    const S = await concurrentPair();
    const before = await asService("SELECT public.tbu_sweeper_claim('source_object',$1) r", [S.source_object_id]);
    return before[0].r === "not_eligible" && (await one("SELECT state FROM public.tb_source_objects WHERE id=$1", [S.source_object_id])).state === "active" ? true : before;
  });

  group("Compatibility — single-file registration and replacement unchanged");
  await check("register_trial_balance_upload: no source object; bound through the reservation as before", async () => {
    const res = await reserve(); y += 1;
    const g = await asUser(U.owner, "SELECT * FROM public.register_trial_balance_upload($1,10,$2,NULL,NULL)", [res.reservation_id, 1900 + (y % 90)]);
    const u = await row(g.upload_id);
    return g.outcome === "registered" && u.source_object_id === null && (await bound(u.id)) ? true : { g, u };
  });
  await check("a single-file discard still owns its path and is deleted once after its window", async () => {
    const res = await reserve();
    const g = await asUser(U.owner, "SELECT * FROM public.register_trial_balance_upload($1,10,$2,NULL,NULL)", [res.reservation_id, 1800 + (++y % 90)]);
    const b = await discardBegin(U.owner, g.upload_id); await discardComplete(U.owner, b.operation_id); await expire(b.operation_id);
    deletions.length = 0; await sweep();
    return b.file_path === res.object_path && deletions.filter((p) => p === res.object_path).length === 1 ? true : { b, deletions };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "SHARED_SOURCE_AUTHORITY: ALL PASSED" : "SHARED_SOURCE_AUTHORITY: FAILED");
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await stopDatabase();
process.exit(ok ? 0 : 1);
