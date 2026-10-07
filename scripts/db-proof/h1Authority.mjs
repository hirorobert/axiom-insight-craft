#!/usr/bin/env bun
// Real-PostgreSQL proof of 20261007100000_treatment_authority_and_processing_control.sql (H1a processing control, H1b
// CONFIRM_ACCOUNT_TREATMENT). Replays every migration before H1, records a review batch through the pre-H1 RPC, then:
//   upgrade   H1 inside a transaction, rolled back, changes nothing; the pre-H1 batch replays byte-identically after H1;
//   control   admin-only, versioned, reasoned, recorded; the hold refuses run creation, processing-field writes,
//             certification and reprocess requests for every role (service role included) except canary companies; the
//             numeric generation floor only rises and refuses older runs and their certifications; the drain closes only
//             pre-hold runs after the stated bound; events and the control row cannot be edited directly;
//   handler   the REAL process-trial-balance handler is refused while held and below the floor, writing no certification;
//   treatment the request id is identical in TypeScript and SQL; a confirmation is accepted only for a current, exact,
//             untampered request with a reason, by a prepare_close holder; replay and conflict; every refusal named; the
//             mapping is never changed; get_confirmed_treatments only returns requests whose mapping link is current.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/h1Authority.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY local database) also works.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, loadFunctionTree, mintTestJwt, shim } from "./lib/functionHarness.mjs";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";
import { buildTreatmentRequest, canonicalTreatmentText, CLOSING_STOCK_RULE, treatmentRequestId } from "../../supabase/functions/_shared/treatmentRequest.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const H1_FILE = "20261007100000_treatment_authority_and_processing_control.sql";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-h1-"));
  const port = 57000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE h1_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/h1_proof`;
}
async function stopDatabase() {
  try { await pool?.end(); } catch { /* */ } try { await admin?.end(); } catch { /* */ }
  if (server) { try { await server.stop(); } catch { /* */ } }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
const uuid = () => crypto.randomUUID();
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
const FINGERPRINT_SQL = `SELECT md5(string_agg(x, '|' ORDER BY x)) AS fp FROM (
  SELECT 'c:'||table_name||'.'||column_name||':'||data_type||':'||coalesce(column_default,'')||is_nullable AS x FROM information_schema.columns WHERE table_schema='public'
  UNION ALL SELECT 'f:'||p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid))||coalesce(array_to_string(p.proacl, ','),'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
  UNION ALL SELECT 't:'||tgname||':'||tgrelid::regclass::text FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'k:'||conname||':'||conrelid::regclass::text||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
  UNION ALL SELECT 'p:'||policyname||':'||tablename FROM pg_policies
  UNION ALL SELECT 'd:'||md5(coalesce((SELECT string_agg(to_jsonb(d)::text, ',' ORDER BY d.id) FROM public.account_review_decisions d), ''))
) s`;
const fingerprint = async () => (await one(FINGERPRINT_SQL)).fp;

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 12 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);
  const cut = files.indexOf(H1_FILE);
  const apply = async (f) => {
    let t = migrationSql(REPO, f);
    if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    try { await admin.query(t); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
  };

  section("Setup — every migration before H1, then legacy state through the pre-H1 review RPC");
  await check(`${H1_FILE} is in the chain and every earlier migration applies`, async () => {
    if (cut < 0) return "H1 missing";
    for (const f of files.slice(0, cut)) await apply(f);
    return true;
  });
  const U = { owner: uuid(), preparer: uuid(), viewer: uuid(), outsider: uuid(), ownerB: uuid(), opsAdmin: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [U.opsAdmin]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "SOLO", 0]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic B') RETURNING id", [U.ownerB])).id;
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now()), ($1,$3,'viewer',now())", [A, U.preparer, U.viewer]);
  const ownerMember = (await one("SELECT id FROM public.firm_members WHERE company_id=$1 AND role='owner'", [A])).id;
  async function upload(company, year, { status = "processing", text = "Code,Name,Debit,Credit\n1000,Bank,10.00,\n3000,Capital,,10.00\n" } = {}) {
    const owner = company === A ? U.owner : U.ownerB;
    const pid = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency) VALUES ($1,$2,$3,$4,'TZS') RETURNING id", [company, `${year}-12-31`, `FY${year}`, owner])).id;
    const fp = `${owner}/${uuid()}.csv`;
    const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,$2,$3,$4,$5,$6,$7) RETURNING id`, [fp, text.length, status, company, year, pid, owner])).id;
    shim.storage.set(`trial-balance-files/${fp}`, new TextEncoder().encode(text));
    return id;
  }
  const decision = (code, name, cls, statement, normal, extra = {}) => ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement, classification: cls, normal_balance: normal, ...extra });
  const batch = (uid, company, up, reqId, decisions) => asUser(uid, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb) r", [company, up, reqId, JSON.stringify(decisions)]).then((x) => x[0].r);
  const reviewUp = await upload(A, 2000);
  const legacyReq = uuid();
  const legacyDecisions = [decision("1200", "Closing stock", "current_assets", "balance_sheet", "debit"), decision("1210", "Bank", "current_assets", "balance_sheet", "debit")];
  const legacyResult = await batch(U.owner, A, reviewUp, legacyReq, legacyDecisions);

  section("Upgrade — rollback leaves nothing; pre-H1 replay identity is preserved");
  await check("H1 applied inside a transaction and rolled back changes nothing (schema, grants, functions, decisions)", async () => {
    const before = await fingerprint();
    await admin.query("BEGIN"); try { await apply(H1_FILE); } finally { await admin.query("ROLLBACK"); }
    return before === (await fingerprint());
  });
  await check(`${H1_FILE} applies, and every later migration on top`, async () => { for (const f of files.slice(cut)) await apply(f); return true; });
  await check("a review batch recorded BEFORE H1 replays byte-identically after H1 (same summary, nothing written)", async () => {
    const n = await count("SELECT count(*) n FROM public.account_review_decisions");
    const r = await batch(U.owner, A, reviewUp, legacyReq, legacyDecisions);
    return JSON.stringify(r) === JSON.stringify(legacyResult) && n === (await count("SELECT count(*) n FROM public.account_review_decisions")) ? true : r;
  });
  await check("the initial control state is open: no hold, no floor, version 1", async () => {
    const c = await one("SELECT * FROM public.processing_release_control");
    return c.hold === false && c.held_at === null && c.min_engine_generation === null && Number(c.version) === 1;
  });

  const control = (uid, hold, canary, floor, reason, version) => asUser(uid, "SELECT public.admin_set_processing_control($1,$2::uuid[],$3,$4,$5) r", [hold, canary, floor, reason, version]).then((x) => x[0].r);
  const version = async () => Number((await one("SELECT version FROM public.processing_release_control")).version);

  section("H1a — processing control authority");
  await refused("a workspace owner (not a commercial administrator) cannot set the control", "42501", () => control(U.owner, true, [], null, "cut-over", 1), "NOT_A_COMMERCIAL_ADMIN");
  await refused("anon cannot call it", "42501", () => as("anon", null, "SELECT public.admin_set_processing_control(true,'{}'::uuid[],NULL,'x y z',1)"));
  await refused("the service role cannot call it", "42501", () => asService("SELECT public.admin_set_processing_control(true,'{}'::uuid[],NULL,'x y z',1)"));
  await refused("a reason is required", "22023", () => control(U.opsAdmin, true, [], null, "  ", 1), "REASON_REQUIRED");
  await refused("a stale version is a conflict (optimistic control)", "40001", () => control(U.opsAdmin, true, [], null, "cut-over", 99), "CONTROL_VERSION_CONFLICT");
  // A run that started BEFORE the hold, still running (for the drain proof), and a validating upload.
  const preHoldRun = (await one("INSERT INTO public.engine_runs (company_id, actor_type, firm_member_id, function_name, engine_version, status, started_at) VALUES ($1,'user',$2,'process-trial-balance','pre','running', now() - interval '5 minutes') RETURNING id", [A, ownerMember])).id;
  const validating = await upload(A, 2001);
  await asService("UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [validating]);
  await check("the admin sets the hold with a reason; version advances; the change is recorded with before/after", async () => {
    const r = await control(U.opsAdmin, true, [], null, "E1 cut-over", 1);
    const ev = await one("SELECT * FROM public.processing_release_control_events ORDER BY occurred_at DESC LIMIT 1");
    return r.hold === true && r.version === 2 && r.held_at !== null && ev.action === "set" && ev.actor_user_id === U.opsAdmin && ev.before_state.hold === false && ev.after_state.hold === true;
  });

  section("H1a — the hold is enforced in the database for every role");
  const heldUp = await upload(A, 2002);
  const heldUpB = await upload(B, 2002);
  await refused("service role: creating a process-trial-balance run is refused (PT503 PROCESSING_HELD)", "PT503", () =>
    asService("INSERT INTO public.engine_runs (company_id, actor_type, firm_member_id, function_name, engine_version) VALUES ($1,'user',$2,'process-trial-balance','x')", [A, ownerMember]), "PROCESSING_HELD");
  await check("other engines' runs are not affected by the hold", async () => {
    await asService("INSERT INTO public.engine_runs (company_id, actor_type, firm_member_id, function_name, engine_version) VALUES ($1,'user',$2,'kinga-tax-engine','x')", [A, ownerMember]);
    return true;
  });
  await refused("service role: a processing-field write on an upload is refused", "PT503", () => asService("UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [heldUp]), "PROCESSING_HELD");
  await refused("migration owner (no marker): a processing-field write is refused too", "PT503", () => admin.query("UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [heldUp]));
  await check("non-processing columns stay writable under the hold (company_name)", async () => {
    await asUser(U.owner, "UPDATE public.trial_balance_uploads SET company_name='Renamed' WHERE id=$1", [heldUp]); return true;
  });
  await refused("certification under the hold is refused", "PT503", async () => {
    const run = (await one("SELECT id FROM public.engine_runs WHERE id=$1", [preHoldRun])).id;
    await asService("SELECT public.commit_tb_certification($1,'process-trial-balance',$2,$3,2001,'h','n','o',false,false,'[]'::jsonb,'[]'::jsonb)", [run, validating, A]);
  }, "PROCESSING_HELD");
  await check("tbu_request_reprocess answers a recorded refusal PROCESSING_HELD, changing nothing else", async () => {
    const op = uuid(); const before = JSON.stringify(await one("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [heldUp]));
    const r = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,NULL) r", [heldUp, op]))[0].r;
    const rec = await one("SELECT outcome, code FROM public.tb_reprocess_requests WHERE operation_id=$1", [op]);
    return r.outcome === "refused" && r.code === "PROCESSING_HELD" && rec.code === "PROCESSING_HELD" && before === JSON.stringify(await one("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [heldUp])) ? true : r;
  });

  const { handler } = await loadFunctionTree(REPO, "process-trial-balance");
  await check("the REAL handler is refused while held: no run, no certification, the upload unchanged", async () => {
    const runs = await count("SELECT count(*) n FROM public.engine_runs WHERE function_name='process-trial-balance'");
    const before = JSON.stringify(await one("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [heldUp]));
    const r = await call(handler, pool, mintTestJwt(U.owner), { uploadId: heldUp, clientRequestId: uuid() });
    return r.http >= 400 && runs === (await count("SELECT count(*) n FROM public.engine_runs WHERE function_name='process-trial-balance'"))
      && (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [heldUp])) === 0
      && before === JSON.stringify(await one("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [heldUp])) ? true : r;
  });
  await check("a canary company may process while every other stays held (the real handler certifies A; B is refused)", async () => {
    await control(U.opsAdmin, true, [A], null, "canary A", await version());
    const rA = await call(handler, pool, mintTestJwt(U.owner), { uploadId: heldUp, clientRequestId: uuid() });
    const rB = await call(handler, pool, mintTestJwt(U.ownerB), { uploadId: heldUpB, clientRequestId: uuid() });
    const certA = await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [heldUp]);
    const certB = await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [heldUpB]);
    return rA.http === 200 && certA === 1 && rB.http >= 400 && certB === 0 ? true : { a: rA.http, b: rB.http, certA, certB };
  });

  section("H1a — drain after the platform bound");
  await refused("draining before the stated bound has elapsed is refused", "55000", () => asUser(U.opsAdmin, "SELECT public.admin_drain_processing(3600,'cut-over drain')"), "DRAIN_TOO_EARLY");
  await refused("a non-admin cannot drain", "42501", () => asUser(U.owner, "SELECT public.admin_drain_processing(1,'cut-over drain')"));
  await new Promise((r) => setTimeout(r, 1200));
  // A canary (A) run that started AFTER the hold, still live, processing its own upload.
  const canaryUp = await upload(A, 2006);
  const canaryRun = (await one("INSERT INTO public.engine_runs (company_id, actor_type, firm_member_id, function_name, engine_version, status, source_table, source_record_id) VALUES ($1,'user',$2,'process-trial-balance','canary','running','trial_balance_uploads',$3) RETURNING id", [A, ownerMember, canaryUp])).id;
  await asService("UPDATE public.trial_balance_uploads SET status='validating' WHERE id=$1", [canaryUp]);
  await check("the drain closes only pre-hold runs still running (failed, DRAINED_AT_CUTOVER), re-queues validating uploads, and is recorded", async () => {
    const d = (await asUser(U.opsAdmin, "SELECT public.admin_drain_processing(1,'cut-over drain') r"))[0].r;
    const canary = await one("SELECT status FROM public.engine_runs WHERE id=$1", [canaryRun]);
    const canaryUpload = await one("SELECT status FROM public.trial_balance_uploads WHERE id=$1", [canaryUp]);
    if (canary.status !== "running" || canaryUpload.status !== "validating") return { canary, canaryUpload };
    const run = await one("SELECT status, error_code FROM public.engine_runs WHERE id=$1", [preHoldRun]);
    const up = await one("SELECT status FROM public.trial_balance_uploads WHERE id=$1", [validating]);
    const ev = await one("SELECT * FROM public.processing_release_control_events WHERE action='drain' ORDER BY occurred_at DESC LIMIT 1");
    return d.runs_closed === 1 && d.run_ids[0] === preHoldRun && run.status === "failed" && run.error_code === "DRAINED_AT_CUTOVER"
      && up.status === "processing" && d.uploads_requeued >= 1 && ev.detail.runs_closed === 1 ? true : { d, run, up };
  });
  await check("the drain refuses when nothing is held", async () => {
    await control(U.opsAdmin, false, [], null, "released", await version());
    try { await asUser(U.opsAdmin, "SELECT public.admin_drain_processing(1,'x y z')"); return "accepted"; } catch (e) { return e.code === "55000" && /NOT_HELD/.test(e.message) ? true : e.message; }
  });

  section("H1a — numeric engine-generation floor");
  const genRun = async (gen) => asService("INSERT INTO public.engine_runs (company_id, actor_type, firm_member_id, function_name, engine_version, engine_generation) VALUES ($1,'user',$2,'process-trial-balance','x',$3) RETURNING id", [A, ownerMember, gen]).then((x) => x[0].id);
  const oldRun = await genRun(null); // created before any floor exists
  await check("setting floor 2 (numeric) is recorded", async () => (await control(U.opsAdmin, false, [], 2, "E1 generation floor", await version())).min_engine_generation === 2);
  await refused("a run without a generation is refused below the floor (PT410)", "PT410", () => genRun(null), "ENGINE_GENERATION_RETIRED");
  await refused("generation 1 is refused below floor 2", "PT410", () => genRun(1));
  await check("generations 2 and 10 are accepted (numeric, never lexical: '10' > '2')", async () => { await genRun(2); await genRun(10); return true; });
  const floorUp = await upload(A, 2005);
  await refused("a certification for a pre-floor run is refused (PT410)", "PT410", () => asService("SELECT public.commit_tb_certification($1,'process-trial-balance',$2,$3,2005,'h','n','o',false,false,'[]'::jsonb,'[]'::jsonb)", [oldRun, floorUp, A]), "ENGINE_GENERATION_RETIRED");
  await refused("the floor cannot decrease", "22023", () => control(U.opsAdmin, false, [], 1, "lower", 0).catch(async () => control(U.opsAdmin, false, [], 1, "lower", await version())), "ENGINE_GENERATION_FLOOR_CANNOT_DECREASE");
  await refused("the floor cannot be removed", "22023", async () => control(U.opsAdmin, false, [], null, "remove", await version()), "ENGINE_GENERATION_FLOOR_CANNOT_DECREASE");
  await check("the REAL current handler (no generation) can no longer start a run: refused, no certification", async () => {
    const up = await upload(A, 2003);
    const r = await call(handler, pool, mintTestJwt(U.owner), { uploadId: up, clientRequestId: uuid() });
    return r.http >= 400 && (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [up])) === 0 ? true : r;
  });
  await refused("a run's generation cannot be rewritten on its terminal transition", "P0001", async () => {
    const id = await genRun(3);
    await asService("UPDATE public.engine_runs SET status='failed', completed_at=now(), engine_generation=99 WHERE id=$1", [id]);
  });

  section("H1a — control and events cannot be edited directly");
  await refused("the control row cannot be updated outside the RPC (even by the owner role)", "42501", () => admin.query("UPDATE public.processing_release_control SET hold=true"));
  await refused("the control row cannot be deleted", "42501", () => admin.query("DELETE FROM public.processing_release_control"));
  await refused("events cannot be edited", "42501", () => admin.query("UPDATE public.processing_release_control_events SET reason='x'"));
  await refused("events cannot be deleted", "42501", () => admin.query("DELETE FROM public.processing_release_control_events"));
  await refused("clients cannot read the control tables", "42501", () => asUser(U.owner, "SELECT * FROM public.processing_release_control"));

  section("H1b — treatment request identity: TypeScript equals SQL");
  const facts = { ...CLOSING_STOCK_RULE, company_id: A, upload_id: reviewUp, source_file_hash: "f".repeat(64), account_key: "1200", account_code: "1200", debit_minor: "0", credit_minor: "500000", mapping_decision_id: uuid() };
  await check("identical ids for the same facts; every single-field change changes both", async () => {
    const same = async (f) => (await treatmentRequestId(f)) === (await one("SELECT public.treatment_request_id($1::jsonb) id", [JSON.stringify(f)])).id;
    if (!(await same(facts))) return "base differs";
    for (const [k, v] of [["rule_version", "2"], ["upload_id", uuid()], ["source_file_hash", "e".repeat(64)], ["account_key", "1201"], ["debit_minor", "1"], ["credit_minor", "500001"], ["mapping_decision_id", uuid()], ["account_code", null]]) {
      const changed = { ...facts, [k]: v };
      if (!(await same(changed))) return `differs on ${k}`;
      if ((await treatmentRequestId(changed)) === (await treatmentRequestId(facts))) return `${k} did not change the id`;
    }
    return canonicalTreatmentText(facts).startsWith("tb-treatment/1|closing_stock_credit|1|") ? true : "canonical prefix";
  });

  section("H1b — CONFIRM_ACCOUNT_TREATMENT");
  // The engine (E1) will emit treatment requests; until then the proof writes one exactly as E1 will (service role).
  const tUp = await upload(A, 2004);
  await asService("UPDATE public.trial_balance_uploads SET source_file_hash=$2 WHERE id=$1", [tUp, "a".repeat(64)]);
  const mappingLink = async () => (await one("SELECT review_decision_id FROM public.account_mappings WHERE company_id=$1 AND account_code='1200'", [A])).review_decision_id;
  const emit = async (overrides = {}) => {
    const r = await buildTreatmentRequest({ ...CLOSING_STOCK_RULE, company_id: A, upload_id: tUp, source_file_hash: "a".repeat(64), account_key: "1200", account_code: "1200", debit_minor: "0", credit_minor: "500000", mapping_decision_id: await mappingLink(), ...overrides });
    return r;
  };
  const writeRequests = (reqs) => asService("UPDATE public.trial_balance_uploads SET processing_result = jsonb_build_object('treatment_requests', $2::jsonb) WHERE id=$1", [tUp, JSON.stringify(reqs)]);
  const confirm = (uid, reqId, request_id, { treatment = "keep_as_mapped", reason = "Stock count shows a credit adjustment pending posting" } = {}) =>
    batch(uid, A, tUp, reqId, [{ account_code: "1200", account_name: "Closing stock", decision_action: "CONFIRM_ACCOUNT_TREATMENT", treatment_request_id: request_id, treatment, reason }]);
  const good = await emit();
  await writeRequests([good]);
  const decisions = () => count("SELECT count(*) n FROM public.account_review_decisions");
  const mappingSnap = async () => JSON.stringify(await one("SELECT statement, classification, line_item, normal_balance, is_cash_account, review_decision_id FROM public.account_mappings WHERE company_id=$1 AND account_code='1200'", [A]));
  for (const [label, uid, code, prefix] of [["viewer (no prepare_close)", U.viewer, "42501", "CAPABILITY_REQUIRED"], ["non-member", U.outsider, "42501", "NOT_A_MEMBER"], ["other-tenant owner", U.ownerB, "42501", "NOT_A_MEMBER"]]) {
    await refused(`${label} cannot confirm a treatment`, code, () => confirm(uid, uuid(), good.request_id), prefix);
  }
  for (const [label, args, prefix] of [
    ["a treatment other than keep_as_mapped", { treatment: "reclassify" }, "UNSUPPORTED_TREATMENT"],
    ["a missing reason", { reason: "" }, "TREATMENT_REASON_REQUIRED"],
    ["a too-short reason", { reason: "ok" }, "TREATMENT_REASON_REQUIRED"],
  ]) {
    await refused(`refused: ${label}`, "22023", () => confirm(U.owner, uuid(), good.request_id, args), prefix);
  }
  await refused("refused: a malformed request id", "22023", () => confirm(U.owner, uuid(), "abc"), "TREATMENT_REQUEST_ID_REQUIRED");
  await refused("refused: a request id the engine did not emit for this upload", "22023", () => confirm(U.owner, uuid(), "b".repeat(64)), "TREATMENT_REQUEST_NOT_FOUND");
  await check("refused: a tampered request (a fact changed, id kept) — nothing written", async () => {
    const n = await decisions();
    await writeRequests([{ ...good, credit_minor: "1" }]);
    try { await confirm(U.owner, uuid(), good.request_id); return "accepted"; }
    catch (e) { await writeRequests([good]); return e.code === "22023" && /TREATMENT_REQUEST_INVALID/.test(e.message) && n === (await decisions()) ? true : e.message; }
  });
  await check("refused: a request for another account key (re-identified as another account) — nothing written", async () => {
    const other = await emit({ account_key: "1210", account_code: "1210" });
    await writeRequests([good, other]);
    try { await confirm(U.owner, uuid(), other.request_id); return "accepted"; }
    catch (e) { return /TREATMENT_REQUEST_MISMATCH/.test(e.message) ? true : e.message; }
  });
  await check("refused: the upload's source bytes changed after the request (source hash differs)", async () => {
    const stale = await emit({ source_file_hash: "c".repeat(64) });
    await writeRequests([good, stale]);
    try { await confirm(U.owner, uuid(), stale.request_id); return "accepted"; }
    catch (e) { await writeRequests([good]); return /TREATMENT_REQUEST_MISMATCH/.test(e.message) ? true : e.message; }
  });
  const okReq = uuid();
  let okSummary;
  await check("accepted: a prepare_close holder confirms keep_as_mapped; the decision binds the whole request; the mapping is untouched", async () => {
    const before = await mappingSnap(); const n = await decisions();
    okSummary = await confirm(U.preparer, okReq, good.request_id);
    const d = await one("SELECT * FROM public.account_review_decisions WHERE decision_action='CONFIRM_ACCOUNT_TREATMENT' ORDER BY sequence_no DESC LIMIT 1");
    return okSummary.treatments_recorded === 1 && n + 1 === (await decisions()) && before === (await mappingSnap())
      && d.new_value.treatment === "keep_as_mapped" && d.new_value.request_id === good.request_id && d.new_value.request.mapping_decision_id === good.mapping_decision_id
      && d.new_value.reason === "Stock count shows a credit adjustment pending posting" && d.review_account_key === "1200" ? true : { okSummary, d: d?.new_value };
  });
  await check("replay: the same request id and payload returns the recorded summary and writes nothing", async () => {
    const n = await decisions();
    const r = await confirm(U.preparer, okReq, good.request_id);
    return JSON.stringify(r) === JSON.stringify(okSummary) && n === (await decisions()) ? true : r;
  });
  await refused("conflict: the same request id with a different reason (the reason is hashed)", "22023", () => confirm(U.preparer, okReq, good.request_id, { reason: "A different explanation entirely" }), "IDEMPOTENCY_KEY_REUSED");
  await check("get_confirmed_treatments returns the confirmed id while the mapping link is current; clients cannot call it", async () => {
    const rows = await asService("SELECT * FROM public.get_confirmed_treatments($1,$2::text[])", [A, [good.request_id, "d".repeat(64)]]);
    try { await asUser(U.owner, "SELECT * FROM public.get_confirmed_treatments($1,$2::text[])", [A, [good.request_id]]); return "client allowed"; }
    catch (e) { return e.code === "42501" && rows.length === 1 && rows[0].request_id === good.request_id ? true : rows; }
  });
  await check("expiry: a new review of the mapping changes its link; the old confirmation no longer applies and cannot be re-submitted", async () => {
    await batch(U.owner, A, reviewUp, uuid(), [decision("1200", "Closing stock", "current_assets", "balance_sheet", "debit", { line_item: "Inventory (reviewed again)" })]);
    const rows = await asService("SELECT * FROM public.get_confirmed_treatments($1,$2::text[])", [A, [good.request_id]]);
    try { await confirm(U.owner, uuid(), good.request_id); return "accepted"; }
    catch (e) { return rows.length === 0 && /TREATMENT_MAPPING_CHANGED/.test(e.message) ? true : { rows: rows.length, e: e.message }; }
  });
  await check("S1 unchanged: approving decisions still link the mapping; a treatment decision can never become a mapping link", async () => {
    const link = await mappingLink();
    const action = (await one("SELECT decision_action FROM public.account_review_decisions WHERE id=$1", [link])).decision_action;
    const conf = (await one("SELECT id FROM public.account_review_decisions WHERE decision_action='CONFIRM_ACCOUNT_TREATMENT' LIMIT 1")).id;
    try { await asService("UPDATE public.account_mappings SET review_decision_id=$2 WHERE company_id=$1 AND account_code='1200'", [A, conf]); return "linked"; }
    catch (e) { return action === "USER_MANUAL_CLASSIFICATION" && e.code === "42501" ? true : e.message; }
  });
}

let ok = false;
try { await main(); ok = results.length > 0 && results.every((r) => r.ok); }
catch (e) { console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); ok = false; }
finally { await stopDatabase(); }
const failed = results.filter((r) => !r.ok);
console.log(`\n──────────────────────────────────────────\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
console.log(ok ? "H1_AUTHORITY: ALL PASSED" : "H1_AUTHORITY: FAILED");
process.exit(ok ? 0 : 1);
