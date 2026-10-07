#!/usr/bin/env node
// Real-PostgreSQL proof of 20261006100000_mapping_and_processing_authority.sql (blueprint Revision 2, stage S1).
//
// Replays every migration BEFORE S1 on an empty PostgreSQL, records legacy state through the PRE-S1 client paths
// (review decisions through the old resolve_account_review_batch, mappings written and forged directly by client roles,
// certified uploads), then:
//   rollback  — S1 applied inside a transaction and rolled back changes nothing;
//   OD2       — the backfill links exactly the mappings whose latest decision approves their complete content;
//   R6        — every client role is refused every direct mapping write (42501); reads follow workspace membership;
//   R6b       — the review RPC refuses cash-flow classes and statement/class mismatches, writing nothing;
//   R6c       — the provenance trigger (all roles, the service role included): same company, same key, approving action,
//               identical seven-field content; an edit without a new decision clears the link;
//   R7        — client roles cannot change any processing field, with or without the lifecycle marker; server
//               processing and the lifecycle RPCs still work; the pre-S1 browser write is refused and changes nothing;
//   R7c       — tbu_request_reprocess: authorization, tenant isolation, every named refusal, replay and conflict, a fault
//               after the invalidation insert leaves nothing, concurrent identical requests, and invalidation honoured by
//               get_authoritative_certification and tbu_derived_active_state until a new certification is recorded.
// Every assertion runs as the real role (SET LOCAL ROLE + simulated JWT claims, the mechanism PostgREST uses).
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> bun scripts/db-proof/mappingProcessingAuthority.mjs
//   (bun: the proof imports the real TypeScript cash-perimeter reader, supabase/functions/_shared/certifiedTbSource.ts)
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY local database) also works.
//
// It reads no Supabase credential and refuses every non-loopback host and the production project reference. It does
// NOT prove stale-worker races (S2/E2).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ATTEMPT_AUTHORITY_MIGRATION, chainBefore } from "./lib/parkedMigrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const S1_FILE = "20261006100000_mapping_and_processing_authority.sql";
const MODE = process.env.DB_PROOF_MODE ?? "embedded";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const CONCURRENCY = 12;

// The REAL MAONO cash-perimeter reader (provenance-aware since S1). TypeScript: run this proof with bun (as CI does).
const { loadCashPerimeter, resolveCashState } = await import(pathToFileURL(path.join(REPO, "supabase/functions/_shared/certifiedTbSource.ts")).href);

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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-s1-proof-"));
  const port = 55000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect();
  await boot.query("CREATE DATABASE s1_proof");
  await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/s1_proof`;
}

async function stopDatabase() {
  try { await pool?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  if (embeddedServer) { try { await embeddedServer.stop(); } catch { /* ignore */ } }
  if (embeddedDir) fs.rmSync(embeddedDir, { recursive: true, force: true });
}

// Up to, not including, S2: this proof simulates the previous engine (see lib/parkedMigrations.mjs, chainBefore).
const migrationFiles = () => chainBefore(fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort(), ATTEMPT_AUTHORITY_MIGRATION);
async function applyMigration(f) {
  let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
  if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  try { await admin.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
}

// Fingerprint of every public object plus the rows S1 touches. Equal before/after == nothing changed.
const FINGERPRINT_SQL = `SELECT md5(string_agg(x, '|' ORDER BY x)) AS fp FROM (
  SELECT 'c:'||table_name||'.'||column_name||':'||data_type||':'||coalesce(column_default,'')||is_nullable AS x FROM information_schema.columns WHERE table_schema='public'
  UNION ALL SELECT 'r:'||c.relname||c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL SELECT 'f:'||p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid))||coalesce(array_to_string(p.proacl, ','),'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
  UNION ALL SELECT 't:'||tgname||':'||tgrelid::regclass::text||':'||tgenabled::text FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'p:'||policyname||':'||tablename||':'||coalesce(qual,'')||':'||coalesce(with_check,'') FROM pg_policies
  UNION ALL SELECT 'k:'||conname||':'||conrelid::regclass::text||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
  UNION ALL SELECT 'g:'||grantee||':'||table_name||':'||privilege_type FROM information_schema.role_table_grants WHERE table_schema='public'
  UNION ALL SELECT 'cg:'||grantee||':'||table_name||'.'||column_name||':'||privilege_type FROM information_schema.column_privileges WHERE table_schema='public' AND table_name IN ('trial_balance_uploads','account_mappings')
  UNION ALL SELECT 'u:'||md5(coalesce((SELECT string_agg(to_jsonb(t)::text, ',' ORDER BY t.id) FROM public.trial_balance_uploads t), ''))
  UNION ALL SELECT 'm:'||md5(coalesce((SELECT string_agg(to_jsonb(m)::text, ',' ORDER BY m.id) FROM public.account_mappings m), ''))
  UNION ALL SELECT 'd:'||md5(coalesce((SELECT string_agg(to_jsonb(d)::text, ',' ORDER BY d.id) FROM public.account_review_decisions d), ''))
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
const upRow = async (id) => (await admin.query("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [id])).rows[0];
const mapRow = async (company, key) => (await admin.query("SELECT * FROM public.account_mappings WHERE company_id IS NOT DISTINCT FROM $1 AND account_key=$2", [company, key])).rows[0];

// The service-role client edge certifiedTbSource uses (from → select → eq), executed as service_role on real PostgreSQL;
// errors are returned like PostgREST's, never thrown.
const serviceTbClient = {
  rpc: async () => ({ data: null, error: { message: "not used" } }),
  from: (table) => ({
    select: (cols) => ({
      eq: async (col, val) => {
        if (!/^[a-z_]+$/.test(table) || !/^[a-z_, ]+$/.test(cols) || !/^[a-z_]+$/.test(col)) throw new Error("bad identifier");
        try { return { data: await q(SERVICE, `SELECT ${cols} FROM public.${table} WHERE ${col} = $1`, [val]), error: null }; }
        catch (e) { return { data: null, error: { message: e.message } }; }
      },
    }),
  }),
};
// S1 contract, checked independently in JS for EVERY linked row: same company, same key, approving action, identical
// seven-field content. Returns the offending rows.
async function linkedRowsViolatingContract() {
  const rows = (await admin.query(`SELECT m.*, d.company_id d_company, d.review_account_key d_key, d.decision_action d_action, d.new_value d_new
    FROM public.account_mappings m LEFT JOIN public.account_review_decisions d ON d.id = m.review_decision_id WHERE m.review_decision_id IS NOT NULL`)).rows;
  const F = ["statement", "classification", "line_item", "normal_balance", "is_cash_account", "is_retained_earnings", "is_payroll_account"];
  return rows.filter((r) => {
    const content = r.d_new?.mapping ?? null;
    return r.d_company !== r.company_id || r.d_key !== (r.account_code ?? r.normalized_account_name)
      || !["USER_ACCEPTED_SUGGESTION", "USER_MANUAL_CLASSIFICATION"].includes(r.d_action) || content === null
      || F.some((f) => (content[f] ?? null) !== (r[f] ?? null));
  }).map((r) => r.account_key);
}

const U = { ownerA: uuid(), preparerA: uuid(), viewerA: uuid(), outsider: uuid(), ownerB: uuid(), lapsed: uuid(), solo: uuid() };
const ownerMemberOf = {};

async function seedUpload(company, uploader, { period = 2026, status = "processing", filePath = null } = {}) {
  const r = await admin.query(
    `INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, user_id)
     VALUES ($1, $2, 100, $3, $4, $5, $6) RETURNING id`,
    [`tb-${uuid().slice(0, 6)}.csv`, filePath ?? `${uploader}/${uuid()}.csv`, status, company, period, uploader]);
  return r.rows[0].id;
}
async function setHash(upload, hash) {
  await q(SERVICE, "UPDATE public.trial_balance_uploads SET source_file_hash=$2 WHERE id=$1", [upload, hash]);
}
// As process-trial-balance does: the service role records the observed source hash and the outcome, then certifies.
async function certify(company, upload, period, { blocking = false, review = false, hash = "h" } = {}) {
  const cur = await upRow(upload);
  if (cur.source_file_hash === null) await setHash(upload, hash);
  await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='valid', is_valid=true, processed_at=now(), processing_result='{\"r\":1}'::jsonb, validation_report='{\"v\":1}'::jsonb WHERE id=$1", [upload]);
  const run = (await admin.query(
    "INSERT INTO public.engine_runs (company_id, actor_type, firm_member_id, function_name, engine_version, status, period_year) VALUES ($1,'user',$2,'process-trial-balance','proof','running',$3) RETURNING id",
    [company, ownerMemberOf[company], period])).rows[0].id;
  const r = await admin.query("SELECT public.commit_tb_certification($1,'process-trial-balance',$2,$3,$4,$5,'n','o',$6,$7,'[]'::jsonb,'[]'::jsonb) r",
    [run, upload, company, period, (await upRow(upload)).source_file_hash, blocking, review]);
  return r.rows[0].r.certification_id;
}
const reprocess = (uid, upload, op, hash) =>
  one(user(uid), "SELECT public.tbu_request_reprocess($1,$2,$3) r", [upload, op, hash]).then((x) => x.r);
const authoritative = async (company, period) => (await admin.query("SELECT id FROM public.get_authoritative_certification($1,$2)", [company, period])).rows[0]?.id ?? null;
const reviewBatch = (uid, company, upload, requestId, decisions) =>
  one(user(uid), "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb) r", [company, upload, requestId, JSON.stringify(decisions)]).then((x) => x.r);
const decision = (code, name, cls, statement, normal, extra = {}) =>
  ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement, classification: cls, normal_balance: normal, ...extra });

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: CONCURRENCY + 6 });

  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  // The hosted project installs pgcrypto in schema "extensions" (20261003100000). This disposable database has it in
  // public; extensions.digest is the same function, so the review RPC and tbu_request_reprocess run as they do hosted.
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);

  const files = migrationFiles();
  const cut = files.indexOf(S1_FILE);
  group("Setup — every migration before S1, then legacy state through the pre-S1 client paths");
  await check(`${S1_FILE} is in the chain and every earlier migration applies on an empty PostgreSQL`, async () => {
    if (cut < 0) return `${S1_FILE} missing`;
    for (const f of files.slice(0, cut)) await applyMigration(f);
    return true;
  });

  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const lic = {};
  for (const [uid, plan] of [[U.ownerA, "PRACTICE"], [U.ownerB, "SOLO"], [U.lapsed, "SOLO"], [U.solo, "SOLO"]]) {
    const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).rows[0].id;
    lic[uid] = (await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4 RETURNING id", [bc, prod, plan === "PRACTICE" ? 4 : 0, plan])).rows[0].id;
  }
  const A = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic A') RETURNING id", [U.ownerA])).rows[0].id;
  const B = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic B') RETURNING id", [U.ownerB])).rows[0].id;
  const C = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Lapsed') RETURNING id", [U.lapsed])).rows[0].id;
  for (const co of [A, B, C]) ownerMemberOf[co] = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND role='owner'", [co])).rows[0].id;
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now()), ($1,$3,'viewer',now())", [A, U.preparerA, U.viewerA]);

  // Legacy (pre-S1) review decisions, through the old RPC.
  const reviewUpload = await seedUpload(A, U.ownerA, { period: 2024 });
  const legacyReq = uuid();
  const legacyDecisions = [
    decision("1000", "Cash at bank", "current_assets", "balance_sheet", "debit", { line_item: "Cash", is_cash_account: true, is_retained_earnings: false, is_payroll_account: false }),
    decision("2000", "Trade payables", "current_liabilities", "balance_sheet", "credit"),
    decision("3000", "Sales", "revenue", "income_statement", "credit"),
    decision("4000", "Rent", "operating_expenses", "income_statement", "debit", { line_item: "Rent X" }),
  ];
  const legacyResult = await reviewBatch(U.ownerA, A, reviewUpload, legacyReq, legacyDecisions);
  await reviewBatch(U.ownerA, A, reviewUpload, uuid(), [decision("4000", "Rent", "operating_expenses", "income_statement", "debit", { line_item: "Rent Y" })]);
  // Direct client writes the pre-S1 policies allowed: an edit after review, a revert to an older reviewed content,
  // a global (company_id NULL) row and a row forged into another tenant's workspace by a non-member.
  await q(user(U.ownerA), "UPDATE public.account_mappings SET line_item='Edited after review' WHERE company_id=$1 AND account_code='3000'", [A]);
  await q(user(U.ownerA), "UPDATE public.account_mappings SET line_item='Rent X' WHERE company_id=$1 AND account_code='4000'", [A]);
  await q(user(U.outsider), "INSERT INTO public.account_mappings (user_id, account_code, account_name, statement, classification, line_item, normal_balance) VALUES ($1,'9000','Global forged','balance_sheet','equity','Forged','credit')", [U.outsider]);
  await q(user(U.outsider), "INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, statement, classification, line_item, normal_balance) VALUES ($1,$2,'9100','Cross-tenant forged','income_statement','revenue','Forged','credit')", [U.outsider, A]);
  await check("legacy state recorded (5 decisions, 6 mappings including 2 forged)", async () =>
    (await count("SELECT count(*) n FROM public.account_review_decisions")) === 5 && (await count("SELECT count(*) n FROM public.account_mappings")) === 6);

  // Uploads for the processing proofs.
  const uCert = await seedUpload(A, U.ownerA, { period: 2026 });
  const certA = await certify(A, uCert, 2026);

  await check("compatibility: the provenance-aware cash-perimeter reader fails CLOSED on the pre-S1 schema (CANNOT_ASSESS)", async () => {
    const r = await loadCashPerimeter(serviceTbClient, A);
    return r.state === "CANNOT_ASSESS" ? true : r;
  });
  const before1000 = await mapRow(A, "1000");

  group("Rollback — S1 inside a transaction, rolled back, changes nothing");
  await check("fingerprint (schema, grants, policies, triggers, uploads, mappings, decisions) is unchanged", async () => {
    const before = await fingerprint();
    await admin.query("BEGIN");
    try { await applyMigration(S1_FILE); } finally { await admin.query("ROLLBACK"); }
    return before === (await fingerprint());
  });
  await check(`${S1_FILE} applies`, async () => { await applyMigration(S1_FILE); return true; });

  group("OD2 — backfill links only exact matches with the latest decision");
  await check("1000 (complete content incl. flags) is linked to its decision", async () => {
    const m = await mapRow(A, "1000");
    const d = (await admin.query("SELECT id FROM public.account_review_decisions WHERE company_id=$1 AND review_account_key='1000'", [A])).rows[0].id;
    return m.review_decision_id === d;
  });
  await check("2000 (flags never reviewed: NULL on both sides) is linked", async () => (await mapRow(A, "2000")).review_decision_id !== null);
  await check("3000 (edited directly after review) stays unlinked", async () => (await mapRow(A, "3000")).review_decision_id === null);
  await check("4000 (reverted to an OLDER reviewed content; latest decision differs) stays unlinked", async () => (await mapRow(A, "4000")).review_decision_id === null);
  await check("forged global and cross-tenant rows stay unlinked", async () =>
    (await mapRow(null, "9000")).review_decision_id === null && (await mapRow(A, "9100")).review_decision_id === null);
  await check("the backfill left updated_at and every content field unchanged, and re-enabled the updated_at trigger", async () => {
    const m = await mapRow(A, "1000");
    const enabled = (await admin.query("SELECT tgenabled FROM pg_trigger WHERE tgname='update_account_mappings_updated_at'")).rows[0].tgenabled;
    return m.updated_at.getTime() === before1000.updated_at.getTime() && m.line_item === before1000.line_item && enabled === "O";
  });

  // Every later migration (H1 onward) is applied before the behaviour groups, so S1's properties are proven on the whole
  // current chain, not only on S1 alone.
  await check("every migration after S1 applies on top (S1's properties below hold on the full current chain)", async () => {
    for (const f of files.slice(cut + 1)) await applyMigration(f);
    return true;
  });

  group("R6 — direct client mapping writes are refused for every role");
  const roles = [["workspace owner", U.ownerA], ["preparer", U.preparerA], ["viewer", U.viewerA], ["non-member", U.outsider], ["other-tenant owner", U.ownerB]];
  for (const [label, uid] of roles) {
    await refused(`${label}: INSERT into account_mappings (own workspace or another)`, "42501", () =>
      q(user(uid), "INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, statement, classification, line_item, normal_balance) VALUES ($1,$2,'5000','X','balance_sheet','equity','X','credit')", [uid, A]));
    await refused(`${label}: UPDATE account_mappings`, "42501", () => q(user(uid), "UPDATE public.account_mappings SET line_item='x' WHERE account_code='1000'"));
    await refused(`${label}: DELETE account_mappings`, "42501", () => q(user(uid), "DELETE FROM public.account_mappings WHERE account_code='1000'"));
    await refused(`${label}: set a forged review_decision_id`, "42501", () => q(user(uid), "UPDATE public.account_mappings SET review_decision_id=(SELECT id FROM public.account_review_decisions LIMIT 1)"));
  }
  await refused("anon: INSERT into account_mappings", "42501", () =>
    q(ANON, "INSERT INTO public.account_mappings (user_id, account_code, account_name, statement, classification, line_item, normal_balance) VALUES ($1,'5000','X','balance_sheet','equity','X','credit')", [U.outsider]));
  await check("no client role holds INSERT/UPDATE/DELETE/TRUNCATE on account_mappings, table or column level", async () =>
    (await count("SELECT count(*) n FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='account_mappings' AND grantee IN ('anon','authenticated','PUBLIC') AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')")) === 0
    && (await count("SELECT count(*) n FROM information_schema.column_privileges WHERE table_schema='public' AND table_name='account_mappings' AND grantee IN ('anon','authenticated','PUBLIC') AND privilege_type IN ('INSERT','UPDATE')")) === 0);
  await check("reads follow membership: members of A see A's rows; the other tenant sees none of them", async () => {
    const seen = async (uid) => Number((await one(user(uid), "SELECT count(*) n FROM public.account_mappings WHERE company_id=$1", [A])).n);
    const total = await count("SELECT count(*) n FROM public.account_mappings WHERE company_id=$1", [A]);
    return (await seen(U.ownerA)) === total && (await seen(U.viewerA)) === total && (await seen(U.ownerB)) === 0 && (await seen(U.outsider)) === 0 && total === 5 ? true : { total };
  });
  await check("a personal (company_id NULL) row is visible only to the user who wrote it", async () =>
    Number((await one(user(U.outsider), "SELECT count(*) n FROM public.account_mappings WHERE company_id IS NULL")).n) === 1
    && Number((await one(user(U.ownerA), "SELECT count(*) n FROM public.account_mappings WHERE company_id IS NULL")).n) === 0);

  group("R6b — the review RPC refuses unsupported combinations and writes nothing");
  const counts = async () => [await count("SELECT count(*) n FROM public.account_review_decisions"), await count("SELECT count(*) n FROM public.account_review_batches"), await count("SELECT count(*) n FROM public.account_mappings")].join("/");
  for (const [label, d, code] of [
    ["cash_flow statement", decision("6000", "Op", "operating_activities", "cash_flow", "debit"), "UNSUPPORTED_CASH_FLOW_CLASSIFICATION"],
    ["cash-flow class on the balance sheet", decision("6000", "Op", "financing_activities", "balance_sheet", "debit"), "UNSUPPORTED_CASH_FLOW_CLASSIFICATION"],
    ["balance_sheet / revenue", decision("6000", "Op", "revenue", "balance_sheet", "credit"), "STATEMENT_CLASSIFICATION_MISMATCH"],
    ["income_statement / equity", decision("6000", "Op", "equity", "income_statement", "credit"), "STATEMENT_CLASSIFICATION_MISMATCH"],
    ["missing statement", decision("6000", "Op", "equity", null, "credit"), "STATEMENT_CLASSIFICATION_MISMATCH"],
  ]) {
    const before = await counts();
    try {
      await reviewBatch(U.ownerA, A, reviewUpload, uuid(), [decision("6100", "Fine", "equity", "balance_sheet", "credit"), d]);
      record(`${label}: refused`, false, "accepted");
    } catch (e) {
      record(`${label}: refused 22023 ${code}, nothing written`, e.code === "22023" && String(e.message).startsWith(code) && before === (await counts()), `${e.code} ${e.message} ${before} ${await counts()}`);
    }
  }
  await refused("viewer (no prepare_close) is refused by the review RPC", "42501", () => reviewBatch(U.viewerA, A, reviewUpload, uuid(), [decision("6100", "Fine", "equity", "balance_sheet", "credit")]));
  await refused("other-tenant owner is refused by the review RPC", "42501", () => reviewBatch(U.ownerB, A, reviewUpload, uuid(), [decision("6100", "Fine", "equity", "balance_sheet", "credit")]));
  await check("a pre-S1 request replays byte-identically (same summary, nothing written)", async () => {
    const before = await counts();
    const r = await reviewBatch(U.ownerA, A, reviewUpload, legacyReq, legacyDecisions);
    return JSON.stringify(r) === JSON.stringify(legacyResult) && before === (await counts());
  });
  await check("an accepted decision is recorded first with its complete content and the mapping is linked to it", async () => {
    await reviewBatch(U.preparerA, A, reviewUpload, uuid(), [decision("3000", "Sales", "revenue", "income_statement", "credit", { line_item: "Sales revenue" })]);
    const m = await mapRow(A, "3000");
    const d = (await admin.query("SELECT * FROM public.account_review_decisions WHERE id=$1", [m.review_decision_id])).rows[0];
    const c = d.new_value.mapping;
    return c.line_item === "Sales revenue" && c.statement === "income_statement" && c.is_cash_account === null && d.company_id === A && d.review_account_key === "3000" ? true : { c, d: d.review_account_key };
  });
  await check("a flag the decision does not carry keeps the mapping's value (recorded in the decision's content)", async () => {
    await reviewBatch(U.ownerA, A, reviewUpload, uuid(), [decision("1000", "Cash at bank", "current_assets", "balance_sheet", "debit", { line_item: "Cash and bank" })]);
    const m = await mapRow(A, "1000");
    const d = (await admin.query("SELECT new_value FROM public.account_review_decisions WHERE id=$1", [m.review_decision_id])).rows[0].new_value;
    return m.is_cash_account === true && d.mapping.is_cash_account === true && m.line_item === "Cash and bank";
  });
  await check("MARK_NON_REPORTING_ACCOUNT still removes the mapping and records the decision", async () => {
    await reviewBatch(U.ownerA, A, reviewUpload, uuid(), [{ account_code: "2000", account_name: "Trade payables", decision_action: "MARK_NON_REPORTING_ACCOUNT" }]);
    return (await mapRow(A, "2000")) === undefined;
  });

  group("R6c — provenance: same company, same key, approving action, identical complete content");
  const decOf = async (company, key) => (await admin.query("SELECT id FROM public.account_review_decisions WHERE company_id=$1 AND review_account_key=$2 AND decision_action<>'MARK_NON_REPORTING_ACCOUNT' ORDER BY sequence_no DESC LIMIT 1", [company, key])).rows[0].id;
  const uB = await seedUpload(B, U.ownerB, { period: 2024 });
  await reviewBatch(U.ownerB, B, uB, uuid(), [decision("1000", "Cash at bank", "current_assets", "balance_sheet", "debit", { line_item: "Cash and bank", is_cash_account: true, is_retained_earnings: false, is_payroll_account: false })]);
  const dA1000 = await decOf(A, "1000");
  const dB1000 = await decOf(B, "1000");
  const dA3000 = await decOf(A, "3000");
  await refused("service role: a decision from ANOTHER company (identical content) is refused", "42501", () =>
    q(SERVICE, "UPDATE public.account_mappings SET review_decision_id=$2 WHERE company_id=$1 AND account_code='1000'", [A, dB1000]));
  await refused("service role: a decision for a DIFFERENT account key is refused", "42501", () =>
    q(SERVICE, "UPDATE public.account_mappings SET review_decision_id=$2 WHERE company_id=$1 AND account_code='1000'", [A, dA3000]));
  const nonRep = (await admin.query("SELECT id FROM public.account_review_decisions WHERE decision_action='MARK_NON_REPORTING_ACCOUNT' LIMIT 1")).rows[0].id;
  await refused("service role: a non-approving decision is refused", "42501", () =>
    q(SERVICE, "INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, statement, classification, line_item, normal_balance, review_decision_id) VALUES ($1,$2,'2000','Trade payables','balance_sheet','current_liabilities','Trade payables','credit',$3)", [U.ownerA, A, nonRep]));
  for (const [field, value] of [["statement", "'income_statement'"], ["classification", "'non_current_assets'"], ["line_item", "'Other'"], ["normal_balance", "'credit'"], ["is_cash_account", "false"], ["is_retained_earnings", "true"], ["is_payroll_account", "NULL"]]) {
    await refused(`service role: content differing only in ${field} cannot carry the decision`, "42501", () =>
      asCaller(SERVICE, async (c) => {
        await c.query("UPDATE public.account_mappings SET review_decision_id=NULL WHERE company_id=$1 AND account_code='1000'", [A]);
        await c.query(`UPDATE public.account_mappings SET ${field}=${value}, review_decision_id=$2 WHERE company_id=$1 AND account_code='1000'`, [A, dA1000]);
      }));
  }
  await check("service role: an edit WITHOUT a new decision clears the link", async () => {
    await q(SERVICE, "UPDATE public.account_mappings SET line_item='Cash (edited)' WHERE company_id=$1 AND account_code='1000'", [A]);
    return (await mapRow(A, "1000")).review_decision_id === null;
  });
  await check("service role: a re-key (account code change) without a new decision clears the link", async () => {
    await reviewBatch(U.ownerA, A, reviewUpload, uuid(), [decision("7000", "Loan", "non_current_liabilities", "balance_sheet", "credit")]);
    await q(SERVICE, "UPDATE public.account_mappings SET account_code='7001' WHERE company_id=$1 AND account_code='7000'", [A]);
    return (await mapRow(A, "7001")).review_decision_id === null;
  });
  await check("service role: the same company, key and identical complete content is accepted", async () => {
    await q(SERVICE, "UPDATE public.account_mappings SET line_item='Cash and bank', review_decision_id=$2 WHERE company_id=$1 AND account_code='1000'", [A, dA1000]);
    return (await mapRow(A, "1000")).review_decision_id === dA1000;
  });
  await check("an unchanged-content update (e.g. approved_at) keeps the link", async () => {
    await q(SERVICE, "UPDATE public.account_mappings SET approved_at=now() WHERE company_id=$1 AND account_code='1000'", [A]);
    return (await mapRow(A, "1000")).review_decision_id === dA1000;
  });

  await check("sufficiency: after every R6c manipulation, EVERY linked row satisfies the full contract (checked independently)", async () => {
    const bad = await linkedRowsViolatingContract();
    return bad.length === 0 && (await count("SELECT count(*) n FROM public.account_mappings WHERE review_decision_id IS NOT NULL")) > 0 ? true : bad;
  });
  await check("cash perimeter on real PostgreSQL: a reviewed flag is known; the same flag on an unproven row is UNKNOWN", async () => {
    // 1000: linked and reviewed as cash. 9100: the forged pre-S1 row, made cash by the service role (no decision → no link).
    await q(SERVICE, "UPDATE public.account_mappings SET is_cash_account=true WHERE company_id=$1 AND account_code='9100'", [A]);
    const r = await loadCashPerimeter(serviceTbClient, A);
    if (r.state !== "KNOWN") return r;
    return resolveCashState(r.value, "1000") === "CASH" && resolveCashState(r.value, "9100") === "UNKNOWN"
      && (await mapRow(A, "9100")).review_decision_id === null ? true : [...r.value.decided.entries()];
  });
  await check("cash perimeter: another company's reviewed rows never enter this company's perimeter", async () => {
    const r = await loadCashPerimeter(serviceTbClient, A);
    const rB = await loadCashPerimeter(serviceTbClient, B);
    return r.state === "KNOWN" && rB.state === "KNOWN" && resolveCashState(rB.value, "1000") === "CASH" && [...rB.value.decided.keys()].join() === "1000" ? true : { a: [...r.value.decided.entries()], b: [...rB.value.decided.entries()] };
  });

  group("R7 — processing fields are server-owned");
  const uField = await seedUpload(A, U.ownerA, { period: 2025 });
  await setHash(uField, "hf");
  const FIELDS = [["status", "'valid'"], ["is_valid", "true"], ["processing_result", "'{}'::jsonb"], ["validation_report", "'{}'::jsonb"], ["accounting_errors", "NULL"], ["processed_at", "now()"], ["source_file_hash", "'forged'"]];
  for (const [label, uid] of [["workspace owner", U.ownerA], ["viewer", U.viewerA], ["non-member", U.outsider], ["other-tenant owner", U.ownerB]]) {
    for (const marker of [false, true]) {
      for (const [field, value] of FIELDS) {
        await refused(`${label}${marker ? " (with the lifecycle marker)" : ""}: UPDATE ${field}`, "42501", () => asCaller(user(uid), async (c) => {
          if (marker) await c.query("SELECT set_config('axiom.tbu_lifecycle_op','reprocess_request',true)");
          await c.query(`UPDATE public.trial_balance_uploads SET ${field}=${value} WHERE id=$1`, [uField]);
        }));
      }
    }
  }
  await refused("anon: UPDATE status", "42501", () => q(ANON, "UPDATE public.trial_balance_uploads SET status='valid' WHERE id=$1", [uField]));
  await check("the guard itself refuses a client change even where a column privilege exists (defence in depth)", async () => {
    // Re-grant the column for this check only, inside a transaction that is rolled back.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("GRANT UPDATE (status) ON public.trial_balance_uploads TO authenticated");
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [U.ownerA]);
      try { await c.query("UPDATE public.trial_balance_uploads SET status='valid' WHERE id=$1", [uField]); return "accepted"; }
      catch (e) { return e.code === "42501" && /server-owned/.test(e.message) ? true : `${e.code} ${e.message}`; }
    } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
  });
  await check("the pre-S1 browser write (status + processing_result) is refused and the row is unchanged", async () => {
    const before = JSON.stringify(await upRow(uField));
    try { await q(user(U.ownerA), "UPDATE public.trial_balance_uploads SET status='processing', processing_result=NULL WHERE id=$1", [uField]); return "accepted"; }
    catch (e) { return e.code === "42501" && before === JSON.stringify(await upRow(uField)) ? true : e.code; }
  });
  await refused("a client INSERT naming a processed result is refused", "42501", () =>
    q(user(U.solo), "INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, user_id, is_valid) VALUES ('x.csv',$1,1,'valid',$2,true)", [`${U.solo}/x.csv`, U.solo]));
  await check("other upload columns keep their access (owner renames company_name)", async () => {
    await q(user(U.ownerA), "UPDATE public.trial_balance_uploads SET company_name='Renamed' WHERE id=$1", [uField]);
    return (await upRow(uField)).company_name === "Renamed";
  });
  await check("server processing still works: the service role claims, records and finalizes", async () => {
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [uField]);
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='valid', is_valid=true, processed_at=now(), processing_result='{}'::jsonb, accounting_errors='[]'::jsonb WHERE id=$1", [uField]);
    return (await upRow(uField)).status === "valid";
  });
  await check("lifecycle RPCs still work: the owner discards an unprocessed upload (pending → completed)", async () => {
    const u = await seedUpload(A, U.ownerA, { period: 2019 });
    const d = await one(user(U.ownerA), "SELECT * FROM public.discard_trial_balance_upload($1,$2)", [u, (await upRow(u)).version]);
    const done = await one(user(U.ownerA), "SELECT * FROM public.complete_trial_balance_discard($1)", [d.operation_id]);
    return (await upRow(u)) === undefined ? true : { d: d.outcome, done };
  });
  await check("lifecycle RPCs still work: the owner removes a certified upload from active use", async () => {
    const u = await seedUpload(A, U.ownerA, { period: 2018 });
    await certify(A, u, 2018);
    const r = await one(user(U.ownerA), "SELECT * FROM public.remove_trial_balance_upload($1,$2,'proof')", [u, (await upRow(u)).version]);
    return (await upRow(u)).lifecycle_state === "retired" ? true : r;
  });

  group("R7c — tbu_request_reprocess");
  const reqCount = () => count("SELECT count(*) n FROM public.tb_reprocess_requests");
  const invCount = () => count("SELECT count(*) n FROM public.tb_certification_invalidations");
  const evCount = () => count("SELECT count(*) n FROM public.trial_balance_upload_lifecycle_events");
  const certSnapshot = async (id) => JSON.stringify((await admin.query("SELECT * FROM public.tb_certifications WHERE id=$1", [id])).rows[0]);

  await check("before: the certified upload is authoritative and active_processed", async () =>
    (await authoritative(A, 2026)) === certA && (await upRow(uCert)).lifecycle_state === "active_processed");
  const certBefore = await certSnapshot(certA);
  const rowBefore = await upRow(uCert);
  const op1 = uuid();
  let r1;
  await check("preparer (prepare_close) → accepted, naming the invalidated certification", async () => {
    r1 = await reprocess(U.preparerA, uCert, op1, "h");
    return r1.outcome === "accepted" && r1.code === "ACCEPTED" && r1.invalidated_certification_id === certA ? true : r1;
  });
  await check("the invalidation is recorded with the operation id and actor; the certification row is unchanged", async () => {
    const i = (await admin.query("SELECT * FROM public.tb_certification_invalidations WHERE certification_id=$1", [certA])).rows[0];
    return i?.operation_id === op1 && i.actor_user_id === U.preparerA && i.reason === "reprocess_requested" && (await certSnapshot(certA)) === certBefore;
  });
  await check("the upload: status processing, is_valid false, processing_result / validation_report kept as history, active_processing, version+1", async () => {
    const r = await upRow(uCert);
    return r.status === "processing" && r.is_valid === false && JSON.stringify(r.processing_result) === JSON.stringify(rowBefore.processing_result)
      && JSON.stringify(r.validation_report) === JSON.stringify(rowBefore.validation_report) && r.lifecycle_state === "active_processing"
      && Number(r.version) === Number(rowBefore.version) + 1 ? true : { s: r.status, l: r.lifecycle_state, v: r.version };
  });
  await check("a lifecycle event carries the operation id, the actor and prepare_close", async () => {
    const e = (await admin.query("SELECT * FROM public.trial_balance_upload_lifecycle_events WHERE operation_id=$1", [op1])).rows;
    return e.length === 1 && e[0].actor_user_id === U.preparerA && e[0].authority_capability === "prepare_close" && e[0].from_state === "active_processed" && e[0].to_state === "active_processing";
  });
  await check("authoritative readers respect it: get_authoritative_certification returns nothing (no older result resurrected)", async () =>
    (await authoritative(A, 2026)) === null
    && Number((await one(user(U.ownerA), "SELECT count(*) n FROM public.get_authoritative_certification($1,2026)", [A])).n) === 0);
  await check("tbu_derived_active_state ignores the invalidated certification (active_processing)", async () =>
    (await admin.query("SELECT public.tbu_derived_active_state(t) s FROM public.trial_balance_uploads t WHERE id=$1", [uCert])).rows[0].s === "active_processing");
  await check("members can read the invalidation; the other tenant cannot", async () =>
    Number((await one(user(U.viewerA), "SELECT count(*) n FROM public.tb_certification_invalidations")).n) === 1
    && Number((await one(user(U.ownerB), "SELECT count(*) n FROM public.tb_certification_invalidations")).n) === 0);

  const snap = async () => [await reqCount(), await invCount(), await evCount(), JSON.stringify(await upRow(uCert))].join("|");
  let s0 = await snap();
  await check("same operation id, same request → replayed, recorded outcome, no new effect", async () => {
    const r = await reprocess(U.preparerA, uCert, op1, "h");
    return r.outcome === "replayed" && r.invalidated_certification_id === certA && s0 === (await snap()) ? true : r;
  });
  await check("same operation id, different expected hash → conflict IDEMPOTENCY_KEY_REUSED, nothing changed", async () => {
    const r = await reprocess(U.preparerA, uCert, op1, "different");
    return r.outcome === "conflict" && r.code === "IDEMPOTENCY_KEY_REUSED" && s0 === (await snap()) ? true : r;
  });
  await check("same operation id from another actor → conflict, nothing changed", async () => {
    const r = await reprocess(U.ownerA, uCert, op1, "h");
    return r.outcome === "conflict" && s0 === (await snap()) ? true : r;
  });

  // Refusals: each carries its code, is recorded, and replays as the same refusal.
  const uFresh = await seedUpload(A, U.ownerA, { period: 2023 });
  const uUnbound = await seedUpload(A, U.ownerA, { period: 2022, filePath: "elsewhere/x.csv" });
  const uValidating = await seedUpload(A, U.ownerA, { period: 2021 });
  await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [uValidating]);
  const uDiscarding = await seedUpload(A, U.ownerA, { period: 2020 });
  await one(user(U.ownerA), "SELECT * FROM public.discard_trial_balance_upload($1,$2)", [uDiscarding, (await upRow(uDiscarding)).version]);
  const uRetired = await seedUpload(A, U.ownerA, { period: 2017 });
  await certify(A, uRetired, 2017);
  await one(user(U.ownerA), "SELECT * FROM public.remove_trial_balance_upload($1,$2,'proof')", [uRetired, (await upRow(uRetired)).version]);
  const uChanged = await seedUpload(A, U.ownerA, { period: 2016 });
  await setHash(uChanged, "stored-hash");
  const uC = await seedUpload(C, U.lapsed, { period: 2026 });
  await admin.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end = now() - interval '1 hour' WHERE id=$1", [lic[U.lapsed]]);
  const uPersonal = await seedUpload(null, U.solo, { period: 2026 });

  for (const [label, uid, upload, hash, code] of [
    ["viewer (no prepare_close)", U.viewerA, uFresh, null, "CAPABILITY_REQUIRED"],
    ["non-member", U.outsider, uFresh, null, "NOT_A_MEMBER_OF_COMPANY"],
    ["other-tenant owner", U.ownerB, uFresh, null, "NOT_A_MEMBER_OF_COMPANY"],
    ["an upload that does not exist", U.ownerA, uuid(), null, "NOT_A_MEMBER_OF_COMPANY"],
    ["workspace without a current plan", U.lapsed, uC, null, "ENTITLEMENT_REQUIRED"],
    ["a removed (retired) upload", U.ownerA, uRetired, "h", "UPLOAD_NOT_ACTIVE"],
    ["a source not bound to the upload", U.ownerA, uUnbound, null, "SOURCE_NOT_BOUND"],
    ["a changed source hash", U.ownerA, uChanged, "what-the-browser-saw", "SOURCE_CHANGED"],
    ["an upload a worker has claimed (validating)", U.ownerA, uValidating, null, "IN_PROGRESS"],
    // A begun discard has already taken the upload out of active use; the claim check behind it is a second guard.
    ["an upload with a pending discard (already out of active use)", U.ownerA, uDiscarding, null, "UPLOAD_NOT_ACTIVE"],
    ["another user's personal upload", U.outsider, uPersonal, null, "NOT_A_MEMBER_OF_COMPANY"],
  ]) {
    const before = [await invCount(), await evCount(), upload === uuid() ? "" : JSON.stringify(await upRow(upload))].join("|");
    const op = uuid();
    await check(`${label} → refused ${code}, recorded, nothing else changed; a retry replays the refusal`, async () => {
      const r = await reprocess(uid, upload, op, hash);
      const rec = (await admin.query("SELECT * FROM public.tb_reprocess_requests WHERE operation_id=$1", [op])).rows[0];
      const after = [await invCount(), await evCount(), upload === uuid() ? "" : JSON.stringify(await upRow(upload))].join("|");
      const again = await reprocess(uid, upload, op, hash);
      return r.outcome === "refused" && r.code === code && rec?.outcome === "refused" && rec.code === code && before === after
        && again.outcome === "refused" && again.code === code && again.replayed === true ? true : { r, again, rec: rec?.code };
    });
  }
  await check("the personal upload's own uploader (with a plan) → accepted", async () => (await reprocess(U.solo, uPersonal, uuid(), null)).outcome === "accepted");
  await check("an upload left at 'processing' with no worker claim (a failed first start) can be re-requested → accepted", async () => {
    const r = await reprocess(U.ownerA, uFresh, uuid(), null);
    return r.outcome === "accepted" && r.invalidated_certification_id === null ? true : r;
  });
  await refused("anon cannot execute tbu_request_reprocess", "42501", () => q(ANON, "SELECT public.tbu_request_reprocess($1,$2,NULL)", [uFresh, uuid()]));
  await refused("the service role cannot execute tbu_request_reprocess", "42501", () => q(SERVICE, "SELECT public.tbu_request_reprocess($1,$2,NULL)", [uFresh, uuid()]));
  await refused("clients cannot read or write the request ledger", "42501", () => q(user(U.ownerA), "SELECT * FROM public.tb_reprocess_requests"));
  await refused("clients cannot insert an invalidation", "42501", () =>
    q(user(U.ownerA), "INSERT INTO public.tb_certification_invalidations (certification_id, company_id, upload_id, reason, operation_id, actor_user_id) VALUES ($1,$2,$3,'reprocess_requested',$4,$5)", [certA, A, uCert, uuid(), U.ownerA]));
  await refused("an invalidation cannot be deleted (even by the service role)", "42501", () => q(SERVICE, "DELETE FROM public.tb_certification_invalidations"));
  await refused("an invalidation cannot be edited (even by the service role)", "42501", () => q(SERVICE, "UPDATE public.tb_certification_invalidations SET reason='reprocess_requested'"));

  // Fault after the invalidation insert: the request-ledger insert is the transaction's last write.
  const uFault = await seedUpload(A, U.ownerA, { period: 2015 });
  const certFault = await certify(A, uFault, 2015);
  await check("a fault after the invalidation insert leaves nothing (no invalidation, no upload change, no event, no request)", async () => {
    await admin.query(`CREATE OR REPLACE FUNCTION public._proof_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome = 'accepted' THEN RAISE EXCEPTION 'injected fault' USING ERRCODE = 'XX000'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER trg_proof_fault BEFORE INSERT ON public.tb_reprocess_requests FOR EACH ROW EXECUTE FUNCTION public._proof_fault();`);
    const before = [await reqCount(), await invCount(), await evCount(), JSON.stringify(await upRow(uFault))].join("|");
    let code = null;
    try { await reprocess(U.ownerA, uFault, uuid(), "h"); } catch (e) { code = e.code; }
    await admin.query("DROP TRIGGER trg_proof_fault ON public.tb_reprocess_requests; DROP FUNCTION public._proof_fault();");
    const after = [await reqCount(), await invCount(), await evCount(), JSON.stringify(await upRow(uFault))].join("|");
    return code === "XX000" && before === after && (await authoritative(A, 2015)) === certFault ? true : { code, same: before === after };
  });

  await check(`${CONCURRENCY} concurrent requests with ONE operation id (2+ sessions) → exactly one accepted, the rest replayed, one invalidation`, async () => {
    const op = uuid();
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => reprocess(U.ownerA, uFault, op, "h")));
    const accepted = out.filter((r) => r.outcome === "accepted").length;
    const replayed = out.filter((r) => r.outcome === "replayed").length;
    const inv = await count("SELECT count(*) n FROM public.tb_certification_invalidations WHERE certification_id=$1", [certFault]);
    return accepted === 1 && replayed === CONCURRENCY - 1 && inv === 1 ? true : { accepted, replayed, inv };
  });

  await check("processing after an accepted request records a new certification that becomes authoritative (active_processed)", async () => {
    await q(SERVICE, "UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [uCert]);
    const fresh = await certify(A, uCert, 2026);
    return (await authoritative(A, 2026)) === fresh && fresh !== certA && (await upRow(uCert)).lifecycle_state === "active_processed";
  });
  await check("a second request invalidates the NEW certification only (the old one stays invalidated, never edited)", async () => {
    const latest = await authoritative(A, 2026);
    const r = await reprocess(U.preparerA, uCert, uuid(), "h");
    return r.outcome === "accepted" && r.invalidated_certification_id === latest && (await invCount()) >= 3 && (await certSnapshot(certA)) === certBefore;
  });

  await check("final sufficiency sweep: every linked mapping still satisfies the full contract", async () => {
    const bad = await linkedRowsViolatingContract();
    return bad.length === 0 ? true : bad;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n──────────────────────────────────────────\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
  console.log(failed.length === 0 ? "MAPPING_PROCESSING_AUTHORITY: ALL PASSED" : "MAPPING_PROCESSING_AUTHORITY: FAILED");
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
// Explicit: the embedded server's own exit hooks must never turn a failed proof into exit code 0.
process.exit(ok ? 0 : 1);
