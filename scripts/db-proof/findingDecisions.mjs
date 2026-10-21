#!/usr/bin/env bun
// Real-PostgreSQL proof of trial-balance finding decisions, the evaluation manifest and bounded investigations
// (20261118100000; Trial Balance workflow, Track B).
//
//   manifest       generation 7 must report every rule once, agree with its findings, name each decision-taking
//                  finding's subject and — when accepted — cite a current, resolving decision for each; a generation the
//                  database does not know is refused at begin and at finalize; generation 6 is served as before;
//   decisions      identity from the certification's own findings; required confirmations and evidence per action;
//                  replay, conflict, stale evaluation, version conflict; append-only and fenced; the evaluation it was
//                  made against invalidated in the same transaction; an engine that cannot read decisions refused;
//   carry-forward  a decision is reused only by a re-check of the same file under the same layout (and, for entity
//                  findings, the same entity identity); replacement files, changed titles, layouts and renames need a new one;
//   policy         clearing balances are review indicators unless the workspace records a require-decision policy;
//   investigation  one running reservation per upload under 12-way concurrency; replay; reuse of a completed result;
//                  a stale evaluation refused; an expired lease recovered and the late worker fenced out; bounded results.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> node scripts/db-proof/findingDecisions.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
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
const FILE = "20261118100000_tb_finding_decisions.sql";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-decisions-proof-"));
  const port = 57900 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE decisions_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/decisions_proof`;
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
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const asService = (sql, params) => asRole("service_role", null, sql, params);
const refusedWith = (re) => (e) => (re.test(String(e.message)) ? true : String(e.message));

const RULES = ["source_read", "columns", "period_and_currency", "duplicate_identities", "balance", "entity_name", "trailing_text", "clearing_accounts", "classification"];
const RULE_OF = { ENTITY_NAME_DIFFERS: "entity_name", ENTITY_WRONG_DESTINATION: "entity_name", UNRECOGNISED_TRAILING_TEXT: "trailing_text",
  LAYOUT_CORRECTION_REQUIRED: "trailing_text", CLEARING_ACCOUNT_BALANCE: "clearing_accounts", TRIAL_BALANCE_IMBALANCE: "balance" };
/** A generation-7 result: the manifest derived from the findings unless overridden. */
function g7({ blocking = false, review = false, findings = [], manifest, omitFindings = false }) {
  const rules = manifest ?? RULES.map((rule) => ({ rule, outcome: findings.some((f) => RULE_OF[f.code] === rule) ? "finding" : "passed" }));
  const certification = { normalized_input_hash: "n", output_hash: "o", is_blocking: blocking, requires_review: review, rows_snapshot: [],
    exceptions: findings, evaluation: { format: "tb-evaluation/1", rules } };
  if (!omitFindings) certification.findings = findings;
  return { outcome: "certified",
    upload: { status: blocking ? "blocked" : review ? "needs_review" : "complete", is_valid: !blocking && !review, processing_result: { status: "x" }, validation_report: { ok: !blocking }, accounting_errors: [] },
    certification };
}
// Each decision-taking finding states whether it must be decided; the database recomputes it (rule + workspace policy).
const entityFinding = (fileEntity, extra = {}) => ({ code: "ENTITY_NAME_DIFFERS", layer: 2, severity: "warning", accountCode: null,
  message: `This file names ${fileEntity}.`, rows: [1], subject: fileEntity.toLowerCase(), file_entity: fileEntity, decision_required: true, ...extra });
const trailingFinding = (rows, extra = {}) => ({ code: "UNRECOGNISED_TRAILING_TEXT", layer: 2, severity: "warning", accountCode: null, message: "Text after the last amount row.", rows, subject: `rows:${rows.join(",")}`, decision_required: false, ...extra });
const clearingFinding = (code, extra = {}) => ({ code: "CLEARING_ACCOUNT_BALANCE", layer: 2, severity: "warning", accountCode: code, message: "Clearing account has a balance.", rows: [9], subject: `code:${code}`, decision_required: false, ...extra });
const imbalanceFinding = () => ({ code: "TRIAL_BALANCE_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "Debits do not equal credits." });

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 20 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);
  const applyFile = async (f) => {
    let t = migrationSql(REPO, f);
    if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    await admin.query(t);
  };

  group("Chain — every migration applies, decisions included; a second application is refused");
  await check(`the full chain applies, ${FILE} included`, async () => {
    if (!files.includes(FILE)) return `${FILE} missing from the chain`;
    for (const f of files) { try { await applyFile(f); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; } }
    return true;
  });
  await check("re-applying the migration is refused by its preflight, nothing changed", async () =>
    applyFile(FILE).then(() => "ran", refusedWith(/PREFLIGHT_REFUSED/)));
  await check("privileges: clients reach the decision, policy and page reads/operations only; engine helpers and investigation writers are service-only", async () => {
    const r = await one(`SELECT
        has_function_privilege('authenticated','public.record_tb_finding_decision(uuid,uuid,text,text,text,jsonb,text,integer,uuid)','EXECUTE') a,
        has_function_privilege('anon','public.record_tb_finding_decision(uuid,uuid,text,text,text,jsonb,text,integer,uuid)','EXECUTE') b,
        has_function_privilege('authenticated','public.get_tb_finding_decisions(uuid)','EXECUTE') c,
        has_function_privilege('authenticated','public.tb_current_finding_decisions(uuid)','EXECUTE') d,
        has_function_privilege('authenticated','public.tb_investigation_reserve(uuid,uuid,uuid,uuid,integer)','EXECUTE') e,
        has_function_privilege('service_role','public.tb_investigation_reserve(uuid,uuid,uuid,uuid,integer)','EXECUTE') f,
        has_function_privilege('authenticated','public.tb_investigation_complete(uuid,text,jsonb,text)','EXECUTE') g,
        has_table_privilege('authenticated','public.tb_finding_decisions','INSERT') h,
        has_function_privilege('authenticated','public.set_tb_finding_policy(uuid,text,text,text,integer,uuid)','EXECUTE') i,
        has_function_privilege('authenticated','public.tb_finding_required(uuid,text)','EXECUTE') j,
        has_function_privilege('authenticated','public.tb_investigation_add_rows(uuid,jsonb)','EXECUTE') k,
        has_function_privilege('authenticated','public.get_tb_investigation_rows(uuid,text,integer,integer)','EXECUTE') l,
        has_table_privilege('authenticated','public.tb_investigation_rows','SELECT') m`);
    return r.a && !r.b && r.c && !r.d && !r.e && r.f && !r.g && !r.h && r.i && !r.j && !r.k && r.l && !r.m ? true : r;
  });
  await check("the rules are defined, not inferred: entity always, clearing by policy, amount-free trailing text never", async () => {
    const rules = (await admin.query("SELECT code, requirement FROM public.tb_decision_rules ORDER BY code")).rows.map((r) => `${r.code}=${r.requirement}`).join();
    return rules === "CLEARING_ACCOUNT_BALANCE=policy,ENTITY_NAME_DIFFERS=always,UNRECOGNISED_TRAILING_TEXT=never" ? true : rules;
  });

  // ── Fixture: one tenant, a stranger and a member without review authority; invented names only ───────────────────
  const U = { owner: uuid(), stranger: uuid(), preparer: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const uid of [U.owner, U.stranger]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 3 FROM public.commercial_plans WHERE product_id=$2 AND code='FIRM'", [bc, prod]);
  }
  const C = (await one("INSERT INTO public.companies (user_id,name,code,tin) VALUES ($1,'Invented Alpha Ltd','A1','900000001') RETURNING id", [U.owner])).id;
  await admin.query("INSERT INTO public.firm_members (company_id, user_id, role, invited_email, accepted_at) VALUES ($1,$2,'preparer','preparer@example.test',now())", [C, U.preparer]);
  const period = (await one(`INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end)
      VALUES ($1,'2025-12-31','FY2025',$2,'TZS','2025-01-01','2025-12-31') RETURNING id`, [C, U.owner])).id;
  const ownerMember = (await one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [C, U.owner]))?.id ?? null;
  await admin.query(`INSERT INTO public.engagements (fiscal_period_id, company_id, engagement_type, created_by_member_id) VALUES ($1,$2,'composite',$3)`, [period, C, ownerMember]);

  let fileNo = 0;
  // One active upload per period: every upload after the first gets a period of its own (an earlier year), so the
  // workspace's 2025 period keeps exactly the upload the authority checks below are about.
  async function newUpload(year = 2025 - fileNo) {
    fileNo++;
    const per = year === 2025 ? period : (await one(`INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end)
      VALUES ($1,$2,$3,$4,'TZS',$5,$6) RETURNING id`, [C, `${year}-12-31`, `FY${year}`, U.owner, `${year}-01-01`, `${year}-12-31`])).id;
    const src = crypto.createHash("sha256").update(`decisions-proof-file-${fileNo}`).digest("hex");
    const up = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id, source_file_hash)
      VALUES ($1,$2,10,'processing',$3,$4,$5,$6,$7) RETURNING id`, [`invented-${fileNo}.csv`, `${U.owner}/${uuid()}.csv`, C, year, per, U.owner, src])).id;
    return { up, src, year };
  }
  const begin = async (u, gen) => (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v7',$4,'workspace_user',NULL,$5,600) r",
    [u.up, uuid(), u.src, gen, U.owner]))[0].r;
  const keys = (u) => [{ scope: C, key: "#framework" }, { scope: C, key: "#currency" }, { scope: "global", key: "#dictionary" },
    { scope: C, key: `#layout_confirmation:${u.up}` }, { scope: C, key: `#finding_decisions:${u.up}` }, { scope: C, key: "#entity" }, { scope: C, key: "#finding_policy" }];
  const snapshot = (run, u) => asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb) r", [run, JSON.stringify(keys(u))]);
  const finalize = async (run, r) => (await asService("SELECT public.tb_finalize_attempt($1,$2::jsonb) r", [run, JSON.stringify(r)]))[0].r;
  /** Fixture only: ends a lease now (ordinary triggers off for this one statement), as time passing would. */
  async function expire(table, id) {
    await admin.query("SET session_replication_role = replica");
    try { await admin.query(`UPDATE public.${table} SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [id]); }
    finally { await admin.query("SET session_replication_role = origin"); }
  }
  /** Begin (generation), snapshot, finalize — the run's outcome or the refusal message. */
  async function certify(u, result, gen = 7) {
    const b = await begin(u, gen);
    if (b.outcome !== "claimed") return { begin: b };
    await snapshot(b.engine_run_id, u);
    try { return { ...(await finalize(b.engine_run_id, result)), run: b.engine_run_id }; }
    catch (e) {
      // A refused finalize writes nothing; the attempt is abandoned so the next check of the same upload can begin.
      await expire("engine_runs", b.engine_run_id);
      return { error: String(e.message).split("\n")[0], run: b.engine_run_id };
    }
  }
  /** A new check of an upload with a result in force, through the one reprocess path (it invalidates the result). */
  const reprocess = async (u) => (await asRole("authenticated", U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [u.up, uuid(), u.src]))[0].r;
  const latestCert = async (up) => (await one("SELECT id FROM public.tb_certifications WHERE upload_id=$1 ORDER BY sequence_no DESC LIMIT 1", [up]))?.id ?? null;
  const decide = (uid, a) => asRole("authenticated", uid, "SELECT public.record_tb_finding_decision($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) r",
    [a.upload, a.cert, a.code, a.subject, a.action, JSON.stringify(a.payload ?? {}), a.reason ?? "Checked against the signed engagement letter", a.expected ?? 0, a.request ?? uuid()]).then((r) => r[0].r);
  const authoritative = async (year = 2025) => (await asRole("authenticated", U.owner, "SELECT id FROM public.get_authoritative_certification($1, $2)", [C, year]))[0]?.id ?? null;
  const current = async (up) => (await asService("SELECT * FROM public.tb_current_finding_decisions($1) ORDER BY code, subject", [up]));
  const setPolicy = (uid, mode, expected, reason = "Engagement letter requires evidence for clearing balances", request = uuid()) =>
    asRole("authenticated", uid, "SELECT public.set_tb_finding_policy($1,'CLEARING_ACCOUNT_BALANCE',$2,$3,$4,$5) r", [C, mode, reason, expected, request]).then((r) => r[0].r);
  const ENTITY_OK = { confirmed: true, file_entity: "Invented Beta Trading", workspace_entity: "Invented Alpha Ltd" };
  const EVIDENCE = { nature: "in_transit", explanation: "Deposit banked on 31 December, cleared 2 January", evidence: { kind: "document", reference: "Bank statement January, line 3" } };

  group("Manifest — generation 7 reports every rule once and agrees with its findings; unknown generations are refused");
  const d = await newUpload(2025);
  const m = await newUpload();
  await check("no manifest → refused (malformed)", async () => { const base = g7({ review: true, findings: [entityFinding("Invented Beta Trading")] }); const r = await certify(m, { ...base, certification: { ...base.certification, evaluation: undefined } }); return /manifest is malformed/.test(r.error ?? "") ? true : r; });
  await check("a required rule omitted (an older handler that never evaluates it) → refused", async () => { const r = await certify(m, g7({ manifest: RULES.filter((x) => x !== "trailing_text").map((rule) => ({ rule, outcome: "passed" })) })); return /omits a required rule/.test(r.error ?? "") ? true : r; });
  await check("an unknown rule, or a rule repeated → refused", async () => {
    const a = await certify(m, g7({ manifest: [...RULES.map((rule) => ({ rule, outcome: "passed" })), { rule: "made_up", outcome: "passed" }] }));
    const b = await certify(m, g7({ manifest: [...RULES.map((rule) => ({ rule, outcome: "passed" })), { rule: "balance", outcome: "passed" }] }));
    return /unknown rule or repeats/.test(a.error ?? "") && /unknown rule or repeats/.test(b.error ?? "") ? true : { a, b };
  });
  await check("a rule left 'not_reached' on a non-blocking result → refused", async () => { const r = await certify(m, g7({ manifest: RULES.map((rule) => ({ rule, outcome: rule === "classification" ? "not_reached" : "passed" })) })); return /only a blocking result/.test(r.error ?? "") ? true : r; });
  await check("a finding whose rule is reported 'passed' (or 'finding' with no finding) → refused", async () => {
    const a = await certify(m, g7({ review: true, findings: [entityFinding("Invented Beta Trading")], manifest: RULES.map((rule) => ({ rule, outcome: "passed" })) }));
    const b = await certify(m, g7({ manifest: RULES.map((rule) => ({ rule, outcome: rule === "balance" ? "finding" : "passed" })) }));
    return /does not agree/.test(a.error ?? "") && /does not agree/.test(b.error ?? "") ? true : { a, b };
  });
  await check("a decision-taking finding without a subject or without its requirement flag → refused", async () => {
    const f1 = entityFinding("Invented Beta Trading"); delete f1.subject;
    const f2 = entityFinding("Invented Beta Trading"); delete f2.decision_required;
    const a = await certify(m, g7({ review: true, findings: [f1] })), b = await certify(m, g7({ review: true, findings: [f2] }));
    return /no subject or requirement/.test(a.error ?? "") && /no subject or requirement/.test(b.error ?? "") ? true : { a, b };
  });
  await check("a requirement flag the workspace does not have (entity stated as optional; clearing stated as required) → refused", async () => {
    const a = await certify(m, g7({ review: true, findings: [entityFinding("Invented Beta Trading", { decision_required: false })] }));
    const b = await certify(m, g7({ review: true, findings: [clearingFinding("1190", { decision_required: true })] }));
    return /requirement the workspace does not have/.test(a.error ?? "") && /requirement the workspace does not have/.test(b.error ?? "") ? true : { a, b };
  });
  await check("an ACCEPTED result with an undecided entity finding → refused (the confirmation is server-enforced)", async () => { const r = await certify(m, g7({ findings: [entityFinding("Invented Beta Trading")] })); return /needs a decision/.test(r.error ?? "") ? true : r; });
  await check("review indicators do not block: an accepted result with an undecided clearing balance and amount-free trailing text is accepted (default policy)", async () => {
    const u = await newUpload();
    const r = await certify(u, g7({ findings: [clearingFinding("1190"), trailingFinding([41, 42])] }));
    return r.outcome === "certified" && (await authoritative(u.year)) !== null ? true : r;
  });
  await check("generation 7 without its complete findings → refused", async () => { const r = await certify(m, g7({ omitFindings: true })); return /complete findings/.test(r.error ?? "") ? true : r; });
  await check("a generation newer than the database (8) is refused at begin, before anything is written", async () => { const r = await certify(m, g7({}), 8); return r.begin?.code === "ENGINE_GENERATION_UNSUPPORTED" ? true : r; });
  await check("CONTAINMENT: an engine below generation 7 is refused at begin for EVERY upload — with or without decisions, accepted result or none — before anything is written", async () => {
    const fresh = await newUpload();
    const accepted = await newUpload();
    const first = await certify(accepted, g7({ findings: [clearingFinding("1190")] }));
    if (first.outcome !== "certified") return { first };
    await reprocess(accepted);
    const runsBefore = Number((await one("SELECT count(*) n FROM public.engine_runs WHERE source_record_id = ANY($1::uuid[])", [[fresh.up, accepted.up]])).n);
    const a = await begin(fresh, 6), b = await begin(accepted, 6), c = await begin(fresh, 3);
    const runsAfter = Number((await one("SELECT count(*) n FROM public.engine_runs WHERE source_record_id = ANY($1::uuid[])", [[fresh.up, accepted.up]])).n);
    return [a, b, c].every((r) => r.outcome === "refused" && r.code === "ENGINE_GENERATION_SUPERSEDED") && runsAfter === runsBefore ? true : { a, b, c, runsBefore, runsAfter };
  });
  await check("CONTAINMENT: a generation-6 run already in flight when the migration applied (FIXTURE: its run recorded as generation 6) finishes failed (ENGINE_GENERATION_SUPERSEDED) and certifies nothing; the result in force is not replaced", async () => {
    const u = await newUpload();
    const first = await certify(u, g7({}));
    if (first.outcome !== "certified") return { first };
    const before = await authoritative(u.year);
    await reprocess(u);
    const b = await begin(u, 7);
    if (b.outcome !== "claimed") return { b };
    await snapshot(b.engine_run_id, u);
    await admin.query("SET session_replication_role = replica");
    try { await admin.query("UPDATE public.engine_runs SET engine_generation = 6 WHERE id=$1", [b.engine_run_id]); } finally { await admin.query("SET session_replication_role = origin"); }
    const accepted = { outcome: "certified", upload: { status: "complete", is_valid: true, processing_result: { status: "x" }, validation_report: { ok: true }, accounting_errors: [] },
      certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: false, requires_review: false, rows_snapshot: [], exceptions: [] } };
    const f = await finalize(b.engine_run_id, accepted);
    const certs = Number((await one("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [u.up])).n);
    // The re-check request already invalidated the earlier result; the superseded run adds nothing in its place.
    return f?.outcome === "failed" && f?.error_code === "ENGINE_GENERATION_SUPERSEDED" && certs === 1 && before !== null && (await authoritative(u.year)) === null
      ? true : { f, certs, before };
  });
  await check("a decision never coexists with a running check: refused while a run holds its lease, and still refused once the lease lapses (the re-check request invalidated the result it would bind to)", async () => {
    const u = await newUpload();
    const first = await certify(u, g7({ review: true, findings: [entityFinding("Invented Beta Trading")] }));
    if (first.outcome !== "certified") return { first };
    const cert = await latestCert(u.up);
    await reprocess(u);
    const b = await begin(u, 7);
    if (b.outcome !== "claimed") return { b };
    const decision = { upload: u.up, cert, code: "ENTITY_NAME_DIFFERS", subject: "invented beta trading", action: "different_entity", payload: ENTITY_OK };
    const live = await decide(U.owner, decision);
    await expire("engine_runs", b.engine_run_id);
    const lapsed = await decide(U.owner, decision);
    return live.code === "IN_PROGRESS" && lapsed.code === "STALE_EVALUATION" && (await current(u.up)).length === 0 ? true : { live, lapsed };
  });

  group("Policy — explicit, recorded, server-enforced; a change invalidates dependent results at once");
  let polRev = 0;
  await check("a preparer without review authority, a stranger and a missing reason are refused; the owner records it (replay safe, version checked)", async () => {
    const a = await setPolicy(U.preparer, "require_decision", 0);
    const b = await setPolicy(U.stranger, "require_decision", 0);
    const c = await setPolicy(U.owner, "require_decision", 0, " ");
    const req = uuid();
    const before = await authoritative(m.year === 2025 ? 2025 : fileNo); void before;
    const ok = await setPolicy(U.owner, "require_decision", 0, undefined, req);
    const again = await setPolicy(U.owner, "require_decision", 0, undefined, req);
    const stale = await setPolicy(U.owner, "review", 0);
    polRev = ok.revision;
    return a.code === "FORBIDDEN" && b.code === "NOT_FOUND" && c.code === "REASON_REQUIRED" && ok.outcome === "recorded" && again.replay === true
      && stale.code === "VERSION_CONFLICT" ? true : { a, b, c, ok, again, stale };
  });
  await check("under the policy an accepted result with an undecided clearing balance is refused; the review-indicator acceptance above lost its authority at once", async () => {
    const u = await newUpload();
    const refusedFlagFalse = await certify(u, g7({ findings: [clearingFinding("1190")] }));
    const refusedUndecided = await certify(u, g7({ findings: [clearingFinding("1190", { decision_required: true })] }));
    const review = await certify(u, g7({ review: true, findings: [clearingFinding("1190", { decision_required: true })] }));
    const earlier = (await admin.query("SELECT public.tb_run_authoritative(c.engine_run_id) a FROM public.tb_certifications c JOIN public.trial_balance_uploads t ON t.id=c.upload_id WHERE t.period_year = 2023 ORDER BY c.sequence_no DESC LIMIT 1")).rows[0]?.a;
    return /requirement the workspace does not have/.test(refusedFlagFalse.error ?? "") && /needs a decision/.test(refusedUndecided.error ?? "")
      && review.outcome === "certified" && earlier === false ? true : { refusedFlagFalse, refusedUndecided, review, earlier };
  });
  await check("the policy is set back to review (reason recorded); the browser read states the mode, its revision and who may change it", async () => {
    const back = await setPolicy(U.owner, "review", polRev, "Firm policy: review indicator only");
    const read = (await asRole("authenticated", U.owner, "SELECT public.get_tb_finding_policies($1) r", [C]))[0].r;
    const prep = (await asRole("authenticated", U.preparer, "SELECT public.get_tb_finding_policies($1) r", [C]))[0].r;
    const p = read.policies?.[0];
    return back.outcome === "recorded" && p?.code === "CLEARING_ACCOUNT_BALANCE" && p.mode === "review" && p.revision === 2 && read.may_change === true
      && prep.may_change === false ? true : { back, read, prep };
  });

  group("Decisions — identity, confirmations, replay, conflicts, immediate invalidation, concurrency");
  const review = await certify(d, g7({ review: true, findings: [entityFinding("Invented Beta Trading"), trailingFinding([41, 42]), clearingFinding("1190")] }));
  const cert1 = await latestCert(d.up);
  const E = { upload: d.up, cert: cert1, code: "ENTITY_NAME_DIFFERS", subject: "invented beta trading", action: "same_entity", payload: ENTITY_OK };
  await check("the review result is certified (requires review: the entity finding must be decided)", async () => (review.outcome === "certified" && cert1 ? true : review));
  await check("a stranger cannot decide (not found: the upload is not theirs to see)", async () => { const r = await decide(U.stranger, E); return r.code === "UPLOAD_NOT_FOUND" ? true : r; });
  await check("a finding identity the certification does not contain → FINDING_NOT_FOUND", async () => { const r = await decide(U.owner, { ...E, subject: "someone else" }); return r.code === "FINDING_NOT_FOUND" ? true : r; });
  await check("an action the registry does not offer → ACTION_NOT_AVAILABLE (an imbalance takes no decision at all)", async () => {
    const a = await decide(U.owner, { ...E, action: "accept_anyway" });
    const b = await decide(U.owner, { ...E, code: "TRIAL_BALANCE_IMBALANCE", subject: "x" });
    return a.code === "ACTION_NOT_AVAILABLE" && b.code === "FINDING_NOT_FOUND" ? true : { a, b };
  });
  await check("the same-entity confirmation needs confirmed=true and both names exactly as recorded → CONFIRMATION_REQUIRED", async () => {
    const a = await decide(U.owner, { ...E, payload: { ...E.payload, confirmed: false } });
    const b = await decide(U.owner, { ...E, payload: { ...E.payload, file_entity: "Invented Beta" } });
    const c = await decide(U.owner, { ...E, payload: { ...E.payload, workspace_entity: "Another Name" } });
    return [a, b, c].every((x) => x.code === "CONFIRMATION_REQUIRED") ? true : { a, b, c };
  });
  await check("a reason is required → REASON_REQUIRED; an explanation without evidence → EVIDENCE_REQUIRED; the footer decision must name exactly the rows", async () => {
    const a = await decide(U.owner, { ...E, reason: " " });
    const b = await decide(U.owner, { upload: d.up, cert: cert1, code: "CLEARING_ACCOUNT_BALANCE", subject: "code:1190", action: "explained", payload: { nature: "in_transit", explanation: "Deposit banked on 31 December" } });
    const c = await decide(U.owner, { upload: d.up, cert: cert1, code: "UNRECOGNISED_TRAILING_TEXT", subject: "rows:41,42", action: "not_part_of_trial_balance", payload: { confirmed: true, rows: [41] } });
    return a.code === "REASON_REQUIRED" && b.code === "EVIDENCE_REQUIRED" && c.code === "CONFIRMATION_REQUIRED" ? true : { a, b, c };
  });
  let rec1;
  await check("12 concurrent first decisions on the same finding: exactly one is recorded; every other is refused (the evaluation it read is gone, or the revision moved); one invalidation", async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, () => decide(U.owner, E)));
    const recorded = rs.filter((r) => r.outcome === "recorded");
    rec1 = recorded[0];
    const inv = (await admin.query("SELECT reason FROM public.tb_certification_invalidations WHERE certification_id=$1", [cert1])).rows;
    return recorded.length === 1 && rs.filter((r) => r.code === "STALE_EVALUATION" || r.code === "VERSION_CONFLICT").length === 11 && inv.length === 1 && inv[0].reason === "finding_decision"
      ? true : rs.map((r) => r.outcome + ":" + (r.code ?? ""));
  });
  await check("a lost answer retried with the same request replays the recorded decision; the same request id with other content is a conflict", async () => {
    const req = uuid();
    const u = await newUpload();
    await certify(u, g7({ review: true, findings: [entityFinding("Invented Beta Trading")] }));
    const args = { ...E, upload: u.up, cert: await latestCert(u.up), request: req };
    const first = await decide(U.owner, args);
    const again = await decide(U.owner, args);
    const other = await decide(U.owner, { ...args, reason: "A different reason entirely" });
    return first.outcome === "recorded" && again.replay === true && again.decision_id === first.decision_id && other.code === "IDEMPOTENCY_KEY_REUSED" ? true : { first, again, other };
  });
  await check("a decision against the now-invalidated evaluation → STALE_EVALUATION", async () => {
    const r = await decide(U.owner, { upload: d.up, cert: cert1, code: "CLEARING_ACCOUNT_BALANCE", subject: "code:1190", action: "explained", payload: EVIDENCE });
    return r.code === "STALE_EVALUATION" ? true : r;
  });
  await check("direct writes bypassing the functions are refused (insert/update/delete on decisions and policies, even for the service)", async () => {
    const ins = await asService("INSERT INTO public.tb_finding_decisions (upload_id) VALUES ($1)", [d.up]).then(() => "inserted", refusedWith(/FENCED|permission denied|violates/));
    const upd = await admin.query("UPDATE public.tb_finding_decisions SET reason='x' WHERE id=$1", [rec1.decision_id]).then(() => "updated", refusedWith(/append-only/));
    const del = await admin.query("DELETE FROM public.tb_finding_decisions WHERE id=$1", [rec1.decision_id]).then(() => "deleted", refusedWith(/append-only/));
    const pol = await asRole("authenticated", U.owner, "INSERT INTO public.tb_finding_policies (company_id) VALUES ($1)", [C]).then(() => "inserted", refusedWith(/permission denied|FENCED/));
    const rules = await admin.query("UPDATE public.tb_decision_rules SET requirement='never'").then(() => "updated", refusedWith(/fixed by migration/));
    return [ins, upd, del, pol, rules].every((x) => x === true) ? true : { ins, upd, del, pol, rules };
  });
  await check("an engine that cannot read decisions (generation 6) is refused for this upload, before anything is written", async () => {
    const r = await begin(d, 6);
    return r.code === "ENGINE_GENERATION_SUPERSEDED" ? true : r;
  });
  await check("the snapshot refuses a decisions key that names another upload", async () => {
    const b = await begin(d, 7);
    const r = await asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb)", [b.engine_run_id, JSON.stringify([{ scope: C, key: `#finding_decisions:${m.up}` }])]).then(() => "accepted", refusedWith(/INVALID_DEPENDENCIES/));
    await expire("engine_runs", b.engine_run_id);
    return r;
  });

  group("Re-check — decisions applied; a non-resolving decision blocks; an accepted result needs every REQUIRED decision current");
  await check("citing a decision that is not current (an invented id) → refused", async () => {
    const r = await certify(d, g7({ findings: [entityFinding("Invented Beta Trading", { decision: { id: uuid(), action: "same_entity" } })] }));
    return /not current/.test(r.error ?? "") ? true : r;
  });
  await check("with the entity decided (and the review indicators left as notes), the re-check is ACCEPTED and authoritative", async () => {
    const r = await certify(d, g7({ findings: [entityFinding("Invented Beta Trading", { decision: { id: rec1.decision_id, action: "same_entity" } }), trailingFinding([41, 42]), clearingFinding("1190")] }));
    const auth = await authoritative();
    return r.outcome === "certified" && auth === (await latestCert(d.up)) ? true : { r, auth };
  });
  await check("an optional decision (the clearing explanation) may still be recorded on the accepted result and is cited on the next check", async () => {
    const cert = await latestCert(d.up);
    const r = await decide(U.owner, { upload: d.up, cert, code: "CLEARING_ACCOUNT_BALANCE", subject: "code:1190", action: "explained", payload: EVIDENCE });
    const again = await certify(d, g7({ findings: [entityFinding("Invented Beta Trading", { decision: { id: rec1.decision_id, action: "same_entity" } }),
      trailingFinding([41, 42]), clearingFinding("1190", { decision: { id: r.decision_id, action: "explained" } })] }));
    return r.outcome === "recorded" && again.outcome === "certified" && (await authoritative()) !== null ? true : { r, again };
  });
  await check("the browser read lists the current decisions, the latest revision of each finding, and nothing for a stranger", async () => {
    const a = (await asRole("authenticated", U.owner, "SELECT public.get_tb_finding_decisions($1) r", [d.up]))[0].r;
    const b = (await asRole("authenticated", U.stranger, "SELECT public.get_tb_finding_decisions($1) r", [d.up]))[0].r;
    return a.outcome === "ok" && a.decisions.length === 2 && a.latest_revisions.length === 2 && b.outcome === "not_found" ? true : { a, b };
  });
  await check("a different-entity decision does not resolve: a non-blocking result citing it is refused; the blocking result is recorded", async () => {
    const u = await newUpload();
    await certify(u, g7({ review: true, findings: [entityFinding("Invented Gamma Co")] }));
    const r = await decide(U.owner, { upload: u.up, cert: await latestCert(u.up), code: "ENTITY_NAME_DIFFERS", subject: "invented gamma co", action: "different_entity",
      payload: { confirmed: true, file_entity: "Invented Gamma Co", workspace_entity: "Invented Alpha Ltd" } });
    const cited = entityFinding("Invented Gamma Co", { decision: { id: r.decision_id, action: "different_entity" } });
    const acc = await certify(u, g7({ findings: [cited] }));
    const rev = await certify(u, g7({ review: true, findings: [cited] }));
    const blk = await certify(u, g7({ blocking: true, findings: [cited, { code: "ENTITY_WRONG_DESTINATION", layer: 2, severity: "error", accountCode: null, message: "This file belongs to another entity." }] }));
    return r.outcome === "recorded" && /must block/.test(acc.error ?? "") && /must block/.test(rev.error ?? "") && blk.outcome === "certified" ? true : { r, acc, rev, blk };
  });

  group("Safe carry-forward — unchanged decisions are reused by a re-check of the same file; changed source or context needs a new decision");
  await check("same file, same layout, same entity: the decisions are reused by the re-check (shown above), with no new record", async () => {
    const n = (await one("SELECT count(*)::int n FROM public.tb_finding_decisions WHERE upload_id=$1", [d.up])).n;
    const cur = await current(d.up);
    return cur.length === 2 && n === 2 ? true : { cur, n };
  });
  await check("REPLACEMENT FILE: a new upload of the same company naming the same entity carries nothing — it must be decided again", async () => {
    const u = await newUpload();
    const acc = await certify(u, g7({ findings: [entityFinding("Invented Beta Trading", { decision: { id: rec1.decision_id, action: "same_entity" } })] }));
    await certify(u, g7({ review: true, findings: [entityFinding("Invented Beta Trading")] }));
    const cur = await current(u.up);
    return cur.length === 0 && /not current/.test(acc.error ?? "") ? true : { cur, acc };
  });
  await check("CHANGED TITLE: a replacement naming a different entity is a different finding identity — no earlier decision applies", async () => {
    const u = await newUpload();
    await certify(u, g7({ review: true, findings: [entityFinding("Invented Beta Trading Holdings")] }));
    const cur = await current(u.up);
    const r = await decide(U.owner, { upload: u.up, cert: await latestCert(u.up), code: "ENTITY_NAME_DIFFERS", subject: "invented beta trading", action: "same_entity", payload: ENTITY_OK });
    return cur.length === 0 && r.code === "FINDING_NOT_FOUND" ? true : { cur, r };
  });
  await check("CHANGED LAYOUT: a new layout confirmation for the file makes every decision on it non-current (and the result a re-check)", async () => {
    const before = (await current(d.up)).length;
    await admin.query("SELECT public._tb_bump_dependency($1, $2)", [C, `#layout_confirmation:${d.up}`]);
    const after = (await current(d.up)).length;
    return before === 2 && after === 0 && (await authoritative()) === null ? true : { before, after };
  });
  await check("after a context change the person decides again against the latest revision (no false version conflict); the same payload is recorded anew, not 'unchanged'", async () => {
    const rr = await reprocess(d);
    const r1 = await certify(d, g7({ review: true, findings: [entityFinding("Invented Beta Trading"), trailingFinding([41, 42]), clearingFinding("1190")] }));
    const read = (await asRole("authenticated", U.owner, "SELECT public.get_tb_finding_decisions($1) r", [d.up]))[0].r;
    const latest = read.latest_revisions.find((x) => x.code === "ENTITY_NAME_DIFFERS")?.revision;
    const r = await decide(U.owner, { ...E, cert: await latestCert(d.up), expected: latest });
    return rr.outcome === "accepted" && r1.outcome === "certified" && latest === 1 && r.outcome === "recorded" && r.revision === 2 ? true : { rr, r1, latest, r };
  });
  await check("RENAMED ENTITY: the entity decision stops applying at once (and the result loses authority); a clearing decision is unaffected by a rename", async () => {
    const entityDecision = (await current(d.up)).find((x) => x.code === "ENTITY_NAME_DIFFERS");
    const cert = await latestCert(d.up);
    await certify(d, g7({ review: true, findings: [entityFinding("Invented Beta Trading", { decision: { id: entityDecision.decision_id, action: "same_entity" } }), clearingFinding("1190")] }));
    const c2 = await latestCert(d.up);
    const clr = await decide(U.owner, { upload: d.up, cert: c2, code: "CLEARING_ACCOUNT_BALANCE", subject: "code:1190", action: "explained", payload: EVIDENCE, expected: 1 });
    const acc = await certify(d, g7({ findings: [entityFinding("Invented Beta Trading", { decision: { id: entityDecision.decision_id, action: "same_entity" } }), clearingFinding("1190", { decision: { id: clr.decision_id, action: "explained" } })] }));
    const authBefore = await authoritative();
    await admin.query("UPDATE public.companies SET name='Invented Alpha Holdings Ltd' WHERE id=$1", [C]);
    const authAfter = await authoritative();
    const cur = (await current(d.up)).map((x) => x.code).sort().join();
    void cert;
    return clr.outcome === "recorded" && acc.outcome === "certified" && authBefore !== null && authAfter === null && cur === "CLEARING_ACCOUNT_BALANCE" ? true : { clr, acc, authBefore, authAfter, cur };
  });
  await check("a company code or TIN change also moves the entity key; an unrelated column does not", async () => {
    const rev = async () => Number((await one("SELECT revision r FROM public.tb_dependency_revisions WHERE scope=$1 AND dep_key='#entity'", [C])).r);
    const a = await rev(); await admin.query("UPDATE public.companies SET tin='900000002' WHERE id=$1", [C]);
    const b = await rev(); await admin.query("UPDATE public.companies SET updated_at=now() WHERE id=$1", [C]).catch(() => {});
    const c = await rev();
    return b === a + 1 && c === b ? true : { a, b, c };
  });

  group("Investigation — one durable reservation, recoverable lease, rows stored once and read by page, bounded");
  const inv = await newUpload();
  await certify(inv, g7({ blocking: true, findings: [imbalanceFinding()] }));
  const invCert = await latestCert(inv.up);
  const reserve = (uid, cert, request, lease = 120) => asService("SELECT public.tb_investigation_reserve($1,$2,$3,$4,$5) r", [uid, inv.up, cert, request, lease]).then((r) => r[0].r);
  const addRows = (id, rows) => asService("SELECT public.tb_investigation_add_rows($1,$2::jsonb) r", [id, JSON.stringify(rows)]).then((r) => r[0].r);
  const rowsOf = (from, n, included = (i) => i % 3 !== 0) => Array.from({ length: n }, (_, k) => ({ ordinal: from + k, row_number: from + k + 1, included: included(from + k),
    disposition: included(from + k) ? "account" : "rejected", account_code: `${1000 + from + k}`, account_name: `Invented ${from + k}`, debit_minor: String((from + k) * 100), credit_minor: null, reason: included(from + k) ? null : "amounts without an account code" }));
  await check("not applicable to a result that is not out of balance; a stranger is refused", async () => {
    const r = await asService("SELECT public.tb_investigation_reserve($1,$2,$3,$4,60) r", [U.owner, d.up, await latestCert(d.up), uuid()]).then((x) => x[0].r);
    const s = await reserve(U.stranger, invCert, uuid());
    return r.code === "NOT_APPLICABLE" && s.code === "FORBIDDEN" ? true : { r, s };
  });
  let first;
  await check("12 concurrent requests: exactly one reservation; the others are told one is in progress", async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, () => reserve(U.owner, invCert, uuid())));
    const reserved = rs.filter((r) => r.outcome === "reserved");
    first = reserved[0];
    const running = await one("SELECT count(*)::int n FROM public.tb_investigations WHERE upload_id=$1 AND status='running'", [inv.up]);
    return reserved.length === 1 && rs.filter((r) => r.outcome === "in_progress").length === 11 && running.n === 1 ? true : rs.map((r) => r.outcome);
  });
  await check("a stale evaluation id is refused", async () => { const r = await reserve(U.owner, cert1, uuid()); return r.code === "STALE_EVALUATION" ? true : r; });
  await check("rows are stored in contiguous batches of at most 2,000 (a gap, an oversized batch or a wrong shape is refused)", async () => {
    const gap = await addRows(first.investigation_id, rowsOf(2, 5)).then(() => "accepted", refusedWith(/INVALID_ROWS/));
    const big = await addRows(first.investigation_id, rowsOf(1, 2001)).then(() => "accepted", refusedWith(/INVALID_ROWS/));
    const a = await addRows(first.investigation_id, rowsOf(1, 150));
    return gap === true && big === true && a.stored === 150 ? true : { gap, big, a };
  });
  await check("a completion whose row count does not match the stored rows, or an unbounded lead list, is refused", async () => {
    const wrong = await asService("SELECT public.tb_investigation_complete($1,'completed',$2::jsonb,NULL)", [first.investigation_id, JSON.stringify({ leads: [], row_count: 151 })]).then(() => "accepted", refusedWith(/INVALID_RESULT/));
    const many = await asService("SELECT public.tb_investigation_complete($1,'completed',$2::jsonb,NULL)", [first.investigation_id, JSON.stringify({ leads: Array.from({ length: 51 }, () => ({})), row_count: 150 })]).then(() => "accepted", refusedWith(/INVALID_RESULT/));
    return wrong === true && many === true ? true : { wrong, many };
  });
  await check("an expired lease is recovered by the next request; the late worker is fenced out of both rows and completion", async () => {
    await expire("tb_investigations", first.investigation_id);
    const next = await reserve(U.owner, invCert, uuid());
    const old = await one("SELECT status FROM public.tb_investigations WHERE id=$1", [first.investigation_id]);
    const lateRows = await addRows(first.investigation_id, rowsOf(151, 1)).then(() => "accepted", refusedWith(/INVESTIGATION_NOT_CURRENT/));
    const late = await asService("SELECT public.tb_investigation_complete($1,'completed',$2::jsonb,NULL)", [first.investigation_id, JSON.stringify({ leads: [], row_count: 150 })]).then(() => "accepted", refusedWith(/INVESTIGATION_NOT_CURRENT/));
    first = next;
    return next.outcome === "reserved" && old.status === "abandoned" && lateRows === true && late === true ? true : { next, old, lateRows, late };
  });
  await check("completed with 450 stored rows; pages are read from storage (never re-parsed): filters, keyset paging, exact totals, exact minor amounts", async () => {
    await addRows(first.investigation_id, rowsOf(1, 200)); await addRows(first.investigation_id, rowsOf(201, 250));
    await asService("SELECT public.tb_investigation_complete($1,'completed',$2::jsonb,NULL)", [first.investigation_id, JSON.stringify({ leads: [{ kind: "amount_equals_difference", rows: [12] }], difference: "100.00", row_count: 450 })]);
    const page = (filter, after, limit) => asRole("authenticated", U.owner, "SELECT public.get_tb_investigation_rows($1,$2,$3,$4) r", [first.investigation_id, filter, after, limit]).then((r) => r[0].r);
    const seen = []; let after = 0; let total = null; let pages = 0;
    do { const p = await page("excluded", after, 40); total ??= p.total; seen.push(...p.rows.map((x) => x.ordinal)); after = p.next_after; pages++; } while (after && pages < 50);
    const excluded = rowsOf(1, 450).filter((r) => !r.included).map((r) => r.ordinal);
    const inc = await page("included", 0, 5);
    const bad = await page("everything", 0, 5);
    const stranger = (await asRole("authenticated", U.stranger, "SELECT public.get_tb_investigation_rows($1,'all',0,5) r", [first.investigation_id]))[0].r;
    return JSON.stringify(seen) === JSON.stringify(excluded) && total === excluded.length && inc.rows.every((x) => x.included) && inc.rows[0].debit_minor === "100"
      && bad.code === "INVALID_REQUEST" && stranger.outcome === "not_found" ? true : { n: seen.length, total, bad, stranger };
  });
  await check("completed: the same request replays it, and a new request reuses it (computed once per evaluation)", async () => {
    const again = await asService("SELECT public.tb_investigation_reserve($1,$2,$3,(SELECT request_id FROM public.tb_investigations WHERE id=$4),120) r", [U.owner, inv.up, invCert, first.investigation_id]).then((r) => r[0].r);
    const fresh = await reserve(U.owner, invCert, uuid());
    return again.outcome === "completed" && again.replay === true && fresh.outcome === "completed" && fresh.investigation_id === first.investigation_id ? true : { again, fresh };
  });
  await check("investigations and their rows cannot be edited; rows are not readable directly by a client", async () => {
    const e = await admin.query("UPDATE public.tb_investigations SET result='{}'::jsonb WHERE id=$1", [first.investigation_id]).then(() => "updated", refusedWith(/append-only/));
    const r = await admin.query("DELETE FROM public.tb_investigation_rows WHERE investigation_id=$1", [first.investigation_id]).then(() => "deleted", refusedWith(/written once/));
    const direct = await asRole("authenticated", U.owner, "SELECT count(*) FROM public.tb_investigation_rows").then(() => "read", refusedWith(/permission denied/));
    return e === true && r === true && direct === true ? true : { e, r, direct };
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => `${f.group} / ${f.name}`).join("; ")}` : ""}`);
  return failed.length === 0;
}

main().then(async (ok) => { await stopDatabase(); process.exit(ok ? 0 : 1); }, async (e) => { console.error(e); await stopDatabase(); process.exit(2); });
