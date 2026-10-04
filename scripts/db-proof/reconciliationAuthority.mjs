#!/usr/bin/env node
// Real-PostgreSQL proof of 20261004100000_reconciliation_server_authority.sql: reconciliation readiness is a server fact.
//
//   Upgrade     every migration before this one is replayed on an empty database; a legacy reconciliation the OLD resolver
//               marked 'clean' while an exception was only ESCALATED is recorded; applying the migration changes no row of
//               any table, and the MAONO gate then blocks that legacy upload;
//   Preserved   the client writes the product makes today (Overview / uploads-panel / Account Review retry, ingest's
//               processing reconciliation and upload status, categorize's needs_review, score's confidence, ingest's
//               evidence rows, match's pending exceptions and their re-match deletion) behave IDENTICALLY before and after;
//   Match       safisha_record_match_result is service-role only, re-checks the actor (owner and reviewer allowed;
//               Prepare-only, outsider and another tenant refused), DERIVES the counts from stored rows (ignoring stored
//               counts), and records 'clean' only for complete coverage (empty and partial stay needs_review);
//   Resolve     approved-all → clean; escalated, pending, or a rejected non-investigate exception → needs_review (never
//               clean); a rejected investigate exception → blocked; Prepare-only / outsider reviewers refused;
//   Forgery     owner, reviewer, Prepare-only, outsider and tenant B cannot set an upload's safisha_status to clean/blocked,
//               change a reconciliation's status to clean, its counts, sealing or completion, create a reconciliation
//               with results, change a reviewer decision, or call either RPC; the service role itself cannot record an
//               incomplete 'clean';
//   Gate        maono_check_safisha_gate unblocks only complete reconciliations;
//   Re-apply    applying the migration again changes nothing.
//
//   DB_PROOF_MODULES_DIR=<dir with node_modules/pg + embedded-postgres> bun ./scripts/db-proof/reconciliationAuthority.mjs
//   (or DB_PROOF_CONN=postgres://postgres:postgres@localhost:<port>/postgres for an already-running disposable server)
//
// Synthetic users only. It reads no Supabase credential, refuses every non-loopback host and the production project
// reference, and works in a uniquely named database it creates and drops itself.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MIGRATION = "20261004100000_reconciliation_server_authority.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

const results = [];
function record(name, ok, detail = "") { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : JSON.stringify(r)); } catch (e) { record(name, false, String(e?.message ?? e).split("\n")[0]); }
}

const PROOF_DB = `recon_authority_${process.pid}_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
let server, dir, admin, pool, maintenanceUrl, created = false;
async function start() {
  let url = process.env.DB_PROOF_CONN;
  if (!url) {
    const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
    const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-recon-authority-"));
    const port = 56000 + Math.floor(Math.random() * 900);
    server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, createPostgresUser: typeof process.getuid === "function" && process.getuid() === 0, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
    await server.initialise(); await server.start();
    url = `postgres://postgres:postgres@localhost:${port}/postgres`;
  }
  const u = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || url.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a disposable local database");
  maintenanceUrl = url;
  const boot = new Client({ connectionString: url, ssl: false }); await boot.connect();
  try { await boot.query(`CREATE DATABASE "${PROOF_DB}"`); created = true; } finally { await boot.end(); }
  u.pathname = `/${PROOF_DB}`;
  admin = new Client({ connectionString: u.toString(), ssl: false }); await admin.connect();
  pool = new Pool({ connectionString: u.toString(), ssl: false, max: 10 });
}
async function stop() {
  try { await pool?.end(); } catch { /* */ } try { await admin?.end(); } catch { /* */ }
  if (created) {
    try { const boot = new Client({ connectionString: maintenanceUrl, ssl: false }); await boot.connect(); await boot.query(`DROP DATABASE IF EXISTS "${PROOF_DB}" WITH (FORCE)`); await boot.end(); console.log(`  dropped this run's database ${PROOF_DB}`); } catch (e) { console.error(`  could not drop ${PROOF_DB}: ${e?.message ?? e}`); }
  }
  try { await server?.stop(); } catch { /* */ } try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
async function apply(f) {
  let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
  if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  try { await admin.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
}

/** Runs fn as a caller ({uid} = authenticated user, "anon", "service") in one transaction; rollback=true never commits. */
async function as(caller, fn, rollback = false) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (caller === "anon" || caller === "service") {
      const role = caller === "anon" ? "anon" : "service_role";
      await c.query(`SET LOCAL ROLE ${role}`);
      await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub','',true)", [role]);
    } else {
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [caller]);
    }
    const out = await fn(c);
    await c.query(rollback ? "ROLLBACK" : "COMMIT");
    return out;
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
}
/** { ok, rows, code } — never throws. */
async function attempt(caller, sql, params = [], rollback = false) {
  try { const r = await as(caller, (c) => c.query(sql, params), rollback); return { ok: true, rows: r.rowCount, data: r.rows }; } catch (e) { return { ok: false, code: e.code, message: String(e.message).split("\n")[0] }; }
}

const uuid = () => globalThis.crypto.randomUUID();
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
async function snapshot() {
  const tables = (await admin.query(`SELECT format('%I.%I', schemaname, tablename) t FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg\\_%' ORDER BY 1`)).rows.map((r) => r.t);
  const out = {};
  for (const t of tables) {
    const r = (await admin.query(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) h FROM ${t} x`)).rows[0];
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}
const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

async function main() {
  await start();
  const files = fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  if (files[files.length - 1] !== MIGRATION) throw new Error(`${MIGRATION} must be the newest migration`);
  console.log(`\n== Setup (synthetic users, disposable database ${PROOF_DB})`);
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  for (const f of files.slice(0, -1)) await apply(f);
  console.log(`  migrations applied before ${MIGRATION}: ${files.length - 1}`);

  const U = { owner: uuid(), reviewer: uuid(), prepareOnly: uuid(), outsider: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.outsider, "SOLO", 0], [U.ownerB, "SOLO", 0]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Tenant A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Tenant B') RETURNING id", [U.ownerB])).id;
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'partner',now())", [A, U.reviewer]);
  await as(U.owner, (c) => c.query("SELECT * FROM public.grant_workspace_capability($1,$2,'prepare_trial_balance')", [A, U.prepareOnly]));

  let year = 2000;
  const upload = async (company = A, owner = U.owner) => { year += 1; return (await one(
    "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ($1,$2,10,'complete',$3,$4,$5) RETURNING id",
    [`tb-${year}.csv`, `workspaces/${company}/${uuid()}/tb-${year}.csv`, company, year, owner])).id; };
  const recon = async (up, client = U.owner) => (await one("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing') RETURNING id", [client, up])).id;
  const tbLine = async (r) => (await one("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash) VALUES ($1,'tb','1000',$2) RETURNING id", [r, uuid()])).id;
  const exception = async (r, tb, category = "investigate") => (await one("INSERT INTO public.safisha_exceptions (reconciliation_id,account_code,category,variance,tb_txn_id) VALUES ($1,'1000',$2,10,$3) RETURNING id", [r, category, tb])).id;
  /** A reconciliation with `lines` TB lines, `excepted` of which carry one pending exception each. */
  const fixture = async ({ lines, excepted = 0, category = "investigate", company = A, owner = U.owner } = {}) => {
    const up = await upload(company, owner); const r = await recon(up, owner); const x = [];
    for (let i = 0; i < lines; i += 1) { const t = await tbLine(r); if (i < excepted) x.push(await exception(r, t, category)); }
    await admin.query("UPDATE public.trial_balance_uploads SET safisha_status='processing' WHERE id=$1", [up]);
    return { up, r, x };
  };
  const state = async (f) => one("SELECT u.safisha_status s, r.status r, r.matched_count m, r.total_tb_lines t, r.exception_count e, r.completed_at IS NOT NULL done, r.sealed FROM public.trial_balance_uploads u JOIN public.safisha_reconciliations r ON r.tb_upload_id=u.id WHERE u.id=$1", [f.up]);
  const resolve = (exc, reviewer, action) => attempt("service", "SELECT public.safisha_resolve_exception($1,$2,$3,'synthetic decision') r", [exc, reviewer, action]);
  const recordMatch = (r, actor, caller = "service") => attempt(caller, "SELECT public.safisha_record_match_result($1,$2) r", [r, actor]);
  const gate = async (ups) => Object.fromEntries((await admin.query("SELECT upload_id, is_blocked FROM public.maono_check_safisha_gate($1::uuid[])", [ups])).rows.map((r) => [r.upload_id, r.is_blocked]));

  // ── The product's own client writes, run (and rolled back) before and after the migration ──────────────────────────
  const P = await fixture({ lines: 2, excepted: 1 });
  await admin.query("UPDATE public.trial_balance_uploads SET safisha_status='needs_review' WHERE id=$1", [P.up]);
  await admin.query("UPDATE public.safisha_reconciliations SET status='needs_review' WHERE id=$1", [P.r]);
  const Q = await upload();
  const legit = [
    ["owner: Overview/Account Review retry — upload status processing, processing_result cleared", U.owner, "UPDATE public.trial_balance_uploads SET status='processing', processing_result=NULL WHERE id=$1", [P.up]],
    ["owner: uploads-panel retry — status, processing_result, accounting_errors, is_valid cleared", U.owner, "UPDATE public.trial_balance_uploads SET status='processing', processing_result=NULL, accounting_errors=NULL, is_valid=NULL WHERE id=$1", [P.up]],
    ["owner: ingest — upload safisha_status processing", U.owner, "UPDATE public.trial_balance_uploads SET safisha_status='processing' WHERE id=$1", [P.up]],
    ["owner: ingest — create a reconciliation as processing", U.owner, "INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($2,$1,'processing')", [Q, U.owner]],
    ["reviewer: ingest — evidence row", U.reviewer, "INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash) VALUES ($1,'bank','1000','h')", [P.r]],
    ["owner: match — pending exception", U.owner, "INSERT INTO public.safisha_exceptions (reconciliation_id,account_code,category,variance) VALUES ($1,'1000','timing',1)", [P.r]],
    ["owner: re-match — delete pending exceptions (a no-op under the existing policies; must stay one)", U.owner, "DELETE FROM public.safisha_exceptions WHERE reconciliation_id=$1 AND reviewer_action='pending'", [P.r], 0],
    ["reviewer: upload retry (outside the reviewer's upload policies; must stay a 0-row no-op)", U.reviewer, "UPDATE public.trial_balance_uploads SET status='processing', processing_result=NULL WHERE id=$1", [P.up], 0],
    ["reviewer: categorize — reconciliation needs_review", U.reviewer, "UPDATE public.safisha_reconciliations SET status='needs_review' WHERE id=$1", [P.r]],
    ["owner: score — confidence_score", U.owner, "UPDATE public.safisha_reconciliations SET confidence_score=80 WHERE id=$1", [P.r]],
  ];
  const runLegit = async () => { const out = []; for (const [, who, sql, p] of legit) out.push(await attempt(who, sql, p, true)); return out; };
  const expectedRows = (i) => legit[i][4];
  const legitBefore = await runLegit();

  // ── Legacy state recorded by the pre-migration code paths ──────────────────────────────────────────────────────────
  const LE = await fixture({ lines: 2, excepted: 1 });                    // the OLD resolver: escalated → 'clean'
  await admin.query("UPDATE public.safisha_reconciliations SET status='needs_review', matched_count=1, exception_count=1, total_tb_lines=2 WHERE id=$1", [LE.r]);
  await resolve(LE.x[0], U.owner, "escalated");
  const LC = await fixture({ lines: 2 });                                 // the OLD matcher: no exceptions → 'clean'
  await admin.query("UPDATE public.safisha_reconciliations SET status='clean', matched_count=2, total_tb_lines=2 WHERE id=$1", [LC.r]);
  await admin.query("UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [LC.up]);

  console.log("\n== Upgrade: applying the migration changes no row");
  await check("before the migration the old resolver marked an ESCALATED reconciliation and its upload 'clean' (the defect)", async () => { const s = await state(LE); return s.r === "clean" && s.s === "clean" ? true : s; });
  const before = await snapshot();
  await apply(MIGRATION);
  await check("every row of every table is byte-identical after the migration", async () => { const d = diff(before, await snapshot()); return d.length === 0 ? true : d; });
  await check("the MAONO gate now BLOCKS the legacy escalated-but-'clean' upload and still passes the legacy complete one", async () => { const g = await gate([LE.up, LC.up]); return g[LE.up] === true && g[LC.up] === false ? true : g; });

  console.log("\n== Preserved: the product's client writes behave identically before and after");
  const legitAfter = await runLegit();
  for (let i = 0; i < legit.length; i += 1) {
    await check(`${legit[i][0]}: identical before and after (${legitAfter[i].ok ? `${legitAfter[i].rows} row(s)` : `refused ${legitAfter[i].code}`})`, async () =>
      legitBefore[i].ok && legitAfter[i].ok && legitBefore[i].rows === legitAfter[i].rows
        && (expectedRows(i) === undefined ? legitAfter[i].rows > 0 : legitAfter[i].rows === expectedRows(i)) ? true : { before: legitBefore[i], after: legitAfter[i] });
  }

  console.log("\n== Match result: service role only, authorized actor, counts derived from rows, clean only when complete");
  const M1 = await fixture({ lines: 3 });
  await admin.query("UPDATE public.safisha_reconciliations SET matched_count=999, total_tb_lines=999 WHERE id=$1", [M1.r]); // stored counts are not authority
  for (const [who, caller] of [["anon", "anon"], ["owner (client)", U.owner], ["reviewer (client)", U.reviewer]]) {
    await check(`${who} cannot call safisha_record_match_result`, async () => { const r = await recordMatch(M1.r, U.owner, caller); return !r.ok && r.code === "42501" ? true : r; });
  }
  for (const [who, actor] of [["Prepare-only", U.prepareOnly], ["outsider", U.outsider], ["tenant B owner", U.ownerB]]) {
    await check(`service role acting for ${who} is refused 42501`, async () => { const r = await recordMatch(M1.r, actor); const s = await state(M1); return !r.ok && r.code === "42501" && s.r === "processing" ? true : { r, s }; });
  }
  await check("owner: 3 of 3 lines matched → clean; counts derived (3/3, not the stored 999); upload clean", async () => {
    const r = await recordMatch(M1.r, U.owner); const s = await state(M1);
    return r.ok && s.r === "clean" && s.s === "clean" && s.m === 3 && s.t === 3 && s.e === 0 && s.done ? true : { r, s };
  });
  const M2 = await fixture({ lines: 0 });
  await check("empty (no trial-balance lines) → needs_review, never clean", async () => { const r = await recordMatch(M2.r, U.owner); const s = await state(M2); return r.ok && s.r === "needs_review" && s.s === "needs_review" && !s.done ? true : { r, s }; });
  const M3 = await fixture({ lines: 4, excepted: 2 });
  await check("reviewer: 2 of 4 lines with pending exceptions → needs_review, matched 2/4", async () => { const r = await recordMatch(M3.r, U.reviewer); const s = await state(M3); return r.ok && s.r === "needs_review" && s.s === "needs_review" && s.m === 2 && s.t === 4 && s.e === 2 ? true : { r, s }; });
  const MS = await fixture({ lines: 1 });
  await admin.query("UPDATE public.safisha_reconciliations SET sealed=true WHERE id=$1", [MS.r]);
  await check("a sealed reconciliation is refused (55000)", async () => { const r = await recordMatch(MS.r, U.owner); return !r.ok && r.code === "55000" ? true : r; });

  console.log("\n== Resolve: escalated, pending and rejected stay unresolved");
  for (const [who, actor] of [["Prepare-only", U.prepareOnly], ["outsider", U.outsider], ["tenant B owner", U.ownerB]]) {
    await check(`${who} as reviewer is refused 42501`, async () => { const r = await resolve(M3.x[0], actor, "approved"); return !r.ok && r.code === "42501" ? true : r; });
  }
  await check("owner (client) cannot call safisha_resolve_exception directly", async () => { const r = await attempt(U.owner, "SELECT public.safisha_resolve_exception($1,$2,'approved')", [M3.x[0], U.owner]); return !r.ok && r.code === "42501" ? true : r; });
  await check("approve one of two → still needs_review (one pending)", async () => { const r = await resolve(M3.x[0], U.reviewer, "approved"); const s = await state(M3); return r.ok && s.r === "needs_review" && s.s === "needs_review" ? true : { r, s }; });
  await check("approve the last → clean, upload clean (every line matched or approved)", async () => { const r = await resolve(M3.x[1], U.reviewer, "approved"); const s = await state(M3); return r.ok && s.r === "clean" && s.s === "clean" && s.done ? true : { r, s }; });
  const E = await fixture({ lines: 2, excepted: 1 }); await recordMatch(E.r, U.owner);
  await check("ESCALATED (the only exception) → needs_review, never clean; upload needs_review", async () => { const r = await resolve(E.x[0], U.reviewer, "escalated"); const s = await state(E); return r.ok && r.data[0].r.recon_status === "needs_review" && s.r === "needs_review" && s.s === "needs_review" && !s.done ? true : { r, s }; });
  const E2 = await fixture({ lines: 3, excepted: 2 }); await recordMatch(E2.r, U.owner);
  await check("approved + escalated → needs_review", async () => { await resolve(E2.x[0], U.reviewer, "approved"); const r = await resolve(E2.x[1], U.owner, "escalated"); const s = await state(E2); return r.ok && s.r === "needs_review" && s.s === "needs_review" ? true : { r, s }; });
  const RN = await fixture({ lines: 2, excepted: 1, category: "needs_adjustment" }); await recordMatch(RN.r, U.owner);
  await check("REJECTED needs_adjustment → needs_review, never clean", async () => { const r = await resolve(RN.x[0], U.reviewer, "rejected"); const s = await state(RN); return r.ok && s.r === "needs_review" && s.s === "needs_review" ? true : { r, s }; });
  const RI = await fixture({ lines: 2, excepted: 1 }); await recordMatch(RI.r, U.owner);
  await check("REJECTED investigate → blocked", async () => { const r = await resolve(RI.x[0], U.reviewer, "rejected"); const s = await state(RI); return r.ok && s.r === "blocked" && s.s === "blocked" ? true : { r, s }; });
  await check("an escalated reconciliation re-recorded by the matcher stays needs_review", async () => { const r = await recordMatch(E.r, U.owner); const s = await state(E); return r.ok && s.r === "needs_review" && s.s === "needs_review" ? true : { r, s }; });

  console.log("\n== Forgery: no client user can write readiness directly");
  const people = [["owner", U.owner], ["reviewer", U.reviewer], ["Prepare-only", U.prepareOnly], ["outsider", U.outsider], ["tenant B owner", U.ownerB]];
  const forgeries = [
    ["upload safisha_status → clean", "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", (f) => [f.up]],
    ["upload safisha_status → blocked", "UPDATE public.trial_balance_uploads SET safisha_status='blocked' WHERE id=$1", (f) => [f.up]],
    ["reconciliation status → clean", "UPDATE public.safisha_reconciliations SET status='clean' WHERE id=$1", (f) => [f.r]],
    ["reconciliation matched_count → total", "UPDATE public.safisha_reconciliations SET matched_count=total_tb_lines WHERE id=$1", (f) => [f.r]],
    ["reconciliation total_tb_lines / exception_count → 0", "UPDATE public.safisha_reconciliations SET total_tb_lines=0, exception_count=0 WHERE id=$1", (f) => [f.r]],
    ["reconciliation completed_at / sealed", "UPDATE public.safisha_reconciliations SET completed_at=now(), sealed=true WHERE id=$1", (f) => [f.r]],
    ["exception reviewer_action → approved", "UPDATE public.safisha_exceptions SET reviewer_action='approved' WHERE reconciliation_id=$1", (f) => [f.r]],
  ];
  for (const [who, uid] of people) {
    for (const [label, sql, params] of forgeries) {
      await check(`${who}: ${label} — refused, nothing changes`, async () => {
        const s0 = await snapshot(); const r = await attempt(uid, sql, params(E)); const d = diff(s0, await snapshot());
        // owner and reviewer can reach the rows, so the refusal must be the database's explicit one (42501); the others are
        // already outside row-level security (0 rows) or the write wall.
        // Where the caller can reach the row (owner: upload and reconciliation; reviewer: reconciliation), the refusal must
        // be this migration's explicit 42501. Elsewhere existing row-level security already reaches nothing (0 rows) —
        // exceptions have no client UPDATE policy, and a firm-member reviewer has no upload UPDATE policy.
        const reachable = (who === "owner" && !label.startsWith("exception")) || (who === "reviewer" && label.startsWith("reconciliation"));
        const explicit = reachable ? !r.ok && r.code === "42501" : !r.ok || r.rows === 0;
        return explicit && d.length === 0 ? true : { r, d };
      });
    }
    await check(`${who}: create a reconciliation already 'clean' with results — refused`, async () => {
      const up = await upload(); const s0 = await snapshot();
      const r = await attempt(uid, "INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status,matched_count,total_tb_lines) VALUES ($1,$2,'clean',5,5)", [uid, up]);
      const d = diff(s0, await snapshot());
      return !r.ok && d.length === 0 && (who !== "owner" || r.code === "42501") ? true : { r, d };
    });
  }
  await check("anon cannot write readiness", async () => { const r = await attempt("anon", "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [E.up]); return (!r.ok || r.rows === 0) && (await state(E)).s === "needs_review" ? true : r; });
  await check("tenant B cannot read tenant A's completeness (security invoker: false, never a leak)", async () => { const r = await attempt(U.ownerB, "SELECT public.safisha_reconciliation_complete($1) c", [M1.r]); return r.ok && r.data[0].c === false ? true : r; });
  await check("the owner reads its own completeness", async () => { const r = await attempt(U.owner, "SELECT public.safisha_reconciliation_complete($1) c", [M1.r]); return r.ok && r.data[0].c === true ? true : r; });
  await check("anon cannot call the completeness readers", async () => { const r = await attempt("anon", "SELECT public.safisha_reconciliation_complete($1)", [M1.r]); return !r.ok && r.code === "42501" ? true : r; });

  console.log("\n== Even the service role cannot record an incomplete 'clean'");
  await check("service role: escalated reconciliation status → clean refused (23514)", async () => { const r = await attempt("service", "UPDATE public.safisha_reconciliations SET status='clean' WHERE id=$1", [E.r]); return !r.ok && r.code === "23514" ? true : r; });
  await check("service role: escalated upload safisha_status → clean refused (23514)", async () => { const r = await attempt("service", "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [E.up]); return !r.ok && r.code === "23514" ? true : r; });
  await check("service role: empty upload safisha_status → clean refused (23514)", async () => { const r = await attempt("service", "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [M2.up]); return !r.ok && r.code === "23514" ? true : r; });
  await check("service role: rejected (needs_adjustment) upload safisha_status → clean refused (23514)", async () => {
    const r = await attempt("service", "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [RN.up]); return !r.ok && r.code === "23514" ? true : r;
  });

  console.log("\n== The MAONO gate unblocks only complete reconciliations");
  await check("complete (M1 matched, M3 approved, legacy complete) unblocked; escalated, approved+escalated, rejected, empty, legacy escalated blocked", async () => {
    const g = await gate([M1.up, M3.up, LC.up, E.up, E2.up, RN.up, RI.up, M2.up, LE.up]);
    const ok = [M1.up, M3.up, LC.up].every((u) => g[u] === false) && [E.up, E2.up, RN.up, RI.up, M2.up, LE.up].every((u) => g[u] === true);
    return ok ? true : g;
  });
  await check("the gate stays service-role only", async () => { const r = await attempt(U.owner, "SELECT * FROM public.maono_check_safisha_gate($1::uuid[])", [[M1.up]]); return !r.ok && r.code === "42501" ? true : r; });

  console.log("\n== Re-apply");
  await check("applying the migration again changes no row and leaves one trigger of each", async () => {
    const s0 = await snapshot(); await apply(MIGRATION); const d = diff(s0, await snapshot());
    const t = (await admin.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('ab_reconciliation_authority','ab_upload_reconciliation_status_authority') ORDER BY 1")).rows.map((x) => x.tgname);
    return d.length === 0 && t.length === 2 ? true : { d, t };
  });

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}

let code = 1;
try { code = (await main()) === 0 ? 0 : 1; } catch (e) { console.error("FATAL", e); } finally { await stop(); }
process.exit(code);
