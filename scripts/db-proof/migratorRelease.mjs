#!/usr/bin/env node
// Release-application proof for 20261004100000 + 20261005100000 through the REAL native-compatible migrator: drizzle-orm's
// own migrate() (the version this repository pins), which reads the latest journal row, then applies every pending entry
// and inserts its journal row inside ONE transaction. Nothing here reimplements the migrator.
//
// A disposable PostgreSQL is brought to the production-equivalent state (every source migration through 20261002100000,
// the PR #34 release staging table from journal entries 0013/0014, and the hosted journal reproduced from
// drizzle/migrations/meta/_journal.json with drizzle's own hashes). Each variant then gets a fresh copy of that database
// and a migrations folder = this repository's drizzle/migrations plus the two candidate entries 0027 and 0028:
//
//   wrapper   the proposed plan: entries rendered EXACTLY from the reviewed verbatim_noop_main template
//             (scripts/ci/releaseJournal.mjs), bodies staged in public._pr34_migration_bodies as sandbox_exec;
//   verbatim  the latest lineage (0025/0026): each entry is the source file byte for byte.
//
// For each: single run (journal rows, full schema postconditions via both read-only verification files), retry, a
// re-application of an entry inside a migrator-style transaction (what a second migrator pass does), concurrent migrator
// runs, and an atomic payload failure. For the wrapper: staging privileges and staging edge cases.
//
//   DB_PROOF_MODULES_DIR=<dir with node_modules/pg + embedded-postgres> node scripts/db-proof/migratorRelease.mjs
//   (or DB_PROOF_CONN=postgres://postgres:postgres@localhost:<port>/postgres). drizzle-orm must resolve `pg` (CI and this
//   proof install it with `bun add --no-save pg@8`).
//
// Loopback only; refuses the production project reference; creates and drops its own databases; reads no credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TEMPLATES } from "../ci/releaseJournal.mjs";
import { RELEASE_2026_10, checkGuardedEntry, renderGuardedEntry } from "../release/guardedEntry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const SOURCES = {
  "0027": { tag: "0027_apply_20261004100000_reconciliation_server_authority", source: "20261004100000_reconciliation_server_authority.sql",
    bytes: 34236, digest: "befca97c5f8fe1a1a8f1d13ab05100facf29417de5d32ab6aa6f2eb214d3425d", verify: "reconciliationAuthorityVerify.sql" },
  "0028": { tag: "0028_apply_20261005100000_safisha_ingestion_authority", source: "20261005100000_safisha_ingestion_authority.sql",
    bytes: 28693, digest: "d814bbebeeaa541cbbe703aa3c037759e0b41882f7c64575f58ee3ed24bcc425", verify: "safishaIngestionVerify.sql" },
};
const APPROVED_HEAD = "bf86417459003490e75cc3fd33e2ad83366f5fb1";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const { drizzle } = await import("drizzle-orm/node-postgres");
const { migrate } = await import("drizzle-orm/node-postgres/migrator");
const { readMigrationFiles } = await import("drizzle-orm/migrator");

const results = [];
const findings = [];
function record(name, ok, detail = "") { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : JSON.stringify(r)); } catch (e) { record(name, false, String(e?.message ?? e).split("\n")[0]); }
}
const observe = (name, value) => { findings.push({ name, value }); console.log(`  OBSERVED  ${name}: ${JSON.stringify(value)}`); };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ── Disposable server ───────────────────────────────────────────────────────────────────────────────────────────────
const RUN = `${process.pid}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
let server, dir, maintenanceUrl;
const created = [];
async function startServer() {
  let url = process.env.DB_PROOF_CONN;
  if (!url) {
    const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
    const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-migrator-proof-"));
    const port = 57000 + Math.floor(Math.random() * 900);
    server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, createPostgresUser: typeof process.getuid === "function" && process.getuid() === 0, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
    await server.initialise(); await server.start();
    url = `postgres://postgres:postgres@localhost:${port}/postgres`;
  }
  const u = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || url.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a disposable local database");
  maintenanceUrl = url;
}
const dbUrl = (name) => { const u = new URL(maintenanceUrl); u.pathname = `/${name}`; return u.toString(); };
async function admin(sql, params) { const c = new Client({ connectionString: maintenanceUrl, ssl: false }); await c.connect(); try { return await c.query(sql, params); } finally { await c.end(); } }
async function cleanup() {
  for (const n of created.reverse()) { try { await admin(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`); } catch { /* */ } }
  try { await server?.stop(); } catch { /* */ } try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

// ── The production-equivalent base ──────────────────────────────────────────────────────────────────────────────────
const SRC_DIR = path.join(REPO, "supabase/migrations");
const DRIZZLE_DIR = path.join(REPO, "drizzle/migrations");
const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE_DIR, "meta/_journal.json"), "utf8"));
async function buildBase() {
  const name = `migrator_base_${RUN}`; await admin(`CREATE DATABASE "${name}"`); created.push(name);
  const db = new Client({ connectionString: dbUrl(name), ssl: false }); await db.connect();
  try {
    await db.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
    await db.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN CREATE ROLE sandbox_exec NOLOGIN; END IF; END $$;
      GRANT USAGE ON SCHEMA public TO sandbox_exec;`);
    const release = new Set(Object.values(SOURCES).map((s) => s.source));
    const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".sql") && !release.has(f)).sort();
    for (const f of files) {
      let t = fs.readFileSync(path.join(SRC_DIR, f), "utf8");
      if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      await db.query(t);
    }
    // The PR #34 release staging infrastructure exactly as journal entries 0013 and 0014 created it.
    await db.query(fs.readFileSync(path.join(DRIZZLE_DIR, "0013_pr34_probe_session_identity.sql"), "utf8"));
    await db.query(fs.readFileSync(path.join(DRIZZLE_DIR, "0014_pr34_release_staging_table.sql"), "utf8"));
    // The hosted journal: every existing entry, with drizzle's own hash and created_at.
    const existing = readMigrationFiles({ migrationsFolder: DRIZZLE_DIR });
    await db.query("CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)");
    for (const m of existing) await db.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)", [m.hash, m.folderMillis]);
    return { name, applied: files.length, journalRows: existing.length };
  } finally { await db.end(); }
}
async function copyOf(base, label) {
  const name = `migrator_${label}_${RUN}`; await admin(`CREATE DATABASE "${name}" TEMPLATE "${base}"`); created.push(name); return dbUrl(name);
}

// ── Candidate entries and migrations folders ────────────────────────────────────────────────────────────────────────
const sourceBytes = (s) => fs.readFileSync(path.join(SRC_DIR, s.source));
const wrapperFor = (s) => TEMPLATES.verbatim_noop_main({ name: s.source, digest: s.digest, head: APPROVED_HEAD });
const lastWhen = journal.entries[journal.entries.length - 1].when;
const WHEN = { "0027": lastWhen + 60_000, "0028": lastWhen + 120_000 };
function folderFor(label, entryText) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `migrator-${label}-`));
  fs.mkdirSync(path.join(d, "meta"));
  for (const f of fs.readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith(".sql"))) fs.copyFileSync(path.join(DRIZZLE_DIR, f), path.join(d, f));
  const j = JSON.parse(JSON.stringify(journal));
  for (const [idx, s] of Object.entries(SOURCES)) {
    fs.writeFileSync(path.join(d, `${s.tag}.sql`), entryText(s));
    j.entries.push({ idx: Number(idx), version: "7", when: WHEN[idx], tag: s.tag, breakpoints: true });
  }
  fs.writeFileSync(path.join(d, "meta/_journal.json"), JSON.stringify(j, null, 2));
  return d;
}
async function runMigrator(url, folder) {
  const pool = new Pool({ connectionString: url, ssl: false, max: 2 });
  try { await migrate(drizzle(pool), { migrationsFolder: folder }); return { ok: true }; }
  catch (e) { const c = e?.cause ?? e; return { ok: false, code: c?.code ?? null, message: String(c?.message ?? e?.message ?? e).split("\n")[0] }; }
  finally { await pool.end(); }
}
async function q(url, sql, params) { const c = new Client({ connectionString: url, ssl: false }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } }
const journalRows = async (url) => Object.fromEntries(await Promise.all(Object.entries(WHEN).map(async ([k, w]) => [k, Number((await q(url, "SELECT count(*) n FROM drizzle.__drizzle_migrations WHERE created_at = $1", [w]))[0].n)])));
async function postconditions(url) {
  const out = {};
  for (const s of Object.values(SOURCES)) {
    const c = new Client({ connectionString: url, ssl: false }); await c.connect();
    try { await c.query("BEGIN READ ONLY"); const rows = (await c.query(fs.readFileSync(path.join(REPO, "scripts/db-preflight", s.verify), "utf8"))).rows; await c.query("ROLLBACK");
      out[s.verify] = rows.filter((r) => r.ok !== true).map((r) => r.item); }
    finally { await c.end(); }
  }
  return out;
}
const allOk = (p) => Object.values(p).every((bad) => bad.length === 0);
const releaseObjectsPresent = async (url) => (await q(url, `SELECT to_regprocedure('public.safisha_record_match_result(uuid,uuid,jsonb)') IS NOT NULL a,
  to_regprocedure('public.safisha_ingest_evidence(uuid,uuid,text,text,text,jsonb,text,jsonb)') IS NOT NULL b`))[0];

/** A second migrator run that reads the journal BEFORE a first run commits and executes AFTER it — the window drizzle's
 *  migrate() leaves open (it reads the latest journal row outside its transaction, with no lock). Only the scheduling is
 *  controlled: the second run's transaction connection waits until the first run has finished. */
async function staggered(url, folder) {
  let release; const gate = new Promise((r) => { release = r; });
  let reached; const atGate = new Promise((r) => { reached = r; });
  const pool2 = new Pool({ connectionString: url, ssl: false, max: 2 });
  const connect = pool2.connect.bind(pool2);
  pool2.connect = (...args) => { if (args.length) return connect(...args); reached(); return gate.then(() => connect()); };
  const second = migrate(drizzle(pool2), { migrationsFolder: folder }).then(() => ({ ok: true }), (e) => ({ ok: false, code: (e?.cause ?? e)?.code ?? null }));
  await atGate;
  const first = await runMigrator(url, folder);
  release();
  const r2 = await second; await pool2.end();
  return { first, second: r2 };
}
/** Executes an entry once more exactly as migrate() would: the entry SQL then its journal INSERT, in one transaction. */
async function reapply(url, sql, hash, when) {
  const c = new Client({ connectionString: url, ssl: false }); await c.connect();
  try { await c.query("BEGIN"); await c.query(sql); await c.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)", [hash, when]); await c.query("COMMIT"); return "committed"; }
  catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } return e.code; } finally { await c.end(); }
}
async function asRole(url, role, sql, params) {
  const c = new Client({ connectionString: url, ssl: false }); await c.connect();
  try { await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`); const r = await c.query(sql, params); await c.query("COMMIT"); return `ok:${r.rowCount}`; }
  catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } return e.code; } finally { await c.end(); }
}
const outcomes = (rs) => rs.map((r) => (r.ok ? "ok" : r.code));

async function main() {
  console.log("\n== Sources and lineage");
  await check("both approved sources are byte-identical to the approved sizes and digests", () => {
    const bad = Object.values(SOURCES).filter((s) => { const b = sourceBytes(s); return b.length !== s.bytes || sha256(b) !== s.digest; });
    return bad.length === 0 ? true : bad.map((s) => s.source);
  });
  await check("the latest journal entry is 0026 (release_verbatim of 20261002100000); the candidates 0027/0028 come after it", () => {
    const last = journal.entries[journal.entries.length - 1];
    return last.idx === 26 && last.tag === "0026_apply_20261002100000_refuse_withheld_service_grants" && WHEN["0027"] > last.when ? true : last;
  });
  await check("the committed candidate entries are exactly the guarded rendering of the approved sources", () => {
    const bad = RELEASE_2026_10.entries.filter((e) => checkGuardedEntry(fs.readFileSync(path.join(REPO, "release/candidates", `${e.tag}.sql`), "utf8"),
      { source: e.source, head: RELEASE_2026_10.head, repoRoot: REPO, verify: e.verify }).length > 0);
    return bad.length === 0 ? true : bad.map((e) => e.tag);
  });

  await startServer();
  try {
    const base = await buildBase();
    console.log(`  base: ${base.applied} source migrations; hosted journal reproduced with ${base.journalRows} rows; PR #34 staging table present`);
    const stage = async (url, s, body = sourceBytes(s).toString("utf8")) =>
      q(url, "INSERT INTO public._pr34_migration_bodies (name, body, sha256_hex) VALUES ($1,$2,$3)", [s.source, body, sha256(Buffer.from(body))]);
    const stageBoth = async (url) => { for (const s of Object.values(SOURCES)) await stage(url, s); };

    // ── 1. The proposed plan: verbatim_noop_main wrappers over public._pr34_migration_bodies ─────────────────────────
    console.log("\n== Proposed plan: verbatim_noop_main wrappers over the PR #34 staging table (measured facts)");
    const W = folderFor("wrapper", wrapperFor);
    { const url = await copyOf(base.name, "w_stage_role");
      const r = await asRole(url, "sandbox_exec", "INSERT INTO public._pr34_migration_bodies (name, body, sha256_hex) VALUES ($1,'x','x')", [SOURCES["0027"].source]);
      await check("plan defect (measured): the role 0014 grants INSERT to (sandbox_exec) cannot stage — RLS on, no policy (42501); staging needs an owner-level role",
        () => r === "42501" ? true : r); }
    { const url = await copyOf(base.name, "w_single"); await stageBoth(url);
      const r = await runMigrator(url, W); const j = await journalRows(url); const p = await postconditions(url);
      await check("plan, single run: both wrappers apply in the migrator transaction; one journal row each; full postconditions",
        () => r.ok && j["0027"] === 1 && j["0028"] === 1 && allOk(p) ? true : { r, j, p });
      const r2 = await runMigrator(url, W); const j2 = await journalRows(url);
      await check("plan, migrator retry: nothing pending, journal unchanged", () => r2.ok && j2["0027"] === 1 && j2["0028"] === 1 ? true : { r2, j2 });
      const re = await reapply(url, wrapperFor(SOURCES["0027"]), sha256(Buffer.from(wrapperFor(SOURCES["0027"]))), WHEN["0027"]); const j3 = await journalRows(url);
      await check("plan defect (measured): re-executing a wrapper in a migrator transaction is a successful no-op that COMMITS a duplicate journal row",
        () => re === "committed" && j3["0027"] === 2 ? true : { re, j3 }); }
    { const url = await copyOf(base.name, "w_stagger"); await stageBoth(url);
      const { first, second } = await staggered(url, W); const j = await journalRows(url);
      observe("plan, staggered runs (second reads the journal before the first commits)", { first: first.ok ? "ok" : first.code, second: second.ok ? "ok" : second.code, journalRows: j });
      await check("plan defect (measured): a staggered second migrator run no-ops and commits a duplicate journal row for each entry",
        () => first.ok && second.ok && j["0027"] === 2 && j["0028"] === 2 ? true : { first, second, j }); }
    { const url = await copyOf(base.name, "w_concurrent"); await stageBoth(url);
      const runs = await Promise.all(Array.from({ length: 4 }, () => runMigrator(url, W))); const j = await journalRows(url);
      observe("plan, 4 simultaneous migrator runs", { outcomes: outcomes(runs), journalRows: j }); }
    { const url = await copyOf(base.name, "w_preset"); await stageBoth(url);
      const preset = await asRole(url, "service_role", "UPDATE public._pr34_migration_bodies SET applied_at = now()");
      const r = await runMigrator(url, W); const j = await journalRows(url); const o = await releaseObjectsPresent(url);
      await check("plan defect (measured): service_role (not revoked on the staging table) can pre-set applied_at; the wrappers then skip the bodies while the journal records them as applied",
        () => preset.startsWith("ok") && r.ok && j["0027"] === 1 && j["0028"] === 1 && !o.a && !o.b ? true : { preset, r, j, o }); }
    { const url = await copyOf(base.name, "w_missing");
      const r = await runMigrator(url, W); const j = await journalRows(url); const o = await releaseObjectsPresent(url);
      await check("plan: a body not staged is refused (55000); no journal row; nothing applied", () => !r.ok && r.code === "55000" && j["0027"] === 0 && j["0028"] === 0 && !o.a && !o.b ? true : { r, j, o }); }
    { const url = await copyOf(base.name, "w_tampered");
      await stage(url, SOURCES["0027"], sourceBytes(SOURCES["0027"]).toString("utf8") + "\n-- altered\n"); await stage(url, SOURCES["0028"]);
      const r = await runMigrator(url, W); const j = await journalRows(url); const o = await releaseObjectsPresent(url);
      await check("plan: a staged body that differs from the approved digest is refused (55000); no journal row; nothing applied",
        () => !r.ok && r.code === "55000" && j["0027"] === 0 && !o.a && !o.b ? true : { r, j, o }); }
    { const url = await copyOf(base.name, "w_failure"); await stageBoth(url);
      await q(url, "CREATE VIEW public.safisha_ingestions AS SELECT gen_random_uuid() AS id");
      const r = await runMigrator(url, W); const j = await journalRows(url); const o = await releaseObjectsPresent(url);
      const applied = (await q(url, "SELECT count(*)::int n FROM public._pr34_migration_bodies WHERE applied_at IS NOT NULL"))[0].n;
      await check("plan: a payload failing in 0028 rolls back the whole migrator transaction (no journal row, 0027 not applied, applied_at unset)",
        () => !r.ok && j["0027"] === 0 && j["0028"] === 0 && !o.a && applied === 0 ? true : { r, j, o, applied }); }

    // ── 2. The latest lineage: release_verbatim ─────────────────────────────────────────────────────────────────────
    console.log("\n== Latest lineage: release_verbatim entries (byte-identical sources, as 0025/0026; measured facts)");
    const V = folderFor("verbatim", (s) => sourceBytes(s).toString("utf8"));
    { const url = await copyOf(base.name, "v_single");
      const r = await runMigrator(url, V); const j = await journalRows(url); const p = await postconditions(url);
      await check("verbatim, single run: both apply in the migrator transaction; one journal row each; full postconditions",
        () => r.ok && j["0027"] === 1 && j["0028"] === 1 && allOk(p) ? true : { r, j, p });
      const re = await reapply(url, sourceBytes(SOURCES["0027"]).toString("utf8"), SOURCES["0027"].digest, WHEN["0027"]); const j3 = await journalRows(url);
      await check("verbatim limit (measured): the replay-safe source re-executes successfully, so a re-application also commits a duplicate journal row",
        () => re === "committed" && j3["0027"] === 2 ? true : { re, j3 }); }
    { const url = await copyOf(base.name, "v_stagger");
      const { first, second } = await staggered(url, V); const j = await journalRows(url);
      await check("verbatim limit (measured): a staggered second migrator run re-executes both sources and commits duplicate journal rows",
        () => first.ok && second.ok && j["0027"] === 2 && j["0028"] === 2 ? true : { first, second, j }); }

    // ── 3. The guarded entries (recommended) ───────────────────────────────────────────────────────────────────────
    console.log("\n== Guarded entries: refuse a second application; postconditions and ledger in the same transaction (asserted)");
    const G = folderFor("guarded", (s) => fs.readFileSync(path.join(REPO, "release/candidates", `${s.tag}.sql`), "utf8"));
    const guardedSql = (s) => fs.readFileSync(path.join(REPO, "release/candidates", `${s.tag}.sql`), "utf8");
    const ledger = async (url) => (await q(url, "SELECT source, source_sha256 FROM public._release_migration_ledger ORDER BY source").catch(() => []));
    { const url = await copyOf(base.name, "g_single");
      const r = await runMigrator(url, G); const j = await journalRows(url); const p = await postconditions(url); const l = await ledger(url);
      await check("guarded, single run: both apply; one journal row each; full postconditions; one ledger row each with the source digest",
        () => r.ok && j["0027"] === 1 && j["0028"] === 1 && allOk(p) && l.length === 2 && l[0].source_sha256 === SOURCES["0027"].digest && l[1].source_sha256 === SOURCES["0028"].digest
          ? true : { r, j, p, l });
      const r2 = await runMigrator(url, G); const j2 = await journalRows(url);
      await check("guarded, migrator retry: nothing pending, journal unchanged", () => r2.ok && j2["0027"] === 1 && j2["0028"] === 1 ? true : { r2, j2 });
      const re = await reapply(url, guardedSql(SOURCES["0027"]), sha256(Buffer.from(guardedSql(SOURCES["0027"]))), WHEN["0027"]); const j3 = await journalRows(url);
      await check("guarded: re-executing an entry in a migrator transaction is REFUSED (55000); no duplicate journal row", () => re === "55000" && j3["0027"] === 1 ? true : { re, j3 });
      const priv = { serviceSelect: await asRole(url, "service_role", "SELECT * FROM public._release_migration_ledger"),
        serviceInsert: await asRole(url, "service_role", "INSERT INTO public._release_migration_ledger (source, source_sha256) VALUES ('x.sql','x')"),
        serviceDelete: await asRole(url, "service_role", "DELETE FROM public._release_migration_ledger"),
        authenticatedSelect: await asRole(url, "authenticated", "SELECT * FROM public._release_migration_ledger"),
        anonSelect: await asRole(url, "anon", "SELECT * FROM public._release_migration_ledger") };
      await check("guarded: the release ledger is closed to every client role, service_role included", () => Object.values(priv).every((v) => v === "42501") ? true : priv); }
    { const url = await copyOf(base.name, "g_stagger");
      const { first, second } = await staggered(url, G); const j = await journalRows(url); const p = await postconditions(url);
      await check("guarded: a staggered second migrator run is refused (55000) and rolls back with its journal rows — one row each",
        () => first.ok && !second.ok && second.code === "55000" && j["0027"] === 1 && j["0028"] === 1 && allOk(p) ? true : { first, second, j }); }
    { const url = await copyOf(base.name, "g_concurrent");
      const runs = await Promise.all(Array.from({ length: 6 }, () => runMigrator(url, G))); const j = await journalRows(url); const p = await postconditions(url);
      await check("guarded: 6 simultaneous migrator runs — exactly one applies; every other run is refused or collides and writes nothing; one journal row each",
        () => runs.filter((r) => r.ok).length === 1 && runs.every((r) => r.ok || ["55000", "23505"].includes(r.code)) && j["0027"] === 1 && j["0028"] === 1 && allOk(p)
          ? true : { outcomes: outcomes(runs), j }); }
    { const url = await copyOf(base.name, "g_failure");
      await q(url, "CREATE VIEW public.safisha_ingestions AS SELECT gen_random_uuid() AS id");
      const r = await runMigrator(url, G); const j = await journalRows(url); const o = await releaseObjectsPresent(url); const l = await ledger(url);
      await check("guarded: a payload failing in 0028 rolls back everything — no journal row, 0027 not applied, no ledger row",
        () => !r.ok && j["0027"] === 0 && j["0028"] === 0 && !o.a && l.length === 0 ? true : { r, j, o, l }); }
    { const url = await copyOf(base.name, "g_postcondition");
      // A postcondition that cannot hold: a stray trigger already carrying one of the release's trigger names, on an unrelated
      // table, makes the verifier's triggers_present check false (the source only manages its own tables' triggers).
      await q(url, "CREATE TRIGGER ac_reconciliation_freshness BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()");
      const r = await runMigrator(url, G); const j = await journalRows(url); const o = await releaseObjectsPresent(url);
      await check("guarded: a failed postcondition refuses the entry (55000) — no journal row, nothing applied",
        () => !r.ok && r.code === "55000" && j["0027"] === 0 && !o.a ? true : { r, j, o }); }
  } finally { await cleanup(); }

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}

let code = 1;
try { code = (await main()) === 0 ? 0 : 1; } catch (e) { console.error("FATAL", e); }
process.exit(code);
