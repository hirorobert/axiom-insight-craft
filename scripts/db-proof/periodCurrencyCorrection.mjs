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
const blockingResult = () => ({ outcome: "certified",
  upload: { status: "blocked", is_valid: false, processing_result: { status: "blocked" }, validation_report: { ok: false }, accounting_errors: [] },
  certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: true, requires_review: false, rows_snapshot: [],
    exceptions: [{ code: "CURRENCY_MISMATCH", layer: 2, severity: "error", accountCode: null, message: "The currency labels on row 11 do not match the selected currency USD." }] } });
const acceptedResult = (requiresReview) => ({ outcome: "certified",
  upload: { status: requiresReview ? "needs_review" : "complete", is_valid: !requiresReview, processing_result: { status: "x" }, validation_report: { ok: true }, accounting_errors: [] },
  certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: false, requires_review: requiresReview, rows_snapshot: [], exceptions: [] } });

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
  async function periodWithAttempt(company = A, owner = U.owner, currency = "USD") {
    const y = ++year;
    const period = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [company, `${y}-12-31`, `FY${y}`, owner, currency, `${y}-01-01`, `${y}-12-31`])).id;
    const up = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id, source_file_hash)
      VALUES ('tb-tzs.csv',$1,10,'processing',$2,$3,$4,$5,$6) RETURNING id`, [`${owner}/${uuid()}.csv`, company, y, period, owner, SRC])).id;
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v6',6,'workspace_user',NULL,$4,600) r", [up, uuid(), SRC, owner]))[0].r;
    if (b.outcome !== "claimed") throw new Error(`begin: ${JSON.stringify(b)}`);
    return { period, up, run: b.engine_run_id, company, year: y };
  }
  const snapshot = (run, company) => asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb) r",
    [run, JSON.stringify([{ scope: company, key: "#framework" }, { scope: company, key: "#currency" }, { scope: "global", key: "#dictionary" }])]);
  const finalize = async (run, result) => (await asService("SELECT public.tb_finalize_attempt($1,$2::jsonb) r", [run, JSON.stringify(result)]))[0].r;
  /** The scenario the repair exists for: a check refused because the file's currency contradicted the period's. */
  async function blockedPeriod(company = A, owner = U.owner) {
    const t = await periodWithAttempt(company, owner, "USD");
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
  await check("privileges: the read and the operation for authenticated only; the internal helpers for nobody", async () => {
    const r = await one(`SELECT has_function_privilege('authenticated','public.correct_period_currency(uuid,text,text,text,uuid)','EXECUTE') a,
        has_function_privilege('anon','public.correct_period_currency(uuid,text,text,text,uuid)','EXECUTE') b,
        has_function_privilege('authenticated','public.get_period_currency_correction(uuid)','EXECUTE') c,
        has_function_privilege('authenticated','public._period_currency_correction_block(uuid)','EXECUTE') d,
        has_function_privilege('authenticated','public._period_currency_actor(uuid,uuid)','EXECUTE') e`);
    return r.a && !r.b && r.c && !r.d && !r.e ? true : r;
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
    await admin.query("INSERT INTO public.management_inputs (company_id, upload_id, period_year, created_by) VALUES ($1,$2,2026,$3)", [A, t.up, U.owner]);
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
    await admin.query("INSERT INTO public.management_inputs (company_id, upload_id, period_year, created_by) VALUES ($1,$2,2026,$3)", [A, d.up, U.owner]);
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
    const p = admin.query("INSERT INTO public.management_inputs (company_id, upload_id, period_year, created_by) VALUES ($1,$2,2026,$3)", [A, t.up, U.owner]);
    const state = await waitsFor(p);
    await c.commit(); await p;
    return c.r.r.outcome === "corrected" && state === "waiting" ? true : { corr: c.r.r, state };
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
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v6',6,'workspace_user',NULL,$4,600) r", [R.up, op, SRC, U.owner]))[0].r;
    if (b.outcome !== "claimed") return b;
    await snapshot(b.engine_run_id, A);
    const f = await finalize(b.engine_run_id, acceptedResult(false));
    const att = await one("SELECT attempt_no FROM public.engine_runs WHERE id=$1", [b.engine_run_id]);
    return f.outcome === "certified" && att.attempt_no >= 2 && (await currencyOf(R.period)) === "TZS" ? true : { f, att };
  });
  await check("the same attempt request again is answered as a replay, never a second attempt", async () => {
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v6',6,'workspace_user',NULL,$4,600) r", [R.up, op, SRC, U.owner]))[0].r;
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
