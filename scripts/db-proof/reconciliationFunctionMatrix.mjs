#!/usr/bin/env bun
// Old/new function × old/new schema matrix for the reconciliation release (20261004100000 + safisha-match/-resolve).
//
// Runs the REAL handlers — the versions on main before this release (byte-identical copies, verified against their git
// blob hashes in fixtures/functions-main-e8962f2/manifest.json) and the versions in this tree — against two disposable
// PostgreSQL databases: one with every migration before 20261004100000 (the old schema) and one with all of them (the
// new schema). The handlers' Supabase client is replaced by a small PostgREST-like client that executes every request
// as the caller's real database role (authenticated with the JWT subject, or service_role) under the real row-level
// security, triggers and grants; only the network edge is replaced.
//
// For every combination it drives the product flow (match a fully matched reconciliation; match one with an unmatched
// line, escalate it, have a partner approve it) and asserts the release invariant:
//   NO COMBINATION EVER RECORDS 'clean' FOR AN INCOMPLETE RECONCILIATION
// and records each combination's observable behaviour (HTTP status, stored statuses) — the evidence behind the
// deployment order.
//
//   DB_PROOF_MODULES_DIR=<dir with node_modules/pg + embedded-postgres> bun ./scripts/db-proof/reconciliationFunctionMatrix.mjs
//   (or DB_PROOF_CONN=postgres://postgres:postgres@localhost:<port>/postgres for an already-running disposable server)
//
// Synthetic users only; loopback only; refuses the production project reference; creates and drops its own databases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, loadHandler } from "./lib/functionHarness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MIGRATION = "20261004100000_reconciliation_server_authority.sql";
// The release's migrations: the old schema (production before the release) has neither; the new schema has both.
const RELEASE_MIGRATIONS = [MIGRATION, "20261005100000_safisha_ingestion_authority.sql"];
const OLD_DIR = path.join(HERE, "fixtures/functions-main-e8962f2");
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

const results = [];
function record(name, ok, detail = "") { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : JSON.stringify(r)); } catch (e) { record(name, false, String(e?.message ?? e).split("\n")[0]); }
}

// ── Disposable server and databases ─────────────────────────────────────────────────────────────────────────────────
const RUN = `${process.pid}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
let server, dir, maintenanceUrl;
const createdDbs = [];
async function startServer() {
  let url = process.env.DB_PROOF_CONN;
  if (!url) {
    const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
    const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-recon-matrix-"));
    const port = 57000 + Math.floor(Math.random() * 900);
    server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, createPostgresUser: typeof process.getuid === "function" && process.getuid() === 0, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
    await server.initialise(); await server.start();
    url = `postgres://postgres:postgres@localhost:${port}/postgres`;
  }
  const u = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || url.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a disposable local database");
  maintenanceUrl = url;
}
async function newDatabase(label) {
  const name = `recon_matrix_${label}_${RUN}`;
  const boot = new Client({ connectionString: maintenanceUrl, ssl: false }); await boot.connect();
  try { await boot.query(`CREATE DATABASE "${name}"`); createdDbs.push(name); } finally { await boot.end(); }
  const u = new URL(maintenanceUrl); u.pathname = `/${name}`; return u.toString();
}
async function stop(pools) {
  for (const p of pools) { try { await p.end(); } catch { /* */ } }
  if (createdDbs.length) {
    const boot = new Client({ connectionString: maintenanceUrl, ssl: false }); await boot.connect();
    for (const n of createdDbs) { try { await boot.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`); console.log(`  dropped ${n}`); } catch (e) { console.error(`  could not drop ${n}: ${e?.message ?? e}`); } }
    await boot.end();
  }
  try { await server?.stop(); } catch { /* */ } try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
async function migrate(url, withRelease) {
  const db = new Client({ connectionString: url, ssl: false }); await db.connect();
  try {
    await db.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
    await db.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
    const files = fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort().filter((f) => withRelease || !RELEASE_MIGRATIONS.includes(f));
    for (const f of files) {
      let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
      if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      try { await db.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
    }
    return files.length;
  } finally { await db.end(); }
}

// The handlers run through the shared harness (real role, row-level security, triggers; only the network edge replaced).
const gitBlobSha1 = (buf) => crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");

async function main() {
  console.log(`\n== Function versions`);
  const manifest = JSON.parse(fs.readFileSync(path.join(OLD_DIR, "manifest.json"), "utf8"));
  await check("the OLD handlers are byte-identical to main's (git blob hashes match the manifest)", async () => {
    const got = Object.fromEntries(Object.keys(manifest.files).map((f) => [f, gitBlobSha1(fs.readFileSync(path.join(OLD_DIR, f)))]));
    return Object.entries(manifest.files).every(([f, m]) => got[f] === m.git_blob_sha1) ? true : got;
  });
  const handlers = {
    old: { match: await loadHandler(fs.readFileSync(path.join(OLD_DIR, "match.index.ts"), "utf8"), "old-match"),
           resolve: await loadHandler(fs.readFileSync(path.join(OLD_DIR, "resolve.index.ts"), "utf8"), "old-resolve") },
    new: { match: await loadHandler(fs.readFileSync(path.join(REPO, "supabase/functions/safisha-match/index.ts"), "utf8"), "new-match"),
           resolve: await loadHandler(fs.readFileSync(path.join(REPO, "supabase/functions/safisha-resolve/index.ts"), "utf8"), "new-resolve") },
  };

  await startServer();
  const pools = [];
  try {
    const schemas = {};
    for (const [label, withRelease] of [["old", false], ["new", true]]) {
      const url = await newDatabase(label);
      const n = await migrate(url, withRelease);
      console.log(`  ${label} schema: ${n} migrations${withRelease ? "" : ` (without ${RELEASE_MIGRATIONS.join(", ")})`}`);
      const pool = new Pool({ connectionString: url, ssl: false, max: 10 }); pools.push(pool);
      schemas[label] = { pool, admin: pool };
    }

    // Synthetic workspace per schema: owner (PRACTICE plan), partner (review_close), preparer (prepare_close only).
    const seed = async (pool) => {
      const q = (sql, p = []) => pool.query(sql, p).then((r) => r.rows);
      const U = { owner: crypto.randomUUID(), partner: crypto.randomUUID(), preparer: crypto.randomUUID() };
      for (const [k, id] of Object.entries(U)) await q("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}-${RUN}@example.test`]);
      const prod = (await q("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'"))[0].id;
      const bc = (await q("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [U.owner, prod]))[0].id;
      await q("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
      const company = (await q("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Matrix Co') RETURNING id", [U.owner]))[0].id;
      await q("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'partner',now()), ($1,$3,'preparer',now())", [company, U.partner, U.preparer]);
      return { U, company, year: 2000 };
    };
    for (const s of Object.values(schemas)) s.ws = await seed(s.pool);

    /** A reconciliation as safisha-ingest leaves it: an upload, a processing reconciliation, TB rows and bank rows. */
    const ingest = async (s, { matched, unmatched }) => {
      const q = (sql, p = []) => s.pool.query(sql, p).then((r) => r.rows);
      s.ws.year += 1;
      const up = (await q("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id,safisha_status) VALUES ($1,$2,10,'complete',$3,$4,$5,'processing') RETURNING id",
        [`tb-${s.ws.year}.csv`, `workspaces/${s.ws.company}/${crypto.randomUUID()}/tb.csv`, s.ws.company, s.ws.year, s.ws.U.owner]))[0].id;
      const r = (await q("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing') RETURNING id", [s.ws.U.owner, up]))[0].id;
      for (let i = 0; i < matched; i += 1) {
        const code = String(1000 + i);
        await q("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,account_name,txn_date,debit,raw_row_hash) VALUES ($1,'tb',$2,'Cash','2025-01-31',100,$3)", [r, code, crypto.randomUUID()]);
        await q("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,account_name,txn_date,debit,raw_row_hash) VALUES ($1,'bank',$2,'Cash','2025-01-31',100,$3)", [r, code, crypto.randomUUID()]);
      }
      for (let i = 0; i < unmatched; i += 1) {
        await q("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,account_name,txn_date,debit,raw_row_hash) VALUES ($1,'tb',$2,'Suspense','2025-01-31',250,$3)", [r, String(9000 + i), crypto.randomUUID()]);
      }
      return { up, r };
    };
    const post = (handler, s, uid, body) => call(handler, s.pool, uid, body);
    const stored = async (s, f) => (await s.pool.query("SELECT u.safisha_status s, r.status r FROM public.trial_balance_uploads u JOIN public.safisha_reconciliations r ON r.tb_upload_id=u.id WHERE u.id=$1", [f.up])).rows[0];
    /** Completeness computed in the proof itself from the stored rows (schema-independent). */
    const completeFromRows = async (s, f) => {
      const tb = (await s.pool.query("SELECT id FROM public.safisha_transactions WHERE reconciliation_id=$1 AND source_id='tb'", [f.r])).rows.map((x) => x.id);
      const ex = (await s.pool.query("SELECT tb_txn_id, reviewer_action FROM public.safisha_exceptions WHERE reconciliation_id=$1", [f.r])).rows;
      if (tb.length === 0 || ex.some((e) => e.reviewer_action !== "approved")) return false;
      return true;
    };
    const exceptionsOf = async (s, f) => (await s.pool.query("SELECT id, reviewer_action FROM public.safisha_exceptions WHERE reconciliation_id=$1 ORDER BY created_at, id", [f.r])).rows;

    const matrix = [];
    for (const fn of ["old", "new"]) {
      for (const schema of ["old", "new"]) {
        const s = schemas[schema]; const H = handlers[fn]; const label = `${fn} functions × ${schema} schema`;
        console.log(`\n== ${label}`);
        const row = { combination: label };
        const invariant = async (f) => { const st = await stored(s, f); return st.s !== "clean" && st.r !== "clean" ? true : await completeFromRows(s, f); };

        // 1. A fully matched reconciliation.
        const F1 = await ingest(s, { matched: 2, unmatched: 0 });
        const m1 = await post(H.match, s, s.ws.U.owner, { reconciliation_id: F1.r });
        row.matched = { http: m1.http, reported: m1.body?.status ?? m1.body?.error ?? null, stored: await stored(s, F1) };
        await check(`${label}: fully matched — never 'clean' unless complete (http ${m1.http}, stored ${JSON.stringify(row.matched.stored)})`, () => invariant(F1));

        // 2. An unmatched line → exception → escalate (preparer) → approve (partner).
        const F2 = await ingest(s, { matched: 1, unmatched: 1 });
        const m2 = await post(H.match, s, s.ws.U.owner, { reconciliation_id: F2.r });
        row.unmatched = { http: m2.http, reported: m2.body?.status ?? m2.body?.error ?? null, stored: await stored(s, F2) };
        await check(`${label}: one unmatched line — not 'clean' (http ${m2.http}, stored ${JSON.stringify(row.unmatched.stored)})`, async () => { const st = await stored(s, F2); return st.s !== "clean" && st.r !== "clean" ? true : st; });
        const [x] = await exceptionsOf(s, F2);
        if (x) {
          const esc = await post(H.resolve, s, s.ws.U.preparer, { exception_id: x.id, action: "escalated" });
          row.escalated = { http: esc.http, stored: await stored(s, F2), decision: (await exceptionsOf(s, F2))[0].reviewer_action };
          await check(`${label}: escalated — never 'clean' (http ${esc.http}, stored ${JSON.stringify(row.escalated.stored)})`, async () => { const st = await stored(s, F2); return st.s !== "clean" && st.r !== "clean" ? true : st; });
          const app = await post(H.resolve, s, s.ws.U.partner, { exception_id: x.id, action: "approved" });
          row.partnerApproves = { http: app.http, stored: await stored(s, F2), decision: (await exceptionsOf(s, F2))[0].reviewer_action };
          await check(`${label}: after the partner's decision — 'clean' only if complete (http ${app.http}, stored ${JSON.stringify(row.partnerApproves.stored)})`, () => invariant(F2));
        } else {
          row.escalated = row.partnerApproves = "no exception was recorded";
        }
        // 3. A retry of the match (the gate's own retry after a lost response).
        const m3 = await post(H.match, s, s.ws.U.owner, { reconciliation_id: F2.r });
        row.retry = { http: m3.http, exceptions: (await exceptionsOf(s, F2)).length, stored: await stored(s, F2) };
        await check(`${label}: retry — never 'clean' unless complete (http ${m3.http}, ${row.retry.exceptions} exception row(s))`, () => invariant(F2));
        matrix.push(row);
      }
    }

    console.log("\n== Expected behaviour of the release combinations");
    const at = (c) => matrix.find((m) => m.combination === c);
    await check("new × new: matched → clean; unmatched → needs_review; escalated stays open; the partner's approval → clean; retry records nothing new", async () => {
      const m = at("new functions × new schema");
      return m.matched.http === 200 && m.matched.stored.s === "clean" && m.unmatched.stored.r === "needs_review" && m.escalated.decision === "escalated"
        && m.escalated.stored.r === "needs_review" && m.partnerApproves.http === 200 && m.partnerApproves.stored.s === "clean" && m.retry.http === 200
        && m.retry.exceptions === 1 && m.retry.stored.s === "clean" ? true : m;
    });
    await check("new × old (functions deployed before the migration): every match and decision answers 503 and records nothing", async () => {
      const m = at("new functions × old schema");
      return m.matched.http === 503 && m.matched.stored.r === "processing" && m.unmatched.http === 503 && m.unmatched.stored.r === "processing"
        && m.retry.http === 503 ? true : m;
    });
    await check("old × new (migration applied before the functions): nothing is recorded as clean; results are not recorded", async () => {
      const m = at("old functions × new schema");
      return m.matched.stored.r !== "clean" && m.matched.stored.s !== "clean" && m.unmatched.stored.r !== "clean" ? true : m;
    });
    console.log("\nMATRIX " + JSON.stringify(matrix, null, 1));
  } finally {
    await stop(pools);
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}

let code = 1;
try { code = (await main()) === 0 ? 0 : 1; } catch (e) { console.error("FATAL", e); }
process.exit(code);
