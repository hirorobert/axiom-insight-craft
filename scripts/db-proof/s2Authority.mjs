#!/usr/bin/env bun
// Real-PostgreSQL proof of 20261008100000_processing_attempt_authority.sql (S2: attempts, the fence, dependency revisions,
// read-time authority, preemption, lifecycle abandonment, lock order). Replays every migration before S2, records legacy
// state through the pre-S2 paths (a certification committed by commit_tb_certification), then:
//   upgrade      S2 in a transaction, rolled back, changes nothing; applied, the legacy certification stays as history and
//                is no longer authoritative (OD1), with the reason stated;
//   fence        processing fields, attempt fields, run inserts and certification inserts are refused for every role outside
//                the attempt functions; commit_tb_certification is retired; client writes keep S1's answer;
//   begin        claimed / replay / conflict / in progress; REPROCESS_REQUIRED, SOURCE_CHANGED, UPLOAD_NOT_ACTIVE,
//                IN_PROGRESS, COMPANY_REQUIRED; an expired lease is abandoned; the hold and the generation floor still apply;
//   finalize     certified → authoritative; failed → nothing certified; a late (non-current) worker changes nothing; a
//                dependency changed between snapshot and finalize fails the attempt; a change after finalize removes
//                authority at read time (mapping, decision, framework, currency, dictionary, an absent key created);
//   transitions  every state change is an append-only event; terminal states never change; an attempt changes state only
//                through the attempt functions;
//   preemption   an authorized reprocess request abandons the running attempt (PREEMPTED); an unauthorized one is refused
//                and recorded; lifecycle exits, lease expiry and the cut-over drain abandon attempts;
//   faults       a failure injected at each statement of finalize leaves every row unchanged;
//   concurrency  barriers observed in pg_stat_activity: concurrent begins, finalize vs preemption, review vs snapshot,
//                25-way begin;
//   locks        the interacting pairs complete in the canonical order in both interleavings; a reversed-order control
//                produces 40P01 (the test can detect a deadlock); bounded retry.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/s2Authority.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY local database) also works.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const S2_FILE = "20261008100000_processing_attempt_authority.sql";
const MODE = process.env.DB_PROOF_MODE ?? "embedded";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

const results = [];
let group = "";
const section = (n) => { group = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") { results.push({ group, name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)}`); }
  catch (e) { record(name, false, `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}`); }
}
async function refused(name, code, fn, messagePrefix = null) {
  try { await fn(); record(name, false, "no error was raised"); }
  catch (e) {
    const ok = e.code === code && (messagePrefix === null || String(e.message).startsWith(messagePrefix));
    record(name, ok, `expected ${code}${messagePrefix ? ` ${messagePrefix}` : ""}, got ${e.code}: ${String(e.message).split("\n")[0]}`);
  }
}

let pool; let admin; let server = null; let dir = null;
function assertLocal(u) {
  const url = new URL(u);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`REFUSED: ${url.hostname} is not loopback`);
  if (u.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project reference");
}
async function startDatabase() {
  if (MODE === "external") { assertLocal(process.env.DB_PROOF_CONN); return process.env.DB_PROOF_CONN; }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-s2-"));
  const port = 55000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE s2_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/s2_proof`;
}
// Every step of shutdown is bounded: the verdict is already printed, and the run must end with its exit code even when a
// connection the concurrency checks used is slow to close.
const bounded = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
async function stopDatabase() {
  await bounded(pool?.end(), 10000);
  await bounded(admin?.end(), 5000);
  if (server) await bounded(server.stop(), 20000);
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the server may still hold files */ } }
}
const uuid = () => crypto.randomUUID();
const hex64 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
const count = async (sql, p = []) => Number((await admin.query(sql, p)).rows[0].n);
async function as(role, uid, sql, p = []) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]);
    const r = await c.query(sql, p); await c.query("COMMIT"); return r.rows;
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
}
const asUser = (uid, sql, p) => as("authenticated", uid, sql, p);
const asService = (sql, p) => as("service_role", null, sql, p);

/** A dedicated session with an open transaction as `role`; the caller commits or rolls back. */
async function session(role, uid = null) {
  const c = await pool.connect();
  await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
  await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]);
  const pid = (await c.query("SELECT pg_backend_pid() p")).rows[0].p;
  return { c, pid, end: async (commit = true) => { try { await c.query(commit ? "COMMIT" : "ROLLBACK"); } finally { c.release(); } } };
}
/** Waits until backend `pid` is observed blocked on a lock (pg_stat_activity), or fails after `ms`. */
async function waitBlocked(pid, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await one("SELECT wait_event_type w, wait_event e FROM pg_stat_activity WHERE pid=$1", [pid]);
    if (r?.w === "Lock") return r.e;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`backend ${pid} was never observed waiting on a lock`);
}
const FINGERPRINT_SQL = `SELECT md5(string_agg(x, '|' ORDER BY x)) AS fp FROM (
  SELECT 'c:'||table_name||'.'||column_name||':'||data_type||':'||coalesce(column_default,'')||is_nullable AS x FROM information_schema.columns WHERE table_schema='public'
  UNION ALL SELECT 'f:'||p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid))||coalesce(array_to_string(p.proacl, ','),'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
  UNION ALL SELECT 't:'||tgname||':'||tgrelid::regclass::text FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'k:'||conname||':'||conrelid::regclass::text||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
  UNION ALL SELECT 'p:'||policyname||':'||tablename FROM pg_policies
  UNION ALL SELECT 'u:'||md5(coalesce((SELECT string_agg(to_jsonb(t)::text, ',' ORDER BY t.id) FROM public.trial_balance_uploads t), ''))
  UNION ALL SELECT 'r:'||md5(coalesce((SELECT string_agg(to_jsonb(r)::text, ',' ORDER BY r.id) FROM public.engine_runs r), ''))
) s`;
const fingerprint = async () => (await one(FINGERPRINT_SQL)).fp;

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 40 });
  // Idle connections dropped when the disposable server stops must not crash the run before its summary.
  admin.on("error", () => {}); pool.on("error", () => {});
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);
  const cut = files.indexOf(S2_FILE);
  const apply = async (f) => {
    let t = migrationSql(REPO, f);
    if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    try { await admin.query(t); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
  };

  section("Setup — every migration before S2, then legacy state through the pre-S2 paths");
  await check(`${S2_FILE} is in the chain and every earlier migration applies`, async () => {
    if (cut < 0) return "S2 missing";
    for (const f of files.slice(0, cut)) await apply(f);
    return true;
  });
  const U = { owner: uuid(), preparer: uuid(), viewer: uuid(), outsider: uuid(), ownerB: uuid(), opsAdmin: uuid(), unpaid: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [U.opsAdmin]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "SOLO", 0]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic A') RETURNING id", [U.owner])).id;
  // A workspace whose plan has ended: created while its licence was current (company creation is capacity-gated), then
  // the licence ends — as a real account reaches that state.
  const unpaidBc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [U.unpaid, prod])).id;
  const unpaidLic = (await one("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '2 days' FROM public.commercial_plans WHERE product_id=$2 AND code='SOLO' RETURNING id", [unpaidBc, prod])).id;
  const unpaidCo = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Unpaid') RETURNING id", [U.unpaid])).id;
  const unpaidUp = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, user_id) VALUES ('u.csv',$1,10,'processing',$2,2091,$3) RETURNING id`, [`${U.unpaid}/${uuid()}.csv`, unpaidCo, U.unpaid])).id;
  await admin.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end = now() - interval '1 day' WHERE id=$1", [unpaidLic]);
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic B') RETURNING id", [U.ownerB])).id;
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now()), ($1,$3,'viewer',now())", [A, U.preparer, U.viewer]);
  let yearSeq = 2000;
  const periods = new Map();
  async function upload(company = A, { status = "processing", year = ++yearSeq } = {}) {
    const owner = company === A ? U.owner : U.ownerB;
    const pid = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency) VALUES ($1,$2,$3,$4,'TZS') RETURNING id", [company, `${year}-12-31`, `FY${year}`, owner])).id;
    const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,10,$2,$3,$4,$5,$6) RETURNING id`, [`${owner}/${uuid()}.csv`, status, company, year, pid, owner])).id;
    periods.set(id, { year, pid, company });
    return id;
  }
  const decision = (code, name, cls, statement, normal) => ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement, classification: cls, normal_balance: normal });
  const reviewUp = await upload(A);
  await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, reviewUp, uuid(), JSON.stringify([decision("1000", "Bank", "current_assets", "balance_sheet", "debit"), decision("3000", "Capital", "equity", "balance_sheet", "credit")])]);

  // A legacy (pre-S2) accepted certification, through the previous engine's own path: run insert + commit_tb_certification.
  const legacyUp = await upload(A);
  const legacyHash = hex64("legacy-bytes");
  await asService("UPDATE public.trial_balance_uploads SET source_file_hash=$2 WHERE id=$1", [legacyUp, legacyHash]);
  const legacyRun = (await asService(`INSERT INTO public.engine_runs (company_id, actor_type, actor_user_id, function_name, engine_version, engine_generation, period_year, source_table, source_record_id)
    VALUES ($1,'workspace_user',$2,'process-trial-balance','safisha-tb-certification-v2',2,$3,'trial_balance_uploads',$4) RETURNING id`, [A, U.owner, periods.get(legacyUp).year, legacyUp]))[0].id;
  const legacyCert = (await asService("SELECT (public.commit_tb_certification($1,'process-trial-balance',$2,$3,$4,$5,'n','o',false,false,'[]'::jsonb,'[]'::jsonb))->>'certification_id' AS id",
    [legacyRun, legacyUp, A, periods.get(legacyUp).year, legacyHash]))[0].id;
  await check("before S2 the legacy certification is authoritative", async () =>
    (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, periods.get(legacyUp).year]))?.id === legacyCert);
  const legacyCertRow = JSON.stringify(await one("SELECT * FROM public.tb_certifications WHERE id=$1", [legacyCert]));

  section("Upgrade — rollback leaves nothing; legacy certifications stay as history and lose authority (OD1)");
  await check("S2 applied inside a transaction and rolled back changes nothing (schema, grants, functions, uploads, runs)", async () => {
    const before = await fingerprint();
    await admin.query("BEGIN"); try { await apply(S2_FILE); } finally { await admin.query("ROLLBACK"); }
    return before === (await fingerprint());
  });
  await check(`${S2_FILE} applies, and every later migration on top`, async () => { for (const f of files.slice(cut)) await apply(f); return true; });
  await check("the legacy certification is unchanged, kept, and no longer authoritative", async () =>
    JSON.stringify(await one("SELECT * FROM public.tb_certifications WHERE id=$1", [legacyCert])) === legacyCertRow
    && (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, periods.get(legacyUp).year])) === undefined);
  await check("tb_upload_authority states why (legacy_certification), for a member", async () => {
    const r = (await asUser(U.viewer, "SELECT public.tb_upload_authority($1) r", [legacyUp]))[0].r;
    return r.authoritative === false && r.reason === "legacy_certification" && r.certification_id === legacyCert ? true : r;
  });
  await refused("tb_upload_authority answers NOT_FOUND to an outsider (no existence leak)", "P0002", () => asUser(U.outsider, "SELECT public.tb_upload_authority($1)", [legacyUp]));

  // ── helpers over the attempt RPCs ──
  const SRC = hex64("source-bytes");
  const begin = (up, { reqId = uuid(), hash = "h-" + reqId, src = SRC, lease = 600, actor = U.owner, generation = 2 } = {}) =>
    asService("SELECT public.tb_begin_attempt($1,$2,$3,'in',$4,'safisha-tb-certification-v3',$5,'workspace_user',NULL,$6,$7) r",
      [up, reqId, hash, src, generation, actor, lease]).then((x) => x[0].r);
  const keysFor = (company, codes) => [...codes.flatMap((c) => [{ scope: company, key: `code:${c}` }, { scope: "global", key: `code:${c}` }]),
    { scope: company, key: "#framework" }, { scope: company, key: "#currency" }, { scope: "global", key: "#dictionary" }];
  const snapshot = (run, keys) => asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb) r", [run, JSON.stringify(keys)]).then((x) => x[0].r);
  const uploadFields = (status = "complete", isValid = true) => ({ status, is_valid: isValid, processing_result: { status: status === "complete" ? "valid" : status }, validation_report: { ok: true }, accounting_errors: [] });
  const certified = (extra = {}) => ({ outcome: "certified", upload: uploadFields(), certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: false, requires_review: false, exceptions: [], rows_snapshot: [], ...extra } });
  const finalize = (run, result) => asService("SELECT public.tb_finalize_attempt($1,$2::jsonb) r", [run, JSON.stringify(result)]).then((x) => x[0].r);
  const row = (id) => one("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [id]);
  const run = (id) => one("SELECT * FROM public.engine_runs WHERE id=$1", [id]);
  const authoritativeFor = async (up) => (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [periods.get(up).company, periods.get(up).year]))?.id ?? null;
  const reason = async (up) => (await asUser(U.owner, "SELECT public.tb_upload_authority($1) r", [up]))[0].r.reason;
  const reprocess = async (uid, up, op = uuid()) => (await asUser(uid, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [up, op, (await row(up)).source_file_hash]))[0].r;
  /** begin → snapshot → finalize(certified): returns { run, cert }. */
  async function certify(up, codes = ["1000", "3000"]) {
    const b = await begin(up);
    await snapshot(b.engine_run_id, keysFor(A, codes));
    const f = await finalize(b.engine_run_id, certified());
    return { run: b.engine_run_id, cert: f.certification_id, begin: b, finalize: f };
  }

  section("Fence — every role, outside the attempt functions");
  const fenceUp = await upload(A);
  await refused("the previous handler's status claim (service role) is refused: PROCESSING_FENCED", "PT409",
    () => asService("UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [fenceUp]), "PROCESSING_FENCED");
  await refused("the same write by the database owner is refused too", "PT409",
    () => admin.query("UPDATE public.trial_balance_uploads SET processing_result='{}'::jsonb WHERE id=$1", [fenceUp]), "PROCESSING_FENCED");
  await refused("the attempt pointer cannot be set directly", "PT409",
    () => asService("UPDATE public.trial_balance_uploads SET processing_attempt=1, current_engine_run_id=$2 WHERE id=$1", [fenceUp, legacyRun]));
  await refused("a client write keeps S1's answer (42501)", "42501",
    () => asUser(U.owner, "UPDATE public.trial_balance_uploads SET status='complete' WHERE id=$1", [fenceUp]));
  await refused("the previous handler's run insert (claimIdempotency) is refused: ATTEMPT_BEGIN_REQUIRED", "PT409",
    () => asService(`INSERT INTO public.engine_runs (company_id, actor_type, actor_user_id, function_name, engine_version, engine_generation, source_table, source_record_id)
      VALUES ($1,'workspace_user',$2,'process-trial-balance','v',2,'trial_balance_uploads',$3)`, [A, U.owner, fenceUp]), "ATTEMPT_BEGIN_REQUIRED");
  await refused("commit_tb_certification is retired: ENGINE_COMMIT_RETIRED", "PT410",
    () => asService("SELECT public.commit_tb_certification($1,'process-trial-balance',$2,$3,2001,'h','n','o',false,false,'[]'::jsonb,'[]'::jsonb)", [legacyRun, fenceUp, A]), "ENGINE_COMMIT_RETIRED");
  await refused("a direct certification insert is refused for the service role", "PT410",
    () => asService("INSERT INTO public.tb_certifications (company_id, upload_id, source_file_hash, normalized_input_hash, engine_run_id) VALUES ($1,$2,'h','n',$3)", [A, fenceUp, legacyRun]), "ENGINE_COMMIT_RETIRED");
  await check("other engines' runs are untouched by the fence", async () => {
    const r = await asService(`INSERT INTO public.engine_runs (company_id, actor_type, actor_user_id, function_name, engine_version) VALUES ($1,'workspace_user',$2,'kinga-tax-engine','v') RETURNING id`, [A, U.owner]);
    await asService("UPDATE public.engine_runs SET status='completed', completed_at=now() WHERE id=$1", [r[0].id]);
    return (await run(r[0].id)).status === "completed";
  });
  await refused("the attempt RPCs are not callable by a signed-in user", "42501", () => asUser(U.owner, "SELECT public.tb_begin_attempt($1,$2,'h','i',$3,'v',2,'workspace_user',NULL,$4,600)", [fenceUp, uuid(), SRC, U.owner]));

  section("Begin — outcomes");
  const up1 = await upload(A);
  const req1 = uuid();
  let b1;
  await check("claimed: run running as attempt 1 with a lease; the upload points at it (validating, source hash set)", async () => {
    b1 = await begin(up1, { reqId: req1 });
    const r = await run(b1.engine_run_id); const u = await row(up1);
    return b1.outcome === "claimed" && r.status === "running" && r.attempt_no === 1 && r.lease_expires_at !== null && r.engine_generation === 2
      && u.current_engine_run_id === b1.engine_run_id && u.processing_attempt === 1 && u.status === "validating" && u.source_file_hash === SRC ? true : { b1, r, u };
  });
  await check("the same request while running: in_progress (nothing new)", async () => {
    const r = await begin(up1, { reqId: req1 });
    return r.outcome === "in_progress" && r.engine_run_id === b1.engine_run_id && (await count("SELECT count(*) n FROM public.engine_runs WHERE source_record_id=$1", [up1])) === 1 ? true : r;
  });
  await check("the same request id with other content: conflict", async () => (await begin(up1, { reqId: req1, hash: "other" })).outcome === "conflict");
  await check("a new request while the lease is valid: refused IN_PROGRESS", async () => {
    const r = await begin(up1); return r.outcome === "refused" && r.code === "IN_PROGRESS" ? true : r;
  });
  await check("other source bytes: refused SOURCE_CHANGED", async () => {
    const r = await begin(up1, { src: hex64("other") }); return r.code === "SOURCE_CHANGED" ? true : r;
  });
  await check("finalize certified: authoritative, run completed, key completed, upload complete", async () => {
    await snapshot(b1.engine_run_id, keysFor(A, ["1000", "3000"]));
    const f = await finalize(b1.engine_run_id, certified());
    const r = await run(b1.engine_run_id); const u = await row(up1);
    const k = await one("SELECT * FROM public.idempotency_keys WHERE engine_run_id=$1", [b1.engine_run_id]);
    return f.outcome === "certified" && r.status === "completed" && k.status === "completed" && k.replay_result.reference_id === f.certification_id
      && u.status === "complete" && u.is_valid === true && (await authoritativeFor(up1)) === f.certification_id && (await reason(up1)) === "current" ? true : { f, r, k, u };
  });
  await check("the same request after it finished: replay of the recorded outcome (no new run)", async () => {
    const r = await begin(up1, { reqId: req1 });
    return r.outcome === "replay" && r.result.status === "completed" && (await count("SELECT count(*) n FROM public.engine_runs WHERE source_record_id=$1", [up1])) === 1 ? true : r;
  });
  await check("a new request on a certified upload: refused REPROCESS_REQUIRED (nothing changes)", async () => {
    const before = JSON.stringify(await row(up1));
    const r = await begin(up1);
    return r.code === "REPROCESS_REQUIRED" && JSON.stringify(await row(up1)) === before ? true : r;
  });
  await check("an upload with no company: refused COMPANY_REQUIRED", async () => {
    const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, user_id, period_year) VALUES ('p.csv',$1,10,'processing',$2,2090) RETURNING id`, [`${U.owner}/${uuid()}.csv`, U.owner])).id;
    const r = await begin(id); return r.code === "COMPANY_REQUIRED" ? true : r;
  });
  await check("invalid inputs are refused (lease bound, source hash form)", async () => {
    let n = 0;
    for (const o of [{ lease: 5 }, { lease: 99999 }, { src: "abc" }]) { try { await begin(up1, o); } catch (e) { if (e.code === "22023") n++; } }
    return n === 3 ? true : n;
  });

  section("Lease expiry, transitions and events");
  const upL = await upload(A);
  let bL;
  await check("an attempt whose lease expired is abandoned (LEASE_EXPIRED) by the next begin, which proceeds as attempt 2", async () => {
    bL = await begin(upL, { lease: 30 });
    await admin.query("SET session_replication_role = replica"); // test-only: age the lease (bypasses triggers)
    await admin.query("UPDATE public.engine_runs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [bL.engine_run_id]);
    await admin.query("SET session_replication_role = origin");
    const b2 = await begin(upL);
    const r1 = await run(bL.engine_run_id);
    return b2.outcome === "claimed" && b2.attempt_no === 2 && r1.status === "abandoned" && r1.error_code === "LEASE_EXPIRED" ? (bL = { first: bL, second: b2 }, true) : { b2, r1 };
  });
  await refused("the expired worker cannot finish: ATTEMPT_NOT_CURRENT", "PT409", () => finalize(bL.first.engine_run_id, certified()), "ATTEMPT_NOT_CURRENT");
  await check("every transition is an event, in order", async () => {
    const ev = (await admin.query("SELECT from_status, to_status, code FROM public.engine_run_events WHERE engine_run_id=$1 ORDER BY id", [bL.first.engine_run_id])).rows;
    return JSON.stringify(ev) === JSON.stringify([{ from_status: null, to_status: "running", code: null }, { from_status: "running", to_status: "abandoned", code: "LEASE_EXPIRED" }]) ? true : ev;
  });
  await refused("events cannot be edited", "42501", () => admin.query("UPDATE public.engine_run_events SET code='x'"));
  await refused("events cannot be deleted", "42501", () => admin.query("DELETE FROM public.engine_run_events"));
  await refused("a terminal attempt never changes again", "P0001", () => admin.query("UPDATE public.engine_runs SET status='completed', completed_at=now() WHERE id=$1", [bL.first.engine_run_id]));
  await refused("a running attempt changes state only through the attempt functions (even for the owner role)", "PT409",
    () => admin.query("UPDATE public.engine_runs SET status='failed', completed_at=now(), error_code='X' WHERE id=$1", [bL.second.engine_run_id]), "ATTEMPT_TRANSITION_FENCED");
  await check("tb_upload_authority flags a running attempt whose lease expired (the review screens offer Retry now)", async () => {
    const up = await upload(A); const b = await begin(up);
    const fresh = (await asUser(U.owner, "SELECT public.tb_upload_authority($1) r", [up]))[0].r;
    await admin.query("SET session_replication_role = replica"); // test-only: age the lease
    await admin.query("UPDATE public.engine_runs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [b.engine_run_id]);
    await admin.query("SET session_replication_role = origin");
    const aged = (await asUser(U.owner, "SELECT public.tb_upload_authority($1) r", [up]))[0].r;
    await reprocess(U.owner, up); // closes this attempt (PREEMPTED) so the expiry check below sees only its own
    return fresh.reason === "attempt_running" && fresh.current_attempt_lease_expired === false
      && aged.reason === "attempt_running" && aged.current_attempt_lease_expired === true ? true : { fresh, aged };
  });
  await check("tb_upload_attempts lists every attempt newest first, with how each ended (members only)", async () => {
    const list = (await asUser(U.viewer, "SELECT public.tb_upload_attempts($1) r", [upL]))[0].r;
    return Array.isArray(list) && list.length === 2 && list[0].attempt_no === 2 && list[1].attempt_no === 1
      && list[1].status === "abandoned" && list[1].code === "LEASE_EXPIRED" ? true : list;
  });
  await refused("tb_upload_attempts answers NOT_FOUND to an outsider", "P0002", () => asUser(U.outsider, "SELECT public.tb_upload_attempts($1)", [upL]));
  await check("tb_expire_attempts abandons an expired attempt (LEASE_EXPIRED) and nothing else", async () => {
    await admin.query("SET session_replication_role = replica");
    await admin.query("UPDATE public.engine_runs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [bL.second.engine_run_id]);
    await admin.query("SET session_replication_role = origin");
    const n = (await asService("SELECT public.tb_expire_attempts() n"))[0].n;
    const r = await run(bL.second.engine_run_id);
    return n === 1 && r.status === "abandoned" && r.error_code === "LEASE_EXPIRED" && (await run(b1.engine_run_id)).status === "completed" ? true : { n, r };
  });

  section("Failure outcomes and the dependency fence");
  await check("finalize failed: run failed with its code, key failed, upload error, nothing certified, not authoritative", async () => {
    const up = await upload(A); const b = await begin(up);
    const f = await finalize(b.engine_run_id, { outcome: "failed", error_code: "INVARIANT_VIOLATION", upload: uploadFields("error", false) });
    const r = await run(b.engine_run_id); const k = await one("SELECT * FROM public.idempotency_keys WHERE engine_run_id=$1", [b.engine_run_id]);
    return f.outcome === "failed" && r.status === "failed" && r.error_code === "INVARIANT_VIOLATION" && k.status === "failed"
      && (await row(up)).status === "error" && (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [up])) === 0
      && (await reason(up)) === "attempt_failed" ? true : { f, r, k };
  });
  await check("an accepted result without recorded dependencies is refused (DEPENDENCIES_REQUIRED); nothing changes", async () => {
    const up = await upload(A); const b = await begin(up);
    try { await finalize(b.engine_run_id, certified()); return "no error"; } catch (e) {
      return e.code === "55000" && /DEPENDENCIES_REQUIRED/.test(e.message) && (await run(b.engine_run_id)).status === "running" ? true : e.message;
    }
  });
  await check("a mapping changed between snapshot and finalize: the attempt fails DEPENDENCY_CHANGED, nothing certified", async () => {
    const up = await upload(A); const b = await begin(up);
    await snapshot(b.engine_run_id, keysFor(A, ["1000", "3000"]));
    await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, reviewUp, uuid(), JSON.stringify([decision("1000", "Bank", "non_current_assets", "balance_sheet", "debit")])]);
    const f = await finalize(b.engine_run_id, certified());
    return f.outcome === "failed" && f.error_code === "DEPENDENCY_CHANGED" && (await run(b.engine_run_id)).error_code === "DEPENDENCY_CHANGED"
      && (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [up])) === 0
      && (await row(up)).accounting_errors[0].code === "DEPENDENCY_CHANGED" ? true : f;
  });
  for (const [label, change] of [
    ["a mapping decision on a consulted account", async () => asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, reviewUp, uuid(), JSON.stringify([decision("3000", "Capital", "equity", "balance_sheet", "credit"), decision("1000", "Bank", "current_assets", "balance_sheet", "debit")])])],
    ["a non-reporting decision on a consulted account", async () => asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, reviewUp, uuid(), JSON.stringify([{ account_code: "3000", account_name: "Capital", decision_action: "MARK_NON_REPORTING_ACCOUNT" }])])],
    ["the reporting framework", async () => admin.query("UPDATE public.companies SET reporting_framework = CASE WHEN reporting_framework = 'full_ifrs' THEN 'ifrs_for_smes' ELSE 'full_ifrs' END WHERE id=$1", [A])],
    ["the period currency", async () => admin.query("UPDATE public.fiscal_periods SET reporting_currency='KES' WHERE company_id=$1 AND reporting_currency='TZS' AND id = (SELECT min(id::text)::uuid FROM public.fiscal_periods WHERE company_id=$1)", [A])],
    ["the keyword dictionary", async () => admin.query("INSERT INTO public.keyword_dictionary (term, language, classification, match_type) VALUES ($1,'en','current_assets','exact')", [`term-${uuid()}`])],
    ["a mapping created for an account that was absent", async () => asService(`INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, statement, classification, line_item, normal_balance) VALUES ($1,NULL,'7777','Shared new','balance_sheet','current_assets','x','debit')`, [U.owner])],
  ]) {
    await check(`after certification, a change to ${label} removes authority at read time (dependency_changed)`, async () => {
      // A fresh accepted certification first (re-checks go through a reprocess request).
      const up = await upload(A);
      const c = await certify(up, ["1000", "3000", "7777"]);
      const was = (await authoritativeFor(up)) === c.cert;
      await change();
      return was && (await authoritativeFor(up)) === null && (await reason(up)) === "dependency_changed" ? true : { was, now: await authoritativeFor(up), reason: await reason(up) };
    });
  }
  await check("a change to an account the run did NOT consult leaves authority intact", async () => {
    const up = await upload(A); const c = await certify(up, ["1000"]);
    await asService(`INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, statement, classification, line_item, normal_balance) VALUES ($1,NULL,'8888','Unrelated','balance_sheet','current_assets','x','debit')`, [U.owner]);
    return (await authoritativeFor(up)) === c.cert ? true : await reason(up);
  });
  await refused("dependencies are recorded once per attempt", "55000", async () => {
    const up = await upload(A); const b = await begin(up);
    await snapshot(b.engine_run_id, keysFor(A, ["1000"])); await snapshot(b.engine_run_id, keysFor(A, ["1000"]));
  }, "DEPENDENCIES_ALREADY_RECORDED");
  await refused("a snapshot naming another company's scope is refused", "22023", async () => {
    const up = await upload(A); const b = await begin(up); await snapshot(b.engine_run_id, [{ scope: B, key: "code:1000" }]);
  }, "INVALID_DEPENDENCIES");

  section("Preemption, lifecycle exits and the cut-over drain");
  await check("an authorized reprocess request preempts the running attempt (PREEMPTED); its worker can no longer finish", async () => {
    const up = await upload(A); const b = await begin(up);
    const r = await reprocess(U.owner, up);
    const run1 = await run(b.engine_run_id);
    let fenced = false; try { await finalize(b.engine_run_id, certified()); } catch (e) { fenced = e.code === "PT409"; }
    return r.outcome === "accepted" && r.preempted_engine_run_id === b.engine_run_id && run1.status === "abandoned" && run1.error_code === "PREEMPTED" && fenced
      && (await begin(up)).outcome === "claimed" ? true : { r, run1, fenced };
  });
  await check("an unauthorized request (viewer) is refused and recorded; the running attempt is untouched", async () => {
    const up = await upload(A); const b = await begin(up);
    const r = await reprocess(U.viewer, up);
    const rec = await one("SELECT outcome, code FROM public.tb_reprocess_requests WHERE operation_id=$1", [r.operation_id]);
    return r.outcome === "refused" && r.code === "CAPABILITY_REQUIRED" && rec.code === "CAPABILITY_REQUIRED" && (await run(b.engine_run_id)).status === "running" ? true : r;
  });
  await check("removing the upload from active use abandons its running attempt (UPLOAD_RETIRED); finalize is refused", async () => {
    const up = await upload(A); const b = await begin(up);
    await asUser(U.owner, "SELECT * FROM public.remove_trial_balance_upload($1,$2,'s2 proof')", [up, (await row(up)).version]);
    const r = await run(b.engine_run_id);
    let fenced = false; try { await finalize(b.engine_run_id, certified()); } catch (e) { fenced = e.code === "PT409"; }
    return r.status === "abandoned" && r.error_code === "UPLOAD_RETIRED" && fenced ? true : { r, fenced };
  });
  await check("the cut-over drain abandons pre-hold attempts (DRAINED_AT_CUTOVER), uploads before runs", async () => {
    const up = await upload(A); const b = await begin(up);
    const ver = Number((await one("SELECT version FROM public.processing_release_control")).version);
    await asUser(U.opsAdmin, "SELECT public.admin_set_processing_control(true,'{}'::uuid[],NULL,'s2 drain test',$1)", [ver]);
    await admin.query("SELECT pg_sleep(1.1)");
    const d = (await asUser(U.opsAdmin, "SELECT public.admin_drain_processing(1,'s2 drain test') r"))[0].r;
    const r = await run(b.engine_run_id);
    const ver2 = Number((await one("SELECT version FROM public.processing_release_control")).version);
    await asUser(U.opsAdmin, "SELECT public.admin_set_processing_control(false,'{}'::uuid[],NULL,'release',$1)", [ver2]);
    return r.status === "abandoned" && r.error_code === "DRAINED_AT_CUTOVER" && d.run_ids.includes(b.engine_run_id) && (await row(up)).status === "processing" ? true : { d, r };
  });
  await check("while held, begin is refused for the service role (PT503) and the floor still applies (PT410)", async () => {
    const up = await upload(A);
    let ver = Number((await one("SELECT version FROM public.processing_release_control")).version);
    await asUser(U.opsAdmin, "SELECT public.admin_set_processing_control(true,'{}'::uuid[],NULL,'hold',$1)", [ver]);
    let held = null; try { await begin(up); } catch (e) { held = e.code; }
    ver = Number((await one("SELECT version FROM public.processing_release_control")).version);
    await asUser(U.opsAdmin, "SELECT public.admin_set_processing_control(false,'{}'::uuid[],2,'floor 2',$1)", [ver]);
    let floor = null; try { await begin(up, { generation: 1 }); } catch (e) { floor = e.code; }
    return held === "PT503" && floor === "PT410" ? true : { held, floor };
  });

  section("Fault injection — a failure at each statement of finalize leaves every row unchanged");
  const faults = [
    ["tb_certifications insert", "tb_certifications", "BEFORE INSERT"],
    ["upload processing-field update", "trial_balance_uploads", "BEFORE UPDATE"],
    ["engine run completion", "engine_runs", "BEFORE UPDATE"],
    ["idempotency key completion", "idempotency_keys", "BEFORE UPDATE"],
    ["the lifecycle transition the certification drives", "trial_balance_upload_lifecycle_events", "BEFORE INSERT"],
  ];
  await admin.query(`CREATE OR REPLACE FUNCTION public.__s2_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_FAULT' USING ERRCODE = 'XX001'; END; $$`);
  for (const [label, table, timing] of faults) {
    await check(`fault at ${label}: finalize raises and nothing changes; without the fault it succeeds`, async () => {
      const exists = (await one("SELECT to_regclass($1) r", [`public.${table}`])).r;
      if (!exists) return `${table} does not exist`;
      const up = await upload(A); const b = await begin(up);
      await snapshot(b.engine_run_id, keysFor(A, ["1000"]));
      const snap = async () => JSON.stringify([await row(up), await run(b.engine_run_id),
        await one("SELECT * FROM public.idempotency_keys WHERE engine_run_id=$1", [b.engine_run_id]),
        await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [up]),
        await count("SELECT count(*) n FROM public.engine_run_events WHERE engine_run_id=$1", [b.engine_run_id])]);
      const before = await snap();
      await admin.query(`CREATE TRIGGER __s2_fault ${timing} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.__s2_fault()`);
      let raised = null;
      try { await finalize(b.engine_run_id, certified()); } catch (e) { raised = e.code; } finally { await admin.query(`DROP TRIGGER __s2_fault ON public.${table}`); }
      const unchanged = before === (await snap());
      const ok = await finalize(b.engine_run_id, certified());
      return raised === "XX001" && unchanged && ok.outcome === "certified" ? true : { raised, unchanged, ok };
    });
  }

  section("Concurrency — barriers observed in pg_stat_activity");
  await check("two begins on one upload: the second waits on the first, then sees it (IN_PROGRESS); one run", async () => {
    const up = await upload(A);
    const s1 = await session("service_role");
    await s1.c.query("SELECT public.tb_begin_attempt($1,$2,'h1','i',$3,'v',2,'workspace_user',NULL,$4,600)", [up, uuid(), SRC, U.owner]);
    const s2 = await session("service_role");
    const p2 = s2.c.query("SELECT public.tb_begin_attempt($1,$2,'h2','i',$3,'v',2,'workspace_user',NULL,$4,600) r", [up, uuid(), SRC, U.owner]);
    await waitBlocked(s2.pid);
    await s1.end(true);
    const r2 = (await p2).rows[0].r; await s2.end(true);
    return r2.code === "IN_PROGRESS" && (await count("SELECT count(*) n FROM public.engine_runs WHERE source_record_id=$1", [up])) === 1 ? true : r2;
  });
  await check("finalize vs preemption: the reprocess request waits on the finalizing upload lock, then invalidates the new certification", async () => {
    const up = await upload(A); const b = await begin(up);
    await snapshot(b.engine_run_id, keysFor(A, ["1000"]));
    const s1 = await session("service_role");
    await s1.c.query("SELECT public.tb_finalize_attempt($1,$2::jsonb)", [b.engine_run_id, JSON.stringify(certified())]);
    const s2 = await session("authenticated", U.owner);
    const p2 = s2.c.query("SELECT public.tbu_request_reprocess($1,$2,$3) r", [up, uuid(), SRC]);
    await waitBlocked(s2.pid);
    await s1.end(true);
    const r2 = (await p2).rows[0].r; await s2.end(true);
    const cert = await one("SELECT id FROM public.tb_certifications WHERE upload_id=$1", [up]);
    return r2.outcome === "accepted" && r2.invalidated_certification_id === cert.id && !r2.preempted_engine_run_id && (await authoritativeFor(up)) === null ? true : r2;
  });
  await check("review vs snapshot: the snapshot waits on the review's account lock, then records the new revision", async () => {
    const up = await upload(A); const b = await begin(up);
    const s1 = await session("authenticated", U.owner);
    await s1.c.query("SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, reviewUp, uuid(), JSON.stringify([decision("1000", "Bank", "current_assets", "balance_sheet", "debit")])]);
    const s2 = await session("service_role");
    const p2 = s2.c.query("SELECT public.tb_snapshot_dependencies($1,$2::jsonb)", [b.engine_run_id, JSON.stringify(keysFor(A, ["1000"]))]);
    const waited = await waitBlocked(s2.pid);
    await s1.end(true);
    await p2; await s2.end(true);
    const rec = await one("SELECT revision FROM public.engine_run_dependencies WHERE engine_run_id=$1 AND scope=$2 AND dep_key='code:1000'", [b.engine_run_id, A]);
    const cur = await one("SELECT revision FROM public.tb_dependency_revisions WHERE scope=$1 AND dep_key='code:1000'", [A]);
    return waited === "advisory" && Number(rec.revision) === Number(cur.revision) ? true : { waited, rec, cur };
  });
  await check("25 concurrent begins with distinct requests on one upload: exactly one claimed, the rest IN_PROGRESS", async () => {
    const up = await upload(A);
    const rs = await Promise.all(Array.from({ length: 25 }, () => begin(up)));
    const claimed = rs.filter((r) => r.outcome === "claimed").length;
    const inProgress = rs.filter((r) => r.code === "IN_PROGRESS").length;
    return claimed === 1 && inProgress === 24 && (await count("SELECT count(*) n FROM public.engine_runs WHERE source_record_id=$1", [up])) === 1 ? true : { claimed, inProgress };
  });

  section("Lock pairs — canonical order in both interleavings; reversed-order control; bounded retry");
  // Each pair: session X takes its locks and holds them; session Y starts and is observed waiting; X commits; Y completes.
  // No 40P01 in either order. The control acquires the same two rows in reversed orders and must produce 40P01.
  async function pair(name, first, second) {
    await check(`T-LOCK ${name}: completes in both interleavings, no deadlock`, async () => {
      for (const [x, y] of [[first, second], [second, first]]) {
        const ctx = await x.prepare();
        const sx = await session(x.role, x.uid); await x.run(sx.c, ctx);
        const sy = await session(y.role, y.uid);
        const py = y.run(sy.c, ctx).then(() => null, (e) => e);
        await waitBlocked(sy.pid);
        await sx.end(true);
        const err = await py;
        await sy.end(err === null);
        if (err && err.code === "40P01") return `${name}: deadlock`;
        if (err && !y.mayFail?.(err)) return `${name}: ${err.code} ${err.message}`;
      }
      return true;
    });
  }
  const preempt = { role: "authenticated", uid: U.owner, run: (c, ctx) => c.query("SELECT public.tbu_request_reprocess($1,$2,$3)", [ctx.up, uuid(), SRC]) };
  const fin = { role: "service_role", run: (c, ctx) => c.query("SELECT public.tb_finalize_attempt($1,$2::jsonb)", [ctx.run, JSON.stringify(certified())]), mayFail: (e) => e.code === "PT409" };
  const prepAttempt = async () => { const up = await upload(A); const b = await begin(up); await snapshot(b.engine_run_id, keysFor(A, ["1000"])); return { up, run: b.engine_run_id }; };
  await pair("finalize ↔ preemption (upload → run)", { ...fin, prepare: prepAttempt }, { ...preempt, prepare: prepAttempt });
  const removeU = { role: "authenticated", uid: U.owner, run: async (c, ctx) => c.query("SELECT * FROM public.remove_trial_balance_upload($1,(SELECT version FROM public.trial_balance_uploads WHERE id=$1),'lock pair')", [ctx.up]) };
  await pair("finalize ↔ lifecycle exit (upload → run)", { ...fin, prepare: prepAttempt }, { ...removeU, prepare: prepAttempt });
  // The expiry pass contends only for an attempt whose lease has expired (it is still current until abandoned).
  const expire = { role: "service_role", run: (c) => c.query("SELECT public.tb_expire_attempts()") };
  const prepExpired = async () => {
    const ctx = await prepAttempt();
    await admin.query("SET session_replication_role = replica"); // test-only: age the lease (bypasses triggers)
    await admin.query("UPDATE public.engine_runs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [ctx.run]);
    await admin.query("SET session_replication_role = origin");
    return ctx;
  };
  await pair("finalize ↔ expiry pass (upload → run)", { ...fin, prepare: prepExpired }, { ...expire, prepare: prepExpired });
  await check("T-LOCK control: the same two rows taken in reversed orders deadlock (40P01) — the test can see a deadlock", async () => {
    const { up, run: r } = await prepAttempt();
    const s1 = await session("postgres"); const s2 = await session("postgres");
    await s1.c.query("SELECT 1 FROM public.engine_runs WHERE id=$1 FOR UPDATE", [r]);       // run first (the retired order)
    await s2.c.query("SELECT 1 FROM public.trial_balance_uploads WHERE id=$1 FOR UPDATE", [up]); // upload first (canonical)
    const p1 = s1.c.query("SELECT 1 FROM public.trial_balance_uploads WHERE id=$1 FOR UPDATE", [up]).then(() => null, (e) => e);
    await waitBlocked(s1.pid);
    const p2 = s2.c.query("SELECT 1 FROM public.engine_runs WHERE id=$1 FOR UPDATE", [r]).then(() => null, (e) => e);
    const [e1, e2] = await Promise.all([p1, p2]);
    await s1.end(false); await s2.end(false);
    return [e1?.code, e2?.code].includes("40P01") ? true : [e1?.code, e2?.code];
  });
  // The discard functions S2 reordered: upload (L4) before operation (L6).
  const discardOp = async () => {
    const up = await upload(A);
    const d = (await asUser(U.owner, "SELECT * FROM public.discard_trial_balance_upload($1,$2)", [up, (await row(up)).version]))[0];
    return { up, op: d.operation_id };
  };
  const completeD = { role: "authenticated", uid: U.owner, run: (c, ctx) => c.query("SELECT * FROM public.complete_trial_balance_discard($1)", [ctx.op]) };
  const lockUpload = { role: "service_role", run: (c, ctx) => c.query("SELECT 1 FROM public.trial_balance_uploads WHERE id=$1 FOR UPDATE", [ctx.up]) };
  await pair("discard completion ↔ an upload-row writer (upload → operation)", { ...completeD, prepare: discardOp }, { ...lockUpload, prepare: discardOp });
  await check("T-LOCK control: the retired operation → upload order against the new completion deadlocks (40P01)", async () => {
    const { up, op } = await discardOp();
    const s1 = await session("postgres"); const s2 = await session("authenticated", U.owner);
    await s1.c.query("SELECT 1 FROM public.trial_balance_upload_operations WHERE id=$1 FOR UPDATE", [op]); // the old order: operation first
    const p2 = s2.c.query("SELECT * FROM public.complete_trial_balance_discard($1)", [op]).then(() => null, (e) => e); // upload, then operation
    await waitBlocked(s2.pid);
    const p1 = s1.c.query("SELECT 1 FROM public.trial_balance_uploads WHERE id=$1 FOR UPDATE", [up]).then(() => null, (e) => e);
    const [e1, e2] = await Promise.all([p1, p2]);
    return [e1?.code, e2?.code].includes("40P01") ? true : [e1?.code, e2?.code];
  });
  await check("bounded retry: an operation refused by a deadlock succeeds on retry within 3 attempts", async () => {
    const { up } = await prepAttempt();
    let attempts = 0; let last = null;
    for (; attempts < 3; attempts++) {
      try { await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3)", [up, uuid(), SRC]); last = null; break; }
      catch (e) { last = e; if (e.code !== "40P01") break; }
    }
    return last === null && attempts < 3 ? true : last?.code;
  });

  section("Prior contracts of the re-created functions, on S2's schema");
  for (const [label, who, mk, code] of [
    ["an outsider", U.outsider, async () => upload(A), "NOT_A_MEMBER_OF_COMPANY"],
    ["a viewer", U.viewer, async () => upload(A), "CAPABILITY_REQUIRED"],
    ["an owner whose plan ended", U.unpaid, async () => unpaidUp, "ENTITLEMENT_REQUIRED"],
    ["a source path bound elsewhere", U.owner, async () => {
      const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, user_id) VALUES ('u.csv','elsewhere/x.csv',10,'processing',$1,2092,$2) RETURNING id`, [A, U.owner])).id;
      return id; }, "SOURCE_NOT_BOUND"],
  ]) {
    await check(`reprocess request by ${label}: refused ${code}, recorded, and replayed as the same refusal`, async () => {
      const up = await mk(); const op = uuid();
      const r1 = (await asUser(who, "SELECT public.tbu_request_reprocess($1,$2,NULL) r", [up, op]))[0].r;
      const r2 = (await asUser(who, "SELECT public.tbu_request_reprocess($1,$2,NULL) r", [up, op]))[0].r;
      const rec = await one("SELECT outcome, code FROM public.tb_reprocess_requests WHERE operation_id=$1", [op]);
      return r1.outcome === "refused" && r1.code === code && rec?.code === code && r2.outcome === "refused" && r2.replayed === true && r2.code === code ? true : { r1, r2, rec };
    });
  }
  await check("reprocess request: SOURCE_CHANGED for a stale expected hash; UPLOAD_NOT_ACTIVE for a retired upload and for one pending discard", async () => {
    const a = await upload(A); const b = await begin(a);
    await snapshot(b.engine_run_id, keysFor(A, ["1000"])); await finalize(b.engine_run_id, certified());
    const changed = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [a, uuid(), hex64("stale")]))[0].r;
    const retired = await upload(A); await certify(retired, ["1000"]);
    const removed = (await asUser(U.owner, "SELECT * FROM public.remove_trial_balance_upload($1,$2,'contracts')", [retired, (await row(retired)).version]))[0];
    const notActive = await reprocess(U.owner, retired);
    const { up: pending } = await discardOp();
    const pendingDiscard = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,NULL) r", [pending, uuid()]))[0].r;
    return changed.code === "SOURCE_CHANGED" && (await row(retired)).lifecycle_state === "retired" && notActive.code === "UPLOAD_NOT_ACTIVE"
      && pendingDiscard.code === "UPLOAD_NOT_ACTIVE" ? true : { changed, removed, notActive, pendingDiscard };
  });
  await check("reprocess request: accepted once with one invalidation; the same operation replays; reused with other content is a conflict", async () => {
    const up = await upload(A); const c = await certify(up, ["1000"]);
    const op = uuid();
    const r1 = await reprocess(U.owner, up, op);
    const r2 = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [up, op, SRC]))[0].r;
    const conflict = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [up, op, hex64("x")]))[0].r;
    const inv = await count("SELECT count(*) n FROM public.tb_certification_invalidations WHERE certification_id=$1", [c.cert]);
    return r1.outcome === "accepted" && r1.invalidated_certification_id === c.cert && r2.outcome === "replayed" && conflict.outcome === "conflict" && inv === 1
      && (await authoritativeFor(up)) === null && (await row(up)).status === "processing" ? true : { r1, r2, conflict, inv };
  });
  await check("after the reprocess request a new attempt certifies and is authoritative again (no fallback to the invalidated one)", async () => {
    const up = await upload(A); const first = await certify(up, ["1000"]);
    await reprocess(U.owner, up);
    const mid = await authoritativeFor(up);
    const second = await certify(up, ["1000"]);
    return mid === null && (await authoritativeFor(up)) === second.cert && second.cert !== first.cert && (await row(up)).processing_attempt === 2 ? true : { mid, second };
  });
  await check("discard -> complete still works for an unprocessed upload (the row is gone, the operation completed)", async () => {
    const { up, op } = await discardOp();
    const done = (await asUser(U.owner, "SELECT * FROM public.complete_trial_balance_discard($1)", [op]))[0];
    return done.outcome === "deleted_now" && (await row(up)) === undefined ? true : done;
  });
  await check("the stale-discard sweeper aborts a discard left pending past its grace (upload kept, operation aborted)", async () => {
    const { up, op } = await discardOp();
    await admin.query("SET session_replication_role = replica"); // test-only: age the operation
    await admin.query("UPDATE public.trial_balance_upload_operations SET created_at = now() - interval '30 days' WHERE id=$1", [op]);
    await admin.query("SET session_replication_role = origin");
    const r = (await asService("SELECT public.tbu_sweeper_complete('stale_discard',$1) r", [op]))[0].r;
    const o = await one("SELECT state FROM public.trial_balance_upload_operations WHERE id=$1", [op]);
    return r === "aborted" && o.state === "aborted" && (await row(up)).lifecycle_state !== "discard_pending" ? true : { r, o };
  });
  await check("the drain left historical uploads alone (a retired upload left 'validating' was not re-queued)", async () => {
    const hist = await one("SELECT id, status FROM public.trial_balance_uploads WHERE lifecycle_state NOT IN ('active_unprocessed','active_processing','active_processed','blocked') AND status='validating' LIMIT 1");
    return hist !== undefined && hist.status === "validating" ? true : "no historical validating upload to observe";
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }

// The verdict is decided and printed BEFORE the disposable server stops; while it stops, only a connection the server
// itself terminated is tolerated (anything else still fails the run).
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "S2_AUTHORITY: ALL PASSED" : "S2_AUTHORITY: FAILED");
process.on("uncaughtException", (e) => {
  if (/Connection terminated unexpectedly/.test(String(e?.message))) return;
  console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1);
});
await stopDatabase();
process.exit(ok ? 0 : 1);
