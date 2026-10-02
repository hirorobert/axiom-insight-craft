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
//   Boundary   anon cannot call or write; authenticated cannot write the table directly; service_role and the table owner
//              are refused by the trigger itself; the trigger function is executable by no client role;
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

/** Every row of every table in public (and auth.users), as a digest per table — the "nothing changed" oracle. */
async function snapshot(db = admin) {
  const tables = (await db.query(`SELECT format('%I.%I', schemaname, tablename) t FROM pg_tables WHERE schemaname IN ('public','auth') ORDER BY 1`)).rows.map((r) => r.t);
  const out = {};
  for (const t of tables) {
    const r = (await db.query(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) h FROM ${t} x`)).rows[0];
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}
const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

async function main() {
  const migrationText = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8");
  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);

  group("Static contract");
  await check("the migration is the newest and contains no DROP, DELETE, TRUNCATE, UPDATE, INSERT or ALTER TABLE", async () => {
    const sql = migrationText.replace(/--[^\n]*/g, "");
    if (cut !== files.length - 1) return `not the newest (followed by ${files.slice(cut + 1).join(", ")})`;
    return !/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT\s+INTO|ALTER\s+TABLE)\b/i.test(sql) ? true : "data or schema-destructive statement present";
  });
  await check("it raises only the controlled SERVICE_NOT_AVAILABLE (PT422) — no internal wording", async () => {
    const sql = migrationText.replace(/--[^\n]*/g, "");
    const raised = [...sql.matchAll(/RAISE EXCEPTION '([^']+)'/g)].map((m) => m[1]);
    const codes = [...sql.matchAll(/ERRCODE = '([^']+)'/g)].map((m) => m[1]);
    return raised.length === 1 && raised[0] === "SERVICE_NOT_AVAILABLE" && codes.length === 1 && codes[0] === "PT422" && !/iron dome|kinga|hesabu/i.test(sql) ? true : { raised, codes };
  });

  // ── Clean install: every migration from zero, this one included ─────────────────────────────────────────────────
  group("Clean install");
  const cleanUrl = await newDatabase("withholding_clean");
  const clean = new Client({ connectionString: cleanUrl }); await clean.connect(); opened.push(clean);
  await check("every repository migration, this one included, applies on an empty PostgreSQL", async () => {
    await bootstrap(clean);
    for (const f of files) await applyMigration(clean, f);
    return true;
  });
  await check("the clean database has exactly one refusal trigger on engagement_mandate_events", async () =>
    Number((await clean.query("SELECT count(*) n FROM pg_trigger WHERE tgname='trg_refuse_withheld_service_grant' AND tgrelid='public.engagement_mandate_events'::regclass AND NOT tgisinternal")).rows[0].n) === 1);
  await clean.end(); opened.pop();

  // ── Upgrade: a database with history, then this migration ──────────────────────────────────────────────────────
  const url = await newDatabase("withholding_upgrade");
  admin = new Client({ connectionString: url }); await admin.connect(); opened.push(admin);
  pool = new Pool({ connectionString: url, max: CONCURRENCY + 5 });

  group("Upgrade — history recorded BEFORE the migration");
  await check("every migration before this one applies", async () => { await bootstrap(admin); for (const f of files.slice(0, cut)) await applyMigration(admin, f); return true; });

  const U = { owner: uuid(), partner: uuid(), preparer: uuid(), outsider: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  for (const [uid, plan] of [[U.owner, "PRACTICE"], [U.ownerB, "FIRM"]]) {
    const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).rows[0].id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code=$3", [bc, prod, plan]);
  }
  const A = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company A') RETURNING id", [U.owner])).rows[0].id;
  const B = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company B') RETURNING id", [U.ownerB])).rows[0].id;
  for (const [k, role] of [["partner", "partner"], ["preparer", "preparer"]]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], role]);

  let E2026; let E2024; let ETAX; let EMON;
  await check("historical grants exist through the real commands: all five services (A 2026), a Tax-only engagement (A 2025), a withdrawn Tax grant (A 2024), a Monitoring-only engagement (A 2023)", async () => {
    await one(user(U.partner), "SELECT public.set_company_filing_jurisdiction($1,'TZ') j", [A]);
    E2026 = (await openScope(user(U.owner), A, 2026, ["FINANCIAL_STATEMENTS", "MONITORING", ...WITHHELD])).engagementId;
    ETAX = (await openScope(user(U.owner), A, 2025, ["TAX_COMPUTATION"])).engagementId;
    E2024 = (await openScope(user(U.owner), A, 2024, ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"])).engagementId;
    await q(user(U.owner), "SELECT public.revoke_engagement_capability($1,'TAX_COMPUTATION','client withdrew')", [E2024]);
    EMON = (await openScope(user(U.owner), A, 2023, ["MONITORING"])).engagementId;
    return (await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE action='GRANT' AND capability = ANY($1)", [WITHHELD])) === 7;
  });
  await check("accounting records exist: a trial balance upload and a committed tax computation for company A", async () => {
    const up = (await admin.query("INSERT INTO public.trial_balance_uploads (user_id, company_id, file_name, file_path, file_size, status, period_year) VALUES ($1,$2,'tb.csv','u/tb.csv',100,'complete',2025) RETURNING id", [U.owner, A])).rows[0].id;
    await admin.query("INSERT INTO public.tax_computations (company_id, upload_id, period_year, computation_detail) VALUES ($1,$2,2025,'{\"cit_payable_tzs\": 1234}'::jsonb)", [A, up]);
    return (await count("SELECT count(*) n FROM public.tax_computations")) === 1;
  });

  const before = await snapshot();
  const historicalEvents = (await admin.query("SELECT * FROM public.engagement_mandate_events ORDER BY engagement_id, sequence_no")).rows;
  const foldBefore = JSON.stringify(await fold(user(U.owner), E2026));

  group("Apply");
  await check(`${MIGRATION} applies on the database with history`, async () => { await applyMigration(admin, MIGRATION); return true; });
  await check("every row of every table (public and auth) is byte-identical after the upgrade", async () => {
    const d = diff(before, await snapshot());
    return d.length === 0 ? true : d;
  });

  group("Direct RPC refusal — open_engagement_with_scope (atomic)");
  for (const cap of WITHHELD) {
    await check(`opening a workspace with ${cap} is refused (PT422 SERVICE_NOT_AVAILABLE) and leaves nothing behind`, async () => {
      const s0 = await snapshot();
      let err = null;
      try { await openScope(user(U.owner), A, 2027, ["FINANCIAL_STATEMENTS", cap]); } catch (e) { err = e; }
      const d = diff(s0, await snapshot());
      return isWithheld(err) && d.length === 0 ? true : { code: err?.code, msg: err?.message, changed: d };
    });
  }
  await check("Financial statements (Prepare and Reconcile) still opens a workspace (A 2027)", async () => {
    const r = await openScope(user(U.owner), A, 2027, ["FINANCIAL_STATEMENTS"]);
    return r.created === true && JSON.stringify(r.granted) === JSON.stringify(["FINANCIAL_STATEMENTS"]);
  });

  group("Direct RPC refusal — grant_engagement_capability");
  const E2027 = (await admin.query("SELECT g.id FROM public.engagements g JOIN public.fiscal_periods p ON p.id=g.fiscal_period_id WHERE g.company_id=$1 AND p.fiscal_year_end='2027-12-31'", [A])).rows[0].id;
  const eventsBeforeGrants = await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id = ANY($1)", [[E2027, E2024]]);
  for (const cap of WITHHELD) await refusedWithheld(`granting ${cap} on an existing engagement is refused`, () => grant(user(U.owner), E2027, cap));
  await refusedWithheld("a withdrawn Tax grant (A 2024) cannot be granted again", () => grant(user(U.owner), E2024, "TAX_COMPUTATION"));
  await check("the refused grants wrote no event", async () => (await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id = ANY($1)", [[E2027, E2024]])) === eventsBeforeGrants);
  await check("FINANCIAL_STATEMENTS stays grantable through grant_engagement_capability (revoked, then granted again, on A 2027)", async () => {
    await q(user(U.owner), "SELECT public.revoke_engagement_capability($1,'FINANCIAL_STATEMENTS','scope check')", [E2027]);
    await grant(user(U.owner), E2027, "FINANCIAL_STATEMENTS");
    return (await fold(user(U.owner), E2027)).some((r) => r.capability === "FINANCIAL_STATEMENTS" && r.granted === true);
  });

  group("Monitoring — existing grants preserved; new grants refused; REVOKE allowed; no re-grant");
  await check("existing Monitoring grants (A 2026 mixed, A 2023 Monitoring-only) are readable and still granted", async () =>
    (await fold(user(U.owner), E2026)).some((r) => r.capability === "MONITORING" && r.granted === true)
    && JSON.stringify(await fold(user(U.partner), EMON)) === JSON.stringify([{ capability: "MONITORING", granted: true }]));
  await refusedWithheld("a new Monitoring workspace (A 2028) is refused", () => openScope(user(U.owner), A, 2028, ["MONITORING"]));
  await refusedWithheld("adding Monitoring to an engagement without it (A 2027) is refused", () => grant(user(U.owner), E2027, "MONITORING"));
  await check("REVOKE of an existing Monitoring grant is allowed (A 2026) and appends exactly one REVOKE event", async () => {
    const n0 = await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id=$1", [E2026]);
    await q(user(U.owner), "SELECT public.revoke_engagement_capability($1,'MONITORING','withheld from customers')", [E2026]);
    const last = (await admin.query("SELECT action, capability FROM public.engagement_mandate_events WHERE engagement_id=$1 ORDER BY sequence_no DESC LIMIT 1", [E2026])).rows[0];
    return (await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id=$1", [E2026])) === n0 + 1 && last.action === "REVOKE" && last.capability === "MONITORING";
  });
  await refusedWithheld("…and once revoked, Monitoring cannot be granted again (A 2026)", () => grant(user(U.owner), E2026, "MONITORING"));

  group("Role boundaries");
  await refused("anonymous cannot call open_engagement_with_scope (42501)", "42501", () => openScope(ANON, A, 2030, ["TAX_COMPUTATION"]));
  await refused("anonymous cannot call grant_engagement_capability (42501)", "42501", () => grant(ANON, E2027, "TAX_COMPUTATION"));
  await check("anonymous cannot write the mandate table directly", async () => {
    try { await q(ANON, "INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) SELECT $1,'TAX_COMPUTATION','GRANT',99,fm.id FROM public.firm_members fm LIMIT 1", [E2027]); return "no error"; }
    catch (e) { return e.code === "42501" || isWithheld(e) ? true : e.code; }
  });
  await check("an authenticated owner cannot write the mandate table directly (row-level security; the trigger stands behind it)", async () => {
    const member = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.owner])).rows[0].id;
    try { await q(user(U.owner), "INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'TAX_COMPUTATION','GRANT',99,$2)", [E2027, member]); return "no error"; }
    catch (e) { return e.code === "42501" || isWithheld(e) ? true : e.code; }
  });
  const member = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.owner])).rows[0].id;
  for (const cap of WITHHELD) {
    await refusedWithheld(`service_role (bypasses RLS) is refused by the trigger itself: direct GRANT of ${cap}`, () =>
      q(SERVICE, "INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,$2,'GRANT',99,$3)", [E2027, cap, member]));
  }
  await refusedWithheld("the table owner (superuser session) is refused too", () =>
    admin.query("INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'FILING_PREPARATION','GRANT',99,$2)", [E2027, member]));
  await check("REVOKE and a FINANCIAL_STATEMENTS grant are not affected by the trigger (service_role direct write)", async () => {
    await q(SERVICE, "INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'FINANCIAL_STATEMENTS','REVOKE',public.next_engagement_sequence($1),$2)", [E2027, member]);
    await q(SERVICE, "INSERT INTO public.engagement_mandate_events (engagement_id,capability,action,sequence_no,actor_member_id) VALUES ($1,'FINANCIAL_STATEMENTS','GRANT',public.next_engagement_sequence($1),$2)", [E2027, member]);
    return true;
  });
  await check("the trigger function is executable by no client role", async () => {
    const r = (await admin.query(`SELECT has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') b, has_function_privilege('service_role', p.oid, 'EXECUTE') c
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refuse_withheld_service_grant'`)).rows;
    return r.length === 1 && !r[0].a && !r[0].b && !r[0].c;
  });
  await check("the trigger function pins its search_path and is not SECURITY DEFINER", async () => {
    const r = (await admin.query("SELECT p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='refuse_withheld_service_grant'")).rows[0];
    return r.prosecdef === false && (r.proconfig ?? []).some((c) => c.startsWith("search_path="));
  });

  group("Replay");
  await check("the same refused request, sent again, is refused again and writes nothing", async () => {
    const s0 = await snapshot();
    const codes = [];
    for (let i = 0; i < 3; i++) { try { await openScope(user(U.owner), A, 2031, ["TAX_COMPUTATION"]); codes.push("ok"); } catch (e) { codes.push(isWithheld(e) ? "withheld" : e.code); } }
    return codes.every((c) => c === "withheld") && diff(s0, await snapshot()).length === 0 ? true : codes;
  });
  await check("replaying the historical set on A 2025 (Tax-only) creates nothing new and reports the existing grant", async () => {
    const s0 = await snapshot();
    const r = await openScope(user(U.owner), A, 2025, ["TAX_COMPUTATION"]);
    return r.created === false && r.engagementId === ETAX && JSON.stringify(r.granted) === JSON.stringify(["TAX_COMPUTATION"]) && diff(s0, await snapshot()).length === 0 ? true : r;
  });

  group(`Concurrency — ${CONCURRENCY} simultaneous requests, separate connections and transactions`);
  await check(`${CONCURRENCY} concurrent opens naming a withheld service are ALL refused; no period, engagement or event for that year`, async () => {
    const s0 = await snapshot();
    const out = await Promise.allSettled(Array.from({ length: CONCURRENCY }, (_, i) => openScope(user(i % 2 ? U.partner : U.owner), A, 2032, ["FINANCIAL_STATEMENTS", WITHHELD[i % WITHHELD.length]])));
    return out.every((o) => o.status === "rejected" && isWithheld(o.reason)) && diff(s0, await snapshot()).length === 0;
  });
  await check(`${CONCURRENCY} concurrent grants of withheld services on one engagement are ALL refused; its history is unchanged`, async () => {
    const n0 = await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id=$1", [E2027]);
    const out = await Promise.allSettled(Array.from({ length: CONCURRENCY }, (_, i) => grant(user(i % 2 ? U.partner : U.owner), E2027, WITHHELD[i % WITHHELD.length])));
    return out.every((o) => o.status === "rejected" && isWithheld(o.reason)) && (await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id=$1", [E2027])) === n0;
  });
  await check(`${CONCURRENCY} concurrent allowed opens (A 2033) still converge on ONE engagement with one grant per service`, async () => {
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => openScope(user(i % 2 ? U.partner : U.owner), A, 2033, ["FINANCIAL_STATEMENTS"])));
    const id = out[0].engagementId;
    return out.every((o) => o.engagementId === id) && out.filter((o) => o.created).length === 1
      && (await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id=$1", [id])) === 1;
  });
  await check(`${CONCURRENCY} concurrent mixed requests on company B (no jurisdiction): withheld ones refused, the rest converge`, async () => {
    const out = await Promise.allSettled(Array.from({ length: CONCURRENCY }, (_, i) => openScope(user(U.ownerB), B, 2026, i % 2 ? ["FINANCIAL_STATEMENTS"] : ["FINANCIAL_STATEMENTS", i % 4 ? "MONITORING" : "TAX_COMPUTATION"])));
    const ok = out.filter((o) => o.status === "fulfilled");
    const bad = out.filter((o) => o.status === "rejected");
    // Monitoring is refused SERVICE_NOT_AVAILABLE; with no jurisdiction, Tax is refused JURISDICTION_REQUIRED first (both PT422).
    return ok.length > 0 && bad.every((o) => o.reason?.code === "PT422") && new Set(ok.map((o) => o.value.engagementId)).size === 1
      && (await count("SELECT count(*) n FROM public.engagement_mandate_events e JOIN public.engagements g ON g.id=e.engagement_id WHERE g.company_id=$1 AND e.capability = ANY($2)", [B, WITHHELD])) === 0;
  });

  group("Historical grants remain readable and unchanged");
  await check("every historical mandate event is byte-identical", async () => {
    const now = (await admin.query("SELECT * FROM public.engagement_mandate_events WHERE id = ANY($1) ORDER BY engagement_id, sequence_no", [historicalEvents.map((e) => e.id)])).rows;
    return JSON.stringify(now) === JSON.stringify(historicalEvents);
  });
  await check("fold_engagement_mandate on A 2026 reports every historical grant as before — Monitoring now withdrawn by the explicit REVOKE above", async () => {
    const now = await fold(user(U.owner), E2026);
    const was = JSON.parse(foldBefore).map((r) => (r.capability === "MONITORING" ? { ...r, granted: false } : r));
    return JSON.stringify(now) === JSON.stringify(was) && now.filter((r) => r.granted).length === 4;
  });
  await check("the Tax-only engagement (A 2025) still folds to Tax granted, readable by its member", async () =>
    JSON.stringify(await fold(user(U.partner), ETAX)) === JSON.stringify([{ capability: "TAX_COMPUTATION", granted: true }]));
  await check("accounting data is unchanged: trial balance uploads, tax computations, account mappings and closing balances are byte-identical", async () => {
    const now = await snapshot();
    const tables = ["public.trial_balance_uploads", "public.tax_computations", "public.account_mappings", "public.period_closing_balances"];
    const changed = tables.filter((t) => now[t] !== before[t]);
    return changed.length === 0 && Number(now["public.tax_computations"].split(":")[0]) === 1 ? true : changed;
  });

  group("Re-apply");
  await check("applying the migration again changes no row and leaves exactly one trigger", async () => {
    const s0 = await snapshot();
    await applyMigration(admin, MIGRATION);
    const n = Number((await admin.query("SELECT count(*) n FROM pg_trigger WHERE tgname='trg_refuse_withheld_service_grant' AND NOT tgisinternal")).rows[0].n);
    return diff(s0, await snapshot()).length === 0 && n === 1;
  });
  await refusedWithheld("after re-application the refusal still holds", () => grant(user(U.owner), E2027, "TAX_COMPUTATION"));

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
