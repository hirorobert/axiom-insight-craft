#!/usr/bin/env node
// Real-PostgreSQL proof of the plan catalogue, the plan x capability matrix, capability authorization and the minimum
// grant on the workspace-authority predicates (20260925130000, 20260925140000, 20260925150000).
//
//   no permanent free plan    the legacy Free state converts to "no current plan" (read-only, nothing deleted); Free
//                             is retired and cannot be offered or granted again; Free -> Solo restores operation
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
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]') FROM public.tax_losses t WHERE t.company_id=$1) tl`, [company])).rows[0];

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
  const legacyFreeLicence = (await admin.query(`SELECT cl.id, cl.status FROM public.commercial_licences cl JOIN public.billing_customers b ON b.id=cl.billing_customer_id
      JOIN public.commercial_plans cp ON cp.id=cl.plan_id WHERE b.owner_user_id=$1 AND cp.code='FREE'`, [L.holder])).rows[0];
  const legacyBefore = await snapshot(L.co);
  const preCapabilityDefs = {};
  await check(`${M130} applies over the legacy Free state (an ACTIVE auto-provisioned FREE licence existed)`, async () => {
    if (legacyFreeLicence?.status !== "ACTIVE") return `no legacy FREE licence: ${JSON.stringify(legacyFreeLicence)}`;
    await applyMigration(M130);
    for (const p of (await admin.query("SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname='public'")).rows) preCapabilityDefs[`${p.tablename}.${p.policyname}`] = p;
    return true;
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
  await check("conversion from Free deleted nothing: the company, memberships, upload, grants and tax records are byte-identical", async () => {
    const after = await snapshot(L.co);
    return JSON.stringify(after) === JSON.stringify(legacyBefore) ? true : "customer data changed";
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

  group("Free → Solo — safe conversion");
  let soloLicence;
  await check("recording Solo restores operation on the same entity with every record intact; members beyond one named user stay suspended, never removed", async () => {
    soloLicence = await grantPlan(L.holder, "SOLO");
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
  await check("the capability, not the title, decides a title change: a new title's template is recorded, explicit grants are kept", async () => {
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
    return asCaller(user(L.holder), async (cl) => {
      await cl.query("RESET ROLE");
      await cl.query("UPDATE public.commercial_plan_features SET included=false WHERE plan_id=(SELECT id FROM public.commercial_plans WHERE code='SOLO') AND capability_code='CLEAN_PDF'");
      await cl.query("SET LOCAL ROLE authenticated");
      const pdf = (await cl.query("SELECT public.issue_reporting_pack($1,2025,'financial_statements_pdf',$2,$3) r", [L.co, `upload:${uuid()}`, uuid()])).rows[0].r;
      const xls = (await cl.query("SELECT public.issue_reporting_pack($1,2025,'financial_statements_spreadsheet',$2,$3) r", [L.co, `upload:${uuid()}`, uuid()])).rows[0].r;
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
    const ref = `upload:${uuid()}`;
    const i = (await one(user(L.holder), "SELECT public.issue_reporting_pack($1,2025,'financial_statements_spreadsheet',$2,$3) r", [L.co, ref, uuid()])).r;
    const sha = "a".repeat(64);
    const seal = (await one(user(L.holder), "SELECT public.consume_reporting_pack_issuance($1,$2,2025,'financial_statements_spreadsheet',$3,$4) r", [i.issuance_id, L.co, ref, sha])).r.outcome;
    const replay = (await one(user(L.holder), "SELECT public.consume_reporting_pack_issuance($1,$2,2025,'financial_statements_spreadsheet',$3,$4) r", [i.issuance_id, L.co, ref, sha])).r.outcome;
    const cross = (await one(user(pr.uid), "SELECT public.consume_reporting_pack_issuance($1,$2,2025,'financial_statements_spreadsheet',$3,$4) r", [i.issuance_id, L.co, ref, "b".repeat(64)])).r.outcome;
    // A Practice member whose issue_reporting_pack was withdrawn.
    await one(user(pr.uid), "SELECT public.revoke_member_capability($1,$2,'issue_reporting_pack','proof')", [pr.co, pr.b]);
    const noCap = (await one(user(pr.b), "SELECT public.issue_reporting_pack($1,2025,'financial_statements_spreadsheet',$2,$3) r", [pr.co, `upload:${uuid()}`, uuid()])).r;
    const refusedEv = await count("SELECT count(*) n FROM public.reporting_pack_issuance_events WHERE actor_user_id=$1 AND event='REFUSED' AND detail->>'code'='CAPABILITY_REQUIRED'", [pr.b]);
    await expire(soloLicence);
    const after = (await one(user(L.holder), "SELECT public.issue_reporting_pack($1,2025,'financial_statements_spreadsheet',$2,$3) r", [L.co, `upload:${uuid()}`, uuid()])).r.outcome;
    const stillVerifies = (await one(user(L.holder), "SELECT public.verify_reporting_pack($1) r", [sha])).r;
    return seal === "sealed" && replay === "already_sealed" && cross === "not_found" && noCap.outcome === "capability_required" && refusedEv === 1
      && after === "entitlement_required" && stillVerifies.official === true
      ? true : JSON.stringify({ seal, replay, cross, noCap, refusedEv, after, stillVerifies });
  });

  group("Close Assurance wall — no new preparation output without a plan, on every path");
  await check("the wall guards uploads, reconciliations, validations, tax computations, closing balances and findings; the service role is refused too", async () => {
    const tables = (await admin.query("SELECT tgrelid::regclass::text t FROM pg_trigger WHERE tgname='trg_close_assurance_wall' ORDER BY 1")).rows.map((r) => r.t);
    const svc = await codeOf(() => q(SERVICE, "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,2027)", [`${L.holder}/svc.csv`, L.co, L.holder]));
    return JSON.stringify(tables) === JSON.stringify(["findings", "hesabu_validations", "period_closing_balances", "safisha_reconciliations", "tax_computations", "trial_balance_uploads"]) && svc === "PT402"
      ? true : JSON.stringify({ tables, svc });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n──────────────────────────────────────────\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  console.log(failed.length === 0 ? "PLAN_CAPABILITIES: ALL PASSED" : "PLAN_CAPABILITIES: FAILED");
  return failed.length === 0;
}

let ok = false;
try { ok = await main(); } catch (e) { console.error(`FATAL: ${e?.stack ?? e}`); } finally { await stopDatabase(); }
process.exitCode = ok ? 0 : 1;
