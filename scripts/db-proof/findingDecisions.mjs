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
//   carry-forward  a same-entity confirmation applies to the company's later uploads naming the same entity, and stops
//                  applying when the company's identity changes (the rename race: authority is lost immediately);
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
const entityFinding = (fileEntity, extra = {}) => ({ code: "ENTITY_NAME_DIFFERS", layer: 2, severity: "warning", accountCode: null,
  message: `This file names ${fileEntity}.`, rows: [1], subject: fileEntity.toLowerCase(), file_entity: fileEntity, ...extra });
const trailingFinding = (rows) => ({ code: "UNRECOGNISED_TRAILING_TEXT", layer: 2, severity: "warning", accountCode: null, message: "Text after the last account.", rows, subject: `rows:${rows.join(",")}` });
const clearingFinding = (code) => ({ code: "CLEARING_ACCOUNT_BALANCE", layer: 2, severity: "warning", accountCode: code, message: "Clearing account has a balance.", rows: [9], subject: `code:${code}` });
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
  await check("privileges: decisions and the decision read for authenticated; the engine helpers and investigation writers for the service only", async () => {
    const r = await one(`SELECT
        has_function_privilege('authenticated','public.record_tb_finding_decision(uuid,uuid,text,text,text,jsonb,text,integer,uuid)','EXECUTE') a,
        has_function_privilege('anon','public.record_tb_finding_decision(uuid,uuid,text,text,text,jsonb,text,integer,uuid)','EXECUTE') b,
        has_function_privilege('authenticated','public.get_tb_finding_decisions(uuid)','EXECUTE') c,
        has_function_privilege('authenticated','public.tb_current_finding_decisions(uuid)','EXECUTE') d,
        has_function_privilege('authenticated','public.tb_investigation_reserve(uuid,uuid,uuid,uuid,integer)','EXECUTE') e,
        has_function_privilege('service_role','public.tb_investigation_reserve(uuid,uuid,uuid,uuid,integer)','EXECUTE') f,
        has_function_privilege('authenticated','public.tb_investigation_complete(uuid,text,jsonb,text)','EXECUTE') g,
        has_table_privilege('authenticated','public.tb_finding_decisions','INSERT') h`);
    return r.a && !r.b && r.c && !r.d && !r.e && r.f && !r.g && !r.h ? true : r;
  });

  // ── Fixture: one tenant with two companies, a stranger; invented names only ──────────────────────────────────────
  const U = { owner: uuid(), stranger: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const uid of [U.owner, U.stranger]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 0 FROM public.commercial_plans WHERE product_id=$2 AND code='FIRM'", [bc, prod]);
  }
  const C = (await one("INSERT INTO public.companies (user_id,name,code,tin) VALUES ($1,'Invented Alpha Ltd','A1','900000001') RETURNING id", [U.owner])).id;
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
    return { up, src };
  }
  const begin = async (u, gen) => (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v7',$4,'workspace_user',NULL,$5,600) r",
    [u.up, uuid(), u.src, gen, U.owner]))[0].r;
  // '#entity_decisions' only for a run that used a carried-forward decision (as the engine records it).
  const keys = (u) => [{ scope: C, key: "#framework" }, { scope: C, key: "#currency" }, { scope: "global", key: "#dictionary" },
    { scope: C, key: `#finding_decisions:${u.up}` }, { scope: C, key: "#entity" }, ...(u.carried ? [{ scope: C, key: "#entity_decisions" }] : [])];
  const snapshot = (run, u) => asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb) r", [run, JSON.stringify(keys(u))]);
  const finalize = async (run, r) => (await asService("SELECT public.tb_finalize_attempt($1,$2::jsonb) r", [run, JSON.stringify(r)]))[0].r;
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
  /** Fixture only: ends a lease now (ordinary triggers off for this one statement), as time passing would. */
  async function expire(table, id) {
    await admin.query("SET session_replication_role = replica");
    try { await admin.query(`UPDATE public.${table} SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [id]); }
    finally { await admin.query("SET session_replication_role = origin"); }
  }
  const latestCert = async (up) => (await one("SELECT id FROM public.tb_certifications WHERE upload_id=$1 ORDER BY sequence_no DESC LIMIT 1", [up]))?.id ?? null;
  const decide = (uid, a) => asRole("authenticated", uid, "SELECT public.record_tb_finding_decision($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) r",
    [a.upload, a.cert, a.code, a.subject, a.action, JSON.stringify(a.payload ?? {}), a.reason ?? "Checked against the signed engagement letter", a.expected ?? 0, a.request ?? uuid()]).then((r) => r[0].r);
  const authoritative = async () => (await asRole("authenticated", U.owner, "SELECT id FROM public.get_authoritative_certification($1, 2025)", [C]))[0]?.id ?? null;
  const current = async (up) => (await asService("SELECT * FROM public.tb_current_finding_decisions($1) ORDER BY code, subject", [up]));

  group("Manifest — generation 7 reports every rule once and agrees with its findings; unknown generations are refused");
  const d = await newUpload(2025);
  const m = await newUpload();
  await check("no manifest → refused (malformed)", async () => { const r = await certify(m, { ...g7({ review: true, findings: [entityFinding("Invented Beta Trading")] }), certification: { ...g7({ review: true, findings: [entityFinding("Invented Beta Trading")] }).certification, evaluation: undefined } }); return /manifest is malformed/.test(r.error ?? "") ? true : r; });
  await check("a required rule omitted → refused", async () => { const r = await certify(m, g7({ manifest: RULES.filter((x) => x !== "trailing_text").map((rule) => ({ rule, outcome: "passed" })) })); return /omits a required rule/.test(r.error ?? "") ? true : r; });
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
  await check("a decision-taking finding without a subject → refused", async () => { const f = entityFinding("Invented Beta Trading"); delete f.subject; const r = await certify(m, g7({ review: true, findings: [f] })); return /has no subject/.test(r.error ?? "") ? true : r; });
  await check("an ACCEPTED result with an undecided entity finding → refused (the confirmation is server-enforced)", async () => { const r = await certify(m, g7({ findings: [entityFinding("Invented Beta Trading")] })); return /needs a decision/.test(r.error ?? "") ? true : r; });
  await check("generation 7 without its complete findings → refused", async () => { const r = await certify(m, g7({ omitFindings: true })); return /complete findings/.test(r.error ?? "") ? true : r; });
  await check("a generation newer than the database (8) is refused at begin, before anything is written", async () => { const r = await certify(m, g7({}), 8); return r.begin?.code === "ENGINE_GENERATION_UNSUPPORTED" ? true : r; });
  await check("generation 6 without a manifest is served as before (no decisions recorded yet)", async () => {
    const u = await newUpload();
    const r = await certify(u, { ...g7({ review: true }), certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: false, requires_review: true, rows_snapshot: [], exceptions: [] } }, 6);
    return r.outcome === "certified" ? true : r;
  });

  group("Decisions — identity, confirmations, replay, conflicts, immediate invalidation");
  const review = await certify(d, g7({ review: true, findings: [entityFinding("Invented Beta Trading"), trailingFinding([41, 42]), clearingFinding("1190")] }));
  const cert1 = await latestCert(d.up);
  const E = { upload: d.up, cert: cert1, code: "ENTITY_NAME_DIFFERS", subject: "invented beta trading", action: "same_entity",
    payload: { confirmed: true, file_entity: "Invented Beta Trading", workspace_entity: "Invented Alpha Ltd" } };
  await check("the review result with three decision-taking findings is certified (requires review)", async () => (review.outcome === "certified" && cert1 ? true : review));
  await check("a stranger cannot decide (not found: the upload is not theirs to see)", async () => { const r = await decide(U.stranger, E); return r.code === "UPLOAD_NOT_FOUND" ? true : r; });
  await check("a finding identity the certification does not contain → FINDING_NOT_FOUND", async () => { const r = await decide(U.owner, { ...E, subject: "someone else" }); return r.code === "FINDING_NOT_FOUND" ? true : r; });
  await check("an action the registry does not offer → ACTION_NOT_AVAILABLE (an imbalance takes no decision at all)", async () => {
    const a = await decide(U.owner, { ...E, action: "accept_anyway" });
    return a.code === "ACTION_NOT_AVAILABLE" ? true : a;
  });
  await check("the same-entity confirmation needs confirmed=true and both names exactly as recorded → CONFIRMATION_REQUIRED", async () => {
    const a = await decide(U.owner, { ...E, payload: { ...E.payload, confirmed: false } });
    const b = await decide(U.owner, { ...E, payload: { ...E.payload, file_entity: "Invented Beta" } });
    const c = await decide(U.owner, { ...E, payload: { ...E.payload, workspace_entity: "Another Name" } });
    return [a, b, c].every((x) => x.code === "CONFIRMATION_REQUIRED") ? true : { a, b, c };
  });
  await check("a reason is required → REASON_REQUIRED", async () => { const r = await decide(U.owner, { ...E, reason: " " }); return r.code === "REASON_REQUIRED" ? true : r; });
  await check("a clearing explanation without evidence → EVIDENCE_REQUIRED", async () => {
    const r = await decide(U.owner, { upload: d.up, cert: cert1, code: "CLEARING_ACCOUNT_BALANCE", subject: "code:1190", action: "explained",
      payload: { nature: "in_transit", explanation: "Deposit banked on 31 December, cleared 2 January" } });
    return r.code === "EVIDENCE_REQUIRED" ? true : r;
  });
  await check("the footer decision must name exactly the finding's rows → CONFIRMATION_REQUIRED", async () => {
    const r = await decide(U.owner, { upload: d.up, cert: cert1, code: "UNRECOGNISED_TRAILING_TEXT", subject: "rows:41,42", action: "not_part_of_trial_balance", payload: { confirmed: true, rows: [41] } });
    return r.code === "CONFIRMATION_REQUIRED" ? true : r;
  });
  const req1 = uuid();
  let rec1;
  await check("recorded: the evaluation it was made against is invalidated in the same transaction, and the decisions key moves", async () => {
    const before = await one("SELECT coalesce((SELECT revision FROM public.tb_dependency_revisions WHERE scope=$1 AND dep_key=$2),0) r", [C, `#finding_decisions:${d.up}`]);
    rec1 = await decide(U.owner, { ...E, request: req1 });
    const inv = await one("SELECT reason, operation_id FROM public.tb_certification_invalidations WHERE certification_id=$1", [cert1]);
    const after = await one("SELECT revision r FROM public.tb_dependency_revisions WHERE scope=$1 AND dep_key=$2", [C, `#finding_decisions:${d.up}`]);
    return rec1.outcome === "recorded" && rec1.revision === 1 && inv?.reason === "finding_decision" && inv.operation_id === rec1.decision_id && Number(after.r) === Number(before.r) + 1 ? true : { rec1, inv, before, after };
  });
  await check("the same request again replays the recorded decision; the same request id with other content is a conflict", async () => {
    const a = await decide(U.owner, { ...E, request: req1 });
    const b = await decide(U.owner, { ...E, request: req1, reason: "A different reason entirely" });
    return a.outcome === "recorded" && a.replay === true && a.decision_id === rec1.decision_id && b.code === "IDEMPOTENCY_KEY_REUSED" ? true : { a, b };
  });
  await check("a decision against the now-invalidated evaluation → STALE_EVALUATION", async () => {
    const r = await decide(U.owner, { upload: d.up, cert: cert1, code: "UNRECOGNISED_TRAILING_TEXT", subject: "rows:41,42", action: "not_part_of_trial_balance", payload: { confirmed: true, rows: [42, 41] } });
    return r.code === "STALE_EVALUATION" ? true : r;
  });
  await check("decisions are append-only and written only by the function (insert, update and delete refused even for the service)", async () => {
    const ins = await asService("INSERT INTO public.tb_finding_decisions (upload_id) VALUES ($1)", [d.up]).then(() => "inserted", refusedWith(/FENCED|permission denied|violates/));
    const upd = await admin.query("UPDATE public.tb_finding_decisions SET reason='x' WHERE id=$1", [rec1.decision_id]).then(() => "updated", refusedWith(/append-only/));
    const del = await admin.query("DELETE FROM public.tb_finding_decisions WHERE id=$1", [rec1.decision_id]).then(() => "deleted", refusedWith(/append-only/));
    return ins === true && upd === true && del === true ? true : { ins, upd, del };
  });
  await check("an engine that cannot read decisions (generation 6) is refused for this upload, before anything is written", async () => {
    const r = await begin(d, 6);
    return r.code === "DECISIONS_REQUIRE_CURRENT_ENGINE" ? true : r;
  });
  await check("the snapshot refuses a decisions key that names another upload", async () => {
    const b = await begin(d, 7);
    const r = await asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb)", [b.engine_run_id, JSON.stringify([{ scope: C, key: `#finding_decisions:${m.up}` }])]).then(() => "accepted", refusedWith(/INVALID_DEPENDENCIES/));
    await expire("engine_runs", b.engine_run_id);
    return r;
  });

  group("Re-check — decisions applied; an accepted result needs every decision current and resolving");
  let cert2, rec2, rec3;
  await check("the re-check certifies for review; the remaining two findings are then decided against it", async () => {
    const r = await certify(d, g7({ review: true, findings: [entityFinding("Invented Beta Trading", { decision: { id: rec1.decision_id, action: "same_entity" } }), trailingFinding([41, 42]), clearingFinding("1190")] }));
    cert2 = await latestCert(d.up);
    rec2 = await decide(U.owner, { upload: d.up, cert: cert2, code: "UNRECOGNISED_TRAILING_TEXT", subject: "rows:41,42", action: "not_part_of_trial_balance", payload: { confirmed: true, rows: [42, 41] } });
    const cert2b = await latestCert(d.up); // still cert2, now invalidated
    const r3 = await certify(d, g7({ review: true, findings: [entityFinding("Invented Beta Trading", { decision: { id: rec1.decision_id, action: "same_entity" } }), trailingFinding([41, 42]), clearingFinding("1190")] }));
    const cert3 = await latestCert(d.up);
    rec3 = await decide(U.owner, { upload: d.up, cert: cert3, code: "CLEARING_ACCOUNT_BALANCE", subject: "code:1190", action: "explained",
      payload: { nature: "in_transit", explanation: "Deposit banked on 31 December, cleared 2 January", evidence: { kind: "document", reference: "Bank statement January, line 3" } } });
    return r.outcome === "certified" && rec2.outcome === "recorded" && cert2b === cert2 && r3.outcome === "certified" && rec3.outcome === "recorded" ? true : { r, rec2, r3, rec3 };
  });
  const decided = () => [
    entityFinding("Invented Beta Trading", { decision: { id: rec1.decision_id, action: "same_entity" } }),
    { ...trailingFinding([41, 42]), decision: { id: rec2.decision_id, action: "not_part_of_trial_balance" } },
    { ...clearingFinding("1190"), decision: { id: rec3.decision_id, action: "explained" } },
  ];
  await check("citing a decision that is not current (an invented id) → refused", async () => {
    const f = decided(); f[0] = { ...f[0], decision: { id: uuid(), action: "same_entity" } };
    const r = await certify(d, g7({ findings: f }));
    return /not current/.test(r.error ?? "") ? true : r;
  });
  await check("with every finding decided, the re-check is ACCEPTED and authoritative", async () => {
    const r = await certify(d, g7({ findings: decided() }));
    const auth = await authoritative();
    return r.outcome === "certified" && auth === (await latestCert(d.up)) ? true : { r, auth };
  });
  await check("the browser read lists the three current decisions for the workspace, and nothing for a stranger", async () => {
    const a = (await asRole("authenticated", U.owner, "SELECT public.get_tb_finding_decisions($1) r", [d.up]))[0].r;
    const b = (await asRole("authenticated", U.stranger, "SELECT public.get_tb_finding_decisions($1) r", [d.up]))[0].r;
    return a.outcome === "ok" && a.decisions.length === 3 && a.recorded === 3 && b.outcome === "not_found" ? true : { a, b };
  });
  await check("a different-entity decision is recorded but does not resolve: an accepted result citing it is refused", async () => {
    const u = await newUpload();
    await certify(u, g7({ review: true, findings: [entityFinding("Invented Gamma Co")] }));
    const r = await decide(U.owner, { upload: u.up, cert: await latestCert(u.up), code: "ENTITY_NAME_DIFFERS", subject: "invented gamma co", action: "different_entity",
      payload: { confirmed: true, file_entity: "Invented Gamma Co", workspace_entity: "Invented Alpha Ltd" } });
    const acc = await certify(u, g7({ findings: [entityFinding("Invented Gamma Co", { decision: { id: r.decision_id, action: "different_entity" } })] }));
    const blk = await certify(u, g7({ blocking: true, findings: [entityFinding("Invented Gamma Co", { decision: { id: r.decision_id, action: "different_entity" } }),
      { code: "ENTITY_WRONG_DESTINATION", layer: 2, severity: "error", accountCode: null, message: "This file belongs to another entity." }] }));
    return r.outcome === "recorded" && /needs a decision/.test(acc.error ?? "") && blk.outcome === "certified" ? true : { r, acc, blk };
  });

  group("Carry-forward and the rename race");
  const later = await newUpload();
  await check("a later upload of the same company naming the same entity carries the same-entity confirmation", async () => {
    const cur = await current(later.up);
    return cur.length === 1 && cur[0].decision_id === rec1.decision_id && cur[0].carried_from_upload_id === d.up ? true : cur;
  });
  await check("…and is accepted citing it; the explanation of a clearing balance is NOT carried (period-specific)", async () => {
    const cur = await current(later.up);
    later.carried = true;
    const r = await certify(later, g7({ findings: [entityFinding("Invented Beta Trading", { decision: { id: rec1.decision_id, action: "same_entity" } })] }));
    return r.outcome === "certified" && !cur.some((x) => x.code === "CLEARING_ACCOUNT_BALANCE") ? true : { r, cur };
  });
  await check("a new entity decision elsewhere in the company: a result that used a carried decision loses authority; one that did not keeps it", async () => {
    const runOf = async (up) => (await one("SELECT engine_run_id r FROM public.tb_certifications WHERE upload_id=$1 ORDER BY sequence_no DESC LIMIT 1", [up])).r;
    const authOf = async (up) => (await one("SELECT public.tb_run_authoritative($1) a", [await runOf(up)])).a;
    const before = [await authOf(later.up), await authOf(d.up)];
    const x = await newUpload();
    await certify(x, g7({ review: true, findings: [entityFinding("Invented Delta Plc")] }));
    await decide(U.owner, { upload: x.up, cert: await latestCert(x.up), code: "ENTITY_NAME_DIFFERS", subject: "invented delta plc", action: "same_entity",
      payload: { confirmed: true, file_entity: "Invented Delta Plc", workspace_entity: "Invented Alpha Ltd" } });
    const after = [await authOf(later.up), await authOf(d.up)];
    return before[0] && before[1] && !after[0] && after[1] ? true : { before, after };
  });
  await check("renaming the company: the accepted result loses authority at once, and the confirmation no longer carries", async () => {
    const before = await authoritative();
    await admin.query("UPDATE public.companies SET name='Invented Alpha Holdings Ltd' WHERE id=$1", [C]);
    const after = await authoritative();
    const cur = await current(later.up);
    return before !== null && after === null && cur.length === 0 ? true : { before, after, cur };
  });
  await check("a company code or TIN change also moves the entity key; an unrelated column does not", async () => {
    const rev = async () => Number((await one("SELECT revision r FROM public.tb_dependency_revisions WHERE scope=$1 AND dep_key='#entity'", [C])).r);
    const a = await rev(); await admin.query("UPDATE public.companies SET tin='900000002' WHERE id=$1", [C]);
    const b = await rev(); await admin.query("UPDATE public.companies SET updated_at=now() WHERE id=$1", [C]).catch(() => {});
    const c = await rev();
    return b === a + 1 && c === b ? true : { a, b, c };
  });

  group("Investigation — one durable reservation, recoverable lease, bounded result");
  const inv = await newUpload();
  await certify(inv, g7({ blocking: true, findings: [imbalanceFinding()] }));
  const invCert = await latestCert(inv.up);
  const reserve = (uid, cert, request, lease = 120) => asService("SELECT public.tb_investigation_reserve($1,$2,$3,$4,$5) r", [uid, inv.up, cert, request, lease]).then((r) => r[0].r);
  await check("not applicable to a result that is not out of balance", async () => {
    const r = await asService("SELECT public.tb_investigation_reserve($1,$2,$3,$4,60) r", [U.owner, d.up, await latestCert(d.up), uuid()]).then((x) => x[0].r);
    return r.code === "NOT_APPLICABLE" ? true : r;
  });
  await check("a stranger is refused", async () => { const r = await reserve(U.stranger, invCert, uuid()); return r.code === "FORBIDDEN" ? true : r; });
  let first;
  await check("12 concurrent requests: exactly one reservation; the others are told one is in progress", async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, () => reserve(U.owner, invCert, uuid())));
    const reserved = rs.filter((r) => r.outcome === "reserved");
    first = reserved[0];
    const running = await one("SELECT count(*)::int n FROM public.tb_investigations WHERE upload_id=$1 AND status='running'", [inv.up]);
    return reserved.length === 1 && rs.filter((r) => r.outcome === "in_progress").length === 11 && running.n === 1 ? true : rs.map((r) => r.outcome);
  });
  await check("a stale evaluation id is refused", async () => { const r = await reserve(U.owner, cert1, uuid()); return r.code === "STALE_EVALUATION" ? true : r; });
  await check("an unbounded result is refused (more than 50 leads)", async () =>
    asService("SELECT public.tb_investigation_complete($1,'completed',$2::jsonb,NULL)", [first.investigation_id, JSON.stringify({ leads: Array.from({ length: 51 }, () => ({})) })])
      .then(() => "accepted", refusedWith(/INVALID_RESULT/)));
  await check("an expired lease is recovered by the next request; the late worker is fenced out", async () => {
    await expire("tb_investigations", first.investigation_id);
    const next = await reserve(U.owner, invCert, uuid());
    const old = await one("SELECT status FROM public.tb_investigations WHERE id=$1", [first.investigation_id]);
    const late = await asService("SELECT public.tb_investigation_complete($1,'completed',$2::jsonb,NULL)", [first.investigation_id, JSON.stringify({ leads: [] })]).then(() => "accepted", refusedWith(/INVESTIGATION_NOT_CURRENT/));
    first = next;
    return next.outcome === "reserved" && old.status === "abandoned" && late === true ? true : { next, old, late };
  });
  await check("completed: the same request replays it, and a new request reuses it (computed once per evaluation)", async () => {
    const leads = [{ kind: "single_row_equals_difference", rows: [12] }];
    await asService("SELECT public.tb_investigation_complete($1,'completed',$2::jsonb,NULL)", [first.investigation_id, JSON.stringify({ leads, difference: "100.00" })]);
    const again = await asService("SELECT public.tb_investigation_reserve($1,$2,$3,(SELECT request_id FROM public.tb_investigations WHERE id=$4),120) r", [U.owner, inv.up, invCert, first.investigation_id]).then((r) => r[0].r);
    const fresh = await reserve(U.owner, invCert, uuid());
    return again.outcome === "completed" && again.replay === true && fresh.outcome === "completed" && fresh.investigation_id === first.investigation_id && fresh.result.leads.length === 1 ? true : { again, fresh };
  });
  await check("investigations are readable in the workspace only, and closed rows cannot be edited", async () => {
    const a = await asRole("authenticated", U.owner, "SELECT count(*)::int n FROM public.tb_investigations WHERE upload_id=$1", [inv.up]);
    const b = await asRole("authenticated", U.stranger, "SELECT count(*)::int n FROM public.tb_investigations WHERE upload_id=$1", [inv.up]);
    const e = await admin.query("UPDATE public.tb_investigations SET result='{}'::jsonb WHERE id=$1", [first.investigation_id]).then(() => "updated", refusedWith(/append-only/));
    return a[0].n >= 2 && b[0].n === 0 && e === true ? true : { a, b, e };
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => `${f.group} / ${f.name}`).join("; ")}` : ""}`);
  return failed.length === 0;
}

main().then(async (ok) => { await stopDatabase(); process.exit(ok ? 0 : 1); }, async (e) => { console.error(e); await stopDatabase(); process.exit(2); });
