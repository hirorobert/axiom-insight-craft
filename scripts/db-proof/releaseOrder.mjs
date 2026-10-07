#!/usr/bin/env bun
// Release-order proof for I1-A (A1 20261009100000, A2 20261010100000 and process-trial-balance generation 4), with the
// REAL handlers on one real PostgreSQL that is upgraded step by step exactly as the release manifest orders it:
//
//   stage 0  the database as on main; the generation-3 engine (main 553d54c) is live
//   stage 1  A1 applied
//   stage 2  A2 applied (trial-balance-layout may already be deployed)
//   stage 3  process-trial-balance generation 4 deployed
//
// At every stage both engines and the layout function are driven against the same data, so each possible live mix is
// proven: what works, what is refused, and that every refusal comes before any write. Confirmations are created both
// through the trial-balance-layout function AND directly through the service-role writer (another authorized path):
// the protection never depends on which path wrote them.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/releaseOrder.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
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
const A1_FILE = "20261009100000_currency_registry_and_reporting_periods.sql";
const A2_FILE = "20261010100000_layout_templates_and_confirmations.sql";
const GENERATION_3_COMMIT = "553d54cac9921cfc7b2698842bd4fff2a6be8f1b";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const uuid = () => crypto.randomUUID();
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") { results.push({ group: currentGroup, name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)?.slice(0, 600)}`); }
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-release-order-"));
  const port = 56000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE release_order_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/release_order_proof`;
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
const asService = (sql, p) => asRole("service_role", null, sql, p);
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
const count = async (sql, p = []) => Number((await one(sql, p)).n);
const apply = async (f) => {
  let t = migrationSql(REPO, f);
  if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  await admin.query(t);
};

const PLAIN = "Code,Name,Debit,Credit\n1000,Bank,1500.25,\n3000,Share capital,,1000.00\n4000,Sales,,900.25\n6000,Rent,400.00,\n";
const EURO = 'Code;Name;Soll;Haben\n1000;Bank;"1.500,25";\n3000;Share capital;;"1.000,00"\n4000;Sales;;"900,25"\n6000;Rent;"400,00";\n';
const EURO_LAYOUT = {
  format: "layout-template/1", sheet: { kind: "csv" }, headerRow: 1, numberFormat: "dot_comma", balanceSign: null,
  columns: { accountCode: "Code", accountName: "Name", debit: "Soll", credit: "Haben", balance: null, dimensions: [] },
};

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 20 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);
  const iA1 = files.indexOf(A1_FILE);
  const iA2 = files.indexOf(A2_FILE);

  group("Stage 0 — the database as on main; generation 3 live");
  await check("A1 and A2 are the last two migrations, in that order; everything before applies", async () => {
    if (iA1 < 0 || iA2 !== iA1 + 1 || iA2 !== files.length - 1) return files.slice(-3);
    for (const f of files.slice(0, iA1)) await apply(f);
    return true;
  });
  const gen3 = (await loadFunctionTree(REPO, "process-trial-balance", { functionsDir: functionsAtCommit(REPO, GENERATION_3_COMMIT, "process-trial-balance") })).handler;
  const gen4 = (await loadFunctionTree(REPO, "process-trial-balance")).handler;
  const layoutFn = (await loadFunctionTree(REPO, "trial-balance-layout")).handler;

  const U = { owner: uuid(), preparer: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [U.owner, prod])).id;
  await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Release order') RETURNING id", [U.owner])).id;
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now())", [A, U.preparer]);
  const NORMAL = { current_assets: "debit", equity: "credit", revenue: "credit", operating_expenses: "debit" };

  let year = 2000;
  const uploads = {};
  async function upload(label, text) {
    const y = ++year;
    const pid = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$2) RETURNING id",
      [A, `${y}-12-31`, `FY${y}`, U.owner, `${y}-01-01`])).id;
    const filePath = `${U.owner}/${uuid()}.csv`;
    const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,$2,'processing',$3,$4,$5,$6) RETURNING id`, [filePath, text.length, A, y, pid, U.owner])).id;
    shim.storage.set(`trial-balance-files/${filePath}`, new TextEncoder().encode(text));
    uploads[label] = { id, year: y, bytes: new TextEncoder().encode(text) };
    return uploads[label];
  }
  const run = (h, up, clientRequestId = uuid()) => call(h, pool, mintTestJwt(U.owner), { uploadId: up.id, clientRequestId });
  const L = (body) => call(layoutFn, pool, mintTestJwt(U.preparer), body);
  const authoritative = async (up) => (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, up.year]))?.id ?? null;
  const snapshotRow = (up) => one("SELECT status, processing_attempt, current_engine_run_id, source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [up.id]);
  const runs = (up) => count("SELECT count(*) n FROM public.engine_runs WHERE source_record_id=$1", [up.id]);

  const seed = await upload("seed", PLAIN);
  const decisions = [["1000", "Bank", "current_assets", "balance_sheet"], ["3000", "Share capital", "equity", "balance_sheet"], ["4000", "Sales", "revenue", "income_statement"], ["6000", "Rent", "operating_expenses", "income_statement"]]
    .map(([code, name, cls, st]) => ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: NORMAL[cls] }));
  await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, seed.id, uuid(), JSON.stringify(decisions)]);

  const u0 = await upload("u0", PLAIN);
  await check("generation 3 certifies a trial balance (today's behaviour)", async () => {
    const r = await run(gen3, u0);
    return r.http === 200 && (await authoritative(u0)) !== null ? true : r.body;
  });
  const early = await upload("early", PLAIN);
  await check("generation 4 deployed too early is refused 503 before any write (no hash, no run)", async () => {
    const before = JSON.stringify(await snapshotRow(early));
    const r = await run(gen4, early);
    return r.http === 503 && r.body?.code === "LAYOUT_AUTHORITY_UNAVAILABLE" && JSON.stringify(await snapshotRow(early)) === before && (await runs(early)) === 0 ? true : r.body;
  });
  await check("the layout function deployed too early answers 'unavailable' (503), never a raw error", async () => {
    const r = await L({ action: "inspect", uploadId: early.id });
    return r.http === 503 && r.body?.code === "LAYOUT_AUTHORITY_UNAVAILABLE" ? true : r;
  });

  group("Stage 1 — A1 applied (generation 3 still live)");
  await check("A1 applies on top of live data, including a period with processed history", async () => { await apply(A1_FILE); return true; });
  const u1 = await upload("u1", PLAIN);
  await check("generation 3 keeps certifying; the stage-0 result stays authoritative", async () => {
    const r = await run(gen3, u1);
    return r.http === 200 && (await authoritative(u1)) !== null && (await authoritative(u0)) !== null ? true : r.body;
  });
  await check("generation 4 is still refused before any write (A2 not applied)", async () => {
    const before = JSON.stringify(await snapshotRow(early));
    const r = await run(gen4, early);
    return r.http === 503 && JSON.stringify(await snapshotRow(early)) === before && (await runs(early)) === 0 ? true : r.body;
  });

  group("Stage 2 — A2 applied (generation 3 still live; the layout function may be deployed)");
  await check("A2 applies; the stage-0 and stage-1 results stay authoritative", async () => {
    await apply(A2_FILE);
    return (await authoritative(u0)) !== null && (await authoritative(u1)) !== null ? true : "authority lost";
  });
  const u2 = await upload("u2", PLAIN);
  await check("generation 3 still certifies an upload without a confirmation", async () => {
    const r = await run(gen3, u2);
    return r.http === 200 && (await authoritative(u2)) !== null ? true : r.body;
  });
  // A confirmation written DIRECTLY through the service-role writer (not through the function).
  const direct = await upload("direct", EURO);
  await check("a confirmation recorded directly through the service-role writer (another authorized path) is accepted", async () => {
    const v = await L({ action: "validate", uploadId: direct.id, layout: EURO_LAYOUT });
    const rep = v.body?.report;
    if (!rep?.layoutFits) return v.body;
    const { rows, resolved, ...summary } = rep;
    const r = (await asService("SELECT public.layout_record_confirmation($1,$2,0,$3,$4,$5,$6,$7,NULL,$8,$9) r",
      [U.preparer, direct.id, sha(direct.bytes), JSON.stringify(EURO_LAYOUT), rep.profileSha256, JSON.stringify(resolved), rep.resolvedProfileSha256, JSON.stringify(summary), JSON.stringify(rows)]))[0].r;
    return r.outcome === "confirmed" && r.confirmationNo === 1 ? true : r;
  });
  await check("generation 3 is refused at begin for that upload — nothing written (no run, upload unchanged)", async () => {
    const before = JSON.stringify(await snapshotRow(direct));
    const r = await run(gen3, direct);
    return r.http === 409 && JSON.stringify(await snapshotRow(direct)) === before && (await runs(direct)) === 0 ? true : { r: r.body, before, after: await snapshotRow(direct) };
  });
  const viaFn = await upload("viaFn", EURO);
  await check("the same holds for a confirmation recorded through the function", async () => {
    const c = await L({ action: "confirm", uploadId: viaFn.id, layout: EURO_LAYOUT, expectedConfirmationNo: 0 });
    const before = JSON.stringify(await snapshotRow(viaFn));
    const r = await run(gen3, viaFn);
    return c.http === 200 && r.http === 409 && JSON.stringify(await snapshotRow(viaFn)) === before && (await runs(viaFn)) === 0 ? true : { c: c.body, r: r.body };
  });
  await check("a generation-3 result in force cannot be given a layout by either path (REPROCESS_REQUIRED)", async () => {
    const v = await L({ action: "validate", uploadId: u1.id, layout: { ...EURO_LAYOUT, numberFormat: "comma_dot", columns: { ...EURO_LAYOUT.columns, debit: "Debit", credit: "Credit" } } });
    const viaFunction = await L({ action: "confirm", uploadId: u1.id, layout: { ...EURO_LAYOUT, numberFormat: "comma_dot", columns: { ...EURO_LAYOUT.columns, debit: "Debit", credit: "Credit" } }, expectedConfirmationNo: 0 });
    const { rows, resolved, ...summary } = v.body.report;
    const viaWriter = (await asService("SELECT public.layout_record_confirmation($1,$2,0,$3,$4,$5,$6,$7,NULL,$8,$9) r",
      [U.preparer, u1.id, sha(u1.bytes), JSON.stringify(v.body.report && { ...EURO_LAYOUT, numberFormat: "comma_dot", columns: { ...EURO_LAYOUT.columns, debit: "Debit", credit: "Credit" } }), v.body.report.profileSha256, JSON.stringify(resolved), v.body.report.resolvedProfileSha256, JSON.stringify(summary), JSON.stringify(rows)]))[0].r;
    return viaFunction.body?.code === "REPROCESS_REQUIRED" && viaWriter.code === "REPROCESS_REQUIRED" && (await authoritative(u1)) !== null ? true : { f: viaFunction.body, w: viaWriter };
  });

  group("Stage 3 — generation 4 deployed");
  await check("both confirmed uploads now certify under their confirmed layout", async () => {
    const a = await run(gen4, direct);
    const b = await run(gen4, viaFn);
    return a.http === 200 && b.http === 200 && (await authoritative(direct)) !== null && (await authoritative(viaFn)) !== null ? true : { a: a.body, b: b.body };
  });
  await check("every result made before the release stays authoritative (u0, u1, u2)", async () =>
    (await authoritative(u0)) !== null && (await authoritative(u1)) !== null && (await authoritative(u2)) !== null ? true : "authority lost");
  await check("a re-check of a generation-3 result runs on generation 4 and records the layout dependency; a confirmation is then accepted and marks it 'Needs re-check'", async () => {
    const op = uuid();
    const rr = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [u1.id, op, sha(u1.bytes)]))[0].r;
    const r = await run(gen4, u1, op);
    const runRow = await one("SELECT current_engine_run_id FROM public.trial_balance_uploads WHERE id=$1", [u1.id]);
    const dep = await one("SELECT revision FROM public.engine_run_dependencies WHERE engine_run_id=$1 AND dep_key=$2", [runRow.current_engine_run_id, `#layout_confirmation:${u1.id}`]);
    const certified = (await authoritative(u1)) !== null;
    const c = await L({ action: "confirm", uploadId: u1.id, layout: { ...EURO_LAYOUT, numberFormat: "comma_dot", columns: { ...EURO_LAYOUT.columns, debit: "Debit", credit: "Credit" } }, expectedConfirmationNo: 0 });
    return ["accepted", "replayed"].includes(rr.outcome) && r.http === 200 && Number(dep?.revision) === 0 && certified && c.http === 200 && (await authoritative(u1)) === null
      ? true : { rr, r: r.body, dep, c: c.body };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "RELEASE_ORDER: ALL PASSED" : "RELEASE_ORDER: FAILED");
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await stopDatabase();
process.exit(ok ? 0 : 1);
