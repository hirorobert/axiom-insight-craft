#!/usr/bin/env node
// Real-PostgreSQL proof of 20261004100000_reconciliation_server_authority.sql: reconciliation readiness is a server fact.
//
//   Upgrade     every migration before this one is replayed on an empty database; legacy reconciliations recorded by the
//               OLD code (an escalated exception marked 'clean'; a matcher 'clean') are kept byte-identical by the
//               migration, and the MAONO gate then blocks the escalated one;
//   Preserved   the client writes the product still makes behave IDENTICALLY before and after; the one removed on purpose
//               (a client inserting an exception) is shown accepted before and refused after;
//   Match       safisha_record_match_result is service-role only, re-checks the actor (owner, partner, preparer allowed;
//               viewer, Prepare-only, outsider, another tenant, no actor refused with nothing recorded), validates every
//               finding against this reconciliation's own rows, DERIVES the counts and records 'clean' only for complete
//               coverage; retries are idempotent;
//   Decisions   escalated, pending and rejected stay unresolved; an escalated exception is decided only by a different
//               holder of review_close; approved and rejected are final; rejected investigate → blocked;
//   Freshness   a trial-balance line added to a 'clean' reconciliation re-opens it; a changed finding re-opens review;
//   Concurrency 25 simultaneous match runs; 25 mixed decisions and match runs; two decisions on one exception; a line
//               ingested during a match run — no deadlock, no duplicate, the verdict always equals the rows;
//   Forgery     owner, partner, preparer, viewer, Prepare-only, outsider and tenant B cannot write readiness, counts,
//               completion, decisions or exceptions, re-point an exception, TRUNCATE, or call the RPCs/helpers; the
//               service role itself cannot record an incomplete 'clean';
//   Gate        maono_check_safisha_gate unblocks only complete reconciliations;
//   Re-apply    applying the migration again changes nothing.
//
//   DB_PROOF_MODULES_DIR=<dir with node_modules/pg + embedded-postgres> node ./scripts/db-proof/reconciliationAuthority.mjs
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
  pool = new Pool({ connectionString: u.toString(), ssl: false, max: 40 });
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
/** Every row of every table, digested. withoutNewColumn: compare row VALUES across the migration, which adds one nullable
 *  column (safisha_audit_log.decision_basis) — its absence/NULL is asserted separately. */
async function snapshot(withoutNewColumn = false) {
  const tables = (await admin.query(`SELECT format('%I.%I', schemaname, tablename) t FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg\\_%' ORDER BY 1`)).rows.map((r) => r.t);
  const out = {};
  const row = withoutNewColumn ? "(to_jsonb(x) - 'decision_basis')::text" : "x::text";
  for (const t of tables) {
    const r = (await admin.query(`SELECT count(*)::int n, md5(coalesce(string_agg(${row}, E'\\n' ORDER BY ${row}), '')) h FROM ${t} x`)).rows[0];
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}
const diff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

async function main() {
  await start();
  const files = fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  // This proof applies the chain up to and including its migration; later migrations (e.g. 20261005100000, evidence
  // ingestion) are proven by their own proofs.
  const cut = files.indexOf(MIGRATION);
  if (cut < 0) throw new Error(`${MIGRATION} is missing`);
  console.log(`\n== Setup (synthetic users, disposable database ${PROOF_DB})`);
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  for (const f of files.slice(0, cut)) await apply(f);
  console.log(`  migrations applied before ${MIGRATION}: ${cut}`);

  const U = { owner: uuid(), reviewer: uuid(), preparer: uuid(), viewer: uuid(), prepareOnly: uuid(), outsider: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 6], [U.outsider, "SOLO", 0], [U.ownerB, "SOLO", 0]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Tenant A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Tenant B') RETURNING id", [U.ownerB])).id;
  // partner: prepare_close + review_close; preparer: prepare_close only; viewer: neither; Prepare-only: a grant of
  // prepare_trial_balance and nothing else.
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'partner',now()), ($1,$3,'preparer',now()), ($1,$4,'viewer',now())", [A, U.reviewer, U.preparer, U.viewer]);
  await as(U.owner, (c) => c.query("SELECT * FROM public.grant_workspace_capability($1,$2,'prepare_trial_balance')", [A, U.prepareOnly]));

  let year = 2000;
  const upload = async (company = A, owner = U.owner) => { year += 1; return (await one(
    "INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ($1,$2,10,'complete',$3,$4,$5) RETURNING id",
    [`tb-${year}.csv`, `workspaces/${company}/${uuid()}/tb-${year}.csv`, company, year, owner])).id; };
  const recon = async (up, client = U.owner) => (await one("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing') RETURNING id", [client, up])).id;
  const tbLine = async (r) => (await one("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash) VALUES ($1,'tb','1000',$2) RETURNING id", [r, uuid()])).id;
  const bankLine = async (r) => (await one("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash) VALUES ($1,'bank','1000',$2) RETURNING id", [r, uuid()])).id;
  /** One matcher finding, as safisha-match sends it. */
  const finding = (tb, { category = "investigate", evidence = null, variance = 10, matchType = evidence ? "one_to_one" : "unmatched" } = {}) => ({
    reconciliation_id: "ignored-by-the-database", account_code: "1000", account_name: "Cash", category, variance, age_days: 0,
    tb_txn_id: tb, evidence_txn_id: evidence, match_type: matchType, description: "synthetic finding", reviewer_action: "pending", reviewer_id: null, resolved_at: null,
  });
  /** A reconciliation with `lines` TB lines; `findings` are the matcher findings for the first `excepted` lines. */
  const fixture = async ({ lines, excepted = 0, category = "investigate", company = A, owner = U.owner } = {}) => {
    const up = await upload(company, owner); const r = await recon(up, owner); const tb = [];
    for (let i = 0; i < lines; i += 1) tb.push(await tbLine(r));
    await admin.query("UPDATE public.trial_balance_uploads SET safisha_status='processing' WHERE id=$1", [up]);
    return { up, r, tb, findings: tb.slice(0, excepted).map((t) => finding(t, { category })) };
  };
  const state = async (f) => one("SELECT u.safisha_status s, r.status r, r.matched_count m, r.total_tb_lines t, r.exception_count e, r.completed_at IS NOT NULL done, r.sealed FROM public.trial_balance_uploads u JOIN public.safisha_reconciliations r ON r.tb_upload_id=u.id WHERE u.id=$1", [f.up]);
  const exceptionIds = async (f) => (await admin.query("SELECT id FROM public.safisha_exceptions WHERE reconciliation_id=$1 ORDER BY created_at, id", [f.r])).rows.map((x) => x.id);
  const decide = (exc, reviewer, action) => attempt("service", "SELECT public.safisha_decide_exception($1,$2,$3,'synthetic decision') r", [exc, reviewer, action]);
  const legacyResolve = (exc, reviewer, action) => attempt("service", "SELECT public.safisha_resolve_exception($1,$2,$3,'synthetic decision') r", [exc, reviewer, action]);
  const recordMatch = (r, actor, findings = [], caller = "service") => attempt(caller, "SELECT public.safisha_record_match_result($1,$2,$3::jsonb) r", [r, actor, JSON.stringify(findings)]);
  const gate = async (ups) => Object.fromEntries((await admin.query("SELECT upload_id, is_blocked FROM public.maono_check_safisha_gate($1::uuid[])", [ups])).rows.map((r) => [r.upload_id, r.is_blocked]));
  const verdictOf = async (f) => { const c = (await admin.query("SELECT * FROM public.safisha_reconciliation_coverage($1)", [f.r])).rows[0];
    return c.rejected_investigate > 0 ? "blocked" : c.complete ? "clean" : "needs_review"; };

  // ── The product's own client writes, run (and rolled back) before and after the migration ──────────────────────────
  const P = await fixture({ lines: 2 });
  await admin.query("INSERT INTO public.safisha_exceptions (reconciliation_id,account_code,category,variance,tb_txn_id) VALUES ($1,'1000','investigate',10,$2)", [P.r, P.tb[0]]);
  await admin.query("UPDATE public.trial_balance_uploads SET safisha_status='needs_review' WHERE id=$1", [P.up]);
  await admin.query("UPDATE public.safisha_reconciliations SET status='needs_review' WHERE id=$1", [P.r]);
  const Q = await upload();
  const legit = [
    ["owner: Overview/Account Review retry — upload status processing, processing_result cleared", U.owner, "UPDATE public.trial_balance_uploads SET status='processing', processing_result=NULL WHERE id=$1", [P.up]],
    ["owner: uploads-panel retry — status, processing_result, accounting_errors, is_valid cleared", U.owner, "UPDATE public.trial_balance_uploads SET status='processing', processing_result=NULL, accounting_errors=NULL, is_valid=NULL WHERE id=$1", [P.up]],
    ["owner: ingest — upload safisha_status processing", U.owner, "UPDATE public.trial_balance_uploads SET safisha_status='processing' WHERE id=$1", [P.up]],
    ["owner: ingest — create a reconciliation as processing", U.owner, "INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($2,$1,'processing')", [Q, U.owner]],
    ["owner: ingest — trial-balance row", U.owner, "INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash) VALUES ($1,'tb','1000','h')", [P.r]],
    ["reviewer: ingest — evidence row", U.reviewer, "INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash) VALUES ($1,'bank','1000','h')", [P.r]],
    ["owner: re-match — delete pending exceptions (refused by the audit gate; must stay refused)", U.owner, "DELETE FROM public.safisha_exceptions WHERE reconciliation_id=$1 AND reviewer_action='pending'", [P.r], 0],
    ["reviewer: upload retry (outside the reviewer's upload policies; must stay a 0-row no-op)", U.reviewer, "UPDATE public.trial_balance_uploads SET status='processing', processing_result=NULL WHERE id=$1", [P.up], 0],
    ["reviewer: categorize — reconciliation needs_review", U.reviewer, "UPDATE public.safisha_reconciliations SET status='needs_review' WHERE id=$1", [P.r]],
    ["owner: score — confidence_score", U.owner, "UPDATE public.safisha_reconciliations SET confidence_score=80 WHERE id=$1", [P.r]],
  ];
  const runLegit = async () => { const out = []; for (const [, who, sql, p] of legit) out.push(await attempt(who, sql, p, true)); return out; };
  const expectedRows = (i) => legit[i][4];
  const legitBefore = await runLegit();
  // The one client write this migration removes on purpose: exceptions become server-recorded (safisha-match records
  // them through safisha_record_match_result).
  const clientException = () => attempt(U.owner, "INSERT INTO public.safisha_exceptions (reconciliation_id,account_code,category,variance,tb_txn_id) VALUES ($1,'1000','timing',1,$2)", [P.r, P.tb[1]], true);
  const clientExceptionBefore = await clientException();

  // ── Legacy state recorded by the pre-migration code paths ──────────────────────────────────────────────────────────
  const LE = await fixture({ lines: 2 });                                 // the OLD resolver: escalated → 'clean'
  const LEx = (await one("INSERT INTO public.safisha_exceptions (reconciliation_id,account_code,category,variance,tb_txn_id) VALUES ($1,'1000','investigate',10,$2) RETURNING id", [LE.r, LE.tb[0]])).id;
  await admin.query("UPDATE public.safisha_reconciliations SET status='needs_review', matched_count=1, exception_count=1, total_tb_lines=2 WHERE id=$1", [LE.r]);
  await legacyResolve(LEx, U.owner, "escalated");
  const LC = await fixture({ lines: 2 });                                 // the OLD matcher: no exceptions → 'clean'
  await admin.query("UPDATE public.safisha_reconciliations SET status='clean', matched_count=2, total_tb_lines=2 WHERE id=$1", [LC.r]);
  await admin.query("UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [LC.up]);

  /** A read-only report file, run as the operator would: inside BEGIN READ ONLY … ROLLBACK. */
  const readOnlyReport = async (file) => {
    const c = await pool.connect();
    try { await c.query("BEGIN READ ONLY"); const r = await c.query(fs.readFileSync(path.join(REPO, "scripts/db-preflight", file), "utf8")); await c.query("ROLLBACK"); return r.rows; }
    finally { c.release(); }
  };
  const asMap = (rows) => Object.fromEntries(rows.map((r) => [r.item, r.n === null || r.n === undefined ? r.ok : Number(r.n)]));

  console.log("\n== Preflight (before the migration): read-only, and it counts exactly the legacy rows");
  await check("reconciliationAuthorityPreflight.sql changes nothing and reports the one legacy escalated-but-clean upload", async () => {
    const s0 = await snapshot(); const m = asMap(await readOnlyReport("reconciliationAuthorityPreflight.sql")); const d = diff(s0, await snapshot());
    const want = { clean_reconciliation_not_latest_ok: 1, clean_upload_line_count_mismatch: 0, clean_upload_with_open_exception: 1, clean_upload_without_tb_lines: 0, escalated_exceptions: 1 };
    return d.length === 0 && JSON.stringify(m) === JSON.stringify(want) ? true : { m, d };
  });

  console.log("\n== Upgrade: applying the migration changes no row");
  await check("before the migration the old resolver marked an ESCALATED reconciliation and its upload 'clean' (the defect)", async () => { const s = await state(LE); return s.r === "clean" && s.s === "clean" ? true : s; });
  const before = await snapshot(true);
  const auditRowsBefore = Number((await one("SELECT count(*) n FROM public.safisha_audit_log")).n);
  await apply(MIGRATION);
  await check("every value of every row of every table is unchanged after the migration (the one new column aside)", async () => { const d = diff(before, await snapshot(true)); return d.length === 0 ? true : d; });
  await check("the one table change: safisha_audit_log.decision_basis, nullable, NULL on every existing row", async () => {
    const col = await one("SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='safisha_audit_log' AND column_name='decision_basis'");
    const nn = Number((await one("SELECT count(*) n FROM public.safisha_audit_log WHERE decision_basis IS NOT NULL")).n);
    return col?.is_nullable === "YES" && col.data_type === "text" && nn === 0 && auditRowsBefore > 0 ? true : { col, nn, auditRowsBefore };
  });
  await check("the MAONO gate now BLOCKS the legacy escalated-but-'clean' upload and still passes the legacy complete one", async () => { const g = await gate([LE.up, LC.up]); return g[LE.up] === true && g[LC.up] === false ? true : g; });
  await check("reconciliationAuthorityVerify.sql (after the migration): read-only, every check true, the legacy row counted", async () => {
    const s0 = await snapshot(); const rows = await readOnlyReport("reconciliationAuthorityVerify.sql"); const d = diff(s0, await snapshot()); const m = asMap(rows);
    return d.length === 0 && rows.every((r) => r.ok === true) && m.legacy_clean_uploads_not_complete === 1 && m.legacy_clean_reconciliations_not_complete === 1 ? true : { rows, d };
  });

  console.log("\n== Preserved: the product's client writes behave identically before and after");
  const legitAfter = await runLegit();
  for (let i = 0; i < legit.length; i += 1) {
    await check(`${legit[i][0]}: identical before and after (${legitAfter[i].ok ? `${legitAfter[i].rows} row(s)` : `refused ${legitAfter[i].code}`})`, async () => {
      const same = legitBefore[i].ok === legitAfter[i].ok && legitBefore[i].rows === legitAfter[i].rows && legitBefore[i].code === legitAfter[i].code;
      const expected = expectedRows(i) === undefined ? legitAfter[i].ok && legitAfter[i].rows > 0 : (legitAfter[i].ok ? legitAfter[i].rows === expectedRows(i) : true);
      return same && expected ? true : { before: legitBefore[i], after: legitAfter[i] };
    });
  }
  await check("intended change: a client could insert a pending exception before; now refused 42501 (exceptions are server-recorded)", async () => {
    const after = await clientException(); return clientExceptionBefore.ok && !after.ok && after.code === "42501" ? true : { before: clientExceptionBefore, after };
  });

  console.log("\n== Match: service role only, authorized actor, findings validated, counts derived, clean only when complete");
  const M1 = await fixture({ lines: 3 });
  await admin.query("UPDATE public.safisha_reconciliations SET matched_count=999 WHERE id=$1", [M1.r]); // stored counts are not authority
  for (const [who, caller] of [["anon", "anon"], ["owner (client)", U.owner], ["reviewer (client)", U.reviewer]]) {
    await check(`${who} cannot call safisha_record_match_result`, async () => { const r = await recordMatch(M1.r, U.owner, [], caller); return !r.ok && r.code === "42501" ? true : r; });
  }
  for (const [who, actor] of [["viewer", U.viewer], ["Prepare-only", U.prepareOnly], ["outsider", U.outsider], ["tenant B owner", U.ownerB], ["no actor", null]]) {
    await check(`service role acting for ${who} is refused 42501, nothing recorded`, async () => { const s0 = await snapshot(); const r = await recordMatch(M1.r, actor); const d = diff(s0, await snapshot()); return !r.ok && r.code === "42501" && d.length === 0 ? true : { r, d }; });
  }
  await check("owner: 3 of 3 lines matched → clean; counts derived (3/3, not the stored 999); upload clean", async () => {
    const r = await recordMatch(M1.r, U.owner); const s = await state(M1);
    return r.ok && s.r === "clean" && s.s === "clean" && s.m === 3 && s.t === 3 && s.e === 0 && s.done ? true : { r, s };
  });
  const Other = await fixture({ lines: 1 });
  const MV = await fixture({ lines: 2 }); const mvBank = await bankLine(MV.r);
  const invalid = [
    ["a finding naming another reconciliation's line", [finding(Other.tb[0])]],
    ["a finding whose evidence line is a trial-balance line", [finding(MV.tb[0], { evidence: MV.tb[1] })]],
    ["a finding with an unknown category", [finding(MV.tb[0], { category: "ignore" })]],
    ["a finding without a variance", [{ ...finding(MV.tb[0]), variance: null }]],
    ["a malformed line id", [{ ...finding(MV.tb[0]), tb_txn_id: "not-a-uuid" }]],
  ];
  for (const [label, payload] of invalid) {
    await check(`${label} is refused 22023 and nothing is recorded`, async () => { const s0 = await snapshot(); const r = await recordMatch(MV.r, U.owner, payload); const d = diff(s0, await snapshot()); return !r.ok && r.code === "22023" && d.length === 0 ? true : { r, d }; });
  }
  await check("a non-array payload is refused 22023", async () => { const r = await attempt("service", "SELECT public.safisha_record_match_result($1,$2,'{}'::jsonb)", [MV.r, U.owner]); return !r.ok && r.code === "22023" ? true : r; });
  await check("a valid evidence-linked finding is accepted", async () => { const r = await recordMatch(MV.r, U.owner, [finding(MV.tb[0], { evidence: mvBank, category: "timing" })]); const s = await state(MV); return r.ok && s.r === "needs_review" && s.m === 1 && s.t === 2 ? true : { r, s }; });
  const M2 = await fixture({ lines: 0 });
  await check("empty (no trial-balance lines) is refused 22023 and stays unrecorded", async () => { const r = await recordMatch(M2.r, U.owner); const s = await state(M2); return !r.ok && r.code === "22023" && s.r === "processing" ? true : { r, s }; });
  const M3 = await fixture({ lines: 4, excepted: 2 });
  await check("reviewer: 2 of 4 lines with findings → needs_review, matched 2/4, 2 exceptions recorded", async () => { const r = await recordMatch(M3.r, U.reviewer, M3.findings); const s = await state(M3); return r.ok && s.r === "needs_review" && s.s === "needs_review" && s.m === 2 && s.t === 4 && s.e === 2 && r.data[0].r.exceptions_recorded === 2 ? true : { r, s }; });
  await check("retry with the same findings is idempotent: nothing new recorded, same ids, same state", async () => {
    const ids0 = await exceptionIds(M3); const s0 = await state(M3); const r = await recordMatch(M3.r, U.reviewer, M3.findings);
    const ids1 = await exceptionIds(M3); const s1 = await state(M3);
    return r.ok && r.data[0].r.exceptions_recorded === 0 && r.data[0].r.exceptions_already_recorded === 2 && JSON.stringify(ids0) === JSON.stringify(ids1) && JSON.stringify(s0) === JSON.stringify(s1) ? true : { r, ids0, ids1, s0, s1 };
  });
  const MS = await fixture({ lines: 1 });
  await admin.query("UPDATE public.safisha_reconciliations SET sealed=true WHERE id=$1", [MS.r]);
  await check("a sealed reconciliation is refused (55000)", async () => { const r = await recordMatch(MS.r, U.owner); return !r.ok && r.code === "55000" ? true : r; });

  console.log("\n== Decisions: escalated, pending and rejected stay unresolved; escalation needs a different senior reviewer");
  const [m3a, m3b] = await exceptionIds(M3);
  for (const [who, actor] of [["viewer", U.viewer], ["Prepare-only", U.prepareOnly], ["outsider", U.outsider], ["tenant B owner", U.ownerB]]) {
    await check(`${who} as reviewer is refused 42501`, async () => { const r = await decide(m3a, actor, "approved"); return !r.ok && r.code === "42501" ? true : r; });
  }
  await check("owner (client) cannot call the decision or the legacy resolver directly", async () => {
    const a = await attempt(U.owner, "SELECT public.safisha_decide_exception($1,$2,'approved')", [m3a, U.owner]);
    const b = await attempt(U.owner, "SELECT public.safisha_resolve_exception($1,$2,'approved')", [m3a, U.owner]);
    return !a.ok && a.code === "42501" && !b.ok && b.code === "42501" ? true : { a, b };
  });
  await check("preparer approves one of two → still needs_review (one pending)", async () => { const r = await decide(m3a, U.preparer, "approved"); const s = await state(M3); return r.ok && s.r === "needs_review" && s.s === "needs_review" ? true : { r, s }; });
  await check("an approved decision is final (55000)", async () => { const r = await decide(m3a, U.owner, "rejected"); return !r.ok && r.code === "55000" ? true : r; });
  await check("preparer ESCALATES the last → needs_review, never clean", async () => { const r = await decide(m3b, U.preparer, "escalated"); const s = await state(M3); return r.ok && r.data[0].r.recon_status === "needs_review" && s.r === "needs_review" && s.s === "needs_review" && !s.done ? true : { r, s }; });
  await check("re-escalating is refused (55000)", async () => { const r = await decide(m3b, U.owner, "escalated"); return !r.ok && r.code === "55000" ? true : r; });
  await check("a preparer (prepare_close without review_close) cannot decide an escalated exception (42501)", async () => { const r = await decide(m3b, U.preparer, "approved"); return !r.ok && r.code === "42501" ? true : r; });
  await check("a partner decides the escalated exception → approved → clean, upload clean", async () => { const r = await decide(m3b, U.reviewer, "approved"); const s = await state(M3); return r.ok && s.r === "clean" && s.s === "clean" && s.done ? true : { r, s }; });
  await check("the audit log keeps the escalation and the senior decision, each with its basis", async () => {
    const rows = (await admin.query("SELECT action, reviewer_id, decision_basis FROM public.safisha_audit_log WHERE exception_id=$1 ORDER BY logged_at, id", [m3b])).rows;
    const pending = (await admin.query("SELECT decision_basis FROM public.safisha_audit_log WHERE exception_id=$1", [m3a])).rows;
    return rows.length === 2 && rows[0].action === "escalated" && rows[0].reviewer_id === U.preparer && rows[0].decision_basis === "prepare_close"
      && rows[1].action === "approved" && rows[1].reviewer_id === U.reviewer && rows[1].decision_basis === "separate_review_close"
      && pending.length === 1 && pending[0].decision_basis === "prepare_close" ? true : { rows, pending };
  });
  await check("firm workspace: the OWNER who escalated cannot decide their own escalation (no owner exemption); a partner can", async () => {
    const F = await fixture({ lines: 1, excepted: 1 }); await recordMatch(F.r, U.owner, F.findings); const [x] = await exceptionIds(F);
    const esc = await decide(x, U.owner, "escalated"); const self = await decide(x, U.owner, "approved"); const other = await decide(x, U.reviewer, "approved"); const s = await state(F);
    const basis = (await one("SELECT decision_basis FROM public.safisha_audit_log WHERE exception_id=$1 AND action='approved'", [x]))?.decision_basis;
    return esc.ok && !self.ok && self.code === "42501" && /SEPARATE_REVIEWER_REQUIRED/.test(self.message) && other.ok && s.r === "clean" && basis === "separate_review_close" ? true : { esc, self, other, s, basis };
  });
  const SD = await fixture({ lines: 1, excepted: 1 }); await recordMatch(SD.r, U.owner, SD.findings); const [sd] = await exceptionIds(SD);
  await check("the partner who escalated cannot decide the same exception (SEPARATE_REVIEWER_REQUIRED, 42501); another senior can", async () => {
    await decide(sd, U.reviewer, "escalated"); const self = await decide(sd, U.reviewer, "approved"); const other = await decide(sd, U.owner, "rejected"); const s = await state(SD);
    // The finding is an investigate exception: the senior rejection blocks the reconciliation.
    return !self.ok && self.code === "42501" && /SEPARATE_REVIEWER_REQUIRED/.test(self.message) && other.ok && s.r === "blocked" && s.s === "blocked" ? true : { self, other, s };
  });
  const E2 = await fixture({ lines: 3, excepted: 2 }); await recordMatch(E2.r, U.owner, E2.findings); const [e2a, e2b] = await exceptionIds(E2);
  await check("approved + escalated → needs_review", async () => { await decide(e2a, U.reviewer, "approved"); const r = await decide(e2b, U.owner, "escalated"); const s = await state(E2); return r.ok && s.r === "needs_review" && s.s === "needs_review" ? true : { r, s }; });
  const RN = await fixture({ lines: 2, excepted: 1, category: "needs_adjustment" }); await recordMatch(RN.r, U.owner, RN.findings); const [rn] = await exceptionIds(RN);
  await check("REJECTED needs_adjustment → needs_review, never clean", async () => { const r = await decide(rn, U.reviewer, "rejected"); const s = await state(RN); return r.ok && s.r === "needs_review" && s.s === "needs_review" ? true : { r, s }; });
  const RI = await fixture({ lines: 2, excepted: 1 }); await recordMatch(RI.r, U.owner, RI.findings); const [ri] = await exceptionIds(RI);
  await check("REJECTED investigate → blocked (and a re-run of the matcher keeps it blocked)", async () => { const r = await decide(ri, U.reviewer, "rejected"); const rr = await recordMatch(RI.r, U.owner, RI.findings); const s = await state(RI); return r.ok && rr.ok && s.r === "blocked" && s.s === "blocked" ? true : { r, rr, s }; });
  await check("the legacy name decides through the same authority (escalated stays open)", async () => {
    const L = await fixture({ lines: 1, excepted: 1 }); await recordMatch(L.r, U.owner, L.findings); const [x] = await exceptionIds(L);
    const r = await legacyResolve(x, U.preparer, "escalated"); const s = await state(L); return r.ok && s.r === "needs_review" && s.s === "needs_review" ? true : { r, s };
  });

  console.log("\n== Personal workspace: the explicit, audited sole-owner exception");
  // A company-less upload owned by U.owner (its personal workspace): the owner is the only person who can act.
  const personal = async (lines, excepted) => {
    year += 1;
    const up = (await one("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ($1,$2,10,'complete',NULL,$3,$4) RETURNING id",
      [`personal-${year}.csv`, `${U.owner}/${uuid()}/personal-${year}.csv`, year, U.owner])).id;
    const r = await recon(up, U.owner); const tb = []; for (let i = 0; i < lines; i += 1) tb.push(await tbLine(r));
    return { up, r, tb, findings: tb.slice(0, excepted).map((t) => finding(t)) };
  };
  const PW = await personal(2, 1);
  await check("only the owner records the match in a personal workspace (anyone else 42501)", async () => {
    const other = await recordMatch(PW.r, U.reviewer, PW.findings); const own = await recordMatch(PW.r, U.owner, PW.findings); const s = await state(PW);
    return !other.ok && other.code === "42501" && own.ok && s.r === "needs_review" ? true : { other, own, s };
  });
  const [pw] = await exceptionIds(PW);
  await check("the owner escalates (basis personal_workspace_owner); nobody else can decide it (42501)", async () => {
    const esc = await decide(pw, U.owner, "escalated");
    const others = await Promise.all([U.reviewer, U.preparer, U.outsider, U.ownerB].map((u) => decide(pw, u, "approved")));
    const basis = (await one("SELECT decision_basis FROM public.safisha_audit_log WHERE exception_id=$1 AND action='escalated'", [pw]))?.decision_basis;
    const s = await state(PW);
    return esc.ok && others.every((o) => !o.ok && o.code === "42501") && basis === "personal_workspace_owner" && s.r === "needs_review" ? true : { esc, others: others.map((o) => o.code), basis, s };
  });
  await check("the sole owner decides their own escalation → approved → clean, audited as personal_sole_owner_escalation", async () => {
    const r = await decide(pw, U.owner, "approved"); const s = await state(PW);
    const rows = (await admin.query("SELECT action, reviewer_id, decision_basis FROM public.safisha_audit_log WHERE exception_id=$1 ORDER BY logged_at, id", [pw])).rows;
    return r.ok && s.r === "clean" && s.s === "clean" && rows.length === 2 && rows[1].action === "approved" && rows[1].reviewer_id === U.owner
      && rows[1].decision_basis === "personal_sole_owner_escalation" ? true : { r, s, rows };
  });
  await check("the exception is personal-only: a firm-workspace escalation can never be audited as personal_sole_owner_escalation", async () => {
    const n = Number((await one(`SELECT count(*) n FROM public.safisha_audit_log a JOIN public.safisha_reconciliations r ON r.id=a.reconciliation_id
      JOIN public.trial_balance_uploads u ON u.id=r.tb_upload_id WHERE a.decision_basis IN ('personal_workspace_owner','personal_sole_owner_escalation') AND u.company_id IS NOT NULL`)).n);
    const bad = await attempt("service", "INSERT INTO public.safisha_audit_log (exception_id,reconciliation_id,reviewer_id,action,decision_basis) VALUES ($1,$2,$3,'approved','owner_override')", [pw, PW.r, U.owner]);
    return n === 0 && !bad.ok && bad.code === "23514" ? true : { n, bad };
  });

  console.log("\n== Retries and freshness: a decided finding is never re-opened; new trial-balance lines re-open 'clean'");
  await check("re-running the matcher after approval keeps M3 clean and records nothing new", async () => { const r = await recordMatch(M3.r, U.owner, M3.findings); const s = await state(M3); return r.ok && r.data[0].r.exceptions_recorded === 0 && s.r === "clean" && s.s === "clean" ? true : { r, s }; });
  await check("a CHANGED finding on an approved line is recorded as new and re-opens review", async () => {
    const r = await recordMatch(M3.r, U.owner, [finding(M3.tb[0], { variance: 11 })]); const s = await state(M3);
    return r.ok && r.data[0].r.exceptions_recorded === 1 && s.r === "needs_review" && s.s === "needs_review" ? true : { r, s };
  });
  await check("a trial-balance line ingested into a CLEAN reconciliation returns it and its upload to needs_review; the gate blocks it", async () => {
    const before = await state(M1); const r = await attempt(U.owner, "INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash) VALUES ($1,'tb','2000',$2)", [M1.r, uuid()]);
    const s = await state(M1); const g = await gate([M1.up]);
    return before.r === "clean" && r.ok && s.r === "needs_review" && s.s === "needs_review" && !s.done && g[M1.up] === true ? true : { before, r, s, g };
  });
  await check("an evidence line does not re-open a clean reconciliation", async () => {
    const F = await fixture({ lines: 1 }); await recordMatch(F.r, U.owner); const r = await attempt(U.owner, "INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash) VALUES ($1,'bank','1000',$2)", [F.r, uuid()]);
    const s = await state(F); return r.ok && s.r === "clean" && s.s === "clean" ? true : { r, s };
  });
  await check("the matcher re-run then covers the new line: 4/4 matched → clean again", async () => { const r = await recordMatch(M1.r, U.owner); const s = await state(M1); return r.ok && s.r === "clean" && s.t === 4 && s.m === 4 ? true : { r, s }; });
  await check("a recorded line count that differs from the stored lines is never complete", async () => {
    const F = await fixture({ lines: 2 }); await recordMatch(F.r, U.owner);
    const c = (await admin.query("SELECT complete FROM public.safisha_reconciliation_coverage($1, 3)", [F.r])).rows[0].complete; return c === false ? true : c;
  });

  console.log("\n== Concurrency: match and decisions serialize on the reconciliation lock; no deadlock, no lost verdict");
  const codes = (rs) => rs.map((r) => (r.ok ? "ok" : r.code));
  await check("25 simultaneous identical match runs: all succeed, each finding recorded once", async () => {
    const C = await fixture({ lines: 6, excepted: 3 });
    const rs = await Promise.all(Array.from({ length: 25 }, () => recordMatch(C.r, U.owner, C.findings)));
    const n = (await exceptionIds(C)).length; const s = await state(C);
    return rs.every((r) => r.ok) && n === 3 && s.r === "needs_review" && s.m === 3 ? true : { codes: [...new Set(codes(rs))], n, s };
  });
  await check("25 operations mixing decisions on every exception and match re-runs: no deadlock, final verdict = verdict from rows", async () => {
    const C = await fixture({ lines: 12, excepted: 12 }); await recordMatch(C.r, U.owner, C.findings); const ids = await exceptionIds(C);
    const ops = [...ids.map((x) => () => decide(x, U.preparer, "approved")), ...Array.from({ length: 13 }, () => () => recordMatch(C.r, U.owner, C.findings))];
    const rs = await Promise.all(ops.sort(() => Math.random() - 0.5).map((f) => f()));
    const s = await state(C); const v = await verdictOf(C);
    return !codes(rs).includes("40P01") && rs.every((r) => r.ok) && s.r === v && s.s === v && v === "clean" ? true : { codes: [...new Set(codes(rs))], s, v };
  });
  await check("two simultaneous decisions on one exception: exactly one succeeds, the other is refused 55000", async () => {
    const C = await fixture({ lines: 1, excepted: 1 }); await recordMatch(C.r, U.owner, C.findings); const [x] = await exceptionIds(C);
    const rs = await Promise.all([decide(x, U.preparer, "approved"), decide(x, U.reviewer, "rejected")]);
    const ok = rs.filter((r) => r.ok).length; const s = await state(C); const v = await verdictOf(C);
    return ok === 1 && rs.some((r) => !r.ok && r.code === "55000") && s.r === v ? true : { codes: codes(rs), s, v };
  });
  await check("a trial-balance line ingested while a match run holds the lock is never lost from the verdict", async () => {
    const C = await fixture({ lines: 2 });
    const rs = await Promise.all([recordMatch(C.r, U.owner), attempt(U.owner, "INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash) VALUES ($1,'tb','3000',$2)", [C.r, uuid()])]);
    const s = await state(C); const lines = Number((await one("SELECT count(*) n FROM public.safisha_transactions WHERE reconciliation_id=$1 AND source_id='tb'", [C.r])).n);
    // Either order is valid; what must never happen is 'clean' while a stored line was not part of the recorded run.
    return rs.every((r) => r.ok) && (s.r !== "clean" || s.t === lines) && (s.s === s.r || s.s === "needs_review") ? true : { codes: codes(rs), s, lines };
  });

  console.log("\n== Forgery: no client user can write readiness directly");
  const E = await fixture({ lines: 2, excepted: 1 }); await recordMatch(E.r, U.owner, E.findings);
  const people = [["owner", U.owner], ["reviewer", U.reviewer], ["preparer", U.preparer], ["viewer", U.viewer], ["Prepare-only", U.prepareOnly], ["outsider", U.outsider], ["tenant B owner", U.ownerB]];
  const forgeries = [
    ["upload safisha_status → clean", "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", (f) => [f.up]],
    ["upload safisha_status → blocked", "UPDATE public.trial_balance_uploads SET safisha_status='blocked' WHERE id=$1", (f) => [f.up]],
    ["reconciliation status → clean", "UPDATE public.safisha_reconciliations SET status='clean' WHERE id=$1", (f) => [f.r]],
    ["reconciliation matched_count → total", "UPDATE public.safisha_reconciliations SET matched_count=total_tb_lines WHERE id=$1", (f) => [f.r]],
    ["reconciliation total_tb_lines / exception_count → 0", "UPDATE public.safisha_reconciliations SET total_tb_lines=0, exception_count=0 WHERE id=$1", (f) => [f.r]],
    ["reconciliation completed_at / sealed", "UPDATE public.safisha_reconciliations SET completed_at=now(), sealed=true WHERE id=$1", (f) => [f.r]],
    ["exception reviewer_action → approved", "UPDATE public.safisha_exceptions SET reviewer_action='approved' WHERE reconciliation_id=$1", (f) => [f.r]],
    ["exception re-pointed to another trial-balance line", "UPDATE public.safisha_exceptions SET tb_txn_id=$2 WHERE reconciliation_id=$1", (f) => [f.r, f.tb[1]]],
    ["exception inserted", "INSERT INTO public.safisha_exceptions (reconciliation_id,account_code,category,variance,tb_txn_id) VALUES ($1,'1000','timing',1,$2)", (f) => [f.r, f.tb[1]]],
    ["TRUNCATE of the exceptions", "TRUNCATE public.safisha_exceptions, public.safisha_audit_log", () => []],
  ];
  // Where the caller can reach the row through row-level security, the refusal must be this migration's (or the audit
  // gate's) explicit error; elsewhere existing row-level security already reaches nothing (0 rows). Uploads are
  // updatable by the owner only; reconciliations by holders of prepare_close (owner, partner, preparer); exceptions have
  // no client UPDATE policy; exception inserts and TRUNCATE are refused for every client.
  const reachable = (who, label) => (label.startsWith("upload") && who === "owner")
    || (label.startsWith("reconciliation") && ["owner", "reviewer", "preparer"].includes(who))
    || label === "exception inserted" || label.startsWith("TRUNCATE");
  for (const [who, uid] of people) {
    for (const [label, sql, params] of forgeries) {
      await check(`${who}: ${label} — refused, nothing changes`, async () => {
        const s0 = await snapshot(); const r = await attempt(uid, sql, params(E)); const d = diff(s0, await snapshot());
        const explicit = reachable(who, label) ? !r.ok && r.code === "42501" : !r.ok || r.rows === 0;
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
  await check("tenant B cannot read tenant A's completeness (security invoker: false, never a leak)", async () => { const r = await attempt(U.ownerB, "SELECT public.safisha_reconciliation_complete($1) c", [M3.r]); return r.ok && r.data[0].c === false ? true : r; });
  await check("the owner reads its own completeness", async () => { const r = await attempt(U.owner, "SELECT public.safisha_reconciliation_complete($1) c", [M1.r]); return r.ok && r.data[0].c === true ? true : r; });
  await check("anon cannot call the completeness readers", async () => { const r = await attempt("anon", "SELECT public.safisha_reconciliation_complete($1)", [M1.r]); return !r.ok && r.code === "42501" ? true : r; });
  await check("no client or service role can call the internal helpers", async () => {
    const rs = [await attempt(U.owner, "SELECT public._safisha_record_verdict($1)", [E.r]), await attempt("service", "SELECT public._safisha_record_verdict($1)", [E.r]),
      await attempt("service", "SELECT public._safisha_authorize($1,$2,'prepare_close')", [E.r, U.owner])];
    return rs.every((r) => !r.ok && r.code === "42501") ? true : codes(rs);
  });

  console.log("\n== Even the service role cannot record an incomplete 'clean'");
  await check("service role: needs_review reconciliation status → clean refused (23514)", async () => { const r = await attempt("service", "UPDATE public.safisha_reconciliations SET status='clean' WHERE id=$1", [E.r]); return !r.ok && r.code === "23514" ? true : r; });
  await check("service role: needs_review upload safisha_status → clean refused (23514)", async () => { const r = await attempt("service", "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [E.up]); return !r.ok && r.code === "23514" ? true : r; });
  await check("service role: never-matched upload safisha_status → clean refused (23514)", async () => { const r = await attempt("service", "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [M2.up]); return !r.ok && r.code === "23514" ? true : r; });
  await check("service role: rejected (needs_adjustment) upload safisha_status → clean refused (23514)", async () => { const r = await attempt("service", "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [RN.up]); return !r.ok && r.code === "23514" ? true : r; });
  await check("service role: an exception cannot be re-pointed or decided outside the decision function", async () => {
    const a = await attempt("service", "UPDATE public.safisha_exceptions SET tb_txn_id=$2 WHERE reconciliation_id=$1", [E.r, E.tb[1]]);
    const b = await attempt("service", "UPDATE public.safisha_exceptions SET reviewer_action='approved' WHERE reconciliation_id=$1", [E.r]);
    return !a.ok && !b.ok ? true : { a, b };
  });

  console.log("\n== The MAONO gate unblocks only complete reconciliations");
  await check("complete (M1 re-matched, legacy complete) unblocked; escalated, approved+escalated, rejected, re-opened, never matched, legacy escalated blocked", async () => {
    const g = await gate([M1.up, LC.up, E.up, E2.up, RN.up, RI.up, M2.up, M3.up, LE.up]);
    const ok = [M1.up, LC.up].every((u) => g[u] === false) && [E.up, E2.up, RN.up, RI.up, M2.up, M3.up, LE.up].every((u) => g[u] === true);
    return ok ? true : g;
  });
  await check("the gate stays service-role only", async () => { const r = await attempt(U.owner, "SELECT * FROM public.maono_check_safisha_gate($1::uuid[])", [[M1.up]]); return !r.ok && r.code === "42501" ? true : r; });

  await check("reconciliationAuthorityVerify.sql at the end of the run: every check still true", async () => { const rows = await readOnlyReport("reconciliationAuthorityVerify.sql"); return rows.every((r) => r.ok === true) ? true : rows; });

  console.log("\n== Re-apply");
  await check("applying the migration again changes no row and leaves one of each trigger", async () => {
    const s0 = await snapshot(); await apply(MIGRATION); const d = diff(s0, await snapshot());
    const t = (await admin.query("SELECT tgrelid::regclass::text || '.' || tgname n FROM pg_trigger WHERE tgname IN ('ab_reconciliation_authority','ab_upload_reconciliation_status_authority','ab_exception_authority','ac_reconciliation_freshness') ORDER BY 1")).rows.map((x) => x.n);
    return d.length === 0 && JSON.stringify(t) === JSON.stringify(["safisha_exceptions.ab_exception_authority", "safisha_exceptions.ac_reconciliation_freshness", "safisha_reconciliations.ab_reconciliation_authority", "safisha_transactions.ac_reconciliation_freshness", "trial_balance_uploads.ab_upload_reconciliation_status_authority"]) ? true : { d, t };
  });

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}

let code = 1;
try { code = (await main()) === 0 ? 0 : 1; } catch (e) { console.error("FATAL", e); } finally { await stop(); }
process.exit(code);
