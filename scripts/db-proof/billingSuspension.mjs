#!/usr/bin/env node
// Real-PostgreSQL proof of named-user billing suspension, invitation reservations and the official Reporting Pack
// (20260925110000_named_user_billing_suspension_and_invitation_lifecycle.sql, 20260925120000_reporting_pack_issuance_binding.sql).
//
// P-03  active named users <= included + purchased seats after downgrade, expiry (with and without a licence write),
//       planned reduction, restoration and concurrent reactivation; suspended people keep their memberships and
//       history, get exactly an outsider's denial (authority, RLS, RPCs, Edge authority), and are reactivated only by
//       the account holder's explicit, version-checked selection; the service role cannot bypass it; each redefined
//       access function differs from its previous definition by exactly the one activity conjunct.
// P-04  pending invitations expire, can be cancelled or released, are never double-reserved, cannot be accepted
//       once invalid, and stay within capacity under concurrency.
// P-05  issuances are bound (user, workspace, period, output, format), short-lived, single-use, re-authorised when
//       sealed, verifiable by content hash, and audited append-only.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/billingSuspension.mjs
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
const MIGRATION = "20260925110000_named_user_billing_suspension_and_invitation_lifecycle.sql";
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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-billing-suspension-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE billing_suspension_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/billing_suspension_proof`;
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

// The 19 access functions 20260925110000 redefines with one added conjunct each (see the migration's section 5).
const PATCHED = [
  "assert_engagement_write_authority(uuid)", "financial_statements_workspace_access(uuid)", "fs_actor_member_id(uuid)",
  "get_engagement_setup_state(uuid)", "get_member_company_ids()", "get_workspace_access(uuid)",
  "hesabu_write_validation(uuid,uuid,integer,text,integer,integer,integer,integer,numeric,numeric,numeric,uuid,text,jsonb)",
  "intake_financial_statement_document(uuid,integer,uuid,text,text,bigint,text,text,text)", "list_shared_workspaces()",
  "maono_write_board_pack(uuid,uuid,text,text,jsonb,text,text,integer)", "open_engagement_with_scope(uuid,integer,text[],text)",
  "record_engagement_data_start(uuid,text,text)", "resolve_account_review_batch(uuid,uuid,uuid,jsonb)", "safisha_recon_visible(uuid)",
  "set_company_filing_jurisdiction(uuid,text)", "tbu_can_view_workspace_audit(uuid)", "tbu_resolve_processing_actor(uuid,uuid)",
  "workspace_authority_basis(uuid,uuid,text)",
  "xbrl_write_instance(uuid,uuid,integer,text,text,text,text,text,integer,boolean,integer,integer,integer,uuid,text,jsonb)",
];
const defOf = async (sig) => (await admin.query("SELECT pg_get_functiondef($1::regprocedure) d", [`public.${sig}`])).rows[0].d;
// Line endings are normalised (some previous definitions came from CRLF migration files); nothing else is.
const stripPredicate = (d) => d.replace(/\r/g, "").replace(/\s*AND\s+public\.named_user_access_active\([^()]*\)/g, "");

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
  const before = {};
  group("Migration — applies over every earlier migration; each access function changes by exactly one conjunct");
  await check(`every migration before ${MIGRATION} applies`, async () => {
    if (cut < 0) return "migration not found";
    for (const f of files.slice(0, cut)) await applyMigration(f);
    for (const sig of PATCHED) before[sig] = await defOf(sig);
    return true;
  });
  await check(`${MIGRATION} and every later migration apply`, async () => { for (const f of files.slice(cut)) await applyMigration(f); return true; });
  await check("each of the 19 redefined access functions equals its previous definition once the single activity conjunct is removed (no other logic changed)", async () => {
    const bad = [];
    for (const sig of PATCHED) {
      const now = await defOf(sig);
      const added = (now.match(/public\.named_user_access_active\(/g) ?? []).length;
      if (added < 1 || stripPredicate(now) !== before[sig].replace(/\r/g, "")) bad.push(`${sig}:${added}`);
    }
    return bad.length === 0 ? true : bad.join(" | ");
  });
  await check("a second application is refused before any change (55000)", async () => (await codeOf(() => applyMigration(MIGRATION))) === "55000"
    || (await errOf(() => admin.query(fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8"))))?.code === "55000");

  // ── Fixtures ──────────────────────────────────────────────────────────────────────────────
  const mkUser = async (label = "u") => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id}@example.test`]); return id; };
  const U = { admin: await mkUser("admin"), outsider: await mkUser("outsider") };
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [U.admin]);
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const planId = async (code) => (await admin.query("SELECT id FROM public.commercial_plans WHERE product_id=$1 AND code=$2", [product, code])).rows[0].id;
  const account = async (planCode, seats = 0) => {
    const uid = await mkUser("acct");
    let lic = null;
    if (planCode) {
      const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id;
      const id = (await admin.query(`INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats)
        VALUES ($1,$2,'ACTIVE','ADMIN_GRANT',now() - interval '1 day',$3) RETURNING id`, [bc, await planId(planCode), seats])).rows[0].id;
      lic = { bc, id };
    }
    const co = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Seat Co') RETURNING id", [uid])).rows[0].id;
    if (!lic) lic = { bc: (await admin.query("SELECT id FROM public.billing_customers WHERE owner_user_id=$1", [uid])).rows[0].id, id: null };
    return { uid, co, lic };
  };
  const addActive = (acct, co, who, role = "preparer") => q(user(acct), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now()) RETURNING id", [co, who, role]);
  const invite = (acct, co, who) => q(user(acct), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',NULL) RETURNING id", [co, who]);
  const grantTo = (acct, co, who, cap = "manage_source_files") => one(user(acct), "SELECT * FROM public.grant_workspace_capability($1,$2,$3)", [co, who, cap]);
  const roster = async (acct) => (await one(user(acct), "SELECT public.get_named_user_roster() r")).r;
  const choose = async (acct, keep, version) => (await one(user(acct), "SELECT public.choose_active_named_users($1::uuid[], $2) r", [keep, version])).r;
  const prepare = async (bc, future, keep, version, caller = U.admin) => (await one(user(caller), "SELECT public.admin_prepare_planned_reduction($1,$2,$3::uuid[],$4,'customer instruction') r", [bc, future, keep, version])).r;
  const setSeats = (licId, n) => one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,$2,'seats changed') r", [licId, n]);
  const accept = async (who) => (await one(user(who), "SELECT public.accept_workspace_invitations() r")).r;
  const authz = async (who, co, cap = "COMPARATIVE_REPORTING") => (await one(user(who), "SELECT public.authorize_paid_action($1,$2) r", [co, cap])).r;
  const activeOf = async (acct) => (await admin.query(`SELECT array_agg(u.named_user_id::text ORDER BY u.named_user_id) a FROM public._account_named_users($1,false) u
      WHERE public._account_named_user_access_active($1, u.named_user_id)`, [acct])).rows[0].a ?? [];
  const allowedOf = async (acct) => (await admin.query("SELECT public._seat_capacity_for_account($1) c", [acct])).rows[0].c;
  const invariant = async (acct) => {
    const a = (await activeOf(acct)).length; const c = await allowedOf(acct);
    return c.determined ? a <= c.allowed_named_users : a === 1;
  };
  const openSuspensions = (acct) => count("SELECT count(*) n FROM public.named_user_billing_suspensions WHERE account_user_id=$1 AND lifted_at IS NULL", [acct]);
  const auditSnapshot = async () => (await admin.query(`SELECT
      coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM public.billing_audit_events b), '[]') ||
      coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM public.workspace_capability_grant_events g), '[]') a`)).rows[0].a;
  const auditBefore = await auditSnapshot();

  group("P-03 — the active-seat invariant after downgrade, expiry, reduction and restoration; memberships and history kept");
  let firm;
  const firmPeople = [];
  await check("Firm with 10 active named users downgrades to Free: exactly the account holder stays active; the nine memberships stay present, billing-suspended", async () => {
    firm = await account("FIRM", 9);
    for (let i = 0; i < 9; i++) { const p = await mkUser("firm"); firmPeople.push(p); await addActive(firm.uid, firm.co, p); }
    const activeBefore = (await activeOf(firm.uid)).length;
    const rowsBefore = (await admin.query("SELECT id, user_id, role, accepted_at FROM public.firm_members WHERE company_id=$1 ORDER BY id", [firm.co])).rows;
    await admin.query("UPDATE public.commercial_licences SET plan_id=$1 WHERE id=$2", [await planId("FREE"), firm.lic.id]);
    const rowsAfter = (await admin.query("SELECT id, user_id, role, accepted_at FROM public.firm_members WHERE company_id=$1 ORDER BY id", [firm.co])).rows;
    const active = await activeOf(firm.uid);
    const reasons = (await admin.query("SELECT DISTINCT reason FROM public.named_user_billing_suspensions WHERE account_user_id=$1", [firm.uid])).rows.map((r) => r.reason);
    return activeBefore === 10 && active.length === 1 && active[0] === firm.uid && (await openSuspensions(firm.uid)) === 9
      && JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter) && rowsAfter.length === 10 && JSON.stringify(reasons) === '["ENTITLEMENT_LOST"]'
      && (await invariant(firm.uid)) ? true : JSON.stringify({ activeBefore, active: active.length, susp: await openSuspensions(firm.uid), reasons });
  });
  await check("restoring capacity reactivates NO ONE by itself; restoring one seat permits exactly one explicitly selected reactivation", async () => {
    await admin.query("UPDATE public.commercial_licences SET plan_id=$1, additional_seats=1 WHERE id=$2", [await planId("PRACTICE"), firm.lic.id]);
    const afterRestore = (await activeOf(firm.uid)).length;
    const r = await roster(firm.uid);
    const two = await choose(firm.uid, [firmPeople[0], firmPeople[1]], r.roster_version);
    const oneSel = await choose(firm.uid, [firmPeople[0]], r.roster_version);
    const active = await activeOf(firm.uid);
    return afterRestore === 1 && two.outcome === "selection_exceeds_allowance" && oneSel.outcome === "applied"
      && active.length === 2 && active.includes(firmPeople[0]) && (await openSuspensions(firm.uid)) === 8 && (await invariant(firm.uid))
      ? true : JSON.stringify({ afterRestore, two, oneSel, active });
  });
  await check("expiry (time) is enforced the instant it passes, with no job: the live predicate locks out everyone but the account holder", async () => {
    const a = await account("PRACTICE", 2);
    const p1 = await mkUser("e"), p2 = await mkUser("e");
    await addActive(a.uid, a.co, p1); await addActive(a.uid, a.co, p2);
    // Simulate time passing without any write to the licence (no trigger fires).
    await admin.query("BEGIN"); await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("UPDATE public.commercial_licences SET effective_end = now() - interval '1 second', effective_start = now() - interval '2 days' WHERE id=$1", [a.lic.id]);
    await admin.query("COMMIT");
    const denied = (await authz(p1, a.co)).code === "WORKSPACE_ACCESS_DENIED" && (await authz(p2, a.co)).code === "WORKSPACE_ACCESS_DENIED";
    const holder = (await authz(a.uid, a.co)).allowed === true;
    return denied && holder && (await activeOf(a.uid)).length === 1 && (await invariant(a.uid));
  });
  let practice;
  const pp = [];
  await check("Practice with four active users, planned reduction to one additional seat: the chosen person stays active; the others are suspended (PLANNED_REDUCTION)", async () => {
    practice = await account("PRACTICE", 3);
    for (let i = 0; i < 3; i++) { const p = await mkUser("p"); pp.push(p); await addActive(practice.uid, practice.co, p); }
    const unplannedRefused = (await errOf(() => setSeats(practice.lic.id, 1)))?.code;
    const r = await roster(practice.uid);
    const applied = await prepare(practice.lic.bc, 2, [pp[1]], r.roster_version);
    await setSeats(practice.lic.id, 1);
    const active = await activeOf(practice.uid);
    const reasons = (await admin.query("SELECT DISTINCT reason FROM public.named_user_billing_suspensions WHERE account_user_id=$1 AND lifted_at IS NULL", [practice.uid])).rows.map((x) => x.reason);
    return unplannedRefused === "22023" && applied.outcome === "applied" && active.length === 2 && active.includes(pp[1]) && active.includes(practice.uid)
      && JSON.stringify(reasons) === '["PLANNED_REDUCTION"]' && (await invariant(practice.uid)) ? true : JSON.stringify({ unplannedRefused, applied, active, reasons });
  });
  await check("a planned selection is refused when missing, invalid, stale, over the future allowance, or not from a commercial admin", async () => {
    const r = await roster(practice.uid);
    const missing = await prepare(practice.lic.bc, 2, null, r.roster_version);
    const invalid = await prepare(practice.lic.bc, 2, [uuid()], r.roster_version);
    const holderInKeep = await prepare(practice.lic.bc, 2, [practice.uid], r.roster_version);
    const stale = await prepare(practice.lic.bc, 2, [pp[1]], "0".repeat(32));
    const over = await prepare(practice.lic.bc, 2, [pp[0], pp[1]], r.roster_version);
    const notAdmin = await codeOf(() => prepare(practice.lic.bc, 2, [pp[1]], r.roster_version, practice.uid));
    return missing.outcome === "selection_required" && invalid.outcome === "invalid_selection" && holderInKeep.outcome === "invalid_selection"
      && stale.outcome === "stale_selection" && over.outcome === "selection_exceeds_allowance" && notAdmin === "42501"
      ? true : JSON.stringify({ missing, invalid, holderInKeep, stale, over, notAdmin });
  });
  await check(`concurrent reactivations from the same roster cannot exceed the allowance: of ${CONCURRENCY} simultaneous selections, exactly one applies; the rest are stale`, async () => {
    const r = await roster(practice.uid); // allowance 2: holder + pp[1]; pp[0], pp[2] suspended
    await choose(practice.uid, [], r.roster_version); // free the one seat: nobody but the holder active
    const r2 = await roster(practice.uid);
    const picks = Array.from({ length: CONCURRENCY }, (_, i) => [pp[i % 3]]);
    const out = await Promise.all(picks.map((k) => choose(practice.uid, k, r2.roster_version).catch((e) => ({ outcome: e.code }))));
    return out.filter((o) => o.outcome === "applied").length === 1 && out.filter((o) => o.outcome === "stale_selection").length === CONCURRENCY - 1
      && (await activeOf(practice.uid)).length === 2 && (await invariant(practice.uid)) ? true : JSON.stringify(out.map((o) => o.outcome));
  });
  await check(`the service role cannot lift suspensions past the allowance: ${CONCURRENCY} simultaneous direct lifts with one free seat → exactly one`, async () => {
    const a = await account("PRACTICE", 3);
    const ps = []; for (let i = 0; i < 3; i++) { const p = await mkUser("s"); ps.push(p); await addActive(a.uid, a.co, p); }
    const r = await roster(a.uid);
    await prepare(a.lic.bc, 1, [], r.roster_version);            // everyone but the holder suspended
    await setSeats(a.lic.id, 1);                                  // allowance 2: one free seat
    const lift = (p) => codeOf(() => q(SERVICE, "UPDATE public.named_user_billing_suspensions SET lifted_at=now(), lifted_by=$2, lift_reason='OWNER_SELECTION' WHERE account_user_id=$1 AND user_id=$3 AND lifted_at IS NULL", [a.uid, a.uid, p]));
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => lift(ps[i % 3])));
    return (await activeOf(a.uid)).length === 2 && out.filter((c) => c === "PT402").length >= 1 && (await invariant(a.uid)) ? true : JSON.stringify(out);
  });
  await check("the service role cannot bypass the invariant with ordinary membership writes: no new member, grant or re-admission for a suspended person; history cannot be deleted", async () => {
    const newcomer = await mkUser("n");
    const svcMember = await codeOf(() => q(SERVICE, "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'viewer',now())", [firm.co, newcomer]));
    const second = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Second') RETURNING id", [practice.uid])).rows[0].id;
    const suspended = (await admin.query("SELECT user_id FROM public.named_user_billing_suspensions WHERE account_user_id=$1 AND lifted_at IS NULL LIMIT 1", [practice.uid])).rows[0].user_id;
    const svcSuspended = await errOf(() => q(SERVICE, "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'viewer',now())", [second, suspended]));
    const grantSuspended = await errOf(() => q(SERVICE, "INSERT INTO public.workspace_capability_grants (company_id, grantee_user_id, capability, granted_by_user_id) VALUES ($1,$2,'manage_source_files',$3)", [second, suspended, practice.uid]));
    const del = await codeOf(() => q(SERVICE, "DELETE FROM public.named_user_billing_suspensions WHERE account_user_id=$1", [practice.uid]));
    const delOwner = await codeOf(() => admin.query("DELETE FROM public.named_user_billing_suspensions WHERE account_user_id=$1", [practice.uid]));
    const trunc = await codeOf(() => admin.query("TRUNCATE public.named_user_billing_suspensions"));
    const clientWrite = await codeOf(() => q(user(practice.uid), "UPDATE public.named_user_billing_suspensions SET lifted_at=now(), lifted_by=$1, lift_reason='OWNER_SELECTION' WHERE account_user_id=$1", [practice.uid]));
    return svcMember === "PT402" && svcSuspended?.code === "PT402" && svcSuspended.hint === "SUSPENDED" && grantSuspended?.code === "PT402"
      && del === "42501" && delOwner === "P0001" && trunc === "P0001" && clientWrite === "42501" ? true : JSON.stringify({ svcMember, svcSuspended: svcSuspended?.hint, grantSuspended: grantSuspended?.code, del, delOwner, trunc, clientWrite });
  });

  group("P-03 — a suspended person gets exactly what an outsider gets: no read, no write, no RPC, no Edge authority");
  const S = firmPeople[5];                // suspended in firm.co (Firm → Free → Practice+1, pp choice kept firmPeople[0])
  const O = U.outsider;
  const sameDenial = async (fn) => JSON.stringify(await fn(S)) === JSON.stringify(await fn(O));
  await check("paid-action authority, commercial state, seat state and workspace access: identical to an unrelated user", async () =>
    (await sameDenial((w) => authz(w, firm.co))) && (await authz(S, firm.co)).code === "WORKSPACE_ACCESS_DENIED"
    && (await sameDenial(async (w) => (await one(user(w), "SELECT public.get_workspace_commercial_state($1) r", [firm.co])).r))
    && (await sameDenial(async (w) => (await one(user(w), "SELECT public.get_workspace_seat_capacity($1) r", [firm.co])).r))
    && (await sameDenial(async (w) => (await q(user(w), "SELECT * FROM public.get_workspace_access($1)", [firm.co])).length))
    && (await sameDenial(async (w) => (await one(user(w), "SELECT public.financial_statements_workspace_access($1) r", [firm.co])).r)));
  await check("RLS: the suspended person reads none of the workspace's rows (own membership, sign-offs, issuances, member company list); an active member reads them", async () => {
    const active = firmPeople[0];
    const up = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,user_id,period_year) VALUES ('tb.csv',$1,10,'complete',$2,$3,2031) RETURNING id", [`${firm.uid}/${uuid()}.csv`, firm.co, firm.uid])).rows[0].id;
    await admin.query("INSERT INTO public.statement_sign_offs (company_id, period_year, upload_id) VALUES ($1,2031,$2)", [firm.co, up]);
    const reads = async (w) => ({
      members: (await q(user(w), "SELECT id FROM public.firm_members WHERE company_id=$1", [firm.co])).length,
      signoffs: (await q(user(w), "SELECT id FROM public.statement_sign_offs WHERE company_id=$1", [firm.co])).length,
      companies: (await q(user(w), "SELECT c FROM public.get_member_company_ids() c WHERE c=$1", [firm.co])).length,
    });
    const s = await reads(S), o = await reads(O), a = await reads(active);
    return JSON.stringify(s) === JSON.stringify(o) && s.members === 0 && s.signoffs === 0 && s.companies === 0 && a.signoffs === 1 && a.companies === 1
      ? true : JSON.stringify({ s, o, a });
  });
  await check("RPCs: actor resolution, engagement scope, filing jurisdiction and processing authority all refuse the suspended person like an outsider", async () => {
    await admin.query("UPDATE public.firm_members SET role='partner' WHERE company_id=$1 AND user_id=$2", [firm.co, S]);
    const actor = await codeOf(() => one(user(S), "SELECT public.fs_actor_member_id($1) r", [firm.co]));
    const actorO = await codeOf(() => one(user(O), "SELECT public.fs_actor_member_id($1) r", [firm.co]));
    const scope = await codeOf(() => one(user(S), "SELECT public.open_engagement_with_scope($1,2031,ARRAY['FINANCIAL_STATEMENTS'],NULL) r", [firm.co]));
    const juris = await codeOf(() => one(user(S), "SELECT public.set_company_filing_jurisdiction($1,'TZ') r", [firm.co]));
    const proc = (await admin.query("SELECT count(*) n FROM public.tbu_resolve_processing_actor($1,$2)", [S, firm.co])).rows[0].n;
    const procActive = (await admin.query("SELECT count(*) n FROM public.tbu_resolve_processing_actor($1,$2)", [firmPeople[0], firm.co])).rows[0].n;
    return actor === "42501" && actor === actorO && scope === "42501" && juris === "42501" && Number(proc) === 0 && Number(procActive) === 1
      ? true : JSON.stringify({ actor, actorO, scope, juris, proc, procActive });
  });
  await check("capability grants: a suspended grantee has no authority basis and the workspace disappears from their shared list", async () => {
    const a = await account("PRACTICE", 1);
    const g = await mkUser("g");
    await grantTo(a.uid, a.co, g, "prepare_trial_balance");
    const beforeBasis = (await admin.query("SELECT public.workspace_authority_basis($1,$2,'prepare_trial_balance') b", [g, a.co])).rows[0].b;
    const beforeShared = (await q(user(g), "SELECT * FROM public.list_shared_workspaces()")).length;
    const r = await roster(a.uid);
    await choose(a.uid, [], r.roster_version);
    const afterBasis = (await admin.query("SELECT public.workspace_authority_basis($1,$2,'prepare_trial_balance') b", [g, a.co])).rows[0].b;
    const afterShared = (await q(user(g), "SELECT * FROM public.list_shared_workspaces()")).length;
    return beforeBasis === "explicit_capability" && beforeShared === 1 && afterBasis === null && afterShared === 0 ? true : JSON.stringify({ beforeBasis, beforeShared, afterBasis, afterShared });
  });
  await check("Edge Function authority (service role) sees the suspension; a signed-in user can never probe anyone else's state", async () => {
    const svc = (await one(SERVICE, "SELECT public.named_user_access_active($1,$2) r", [firm.co, S])).r;
    const svcActive = (await one(SERVICE, "SELECT public.named_user_access_active($1,$2) r", [firm.co, firmPeople[0]])).r;
    const probe = (await one(user(O), "SELECT public.named_user_access_active($1,$2) r", [firm.co, firmPeople[0]])).r;
    const anonCall = await codeOf(() => one(ANON, "SELECT public.named_user_access_active($1,$2) r", [firm.co, S]));
    return svc === false && svcActive === true && probe === false && anonCall === "42501" ? true : JSON.stringify({ svc, svcActive, probe, anonCall });
  });
  await check("removing a suspended member never corrupts attribution: an attributed membership cannot be deleted; an unattributed one can, and its suspension history remains", async () => {
    const attributed = firmPeople[6], plain = firmPeople[7];
    const memberId = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [firm.co, attributed])).rows[0].id;
    await admin.query(`INSERT INTO public.financial_statement_reports (report_id, report_version, company_id, period_year, provenance_origin, report_document, content_hash, document_hash, created_by_firm_member_id)
      VALUES ($1,1,$2,2031,'TRIAL_BALANCE_DERIVED','{}'::jsonb,$3,$3,$4)`, [`r-${uuid()}`, firm.co, "b".repeat(64), memberId]);
    const delAttributed = await codeOf(() => q(user(firm.uid), "DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [firm.co, attributed]));
    const stillAttributed = await count("SELECT count(*) n FROM public.financial_statement_reports WHERE created_by_firm_member_id=$1", [memberId]);
    const delPlain = await codeOf(() => q(user(firm.uid), "DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [firm.co, plain]));
    const history = await count("SELECT count(*) n FROM public.named_user_billing_suspensions WHERE account_user_id=$1 AND user_id=$2", [firm.uid, plain]);
    return delAttributed !== "ok" && stillAttributed === 1 && delPlain === "ok" && history === 1 ? true : JSON.stringify({ delAttributed, stillAttributed, delPlain, history });
  });

  group("P-04 — invitation reservations expire, can be cancelled or released, are never double-reserved, and stay within capacity");
  const reserve = async (co, who, by) => (await one(SERVICE, "SELECT public.reserve_workspace_invitation($1,$2,'preparer',$3,$4) r", [co, who, by, `${who}@example.test`])).r;
  const reservedOf = async (acct) => Number((await admin.query("SELECT count(*) n FROM public._account_named_users($1,true)", [acct])).rows[0].n);
  await check("a pending invitation carries an explicit expiry (invitation_reservation_ttl) and can never be given a longer one", async () => {
    const a = await account("PRACTICE", 2);
    const r1 = await reserve(a.co, await mkUser("i"), a.uid);
    const far = await mkUser("i");
    await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at,invitation_expires_at) VALUES ($1,$2,'viewer',NULL, now() + interval '400 days')", [a.co, far]);
    const ttl = (await admin.query("SELECT extract(epoch FROM public.invitation_reservation_ttl()) s")).rows[0].s;
    const rows = (await admin.query("SELECT extract(epoch FROM invitation_expires_at - now()) s FROM public.firm_members WHERE company_id=$1 AND accepted_at IS NULL", [a.co])).rows;
    return r1.outcome === "reserved" && rows.length === 2 && rows.every((x) => Number(x.s) <= Number(ttl) + 5 && Number(x.s) > Number(ttl) - 120) ? true : JSON.stringify({ r1, ttl, rows });
  });
  await check("expiry releases the seat atomically (no job) and an expired invitation cannot be accepted; the row is kept", async () => {
    const a = await account("PRACTICE", 1);
    const p = await mkUser("x"), q2 = await mkUser("x");
    await reserve(a.co, p, a.uid);
    const full = await reserve(a.co, q2, a.uid);
    await admin.query("UPDATE public.firm_members SET invitation_expires_at = now() - interval '1 minute' WHERE company_id=$1 AND user_id=$2", [a.co, p]);
    const reservedAfter = await reservedOf(a.uid);
    const acc = await accept(p);
    const freed = await reserve(a.co, q2, a.uid);
    const kept = await count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1 AND user_id=$2 AND accepted_at IS NULL", [a.co, p]);
    return full.outcome === "seat_limit_reached" && reservedAfter === 1 && acc.blocked.length === 1 && acc.blocked[0].code === "INVITATION_EXPIRED"
      && freed.outcome === "reserved" && kept === 1 ? true : JSON.stringify({ full, reservedAfter, acc, freed, kept });
  });
  await check("the account holder cancels a pending invitation: the seat is released at once, the invitation can no longer be accepted, the row is kept; nobody else can cancel it", async () => {
    const a = await account("PRACTICE", 1);
    const p = await mkUser("c"), q2 = await mkUser("c");
    const r = await reserve(a.co, p, a.uid);
    const byOther = (await one(user(U.outsider), "SELECT public.cancel_workspace_invitation($1) r", [r.member_id])).r;
    const byInvitee = (await one(user(p), "SELECT public.cancel_workspace_invitation($1) r", [r.member_id])).r;
    const cancel = (await one(user(a.uid), "SELECT public.cancel_workspace_invitation($1) r", [r.member_id])).r;
    const again = (await one(user(a.uid), "SELECT public.cancel_workspace_invitation($1) r", [r.member_id])).r;
    const acc = await accept(p);
    const next = await reserve(a.co, q2, a.uid);
    return byOther.outcome === "not_found" && byInvitee.outcome === "not_found" && cancel.outcome === "cancelled" && again.outcome === "already_cancelled"
      && acc.blocked[0]?.code === "INVITATION_CANCELLED" && next.outcome === "reserved"
      && (await count("SELECT count(*) n FROM public.firm_members WHERE id=$1", [r.member_id])) === 1 ? true : JSON.stringify({ byOther, byInvitee, cancel, again, acc, next });
  });
  await check("reissuing never double-reserves: the same person is one row; a valid invitation is refreshed, an expired or cancelled one is reissued only if a seat is free", async () => {
    const a = await account("PRACTICE", 1);
    const p = await mkUser("r"), q2 = await mkUser("r");
    const first = await reserve(a.co, p, a.uid);
    const again = await reserve(a.co, p, a.uid);
    const rows = await count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [a.co, p]);
    const reserved = await reservedOf(a.uid);
    await one(user(a.uid), "SELECT public.cancel_workspace_invitation($1) r", [first.member_id]);
    await reserve(a.co, q2, a.uid);                        // the released seat is taken by someone else
    const reissue = await reserve(a.co, p, a.uid);
    return first.outcome === "reserved" && again.outcome === "refreshed" && again.member_id === first.member_id && rows === 1 && reserved === 2
      && reissue.outcome === "seat_limit_reached" ? true : JSON.stringify({ first, again, rows, reserved, reissue });
  });
  await check("repeated invitation attempts cannot exhaust seats permanently: expired reservations hold nothing", async () => {
    const a = await account("PRACTICE", 2);
    for (let i = 0; i < 2; i++) await reserve(a.co, await mkUser("e"), a.uid);
    const blocked = await reserve(a.co, await mkUser("e"), a.uid);
    await admin.query("UPDATE public.firm_members SET invitation_expires_at = now() - interval '1 minute' WHERE company_id=$1 AND accepted_at IS NULL", [a.co]);
    const ok1 = await reserve(a.co, await mkUser("e"), a.uid);
    const ok2 = await reserve(a.co, await mkUser("e"), a.uid);
    return blocked.outcome === "seat_limit_reached" && ok1.outcome === "reserved" && ok2.outcome === "reserved";
  });
  await check("an email that could not be sent releases the reservation (release_workspace_invitation, service role only)", async () => {
    const a = await account("PRACTICE", 1);
    const p = await mkUser("m");
    const r = await reserve(a.co, p, a.uid);
    const clientCall = await codeOf(() => one(user(a.uid), "SELECT public.release_workspace_invitation($1) r", [r.member_id]));
    const rel = (await one(SERVICE, "SELECT public.release_workspace_invitation($1) r", [r.member_id])).r;
    const reserved = await reservedOf(a.uid);
    const reason = (await admin.query("SELECT invitation_cancel_reason x FROM public.firm_members WHERE id=$1", [r.member_id])).rows[0].x;
    return clientCall === "42501" && rel.outcome === "released" && reserved === 1 && reason === "EMAIL_FAILED" ? true : JSON.stringify({ clientCall, rel, reserved, reason });
  });
  await check(`${CONCURRENCY} simultaneous reservations (+2 seats): exactly 2; the same person reserved ${CONCURRENCY} times at once: one row`, async () => {
    const a = await account("PRACTICE", 2);
    const people = []; for (let i = 0; i < CONCURRENCY; i++) people.push(await mkUser("cc"));
    const out = await Promise.all(people.map((p) => reserve(a.co, p, a.uid)));
    const b = await account("PRACTICE", 2);
    const same = await mkUser("same");
    const out2 = await Promise.all(Array.from({ length: CONCURRENCY }, () => reserve(b.co, same, b.uid)));
    const rows = await count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [b.co, same]);
    return out.filter((o) => o.outcome === "reserved").length === 2 && out.filter((o) => o.outcome === "seat_limit_reached").length === CONCURRENCY - 2
      && rows === 1 && out2.filter((o) => o.outcome === "reserved").length === 1 ? true : JSON.stringify({ o1: out.map((o) => o.outcome), o2: out2.map((o) => o.outcome), rows });
  });
  await check("acceptance racing cancellation resolves to exactly one of them, never both", async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      const a = await account("PRACTICE", 1);
      const p = await mkUser("race");
      const r = await reserve(a.co, p, a.uid);
      const [acc, can] = await Promise.all([accept(p), one(user(a.uid), "SELECT public.cancel_workspace_invitation($1) r", [r.member_id]).then((x) => x.r)]);
      const row = (await admin.query("SELECT accepted_at, invitation_cancelled_at FROM public.firm_members WHERE id=$1", [r.member_id])).rows[0];
      const accepted = row.accepted_at !== null, cancelled = row.invitation_cancelled_at !== null;
      results.push(accepted !== cancelled && (accepted ? can.outcome === "not_pending" && acc.accepted.length === 1 : can.outcome === "cancelled"));
    }
    return results.every(Boolean) ? true : JSON.stringify(results);
  });

  group("P-05 — the official Reporting Pack: bound, short-lived, single-use, re-authorised at seal time, verifiable, audited");
  const issue = async (who, co, kind = "financial_statements_pdf", ref = "upload:p05", period = 2031, rid = uuid()) =>
    (await one(user(who), "SELECT public.issue_reporting_pack($1,$2,$3,$4,$5) r", [co, period, kind, ref, rid])).r;
  const seal = async (who, id, co, kind = "financial_statements_pdf", ref = "upload:p05", period = 2031, sha = "a".repeat(64)) =>
    (await one(user(who), "SELECT public.consume_reporting_pack_issuance($1,$2,$3,$4,$5,$6) r", [id, co, period, kind, ref, sha])).r;
  const pk = await account("PRACTICE", 1);
  const pkMember = await mkUser("pk");
  await addActive(pk.uid, pk.co, pkMember);
  const other = await account("PRACTICE", 0);
  await check("a Free workspace cannot obtain an issuance at all (and the refusal is audited)", async () => {
    const f = await account(null);
    const r = await issue(f.uid, f.co);
    return r.outcome === "entitlement_required" && (await count("SELECT count(*) n FROM public.reporting_pack_issuance_events WHERE company_id=$1 AND event='REFUSED'", [f.co])) === 1;
  });
  await check("sealing requires the same user, workspace, period, saved output and format: every other combination is refused", async () => {
    const i = await issue(pk.uid, pk.co);
    const otherUser = await seal(pkMember, i.issuance_id, pk.co);
    const otherWs = await seal(pk.uid, i.issuance_id, other.co);
    const otherPeriod = await seal(pk.uid, i.issuance_id, pk.co, "financial_statements_pdf", "upload:p05", 2030);
    const otherVersion = await seal(pk.uid, i.issuance_id, pk.co, "financial_statements_pdf", "upload:other");
    const otherFormat = await seal(pk.uid, i.issuance_id, pk.co, "financial_statements_spreadsheet");
    const csv = await seal(pk.uid, i.issuance_id, pk.co, "financial_statements_data");
    const ok = await seal(pk.uid, i.issuance_id, pk.co);
    return i.outcome === "issued" && otherUser.outcome === "not_found" && otherWs.outcome === "binding_mismatch" && otherPeriod.outcome === "binding_mismatch"
      && otherVersion.outcome === "binding_mismatch" && otherFormat.outcome === "binding_mismatch" && csv.outcome === "binding_mismatch" && ok.outcome === "sealed"
      ? true : JSON.stringify({ otherUser, otherWs, otherPeriod, otherVersion, otherFormat, csv, ok });
  });
  await check("an issuance cannot be replayed: a second seal, a re-issue with the same request id and different bindings, and an expired issuance are all refused", async () => {
    const rid = uuid();
    const i = await issue(pk.uid, pk.co, "board_pack", "upload:p05", 2031, rid);
    await seal(pk.uid, i.issuance_id, pk.co, "board_pack");
    const again = await seal(pk.uid, i.issuance_id, pk.co, "board_pack", "upload:p05", 2031, "c".repeat(64));
    const sameReq = await issue(pk.uid, pk.co, "board_pack", "upload:p05", 2031, rid);
    const conflict = await issue(pk.uid, pk.co, "client_pack", "upload:p05", 2031, rid);
    const e = await issue(pk.uid, pk.co, "client_pack");
    await admin.query("BEGIN"); await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("UPDATE public.reporting_pack_issuances SET expires_at = now() - interval '1 second' WHERE id=$1", [e.issuance_id]);
    await admin.query("COMMIT");
    const expired = await seal(pk.uid, e.issuance_id, pk.co, "client_pack");
    return again.outcome === "already_sealed" && sameReq.outcome === "already_issued" && sameReq.sealed === true && conflict.outcome === "request_conflict" && expired.outcome === "expired"
      ? true : JSON.stringify({ again, sameReq, conflict, expired });
  });
  await check("a downgrade between issue and generation is refused at seal time; so is a person suspended in between", async () => {
    const a = await account("PRACTICE", 1);
    const m = await mkUser("dg");
    await addActive(a.uid, a.co, m);
    const i = await issue(a.uid, a.co);
    const im = await issue(m, a.co, "financial_statements_spreadsheet");
    const r = await roster(a.uid);
    await choose(a.uid, [], r.roster_version);
    const memberSeal = await seal(m, im.issuance_id, a.co, "financial_statements_spreadsheet");
    await admin.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end=now() WHERE id=$1", [a.lic.id]);
    const holderSeal = await seal(a.uid, i.issuance_id, a.co);
    return memberSeal.outcome === "workspace_access_denied" && holderSeal.outcome === "entitlement_required" ? true : JSON.stringify({ memberSeal, holderSeal });
  });
  await check(`${CONCURRENCY} tabs sealing the same issuance at once: exactly one seal`, async () => {
    const i = await issue(pk.uid, pk.co, "tax_workpaper");
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, n) => seal(pk.uid, i.issuance_id, pk.co, "tax_workpaper", "upload:p05", 2031, n.toString(16).padStart(64, "0"))));
    return out.filter((o) => o.outcome === "sealed").length === 1 && out.filter((o) => o.outcome === "already_sealed").length === CONCURRENCY - 1;
  });
  await check("a saved financial-statements version must exist for the workspace and period; an unknown one is refused", async () =>
    (await issue(pk.uid, pk.co, "financial_statements_data", "fs-report:nope:v1")).outcome === "invalid_request"
    && (await issue(pk.uid, pk.co, "financial_statements_data", "")).outcome === "invalid_request");
  await check("verification: a sealed file is official for the workspace's members only; unsealed or unknown bytes never are", async () => {
    const sha = "d".repeat(64);
    const i = await issue(pk.uid, pk.co, "management_letter");
    await seal(pk.uid, i.issuance_id, pk.co, "management_letter", "upload:p05", 2031, sha);
    const member = (await one(user(pkMember), "SELECT public.verify_reporting_pack($1) r", [sha])).r;
    const outsider = (await one(user(U.outsider), "SELECT public.verify_reporting_pack($1) r", [sha])).r;
    const unknown = (await one(user(pk.uid), "SELECT public.verify_reporting_pack($1) r", ["e".repeat(64)])).r;
    const unsealed = await issue(pk.uid, pk.co, "management_letter");
    return member.official === true && member.pack_kind === "management_letter" && member.issuance_id === i.issuance_id
      && outsider.official === false && unknown.official === false && unsealed.outcome === "issued" ? true : JSON.stringify({ member, outsider, unknown });
  });
  await check("issuances and their audit events cannot be written, changed or deleted by clients or the service role; issuances change only by one seal", async () => {
    const i = await issue(pk.uid, pk.co, "filing_pack");
    const clientIns = await codeOf(() => q(user(pk.uid), "INSERT INTO public.reporting_pack_issuance_events (event) VALUES ('ISSUED')"));
    const svcIns = await codeOf(() => q(SERVICE, "INSERT INTO public.reporting_pack_issuance_events (event) VALUES ('ISSUED')"));
    const evUpd = await codeOf(() => admin.query("UPDATE public.reporting_pack_issuance_events SET event='SEALED' WHERE issuance_id=$1", [i.issuance_id]));
    const evDel = await codeOf(() => admin.query("DELETE FROM public.reporting_pack_issuance_events WHERE issuance_id=$1", [i.issuance_id]));
    const kindUpd = await codeOf(() => admin.query("UPDATE public.reporting_pack_issuances SET pack_kind='client_pack' WHERE id=$1", [i.issuance_id]));
    const extend = await codeOf(() => admin.query("UPDATE public.reporting_pack_issuances SET expires_at = now() + interval '1 day' WHERE id=$1", [i.issuance_id]));
    const events = await count("SELECT count(*) n FROM public.reporting_pack_issuance_events WHERE issuance_id=$1 AND event='ISSUED'", [i.issuance_id]);
    return clientIns === "42501" && svcIns === "42501" && evUpd === "P0001" && evDel === "P0001" && kindUpd === "P0001" && extend === "P0001" && events === 1
      ? true : JSON.stringify({ clientIns, svcIns, evUpd, evDel, kindUpd, extend, events });
  });

  group("Invariant and history across everything above");
  await check("for EVERY account: active named users <= included + purchased seats (or only the account holder when capacity is unknown)", async () => {
    const accounts = (await admin.query("SELECT DISTINCT user_id u FROM public.companies WHERE user_id IS NOT NULL")).rows.map((r) => r.u);
    const bad = []; for (const a of accounts) if (!(await invariant(a))) bad.push(a);
    return bad.length === 0 ? true : bad.join(",");
  });
  await check("no pre-existing audit row changed (billing audit and capability-grant events): later events are only appended", async () => {
    const now = await auditSnapshot();
    return JSON.stringify(now.slice(0, auditBefore.length)) === JSON.stringify(auditBefore) || auditBefore.every((row) => now.some((r) => JSON.stringify(r) === JSON.stringify(row)));
  });
  await check("the suspension and activity functions pin search_path, and clients can execute only the intended entry points", async () => {
    const rows = (await admin.query(`SELECT p.proname, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
      ('_account_named_user_access_active','named_user_access_active','_named_user_suspended','_named_user_roster','_apply_named_user_selection','choose_active_named_users',
       'get_named_user_roster','admin_prepare_planned_reduction','reconcile_named_user_allowance','reconcile_all_named_user_allowances','reserve_workspace_invitation',
       'release_workspace_invitation','cancel_workspace_invitation','consume_reporting_pack_issuance','verify_reporting_pack','issue_reporting_pack')`)).rows;
    const pinned = rows.every((r) => (r.proconfig ?? []).some((c) => c.startsWith("search_path=")));
    const byName = Object.fromEntries(rows.map((r) => [r.proname, r]));
    const clientOk = ["named_user_access_active", "choose_active_named_users", "get_named_user_roster", "admin_prepare_planned_reduction", "cancel_workspace_invitation", "consume_reporting_pack_issuance", "verify_reporting_pack", "issue_reporting_pack"];
    const internal = ["_account_named_user_access_active", "_named_user_suspended", "_named_user_roster", "_apply_named_user_selection", "reconcile_named_user_allowance", "reconcile_all_named_user_allowances", "reserve_workspace_invitation", "release_workspace_invitation"];
    return rows.length === 16 && pinned && rows.every((r) => !r.anon) && clientOk.every((n) => byName[n]?.auth) && internal.every((n) => byName[n] && !byName[n].auth)
      ? true : JSON.stringify(rows.map((r) => [r.proname, r.anon, r.auth]));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n──────────────────────────────────────────\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  console.log(failed.length === 0 ? "BILLING_SUSPENSION: ALL PASSED" : "BILLING_SUSPENSION: FAILED");
  return failed.length === 0;
}

let ok = false;
try { ok = await main(); } catch (e) { console.error(`FATAL: ${e?.stack ?? e}`); } finally { await stopDatabase(); }
process.exitCode = ok ? 0 : 1;
