// reconciliationEvidence.mjs — disposable-PostgreSQL proof for the reconciliation-evidence reads behind "Trial balance
// ready" (src/lib/workspace/trialBalanceReadiness.ts). Synthetic users only; loopback only; refuses the production ref.
//
// Replays every repository migration on an empty embedded PostgreSQL in a UNIQUELY named database it creates and drops
// itself, then drives the app's OWN reader (readReconciliationEvidence → evidenceState / effectiveSafishaStatus) through
// a client that executes as each synthetic user under the REAL row-level policies:
//   viewers  owner · firm-member reviewer · Prepare-only grant holder · outsider · another tenant's owner
//   states   complete · partial · empty · pending · escalated (real safisha_resolve_exception) · rejected (real RPC)
// It also probes the write surface (can a viewer forge "clean"?) and the server gate MAONO consumes
// (maono_check_safisha_gate), and reports what it finds — it does not assume.
//
//   DB_PROOF_MODULES_DIR=<dir with node_modules/pg + embedded-postgres> bun ./scripts/db-proof/reconciliationEvidence.mjs
//   (or DB_PROOF_CONN=postgres://postgres:postgres@localhost:<port>/postgres for an already-running disposable server)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { effectiveSafishaStatus, evidenceState, readReconciliationEvidence } from "../../src/lib/workspace/trialBalanceReadiness.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

const results = [];
const findings = [];
function record(name, ok, detail = "") { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : JSON.stringify(r)); } catch (e) { record(name, false, String(e?.message ?? e).split("\n")[0]); }
}

const PROOF_DB = `recon_proof_${process.pid}_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
let server, dir, admin, pool, maintenanceUrl, created = false;
async function createProofDb(url) {
  maintenanceUrl = url;
  const boot = new Client({ connectionString: url, ssl: false }); await boot.connect();
  try { await boot.query(`CREATE DATABASE "${PROOF_DB}"`); created = true; } finally { await boot.end(); }
  const u = new URL(url); u.pathname = `/${PROOF_DB}`; return u.toString();
}
async function start() {
  let url = process.env.DB_PROOF_CONN;
  if (!url) {
    const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
    const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-recon-proof-"));
    const port = 56000 + Math.floor(Math.random() * 900);
    server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, createPostgresUser: typeof process.getuid === "function" && process.getuid() === 0, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
    await server.initialise(); await server.start();
    url = `postgres://postgres:postgres@localhost:${port}/postgres`;
  }
  const u = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || url.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a disposable local database");
  const db = await createProofDb(url);
  admin = new Client({ connectionString: db, ssl: false }); await admin.connect();
  pool = new Pool({ connectionString: db, ssl: false, max: 10 });
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
  await admin.query(text);
}
async function asUser(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const out = await fn(c); await c.query("COMMIT"); return out;
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
}

/** The PostgREST-shaped client the app's reader expects, executing as `uid` under the real policies. */
function clientAs(uid) {
  return {
    from(table) {
      if (!/^[a-z_]+$/.test(table)) throw new Error("bad table");
      const q = { cols: "*", where: [], params: [], order: "", limit: "" };
      const run = async (single) => {
        const sql = `SELECT ${q.cols} FROM public.${table}${q.where.length ? ` WHERE ${q.where.join(" AND ")}` : ""}${q.order}${q.limit}`;
        try {
          const rows = await asUser(uid, async (c) => (await c.query(sql, q.params)).rows);
          return { data: single ? rows[0] ?? null : rows, error: null };
        } catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
      };
      const b = {
        select(cols) { if (!/^[a-z_, ]+$/.test(cols)) throw new Error("bad cols"); q.cols = cols; return b; },
        eq(col, v) { if (!/^[a-z_]+$/.test(col)) throw new Error("bad col"); q.params.push(v); q.where.push(`${col} = $${q.params.length}`); return b; },
        order(col, o) { q.order = ` ORDER BY ${col} ${o?.ascending === false ? "DESC" : "ASC"}`; return b; },
        limit(n) { q.limit = ` LIMIT ${Number(n)}`; return b; },
        maybeSingle() { return run(true); },
        then(ok, bad) { return run(false).then(ok, bad); },
      };
      return b;
    },
  };
}

const uuid = () => globalThis.crypto.randomUUID();
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];

async function main() {
  await start();
  const files = fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  console.log(`\n== Setup (synthetic users, disposable database ${PROOF_DB})`);
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  // A later reconciliation-authority migration (20261004100000) refuses the incomplete 'clean' states seeded below for
  // every writer. When it is present they are seeded as LEGACY rows — recorded before it — and it is applied right
  // after, exactly as on an upgraded database. Without it nothing changes.
  const AUTHORITY = "20261004100000_reconciliation_server_authority.sql";
  const before = files.filter((x) => x !== AUTHORITY);
  for (const f of before) await apply(f);
  console.log(`  migrations applied: ${before.length}${files.includes(AUTHORITY) ? ` (then ${AUTHORITY} after the legacy states)` : ""}`);

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
  await asUser(U.owner, (c) => c.query("SELECT * FROM public.grant_workspace_capability($1,$2,'prepare_trial_balance')", [A, U.prepareOnly]));

  // One upload per state (distinct periods: one active upload per period).
  const upload = async (company, owner, year) => (await one(
    "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ($1,$2,10,'complete',$3,$4,$5) RETURNING id",
    [`tb-${year}.csv`, `workspaces/${company}/${uuid()}/tb-${year}.csv`, company, year, owner])).id;
  const tbLine = async (recon, code) => (await one("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash) VALUES ($1,'tb',$2,$3) RETURNING id", [recon, code, uuid()])).id;
  const recon = async (up, status, matched, total, client = U.owner) => (await one(
    "INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status,matched_count,exception_count,total_tb_lines) VALUES ($1,$2,$3,$4,0,$5) RETURNING id",
    [client, up, status, matched, total])).id;
  // Exceptions are inserted pending (the Iron Dome trigger refuses anything else) and resolved ONLY through the real
  // service-role RPC safisha_resolve_exception, exactly as the safisha-resolve function does.
  const exception = async (r, action, tbTxn) => {
    const x = (await one("INSERT INTO public.safisha_exceptions (reconciliation_id,account_code,category,variance,tb_txn_id) VALUES ($1,'1000','investigate',10,$2) RETURNING id", [r, tbTxn])).id;
    if (action !== "pending") await admin.query("SELECT public.safisha_resolve_exception($1,$2,$3,'synthetic decision')", [x, U.owner, action]);
    return x;
  };
  const setUploadStatus = (up, s) => admin.query("UPDATE public.trial_balance_uploads SET safisha_status=$2 WHERE id=$1", [up, s]);

  const S = {};
  // complete: 3 matched + 1 approved = 4 of 4
  S.complete = await upload(A, U.owner, 2021); { await setUploadStatus(S.complete, "needs_review"); const r = await recon(S.complete, "needs_review", 3, 4); await exception(r, "approved", await tbLine(r, "1000")); }
  // partial: 1 matched + 1 approved of 4, marked clean
  S.partial = await upload(A, U.owner, 2022); { await setUploadStatus(S.partial, "needs_review"); const r = await recon(S.partial, "needs_review", 1, 4); await exception(r, "approved", await tbLine(r, "1000")); }
  // empty comparison marked clean
  S.empty = await upload(A, U.owner, 2023); { await recon(S.empty, "clean", 0, 0); await setUploadStatus(S.empty, "clean"); }
  // pending exception (needs_review)
  S.pending = await upload(A, U.owner, 2024); { await setUploadStatus(S.pending, "needs_review"); const r = await recon(S.pending, "needs_review", 3, 4); await exception(r, "pending", await tbLine(r, "1000")); }
  // escalated through the REAL resolve RPC (service role, as the safisha-resolve function calls it)
  S.escalated = await upload(A, U.owner, 2025); {
    await setUploadStatus(S.escalated, "needs_review"); const r = await recon(S.escalated, "needs_review", 3, 4); await exception(r, "escalated", await tbLine(r, "1000"));
  }
  // rejected through the REAL resolve RPC
  S.rejected = await upload(A, U.owner, 2020); {
    await setUploadStatus(S.rejected, "needs_review"); const r = await recon(S.rejected, "needs_review", 3, 4); await exception(r, "rejected", await tbLine(r, "1000"));
  }
  // tenant B: complete, for cross-tenant reads
  S.tenantB = await upload(B, U.ownerB, 2025); { const r = await recon(S.tenantB, "clean", 2, 2, U.ownerB); await setUploadStatus(S.tenantB, "clean"); void r; }
  if (files.includes(AUTHORITY)) await apply(AUTHORITY);

  const raw = async (up) => (await one("SELECT u.safisha_status s, r.status r FROM public.trial_balance_uploads u LEFT JOIN public.safisha_reconciliations r ON r.tb_upload_id=u.id WHERE u.id=$1", [up]));
  console.log("\n== What the database itself records (raw statuses after the REAL resolve RPC)");
  await check("escalated: the resolve RPC marks the reconciliation AND the upload 'clean' (an escalated exception counts as resolved)", async () => {
    const x = await raw(S.escalated); if (x.s === "clean" && x.r === "clean") findings.push("SERVER: safisha_resolve_exception sets recon+upload 'clean' while an exception is only ESCALATED"); return x.s === "clean" && x.r === "clean" ? true : x;
  });
  await check("rejected: the resolve RPC marks it 'blocked'", async () => { const x = await raw(S.rejected); return x.s === "blocked" && x.r === "blocked" ? true : x; });

  // What each viewer's app computes, through the app's own reader under the real policies.
  const view = async (uid, up) => {
    const status = await asUser(uid, async (c) => (await c.query("SELECT safisha_status FROM public.trial_balance_uploads WHERE id=$1", [up])).rows[0]?.safisha_status ?? null);
    const read = await readReconciliationEvidence(clientAs(uid), up);
    const st = evidenceState(status, read);
    return { status, state: st.state, effective: effectiveSafishaStatus(status, read), evidenceVisible: read.state === "read" && !!read.evidence };
  };

  console.log("\n== Owner and firm-member reviewer: evidence readable; only COMPLETE is complete");
  for (const [who, uid] of [["owner", U.owner], ["reviewer", U.reviewer]]) {
    await check(`${who}: complete → complete (effective 'clean')`, async () => { const v = await view(uid, S.complete); return v.state === "complete" && v.effective === "clean" ? true : v; });
    for (const k of ["partial", "empty", "escalated"]) {
      await check(`${who}: ${k} marked 'clean' → incomplete; effective 'needs_review' (unlocks nothing)`, async () => { const v = await view(uid, S[k]); return v.status === "clean" && v.state === "incomplete" && v.effective === "needs_review" ? true : v; });
    }
    await check(`${who}: pending → incomplete`, async () => { const v = await view(uid, S.pending); return v.state === "incomplete" && v.effective === "needs_review" ? true : v; });
    await check(`${who}: rejected → incomplete (raw 'blocked' stays blocked)`, async () => { const v = await view(uid, S.rejected); return v.state === "incomplete" && v.effective === "blocked" ? true : v; });
  }

  console.log("\n== Prepare-only grant holder: sees the upload, NOT the reconciliation → 'not visible', never ready");
  for (const k of ["complete", "escalated"]) {
    await check(`prepare-only: ${k} → upload status visible, evidence not visible → not_visible`, async () => { const v = await view(U.prepareOnly, S[k]); return v.status === "clean" && !v.evidenceVisible && v.state === "not_visible" ? true : v; });
  }

  console.log("\n== Outsider and another tenant: no upload, no reconciliation, no exceptions — nothing leaks");
  for (const [who, uid] of [["outsider", U.outsider], ["tenant B owner", U.ownerB]]) {
    await check(`${who} reading tenant A: upload status, reconciliation and exceptions all invisible`, async () => {
      const v = await view(uid, S.escalated);
      const ex = await asUser(uid, async (c) => (await c.query("SELECT count(*)::int n FROM public.safisha_exceptions e JOIN public.safisha_reconciliations r ON r.id=e.reconciliation_id WHERE r.tb_upload_id=$1", [S.escalated])).rows[0].n);
      return v.status === null && !v.evidenceVisible && ex === 0 ? true : { ...v, ex };
    });
  }
  await check("tenant A owner reading tenant B: nothing visible", async () => { const v = await view(U.owner, S.tenantB); return v.status === null && !v.evidenceVisible ? true : v; });
  await check("tenant B owner reads its own complete reconciliation (scoping is per tenant, not a blanket denial)", async () => { const v = await view(U.ownerB, S.tenantB); return v.evidenceVisible && v.status === "clean" ? true : v; });

  console.log("\n== Write surface: can a viewer forge readiness? (probed and reported, not assumed)");
  const probe = async (label, uid, sql, params, readBack) => {
    let outcome;
    try { const n = await asUser(uid, async (c) => (await c.query(sql, params)).rowCount); outcome = `accepted (${n} row${n === 1 ? "" : "s"})`; } catch (e) { outcome = `refused ${e.code ?? ""}`.trim(); }
    const after = await readBack();
    console.log(`  PROBE ${label}: ${outcome}; after → ${JSON.stringify(after)}`);
    return { outcome, after };
  };
  for (const [who, uid] of [["owner", U.owner], ["reviewer", U.reviewer], ["prepare-only", U.prepareOnly], ["outsider", U.outsider]]) {
    const up = await probe(`${who} UPDATE trial_balance_uploads.safisha_status='clean' (pending upload)`, uid,
      "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [S.pending], () => raw(S.pending));
    if (up.after.s === "clean") { findings.push(`CLIENT WRITE: ${who} can set trial_balance_uploads.safisha_status='clean' directly`); await setUploadStatus(S.pending, "needs_review"); }
    const rc = await probe(`${who} UPDATE safisha_reconciliations SET status='clean', matched_count=total_tb_lines (pending recon)`, uid,
      "UPDATE public.safisha_reconciliations SET status='clean', matched_count=total_tb_lines WHERE tb_upload_id=$1", [S.pending], () => raw(S.pending));
    if (rc.after.r === "clean") { findings.push(`CLIENT WRITE: ${who} can set safisha_reconciliations.status/matched_count directly`); await admin.query("UPDATE public.safisha_reconciliations SET status='needs_review', matched_count=3 WHERE tb_upload_id=$1", [S.pending]); }
    const ex = await probe(`${who} UPDATE safisha_exceptions SET reviewer_action='approved' (pending exception)`, uid,
      "UPDATE public.safisha_exceptions SET reviewer_action='approved' WHERE reconciliation_id IN (SELECT id FROM public.safisha_reconciliations WHERE tb_upload_id=$1)", [S.pending],
      async () => (await one("SELECT e.reviewer_action a FROM public.safisha_exceptions e JOIN public.safisha_reconciliations r ON r.id=e.reconciliation_id WHERE r.tb_upload_id=$1", [S.pending])));
    if (ex.after.a !== "pending") { findings.push(`CLIENT WRITE: ${who} can change safisha_exceptions.reviewer_action directly`); await admin.query("UPDATE public.safisha_exceptions SET reviewer_action='pending' WHERE reconciliation_id IN (SELECT id FROM public.safisha_reconciliations WHERE tb_upload_id=$1)", [S.pending]); }
  }
  await check("no viewer can approve an exception directly (reviewer decisions go only through the audited RPC)", async () => !findings.some((f) => f.includes("reviewer_action")) || findings.filter((f) => f.includes("reviewer_action")));

  console.log("\n== Server consumer: the gate MAONO uses (maono_check_safisha_gate)");
  await check("the MAONO gate treats the ESCALATED-but-'clean' upload as unblocked (server consumer of raw 'clean')", async () => {
    const rows = (await admin.query("SELECT * FROM public.maono_check_safisha_gate($1::uuid[])", [[S.escalated, S.partial, S.empty, S.complete]])).rows;
    const open = rows.filter((r) => r.is_blocked === false).map((r) => r.upload_id ?? r.id);
    if (open.length > 1) findings.push(`SERVER: maono_check_safisha_gate passes ${open.length} uploads whose reconciliation is not complete (escalated/partial/empty marked clean)`);
    return rows.length === 4 ? true : rows;
  });

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  console.log(`\nFINDINGS (${findings.length}):${findings.length ? "\n  - " + findings.join("\n  - ") : " none"}`);
  return failed;
}

let code = 1;
try { code = (await main()) === 0 ? 0 : 1; } catch (e) { console.error("FATAL", e); } finally { await stop(); }
process.exit(code);
