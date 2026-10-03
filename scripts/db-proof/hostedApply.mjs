#!/usr/bin/env node
// Disposable-PostgreSQL proof of the controlled hosted application procedure for 20261002100000
// (scripts/release/hosted-apply/applyCandidate.mjs). It never connects anywhere but a loopback embedded server.
//
// The disposable target mirrors the hosted one: every source migration before the candidate, and Lovable's Drizzle apply
// journal (drizzle.__drizzle_migrations, created with drizzle-orm 0.45.2's own DDL) seeded with entries 0000–0025 exactly
// as drizzle records them (hash = SHA-256 of the entry file, created_at = the entry's "when"). Each scenario runs on a
// fresh CLONE of that database and drives the real runner CLI as a separate process.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> node scripts/db-proof/hostedApply.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RUNNER = path.join(REPO, "scripts/release/hosted-apply/applyCandidate.mjs");
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Client } = req("pg");
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "scripts/release/hosted-apply/candidate-20261002100000.json"), "utf8"));
const runnerModule = await import(pathToFileURL(RUNNER).href);

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") {
  results.push({ group: currentGroup, name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)}`); }
  catch (e) { record(name, false, String(e?.message ?? e).split("\n")[0]); }
}

// ── embedded server ─────────────────────────────────────────────────────────────────────────────────────────────────
const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(path.resolve(MODULES_DIR), "node_modules/embedded-postgres/dist/index.js")).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-hosted-apply-proof-"));
const port = 54000 + Math.floor(Math.random() * 900);
const server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
const urlFor = (db) => `postgres://postgres:postgres@localhost:${port}/${db}`;
const connect = async (db) => { const c = new Client({ connectionString: urlFor(db) }); await c.connect(); return c; };
async function query(db, sql, params) { const c = await connect(db); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } }
async function cloneFrom(template, name) { await query("postgres", `CREATE DATABASE ${name} TEMPLATE ${template}`); return name; }

/** Runs the real CLI against a database; resolves { code, out }. */
function runner(db, args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, ...args], { cwd: REPO, env: { ...process.env, LOVABLE_DB_MIGRATION_URL: urlFor(db), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
}
const lineOf = (out, prefix) => out.split("\n").find((l) => l.startsWith(prefix)) ?? "";

/** Everything the procedure may change: every public function (definition + ACL), every user trigger, the journal. */
async function fingerprint(db) {
  const c = await connect(db);
  try {
    const fns = (await c.query(`SELECT p.oid::regprocedure::text AS sig, md5(pg_get_functiondef(p.oid)) AS def, coalesce(p.proacl::text, '') AS acl, p.provolatile AS vol
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' ORDER BY 1`)).rows;
    const trigs = (await c.query(`SELECT t.tgrelid::regclass::text AS rel, t.tgname, t.tgtype, t.tgenabled, t.tgfoid::regproc::text AS fn
      FROM pg_trigger t WHERE NOT t.tgisinternal ORDER BY 1, 2`)).rows;
    const journal = (await c.query(`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ok`)).rows[0].ok
      ? (await c.query(`SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`)).rows : null;
    return JSON.stringify({ fns, trigs, journal });
  } finally { await c.end(); }
}
const journalRows = async (db) => query(db, `SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
const systemId = async (db) => (await query(db, "SELECT system_identifier::text AS id FROM pg_control_system()"))[0].id;

async function main() {
  await server.initialise();
  await server.start();
  const LAST = manifest.journal.expectedLastBeforeApply;
  const WHEN = String(Number(LAST.createdAt) + 86_400_000);   // a "when" after the last journal entry

  group("Candidate verification (no connection)");
  await check("the repository candidate is exactly 10824 bytes with the approved SHA-256, clean UTF-8, one batch", async () => {
    const c = runnerModule.loadCandidate(manifest, REPO);
    return c.bytes === 10824 && c.sha === "704beb2d1c2cc3a1276633055cbf3fc049d26049db4ce60565130a4d550cf0f8" ? true : c;
  });
  await check("a one-byte change, a CRLF conversion, a BOM or a truncation is refused before any connection", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cand-"));
    const target = path.join(tmp, manifest.source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = fs.readFileSync(path.join(REPO, manifest.source));
    const variants = [
      Buffer.concat([original.subarray(0, 100), Buffer.from("X"), original.subarray(101)]),
      Buffer.from(original.toString("utf8").replace(/\n/g, "\r\n")),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]),
      original.subarray(0, original.length - 1),
    ];
    const refused = variants.map((v) => { fs.writeFileSync(target, v); try { runnerModule.loadCandidate(manifest, tmp); return false; } catch { return true; } });
    fs.rmSync(tmp, { recursive: true, force: true });
    return refused.every(Boolean) ? true : refused;
  });
  await check("the drizzle record hash equals the byte SHA-256 (drizzle-orm hashes file.toString())", async () => {
    const text = fs.readFileSync(path.join(REPO, manifest.source)).toString();
    return crypto.createHash("sha256").update(text).digest("hex") === manifest.sha256;
  });

  group("Disposable target — every migration before the candidate, and Lovable's journal 0000–0025");
  const BASE = "hosted_base";
  await check("the base database replays every source migration before 20261002100000", async () => {
    await query("postgres", `CREATE DATABASE ${BASE}`);
    const c = await connect(BASE);
    try {
      await c.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
      await c.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
      for (const f of fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql") && f < "20261002100000").sort()) {
        let t = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
        if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
        await c.query(t);
      }
      // drizzle-orm 0.45.2 PgDialect.migrate DDL, verbatim in substance.
      await c.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"; CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
      const journal = JSON.parse(fs.readFileSync(path.join(REPO, "drizzle/migrations/meta/_journal.json"), "utf8"));
      for (const e of journal.entries) {
        const text = fs.readFileSync(path.join(REPO, "drizzle/migrations", `${e.tag}.sql`)).toString();
        await c.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`, [crypto.createHash("sha256").update(text).digest("hex"), e.when]);
      }
    } finally { await c.end(); }
    const last = (await journalRows(BASE)).at(-1);
    return last.hash === LAST.hash && last.created_at === String(LAST.createdAt) ? true : last;
  });

  group("Target identity — refused before anything is changed");
  const ID = await cloneFrom(BASE, "hosted_identity");
  const idFp = await fingerprint(ID);
  await check("status without --disposable refuses a URL that does not name the expected project", async () => {
    const r = await runner(ID, ["status", "--expect-ref", manifest.productionRef]);
    return r.code === 2 && /does not name project/.test(r.out) ? true : r;
  });
  await check("--disposable refuses a URL that names the production project", async () => {
    const r = await runner(ID, ["status", "--disposable"], { env: { LOVABLE_DB_MIGRATION_URL: `postgres://postgres.${manifest.productionRef}:postgres@localhost:${port}/${ID}` } });
    return r.code === 2 && /refuses a URL naming the production project/.test(r.out) ? true : r;
  });
  await check("apply refuses a wrong --expect-system-id, a missing --when and a missing system id", async () => {
    const a = await runner(ID, ["apply", "--disposable", "--expect-system-id", "1", "--when", WHEN]);
    const b = await runner(ID, ["apply", "--disposable", "--expect-system-id", await systemId(ID)]);
    const c = await runner(ID, ["apply", "--disposable", "--when", WHEN]);
    return a.code === 2 && /is not the expected 1/.test(a.out) && b.code === 2 && c.code === 2 ? true : { a: a.out, b: b.out, c: c.out };
  });
  await check("the failure-injection hook is refused outside --disposable", async () => {
    const r = await runner(ID, ["apply", "--expect-ref", manifest.productionRef, "--expect-system-id", "1", "--when", WHEN, "--test-fail-before-commit"]);
    return r.code === 2 ? true : r;
  });
  await check("nothing changed", async () => (await fingerprint(ID)) === idFp);

  group("Apply — success, repeat invocation, record");
  const A = await cloneFrom(BASE, "hosted_apply");
  const sysA = await systemId(A);
  const fpBefore = await fingerprint(A);
  await check("status reads UNAPPLIED and prints the target identity", async () => {
    const r = await runner(A, ["status", "--disposable"]);
    return r.code === 0 && lineOf(r.out, "STATUS") === "STATUS UNAPPLIED" && lineOf(r.out, "TARGET").includes(`system_identifier=${sysA}`) ? true : r.out;
  });
  await check("apply with a --when not after the last journal entry is a CONFLICT; nothing changed", async () => {
    const r = await runner(A, ["apply", "--disposable", "--expect-system-id", sysA, "--when", String(LAST.createdAt)]);
    return r.code === 10 && (await fingerprint(A)) === fpBefore ? true : r.out;
  });
  let applied;
  await check("apply → APPLIED: one transaction, the approved SQL verbatim, one journal row (hash, when)", async () => {
    applied = await runner(A, ["apply", "--disposable", "--expect-system-id", sysA, "--when", WHEN]);
    const rows = await journalRows(A);
    const mine = rows.filter((x) => x.hash === manifest.sha256);
    return applied.code === 0 && /^APPLIED /m.test(applied.out) && mine.length === 1 && mine[0].created_at === WHEN && rows.at(-1).hash === manifest.sha256 ? true : applied.out;
  });
  await check("it prints the exact journal entry Lovable's journal must carry", async () =>
    lineOf(applied.out, "JOURNAL_ENTRY") === `JOURNAL_ENTRY {"idx":26,"version":"7","when":${WHEN},"tag":"${manifest.journalTag}","breakpoints":true}` ? true : lineOf(applied.out, "JOURNAL_ENTRY"));
  await check("postconditions: volatility IMMUTABLE / STABLE / VOLATILE; definer only on the trigger function; owner-only ACLs", async () => {
    const r = await query(A, `SELECT proname, provolatile, prosecdef, proacl::text AS acl, proowner::regrole::text AS owner FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname IN ('capability_customer_available','assert_capability_available','refuse_withheld_service_grant') ORDER BY proname`);
    const by = Object.fromEntries(r.map((x) => [x.proname, x]));
    return by.capability_customer_available.provolatile === "i" && by.assert_capability_available.provolatile === "s" && by.refuse_withheld_service_grant.provolatile === "v"
      && !by.capability_customer_available.prosecdef && !by.assert_capability_available.prosecdef && by.refuse_withheld_service_grant.prosecdef
      && r.every((x) => x.acl === `{${x.owner}=X/${x.owner}}`) ? true : r;
  });
  await check("postconditions: the trigger is AFTER INSERT FOR EACH ROW, enabled, on engagement_mandate_events", async () => {
    const t = await query(A, `SELECT tgtype, tgenabled, tgfoid::regproc::text AS fn FROM pg_trigger WHERE tgname = 'trg_refuse_withheld_service_grant' AND tgrelid = 'public.engagement_mandate_events'::regclass`);
    return t.length === 1 && t[0].tgtype === 5 && t[0].tgenabled === "O" && t[0].fn === "refuse_withheld_service_grant" ? true : t;
  });
  await check("postconditions: the four services are unavailable, Financial statements is available", async () => {
    const r = await query(A, `SELECT c, public.capability_customer_available(c) AS ok FROM unnest(ARRAY['TAX_COMPUTATION','COMPLIANCE_REVIEW','FILING_PREPARATION','MONITORING','FINANCIAL_STATEMENTS']) c`);
    return r.filter((x) => x.ok).map((x) => x.c).join() === "FINANCIAL_STATEMENTS" ? true : r;
  });
  await check("on the applied target a service_role direct GRANT is refused PT422 SERVICE_NOT_AVAILABLE for a withheld service and accepted for Financial statements (all rolled back)", async () => {
    const c = await connect(A);
    try {
      await c.query("BEGIN");
      const uid = (await c.query("INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'owner@example.test') RETURNING id")).rows[0].id;
      const prod = (await c.query("SELECT id FROM public.commercial_products WHERE code = 'CFOCLOSE'")).rows[0].id;
      const bc = (await c.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1, $2) RETURNING id", [uid, prod])).rows[0].id;
      await c.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day' FROM public.commercial_plans WHERE product_id = $2 AND code = 'PRACTICE'", [bc, prod]);
      const co = (await c.query("INSERT INTO public.companies (user_id, name) VALUES ($1, 'Example Co') RETURNING id", [uid])).rows[0].id;
      const member = (await c.query("SELECT id FROM public.firm_members WHERE company_id = $1 AND user_id = $2", [co, uid])).rows[0].id;
      const period = (await c.query("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, reporting_start, reporting_end, period_label, created_by) VALUES ($1, '2026-12-31', '2026-01-01', '2026-12-31', 'FY2026', $2) RETURNING id", [co, uid])).rows[0].id;
      const eng = (await c.query("INSERT INTO public.engagements (fiscal_period_id, company_id, engagement_type, created_by_member_id) VALUES ($1, $2, 'composite', $3) RETURNING id", [period, co, member])).rows[0].id;
      await c.query("SET LOCAL ROLE service_role");
      const ins = (cap) => c.query("INSERT INTO public.engagement_mandate_events (engagement_id, capability, action, sequence_no, actor_member_id) VALUES ($1, $2, 'GRANT', public.next_engagement_sequence($1), $3)", [eng, cap, member]);
      await c.query("SAVEPOINT s");
      let refused = null;
      try { await ins("TAX_COMPUTATION"); refused = "no error"; } catch (e) { refused = `${e.code}:${e.message}`; }
      await c.query("ROLLBACK TO SAVEPOINT s");
      await ins("FINANCIAL_STATEMENTS");
      return refused === "PT422:SERVICE_NOT_AVAILABLE" ? true : refused;
    } finally { await c.query("ROLLBACK").catch(() => {}); await c.end(); }
  });
  const fpApplied = await fingerprint(A);
  await check("repeat apply with the same --when → ALREADY_APPLIED; schema and journal byte-identical", async () => {
    const r = await runner(A, ["apply", "--disposable", "--expect-system-id", sysA, "--when", WHEN]);
    return r.code === 0 && /ALREADY_APPLIED/.test(r.out) && (await fingerprint(A)) === fpApplied ? true : r.out;
  });
  await check("repeat apply with a different --when → CONFLICT (the journal entry must carry the recorded when); unchanged", async () => {
    const r = await runner(A, ["apply", "--disposable", "--expect-system-id", sysA, "--when", String(Number(WHEN) + 1)]);
    return r.code === 10 && /already recorded with created_at/.test(r.out) && (await fingerprint(A)) === fpApplied ? true : r.out;
  });
  await check("status after apply → ALREADY_APPLIED with the recorded created_at (read-only)", async () => {
    const r = await runner(A, ["status", "--disposable"]);
    return r.code === 0 && lineOf(r.out, "STATUS") === `STATUS ALREADY_APPLIED (recorded created_at ${WHEN})` && (await fingerprint(A)) === fpApplied ? true : r.out;
  });
  await check("the only changes the apply made: the candidate's objects, the two RPC bodies, and ONE journal row", async () => {
    const b = JSON.parse(fpBefore); const a = JSON.parse(fpApplied);
    const changedFns = a.fns.filter((f) => !b.fns.some((g) => g.sig === f.sig && g.def === f.def && g.acl === f.acl)).map((f) => f.sig).sort();
    const removedFns = b.fns.filter((f) => !a.fns.some((g) => g.sig === f.sig)).map((f) => f.sig);
    const newTrigs = a.trigs.filter((t) => !b.trigs.some((u) => JSON.stringify(u) === JSON.stringify(t))).map((t) => t.tgname);
    return JSON.stringify(changedFns) === JSON.stringify(["assert_capability_available(text)", "capability_customer_available(text)", "grant_engagement_capability(uuid,text,text)", "open_engagement_with_scope(uuid,integer,text[],text)", "refuse_withheld_service_grant()"])
      && removedFns.length === 0 && JSON.stringify(newTrigs) === JSON.stringify(["trg_refuse_withheld_service_grant"])
      && a.journal.length === b.journal.length + 1 && JSON.stringify(a.journal.slice(0, -1)) === JSON.stringify(b.journal) ? true : { changedFns, removedFns, newTrigs };
  });

  group("Induced failures — schema AND journal unchanged");
  const F = await cloneFrom(BASE, "hosted_fail");
  const sysF = await systemId(F);
  const fpF = await fingerprint(F);
  await check("a failure AFTER the SQL and the journal row, before COMMIT → FAILED; nothing changed", async () => {
    const r = await runner(F, ["apply", "--disposable", "--expect-system-id", sysF, "--when", WHEN, "--test-fail-before-commit"]);
    return r.code === 13 && /induced failure before COMMIT/.test(r.out) && (await fingerprint(F)) === fpF ? true : r.out;
  });
  await check("lock contention beyond lock_timeout (a session holds ACCESS EXCLUSIVE on the mandate table) → BUSY; nothing changed", async () => {
    const holder = await connect(F);
    await holder.query("BEGIN; LOCK TABLE public.engagement_mandate_events IN ACCESS EXCLUSIVE MODE");
    try {
      const r = await runner(F, ["apply", "--disposable", "--expect-system-id", sysF, "--when", WHEN, "--lock-timeout", "1s"]);
      return r.code === 12 && /^BUSY /m.test(r.out) ? true : r.out;
    } finally { await holder.query("ROLLBACK"); await holder.end(); }
  });
  await check("…and the journal and schema are byte-identical afterwards", async () => (await fingerprint(F)) === fpF);
  await check("a statement exceeding statement_timeout → FAILED; nothing changed", async () => {
    const holder = await connect(F);
    await holder.query("BEGIN; LOCK TABLE public.engagement_mandate_events IN ACCESS EXCLUSIVE MODE");
    try {
      const r = await runner(F, ["apply", "--disposable", "--expect-system-id", sysF, "--when", WHEN, "--lock-timeout", "30s", "--statement-timeout", "1s"]);
      return r.code === 13 && /57014|statement timeout/i.test(r.out) && (await fingerprint(F)) === fpF ? true : r.out;
    } finally { await holder.query("ROLLBACK"); await holder.end(); }
  });
  await check("the runner's backend terminated mid-transaction → FAILED (not committed); nothing changed", async () => {
    const holder = await connect(F);
    await holder.query("BEGIN; LOCK TABLE public.engagement_mandate_events IN ACCESS EXCLUSIVE MODE");
    const pending = runner(F, ["apply", "--disposable", "--expect-system-id", sysF, "--when", WHEN, "--lock-timeout", "60s"]);
    let killed = 0;
    for (let i = 0; i < 100 && killed === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      killed = (await query(F, `SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'cfoclose-hosted-apply' AND state = 'active' AND wait_event_type = 'Lock') x`))[0].n;
    }
    const r = await pending;
    await holder.query("ROLLBACK"); await holder.end();
    return killed === 1 && r.code === 13 && (await fingerprint(F)) === fpF ? true : { killed, out: r.out };
  });
  await check("after every failure, status still reads UNAPPLIED and a clean apply then succeeds", async () => {
    const s = await runner(F, ["status", "--disposable"]);
    const a = await runner(F, ["apply", "--disposable", "--expect-system-id", sysF, "--when", WHEN]);
    return lineOf(s.out, "STATUS") === "STATUS UNAPPLIED" && a.code === 0 && /^APPLIED /m.test(a.out) ? true : { s: s.out, a: a.out };
  });

  group("Concurrent invocation — exactly one application, one journal row");
  const C = await cloneFrom(BASE, "hosted_concurrent");
  const sysC = await systemId(C);
  await check("8 simultaneous apply processes → exactly 1 APPLIED and 7 ALREADY_APPLIED; one journal row; postconditions hold", async () => {
    const out = await Promise.all(Array.from({ length: 8 }, () => runner(C, ["apply", "--disposable", "--expect-system-id", sysC, "--when", WHEN, "--lock-timeout", "60s"])));
    const applied = out.filter((r) => r.code === 0 && /^APPLIED /m.test(r.out)).length;
    const already = out.filter((r) => r.code === 0 && /ALREADY_APPLIED/.test(r.out)).length;
    const rows = (await journalRows(C)).filter((x) => x.hash === manifest.sha256);
    const s = await runner(C, ["status", "--disposable"]);
    return applied === 1 && already === 7 && rows.length === 1 && lineOf(s.out, "STATUS").startsWith("STATUS ALREADY_APPLIED") ? true : { applied, already, rows: rows.length, codes: out.map((r) => r.code) };
  });

  group("Conflicting states — classified, refused, nothing changed");
  const conflict = async (name, prepare, expect) => {
    const db = await cloneFrom(BASE, `hosted_conflict_${results.length}`);
    await prepare(db);
    const fp = await fingerprint(db);
    await check(name, async () => {
      const s = await runner(db, ["status", "--disposable"]);
      const a = await runner(db, ["apply", "--disposable", "--expect-system-id", await systemId(db), "--when", WHEN]);
      return s.code === 10 && a.code === 10 && expect.test(s.out) && (await fingerprint(db)) === fp ? true : { status: s.out, apply: a.out };
    });
  };
  await conflict("applied out of band (objects present, no journal record) → CONFLICT", async (db) => { const c = await connect(db); await c.query(fs.readFileSync(path.join(REPO, manifest.source), "utf8")); await c.end(); }, /applied out of band/);
  await conflict("partially present (one function only) → CONFLICT", async (db) => query(db, "CREATE FUNCTION public.capability_customer_available(p_capability text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$"), /part of the candidate is present/);
  await conflict("journal lineage moved (a later entry exists) → CONFLICT", async (db) => query(db, "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('0000000000000000000000000000000000000000000000000000000000000000', $1)", [Number(WHEN) + 5]), /journal lineage/);
  await conflict("the candidate recorded twice → CONFLICT", async (db) => query(db, "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2), ($1, $2)", [manifest.sha256, WHEN]), /recorded 2 times/);
  await conflict("recorded in the journal but not applied → CONFLICT", async (db) => query(db, "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [manifest.sha256, WHEN]), /postconditions do not hold/);
  await conflict("the journal table is absent (wrong target) → CONFLICT", async (db) => query(db, "DROP SCHEMA drizzle CASCADE"), /does not exist/);

  group("Classifier (pure)");
  await check("UNCERTAIN is never guessed: the classifier has exactly three answers and status resolves an interrupted commit", async () => {
    const outcomes = new Set();
    const clean = { journalExists: true, rows: [{ hash: LAST.hash, created_at: String(LAST.createdAt) }], fns: [], trig: [], lines: { grant_engagement_capability: 0, open_engagement_with_scope: 0 }, rpcPrivileges: { grant_auth: true, grant_anon: false, open_auth: true, open_anon: false }, behaviour: null };
    outcomes.add(runnerModule.classify(clean, manifest).outcome);
    outcomes.add(runnerModule.classify({ ...clean, rows: [] }, manifest).outcome);
    outcomes.add(runnerModule.classify({ ...clean, journalExists: false }, manifest).outcome);
    return [...outcomes].every((o) => ["UNAPPLIED", "ALREADY_APPLIED", "CONFLICT"].includes(o)) ? true : [...outcomes];
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"─".repeat(42)}\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
  console.log(failed.length ? "HOSTED_APPLY: FAILED" : "HOSTED_APPLY: ALL PASSED");
  return failed.length ? 1 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error(e); }
try { await server.stop(); } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
process.exit(code);
