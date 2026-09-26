#!/usr/bin/env node
// Real-PostgreSQL proof of the plan catalogue, the plan x capability matrix, capability authorization and the minimum
// grant on the workspace-authority predicates (20260925130000, 20260925140000, 20260925150000).
//
//   no permanent free plan    FREE -> EXPIRED_READ_ONLY: the legacy Free licence ends and the account becomes read-only;
//                             nothing is deleted and NO plan is granted; Free cannot be offered or granted again; only an
//                             explicit, audited administrator action records a plan afterwards
//   reconciliation            every reconciliation / EFDMS mutation (match, categorize, score, resolve, ingest, direct
//                             table, service role, RPC) is refused without a current plan and the capability
//   limits                    Solo 1 entity / 1 user, Practice 5, Firm 25; seats; invitation expiry and
//                             accept/cancel concurrency; downgrade suspension and explicit restoration
//   capabilities              stored per person, never a job title: grant / withdraw / re-title, append-only,
//                             no oracle, no policy or authority function reads the title, 30-policy parity
//   matrix                    one authority, complete, fail closed; formats need their plan feature
//   Reporting Pack            replay, cross-account, capability and post-downgrade refusal
//   grants                    clean replay and hosted-drift replay converge to EXECUTE for service_role only
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/planCapabilities.mjs
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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-plan-capabilities-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE plan_capabilities_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/plan_capabilities_proof`;
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


const M130 = "20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql";
const M140 = "20260925140000_workspace_capability_authorization.sql";
const M150 = "20260925150000_can_user_act_on_workspace_minimum_grant.sql";
const CAPS = ["prepare_close", "review_close", "approve_certification", "issue_reporting_pack", "manage_members"];
const TEMPLATE = {
  owner: ["approve_certification", "issue_reporting_pack", "manage_members", "prepare_close", "review_close"],
  partner: ["approve_certification", "issue_reporting_pack", "prepare_close", "review_close"],
  preparer: ["issue_reporting_pack", "prepare_close"],
  viewer: ["issue_reporting_pack"],
};
const MATRIX_CAPS = ["CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS",
  "CLEAN_PDF", "EXCEL_EXPORT", "FILING_PACKS", "MANAGEMENT_LETTERS", "MULTI_ENTITY_REPORTING", "CONSOLIDATION", "REGIONAL_PACKS"];
const aclOf = async (sig) => (await admin.query("SELECT coalesce(proacl::text,'') a FROM pg_proc WHERE oid = $1::regprocedure", [sig])).rows[0].a;

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
  const cut = files.indexOf(M130);
  const mkUser = async (label = "u") => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id}@example.test`]); return id; };
  const L = {};
  const snapshot = async (company) => (await admin.query(`SELECT
      (SELECT to_jsonb(c) - 'updated_at' FROM public.companies c WHERE c.id=$1) co,
      (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id), '[]') FROM public.firm_members f WHERE f.company_id=$1) fm,
      (SELECT coalesce(jsonb_agg(to_jsonb(u) - 'updated_at' ORDER BY u.id), '[]') FROM public.trial_balance_uploads u WHERE u.company_id=$1) tb,
      (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id), '[]') FROM public.workspace_capability_grants g WHERE g.company_id=$1) gr,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM public.tax_losses t WHERE t.company_id=$1) tl,
      (SELECT coalesce(jsonb_agg(to_jsonb(i) - 'storage_path' - 'byte_size' ORDER BY i.id), '[]') FROM public.reporting_pack_issuances i WHERE i.company_id=$1) iss,
      (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]') FROM public.reporting_pack_issuance_events e WHERE e.company_id=$1) iev,
      (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]') FROM public.billing_audit_events a JOIN public.billing_customers b ON b.id=a.billing_customer_id
         JOIN public.companies c ON c.user_id=b.owner_user_id WHERE c.id=$1) aud`, [company])).rows[0];

  group("Migration replay — clean and already-upgraded; the legacy Free state is converted, never deleted");
  await check(`every migration before ${M130} applies`, async () => {
    if (cut < 0) return "migration not found";
    for (const f of files.slice(0, cut)) await applyMigration(f);
    return true;
  });
  // The legacy Free state as a hosted database has it: an account whose first company auto-provisioned an ACTIVE, open-ended
  // FREE licence, with a member, a viewer, an upload and a tax-loss record.
  L.holder = await mkUser("legacy-holder"); L.member = await mkUser("legacy-member"); L.viewer = await mkUser("legacy-viewer");
  L.co = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Legacy Free Co') RETURNING id", [L.holder])).rows[0].id;
  await admin.query("BEGIN"); await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now()), ($1,$3,'viewer',now())", [L.co, L.member, L.viewer]);
  await admin.query("COMMIT");
  await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,2025)", [`${L.holder}/legacy.csv`, L.co, L.holder]);
  await admin.query("INSERT INTO public.tax_losses (company_id, created_by, period_year) VALUES ($1,$2,2025)", [L.co, L.holder]);
  const legacyIssuance = (await admin.query(`INSERT INTO public.reporting_pack_issuances (company_id, period_year, pack_kind, request_id, issued_by, plan_code, output_ref, expires_at, consumed_at, content_sha256, consumed_plan_code)
    VALUES ($1,2025,'financial_statements_pdf',gen_random_uuid(),$2,'PAID','upload:legacy',now() + interval '10 minutes',now(),$3,'PAID') RETURNING id`, [L.co, L.holder, "c".repeat(64)])).rows[0].id;
  await admin.query("INSERT INTO public.reporting_pack_issuance_events (issuance_id, company_id, actor_user_id, event, detail) VALUES ($1,$2,$3,'SEALED','{}'::jsonb)", [legacyIssuance, L.co, L.holder]);
  const legacyFreeLicence = (await admin.query(`SELECT cl.id, cl.status FROM public.commercial_licences cl JOIN public.billing_customers b ON b.id=cl.billing_customer_id
      JOIN public.commercial_plans cp ON cp.id=cl.plan_id WHERE b.owner_user_id=$1 AND cp.code='FREE'`, [L.holder])).rows[0];
  const legacyBefore = await snapshot(L.co);
  const preCapabilityDefs = {};
  // ── Production interlock (B-3): a durable, environment-bound, single-use approval, consumed by the retirement statement ──
  const IA = await mkUser("interlock-admin");
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [IA]);
  const inventory = async () => (await admin.query("SELECT public._free_plan_inventory() i")).rows[0].i;
  const freeOpen = () => count("SELECT count(*) n FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id=cl.plan_id WHERE cp.code='FREE' AND cl.status IN ('PENDING','ACTIVE','GRACE')");
  const refusedCleanly = async (label) => {
    const before = await fingerprint(); const open = await freeOpen();
    const e = await errOf(() => applyMigration(M130));
    const ok = e?.message?.includes("production interlock") && (await fingerprint()) === before && (await freeOpen()) === open && open > 0;
    return ok ? null : `${label}: ${e?.message ?? "applied"}`;
  };
  await check("production interlock: with no approval, 130000 is refused as a whole — schema, data and every Free licence unchanged", async () => (await refusedCleanly("no approval")) ?? true);
  await check("a runner that continues after errors (statement by statement) cannot apply ANY part of 130000: it is one atomic statement", async () => {
    const before = await fingerprint(); const open = await freeOpen();
    const stmts = splitStatements(fs.readFileSync(path.join(REPO, "supabase/migrations", M130), "utf8"));
    let errors = 0; for (const st of stmts) { try { await admin.query(st); } catch { errors++; } }
    return stmts.length === 1 && errors === 1 && (await fingerprint()) === before && (await freeOpen()) === open ? true : JSON.stringify({ n: stmts.length, errors });
  });
  await check("no setting can stand in for the approval: session, database-level and role-level defaults of the old switch are ignored", async () => {
    const db = (await admin.query("SELECT current_database() d")).rows[0].d;
    await admin.query(`ALTER DATABASE "${db}" SET cfoclose.free_retirement_approval = 'FREE_ACCOUNTS_INVENTORIED_NOTIFIED_AND_ACTIVATION_PATH_CONFIRMED'`);
    await admin.query("ALTER ROLE postgres SET cfoclose.free_retirement_approval = 'FREE_ACCOUNTS_INVENTORIED_NOTIFIED_AND_ACTIVATION_PATH_CONFIRMED'");
    await admin.query("SET cfoclose.free_retirement_approval = 'FREE_ACCOUNTS_INVENTORIED_NOTIFIED_AND_ACTIVATION_PATH_CONFIRMED'");
    try { return (await refusedCleanly("settings")) ?? true; } finally {
      await admin.query(`ALTER DATABASE "${db}" RESET cfoclose.free_retirement_approval`); await admin.query("ALTER ROLE postgres RESET cfoclose.free_retirement_approval");
      await admin.query("RESET cfoclose.free_retirement_approval");
    }
  });
  await check("wrong approvals are refused: another environment, a stale inventory, an expired one, an already consumed one", async () => {
    const inv = await inventory();
    // Forged rows need superuser powers (replication mode bypasses the insert guard); even those are refused by the interlock.
    const ins = async (fp, evidence, approvedAt = "now()", expiresAt = "now() + interval '1 hour'", consumed = false) => {
      await admin.query("BEGIN"); await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
      `INSERT INTO public.deployment_approvals (purpose, environment_fingerprint, environment_label, evidence, approved_by, approved_at, expires_at, consumed_at, consumed_by)
       VALUES ('FREE_PLAN_RETIREMENT',$1,'proof',$2,$3,${approvedAt},${expiresAt},${consumed ? "now()" : "NULL"},${consumed ? "'earlier'" : "NULL"})`, [fp, evidence, IA]);
      await admin.query("COMMIT");
    };
    const fp = (await admin.query("SELECT public._environment_fingerprint() f")).rows[0].f;
    const out = [];
    await ins("0".repeat(32), inv); out.push(await refusedCleanly("other environment"));
    await ins(fp, { ...inv, inventory_digest: "f".repeat(32) }); out.push(await refusedCleanly("stale inventory"));
    await ins(fp, inv, "now() - interval '3 hours'", "now() - interval '1 hour'"); out.push(await refusedCleanly("expired"));
    await ins(fp, inv, "now()", "now() + interval '1 hour'", true); out.push(await refusedCleanly("consumed"));
    return out.every((x) => x === null) ? true : JSON.stringify(out);
  });
  await check("the approval can only be recorded by a commercial administrator, for the current inventory, with a notification reference and an activation path", async () => {
    const inv = await inventory();
    const nonAdmin = await codeOf(() => q(user(L.holder), "SELECT public.admin_record_deployment_approval('FREE_PLAN_RETIREMENT','staging',$1,'notice-1','MANUAL_ADMIN')", [inv.open_free_licences]));
    const stale = await errOf(() => q(user(IA), "SELECT public.admin_record_deployment_approval('FREE_PLAN_RETIREMENT','staging',$1,'notice-1','MANUAL_ADMIN')", [inv.open_free_licences + 1]));
    const noNotice = await errOf(() => q(user(IA), "SELECT public.admin_record_deployment_approval('FREE_PLAN_RETIREMENT','staging',$1,'','MANUAL_ADMIN')", [inv.open_free_licences]));
    const noPath = await errOf(() => q(user(IA), "SELECT public.admin_record_deployment_approval('FREE_PLAN_RETIREMENT','staging',$1,'notice-1','LATER')", [inv.open_free_licences]));
    const direct = await codeOf(() => q(user(IA), "INSERT INTO public.deployment_approvals (purpose, environment_fingerprint, environment_label, evidence, approved_by, expires_at) VALUES ('FREE_PLAN_RETIREMENT','x','y','{}',$1, now() + interval '1 hour')", [IA]));
    return nonAdmin === "42501" && /INVENTORY_MISMATCH/.test(stale?.message ?? "") && /NOTIFICATION_REFERENCE_REQUIRED/.test(noNotice?.message ?? "") && /ACTIVATION_PATH_REQUIRED/.test(noPath?.message ?? "") && direct === "42501"
      ? true : JSON.stringify({ nonAdmin, stale: stale?.message, noNotice: noNotice?.message, noPath: noPath?.message, direct });
  });
  await check("deployment approvals: no direct INSERT / UPDATE / DELETE for anon, authenticated or service_role; even the table owner cannot insert outside the function; the approver must be the calling, active commercial administrator (FK)", async () => {
    const inv = await inventory();
    const fp = (await admin.query("SELECT public._environment_fingerprint() f")).rows[0].f;
    const row = [fp, JSON.stringify(inv), IA];
    const insSql = "INSERT INTO public.deployment_approvals (purpose, environment_fingerprint, environment_label, evidence, approved_by, expires_at) VALUES ('FREE_PLAN_RETIREMENT',$1,'x',$2::jsonb,$3, now() + interval '1 hour')";
    const out = {
      anon: await codeOf(() => q(ANON, insSql, row)),
      admin_user: await codeOf(() => q(user(IA), insSql, row)),
      service: await codeOf(() => q(SERVICE, insSql, row)),
      owner: await codeOf(() => admin.query(insSql, row)),
      svcUpdate: await codeOf(() => q(SERVICE, "UPDATE public.deployment_approvals SET consumed_at=now(), consumed_by='x'")),
      svcDelete: await codeOf(() => q(SERVICE, "DELETE FROM public.deployment_approvals")),
      userUpdate: await codeOf(() => q(user(IA), "UPDATE public.deployment_approvals SET consumed_at=now(), consumed_by='x'")),
    };
    const nonAdmin = await mkUser("not-admin");
    const markForged = await codeOf(async () => { await admin.query("BEGIN"); try {
      await admin.query("SET LOCAL ROLE authenticated");
      await admin.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true), set_config('cfoclose.deployment_approval_writer', txid_current()::text, true)", [nonAdmin]);
      await admin.query(insSql, [fp, JSON.stringify(inv), nonAdmin]);
    } finally { await admin.query("ROLLBACK"); } });
    await admin.query("UPDATE public.commercial_admins SET active=false WHERE user_id=$1", [IA]);
    const inactive = await codeOf(() => q(user(IA), "SELECT public.admin_record_deployment_approval('FREE_PLAN_RETIREMENT','staging',$1,'notice-1','MANUAL_ADMIN')", [inv.open_free_licences]));
    await admin.query("UPDATE public.commercial_admins SET active=true WHERE user_id=$1", [IA]);
    const fk = (await admin.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='fk_da_approved_by'")).rows[0]?.d ?? "";
    const n = await count("SELECT count(*) n FROM public.deployment_approvals WHERE environment_label='x'");
    return Object.values(out).every((c) => c === "42501") && ["42501", "42501"].includes(markForged) && inactive === "42501" && fk.includes("REFERENCES commercial_admins(user_id)") && n === 0
      ? true : JSON.stringify({ out, markForged, inactive, fk, n });
  });
  let approvalId;
  await check(`${M130} applies over the legacy Free state with a recorded approval and consumes it (single use, audited by who / when / what)`, async () => {
    if (legacyFreeLicence?.status !== "ACTIVE") return `no legacy FREE licence: ${JSON.stringify(legacyFreeLicence)}`;
    const inv = await inventory();
    approvalId = (await one(user(IA), "SELECT public.admin_record_deployment_approval('FREE_PLAN_RETIREMENT','proof',$1,'customer notice CN-1','MANUAL_ADMIN',2) r", [inv.open_free_licences])).r.approval_id;
    await applyMigration(M130);
    for (const p of (await admin.query("SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname='public'")).rows) preCapabilityDefs[`${p.tablename}.${p.policyname}`] = p;
    const a = (await admin.query("SELECT approved_by, consumed_at, consumed_by, evidence FROM public.deployment_approvals WHERE id=$1", [approvalId])).rows[0];
    return a.approved_by === IA && a.consumed_at !== null && a.consumed_by === "20260925130000" && a.evidence.notification_reference === "customer notice CN-1"
      && a.evidence.activation_path === "MANUAL_ADMIN" ? true : JSON.stringify(a);
  });
  await check("the used approval cannot be replayed or edited, re-application is refused, and a zero-open-Free database needs no approval", async () => {
    const unconsume = await codeOf(() => admin.query("UPDATE public.deployment_approvals SET consumed_at=NULL, consumed_by=NULL WHERE id=$1", [approvalId]));
    const del = await codeOf(() => admin.query("DELETE FROM public.deployment_approvals WHERE id=$1", [approvalId]));
    const again = await errOf(() => applyMigration(M130));
    const zero = (await admin.query("SELECT public._free_retirement_approval_id() i")).rows[0].i;
    return unconsume === "42501" && del === "42501" && /already applied/.test(again?.message ?? "") && zero === "00000000-0000-0000-0000-000000000000"
      ? true : JSON.stringify({ unconsume, del, again: again?.message, zero });
  });
  await check(`${M140} and ${M150} (and every later migration) apply`, async () => { for (const f of files.slice(cut + 1)) await applyMigration(f); return true; });
  await check("a second application of 130000 and 140000 is refused at statement 1 and changes nothing (55000)", async () => {
    const before = await fingerprint();
    const out = [];
    for (const m of [M130, M140]) {
      const stmts = splitStatements(fs.readFileSync(path.join(REPO, "supabase/migrations", m), "utf8"));
      try { await admin.query(stmts[0]); out.push("applied"); } catch (e) { out.push(e.code); }
    }
    return JSON.stringify(out) === '["55000","55000"]' && (await fingerprint()) === before ? true : JSON.stringify(out);
  });
  await check("FREE -> EXPIRED_READ_ONLY deletes nothing: company, memberships, uploads, grants, tax records, issued outputs and their events are byte-identical; audit history is only appended to", async () => {
    const after = await snapshot(L.co);
    const same = ["co", "fm", "tb", "gr", "tl", "iss", "iev"].every((k) => JSON.stringify(after[k]) === JSON.stringify(legacyBefore[k]));
    const auditKept = legacyBefore.aud.every((row) => after.aud.some((x) => JSON.stringify(x) === JSON.stringify(row)));
    const appended = after.aud.filter((x) => !legacyBefore.aud.some((row) => JSON.stringify(row) === JSON.stringify(x))).map((x) => x.action);
    return same && auditKept && JSON.stringify(appended) === '["FREE_PLAN_RETIRED"]' ? true : JSON.stringify({ same, auditKept, appended });
  });
  await check("the migration grants NO plan: the converted account has no current licence and no paid (Solo or other) licence was created", async () => {
    const lic = (await admin.query(`SELECT cp.code, cl.status FROM public.commercial_licences cl JOIN public.billing_customers b ON b.id=cl.billing_customer_id
      JOIN public.commercial_plans cp ON cp.id=cl.plan_id WHERE b.owner_user_id=$1`, [L.holder])).rows;
    const current = (await admin.query("SELECT public._account_current_plan_code($1) c", [L.holder])).rows[0].c;
    const anyGranted = await count("SELECT count(*) n FROM public.commercial_licences cl JOIN public.commercial_plans cp ON cp.id=cl.plan_id WHERE cp.code <> 'FREE'");
    return JSON.stringify(lic) === '[{"code":"FREE","status":"EXPIRED"}]' && current === null && anyGranted === 0 ? true : JSON.stringify({ lic, current, anyGranted });
  });
  await check("the Free licence row is kept (same id), ended as EXPIRED, with exactly one FREE_PLAN_RETIRED audit event", async () => {
    const l = (await admin.query("SELECT status, effective_end FROM public.commercial_licences WHERE id=$1", [legacyFreeLicence.id])).rows[0];
    const ev = await count("SELECT count(*) n FROM public.billing_audit_events WHERE action='FREE_PLAN_RETIRED' AND (previous_state->>'licence_id')::uuid = $1", [legacyFreeLicence.id]);
    return l.status === "EXPIRED" && l.effective_end !== null && ev === 1 ? true : JSON.stringify({ l, ev });
  });

  group("Grant authority — can_user_act_on_workspace converges to service_role only; no cross-workspace oracle");
  const SIGS = ["public.can_user_act_on_workspace(uuid,uuid,text)", "public.workspace_authority_basis(uuid,uuid,text)"];
  await check("clean replay: EXECUTE on both predicates is exactly {owner, service_role}; anon and authenticated cannot execute", async () => {
    const rows = (await admin.query(`SELECT has_function_privilege('anon', s, 'EXECUTE') a, has_function_privilege('authenticated', s, 'EXECUTE') u,
      has_function_privilege('service_role', s, 'EXECUTE') s2 FROM unnest($1::text[]) s`, [SIGS])).rows;
    return rows.every((r) => !r.a && !r.u && r.s2) ? true : JSON.stringify(rows);
  });
  const cleanAcl = await aclOf(SIGS[0]);
  await check("already-upgraded replay: 20260925150000 applied again is idempotent (privileges and schema unchanged)", async () => {
    const before = await fingerprint();
    await applyMigration(M150);
    return (await fingerprint()) === before && (await aclOf(SIGS[0])) === cleanAcl ? true : "changed";
  });
  await check("the hosted history (journal entry 0006 left authenticated with EXECUTE) converges to the same privileges as a clean replay", async () => {
    await admin.query("GRANT EXECUTE ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) TO authenticated");
    await admin.query("GRANT EXECUTE ON FUNCTION public.workspace_authority_basis(uuid, uuid, text) TO PUBLIC");
    const drifted = await aclOf(SIGS[0]);
    await applyMigration(M150);
    return drifted !== cleanAcl && (await aclOf(SIGS[0])) === cleanAcl ? true : JSON.stringify({ drifted, cleanAcl, now: await aclOf(SIGS[0]) });
  });
  await check("the postcondition fails the migration if a grant slips back in (it can never leave an authenticated grant in place)", async () => {
    const text = fs.readFileSync(path.join(REPO, "supabase/migrations", M150), "utf8");
    const post = text.slice(text.indexOf("DO $post$"));
    await admin.query("BEGIN");
    try {
      await admin.query("GRANT EXECUTE ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) TO authenticated");
      const e = await errOf(() => admin.query(post));
      return e?.code === "55000" ? true : String(e?.code);
    } finally { await admin.query("ROLLBACK"); }
  });

  // ── Fixtures ──────────────────────────────────────────────────────────────────────────────
  const U = { admin: await mkUser("admin"), outsider: await mkUser("outsider") };
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [U.admin]);
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const planId = async (code) => (await admin.query("SELECT id FROM public.commercial_plans WHERE product_id=$1 AND code=$2", [product, code])).rows[0].id;
  const bcOf = async (uid) => (await admin.query("SELECT id FROM public.billing_customers WHERE owner_user_id=$1", [uid])).rows[0]?.id ?? null;
  const ensureBc = async (uid) => (await one(user(U.admin), "SELECT public.admin_ensure_billing_customer($1,'proof') r", [uid])).r.billing_customer_id;
  const grantPlan = async (uid, plan) => (await one(user(U.admin), "SELECT public.admin_grant_commercial_licence($1,$2,now() - interval '1 minute',NULL,'proof') r", [await ensureBc(uid), plan])).r.licence_id;
  const newCompany = (uid, name = "Co") => q(user(uid), "INSERT INTO public.companies (user_id,name) VALUES ($1,$2) RETURNING id", [uid, name]).then((r) => r[0].id);
  const ent = async (uid, cap) => (await admin.query("SELECT public._resolve_entitlement_for_owner($1,$2) r", [uid, cap])).rows[0].r;
  const caps = async (uid, co) => (await one(user(uid), "SELECT public.get_my_workspace_capabilities($1) r", [co])).r;
  const addTaxLoss = (uid, co) => codeOf(() => q(user(uid), "INSERT INTO public.tax_losses (company_id, created_by, period_year) VALUES ($1,$2,2026)", [co, uid]));
  const expire = (licId) => admin.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end = now() WHERE id=$1", [licId]);

  group("No permanent free plan — the catalogue");
  await check("public plans are exactly Solo $49/$490 (1 entity, 1 user, no seats), Practice $99/$990 (5), Firm $299/$2,990 (25) and Enterprise (negotiated); Free is retired", async () => {
    const plans = (await admin.query(`SELECT code, is_active, is_public, sales_mode, entity_capacity, included_seats, additional_seats_purchasable b FROM public.commercial_plans WHERE product_id=$1 ORDER BY display_order NULLS LAST, code`, [product])).rows;
    const pub = plans.filter((p) => p.is_public).map((p) => `${p.code}:${p.entity_capacity}:${p.included_seats}:${p.b}`);
    const offers = (await admin.query(`SELECT cp.code, o.billing_interval i, o.amount_minor a, o.is_purchasable p FROM public.commercial_offers o JOIN public.commercial_plans cp ON cp.id=o.plan_id WHERE o.is_active ORDER BY 1,2`)).rows.map((r) => `${r.code}:${r.i}:${r.a}:${r.p}`);
    const free = plans.find((p) => p.code === "FREE");
    return JSON.stringify(pub) === JSON.stringify(["SOLO:1:1:false", "PRACTICE:5:1:true", "FIRM:25:1:true", "ENTERPRISE:null:null:false"])
      && JSON.stringify(offers) === JSON.stringify(["FIRM:ANNUAL:299000:false", "FIRM:MONTHLY:29900:false", "PRACTICE:ANNUAL:99000:false", "PRACTICE:MONTHLY:9900:false", "SOLO:ANNUAL:49000:false", "SOLO:MONTHLY:4900:false"])
      && free.is_active === false && free.is_public === false && free.sales_mode === "retired" && plans.every((p) => p.sales_mode !== "free")
      ? true : JSON.stringify({ pub, offers, free });
  });
  await check("no plan can be offered free again, and a FREE licence cannot be granted", async () => {
    const c1 = await codeOf(() => admin.query("UPDATE public.commercial_plans SET sales_mode='free' WHERE code='SOLO'"));
    const legacyBc = await bcOf(L.holder);
    const c2 = (await errOf(() => one(user(U.admin), "SELECT public.admin_grant_commercial_licence($1,'FREE',now(),NULL,'x')", [legacyBc])))?.message ?? "";
    return c1 === "23514" && /UNKNOWN_OR_INACTIVE_PLAN_CODE/.test(c2) ? true : JSON.stringify({ c1, c2 });
  });
  await check("no permanent free entitlement: with no plan, EVERY capability (Close Assurance and Comparative Reporting included) is NOT_ENTITLED; a FREE licence is RETIRED_PLAN", async () => {
    const noPlan = await Promise.all(MATRIX_CAPS.map((c) => ent(L.holder, c)));
    const noBc = await ent(U.outsider, "CLOSE_ASSURANCE");
    // A FREE licence written directly (as an unreviewed import would) still entitles nothing.
    const direct = await mkUser("direct-free");
    const bc = await ensureBc(direct);
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start) VALUES ($1,$2,'ACTIVE','ADMIN_GRANT',now() - interval '1 day')", [bc, await planId("FREE")]);
    const directAns = await ent(direct, "COMPARATIVE_REPORTING");
    return noPlan.every((r) => r.status === "NOT_ENTITLED" && r.reason === "NO_CURRENT_PLAN") && noBc.status === "NOT_ENTITLED" && directAns.reason === "RETIRED_PLAN"
      ? true : JSON.stringify({ noPlan: noPlan.map((r) => r.reason), noBc, directAns });
  });
  await check("with no plan the account is read-only: existing data is readable, no entity can be added, no new operation is accepted, only the holder is active", async () => {
    const reads = (await q(user(L.holder), "SELECT id FROM public.companies WHERE id=$1", [L.co])).length === 1
      && (await q(user(L.holder), "SELECT id FROM public.tax_losses WHERE company_id=$1", [L.co])).length === 1
      && (await q(user(L.holder), "SELECT id FROM public.trial_balance_uploads WHERE company_id=$1", [L.co])).length === 1;
    const cap = (await admin.query("SELECT public._entity_capacity_for_account($1) c", [L.holder])).rows[0].c;
    const newCo = await codeOf(() => newCompany(L.holder, "Second"));
    const write = await addTaxLoss(L.holder, L.co);
    const upload = await codeOf(() => admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,2026)", [`${L.holder}/new.csv`, L.co, L.holder]));
    const seats = (await admin.query("SELECT public._seat_capacity_for_account($1) c", [L.holder])).rows[0].c;
    const myCaps = await caps(L.holder, L.co);
    return reads && cap.capacity === 0 && cap.plan_code === null && newCo === "PT402" && write === "42501" && upload === "PT402"
      && seats.allowed_named_users === 1 && seats.plan_code === null && myCaps.has_current_plan === false && myCaps.allowed.length === 1 && myCaps.allowed[0] === "manage_members"
      ? true : JSON.stringify({ reads, cap, newCo, write, upload, seats, myCaps });
  });
  await check("a new person with no plan cannot create an entity; creating a company no longer enrols anyone in a plan", async () => {
    const u = await mkUser("newcomer");
    const refused = await codeOf(() => newCompany(u));
    await ensureBc(u);
    const licences = await count("SELECT count(*) n FROM public.commercial_licences cl JOIN public.billing_customers b ON b.id=cl.billing_customer_id WHERE b.owner_user_id=$1", [u]);
    return refused === "PT402" && licences === 0 ? true : JSON.stringify({ refused, licences });
  });

  group("After FREE -> EXPIRED_READ_ONLY: only an explicit, audited administrator action records a plan");
  let soloLicence;
  await check("an administrator explicitly recording a plan (here Solo, audited LICENCE_GRANTED by that administrator) restores operation on the same entity with every record intact; members beyond one named user stay suspended", async () => {
    soloLicence = await grantPlan(L.holder, "SOLO");
    const granted = await count("SELECT count(*) n FROM public.billing_audit_events WHERE action='LICENCE_GRANTED' AND actor_user_id=$1 AND (new_state->>'licence_id')::uuid=$2", [U.admin, soloLicence]);
    if (granted !== 1) return `no audited administrator grant: ${granted}`;
    const all = await Promise.all(MATRIX_CAPS.map(async (c) => [c, (await ent(L.holder, c)).status]));
    const entitled = all.filter(([, s]) => s === "ENTITLED").map(([c]) => c);
    const write = await addTaxLoss(L.holder, L.co);
    const suspended = await count("SELECT count(*) n FROM public.named_user_billing_suspensions WHERE account_user_id=$1 AND lifted_at IS NULL", [L.holder]);
    const memberships = await count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1", [L.co]);
    const after = await snapshot(L.co);
    return JSON.stringify(entitled) === JSON.stringify(MATRIX_CAPS.filter((c) => c !== "MULTI_ENTITY_REPORTING" && c !== "CONSOLIDATION"))
      && write === "ok" && suspended === 2 && memberships === 3
      && JSON.stringify(after.co) === JSON.stringify(legacyBefore.co) && JSON.stringify(after.tb) === JSON.stringify(legacyBefore.tb)
      ? true : JSON.stringify({ entitled, write, suspended, memberships });
  });
  await check("Solo is one entity and one named user: a second entity is refused; no seat can be recorded; a malformed Solo quantity fails closed", async () => {
    const second = await codeOf(() => newCompany(L.holder, "Solo second"));
    const seat = (await errOf(() => one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,1,'x')", [soloLicence])))?.message ?? "";
    await admin.query("UPDATE public.commercial_licences SET additional_seats=2 WHERE id=$1", [soloLicence]);
    const malformed = (await admin.query("SELECT public._seat_capacity_for_account($1) c", [L.holder])).rows[0].c;
    await admin.query("UPDATE public.commercial_licences SET additional_seats=0 WHERE id=$1", [soloLicence]);
    return second === "PT402" && /SOLO_PLAN_HAS_NO_ADDITIONAL_SEATS/.test(seat) && malformed.determined === false ? true : JSON.stringify({ second, seat, malformed });
  });

  group("Entity and seat limits");
  await check("entity capacity: Practice 5 (the 6th refused), Firm 25 (the 26th refused)", async () => {
    const res = {};
    for (const [plan, cap] of [["PRACTICE", 5], ["FIRM", 25]]) {
      const u = await mkUser(plan); await grantPlan(u, plan);
      let made = 0; for (let i = 0; i < cap; i++) { await newCompany(u, `${plan} ${i}`); made++; }
      res[plan] = [made, await codeOf(() => newCompany(u, `${plan} over`))];
    }
    return JSON.stringify(res) === JSON.stringify({ PRACTICE: [5, "PT402"], FIRM: [25, "PT402"] }) ? true : JSON.stringify(res);
  });
  let pr;
  await check("named users: Practice with 2 purchased seats admits exactly 3 people; the 4th is refused by the seat wall", async () => {
    pr = { uid: await mkUser("pr-holder") };
    pr.lic = await grantPlan(pr.uid, "PRACTICE");
    await one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,2,'proof')", [pr.lic]);
    pr.co = await newCompany(pr.uid, "Practice Co");
    pr.a = await mkUser("pr-a"); pr.b = await mkUser("pr-b"); pr.c = await mkUser("pr-c");
    await q(user(pr.uid), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now())", [pr.co, pr.a]);
    await q(user(pr.uid), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'partner',now())", [pr.co, pr.b]);
    const fourth = await codeOf(() => q(user(pr.uid), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'viewer',now())", [pr.co, pr.c]));
    return fourth === "PT402" ? true : fourth;
  });

  group("Invitations — expiry and cancellation under concurrency");
  await check(`${CONCURRENCY} concurrent accept / cancel races on pending invitations: each ends in exactly one outcome, never both`, async () => {
    const u = await mkUser("inv-holder"); const lic = await grantPlan(u, "FIRM");
    await one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,$2,'proof')", [lic, CONCURRENCY]);
    const co = await newCompany(u, "Invite Co");
    const people = []; for (let i = 0; i < CONCURRENCY; i++) people.push(await mkUser("inv"));
    const ids = [];
    for (const p of people) ids.push((await q(user(u), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',NULL) RETURNING id", [co, p]))[0].id);
    await Promise.all(people.flatMap((p, i) => [
      one(user(p), "SELECT public.accept_workspace_invitations() r").catch(() => null),
      one(user(u), "SELECT public.cancel_workspace_invitation($1) r", [ids[i]]).catch(() => null),
    ]));
    const rows = (await admin.query("SELECT accepted_at, invitation_cancelled_at FROM public.firm_members WHERE id = ANY($1::uuid[])", [ids])).rows;
    const exactlyOne = rows.every((r) => (r.accepted_at !== null) !== (r.invitation_cancelled_at !== null));
    return rows.length === CONCURRENCY && exactlyOne ? true : JSON.stringify(rows);
  });
  await check("an expired invitation cannot be accepted and frees its seat; concurrent re-invitations reserve ONE row (never double)", async () => {
    const u = await mkUser("exp-holder"); const lic = await grantPlan(u, "PRACTICE");
    await one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,1,'proof')", [lic]);
    const co = await newCompany(u, "Expiry Co");
    const p = await mkUser("exp-person");
    const id = (await q(user(u), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',NULL) RETURNING id", [co, p]))[0].id;
    await admin.query("UPDATE public.firm_members SET invitation_expires_at = now() - interval '1 minute' WHERE id=$1", [id]);
    const acc = await one(user(p), "SELECT public.accept_workspace_invitations() r");
    const freed = (await one(user(u), "SELECT public.get_workspace_seat_capacity($1) r", [co])).r.reserved_named_users;
    const outcomes = await Promise.all(Array.from({ length: CONCURRENCY }, () =>
      one(SERVICE, "SELECT public.reserve_workspace_invitation($1,$2,'preparer',$3,'e@example.test') r", [co, p, u]).then((x) => x.r.outcome).catch((e) => e.code)));
    const rows = await count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [co, p]);
    const blocked = acc.r.blocked?.[0]?.code;
    return blocked === "INVITATION_EXPIRED" && freed === 1 && rows === 1 && outcomes.every((o) => ["reserved", "reissued", "refreshed"].includes(o))
      ? true : JSON.stringify({ blocked, freed, rows, outcomes });
  });

  group("Downgrade suspension and restoration");
  await check("Practice → Solo suspends everyone but the account holder (memberships kept); restoring Practice reactivates nobody until the holder chooses", async () => {
    await admin.query("UPDATE public.commercial_licences SET plan_id=$1, additional_seats=0 WHERE id=$2", [await planId("SOLO"), pr.lic]);
    const susp = await count("SELECT count(*) n FROM public.named_user_billing_suspensions WHERE account_user_id=$1 AND lifted_at IS NULL", [pr.uid]);
    const members = await count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1", [pr.co]);
    const deniedRead = (await caps(pr.a, pr.co)).access ? 1 : 0;
    await admin.query("UPDATE public.commercial_licences SET plan_id=$1, additional_seats=2 WHERE id=$2", [await planId("PRACTICE"), pr.lic]);
    const stillSusp = await count("SELECT count(*) n FROM public.named_user_billing_suspensions WHERE account_user_id=$1 AND lifted_at IS NULL", [pr.uid]);
    const r = (await one(user(pr.uid), "SELECT public.get_named_user_roster() r")).r;
    const chosen = (await one(user(pr.uid), "SELECT public.choose_active_named_users($1::uuid[],$2) r", [[pr.a, pr.b], r.roster_version])).r;
    const back = (await caps(pr.a, pr.co)).access ? 1 : 0;
    return susp === 2 && members === 3 && deniedRead === 0 && stillSusp === 2 && chosen.outcome === "applied" && back === 1
      ? true : JSON.stringify({ susp, members, deniedRead, stillSusp, chosen, back });
  });

  group("Capabilities — never a job title");
  await check("backfill: every existing membership holds exactly its title's template, nothing more", async () => {
    const rows = (await admin.query(`SELECT fm.role, array_agg(c.capability ORDER BY c.capability) caps FROM public.firm_members fm
      JOIN public.workspace_member_capabilities c ON c.company_id=fm.company_id AND c.user_id=fm.user_id AND c.revoked_at IS NULL
      WHERE fm.company_id=$1 GROUP BY fm.user_id, fm.role`, [L.co])).rows;
    return rows.length === 3 && rows.every((r) => JSON.stringify(r.caps) === JSON.stringify(TEMPLATE[r.role])) ? true : JSON.stringify(rows);
  });
  await check("a 'viewer' title granted prepare_close can prepare; withdrawn, it cannot — the title never changed", async () => {
    const v = await mkUser("pr-viewer");
    // Room for one more person: Practice with a third purchased seat.
    await one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,3,'proof')", [pr.lic]);
    await q(user(pr.uid), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'viewer',now())", [pr.co, v]);
    const before = await addTaxLoss(v, pr.co);
    const g = (await one(user(pr.uid), "SELECT public.grant_member_capability($1,$2,'prepare_close','proof') r", [pr.co, v])).r.outcome;
    const granted = await addTaxLoss(v, pr.co);
    const rv = (await one(user(pr.uid), "SELECT public.revoke_member_capability($1,$2,'prepare_close','proof') r", [pr.co, v])).r.outcome;
    const after = await addTaxLoss(v, pr.co);
    return before === "42501" && g === "granted" && granted === "ok" && rv === "revoked" && after === "42501" ? true : JSON.stringify({ before, g, granted, rv, after });
  });
  await check("a 'partner' title without its capabilities cannot prepare, review, or choose services", async () => {
    for (const c of ["prepare_close", "review_close", "approve_certification"]) await one(user(pr.uid), "SELECT public.revoke_member_capability($1,$2,$3,'proof')", [pr.co, pr.b, c]);
    const write = await addTaxLoss(pr.b, pr.co);
    const scope = await codeOf(() => q(user(pr.b), "SELECT public.open_engagement_with_scope($1,2026,ARRAY['FINANCIAL_STATEMENTS'],'composite')", [pr.co]));
    const mine = await caps(pr.b, pr.co);
    return write === "42501" && scope === "42501" && JSON.stringify(mine.capabilities) === '["issue_reporting_pack"]' ? true : JSON.stringify({ write, scope, mine });
  });
  await check("a title change never adds a capability (it can only narrow); explicit grants are kept", async () => {
    await one(user(pr.uid), "SELECT public.grant_member_capability($1,$2,'review_close','explicit') r", [pr.co, pr.a]);
    await q(user(pr.uid), "UPDATE public.firm_members SET role='viewer' WHERE company_id=$1 AND user_id=$2", [pr.co, pr.a]);
    const held = (await caps(pr.a, pr.co)).capabilities;
    return JSON.stringify(held) === '["issue_reporting_pack","review_close"]' ? true : JSON.stringify(held);
  });
  await check("managing capabilities: only manage_members may grant; manage_members itself is not grantable; the account holder cannot be stripped", async () => {
    const byMember = (await one(user(pr.a), "SELECT public.grant_member_capability($1,$2,'prepare_close','x') r", [pr.co, pr.a])).r.outcome;
    const mm = (await one(user(pr.uid), "SELECT public.grant_member_capability($1,$2,'manage_members','x') r", [pr.co, pr.a])).r.outcome;
    const holder = (await one(user(pr.uid), "SELECT public.revoke_member_capability($1,$2,'prepare_close','x') r", [pr.co, pr.uid])).r.outcome;
    const outsider = (await one(user(U.outsider), "SELECT public.grant_member_capability($1,$2,'prepare_close','x') r", [pr.co, U.outsider])).r.outcome;
    return byMember === "forbidden" && mm === "invalid_capability" && holder === "account_holder_locked" && outsider === "forbidden"
      ? true : JSON.stringify({ byMember, mm, holder, outsider });
  });
  await check("capability rows are append-only (no delete, no edit, no un-revoke), even for the service role", async () => {
    const id = (await admin.query("SELECT id FROM public.workspace_member_capabilities WHERE revoked_at IS NOT NULL LIMIT 1")).rows[0].id;
    const del = await codeOf(() => admin.query("DELETE FROM public.workspace_member_capabilities WHERE id=$1", [id]));
    const unrevoke = await codeOf(() => admin.query("UPDATE public.workspace_member_capabilities SET revoked_at=NULL, revoke_reason=NULL, revoked_by=NULL WHERE id=$1", [id]));
    const svcIns = await codeOf(() => q(SERVICE, "INSERT INTO public.workspace_member_capabilities (company_id,user_id,capability,source) VALUES ($1,$2,'prepare_close','EXPLICIT_GRANT')", [pr.co, U.outsider]));
    const clientIns = await codeOf(() => q(user(pr.uid), "INSERT INTO public.workspace_member_capabilities (company_id,user_id,capability,source) VALUES ($1,$2,'prepare_close','EXPLICIT_GRANT')", [pr.co, U.outsider]));
    return del === "42501" && unrevoke === "42501" && svcIns === "42501" && clientIns === "42501" ? true : JSON.stringify({ del, unrevoke, svcIns, clientIns });
  });
  await check("no cross-workspace oracle: another person's capability, an unknown workspace and a foreign workspace all answer exactly like an outsider", async () => {
    const other = (await one(user(U.outsider), "SELECT public.has_workspace_capability($1,$2,'prepare_close') r", [pr.co, pr.uid])).r;
    const unknownWs = (await one(user(U.outsider), "SELECT public.get_my_workspace_capabilities($1) r", [uuid()])).r;
    const foreignWs = (await one(user(U.outsider), "SELECT public.get_my_workspace_capabilities($1) r", [pr.co])).r;
    const pred = await codeOf(() => q(user(U.outsider), "SELECT public.can_user_act_on_workspace($1,$2,'manage_source_files')", [pr.uid, pr.co]));
    const basis = await codeOf(() => q(user(U.outsider), "SELECT public.workspace_authority_basis($1,$2,'manage_source_files')", [pr.uid, pr.co]));
    return other === false && JSON.stringify(unknownWs) === JSON.stringify(foreignWs) && foreignWs.access === false && pred === "42501" && basis === "42501"
      ? true : JSON.stringify({ other, unknownWs, foreignWs, pred, basis });
  });
  await check("no RLS policy and no authority function reads a job title (only the owner-title integrity guards remain)", async () => {
    const pols = (await admin.query(`SELECT tablename||'.'||policyname p FROM pg_policies WHERE schemaname IN ('public','storage')
      AND (coalesce(qual,'')||coalesce(with_check,'')) ~ '\\mrole\\M' ORDER BY 1`)).rows.map((r) => r.p);
    const fns = (await admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
      AND pg_get_functiondef(p.oid) ~ '(fm|firm_members)\\.role\\s*(=|<>|NOT IN\\s*\\(|IN\\s*\\()|v_role\\s*(NOT )?IN\\s*\\(|role\\s*<>\\s*''viewer''' ORDER BY 1`)).rows.map((r) => r.proname);
    const integrity = ["firm_members.firm_members_delete_self_resign", "firm_members.firm_members_insert", "firm_members.firm_members_insert_restrictive", "firm_members.firm_members_update_by_owner"];
    return JSON.stringify(pols) === JSON.stringify(integrity) && JSON.stringify(fns) === '["financial_statements_workspace_access"]' ? true : JSON.stringify({ pols, fns });
  });
  await check("each of the 30 redefined policies equals its previous definition with the title predicate replaced by a capability predicate on the same member row", async () => {
    const IGN = new Set(["manager", "reviewer", "approver"]);
    const FINAL = new Set(["aje_update_partner_owner", "sso_update_partner_owner"]);
    const bad = []; let n = 0;
    for (const [key, old] of Object.entries(preCapabilityDefs)) {
      if (!/'(partner|manager|preparer|viewer)'/.test((old.qual ?? "") + (old.with_check ?? ""))) continue;
      n++;
      const cmd = (await admin.query("SELECT cmd FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND policyname=$2", [old.tablename, old.policyname])).rows[0].cmd;
      const tx = (e) => e == null ? null : e.replace(/\((fm|firm_members)\.role = ANY \(ARRAY\[([^\]]*)\]\)\)/g, (_m, a, list) => {
        const roles = [...list.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]).filter((r) => !IGN.has(r)).sort().join(",");
        const f = cmd === "SELECT" ? "has_workspace_capability" : "workspace_capability_allowed";
        const call = (c, fn = f) => `${fn}(${a}.company_id, ${a}.user_id, '${c}'::text)`;
        // The deparser drops the parentheses around a lone function call.
        if (roles === "owner,partner") return call(FINAL.has(old.policyname) ? "approve_certification" : "review_close");
        if (roles === "owner,partner,preparer") return call("prepare_close");
        if (roles === "preparer") return `(${call("prepare_close")} AND (NOT ${call("approve_certification", "has_workspace_capability")}))`;
        return "UNMAPPED";
      });
      const now = (await admin.query("SELECT qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND policyname=$2", [old.tablename, old.policyname])).rows[0];
      if (tx(old.qual) !== now.qual || tx(old.with_check) !== now.with_check) bad.push(bad.length === 0 ? { key, want: tx(old.qual) ?? tx(old.with_check), got: now.qual ?? now.with_check } : key);
    }
    return n === 30 && bad.length === 0 ? true : JSON.stringify({ n, bad });
  });

  group("Invitation acceptance — no self-escalation, no second owner, no capability resurrection (B-1)");
  const IV = { holder: await mkUser("iv-holder") };
  IV.lic = await grantPlan(IV.holder, "FIRM");
  await one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,20,'proof')", [IV.lic]);
  IV.co = await newCompany(IV.holder, "Invitation Co");
  const invitePending = async (who, role = "viewer") => (await q(user(IV.holder), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,NULL) RETURNING id", [IV.co, who, role]))[0].id;
  const memberRow = async (who) => (await admin.query("SELECT to_jsonb(f) - 'updated_at' j FROM public.firm_members f WHERE company_id=$1 AND user_id=$2", [IV.co, who])).rows[0]?.j ?? null;
  const capsOf = async (who, co = IV.co) => (await admin.query("SELECT coalesce(array_agg(capability ORDER BY capability), '{}') c FROM public.workspace_member_capabilities WHERE company_id=$1 AND user_id=$2 AND revoked_at IS NULL", [co, who])).rows[0].c;
  const ownersOf = () => count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1 AND role='owner'", [IV.co]);
  await check("an invitee cannot make themselves owner or partner, re-point, re-date or re-attribute the invitation: every crafted UPDATE fails and changes nothing", async () => {
    const v = await mkUser("iv-viewer"); await invitePending(v, "viewer");
    const before = { row: await memberRow(v), caps: await capsOf(v), owners: await ownersOf() };
    const attempts = {
      owner: await codeOf(() => q(user(v), "UPDATE public.firm_members SET role='owner', accepted_at=now() WHERE company_id=$1 AND user_id=$2", [IV.co, v])),
      partner: await codeOf(() => q(user(v), "UPDATE public.firm_members SET role='partner', accepted_at=now() WHERE company_id=$1 AND user_id=$2", [IV.co, v])),
      expiry: await codeOf(() => q(user(v), "UPDATE public.firm_members SET accepted_at=now(), invitation_expires_at=now() + interval '10 years' WHERE company_id=$1 AND user_id=$2", [IV.co, v])),
      inviter: await codeOf(() => q(user(v), "UPDATE public.firm_members SET accepted_at=now(), invited_by=$3 WHERE company_id=$1 AND user_id=$2", [IV.co, v, v])),
      repoint: await codeOf(() => q(user(v), "UPDATE public.firm_members SET company_id=$3 WHERE company_id=$1 AND user_id=$2", [IV.co, v, pr.co])),
    };
    const after = { row: await memberRow(v), caps: await capsOf(v), owners: await ownersOf() };
    return Object.values(attempts).every((c) => c === "42501") && JSON.stringify(after) === JSON.stringify(before) && after.owners === 1
      ? true : JSON.stringify({ attempts, same: JSON.stringify(after) === JSON.stringify(before) });
  });
  await check("acceptance changes only the acceptance: title and capabilities stay those the inviter chose", async () => {
    const v = await mkUser("iv-accept"); await invitePending(v, "viewer");
    const before = await memberRow(v);
    const acc = (await one(user(v), "SELECT public.accept_workspace_invitations() r")).r;
    const after = await memberRow(v);
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    return acc.accepted.length === 1 && JSON.stringify(changed) === '["accepted_at"]' && after.role === "viewer" && JSON.stringify(await capsOf(v)) === '["issue_reporting_pack"]'
      ? true : JSON.stringify({ acc, changed, caps: await capsOf(v) });
  });
  await check("duplicate and concurrent acceptance: exactly one acceptance, a repeat changes nothing", async () => {
    const v = await mkUser("iv-concurrent"); await invitePending(v, "preparer");
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => one(user(v), "SELECT public.accept_workspace_invitations() r").then((x) => x.r.accepted.length, (e) => e.code)));
    const row = await memberRow(v);
    const again = (await one(user(v), "SELECT public.accept_workspace_invitations() r")).r;
    const direct = await codeOf(() => q(user(v), "UPDATE public.firm_members SET accepted_at=now() WHERE company_id=$1 AND user_id=$2 RETURNING id", [IV.co, v]).then((r) => { if (r.length) throw Object.assign(new Error("changed"), { code: "CHANGED" }); }));
    return out.filter((n) => n === 1).length === 1 && out.every((n) => n === 0 || n === 1) && again.accepted.length === 0
      && JSON.stringify(await memberRow(v)) === JSON.stringify(row) && direct !== "CHANGED" ? true : JSON.stringify({ out, again, direct });
  });
  await check("nobody can create a second billing owner: not the account holder, not the service role, not an invitation", async () => {
    const m = await mkUser("iv-member"); await q(user(IV.holder), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'partner',now())", [IV.co, m]);
    const holder = await codeOf(() => q(user(IV.holder), "UPDATE public.firm_members SET role='owner' WHERE company_id=$1 AND user_id=$2", [IV.co, m]));
    const svc = await codeOf(() => q(SERVICE, "UPDATE public.firm_members SET role='owner' WHERE company_id=$1 AND user_id=$2", [IV.co, m]));
    const newcomer = await mkUser("iv-o");
    const invite = await codeOf(() => q(user(IV.holder), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'owner',NULL)", [IV.co, newcomer]));
    return holder === "42501" && svc === "42501" && ["42501", "P0001"].includes(invite) && (await ownersOf()) === 1 ? true : JSON.stringify({ holder, svc, invite, owners: await ownersOf() });
  });
  await check("a cancelled or expired invitation cannot be accepted, and the failed acceptance changes nothing", async () => {
    const c = await mkUser("iv-cancel"); const cid = await invitePending(c, "viewer");
    await one(user(IV.holder), "SELECT public.cancel_workspace_invitation($1)", [cid]);
    const e = await mkUser("iv-expired"); await invitePending(e, "viewer");
    await admin.query("UPDATE public.firm_members SET invitation_expires_at = now() - interval '1 minute' WHERE company_id=$1 AND user_id=$2", [IV.co, e]);
    const before = [await memberRow(c), await memberRow(e)];
    const rc = (await one(user(c), "SELECT public.accept_workspace_invitations() r")).r;
    const re = (await one(user(e), "SELECT public.accept_workspace_invitations() r")).r;
    return rc.blocked[0]?.code === "INVITATION_CANCELLED" && re.blocked[0]?.code === "INVITATION_EXPIRED" && rc.accepted.length === 0 && re.accepted.length === 0
      && JSON.stringify([await memberRow(c), await memberRow(e)]) === JSON.stringify(before) ? true : JSON.stringify({ rc, re });
  });
  await check("a revoked capability stays revoked through a no-op title save, a real title change, an invitation refresh, acceptance, and suspension / reactivation", async () => {
    const m = await mkUser("iv-revoked"); await q(user(IV.holder), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now())", [IV.co, m]);
    await one(user(IV.holder), "SELECT public.revoke_member_capability($1,$2,'prepare_close','proof')", [IV.co, m]);
    const steps = {};
    await q(user(IV.holder), "UPDATE public.firm_members SET role=role WHERE company_id=$1 AND user_id=$2", [IV.co, m]); steps.noop = await capsOf(m);
    await q(user(IV.holder), "UPDATE public.firm_members SET role='partner' WHERE company_id=$1 AND user_id=$2", [IV.co, m]); steps.retitle = await capsOf(m);
    const p = await mkUser("iv-pending"); await invitePending(p, "preparer");
    await one(user(IV.holder), "SELECT public.revoke_member_capability($1,$2,'prepare_close','proof')", [IV.co, p]);
    await one(SERVICE, "SELECT public.reserve_workspace_invitation($1,$2,'partner',$3,'p@example.test') r", [IV.co, p, IV.holder]); steps.refresh = await capsOf(p);
    await one(user(p), "SELECT public.accept_workspace_invitations()"); steps.accept = await capsOf(p);
    await admin.query("UPDATE public.commercial_licences SET plan_id=$1, additional_seats=0 WHERE id=$2", [await planId("SOLO"), IV.lic]);
    await admin.query("UPDATE public.commercial_licences SET plan_id=$1, additional_seats=20 WHERE id=$2", [await planId("FIRM"), IV.lic]);
    const roster = (await one(user(IV.holder), "SELECT public.get_named_user_roster() r")).r;
    await one(user(IV.holder), "SELECT public.choose_active_named_users($1::uuid[],$2)", [roster.people.filter((x) => x.state !== "pending").map((x) => x.user_id).filter((id) => id !== IV.holder), roster.roster_version]);
    steps.reactivated = await capsOf(m);
    const ok = JSON.stringify(steps.noop) === '["issue_reporting_pack"]' && JSON.stringify(steps.retitle) === '["issue_reporting_pack"]'
      && JSON.stringify(steps.refresh) === '["issue_reporting_pack"]' && JSON.stringify(steps.accept) === '["issue_reporting_pack"]'
      && JSON.stringify(steps.reactivated) === '["issue_reporting_pack"]';
    return ok ? true : JSON.stringify(steps);
  });

  group("Active accepted membership — no capability before acceptance, after cancellation or expiry, or while suspended (N-2)");
  const NV = { holder: await mkUser("nv-holder") };
  NV.lic = await grantPlan(NV.holder, "FIRM");
  await one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,40,'proof')", [NV.lic]);
  NV.co = await newCompany(NV.holder, "Membership Co");
  const nvInvite = async (who, role) => (await q(user(NV.holder), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,NULL) RETURNING id", [NV.co, who, role]))[0].id;
  const nvAccepted = async (who, role) => q(user(NV.holder), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [NV.co, who, role]);
  const nvCaps = async (who) => (await admin.query("SELECT coalesce(array_agg(capability ORDER BY capability), '{}') c FROM public.workspace_member_capabilities WHERE company_id=$1 AND user_id=$2 AND revoked_at IS NULL", [NV.co, who])).rows[0].c;
  const usable = async (who) => { const out = []; for (const c of CAPS) if ((await one(user(who), "SELECT public.has_workspace_capability($1,$2,$3) r", [NV.co, who, c])).r) out.push(c); return out; };
  // Controls (accepted, active) and every inactive state, for both a partner and a preparer title.
  const S = { partner: await mkUser("nv-partner"), preparer: await mkUser("nv-preparer") };
  await nvAccepted(S.partner, "partner"); await nvAccepted(S.preparer, "preparer");
  const INACTIVE = {};
  for (const role of ["partner", "preparer"]) {
    INACTIVE[`pending ${role}`] = await mkUser(`nv-pending-${role}`); await nvInvite(INACTIVE[`pending ${role}`], role);
    INACTIVE[`expired ${role}`] = await mkUser(`nv-expired-${role}`); await nvInvite(INACTIVE[`expired ${role}`], role);
    await admin.query("UPDATE public.firm_members SET invitation_expires_at = now() - interval '1 minute' WHERE company_id=$1 AND user_id=$2", [NV.co, INACTIVE[`expired ${role}`]]);
    INACTIVE[`cancelled ${role}`] = await mkUser(`nv-cancelled-${role}`);
    await one(user(NV.holder), "SELECT public.cancel_workspace_invitation($1)", [await nvInvite(INACTIVE[`cancelled ${role}`], role)]);
    INACTIVE[`suspended ${role}`] = await mkUser(`nv-suspended-${role}`); await nvAccepted(INACTIVE[`suspended ${role}`], role);
    await admin.query("INSERT INTO public.named_user_billing_suspensions (account_user_id, user_id, reason) VALUES ($1,$2,'OWNER_SELECTION')", [NV.holder, INACTIVE[`suspended ${role}`]]);
    INACTIVE[`revoked ${role}`] = await mkUser(`nv-revoked-${role}`); await nvAccepted(INACTIVE[`revoked ${role}`], role);
    for (const c of TEMPLATE[role]) await one(user(NV.holder), "SELECT public.revoke_member_capability($1,$2,$3,'proof')", [NV.co, INACTIVE[`revoked ${role}`], c]);
    INACTIVE[`removed ${role}`] = await mkUser(`nv-removed-${role}`); await nvAccepted(INACTIVE[`removed ${role}`], role);
    await q(user(NV.holder), "DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [NV.co, INACTIVE[`removed ${role}`]]);
  }
  // A real upload and journal entry, so policies that join through a parent row are evaluated against real data.
  NV.upload = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,2025) RETURNING id", [`${NV.holder}/nv.csv`, NV.co, NV.holder])).rows[0].id;
  await admin.query("BEGIN"); await admin.query("SET LOCAL session_replication_role = replica");
  NV.aje = (await admin.query("INSERT INTO public.adjusting_journal_entries (company_id, upload_id, period_year, aje_number, description, aje_type, created_by) VALUES ($1,$2,2025,'AJE-M001','proof','accrual',$3) RETURNING id", [NV.co, NV.upload, NV.holder])).rows[0].id;
  await admin.query("INSERT INTO public.tax_losses (company_id, created_by, period_year) VALUES ($1,$2,2025)", [NV.co, NV.holder]);
  await admin.query("COMMIT");
  const nvState = async () => (await admin.query(`SELECT
      (SELECT coalesce(jsonb_agg(to_jsonb(f) - 'updated_at' ORDER BY f.id), '[]') FROM public.firm_members f WHERE f.company_id=$1) fm,
      (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]') FROM public.workspace_member_capabilities c WHERE c.company_id=$1) caps,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM public.tax_losses t WHERE t.company_id=$1) tl,
      (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id), '[]') FROM public.adjusting_journal_entries a WHERE a.company_id=$1) aje,
      (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]') FROM public.named_user_billing_suspensions s WHERE s.account_user_id=$2) sus`, [NV.co, NV.holder])).rows[0];

  await check("the central authority: every capability is unusable in every inactive state (pending, expired, cancelled, suspended, revoked, removed), usable for the accepted controls", async () => {
    const bad = {};
    for (const [label, who] of Object.entries(INACTIVE)) { const u = await usable(who); if (u.length) bad[label] = u; }
    const partner = await usable(S.partner); const preparer = await usable(S.preparer);
    const allowed = (await one(user(INACTIVE["pending partner"]), "SELECT public.workspace_capability_allowed($1,$2,'prepare_close') r", [NV.co, INACTIVE["pending partner"]])).r;
    const mine = (await caps(INACTIVE["pending partner"], NV.co)).capabilities;
    return Object.keys(bad).length === 0 && allowed === false && JSON.stringify(mine) === "[]"
      && JSON.stringify(partner) === JSON.stringify(CAPS.filter((c) => TEMPLATE.partner.includes(c))) && JSON.stringify(preparer) === JSON.stringify(CAPS.filter((c) => TEMPLATE.preparer.includes(c)))
      ? true : JSON.stringify({ bad, allowed, mine, partner, preparer });
  });
  let sweptPolicies = 0;
  await check("EVERY capability-backed RLS policy (each USING and WITH CHECK), evaluated for a row of this workspace: true for an accepted control, false for every inactive state", async () => {
    const pols = (await admin.query(`SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname='public'
      AND (coalesce(qual,'')||coalesce(with_check,'')) ~ '(has_workspace_capability|workspace_capability_allowed)' ORDER BY 1,2`)).rows;
    const before = await nvState();
    const failures = []; let exprs = 0;
    for (const p of pols) {
      for (const [kind, expr] of [["USING", p.qual], ["WITH CHECK", p.with_check]]) {
        // An expression without a capability predicate (engagements' status WITH CHECK is membership-only) is gated by
        // the policy's USING, which is evaluated here; every policy must have at least one gated expression.
        if (!expr || !/(has_workspace_capability|workspace_capability_allowed)/.test(expr)) continue;
        exprs++;
        const evalFor = async (who) => {
          // The row as the caller would write / read it: this workspace, created by the caller, submitted by someone else.
          const memberId = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [NV.co, who])).rows[0]?.id ?? null;
          const row = { company_id: NV.co, created_by: who, created_by_member_id: memberId, user_id: NV.holder, status: "draft", aje_id: NV.aje, upload_id: NV.upload, period_year: 2025, submitted_by: NV.holder };
          const r = await one(user(who), `SELECT (${expr}) AS ok FROM jsonb_populate_record(NULL::public.${p.tablename}, $1::jsonb) AS ${p.tablename}`, [JSON.stringify(row)]);
          return r.ok === true;
        };
        const controls = [NV.holder, S.partner, S.preparer];
        const ctl = []; for (const c of controls) ctl.push(await evalFor(c));
        const leaks = []; for (const [label, who] of Object.entries(INACTIVE)) if (await evalFor(who)) leaks.push(label);
        if (!ctl.some(Boolean) || leaks.length) failures.push({ policy: `${p.tablename}.${p.policyname}`, kind, control: ctl, leaks });
      }
    }
    sweptPolicies = pols.length;
    const same = JSON.stringify(await nvState()) === JSON.stringify(before);
    return pols.length >= 30 && failures.length === 0 && same ? true : JSON.stringify({ policies: pols.length, exprs, same, failures: failures.slice(0, 6), more: Math.max(0, failures.length - 6) });
  });
  await check("refused operations by a never-accepted invitee (write, read, sign-off, capability management, Reporting Pack issue) leave the database byte-identical", async () => {
    const v = INACTIVE["pending partner"];
    const before = await nvState();
    const write = await addTaxLoss(v, NV.co);
    const read = (await q(user(v), "SELECT id FROM public.tax_losses WHERE company_id=$1", [NV.co])).length;
    const aje = (await q(user(v), "SELECT id FROM public.adjusting_journal_entries WHERE company_id=$1", [NV.co])).length;
    const upd = (await q(user(v), "UPDATE public.adjusting_journal_entries SET description='x' WHERE id=$1 RETURNING id", [NV.aje])).length;
    const grant = (await one(user(v), "SELECT public.grant_member_capability($1,$2,'review_close','x') r", [NV.co, v])).r.outcome;
    const issue = (await one(user(v), "SELECT public.issue_reporting_pack($1,2025,'financial_statements_data',$2,$3) r", [NV.co, `upload:${NV.upload}`, uuid()])).r.outcome;
    const same = JSON.stringify(await nvState()) === JSON.stringify(before);
    return write === "42501" && read === 0 && aje === 0 && upd === 0 && grant === "forbidden" && ["workspace_access_denied", "capability_required"].includes(issue) && same
      ? true : JSON.stringify({ write, read, aje, upd, grant, issue, same });
  });
  await check("acceptance activates exactly the capabilities the inviter chose, and nothing else", async () => {
    const v = await mkUser("nv-accept"); await nvInvite(v, "preparer");
    const pending = await usable(v);
    await one(user(v), "SELECT public.accept_workspace_invitations()");
    const active = await usable(v);
    return JSON.stringify(pending) === "[]" && JSON.stringify(active) === JSON.stringify(CAPS.filter((c) => TEMPLATE.preparer.includes(c))) && (await addTaxLoss(v, NV.co)) === "ok"
      ? true : JSON.stringify({ pending, active });
  });
  await check("concurrent acceptance: exactly one acceptance, capabilities activated once", async () => {
    const v = await mkUser("nv-concurrent"); await nvInvite(v, "partner");
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => one(user(v), "SELECT public.accept_workspace_invitations() r").then((x) => x.r.accepted.length, (e) => e.code)));
    const rows = await count("SELECT count(*) n FROM public.workspace_member_capabilities WHERE company_id=$1 AND user_id=$2 AND revoked_at IS NULL", [NV.co, v]);
    return out.filter((n) => n === 1).length === 1 && out.every((n) => n === 0 || n === 1) && rows === TEMPLATE.partner.length
      && JSON.stringify(await usable(v)) === JSON.stringify(CAPS.filter((c) => TEMPLATE.partner.includes(c))) ? true : JSON.stringify({ out, rows });
  });
  await check("cancelling during acceptance (12 races): either accepted and usable, or cancelled with nothing usable — never a cancelled person with a usable capability", async () => {
    const outcomes = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const v = await mkUser(`nv-race-${i}`); const id = await nvInvite(v, "partner");
      await Promise.all([
        one(user(v), "SELECT public.accept_workspace_invitations()").catch(() => null),
        one(user(NV.holder), "SELECT public.cancel_workspace_invitation($1)", [id]).catch(() => null),
      ]);
      const row = (await admin.query("SELECT accepted_at, invitation_cancelled_at FROM public.firm_members WHERE id=$1", [id])).rows[0];
      const u = await usable(v);
      const ok = (row.accepted_at && !row.invitation_cancelled_at && u.length === TEMPLATE.partner.length) || (!row.accepted_at && row.invitation_cancelled_at && u.length === 0);
      outcomes.push(ok ? (row.accepted_at ? "accepted" : "cancelled") : { row, u });
    }
    return outcomes.every((o) => typeof o === "string") ? true : JSON.stringify(outcomes);
  });
  await check("revocation racing a capability-backed write (12 rounds): each write either committed before the revoke or was refused, and the capability is never usable afterwards", async () => {
    const out = [];
    for (let k = 0; k < CONCURRENCY; k++) {
      const m = await mkUser(`nv-rev-${k}`); await nvAccepted(m, "preparer");
      // A period of its own per round, so the write can genuinely commit when it wins the race (no key collision).
      const [w, rv] = await Promise.all([
        codeOf(() => q(user(m), "INSERT INTO public.tax_losses (company_id, created_by, period_year) VALUES ($1,$2,$3)", [NV.co, m, 2040 + k])),
        one(user(NV.holder), "SELECT public.revoke_member_capability($1,$2,'prepare_close','race') r", [NV.co, m]).then((x) => x.r.outcome),
      ]);
      const after = await usable(m);
      const again = await addTaxLoss(m, NV.co);
      out.push(["ok", "42501"].includes(w) && rv === "revoked" && !after.includes("prepare_close") && again === "42501" ? w : { w, rv, after, again });
    }
    return out.every((o) => typeof o === "string") ? true : JSON.stringify(out);
  });
  await check("re-invitation after cancellation does not resurrect an explicitly revoked capability; a title change adds none", async () => {
    const v = await mkUser("nv-reinvite"); const id = await nvInvite(v, "partner");
    await one(user(NV.holder), "SELECT public.revoke_member_capability($1,$2,'approve_certification','proof')", [NV.co, v]);
    await one(user(NV.holder), "SELECT public.cancel_workspace_invitation($1)", [id]);
    const whileCancelled = await usable(v);
    await one(SERVICE, "SELECT public.reserve_workspace_invitation($1,$2,'partner',$3,'r@example.test') r", [NV.co, v, NV.holder]);
    const reinvited = await usable(v);
    await one(user(v), "SELECT public.accept_workspace_invitations()");
    const accepted = await usable(v);
    await q(user(NV.holder), "UPDATE public.firm_members SET role='preparer' WHERE company_id=$1 AND user_id=$2", [NV.co, v]);
    await q(user(NV.holder), "UPDATE public.firm_members SET role='partner' WHERE company_id=$1 AND user_id=$2", [NV.co, v]);
    const retitled = await usable(v);
    return JSON.stringify(whileCancelled) === "[]" && JSON.stringify(reinvited) === "[]" && !accepted.includes("approve_certification")
      && JSON.stringify(accepted) === '["prepare_close","review_close","issue_reporting_pack"]' && !retitled.includes("approve_certification") && !retitled.includes("review_close")
      ? true : JSON.stringify({ whileCancelled, reinvited, accepted, retitled });
  });
  await check("an explicit workspace grant (no membership) confers no workspace capability; only an active, accepted membership does", async () => {
    const g = await mkUser("nv-grantee");
    await admin.query("INSERT INTO public.workspace_capability_grants (company_id, grantee_user_id, capability, granted_by_user_id) VALUES ($1,$2,'manage_source_files',$3)", [NV.co, g, NV.holder]);
    return JSON.stringify(await usable(g)) === "[]" ? true : JSON.stringify(await usable(g));
  });

  const legacyRef = async () => `upload:${(await admin.query("SELECT id FROM public.trial_balance_uploads WHERE company_id=$1 AND period_year=2025 ORDER BY uploaded_at LIMIT 1", [L.co])).rows[0].id}`;
  group("Plan / capability matrix — one authority, fail closed");
  await check("the matrix has exactly one row for every plan x every non-capacity capability; multi-entity follows capacity; consolidation is on no plan", async () => {
    const rows = (await admin.query(`SELECT cp.code, f.capability_code c, f.included i, cp.entity_capacity e FROM public.commercial_plan_features f JOIN public.commercial_plans cp ON cp.id=f.plan_id`)).rows;
    const plans = await count("SELECT count(*) n FROM public.commercial_plans");
    const multiOk = rows.filter((r) => r.c === "MULTI_ENTITY_REPORTING").every((r) => r.code === "FREE" ? !r.i : r.i === (r.e === null || r.e > 1));
    return rows.length === plans * MATRIX_CAPS.length && rows.filter((r) => r.c === "CONSOLIDATION").every((r) => !r.i) && multiOk
      && rows.filter((r) => r.code === "FREE").every((r) => !r.i) ? true : JSON.stringify({ n: rows.length, plans, multiOk });
  });
  await check("unknown capability → UNKNOWN; a capability missing from the matrix → NOT_ENTITLED (fail closed); an unknown plan cannot be stored", async () => {
    const unknown = (await ent(pr.uid, "GOLD_FEATURE")).status;
    await admin.query("BEGIN");
    let missing;
    try {
      await admin.query("DELETE FROM public.commercial_plan_features WHERE plan_id=$1 AND capability_code='CLEAN_PDF'", [await planId("PRACTICE")]);
      missing = (await admin.query("SELECT public._resolve_entitlement_for_owner($1,'CLEAN_PDF') r", [pr.uid])).rows[0].r;
    } finally { await admin.query("ROLLBACK"); }
    const gold = await codeOf(() => admin.query("INSERT INTO public.commercial_plans (product_id, code, name, entity_capacity, sales_mode, feature_codes) VALUES ($1,'GOLD','Gold',3,'self_serve',ARRAY['CLOSE_ASSURANCE','COMPARATIVE_REPORTING','ENTITY_CAPACITY','NAMED_USER_SEATS'])", [product]));
    return unknown === "UNKNOWN" && missing.status === "NOT_ENTITLED" && missing.reason === "NOT_IN_PLAN_MATRIX" && gold === "23514" ? true : JSON.stringify({ unknown, missing, gold });
  });
  await check("every official format needs its plan feature: withdrawing CLEAN_PDF from Solo refuses a statement PDF while a spreadsheet is still issued", async () => {
    // Run the same change inside the caller's own transaction so both issuance calls see it.
    const LREF = await legacyRef();
    return asCaller(user(L.holder), async (cl) => {
      await cl.query("RESET ROLE");
      await cl.query("UPDATE public.commercial_plan_features SET included=false WHERE plan_id=(SELECT id FROM public.commercial_plans WHERE code='SOLO') AND capability_code='CLEAN_PDF'");
      await cl.query("SET LOCAL ROLE authenticated");
      const pdf = (await cl.query("SELECT public.issue_reporting_pack($1,2025,'financial_statements_pdf',$2,$3) r", [L.co, LREF, uuid()])).rows[0].r;
      const xls = (await cl.query("SELECT public.issue_reporting_pack($1,2025,'financial_statements_spreadsheet',$2,$3) r", [L.co, LREF, uuid()])).rows[0].r;
      await cl.query("RESET ROLE");
      await cl.query("UPDATE public.commercial_plan_features SET included=true WHERE plan_id=(SELECT id FROM public.commercial_plans WHERE code='SOLO') AND capability_code='CLEAN_PDF'");
      return pdf.outcome === "entitlement_required" && pdf.capability === "CLEAN_PDF" && xls.outcome === "issued" ? true : JSON.stringify({ pdf, xls });
    });
  });
  await check("regional packs need the plan: a filing jurisdiction is set on Solo, refused with no plan", async () => {
    const ok = await codeOf(() => q(user(L.holder), "SELECT public.set_company_filing_jurisdiction($1,'TZ')", [L.co]));
    await expire(soloLicence);
    const refused = await codeOf(() => q(user(L.holder), "SELECT public.set_company_filing_jurisdiction($1,'KE')", [L.co]));
    soloLicence = await grantPlan(L.holder, "SOLO");
    return ok === "ok" && refused === "42501" ? true : JSON.stringify({ ok, refused });
  });

  group("Reporting Pack — replay, cross-account, capability and downgrade refusal");
  await check("issue → seal once; a replayed seal, another account's seal, a person without issue_reporting_pack, and an issue after the plan ends are all refused; an output already issued stays verifiable", async () => {
    const ref = await legacyRef();
    const prRef = `upload:${(await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,2025) RETURNING id", [`${pr.uid}/${uuid()}.csv`, pr.co, pr.uid])).rows[0].id}`;
    // The official pack is generated by the database from a SAVED statements version (N-1): the seal takes no hash.
    const member = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [L.co, L.holder])).rows[0].id;
    const rid = `r-${uuid()}`;
    await admin.query("BEGIN"); await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(`INSERT INTO public.financial_statement_reports (report_id, report_version, company_id, period_year, provenance_origin, report_document, content_hash, document_hash, created_by_firm_member_id)
      VALUES ($1,1,$2,2025,'TRIAL_BALANCE_DERIVED','{"statements":{}}'::jsonb,$3, public.fs_sha256_hex('{"statements":{}}'::jsonb::text), $4)`, [rid, L.co, "e".repeat(64), member]);
    await admin.query("COMMIT");
    const saved = `fs-report:${rid}:v1`;
    const serverSeal = (who, id, co = L.co) => one(SERVICE, "SELECT public.seal_reporting_pack_server($1,$2,$3) r", [who, id, `${co}/${id}.json`]);
    const i = (await one(user(L.holder), "SELECT public.issue_reporting_pack($1,2025,'financial_statements_data',$2,$3) r", [L.co, saved, uuid()])).r;
    // The object the Edge Function stores (Supabase Storage records its size): a seal needs it.
    const prepared = (await one(SERVICE, "SELECT public.prepare_official_reporting_pack($1,$2) r", [L.holder, i.issuance_id])).r;
    await admin.query("INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('reporting-packs', $1, $2::jsonb)", [`${L.co}/${i.issuance_id}.json`, JSON.stringify({ size: prepared.byte_size })]);
    const sealed = (await serverSeal(L.holder, i.issuance_id)).r;
    const seal = sealed.outcome;
    const sha = sealed.content_sha256;
    const replay = (await serverSeal(L.holder, i.issuance_id)).r.outcome;
    const cross = (await serverSeal(pr.uid, i.issuance_id)).r.outcome;
    // A Practice member whose issue_reporting_pack was withdrawn.
    await one(user(pr.uid), "SELECT public.revoke_member_capability($1,$2,'issue_reporting_pack','proof')", [pr.co, pr.b]);
    const noCap = (await one(user(pr.b), "SELECT public.issue_reporting_pack($1,2025,'financial_statements_spreadsheet',$2,$3) r", [pr.co, prRef, uuid()])).r;
    const refusedEv = await count("SELECT count(*) n FROM public.reporting_pack_issuance_events WHERE actor_user_id=$1 AND event='REFUSED' AND detail->>'code'='CAPABILITY_REQUIRED'", [pr.b]);
    await expire(soloLicence);
    const after = (await one(user(L.holder), "SELECT public.issue_reporting_pack($1,2025,'financial_statements_spreadsheet',$2,$3) r", [L.co, ref, uuid()])).r.outcome;
    const stillVerifies = (await one(user(L.holder), "SELECT public.verify_reporting_pack($1) r", [sha])).r;
    return seal === "sealed" && replay === "already_sealed" && cross === "not_found" && noCap.outcome === "capability_required" && refusedEv === 1
      && after === "entitlement_required" && stillVerifies.official === true
      ? true : JSON.stringify({ seal, replay, cross, noCap, refusedEv, after, stillVerifies });
  });

  group("Reconciliation write wall — match, categorize, score and resolve are refused without a current plan, on every path");
  const R = { owner: await mkUser("rc-owner"), preparer: await mkUser("rc-preparer"), viewer: await mkUser("rc-viewer"), other: await mkUser("rc-other") };
  R.lic = await grantPlan(R.owner, "PRACTICE");
  await one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,2,'proof')", [R.lic]);
  R.co = await newCompany(R.owner, "Reconciliation Co");
  await q(user(R.owner), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now()), ($1,$3,'viewer',now())", [R.co, R.preparer, R.viewer]);
  const mkRecon = async (owner, co, period = 2025) => {
    const up = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,$4) RETURNING id", [owner + "/" + uuid() + ".csv", co, owner, period])).rows[0].id;
    // Fixture rows are written directly (the wall still runs on them: the account has a plan).
    const rec = (await admin.query("INSERT INTO public.safisha_reconciliations (client_id, tb_upload_id) VALUES ($1,$2) RETURNING id", [owner, up])).rows[0].id;
    await admin.query("INSERT INTO public.safisha_transactions (reconciliation_id, source_id, account_code, raw_row_hash) VALUES ($1,'bank','1000','h1')", [rec]);
    const ex = (await admin.query("INSERT INTO public.safisha_exceptions (reconciliation_id, account_code, category, variance) VALUES ($1,'1000','timing',10) RETURNING id", [rec])).rows[0].id;
    const ex2 = (await admin.query("INSERT INTO public.safisha_exceptions (reconciliation_id, account_code, category, variance) VALUES ($1,'2000','timing',5) RETURNING id", [rec])).rows[0].id;
    return { up, rec, ex, ex2 };
  };
  const match = (who, rec) => codeOf(() => q(user(who), "UPDATE public.safisha_reconciliations SET matched_count = matched_count + 1, status='needs_review' WHERE id=$1 RETURNING id", [rec]).then((x) => { if (x.length === 0) throw Object.assign(new Error("0 rows"), { code: "NO_ROW" }); }));
  const categorize = (who, rec) => codeOf(() => q(user(who), "INSERT INTO public.safisha_exceptions (reconciliation_id, account_code, category, variance) VALUES ($1,'3000','investigate',1)", [rec]));
  const score = (who, rec) => codeOf(() => q(user(who), "UPDATE public.safisha_reconciliations SET confidence_score = 90 WHERE id=$1 RETURNING id", [rec]).then((x) => { if (x.length === 0) throw Object.assign(new Error("0 rows"), { code: "NO_ROW" }); }));
  const resolveEx = (reviewer, ex) => codeOf(() => q(SERVICE, "SELECT public.safisha_resolve_exception($1,$2,'approved','proof')", [ex, reviewer]));
  const reconState = async (rec, co) => (await admin.query(`SELECT
      (SELECT to_jsonb(r) FROM public.safisha_reconciliations r WHERE r.id=$1) r,
      (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]') FROM public.safisha_exceptions e WHERE e.reconciliation_id=$1) e,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM public.safisha_transactions t WHERE t.reconciliation_id=$1) t,
      (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]') FROM public.safisha_audit_log a WHERE a.reconciliation_id=$1) a,
      (SELECT to_jsonb(u) - 'updated_at' FROM public.trial_balance_uploads u WHERE u.id=(SELECT tb_upload_id FROM public.safisha_reconciliations WHERE id=$1)) u,
      (SELECT coalesce(jsonb_agg(to_jsonb(fi) ORDER BY fi.id), '[]') FROM public.findings fi WHERE fi.company_id=$2) f,
      (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]') FROM public.statement_sign_offs s WHERE s.company_id=$2) so,
      (SELECT coalesce(jsonb_agg(to_jsonb(ev) ORDER BY ev.id), '[]') FROM public.efdms_reconciliation ev WHERE ev.company_id=$2) ef`, [rec, co])).rows[0];
  let RC;
  await check("with a current plan: the owner and a prepare_close holder can match, categorize, score and resolve; a viewer cannot", async () => {
    RC = await mkRecon(R.owner, R.co);
    const res = { match: await match(R.owner, RC.rec), cat: await categorize(R.preparer, RC.rec), score: await score(R.owner, RC.rec), resolve: await resolveEx(R.owner, RC.ex),
      viewerMatch: await match(R.viewer, RC.rec), viewerResolve: await resolveEx(R.viewer, RC.ex2) };
    return JSON.stringify(res) === JSON.stringify({ match: "ok", cat: "ok", score: "ok", resolve: "ok", viewerMatch: "42501", viewerResolve: "42501" }) ? true : JSON.stringify(res);
  });
  let before;
  await check("after expiry an EXISTING reconciliation cannot be matched, categorized, scored or resolved (PT402, CLOSE_ASSURANCE), by the owner or any member", async () => {
    await expire(R.lic);
    before = await reconState(RC.rec, R.co);
    const res = { match: await match(R.owner, RC.rec), cat: await categorize(R.owner, RC.rec), score: await score(R.owner, RC.rec), resolve: await resolveEx(R.owner, RC.ex2),
      preparerMatch: await match(R.preparer, RC.rec) };
    const e = await errOf(() => q(user(R.owner), "UPDATE public.safisha_reconciliations SET matched_count = 99 WHERE id=$1", [RC.rec]));
    // The preparer is billing-suspended by the expiry (only the holder stays active), so the row is not even visible.
    return res.match === "PT402" && res.cat === "PT402" && res.score === "PT402" && res.resolve === "PT402" && ["NO_ROW", "PT402"].includes(res.preparerMatch)
      && e?.detail === "CLOSE_ASSURANCE" && e?.hint === "NO_PLAN" ? true : JSON.stringify({ res, detail: e?.detail, hint: e?.hint });
  });
  await check("no direct bypass: service-role table writes, the evidence RPC, transaction / exception / audit inserts and EFDMS writes are all refused", async () => {
    const res = {
      svcUpdate: await codeOf(() => q(SERVICE, "UPDATE public.safisha_reconciliations SET status='clean' WHERE id=$1", [RC.rec])),
      svcDelete: await codeOf(() => q(SERVICE, "DELETE FROM public.safisha_reconciliations WHERE id=$1", [RC.rec])),
      evidenceRpc: await codeOf(() => q(SERVICE, "SELECT public.safisha_append_evidence_file($1,'bank','x.csv',1)", [RC.rec])),
      txnInsert: await codeOf(() => q(user(R.owner), "INSERT INTO public.safisha_transactions (reconciliation_id, source_id, account_code, raw_row_hash) VALUES ($1,'bank','1000','h2')", [RC.rec])),
      svcExInsert: await codeOf(() => q(SERVICE, "INSERT INTO public.safisha_exceptions (reconciliation_id, account_code, category, variance) VALUES ($1,'9','timing',1)", [RC.rec])),
      auditInsert: await codeOf(() => q(SERVICE, "INSERT INTO public.safisha_audit_log (exception_id, reconciliation_id, reviewer_id, action) VALUES ($1,$2,$3,'approved')", [RC.ex2, RC.rec, R.owner])),
      newRecon: await codeOf(() => q(user(R.owner), "INSERT INTO public.safisha_reconciliations (client_id, tb_upload_id) VALUES ($1,$2)", [R.owner, RC.up])),
      efdms: await codeOf(() => q(SERVICE, "INSERT INTO public.efdms_reconciliation (company_id, fiscal_year, period_month) VALUES ($1,2025,1)", [R.co])),
      resolverDirect: await codeOf(() => q(user(R.owner), "SELECT public.safisha_resolve_exception($1,$2,'approved','x')", [RC.ex2, R.owner])),
    };
    const ok = Object.entries(res).every(([k, v]) => (k === "resolverDirect" ? v === "42501" : v === "PT402"));
    return ok ? true : JSON.stringify(res);
  });
  await check("another account fails identically: an outsider changes nothing (RLS), and a second expired account is refused with the same PT402 on its own reconciliation", async () => {
    const outsider = await match(R.other, RC.rec);
    const O = { owner: await mkUser("rc2") }; O.lic = await grantPlan(O.owner, "SOLO"); O.co = await newCompany(O.owner, "Other Recon"); O.rc = await mkRecon(O.owner, O.co);
    await expire(O.lic);
    const e1 = await errOf(() => q(user(O.owner), "UPDATE public.safisha_reconciliations SET matched_count=1 WHERE id=$1", [O.rc.rec]));
    const e2 = await errOf(() => q(user(R.owner), "UPDATE public.safisha_reconciliations SET matched_count=1 WHERE id=$1", [RC.rec]));
    return outsider === "NO_ROW" && e1?.code === "PT402" && e2?.code === "PT402" && e1.detail === e2.detail && e1.hint === e2.hint && e1.message === e2.message
      ? true : JSON.stringify({ outsider, e1: [e1?.code, e1?.detail], e2: [e2?.code, e2?.detail] });
  });
  await check("refusal changed no reconciliation, exception, transaction, audit, upload, finding, sign-off or EFDMS state; history stays readable to the owner", async () => {
    const after = await reconState(RC.rec, R.co);
    const readable = (await q(user(R.owner), "SELECT id FROM public.safisha_reconciliations WHERE id=$1", [RC.rec])).length === 1
      && (await q(user(R.owner), "SELECT id FROM public.safisha_exceptions WHERE reconciliation_id=$1", [RC.rec])).length === 3;
    // (safisha_audit_log has never been client-readable; its unchanged content is compared above.)
    return JSON.stringify(after) === JSON.stringify(before) && readable ? true : JSON.stringify({ same: JSON.stringify(after) === JSON.stringify(before), readable });
  });
  await check("reactivation restores only explicitly entitled operations: the owner may reconcile again; a member without prepare_close still may not", async () => {
    R.lic = await grantPlan(R.owner, "PRACTICE");
    await one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,2,'proof')", [R.lic]);
    const roster = (await one(user(R.owner), "SELECT public.get_named_user_roster() r")).r;
    await one(user(R.owner), "SELECT public.choose_active_named_users($1::uuid[],$2)", [[R.preparer, R.viewer], roster.roster_version]);
    await one(user(R.owner), "SELECT public.revoke_member_capability($1,$2,'prepare_close','proof')", [R.co, R.preparer]);
    const res = { owner: await match(R.owner, RC.rec), ownerResolve: await resolveEx(R.owner, RC.ex2), preparer: await match(R.preparer, RC.rec), viewer: await categorize(R.viewer, RC.rec) };
    return JSON.stringify(res) === JSON.stringify({ owner: "ok", ownerResolve: "ok", preparer: "42501", viewer: "42501" }) ? true : JSON.stringify(res);
  });
  // ── B-2: no record can be moved or detached across workspaces, uploads or reconciliations (OLD and NEW scope) ──
  const X = { up: null, co: null, up2: null, co2: null };
  X.lic = await grantPlan(R.viewer, "SOLO");
  X.co = await newCompany(R.viewer, "Attacker Co");
  X.up = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,2025) RETURNING id", [`${R.viewer}/${uuid()}.csv`, X.co, R.viewer])).rows[0].id;
  X.co2 = await newCompany(R.owner, "Owner second Co");
  X.up2 = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,2025) RETURNING id", [`${R.owner}/${uuid()}.csv`, X.co2, R.owner])).rows[0].id;
  X.ef = (await admin.query("INSERT INTO public.efdms_reconciliation (company_id, fiscal_year, period_month) VALUES ($1,2025,2) RETURNING id", [R.co])).rows[0].id;
  await check("re-parenting is refused for a viewer, the owner and the service role — to another workspace, another upload, another reconciliation, another company or NULL — and nothing changes", async () => {
    const beforeR = await reconState(RC.rec, R.co); const beforeX = await admin.query("SELECT count(*)::int n FROM public.safisha_reconciliations r JOIN public.trial_balance_uploads u ON u.id=r.tb_upload_id WHERE u.company_id IN ($1,$2)", [X.co, X.co2]);
    const other = await mkRecon(R.owner, R.co, 2026);
    const res = {
      viewerMove: await codeOf(() => q(user(R.viewer), "UPDATE public.safisha_reconciliations SET tb_upload_id=$2 WHERE id=$1", [RC.rec, X.up])),
      ownerMove: await codeOf(() => q(user(R.owner), "UPDATE public.safisha_reconciliations SET tb_upload_id=$2 WHERE id=$1", [RC.rec, X.up2])),
      serviceMove: await codeOf(() => q(SERVICE, "UPDATE public.safisha_reconciliations SET tb_upload_id=$2 WHERE id=$1", [RC.rec, X.up])),
      serviceClient: await codeOf(() => q(SERVICE, "UPDATE public.safisha_reconciliations SET client_id=$2 WHERE id=$1", [RC.rec, R.viewer])),
      detach: await codeOf(() => q(SERVICE, "UPDATE public.safisha_reconciliations SET tb_upload_id=NULL WHERE id=$1", [RC.rec])),
      exceptionMove: await codeOf(() => q(SERVICE, "UPDATE public.safisha_exceptions SET reconciliation_id=$2 WHERE id=$1", [RC.ex2, other.rec])),
      transactionMove: await codeOf(() => q(SERVICE, "UPDATE public.safisha_transactions SET reconciliation_id=$2 WHERE reconciliation_id=$1", [RC.rec, other.rec])),
      efdmsMove: await codeOf(() => q(SERVICE, "UPDATE public.efdms_reconciliation SET company_id=$2 WHERE id=$1", [X.ef, X.co])),
      efdmsDetach: await codeOf(() => q(SERVICE, "UPDATE public.efdms_reconciliation SET company_id=NULL WHERE id=$1", [X.ef])),
    };
    const concurrent = await Promise.all(Array.from({ length: CONCURRENCY }, (_, n) => codeOf(() => (n % 2 ? q(SERVICE, "UPDATE public.safisha_reconciliations SET tb_upload_id=$2 WHERE id=$1", [RC.rec, X.up2]) : q(user(R.owner), "UPDATE public.safisha_reconciliations SET tb_upload_id=$2 WHERE id=$1", [RC.rec, X.up2])))));
    const afterR = await reconState(RC.rec, R.co); const afterX = await admin.query("SELECT count(*)::int n FROM public.safisha_reconciliations r JOIN public.trial_balance_uploads u ON u.id=r.tb_upload_id WHERE u.company_id IN ($1,$2)", [X.co, X.co2]);
    const efdmsKept = (await admin.query("SELECT company_id FROM public.efdms_reconciliation WHERE id=$1", [X.ef])).rows[0].company_id === R.co;
    const ok = Object.values(res).every((c) => c === "42501") && concurrent.every((c) => c === "42501")
      && JSON.stringify(afterR) === JSON.stringify(beforeR) && afterX.rows[0].n === beforeX.rows[0].n && efdmsKept;
    return ok ? true : JSON.stringify({ res, concurrent: [...new Set(concurrent)], same: JSON.stringify(afterR) === JSON.stringify(beforeR), efdmsKept });
  });
  await check("evidence attachment: pinned search path; attaches exactly one entry when authorized; an outsider, bad input or no plan fails atomically", async () => {
    const cfg = (await admin.query("SELECT proconfig FROM pg_proc WHERE oid='public.safisha_append_evidence_file(uuid,text,text,integer)'::regprocedure")).rows[0].proconfig;
    const len = async () => (await admin.query("SELECT jsonb_array_length(evidence_files) n FROM public.safisha_reconciliations WHERE id=$1", [RC.rec])).rows[0].n;
    const n0 = await len();
    const ok = (await one(user(R.owner), "SELECT public.safisha_append_evidence_file($1,'bank','statement.csv',12) r", [RC.rec])).r;
    const n1 = await len();
    const outsider = await codeOf(() => q(user(U.outsider), "SELECT public.safisha_append_evidence_file($1,'bank','x.csv',1)", [RC.rec]));
    const viewer = await codeOf(() => q(user(R.viewer), "SELECT public.safisha_append_evidence_file($1,'bank','x.csv',1)", [RC.rec]));
    const bad = await codeOf(() => q(user(R.owner), "SELECT public.safisha_append_evidence_file($1,'invoice','x.csv',1)", [RC.rec]));
    const anon = await codeOf(() => q(ANON, "SELECT public.safisha_append_evidence_file($1,'bank','x.csv',1)", [RC.rec]));
    const n2 = await len();
    return (cfg ?? []).some((c) => c.startsWith("search_path=")) && ok.outcome === "attached" && n1 === n0 + 1 && outsider === "42501" && viewer === "42501"
      && bad === "22023" && ["42501", "28000"].includes(anon) && n2 === n1 ? true : JSON.stringify({ cfg, ok, n0, n1, n2, outsider, viewer, bad, anon });
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ownerSession = async (uid) => { const c = await pool.connect(); await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]); return c; };
  const matchedCount = async () => (await admin.query("SELECT matched_count FROM public.safisha_reconciliations WHERE id=$1", [RC.rec])).rows[0].matched_count;
  await check("expiry vs write race — expiry commits first: the waiting write re-reads the plan after the lock and is refused (nothing written)", async () => {
    const before = await matchedCount();
    const a = await pool.connect(); await a.query("BEGIN");
    await a.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end=now() WHERE id=$1", [R.lic]);
    const b = await ownerSession(R.owner);
    let settled = false;
    const pb = b.query("UPDATE public.safisha_reconciliations SET matched_count = matched_count + 1 WHERE id=$1", [RC.rec]).then(() => "ok", (e) => e.code).finally(() => { settled = true; });
    await sleep(400);
    const blocked = !settled;
    await a.query("COMMIT"); a.release();
    const rb = await pb; await b.query("ROLLBACK"); b.release();
    return blocked && rb === "PT402" && (await matchedCount()) === before ? true : JSON.stringify({ blocked, rb, before, after: await matchedCount() });
  });
  await check("expiry vs write race — write commits first: the expiry waits for it; final state is deterministic (write kept, plan ended)", async () => {
    R.lic = await grantPlan(R.owner, "PRACTICE");
    const before = await matchedCount();
    const b = await ownerSession(R.owner);
    await b.query("UPDATE public.safisha_reconciliations SET matched_count = matched_count + 1 WHERE id=$1", [RC.rec]);
    const a = await pool.connect(); await a.query("BEGIN");
    let settled = false;
    const pa = a.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end=now() WHERE id=$1", [R.lic]).then(() => "ok", (e) => e.code).finally(() => { settled = true; });
    await sleep(400);
    const blocked = !settled;
    await b.query("COMMIT"); b.release();
    const ra = await pa; await a.query("COMMIT"); a.release();
    const plan = (await admin.query("SELECT public._account_has_current_plan($1) p", [R.owner])).rows[0].p;
    return blocked && ra === "ok" && (await matchedCount()) === before + 1 && plan === false ? true : JSON.stringify({ blocked, ra, before, after: await matchedCount(), plan });
  });
  await check("the wall covers every reconciliation table on INSERT, UPDATE and DELETE, and no other function writes them", async () => {
    const t = (await admin.query("SELECT tgrelid::regclass::text t, (tgtype & 4) <> 0 ins, (tgtype & 8) <> 0 del, (tgtype & 16) <> 0 upd FROM pg_trigger WHERE tgname='aa_reconciliation_write_wall' ORDER BY 1")).rows;
    const tables = t.map((x) => x.t);
    const writers = (await admin.query(String.raw`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
      AND pg_get_functiondef(p.oid) ~* '(INSERT INTO|UPDATE|DELETE FROM)\s+(public\.)?(safisha_(reconciliations|transactions|exceptions|audit_log)|efdms_(reconciliation|records|z_reports))\M' ORDER BY 1`)).rows.map((x) => x.proname);
    return JSON.stringify(tables) === JSON.stringify(["efdms_reconciliation", "efdms_records", "efdms_z_reports", "safisha_audit_log", "safisha_exceptions", "safisha_reconciliations", "safisha_transactions"])
      && t.every((x) => x.ins && x.del && x.upd) && JSON.stringify(writers) === '["safisha_append_evidence_file","safisha_resolve_exception"]'
      ? true : JSON.stringify({ tables, writers });
  });

  group("Close Assurance wall — no new preparation output without a plan, on every path");
  await check("the wall guards uploads, reconciliations, validations, tax computations, closing balances and findings; the service role is refused too", async () => {
    const tables = (await admin.query("SELECT tgrelid::regclass::text t FROM pg_trigger WHERE tgname='trg_close_assurance_wall' ORDER BY 1")).rows.map((r) => r.t);
    const svc = await codeOf(() => q(SERVICE, "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,2027)", [`${L.holder}/svc.csv`, L.co, L.holder]));
    return JSON.stringify(tables) === JSON.stringify(["findings", "hesabu_validations", "period_closing_balances", "safisha_reconciliations", "tax_computations", "trial_balance_uploads"]) && svc === "PT402"
      ? true : JSON.stringify({ tables, svc });
  });

  group("Migration replay — a clean replay and the upgrade replay above converge to the same schema");
  await check("an empty database replaying every migration (no approval needed: no open Free licence) reaches exactly the schema, policies, triggers, constraints and privileges of the upgraded legacy database", async () => {
    const SCHEMA_SQL = `SELECT md5(string_agg(x, '|' ORDER BY x)) fp, count(*) n FROM (
      SELECT 'c:'||table_name||'.'||column_name||':'||data_type||':'||coalesce(column_default,'')||is_nullable AS x FROM information_schema.columns WHERE table_schema='public'
      UNION ALL SELECT 'r:'||c.relname||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL SELECT 'f:'||p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
      UNION ALL SELECT 't:'||tgname||':'||tgrelid::regclass::text||':'||tgenabled::text FROM pg_trigger WHERE NOT tgisinternal
      UNION ALL SELECT 'k:'||conname||':'||conrelid::regclass::text||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
      UNION ALL SELECT 'p:'||tablename||'.'||policyname||':'||permissive||':'||roles::text||':'||cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,'') FROM pg_policies WHERE schemaname IN ('public','storage')
    ) s`;
    const cleanName = `clean_replay_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${cleanName}`);
    const cp = admin.connectionParameters;
    const c2 = new Client({ host: cp.host, port: cp.port, user: cp.user, password: cp.password, database: cleanName });
    await c2.connect();
    try {
      await c2.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
      await c2.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
      for (const f of files) {
        let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
        if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
        await c2.query(text);
      }
      const clean = (await c2.query(SCHEMA_SQL)).rows[0];
      const upgraded = (await admin.query(SCHEMA_SQL)).rows[0];
      if (clean.fp === upgraded.fp) return true;
      // Name the differing entries for the report.
      const LIST = SCHEMA_SQL.replace("SELECT md5(string_agg(x, '|' ORDER BY x)) fp, count(*) n FROM (", "SELECT x FROM (").replace(/\) s$/, ") s ORDER BY x");
      const a = new Set((await c2.query(LIST)).rows.map((r) => r.x)); const b = new Set((await admin.query(LIST)).rows.map((r) => r.x));
      return JSON.stringify({ onlyClean: [...a].filter((x) => !b.has(x)).slice(0, 5), onlyUpgraded: [...b].filter((x) => !a.has(x)).slice(0, 5) });
    } finally { await c2.end(); await admin.query(`DROP DATABASE ${cleanName}`); }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n──────────────────────────────────────────\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  console.log(failed.length === 0 ? "PLAN_CAPABILITIES: ALL PASSED" : "PLAN_CAPABILITIES: FAILED");
  return failed.length === 0;
}

let ok = false;
try { ok = await main(); } catch (e) { console.error(`FATAL: ${e?.stack ?? e}`); } finally { await stopDatabase(); }
process.exitCode = ok ? 0 : 1;
