#!/usr/bin/env bun
// Real-PostgreSQL proof of I1-C — controls for AI-assisted layout suggestions (migration 20261012100000) and the REAL
// layout-assist Edge Function (only the network edges replaced; lib/functionHarness.mjs).
//
//   disabled       as deployed (no provider wired) the function refuses before anything is read; as migrated the
//                  provider is disabled, has no consent wording, no budget; enabling needs both approval gates;
//   consent        versioned, revocable, append-only, manage_members only; a new wording needs a new consent;
//   limits         per-user daily quota and per-workspace monthly cost cap, reserved pessimistically under a per-workspace
//                  lock (12 concurrent reservations never exceed the cap); idempotent per request; a run completes once;
//   end to end     with a TEST provider injected into the real function: the provider sees only the minimized sample; the
//                  suggestion is validated against the whole file, recorded as advisory, and never confirmed; the person
//                  confirms through the existing layout function;
//   isolation      another workspace is refused; clients cannot reserve, complete, configure or write records.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/layoutAssistAuthority.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, loadFunctionTree, mintTestJwt, shim } from "./lib/functionHarness.mjs";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const I1C_FILE = "20261012100000_layout_assist_controls.sql";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-layout-assist-proof-"));
  const port = 57000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE layout_assist_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/layout_assist_proof`;
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

const CSV = 'Kontonummer;Kontobezeichnung;Soll;Haben\n1000;Bank Mkombozi Ltd;"1.500,25";\n3000;Share capital Mwana Holdings;;"1.000,00"\n4000;Sales to Juma Traders;;"900,25"\n6000;Rent Kariakoo;"400,00";\n';
const SECRETS = ["Mkombozi", "Mwana", "Juma", "Kariakoo", "Bank", "1.500,25", "900,25"];
const PROPOSAL = { format: "layout-proposal/1", sheetIndex: 0, headerRow: 1, columns: { accountCode: 0, accountName: 1, debit: 2, credit: 3, balance: null, dimensions: [] }, numberFormat: "dot_comma", balanceSign: null };

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

  group("Replay — the whole chain, I1-C last");
  await check(`${I1C_FILE} is the newest migration and the whole chain applies`, async () => {
    if (files[files.length - 1] !== I1C_FILE) return `newest is ${files[files.length - 1]}`;
    for (const f of files) {
      let t = migrationSql(REPO, f);
      if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      try { await admin.query(t); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; }
    }
    return true;
  });
  await refused("applying I1-C again is refused by its preflight", "P0001", () => admin.query(migrationSql(REPO, I1C_FILE)), "PREFLIGHT_REFUSED");

  const U = { owner: uuid(), preparer: uuid(), viewer: uuid(), ownerB: uuid(), admin: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  await admin.query("INSERT INTO public.commercial_admins (user_id, active) VALUES ($1, true)", [U.admin]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "FIRM", 50]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic B') RETURNING id", [U.ownerB])).id;
  for (const [k, role] of [["preparer", "preparer"], ["viewer", "viewer"]]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], role]);
  let year = 2000;
  async function upload(company = A, text = CSV) {
    const owner = company === A ? U.owner : U.ownerB;
    const y = ++year;
    const pid = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$2) RETURNING id",
      [company, `${y}-12-31`, `FY${y}`, owner, `${y}-01-01`])).id;
    const filePath = `${owner}/${uuid()}.csv`;
    const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,$2,'processing',$3,$4,$5,$6) RETURNING id`, [filePath, text.length, company, y, pid, owner])).id;
    shim.storage.set(`trial-balance-files/${filePath}`, new TextEncoder().encode(text));
    return id;
  }
  const reserve = (uid, uploadId, request = uuid(), sampleSha = sha("sample")) => asService("SELECT public.ai_layout_assist_reserve($1,$2,$3,$4) r", [uid, uploadId, request, sampleSha]).then((r) => r.r);
  const completeRun = (runId, state = "failed", cost = null) => asService("SELECT public.ai_layout_assist_complete($1,$2,$3,NULL,NULL,NULL,'PROOF') r", [runId, state, cost]).then((r) => r.r);
  const configure = (uid, enabled, approvals = true, maxCost = 1000) => asUser(uid, "SELECT public.ai_configure_provider($1,'testprov','test-model','p1',$2,$3,$4) r",
    [enabled, maxCost, approvals ? new Date().toISOString() : null, approvals ? new Date().toISOString() : null]).then((r) => r.r);
  const setBudget = (company, cap, quota) => asUser(U.admin, "SELECT public.ai_set_workspace_budget($1,$2,$3) r", [company, cap, quota]);
  const consent = (uid, company, version, grant) => asUser(uid, "SELECT public.ai_set_workspace_consent($1,$2,$3) r", [company, version, grant]).then((r) => r.r);
  const publishVersion = async (v) => {
    await admin.query("UPDATE public.ai_consent_versions SET is_current=false WHERE is_current");
    const wording = `Proof wording ${v}: a minimized ai-sample/1 of the file is sent to the configured provider.`;
    await admin.query("INSERT INTO public.ai_consent_versions (version, wording, wording_sha256, sample_format, published_by, is_current) VALUES ($1,$2,$3,'ai-sample/1',$4,true)", [v, wording, sha(wording), U.admin]);
  };

  const real = (await loadFunctionTree(REPO, "layout-assist")).handler;
  const patched = (await loadFunctionTree(REPO, "layout-assist", { patch: (p, t) => (p === "layout-assist/index.ts" ? t.replace("provider: null,", "provider: globalThis.__testProvider ?? null,") : t) })).handler;
  const assist = (h, uid, body) => call(h, pool, uid ? mintTestJwt(uid) : null, body);
  const layoutFn = (await loadFunctionTree(REPO, "trial-balance-layout")).handler;

  group("Disabled as shipped");
  const up = await upload();
  await check("the deployed function (no provider wired) refuses PROVIDER_DISABLED before anything is read or reserved", async () => {
    const reads = []; const realGet = shim.storage.get.bind(shim.storage);
    shim.storage.get = (k) => { reads.push(k); return realGet(k); };
    let r; try { r = await assist(real, U.owner, { action: "suggest", uploadId: up, requestId: uuid() }); } finally { shim.storage.get = realGet; }
    return r.http === 503 && r.body.code === "PROVIDER_DISABLED" && reads.length === 0
      && (await count("SELECT count(*) n FROM public.ai_layout_assist_runs")) === 0 ? true : { r, reads };
  });
  await check("as migrated: provider disabled, no consent wording, no budget", async () => {
    const p = await one("SELECT * FROM public.ai_provider_settings");
    return p.enabled === false && p.provider_id === null && (await count("SELECT count(*) n FROM public.ai_consent_versions")) === 0
      && (await count("SELECT count(*) n FROM public.ai_workspace_budgets")) === 0 ? true : p;
  });
  await check("a reservation while disabled: PROVIDER_DISABLED, nothing recorded", async () => {
    const r = await reserve(U.owner, up);
    return r.code === "PROVIDER_DISABLED" && (await count("SELECT count(*) n FROM public.ai_layout_assist_runs")) === 0 ? true : r;
  });
  await refused("enabling without both approval gates is refused by the database", "23514", () => configure(U.admin, true, false));
  await refused("only a commercial admin configures the provider", "42501", () => configure(U.owner, true));
  await refused("only a commercial admin sets a budget", "42501", () => asUser(U.owner, "SELECT public.ai_set_workspace_budget($1,1,1)", [A]));
  await check("a commercial admin enables it with both approvals recorded", async () => (await configure(U.admin, true)).enabled === true ? true : "not enabled");

  group("Consent — versioned, revocable, append-only, manage_members");
  await check("no published wording: consent cannot be granted (stale_version); reservations need consent", async () => {
    const c = await consent(U.owner, A, "v1", true);
    const r = await reserve(U.owner, up);
    return c.outcome === "stale_version" && r.code === "CONSENT_REQUIRED" ? true : { c, r };
  });
  await publishVersion("v1");
  await check("a viewer or preparer (no manage_members) cannot grant; the owner can", async () => {
    const v = await consent(U.viewer, A, "v1", true);
    const p = await consent(U.preparer, A, "v1", true);
    const o = await consent(U.owner, A, "v1", true);
    return v.outcome === "forbidden" && p.outcome === "forbidden" && o.outcome === "recorded" ? true : { v, p, o };
  });
  await check("no budget: AI_BUDGET_EXCEEDED, nothing recorded", async () => {
    const r = await reserve(U.owner, up);
    return r.code === "AI_BUDGET_EXCEEDED" && (await count("SELECT count(*) n FROM public.ai_layout_assist_runs")) === 0 ? true : r;
  });
  await setBudget(A, 5000, 100);
  await check("consent, budget and quota present: reserved; a retry of the same request replays; the same id for another file is refused", async () => {
    const request = uuid();
    const a = await reserve(U.owner, up, request);
    const b = await reserve(U.owner, up, request);
    const c = await reserve(U.owner, await upload(), request);
    await completeRun(a.runId);
    return a.outcome === "reserved" && b.replay === true && b.runId === a.runId && c.code === "REQUEST_ID_REUSED" ? true : { a, b, c };
  });
  await check("a new wording makes the old consent stale; revocation ends it", async () => {
    await publishVersion("v2");
    const stale = await reserve(U.owner, up);
    const g = await consent(U.owner, A, "v2", true);
    const ok = await reserve(U.owner, up);
    await completeRun(ok.runId);
    const rv = await consent(U.owner, A, "v2", false);
    const after = await reserve(U.owner, up);
    await consent(U.owner, A, "v2", true);
    return stale.code === "CONSENT_REQUIRED" && g.outcome === "recorded" && ok.outcome === "reserved" && rv.outcome === "recorded" && after.code === "CONSENT_REQUIRED" ? true : { stale, ok, after };
  });
  await refused("consent records are append-only", "42501", () => admin.query("UPDATE public.ai_workspace_consents SET action='granted'"));
  await refused("a published wording never changes", "42501", () => admin.query("UPDATE public.ai_consent_versions SET wording = wording || ' x' WHERE version='v1'"));
  await refused("clients cannot write consent records directly", "42501", () => asUser(U.owner, "INSERT INTO public.ai_workspace_consents (company_id, consent_version, action, actor_user_id) VALUES ($1,'v2','granted',$2)", [A, U.owner]));

  group("Limits — quota and cost cap");
  await check("the per-user daily quota is enforced", async () => {
    await setBudget(A, 1_000_000, 4); // 2 runs used today
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await reserve(U.owner, up));
    for (const r of runs) if (r.runId) await completeRun(r.runId);
    return runs.map((r) => r.outcome === "reserved" ? "ok" : r.code).join(",") === "ok,ok,QUOTA_EXCEEDED" ? true : runs;
  });
  await check("12 concurrent reservations never exceed the monthly cap (pessimistic: reserved at the per-call ceiling)", async () => {
    const used = await count("SELECT COALESCE(sum(COALESCE(actual_cost_micros, reserved_cost_micros)),0) n FROM public.ai_layout_assist_runs WHERE company_id=$1", [A]);
    await setBudget(A, used + 3500, 1000);                       // room for exactly 3 calls at 1000
    const rs = await Promise.all(Array.from({ length: 12 }, () => reserve(U.preparer, up)));
    const ok = rs.filter((r) => r.outcome === "reserved").length;
    const cap = rs.filter((r) => r.code === "AI_BUDGET_EXCEEDED").length;
    for (const r of rs) if (r.runId) await completeRun(r.runId, "failed", 200);
    return ok === 3 && cap === 9 ? true : { ok, cap };
  });
  await check("a completed run is recorded at its actual cost, never above the ceiling (an over-ceiling report is flagged), and never changes again", async () => {
    await setBudget(A, 10_000_000, 1000);
    const r = await reserve(U.owner, up);
    const a = await completeRun(r.runId, "failed", 5000);
    const b = await completeRun(r.runId, "invalid", 1);
    const row = await one("SELECT state, actual_cost_micros, failure_code FROM public.ai_layout_assist_runs WHERE id=$1", [r.runId]);
    return a.outcome === "completed" && b.replay === true && row.state === "failed" && Number(row.actual_cost_micros) === 1000 && row.failure_code === "COST_ABOVE_CEILING" ? true : row;
  });
  await refused("a completed run cannot be edited — not even by the owner", "42501", () => admin.query("UPDATE public.ai_layout_assist_runs SET state='proposed' WHERE state='failed'"));
  await refused("runs cannot be deleted", "42501", () => admin.query("DELETE FROM public.ai_layout_assist_runs"));

  group("Isolation");
  await check("another workspace's owner is refused (FORBIDDEN) and nothing is recorded", async () => {
    const n = await count("SELECT count(*) n FROM public.ai_layout_assist_runs");
    const r = await reserve(U.ownerB, up);
    return r.code === "FORBIDDEN" && (await count("SELECT count(*) n FROM public.ai_layout_assist_runs")) === n ? true : r;
  });
  await refused("clients cannot reserve", "42501", () => asUser(U.owner, "SELECT public.ai_layout_assist_reserve($1,$2,$3,$4)", [U.owner, up, uuid(), sha("x")]));
  await refused("clients cannot complete", "42501", () => asUser(U.owner, "SELECT public.ai_layout_assist_complete($1,'proposed',1,'{}','" + "a".repeat(64) + "','{}',NULL)", [uuid()]));
  await refused("the service role cannot write the provider settings directly", "42501", () => asRole("service_role", null, "UPDATE public.ai_provider_settings SET enabled=false"));
  await check("members read their workspace's runs; another workspace reads none; provider settings are not readable by clients", async () => {
    const mine = await asUser(U.viewer, "SELECT count(*)::int n FROM public.ai_layout_assist_runs");
    const theirs = await asUser(U.ownerB, "SELECT count(*)::int n FROM public.ai_layout_assist_runs");
    let settings = "readable"; try { await asUser(U.owner, "SELECT * FROM public.ai_provider_settings"); } catch (e) { settings = e.code; }
    return mine.n > 0 && theirs.n === 0 && settings === "42501" ? true : { mine, theirs, settings };
  });

  group("End to end — a TEST provider injected into the real function");
  const seen = [];
  globalThis.__testProvider = { id: "testprov", model: "test-model", promptVersion: "p1", propose: async (s) => { seen.push(JSON.stringify(s)); return { proposal: PROPOSAL, costMicros: 700 }; } };
  let run;
  await check("suggest: 200 advisory proposal; the provider saw only the minimized sample; the whole file was validated; nothing confirmed", async () => {
    const up2 = await upload();
    const r = await assist(patched, U.preparer, { action: "suggest", uploadId: up2, requestId: uuid() });
    run = { id: r.body?.runId, upload: up2, layout: r.body?.layout };
    const row = await one("SELECT state, actual_cost_micros, proposal, sample_format, consent_version, firm_member_id FROM public.ai_layout_assist_runs WHERE id=$1", [r.body?.runId]);
    const leaked = SECRETS.filter((s) => seen.join("").includes(s));
    return r.http === 200 && r.body.advisory === true && r.body.report.layoutFits === true && r.body.report.rows.length === 5
      && row.state === "proposed" && Number(row.actual_cost_micros) === 700 && row.sample_format === "ai-sample/1" && row.consent_version === "v2"
      && row.firm_member_id !== null && leaked.length === 0
      && (await count("SELECT count(*) n FROM public.layout_confirmations WHERE upload_id=$1", [up2])) === 0 ? true : { r: r.body, row, leaked };
  });
  await check("the person confirms the suggested layout through the existing layout function (the only confirm path)", async () => {
    const r = await call(layoutFn, pool, mintTestJwt(U.preparer), { action: "confirm", uploadId: run.upload, layout: run.layout, expectedConfirmationNo: 0 });
    return r.http === 200 && r.body.confirmationNo === 1 ? true : r.body;
  });
  await check("a viewer (no prepare_close) is refused before the provider is called", async () => {
    const before = seen.length;
    const r = await assist(patched, U.viewer, { action: "suggest", uploadId: await upload(), requestId: uuid() });
    return [403].includes(r.http) && seen.length === before ? true : { r: r.body, calls: seen.length - before };
  });
  await check("consent revoked: refused (CONSENT_REQUIRED) and the provider is not called", async () => {
    await consent(U.owner, A, "v2", false);
    const before = seen.length;
    const r = await assist(patched, U.preparer, { action: "suggest", uploadId: await upload(), requestId: uuid() });
    await consent(U.owner, A, "v2", true);
    return r.http === 403 && r.body.code === "CONSENT_REQUIRED" && seen.length === before ? true : r.body;
  });
  await check("provider disabled again by the admin: refused and the provider is not called", async () => {
    await configure(U.admin, false);
    const before = seen.length;
    const r = await assist(patched, U.preparer, { action: "suggest", uploadId: await upload(), requestId: uuid() });
    return r.http === 503 && r.body.code === "PROVIDER_DISABLED" && seen.length === before ? true : r.body;
  });
  delete globalThis.__testProvider;
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "LAYOUT_ASSIST_AUTHORITY: ALL PASSED" : "LAYOUT_ASSIST_AUTHORITY: FAILED");
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await stopDatabase();
process.exit(ok ? 0 : 1);
