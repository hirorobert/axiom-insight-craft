// hubTrialBalanceReview.mjs — disposable-PostgreSQL acceptance proof for the account-home "service currently
// unavailable" hotfix. Synthetic users only; refuses any non-loopback host and the production project reference.
//
// It replays every repository migration on an empty embedded PostgreSQL, records a historical Tax-only engagement
// BEFORE the withholding migration (exactly the production shape), applies the rest, then drives the REAL browser
// modules (unavailableService.ts: reviewActionGate, addTrialBalanceReview, partitionEngagements) against the REAL
// server commands through an RpcClient that executes as the synthetic caller.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> bun ./scripts/db-proof/hubTrialBalanceReview.mjs
//   (or DB_PROOF_CONN=postgres://postgres@localhost:<port>/postgres for an already-running disposable local server)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addTrialBalanceReview, partitionEngagements, reviewActionGate } from "../../src/lib/workspace/unavailableService.ts";
import { parseMyWorkspaceCapabilities } from "../../src/lib/auth/workspaceCapabilities.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const WITHHOLDING = "20261002100000_refuse_withheld_service_grants.sql";
const CONCURRENCY = 25;
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

const results = [];
function record(name, ok, detail = "") { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : JSON.stringify(r)); } catch (e) { record(name, false, String(e?.message ?? e).split("\n")[0]); }
}

let server, dir, port, admin, pool;
async function start() {
  if (process.env.DB_PROOF_CONN) {
    // External mode: an already-running DISPOSABLE local server (e.g. a throwaway initdb cluster).
    const base = new URL(process.env.DB_PROOF_CONN);
    if (!["localhost", "127.0.0.1"].includes(base.hostname) || process.env.DB_PROOF_CONN.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a disposable local database");
    const boot = new Client({ connectionString: process.env.DB_PROOF_CONN, ssl: false }); await boot.connect();
    await boot.query("DROP DATABASE IF EXISTS hub_proof"); await boot.query("CREATE DATABASE hub_proof"); await boot.end();
    base.pathname = "/hub_proof";
    admin = new Client({ connectionString: base.toString(), ssl: false }); await admin.connect();
    pool = new Pool({ connectionString: base.toString(), ssl: false, max: CONCURRENCY + 5 });
    return;
  }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-hub-proof-"));
  port = 55000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, createPostgresUser: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const url = `postgres://postgres:postgres@localhost:${port}/postgres`;
  const u = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || url.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a disposable local database");
  const boot = new Client({ connectionString: url }); await boot.connect(); await boot.query("CREATE DATABASE hub_proof"); await boot.end();
  const db = url.replace(/\/postgres$/, "/hub_proof");
  admin = new Client({ connectionString: db }); await admin.connect();
  pool = new Pool({ connectionString: db, max: CONCURRENCY + 5 });
}
async function stop() {
  try { await pool?.end(); } catch { /* */ } try { await admin?.end(); } catch { /* */ }
  try { await server?.stop(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
async function bootstrap() {
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
}
async function apply(f) {
  let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
  if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  await admin.query(text);
}
async function asUser(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const out = await fn(c); await c.query("COMMIT"); return out;
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
}
/** The browser's RpcClient contract, executed as the synthetic user against the real functions. */
const rpcAs = (uid) => ({
  async rpc(fn, args = {}) {
    const keys = Object.keys(args);
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
    const setReturning = fn === "fold_engagement_mandate";
    const sql = setReturning ? `SELECT * FROM public.${fn}(${named})` : `SELECT public.${fn}(${named}) AS r`;
    try {
      const rows = await asUser(uid, async (c) => (await c.query(sql, keys.map((k) => args[k]))).rows);
      return { data: setReturning ? rows : rows[0]?.r ?? null, error: null };
    } catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
  },
});
const uuid = () => globalThis.crypto.randomUUID();
const n = async (sql, p = []) => Number((await admin.query(sql, p)).rows[0].n);
const fsGrants = (eng) => n("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id=$1 AND capability='FINANCIAL_STATEMENTS' AND action='GRANT'", [eng]);
const history = async () => (await admin.query("SELECT md5(string_agg(e::text, '|' ORDER BY e.id)) h, count(*) c FROM public.engagement_mandate_events e")).rows[0];
const engagements = () => n("SELECT count(*) n FROM public.engagements");
const fold = async (uid, eng) => (await rpcAs(uid).rpc("fold_engagement_mandate", { p_engagement_id: eng })).data.filter((r) => r.granted).map((r) => r.capability).sort();
const gateFor = async (uid, company) => {
  const { data, error } = await rpcAs(uid).rpc("get_my_workspace_capabilities", { p_company_id: company });
  return reviewActionGate(false, error ? null : parseMyWorkspaceCapabilities(data));
};

async function main() {
  await start();
  const files = fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  const cut = files.indexOf(WITHHOLDING);
  console.log("\n== Setup (synthetic users, disposable database)");
  await bootstrap();
  for (const f of files.slice(0, cut)) await apply(f);
  const U = { owner: uuid(), preparer: uuid(), outsider: uuid(), lapsed: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const lic = {};
  for (const [uid, plan] of [[U.owner, "PRACTICE"], [U.outsider, "SOLO"], [U.lapsed, "SOLO"]]) {
    const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).rows[0].id;
    lic[uid] = (await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4 RETURNING id", [bc, prod, plan === "PRACTICE" ? 4 : 0, plan])).rows[0].id;
  }
  const A = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Arusha') RETURNING id", [U.owner])).rows[0].id;
  const L = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Lapsed') RETURNING id", [U.lapsed])).rows[0].id;
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now())", [A, U.preparer]);
  const open = async (uid, c, y, caps) => (await asUser(uid, async (x) => (await x.query("SELECT public.open_engagement_with_scope($1,$2,$3,'composite') r", [c, y, caps])).rows[0].r)).engagementId;
  const E25 = await open(U.owner, A, 2025, ["TAX_COMPUTATION"]);   // the production shape: a historical Tax-only engagement
  const E24 = await open(U.owner, A, 2024, ["TAX_COMPUTATION"]);   // used for the concurrency proof
  const EL = await open(U.lapsed, L, 2025, ["TAX_COMPUTATION"]);
  for (const f of files.slice(cut)) await apply(f);
  // The lapsed account loses its plan after its history exists (expiry, never deletion).
  await admin.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end = now() - interval '1 hour' WHERE id=$1", [lic[U.lapsed]]);
  console.log(`  migrations applied: ${files.length}; withheld-only engagements recorded before ${WITHHOLDING}`);

  console.log("\n== Discovery: the withheld-only engagement is an existing engagement whose service is unavailable");
  await check("the hub's partition lists it as unavailable (not visible, not 'no engagement')", async () => {
    const caps = await fold(U.owner, E25);
    const r = partitionEngagements([{ engagementId: E25, companyId: A, companyName: "Synthetic Arusha", periodYear: 2025, capabilities: caps }]);
    return JSON.stringify(caps) === '["TAX_COMPUTATION"]' && r.visible.length === 0 && r.unavailable.length === 1 ? true : { caps, r };
  });

  console.log("\n== Permission-aware gate from the authoritative access read (get_my_workspace_capabilities)");
  await check("owner with a current plan → allowed", async () => (await gateFor(U.owner, A)).state === "allowed" || (await gateFor(U.owner, A)));
  await check("preparer member (no review_close) → blocked", async () => (await gateFor(U.preparer, A)).state === "blocked" || (await gateFor(U.preparer, A)));
  await check("outsider (no membership) → blocked", async () => (await gateFor(U.outsider, A)).state === "blocked" || (await gateFor(U.outsider, A)));
  await check("owner whose plan expired → blocked", async () => (await gateFor(U.lapsed, L)).state === "blocked" || (await gateFor(U.lapsed, L)));

  console.log("\n== Server enforcement holds even if the browser gate were bypassed; refusals change nothing");
  for (const [label, uid, eng] of [["preparer", U.preparer, E25], ["outsider", U.outsider, E25], ["expired plan", U.lapsed, EL]]) {
    await check(`${label}: refused, not success; history byte-identical; no FINANCIAL_STATEMENTS grant; no engagement created`, async () => {
      const h0 = await history(); const e0 = await engagements();
      const out = await addTrialBalanceReview(rpcAs(uid), eng);
      const h1 = await history();
      return !out.ok && h0.h === h1.h && (await fsGrants(eng)) === 0 && (await engagements()) === e0 ? true : { out, h0, h1 };
    });
  }

  console.log("\n== Explicit grant by the authorized owner");
  const tax0 = (await admin.query("SELECT e::text t FROM public.engagement_mandate_events e WHERE engagement_id=$1 AND capability='TAX_COMPUTATION'", [E25])).rows.map((r) => r.t);
  const engBefore = await engagements();
  await check("first click → success confirmed by the authority; exactly one appended GRANT", async () => {
    const out = await addTrialBalanceReview(rpcAs(U.owner), E25);
    return out.ok && (await fsGrants(E25)) === 1 ? true : out;
  });
  await check("the historical Tax mandate row is byte-identical; no engagement created; same period", async () => {
    const tax1 = (await admin.query("SELECT e::text t FROM public.engagement_mandate_events e WHERE engagement_id=$1 AND capability='TAX_COMPUTATION'", [E25])).rows.map((r) => r.t);
    return JSON.stringify(tax0) === JSON.stringify(tax1) && (await engagements()) === engBefore ? true : { tax0, tax1 };
  });
  await check("after refresh the engagement is visible (Resume into Trial balance review), no longer unavailable", async () => {
    const caps = await fold(U.owner, E25);
    const r = partitionEngagements([{ engagementId: E25, companyId: A, companyName: "x", periodYear: 2025, capabilities: caps }]);
    return JSON.stringify(caps) === '["FINANCIAL_STATEMENTS","TAX_COMPUTATION"]' && r.visible.length === 1 ? true : caps;
  });
  await check("repeat click → server answers 23001; reported success only because the re-read confirms it; no duplicate", async () => {
    const raw = await rpcAs(U.owner).rpc("grant_engagement_capability", { p_engagement_id: E25, p_capability: "FINANCIAL_STATEMENTS", p_reason: "x" });
    const out = await addTrialBalanceReview(rpcAs(U.owner), E25);
    return raw.error?.code === "23001" && out.ok && (await fsGrants(E25)) === 1 ? true : { raw: raw.error, out };
  });

  console.log(`\n== ${CONCURRENCY} concurrent requests (e.g. two tabs + repeated clicks)`);
  await check(`all ${CONCURRENCY} resolve to confirmed success; exactly ONE grant row exists`, async () => {
    const outs = await Promise.all(Array.from({ length: CONCURRENCY }, () => addTrialBalanceReview(rpcAs(U.owner), E24)));
    return outs.every((o) => o.ok) && (await fsGrants(E24)) === 1 ? true : { fails: outs.filter((o) => !o.ok), rows: await fsGrants(E24) };
  });

  console.log("\n== Withheld services stay blocked");
  await check("granting TAX_COMPUTATION again is still refused PT422", async () => {
    await asUser(U.owner, (c) => c.query("SELECT public.revoke_engagement_capability($1,'TAX_COMPUTATION','proof')", [E24]));
    const r = await rpcAs(U.owner).rpc("grant_engagement_capability", { p_engagement_id: E24, p_capability: "TAX_COMPUTATION", p_reason: "x" });
    return r.error?.code === "PT422" ? true : r;
  });

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}

let code = 1;
try { code = (await main()) === 0 ? 0 : 1; } catch (e) { console.error("FATAL", e); } finally { await stop(); }
process.exit(code);
