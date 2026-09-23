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

const U = { solo: uuid(), owner: uuid(), collab: uuid(), admin: uuid(), partnerTitle: uuid(), preparerTitle: uuid(), viewerTitle: uuid(), unrelated: uuid(), ownerB: uuid(), legacy: uuid() };

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

  // ── Behaviour (user-based authority) ───────────────────────────────────────────────────────
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
  // Occupational titles that must confer NOTHING for source-file operations.
  for (const [k, role] of [["partnerTitle", "partner"], ["preparerTitle", "preparer"], ["viewerTitle", "viewer"]]) {
    await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [C, U[k], role]);
  }

  const putObject = (path) => admin.query("INSERT INTO storage.objects (bucket_id, name) VALUES ('trial-balance-files', $1)", [path]);
  // The authorized service-role deletion the trial-balance-storage-cleanup Edge Function performs.
  const deleteObject = (path) => admin.query("DELETE FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [path]);
  const objectExists = async (path) => (await count("SELECT count(*) n FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [path])) === 1;
  // The browser path (TrialBalanceUpload.tsx): the Storage object in the caller's own folder, then an authenticated insert through RLS.
  const clientUpload = async (company, period, who = U.owner) => {
    const path = `${who}/${uuid()}.csv`;
    await putObject(path);
    const id = (await one(user(who),
      "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('c.csv',$1,10,'processing',$2,$3,$4) RETURNING id",
      [path, who, company, period])).id;
    return { id, path };
  };
  const grant = (caller, company, grantee, cap) => one(caller, "SELECT * FROM public.grant_workspace_capability($1,$2,$3)", [company, grantee, cap]);
  const revoke = (caller, company, grantee, cap) => one(caller, "SELECT * FROM public.revoke_workspace_capability($1,$2,$3)", [company, grantee, cap]);
  const can = async (u, company, cap) => (await admin.query("SELECT public.can_user_act_on_workspace($1,$2,$3) r", [u, company, cap])).rows[0].r;

  group("THE predicate — ownership or an explicit grant; never a title, never anonymous");
  await check("the solo workspace really has no firm_members row", async () => (await count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1", [S])) === 0);
  await check("solo owner: can_user_act_on_workspace = true for every valid capability", async () => {
    for (const cap of ["manage_source_files", "prepare_trial_balance", "review_close", "administer_workspace"]) if (!(await can(U.solo, S, cap))) return cap;
    return true;
  });
  await check("owner, anonymous (NULL user), unrelated user, other workspace, unknown capability", async () =>
    (await can(U.owner, C, "manage_source_files")) === true && (await can(null, C, "manage_source_files")) === false
    && (await can(U.unrelated, C, "manage_source_files")) === false && (await can(U.owner, B, "manage_source_files")) === false
    && (await can(U.owner, C, "delete_everything")) === false && (await can(U.owner, C, null)) === false);
  await check("an accepted partner / preparer / viewer TITLE confers nothing", async () =>
    !(await can(U.partnerTitle, C, "manage_source_files")) && !(await can(U.preparerTitle, C, "manage_source_files")) && !(await can(U.viewerTitle, C, "manage_source_files")));
  await check("the predicate never reads firm_members or any occupational title", async () => {
    const src = (await admin.query("SELECT string_agg(pg_get_functiondef(p.oid), ' ') s FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('workspace_authority_basis','can_user_act_on_workspace')")).rows[0].s;
    return !/firm_members|partner|manager|preparer|'owner'/.test(src);
  });
  await refused("authenticated cannot call the predicate with an arbitrary user id (no EXECUTE)", "42501", () => q(user(U.owner), "SELECT public.can_user_act_on_workspace($1,$2,'manage_source_files')", [U.solo, S]));
  await refused("anonymous cannot call any lifecycle RPC (no EXECUTE)", "42501", () => q(ANON, "SELECT * FROM public.discard_trial_balance_upload($1,1)", [uuid()]));

  group("Grants — owner only, idempotent, one active grant, revocable, audited");
  await check("owner grants manage_source_files to the collaborator", async () => (await grant(user(U.owner), C, U.collab, "manage_source_files")).outcome === "granted");
  await check("granting again is idempotent (already_granted, same grant)", async () => {
    const a = await grant(user(U.owner), C, U.collab, "manage_source_files");
    return a.outcome === "already_granted" && (await count("SELECT count(*) n FROM public.workspace_capability_grants WHERE company_id=$1 AND grantee_user_id=$2 AND revoked_at IS NULL", [C, U.collab])) === 1;
  });
  await check("a non-owner cannot grant, even one holding administer_workspace", async () => {
    await grant(user(U.owner), C, U.admin, "administer_workspace");
    return (await grant(user(U.admin), C, U.unrelated, "manage_source_files")).outcome === "forbidden"
      && (await grant(user(U.collab), C, U.unrelated, "manage_source_files")).outcome === "forbidden"
      && (await grant(user(U.partnerTitle), C, U.unrelated, "manage_source_files")).outcome === "forbidden";
  });
  await check("cross-workspace grant is refused (owner of B cannot grant in C)", async () => (await grant(user(U.ownerB), C, U.ownerB, "manage_source_files")).outcome === "forbidden");
  await check("unknown / malformed capability and invalid grantee fail closed", async () =>
    (await grant(user(U.owner), C, U.collab, "delete_everything")).outcome === "invalid_capability"
    && (await grant(user(U.owner), C, uuid(), "manage_source_files")).outcome === "invalid_grantee"
    && (await grant(user(U.owner), C, U.owner, "manage_source_files")).outcome === "invalid_grantee");
  await refused("the database enforces ONE active grant (a direct duplicate is 23505)", "23505", () => admin.query(
    "INSERT INTO public.workspace_capability_grants (company_id, grantee_user_id, capability, granted_by_user_id) VALUES ($1,$2,'manage_source_files',$3)", [C, U.collab, U.owner]));
  await refused("clients cannot write grants directly", "42501", () => q(user(U.owner), "INSERT INTO public.workspace_capability_grants (company_id, grantee_user_id, capability, granted_by_user_id) VALUES ($1,$2,'review_close',$3)", [C, U.unrelated, U.owner]));
  await check("grant events record actor_user_id and outcome, including denials", async () =>
    (await count("SELECT count(*) n FROM public.workspace_capability_grant_events WHERE company_id=$1 AND outcome='denied' AND actor_user_id=$2", [C, U.admin])) >= 1
    && (await count("SELECT count(*) n FROM public.workspace_capability_grant_events WHERE company_id=$1 AND outcome='applied' AND actor_user_id=$2", [C, U.owner])) >= 2);

  group("SOLO LIFECYCLE — an owner with no firm_members row completes the whole lifecycle");
  const s1 = await clientUpload(S, 2030, U.solo);
  let sop;
  await check("solo owner discards an unprocessed upload (phase 1)", async () => { const r = await discard(user(U.solo), s1.id, 1); sop = r.operation_id; return r.outcome === "discard_pending" && !!sop; });
  await check("completion is refused while the object is still in Storage — no client claim is accepted", async () =>
    (await complete(user(U.solo), sop)).outcome === "discard_pending" && !!(await row(s1.id)));
  await check("after the authorized Storage deletion, completion deletes the row", async () => {
    await deleteObject(s1.path);
    return (await complete(user(U.solo), sop)).outcome === "deleted_now" && !(await row(s1.id));
  });
  await check("Undo is refused until the file is back, then restores the exact upload", async () => {
    const before = (await restore(user(U.solo), sop)).outcome;
    await putObject(s1.path);
    const r = await restore(user(U.solo), sop);
    return before === "storage_restore_required" && r.outcome === "restored" && (await row(s1.id))?.file_path === s1.path
      && (await restore(user(U.solo), sop)).outcome === "already_restored";
  });
  await check("solo owner: certify, replace, cancel the replacement, restore the certified upload", async () => {
    await certify(S, s1.id, 2030);
    const rep = `${U.solo}/rep-${uuid()}.csv`; await putObject(rep);
    const r = await retire(user(U.solo), s1.id, Number((await row(s1.id)).version), rep);
    const c = await cancel(user(U.solo), r.new_upload_id, Number((await row(r.new_upload_id)).version));
    const pending = (await confirmCleanup(user(U.solo), c.operation_id)).outcome;
    await deleteObject(rep);
    const done = (await confirmCleanup(user(U.solo), c.operation_id)).outcome;
    return r.outcome === "replaced" && c.outcome === "cancelled" && pending === "storage_cleanup_pending" && done === "completed"
      && (await row(s1.id)).lifecycle_state === "active_processed" && (await activeCount(S, 2030)) === 1 && (await authoritative(S, 2030)) === s1.id;
  });
  await check("every solo event: actor_user_id = the owner, basis workspace_owner, membership NULL", async () => {
    const ev = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE company_id=$1 AND actor_kind='user'", [S])).rows;
    return ev.length >= 5 && ev.every((e) => e.actor_user_id === U.solo && e.authority_basis === "workspace_owner" && e.actor_membership_id === null && e.outcome === "applied");
  });
  await check("solo operations record basis workspace_owner and no membership", async () =>
    (await count("SELECT count(*) n FROM public.trial_balance_upload_operations WHERE company_id=$1 AND (authority_basis<>'workspace_owner' OR actor_membership_id IS NOT NULL)", [S])) === 0);

  group("COLLABORATION — only what is explicitly granted");
  const c1 = await clientUpload(C, 2031, U.owner);
  await check("collaborator WITHOUT a grant is denied, and the denial is audited", async () => {
    const r = await discard(user(U.partnerTitle), c1.id, 1);
    const ev = await count("SELECT count(*) n FROM public.trial_balance_upload_lifecycle_events WHERE upload_id=$1 AND outcome='denied' AND actor_user_id=$2", [c1.id, U.partnerTitle]);
    return r.outcome === "forbidden" && ev === 1;
  });
  for (const k of ["preparerTitle", "viewerTitle", "unrelated", "ownerB", "admin"]) {
    await check(`${k} is denied (no manage_source_files grant)`, async () => (await discard(user(U[k]), c1.id, 1)).outcome === "forbidden");
  }
  let cop;
  await check("the granted collaborator discards the OWNER's upload; basis explicit_capability", async () => {
    const r = await discard(user(U.collab), c1.id, 1); cop = r.operation_id;
    const op = (await admin.query("SELECT * FROM public.trial_balance_upload_operations WHERE id=$1", [cop])).rows[0];
    return r.outcome === "discard_pending" && op.authority_basis === "explicit_capability" && op.authority_capability === "manage_source_files"
      && op.actor_user_id === U.collab && op.actor_membership_id === null && op.file_path === c1.path;
  });
  await check("the owner completes a discard the collaborator started (authorized regardless of uploader)", async () => {
    await deleteObject(c1.path);
    return (await complete(user(U.owner), cop)).outcome === "deleted_now";
  });
  await check("a granted collaborator cannot make a PLAIN browser upload: the pre-existing owner-only insert RLS is unchanged (out of PR #32 scope)", async () => {
    try { await clientUpload(C, 2032, U.collab); return "no error"; } catch (e) { return e.code === "42501"; }
  });
  await check("the owner manages a file the COLLABORATOR uploaded: collaborator replaces, owner cancels, cleanup bound to the collaborator's folder", async () => {
    const base = await clientUpload(C, 2032, U.owner); await certify(C, base.id, 2032);
    const collabFile = `${U.collab}/replacement-${uuid()}.csv`; await putObject(collabFile);
    const r = await retire(user(U.collab), base.id, Number((await row(base.id)).version), collabFile);
    const n = await row(r.new_upload_id);
    const c = await cancel(user(U.owner), r.new_upload_id, Number(n.version));
    const op = (await admin.query("SELECT file_path, authority_basis FROM public.trial_balance_upload_operations WHERE id=$1", [c.operation_id])).rows[0];
    const pending = (await confirmCleanup(user(U.owner), c.operation_id)).outcome;
    await deleteObject(collabFile);
    const done = (await confirmCleanup(user(U.owner), c.operation_id)).outcome;
    return r.outcome === "replaced" && n.user_id === U.collab && c.outcome === "cancelled" && op.file_path === collabFile
      && op.authority_basis === "workspace_owner" && pending === "storage_cleanup_pending" && done === "completed";
  });
  await check("REVOKED: the collaborator is denied on the very next call", async () => {
    const u = await clientUpload(C, 2033, U.owner);
    const rv = await revoke(user(U.owner), C, U.collab, "manage_source_files");
    const again = await revoke(user(U.owner), C, U.collab, "manage_source_files");
    return rv.outcome === "revoked" && again.outcome === "not_granted" && (await discard(user(U.collab), u.id, 1)).outcome === "forbidden"
      && !(await can(U.collab, C, "manage_source_files"));
  });
  await refused("a revoked grant is immutable (cannot be un-revoked)", "23000", () => admin.query("UPDATE public.workspace_capability_grants SET revoked_at = NULL, revoked_by_user_id = NULL WHERE company_id=$1 AND grantee_user_id=$2", [C, U.collab]));
  await check("re-granting after revocation creates a new active grant (history kept)", async () =>
    (await grant(user(U.owner), C, U.collab, "manage_source_files")).outcome === "granted"
    && (await count("SELECT count(*) n FROM public.workspace_capability_grants WHERE company_id=$1 AND grantee_user_id=$2", [C, U.collab])) === 2);
  await check("a grant is per workspace: the collaborator has nothing in workspace B", async () => {
    const b1 = await clientUpload(B, 2034, U.ownerB);
    return (await discard(user(U.collab), b1.id, 1)).outcome === "forbidden";
  });

  group("Storage-path binding — a forged row or path can never redirect a deletion");
  await check("a row whose file_path points at ANOTHER user's object gets no bound path; the victim object is untouched", async () => {
    const victim = `${U.ownerB}/victim-${uuid()}.csv`; await putObject(victim);
    const attacker = (await one(user(U.unrelated), "INSERT INTO public.companies (user_id,name) VALUES ($1,'Attacker') RETURNING id", [U.unrelated])).id;
    const forged = (await one(user(U.unrelated),
      "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('x',$1,1,'processing',$2,$3,2040) RETURNING id",
      [victim, U.unrelated, attacker])).id;
    const r = await discard(user(U.unrelated), forged, 1);
    const op = (await admin.query("SELECT file_path FROM public.trial_balance_upload_operations WHERE id=$1", [r.operation_id])).rows[0];
    const c = await complete(user(U.unrelated), r.operation_id);
    return r.outcome === "discard_pending" && r.file_path === null && op.file_path === null && c.outcome === "deleted_now" && (await objectExists(victim));
  });
  await check("replace refuses a path outside the caller's own folder, a path already in use, or a missing object", async () => {
    const u = await clientUpload(C, 2035, U.owner); await certify(C, u.id, 2035);
    const v = Number((await row(u.id)).version);
    const foreign = `${U.ownerB}/x-${uuid()}.csv`; await putObject(foreign);
    const inUse = u.path;
    const missing = `${U.owner}/never-uploaded.csv`;
    return (await retire(user(U.owner), u.id, v, foreign)).outcome === "forbidden" && (await retire(user(U.owner), u.id, v, inUse)).outcome === "forbidden"
      && (await retire(user(U.owner), u.id, v, missing)).outcome === "forbidden" && (await row(u.id)).lifecycle_state === "active_processed";
  });
  await check("a forged operation id resolves to nothing (restore stale_operation; complete already_discarded)", async () =>
    (await restore(user(U.owner), uuid())).outcome === "stale_operation" && (await complete(user(U.owner), uuid())).outcome === "already_discarded");
  await check("the cleanup target is resolved only server-side, and only for service_role", async () => {
    try { await q(user(U.owner), "SELECT * FROM public.tbu_storage_cleanup_target($1)", [uuid()]); return "no error"; } catch (e) { return e.code === "42501"; }
  });

  group("Lifecycle columns stay server-authoritative");
  const u1 = await clientUpload(C, 2036, U.owner);
  await refused("a client cannot set lifecycle_state directly (42501)", "42501", () => q(user(U.owner), "UPDATE public.trial_balance_uploads SET lifecycle_state='retired' WHERE id=$1", [u1.id]));
  await refused("a client cannot forge the sanctioned-op marker (still 42501)", "42501", () => asCaller(user(U.owner), async (c) => {
    await c.query("SELECT set_config('axiom.tbu_lifecycle_op','cancel_replacement',true)");
    await c.query("UPDATE public.trial_balance_uploads SET lifecycle_state='retired' WHERE id=$1", [u1.id]);
  }));
  await check("a direct client DELETE removes nothing (no DELETE policy remains)", async () => {
    await q(user(U.owner), "DELETE FROM public.trial_balance_uploads WHERE id=$1", [u1.id]);
    return (await row(u1.id)) !== undefined;
  });
  await refused("a second active upload for the same period is refused by the unique index (23505)", "23505", () => clientUpload(C, 2036, U.owner));

  group("B2 — certification drives lifecycle; eligibility never trusts lifecycle_state alone");
  const u2 = await clientUpload(C, 2037, U.owner);
  await check("processing start moves it to active_processing (engine event, basis engine)", async () => {
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [u2.id]);
    const ev = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE upload_id=$1 AND to_state='active_processing'", [u2.id])).rows;
    return (await row(u2.id)).lifecycle_state === "active_processing" && ev.length === 1 && ev[0].authority_basis === "engine";
  });
  await check("a processing upload is refused a hard discard even with a stale version", async () => (await discard(user(U.owner), u2.id, 1)).outcome === "replacement_required");
  await check("blocking → blocked; needs-review → active_processed; clean → active_processed", async () => {
    await certify(C, u2.id, 2037, { blocking: true }); const a = (await row(u2.id)).lifecycle_state;
    await certify(C, u2.id, 2037, { review: true }); const b = (await row(u2.id)).lifecycle_state;
    await certify(C, u2.id, 2037); const c = (await row(u2.id)).lifecycle_state;
    return a === "blocked" && b === "active_processed" && c === "active_processed";
  });
  await check("derived evidence alone refuses a hard discard", async () => {
    const u = await clientUpload(C, 2038, U.owner);
    await admin.query("INSERT INTO public.upload_integrity_findings (upload_id, company_id, issue_type) VALUES ($1, $2, 'ENGAGEMENT_COMPANY_MISMATCH')", [u.id, C]);
    return (await row(u.id)).lifecycle_state === "active_unprocessed" && (await discard(user(U.owner), u.id, 1)).outcome === "replacement_required";
  });

  group("Retire / cancel — evidence preserved, exactly one active upload");
  const certsBefore = await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [u2.id]);
  let n1;
  const p1 = `${U.owner}/replacement-1.csv`; await putObject(p1);
  await check("owner replaces a certified upload: superseded + linked, certifications untouched, one active", async () => {
    const r = await retire(user(U.owner), u2.id, Number((await row(u2.id)).version), p1); n1 = r.new_upload_id;
    const [o, n] = [await row(u2.id), await row(n1)];
    return r.outcome === "replaced" && o.lifecycle_state === "superseded" && o.superseded_by_upload_id === n1 && n.replaces_upload_id === u2.id
      && o.retired_by === U.owner && (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [u2.id])) === certsBefore && (await activeCount(C, 2037)) === 1;
  });
  await check("retry with the same file → same replacement; a different file → stale_version", async () => {
    const p2 = `${U.owner}/other-${uuid()}.csv`; await putObject(p2);
    return (await retire(user(U.owner), u2.id, 1, p1)).new_upload_id === n1 && (await retire(user(U.owner), u2.id, 1, p2)).outcome === "stale_version";
  });
  await check("hard discard of the unprocessed replacement → replacement_cancel_required", async () => (await discard(user(U.owner), n1, Number((await row(n1)).version))).outcome === "replacement_cancel_required");
  await check("the GRANTED collaborator cancels; predecessor is the sole active upload again and authoritative", async () => {
    const r = await cancel(user(U.collab), n1, Number((await row(n1)).version));
    const o = await row(u2.id);
    await deleteObject(p1);
    const done = (await confirmCleanup(user(U.collab), r.operation_id)).outcome;
    return r.outcome === "cancelled" && !(await row(n1)) && o.lifecycle_state === "active_processed" && (await activeCount(C, 2037)) === 1
      && (await authoritative(C, 2037)) === u2.id && done === "completed" && (await confirmCleanup(user(U.collab), r.operation_id)).outcome === "already_completed";
  });
  await check("a processed replacement cannot be cancelled or hard-deleted; it must itself be retired", async () => {
    const p3 = `${U.owner}/rep-${uuid()}.csv`; await putObject(p3);
    const r = await retire(user(U.owner), u2.id, Number((await row(u2.id)).version), p3);
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [r.new_upload_id]);
    const v = Number((await row(r.new_upload_id)).version);
    const p4 = `${U.owner}/rep-${uuid()}.csv`; await putObject(p4);
    return (await cancel(user(U.owner), r.new_upload_id, v)).outcome === "replacement_processed" && (await discard(user(U.owner), r.new_upload_id, v)).outcome === "replacement_required"
      && (await retire(user(U.owner), r.new_upload_id, v, p4)).outcome === "replaced" && (await activeCount(C, 2037)) === 1;
  });
  await check("concurrent cancel vs processing: whichever holds the lock first wins; never two actives", async () => {
    const base = await clientUpload(C, 2039, U.owner); await certify(C, base.id, 2039);
    const pp = `${U.owner}/rep-${uuid()}.csv`; await putObject(pp);
    const rep = (await retire(user(U.owner), base.id, Number((await row(base.id)).version), pp)).new_upload_id;
    const repVersion = Number((await row(rep)).version);
    const engine = await pool.connect();
    try {
      await engine.query("BEGIN; SET LOCAL ROLE service_role");
      await engine.query("UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [rep]);
      const pending = cancel(user(U.owner), rep, repVersion);
      await new Promise((r) => setTimeout(r, 300));
      await engine.query("COMMIT");
      return (await pending).outcome === "replacement_processed" && (await activeCount(C, 2039)) === 1;
    } finally { engine.release(); }
  });

  group("B4 — truthful Undo");
  const u6 = await clientUpload(C, 2051, U.owner);
  await check("EXACT SCENARIO: discard → upload a new active file → Undo = explicit conflict; new upload unchanged", async () => {
    const b = await discard(user(U.owner), u6.id, 1);
    await deleteObject(u6.path); await complete(user(U.owner), b.operation_id);
    const u7 = await clientUpload(C, 2051, U.owner);
    const before = JSON.stringify(await row(u7.id));
    await putObject(u6.path);
    const r = await restore(user(U.owner), b.operation_id);
    return r.outcome === "conflict_new_active_upload" && !(await row(u6.id)) && JSON.stringify(await row(u7.id)) === before && (await activeCount(C, 2051)) === 1;
  });
  await check("an expired undo window: expired", async () => {
    const u = await clientUpload(C, 2052, U.owner); const b = await discard(user(U.owner), u.id, 1);
    await deleteObject(u.path); await complete(user(U.owner), b.operation_id);
    await admin.query("UPDATE public.trial_balance_upload_operations SET completed_at = now() - interval '11 minutes' WHERE id=$1", [b.operation_id]);
    await putObject(u.path);
    return (await restore(user(U.owner), b.operation_id)).outcome === "expired";
  });
  await check("an unfinished discard or unknown operation: stale_operation", async () => {
    const u = await clientUpload(C, 2053, U.owner); const b = await discard(user(U.owner), u.id, 1);
    return (await restore(user(U.owner), b.operation_id)).outcome === "stale_operation";
  });

  group(`Concurrency — ${CONCURRENCY} simultaneous requests on separate connections`);
  await check(`${CONCURRENCY} concurrent begins converge on ONE discard operation`, async () => {
    const u = await clientUpload(C, 2060, U.owner);
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => discard(user(U.owner), u.id, 1)));
    return new Set(out.map((o) => o.operation_id)).size === 1 && out.every((o) => o.outcome === "discard_pending");
  });
  await check(`${CONCURRENCY} concurrent completions: exactly one deletes, the rest are idempotent`, async () => {
    const u = await clientUpload(C, 2063, U.owner); const b = await discard(user(U.owner), u.id, 1); await deleteObject(u.path);
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => complete(user(U.owner), b.operation_id)));
    return out.filter((o) => o.outcome === "deleted_now").length === 1 && out.filter((o) => o.outcome === "already_discarded").length === CONCURRENCY - 1;
  });
  await check(`${CONCURRENCY} concurrent replaces with DIFFERENT files: one wins, the rest stale_version`, async () => {
    const u = await clientUpload(C, 2062, U.owner); await certify(C, u.id, 2062);
    const v = Number((await row(u.id)).version);
    const paths = Array.from({ length: CONCURRENCY }, (_, i) => `${U.owner}/f${i}-${uuid()}.csv`);
    for (const p of paths) await putObject(p);
    const out = await Promise.all(paths.map((p) => retire(user(U.owner), u.id, v, p)));
    return out.filter((o) => o.outcome === "replaced").length === 1 && out.filter((o) => o.outcome === "stale_version").length === CONCURRENCY - 1 && (await activeCount(C, 2062)) === 1;
  });
  await check(`${CONCURRENCY} concurrent grants converge on ONE active grant`, async () => {
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => grant(user(U.owner), C, U.unrelated, "review_close")));
    return out.filter((o) => o.outcome === "granted").length === 1
      && (await count("SELECT count(*) n FROM public.workspace_capability_grants WHERE company_id=$1 AND grantee_user_id=$2 AND capability='review_close' AND revoked_at IS NULL", [C, U.unrelated])) === 1;
  });

  group("Privileges and audit immutability");
  await check("client RPCs are executable by authenticated and NOT by anon", async () => {
    const fns = ["discard_trial_balance_upload(uuid,bigint)", "complete_trial_balance_discard(uuid)", "restore_trial_balance_upload(uuid)",
      "retire_trial_balance_upload(uuid,bigint,text,text,integer,text)", "cancel_trial_balance_replacement(uuid,bigint)", "confirm_trial_balance_storage_cleanup(uuid)",
      "grant_workspace_capability(uuid,uuid,text)", "revoke_workspace_capability(uuid,uuid,text)"];
    for (const f of fns) {
      const r = (await admin.query(`SELECT has_function_privilege('authenticated','public.${f}','EXECUTE') a, has_function_privilege('anon','public.${f}','EXECUTE') n`)).rows[0];
      if (!r.a || r.n) return f;
    }
    return true;
  });
  await check("the predicate, storage probe and cleanup target are service_role-only", async () => {
    for (const f of ["can_user_act_on_workspace(uuid,uuid,text)", "workspace_authority_basis(uuid,uuid,text)", "tbu_storage_object_exists(text)", "tbu_storage_cleanup_target(uuid)", "tbu_authorize(uuid)"]) {
      const r = (await admin.query(`SELECT has_function_privilege('authenticated','public.${f}','EXECUTE') a, has_function_privilege('anon','public.${f}','EXECUTE') n`)).rows[0];
      if (r.a || r.n) return f;
    }
    return true;
  });
  await check("every SECURITY DEFINER function in the lifecycle migration pins its search_path", async () =>
    (await count(`SELECT count(*) n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.prosecdef
      AND (p.proname LIKE 'tbu_%' OR p.proname LIKE '%trial_balance_%' OR p.proname LIKE '%workspace_%' OR p.proname = 'tb_certification_drives_upload_lifecycle')
      AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')`)) === 0);
  await refused("lifecycle events are append-only, even for the owner role (23001)", "23001", () => admin.query("UPDATE public.trial_balance_upload_lifecycle_events SET reason='x' WHERE id=(SELECT id FROM public.trial_balance_upload_lifecycle_events LIMIT 1)"));
  await refused("grant events are append-only (23001)", "23001", () => admin.query("DELETE FROM public.workspace_capability_grant_events WHERE id=(SELECT id FROM public.workspace_capability_grant_events LIMIT 1)"));
  await check("the owner and capability holders read lifecycle events; other tenants and titles-only members see none", async () => {
    const owner = await one(user(U.owner), "SELECT count(*)::int n FROM public.trial_balance_upload_lifecycle_events WHERE company_id=$1", [C]);
    const holder = await one(user(U.collab), "SELECT count(*)::int n FROM public.trial_balance_upload_lifecycle_events WHERE company_id=$1", [C]);
    const title = await one(user(U.viewerTitle), "SELECT count(*)::int n FROM public.trial_balance_upload_lifecycle_events WHERE company_id=$1", [C]);
    const other = await one(user(U.ownerB), "SELECT count(*)::int n FROM public.trial_balance_upload_lifecycle_events WHERE company_id=$1", [C]);
    return owner.n > 0 && holder.n > 0 && title.n === 0 && other.n === 0;
  });
  await check("clients cannot read the operation records", async () => {
    const r = await q(user(U.owner), "SELECT count(*)::int n FROM public.trial_balance_upload_operations").catch((e) => e);
    return r instanceof Error ? r.code === "42501" : r[0].n === 0;
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
