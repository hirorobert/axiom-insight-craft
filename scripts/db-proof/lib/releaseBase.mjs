// The production-equivalent starting state for the 2026-10 release proofs (scripts/db-proof/migratorRelease.mjs and
// scripts/db-proof/hostedExecutorRelease.mjs): every source migration except the two release sources, the PR #34 release
// staging infrastructure exactly as hosted journal entries 0013/0014 created it, and the hosted journal reproduced from
// drizzle/migrations/meta/_journal.json with drizzle's own hashes (SHA-256 of each entry file) and timestamps.
// Loopback only; refuses the production project reference; every database it creates is dropped by cleanup().
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
export const SRC_DIR = path.join(REPO, "supabase/migrations");
export const DRIZZLE_DIR = path.join(REPO, "drizzle/migrations");
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
export const { Pool, Client } = req("pg");
export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
export const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE_DIR, "meta/_journal.json"), "utf8"));
/** The hosted journal rows as drizzle computes them: SHA-256 of each entry file's text, `when` as created_at. */
export const hostedJournal = () => journal.entries.map((e) => ({ tag: e.tag, hash: sha256(fs.readFileSync(path.join(DRIZZLE_DIR, `${e.tag}.sql`), "utf8")), when: e.when }));

export function releaseServer(label) {
  const RUN = `${process.pid}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  let server, dir, maintenanceUrl;
  const created = [];
  const dbUrl = (name) => { const u = new URL(maintenanceUrl); u.pathname = `/${name}`; return u.toString(); };
  async function admin(sql, params) { const c = new Client({ connectionString: maintenanceUrl, ssl: false }); await c.connect(); try { return await c.query(sql, params); } finally { await c.end(); } }
  return {
    RUN,
    async start() {
      let url = process.env.DB_PROOF_CONN;
      if (!url) {
        const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
        const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), `cfoclose-${label}-proof-`));
        const port = 57000 + Math.floor(Math.random() * 900);
        server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, createPostgresUser: typeof process.getuid === "function" && process.getuid() === 0, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
        await server.initialise(); await server.start();
        url = `postgres://postgres:postgres@localhost:${port}/postgres`;
      }
      const u = new URL(url);
      if (!["localhost", "127.0.0.1"].includes(u.hostname) || url.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a disposable local database");
      maintenanceUrl = url;
    },
    async cleanup() {
      for (const n of created.reverse()) { try { await admin(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`); } catch { /* */ } }
      try { await server?.stop(); } catch { /* */ } try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    },
    /** The production-equivalent base database, without the release sources `exclude`. */
    async buildBase(exclude) {
      const name = `${label}_base_${RUN}`; await admin(`CREATE DATABASE "${name}"`); created.push(name);
      const db = new Client({ connectionString: dbUrl(name), ssl: false }); await db.connect();
      try {
        await db.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
        await db.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
          DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN CREATE ROLE sandbox_exec NOLOGIN; END IF; END $$;
          GRANT USAGE ON SCHEMA public TO sandbox_exec;`);
        const skip = new Set(exclude);
        const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".sql") && !skip.has(f)).sort();
        for (const f of files) {
          let t = fs.readFileSync(path.join(SRC_DIR, f), "utf8");
          if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
          await db.query(t);
        }
        await db.query(fs.readFileSync(path.join(DRIZZLE_DIR, "0013_pr34_probe_session_identity.sql"), "utf8"));
        await db.query(fs.readFileSync(path.join(DRIZZLE_DIR, "0014_pr34_release_staging_table.sql"), "utf8"));
        const rows = hostedJournal();
        await db.query("CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)");
        for (const m of rows) await db.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)", [m.hash, m.when]);
        return { name, applied: files.length, journalRows: rows.length };
      } finally { await db.end(); }
    },
    async copyOf(base, l) { const name = `${label}_${l}_${RUN}`; await admin(`CREATE DATABASE "${name}" TEMPLATE "${base}"`); created.push(name); return dbUrl(name); },
  };
}
