#!/usr/bin/env bun
// Real-PostgreSQL proof of the period currency correction (20261113100000; owner-approved currency-recovery repair).
//
//   reproduction  on the chain without the repair, a check refused for CURRENCY_MISMATCH locks the period's wrong
//                 currency for good (PERIOD_LOCKED_BY_PROCESSING);
//   eligibility   the refused-currency period is correctable; an accepted certification (also one requiring review), a
//                 downstream record and a running check each refuse it, named by their record;
//   correction    authorised, recorded (old/new, reason, actor, request, time), idempotent, version-checked; nothing
//                 else changes (certifications and upload rows byte-identical; no amount converted);
//   refusals      non-member, another tenant, pending member, anonymous; the processing lock still holds for others;
//   concurrency   finalize vs correction in both orders, a downstream write vs an open correction, two requests at
//                 once, 12 duplicate clicks;
//   recovery      the same source re-checked as a new attempt with the deterministic re-check id; a retry replays.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/periodCurrencyCorrection.mjs
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
const REPAIR_FILE = "20261113100000_period_currency_correction.sql";
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
async function refused(name, code, fn, text) {
  try { await fn(); record(name, false, "no error was raised"); }
  catch (e) { record(name, e.code === code && (!text || String(e.message).includes(text)), `expected ${code}${text ? ` ${text}` : ""}, got ${e.code}: ${String(e.message).split("\n")[0]}`); }
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-period-currency-proof-"));
  const port = 56900 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE period_currency_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/period_currency_proof`;
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
const count = async (sql, p = []) => Number((await one(sql, p)).n);
const asService = (sql, params) => asRole("service_role", null, sql, params);

const SRC = crypto.createHash("sha256").update("period-currency-correction-proof").digest("hex");
const G7_RULES = [
  "source_read", "columns", "period_and_currency", "duplicate_identities", "balance",
  "entity_name", "trailing_text", "clearing_accounts", "classification",
];
const findingRule = (code) => code === "CURRENCY_MISMATCH" ? "period_and_currency" : null;
const evaluationFor = (findings) => ({
  format: "tb-evaluation/1",
  rules: G7_RULES.map((rule) => ({ rule, outcome: findings.some((f) => findingRule(f.code) === rule) ? "finding" : "passed" })),
});
const blockingResult = () => ({ outcome: "certified",
  upload: { status: "blocked", is_valid: false, processing_result: { status: "blocked" }, validation_report: { ok: false }, accounting_errors: [] },
  certification: (() => {
    const findings = [{ code: "CURRENCY_MISMATCH", layer: 2, severity: "error", accountCode: null, message: "The currency labels on row 11 do not match the selected currency USD." }];
    return { normalized_input_hash: "n", output_hash: "o", is_blocking: true, requires_review: false, rows_snapshot: [],
      exceptions: findings, findings, evaluation: evaluationFor(findings) };
  })() });
const acceptedResult = (requiresReview) => ({ outcome: "certified",
  upload: { status: requiresReview ? "needs_review" : "complete", is_valid: !requiresReview, processing_result: { status: "x" }, validation_report: { ok: true }, accounting_errors: [] },
  certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: false, requires_review: requiresReview, rows_snapshot: [], exceptions: [], findings: [], evaluation: evaluationFor([]) } });

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
  const applyFile = async (f) => {
    let t = migrationSql(REPO, f);
    if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    await admin.query(t);
  };
  const cut = files.indexOf(REPAIR_FILE);
  let attemptGeneration = 6;

  group("Replay — the chain up to (not including) the repair");
  await check(`${REPAIR_FILE} is in the chain and everything before it applies`, async () => {
    if (cut < 0) return `${REPAIR_FILE} missing`;
    for (const f of files.slice(0, cut)) { try { await applyFile(f); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; } }
    return true;
  });

  const U = { owner: uuid(), ownerB: uuid(), outsider: uuid(), pending: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const uid of [U.owner, U.ownerB]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 0 FROM public.commercial_plans WHERE product_id=$2 AND code='FIRM'", [bc, prod]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Currency A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Currency B') RETURNING id", [U.ownerB])).id;
  // A member of A who has not accepted the invitation: never an actor.
  await admin.query("INSERT INTO public.firm_members (company_id, user_id, role, invited_email) VALUES ($1,$2,'staff','pending@example.test')", [A, U.pending]).catch(() => {});

  let year = 2000;
  /** A period in `company` reporting in `currency`, with one upload and a claimed attempt. */
  async function periodWithAttempt(company = A, owner = U.owner, currency = "USD", generation = attemptGeneration) {
    const y = ++year;
    const period = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [company, `${y}-12-31`, `FY${y}`, owner, currency, `${y}-01-01`, `${y}-12-31`])).id;
    const up = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id, source_file_hash)
      VALUES ('tb-tzs.csv',$1,10,'processing',$2,$3,$4,$5,$6) RETURNING id`, [`${owner}/${uuid()}.csv`, company, y, period, owner, SRC])).id;
    const b = (await asService(`SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v${generation}',${generation},'workspace_user',NULL,$4,600) r`, [up, uuid(), SRC, owner]))[0].r;
    if (b.outcome !== "claimed") throw new Error(`begin: ${JSON.stringify(b)}`);
    return { period, up, run: b.engine_run_id, company, year: y };
  }
  const snapshot = (run, company) => asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb) r",
    [run, JSON.stringify([{ scope: company, key: "#framework" }, { scope: company, key: "#currency" }, { scope: "global", key: "#dictionary" }])]);
  const finalize = async (run, result) => (await asService("SELECT public.tb_finalize_attempt($1,$2::jsonb) r", [run, JSON.stringify(result)]))[0].r;
  /** The scenario the repair exists for: a check refused because the file's currency contradicted the period's. */
  async function blockedPeriod(company = A, owner = U.owner, generation = attemptGeneration) {
    const t = await periodWithAttempt(company, owner, "USD", generation);
    await snapshot(t.run, company);
    const f = await finalize(t.run, blockingResult());
    if (f.outcome !== "certified") throw new Error(`finalize: ${JSON.stringify(f)}`);
    return { ...t, certification: f.certification_id };
  }
  const asUser = async (uid, sql, params) => (await asRole("authenticated", uid, sql, params))[0];
  const correct = (uid, period, to, from, req = uuid(), reason = "The trial balance is in Tanzanian shillings") =>
    asUser(uid, "SELECT public.correct_period_currency($1,$2,$3,$4,$5) r", [period, to, from, reason, req]).then((x) => x.r);
  const eligibility = (uid, period) => asUser(uid, "SELECT public.get_period_currency_correction($1) r", [period]).then((x) => x.r);
  const currencyOf = async (period) => (await one("SELECT reporting_currency c FROM public.fiscal_periods WHERE id=$1", [period])).c;
  const fp = async (t) => (await one(`SELECT md5(coalesce((SELECT string_agg(to_jsonb(c)::text, ',' ORDER BY c.id) FROM public.tb_certifications c WHERE c.upload_id=$1),''))
      || md5((SELECT (to_jsonb(u) - 'updated_at')::text FROM public.trial_balance_uploads u WHERE u.id=$1)) h`, [t.up])).h;

  group("Reproduction — on the chain without the repair, a refused check locks the wrong currency for good");
  const R = await blockedPeriod();
  await refused("a blocking CURRENCY_MISMATCH check locks the period: changing its currency fails PERIOD_LOCKED_BY_PROCESSING", "55000",
    () => admin.query("UPDATE public.fiscal_periods SET reporting_currency='TZS' WHERE id=$1", [R.period]), "PERIOD_LOCKED_BY_PROCESSING");

  group("Repair — applied over the same database");
  await check(`${REPAIR_FILE} applies, and every later migration applies on top`, async () => {
    await applyFile(REPAIR_FILE);
    for (const f of files.slice(cut + 1)) { try { await applyFile(f); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; } }
    return true;
  });
  await refused("applying it again is refused by its preflight", "P0001", () => admin.query(migrationSql(REPO, REPAIR_FILE)), "PREFLIGHT_REFUSED");
  await check("the downstream scan is exhaustive: every foreign key into the uploads, the period or its certifications, and every company+period table, is listed here as bookkeeping or blocking", async () => {
    const allow = (await one("SELECT public._period_currency_bookkeeping() a")).a;
    const fks = (await admin.query(`SELECT DISTINCT format('%I.%I', n.nspname, cl.relname) rel, a.attname col, c.confrelid::regclass::text target
        FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid IN ('public.trial_balance_uploads'::regclass, 'public.fiscal_periods'::regclass, 'public.tb_certifications'::regclass)
       ORDER BY 1, 2`)).rows;
    const keyed = (await admin.query(`SELECT format('%I.%I', table_schema, table_name) rel FROM information_schema.tables t WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = t.table_schema AND k.table_name = t.table_name AND k.column_name = 'company_id')
        AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = t.table_schema AND k.table_name = t.table_name AND k.column_name IN ('period_year', 'reporting_period_id'))
       ORDER BY 1`)).rows;
    for (const f of fks) console.log(`        ${allow.includes(f.rel) ? "bookkeeping" : "BLOCKS     "}  ${f.rel}.${f.col} -> ${f.target}`);
    for (const k of keyed) console.log(`        ${allow.includes(k.rel) ? "bookkeeping" : "BLOCKS     "}  ${k.rel} (company + period key)`);
    return fks.length > 0 && keyed.length > 0 ? true : { fks, keyed };
  });
  attemptGeneration = 7;
  await check("privileges: the read and the operation for authenticated only; the internal helpers for nobody", async () => {
    const r = await one(`SELECT has_function_privilege('authenticated','public.correct_period_currency(uuid,text,text,text,uuid)','EXECUTE') a,
        has_function_privilege('anon','public.correct_period_currency(uuid,text,text,text,uuid)','EXECUTE') b,
        has_function_privilege('authenticated','public.get_period_currency_correction(uuid)','EXECUTE') c,
        has_function_privilege('authenticated','public._period_currency_correction_block(uuid)','EXECUTE') d,
        has_function_privilege('authenticated','public._period_currency_actor(uuid,uuid)','EXECUTE') e,
        has_function_privilege('authenticated','public._period_currency_dependent_relations()','EXECUTE') f,
        has_function_privilege('authenticated','public._period_currency_dependencies(oid)','EXECUTE') g`);
    return r.a && !r.b && r.c && !r.d && !r.e && !r.f && !r.g ? true : r;
  });

  group("Eligibility — the refused-currency period is correctable; the rule's records are named exactly");
  await check("the blocked period (one blocking CURRENCY_MISMATCH certification, its run, its dependencies) is eligible", async () => {
    const e = await eligibility(U.owner, R.period);
    return e.outcome === "eligible" && e.currency === "USD" && e.block === null ? true : e;
  });
  await check("an ACCEPTED certification that still REQUIRES REVIEW blocks it, named with its record", async () => {
    const t = await periodWithAttempt(); await snapshot(t.run, A);
    const f = await finalize(t.run, acceptedResult(true));
    const e = await eligibility(U.owner, t.period);
    return e.outcome === "not_eligible" && e.block.code === "ACCEPTED_CERTIFICATION" && e.block.record_id === f.certification_id && e.block.requires_review === true ? true : { e, f };
  });
  await check("an accepted certification that needs no review blocks it too", async () => {
    const t = await periodWithAttempt(); await snapshot(t.run, A);
    const f = await finalize(t.run, acceptedResult(false));
    const e = await eligibility(U.owner, t.period);
    return e.block?.code === "ACCEPTED_CERTIFICATION" && e.block.requires_review === false ? true : { e, f };
  });
  await check("a downstream record referencing the upload (management_inputs) blocks it, named by relation", async () => {
    const t = await blockedPeriod();
    await admin.query("INSERT INTO public.management_inputs (company_id, upload_id, period_year, created_by) VALUES ($1,$2,(SELECT period_year FROM public.trial_balance_uploads WHERE id = $2),$3)", [A, t.up, U.owner]);
    const e = await eligibility(U.owner, t.period);
    return e.block?.code === "DOWNSTREAM_RECORD" && e.block.relation === "public.management_inputs" ? true : e;
  });
  await check("the scheduled identity sweep's flag on the upload (upload_integrity_findings: no amount, no currency) does not block it", async () => {
    const t = await blockedPeriod();
    await admin.query("INSERT INTO public.upload_integrity_findings (upload_id, company_id, issue_type) VALUES ($1,$2,'ENGAGEMENT_PERIOD_MISMATCH')", [t.up, A]);
    const e = await eligibility(U.owner, t.period);
    return e.outcome === "eligible" ? true : e;
  });
  await check("financial statement evidence for the period (company + 'FY' reporting period id) blocks it, named by relation", async () => {
    const t = await blockedPeriod();
    const y = (await one("SELECT extract(year FROM coalesce(reporting_end, fiscal_year_end))::int y FROM public.fiscal_periods WHERE id=$1", [t.period])).y;
    const m = await one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.owner]);
    const h = "a".repeat(64);
    await admin.query(`INSERT INTO public.financial_evidence_batches (evidence_batch_id, company_id, reporting_period_id, evidence_type, period_role,
        schema_version, content_hash, document_hash, replay_identity, currency, scale, batch_document, diagnostics, validation_status, version, uploaded_by_firm_member_id)
      VALUES ($1,$2,$3,'TRANSACTION_LEDGER','CURRENT','1',$4,$4,$4,'USD',2,'{}','[]','VALID',1,$5)`, [`ev-${uuid()}`, A, `FY${y}`, h, m.id]);
    const e = await eligibility(U.owner, t.period);
    return e.block?.code === "DOWNSTREAM_RECORD" && e.block.relation === "public.financial_evidence_batches" ? true : e;
  });
  await check("a check still running within its lease blocks it (PROCESSING_IN_PROGRESS)", async () => {
    const t = await periodWithAttempt();
    const e = await eligibility(U.owner, t.period);
    return e.block?.code === "PROCESSING_IN_PROGRESS" && e.block.record_id === t.run ? true : e;
  });
  await check("the read answers nothing to a non-member, another tenant, a pending member or an anonymous caller", async () => {
    const a = await eligibility(U.outsider, R.period), b = await eligibility(U.ownerB, R.period), c = await eligibility(U.pending, R.period);
    const d = await asRole("anon", null, "SELECT public.get_period_currency_correction($1) r", [R.period]).then(() => "ran", (e) => e.code);
    return a.outcome === "not_found" && b.outcome === "not_found" && c.outcome === "not_found" && d === "42501" ? true : { a, b, c, d };
  });

  group("Correction — authorised, recorded, idempotent, version-checked; nothing else changes");
  const before = await fp(R);
  const revBefore = await one("SELECT revision r FROM public.tb_dependency_revisions WHERE scope=$1 AND dep_key='#currency'", [A]).then((x) => x?.r ?? null, () => null);
  const req = uuid();
  const c1 = await correct(U.owner, R.period, "TZS", "USD", req);
  await check("the owner corrects USD → TZS: corrected, the period now reports TZS", async () =>
    c1.outcome === "corrected" && c1.from === "USD" && c1.to === "TZS" && (await currencyOf(R.period)) === "TZS" ? true : c1);
  await check("the history records old and new currency, the reason, the actor (member and user), the request and the time", async () => {
    const e = await one("SELECT * FROM public.fiscal_period_events WHERE id=$1", [c1.event_id]);
    const m = await one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.owner]);
    return e.action === "currency_corrected" && e.detail.from === "USD" && e.detail.to === "TZS" && /shillings/.test(e.detail.reason)
      && e.detail.request_id === req && e.actor_user_id === U.owner && e.actor_member_id === m.id && e.occurred_at ? true : e;
  });
  await check("no certification, upload field or source reference changed (byte-identical rows); no amount converted", async () => (await fp(R)) === before ? true : "changed");
  await check("the '#currency' dependency revision moved (a check that read USD can no longer certify)", async () => {
    const after = await one("SELECT revision r FROM public.tb_dependency_revisions WHERE scope=$1 AND dep_key='#currency'", [A]).then((x) => x?.r ?? null, () => null);
    return after !== null && String(after) !== String(revBefore) ? true : { revBefore, after };
  });
  await check("the answer names the trial balance to re-check with a deterministic operation id", async () =>
    Array.isArray(c1.rechecks) && c1.rechecks.length === 1 && c1.rechecks[0].upload_id === R.up && /^[0-9a-f-]{36}$/.test(c1.rechecks[0].operation_id) ? true : c1);
  await check("after a reload the read still names that correction and its re-check id (and never the reason)", async () => {
    const r = await eligibility(U.owner, R.period);
    const l = r.last_correction;
    return l && l.event_id === c1.event_id && l.from === "USD" && l.to === "TZS" && l.rechecks?.[0]?.operation_id === c1.rechecks[0].operation_id
      && !("reason" in l) && r.currency === "TZS" ? true : r;
  });
  await check("a duplicate click (the same request) answers already_corrected with the same event and re-check id; one event", async () => {
    const c2 = await correct(U.owner, R.period, "TZS", "USD", req);
    const n = await count("SELECT count(*) n FROM public.fiscal_period_events WHERE period_id=$1 AND action='currency_corrected'", [R.period]);
    return c2.outcome === "already_corrected" && c2.event_id === c1.event_id && c2.rechecks[0].operation_id === c1.rechecks[0].operation_id && n === 1 ? true : { c2, n };
  });
  await check("the same request id with a different change is a conflict, never a second change", async () => {
    const c3 = await correct(U.owner, R.period, "KES", "USD", req);
    return c3.outcome === "request_conflict" && (await currencyOf(R.period)) === "TZS" ? true : c3;
  });
  await check("a stale caller (expects USD, the period is TZS now) is refused with the current currency", async () => {
    const c4 = await correct(U.owner, R.period, "KES", "USD");
    return c4.outcome === "stale" && c4.currency === "TZS" ? true : c4;
  });
  await check("invalid input and an unknown currency are refused with nothing changed", async () => {
    const a = await correct(U.owner, R.period, "XYZ", "TZS"), b = await correct(U.owner, R.period, "KES", "TZS", uuid(), "x");
    return a.outcome === "invalid_request" && b.outcome === "invalid_request" && (await currencyOf(R.period)) === "TZS" ? true : { a, b };
  });

  group("Refusals — unauthorised, cross-tenant, downstream, accepted, running");
  const R2 = await blockedPeriod();
  await check("a non-member, another tenant's owner and a pending member are refused (not_found) and nothing changes", async () => {
    const a = await correct(U.outsider, R2.period, "TZS", "USD"), b = await correct(U.ownerB, R2.period, "TZS", "USD"), c = await correct(U.pending, R2.period, "TZS", "USD");
    return [a, b, c].every((x) => x.outcome === "not_found") && (await currencyOf(R2.period)) === "USD" ? true : { a, b, c };
  });
  await check("an anonymous caller cannot execute the operation", async () =>
    (await asRole("anon", null, "SELECT public.correct_period_currency($1,'TZS','USD','reason here',$2) r", [R2.period, uuid()]).then(() => "ran", (e) => e.code)) === "42501" ? true : "ran");
  await check("downstream, accepted and running refusals name their record and change nothing", async () => {
    const d = await blockedPeriod();
    await admin.query("INSERT INTO public.management_inputs (company_id, upload_id, period_year, created_by) VALUES ($1,$2,(SELECT period_year FROM public.trial_balance_uploads WHERE id = $2),$3)", [A, d.up, U.owner]);
    const x = await correct(U.owner, d.period, "TZS", "USD");
    const acc = await periodWithAttempt(); await snapshot(acc.run, A); await finalize(acc.run, acceptedResult(true));
    const y = await correct(U.owner, acc.period, "TZS", "USD");
    const run = await periodWithAttempt();
    const z = await correct(U.owner, run.period, "TZS", "USD");
    const ok = x.outcome === "not_eligible" && x.block.relation === "public.management_inputs"
      && y.outcome === "not_eligible" && y.block.code === "ACCEPTED_CERTIFICATION"
      && z.outcome === "not_eligible" && z.block.code === "PROCESSING_IN_PROGRESS"
      && (await currencyOf(d.period)) === "USD" && (await currencyOf(acc.period)) === "USD" && (await currencyOf(run.period)) === "USD";
    return ok ? true : { x, y, z };
  });
  await check("the processing lock still holds for everyone else: a direct change (owner role, no marker) is refused; the client role is fenced", async () => {
    const a = await admin.query("UPDATE public.fiscal_periods SET reporting_currency='TZS' WHERE id=$1", [R2.period]).then(() => "ran", (e) => e.code);
    const b = await asRole("authenticated", U.owner, "UPDATE public.fiscal_periods SET reporting_currency='TZS' WHERE id=$1", [R2.period]).then(() => "ran", (e) => e.code);
    const c = await admin.query("UPDATE public.fiscal_periods SET reporting_end=reporting_end - 1 WHERE id=$1", [R.period]).then(() => "ran", (e) => e.code);
    return a === "55000" && ["55000", "42501"].includes(b) && c === "55000" && (await currencyOf(R2.period)) === "USD" ? true : { a, b, c };
  });

  group("Concurrency — one lock protocol with processing, certification and downstream writes");
  /** Runs `fn` inside an open transaction as the owner; resolves once its statement returned; commit/rollback on demand. */
  async function held(role, uid, sql, params) {
    const c = await pool.connect();
    await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]);
    const r = await c.query(sql, params);
    return { r: r.rows[0], commit: async () => { await c.query("COMMIT"); c.release(); }, rollback: async () => { await c.query("ROLLBACK"); c.release(); } };
  }
  const waitsFor = async (promise, ms = 700) => Promise.race([promise.then(() => "done", () => "done"), new Promise((r) => setTimeout(() => r("waiting"), ms))]);

  await check("certification first: a finalize holding the upload makes the correction wait; it then sees the accepted certification and refuses", async () => {
    const t = await periodWithAttempt(); await snapshot(t.run, A);
    const fin = await held("service_role", null, "SELECT public.tb_finalize_attempt($1,$2::jsonb) r", [t.run, JSON.stringify(acceptedResult(true))]);
    const p = correct(U.owner, t.period, "TZS", "USD");
    const state = await waitsFor(p);
    await fin.commit();
    const res = await p;
    return state === "waiting" && res.outcome === "not_eligible" && res.block.code === "ACCEPTED_CERTIFICATION" && (await currencyOf(t.period)) === "USD" ? true : { state, res };
  });
  await check("a running check refuses the correction outright (no race window): PROCESSING_IN_PROGRESS, nothing changed", async () => {
    const t = await periodWithAttempt(); await snapshot(t.run, A);
    const r = await correct(U.owner, t.period, "TZS", "USD");
    return r.outcome === "not_eligible" && r.block.code === "PROCESSING_IN_PROGRESS" && (await currencyOf(t.period)) === "USD" ? true : r;
  });
  await check("correction first: a re-check starting meanwhile waits for it, then records the NEW currency revision", async () => {
    const t = await blockedPeriod();
    const c = await held("authenticated", U.owner, "SELECT public.correct_period_currency($1,'TZS','USD','race check reason',$2) r", [t.period, uuid()]);
    const rq = asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [t.up, uuid(), SRC]).then((x) => x.r, (e) => ({ error: e.code }));
    const state = await waitsFor(rq);
    const revDuring = await one("SELECT revision r FROM public.tb_dependency_revisions WHERE scope=$1 AND dep_key='#currency'", [A]).then((x) => x?.r ?? null);
    await c.commit();
    const req = await rq;
    const revAfter = await one("SELECT revision r FROM public.tb_dependency_revisions WHERE scope=$1 AND dep_key='#currency'", [A]).then((x) => x?.r ?? null);
    return c.r.r.outcome === "corrected" && state === "waiting" && req.outcome === "accepted" && String(revAfter) !== String(revDuring)
      && (await currencyOf(t.period)) === "TZS" ? true : { corr: c.r.r, state, req, revDuring, revAfter };
  });
  await check("a downstream write referencing the upload waits for an open correction (KEY SHARE vs FOR UPDATE)", async () => {
    const t = await blockedPeriod();
    const c = await held("authenticated", U.owner, "SELECT public.correct_period_currency($1,'TZS','USD','race check reason',$2) r", [t.period, uuid()]);
    const p = admin.query("INSERT INTO public.management_inputs (company_id, upload_id, period_year, created_by) VALUES ($1,$2,(SELECT period_year FROM public.trial_balance_uploads WHERE id = $2),$3)", [A, t.up, U.owner]);
    const state = await waitsFor(p);
    await c.commit(); await p;
    return c.r.r.outcome === "corrected" && state === "waiting" ? true : { corr: c.r.r, state };
  });
  // Writers keyed only by company and period (no foreign key to the upload or the period): financial-statement evidence
  // is the representative one (its writer is a SECURITY DEFINER RPC that never locks the upload or the period).
  const memberA = (await one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.owner])).id;
  const EVIDENCE_SQL = `INSERT INTO public.financial_evidence_batches (evidence_batch_id, company_id, reporting_period_id, evidence_type, period_role,
      schema_version, content_hash, document_hash, replay_identity, currency, scale, batch_document, diagnostics, validation_status, version, uploaded_by_firm_member_id)
    VALUES ($1,$2,$3,'TRANSACTION_LEDGER','CURRENT','1',$4,$4,$4,'USD',2,'{}','[]','VALID',1,$5)`;
  const evidenceArgs = (t) => [`ev-${uuid()}`, A, `FY${t.year}`, crypto.randomBytes(32).toString("hex"), memberA];
  async function heldAdmin(sql, params) {
    const c = await pool.connect();
    await c.query("BEGIN"); await c.query(sql, params);
    return { commit: async () => { await c.query("COMMIT"); c.release(); }, rollback: async () => { await c.query("ROLLBACK"); c.release(); } };
  }
  const events = (period) => count("SELECT count(*) n FROM public.fiscal_period_events WHERE period_id=$1 AND action='currency_corrected'", [period]);

  await check("no-FK writer, BEFORE: committed evidence for the period makes the correction refuse, naming it; nothing changed", async () => {
    const t = await blockedPeriod();
    await admin.query(EVIDENCE_SQL, evidenceArgs(t));
    const r = await correct(U.owner, t.period, "TZS", "USD");
    return r.outcome === "not_eligible" && r.block.relation === "public.financial_evidence_batches" && (await currencyOf(t.period)) === "USD" && (await events(t.period)) === 0 ? true : r;
  });
  await check("no-FK writer IN FLIGHT when the correction starts: the correction waits for it, then sees it and refuses (never commits past it)", async () => {
    const t = await blockedPeriod();
    const w = await heldAdmin(EVIDENCE_SQL, evidenceArgs(t));
    const p = correct(U.owner, t.period, "TZS", "USD");
    const state = await waitsFor(p);
    await w.commit();
    const r = await p;
    return state === "waiting" && r.outcome === "not_eligible" && r.block.relation === "public.financial_evidence_batches"
      && (await currencyOf(t.period)) === "USD" && (await events(t.period)) === 0 ? true : { state, r };
  });
  await check("no-FK writer that begins DURING an open correction waits; it commits only after, against the corrected period, where no accepted trial balance exists (the statements' authority is empty)", async () => {
    const t = await blockedPeriod();
    const c = await held("authenticated", U.owner, "SELECT public.correct_period_currency($1,'TZS','USD','race check reason',$2) r", [t.period, uuid()]);
    const p = admin.query(EVIDENCE_SQL, evidenceArgs(t));
    const state = await waitsFor(p);
    await c.commit(); await p;
    // fs_reporting_input starts from get_authoritative_certification and answers no_authority without one.
    const authority = await count("SELECT count(*) n FROM public.get_authoritative_certification($1,$2)", [A, t.year]);
    return c.r.r.outcome === "corrected" && state === "waiting" && (await currencyOf(t.period)) === "TZS" && authority === 0 ? true : { corr: c.r.r, state, authority };
  });
  await check("AFTER: the next correction of that period sees the USD-declared evidence and refuses; the statements' only authority (after the normal re-check) reports in the period's TZS", async () => {
    const t = await blockedPeriod();
    const c1r = await correct(U.owner, t.period, "TZS", "USD");
    await admin.query(EVIDENCE_SQL, evidenceArgs(t));
    const back = await correct(U.owner, t.period, "USD", "TZS");
    // The normal re-check certifies under the corrected currency; the statements read their currency from the period.
    const op = c1r.rechecks[0].operation_id;
    const rq = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [t.up, op, SRC])).r;
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v7',7,'workspace_user',NULL,$4,600) r", [t.up, op, SRC, U.owner]))[0].r;
    await snapshot(b.engine_run_id, A);
    const f = await finalize(b.engine_run_id, acceptedResult(false));
    const meta = (await one("SELECT public._fs_period_meta($1,$2) m", [A, f.certification_id])).m;
    return c1r.outcome === "corrected" && back.outcome === "not_eligible" && back.block.relation === "public.financial_evidence_batches"
      && rq.outcome === "accepted" && f.outcome === "certified" && meta.currency === "TZS" ? true : { c1r, back, rq, f, meta };
  });
  await check("a dependent table held by another writer past the bound: 'busy' within the lock timeout, nothing changed, no event; the same request then corrects", async () => {
    const t = await blockedPeriod();
    const other = await heldAdmin("LOCK TABLE public.financial_statement_reports IN ROW EXCLUSIVE MODE", []);
    const id = uuid();
    const started = Date.now();
    const r1 = await correct(U.owner, t.period, "TZS", "USD", id);
    const waited = Date.now() - started;
    const unchanged = (await currencyOf(t.period)) === "USD" && (await events(t.period)) === 0;
    await other.rollback();
    const r2 = await correct(U.owner, t.period, "TZS", "USD", id);
    return r1.outcome === "busy" && waited >= 4500 && waited < 15000 && unchanged && r2.outcome === "corrected" ? true : { r1, waited, unchanged, r2 };
  });
  // ── Table-lock impact ──────────────────────────────────────────────────────────────────────────────────────────────
  const deps = (await admin.query("SELECT r::text AS rel FROM public._period_currency_dependent_relations() r")).rows.map((x) => x.rel);
  await check(`an open correction holds exactly the ${deps.length} dependent tables, in SHARE mode`, async () => {
    const qualified = (await admin.query(`SELECT format('%I.%I', n.nspname, c.relname) q FROM public._period_currency_dependent_relations() r
        JOIN pg_class c ON c.oid = r JOIN pg_namespace n ON n.oid = c.relnamespace`)).rows.map((x) => x.q);
    const sorted = [...qualified].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const t = await blockedPeriod();
    const c = await held("authenticated", U.owner, "SELECT public.correct_period_currency($1,'TZS','USD','lock order check',$2) r", [t.period, uuid()]);
    const held_ = (await admin.query(`SELECT format('%I.%I', n.nspname, cl.relname) q FROM pg_locks l JOIN pg_class cl ON cl.oid = l.relation
        JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE l.locktype = 'relation' AND l.mode = 'ShareLock' AND l.granted
          AND l.pid <> pg_backend_pid() AND format('%I.%I', n.nspname, cl.relname) = ANY ($1)`, [qualified])).rows.map((x) => x.q).sort();
    await c.commit();
    return JSON.stringify(qualified) === JSON.stringify(sorted) && JSON.stringify(held_) === JSON.stringify(sorted) && c.r.r.outcome === "corrected"
      ? true : { qualified, held: held_, outcome: c.r.r.outcome };
  });
  await check("the 5-second budget is ONE total for all lock waits, not per lock: a first table released after 3s and a later one held answer 'busy' at about 5s (not 8s)", async () => {
    const t = await blockedPeriod();
    const first = deps[0], later = deps[deps.length - 1];
    const a = await heldAdmin(`LOCK TABLE ${first} IN ROW EXCLUSIVE MODE`, []);
    const b = await heldAdmin(`LOCK TABLE ${later} IN ROW EXCLUSIVE MODE`, []);
    setTimeout(() => { void a.commit(); }, 3000);
    const t0 = Date.now();
    const r = await correct(U.owner, t.period, "TZS", "USD");
    const waited = Date.now() - t0;
    await b.rollback();
    return r.outcome === "busy" && waited >= 4500 && waited < 6800 && (await currencyOf(t.period)) === "USD" && (await events(t.period)) === 0 ? true : { r, waited, first, later };
  });
  await check("the budget also bounds the row locks: the period's upload held by another transaction answers 'busy' within the budget; nothing changed", async () => {
    const t = await blockedPeriod();
    const h = await heldAdmin("SELECT 1 FROM public.trial_balance_uploads WHERE id = $1 FOR UPDATE", [t.up]);
    const t0 = Date.now();
    const r = await correct(U.owner, t.period, "TZS", "USD");
    const waited = Date.now() - t0;
    await h.rollback();
    return r.outcome === "busy" && waited >= 4500 && waited < 6800 && (await currencyOf(t.period)) === "USD" && (await events(t.period)) === 0 ? true : { r, waited };
  });
  await check("rollback on timeout releases every lock at once: right after 'busy', writes to every dependent table proceed without waiting", async () => {
    const t = await blockedPeriod();
    const b = await heldAdmin(`LOCK TABLE ${deps[deps.length - 1]} IN ROW EXCLUSIVE MODE`, []);
    const r = await correct(U.owner, t.period, "TZS", "USD");
    await b.rollback();
    const c = await pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL lock_timeout = '200ms'");
      for (const rel of deps) await c.query(`LOCK TABLE ${rel} IN ROW EXCLUSIVE MODE`);
      await c.query("ROLLBACK");
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); c.release(); return { r, error: e.code }; }
    c.release();
    const lingering = await count("SELECT count(*) n FROM pg_locks WHERE locktype = 'relation' AND mode = 'ShareLock' AND pid <> pg_backend_pid()");
    return r.outcome === "busy" && lingering === 0 ? true : { r, lingering };
  });
  await check("deadlock handling: a writer holding a later table that then writes an earlier one deadlocks with the correction; PostgreSQL breaks it, and both sides end consistent", async () => {
    const t = await blockedPeriod();
    const w = await pool.connect();
    await w.query("BEGIN"); await w.query(`LOCK TABLE ${deps[deps.length - 1]} IN ROW EXCLUSIVE MODE`);
    const p = correct(U.owner, t.period, "TZS", "USD");
    await new Promise((r) => setTimeout(r, 300));                       // the correction now holds the earlier tables and waits
    const wr = await w.query(`LOCK TABLE ${deps[0]} IN ROW EXCLUSIVE MODE`).then(() => "ok", (e) => e.code);
    await w.query(wr === "ok" ? "COMMIT" : "ROLLBACK"); w.release();
    const r = await p;
    const cur = await currencyOf(t.period), n = await events(t.period);
    const correctionVictim = r.outcome === "busy" && wr === "ok" && cur === "USD" && n === 0;
    const writerVictim = wr === "40P01" && r.outcome === "corrected" && cur === "TZS" && n === 1;
    return correctionVictim || writerVictim ? true : { r, wr, cur, n };
  });
  await check("cross-company contention: another company's write to a dependent table waits only while a correction holds its locks, then proceeds; an uncontended correction holds them briefly", async () => {
    const t = await blockedPeriod();
    const c = await held("authenticated", U.owner, "SELECT public.correct_period_currency($1,'TZS','USD','contention check',$2) r", [t.period, uuid()]);
    const other = (await admin.query("SELECT id FROM public.companies WHERE id <> $1 LIMIT 1", [A])).rows[0].id;
    const t0 = Date.now();
    const p = admin.query(EVIDENCE_SQL.replace("$5)", "(SELECT id FROM public.firm_members WHERE company_id = $2 LIMIT 1))").replace(",$5", ""), [`ev-${uuid()}`, other, "FY2099", crypto.randomBytes(32).toString("hex")]).then(() => "ok", (e) => e.message);
    const state = await waitsFor(p, 400);
    await c.commit();
    const res = await p; const after = Date.now() - t0;
    // Uncontended: the whole call (locks held from acquisition to commit) on a fresh period, measured end to end.
    const u = await blockedPeriod();
    const s0 = Date.now(); const r = await correct(U.owner, u.period, "TZS", "USD"); const holdMs = Date.now() - s0;
    console.log(`        dependent tables locked: ${deps.length}; uncontended correction call: ${holdMs} ms`);
    return c.r.r.outcome === "corrected" && state === "waiting" && res === "ok" && r.outcome === "corrected" && holdMs < 3000 ? true : { corr: c.r.r, state, res, after, holdMs, r };
  });
  await check("no storage, network or edge-function call inside the locked transaction (the operation's definition)", async () => {
    const def = (await one("SELECT pg_get_functiondef('public.correct_period_currency(uuid,text,text,text,uuid)'::regprocedure) d")).d;
    return !/\b(net\.|http_|storage\.|extensions\.http|pg_net|dblink)/i.test(def) ? true : "found a remote call";
  });
  // ── Review findings (Codex, 2026-10-19) ─────────────────────────────────────────────────────────────────────────────
  await check("[1] the request-id lock is inside the budget: the matching request id held elsewhere answers 'busy' within ~5s; no event, no change, no lock left; the same id then corrects", async () => {
    const t = await blockedPeriod();
    const id = uuid();
    const h = await heldAdmin("SELECT pg_advisory_xact_lock(hashtext('correct_period_currency'), hashtext($1))", [id]);
    const t0 = Date.now();
    const r1 = await correct(U.owner, t.period, "TZS", "USD", id);
    const waited = Date.now() - t0;
    const unchanged = (await currencyOf(t.period)) === "USD" && (await events(t.period)) === 0;
    const lingering = await count("SELECT count(*) n FROM pg_locks WHERE locktype = 'relation' AND mode = 'ShareLock' AND pid <> pg_backend_pid()");
    await h.rollback();
    const r2 = await correct(U.owner, t.period, "TZS", "USD", id);
    return r1.outcome === "busy" && waited >= 4500 && waited < 6800 && unchanged && lingering === 0 && r2.outcome === "corrected" && (await events(t.period)) === 1
      ? true : { r1, waited, unchanged, lingering, r2 };
  });
  await check("[4] acquisition ORDER itself: with every dependent table held by its own session, the correction waits on them one by one in ascending schema-qualified order", async () => {
    const t = await blockedPeriod();
    const expected = (await admin.query(`SELECT format('%I.%I', n.nspname, c.relname) q FROM public._period_currency_dependent_relations() r
        JOIN pg_class c ON c.oid = r JOIN pg_namespace n ON n.oid = c.relnamespace`)).rows.map((x) => x.q);
    const holders = new Map();
    for (const q of expected) {
      const c = new Client({ connectionString: url });
      await c.connect(); await c.query("BEGIN"); await c.query(`LOCK TABLE ${q} IN ROW EXCLUSIVE MODE`);
      holders.set(q, c);
    }
    const p = correct(U.owner, t.period, "TZS", "USD");
    const seen = [];
    const deadline = Date.now() + 4500;
    while (seen.length < expected.length && Date.now() < deadline) {
      const w = (await admin.query(`SELECT format('%I.%I', n.nspname, c.relname) q FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT l.granted AND l.locktype = 'relation' AND l.mode = 'ShareLock' AND a.query LIKE '%correct_period_currency%'`)).rows[0]?.q;
      if (w && seen[seen.length - 1] !== w) { seen.push(w); const c = holders.get(w); holders.delete(w); await c.query("COMMIT"); await c.end(); }
      else await new Promise((r) => setTimeout(r, 15));
    }
    for (const c of holders.values()) { await c.query("ROLLBACK").catch(() => {}); await c.end(); }
    const r = await p;
    return JSON.stringify(seen) === JSON.stringify(expected) && r.outcome === "corrected" ? true : { seen: seen.slice(0, 6), expected: expected.slice(0, 6), n: seen.length, of: expected.length, r };
  });
  await check("[2] a COMPOSITE foreign key (upload_id, company_id) is classified, matched on both columns, locked, and refuses the correction; other periods are unaffected", async () => {
    await admin.query(`ALTER TABLE public.trial_balance_uploads ADD CONSTRAINT proof_uq_tbu_id_company UNIQUE (id, company_id);
      CREATE TABLE public.proof_composite_dep (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), upload_id uuid, company_id uuid,
        CONSTRAINT proof_composite_fk FOREIGN KEY (upload_id, company_id) REFERENCES public.trial_balance_uploads (id, company_id))`);
    try {
      const cls = (await admin.query("SELECT kind, child_cols, parent_cols, problem FROM public._period_currency_dependencies() WHERE qualified = 'public.proof_composite_dep'")).rows;
      const t = await blockedPeriod(), other = await blockedPeriod();
      await admin.query("INSERT INTO public.proof_composite_dep (upload_id, company_id) VALUES ($1,$2)", [t.up, A]);
      const r = await correct(U.owner, t.period, "TZS", "USD");
      const o = await correct(U.owner, other.period, "TZS", "USD");
      return cls.length === 1 && cls[0].kind === "foreign_key" && JSON.stringify(cls[0].child_cols) === '["upload_id","company_id"]' && JSON.stringify(cls[0].parent_cols) === '["id","company_id"]' && cls[0].problem === null
        && r.outcome === "not_eligible" && r.block.code === "DOWNSTREAM_RECORD" && r.block.relation === "public.proof_composite_dep" && r.block.constraint === "proof_composite_fk"
        && (await currencyOf(t.period)) === "USD" && o.outcome === "corrected" ? true : { cls, r, o };
    } finally { /* kept for the concurrency check below */ }
  });
  await check("[2] composite FK concurrency: an in-flight composite write makes the correction wait then refuse; one that starts during an open correction waits until after it", async () => {
    try {
      const t = await blockedPeriod();
      const w = await heldAdmin("INSERT INTO public.proof_composite_dep (upload_id, company_id) VALUES ($1,$2)", [t.up, A]);
      const p = correct(U.owner, t.period, "TZS", "USD");
      const s1 = await waitsFor(p);
      await w.commit();
      const r = await p;
      const u = await blockedPeriod();
      const c = await held("authenticated", U.owner, "SELECT public.correct_period_currency($1,'TZS','USD','composite race',$2) r", [u.period, uuid()]);
      const ins = admin.query("INSERT INTO public.proof_composite_dep (upload_id, company_id) VALUES ($1,$2)", [u.up, A]);
      const s2 = await waitsFor(ins);
      await c.commit(); await ins;
      return s1 === "waiting" && r.outcome === "not_eligible" && r.block.relation === "public.proof_composite_dep" && s2 === "waiting" && c.r.r.outcome === "corrected" ? true : { s1, r, s2, corr: c.r.r };
    } finally {
      await admin.query("DROP TABLE public.proof_composite_dep; ALTER TABLE public.trial_balance_uploads DROP CONSTRAINT proof_uq_tbu_id_company");
    }
  });
  await check("[2] an UNSUPPORTED dependency shape (company_id + a text period_year) refuses every correction by name, before any lock; removing it restores correction", async () => {
    await admin.query("CREATE TABLE public.proof_unsupported_dep (company_id uuid, period_year text)");
    let r, e;
    const t = await blockedPeriod();
    try {
      r = await correct(U.owner, t.period, "TZS", "USD");
      e = await eligibility(U.owner, t.period);
    } finally { await admin.query("DROP TABLE public.proof_unsupported_dep"); }
    const after = await correct(U.owner, t.period, "TZS", "USD");
    return r.outcome === "not_eligible" && r.block.code === "DEPENDENCY_UNSUPPORTED" && r.block.relation === "public.proof_unsupported_dep"
      && e.block?.code === "DEPENDENCY_UNSUPPORTED" && after.outcome === "corrected" ? true : { r, e, after };
  });
  await check("[3] row visibility under RLS: with the SECURITY DEFINER functions owned by a role row-level security applies to, a hidden downstream row (invisible to that owner) refuses the correction (DEPENDENCY_NOT_VISIBLE); nothing changes", async () => {
    const t = await blockedPeriod();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`CREATE ROLE proof_definer_owner NOSUPERUSER NOBYPASSRLS NOLOGIN;
        GRANT USAGE ON SCHEMA public, auth TO proof_definer_owner;
        GRANT ALL ON ALL TABLES IN SCHEMA public TO proof_definer_owner;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth TO proof_definer_owner;
        ALTER FUNCTION public.get_period_currency_correction(uuid) OWNER TO proof_definer_owner;
        ALTER FUNCTION public._period_currency_correction_block(uuid) OWNER TO proof_definer_owner;
        ALTER FUNCTION public._period_currency_actor(uuid, uuid) OWNER TO proof_definer_owner;
        ALTER FUNCTION public.correct_period_currency(uuid, text, text, text, uuid) OWNER TO proof_definer_owner;
        CREATE TABLE public.proof_hidden_dep (upload_id uuid REFERENCES public.trial_balance_uploads (id));
        ALTER TABLE public.proof_hidden_dep ENABLE ROW LEVEL SECURITY;
        GRANT ALL ON public.proof_hidden_dep TO proof_definer_owner;
        -- As on the hosted database, the functions' owner owns the application's tables (owners are exempt from their
        -- tables' row-level security unless FORCEd); the fixture alone is owned by another role, with RLS and no policy.
        DO $o$ DECLARE t text; BEGIN
          FOR t IN SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'proof_hidden_dep' AND NOT c.relispartition LOOP
            EXECUTE 'ALTER TABLE ' || t || ' OWNER TO proof_definer_owner';
          END LOOP;
        END $o$;`);
      await c.query("INSERT INTO public.proof_hidden_dep (upload_id) VALUES ($1)", [t.up]);
      await c.query("SET LOCAL ROLE proof_definer_owner");
      const seenByOwner = (await c.query("SELECT count(*)::int n FROM public.proof_hidden_dep")).rows[0].n;
      await c.query("RESET ROLE");
      const cls = (await c.query("SELECT problem FROM public._period_currency_dependencies((SELECT oid FROM pg_roles WHERE rolname = 'proof_definer_owner')) WHERE qualified = 'public.proof_hidden_dep'")).rows;
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [U.owner]);
      const e = (await c.query("SELECT public.get_period_currency_correction($1) r", [t.period])).rows[0].r;
      const r = (await c.query("SELECT public.correct_period_currency($1,'TZS','USD','hidden dependency',$2) r", [t.period, uuid()])).rows[0].r;
      await c.query("RESET ROLE");
      const cur = (await c.query("SELECT reporting_currency c FROM public.fiscal_periods WHERE id = $1", [t.period])).rows[0].c;
      await c.query("ROLLBACK");
      return seenByOwner === 0 && cls[0]?.problem === "DEPENDENCY_NOT_VISIBLE"
        && e.block?.code === "DEPENDENCY_NOT_VISIBLE" && e.block?.relation === "public.proof_hidden_dep"
        && r.outcome === "not_eligible" && r.block.code === "DEPENDENCY_NOT_VISIBLE" && r.block.relation === "public.proof_hidden_dep" && cur === "USD"
        ? true : { seenByOwner, cls, e, r, cur };
    } catch (err) { await c.query("ROLLBACK").catch(() => {}); return { error: String(err?.message ?? err) }; }
    finally { c.release(); }
  });
  await check("[3] control: the same RLS-protected table (FORCE) seen by an owner that bypasses row-level security is matched normally (DOWNSTREAM_RECORD, not hidden)", async () => {
    const t = await blockedPeriod();
    await admin.query(`CREATE TABLE public.proof_hidden_dep (upload_id uuid REFERENCES public.trial_balance_uploads (id));
      ALTER TABLE public.proof_hidden_dep ENABLE ROW LEVEL SECURITY; ALTER TABLE public.proof_hidden_dep FORCE ROW LEVEL SECURITY;`);
    try {
      await admin.query("INSERT INTO public.proof_hidden_dep (upload_id) VALUES ($1)", [t.up]);
      const r = await correct(U.owner, t.period, "TZS", "USD");
      return r.outcome === "not_eligible" && r.block.code === "DOWNSTREAM_RECORD" && r.block.relation === "public.proof_hidden_dep" ? true : r;
    } finally { await admin.query("DROP TABLE public.proof_hidden_dep"); }
  });
  await check("[3] deployment check: on this chain every dependency is matchable, visible and lockable for the functions' real owner", async () => {
    const owner = (await one("SELECT proowner FROM pg_proc WHERE oid = 'public.correct_period_currency(uuid,text,text,text,uuid)'::regprocedure")).proowner;
    const bad = (await admin.query("SELECT qualified, problem FROM public._period_currency_dependencies($1) WHERE problem IS NOT NULL", [owner])).rows;
    return bad.length === 0 ? true : bad;
  });
  await check("the identity sweep's flags are preserved by a correction (rows byte-identical) and the sweep still writes during and after it", async () => {
    const t = await blockedPeriod();
    await admin.query("INSERT INTO public.upload_integrity_findings (upload_id, company_id, issue_type) VALUES ($1,$2,'ENGAGEMENT_PERIOD_MISMATCH')", [t.up, A]);
    const before = (await one("SELECT md5(string_agg(to_jsonb(f)::text, ',' ORDER BY f.id)) h FROM public.upload_integrity_findings f WHERE f.upload_id=$1", [t.up])).h;
    const c = await held("authenticated", U.owner, "SELECT public.correct_period_currency($1,'TZS','USD','race check reason',$2) r", [t.period, uuid()]);
    const p = admin.query("INSERT INTO public.upload_integrity_findings (upload_id, company_id, issue_type) VALUES ($1,$2,'ENGAGEMENT_COMPANY_MISMATCH')", [t.up, A]);
    const state = await waitsFor(p);
    await c.commit(); await p;
    const after = (await one("SELECT md5(string_agg(to_jsonb(f)::text, ',' ORDER BY f.id)) h FROM public.upload_integrity_findings f WHERE f.upload_id=$1 AND f.issue_type='ENGAGEMENT_PERIOD_MISMATCH'", [t.up])).h;
    const n = await count("SELECT count(*) n FROM public.upload_integrity_findings WHERE upload_id=$1", [t.up]);
    // The flag's FK takes KEY SHARE on the upload, so a flag written during the correction waits for it, as every FK writer does.
    return c.r.r.outcome === "corrected" && before === after && n === 2 && state === "waiting" ? true : { corr: c.r.r, before, after, n, state };
  });
  await check("the exemption does not reach any other table: the bookkeeping list is exactly the reviewed fourteen", async () => {
    const allow = (await one("SELECT public._period_currency_bookkeeping() a")).a;
    const expected = ["public.engagements", "public.engine_runs", "public.fiscal_period_events", "public.fiscal_periods", "public.layout_confirmations",
      "public.onboarding_progress", "public.tb_certification_findings", "public.tb_certification_invalidations", "public.tb_certifications",
      "public.trial_balance_draft_commits", "public.trial_balance_upload_lifecycle_events", "public.trial_balance_upload_operations",
      "public.trial_balance_uploads", "public.upload_integrity_findings"];
    return JSON.stringify([...allow].sort()) === JSON.stringify(expected) ? true : allow;
  });
  await check("the processing lock and the setup fence still refuse every other path after the repair (no marker: refused; client role: fenced)", async () => {
    const t = await blockedPeriod();
    const a = await admin.query("UPDATE public.fiscal_periods SET reporting_currency='TZS' WHERE id=$1", [t.period]).then(() => "ran", (e) => e.code);
    const b = await asUser(U.owner, "UPDATE public.fiscal_periods SET reporting_currency='TZS' WHERE id=$1 RETURNING id", [t.period]).then(() => "ran", (e) => e.code);
    return a === "55000" && b !== "ran" && (await currencyOf(t.period)) === "USD" ? true : { a, b };
  });
  await check("two different requests at once: exactly one corrects; the other is stale (no lost update)", async () => {
    const t = await blockedPeriod();
    const rs = await Promise.all([correct(U.owner, t.period, "TZS", "USD"), correct(U.owner, t.period, "KES", "USD")]);
    const outs = rs.map((r) => r.outcome).sort();
    const n = await count("SELECT count(*) n FROM public.fiscal_period_events WHERE period_id=$1 AND action='currency_corrected'", [t.period]);
    return JSON.stringify(outs) === JSON.stringify(["corrected", "stale"]) && n === 1 ? true : { outs, n };
  });
  await check("12 concurrent duplicate clicks (one request id): one correction, eleven already_corrected, one event", async () => {
    const t = await blockedPeriod();
    const id = uuid();
    const rs = await Promise.all(Array.from({ length: 12 }, () => correct(U.owner, t.period, "TZS", "USD", id)));
    const n = await count("SELECT count(*) n FROM public.fiscal_period_events WHERE period_id=$1 AND action='currency_corrected'", [t.period]);
    return rs.filter((r) => r.outcome === "corrected").length === 1 && rs.filter((r) => r.outcome === "already_corrected").length === 11 && n === 1 ? true : { rs: rs.map((r) => r.outcome), n };
  });

  group("Recovery — after the correction the file is re-checked through the normal path, as a new attempt");
  const op = c1.rechecks[0].operation_id;
  await check("the re-check uses the normal path: tbu_request_reprocess with the deterministic id is accepted (the blocking certification is invalidated, kept as history)", async () => {
    const r = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [R.up, op, SRC])).r;
    const inv = await count("SELECT count(*) n FROM public.tb_certification_invalidations WHERE certification_id=$1", [R.certification]);
    const kept = await count("SELECT count(*) n FROM public.tb_certifications WHERE id=$1", [R.certification]);
    return r.outcome === "accepted" && inv === 1 && kept === 1 ? true : { r, inv, kept };
  });
  await check("a retry of the same re-check request is a replay (idempotent); no second invalidation", async () => {
    const r = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [R.up, op, SRC])).r;
    const inv = await count("SELECT count(*) n FROM public.tb_certification_invalidations WHERE certification_id=$1", [R.certification]);
    return r.outcome === "replayed" && inv === 1 ? true : { r, inv };
  });
  await check("a new attempt on the same upload and source runs under the corrected currency and certifies (attempt 2)", async () => {
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v7',7,'workspace_user',NULL,$4,600) r", [R.up, op, SRC, U.owner]))[0].r;
    if (b.outcome !== "claimed") return b;
    await snapshot(b.engine_run_id, A);
    const f = await finalize(b.engine_run_id, acceptedResult(false));
    const att = await one("SELECT attempt_no FROM public.engine_runs WHERE id=$1", [b.engine_run_id]);
    return f.outcome === "certified" && att.attempt_no >= 2 && (await currencyOf(R.period)) === "TZS" ? true : { f, att };
  });
  await check("the same attempt request again is answered as a replay, never a second attempt", async () => {
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v7',7,'workspace_user',NULL,$4,600) r", [R.up, op, SRC, U.owner]))[0].r;
    return b.outcome === "replay" ? true : b;
  });
  await check("once the corrected period has an accepted certification, its currency can no longer be corrected", async () => {
    const e = await eligibility(U.owner, R.period);
    return e.block?.code === "ACCEPTED_CERTIFICATION" ? true : e;
  });
}

try { await main(); } catch (e) { record("unexpected", false, String(e?.stack ?? e)); }
finally { await stopDatabase(); }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => `${f.group} / ${f.name}`).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
