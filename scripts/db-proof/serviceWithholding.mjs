#!/usr/bin/env node
// Real-PostgreSQL proof of 20261002100000_refuse_withheld_service_grants.sql: the database refuses every NEW grant of
// Tax computation, Compliance review, Filing package and Monitoring, keeps FINANCIAL_STATEMENTS (Prepare and Reconcile)
// grantable, and changes nothing that already exists.
//
//   Install    a clean database applies every migration from zero, this one included;
//   Upgrade    a database holding historical grants of all three services (and accounting records) applies it with every
//              row of every table byte-identical;
//   Refusal    open_engagement_with_scope and grant_engagement_capability refuse each withheld service with SQLSTATE PT422
//              SERVICE_NOT_AVAILABLE, atomically (no engagement, period or event is left behind); a withdrawn service
//              cannot be re-granted; REVOKE stays allowed; FINANCIAL_STATEMENTS still opens and grants;
//   Monitoring every existing Monitoring grant (in a mixed and in a Monitoring-only engagement) is preserved and readable;
//              a new one is refused on every path; it can be revoked, and once revoked it cannot be granted again;
//   Boundary   anon cannot call or write; an authenticated direct write gets the ESTABLISHED RLS denial (recorded before the
//              migration, byte-identical after it — never SERVICE_NOT_AVAILABLE); service_role and the table owner are refused
//              by the AFTER INSERT backstop, which rolls the whole statement back; no BEFORE trigger consults availability;
//              the trigger function is executable by no client role;
//   Replay     a refused request refused again writes nothing; a historical grant replayed creates nothing new;
//   Concurrency 25 simultaneous refused opens and 25 simultaneous refused grants leave nothing; 25 simultaneous allowed
//              opens still converge on ONE engagement;
//   History    every historical grant stays readable through fold_engagement_mandate, unchanged;
//   Re-apply   applying the migration again changes nothing (one trigger, same data);
//   Zero deletion  the migration contains no DROP, DELETE, TRUNCATE, UPDATE or ALTER TABLE, and no row disappears.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/serviceWithholding.mjs
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
const MIGRATION = "20261002100000_refuse_withheld_service_grants.sql";
const WITHHELD = ["TAX_COMPUTATION", "COMPLIANCE_REVIEW", "FILING_PREPARATION", "MONITORING"];
const CONCURRENCY = 25;
const MODE = process.env.DB_PROOF_MODE ?? "embedded";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
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
const isWithheld = (e) => e?.code === "PT422" && e?.message === "SERVICE_NOT_AVAILABLE";
async function refusedWithheld(name, fn) {
  try {
    await fn();
    record(name, false, "no error was raised");
  } catch (e) {
    record(name, isWithheld(e), `expected PT422 SERVICE_NOT_AVAILABLE, got ${e.code}: ${String(e.message).split("\n")[0]}`);
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

let embeddedServer = null;
let embeddedDir = null;
let port = null;
const opened = [];
function assertLocal(u) {
  const url = new URL(u);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`REFUSED: ${url.hostname} is not loopback`);
  if (u.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project reference");
}
/** A fresh, empty database on the same server; returns its connection URL. */
async function newDatabase(name) {
  if (MODE === "external") {
    assertLocal(process.env.DB_PROOF_CONN);
    const base = new URL(process.env.DB_PROOF_CONN);
    const boot = new Client({ connectionString: process.env.DB_PROOF_CONN });
    await boot.connect();
    if (name !== base.pathname.slice(1)) { await boot.query(`DROP DATABASE IF EXISTS ${name}`); await boot.query(`CREATE DATABASE ${name}`); }
    await boot.end();
    base.pathname = `/${name}`;
    return base.toString();
  }
  if (!embeddedServer) {
    const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
    const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
    embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-withholding-proof-"));
    port = 54000 + Math.floor(Math.random() * 900);
    embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
    await embeddedServer.initialise();
    await embeddedServer.start();
  }
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect();
  await boot.query(`CREATE DATABASE ${name}`);
  await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/${name}`;
}
async function stopDatabase() {
  for (const c of opened) { try { await c.end(); } catch { /* ignore */ } }
  if (embeddedServer) { try { await embeddedServer.stop(); } catch { /* ignore */ } }
  if (embeddedDir) { try { fs.rmSync(embeddedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ } }
}

const migrationFiles = () => fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
async function bootstrap(db) {
  await db.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  // Supabase grants table/function privileges to the client roles by default; RLS and explicit REVOKEs are the boundary.
  await db.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
}
async function applyMigration(db, f) {
  let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
  if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  try { await db.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
}

let pool;
let admin;
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
const openScope = (caller, company, year, caps) => one(caller, "SELECT public.open_engagement_with_scope($1,$2,$3,'composite') r", [company, year, caps]).then((x) => x.r);
const grant = (caller, eng, cap) => one(caller, "SELECT public.grant_engagement_capability($1,$2,'x') r", [eng, cap]);
const fold = (caller, eng) => q(caller, "SELECT capability, granted FROM public.fold_engagement_mandate($1) ORDER BY capability", [eng]);

/** Every row of every table in EVERY non-system schema (public, auth, audit/event and any other), as a digest per table —
 *  the "nothing changed" oracle. */
async function snapshot(db = admin) {
  const tables = (await db.query(`SELECT format('%I.%I', schemaname, tablename) t FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg\\_%' ORDER BY 1`)).rows.map((r) => r.t);
  const out = {};
  for (const t of tables) {
    const r = (await db.query(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) h FROM ${t} x`)).rows[0];
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}
const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

/** Exact controlled refusal: SQLSTATE PT422 and the message SERVICE_NOT_AVAILABLE, nothing more. */
const exact = (e) => e?.code === "PT422" && e?.message === "SERVICE_NOT_AVAILABLE";
const seen = [];   // every refusal observed for a withheld service — the JURISDICTION_REQUIRED regression oracle
async function attempt(fn) {
  try { await fn(); return { ok: true }; } catch (e) { seen.push(`${e?.code}:${e?.message}`); return { ok: false, code: e?.code, message: e?.message }; }
}
/** Refused EXACTLY, and every row of every table byte-identical afterwards. */
async function refusedExactlyWithNoState(name, fn) {
  await check(name, async () => {
    const s0 = await snapshot();
    const r = await attempt(fn);
    const changed = diff(s0, await snapshot());
    return !r.ok && r.code === "PT422" && r.message === "SERVICE_NOT_AVAILABLE" && changed.length === 0 ? true : { result: r, changed };
  });
}
/** A direct mandate INSERT by an AUTHENTICATED session (the table privilege exists; row-level security must decide). */
const authDirect = (uid, eng, member, cap, action) => q(user(uid),
  "INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,$2,$3,999999,$4)", [eng, cap, action, member]);
const outcome = async (fn) => { try { await fn(); return "ALLOWED"; } catch (e) { return `${e?.code}:${e?.message}`; } };
const RLS_DENIAL = 'new row violates row-level security policy for table "engagement_mandate_events"';
/** Schema, ACL, trigger, policy and RLS fingerprint of everything this migration owns or touches. */
async function catalogFingerprint() {
  const one = async (sql) => (await admin.query(sql)).rows[0].h;
  return {
    functions: await one(`SELECT md5(string_agg(p.oid::regprocedure::text || pg_get_functiondef(p.oid) || coalesce(p.proacl::text,'') || p.proowner::regrole::text
        || p.prosecdef::text || p.provolatile::text || coalesce(array_to_string(p.proconfig, ','), ''), '#' ORDER BY p.oid::regprocedure::text)) h
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'`),
    triggers: await one(`SELECT md5(string_agg(t.tgrelid::regclass::text || t.tgname || pg_get_triggerdef(t.oid) || t.tgenabled::text, '#' ORDER BY t.tgrelid::regclass::text, t.tgname)) h
      FROM pg_trigger t WHERE NOT t.tgisinternal`),
    policies: await one(`SELECT md5(coalesce(string_agg(polrelid::regclass::text || polname || polcmd::text || coalesce(pg_get_expr(polqual,polrelid),'') || coalesce(pg_get_expr(polwithcheck,polrelid),''), '#' ORDER BY polrelid::regclass::text, polname), '')) h FROM pg_policy`),
    tables: await one(`SELECT md5(string_agg(c.oid::regclass::text || coalesce(c.relacl::text,'') || c.relrowsecurity::text || c.relforcerowsecurity::text, '#' ORDER BY c.oid::regclass::text)) h
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')`),
  };
}
const fnDef = async (sig) => (await admin.query("SELECT pg_get_functiondef($1::regprocedure) d, proowner::regrole::text o, proacl::text a FROM pg_proc WHERE oid = $1::regprocedure", [sig])).rows[0];
const GRANT_SIG = "public.grant_engagement_capability(uuid,text,text)";
const OPEN_SIG = "public.open_engagement_with_scope(uuid,integer,text[],text)";
const GRANT_LINE = "  PERFORM public.assert_capability_available(p_capability);\n";
const OPEN_LINE = "  FOREACH v_cap IN ARRAY v_caps LOOP PERFORM public.assert_capability_available(v_cap); END LOOP;\n";

async function main() {
  const migrationText = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8");
  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);

  group("Static contract");
  const code = migrationText.replace(/--[^\n]*/g, "");
  // Reviewed, unrelated forward migrations that may follow this one (exact names; nothing else may).
  // 20261003100000 is the classification-save digest fix (hosted 0027); 20261006100000 is S1 (hosted 0028). The parked
  // 20261004100000 / 20261005100000 are quarantined in supabase/migrations_historical/ (never applied).
  const LATER = ["20261003100000_account_review_digest_schema_qualification.sql", "20261006100000_mapping_and_processing_authority.sql", "20261007100000_treatment_authority_and_processing_control.sql", "20261008100000_processing_attempt_authority.sql", "20261009100000_currency_registry_and_reporting_periods.sql", "20261010100000_layout_templates_and_confirmations.sql", "20261011100000_two_period_shared_source.sql", "20261012100000_layout_assist_controls.sql", "20261013100000_close_review_timeline.sql", "20261014100000_close_review_findings.sql", "20261015100000_close_review_adjustments.sql", "20261016100000_fs_reporting_input.sql", "20261017100000_signoff_completion_requirements.sql", "20261018100000_fs_statement_composition.sql", "20261019100000_fs_notes_and_schedules.sql", "20261020100000_fs_comparatives.sql", "20261021100000_fs_signoff_binding.sql", "20261022100000_fs_reporting_closure.sql"];
  await check("the migration is the newest but for the named later migrations; its top-level statements contain no DROP, DELETE, TRUNCATE, UPDATE, INSERT or ALTER TABLE", async () => {
    // Function bodies (dollar-quoted) are excluded: the two RPC bodies are their existing definitions, proven below to
    // differ from them by exactly one line each.
    const topLevel = code.replace(/\$(function)?\$[\s\S]*?\$(function)?\$/g, "");
    if (JSON.stringify(files.slice(cut + 1)) !== JSON.stringify(LATER)) return `followed by ${files.slice(cut + 1).join(", ") || "nothing"}, expected exactly ${LATER.join(", ")}`;
    return !/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT\s+INTO|ALTER\s+TABLE)\b/i.test(topLevel) ? true : "data or schema-destructive statement present";
  });
  await check("ONE withheld list: only capability_customer_available() names the four services; every entry asserts through it", async () => {
    const list = "ARRAY['TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING']";
    const asserts = code.match(/public\.assert_capability_available\(/g)?.length ?? 0;
    return code.split(list).length === 2 && asserts === 5 /* definition + its REVOKE + open + grant + trigger */ && !/IN \('TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING'\)/.test(code) ? true : { asserts };
  });

  group("Clean install");
  const cleanUrl = await newDatabase("withholding_clean");
  const clean = new Client({ connectionString: cleanUrl }); await clean.connect(); opened.push(clean);
  await check("every repository migration, this one included, applies on an empty PostgreSQL", async () => { await bootstrap(clean); for (const f of files) await applyMigration(clean, f); return true; });
  await check("the clean database has exactly one refusal trigger and both availability functions", async () =>
    Number((await clean.query("SELECT count(*) n FROM pg_trigger WHERE tgname='trg_refuse_withheld_service_grant' AND tgrelid='public.engagement_mandate_events'::regclass AND NOT tgisinternal")).rows[0].n) === 1
    && Number((await clean.query("SELECT count(*) n FROM pg_proc WHERE proname IN ('capability_customer_available','assert_capability_available') AND pronamespace='public'::regnamespace")).rows[0].n) === 2);
  await clean.end(); opened.pop();

  const url = await newDatabase("withholding_upgrade");
  admin = new Client({ connectionString: url }); await admin.connect(); opened.push(admin);
  pool = new Pool({ connectionString: url, max: CONCURRENCY + 5 });

  group("Upgrade — history recorded BEFORE the migration");
  await check("every migration before this one applies", async () => { await bootstrap(admin); for (const f of files.slice(0, cut)) await applyMigration(admin, f); return true; });
  const U = { owner: uuid(), partner: uuid(), preparer: uuid(), outsider: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  for (const [uid, plan] of [[U.owner, "PRACTICE"], [U.ownerB, "FIRM"], [U.outsider, "SOLO"]]) {
    const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).rows[0].id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code=$3", [bc, prod, plan]);
  }
  // Company A HAS a filing jurisdiction; company B does NOT.
  const A = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company A') RETURNING id", [U.owner])).rows[0].id;
  const B = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company B') RETURNING id", [U.ownerB])).rows[0].id;
  for (const [k, role] of [["partner", "partner"], ["preparer", "preparer"]]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], role]);
  const COMPANY = { A: { id: A, caller: user(U.owner), label: "with filing jurisdiction" }, B: { id: B, caller: user(U.ownerB), label: "without filing jurisdiction" } };

  let E2026; let ETAX; let E2024; let EMON; let BMON;
  await check("historical grants exist through the real commands (A: all five; Tax-only; withdrawn Tax; Monitoring-only — B: Monitoring-only)", async () => {
    await one(user(U.partner), "SELECT public.set_company_filing_jurisdiction($1,'TZ') j", [A]);
    E2026 = (await openScope(user(U.owner), A, 2026, ["FINANCIAL_STATEMENTS", ...WITHHELD])).engagementId;
    ETAX = (await openScope(user(U.owner), A, 2025, ["TAX_COMPUTATION"])).engagementId;
    E2024 = (await openScope(user(U.owner), A, 2024, ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"])).engagementId;
    await q(user(U.owner), "SELECT public.revoke_engagement_capability($1,'TAX_COMPUTATION','client withdrew')", [E2024]);
    EMON = (await openScope(user(U.owner), A, 2023, ["MONITORING"])).engagementId;
    BMON = (await openScope(user(U.ownerB), B, 2023, ["MONITORING"])).engagementId;
    return (await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE action='GRANT' AND capability = ANY($1)", [WITHHELD])) === 8;
  });
  await check("accounting records exist: a trial balance upload and a committed tax computation", async () => {
    const up = (await admin.query("INSERT INTO public.trial_balance_uploads (user_id, company_id, file_name, file_path, file_size, status, period_year) VALUES ($1,$2,'tb.csv','u/tb.csv',100,'complete',2025) RETURNING id", [U.owner, A])).rows[0].id;
    await admin.query("INSERT INTO public.tax_computations (company_id, upload_id, period_year, computation_detail) VALUES ($1,$2,2025,'{\"cit_payable_tzs\": 1234}'::jsonb)", [A, up]);
    return (await count("SELECT count(*) n FROM public.tax_computations")) === 1;
  });
  // The ESTABLISHED result of an authenticated direct mandate INSERT, recorded on the pre-migration database: every
  // capability × GRANT/REVOKE × with/without jurisdiction. After the migration each must be byte-identical (RLS denial).
  const memberPre = async (company, uid) => (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [company, uid])).rows[0].id;
  const DIRECT_TARGETS = { A: { uid: U.owner, eng: E2026, member: await memberPre(A, U.owner) }, B: { uid: U.ownerB, eng: BMON, member: await memberPre(B, U.ownerB) } };
  const DIRECT_CASES = [];
  for (const k of ["A", "B"]) for (const cap of ["FINANCIAL_STATEMENTS", ...WITHHELD]) for (const action of ["GRANT", "REVOKE"]) DIRECT_CASES.push({ k, cap, action });
  const established = {};
  for (const c of DIRECT_CASES) { const t = DIRECT_TARGETS[c.k]; established[`${c.k}:${c.cap}:${c.action}`] = await outcome(() => authDirect(t.uid, t.eng, t.member, c.cap, c.action)); }
  await check("pre-migration: every authenticated direct mandate INSERT is the RLS denial (42501) — the established result", async () => {
    const off = Object.entries(established).filter(([, v]) => v !== `42501:${RLS_DENIAL}`);
    return off.length === 0 ? true : off.slice(0, 4);
  });
  const before = await snapshot();
  const historicalEvents = (await admin.query("SELECT * FROM public.engagement_mandate_events ORDER BY engagement_id, sequence_no")).rows;
  const grantBefore = await fnDef(GRANT_SIG);
  const openBefore = await fnDef(OPEN_SIG);

  group("Apply");
  await check(`${MIGRATION} applies on the database with history`, async () => { await applyMigration(admin, MIGRATION); return true; });
  await check("every row of every table (public and auth) is byte-identical after the upgrade", async () => { const d = diff(before, await snapshot()); return d.length === 0 ? true : d; });
  await check("each RPC is its previous definition with exactly ONE added availability line; owner and privileges unchanged", async () => {
    const g = await fnDef(GRANT_SIG); const o = await fnDef(OPEN_SIG);
    return g.d.split(GRANT_LINE).length === 2 && g.d.replace(GRANT_LINE, "") === grantBefore.d && g.o === grantBefore.o && g.a === grantBefore.a
      && o.d.split(OPEN_LINE).length === 2 && o.d.replace(OPEN_LINE, "") === openBefore.d && o.o === openBefore.o && o.a === openBefore.a;
  });
  await check("ordering in the RPCs: authorization BEFORE availability; availability BEFORE jurisdiction, lock, period, engagement and insert", async () => {
    const g = (await fnDef(GRANT_SIG)).d; const o = (await fnDef(OPEN_SIG)).d;
    const at = (s, needle) => s.indexOf(needle);
    return at(g, "assert_engagement_write_authority") < at(g, GRANT_LINE) && at(g, GRANT_LINE) < at(g, "capability_needs_jurisdiction")
      && at(g, GRANT_LINE) < at(g, "INSERT INTO public.engagement_mandate_events")
      && at(o, "FORBIDDEN: choosing services") < at(o, OPEN_LINE) && at(o, OPEN_LINE) < at(o, "pg_advisory_xact_lock")
      && at(o, OPEN_LINE) < at(o, "INSERT INTO public.fiscal_periods") && at(o, OPEN_LINE) < at(o, "INSERT INTO public.engagements");
  });

  // Customer-available engagements to grant into, opened AFTER the migration (Financial statements only).
  const EA = (await openScope(COMPANY.A.caller, A, 2027, ["FINANCIAL_STATEMENTS"])).engagementId;
  const EB = (await openScope(COMPANY.B.caller, B, 2027, ["FINANCIAL_STATEMENTS"])).engagementId;
  const ENG = { A: EA, B: EB };
  const memberOf = async (company, uid) => (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [company, uid])).rows[0].id;
  const MEMBER = { A: await memberOf(A, U.owner), B: await memberOf(B, U.ownerB) };
  const directInsert = (caller, k, cap) => {
    const sql = "INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,$2,'GRANT',public.next_engagement_sequence($1),$3)";
    return caller === "owner" ? admin.query(sql, [ENG[k], cap, MEMBER[k]]) : q(SERVICE, sql, [ENG[k], cap, MEMBER[k]]);
  };

  group("A–D. every withheld service × with / without jurisdiction × every entry path → exactly PT422 SERVICE_NOT_AVAILABLE, nothing written");
  let year = 2040;
  for (const cap of WITHHELD) {
    for (const k of ["A", "B"]) {
      const { id, caller, label } = COMPANY[k];
      await refusedExactlyWithNoState(`${cap} · ${label} · open_engagement_with_scope (new workspace, alone)`, () => openScope(caller, id, year++, [cap]));
      await refusedExactlyWithNoState(`${cap} · ${label} · open_engagement_with_scope (new workspace, with Financial statements)`, () => openScope(caller, id, year++, ["FINANCIAL_STATEMENTS", cap]));
      await refusedExactlyWithNoState(`${cap} · ${label} · open_engagement_with_scope (existing workspace)`, () => openScope(caller, id, 2027, ["FINANCIAL_STATEMENTS", cap]));
      await refusedExactlyWithNoState(`${cap} · ${label} · grant_engagement_capability`, () => grant(caller, ENG[k], cap));
      await refusedExactlyWithNoState(`${cap} · ${label} · direct mandate INSERT as service_role`, () => directInsert("service", k, cap));
      await refusedExactlyWithNoState(`${cap} · ${label} · direct mandate INSERT as the table owner (superuser)`, () => directInsert("owner", k, cap));
    }
  }
  await refusedExactlyWithNoState("a withdrawn Tax grant (A 2024) cannot be granted again", () => grant(user(U.owner), E2024, "TAX_COMPUTATION"));
  await refusedExactlyWithNoState("replaying an existing withheld grant through open_engagement_with_scope (A 2025, Tax) is refused, nothing written", () => openScope(user(U.owner), A, 2025, ["TAX_COMPUTATION"]));

  group("4. authorization precedes availability — an unauthorized caller gets the established FORBIDDEN, never availability state");
  const forbidden = async (name, fn) => check(name, async () => {
    const s0 = await snapshot(); const r = await attempt(fn);
    return !r.ok && r.code === "42501" && !/SERVICE_NOT_AVAILABLE|JURISDICTION/.test(r.message ?? "") && diff(s0, await snapshot()).length === 0 ? true : r;
  });
  await forbidden("anonymous · open_engagement_with_scope(Tax) → 42501", () => openScope(ANON, A, 2050, ["TAX_COMPUTATION"]));
  await forbidden("anonymous · grant_engagement_capability(Monitoring) → 42501", () => grant(ANON, EA, "MONITORING"));
  await forbidden("a non-member · open_engagement_with_scope(Tax) on company A → 42501 FORBIDDEN", () => openScope(user(U.outsider), A, 2051, ["TAX_COMPUTATION"]));
  await forbidden("a non-member · grant_engagement_capability(Compliance) on A's engagement → 42501", () => grant(user(U.outsider), EA, "COMPLIANCE_REVIEW"));
  await forbidden("a preparer without review_close · open_engagement_with_scope(Filing) → 42501", () => openScope(user(U.preparer), A, 2052, ["FILING_PREPARATION"]));
  await forbidden("a preparer without review_close · grant_engagement_capability(Monitoring) → 42501", () => grant(user(U.preparer), EA, "MONITORING"));

  group("4b. authenticated direct-table caller: table privilege → RLS → (never) the backstop — the established result, unchanged");
  for (const c of DIRECT_CASES) {
    const t = DIRECT_TARGETS[c.k];
    await check(`authenticated direct INSERT · ${c.cap} ${c.action} · ${COMPANY[c.k].label} → the established RLS denial (42501), byte-identical, nothing written`, async () => {
      const s0 = await snapshot();
      const now = await outcome(() => authDirect(t.uid, t.eng, t.member, c.cap, c.action));
      const changed = diff(s0, await snapshot());
      return now === established[`${c.k}:${c.cap}:${c.action}`] && now === `42501:${RLS_DENIAL}` && !/SERVICE_NOT_AVAILABLE|JURISDICTION/.test(now) && changed.length === 0
        ? true : { now, established: established[`${c.k}:${c.cap}:${c.action}`], changed };
    });
  }
  await check("anonymous direct INSERT of a withheld GRANT → permission denied (table privilege), never availability", async () => {
    const r = await outcome(() => q(ANON, "INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'TAX_COMPUTATION','GRANT',999999,$2)", [EA, MEMBER.A]));
    return r === "42501:permission denied for table engagement_mandate_events" ? true : r;
  });

  group("4c. the backstop is AFTER INSERT; no BEFORE trigger reveals availability; an AFTER refusal rolls the whole statement back");
  await check("trg_refuse_withheld_service_grant is AFTER, ROW, INSERT-only, enabled, on engagement_mandate_events", async () => {
    const r = (await admin.query(`SELECT tgtype, tgenabled::text e, tgrelid::regclass::text rel, pg_get_triggerdef(oid) d FROM pg_trigger
      WHERE tgname='trg_refuse_withheld_service_grant' AND NOT tgisinternal`)).rows;
    // tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE, 64 INSTEAD.
    return r.length === 1 && r[0].rel === "engagement_mandate_events" && (r[0].tgtype & 1) === 1 && (r[0].tgtype & 2) === 0 && (r[0].tgtype & 64) === 0
      && (r[0].tgtype & (4 | 8 | 16 | 32)) === 4 && r[0].e === "O" && /AFTER INSERT ON public\.engagement_mandate_events FOR EACH ROW/.test(r[0].d) ? true : r;
  });
  await check("no BEFORE trigger on engagement_mandate_events (or on any public table) consults availability", async () => {
    const r = (await admin.query(`SELECT t.tgrelid::regclass::text rel, t.tgname, p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND (t.tgtype & 2) = 2 AND (p.prosrc ~ 'assert_capability_available|capability_customer_available|SERVICE_NOT_AVAILABLE|refuse_withheld')`)).rows;
    return r.length === 0 ? true : r;
  });
  for (const who of ["service_role", "owner"]) {
    await check(`${who}: ONE multi-row INSERT (an allowed Financial statements REVOKE + a withheld GRANT) → exactly PT422 SERVICE_NOT_AVAILABLE; NEITHER row persists`, async () => {
      const s0 = await snapshot();
      const sql = `INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id)
        VALUES ($1,'FINANCIAL_STATEMENTS','REVOKE',public.next_engagement_sequence($1),$2), ($1,'MONITORING','GRANT',public.next_engagement_sequence($1)+1,$2)`;
      const r = await attempt(() => (who === "owner" ? admin.query(sql, [EA, MEMBER.A]) : q(SERVICE, sql, [EA, MEMBER.A])));
      const changed = diff(s0, await snapshot());
      return exact(r) && changed.length === 0 ? true : { r, changed };
    });
    await check(`${who}: an explicit transaction (allowed write, then a withheld GRANT) is aborted by the AFTER refusal and leaves nothing`, async () => {
      const s0 = await snapshot();
      const c = who === "owner" ? await pool.connect() : null;
      let r;
      if (who === "owner") {
        try {
          await c.query("BEGIN");
          await c.query("INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'FINANCIAL_STATEMENTS','REVOKE',public.next_engagement_sequence($1),$2)", [EA, MEMBER.A]);
          await c.query("INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'TAX_COMPUTATION','GRANT',public.next_engagement_sequence($1),$2)", [EA, MEMBER.A]);
          await c.query("COMMIT"); r = { ok: true };
        } catch (e) { r = { ok: false, code: e.code, message: e.message }; await c.query("ROLLBACK"); } finally { c.release(); }
      } else {
        r = await attempt(() => asCaller(SERVICE, async (cc) => {
          await cc.query("INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'FINANCIAL_STATEMENTS','REVOKE',public.next_engagement_sequence($1),$2)", [EA, MEMBER.A]);
          await cc.query("INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'TAX_COMPUTATION','GRANT',public.next_engagement_sequence($1),$2)", [EA, MEMBER.A]);
        }));
      }
      const changed = diff(s0, await snapshot());
      return exact(r) && changed.length === 0 ? true : { r, changed };
    });
  }

  group("E. negative control — FINANCIAL_STATEMENTS still grants, with and without a filing jurisdiction");
  for (const k of ["A", "B"]) {
    const { id, caller, label } = COMPANY[k];
    await check(`${label}: a new Financial statements workspace opens`, async () => {
      const r = await openScope(caller, id, 2060, ["FINANCIAL_STATEMENTS"]);
      return r.created === true && JSON.stringify(r.granted) === JSON.stringify(["FINANCIAL_STATEMENTS"]);
    });
    await check(`${label}: Financial statements can be revoked and granted again through grant_engagement_capability`, async () => {
      await q(caller, "SELECT public.revoke_engagement_capability($1,'FINANCIAL_STATEMENTS','scope check')", [ENG[k]]);
      await grant(caller, ENG[k], "FINANCIAL_STATEMENTS");
      return (await fold(caller, ENG[k])).some((r) => r.capability === "FINANCIAL_STATEMENTS" && r.granted === true);
    });
    await check(`${label}: service_role may still write a Financial statements GRANT and a REVOKE directly`, async () => {
      await q(SERVICE, "INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'FINANCIAL_STATEMENTS','REVOKE',public.next_engagement_sequence($1),$2)", [ENG[k], MEMBER[k]]);
      await q(SERVICE, "INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'FINANCIAL_STATEMENTS','GRANT',public.next_engagement_sequence($1),$2)", [ENG[k], MEMBER[k]]);
      return true;
    });
  }

  group(`F. concurrency — ${CONCURRENCY} simultaneous mixed withheld-service requests (paths, companies, services)`);
  await check("every one is exactly SERVICE_NOT_AVAILABLE; zero partial state", async () => {
    const s0 = await snapshot();
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => {
      const k = i % 2 ? "A" : "B"; const cap = WITHHELD[i % WITHHELD.length]; const { id, caller } = COMPANY[k];
      const fn = [() => openScope(caller, id, 2070 + (i % 3), ["FINANCIAL_STATEMENTS", cap]), () => grant(caller, ENG[k], cap), () => directInsert("service", k, cap), () => directInsert("owner", k, cap)][i % 4];
      return attempt(fn);
    }));
    const bad = out.filter((r) => r.ok || r.code !== "PT422" || r.message !== "SERVICE_NOT_AVAILABLE");
    return bad.length === 0 && diff(s0, await snapshot()).length === 0 ? true : { bad: bad.slice(0, 3) };
  });
  await check(`${CONCURRENCY * 2} simultaneous MIXED requests: withheld RPC/service_role/owner → exact PT422; authenticated direct → established RLS denial; Financial statements opens → succeed and converge`, async () => {
    const tableRows = async () => Object.fromEntries(Object.entries(await snapshot()).filter(([t]) => t !== "public.engagement_mandate_events" && t !== "public.engagements" && t !== "public.fiscal_periods"));
    const others0 = await tableRows();
    const ev0 = await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE action='GRANT' AND capability = ANY($1)", [WITHHELD]);
    const jobs = Array.from({ length: CONCURRENCY * 2 }, (_, i) => {
      const k = i % 2 ? "A" : "B"; const cap = WITHHELD[i % WITHHELD.length]; const { id, caller } = COMPANY[k]; const t = DIRECT_TARGETS[k];
      const kinds = [
        ["withheld", () => openScope(caller, id, 2075, [cap])],
        ["withheld", () => openScope(caller, id, 2075, ["FINANCIAL_STATEMENTS", cap])],
        ["withheld", () => grant(caller, ENG[k], cap)],
        ["withheld", () => directInsert("service", k, cap)],
        ["withheld", () => directInsert("owner", k, cap)],
        ["authenticated", () => authDirect(t.uid, t.eng, t.member, cap, "GRANT")],
        ["fs", () => openScope(caller, id, 2076, ["FINANCIAL_STATEMENTS"])],
      ];
      const [kind, fn] = kinds[i % kinds.length];
      return outcome(fn).then((o) => ({ kind, o }));
    });
    const out = await Promise.all(jobs);
    const badWithheld = out.filter((x) => x.kind === "withheld" && x.o !== "PT422:SERVICE_NOT_AVAILABLE");
    const badAuth = out.filter((x) => x.kind === "authenticated" && x.o !== `42501:${RLS_DENIAL}`);
    const badFs = out.filter((x) => x.kind === "fs" && x.o !== "ALLOWED");
    const p2075 = await count("SELECT count(*) n FROM public.fiscal_periods WHERE company_id = ANY($1) AND EXTRACT(YEAR FROM fiscal_year_end) = 2075", [[A, B]]);
    const e2076 = (await admin.query("SELECT g.company_id, count(*)::int n FROM public.engagements g JOIN public.fiscal_periods p ON p.id = g.fiscal_period_id WHERE g.company_id = ANY($1) AND EXTRACT(YEAR FROM p.fiscal_year_end) = 2076 GROUP BY 1", [[A, B]])).rows;
    const ev1 = await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE action='GRANT' AND capability = ANY($1)", [WITHHELD]);
    const othersChanged = diff(others0, await tableRows());
    return badWithheld.length === 0 && badAuth.length === 0 && badFs.length === 0 && p2075 === 0 && ev1 === ev0
      && e2076.length === 2 && e2076.every((x) => x.n === 1) && othersChanged.length === 0
      ? true : { badWithheld: badWithheld.slice(0, 3), badAuth: badAuth.slice(0, 3), badFs: badFs.slice(0, 3), p2075, e2076, ev0, ev1, othersChanged };
  });
  await check(`${CONCURRENCY} simultaneous allowed opens (Financial statements, A 2080) still converge on ONE engagement`, async () => {
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => openScope(i % 2 ? user(U.partner) : user(U.owner), A, 2080, ["FINANCIAL_STATEMENTS"])));
    return new Set(out.map((o) => o.engagementId)).size === 1 && out.filter((o) => o.created).length === 1;
  });

  group("G. regression — JURISDICTION_REQUIRED never answers a withheld-service grant");
  await check(`none of the ${seen.length} withheld-service refusals observed reported JURISDICTION_REQUIRED (or anything but the exact contract)`, async () => {
    const offending = seen.filter((s) => s !== "PT422:SERVICE_NOT_AVAILABLE" && !s.startsWith("42501:"));
    return seen.length > 0 && !seen.some((s) => /JURISDICTION/.test(s)) && offending.length === 0 ? true : offending.slice(0, 5);
  });

  group("Existing grants preserved; REVOKE allowed; no re-grant");
  await check("every historical mandate event is byte-identical", async () => {
    const now = (await admin.query("SELECT * FROM public.engagement_mandate_events WHERE id = ANY($1) ORDER BY engagement_id, sequence_no", [historicalEvents.map((e) => e.id)])).rows;
    return JSON.stringify(now) === JSON.stringify(historicalEvents);
  });
  await check("historical grants stay readable: A 2026 (all five), A 2025 (Tax only), A 2023 and B 2023 (Monitoring only)", async () =>
    (await fold(user(U.owner), E2026)).filter((r) => r.granted).length === 5
    && JSON.stringify(await fold(user(U.partner), ETAX)) === JSON.stringify([{ capability: "TAX_COMPUTATION", granted: true }])
    && JSON.stringify(await fold(user(U.owner), EMON)) === JSON.stringify([{ capability: "MONITORING", granted: true }])
    && JSON.stringify(await fold(user(U.ownerB), BMON)) === JSON.stringify([{ capability: "MONITORING", granted: true }]));
  for (const [label, caller, eng] of [["A 2026", user(U.owner), E2026], ["B 2023", user(U.ownerB), BMON]]) {
    await check(`${label}: REVOKE of an existing Monitoring grant is allowed and appends exactly one REVOKE event`, async () => {
      const n0 = await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id=$1", [eng]);
      await q(caller, "SELECT public.revoke_engagement_capability($1,'MONITORING','withheld from customers')", [eng]);
      const last = (await admin.query("SELECT action, capability FROM public.engagement_mandate_events WHERE engagement_id=$1 ORDER BY sequence_no DESC LIMIT 1", [eng])).rows[0];
      return (await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id=$1", [eng])) === n0 + 1 && last.action === "REVOKE" && last.capability === "MONITORING";
    });
    await refusedExactlyWithNoState(`${label}: …and once revoked, Monitoring cannot be granted again`, () => grant(caller, eng, "MONITORING"));
  }
  await check("accounting data is unchanged: uploads, tax computations, account mappings and closing balances", async () => {
    const now = await snapshot();
    const tables = ["public.trial_balance_uploads", "public.tax_computations", "public.account_mappings", "public.period_closing_balances"];
    return tables.every((t) => now[t] === before[t]) && Number(now["public.tax_computations"].split(":")[0]) === 1 ? true : tables.filter((t) => now[t] !== before[t]);
  });

  group("Privileges");
  await check("the availability functions and the trigger function are executable by no client role", async () => {
    const r = (await admin.query(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') b, has_function_privilege('service_role', p.oid, 'EXECUTE') c
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('capability_customer_available','assert_capability_available','refuse_withheld_service_grant')`)).rows;
    return r.length === 3 && r.every((x) => !x.a && !x.b && !x.c) ? true : r;
  });
  await check("internal helpers grant EXECUTE to their owner ONLY — no PUBLIC, anon, authenticated or service_role entry in the ACL", async () => {
    const r = (await admin.query(`SELECT p.proname, p.proacl::text acl, p.proowner::regrole::text owner,
        has_function_privilege('public', p.oid, 'EXECUTE') pub
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('capability_customer_available','assert_capability_available','refuse_withheld_service_grant')`)).rows;
    return r.length === 3 && r.every((x) => x.acl === `{${x.owner}=X/${x.owner}}` && x.pub === false) ? true : r;
  });
  await check("the RPCs remain executable by authenticated and not by anon", async () => {
    const r = (await admin.query(`SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') a, has_function_privilege('anon', $1::regprocedure, 'EXECUTE') b,
      has_function_privilege('authenticated', $2::regprocedure, 'EXECUTE') c, has_function_privilege('anon', $2::regprocedure, 'EXECUTE') d`, [GRANT_SIG, OPEN_SIG])).rows[0];
    return r.a && !r.b && r.c && !r.d ? true : r;
  });
  await check("every new function pins its search_path", async () => {
    const r = (await admin.query("SELECT proname, proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('capability_customer_available','assert_capability_available','refuse_withheld_service_grant')")).rows;
    return r.length === 3 && r.every((x) => (x.proconfig ?? []).some((c) => c.startsWith("search_path="))) ? true : r;
  });

  group("Re-apply");
  await check("applying the migration again TWICE changes no row, no function definition or ACL, no trigger definition or enabled state, no policy or RLS flag", async () => {
    const s0 = await snapshot(); const c0 = await catalogFingerprint(); const g0 = await fnDef(GRANT_SIG); const o0 = await fnDef(OPEN_SIG);
    await applyMigration(admin, MIGRATION);
    await applyMigration(admin, MIGRATION);
    const n = Number((await admin.query("SELECT count(*) n FROM pg_trigger WHERE tgname='trg_refuse_withheld_service_grant' AND NOT tgisinternal")).rows[0].n);
    const c1 = await catalogFingerprint();
    const catalogChanged = Object.keys(c0).filter((k) => c0[k] !== c1[k]);
    const rows = diff(s0, await snapshot());
    return rows.length === 0 && n === 1 && catalogChanged.length === 0 && JSON.stringify(await fnDef(GRANT_SIG)) === JSON.stringify(g0) && JSON.stringify(await fnDef(OPEN_SIG)) === JSON.stringify(o0)
      ? true : { rows, n, catalogChanged };
  });
  await refusedExactlyWithNoState("after re-application the refusal still holds (B, Tax, grant)", () => grant(COMPANY.B.caller, EB, "TAX_COMPUTATION"));

  group("Zero deletion");
  await check("no table lost a row between the pre-migration snapshot and the end of the proof", async () => {
    const now = await snapshot();
    const lost = Object.keys(before).filter((t) => Number(now[t]?.split(":")[0] ?? -1) < Number(before[t].split(":")[0]));
    return lost.length === 0 ? true : lost;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"─".repeat(42)}\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
  console.log(failed.length ? "SERVICE_WITHHOLDING: FAILED" : "SERVICE_WITHHOLDING: ALL PASSED");
  await pool?.end().catch(() => {});
  await stopDatabase();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool?.end().catch(() => {});
  await stopDatabase();
  process.exit(1);
});
