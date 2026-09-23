#!/usr/bin/env node
// Real-PostgreSQL proof of the trial balance upload lifecycle migration (20260923100000).
//
// 1. Upgrade (B1): replays every migration BEFORE 20260923100000, seeds legacy uploads (zero, one and
//    several per period, certified and blocked history, an exact uploaded_at tie, NULL periods and derived
//    evidence), applies 20260923100000, and proves the backfill kept exactly the upload the pre-lifecycle
//    authority rule already treated as current and preserved everything.
// 2. Behaviour: certification-driven transitions (B2), replacement cancellation (B3), truthful restore
//    (B4), the owner/partner capability boundary with both actor identities, and real concurrency. Every
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
    "INSERT INTO public.engine_runs (company_id, actor_type, firm_member_id, function_name, engine_version, status, period_year) VALUES ($1,'user',$2,'process-trial-balance','proof','running',$3) RETURNING id",
    [company, ownerMemberOf[company] ?? null, period])).rows[0].id;
  await admin.query("SELECT public.commit_tb_certification($1,'process-trial-balance',$2,$3,$4,'h','n','o',$5,$6,'[]'::jsonb,'[]'::jsonb)",
    [run, upload, company, period, blocking, review]);
}
const ownerMemberOf = {};

const discard = (caller, id, version) => one(caller, "SELECT * FROM public.discard_trial_balance_upload($1,$2)", [id, version]);
const complete = (caller, op, removed) => one(caller, "SELECT * FROM public.complete_trial_balance_discard($1,$2)", [op, removed]);
const restore = (caller, op, restored) => one(caller, "SELECT * FROM public.restore_trial_balance_upload($1,$2)", [op, restored]);
const retire = (caller, id, version, filePath) => one(caller, "SELECT * FROM public.retire_trial_balance_upload($1,$2,'replacement.csv',$3,200,'proof')", [id, version, filePath]);
const cancel = (caller, id, version) => one(caller, "SELECT * FROM public.cancel_trial_balance_replacement($1,$2)", [id, version]);
const confirmCleanup = (caller, op, removed) => one(caller, "SELECT * FROM public.confirm_trial_balance_storage_cleanup($1,$2)", [op, removed]);
const activeCount = (company, period) => count(
  "SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1 AND period_year=$2 AND lifecycle_state IN ('active_unprocessed','active_processing','active_processed','blocked')", [company, period]);
const authoritative = async (company, period) => (await admin.query("SELECT upload_id FROM public.get_authoritative_certification($1,$2)", [company, period])).rows[0]?.upload_id ?? null;

const U = { owner: uuid(), partner: uuid(), preparer: uuid(), viewer: uuid(), pending: uuid(), outsider: uuid(), ownerB: uuid(), legacy: uuid() };

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

  // ── Behaviour ──────────────────────────────────────────────────────────────────────────────
  for (const [k, id] of Object.entries(U)) if (k !== "legacy") await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const C = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company C') RETURNING id", [U.owner])).rows[0].id;
  const B = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company B') RETURNING id", [U.ownerB])).rows[0].id;
  ownerMemberOf[C] = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND role='owner'", [C])).rows[0].id;
  for (const [k, role, accepted] of [["partner", "partner", true], ["preparer", "preparer", true], ["viewer", "viewer", true], ["pending", "partner", false]]) {
    await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,CASE WHEN $4 THEN now() END)", [C, U[k], role, accepted]);
  }
  const partnerMember = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [C, U.partner])).rows[0].id;

  // The real client path (TrialBalanceUpload.tsx): an authenticated insert through RLS.
  const clientUpload = async (period, who = U.owner) => (await one(user(who),
    "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('c.csv',$1,10,'processing',$2,$3,$4) RETURNING id",
    [`${who}/${uuid()}.csv`, who, C, period])).id;

  group("Lifecycle columns are server-authoritative");
  const u1 = await clientUpload(2030);
  await check("a client upload starts active_unprocessed at version 1", async () => { const r = await row(u1); return r.lifecycle_state === "active_unprocessed" && Number(r.version) === 1; });
  await refused("a client cannot set lifecycle_state directly (42501)", "42501", () => q(user(U.owner), "UPDATE public.trial_balance_uploads SET lifecycle_state='retired' WHERE id=$1", [u1]));
  await refused("a client cannot bump version (42501)", "42501", () => q(user(U.owner), "UPDATE public.trial_balance_uploads SET version=99 WHERE id=$1", [u1]));
  await refused("a client cannot insert a pre-retired upload (42501)", "42501", () => q(user(U.owner),
    "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year,lifecycle_state) VALUES ('x','x',1,'processing',$1,$2,2031,'retired')", [U.owner, C]));
  await refused("a client cannot forge the sanctioned-op marker (still 42501)", "42501", () => asCaller(user(U.owner), async (c) => {
    await c.query("SELECT set_config('axiom.tbu_lifecycle_op','cancel_replacement',true)");
    await c.query("UPDATE public.trial_balance_uploads SET lifecycle_state='retired' WHERE id=$1", [u1]);
  }));
  await refused("the service role cannot write lifecycle columns directly either (42501)", "42501", () => q(SERVICE, "UPDATE public.trial_balance_uploads SET lifecycle_state='blocked' WHERE id=$1", [u1]));
  await check("a direct client DELETE removes nothing (no DELETE policy remains)", async () => {
    await q(user(U.owner), "DELETE FROM public.trial_balance_uploads WHERE id=$1", [u1]);
    return (await row(u1)) !== undefined;
  });
  await refused("a second active upload for the same period is refused by the unique index (23505)", "23505", () => clientUpload(2030));

  group("Capability: only owner / partner (management authority) may perform source lifecycle operations");
  const v1 = Number((await row(u1)).version);
  await refused("anonymous cannot execute discard (42501)", "42501", () => discard(ANON, u1, v1));
  for (const who of ["preparer", "viewer", "pending", "outsider", "ownerB"]) {
    await check(`${who} is refused with 'forbidden'`, async () => (await discard(user(U[who]), u1, v1)).outcome === "forbidden");
  }
  await check("nothing changed after the refused attempts", async () => { const r = await row(u1); return r.lifecycle_state === "active_unprocessed" && Number(r.version) === v1; });
  await refused("authenticated cannot call the capability helper directly (42501)", "42501", () => q(user(U.owner), "SELECT public.tbu_source_manager_membership($1)", [C]));
  await refused("authenticated cannot call the evidence helper directly (42501)", "42501", () => q(user(U.owner), "SELECT public.tbu_upload_evidence($1, NULL)", [u1]));

  group("Unprocessed hard discard — two-phase, audited, idempotent");
  await check("stale version is refused with 'stale_version'", async () => (await discard(user(U.partner), u1, v1 + 5)).outcome === "stale_version");
  let op1;
  await check("partner begins the discard: discard_pending with an operation id", async () => {
    const r = await discard(user(U.partner), u1, v1); op1 = r.operation_id;
    return r.outcome === "discard_pending" && !!op1 && (await row(u1)).lifecycle_state === "discard_pending";
  });
  await check("a retried begin resumes the SAME operation", async () => (await discard(user(U.partner), u1, v1)).operation_id === op1);
  await check("finalize without confirmed Storage removal deletes nothing", async () =>
    (await complete(user(U.partner), op1, false)).outcome === "discard_pending" && (await row(u1)) !== undefined);
  await check("finalize with Storage confirmed deletes the row", async () =>
    (await complete(user(U.partner), op1, true)).outcome === "deleted_now" && (await row(u1)) === undefined);
  await check("a repeated finalize is idempotent ('already_discarded')", async () => (await complete(user(U.partner), op1, true)).outcome === "already_discarded");
  await check("events record actor_user_id AND the server-resolved actor_membership_id", async () => {
    const ev = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE upload_id=$1 ORDER BY occurred_at", [u1])).rows;
    const d = ev.find((e) => e.to_state === "discarded");
    return ev.length >= 2 && d && d.actor_user_id === U.partner && d.actor_membership_id === partnerMember && d.operation_id === op1 && d.company_id === C;
  });

  group("B2 — certification drives lifecycle; eligibility never trusts lifecycle_state alone");
  const u2 = await clientUpload(2030);
  await check("processing start (engine sets status='validating') moves it to active_processing, audited as the engine", async () => {
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [u2]);
    const ev = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE upload_id=$1 AND to_state='active_processing'", [u2])).rows;
    return (await row(u2)).lifecycle_state === "active_processing" && ev.length === 1 && ev[0].actor_kind === "engine";
  });
  await check("a processing upload is refused a hard discard ('replacement_required')", async () =>
    (await discard(user(U.owner), u2, Number((await row(u2)).version))).outcome === "replacement_required");
  await check("a blocking certification -> blocked", async () => { await certify(C, u2, 2030, { blocking: true }); return (await row(u2)).lifecycle_state === "blocked"; });
  await check("a later needs-review certification -> active_processed (review stays on the certification)", async () => {
    await certify(C, u2, 2030, { review: true });
    return (await row(u2)).lifecycle_state === "active_processed";
  });
  await check("a later clean certification keeps active_processed; each transition is on the audit trail with the engine actor's membership", async () => {
    await certify(C, u2, 2030);
    const ev = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE upload_id=$1 AND reason LIKE 'Certification %'", [u2])).rows;
    return (await row(u2)).lifecycle_state === "active_processed" && ev.length === 2 && ev.every((e) => e.actor_membership_id === ownerMemberOf[C] && e.actor_user_id === U.owner);
  });
  await check("a certification of a never-touched upload moves it straight to active_processed", async () => {
    const u = await clientUpload(2032); await certify(C, u, 2032);
    return (await row(u)).lifecycle_state === "active_processed";
  });
  await check("derived evidence alone (no processing trace, lifecycle still unprocessed) refuses a hard discard", async () => {
    const u = await clientUpload(2033);
    await admin.query("INSERT INTO public.upload_integrity_findings (upload_id, company_id, issue_type) VALUES ($1, $2, 'ENGAGEMENT_COMPANY_MISMATCH')", [u, C]);
    const r = await row(u);
    return r.lifecycle_state === "active_unprocessed" && (await discard(user(U.owner), u, Number(r.version))).outcome === "replacement_required";
  });

  group("Retire and replace — evidence preserved, exactly one active upload");
  const certsBefore = await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [u2]);
  let n1;
  const path1 = `${U.owner}/replacement-1.csv`;
  await check("preparer cannot replace ('forbidden')", async () => (await retire(user(U.preparer), u2, Number((await row(u2)).version), path1)).outcome === "forbidden");
  await check("owner replaces a certified upload: old superseded, new active_unprocessed and linked", async () => {
    const r = await retire(user(U.owner), u2, Number((await row(u2)).version), path1); n1 = r.new_upload_id;
    const [o, n] = [await row(u2), await row(n1)];
    return r.outcome === "replaced" && o.lifecycle_state === "superseded" && o.superseded_by_upload_id === n1 && n.replaces_upload_id === u2
      && n.lifecycle_state === "active_unprocessed" && o.retired_by === U.owner && o.retired_by_membership_id === ownerMemberOf[C];
  });
  await check("certifications of the replaced upload are untouched and exactly one upload is active", async () =>
    (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [u2])) === certsBefore && (await activeCount(C, 2030)) === 1);
  await check("a retried replace with the SAME file returns the same new upload", async () => (await retire(user(U.owner), u2, 1, path1)).new_upload_id === n1);
  await check("a replace with a DIFFERENT file for the already-replaced upload is 'stale_version', never a false success", async () =>
    (await retire(user(U.owner), u2, 1, `${U.owner}/other.csv`)).outcome === "stale_version");
  await check("while the replacement is unprocessed, no certification is authoritative for the period", async () => (await authoritative(C, 2030)) === null);

  group("B3 — cancelling a replacement restores its predecessor");
  await check("hard discard of an unprocessed replacement is refused with 'replacement_cancel_required'", async () =>
    (await discard(user(U.owner), n1, Number((await row(n1)).version))).outcome === "replacement_cancel_required");
  await check("viewer cannot cancel ('forbidden')", async () => (await cancel(user(U.viewer), n1, Number((await row(n1)).version))).outcome === "forbidden");
  await check("a stale version is refused", async () => (await cancel(user(U.owner), n1, 999)).outcome === "stale_version");
  let cop;
  await check("owner cancels: replacement removed, predecessor restored as the SOLE active upload in its certified state", async () => {
    const r = await cancel(user(U.owner), n1, Number((await row(n1)).version)); cop = r.operation_id;
    const o = await row(u2);
    return r.outcome === "cancelled" && r.restored_upload_id === u2 && (await row(n1)) === undefined
      && o.lifecycle_state === "active_processed" && o.superseded_by_upload_id === null && o.retired_at === null && (await activeCount(C, 2030)) === 1;
  });
  await check("the original certifications are preserved and authoritative again", async () =>
    (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [u2])) === certsBefore && (await authoritative(C, 2030)) === u2);
  await check("Storage cleanup is tracked: pending until confirmed; a failed cleanup stays pending; confirm is idempotent", async () =>
    (await confirmCleanup(user(U.owner), cop, false)).outcome === "storage_cleanup_pending"
    && (await confirmCleanup(user(U.owner), cop, true)).outcome === "completed"
    && (await confirmCleanup(user(U.owner), cop, true)).outcome === "already_completed");
  await check("retrying the cancel is idempotent ('already_cancelled', same operation)", async () => {
    const r = await cancel(user(U.owner), n1, 1); return r.outcome === "already_cancelled" && r.operation_id === cop;
  });
  await check("cancel events carry both actor identities and the operation id", async () => {
    const ev = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE operation_id=$1", [cop])).rows;
    return ev.length === 2 && ev.every((e) => e.actor_user_id === U.owner && e.actor_membership_id === ownerMemberOf[C]);
  });
  await check("a replacement that has been processed cannot be cancelled or hard-deleted; it must itself be retired", async () => {
    const r = await retire(user(U.owner), u2, Number((await row(u2)).version), `${U.owner}/replacement-2.csv`);
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [r.new_upload_id]);
    const v = Number((await row(r.new_upload_id)).version);
    const c = await cancel(user(U.owner), r.new_upload_id, v);
    const d = await discard(user(U.owner), r.new_upload_id, v);
    const again = await retire(user(U.owner), r.new_upload_id, v, `${U.owner}/replacement-3.csv`);
    return c.outcome === "replacement_processed" && d.outcome === "replacement_required" && again.outcome === "replaced" && (await activeCount(C, 2030)) === 1;
  });

  group("B3 — concurrent cancel and processing");
  const concurrentCase = async (engineFirst) => {
    const base = await clientUpload(engineFirst ? 2040 : 2041);
    await certify(C, base, engineFirst ? 2040 : 2041);
    const rep = (await retire(user(U.owner), base, Number((await row(base)).version), `${U.owner}/${uuid()}.csv`)).new_upload_id;
    const repVersion = Number((await row(rep)).version);
    const engine = await pool.connect();
    try {
      await engine.query("BEGIN; SET LOCAL ROLE service_role");
      if (engineFirst) {
        await engine.query("UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [rep]);
        const pending = cancel(user(U.owner), rep, repVersion);
        await new Promise((r) => setTimeout(r, 300));
        await engine.query("COMMIT");
        return { outcome: (await pending).outcome, base, rep, period: 2040 };
      }
      const c = await cancel(user(U.owner), rep, repVersion);
      const upd = await engine.query("UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [rep]);
      await engine.query("COMMIT");
      return { outcome: c.outcome, updated: upd.rowCount, base, rep, period: 2041 };
    } finally { engine.release(); }
  };
  await check("processing wins the lock: the cancel sees it and answers 'replacement_processed'; one active upload", async () => {
    const r = await concurrentCase(true);
    return r.outcome === "replacement_processed" && (await activeCount(C, r.period)) === 1 && (await row(r.rep)).lifecycle_state === "active_processing";
  });
  await check("cancel wins: the engine's later update touches nothing; the predecessor is the sole active upload", async () => {
    const r = await concurrentCase(false);
    return r.outcome === "cancelled" && r.updated === 0 && (await activeCount(C, r.period)) === 1 && (await row(r.base)).lifecycle_state === "active_processed";
  });

  group("B4 — truthful Undo");
  const u5 = await clientUpload(2050);
  let op5;
  await check("discard completes (fixture for restore)", async () => {
    const b = await discard(user(U.owner), u5, 1); op5 = b.operation_id;
    return (await complete(user(U.owner), op5, true)).outcome === "deleted_now";
  });
  await check("restore without the file back in Storage: 'storage_restore_required', nothing inserted", async () =>
    (await restore(user(U.owner), op5, false)).outcome === "storage_restore_required" && (await row(u5)) === undefined);
  await check("preparer cannot restore ('forbidden')", async () => (await restore(user(U.preparer), op5, true)).outcome === "forbidden");
  await check("restore puts back the exact original upload", async () => {
    const r = await restore(user(U.owner), op5, true); const back = await row(u5);
    return r.outcome === "restored" && r.upload_id === u5 && back.lifecycle_state === "active_unprocessed" && (await activeCount(C, 2050)) === 1;
  });
  await check("a repeated restore proves the same row exists: 'already_restored'", async () => (await restore(user(U.owner), op5, true)).outcome === "already_restored");

  const u6 = await clientUpload(2051);
  let op6;
  let u7;
  await check("EXACT SCENARIO: discard old upload -> upload a new active file -> Undo = explicit conflict", async () => {
    const b = await discard(user(U.owner), u6, 1); op6 = b.operation_id;
    await complete(user(U.owner), op6, true);
    u7 = await clientUpload(2051);
    const before = await row(u7);
    const r = await restore(user(U.owner), op6, true);
    const after = await row(u7);
    return r.outcome === "conflict_new_active_upload" && (await row(u6)) === undefined
      && JSON.stringify(before) === JSON.stringify(after) && (await activeCount(C, 2051)) === 1;
  });
  await check("the conflict is never reported as restored, even on retry", async () => (await restore(user(U.owner), op6, true)).outcome === "conflict_new_active_upload");
  await check("an expired undo window: 'expired'", async () => {
    const u = await clientUpload(2052); const b = await discard(user(U.owner), u, 1); await complete(user(U.owner), b.operation_id, true);
    await admin.query("UPDATE public.trial_balance_upload_operations SET completed_at = now() - interval '11 minutes' WHERE id=$1", [b.operation_id]);
    return (await restore(user(U.owner), b.operation_id, true)).outcome === "expired";
  });
  await check("an unfinished discard or unknown operation: 'stale_operation'", async () => {
    const u = await clientUpload(2053); const b = await discard(user(U.owner), u, 1);
    return (await restore(user(U.owner), b.operation_id, true)).outcome === "stale_operation" && (await restore(user(U.owner), uuid(), true)).outcome === "stale_operation";
  });
  await check("a restored record that no longer matches its receipt: 'terminal_failure', never already_restored", async () => {
    await admin.query("UPDATE public.trial_balance_uploads SET file_path='tampered' WHERE id=$1", [u5]);
    return (await restore(user(U.owner), op5, true)).outcome === "terminal_failure";
  });

  group(`Concurrency — ${CONCURRENCY} simultaneous requests on separate connections`);
  await check(`${CONCURRENCY} concurrent begins converge on ONE discard operation`, async () => {
    const u = await clientUpload(2060);
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => discard(user(U.owner), u, 1)));
    const ops = new Set(out.map((o) => o.operation_id));
    return ops.size === 1 && out.every((o) => o.outcome === "discard_pending") && (await count("SELECT count(*) n FROM public.trial_balance_upload_operations WHERE upload_id=$1", [u])) === 1;
  });
  await check(`${CONCURRENCY} concurrent replaces with the SAME file create exactly one replacement`, async () => {
    const u = await clientUpload(2061); await certify(C, u, 2061);
    const v = Number((await row(u)).version); const p = `${U.owner}/same.csv`;
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => retire(user(U.owner), u, v, p)));
    return new Set(out.map((o) => o.new_upload_id)).size === 1 && out.every((o) => o.outcome === "replaced") && (await activeCount(C, 2061)) === 1;
  });
  await check(`${CONCURRENCY} concurrent replaces with DIFFERENT files: one wins, the rest get 'stale_version'`, async () => {
    const u = await clientUpload(2062); await certify(C, u, 2062);
    const v = Number((await row(u)).version);
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => retire(user(U.owner), u, v, `${U.owner}/f${i}.csv`)));
    return out.filter((o) => o.outcome === "replaced").length === 1 && out.filter((o) => o.outcome === "stale_version").length === CONCURRENCY - 1 && (await activeCount(C, 2062)) === 1;
  });

  group("Privileges and audit immutability");
  await check("RPCs are executable by authenticated and NOT by anon or PUBLIC", async () => {
    const fns = ["discard_trial_balance_upload(uuid,bigint)", "complete_trial_balance_discard(uuid,boolean)", "restore_trial_balance_upload(uuid,boolean)",
      "retire_trial_balance_upload(uuid,bigint,text,text,integer,text)", "cancel_trial_balance_replacement(uuid,bigint)", "confirm_trial_balance_storage_cleanup(uuid,boolean)"];
    for (const f of fns) {
      const r = (await admin.query(`SELECT has_function_privilege('authenticated','public.${f}','EXECUTE') a, has_function_privilege('anon','public.${f}','EXECUTE') n`)).rows[0];
      if (!r.a || r.n) return f;
    }
    return true;
  });
  await check("internal helpers are not executable by anon or authenticated", async () => {
    const fns = ["tbu_source_manager_membership(uuid)", "tbu_upload_evidence(uuid,uuid)", "tbu_derived_active_state(public.trial_balance_uploads)",
      "tbu_record_lifecycle_event(public.trial_balance_uploads,text,text,text,uuid,uuid,uuid,text)"];
    for (const f of fns) {
      const r = (await admin.query(`SELECT has_function_privilege('authenticated','public.${f}','EXECUTE') a, has_function_privilege('anon','public.${f}','EXECUTE') n`)).rows[0];
      if (r.a || r.n) return f;
    }
    return true;
  });
  await check("every SECURITY DEFINER function in the lifecycle migration pins its search_path", async () =>
    (await count(`SELECT count(*) n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.prosecdef
      AND (p.proname LIKE 'tbu_%' OR p.proname LIKE '%trial_balance_%' OR p.proname = 'tb_certification_drives_upload_lifecycle')
      AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')`)) === 0);
  await refused("lifecycle events are append-only, even for the owner role (23001)", "23001", () => admin.query("UPDATE public.trial_balance_upload_lifecycle_events SET reason='x' WHERE id=(SELECT id FROM public.trial_balance_upload_lifecycle_events LIMIT 1)"));
  await check("clients cannot read or write the operation records", async () => {
    const r = await q(user(U.owner), "SELECT count(*)::int n FROM public.trial_balance_upload_operations").catch((e) => e);
    return r instanceof Error ? r.code === "42501" : r[0].n === 0;
  });
  await check("members read their own company's lifecycle events; other tenants see none", async () => {
    const mine = await one(user(U.viewer), "SELECT count(*)::int n FROM public.trial_balance_upload_lifecycle_events WHERE company_id=$1", [C]);
    const theirs = await one(user(U.ownerB), "SELECT count(*)::int n FROM public.trial_balance_upload_lifecycle_events WHERE company_id=$1", [C]);
    return mine.n > 0 && theirs.n === 0 && B !== C;
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
