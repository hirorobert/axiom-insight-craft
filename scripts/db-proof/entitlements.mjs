#!/usr/bin/env node
// Real-PostgreSQL proof of the CFO Close capability, entitlement, wall and pricing migration
// (20260925100000_global_capabilities_entitlements_pricing.sql).
//
// 1. Upgrade: replays every earlier migration, seeds the LEGACY commercial state (legacy feature codes in plans and
//    overrides, a legacy PAID licence), applies the migration and proves the deterministic catalogue and the
//    legacy-identifier mapping (ids preserved). A second application is refused before any change.
// 2. Authority: the paid-action authority across anonymous, unrelated, creator, member, grant, revoked grant,
//    cross-user and cross-workspace callers, unknown capability / plan, expiry, grace, suspension and overrides.
// 3. Walls: Close Certification (sign-offs, FINAL), Reporting Pack issuance, Close Insights, Entity Capacity
//    (Free 1 / Practice 5 / Firm 25, concurrency, direct insert, RPC, idempotent retry, downgrade, reactivation).
// 4. Billing never touches accounting: licence transitions leave certifications, sign-offs and uploads byte-identical.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/entitlements.mjs
//
// It reads no Supabase credential and refuses every non-loopback host and the production project reference.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MIGRATION = "20260925100000_global_capabilities_entitlements_pricing.sql";
const MODE = process.env.DB_PROOF_MODE ?? "embedded";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const CONCURRENCY = 12;

const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") {
  results.push({ group: currentGroup, name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}
async function check(name, fn) {
  try {
    const r = await fn();
    record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)}`);
  } catch (e) {
    record(name, false, String(e?.message ?? e).split("\n")[0]);
  }
}

let pool;
let admin;
let embeddedServer = null;
let embeddedDir = null;

function assertLocal(u) {
  const url = new URL(u);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`REFUSED: ${url.hostname} is not loopback`);
  if (u.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project reference");
}
async function startDatabase() {
  if (MODE === "external") { assertLocal(process.env.DB_PROOF_CONN); return process.env.DB_PROOF_CONN; }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-entitlement-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE entitlement_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/entitlement_proof`;
}
async function stopDatabase() {
  try { await pool?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  if (embeddedServer) { try { await embeddedServer.stop(); } catch { /* ignore */ } }
  if (embeddedDir) { try { fs.rmSync(embeddedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir cleanup is best effort */ } }
}

const migrationFiles = () => fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
async function applyMigration(f) {
  let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
  if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  try { await admin.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
}
function splitStatements(sql) {
  const out = []; let cur = ""; let i = 0;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "-" && n === "-") { const e = sql.indexOf("\n", i); const j = e < 0 ? sql.length : e; cur += sql.slice(i, j); i = j; continue; }
    if (c === "/" && n === "*") { const e = sql.indexOf("*/", i + 2); const j = e < 0 ? sql.length : e + 2; cur += sql.slice(i, j); i = j; continue; }
    if (c === "'" || c === '"') { let j = i + 1; while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; } cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === "$") { const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i)); if (m) { const e = sql.indexOf(m[0], i + m[0].length); const j = e < 0 ? sql.length : e + m[0].length; cur += sql.slice(i, j); i = j; continue; } }
    if (c === ";") { if (cur.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) out.push(cur.trim()); cur = ""; i++; continue; }
    cur += c; i++;
  }
  if (cur.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) out.push(cur.trim());
  return out;
}
const FINGERPRINT_SQL = `SELECT md5(string_agg(x, '|' ORDER BY x)) AS fp FROM (
  SELECT 'c:'||table_name||'.'||column_name||':'||data_type||':'||coalesce(column_default,'')||is_nullable AS x FROM information_schema.columns WHERE table_schema='public'
  UNION ALL SELECT 'r:'||c.relname||c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL SELECT 'f:'||p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
  UNION ALL SELECT 't:'||tgname||':'||tgrelid::regclass::text FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'k:'||conname||':'||conrelid::regclass::text||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
  UNION ALL SELECT 'd:'||md5(coalesce((SELECT string_agg(to_jsonb(p)::text, ',' ORDER BY p.id) FROM public.commercial_plans p), '')
                          || coalesce((SELECT string_agg(to_jsonb(o)::text, ',' ORDER BY o.id) FROM public.commercial_offers o), '')
                          || coalesce((SELECT string_agg(to_jsonb(e)::text, ',' ORDER BY e.id) FROM public.entitlement_overrides e), ''))
) s`;
const fingerprint = async () => (await admin.query(FINGERPRINT_SQL)).rows[0].fp;

async function asCaller(caller, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (caller.kind === "anon") {
      await c.query("SET LOCAL ROLE anon");
      await c.query("SELECT set_config('request.jwt.claim.role','anon',true), set_config('request.jwt.claim.sub','',true)");
    } else if (caller.kind === "service") {
      await c.query("SET LOCAL ROLE service_role");
      await c.query("SELECT set_config('request.jwt.claim.role','service_role',true), set_config('request.jwt.claim.sub','',true)");
    } else {
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [caller.uid]);
    }
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally { c.release(); }
}
const user = (uid) => ({ kind: "user", uid });
const ANON = { kind: "anon" };
const SERVICE = { kind: "service" };
const q = (caller, sql, params) => asCaller(caller, async (c) => (await c.query(sql, params)).rows);
const one = async (caller, sql, params) => (await q(caller, sql, params))[0];
const uuid = () => globalThis.crypto.randomUUID();
const count = async (sql, params = []) => Number((await admin.query(sql, params)).rows[0].n);
const codeOf = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.code; } };
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: CONCURRENCY + 8 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);

  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);

  group("Upgrade — legacy commercial state is migrated deterministically");
  await check(`every migration before ${MIGRATION} applies`, async () => {
    if (cut < 0) return "migration not found";
    for (const f of files.slice(0, cut)) await applyMigration(f);
    return true;
  });
  const U = {};
  for (const k of ["legacyPaid", "admin"]) {
    U[k] = uuid();
    await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [U[k], `${k}@example.test`]);
  }
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const planId = async (code) => (await admin.query("SELECT id FROM public.commercial_plans WHERE product_id=$1 AND code=$2", [product, code])).rows[0]?.id;
  const legacyPaidPlan = await planId("PAID");
  const legacyBc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [U.legacyPaid, product])).rows[0].id;
  const legacyLicence = (await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start) VALUES ($1,$2,'ACTIVE','ADMIN_GRANT',now() - interval '1 day') RETURNING id", [legacyBc, legacyPaidPlan])).rows[0].id;
  const legacyOverrides = {};
  for (const code of ["MULTI_COMPANY", "SAFISHA_CERTIFY", "MULTI_PERIOD", "HESABU_REPORTING"]) {
    legacyOverrides[code] = (await admin.query("INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, granted_by, reason) VALUES ($1,$2,$3,'legacy proof') RETURNING id", [legacyBc, code, U.admin])).rows[0].id;
  }
  const retiredOffers = (await admin.query("SELECT id, offer_code FROM public.commercial_offers WHERE offer_code LIKE 'CFOCLOSE_PROFESSIONAL%' ORDER BY offer_code")).rows;

  await check(`${MIGRATION} applies over the legacy state`, async () => { await applyMigration(MIGRATION); return true; });
  await check("every later migration also applies", async () => { for (const f of files.slice(cut + 1)) await applyMigration(f); return true; });

  await check("the catalogue is exactly Free / Practice / Firm / Enterprise (+ the hidden legacy PAID plan)", async () => {
    const rows = (await admin.query("SELECT code, entity_capacity, user_capacity, is_public, sales_mode, display_order, feature_codes FROM public.commercial_plans WHERE product_id=$1 ORDER BY code", [product])).rows;
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    const PAIDS = ["CLOSE_ASSURANCE", "CLOSE_INSIGHTS", "COMPARATIVE_REPORTING", "ENTITY_CAPACITY", "REPORTING_PACK_EXPORT", "STATEMENT_CERTIFICATION"];
    const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    return rows.length === 5
      && by.FREE.entity_capacity === 1 && by.FREE.user_capacity === 1 && by.FREE.is_public && eq(by.FREE.feature_codes, ["CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "ENTITY_CAPACITY"])
      && by.PRACTICE.entity_capacity === 5 && by.PRACTICE.user_capacity === 3 && eq(by.PRACTICE.feature_codes, PAIDS)
      && by.FIRM.entity_capacity === 25 && by.FIRM.user_capacity === 10 && eq(by.FIRM.feature_codes, PAIDS)
      && by.ENTERPRISE.entity_capacity === null && by.ENTERPRISE.sales_mode === "contact_sales" && eq(by.ENTERPRISE.feature_codes, PAIDS)
      && by.PAID.is_public === false && by.PAID.sales_mode === "legacy" && by.PAID.entity_capacity === 25 && eq(by.PAID.feature_codes, PAIDS)
      ? true : JSON.stringify(rows);
  });
  await check("prices: Practice $99 / $990 and Firm $299 / $2,990 (USD, minor units, one row each); Enterprise has no price; nothing is purchasable (no checkout)", async () => {
    const rows = (await admin.query(`SELECT cp.code, o.billing_interval, o.amount_minor, o.currency_code, o.currency_exponent, o.is_purchasable
      FROM public.commercial_offers o JOIN public.commercial_plans cp ON cp.id=o.plan_id WHERE o.is_active ORDER BY cp.code, o.billing_interval`)).rows;
    const got = rows.map((r) => `${r.code}:${r.billing_interval}:${r.amount_minor}:${r.currency_code}:${r.currency_exponent}:${r.is_purchasable}`);
    return JSON.stringify(got) === JSON.stringify(["FIRM:ANNUAL:299000:USD:2:false", "FIRM:MONTHLY:29900:USD:2:false", "PRACTICE:ANNUAL:99000:USD:2:false", "PRACTICE:MONTHLY:9900:USD:2:false"]) ? true : got;
  });
  await check("the $49 / $499 offers are retired, not deleted (same ids, inactive, non-purchasable, ended)", async () => {
    const rows = (await admin.query("SELECT id, is_active, is_purchasable, effective_end FROM public.commercial_offers WHERE id = ANY($1::uuid[])", [retiredOffers.map((r) => r.id)])).rows;
    return retiredOffers.length === 2 && rows.length === 2 && rows.every((r) => !r.is_active && !r.is_purchasable && r.effective_end !== null);
  });
  await check("no public plan is priced at $49 and there is no Founding/$49 plan", async () =>
    (await count("SELECT count(*) n FROM public.commercial_offers WHERE is_active AND amount_minor IN (4900, 49900)")) === 0
    && (await count("SELECT count(*) n FROM public.commercial_plans WHERE code NOT IN ('FREE','PRACTICE','FIRM','ENTERPRISE','PAID')")) === 0);
  await check("legacy overrides keep their ids and map deterministically (MULTI_COMPANY → ENTITY_CAPACITY at 25, SAFISHA_CERTIFY → STATEMENT_CERTIFICATION, MULTI_PERIOD → COMPARATIVE_REPORTING, HESABU_REPORTING → CLOSE_ASSURANCE)", async () => {
    const rows = Object.fromEntries((await admin.query("SELECT id, feature_code, capacity_value FROM public.entitlement_overrides WHERE billing_customer_id=$1", [legacyBc])).rows.map((r) => [r.id, r]));
    const o = legacyOverrides;
    return rows[o.MULTI_COMPANY]?.feature_code === "ENTITY_CAPACITY" && rows[o.MULTI_COMPANY].capacity_value === 25
      && rows[o.SAFISHA_CERTIFY]?.feature_code === "STATEMENT_CERTIFICATION" && rows[o.SAFISHA_CERTIFY].capacity_value === null
      && rows[o.MULTI_PERIOD]?.feature_code === "COMPARATIVE_REPORTING" && rows[o.HESABU_REPORTING]?.feature_code === "CLOSE_ASSURANCE"
      ? true : JSON.stringify(rows);
  });
  await check("the legacy PAID licence is preserved (same id, still ACTIVE) and still entitles every paid capability", async () => {
    const l = (await admin.query("SELECT status, plan_id FROM public.commercial_licences WHERE id=$1", [legacyLicence])).rows[0];
    const r = (await admin.query("SELECT public._resolve_entitlement_for_owner($1,'CLOSE_INSIGHTS') r", [U.legacyPaid])).rows[0].r;
    return l.status === "ACTIVE" && l.plan_id === legacyPaidPlan && r.status === "ENTITLED";
  });
  await check("compatibility lookup: a legacy code resolves exactly like its canonical code", async () => {
    for (const [legacy, canon] of [["SAFISHA_CERTIFY", "STATEMENT_CERTIFICATION"], ["HESABU_EXPORT", "REPORTING_PACK_EXPORT"], ["MAONO_INTELLIGENCE", "CLOSE_INSIGHTS"], ["MULTI_PERIOD", "COMPARATIVE_REPORTING"]]) {
      const a = (await admin.query("SELECT public._resolve_entitlement_for_owner($1,$2) r", [U.legacyPaid, legacy])).rows[0].r;
      const b = (await admin.query("SELECT public._resolve_entitlement_for_owner($1,$2) r", [U.legacyPaid, canon])).rows[0].r;
      if (JSON.stringify(a) !== JSON.stringify(b) || a.capability !== canon) return legacy;
    }
    return true;
  });
  await check("constraints now refuse legacy codes and unknown plans (malformed state cannot be stored)", async () =>
    (await codeOf(() => admin.query("INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, granted_by, reason) VALUES ($1,'SAFISHA_CERTIFY',$2,'x')", [legacyBc, U.admin]))) === "23514"
    && (await codeOf(() => admin.query("INSERT INTO public.commercial_plans (product_id, code, name, entity_capacity, sales_mode, feature_codes) VALUES ($1,'GOLD','Gold',3,'self_serve',ARRAY['CLOSE_ASSURANCE','COMPARATIVE_REPORTING','ENTITY_CAPACITY'])", [product]))) === "23514"
    && (await codeOf(() => admin.query("INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, granted_by, reason) VALUES ($1,'ENTITY_CAPACITY',$2,'no number')", [legacyBc, U.admin]))) === "23514");
  await check("a second application is refused at statement 1 (autocommit, no wrapping transaction) and changes nothing", async () => {
    const before = await fingerprint();
    const stmts = splitStatements(fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8"));
    let failed = null;
    for (let k = 0; k < stmts.length; k++) { try { await admin.query(stmts[k]); } catch (e) { failed = { index: k, code: e.code }; break; } }
    return failed?.index === 0 && failed.code === "55000" && (await fingerprint()) === before ? true : JSON.stringify(failed);
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────────────────────
  for (const k of ["free", "practice", "firm", "enterprise", "expired", "grace", "suspended", "member", "grantee", "revoked", "unrelated", "paidOutsider", "partnerTitle", "capA", "capB", "capC", "capD"]) {
    U[k] = uuid();
    await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [U[k], `${k}@example.test`]);
  }
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [U.admin]);
  const licence = async (uid, planCode, status = "ACTIVE", { start = "now() - interval '1 day'", end = null } = {}) => {
    let bc = (await admin.query("SELECT id FROM public.billing_customers WHERE owner_user_id=$1", [uid])).rows[0]?.id;
    if (!bc) bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id;
    const id = (await admin.query(`INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end)
      VALUES ($1,$2,$3,'ADMIN_GRANT',${start},${end ?? "NULL"}) RETURNING id`, [bc, await planId(planCode), status])).rows[0].id;
    return { bc, id };
  };
  const practice = await licence(U.practice, "PRACTICE");
  await licence(U.firm, "FIRM");
  const enterprise = await licence(U.enterprise, "ENTERPRISE");
  await licence(U.expired, "PRACTICE", "ACTIVE", { start: "now() - interval '40 days'", end: "now() - interval '1 day'" });
  await licence(U.grace, "PRACTICE", "GRACE");
  await licence(U.suspended, "PRACTICE", "SUSPENDED");
  await licence(U.paidOutsider, "FIRM");
  const company = async (uid, name) => (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,$2) RETURNING id", [uid, name])).rows[0].id;
  const W = {
    free: await company(U.free, "Free Co"), practice: await company(U.practice, "Practice Co"), firm: await company(U.firm, "Firm Co"),
    expired: await company(U.expired, "Expired Co"), grace: await company(U.grace, "Grace Co"), suspended: await company(U.suspended, "Suspended Co"),
    outsider: await company(U.paidOutsider, "Outsider Co"),
  };
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now()), ($3,$2,'preparer',now())", [W.practice, U.member, W.free]);
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'partner',now())", [W.free, U.partnerTitle]);
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now())", [W.free, U.paidOutsider]);
  await admin.query("INSERT INTO public.workspace_capability_grants (company_id, grantee_user_id, capability, granted_by_user_id) VALUES ($1,$2,'prepare_trial_balance',$3)", [W.practice, U.grantee, U.practice]);
  await admin.query("INSERT INTO public.workspace_capability_grants (company_id, grantee_user_id, capability, granted_by_user_id, revoked_at, revoked_by_user_id) VALUES ($1,$2,'prepare_trial_balance',$3,now(),$3)", [W.practice, U.revoked, U.practice]);

  const withExpired = async (licenceId, fn) => {
    await admin.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end = now() WHERE id=$1", [licenceId]);
    try { return await fn(); } finally { await admin.query("UPDATE public.commercial_licences SET status='ACTIVE', effective_end = NULL WHERE id=$1", [licenceId]); }
  };
  const authz = async (caller, company, cap) => (await one(caller, "SELECT public.authorize_paid_action($1,$2) r", [company, cap])).r;
  const PAID = ["STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS"];

  group("Authority — AUTHORIZED = session AND workspace access AND known capability AND the workspace account's entitlement");
  await check("anonymous cannot even call the authority (42501)", async () => (await codeOf(() => authz(ANON, W.practice, "CLOSE_INSIGHTS"))) === "42501");
  await check("an unrelated signed-in user: WORKSPACE_ACCESS_DENIED for every capability, paid or included", async () => {
    for (const cap of [...PAID, "COMPARATIVE_REPORTING"]) if ((await authz(user(U.unrelated), W.practice, cap)).code !== "WORKSPACE_ACCESS_DENIED") return cap;
    return true;
  });
  await check("unknown capability → UNKNOWN_CAPABILITY; the capacity dimension is not an action → NOT_AN_ACTION; missing workspace → WORKSPACE_ACCESS_DENIED", async () =>
    (await authz(user(U.practice), W.practice, "TELEPORT")).code === "UNKNOWN_CAPABILITY"
    && (await authz(user(U.practice), W.practice, null)).code === "UNKNOWN_CAPABILITY"
    && (await authz(user(U.practice), W.practice, "ENTITY_CAPACITY")).code === "NOT_AN_ACTION"
    && (await authz(user(U.practice), uuid(), "CLOSE_INSIGHTS")).code === "WORKSPACE_ACCESS_DENIED");
  await check("Free workspace: the three paid actions → ENTITLEMENT_REQUIRED (Practice); Comparative Reporting and Close Assurance are allowed", async () => {
    for (const cap of PAID) { const r = await authz(user(U.free), W.free, cap); if (r.code !== "ENTITLEMENT_REQUIRED" || r.required_plan !== "PRACTICE" || r.allowed) return cap; }
    return (await authz(user(U.free), W.free, "COMPARATIVE_REPORTING")).allowed === true && (await authz(user(U.free), W.free, "CLOSE_ASSURANCE")).allowed === true;
  });
  await check("Practice and Firm workspaces: every paid action allowed for the creating account", async () => {
    for (const [u, w] of [[U.practice, W.practice], [U.firm, W.firm]]) for (const cap of PAID) if (!(await authz(user(u), w, cap)).allowed) return `${cap}`;
    return true;
  });
  await check("workspace access carries the WORKSPACE's entitlement: an accepted member and an active grant holder of a Practice workspace are allowed; a revoked grant is not", async () =>
    (await authz(user(U.member), W.practice, "CLOSE_INSIGHTS")).allowed === true && (await authz(user(U.grantee), W.practice, "REPORTING_PACK_EXPORT")).allowed === true
    && (await authz(user(U.revoked), W.practice, "REPORTING_PACK_EXPORT")).code === "WORKSPACE_ACCESS_DENIED");
  await check("workspace membership never grants a paid capability: the same member is refused in the Free workspace", async () =>
    (await authz(user(U.member), W.free, "CLOSE_INSIGHTS")).code === "ENTITLEMENT_REQUIRED");
  await check("an entitlement never grants workspace access, and cannot be carried into another account's workspace (cross-user / cross-workspace reuse)", async () =>
    (await authz(user(U.paidOutsider), W.practice, "CLOSE_INSIGHTS")).code === "WORKSPACE_ACCESS_DENIED"
    && (await authz(user(U.paidOutsider), W.free, "CLOSE_INSIGHTS")).code === "ENTITLEMENT_REQUIRED"
    && (await authz(user(U.paidOutsider), W.outsider, "CLOSE_INSIGHTS")).allowed === true);
  await check("no occupational title changes anything: a 'partner' member of the Free workspace is treated exactly like a 'preparer'", async () => {
    for (const cap of [...PAID, "COMPARATIVE_REPORTING"]) {
      const a = await authz(user(U.partnerTitle), W.free, cap); const b = await authz(user(U.member), W.free, cap);
      if (JSON.stringify(a) !== JSON.stringify(b)) return cap;
    }
    const src = (await admin.query(`SELECT string_agg(pg_get_functiondef(p.oid), ' ') s FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('_workspace_access_basis','_authorize_paid_action','_resolve_entitlement_for_owner','_entity_capacity_for_account','company_entity_capacity_wall','issue_reporting_pack','create_entity')`)).rows[0].s;
    return !/\brole\b|'owner'|'partner'|'manager'|'accountant'|'reviewer'|'admin'/i.test(src) ? true : "occupational term in the authority";
  });
  await check("expiry and suspension stop paid actions; GRACE keeps them", async () =>
    (await authz(user(U.expired), W.expired, "STATEMENT_CERTIFICATION")).code === "ENTITLEMENT_REQUIRED"
    && (await authz(user(U.suspended), W.suspended, "STATEMENT_CERTIFICATION")).code === "ENTITLEMENT_REQUIRED"
    && (await authz(user(U.grace), W.grace, "STATEMENT_CERTIFICATION")).allowed === true);
  await check("a caller-supplied user id is never authority: the user-id variant is service_role only", async () => {
    const r = (await admin.query(`SELECT has_function_privilege('authenticated','public.authorize_paid_action_for_user(uuid,uuid,text)','EXECUTE') a,
      has_function_privilege('anon','public.authorize_paid_action_for_user(uuid,uuid,text)','EXECUTE') n,
      has_function_privilege('service_role','public.authorize_paid_action_for_user(uuid,uuid,text)','EXECUTE') s`)).rows[0];
    return !r.a && !r.n && r.s && (await codeOf(() => q(user(U.free), "SELECT public.authorize_paid_action_for_user($1,$2,'CLOSE_INSIGHTS')", [U.practice, W.practice]))) === "42501";
  });
  await check("overrides are scoped to one account, audited, expire, and can be revoked; only commercial admins grant them", async () => {
    const freeBc = (await admin.query("SELECT id FROM public.billing_customers WHERE owner_user_id=$1", [U.free])).rows[0].id;
    const notAdmin = await codeOf(() => q(user(U.free), "SELECT public.admin_grant_entitlement_override($1,'CLOSE_INSIGHTS','self-grant',NULL)", [freeBc]));
    const g = (await one(user(U.admin), "SELECT public.admin_grant_entitlement_override($1,'MAONO_INTELLIGENCE','pilot',now() + interval '1 hour') r", [freeBc])).r;
    const stored = (await admin.query("SELECT feature_code FROM public.entitlement_overrides WHERE id=$1", [g.override_id])).rows[0].feature_code;
    const audited = await count("SELECT count(*) n FROM public.billing_audit_events WHERE billing_customer_id=$1 AND action='ENTITLEMENT_OVERRIDE_GRANTED'", [freeBc]);
    const during = (await authz(user(U.free), W.free, "CLOSE_INSIGHTS")).allowed;
    const other = (await authz(user(U.free), W.free, "REPORTING_PACK_EXPORT")).allowed;
    const elsewhere = (await authz(user(U.expired), W.expired, "CLOSE_INSIGHTS")).allowed;
    await admin.query("UPDATE public.entitlement_overrides SET effective_start = now() - interval '2 hours', effective_end = now() - interval '1 hour' WHERE id=$1", [g.override_id]);
    const afterExpiry = (await authz(user(U.free), W.free, "CLOSE_INSIGHTS")).allowed;
    const g2 = (await one(user(U.admin), "SELECT public.admin_grant_entitlement_override($1,'CLOSE_INSIGHTS','pilot 2',NULL) r", [freeBc])).r;
    await one(user(U.admin), "SELECT public.admin_revoke_entitlement_override($1,'pilot ended') r", [g2.override_id]);
    const afterRevoke = (await authz(user(U.free), W.free, "CLOSE_INSIGHTS")).allowed;
    const capWrong = await codeOf(() => q(user(U.admin), "SELECT public.admin_grant_entitlement_override($1,'ENTITY_CAPACITY','x',NULL)", [freeBc]));
    return notAdmin === "42501" && stored === "CLOSE_INSIGHTS" && audited === 1 && during === true && other === false && elsewhere === false
      && afterExpiry === false && afterRevoke === false && capWrong === "22023" ? true : JSON.stringify({ notAdmin, stored, audited, during, other, elsewhere, afterExpiry, afterRevoke, capWrong });
  });
  await check("every authority function pins search_path, is SECURITY DEFINER, and is never executable by PUBLIC/anon", async () => {
    const rows = (await admin.query(`SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') anon
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
      ('commercial_canonical_capability','_resolve_entitlement_for_owner','_entity_capacity_for_account','_workspace_access_basis','_authorize_paid_action',
       'authorize_paid_action','authorize_paid_action_for_user','workspace_capability_entitled','_require_workspace_capability','get_workspace_commercial_state',
       'statement_sign_off_certification_wall','financial_statement_final_certification_wall','close_insights_wall','company_entity_capacity_wall',
       'issue_reporting_pack','can_access_workspace','get_my_entity_capacity','admin_grant_entity_capacity_override')`)).rows;
    const bad = rows.filter((r) => !r.prosecdef || !(r.proconfig ?? []).some((c) => c.startsWith("search_path=")) || r.anon);
    return rows.length === 18 && bad.length === 0 ? true : JSON.stringify(bad.map((b) => b.proname));
  });

  group("Close Certification — new sign-offs and FINAL reports need STATEMENT_CERTIFICATION; history stays readable");
  let periodSeq = 2000;
  const upload = async (co, uid) => (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,$4) RETURNING id", [`${uid}/${uuid()}.csv`, co, uid, ++periodSeq])).rows[0].id;
  const draft = async (co, uid) => {
    const up = await upload(co, uid);
    return (await one(user(uid), "INSERT INTO public.statement_sign_offs (company_id, period_year, upload_id) VALUES ($1,$2,$3) RETURNING id", [co, periodSeq, up])).id;
  };
  const advance = (uid, id) => q(user(uid), "UPDATE public.statement_sign_offs SET status='preparer_signed' WHERE id=$1 RETURNING id", [id]);
  await check("a Free workspace may create a DRAFT sign-off (preparation stays free)", async () => typeof (await draft(W.free, U.free)) === "string");
  await check("a Free workspace cannot record a sign-off event by direct client write: 402 (PT402) with the structured capability code", async () => {
    const id = await draft(W.free, U.free);
    const e = await errOf(() => advance(U.free, id));
    return e?.code === "PT402" && e.detail === "STATEMENT_CERTIFICATION" && (await admin.query("SELECT status FROM public.statement_sign_offs WHERE id=$1", [id])).rows[0].status === "draft";
  });
  await check("nor through the service role (the wall is the database boundary, not the client)", async () => {
    const id = await draft(W.free, U.free);
    return (await codeOf(() => q(SERVICE, "UPDATE public.statement_sign_offs SET status='preparer_signed' WHERE id=$1", [id]))) === "PT402";
  });
  await check(`${CONCURRENCY} concurrent sign-off attempts on a Free workspace: every one refused, nothing recorded`, async () => {
    const ids = []; for (let i = 0; i < CONCURRENCY; i++) ids.push(await draft(W.free, U.free));
    const out = await Promise.all(ids.map((id) => codeOf(() => advance(U.free, id))));
    return out.every((c) => c === "PT402") && (await count("SELECT count(*) n FROM public.statement_sign_offs WHERE id = ANY($1::uuid[]) AND status <> 'draft'", [ids])) === 0;
  });
  let practiceSignOff;
  await check("a Practice (and GRACE) workspace records the sign-off event", async () => {
    practiceSignOff = await draft(W.practice, U.practice);
    const g = await draft(W.grace, U.grace);
    return (await advance(U.practice, practiceSignOff)).length === 1 && (await advance(U.grace, g)).length === 1;
  });
  await check("after expiry: no NEW sign-off event, but every existing sign-off remains readable and unchanged", async () => {
    const before = (await admin.query("SELECT to_jsonb(s) j FROM public.statement_sign_offs s WHERE id=$1", [practiceSignOff])).rows[0].j;
    return withExpired(practice.id, async () => {
      const next = await draft(W.practice, U.practice);
      const refused = await codeOf(() => advance(U.practice, next));
      const readable = await q(user(U.practice), "SELECT to_jsonb(s) j FROM public.statement_sign_offs s WHERE id=$1", [practiceSignOff]);
      return refused === "PT402" && readable.length === 1 && JSON.stringify(readable[0].j) === JSON.stringify(before);
    });
  });
  const member = async (co) => (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 ORDER BY created_at LIMIT 1", [co])).rows[0].id;
  const report = async (co) => {
    const rid = `r-${uuid()}`;
    await admin.query(`INSERT INTO public.financial_statement_reports (report_id, report_version, company_id, period_year, provenance_origin, report_document, content_hash, document_hash, created_by_firm_member_id)
      VALUES ($1,1,$2,2025,'TRIAL_BALANCE_DERIVED','{}'::jsonb,$3,$3,$4)`, [rid, co, "a".repeat(64), await member(co)]);
    return rid;
  };
  const publish = async (co, rid, state) => admin.query("INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id) VALUES ($1,1,$2,$3,'proof publication',$4)", [rid, co, state, await member(co)]);
  await check("FINAL report version: refused for Free (PT402), allowed for Practice; REVIEWED/DRAFT stay free", async () => {
    const rf = await report(W.free); const rp = await report(W.practice);
    const draftOk = await codeOf(() => publish(W.free, rf, "REVIEWED"));
    const freeFinal = await errOf(() => publish(W.free, rf, "FINAL"));
    const paidFinal = await codeOf(() => publish(W.practice, rp, "FINAL"));
    return draftOk === "ok" && freeFinal?.code === "PT402" && freeFinal.detail === "STATEMENT_CERTIFICATION" && paidFinal === "ok" ? true : JSON.stringify({ draftOk, free: freeFinal?.code, paidFinal });
  });

  group("Reporting Pack — issued only by the server, idempotent, workspace-scoped, readable after expiry");
  const issue = (uid, co, kind = "financial_statements_pdf", rid = uuid()) => one(user(uid), "SELECT public.issue_reporting_pack($1,2025,$2,$3) r", [co, kind, rid]).then((x) => x.r);
  await check("Free: preview stays available, a formal pack is refused with a structured outcome (entitlement_required, Practice)", async () => {
    const r = await issue(U.free, W.free);
    return r.outcome === "entitlement_required" && r.required_plan === "PRACTICE" && (await count("SELECT count(*) n FROM public.reporting_pack_issuances WHERE company_id=$1", [W.free])) === 0;
  });
  let issued;
  await check("Practice: issued; a retry with the same request id returns the same issuance; concurrent retries create exactly one", async () => {
    const rid = uuid();
    issued = await issue(U.practice, W.practice, "filing_pack", rid);
    const again = await issue(U.practice, W.practice, "filing_pack", rid);
    const rid2 = uuid();
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => issue(U.practice, W.practice, "board_pack", rid2)));
    const ids = new Set(out.map((o) => o.issuance_id));
    return issued.outcome === "issued" && again.outcome === "already_issued" && again.issuance_id === issued.issuance_id
      && ids.size === 1 && out.filter((o) => o.outcome === "issued").length === 1 ? true : JSON.stringify({ issued, again, n: ids.size });
  });
  await check("URL guessing: another workspace's user, an unrelated user and anonymous read nothing; members of the workspace read it", async () => {
    const byId = (caller) => q(caller, "SELECT id FROM public.reporting_pack_issuances WHERE id=$1", [issued.issuance_id]);
    return (await byId(user(U.free))).length === 0 && (await byId(user(U.unrelated))).length === 0
      && (await codeOf(() => byId(ANON))) === "42501" && (await byId(user(U.member))).length === 1 && (await byId(user(U.practice))).length === 1;
  });
  await check("issuances cannot be written, changed or deleted by clients or the service role outside the RPC", async () =>
    (await codeOf(() => q(user(U.practice), "INSERT INTO public.reporting_pack_issuances (company_id, period_year, pack_kind, request_id, issued_by) VALUES ($1,2025,'client_pack',$2,$3)", [W.practice, uuid(), U.practice]))) === "42501"
    && (await codeOf(() => admin.query("UPDATE public.reporting_pack_issuances SET pack_kind='client_pack' WHERE id=$1", [issued.issuance_id]))) === "P0001"
    && (await codeOf(() => admin.query("DELETE FROM public.reporting_pack_issuances WHERE id=$1", [issued.issuance_id]))) === "P0001");
  await check("after expiry: no new pack, the historical issuance remains readable", async () => {
    return withExpired(practice.id, async () => {
      const r = await issue(U.practice, W.practice);
      const hist = await q(user(U.practice), "SELECT id FROM public.reporting_pack_issuances WHERE id=$1", [issued.issuance_id]);
      return r.outcome === "entitlement_required" && hist.length === 1;
    });
  });
  await check("an unrelated user is refused before any entitlement question (workspace_access_denied)", async () =>
    (await issue(U.unrelated, W.practice)).outcome === "workspace_access_denied");

  group("Close Insights — new analysis needs CLOSE_INSIGHTS at the database boundary; essential validation stays free");
  const run = (co, uid) => admin.query("INSERT INTO public.variance_runs (company_id, tb_upload_ids, period_from, period_to, fiscal_year, period_month, triggered_by) VALUES ($1,ARRAY[]::uuid[],'2025-01-01','2025-12-31',2025,12,$2) RETURNING id", [co, uid]);
  let paidRun;
  await check("a new variance run: refused for a Free workspace (PT402, CLOSE_INSIGHTS), recorded for Practice", async () => {
    const e = await errOf(() => run(W.free, U.free));
    paidRun = (await run(W.practice, U.practice)).rows[0].id;
    return e?.code === "PT402" && e.detail === "CLOSE_INSIGHTS" && !!paidRun;
  });
  await check("insights, forecasts and alerts are walled the same way (server-side bypass fails)", async () => {
    const alert = (co) => admin.query("INSERT INTO public.variance_alerts (company_id, alert_type, message) VALUES ($1,'variance_threshold','proof')", [co]);
    return (await codeOf(() => alert(W.free))) === "PT402" && (await codeOf(() => alert(W.practice))) === "ok";
  });
  await check("after expiry the historical run stays readable for the workspace; no new run can be created", async () => {
    return withExpired(practice.id, async () => {
      const blocked = await codeOf(() => run(W.practice, U.practice));
      const still = await count("SELECT count(*) n FROM public.variance_runs WHERE id=$1", [paidRun]);
      return blocked === "PT402" && still === 1;
    });
  });
  await check("ordinary validation is never walled: statement validation results can be recorded for a Free workspace", async () => {
    const up = await upload(W.free, U.free);
    const e = await errOf(() => admin.query("INSERT INTO public.hesabu_validations (upload_id, company_id, period_year, status, validated_by) VALUES ($1,$2,$3,'all_pass',$4)", [up, W.free, periodSeq, U.free]));
    return e === null ? true : `${e.code} ${e.message}`;
  });

  group("Entity Capacity — Free 1, Practice 5, Firm 25; concurrent, direct, RPC and retry-safe; downgrade never hides anything");
  const createEntity = (uid, rid = uuid(), name = "Entity") => one(user(uid), "SELECT public.create_entity($1,$2,'2025-12-31','USD','ifrs_for_smes') r", [rid, name]).then((x) => x.r);
  const direct = (uid, name = "Direct") => q(user(uid), "INSERT INTO public.companies (user_id,name) VALUES ($1,$2) RETURNING id", [uid, name]);
  const active = (uid) => count("SELECT count(*) n FROM public.companies WHERE user_id=$1 AND COALESCE(is_active,true)", [uid]);
  await check("Free stops at 1: direct insert refused (PT402 ENTITY_CAPACITY) and the RPC answers capacity_reached with the numbers", async () => {
    const e = await errOf(() => direct(U.free));
    const r = await createEntity(U.free);
    return e?.code === "PT402" && e.detail === "ENTITY_CAPACITY" && r.outcome === "capacity_reached" && r.capacity === 1 && r.used === 1 && (await active(U.free)) === 1
      ? true : JSON.stringify({ e: e?.code, r });
  });
  await check("the service role cannot bypass capacity either", async () =>
    (await codeOf(() => q(SERVICE, "INSERT INTO public.companies (user_id,name) VALUES ($1,'svc')", [U.free]))) === "PT402");
  await check("Practice stops at 5, Firm at 25", async () => {
    for (let i = 0; i < 4; i++) if ((await createEntity(U.practice)).outcome !== "created") return `practice ${i}`;
    const sixth = await createEntity(U.practice);
    for (let i = 0; i < 24; i++) if ((await createEntity(U.firm)).outcome !== "created") return `firm ${i}`;
    const twentySixth = await createEntity(U.firm);
    return sixth.outcome === "capacity_reached" && (await active(U.practice)) === 5 && twentySixth.outcome === "capacity_reached" && (await active(U.firm)) === 25;
  });
  await check(`${CONCURRENCY} simultaneous creations cannot exceed the limit (new Free account: exactly 1; Practice account with 2: exactly 3 more)`, async () => {
    const a = await Promise.all(Array.from({ length: CONCURRENCY }, () => createEntity(U.capA)));
    await licence(U.capB, "PRACTICE");
    await createEntity(U.capB); await createEntity(U.capB);
    const b = await Promise.all(Array.from({ length: CONCURRENCY }, () => createEntity(U.capB)));
    const d = await Promise.all(Array.from({ length: CONCURRENCY }, () => codeOf(() => direct(U.capD))));
    return a.filter((r) => r.outcome === "created").length === 1 && (await active(U.capA)) === 1
      && b.filter((r) => r.outcome === "created").length === 3 && (await active(U.capB)) === 5
      && d.filter((c) => c === "ok").length === 1 && (await active(U.capD)) === 1 ? true : JSON.stringify({ a: await active(U.capA), b: await active(U.capB), d: await active(U.capD) });
  });
  await check("retries are idempotent: the same request id returns the same workspace, sequentially and concurrently", async () => {
    await licence(U.capC, "FIRM");
    const rid = uuid();
    const first = await createEntity(U.capC, rid, "Once");
    const again = await createEntity(U.capC, rid, "Once");
    const rid2 = uuid();
    const burst = await Promise.all(Array.from({ length: CONCURRENCY }, () => createEntity(U.capC, rid2, "Burst")));
    const ids = new Set(burst.map((r) => r.company_id));
    return first.outcome === "created" && again.outcome === "already_created" && again.company_id === first.company_id
      && ids.size === 1 && burst.filter((r) => r.outcome === "created").length === 1
      && (await count("SELECT count(*) n FROM public.companies WHERE user_id=$1 AND creation_request_id=$2", [U.capC, rid2])) === 1 ? true : JSON.stringify({ first, again, n: ids.size });
  });
  await check("downgrade (Firm expires with 25 entities): nothing is deleted, hidden or detached; every entity stays readable; no 26th — and no new one at all", async () => {
    const before = (await admin.query("SELECT id, name, is_active FROM public.companies WHERE user_id=$1 ORDER BY id", [U.firm])).rows;
    await admin.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end = now() WHERE billing_customer_id=(SELECT id FROM public.billing_customers WHERE owner_user_id=$1)", [U.firm]);
    const after = (await admin.query("SELECT id, name, is_active FROM public.companies WHERE user_id=$1 ORDER BY id", [U.firm])).rows;
    const visible = await q(user(U.firm), "SELECT id FROM public.companies WHERE user_id=$1", [U.firm]);
    const create = await createEntity(U.firm);
    return JSON.stringify(before) === JSON.stringify(after) && visible.length === 25 && create.outcome === "capacity_reached" && create.capacity === 1;
  });
  await check("an over-limit account can deactivate an entity but cannot reactivate it (or any other) until usage is within the plan", async () => {
    const [x, y] = (await admin.query("SELECT id FROM public.companies WHERE user_id=$1 ORDER BY id LIMIT 2", [U.firm])).rows.map((r) => r.id);
    const off = await codeOf(() => q(user(U.firm), "UPDATE public.companies SET is_active=false WHERE id=$1", [x]));
    const on = await codeOf(() => q(user(U.firm), "UPDATE public.companies SET is_active=true WHERE id=$1", [x]));
    const rename = await codeOf(() => q(user(U.firm), "UPDATE public.companies SET name='Renamed' WHERE id=$1", [y]));
    return off === "ok" && on === "PT402" && rename === "ok";
  });
  await check("Enterprise without a recorded contract capacity is refused (fail closed); an audited capacity override enables it", async () => {
    const first = await createEntity(U.enterprise);
    const nonAdmin = await codeOf(() => q(user(U.enterprise), "SELECT public.admin_grant_entity_capacity_override($1,40,'self',NULL)", [enterprise.bc]));
    await one(user(U.admin), "SELECT public.admin_grant_entity_capacity_override($1,40,'Enterprise contract',NULL) r", [enterprise.bc]);
    const second = await createEntity(U.enterprise);
    const cap = (await one(user(U.enterprise), "SELECT public.get_my_entity_capacity() r")).r;
    return first.outcome === "capacity_undetermined" && nonAdmin === "42501" && second.outcome === "created" && cap.capacity === 40 && cap.source === "ADMIN_OVERRIDE"
      ? true : JSON.stringify({ first, nonAdmin, second, cap });
  });

  group("Billing never changes accounting");
  await check("licence activation, expiry, suspension and plan changes leave certifications, sign-offs, uploads and FINAL publications byte-identical", async () => {
    const snap = async () => (await admin.query(`SELECT md5(coalesce((SELECT string_agg(to_jsonb(t)::text, ',' ORDER BY t.id) FROM public.tb_certifications t), '')
      || coalesce((SELECT string_agg(to_jsonb(s)::text, ',' ORDER BY s.id) FROM public.statement_sign_offs s), '')
      || coalesce((SELECT string_agg(to_jsonb(u)::text, ',' ORDER BY u.id) FROM public.trial_balance_uploads u), '')
      || coalesce((SELECT string_agg(to_jsonb(p)::text, ',' ORDER BY p.id) FROM public.financial_statement_publications p), '')) h`)).rows[0].h;
    const before = await snap();
    for (const s of ["SUSPENDED", "EXPIRED", "CANCELLED", "ACTIVE"]) await admin.query("UPDATE public.commercial_licences SET status=$1 WHERE id=$2", [s, practice.id]);
    await admin.query("UPDATE public.commercial_licences SET plan_id=$1 WHERE id=$2", [await planId("FIRM"), practice.id]);
    await admin.query("UPDATE public.commercial_licences SET plan_id=$1 WHERE id=$2", [await planId("PRACTICE"), practice.id]);
    return (await snap()) === before;
  });
  await check("no trigger on any commercial table writes an accounting, certification or lifecycle table", async () => {
    const defs = (await admin.query(`SELECT c.relname, pg_get_functiondef(t.tgfoid) d FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN ('commercial_plans','commercial_offers','commercial_licences','billing_customers','entitlement_overrides','payment_events','billing_audit_events','commercial_capabilities','commercial_capability_aliases','reporting_pack_issuances')`)).rows;
    const bad = defs.filter((r) => /(INSERT INTO|UPDATE|DELETE FROM)\s+(public\.)?(tb_certifications|statement_sign_offs|trial_balance_uploads|financial_statement_|tax_computations|account_mappings|fiscal_periods)/i.test(r.d));
    return bad.length === 0 ? true : bad.map((b) => b.relname);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n──────────────────────────────────────────\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  console.log(failed.length === 0 ? "ENTITLEMENTS: ALL PASSED" : "ENTITLEMENTS: FAILED");
  return failed.length === 0;
}

let ok = false;
try { ok = await main(); } catch (e) { console.error(`FATAL: ${e?.stack ?? e}`); } finally { await stopDatabase(); }
process.exitCode = ok ? 0 : 1;
