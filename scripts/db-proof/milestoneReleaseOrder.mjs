#!/usr/bin/env bun
// Real-PostgreSQL proof of THIS milestone's release order (I1-B, I1-C, Close Review, reporting input, sign-off): one
// database upgraded from the schema of main through each step of the release procedure, with legacy data present and the
// scheduled jobs running at every stage.
//
//   stage 0   main's schema (chain before 20261011100000); legacy uploads (a personal path and a workspace-scoped one),
//             a discard inside its undo window, a terminal discard, an expired reservation;
//   stage 1   the NEW trial-balance-storage-cleanup on the OLD schema behaves exactly as the old one;
//   stage 2+  the seven migrations, one at a time; after EACH: every legacy upload is still bound, the in-window discard is
//             still restorable, the sweeper (the real orchestration) deletes nothing a bound upload references, and the
//             cleanup function still answers;
//   shared    after 20261011100000: one file as two years; retiring (replacing) either year, discarding either year, the
//             old cleanup handler (deployed out of order) and the new one — nothing a sibling still needs is ever deleted.
// The storage-cleanup decision module is run at the exact source of main (old) and of this release (new); only the
// network edges (Storage removal, the database client) are doubled.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/milestoneReleaseOrder.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";
import { runSourceSweep } from "../../supabase/functions/_shared/sourceSweeper.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
// The source of main this release is built on (the old storage-cleanup decision module comes from it).
const BASE_COMMIT = "c0f0f09402f502c5c7ac5c60971c5d8cccc62684";
export const RELEASE_MIGRATIONS = [
  "20261011100000_two_period_shared_source.sql",
  "20261012100000_layout_assist_controls.sql",
  "20261013100000_close_review_timeline.sql",
  "20261014100000_close_review_findings.sql",
  "20261015100000_close_review_adjustments.sql",
  "20261016100000_fs_reporting_input.sql",
  "20261017100000_signoff_completion_requirements.sql",
];
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const uuid = () => crypto.randomUUID();

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") { results.push({ group: currentGroup, name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)?.slice(0, 700)}`); }
  catch (e) { record(name, false, `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}`); }
}

let pool, admin, server = null, dir = null;
async function startDatabase() {
  if ((process.env.DB_PROOF_MODE ?? "embedded") === "external") {
    const conn = process.env.DB_PROOF_CONN ?? "";
    const u = new URL(conn);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname) || conn.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a loopback database");
    return conn;
  }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-milestone-release-"));
  const port = 59000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE milestone_release_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/milestone_release_proof`;
}
async function stopDatabase() {
  const step = (p) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  await step(pool?.end() ?? Promise.resolve()); await step(admin?.end() ?? Promise.resolve());
  if (server) await step(server.stop());
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}
async function asRole(role, uid, sql, params) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]);
    const r = await c.query(sql, params); await c.query("COMMIT"); return r.rows;
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
}
const asUser = async (uid, sql, p) => (await asRole("authenticated", uid, sql, p))[0];
const asService = (sql, p) => asRole("service_role", null, sql, p);
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
const count = async (sql, p = []) => Number((await one(sql, p)).n);
const apply = async (f) => {
  let t = migrationSql(REPO, f);
  if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  await admin.query(t);
};

/** The storage-cleanup decision module at a given source (main's, or this release's working tree). */
async function cleanupModuleAt(commit) {
  if (!commit) return import(pathToFileURL(path.join(REPO, "supabase/functions/_shared/storageCleanup.ts")).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-old-"));
  for (const f of ["storageCleanup.ts", "sourcePath.ts"]) {
    try { fs.writeFileSync(path.join(tmp, f), execFileSync("git", ["-C", REPO, "show", `${commit}:supabase/functions/_shared/${f}`])); } catch { /* not every file exists */ }
  }
  return import(pathToFileURL(path.join(tmp, "storageCleanup.ts")).href);
}

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 30 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);

  const files = currentChain(REPO);
  group("Stage 0 — the schema of main");
  await check("the seven release migrations are the newest seven, in this order; everything before applies", async () => {
    const tail = files.slice(-RELEASE_MIGRATIONS.length);
    if (JSON.stringify(tail) !== JSON.stringify(RELEASE_MIGRATIONS)) return tail;
    for (const f of files.slice(0, files.length - RELEASE_MIGRATIONS.length)) await apply(f);
    return true;
  });

  const U = { owner: uuid() };
  await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,'owner@example.test')", [U.owner]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [U.owner, prod])).id;
  await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic A') RETURNING id", [U.owner])).id;
  const putObject = (p) => admin.query("INSERT INTO storage.objects (bucket_id, name) VALUES ('trial-balance-files', $1)", [p]);
  const objectExists = async (p) => (await count("SELECT count(*) n FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [p])) === 1;
  const reserve = async () => { const r = await asUser(U.owner, "SELECT * FROM public.reserve_trial_balance_source($1,'tb.csv')", [A]); await putObject(r.object_path); return r; };
  let year = 2000;
  const workspaceUpload = async () => {
    const r = await reserve();
    const g = await asUser(U.owner, "SELECT * FROM public.register_trial_balance_upload($1,10,$2,NULL,NULL)", [r.reservation_id, ++year]);
    return { id: g.upload_id, path: r.object_path, year };
  };
  const row = (id) => one("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [id]);
  const bound = async (id) => (await one("SELECT public.tbu_upload_source_bound($1) b", [id])).b;
  const discard = async (id) => {
    const b = await asUser(U.owner, "SELECT * FROM public.discard_trial_balance_upload($1,$2)", [id, Number((await row(id)).version)]);
    await asUser(U.owner, "SELECT * FROM public.complete_trial_balance_discard($1)", [b.operation_id]);
    return b;
  };
  const expire = (op) => admin.query("UPDATE public.trial_balance_upload_operations SET completed_at = now() - public.tbu_undo_window() - interval '1 minute' WHERE id=$1", [op]);

  // Legacy data present before the release.
  const personalPath = `${U.owner}/${uuid()}.csv`;
  await putObject(personalPath);
  const personal = (await asUser(U.owner, "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('legacy.csv',$1,10,'processing',$2,$3,$4) RETURNING id", [personalPath, U.owner, A, ++year])).id;
  const ws = await workspaceUpload();
  const inWindow = await workspaceUpload();
  const inWindowOp = (await discard(inWindow.id)).operation_id;
  const terminal = await workspaceUpload();
  const terminalOp = (await discard(terminal.id)).operation_id;
  await expire(terminalOp);
  const expiredRes = await asUser(U.owner, "SELECT * FROM public.reserve_trial_balance_source($1,'never-registered.csv')", [A]);
  await putObject(expiredRes.object_path);
  await admin.query("UPDATE public.trial_balance_source_reservations SET expires_at = now() - interval '2 days' WHERE id=$1", [expiredRes.reservation_id]);

  const deletions = [];
  const sweepDeps = {
    redeemTicket: async () => true,
    listCandidates: async (n) => asService("SELECT * FROM public.tbu_sweeper_candidates($1)", [n]),
    claim: async (k, id) => (await asService("SELECT public.tbu_sweeper_claim($1,$2) r", [k, id]))[0].r === "claimed",
    removeObject: async (p) => { const r = await admin.query("DELETE FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [p]); if (r.rowCount) deletions.push(p); return true; },
    objectExists: async (p) => objectExists(p),
    complete: async (k, id) => (await asService("SELECT public.tbu_sweeper_complete($1,$2) r", [k, id]))[0].r,
  };
  const cleanupDeps = (uid) => ({
    authenticate: async () => uid,
    resolveTarget: async (op) => (await asService("SELECT * FROM public.tbu_storage_cleanup_target($1)", [op]))[0] ?? null,
    canManage: async (u, company) => (await asService("SELECT public.can_user_act_on_workspace($1,$2,'manage_source_files') r", [u, company]))[0].r === true,
    removeObject: async (p) => { const r = await admin.query("DELETE FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [p]); if (r.rowCount) deletions.push(p); return { ok: true }; },
    objectExists: async (p) => objectExists(p),
    completeAsCaller: async (kind, op) => {
      try { const r = await asUser(uid, `SELECT * FROM public.${kind === "discard" ? "purge_trial_balance_discard" : "confirm_trial_balance_storage_cleanup"}($1)`, [op]); return r?.outcome ? { outcome: String(r.outcome) } : null; }
      catch { return null; }
    },
    claimAsCaller: async (op) => {
      try { const r = await asUser(uid, "SELECT * FROM public.claim_trial_balance_discard_purge($1)", [op]); return r?.outcome ? { outcome: String(r.outcome) } : null; }
      catch { return null; }
    },
  });
  const OLD = await cleanupModuleAt(BASE_COMMIT);
  const NEW = await cleanupModuleAt(null);
  const legacyPaths = [personalPath, ws.path];
  const invariants = async (label) => {
    deletions.length = 0;
    const s = await runSourceSweep(sweepDeps, "a".repeat(64));
    const bad = [];
    for (const id of [personal, ws.id]) if (!(await bound(id))) bad.push(`unbound ${id}`);
    for (const p of [...legacyPaths, inWindow.path]) if (!(await objectExists(p))) bad.push(`deleted ${p}`);
    const op = await one("SELECT state FROM public.trial_balance_upload_operations WHERE id=$1", [inWindowOp]);
    if (op.state !== "completed") bad.push(`in-window discard is ${op.state}`);
    return s.outcome === "swept" && bad.length === 0 ? true : { label, bad, sweep: s };
  };

  // The documented hosted preflight / postcondition (docs/release/milestone-i1b-signoff), run exactly as written, in READ ONLY transactions.
  const readOnlySql = async (file) => {
    const notices = [];
    const onNotice = (m) => notices.push(m.message);
    admin.on("notice", onNotice);
    try {
      await admin.query("BEGIN READ ONLY");
      try { await admin.query(fs.readFileSync(path.join(REPO, "docs/release/milestone-i1b-signoff", file), "utf8")); }
      finally { await admin.query("ROLLBACK"); }
      return notices;
    } finally { admin.off("notice", onNotice); }
  };
  await check("the documented hosted preflight passes on main's schema, read-only, and prints the baseline", async () => {
    const n = await readOnlySql("preflight.sql");
    return n.some((m) => m.startsWith("PREFLIGHT OK")) && n.some((m) => m === "BASELINE legacy_personal_path_uploads=1")
      && n.some((m) => m === "BASELINE discards_inside_undo_window=1") ? true : n;
  });
  await check("stage 0: legacy uploads bound; the sweeper reclaims only the expired reservation and the terminal discard", async () => {
    const r = await invariants("stage 0");
    return r === true && deletions.includes(expiredRes.object_path) && deletions.includes(terminal.path) ? true : { r, deletions };
  });

  group("Stage 1 — the new storage-cleanup function on the old schema");
  await check("old and new cleanup answer identically on the old schema (terminal discard: completed; in-window discard: refused, nothing deleted)", async () => {
    const t = await workspaceUpload();
    const op = (await discard(t.id)).operation_id;
    const early = [await OLD.runStorageCleanup(cleanupDeps(U.owner), op), await NEW.runStorageCleanup(cleanupDeps(U.owner), op)];
    const stillThere = await objectExists(t.path);
    await expire(op);
    const done = await NEW.runStorageCleanup(cleanupDeps(U.owner), op);
    return JSON.stringify(early[0]) === JSON.stringify(early[1]) && early[1].outcome === "undo_window_open" && stillThere
      && done.outcome === "completed" && !(await objectExists(t.path)) ? true : { early, done };
  });

  group("Stages 2–8 — the seven migrations, one at a time");
  for (const f of RELEASE_MIGRATIONS) {
    await check(`${f} applies; legacy uploads bound, the in-window discard restorable, the sweeper deletes nothing referenced`, async () => {
      await apply(f);
      return invariants(f);
    });
    if (f === RELEASE_MIGRATIONS[0]) {
      await check("after the first migration, the preflight refuses (a partial apply is investigated, never layered over)", async () => {
        try { await readOnlySql("preflight.sql"); return "passed"; }
        catch (e) { return /PREFLIGHT: objects of this release already exist|source_object_id already exists/.test(e.message) ? true : e.message; }
      });
      // The shared-source contract, while the remaining migrations are still to come.
      group("Shared source — siblings, retirement and both cleanup handlers");
      const pair = async () => {
        const pri = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$2) RETURNING id", [A, `${++year}-12-31`, `FY${year}`, U.owner, `${year}-01-01`])).id;
        const cur = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$2) RETURNING id", [A, `${++year}-12-31`, `FY${year}`, U.owner, `${year}-01-01`])).id;
        const r = await reserve();
        const g = await asUser(U.owner, "SELECT * FROM public.register_two_period_uploads($1,$2,10,$3,$4)", [r.reservation_id, uuid(), cur, pri]);
        return { ...g, path: r.object_path };
      };
      await check("retiring (replacing) the PRIOR year keeps the file its sibling needs; the sweeper deletes nothing", async () => {
        const p = await pair();
        const rep = await reserve();
        const pr = await row(p.prior_upload_id);
        const r = await asUser(U.owner, "SELECT * FROM public.retire_trial_balance_upload($1,$2,$3,10,'replaced')", [pr.id, Number(pr.version), rep.reservation_id]);
        deletions.length = 0; await runSourceSweep(sweepDeps, "a".repeat(64));
        return r.outcome === "replaced" && (await objectExists(p.path)) && (await bound(p.current_upload_id)) && !deletions.includes(p.path) ? true : { r, deletions };
      });
      await check("retiring the CURRENT year, then discarding the prior year past its window: still kept (the retired row is history that references it)", async () => {
        const p = await pair();
        const rep = await reserve();
        const cr = await row(p.current_upload_id);
        await asUser(U.owner, "SELECT * FROM public.retire_trial_balance_upload($1,$2,$3,10,'replaced')", [cr.id, Number(cr.version), rep.reservation_id]);
        const op = (await discard(p.prior_upload_id)).operation_id; await expire(op);
        deletions.length = 0; await runSourceSweep(sweepDeps, "a".repeat(64));
        return (await objectExists(p.path)) && !deletions.includes(p.path) ? true : deletions;
      });
      await check("one year discarded past its window, the OLD cleanup handler (deployed out of order) fails closed — nothing deleted; the NEW one answers source_shared", async () => {
        const p = await pair();
        const op = (await discard(p.prior_upload_id)).operation_id; await expire(op);
        const oldR = await OLD.runStorageCleanup(cleanupDeps(U.owner), op);
        const kept1 = await objectExists(p.path);
        const op2 = (await discard((await pair()).prior_upload_id)).operation_id; await expire(op2);
        const newR = await NEW.runStorageCleanup(cleanupDeps(U.owner), op2);
        return oldR.status === 500 && kept1 && newR.status === 200 && newR.outcome === "source_shared" && (await bound(p.current_upload_id)) ? true : { oldR, newR, kept1 };
      });
      await check("both years discarded: the file is deleted exactly once, only after both undo windows", async () => {
        const p = await pair();
        const a = (await discard(p.prior_upload_id)).operation_id;
        const b = (await discard(p.current_upload_id)).operation_id;
        deletions.length = 0; await runSourceSweep(sweepDeps, "a".repeat(64));
        const inside = deletions.filter((x) => x === p.path).length;
        await expire(a); await expire(b);
        await Promise.all([runSourceSweep(sweepDeps, "a".repeat(64)), runSourceSweep(sweepDeps, "a".repeat(64))]);
        return inside === 0 && deletions.filter((x) => x === p.path).length === 1 && !(await objectExists(p.path)) ? true : { inside, deletions };
      });
      group("Stages 3–8 (continued)");
    }
  }
  await check("the documented postcondition passes after the seventh migration, read-only (AI provider disabled, nothing executable by anon)", async () => {
    const n = await readOnlySql("postcondition.sql");
    return n.some((m) => m === "POSTCONDITION OK.") && n.some((m) => m === "AFTER legacy_personal_path_uploads=1") ? true : n;
  });
  await check("on the final schema, a single-year discard past its window: the OLD and the NEW cleanup handler each complete it (exactly one deletion each)", async () => {
    const out = [];
    for (const M of [OLD, NEW]) {
      const t = await workspaceUpload();
      const op = (await discard(t.id)).operation_id; await expire(op);
      deletions.length = 0;
      const r = await M.runStorageCleanup(cleanupDeps(U.owner), op);
      out.push({ r, gone: !(await objectExists(t.path)), n: deletions.filter((x) => x === t.path).length });
    }
    return out.every((x) => x.r.outcome === "completed" && x.gone && x.n === 1) ? true : out;
  });
  await check("after the whole release: the in-window discard is restored by its owner; every legacy upload still bound", async () => {
    const r = await asUser(U.owner, "SELECT * FROM public.restore_trial_balance_upload($1)", [inWindowOp]);
    return r.outcome === "restored" && (await bound(inWindow.id)) && (await bound(personal)) && (await bound(ws.id)) ? true : r;
  });
  await check("re-applying any release migration is refused by its preflight (nothing replaced)", async () => {
    const out = [];
    for (const f of RELEASE_MIGRATIONS) { try { await apply(f); out.push(`${f}: applied twice`); } catch (e) { if (!String(e.message).includes("PREFLIGHT_REFUSED")) out.push(`${f}: ${e.message}`); } }
    return out.length === 0 ? true : out;
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "MILESTONE_RELEASE_ORDER: ALL PASSED" : "MILESTONE_RELEASE_ORDER: FAILED");
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await stopDatabase();
process.exit(ok ? 0 : 1);
