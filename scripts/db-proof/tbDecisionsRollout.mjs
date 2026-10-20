#!/usr/bin/env bun
// Rollout proof for the trial-balance workflow release (20261117100000 portfolio, 20261118100000 finding decisions,
// process-trial-balance generation 7, trial-balance-layout investigate), with the REAL handlers on one real PostgreSQL that
// is upgraded step by step in the release order:
//
//   stage 0  the database as on main; generation 6 (process-trial-balance + trial-balance-layout at daa23e4) live
//   stage 1  20261117100000 applied
//   stage 2  20261118100000 applied (an interrupted apply first: rolled back, nothing changed)
//   stage 3  frontend published, then generation 7 deployed — a mixed fleet: generation-6 instances may still answer
//   stage 4  processing_release_control.min_engine_generation raised to 7 (enforcement for every upload)
//
// At every stage the old and the new engine are driven against the same data: what works, what is refused, that every
// refusal comes before any write, and that results already in force stay in force (existing uploads have no evaluation
// manifest and need none). The frontend's side of each stage is proven by the unit suites named in
// docs/release/tb-workflow/README.md (the browser cannot run here).
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/tbDecisionsRollout.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
// The generation-6 commit must be present locally (CI fetches it). Invented data only.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, functionsAtCommit, loadFunctionTree, mintTestJwt, shim } from "./lib/functionHarness.mjs";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const PORTFOLIO_FILE = "20261117100000_engagement_portfolio.sql";
const DECISIONS_FILE = "20261118100000_tb_finding_decisions.sql";
// The engine live before this release: a generation-6 commit, both functions — main daa23e4 by default; the closure
// deployed hosted on 2026-10-18 (942764f, also generation 6) with ROLLOUT_OLD_COMMIT=942764f… (fetch it first).
const GENERATION_6_COMMIT = process.env.ROLLOUT_OLD_COMMIT || "daa23e4113dc726fab867480dac6b0b6aba0bbfc";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-tb-rollout-"));
  const port = 57000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE tb_rollout_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/tb_rollout_proof`;
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
const asUser = (uid, sql, p) => asRole("authenticated", uid, sql, p);
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
const apply = async (f) => {
  let t = migrationSql(REPO, f);
  if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  await admin.query(t);
};
const csv = (rows, title = "Trial balance for the year") => `${title}\nCode,Name,Debit,Credit\n${rows.map((r) => r.map((x) => (x.includes(",") ? `"${x}"` : x)).join(",")).join("\n")}\n`;
const PLAIN = [["1000", "Bank", "1,500.25", ""], ["3000", "Share capital", "", "1,000.00"], ["4000", "Sales", "", "900.25"], ["6000", "Rent", "400.00", ""]];
const UNBALANCED = [["1000", "Bank", "1,500.25", ""], ["1100", "Debtors", "120.00", ""], ["3000", "Share capital", "", "1,000.00"], ["4000", "Sales", "", "900.25"], ["6000", "Rent", "400.00", ""]];

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 16 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);
  const iP = files.indexOf(PORTFOLIO_FILE), iD = files.indexOf(DECISIONS_FILE);

  const old = {
    engine: (await loadFunctionTree(REPO, "process-trial-balance", { functionsDir: functionsAtCommit(REPO, GENERATION_6_COMMIT, "process-trial-balance") })).handler,
    layout: (await loadFunctionTree(REPO, "trial-balance-layout", { functionsDir: functionsAtCommit(REPO, GENERATION_6_COMMIT, "trial-balance-layout") })).handler,
  };
  const neu = {
    engine: (await loadFunctionTree(REPO, "process-trial-balance")).handler,
    layout: (await loadFunctionTree(REPO, "trial-balance-layout")).handler,
  };

  console.log(`old engine (generation 6): process-trial-balance and trial-balance-layout at ${GENERATION_6_COMMIT}`);
  group("Stage 0 — the database as on main; generation 6 live");
  await check("the two migrations are the newest of the chain, in this order; everything before applies", async () => {
    if (iP < 0 || iD !== iP + 1 || iD !== files.length - 1) return files.slice(-3);
    for (const f of files.slice(0, iP)) await apply(f);
    return true;
  });

  const U = { owner: uuid(), ops: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [U.ops]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [U.owner, prod])).id;
  await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Invented Rollout Ltd') RETURNING id", [U.owner])).id;
  const NORMAL = { current_assets: "debit", equity: "credit", revenue: "credit", operating_expenses: "debit" };

  let year = 2000;
  async function upload(rows, title) {
    const y = ++year;
    const pid = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$2) RETURNING id",
      [A, `${y}-12-31`, `FY${y}`, U.owner, `${y}-01-01`])).id;
    const text = csv(rows, title);
    const filePath = `${U.owner}/${uuid()}.csv`;
    const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,$2,'processing',$3,$4,$5,$6) RETURNING id`, [filePath, text.length, A, y, pid, U.owner])).id;
    shim.storage.set(`trial-balance-files/${filePath}`, new TextEncoder().encode(text));
    return { id, year: y };
  }
  const run = (h, up, clientRequestId = uuid()) => call(h, pool, mintTestJwt(U.owner), { uploadId: up.id, clientRequestId });
  const authoritative = async (up) => (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, up.year]))?.id ?? null;
  const latestCert = async (up) => (await one("SELECT * FROM public.tb_certifications WHERE upload_id=$1 ORDER BY sequence_no DESC LIMIT 1", [up.id])) ?? null;
  const footprint = async (up) => JSON.stringify({
    row: await one("SELECT status, processing_attempt, current_engine_run_id, source_file_hash, processing_result FROM public.trial_balance_uploads WHERE id=$1", [up.id]),
    runs: (await admin.query("SELECT id, status FROM public.engine_runs WHERE source_record_id=$1 ORDER BY started_at, id", [up.id])).rows,
    certs: (await admin.query("SELECT id FROM public.tb_certifications WHERE upload_id=$1 ORDER BY sequence_no", [up.id])).rows,
  });
  const requestRecheck = async (up) => {
    const op = uuid();
    const src = (await one("SELECT source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [up.id])).source_file_hash;
    const acc = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [up.id, op, src]))[0].r;
    return { op, acc };
  };

  // Mappings through the real review RPC.
  const seed = await upload([["9000", "Seed", "1", ""], ["9001", "Seed", "", "1"]]);
  const decisions = [["1000", "Bank", "current_assets", "balance_sheet"], ["1100", "Debtors", "current_assets", "balance_sheet"], ["1190", "Cash in transit", "current_assets", "balance_sheet"],
    ["3000", "Share capital", "equity", "balance_sheet"], ["4000", "Sales", "revenue", "income_statement"], ["6000", "Rent", "operating_expenses", "income_statement"]]
    .map(([code, name, cls, st]) => ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: NORMAL[cls] }));
  await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, seed.id, uuid(), JSON.stringify(decisions)]);

  const u0 = await upload(PLAIN);
  await check("generation 6 certifies a balanced trial balance (today's behaviour)", async () => {
    const r = await run(old.engine, u0);
    return r.http === 200 && (await authoritative(u0)) !== null ? true : r.body;
  });
  const early = await upload(PLAIN);
  await check("generation 7 deployed too early is refused 503 before any write (decisions authority unavailable)", async () => {
    const before = await footprint(early);
    const r = await run(neu.engine, early);
    return r.http === 503 && r.body?.code === "DECISIONS_AUTHORITY_UNAVAILABLE" && (await footprint(early)) === before ? true : { http: r.http, body: r.body };
  });
  const bad0 = await upload(UNBALANCED);
  await check("the new layout function deployed too early: investigate is refused before any write; generation 6 still serves the upload", async () => {
    const r0 = await run(old.engine, bad0);
    const c = await latestCert(bad0);
    const before = await footprint(bad0);
    const r = await call(neu.layout, pool, mintTestJwt(U.owner), { action: "investigate", uploadId: bad0.id, certificationId: c?.id, requestId: uuid() });
    return r0.http === 200 && c?.is_blocking === true && r.http >= 500 && (await footprint(bad0)) === before ? true : { r0: r0.http, http: r.http, body: r.body };
  });

  group("Stage 1 — 20261117100000 applied (generation 6 still live)");
  await check("the portfolio migration applies on live data; the stage-0 result stays authoritative", async () => {
    await apply(PORTFOLIO_FILE);
    return (await authoritative(u0)) !== null ? true : "authority lost";
  });
  const u1 = await upload(PLAIN);
  await check("generation 6 keeps certifying through the new portfolio triggers", async () => {
    const r = await run(old.engine, u1);
    return r.http === 200 && (await authoritative(u1)) !== null ? true : r.body;
  });
  await check("the account home answers from the server with exact totals", async () => {
    const h = (await asUser(U.owner, "SELECT public.get_account_home(ARRAY[]::text[], 5) r"))[0].r;
    return h?.outcome === "ok" && typeof h.engagements?.total === "number" ? true : h;
  });
  await check("generation 7 is still refused before any write", async () => {
    const before = await footprint(early);
    const r = await run(neu.engine, early);
    return r.http === 503 && (await footprint(early)) === before ? true : r.body;
  });
  // The same file before the decisions migration: what generation 6 does with it today (the stage-2 baseline).
  const ENT_ROWS = [["1000", "Bank", "1,400.25", ""], ["1190", "Cash in transit", "100.00", ""], ["3000", "Share capital", "", "1,000.00"], ["4000", "Sales", "", "900.25"], ["6000", "Rent", "400.00", ""]];
  const ENT_TITLE = "Invented Rollout Trading Company";
  let baseline;
  await check("baseline: generation 6 on a file naming another entity with a clearing balance (recorded for comparison)", async () => {
    const b = await upload(ENT_ROWS, ENT_TITLE);
    const r = await run(old.engine, b);
    const row = await one("SELECT status, is_valid FROM public.trial_balance_uploads WHERE id=$1", [b.id]);
    const c = await latestCert(b);
    baseline = { http: r.http, status: row.status, is_valid: row.is_valid, blocking: c?.is_blocking, review: c?.requires_review, authoritative: (await authoritative(b)) !== null };
    return r.http === 200 ? true : baseline;
  });

  group("Stage 2 — 20261118100000 applied (generation 6 still live; old frontend)");
  await check("an interrupted apply (failure after the last statement) rolls back completely: no new object, generation 6 unaffected", async () => {
    await admin.query("BEGIN");
    let failed = false;
    try { await admin.query(migrationSql(REPO, DECISIONS_FILE)); await admin.query("SELECT 1/0"); }
    catch { failed = true; }
    await admin.query("ROLLBACK");
    const reg = await one("SELECT to_regclass('public.tb_finding_decisions') t, to_regprocedure('public.tb_max_engine_generation()') f");
    const u = await upload(PLAIN);
    const r = await run(old.engine, u);
    return failed && reg.t === null && reg.f === null && r.http === 200 && (await authoritative(u)) !== null ? true : { failed, reg, http: r.http };
  });
  await check("the decisions migration applies on live data; every result in force stays in force (no manifest needed)", async () => {
    await apply(DECISIONS_FILE);
    return (await authoritative(u0)) !== null && (await authoritative(u1)) !== null ? true : "authority lost";
  });
  const ent = await upload(ENT_ROWS, ENT_TITLE);
  await check("generation 6 serves new uploads exactly as before the migration (the same file, the same outcome and authority)", async () => {
    const r = await run(old.engine, ent);
    const row = await one("SELECT status, is_valid FROM public.trial_balance_uploads WHERE id=$1", [ent.id]);
    const c = await latestCert(ent);
    const now = { http: r.http, status: row.status, is_valid: row.is_valid, blocking: c?.is_blocking, review: c?.requires_review, authoritative: (await authoritative(ent)) !== null };
    console.log(`        (generation 6, before and after: ${JSON.stringify(baseline)})`);
    return JSON.stringify(now) === JSON.stringify(baseline) ? true : { baseline, now };
  });
  await check("a generation-6 result carries no decision identity: no decision can be recorded on it (refused, nothing written)", async () => {
    const c = await latestCert(ent);
    const d = (await asUser(U.owner, "SELECT public.record_tb_finding_decision($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) r",
      [ent.id, c.id, "ENTITY_NAME_DIFFERS", "invented rollout trading company", "same_entity", JSON.stringify({ confirmed: true }), "Same company, trading name", 0, uuid()]))[0].r;
    const n = Number((await one("SELECT count(*) n FROM public.tb_finding_decisions")).n);
    return d?.outcome === "refused" && n === 0 ? true : { d, n };
  });
  await check("the old layout function keeps working on the new schema (inspect)", async () => {
    const r = await call(old.layout, pool, mintTestJwt(U.owner), { action: "inspect", uploadId: u1.id });
    return r.http === 200 ? true : { http: r.http, body: r.body };
  });

  group("Stage 3 — frontend published, then generation 7 deployed; generation-6 instances may still answer (mixed fleet)");
  let entCert;
  await check("generation 7 re-checks an upload certified by generation 6: the entity decision is required, the clearing balance is a review note", async () => {
    const { op, acc } = await requestRecheck(ent);
    const r = await run(neu.engine, ent, op);
    const row = await one("SELECT status, processing_result FROM public.trial_balance_uploads WHERE id=$1", [ent.id]);
    entCert = await latestCert(ent);
    const req = (row.processing_result?.decisions_required ?? []).map((x) => x.code).join();
    return acc.outcome === "accepted" && r.http === 200 && row.status === "needs_review" && req === "ENTITY_NAME_DIFFERS" ? true : { acc, http: r.http, status: row.status, req };
  });
  await check("a decision is recorded on the generation-7 result", async () => {
    const f = (await admin.query("SELECT finding FROM public.tb_certification_findings WHERE certification_id=$1 ORDER BY ordinal", [entCert.id])).rows.map((x) => x.finding).find((x) => x.code === "ENTITY_NAME_DIFFERS");
    const d = (await asUser(U.owner, "SELECT public.record_tb_finding_decision($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) r",
      [ent.id, entCert.id, f.code, f.subject, "same_entity", JSON.stringify({ confirmed: true, file_entity: f.file_entity, workspace_entity: "Invented Rollout Ltd" }), "Same company, trading name", 0, uuid()]))[0].r;
    return d?.outcome === "recorded" ? true : d;
  });
  let pending;
  await check("a generation-6 instance given the next check of that upload is refused before any write (it cannot read decisions)", async () => {
    pending = await requestRecheck(ent);
    const before = await footprint(ent);
    const r = await run(old.engine, ent, pending.op);
    return pending.acc.outcome === "accepted" && r.http >= 400 && (await footprint(ent)) === before ? true : { acc: pending.acc, http: r.http, body: r.body };
  });
  await check("recovery: generation 7 completes the same accepted request — accepted, with the decision applied", async () => {
    const r = await run(neu.engine, ent, pending.op);
    const row = await one("SELECT status FROM public.trial_balance_uploads WHERE id=$1", [ent.id]);
    return r.http === 200 && row.status === "complete" && (await authoritative(ent)) !== null ? true : { http: r.http, body: r.body, status: row.status };
  });
  await check("in the same fleet generation 6 still certifies an upload with no decisions (enforcement for it is not yet active)", async () => {
    const u = await upload(PLAIN);
    const r = await run(old.engine, u);
    return r.http === 200 && (await authoritative(u)) !== null ? true : r.body;
  });
  await check("an existing generation-6 result re-checked by generation 7 gains the evaluation manifest and stays authoritative", async () => {
    const { op } = await requestRecheck(u1);
    const r = await run(neu.engine, u1, op);
    const c = await latestCert(u1);
    // The manifest is verified by tb_finalize_attempt for every generation-7 certification (findingDecisions.mjs, Manifest).
    const runGen = Number((await one("SELECT engine_generation g FROM public.engine_runs WHERE id=$1", [c.engine_run_id]))?.g);
    return r.http === 200 && runGen === 7 && (await authoritative(u1)) === c.id ? true : { http: r.http, body: r.body, runGen };
  });
  await check("the new layout function investigates a generation-7 blocking result (reservation, stored rows, cause)", async () => {
    const u = await upload(UNBALANCED);
    await run(neu.engine, u);
    const c = await latestCert(u);
    const r = await call(neu.layout, pool, mintTestJwt(U.owner), { action: "investigate", uploadId: u.id, certificationId: c.id, requestId: uuid() });
    return c.is_blocking === true && r.http === 200 && r.body?.status === "completed" && typeof r.body.result?.cause === "string" ? true : { http: r.http, body: r.body };
  });

  group("Stage 4 — minimum engine generation raised to 7 (enforcement for every upload)");
  const control = async (floor, reason) => {
    const v = Number((await one("SELECT version FROM public.processing_release_control")).version);
    return (await asUser(U.ops, "SELECT public.admin_set_processing_control(false, ARRAY[]::uuid[], $1, $2, $3) r", [floor, reason, v]))[0].r;
  };
  await check("the floor is raised by an operator, with a reason, version-checked", async () => {
    await control(7, "Trial-balance workflow: generation 7 deployed everywhere");
    return Number((await one("SELECT min_engine_generation g FROM public.processing_release_control")).g) === 7 ? true : "floor not set";
  });
  const late = await upload(PLAIN);
  let lateOp;
  await check("a generation-6 instance is refused for every upload, before any write", async () => {
    const before = await footprint(late);
    lateOp = uuid();
    const r = await run(old.engine, late, lateOp);
    return r.http >= 400 && (await footprint(late)) === before ? true : { http: r.http, body: r.body };
  });
  await check("generation 7 serves the same upload; results certified earlier by generation 6 stay in force", async () => {
    const r = await run(neu.engine, late, lateOp);
    return r.http === 200 && (await authoritative(late)) !== null && (await authoritative(u0)) !== null ? true : { http: r.http, body: r.body };
  });
  await check("the floor cannot be lowered again (it only rises)", async () => {
    try { await control(6, "attempt to lower"); return "lowered"; }
    catch (e) { return /FLOOR|lower|rise/i.test(String(e.message)) ? true : String(e.message); }
  });
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
finally { await stopDatabase(); }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => `${f.group} / ${f.name}`).join("; ")}` : ""}`);
process.exit(crashed || failed.length || results.length === 0 ? 1 : 0);
