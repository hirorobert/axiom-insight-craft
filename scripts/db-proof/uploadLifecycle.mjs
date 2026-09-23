#!/usr/bin/env node
// Real-PostgreSQL proof of the trial balance upload lifecycle migration (20260923100000).
//
// 1. Upgrade (B1): replays every migration BEFORE 20260923100000, seeds legacy uploads (zero, one and
//    several per period, certified and blocked history, an exact uploaded_at tie, NULL periods and derived
//    evidence), applies 20260923100000, and proves the backfill kept exactly the upload the pre-lifecycle
//    authority rule already treated as current and preserved everything.
// 2. Behaviour: USER-BASED authority (a solo owner with no firm_members row, explicit / missing / revoked
//    grants, titles that confer nothing, cross-workspace isolation), Storage-path binding, server-read
//    Storage evidence, B2-B4, audit identity and real concurrency. Every
//    concurrent request runs on its own connection and in its own transaction, as authenticated with
//    simulated JWT claims (the mechanism PostgREST uses).
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/uploadLifecycle.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY local database) also works.
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
const LIFECYCLE_FILE = "20260923100000_upload_lifecycle_retire_and_replace.sql";
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
async function refused(name, code, fn) {
  try {
    await fn();
    record(name, false, "no error was raised");
  } catch (e) {
    record(name, e.code === code, `expected ${code}, got ${e.code}: ${String(e.message).split("\n")[0]}`);
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
  if (MODE === "external") {
    assertLocal(process.env.DB_PROOF_CONN);
    return process.env.DB_PROOF_CONN;
  }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-lifecycle-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect();
  await boot.query("CREATE DATABASE lifecycle_proof");
  await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/lifecycle_proof`;
}

async function stopDatabase() {
  try { await pool?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  if (embeddedServer) { try { await embeddedServer.stop(); } catch { /* ignore */ } }
  if (embeddedDir) fs.rmSync(embeddedDir, { recursive: true, force: true });
}

const migrationFiles = () => fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
async function applyMigration(f) {
  let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
  if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  try { await admin.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
}

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
  } finally {
    c.release();
  }
}
const user = (uid) => ({ kind: "user", uid });
const ANON = { kind: "anon" };
const SERVICE = { kind: "service" };
const q = (caller, sql, params) => asCaller(caller, async (c) => (await c.query(sql, params)).rows);
const one = async (caller, sql, params) => (await q(caller, sql, params))[0];
const uuid = () => globalThis.crypto.randomUUID();
const count = async (sql, params = []) => Number((await admin.query(sql, params)).rows[0].n);
const row = async (id) => (await admin.query("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [id])).rows[0];

// Seeding (as the migration owner — fixtures only; every assertion goes through the real client paths).
async function seedUpload(company, { period = 2026, at = null, status = "processing", processed = false, userId = null } = {}) {
  const r = await admin.query(
    `INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, user_id, uploaded_at, processed_at)
     VALUES ($1, $2, 100, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), CASE WHEN $8 THEN now() END) RETURNING id`,
    [`tb-${uuid().slice(0, 6)}.csv`, `seed/${uuid()}.csv`, status, company, period, userId, at, processed]);
  return r.rows[0].id;
}
async function certify(company, upload, period, { blocking = false, review = false } = {}) {
  // As process-trial-balance does: the service role records the observed source hash, then certifies.
  const svc = await pool.connect();
  try {
    await svc.query("BEGIN; SET LOCAL ROLE service_role");
    await svc.query("UPDATE public.trial_balance_uploads SET source_file_hash='h' WHERE id=$1 AND source_file_hash IS NULL", [upload]);
    await svc.query("COMMIT");
  } catch (e) { await svc.query("ROLLBACK").catch(() => {}); throw e; } finally { svc.release(); }
  const run = (await admin.query(
    "INSERT INTO public.engine_runs (company_id, actor_type, firm_member_id, function_name, engine_version, status, period_year) VALUES ($1,CASE WHEN $2::uuid IS NULL THEN 'system' ELSE 'user' END,$2,'process-trial-balance','proof','running',$3) RETURNING id",
    [company, ownerMemberOf[company] ?? null, period])).rows[0].id;
  await admin.query("SELECT public.commit_tb_certification($1,'process-trial-balance',$2,$3,$4,'h','n','o',$5,$6,'[]'::jsonb,'[]'::jsonb)",
    [run, upload, company, period, blocking, review]);
}
const ownerMemberOf = {};

const discard = (caller, id, version) => one(caller, "SELECT * FROM public.discard_trial_balance_upload($1,$2)", [id, version]);
const complete = (caller, op) => one(caller, "SELECT * FROM public.complete_trial_balance_discard($1)", [op]);
const restore = (caller, op) => one(caller, "SELECT * FROM public.restore_trial_balance_upload($1)", [op]);
const retire = (caller, id, version, filePath) => one(caller, "SELECT * FROM public.retire_trial_balance_upload($1,$2,'replacement.csv',$3,200,'proof')", [id, version, filePath]);
const cancel = (caller, id, version) => one(caller, "SELECT * FROM public.cancel_trial_balance_replacement($1,$2)", [id, version]);
const confirmCleanup = (caller, op) => one(caller, "SELECT * FROM public.confirm_trial_balance_storage_cleanup($1)", [op]);
const activeCount = (company, period) => count(
  "SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1 AND period_year=$2 AND lifecycle_state IN ('active_unprocessed','active_processing','active_processed','blocked')", [company, period]);
const authoritative = async (company, period) => (await admin.query("SELECT upload_id FROM public.get_authoritative_certification($1,$2)", [company, period])).rows[0]?.upload_id ?? null;

const U = { solo: uuid(), owner: uuid(), collab: uuid(), admin: uuid(), revoked: uuid(), partnerTitle: uuid(), preparerTitle: uuid(), viewerTitle: uuid(), unrelated: uuid(), ownerB: uuid(), legacy: uuid() };

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: CONCURRENCY + 6 });

  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  // Mirror Supabase's defaults: client roles hold table/function privileges in public, so RLS, the lifecycle
  // guard and each function's own REVOKEs are the real boundary, as in production.
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);

  const files = migrationFiles();
  const cut = files.indexOf(LIFECYCLE_FILE);

  group("B1 — upgrade of an existing database");
  await check(`every migration before ${LIFECYCLE_FILE} applies on an empty PostgreSQL`, async () => {
    if (cut < 0) return "lifecycle migration not found";
    for (const f of files.slice(0, cut)) await applyMigration(f);
    return true;
  });

  await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,'legacy@example.test')", [U.legacy]);
  const L = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Legacy Co') RETURNING id", [U.legacy])).rows[0].id;
  ownerMemberOf[L] = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND role='owner'", [L])).rows[0].id;
  const t0 = new Date("2026-01-01T00:00:00Z").getTime();
  const at = (min) => new Date(t0 + min * 60000).toISOString();
  // 2025: exactly one upload, certified clean.
  const one2025 = await seedUpload(L, { period: 2025, at: at(1), status: "complete", processed: true });
  await certify(L, one2025, 2025);
  // 2023: three uploads — oldest certified clean, middle certified blocking, newest never processed.
  const old2023 = await seedUpload(L, { period: 2023, at: at(1), status: "complete", processed: true });
  await certify(L, old2023, 2023);
  const mid2023 = await seedUpload(L, { period: 2023, at: at(2), status: "blocked", processed: true });
  await certify(L, mid2023, 2023, { blocking: true });
  const new2023 = await seedUpload(L, { period: 2023, at: at(3), status: "processing" });
  // Derived evidence on a non-current upload: must survive the backfill untouched.
  await admin.query("INSERT INTO public.upload_integrity_findings (upload_id, company_id, issue_type) VALUES ($1, $2, 'ENGAGEMENT_COMPANY_MISMATCH')", [old2023, L]);
  // 2022: two uploads with an EXACT uploaded_at tie.
  const tieA = await seedUpload(L, { period: 2022, at: at(5) });
  const tieB = await seedUpload(L, { period: 2022, at: at(5) });
  const tieWinner = tieA > tieB ? tieA : tieB;
  const tieLoser = tieA > tieB ? tieB : tieA;
  // 2021: processed but never certified.
  const proc2021 = await seedUpload(L, { period: 2021, at: at(1), status: "error", processed: true });
  // Legacy rows without a period: never ranked, never retired.
  const noPeriodA = await seedUpload(L, { period: null, at: at(1) });
  const noPeriodB = await seedUpload(L, { period: null, at: at(2), status: "complete", processed: true });

  const beforeCerts = await count("SELECT count(*) n FROM public.tb_certifications");
  const beforeUploads = await count("SELECT count(*) n FROM public.trial_balance_uploads");
  const beforeDerived = await count("SELECT count(*) n FROM public.upload_integrity_findings");
  const beforeAuth = {};
  for (const p of [2021, 2022, 2023, 2024, 2025]) beforeAuth[p] = await authoritative(L, p);

  await check(`${LIFECYCLE_FILE} applies over the legacy data`, async () => { await applyMigration(LIFECYCLE_FILE); return true; });
  await check("every later migration also applies", async () => { for (const f of files.slice(cut + 1)) await applyMigration(f); return true; });

  await check("nothing was deleted: uploads, certifications and derived evidence are all preserved", async () =>
    (await count("SELECT count(*) n FROM public.trial_balance_uploads")) === beforeUploads
    && (await count("SELECT count(*) n FROM public.tb_certifications")) === beforeCerts
    && beforeDerived === 1 && (await count("SELECT count(*) n FROM public.upload_integrity_findings")) === beforeDerived);
  await check("zero uploads in a period: nothing active, nothing invented", async () => (await activeCount(L, 2024)) === 0);
  await check("one upload in a period: it stays active in its certified state (active_processed)", async () =>
    (await row(one2025)).lifecycle_state === "active_processed");
  await check("several uploads: exactly the latest (by uploaded_at, then id) stays active; the rest are retired", async () => {
    const [o, m, n] = [await row(old2023), await row(mid2023), await row(new2023)];
    return n.lifecycle_state === "active_unprocessed" && o.lifecycle_state === "retired" && m.lifecycle_state === "retired" && (await activeCount(L, 2023)) === 1;
  });
  await check("retired legacy uploads carry an explicit migration reason and NO invented supersession link", async () => {
    const o = await row(old2023);
    return /Lifecycle migration 20260923100000/.test(o.retired_reason ?? "") && o.superseded_by_upload_id === null && o.replaces_upload_id === null;
  });
  await check("an exact uploaded_at tie resolves by id DESC, exactly as get_authoritative_certification already did", async () =>
    (await row(tieWinner)).lifecycle_state === "active_unprocessed" && (await row(tieLoser)).lifecycle_state === "retired");
  await check("processed-but-uncertified legacy upload becomes active_processing", async () => (await row(proc2021)).lifecycle_state === "active_processing");
  await check("uploads without a period_year are never ranked or retired", async () =>
    (await row(noPeriodA)).lifecycle_state === "active_unprocessed" && (await row(noPeriodB)).lifecycle_state === "active_processing");
  await check("authoritative certification per period is unchanged by the upgrade", async () => {
    for (const p of [2021, 2022, 2023, 2024, 2025]) { const now = await authoritative(L, p); if (now !== beforeAuth[p]) return `period ${p}: before ${beforeAuth[p]} after ${now}`; }
    return beforeAuth[2025] === null ? "fixture: expected a certified 2025" : true;
  });
  await check("the unique index exists and no period has two active uploads", async () =>
    (await count("SELECT count(*) n FROM pg_indexes WHERE indexname='uq_one_active_upload_per_period'")) === 1
    && (await count("SELECT count(*) n FROM (SELECT 1 FROM public.trial_balance_uploads WHERE lifecycle_state IN ('active_unprocessed','active_processing','active_processed','blocked') AND company_id IS NOT NULL AND period_year IS NOT NULL GROUP BY company_id, period_year HAVING count(*)>1) d")) === 0);
  await check("every legacy upload has a migration event on the audit trail", async () =>
    (await count("SELECT count(*) n FROM public.trial_balance_upload_lifecycle_events WHERE actor_kind='migration' AND company_id=$1", [L])) === beforeUploads);
  await check("the fail-closed assertion is present before the index", async () => {
    const sql = fs.readFileSync(path.join(REPO, "supabase/migrations", LIFECYCLE_FILE), "utf8");
    return sql.indexOf("still have more than one active upload") > 0 && sql.indexOf("still have more than one active upload") < sql.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_upload_per_period");
  });

  // ── Behaviour (user-based authority, workspace-scoped sources) ─────────────────────────────
  for (const [k, id] of Object.entries(U)) if (k !== "legacy") await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  // SOLO: a workspace whose owner has NO firm_members row. Company creation auto-creates an owner membership
  // (create_owner_firm_member) and trg_prevent_last_owner_delete protects it. In this throwaway database only,
  // the fixture removes that row with triggers suspended for the one statement, so the proof shows authority
  // never needs it.
  const S = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Solo workspace') RETURNING id", [U.solo])).rows[0].id;
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query("DELETE FROM public.firm_members WHERE company_id = $1", [S]);
  await admin.query("COMMIT");
  const C = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Team workspace') RETURNING id", [U.owner])).rows[0].id;
  const B = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Other workspace') RETURNING id", [U.ownerB])).rows[0].id;
  ownerMemberOf[C] = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND role='owner'", [C])).rows[0].id;
  for (const [k, role] of [["partnerTitle", "partner"], ["preparerTitle", "preparer"], ["viewerTitle", "viewer"]]) {
    await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [C, U[k], role]);
  }

  // storage.objects in this harness; the signed upload / service-role deletion are the Edge Functions' job.
  const putObject = async (path) => (await admin.query("INSERT INTO storage.objects (bucket_id, name) VALUES ('trial-balance-files', $1) RETURNING id", [path])).rows[0].id;
  const deleteObject = (path) => admin.query("DELETE FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [path]);
  const objectId = async (path) => (await admin.query("SELECT id FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [path])).rows[0]?.id ?? null;
  const objectExists = async (path) => (await objectId(path)) !== null;
  const reserve = (who, company, name = "tb.csv") => one(user(who), "SELECT * FROM public.reserve_trial_balance_source($1,$2)", [company, name]);
  const register = (who, reservation, period) => one(user(who), "SELECT * FROM public.register_trial_balance_upload($1,10,$2,NULL,NULL)", [reservation, period]);
  // The workspace-scoped browser path: reserve → (signed upload of exactly that object) → register.
  const workspaceUpload = async (company, period, who = U.owner) => {
    const r = await reserve(who, company);
    if (r.outcome !== "reserved") throw Object.assign(new Error(`reserve ${r.outcome}`), { outcome: r.outcome });
    const objId = await putObject(r.object_path);
    const g = await register(who, r.reservation_id, period);
    if (g.outcome !== "registered") throw Object.assign(new Error(`register ${g.outcome}`), { outcome: g.outcome });
    return { id: g.upload_id, path: r.object_path, objectId: objId, reservation: r.reservation_id };
  };
  // The LEGACY browser path (before workspace-scoped storage): the owner's own folder plus a direct insert.
  const legacyUpload = async (company, period, who = U.owner) => {
    const path = `${who}/${uuid()}.csv`; await putObject(path);
    const id = (await one(user(who),
      "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('legacy.csv',$1,10,'processing',$2,$3,$4) RETURNING id",
      [path, who, company, period])).id;
    return { id, path };
  };
  const reservedReplacement = async (who, company) => { const r = await reserve(who, company, "replacement.csv"); await putObject(r.object_path); return r; };
  const retireWith = (who, id, version, reservation) => one(user(who), "SELECT * FROM public.retire_trial_balance_upload($1,$2,$3,200,'proof')", [id, version, reservation]);
  const purge = (caller, op) => one(caller, "SELECT * FROM public.purge_trial_balance_discard($1)", [op]);
  const expire = (op) => admin.query("UPDATE public.trial_balance_upload_operations SET completed_at = now() - interval '11 minutes' WHERE id=$1", [op]);
  const grant = (caller, company, grantee, cap) => one(caller, "SELECT * FROM public.grant_workspace_capability($1,$2,$3)", [company, grantee, cap]);
  const revoke = (caller, company, grantee, cap) => one(caller, "SELECT * FROM public.revoke_workspace_capability($1,$2,$3)", [company, grantee, cap]);
  const can = async (u, company, cap) => (await admin.query("SELECT public.can_user_act_on_workspace($1,$2,$3) r", [u, company, cap])).rows[0].r;
  const discardFully = async (who, id) => { const b = await discard(user(who), id, Number((await row(id)).version)); const c = await complete(user(who), b.operation_id); return { b, c }; };

  group("THE predicate — ownership or an explicit grant; never a title, never anonymous");
  await check("the solo workspace really has no firm_members row", async () => (await count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1", [S])) === 0);
  await check("solo owner: true for every valid capability", async () => {
    for (const cap of ["manage_source_files", "prepare_trial_balance", "review_close", "administer_workspace"]) if (!(await can(U.solo, S, cap))) return cap;
    return true;
  });
  await check("owner true; anonymous, unrelated, other workspace, unknown capability false", async () =>
    (await can(U.owner, C, "manage_source_files")) === true && (await can(null, C, "manage_source_files")) === false
    && (await can(U.unrelated, C, "manage_source_files")) === false && (await can(U.owner, B, "manage_source_files")) === false
    && (await can(U.owner, C, "delete_everything")) === false);
  await check("an accepted partner / preparer / viewer TITLE confers nothing", async () =>
    !(await can(U.partnerTitle, C, "manage_source_files")) && !(await can(U.preparerTitle, C, "manage_source_files")) && !(await can(U.viewerTitle, C, "manage_source_files")));
  await check("the predicate never reads firm_members or any occupational title", async () => {
    const src = (await admin.query("SELECT string_agg(pg_get_functiondef(p.oid), ' ') s FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('workspace_authority_basis','can_user_act_on_workspace')")).rows[0].s;
    return !/firm_members|partner|manager|preparer|'owner'/.test(src);
  });
  await refused("authenticated cannot call the predicate with an arbitrary user id", "42501", () => q(user(U.owner), "SELECT public.can_user_act_on_workspace($1,$2,'manage_source_files')", [U.solo, S]));
  await refused("anonymous cannot call any lifecycle RPC", "42501", () => q(ANON, "SELECT * FROM public.reserve_trial_balance_source($1,'x.csv')", [C]));

  group("Grants — owner only, idempotent, one active grant, revocable, audited");
  await check("owner grants manage_source_files to the collaborator (idempotent)", async () =>
    (await grant(user(U.owner), C, U.collab, "manage_source_files")).outcome === "granted" && (await grant(user(U.owner), C, U.collab, "manage_source_files")).outcome === "already_granted");
  await check("non-owners cannot grant, even holding administer_workspace; cross-workspace refused", async () => {
    await grant(user(U.owner), C, U.admin, "administer_workspace");
    return (await grant(user(U.admin), C, U.unrelated, "manage_source_files")).outcome === "forbidden"
      && (await grant(user(U.collab), C, U.unrelated, "manage_source_files")).outcome === "forbidden"
      && (await grant(user(U.ownerB), C, U.ownerB, "manage_source_files")).outcome === "forbidden";
  });
  await check("unknown capability / invalid grantee fail closed", async () =>
    (await grant(user(U.owner), C, U.collab, "delete_everything")).outcome === "invalid_capability"
    && (await grant(user(U.owner), C, uuid(), "manage_source_files")).outcome === "invalid_grantee");
  await refused("the database enforces ONE active grant (23505)", "23505", () => admin.query(
    "INSERT INTO public.workspace_capability_grants (company_id, grantee_user_id, capability, granted_by_user_id) VALUES ($1,$2,'manage_source_files',$3)", [C, U.collab, U.owner]));

  group("NORMAL UPLOAD — workspace-scoped, for the owner AND a granted collaborator");
  await check("solo owner (no membership) uploads through a reservation; the object lives in the WORKSPACE, not a personal folder", async () => {
    const u = await workspaceUpload(S, 2030, U.solo);
    const r = await row(u.id);
    return r.file_path === u.path && u.path.startsWith(`workspaces/${S}/`) && r.user_id === U.solo && r.lifecycle_state === "active_unprocessed";
  });
  await check("a GRANTED collaborator (no firm membership) performs a normal upload", async () => {
    const u = await workspaceUpload(C, 2031, U.collab);
    const r = await row(u.id);
    return r.user_id === U.collab && r.company_id === C && u.path.startsWith(`workspaces/${C}/`);
  });
  await check("a partner-titled member / unrelated user / other-workspace owner cannot even reserve", async () =>
    (await reserve(U.partnerTitle, C)).outcome === "forbidden" && (await reserve(U.unrelated, C)).outcome === "forbidden" && (await reserve(U.ownerB, C)).outcome === "forbidden");
  await check("the server derives the path: a hostile file name cannot escape the workspace folder", async () => {
    const r = await reserve(U.owner, C, "../../other-workspace/../evil name.csv");
    return r.outcome === "reserved" && r.object_path.startsWith(`workspaces/${C}/`) && !r.object_path.includes("..") && r.object_path.split("/").length === 4;
  });
  await check("register refuses an object that never reached storage (object_missing)", async () => {
    const r = await reserve(U.owner, C);
    return (await register(U.owner, r.reservation_id, 2032)).outcome === "object_missing";
  });
  await check("a reservation is personal: another authorized user cannot consume it", async () => {
    const r = await reserve(U.owner, C); await putObject(r.object_path);
    return (await register(U.collab, r.reservation_id, 2033)).outcome === "forbidden";
  });
  await check("a reservation is single-use: registering twice returns the same upload (idempotent)", async () => {
    const r = await reserve(U.owner, C); await putObject(r.object_path);
    const a = await register(U.owner, r.reservation_id, 2034); const b = await register(U.owner, r.reservation_id, 2034);
    return a.outcome === "registered" && b.outcome === "already_registered" && b.upload_id === a.upload_id;
  });
  await check("an expired reservation is refused", async () => {
    const r = await reserve(U.owner, C); await putObject(r.object_path);
    await admin.query("UPDATE public.trial_balance_source_reservations SET expires_at = now() - interval '1 minute' WHERE id=$1", [r.reservation_id]);
    return (await register(U.owner, r.reservation_id, 2035)).outcome === "expired";
  });
  await check("a second active upload for the same period is refused with a named outcome", async () => {
    const r = await reserve(U.owner, C); await putObject(r.object_path);
    return (await register(U.owner, r.reservation_id, 2031)).outcome === "active_upload_exists";
  });
  await check("a revoked collaborator cannot reserve or register", async () => {
    await grant(user(U.owner), C, U.revoked, "manage_source_files");
    const r = await reserve(U.revoked, C); await putObject(r.object_path);
    await revoke(user(U.owner), C, U.revoked, "manage_source_files");
    return (await register(U.revoked, r.reservation_id, 2036)).outcome === "forbidden" && (await reserve(U.revoked, C)).outcome === "forbidden";
  });
  await refused("clients cannot read or write reservations directly", "42501", () => q(user(U.owner), "SELECT * FROM public.trial_balance_source_reservations"));

  group("UNDO — the source is retained; any authorized user restores the exact object");
  await check("same-user Undo: the exact object (same storage id) is restored, nothing re-uploaded", async () => {
    const u = await workspaceUpload(C, 2040, U.owner);
    const { b, c } = await discardFully(U.owner, u.id);
    const retained = await objectId(u.path);
    const r = await restore(user(U.owner), b.operation_id);
    return c.outcome === "deleted_now" && retained === u.objectId && r.outcome === "restored" && (await row(u.id))?.file_path === u.path && (await objectId(u.path)) === u.objectId;
  });
  await check("owner Undo of a COLLABORATOR's upload", async () => {
    const u = await workspaceUpload(C, 2041, U.collab);
    const { b } = await discardFully(U.collab, u.id);
    return (await restore(user(U.owner), b.operation_id)).outcome === "restored" && (await objectId(u.path)) === u.objectId && (await row(u.id)).user_id === U.collab;
  });
  await check("collaborator Undo of the OWNER's upload", async () => {
    const u = await workspaceUpload(C, 2042, U.owner);
    const { b } = await discardFully(U.owner, u.id);
    return (await restore(user(U.collab), b.operation_id)).outcome === "restored" && (await objectId(u.path)) === u.objectId;
  });
  await check("the restored row is the exact original (id, path, uploaded_at, source hash)", async () => {
    const u = await workspaceUpload(C, 2043, U.owner);
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET source_file_hash='sha-original' WHERE id=$1", [u.id]).catch(() => {});
    const before = await row(u.id);
    const b = await discard(user(U.owner), u.id, Number(before.version));
    if (b.outcome !== "discard_pending") {
      // A hashed upload is processed, so it cannot be hard-discarded; prove identity on an unhashed one instead.
      const v = await workspaceUpload(C, 2044, U.owner); const bv = await row(v.id);
      const { b: b2 } = await discardFully(U.owner, v.id); await restore(user(U.owner), b2.operation_id);
      const after = await row(v.id);
      return after.id === bv.id && after.file_path === bv.file_path && String(after.uploaded_at) === String(bv.uploaded_at) && after.user_id === bv.user_id && after.source_file_hash === bv.source_file_hash;
    }
    return false;
  });
  await check("repeated Undo: already_restored (proved against the exact row)", async () => {
    const u = await workspaceUpload(C, 2045, U.owner); const { b } = await discardFully(U.owner, u.id);
    return (await restore(user(U.owner), b.operation_id)).outcome === "restored" && (await restore(user(U.collab), b.operation_id)).outcome === "already_restored";
  });
  await check(`concurrent Undo (${CONCURRENCY} callers, owner and collaborator): exactly one restores`, async () => {
    const u = await workspaceUpload(C, 2046, U.owner); const { b } = await discardFully(U.owner, u.id);
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => restore(user(i % 2 ? U.collab : U.owner), b.operation_id)));
    return out.filter((o) => o.outcome === "restored").length === 1 && out.filter((o) => o.outcome === "already_restored").length === CONCURRENCY - 1 && (await activeCount(C, 2046)) === 1;
  });
  await check("Undo after a new active upload: explicit conflict; the new upload unchanged", async () => {
    const u = await workspaceUpload(C, 2047, U.owner); const { b } = await discardFully(U.owner, u.id);
    const n = await workspaceUpload(C, 2047, U.collab); const before = JSON.stringify(await row(n.id));
    const r = await restore(user(U.owner), b.operation_id);
    return r.outcome === "conflict_new_active_upload" && JSON.stringify(await row(n.id)) === before && (await activeCount(C, 2047)) === 1;
  });
  await check("expired Undo is refused", async () => {
    const u = await workspaceUpload(C, 2048, U.owner); const { b } = await discardFully(U.owner, u.id);
    await expire(b.operation_id);
    return (await restore(user(U.owner), b.operation_id)).outcome === "expired";
  });
  await check("a partner-titled member / unrelated user / other workspace cannot Undo", async () => {
    const u = await workspaceUpload(C, 2049, U.owner); const { b } = await discardFully(U.owner, u.id);
    return (await restore(user(U.partnerTitle), b.operation_id)).outcome === "forbidden" && (await restore(user(U.unrelated), b.operation_id)).outcome === "forbidden"
      && (await restore(user(U.ownerB), b.operation_id)).outcome === "forbidden";
  });

  group("PURGE — only after the operation is terminal; never an unrelated object");
  await check("purge is refused while the discard is still restorable (undo_window_open), and the source survives", async () => {
    const u = await workspaceUpload(C, 2050, U.owner); const { b } = await discardFully(U.owner, u.id);
    return (await purge(user(U.owner), b.operation_id)).outcome === "undo_window_open" && (await objectExists(u.path));
  });
  await check("a restored discard is never purgeable", async () => {
    const u = await workspaceUpload(C, 2051, U.owner); const { b } = await discardFully(U.owner, u.id);
    await restore(user(U.owner), b.operation_id); await expire(b.operation_id);
    return (await purge(user(U.owner), b.operation_id)).outcome === "not_purgeable" && (await objectExists(u.path));
  });
  await check("after the window: listed as purgeable; the purge is recorded only once the object is gone", async () => {
    const u = await workspaceUpload(C, 2052, U.collab); const { b } = await discardFully(U.collab, u.id);
    await expire(b.operation_id);
    const listed = (await q(user(U.owner), "SELECT operation_id FROM public.list_purgeable_trial_balance_sources($1)", [C])).map((x) => x.operation_id);
    const early = (await purge(user(U.owner), b.operation_id)).outcome;
    await deleteObject(u.path);
    const done = (await purge(user(U.owner), b.operation_id)).outcome;
    return listed.includes(b.operation_id) && early === "storage_cleanup_pending" && done === "purged"
      && (await purge(user(U.owner), b.operation_id)).outcome === "already_purged" && (await restore(user(U.owner), b.operation_id)).outcome === "expired";
  });
  await check("the cleanup target marks a discard deletable ONLY when terminal", async () => {
    const u = await workspaceUpload(C, 2053, U.owner); const { b } = await discardFully(U.owner, u.id);
    const t1 = (await admin.query("SELECT deletion_eligible FROM public.tbu_storage_cleanup_target($1)", [b.operation_id])).rows[0].deletion_eligible;
    await expire(b.operation_id);
    const t2 = (await admin.query("SELECT deletion_eligible FROM public.tbu_storage_cleanup_target($1)", [b.operation_id])).rows[0].deletion_eligible;
    return t1 === false && t2 === true;
  });
  await check("unauthorized users cannot list or purge", async () => {
    const listed = await q(user(U.unrelated), "SELECT operation_id FROM public.list_purgeable_trial_balance_sources($1)", [C]);
    const u = await workspaceUpload(C, 2054, U.owner); const { b } = await discardFully(U.owner, u.id); await expire(b.operation_id);
    return listed.length === 0 && (await purge(user(U.partnerTitle), b.operation_id)).outcome === "forbidden";
  });
  await check("a forged row pointing at another workspace's object is never bound, so nothing unrelated can be deleted or restored", async () => {
    const victim = await workspaceUpload(B, 2055, U.ownerB);
    const attacker = (await one(user(U.unrelated), "INSERT INTO public.companies (user_id,name) VALUES ($1,'Attacker') RETURNING id", [U.unrelated])).id;
    const forged = (await one(user(U.unrelated),
      "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('x',$1,1,'processing',$2,$3,2055) RETURNING id",
      [victim.path, U.unrelated, attacker])).id;
    const b = await discard(user(U.unrelated), forged, 1);
    const op = (await admin.query("SELECT file_path FROM public.trial_balance_upload_operations WHERE id=$1", [b.operation_id])).rows[0];
    return b.file_path === null && op.file_path === null && (await objectExists(victim.path));
  });

  group("LEGACY — uploader-folder objects stay fully manageable");
  await check("a legacy upload is discarded, restored and purged; its path is bound", async () => {
    const u = await legacyUpload(C, 2060, U.owner);
    const { b } = await discardFully(U.owner, u.id);
    const op = (await admin.query("SELECT file_path FROM public.trial_balance_upload_operations WHERE id=$1", [b.operation_id])).rows[0];
    const r = await restore(user(U.collab), b.operation_id);
    const { b: b2 } = await discardFully(U.owner, u.id); await expire(b2.operation_id); await deleteObject(u.path);
    return op.file_path === u.path && r.outcome === "restored" && (await purge(user(U.owner), b2.operation_id)).outcome === "purged";
  });

  group("REPLACE / CANCEL — workspace-scoped replacements, cross-uploader");
  const base = await workspaceUpload(C, 2070, U.owner); await certify(C, base.id, 2070);
  const certsBefore = await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [base.id]);
  let rep1;
  await check("the COLLABORATOR replaces the owner's certified upload with a workspace-scoped source; evidence untouched, one active", async () => {
    const r = await reservedReplacement(U.collab, C);
    const x = await retireWith(U.collab, base.id, Number((await row(base.id)).version), r.reservation_id); rep1 = { id: x.new_upload_id, path: r.object_path, reservation: r.reservation_id };
    const n = await row(rep1.id);
    return x.outcome === "replaced" && n.file_path === r.object_path && n.user_id === U.collab && (await row(base.id)).lifecycle_state === "superseded"
      && (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [base.id])) === certsBefore && (await activeCount(C, 2070)) === 1;
  });
  await check("retry with the same reservation → same replacement; another reservation → stale_version", async () => {
    const other = await reservedReplacement(U.owner, C);
    return (await retireWith(U.collab, base.id, 1, rep1.reservation)).new_upload_id === rep1.id && (await retireWith(U.owner, base.id, 1, other.reservation_id)).outcome === "stale_version";
  });
  await check("a reservation from another workspace, another user, or already used cannot replace", async () => {
    const u = await workspaceUpload(C, 2071, U.owner); await certify(C, u.id, 2071); const v = Number((await row(u.id)).version);
    const otherWs = await reservedReplacement(U.ownerB, B);
    const otherUser = await reservedReplacement(U.collab, C);
    return (await retireWith(U.owner, u.id, v, otherWs.reservation_id)).outcome === "forbidden"
      && (await retireWith(U.owner, u.id, v, otherUser.reservation_id)).outcome === "forbidden"
      && (await retireWith(U.owner, u.id, v, rep1.reservation)).outcome === "forbidden";
  });
  await check("the OWNER cancels the collaborator's replacement; server-side cleanup of the collaborator's workspace object; certified original restored", async () => {
    const c = await cancel(user(U.owner), rep1.id, Number((await row(rep1.id)).version));
    const op = (await admin.query("SELECT file_path FROM public.trial_balance_upload_operations WHERE id=$1", [c.operation_id])).rows[0];
    const pending = (await confirmCleanup(user(U.owner), c.operation_id)).outcome;
    await deleteObject(rep1.path);
    return c.outcome === "cancelled" && op.file_path === rep1.path && pending === "storage_cleanup_pending"
      && (await confirmCleanup(user(U.owner), c.operation_id)).outcome === "completed" && (await row(base.id)).lifecycle_state === "active_processed"
      && (await authoritative(C, 2070)) === base.id && (await activeCount(C, 2070)) === 1;
  });
  await check("a processed replacement cannot be cancelled or hard-deleted; it must itself be retired", async () => {
    const r = await reservedReplacement(U.owner, C);
    const x = await retireWith(U.owner, base.id, Number((await row(base.id)).version), r.reservation_id);
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [x.new_upload_id]);
    const v = Number((await row(x.new_upload_id)).version);
    const r2 = await reservedReplacement(U.owner, C);
    return (await cancel(user(U.owner), x.new_upload_id, v)).outcome === "replacement_processed" && (await discard(user(U.owner), x.new_upload_id, v)).outcome === "replacement_required"
      && (await retireWith(U.owner, x.new_upload_id, v, r2.reservation_id)).outcome === "replaced" && (await activeCount(C, 2070)) === 1;
  });

  group("B2 and server-authoritative lifecycle columns");
  const u2 = await workspaceUpload(C, 2080, U.owner);
  await check("processing start → active_processing (engine event); blocking → blocked; clean → active_processed", async () => {
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [u2.id]); const a = (await row(u2.id)).lifecycle_state;
    await certify(C, u2.id, 2080, { blocking: true }); const b = (await row(u2.id)).lifecycle_state;
    await certify(C, u2.id, 2080); const c = (await row(u2.id)).lifecycle_state;
    return a === "active_processing" && b === "blocked" && c === "active_processed" && (await discard(user(U.owner), u2.id, 1)).outcome === "replacement_required";
  });
  await refused("a client cannot set lifecycle_state directly (42501)", "42501", () => q(user(U.owner), "UPDATE public.trial_balance_uploads SET lifecycle_state='retired' WHERE id=$1", [u2.id]));
  await check("derived evidence alone refuses a hard discard", async () => {
    const u = await workspaceUpload(C, 2081, U.owner);
    await admin.query("INSERT INTO public.upload_integrity_findings (upload_id, company_id, issue_type) VALUES ($1, $2, 'ENGAGEMENT_COMPANY_MISMATCH')", [u.id, C]);
    return (await discard(user(U.owner), u.id, 1)).outcome === "replacement_required";
  });

  group(`Concurrency — ${CONCURRENCY} simultaneous requests on separate connections`);
  await check(`${CONCURRENCY} concurrent completions of one discard: exactly one deletes the row`, async () => {
    const u = await workspaceUpload(C, 2090, U.owner); const b = await discard(user(U.owner), u.id, 1);
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => complete(user(U.owner), b.operation_id)));
    return out.filter((o) => o.outcome === "deleted_now").length === 1 && out.filter((o) => o.outcome === "already_discarded").length === CONCURRENCY - 1;
  });
  await check(`${CONCURRENCY} concurrent replaces with DIFFERENT reservations: one wins, the rest stale_version`, async () => {
    const u = await workspaceUpload(C, 2091, U.owner); await certify(C, u.id, 2091); const v = Number((await row(u.id)).version);
    const rs = []; for (let i = 0; i < CONCURRENCY; i++) rs.push(await reservedReplacement(U.owner, C));
    const out = await Promise.all(rs.map((r) => retireWith(U.owner, u.id, v, r.reservation_id)));
    return out.filter((o) => o.outcome === "replaced").length === 1 && out.filter((o) => o.outcome === "stale_version").length === CONCURRENCY - 1 && (await activeCount(C, 2091)) === 1;
  });
  await check(`${CONCURRENCY} concurrent grants converge on ONE active grant`, async () => {
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => grant(user(U.owner), C, U.unrelated, "review_close")));
    return out.filter((o) => o.outcome === "granted").length === 1;
  });

  group("Privileges and audit immutability");
  await check("client RPCs are executable by authenticated and NOT by anon", async () => {
    const fns = ["discard_trial_balance_upload(uuid,bigint)", "complete_trial_balance_discard(uuid)", "restore_trial_balance_upload(uuid)",
      "retire_trial_balance_upload(uuid,bigint,uuid,integer,text)", "cancel_trial_balance_replacement(uuid,bigint)", "confirm_trial_balance_storage_cleanup(uuid)",
      "grant_workspace_capability(uuid,uuid,text)", "revoke_workspace_capability(uuid,uuid,text)", "reserve_trial_balance_source(uuid,text)",
      "register_trial_balance_upload(uuid,integer,integer,uuid,uuid)", "list_purgeable_trial_balance_sources(uuid)", "purge_trial_balance_discard(uuid)"];
    for (const f of fns) {
      const r = (await admin.query(`SELECT has_function_privilege('authenticated','public.${f}','EXECUTE') a, has_function_privilege('anon','public.${f}','EXECUTE') n`)).rows[0];
      if (!r.a || r.n) return f;
    }
    return true;
  });
  await check("the predicate, storage probe, cleanup and reservation targets are service_role-only", async () => {
    for (const f of ["can_user_act_on_workspace(uuid,uuid,text)", "workspace_authority_basis(uuid,uuid,text)", "tbu_storage_object_exists(text)", "tbu_storage_cleanup_target(uuid)", "tbu_source_reservation_target(uuid)", "tbu_authorize(uuid)"]) {
      const r = (await admin.query(`SELECT has_function_privilege('authenticated','public.${f}','EXECUTE') a, has_function_privilege('anon','public.${f}','EXECUTE') n`)).rows[0];
      if (r.a || r.n) return f;
    }
    return true;
  });
  await check("every SECURITY DEFINER function in the lifecycle migration pins its search_path", async () =>
    (await count(`SELECT count(*) n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.prosecdef
      AND (p.proname LIKE 'tbu_%' OR p.proname LIKE '%trial_balance_%' OR p.proname LIKE '%workspace_%' OR p.proname = 'tb_certification_drives_upload_lifecycle')
      AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')`)) === 0);
  await refused("lifecycle events are append-only (23001)", "23001", () => admin.query("UPDATE public.trial_balance_upload_lifecycle_events SET reason='x' WHERE id=(SELECT id FROM public.trial_balance_upload_lifecycle_events LIMIT 1)"));
  await check("solo and collaborator events: actor_user_id is the actor, membership NULL, basis recorded", async () => {
    const solo = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE company_id=$1 AND actor_kind='user'", [S])).rows;
    const collab = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE actor_user_id=$1 AND outcome='applied'", [U.collab])).rows;
    return solo.length >= 1 && solo.every((e) => e.authority_basis === "workspace_owner" && e.actor_membership_id === null)
      && collab.length >= 3 && collab.every((e) => e.authority_basis === "explicit_capability" && e.actor_membership_id === null);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n──────────────────────────────────────────\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  console.log(failed.length === 0 ? "UPLOAD_LIFECYCLE: ALL PASSED" : "UPLOAD_LIFECYCLE: FAILED");
  return failed.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error(`FATAL: ${e?.stack ?? e}`);
} finally {
  await stopDatabase();
}
process.exitCode = ok ? 0 : 1;
