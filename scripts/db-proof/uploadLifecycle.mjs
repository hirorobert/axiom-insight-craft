#!/usr/bin/env node
// Real-PostgreSQL proof of the trial balance upload lifecycle migrations (20260923100000, 20260923120000, 20260923130000,
// 20260923140000: the security-review hardening — F-01 history immutability, F-02 RLS, F-03 backfill refusal, F-04, F-05).
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

// Splits a migration into top-level statements exactly as a statement-at-a-time runner would (psql in autocommit
// with ON_ERROR_STOP): respects '...', "...", $tag$...$tag$, -- and /* */ comments.
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
// Fingerprint of every public object (tables, columns, functions with bodies, triggers, policies, constraints,
// indexes) plus the rows of the two tables the lifecycle migrations touch. Equal before/after == nothing changed.
const FINGERPRINT_SQL = `SELECT md5(string_agg(x, '|' ORDER BY x)) AS fp FROM (
  SELECT 'c:'||table_name||'.'||column_name||':'||data_type||':'||coalesce(column_default,'')||is_nullable AS x FROM information_schema.columns WHERE table_schema='public'
  UNION ALL SELECT 'r:'||c.relname||c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL SELECT 'f:'||p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
  UNION ALL SELECT 't:'||tgname||':'||tgrelid::regclass::text||':'||tgenabled::text FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'p:'||policyname||':'||tablename||':'||coalesce(qual,'')||':'||coalesce(with_check,'') FROM pg_policies
  UNION ALL SELECT 'k:'||conname||':'||conrelid::regclass::text||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
  UNION ALL SELECT 'u:'||md5(coalesce((SELECT string_agg(to_jsonb(t)::text, ',' ORDER BY t.id) FROM public.trial_balance_uploads t), ''))
  UNION ALL SELECT 'v:'||md5(coalesce((SELECT string_agg(to_jsonb(p)::text, ',' ORDER BY p.id) FROM public.fiscal_periods p), ''))
) s`;
const fingerprint = async () => (await admin.query(FINGERPRINT_SQL)).rows[0].fp;
// Least favourable supported execution: no wrapping transaction; each statement autocommits; stop at the first
// error (psql ON_ERROR_STOP). Returns { index, code } of the failing statement, or null if everything applied.
async function applyAutocommit(file) {
  const stmts = splitStatements(fs.readFileSync(path.join(REPO, "supabase/migrations", file), "utf8"));
  for (let k = 0; k < stmts.length; k++) {
    try { await admin.query(stmts[k]); } catch (e) { return { index: k, code: e.code, count: stmts.length }; }
  }
  return null;
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

  // ── F-03: the backfill never strands fiscal_periods.active_upload_id on a retired upload ──────
  group("F-03 — mandatory preflight names the authoritative upload; the backfill refuses a stranded pointer");
  const PREFLIGHT = fs.readFileSync(path.join(REPO, "scripts/db-preflight/uploadLifecyclePreflight.sql"), "utf8");
  const preflight = async () => {
    const res = [].concat(await admin.query(PREFLIGHT));
    const by = (col, not) => res.find((r) => r.fields?.some((x) => x.name === col) && !(not && r.fields.some((x) => x.name === not)))?.rows ?? null;
    return { blockers: by("would_keep_upload_id"), authority: by("pointer_status"), after: by("lifecycle_state", "file_name") };
  };
  const fp2023 = (await admin.query("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, active_upload_id) VALUES ($1,'2023-12-31','FY2023',$2,$3) RETURNING id", [L, U.legacy, old2023])).rows[0].id;
  await check("the preflight is read-only (SELECT statements only)", async () =>
    !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE)\b/i.test(PREFLIGHT.replace(/--[^\n]*/g, "")));
  await check("preflight §7 lists the blocker: FY2023 names an upload the backfill would retire, and which upload it keeps", async () => {
    const { blockers } = await preflight();
    return blockers?.length === 1 && blockers[0].fiscal_period_id === fp2023 && blockers[0].named_upload_id === old2023 && blockers[0].would_keep_upload_id === new2023;
  });
  await check("preflight §8 reports the authoritative upload per period and marks FY2023 names_retired", async () => {
    const { authority } = await preflight();
    const r = authority?.find((x) => x.company_id === L && Number(x.period_year) === 2023);
    return r?.authoritative_upload_id === new2023 && r.pointer_status === "names_retired" && r.active_upload_id === old2023;
  });
  await check("N-03: the refusal is the file's FIRST statement, before any DDL", async () => {
    const stmts = splitStatements(fs.readFileSync(path.join(REPO, "supabase/migrations", LIFECYCLE_FILE), "utf8"));
    return /^DO \$refuse\$/.test(stmts[0].replace(/^(--[^\n]*\n|\s)+/, "")) && /fiscal_periods/.test(stmts[0]) && stmts.length > 50 ? true : stmts[0].slice(0, 80);
  });
  await check("N-03: applied statement by statement in AUTOCOMMIT (no wrapping transaction), it refuses at statement 1 and changes NOTHING", async () => {
    const LIFECYCLE_OBJECTS = `SELECT count(*) n FROM (
      SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='trial_balance_uploads' AND column_name IN ('lifecycle_state','version','superseded_by_upload_id','replaces_upload_id')
      UNION ALL SELECT 1 FROM pg_class WHERE relname IN ('trial_balance_upload_operations','trial_balance_upload_lifecycle_events','workspace_capability_grants','trial_balance_source_reservations','uq_one_active_upload_per_period')
      UNION ALL SELECT 1 FROM pg_proc WHERE proname IN ('retire_trial_balance_upload','tbu_authorize','can_user_act_on_workspace','reserve_trial_balance_source')) x`;
    const baseline = await count(LIFECYCLE_OBJECTS);
    const before = await fingerprint();
    const r = await applyAutocommit(LIFECYCLE_FILE);
    const after = await fingerprint();
    const leftovers = await count(LIFECYCLE_OBJECTS);
    return r?.index === 0 && r.code === "55000" && before === after && baseline === 0 && leftovers === 0 ? true : JSON.stringify({ r, same: before === after, baseline, leftovers });
  });
  await check(`${LIFECYCLE_FILE} REFUSES to run (55000) while the pointer is stranded, and changes nothing`, async () => {
    let code = null;
    await admin.query("BEGIN");
    try { await admin.query(fs.readFileSync(path.join(REPO, "supabase/migrations", LIFECYCLE_FILE), "utf8")); } catch (e) { code = e.code; }
    await admin.query("ROLLBACK");
    const col = await count("SELECT count(*) n FROM information_schema.columns WHERE table_name='trial_balance_uploads' AND column_name='lifecycle_state'");
    const fp = (await admin.query("SELECT active_upload_id FROM public.fiscal_periods WHERE id=$1", [fp2023])).rows[0].active_upload_id;
    return code === "55000" && col === 0 && fp === old2023;
  });
  // The operator decision the preflight asks for (made explicitly here, never by the migration).
  await admin.query("UPDATE public.fiscal_periods SET active_upload_id=$1 WHERE id=$2", [new2023, fp2023]);
  await check("after an explicit reconcile the preflight is clear (§7 empty, §8 matches)", async () => {
    const { blockers, authority } = await preflight();
    return blockers?.length === 0 && authority.find((x) => x.company_id === L && Number(x.period_year) === 2023)?.pointer_status === "matches";
  });

  await check(`${LIFECYCLE_FILE} applies over the legacy data`, async () => { await applyMigration(LIFECYCLE_FILE); return true; });
  const HARDENING_FILE = "20260923140000_upload_lifecycle_hardening.sql";
  const POINTER_FILE = "20260923150000_upload_pointer_and_source_binding.sql";
  const hcut = files.indexOf(HARDENING_FILE), pcut = files.indexOf(POINTER_FILE);
  await check(`every later migration before ${HARDENING_FILE} applies`, async () => {
    if (hcut < 0 || pcut < 0) return "hardening/pointer migration not found";
    for (const f of files.slice(cut + 1, hcut)) await applyMigration(f); return true;
  });
  // The state the pre-N-01 code could leave behind (possible before 20260923140000's pointer guard existed): a
  // fiscal period naming an upload that is no longer active. Here: the tie loser the backfill retired.
  const fp2025 = (await admin.query("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, active_upload_id) VALUES ($1,'2022-12-31','FY2022',$2,$3) RETURNING id", [L, U.legacy, tieLoser])).rows[0].id;
  await check(`${HARDENING_FILE} applies`, async () => { for (const f of files.slice(hcut, pcut)) await applyMigration(f); return true; });
  await check(`N-01/N-03: ${POINTER_FILE} refuses (statement 1, autocommit, 55000) while a fiscal period names a non-active upload, and changes nothing`, async () => {
    const before = await fingerprint();
    const r = await applyAutocommit(POINTER_FILE);
    const after = await fingerprint();
    const trig = await count("SELECT count(*) n FROM pg_trigger WHERE tgname IN ('trg_tbu_sync_fiscal_period_pointer','trg_tbu_client_source_guard')");
    return r?.index === 0 && r.code === "55000" && before === after && trig === 0 ? true : JSON.stringify({ r, same: before === after, trig });
  });
  await check("preflight §9 names exactly that stranded pointer", async () => {
    const { after } = await preflight();
    return after?.length === 1 && after[0].fiscal_period_id === fp2025 && after[0].active_upload_id === tieLoser && after[0].lifecycle_state === "retired";
  });
  // The operator decision (explicit, here): clear the stale pointer. Then the migration applies.
  await admin.query("UPDATE public.fiscal_periods SET active_upload_id = NULL WHERE id=$1", [fp2025]);
  await check("every later migration also applies (after the explicit reconcile)", async () => { for (const f of files.slice(pcut)) await applyMigration(f); return true; });

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
  await check("F-03: after every migration the fiscal period still names the kept, ACTIVE upload; preflight §9 finds none stranded", async () => {
    const fp = (await admin.query("SELECT active_upload_id FROM public.fiscal_periods WHERE id=$1", [fp2023])).rows[0].active_upload_id;
    const { after } = await preflight();
    return fp === new2023 && (await row(new2023)).lifecycle_state === "active_unprocessed" && after?.length === 0;
  });
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
  // Entity Capacity (20260925100000): this fixture account runs several workspaces, as a Firm-plan account would.
  if ((await count("SELECT count(*) n FROM information_schema.tables WHERE table_name='commercial_capabilities'")) === 1) {
    const prod = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
    const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [U.owner, prod])).rows[0].id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day' FROM public.commercial_plans WHERE product_id=$2 AND code='FIRM'", [bc, prod]);
  }
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
  const register = (who, reservation, period, periodId = null) => one(user(who), "SELECT * FROM public.register_trial_balance_upload($1,10,$2,$3,NULL)", [reservation, period, periodId]);
  // The workspace-scoped browser path: reserve → (signed upload of exactly that object) → register.
  const workspaceUpload = async (company, period, who = U.owner, periodId = null) => {
    const r = await reserve(who, company);
    if (r.outcome !== "reserved") throw Object.assign(new Error(`reserve ${r.outcome}`), { outcome: r.outcome });
    const objId = await putObject(r.object_path);
    const g = await register(who, r.reservation_id, period, periodId);
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
  await check("the cleanup target marks a discard deletable ONLY when terminal AND claimed", async () => {
    const u = await workspaceUpload(C, 2053, U.owner); const { b } = await discardFully(U.owner, u.id);
    const t1 = (await admin.query("SELECT deletion_eligible FROM public.tbu_storage_cleanup_target($1)", [b.operation_id])).rows[0].deletion_eligible;
    await expire(b.operation_id);
    const t2 = (await admin.query("SELECT deletion_eligible FROM public.tbu_storage_cleanup_target($1)", [b.operation_id])).rows[0].deletion_eligible;
    // F-05: terminal is not enough; the discard must first be CLAIMED ('purging') under the operation lock.
    const claimed = (await one(user(U.owner), "SELECT * FROM public.claim_trial_balance_discard_purge($1)", [b.operation_id])).outcome;
    const t3 = (await admin.query("SELECT deletion_eligible FROM public.tbu_storage_cleanup_target($1)", [b.operation_id])).rows[0].deletion_eligible;
    return t1 === false && t2 === false && claimed === "claimed" && t3 === true;
  });
  await check("unauthorized users cannot list or purge", async () => {
    const listed = await q(user(U.unrelated), "SELECT operation_id FROM public.list_purgeable_trial_balance_sources($1)", [C]);
    const u = await workspaceUpload(C, 2054, U.owner); const { b } = await discardFully(U.owner, u.id); await expire(b.operation_id);
    return listed.length === 0 && (await purge(user(U.partnerTitle), b.operation_id)).outcome === "forbidden";
  });
  await check("a forged row pointing at another workspace's object is never bound, so nothing unrelated can be deleted or restored", async () => {
    const victim = await workspaceUpload(B, 2055, U.ownerB);
    const attacker = (await one(user(U.unrelated), "INSERT INTO public.companies (user_id,name) VALUES ($1,'Attacker') RETURNING id", [U.unrelated])).id;
    // N-02: a client can no longer even create such a row (42501)...
    let clientCode = null;
    try {
      await q(user(U.unrelated), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('x',$1,1,'processing',$2,$3,2055)", [victim.path, U.unrelated, attacker]);
    } catch (e) { clientCode = e.code; }
    // ...and a row forged below the client layer still binds nothing.
    const forged = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('x',$1,1,'processing',$2,$3,2055) RETURNING id",
      [victim.path, U.unrelated, attacker])).rows[0].id;
    const b = await discard(user(U.unrelated), forged, 1);
    const op = (await admin.query("SELECT file_path FROM public.trial_balance_upload_operations WHERE id=$1", [b.operation_id])).rows[0];
    return clientCode === "42501" && b.file_path === null && op.file_path === null && (await objectExists(victim.path));
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

  group("VALIDATION — user-based processing authority (20260923120000); no firm membership required");
  const actorOf = async (u, company) => (await admin.query("SELECT * FROM public.tbu_resolve_processing_actor($1,$2)", [u, company])).rows[0] ?? null;
  await check("solo owner with NO firm membership may validate, as a workspace_user actor", async () => {
    const a = await actorOf(U.solo, S);
    return a?.actor_type === "workspace_user" && a.firm_member_id === null && a.authority_basis === "workspace_owner";
  });
  await check("a manage_source_files grant holder with NO firm membership may validate (explicit_capability)", async () => {
    const a = await actorOf(U.collab, C);
    return (await count("SELECT count(*) n FROM public.firm_members WHERE user_id=$1", [U.collab])) === 0
      && a?.actor_type === "workspace_user" && a.firm_member_id === null && a.authority_basis === "explicit_capability" && a.authority_capability === "manage_source_files";
  });
  await check("a prepare_trial_balance grant alone also suffices", async () => {
    await grant(user(U.owner), C, U.admin, "prepare_trial_balance");
    const a = await actorOf(U.admin, C);
    return a?.actor_type === "workspace_user" && a.authority_capability === "prepare_trial_balance";
  });
  await check("an accepted firm member keeps the firm-member actor exactly as before, with its real role", async () => {
    const o = await actorOf(U.owner, C); const p = await actorOf(U.partnerTitle, C);
    return o?.actor_type === "user" && o.firm_member_id === ownerMemberOf[C] && o.firm_member_role === "owner" && o.authority_basis === "workspace_owner"
      && p?.actor_type === "user" && p.firm_member_role === "partner" && p.authority_basis === "firm_membership";
  });
  await check("unrelated, other-workspace owner, revoked and anonymous users may not validate", async () =>
    (await actorOf(U.unrelated, C)) === null && (await actorOf(U.ownerB, C)) === null && (await actorOf(U.revoked, C)) === null && (await actorOf(null, C)) === null);
  await check("the resolver never creates a firm membership", async () => (await count("SELECT count(*) n FROM public.firm_members WHERE user_id IN ($1,$2)", [U.collab, U.solo])) === 0);

  group("ENGINE LEDGER — an attributable workspace_user actor; firm-member and system rows unchanged");
  const runAs = (company, actorType, fm, au, period = 2100) => admin.query(
    "INSERT INTO public.engine_runs (company_id, actor_type, firm_member_id, actor_user_id, function_name, engine_version, status, period_year) VALUES ($1,$2,$3,$4,'process-trial-balance','proof','running',$5) RETURNING id",
    [company, actorType, fm, au, period]);
  await check("a workspace_user engine run records the user and no membership", async () => (await runAs(S, "workspace_user", null, U.solo)).rows.length === 1);
  await refused("a workspace_user run can never carry a firm membership (23514)", "23514", () => runAs(C, "workspace_user", ownerMemberOf[C], U.owner));
  await refused("a workspace_user run must name its user (23514)", "23514", () => runAs(C, "workspace_user", null, null));
  await refused("a firm-member 'user' run cannot also claim a user actor (23514)", "23514", () => runAs(C, "user", ownerMemberOf[C], U.owner));
  await refused("a system run carries no actor at all (23514)", "23514", () => runAs(C, "system", null, U.owner));
  await refused("actor_user_id is immutable (P0001)", "P0001", async () => {
    const id = (await runAs(S, "workspace_user", null, U.solo)).rows[0].id;
    await admin.query("UPDATE public.engine_runs SET actor_user_id=$2, status='failed', completed_at=now() WHERE id=$1", [id, U.owner]);
  });
  const claim = async (company, au, rid) => {
    const run = (await runAs(company, "workspace_user", null, au)).rows[0].id;
    return admin.query("INSERT INTO public.idempotency_keys (company_id, actor_type, actor_user_id, function_name, client_request_id, request_hash, engine_run_id) VALUES ($1,'workspace_user',$2,'process-trial-balance',$3,'h',$4)", [company, au, rid, run]);
  };
  await check("idempotency: one request id by two different workspace users is two separate claims", async () => { const rid = uuid(); await claim(C, U.collab, rid); await claim(C, U.admin, rid); return true; });
  await refused("idempotency: the same workspace user and request id cannot claim twice (23505)", "23505", async () => { const rid = uuid(); await claim(C, U.collab, rid); await claim(C, U.collab, rid); });
  await check("a certification from a workspace_user run drives the lifecycle and names that user, with no membership", async () => {
    const u = await workspaceUpload(C, 2098, U.collab);
    const svc = await pool.connect();
    try { await svc.query("BEGIN; SET LOCAL ROLE service_role"); await svc.query("UPDATE public.trial_balance_uploads SET source_file_hash='h' WHERE id=$1", [u.id]); await svc.query("COMMIT"); }
    catch (e) { await svc.query("ROLLBACK").catch(() => {}); throw e; } finally { svc.release(); }
    const run = (await runAs(C, "workspace_user", null, U.collab, 2098)).rows[0].id;
    await admin.query("SELECT public.commit_tb_certification($1,'process-trial-balance',$2,$3,2098,'h','n','o',false,false,'[]'::jsonb,'[]'::jsonb)", [run, u.id, C]);
    const ev = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE upload_id=$1 AND actor_kind='engine' ORDER BY occurred_at DESC LIMIT 1", [u.id])).rows[0];
    return (await row(u.id)).lifecycle_state === "active_processed" && ev?.actor_user_id === U.collab && ev.actor_membership_id === null;
  });

  group("SWEEPER — scheduled and server-only: exactly the terminal or abandoned objects, nothing else");
  const candidates = () => q(SERVICE, "SELECT * FROM public.tbu_sweeper_candidates(500)");
  const sweepDone = async (kind, id) => (await one(SERVICE, "SELECT public.tbu_sweeper_complete($1,$2) AS o", [kind, id])).o;
  const ageReservation = (id) => admin.query("UPDATE public.trial_balance_source_reservations SET expires_at = now() - interval '16 minutes' WHERE id=$1", [id]);
  await check("a discard inside the undo window is not a candidate and cannot be completed; the source survives", async () => {
    const u = await workspaceUpload(C, 2110, U.owner); const { b } = await discardFully(U.owner, u.id);
    return !(await candidates()).some((c) => c.target_id === b.operation_id) && (await sweepDone("discard", b.operation_id)) === "not_eligible" && (await objectExists(u.path));
  });
  await check("after the window: listed for deletion; recorded only once the object is gone; Undo then expired; engine-attributed event", async () => {
    const u = await workspaceUpload(C, 2111, U.collab); const { b } = await discardFully(U.collab, u.id); await expire(b.operation_id);
    const c = (await candidates()).find((x) => x.target_id === b.operation_id);
    const early = await sweepDone("discard", b.operation_id);
    await deleteObject(u.path);
    const done = await sweepDone("discard", b.operation_id);
    const ev = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE operation_id=$1 ORDER BY occurred_at DESC LIMIT 1", [b.operation_id])).rows[0];
    return c?.kind === "discard" && c.delete_object === true && c.object_path === u.path && early === "storage_cleanup_pending" && done === "purged"
      && (await sweepDone("discard", b.operation_id)) === "already_done" && (await restore(user(U.owner), b.operation_id)).outcome === "expired"
      && ev?.actor_kind === "engine" && ev.authority_basis === "engine" && ev.actor_user_id === null;
  });
  await check("a restored discard is never a candidate, even after the window", async () => {
    const u = await workspaceUpload(C, 2112, U.owner); const { b } = await discardFully(U.owner, u.id);
    await restore(user(U.owner), b.operation_id); await expire(b.operation_id);
    return !(await candidates()).some((c) => c.target_id === b.operation_id) && (await sweepDone("discard", b.operation_id)) === "not_eligible" && (await objectExists(u.path));
  });
  await check("an abandoned cancel-replacement cleanup is finished by the sweeper after the grace period only", async () => {
    const u = await workspaceUpload(C, 2099, U.owner); await certify(C, u.id, 2099);
    const r = await reservedReplacement(U.collab, C);
    const rep = await retireWith(U.collab, u.id, Number((await row(u.id)).version), r.reservation_id);
    const cx = await cancel(user(U.owner), rep.new_upload_id, Number((await row(rep.new_upload_id)).version));
    const inGrace = (await candidates()).some((c) => c.target_id === cx.operation_id);
    await admin.query("UPDATE public.trial_balance_upload_operations SET created_at = now() - interval '6 minutes' WHERE id=$1", [cx.operation_id]);
    const c = (await candidates()).find((x) => x.target_id === cx.operation_id);
    await deleteObject(r.object_path);
    return !inGrace && c?.kind === "cancel_replacement" && c.delete_object === true && c.object_path === r.object_path
      && (await sweepDone("cancel_replacement", cx.operation_id)) === "completed" && (await sweepDone("cancel_replacement", cx.operation_id)) === "already_done";
  });
  await check("an expired, unconsumed reservation's object is reclaimed; a live or a consumed one never is", async () => {
    const live = await reserve(U.owner, C, "live.csv"); await putObject(live.object_path);
    const dead = await reserve(U.collab, C, "abandoned.csv"); await putObject(dead.object_path); await ageReservation(dead.reservation_id);
    const used = await workspaceUpload(C, 2114, U.owner); await ageReservation(used.reservation);
    const cs = await candidates();
    const cd = cs.find((x) => x.target_id === dead.reservation_id);
    const early = await sweepDone("reservation", dead.reservation_id);
    await deleteObject(dead.object_path);
    return cd?.kind === "reservation" && cd.delete_object === true && cd.object_path === dead.object_path
      && !cs.some((x) => x.target_id === live.reservation_id) && !cs.some((x) => x.target_id === used.reservation)
      && early === "storage_cleanup_pending" && (await sweepDone("reservation", dead.reservation_id)) === "reclaimed"
      && (await sweepDone("reservation", live.reservation_id)) === "not_eligible" && (await sweepDone("reservation", used.reservation)) === "not_eligible"
      && (await register(U.collab, dead.reservation_id, 2115)).outcome === "expired"
      && (await objectExists(live.object_path)) && (await objectExists(used.path));
  });
  await check("a late upload against an already-swept reservation (signed-URL tail) is listed and reclaimed again", async () => {
    const dead = await reserve(U.owner, C, "late.csv"); await ageReservation(dead.reservation_id);
    const first = await sweepDone("reservation", dead.reservation_id);
    await putObject(dead.object_path);
    const c = (await candidates()).find((x) => x.target_id === dead.reservation_id);
    await deleteObject(dead.object_path);
    return first === "reclaimed" && c?.delete_object === true && (await sweepDone("reservation", dead.reservation_id)) === "reclaimed";
  });
  await check("N-02: a FORGED row naming an abandoned reservation's object does not hold it back; the object is reclaimed", async () => {
    const dead = await reserve(U.owner, C, "shared.csv"); await putObject(dead.object_path); await ageReservation(dead.reservation_id);
    await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ('x',$1,1,'processing',$2,2116,$3)", [dead.object_path, C, U.owner]);
    const c = (await candidates()).find((x) => x.target_id === dead.reservation_id);
    const held = (await one(SERVICE, "SELECT public.tbu_object_referenced($1) AS r", [dead.object_path])).r;
    await deleteObject(dead.object_path);
    return c?.delete_object === true && held === false && (await sweepDone("reservation", dead.reservation_id)) === "reclaimed";
  });

  group("SWEEPER invocation — single-use database tickets; no stored key; service_role only");
  const mint = async () => (await one(SERVICE, "SELECT public.tbu_mint_source_sweeper_ticket() AS t")).t;
  const redeem = async (t) => (await one(SERVICE, "SELECT public.tbu_redeem_source_sweeper_ticket($1) AS r", [t])).r;
  await check("a minted ticket (256-bit hex) redeems exactly once", async () => { const t = await mint(); return /^[0-9a-f]{64}$/.test(t) && (await redeem(t)) === true && (await redeem(t)) === false; });
  await check("forged, malformed and expired tickets never redeem; only the SHA-256 is stored", async () => {
    const t = await mint();
    const stored = await count("SELECT count(*) n FROM public.tbu_source_sweeper_tickets WHERE token_hash=$1", [t]);
    await admin.query("UPDATE public.tbu_source_sweeper_tickets SET expires_at = now() - interval '1 second' WHERE token_hash = encode(sha256(convert_to($1,'UTF8')),'hex')", [t]);
    return stored === 0 && (await redeem(t)) === false && (await redeem("f".repeat(64))) === false && (await redeem("not-a-ticket")) === false && (await redeem(null)) === false;
  });
  await check(`${CONCURRENCY} concurrent redemptions of one ticket: exactly one succeeds`, async () => {
    const t = await mint();
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => redeem(t)));
    return out.filter(Boolean).length === 1;
  });
  await check("configuration accepts only a trial-balance-source-sweeper function URL", async () => {
    const cfg = async (u) => (await one(SERVICE, "SELECT public.tbu_configure_source_sweeper($1) AS o", [u])).o;
    return (await cfg("https://evil.example/steal")) === "invalid_url" && (await cfg("http://evil.example/functions/v1/trial-balance-source-sweeper")) === "invalid_url"
      && (await cfg(null)) === "invalid_url" && (await cfg("https://project.supabase.co/functions/v1/trial-balance-source-sweeper")) === "configured";
  });
  await check("the scheduled entry point never errors: dispatches only with work, configuration and pg_net (absent here)", async () => {
    const run = async () => (await one(SERVICE, "SELECT public.tbu_run_source_sweeper() AS o")).o;
    const u = await workspaceUpload(C, 2117, U.owner); const { b } = await discardFully(U.owner, u.id); await expire(b.operation_id);
    const withConfig = await run();
    await admin.query("DELETE FROM public.tbu_source_sweeper_config");
    const noConfig = await run();
    return withConfig === "scheduler_unavailable" && noConfig === "not_configured";
  });
  await check("sweeper functions: service_role only (never authenticated or anon); ticket and config tables unreadable by every client role", async () => {
    for (const f of ["tbu_sweeper_candidates(integer)", "tbu_sweeper_complete(text,uuid)", "tbu_configure_source_sweeper(text)", "tbu_mint_source_sweeper_ticket()",
      "tbu_redeem_source_sweeper_ticket(text)", "tbu_run_source_sweeper()", "tbu_resolve_processing_actor(uuid,uuid)"]) {
      const r = (await admin.query(`SELECT has_function_privilege('authenticated','public.${f}','EXECUTE') a, has_function_privilege('anon','public.${f}','EXECUTE') n, has_function_privilege('service_role','public.${f}','EXECUTE') s`)).rows[0];
      if (r.a || r.n || !r.s) return f;
    }
    for (const t of ["tbu_source_sweeper_tickets", "tbu_source_sweeper_config"]) {
      const r = (await admin.query(`SELECT has_table_privilege('authenticated','public.${t}','SELECT') a, has_table_privilege('anon','public.${t}','SELECT') n, has_table_privilege('service_role','public.${t}','SELECT') s`)).rows[0];
      if (r.a || r.n || r.s) return t;
    }
    return true;
  });
  await refused("authenticated cannot mint a ticket (42501)", "42501", () => q(user(U.owner), "SELECT public.tbu_mint_source_sweeper_ticket()"));
  await refused("authenticated cannot complete a sweep (42501)", "42501", () => q(user(U.owner), "SELECT public.tbu_sweeper_complete('discard',$1)", [uuid()]));

  group("ACCESS BRIDGE — discover and open a workspace by ownership or an explicit Prepare grant (20260923130000)");
  const accessOf = async (u, company) => (await q(user(u), "SELECT * FROM public.get_workspace_access($1)", [company]))[0] ?? null;
  const sharedOf = async (u) => (await q(user(u), "SELECT company_id FROM public.list_shared_workspaces()")).map((r) => r.company_id);
  const visible = async (u, sql, params) => (await q(user(u), sql, params)).length;
  const ALL_STAGES = ["prepare", "reconcile", "statements", "tax", "compliance", "filing", "monitor"];
  await check("solo owner (no membership) opens their workspace with every stage; their own workspace is not 'shared'", async () => {
    const a = await accessOf(U.solo, S);
    return a?.access === "owner" && JSON.stringify(a.stages) === JSON.stringify(ALL_STAGES) && a.name === "Solo workspace" && (await sharedOf(U.solo)).length === 0;
  });
  await check("a manage_source_files grant holder with NO membership discovers and opens ONLY the granted workspace, Prepare only", async () => {
    const a = await accessOf(U.collab, C);
    const shared = await sharedOf(U.collab);
    return (await count("SELECT count(*) n FROM public.firm_members WHERE user_id=$1", [U.collab])) === 0
      && a?.access === "capability" && JSON.stringify(a.stages) === '["prepare"]' && a.capabilities.includes("manage_source_files")
      && JSON.stringify(shared) === JSON.stringify([C]) && (await accessOf(U.collab, B)) === null && (await accessOf(U.collab, S)) === null;
  });
  await check("a prepare_trial_balance grant opens Prepare only", async () => {
    const a = await accessOf(U.admin, C);
    return a?.access === "capability" && JSON.stringify(a.stages) === '["prepare"]' && a.capabilities.includes("prepare_trial_balance");
  });
  await check("the resolver returns only minimum metadata: no TIN, code, owner or billing columns", async () => {
    const a = await accessOf(U.collab, C);
    return JSON.stringify(Object.keys(a).sort()) === JSON.stringify(["access", "capabilities", "company_id", "created_at", "currency", "fiscal_year_end", "name", "reporting_framework", "stages"]);
  });
  await check("the grant holder reads the Prepare data of the granted workspace (uploads, certifications) and nothing of any other", async () => {
    const upC = await visible(U.collab, "SELECT id FROM public.trial_balance_uploads WHERE company_id=$1", [C]);
    const allC = await count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1", [C]);
    const certC = await visible(U.collab, "SELECT id FROM public.tb_certifications WHERE company_id=$1", [C]);
    return upC === allC && upC > 0 && certC > 0
      && (await visible(U.collab, "SELECT id FROM public.trial_balance_uploads WHERE company_id=$1", [B])) === 0
      && (await visible(U.collab, "SELECT id FROM public.tb_certifications WHERE company_id=$1", [B])) === 0;
  });
  await check("the grant opens NOTHING outside Prepare: the companies row, engagements, periods, reconciliations, sign-offs, statements and tax stay unreadable", async () => {
    for (const [t, col] of [["companies", "id"], ["engagements", "company_id"], ["fiscal_periods", "company_id"], ["statement_sign_offs", "company_id"],
      ["hesabu_validations", "company_id"], ["tax_computations", "company_id"], ["safisha_reconciliations", null], ["upload_integrity_findings", "company_id"]]) {
      if (!(await admin.query("SELECT to_regclass($1) r", [`public.${t}`])).rows[0].r) continue;
      const n = col ? await visible(U.collab, `SELECT 1 FROM public.${t} WHERE ${col}=$1`, [C]) : await visible(U.collab, `SELECT 1 FROM public.${t}`);
      if (n !== 0) return `${t} readable (${n})`;
    }
    return true;
  });
  await check("grant administration stays owner-only for a grant holder", async () =>
    (await grant(user(U.collab), C, U.unrelated, "manage_source_files")).outcome === "forbidden");
  await check("review_close / administer_workspace alone open nothing (no stage implements them here)", async () => {
    await grant(user(U.owner), C, U.ownerB, "review_close");
    const a = await accessOf(U.ownerB, C);
    await revoke(user(U.owner), C, U.ownerB, "review_close");
    return a === null && !(await sharedOf(U.ownerB)).includes(C);
  });
  await check("an occupational TITLE without a grant gives no new PR #32 access (existing membership only; nothing shared; no Prepare-grant read path)", async () => {
    const a = await accessOf(U.partnerTitle, C);
    const canRead = (await one(user(U.partnerTitle), "SELECT public.tbu_can_read_prepare($1) r", [C])).r;
    return a?.access === "member" && (await sharedOf(U.partnerTitle)).length === 0 && canRead === false;
  });
  await check("unrelated users and other workspaces' owners cannot discover or open the workspace (cross-workspace URL denied)", async () =>
    (await accessOf(U.unrelated, C)) === null && (await accessOf(U.ownerB, C)) === null && (await sharedOf(U.unrelated)).length === 0
    && (await visible(U.unrelated, "SELECT id FROM public.trial_balance_uploads WHERE company_id=$1", [C])) === 0
    && (await accessOf(U.owner, B)) === null);
  await check("revoking the grant removes discovery, access and the Prepare reads on the very next read", async () => {
    await grant(user(U.owner), C, U.unrelated, "manage_source_files");
    const before = [await accessOf(U.unrelated, C), await sharedOf(U.unrelated), await visible(U.unrelated, "SELECT id FROM public.trial_balance_uploads WHERE company_id=$1", [C])];
    await revoke(user(U.owner), C, U.unrelated, "manage_source_files");
    const after = [await accessOf(U.unrelated, C), await sharedOf(U.unrelated), await visible(U.unrelated, "SELECT id FROM public.trial_balance_uploads WHERE company_id=$1", [C])];
    return before[0]?.access === "capability" && before[1].includes(C) && before[2] > 0 && after[0] === null && after[1].length === 0 && after[2] === 0;
  });
  await refused("anonymous cannot resolve access (42501)", "42501", () => q(ANON, "SELECT * FROM public.get_workspace_access($1)", [C]));
  await refused("anonymous cannot list shared workspaces (42501)", "42501", () => q(ANON, "SELECT * FROM public.list_shared_workspaces()"));
  await check("no firm_members row was created in the granted workspace for any grant holder", async () =>
    (await count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1 AND user_id IN ($2,$3,$4)", [C, U.collab, U.admin, U.unrelated])) === 0
    && (await count("SELECT count(*) n FROM public.firm_members WHERE user_id IN ($1,$2)", [U.collab, U.admin])) === 0);
  await check("sweeper status is service_role only and reports what exists (here: no pg_net, no cron)", async () => {
    const r = (await admin.query("SELECT has_function_privilege('authenticated','public.tbu_source_sweeper_status()','EXECUTE') a, has_function_privilege('service_role','public.tbu_source_sweeper_status()','EXECUTE') s")).rows[0];
    const st = await one(SERVICE, "SELECT * FROM public.tbu_source_sweeper_status()");
    return !r.a && r.s && st.pg_net_installed === false && st.cron_job_active === false;
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

  // ── Independent security review of 1fd1275: F-01, F-02, F-04, F-05 (20260923140000) ─────────────
  const ACTIVE_STATES = ["active_unprocessed", "active_processing", "active_processed", "blocked"];
  const expectCode = async (code, fn) => { try { await fn(); return false; } catch (e) { return e.code === code; } };
  const sanctioned = async (sql, params) => {
    await admin.query("BEGIN");
    try { await admin.query("SELECT set_config('axiom.tbu_lifecycle_op','proof',true)"); const r = await admin.query(sql, params); await admin.query("COMMIT"); return r; }
    catch (e) { await admin.query("ROLLBACK"); throw e; }
  };
  const commitCert = async (company, upload, period) => {
    const run = (await admin.query("INSERT INTO public.engine_runs (company_id, actor_type, firm_member_id, function_name, engine_version, status, period_year) VALUES ($1,'user',$2,'process-trial-balance','proof','running',$3) RETURNING id",
      [company, ownerMemberOf[company], period])).rows[0].id;
    return admin.query("SELECT public.commit_tb_certification($1,'process-trial-balance',$2,$3,$4,'h','n','o',false,false,'[]'::jsonb,'[]'::jsonb)", [run, upload, company, period]);
  };
  const newPeriod = async (company, year, pointer = null) => (await admin.query(
    "INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, active_upload_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [company, `${year}-12-31`, `FY${year}`, U.owner, pointer])).rows[0].id;
  const pointerOf = async (fp) => (await admin.query("SELECT active_upload_id FROM public.fiscal_periods WHERE id=$1", [fp])).rows[0].active_upload_id;

  group("F-01 — a historical upload is never reprocessed, rewritten, certified or made the period's active upload");
  const hBase = await workspaceUpload(C, 2001, U.owner); await certify(C, hBase.id, 2001);
  const hRes = await reservedReplacement(U.owner, C);
  const hRep = await retireWith(U.owner, hBase.id, Number((await row(hBase.id)).version), hRes.reservation_id);
  const pend = await workspaceUpload(C, 2002, U.owner);
  const pendOp = await discard(user(U.owner), pend.id, Number((await row(pend.id)).version));
  const ret = await workspaceUpload(C, 2026, U.owner);
  const retOp = await discard(user(U.owner), ret.id, Number((await row(ret.id)).version));
  await workspaceUpload(C, 2026, U.collab);
  await admin.query("UPDATE public.trial_balance_upload_operations SET created_at = now() - interval '16 minutes' WHERE id=$1", [retOp.operation_id]);
  await sweepDone("stale_discard", retOp.operation_id);
  const HIST = [["superseded", hBase.id, U.owner, C, 2001], ["retired", ret.id, U.owner, C, 2026], ["retired by the backfill", old2023, null, L, 2023], ["discard_pending", pend.id, U.owner, C, 2002]];
  await check("fixtures: superseded (by replacement), retired (by the backfill) and discard_pending rows exist", async () =>
    hRep.outcome === "replaced" && pendOp.outcome === "discard_pending"
    && (await row(hBase.id)).lifecycle_state === "superseded" && (await row(old2023)).lifecycle_state === "retired" && (await row(ret.id)).lifecycle_state === "retired" && (await row(pend.id)).lifecycle_state === "discard_pending");
  const snapshots = {};
  for (const [, id] of HIST) snapshots[id] = JSON.stringify(await row(id));
  for (const [state, id, uploader] of HIST) {
    if (uploader) await refused(`${state}: the client Retry write (status/processing_result/accounting_errors/is_valid) by its own uploader is refused`, "55000", () =>
      q(user(uploader), "UPDATE public.trial_balance_uploads SET status='processing', processing_result=NULL, accounting_errors=NULL, is_valid=NULL WHERE id=$1", [id]));
    await check(`${state}: the engine (service_role) cannot rewrite status, results, validation, identity or source fields`, async () => {
      const sets = ["status='validating'", "processing_result='{}'::jsonb", "validation_report='{}'::jsonb", "accounting_errors='[{\"forged\":true}]'::jsonb", "is_valid=true",
        "processed_at=now()", "source_file_hash='forged'", "file_path='workspaces/forged.csv'", "file_name='forged.csv'", `company_id='${B}'`, "period_year=1999",
        `user_id='${U.unrelated}'`, "uploaded_at=now()", "lifecycle_state='active_processed'"];
      for (const s of sets) if (!(await expectCode("55000", () => q(SERVICE, `UPDATE public.trial_balance_uploads SET ${s} WHERE id=$1`, [id])))) return s;
      return true;
    });
  }
  await check("every refused attempt left each historical row byte-for-byte unchanged", async () => {
    for (const [, id] of HIST) if (JSON.stringify(await row(id)) !== snapshots[id]) return id;
    return true;
  });
  await check("a historical upload cannot be certified (55000); no certification row is added", async () => {
    const before = await count("SELECT count(*) n FROM public.tb_certifications");
    for (const [state, id, , company, period] of HIST) if (!(await expectCode("55000", () => commitCert(company, id, period)))) return state;
    return (await count("SELECT count(*) n FROM public.tb_certifications")) === before;
  });
  const fpH = await newPeriod(C, 2001);
  await check("fiscal_periods.active_upload_id refuses every historical upload (insert and update), accepts an active one and NULL", async () => {
    for (const [state, id, , company] of HIST) {
      if (!(await expectCode("55000", () => admin.query("UPDATE public.fiscal_periods SET active_upload_id=$1 WHERE id=$2", [id, fpH])))) return `update ${state}`;
      if (!(await expectCode("55000", () => newPeriod(company, 2090 + HIST.findIndex((h) => h[1] === id), id)))) return `insert ${state}`;
    }
    if (!(await expectCode("55000", () => admin.query("UPDATE public.fiscal_periods SET active_upload_id=$1 WHERE id=$2", [uuid(), fpH])))) return "missing upload";
    await admin.query("UPDATE public.fiscal_periods SET active_upload_id=$1 WHERE id=$2", [hRep.new_upload_id, fpH]);
    const ok = (await pointerOf(fpH)) === hRep.new_upload_id;
    await admin.query("UPDATE public.fiscal_periods SET active_upload_id=NULL WHERE id=$1", [fpH]);
    return ok && (await pointerOf(fpH)) === null;
  });
  await check("the 'valid' promotion never promotes a historical upload, even inside a sanctioned lifecycle operation", async () => {
    let outcome;
    try { await sanctioned("UPDATE public.trial_balance_uploads SET period_id=$1, status='valid' WHERE id=$2", [fpH, hBase.id]); outcome = "updated"; }
    catch (e) { outcome = e.code; }
    return (await pointerOf(fpH)) === null ? true : `pointer moved (${outcome})`;
  });
  await check("an ACTIVE upload turning 'valid' is still promoted (existing behaviour preserved)", async () => {
    const fp = await newPeriod(C, 2003); const a = await workspaceUpload(C, 2003, U.owner, fp);
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='valid' WHERE id=$1", [a.id]);
    return (await pointerOf(fp)) === a.id;
  });
  await check("the database's own ON DELETE SET NULL still reaches a historical row (and changes nothing else)", async () => {
    const fp = await newPeriod(C, 2004);
    await sanctioned("UPDATE public.trial_balance_uploads SET period_id=$1 WHERE id=$2", [fp, hBase.id]);
    const before = await row(hBase.id);
    await admin.query("DELETE FROM public.fiscal_periods WHERE id=$1", [fp]);
    const after = await row(hBase.id);
    return before.period_id === fp && after.period_id === null && after.lifecycle_state === "superseded"
      && JSON.stringify(after.processing_result) === JSON.stringify(before.processing_result) && after.file_path === before.file_path && after.status === before.status;
  });
  await check("ACTIVE uploads keep processing normally: engine writes, certification, active_processed, client Retry write", async () => {
    const a = await workspaceUpload(C, 2005, U.owner);
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [a.id]);
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='processing', processing_result='{\"status\":\"valid\"}'::jsonb WHERE id=$1", [a.id]);
    await certify(C, a.id, 2005);
    const r = await row(a.id);
    const retried = await q(user(U.owner), "UPDATE public.trial_balance_uploads SET status='processing', processing_result=NULL, accounting_errors=NULL, is_valid=NULL WHERE id=$1 RETURNING id", [a.id]);
    return r.lifecycle_state === "active_processed" && (await authoritative(C, 2005)) === a.id && retried.length === 1 && ACTIVE_STATES.includes((await row(a.id)).lifecycle_state);
  });
  await check("authorized lifecycle operations on historical rows still work: complete + Undo of the pending discard", async () =>
    (await complete(user(U.owner), pendOp.operation_id)).outcome === "deleted_now" && (await restore(user(U.owner), pendOp.operation_id)).outcome === "restored"
    && (await row(pend.id)).lifecycle_state === "active_unprocessed");
  await check("a discarded upload has no row left to reprocess or certify; only Undo brings it back", async () => {
    const d = await workspaceUpload(C, 2006, U.owner); const { b } = await discardFully(U.owner, d.id);
    let code = null; try { await commitCert(C, d.id, 2006); } catch (e) { code = e.code; }
    return (await row(d.id)) === undefined && code !== null && (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [d.id])) === 0
      && (await restore(user(U.owner), b.operation_id)).outcome === "restored" ? true : `certification code ${code}`;
  });

  group("F-02 — upload visibility and updates follow CURRENT workspace authority (SELECT and UPDATE together)");
  const G2 = uuid(), R2 = uuid(), N2 = uuid();
  for (const [id, e] of [[G2, "grantee"], [R2, "revokee"], [N2, "nobody"]]) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `f02-${e}@example.test`]);
  const W = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'F-02 workspace') RETURNING id", [U.owner])).rows[0].id;
  await grant(user(U.owner), W, G2, "manage_source_files"); await grant(user(U.owner), W, R2, "manage_source_files");
  const wOwner = await workspaceUpload(W, 2140, U.owner), wG = await workspaceUpload(W, 2141, G2), wR = await workspaceUpload(W, 2142, R2);
  const personal = (await one(user(R2), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id) VALUES ('personal.csv',$1,10,'processing',$2) RETURNING id", [`${R2}/${uuid()}.csv`, R2])).id;
  await revoke(user(U.owner), W, R2, "manage_source_files");
  const W_IDS = [wOwner.id, wG.id, wR.id].sort();
  const sees = async (caller) => (await q(caller, "SELECT id FROM public.trial_balance_uploads WHERE id = ANY($1::uuid[])", [W_IDS])).map((r) => r.id).sort();
  const writes = async (caller, id) => (await q(caller, "UPDATE public.trial_balance_uploads SET file_name = file_name WHERE id=$1 RETURNING id", [id])).length;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  await check("workspace creator: SELECT all three rows; UPDATE of their own active row still allowed", async () =>
    same(await sees(user(U.owner)), W_IDS) && (await writes(user(U.owner), wOwner.id)) === 1);
  await check("active grantee: SELECT all three rows (including others'); direct UPDATE of none, even their own (writes go through the lifecycle RPCs)", async () =>
    same(await sees(user(G2)), W_IDS) && (await writes(user(G2), wG.id)) === 0 && (await writes(user(G2), wOwner.id)) === 0);
  await check("REVOKED grantee: SELECT none, including the row they uploaded themselves; UPDATE none", async () =>
    (await sees(user(R2))).length === 0 && (await writes(user(R2), wR.id)) === 0 && (await writes(user(R2), wOwner.id)) === 0
    && (await one(user(R2), "SELECT public.tbu_can_read_prepare($1) r", [W])).r === false);
  await check("REVOKED grantee: no lifecycle action on their former upload either (discard forbidden)", async () =>
    (await discard(user(R2), wR.id, Number((await row(wR.id)).version))).outcome === "forbidden" && (await row(wR.id)).lifecycle_state === "active_unprocessed");
  await check("unrelated user: SELECT none, UPDATE none", async () =>
    (await sees(user(N2))).length === 0 && (await writes(user(N2), wOwner.id)) === 0 && (await writes(user(N2), wR.id)) === 0);
  // anon holds no table privilege at all here (42501); where it does, RLS returns nothing. Either is a refusal.
  const anonNone = async (fn) => { try { return (await fn()) === 0; } catch (e) { return e.code === "42501"; } };
  await check("anonymous: SELECT none, UPDATE none", async () => (await anonNone(async () => (await sees(ANON)).length)) && (await anonNone(() => writes(ANON, wOwner.id))));
  await check("an occupational title confers nothing here (partner-titled member of ANOTHER workspace sees none)", async () => (await sees(user(U.partnerTitle))).length === 0);
  await check("accepted members keep their existing access to their own workspace's uploads (unchanged)", async () =>
    (await visible(U.partnerTitle, "SELECT id FROM public.trial_balance_uploads WHERE company_id=$1", [C])) > 0);
  await check("a personal (company-less) upload stays visible and updatable by its uploader, and by no one else", async () =>
    (await visible(R2, "SELECT id FROM public.trial_balance_uploads WHERE id=$1", [personal])) === 1 && (await writes(user(R2), personal)) === 1
    && (await visible(U.owner, "SELECT id FROM public.trial_balance_uploads WHERE id=$1", [personal])) === 0 && (await writes(user(N2), personal)) === 0);
  await check("re-granting restores access immediately; revoking removes it immediately (evaluated live, no cache)", async () => {
    await grant(user(U.owner), W, R2, "manage_source_files"); const back = await sees(user(R2));
    await revoke(user(U.owner), W, R2, "manage_source_files"); const gone = await sees(user(R2));
    return same(back, W_IDS) && gone.length === 0;
  });
  await check("the uploader SELECT and UPDATE policies both exclude workspace rows (checked together)", async () => {
    const p = (await admin.query("SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename='trial_balance_uploads' AND policyname IN ('Users can view their own uploads','Users can update their own uploads')")).rows;
    const sel = p.find((x) => x.cmd === "SELECT"), upd = p.find((x) => x.cmd === "UPDATE");
    return /company_id IS NULL/.test(sel?.qual ?? "") && /company_id IS NULL/.test(upd?.qual ?? "") && /company_id IS NULL/.test(upd?.with_check ?? "");
  });

  group("F-04 — a pending discard never stays stuck");
  const ageOp = (op) => admin.query("UPDATE public.trial_balance_upload_operations SET created_at = now() - interval '16 minutes' WHERE id=$1", [op]);
  await check("inside the 15-minute grace a pending discard is left alone (not listed, not resolvable)", async () => {
    const u = await workspaceUpload(C, 2007, U.owner); const b = await discard(user(U.owner), u.id, Number((await row(u.id)).version));
    return !(await candidates()).some((c) => c.target_id === b.operation_id) && (await sweepDone("stale_discard", b.operation_id)) === "not_eligible"
      && (await row(u.id)).lifecycle_state === "discard_pending";
  });
  await check("stale, period free → the sweeper returns it to its active state; nothing deleted; engine-attributed; late completion is refused", async () => {
    const u = await workspaceUpload(C, 2008, U.owner); const b = await discard(user(U.owner), u.id, Number((await row(u.id)).version)); await ageOp(b.operation_id);
    const c = (await candidates()).find((x) => x.target_id === b.operation_id);
    const done = await sweepDone("stale_discard", b.operation_id);
    const ev = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE operation_id=$1 ORDER BY occurred_at DESC LIMIT 1", [b.operation_id])).rows[0];
    const op = (await admin.query("SELECT state FROM public.trial_balance_upload_operations WHERE id=$1", [b.operation_id])).rows[0].state;
    const late = (await complete(user(U.owner), b.operation_id)).outcome;
    return c?.kind === "stale_discard" && c.delete_object === false && done === "aborted" && (await row(u.id)).lifecycle_state === "active_unprocessed"
      && op === "aborted" && (await objectExists(u.path)) && ev?.actor_kind === "engine" && late === "stale_version"
      && (await sweepDone("stale_discard", b.operation_id)) === "not_eligible" && !(await candidates()).some((x) => x.target_id === b.operation_id)
      ? true : JSON.stringify({ c, done, op, late, ev: ev && { actor_kind: ev.actor_kind } });
  });
  await check("stale, period TAKEN by a newer upload → retired as history (never a second active upload), nothing deleted", async () => {
    const u = await workspaceUpload(C, 2009, U.owner); const b = await discard(user(U.owner), u.id, Number((await row(u.id)).version));
    const n = await workspaceUpload(C, 2009, U.collab); await ageOp(b.operation_id);
    const done = await sweepDone("stale_discard", b.operation_id); const r = await row(u.id);
    return done === "aborted" && r.lifecycle_state === "retired" && /another trial balance became active/.test(r.retired_reason ?? "")
      && (await row(n.id)).lifecycle_state === "active_unprocessed" && (await activeCount(C, 2009)) === 1 && (await objectExists(u.path))
      ? true : JSON.stringify({ done, state: r.lifecycle_state, reason: r.retired_reason });
  });
  await check("evidence appearing mid-saga while the period is TAKEN: the discard aborts to retired (previously stuck discard_pending)", async () => {
    const u = await workspaceUpload(C, 2010, U.owner); const b = await discard(user(U.owner), u.id, Number((await row(u.id)).version));
    const n = await workspaceUpload(C, 2010, U.collab);
    await admin.query("INSERT INTO public.upload_integrity_findings (upload_id, company_id, issue_type) VALUES ($1, $2, 'ENGAGEMENT_COMPANY_MISMATCH')", [u.id, C]);
    const c = await complete(user(U.owner), b.operation_id);
    return c.outcome === "replacement_required" && (await row(u.id)).lifecycle_state === "retired" && (await row(n.id)).lifecycle_state === "active_unprocessed"
      && (await activeCount(C, 2010)) === 1 ? true : JSON.stringify({ c, state: (await row(u.id)).lifecycle_state });
  });
  await check("evidence appearing mid-saga with the period free: back to active, exactly as before", async () => {
    const u = await workspaceUpload(C, 2011, U.owner); const b = await discard(user(U.owner), u.id, Number((await row(u.id)).version));
    await admin.query("INSERT INTO public.upload_integrity_findings (upload_id, company_id, issue_type) VALUES ($1, $2, 'ENGAGEMENT_COMPANY_MISMATCH')", [u.id, C]);
    return (await complete(user(U.owner), b.operation_id)).outcome === "replacement_required" && ACTIVE_STATES.includes((await row(u.id)).lifecycle_state);
  });
  await check("no discard stays pending past the grace after one sweep", async () => {
    for (const c of (await candidates()).filter((x) => x.kind === "stale_discard")) await sweepDone("stale_discard", c.target_id);
    return (await count("SELECT count(*) n FROM public.trial_balance_upload_operations o WHERE o.kind='discard' AND o.state='pending' AND o.created_at <= now() - interval '15 minutes'")) === 0;
  });

  group("F-05 — restore-versus-purge is serialised; nothing a live row references is ever deleted");
  const claimPurge = (caller, op) => one(caller, "SELECT * FROM public.claim_trial_balance_discard_purge($1)", [op]);
  const sweepClaim = async (kind, id) => (await one(SERVICE, "SELECT public.tbu_sweeper_claim($1,$2) AS o", [kind, id])).o;
  const opState = async (op) => (await admin.query("SELECT state FROM public.trial_balance_upload_operations WHERE id=$1", [op])).rows[0].state;
  const eligible = async (op) => (await admin.query("SELECT deletion_eligible FROM public.tbu_storage_cleanup_target($1)", [op])).rows[0].deletion_eligible;
  await check("inside the Undo window a claim is refused (undo_window_open) and Undo still works", async () => {
    const u = await workspaceUpload(C, 2012, U.owner); const { b } = await discardFully(U.owner, u.id);
    return (await claimPurge(user(U.owner), b.operation_id)).outcome === "undo_window_open" && (await sweepClaim("discard", b.operation_id)) === "not_eligible"
      && (await eligible(b.operation_id)) === false && (await restore(user(U.owner), b.operation_id)).outcome === "restored";
  });
  await check("after the window: claim → 'purging' (deletes nothing); only then deletable; Undo is expired; purge completes once the object is gone", async () => {
    const u = await workspaceUpload(C, 2013, U.owner); const { b } = await discardFully(U.owner, u.id); await expire(b.operation_id);
    const before = await eligible(b.operation_id);
    const cl = (await claimPurge(user(U.collab), b.operation_id)).outcome;
    const st = await opState(b.operation_id); const after = await eligible(b.operation_id);
    const r = (await restore(user(U.owner), b.operation_id)).outcome;
    const exists = await objectExists(u.path);
    await deleteObject(u.path);
    return before === false && cl === "claimed" && st === "purging" && after === true && r === "expired" && exists
      && (await claimPurge(user(U.owner), b.operation_id)).outcome === "claimed" && (await purge(user(U.owner), b.operation_id)).outcome === "purged"
      && (await claimPurge(user(U.owner), b.operation_id)).outcome === "already_purged";
  });
  await check("a restored discard can never be claimed", async () => {
    const u = await workspaceUpload(C, 2014, U.owner); const { b } = await discardFully(U.owner, u.id);
    await restore(user(U.owner), b.operation_id); await expire(b.operation_id);
    return (await claimPurge(user(U.owner), b.operation_id)).outcome === "not_purgeable" && (await sweepClaim("discard", b.operation_id)) === "not_eligible" && (await eligible(b.operation_id)) === false;
  });
  await check(`the boundary race: ${CONCURRENCY} concurrent restores and claims AT the window edge; exactly one side wins, never both`, async () => {
    for (let round = 0; round < 4; round++) {
      const u = await workspaceUpload(C, 2021 + round, U.owner); const { b } = await discardFully(U.owner, u.id);
      await admin.query("UPDATE public.trial_balance_upload_operations SET completed_at = now() - public.tbu_undo_window() + interval '40 milliseconds' WHERE id=$1", [b.operation_id]);
      const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => i % 2
        ? restore(user(U.owner), b.operation_id).then((x) => `r:${x.outcome}`)
        : (i % 4 ? claimPurge(user(U.collab), b.operation_id).then((x) => `c:${x.outcome}`) : sweepClaim("discard", b.operation_id).then((x) => `s:${x}`))));
      const restored = out.filter((o) => o === "r:restored").length;
      const claimed = out.filter((o) => o === "c:claimed" || o === "s:claimed").length;
      const st = await opState(b.operation_id);
      if (restored > 1) return `round ${round}: ${restored} restores`;
      if (restored === 1 && (claimed > 0 || st !== "restored" || (await row(u.id))?.lifecycle_state !== "active_unprocessed")) return `round ${round}: both won ${out}`;
      if (claimed > 0 && (restored > 0 || st !== "purging" || (await row(u.id)) !== undefined)) return `round ${round}: both won ${out}`;
      if (restored === 0 && claimed === 0 && st !== "completed") return `round ${round}: neither but state ${st}`;
      if (!(await objectExists(u.path))) return `round ${round}: the object was deleted by a claim`;
    }
    return true;
  });
  await check("an object still referenced by a canonically BOUND live row is never claimed or deletable (user claim, sweeper, candidates)", async () => {
    // Legitimate shared reference: the same uploader's own-folder object, named by a second row of theirs.
    const lg = await legacyUpload(C, 2015, U.owner); const { b } = await discardFully(U.owner, lg.id); await expire(b.operation_id);
    await q(user(U.owner), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('again.csv',$1,10,'processing',$2,$3,2016)", [lg.path, U.owner, C]);
    const cand = (await candidates()).find((x) => x.target_id === b.operation_id);
    return (await claimPurge(user(U.owner), b.operation_id)).outcome === "not_purgeable" && (await sweepClaim("discard", b.operation_id)) === "not_eligible"
      && (await eligible(b.operation_id)) === false && cand?.delete_object === false && (await opState(b.operation_id)) === "completed" && (await objectExists(lg.path))
      ? true : JSON.stringify({ cand });
  });
  await check("N-02: a FORGED row naming a cancelled replacement's object does not hold its cleanup", async () => {
    const u = await workspaceUpload(C, 2018, U.owner); await certify(C, u.id, 2018);
    const r = await reservedReplacement(U.collab, C);
    const rep = await retireWith(U.collab, u.id, Number((await row(u.id)).version), r.reservation_id);
    const cx = await cancel(user(U.owner), rep.new_upload_id, Number((await row(rep.new_upload_id)).version));
    const free = await sweepClaim("cancel_replacement", cx.operation_id);
    await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ('z',$1,1,'processing',$2,2019,$3)", [r.object_path, C, U.owner]);
    return free === "claimed" && (await sweepClaim("cancel_replacement", cx.operation_id)) === "claimed" && (await eligible(cx.operation_id)) === true
      ? true : JSON.stringify({ free, cx });
  });
  await check("the claim is authorized: unrelated / title-only / other-workspace / revoked users are forbidden and nothing changes", async () => {
    const u = await workspaceUpload(C, 2020, U.owner); const { b } = await discardFully(U.owner, u.id); await expire(b.operation_id);
    for (const who of [U.unrelated, U.partnerTitle, U.ownerB, R2]) if ((await claimPurge(user(who), b.operation_id)).outcome !== "forbidden") return who;
    return (await opState(b.operation_id)) === "completed";
  });
  await refused("anonymous cannot claim (42501)", "42501", () => q(ANON, "SELECT * FROM public.claim_trial_balance_discard_purge($1)", [uuid()]));
  await check("internal claim/abort helpers are never client-callable; the sweeper claim is service_role only", async () => {
    for (const f of ["tbu_claim_discard_purge(uuid)", "tbu_abort_discard(uuid,text,uuid,text)", "tbu_sweeper_claim(text,uuid)", "tbu_object_referenced(text)", "tbu_stale_discard_grace()"]) {
      const r = (await admin.query(`SELECT has_function_privilege('authenticated','public.${f}','EXECUTE') a, has_function_privilege('anon','public.${f}','EXECUTE') n`)).rows[0];
      if (r.a || r.n) return f;
    }
    return (await admin.query("SELECT has_function_privilege('service_role','public.tbu_sweeper_claim(text,uuid)','EXECUTE') s")).rows[0].s === true
      && (await admin.query("SELECT has_function_privilege('authenticated','public.claim_trial_balance_discard_purge(uuid)','EXECUTE') s")).rows[0].s === true;
  });

  // ── Re-review of fa56822: N-01 (fiscal-period pointer), N-02 (source-path binding) — 20260923150000 ──────────
  group("N-01 — fiscal_periods.active_upload_id is NULL or the correct ACTIVE upload after every transition");
  const P = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Pointer workspace') RETURNING id", [U.owner])).rows[0].id;
  ownerMemberOf[P] = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND role='owner'", [P])).rows[0].id;
  const stalePointers = () => count(`SELECT count(*) n FROM public.fiscal_periods fp JOIN public.trial_balance_uploads t ON t.id = fp.active_upload_id
    WHERE t.lifecycle_state NOT IN ('active_unprocessed','active_processing','active_processed','blocked')`);
  // NULL, or exactly `expected` and that upload is active. Also re-checks the global invariant every time.
  const pointerIs = async (fp, expected) => {
    const p = await pointerOf(fp);
    if (p !== expected) return `pointer ${p} expected ${expected}`;
    if (p !== null && !ACTIVE_STATES.includes((await row(p)).lifecycle_state)) return `pointer names ${(await row(p)).lifecycle_state}`;
    const stale = await stalePointers();
    return stale === 0 ? true : `${stale} stale pointer(s) in the database`;
  };
  const promote = async (id, fp) => {
    if ((await row(id)).period_id !== fp) throw new Error("fixture: the upload was not registered in that fiscal period");
    return q(SERVICE, "UPDATE public.trial_balance_uploads SET status='valid' WHERE id=$1", [id]);
  };
  const replaceIn = async (company, id) => {
    const r = await reservedReplacement(U.owner, company);
    return retireWith(U.owner, id, Number((await row(id)).version), r.reservation_id);
  };
  const steps = async (list) => { for (const [label, fn] of list) { const r = await fn(); if (r !== true) return `${label}: ${r}`; } return true; };
  await check("replace: the pointer is cleared in the same transaction; the replacement is NOT pointed at merely because it exists; it is once it is validated", async () => {
    const fp = await newPeriod(P, 2001); const a = await workspaceUpload(P, 2001, U.owner, fp); await certify(P, a.id, 2001);
    let rep;
    return steps([
      ["promoted", async () => { await promote(a.id, fp); return pointerIs(fp, a.id); }],
      ["replaced", async () => { rep = await replaceIn(P, a.id); return rep.outcome === "replaced" && (await row(a.id)).lifecycle_state === "superseded" ? pointerIs(fp, null) : `replace ${rep.outcome}`; }],
      ["replacement exists", async () => (await row(rep.new_upload_id)).lifecycle_state === "active_unprocessed" ? pointerIs(fp, null) : "replacement not active"],
      ["replacement validated", async () => { await certify(P, rep.new_upload_id, 2001); await promote(rep.new_upload_id, fp); return pointerIs(fp, rep.new_upload_id); }],
    ]);
  });
  await check("replace a period's upload that is NOT the pointed one: the pointer to another upload is untouched", async () => {
    const fp = await newPeriod(P, 2002); const a = await workspaceUpload(P, 2002, U.owner, fp); await certify(P, a.id, 2002);
    await promote(a.id, fp);
    const other = await workspaceUpload(P, 2003, U.owner); await certify(P, other.id, 2003);
    const rep = await replaceIn(P, other.id);
    return rep.outcome === "replaced" ? pointerIs(fp, a.id) : rep.outcome;
  });
  await check("cancel replacement: the previous upload returns to active and is pointed at again by the existing promotion rule", async () => {
    const fp = await newPeriod(P, 2004); const a = await workspaceUpload(P, 2004, U.owner, fp); await certify(P, a.id, 2004);
    await promote(a.id, fp);
    let rep;
    return steps([
      ["replaced", async () => { rep = await replaceIn(P, a.id); return pointerIs(fp, null); }],
      ["cancelled", async () => {
        const cx = await cancel(user(U.owner), rep.new_upload_id, Number((await row(rep.new_upload_id)).version));
        return ["cancelled", "storage_cleanup_pending", "completed"].includes(cx.outcome) || cx.operation_id ? pointerIs(fp, a.id) : `cancel ${cx.outcome}`;
      }],
      ["restored state", async () => ACTIVE_STATES.includes((await row(a.id)).lifecycle_state) ? true : (await row(a.id)).lifecycle_state],
    ]);
  });
  await check("cancel replacement of a never-validated upload: it returns to active but is NOT pointed at (it was never promoted)", async () => {
    const fp = await newPeriod(P, 2005); const a = await workspaceUpload(P, 2005, U.owner, fp); await certify(P, a.id, 2005);
    const rep = await replaceIn(P, a.id);
    await cancel(user(U.owner), rep.new_upload_id, Number((await row(rep.new_upload_id)).version));
    return ACTIVE_STATES.includes((await row(a.id)).lifecycle_state) ? pointerIs(fp, null) : "not restored";
  });
  await check("discard: pending clears the pointer; completion deletes the row (NULL); Undo restores the row but not the pointer", async () => {
    const u = await workspaceUpload(P, 2006, U.owner); const fp = await newPeriod(P, 2006, u.id);
    let b;
    return steps([
      ["pointed", () => pointerIs(fp, u.id)],
      ["pending", async () => { b = await discard(user(U.owner), u.id, Number((await row(u.id)).version)); return pointerIs(fp, null); }],
      ["completed", async () => (await complete(user(U.owner), b.operation_id)).outcome === "deleted_now" ? pointerIs(fp, null) : "not deleted"],
      ["undone", async () => (await restore(user(U.owner), b.operation_id)).outcome === "restored" ? pointerIs(fp, null) : "not restored"],
    ]);
  });
  await check("discard recovery (stale pending, period free): the row returns to active; the pointer stays NULL (not validated)", async () => {
    const u = await workspaceUpload(P, 2007, U.owner); const fp = await newPeriod(P, 2007, u.id);
    const b = await discard(user(U.owner), u.id, Number((await row(u.id)).version)); const mid = await pointerIs(fp, null);
    await admin.query("UPDATE public.trial_balance_upload_operations SET created_at = now() - interval '16 minutes' WHERE id=$1", [b.operation_id]);
    const done = await sweepDone("stale_discard", b.operation_id);
    return mid === true && done === "aborted" && (await row(u.id)).lifecycle_state === "active_unprocessed" ? pointerIs(fp, null) : JSON.stringify({ mid, done });
  });
  await check("abort's RETIRE branch (stale pending, period taken): the discarded row is retired, the pointer is NULL, the new upload is pointed at once validated", async () => {
    const fp0 = await newPeriod(P, 2008);
    const u = await workspaceUpload(P, 2008, U.owner, fp0); const fp = fp0;
    await admin.query("UPDATE public.fiscal_periods SET active_upload_id=$1 WHERE id=$2", [u.id, fp]);
    const b = await discard(user(U.owner), u.id, Number((await row(u.id)).version));
    const n = await workspaceUpload(P, 2008, U.owner, fp);
    await admin.query("UPDATE public.trial_balance_upload_operations SET created_at = now() - interval '16 minutes' WHERE id=$1", [b.operation_id]);
    const done = await sweepDone("stale_discard", b.operation_id);
    const mid = await pointerIs(fp, null);
    await certify(P, n.id, 2008); await promote(n.id, fp);
    return done === "aborted" && (await row(u.id)).lifecycle_state === "retired" && mid === true ? pointerIs(fp, n.id) : JSON.stringify({ done, mid });
  });
  await check("abort's RETIRE branch via evidence mid-saga (period taken): retired, pointer NULL", async () => {
    const u = await workspaceUpload(P, 2009, U.owner); const fp = await newPeriod(P, 2009, u.id);
    const b = await discard(user(U.owner), u.id, Number((await row(u.id)).version));
    await workspaceUpload(P, 2009, U.owner);
    await admin.query("INSERT INTO public.upload_integrity_findings (upload_id, company_id, issue_type) VALUES ($1, $2, 'ENGAGEMENT_COMPANY_MISMATCH')", [u.id, P]);
    const c = await complete(user(U.owner), b.operation_id);
    return c.outcome === "replacement_required" && (await row(u.id)).lifecycle_state === "retired" ? pointerIs(fp, null) : c.outcome;
  });
  await check("certification to blocked keeps an active upload's pointer (blocked is still the period's active upload)", async () => {
    const u = await workspaceUpload(P, 2010, U.owner); const fp = await newPeriod(P, 2010, u.id);
    await certify(P, u.id, 2010, { blocking: true });
    return (await row(u.id)).lifecycle_state === "blocked" ? pointerIs(fp, u.id) : (await row(u.id)).lifecycle_state;
  });
  await check("no fiscal period anywhere in the database names a non-active upload (preflight §9 empty)", async () => {
    const { after } = await preflight();
    return (await stalePointers()) === 0 && after?.length === 0;
  });
  await check("the pointer sync is internal: not callable by any client role", async () => {
    const r = (await admin.query("SELECT has_function_privilege('authenticated','public.tbu_sync_fiscal_period_pointer()','EXECUTE') a, has_function_privilege('anon','public.tbu_sync_fiscal_period_pointer()','EXECUTE') n")).rows[0];
    return !r.a && !r.n;
  });

  group("N-02 — a source path is bound to its own workspace reservation or its uploader's folder (owner-A / owner-B adversarial)");
  const bound = async (id) => (await one(SERVICE, "SELECT public.tbu_upload_source_bound($1) AS b", [id])).b;
  const held = async (p) => (await one(SERVICE, "SELECT public.tbu_object_referenced($1) AS r", [p])).r;
  const insertAs = (who, company, filePath, uid = who) => q(user(who),
    "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('b.csv',$1,10,'processing',$2,$3,2040) RETURNING id", [filePath, uid, company]);
  const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, message: e.message }; } };
  const aUp = await workspaceUpload(C, 2027, U.owner);
  await check("A's legitimate workspace upload is bound (processes); so are its replacement, its superseded original and an Undo-restored row", async () => {
    const x = await workspaceUpload(C, 2028, U.owner); await certify(C, x.id, 2028);
    const rep = await retireWith(U.owner, x.id, Number((await row(x.id)).version), (await reservedReplacement(U.owner, C)).reservation_id);
    const y = await workspaceUpload(C, 2029, U.owner); const { b } = await discardFully(U.owner, y.id); await restore(user(U.owner), b.operation_id);
    return (await bound(aUp.id)) && (await bound(rep.new_upload_id)) && (await bound(x.id)) && (await bound(y.id)) ? true : "unbound legitimate row";
  });
  await check("legitimate personal / legacy own-folder uploads still insert and are bound", async () => {
    const lg = await legacyUpload(B, 2041, U.ownerB);
    const personal = (await one(user(U.ownerB), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id) VALUES ('p.csv',$1,10,'processing',$2) RETURNING id", [`${U.ownerB}/${uuid()}.csv`, U.ownerB])).id;
    return (await bound(lg.id)) && (await bound(personal));
  });
  await check("a personal (company-less) upload accepts exactly the engine's writes (validating → source hash → valid result)", async () => {
    const id = (await one(user(U.ownerB), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id) VALUES ('p2.csv',$1,10,'processing',$2) RETURNING id", [`${U.ownerB}/${uuid()}.csv`, U.ownerB])).id;
    const steps = [
      ["validating", "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1"],
      ["source hash", "UPDATE public.trial_balance_uploads SET source_file_hash='abc' WHERE id=$1"],
      ["result", "UPDATE public.trial_balance_uploads SET status='valid', is_valid=true, processing_result='{\"status\":\"valid\"}'::jsonb, validation_report='{}'::jsonb, accounting_errors='[]'::jsonb, processed_at=now() WHERE id=$1"],
    ];
    for (const [label, sql] of steps) { try { await q(SERVICE, sql, [id]); } catch (e) { return `${label}: ${e.code} ${e.message}`; } }
    return (await row(id)).status === "valid" && (await bound(id));
  });
  await check("owner B cannot create a row in B naming A's workspace object, A's folder, a made-up workspace path, or as another user (42501)", async () => {
    for (const [label, fn] of [
      ["A's workspace object", () => insertAs(U.ownerB, B, aUp.path)],
      ["A's own folder", () => insertAs(U.ownerB, B, `${U.owner}/${uuid()}.csv`)],
      ["a workspace path in B", () => insertAs(U.ownerB, B, `workspaces/${B}/${uuid()}/forged.csv`)],
      ["traversal", () => insertAs(U.ownerB, B, `${U.ownerB}/../${U.owner}/x.csv`)],
      ["impersonating A", () => insertAs(U.ownerB, B, `${U.owner}/${uuid()}.csv`, U.owner)],
    ]) { const e = await errOf(fn); if (e?.code !== "42501") return `${label}: ${JSON.stringify(e)}`; }
    return true;
  });
  await check("the refusal never reveals whether a guessed foreign object exists (identical code and message)", async () => {
    const real = await errOf(() => insertAs(U.ownerB, B, aUp.path));
    const guessed = await errOf(() => insertAs(U.ownerB, B, `workspaces/${C}/${uuid()}/no-such-object.csv`));
    return real?.code === "42501" && real.code === guessed?.code && real.message === guessed.message;
  });
  await check("no client can re-point an existing row's path or uploader (42501), even their own row", async () => {
    const mine = (await one(user(U.ownerB), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('m.csv',$1,10,'processing',$2,$3,2042) RETURNING id", [`${U.ownerB}/${uuid()}.csv`, U.ownerB, B])).id;
    const e1 = await errOf(() => q(user(U.ownerB), "UPDATE public.trial_balance_uploads SET file_path=$1 WHERE id=$2", [aUp.path, mine]));
    const e2 = await errOf(() => q(user(U.ownerB), "UPDATE public.trial_balance_uploads SET user_id=$1 WHERE id=$2", [U.owner, mine]));
    return e1?.code === "42501" && e2?.code === "42501" ? true : JSON.stringify({ e1, e2 });
  });
  await check("B cannot process A's object: a server-forged row naming it (in B, or even in A) is NOT bound, so process-trial-balance refuses it", async () => {
    const inB = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ('f',$1,1,'processing',$2,2122,$3) RETURNING id", [aUp.path, B, U.ownerB])).rows[0].id;
    const inA = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ('f',$1,1,'processing',$2,2120,$3) RETURNING id", [aUp.path, C, U.ownerB])).rows[0].id;
    return (await bound(inB)) === false && (await bound(inA)) === false && (await bound(aUp.id)) === true;
  });
  await check("B cannot block A's purge: forged rows naming A's discarded object never hold it; A's purge claims and completes", async () => {
    const a2 = await workspaceUpload(C, 2123, U.owner); const { b } = await discardFully(U.owner, a2.id); await expire(b.operation_id);
    await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ('f',$1,1,'processing',$2,2124,$3)", [a2.path, B, U.ownerB]);
    await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ('f',$1,1,'processing',$2,2125,$3)", [a2.path, C, U.ownerB]);
    const h = await held(a2.path);
    const cl = (await one(user(U.owner), "SELECT * FROM public.claim_trial_balance_discard_purge($1)", [b.operation_id])).outcome;
    const el = (await admin.query("SELECT deletion_eligible FROM public.tbu_storage_cleanup_target($1)", [b.operation_id])).rows[0].deletion_eligible;
    await deleteObject(a2.path);
    const pg = (await purge(user(U.owner), b.operation_id)).outcome;
    return h === false && cl === "claimed" && el === true && pg === "purged" ? true : JSON.stringify({ h, cl, el, pg });
  });
  await check("the binding check and path predicate are server-only (service_role), never client-callable", async () => {
    const r = (await admin.query(`SELECT has_function_privilege('authenticated','public.tbu_upload_source_bound(uuid)','EXECUTE') a,
      has_function_privilege('anon','public.tbu_upload_source_bound(uuid)','EXECUTE') n,
      has_function_privilege('authenticated','public.tbu_source_path_bound(text,uuid,uuid,uuid)','EXECUTE') pa,
      has_function_privilege('service_role','public.tbu_upload_source_bound(uuid)','EXECUTE') s`)).rows[0];
    return !r.a && !r.n && !r.pa && r.s;
  });

  // ── Final re-review of fc4cbd4: P-02 binding immutability, N-05/N-06 path rules, N-07, audit — 20260923170000 ──
  group("P-02 — a workspace upload can never be detached, re-attached, moved or re-pointed (any caller role)");
  const X = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Binding workspace') RETURNING id", [U.owner])).rows[0].id;
  ownerMemberOf[X] = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND role='owner'", [X])).rows[0].id;
  await grant(user(U.owner), X, U.collab, "manage_source_files");
  const codeOf = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.code; } };
  const upd = (caller, set, id, params = []) => q(caller, `UPDATE public.trial_balance_uploads SET ${set} WHERE id=$1 RETURNING id`, [id, ...params]);
  const xUp = await workspaceUpload(X, 2001, U.owner);
  const xSnap = JSON.stringify(await row(xUp.id));
  const fpX = await newPeriod(X, 2002);
  const BINDING_CHANGES = [
    ["company_id → NULL (detach)", "company_id = NULL"],
    ["company_id → another workspace the owner also owns", `company_id = '${C}'`],
    ["period_id", `period_id = '${fpX}'`],
    ["period_year", "period_year = 2002"],
    ["fiscal_year_end", "fiscal_year_end = '2002-12-31'"],
    ["user_id", `user_id = '${U.collab}'`],
    ["file_path", `file_path = '${U.owner}/other.csv'`],
  ];
  await check("the OWNER cannot change any binding column of their active workspace upload (42501)", async () => {
    for (const [label, set] of BINDING_CHANGES) { const c = await codeOf(() => upd(user(U.owner), set, xUp.id)); if (c !== "42501") return `${label}: ${c}`; }
    return JSON.stringify(await row(xUp.id)) === xSnap;
  });
  await check("service_role (the engine's own key) cannot either: no role exemption (42501)", async () => {
    for (const [label, set] of BINDING_CHANGES) { const c = await codeOf(() => upd(SERVICE, set, xUp.id)); if (c !== "42501") return `${label}: ${c}`; }
    return JSON.stringify(await row(xUp.id)) === xSnap;
  });
  await check("a granted collaborator cannot either (the row is not updatable by them at all); nothing changes", async () => {
    for (const [label, set] of BINDING_CHANGES) {
      const c = await codeOf(async () => { const r = await upd(user(U.collab), set, xUp.id); if (r.length) throw Object.assign(new Error("updated"), { code: "UPDATED" }); });
      if (!["ok", "42501"].includes(c)) return `${label}: ${c}`;
    }
    return JSON.stringify(await row(xUp.id)) === xSnap;
  });
  await check("historical rows too: a superseded upload's binding cannot be changed by owner or service_role", async () => {
    const h = await workspaceUpload(X, 2003, U.owner); await certify(X, h.id, 2003);
    const r = await retireWith(U.owner, h.id, Number((await row(h.id)).version), (await reservedReplacement(U.owner, X)).reservation_id);
    const snap = JSON.stringify(await row(h.id));
    for (const caller of [user(U.owner), SERVICE]) for (const [label, set] of BINDING_CHANGES) {
      const c = await codeOf(() => upd(caller, set, h.id)); if (!["42501", "55000"].includes(c)) return `${label}: ${c}`;
    }
    return r.outcome === "replaced" && (await row(h.id)).lifecycle_state === "superseded" && JSON.stringify(await row(h.id)) === snap;
  });
  await check("a personal row can never be attached to a workspace (owner or service_role; 42501)", async () => {
    const p = (await one(user(U.owner), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id) VALUES ('p.csv',$1,10,'processing',$2) RETURNING id", [`${U.owner}/${uuid()}.csv`, U.owner])).id;
    const a = await codeOf(() => upd(user(U.owner), `company_id = '${X}', period_year = 2004`, p));
    const b = await codeOf(() => upd(SERVICE, `company_id = '${X}'`, p));
    return a === "42501" && b === "42501" && (await row(p)).company_id === null;
  });
  await check("the detach → process → re-attach attack is impossible, and the upload never leaves the one-active index", async () => {
    const before = await activeCount(X, 2001);
    const detach = await codeOf(() => upd(user(U.owner), "company_id = NULL", xUp.id));
    const second = await codeOf(async () => { const r = await reserve(U.owner, X); await putObject(r.object_path); const g = await register(U.owner, r.reservation_id, 2001); if (g.outcome !== "registered") throw Object.assign(new Error(g.outcome), { code: g.outcome }); });
    return detach === "42501" && before === 1 && (await activeCount(X, 2001)) === 1 && second === "active_upload_exists" ? true : JSON.stringify({ detach, before, second });
  });
  await check("personal rows keep their own freedoms (status, results) but never their path or uploader", async () => {
    const p = (await one(user(U.owner), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id) VALUES ('p.csv',$1,10,'processing',$2) RETURNING id", [`${U.owner}/${uuid()}.csv`, U.owner])).id;
    const ok = (await upd(user(U.owner), "status = 'pending'", p)).length === 1;
    const path = await codeOf(() => upd(user(U.owner), `file_path = '${U.owner}/x.csv'`, p));
    return ok && path === "42501";
  });
  await check("authorized lifecycle operations still work after P-02: replace, cancel, discard, Undo, sweep", async () => {
    const a = await workspaceUpload(X, 2005, U.owner); await certify(X, a.id, 2005);
    const r = await retireWith(U.owner, a.id, Number((await row(a.id)).version), (await reservedReplacement(U.owner, X)).reservation_id);
    const cx = await cancel(user(U.owner), r.new_upload_id, Number((await row(r.new_upload_id)).version));
    const d = await workspaceUpload(X, 2006, U.owner); const { b, c } = await discardFully(U.owner, d.id);
    const u = await restore(user(U.owner), b.operation_id);
    return r.outcome === "replaced" && !!cx.operation_id && ACTIVE_STATES.includes((await row(a.id)).lifecycle_state) && c.outcome === "deleted_now" && u.outcome === "restored"
      ? true : JSON.stringify({ r: r.outcome, cx: cx.outcome, c: c.outcome, u: u.outcome });
  });
  await check("the database's own ON DELETE SET NULL of a deleted fiscal period still reaches a workspace row (period fields only)", async () => {
    const fp = await newPeriod(X, 2007); const a = await workspaceUpload(X, 2007, U.owner, fp);
    const before = await row(a.id);
    await admin.query("DELETE FROM public.fiscal_periods WHERE id=$1", [fp]);
    const after = await row(a.id);
    return before.period_id === fp && after.period_id === null && after.company_id === X && after.file_path === before.file_path && after.user_id === before.user_id;
  });
  await check("deleting a workspace: either the FK detaches its uploads only because the workspace is really gone, or the delete is refused; never a live workspace with a detached row", async () => {
    const K = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Doomed workspace') RETURNING id", [U.owner])).rows[0].id;
    const k = await workspaceUpload(K, 2008, U.owner);
    const del = await codeOf(() => admin.query("DELETE FROM public.companies WHERE id=$1", [K]));
    const r = await row(k.id);
    const companyGone = (await count("SELECT count(*) n FROM public.companies WHERE id=$1", [K])) === 0;
    if (del === "ok") return companyGone && (r === undefined || r.company_id === null) ? true : JSON.stringify({ del, r: r?.company_id });
    return !companyGone && r.company_id === K ? true : JSON.stringify({ del, companyGone, r: r?.company_id });
  });
  await check("a service_role request cannot imitate the FK path: NULLing company_id while the workspace exists is refused", async () =>
    (await codeOf(() => upd(SERVICE, "company_id = NULL", xUp.id))) === "42501" && (await row(xUp.id)).company_id === X);
  await check("every workspace processing transition still writes its audit event (engine, active_unprocessed → active_processing)", async () => {
    const a = await workspaceUpload(X, 2009, U.owner);
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [a.id]);
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET source_file_hash='h9' WHERE id=$1", [a.id]);
    const ev = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE upload_id=$1 AND actor_kind='engine' AND to_state='active_processing'", [a.id])).rows;
    await certify(X, a.id, 2009);
    const cert = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE upload_id=$1 AND to_state='active_processed'", [a.id])).rows;
    return (await row(a.id)).lifecycle_state === "active_processed" && ev.length === 1 && ev[0].company_id === X && cert.length === 1 && cert[0].company_id === X;
  });

  group("N-05 / N-06 — ONE source-path authority; '..' refused only as a whole segment");
  const CORPUS = JSON.parse(fs.readFileSync(path.join(REPO, "src/lib/workspace/__fixtures__/sourcePathCorpus.json"), "utf8"));
  await check("tbu_path_well_formed matches the shared corpus exactly (the Edge Functions' mirror is held to the same file)", async () => {
    for (const p of CORPUS.wellFormed) if ((await one(SERVICE, "SELECT public.tbu_path_well_formed($1) AS ok", [p])).ok !== true) return `should accept ${JSON.stringify(p)}`;
    for (const p of CORPUS.malformed) {
      let ok; try { ok = (await one(SERVICE, "SELECT public.tbu_path_well_formed($1) AS ok", [p])).ok; } catch (e) { ok = e.code === "22021" ? false : `error ${e.code}`; } // NUL cannot even be sent
      if (ok !== false) return `should refuse ${JSON.stringify(p)}: ${ok}`;
    }
    return true;
  });
  await check("a legitimate own-folder file named TB..final.csv is accepted, bound and processable; traversal is refused", async () => {
    const good = (await one(user(U.owner), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id) VALUES ('TB..final.csv',$1,10,'processing',$2) RETURNING id", [`${U.owner}/TB..final.csv`, U.owner])).id;
    const bad = await codeOf(() => q(user(U.owner), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id) VALUES ('x.csv',$1,10,'processing',$2)", [`${U.owner}/../${U.collab}/x.csv`, U.owner]));
    const deeper = await codeOf(() => q(user(U.owner), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id) VALUES ('x.csv',$1,10,'processing',$2)", [`${U.owner}/sub/x.csv`, U.owner]));
    return (await bound(good)) === true && bad === "42501" && deeper === "42501";
  });
  await check("processing (tbu_upload_source_bound), the discard binding (tbu_bound_storage_path) and the cleanup hold (tbu_object_referenced) AGREE on every row kind", async () => {
    const legacy = await legacyUpload(X, 2010, U.owner);
    const ws = await workspaceUpload(X, 2011, U.owner);
    const dotted = (await one(user(U.owner), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('d.csv',$1,10,'processing',$2,$3,2012) RETURNING id", [`${U.owner}/TB..v2.csv`, U.owner, X])).id;
    const forgedA = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ('f',$1,1,'processing',$2,2013,$3) RETURNING id", [`workspaces/${X}/${uuid()}/x.csv`, X, U.owner])).rows[0].id;
    const forgedB = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ('f',$1,1,'processing',$2,2014,$3) RETURNING id", [`${U.collab}/y.csv`, X, U.owner])).rows[0].id;
    const deep = (await admin.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ('f',$1,1,'processing',$2,2015,$3) RETURNING id", [`${U.owner}/a/b.csv`, X, U.owner])).rows[0].id;
    const expected = { [legacy.id]: true, [ws.id]: true, [dotted]: true, [forgedA]: false, [forgedB]: false, [deep]: false };
    for (const [id, want] of Object.entries(expected)) {
      const r = await row(id);
      const proc = await bound(id);
      const disc = (await admin.query("SELECT public.tbu_bound_storage_path(t) AS p FROM public.trial_balance_uploads t WHERE t.id=$1", [id])).rows[0].p;
      const hold = await held(r.file_path);
      if (proc !== want || (disc !== null) !== want || hold !== want) return `${r.file_path}: processing=${proc} discard=${disc !== null} cleanupHold=${hold} expected ${want}`;
    }
    return true;
  });
  await check("there is ONE definition: tbu_bound_storage_path and tbu_object_referenced both delegate to tbu_source_path_bound", async () => {
    const def = async (sig) => (await admin.query(`SELECT pg_get_functiondef('public.${sig}'::regprocedure) d`)).rows[0].d;
    const [b, o, s] = [await def("tbu_bound_storage_path(public.trial_balance_uploads)"), await def("tbu_object_referenced(text)"), await def("tbu_source_path_bound(text,uuid,uuid,uuid)")];
    return /tbu_source_path_bound/.test(b) && /tbu_source_path_bound/.test(o) && /tbu_workspace_source_path_shape/.test(s) && /tbu_personal_source_path/.test(s)
      && !/position\('\.\.'/.test(b + o + s);
  });

  group("N-07 — lifecycle RPCs on a personal upload answer 'forbidden', never a raw 23502");
  await check("discard / cancel / retire on a personal upload: canonical outcome, no exception, no workspace event", async () => {
    const p = (await one(user(U.owner), "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id) VALUES ('p.csv',$1,10,'processing',$2) RETURNING id", [`${U.owner}/${uuid()}.csv`, U.owner])).id;
    const v = Number((await row(p)).version);
    const outs = {};
    for (const [label, fn] of [
      ["discard", () => discard(user(U.owner), p, v)],
      ["cancel", () => cancel(user(U.owner), p, v)],
      ["retire", () => one(user(U.owner), "SELECT * FROM public.retire_trial_balance_upload($1,$2,$3,10,'proof')", [p, v, uuid()])],
    ]) { try { outs[label] = (await fn()).outcome; } catch (e) { return `${label}: raw ${e.code} ${e.message}`; } }
    const events = await count("SELECT count(*) n FROM public.trial_balance_upload_lifecycle_events WHERE upload_id=$1", [p]);
    return outs.discard === "forbidden" && outs.cancel === "forbidden" && outs.retire !== "replaced" && events === 0 && ACTIVE_STATES.includes((await row(p)).lifecycle_state)
      ? true : JSON.stringify({ outs, events });
  });
  await check("tbu_log_event writes nothing without a workspace, and writes normally with one", async () => {
    const before = await count("SELECT count(*) n FROM public.trial_balance_upload_lifecycle_events");
    await admin.query("SELECT public.tbu_log_event($1,NULL,NULL,NULL,'a','b','engine',NULL,NULL,'engine',NULL,'applied',NULL,'proof')", [uuid()]);
    const mid = await count("SELECT count(*) n FROM public.trial_balance_upload_lifecycle_events");
    await admin.query("SELECT public.tbu_log_event($1,$2,NULL,NULL,'a','b','engine',NULL,NULL,'engine',NULL,'applied',NULL,'proof')", [uuid(), X]);
    return mid === before && (await count("SELECT count(*) n FROM public.trial_balance_upload_lifecycle_events")) === before + 1;
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
    const collab = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE actor_user_id=$1 AND outcome='applied' AND actor_kind='user'", [U.collab])).rows;
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
