#!/usr/bin/env bun
// Real-PostgreSQL proof of repair A — one certification keeps EVERY finding, whatever its size (20261107100000).
//
//   reproduction   on the chain WITHOUT the repair: 400 unclassified accounts are refused by chk_tbc_exceptions_bounded
//                  (23514) and nothing is recorded; a 2,000-account snapshot takes 4,000 advisory locks in one transaction;
//   repair         applied over the same database; applying it again is refused by its preflight;
//   complete       2,000 findings stored in order under the attempt fence, the certification carries a bounded summary,
//                  the count and a SHA-256 recomputable from the stored findings; review is still required;
//   agreement      a summary that leaves a kind out, invents an example, miscounts, or has no complete findings is
//                  refused and records nothing;
//   isolation      12 attempts finalising concurrently each keep exactly their own findings; a superseded attempt records
//                  nothing; findings cannot be written, changed or deleted outside the fenced path; a non-member reads none;
//   compatibility  an engine that sends no findings is served exactly as before; a certification made before the repair is
//                  unchanged;
//   dependencies   every key of a 2,000-account run is recorded (none dropped) with no per-account locks; a 200-account run
//                  keeps its locks; a change to the LAST account's mapping (outside every summary example) still makes the
//                  attempt DEPENDENCY_CHANGED, and a certified result non-authoritative.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/certificationCapacity.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";
import { isFindingCountRecord, summarizeFindings } from "../../supabase/functions/_shared/certificationFindings.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const REPAIR_FILE = "20261107100000_certification_findings_capacity.sql";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-cert-capacity-proof-"));
  const port = 56000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE cert_capacity_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/cert_capacity_proof`;
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
const asUser = (uid, sql, p) => asRole("authenticated", uid, sql, p);
const asService = (sql, p) => asRole("service_role", null, sql, p);
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const count = async (sql, p = []) => Number((await one(sql, p)).n);

// ── Invented, varied account names (never client data) ────────────────────────────────────────────────────────────
const W1 = ["Trade", "Other", "Accrued", "Prepaid", "Deferred", "Staff", "Motor", "Office", "Bank", "Loan", "Interest", "Rental", "Consulting", "Insurance", "Freight"];
const W2 = ["receivables", "payables", "expenses", "income", "charges", "deposits", "advances", "fees", "costs", "provisions", "allowances", "levies"];
const W3 = ["Dar es Salaam", "Arusha", "Mwanza", "Dodoma", "head office", "branch 2", "project Kilima", "USD account", "petty", "suspense"];
const accountName = (i) => `${W1[i % W1.length]} ${W2[(i * 7) % W2.length]} - ${W3[(i * 3) % W3.length]} ${1000 + ((i * 7919) % 9000)}`;
const accountCode = (i) => String(100000 + i);
const needsReview = (i) => ({ code: "NEEDS_REVIEW", layer: 4, severity: "warning", accountCode: accountCode(i), message: `No classification found for "${accountName(i)}" (${accountCode(i)})` });
const findingsFor = (n, tag = "") => Array.from({ length: n }, (_, i) => ({ ...needsReview(i), ...(tag ? { message: `${needsReview(i).message} ${tag}` } : {}) }));
const normalized = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const depKeys = (company, n) => {
  const keys = [];
  for (let i = 0; i < n; i++) for (const scope of [company, "global"]) keys.push({ scope, key: `code:${accountCode(i)}` }, { scope, key: `name:${normalized(accountName(i))}` });
  keys.push({ scope: company, key: "#framework" }, { scope: company, key: "#currency" }, { scope: "global", key: "#dictionary" });
  return keys;
};
const upload = { status: "needs_review", is_valid: false, processing_result: { status: "needs_review" }, validation_report: { ok: false }, accounting_errors: [] };
const certified = (extra) => ({ outcome: "certified", upload, certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: false, requires_review: true, rows_snapshot: [], ...extra } });

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 40 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);

  group("Replay — the chain up to (not including) the repair");
  const cut = files.indexOf(REPAIR_FILE);
  const applyFile = async (f) => {
    let t = migrationSql(REPO, f);
    if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    await admin.query(t);
  };
  await check(`${REPAIR_FILE} is in the chain and everything before it applies`, async () => {
    if (cut < 0) return `${REPAIR_FILE} missing`;
    for (const f of files.slice(0, cut)) { try { await applyFile(f); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; } }
    return true;
  });

  const U = { owner: uuid(), outsider: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const uid of [U.owner, U.outsider]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='FIRM'", [bc, prod]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Capacity Ltd') RETURNING id", [U.owner])).id;
  const SRC = crypto.createHash("sha256").update("certification-capacity-proof").digest("hex");
  let year = 2000;
  /** A fresh upload in its own period with a claimed attempt (the processing function's first two steps). */
  async function attempt() {
    const y = ++year;
    const period = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$6) RETURNING id",
      [A, `${y}-12-31`, `FY${y}`, U.owner, `${y}-01-01`, `${y}-12-31`])).id;
    const up = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,10,'processing',$2,$3,$4,$5) RETURNING id`, [`${U.owner}/${uuid()}.csv`, A, y, period, U.owner])).id;
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v5',5,'workspace_user',NULL,$4,600) r", [up, uuid(), SRC, U.owner]))[0].r;
    if (b.outcome !== "claimed") throw new Error(`begin: ${JSON.stringify(b)}`);
    return { up, run: b.engine_run_id };
  }
  // A real write to the company's mappings (its dependency trigger bumps the account's code and name revisions).
  const mapAccount = (i) => admin.query(`INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, statement, classification, line_item, normal_balance)
    VALUES ($1,$2,$3,$4,'balance_sheet','current_assets','Invented','debit')`, [U.owner, A, accountCode(i), accountName(i)]);
  const snapshot = (run, keys) => asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb) r", [run, JSON.stringify(keys)]);
  const finalize = async (run, result) => (await asService("SELECT public.tb_finalize_attempt($1,$2::jsonb) r", [run, JSON.stringify(result)]))[0].r;
  /** Advisory locks held by one snapshot, counted inside its own transaction (rolled back). */
  async function locksTakenBySnapshot(n) {
    const t = await attempt();
    const c = await pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
      await c.query("SELECT public.tb_snapshot_dependencies($1,$2::jsonb)", [t.run, JSON.stringify(depKeys(A, n))]);
      const r = await c.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()");
      const rec = await c.query("SELECT count(*)::int n FROM public.engine_run_dependencies WHERE engine_run_id=$1", [t.run]);
      await c.query("ROLLBACK");
      return { locks: r.rows[0].n, recorded: rec.rows[0].n };
    } finally { c.release(); }
  }
  const nothingRecorded = async (t) => (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [t.up])) === 0
    && (await one("SELECT status FROM public.engine_runs WHERE id=$1", [t.run])).status === "running";

  group("Reproduction — the defect, on the chain without the repair");
  await refused("400 unclassified accounts: the certification is refused by chk_tbc_exceptions_bounded (23514)", "23514", async () => {
    const t = await attempt();
    await finalize(t.run, certified({ exceptions: findingsFor(400) }));
  }, "chk_tbc_exceptions_bounded");
  await check("…and the size is the CHECK's, measured: 300 such findings fit, 400 do not (uncompressed bytes)", async () => {
    const s = async (n) => Number((await one("SELECT pg_column_size($1::jsonb) n", [JSON.stringify(findingsFor(n))])).n);
    const [a, b] = [await s(300), await s(400)];
    console.log(`        300 findings ${a} bytes; 400 findings ${b} bytes; CHECK 65,536`);
    return a <= 65536 && b > 65536 ? true : { a, b };
  });
  await check("a 2,000-account snapshot takes 4,000 advisory locks in one transaction (unbounded before the repair)", async () => {
    const r = await locksTakenBySnapshot(2000);
    return r.locks === 4000 && r.recorded === 8003 ? true : r;
  });
  const legacy = await attempt();
  await snapshot(legacy.run, depKeys(A, 3));
  const legacyResult = await finalize(legacy.run, { outcome: "certified", upload: { ...upload, status: "complete", is_valid: true },
    certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: false, requires_review: false, exceptions: [needsReview(0)], rows_snapshot: [] } });
  const legacyBefore = await one("SELECT to_jsonb(c) j FROM public.tb_certifications c WHERE id=$1", [legacyResult.certification_id]);

  group("Repair — applied over the same database");
  await check(`${REPAIR_FILE} applies`, async () => { await admin.query(migrationSql(REPO, REPAIR_FILE)); return true; });
  await refused("applying it again is refused by its preflight (nothing is replaced)", "P0001", () => admin.query(migrationSql(REPO, REPAIR_FILE)), "PREFLIGHT_REFUSED");
  await check("every later migration applies on top", async () => {
    for (const f of files.slice(cut + 1)) { try { await applyFile(f); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; } }
    return true;
  });

  group("Complete findings — 2,000 unclassified accounts");
  const big = findingsFor(2000);
  const bigSummary = summarizeFindings(big);
  const T = await attempt();
  await snapshot(T.run, depKeys(A, 2000));
  let bigCert;
  await check("the attempt is certified: every finding stored, a bounded summary on the row, review still required", async () => {
    const r = await finalize(T.run, certified({ exceptions: bigSummary.exceptions, findings: big }));
    bigCert = r.certification_id;
    const c = await one("SELECT requires_review, is_blocking, findings_count, findings_summarized, pg_column_size(exceptions) sz, jsonb_array_length(exceptions) n FROM public.tb_certifications WHERE id=$1", [bigCert]);
    const stored = await count("SELECT count(*) n FROM public.tb_certification_findings WHERE certification_id=$1", [bigCert]);
    console.log(`        summary ${c.n} entries, ${c.sz} bytes stored; ${stored} findings stored`);
    return r.outcome === "certified" && r.findings_count === 2000 && stored === 2000 && c.findings_count === 2000 && c.findings_summarized === true
      && c.requires_review === true && c.is_blocking === false && c.sz <= 65536 ? true : { r, c, stored };
  });
  await check("the stored findings are exactly the findings sent, in order", async () =>
    (await one("SELECT (SELECT jsonb_agg(finding ORDER BY ordinal) FROM public.tb_certification_findings WHERE certification_id=$1) = $2::jsonb ok", [bigCert, JSON.stringify(big)])).ok === true);
  await check("findings_sha256 binds the COMPLETE findings: recomputed from the stored rows it matches; from the summary it does not", async () => {
    const r = await one(`SELECT c.findings_sha256 h,
        (SELECT encode(sha256(convert_to(string_agg(finding::text, E'\\n' ORDER BY ordinal), 'UTF8')), 'hex') FROM public.tb_certification_findings WHERE certification_id=c.id) full_h,
        (SELECT encode(sha256(convert_to(string_agg(e::text, E'\\n' ORDER BY o), 'UTF8')), 'hex') FROM jsonb_array_elements(c.exceptions) WITH ORDINALITY x(e, o)) summary_h
      FROM public.tb_certifications c WHERE c.id=$1`, [bigCert]);
    return r.h === r.full_h && r.h !== r.summary_h ? true : r;
  });
  await check("each finding is traceable: certification → upload, attempt (engine run) and engine version", async () => {
    const r = await one(`SELECT c.upload_id, er.id run, er.engine_version, er.attempt_no FROM public.tb_certification_findings f
      JOIN public.tb_certifications c ON c.id=f.certification_id JOIN public.engine_runs er ON er.id=c.engine_run_id
      WHERE f.certification_id=$1 AND f.ordinal=2000`, [bigCert]);
    return r.upload_id === T.up && r.run === T.run && r.engine_version === "safisha-tb-certification-v5" && r.attempt_no === 1 ? true : r;
  });
  await check("the summary names the total and how many it leaves out (one count record)", async () => {
    const c = bigSummary.exceptions.filter(isFindingCountRecord);
    return c.length === 1 && c[0].summary.total === 2000 && c[0].summary.omitted === 2000 - (bigSummary.exceptions.length - 1) ? true : c;
  });
  await check("the certification is not authoritative (review required): no gate treats it as accepted", async () =>
    (await count("SELECT count(*) n FROM public.get_authoritative_certification($1,$2)", [A, year])) === 0);

  group("Agreement — a summary that disagrees with the complete findings is refused, nothing recorded");
  const mixed = [...findingsFor(600), { code: "TRIAL_BALANCE_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "Debits (10.00) != Credits (8.00)" }];
  const mixedSummary = summarizeFindings(mixed).exceptions;
  for (const [label, exceptions, findings, text] of [
    ["a kind of finding left out (the one error)", mixedSummary.filter((e) => e.layer !== 3), mixed, "missing from the summary"],
    ["an example that is not one of the findings", mixedSummary.map((e, i) => (i === 0 ? { ...e, message: "Altered" } : e)), mixed, "not one of the findings"],
    ["a count record with the wrong total", mixedSummary.map((e) => (isFindingCountRecord(e) ? { ...e, summary: { ...e.summary, total: e.summary.total - 1, omitted: e.summary.omitted - 1 } } : e)), mixed, "does not agree"],
    ["two count records for one kind", [...mixedSummary, ...mixedSummary.filter(isFindingCountRecord)], mixed, "does not agree"],
    ["a summary without its complete findings", mixedSummary, undefined, "needs the complete findings"],
    ["a malformed finding (layer 9)", mixedSummary, mixed.map((f, i) => (i === 3 ? { ...f, layer: 9 } : f)), "malformed"],
  ]) {
    const t = await attempt();
    await refused(`${label} → INVALID_RESULT`, "22023", () => finalize(t.run, certified({ exceptions, ...(findings ? { findings } : {}) })), text);
    await check(`…and ${label}: no certification, no findings, the attempt still running`, () => nothingRecorded(t));
  }

  group("Isolation — attempts, fence, append-only, readers");
  await check("12 attempts finalising concurrently each keep exactly their own findings", async () => {
    const ts = await Promise.all(Array.from({ length: 12 }, () => attempt()));
    const sent = ts.map((_, k) => findingsFor(300 + k * 37, `[attempt ${k}]`));
    const out = await Promise.all(ts.map((t, k) => finalize(t.run, certified({ exceptions: summarizeFindings(sent[k]).exceptions, findings: sent[k] }))));
    for (let k = 0; k < ts.length; k++) {
      const same = (await one("SELECT (SELECT jsonb_agg(finding ORDER BY ordinal) FROM public.tb_certification_findings WHERE certification_id=$1) = $2::jsonb ok", [out[k].certification_id, JSON.stringify(sent[k])])).ok;
      if (out[k].outcome !== "certified" || !same) return { k, out: out[k], same };
    }
    return true;
  });
  await check("a superseded attempt cannot finalise (ATTEMPT_NOT_CURRENT); the retry records only its own findings", async () => {
    const t = await attempt();
    // The lease expires; the next begin abandons it and proceeds as attempt 2 (the s2Authority proof's path).
    await admin.query("SET session_replication_role = replica"); // test-only: age the lease (bypasses triggers)
    await admin.query("UPDATE public.engine_runs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [t.run]);
    await admin.query("SET session_replication_role = origin");
    const b2 = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v5',5,'workspace_user',NULL,$4,600) r", [t.up, uuid(), SRC, U.owner]))[0].r;
    let late;
    try { await finalize(t.run, certified({ exceptions: summarizeFindings(big).exceptions, findings: big })); late = "finalised"; } catch (e) { late = e.code; }
    const f2 = findingsFor(700, "[attempt 2]");
    const r2 = await finalize(b2.engine_run_id, certified({ exceptions: summarizeFindings(f2).exceptions, findings: f2 }));
    const certs = (await admin.query("SELECT c.id, c.engine_run_id, (SELECT jsonb_agg(finding ORDER BY ordinal) FROM public.tb_certification_findings WHERE certification_id=c.id) = $2::jsonb own FROM public.tb_certifications c WHERE c.upload_id=$1", [t.up, JSON.stringify(f2)])).rows;
    return late === "PT409" && b2.attempt_no === 2 && r2.outcome === "certified" && certs.length === 1 && certs[0].engine_run_id === b2.engine_run_id && certs[0].own === true
      ? true : { late, b2, r2, certs };
  });
  await refused("the service role cannot write findings directly (ENGINE_COMMIT_RETIRED)", "PT410", () => asService("INSERT INTO public.tb_certification_findings (certification_id, ordinal, finding) VALUES ($1, 9999, '{}'::jsonb)", [bigCert]));
  await refused("nor can the database owner outside the fenced path", "PT410", () => admin.query("INSERT INTO public.tb_certification_findings (certification_id, ordinal, finding) VALUES ($1, 9999, '{}'::jsonb)", [bigCert]));
  await refused("a signed-in user cannot write findings at all", "42501", () => asUser(U.owner, "INSERT INTO public.tb_certification_findings (certification_id, ordinal, finding) VALUES ($1, 9999, '{}'::jsonb)", [bigCert]));
  await refused("findings are append-only: no UPDATE", "P0001", () => admin.query("UPDATE public.tb_certification_findings SET finding='{}'::jsonb WHERE certification_id=$1 AND ordinal=1", [bigCert]), "append-only");
  await refused("findings are append-only: no DELETE", "P0001", () => admin.query("DELETE FROM public.tb_certification_findings WHERE certification_id=$1", [bigCert]), "append-only");
  await refused("the certification itself stays append-only", "P0001", () => admin.query("UPDATE public.tb_certifications SET findings_count=1 WHERE id=$1", [bigCert]), "append-only");
  await check("the workspace owner reads every finding; a non-member reads none", async () => {
    const own = (await asUser(U.owner, "SELECT count(*)::int n FROM public.tb_certification_findings WHERE certification_id=$1", [bigCert]))[0].n;
    const out = (await asUser(U.outsider, "SELECT count(*)::int n FROM public.tb_certification_findings WHERE certification_id=$1", [bigCert]))[0].n;
    return own === 2000 && out === 0 ? true : { own, out };
  });

  group("Compatibility — earlier engines and earlier certifications");
  await check("a certification made before the repair is unchanged (new columns NULL)", async () => {
    const after = (await one("SELECT to_jsonb(c) j FROM public.tb_certifications c WHERE id=$1", [legacyResult.certification_id])).j;
    const { findings_count, findings_sha256, findings_summarized, ...rest } = after;
    return JSON.stringify(rest) === JSON.stringify(legacyBefore.j) && findings_count === null && findings_sha256 === null && findings_summarized === null
      && (await count("SELECT count(*) n FROM public.tb_certification_findings WHERE certification_id=$1", [legacyResult.certification_id])) === 0 ? true : { after, before: legacyBefore.j };
  });
  await check("an engine that sends no findings is served as before: exceptions stored verbatim, no findings rows, columns NULL", async () => {
    const t = await attempt();
    const r = await finalize(t.run, certified({ exceptions: findingsFor(20) }));
    const c = await one("SELECT exceptions, findings_count FROM public.tb_certifications WHERE id=$1", [r.certification_id]);
    return r.outcome === "certified" && r.findings_count === null && c.findings_count === null && JSON.stringify(c.exceptions) === JSON.stringify(findingsFor(20).map((f) => Object.fromEntries(Object.entries(f).sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1)))))
      ? true : { r, n: c.findings_count };
  });
  await check("small findings with the new engine: the summary IS the findings (summarized=false), all stored", async () => {
    const t = await attempt();
    const f = findingsFor(20);
    const r = await finalize(t.run, certified({ exceptions: f, findings: f }));
    const c = await one("SELECT findings_count, findings_summarized FROM public.tb_certifications WHERE id=$1", [r.certification_id]);
    return c.findings_count === 20 && c.findings_summarized === false ? true : c;
  });
  await check("the existing 64 KB bound is unchanged: a summary over it is still refused", async () => {
    const t = await attempt();
    const f = findingsFor(400);
    try { await finalize(t.run, certified({ exceptions: f, findings: f })); return "accepted"; } catch (e) { return e.code === "23514" && (await nothingRecorded(t)) ? true : e.code; }
  });

  group("Dependencies — every key recorded, bounded locks, invalidation outside the summary");
  await check("a 2,000-account run records all 8,003 keys and takes no per-account advisory locks", async () => {
    const r = await locksTakenBySnapshot(2000);
    return r.recorded === 8003 && r.locks === 0 ? true : r;
  });
  await check("a 200-account run keeps its per-account locks (400: code and name)", async () => {
    const r = await locksTakenBySnapshot(200);
    return r.recorded === 803 && r.locks === 400 ? true : r;
  });
  await check("a change to the LAST account's mapping (not among the summary's examples) fails the attempt: DEPENDENCY_CHANGED", async () => {
    const t = await attempt();
    await snapshot(t.run, depKeys(A, 2000));
    const last = 1999;
    const shown = summarizeFindings(big).exceptions.some((e) => e.accountCode === accountCode(last));
    await mapAccount(last);
    const r = await finalize(t.run, certified({ exceptions: summarizeFindings(big).exceptions, findings: big }));
    return !shown && r.outcome === "failed" && r.error_code === "DEPENDENCY_CHANGED" && (await count("SELECT count(*) n FROM public.tb_certifications WHERE upload_id=$1", [t.up])) === 0 ? true : { shown, r };
  });
  await check("after certification, the same change makes the result non-authoritative (read-time check)", async () => {
    const t = await attempt();
    await snapshot(t.run, depKeys(A, 2000));
    const f = findingsFor(2000).map((x) => ({ ...x, severity: "info", layer: 5, code: "L5_NOTE" }));
    const r = await finalize(t.run, { outcome: "certified", upload: { ...upload, status: "complete", is_valid: true },
      certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: false, requires_review: false, rows_snapshot: [], exceptions: summarizeFindings(f).exceptions, findings: f } });
    const before = (await one("SELECT public.tb_run_authoritative($1) a", [t.run])).a;
    await mapAccount(1998);
    const after = (await one("SELECT public.tb_run_authoritative($1) a", [t.run])).a;
    return r.outcome === "certified" && before === true && after === false ? true : { r, before, after };
  });

  group("Dependencies — mapping changes CONCURRENT with processing and finalisation (2,000 accounts: no per-account locks)");
  const accepted = (f) => ({ outcome: "certified", upload: { ...upload, status: "complete", is_valid: true },
    certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: false, requires_review: false, rows_snapshot: [], exceptions: summarizeFindings(f).exceptions, findings: f } });
  const info = findingsFor(2000).map((x) => ({ ...x, severity: "info", layer: 5, code: "L5_NOTE" }));
  const shownCodes = new Set(summarizeFindings(info).exceptions.map((e) => e.accountCode).filter(Boolean));
  await check("a mapping transaction OPEN while finalisation runs (outside the summary), committed after it: the certification loses authority at once", async () => {
    const t = await attempt();
    await snapshot(t.run, depKeys(A, 2000));
    const i = 1900;
    if (shownCodes.has(accountCode(i))) return "account is in the summary";
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(`INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, statement, classification, line_item, normal_balance)
        VALUES ($1,$2,$3,$4,'balance_sheet','current_assets','Invented','debit')`, [U.owner, A, accountCode(i), accountName(i)]);
      const r = await finalize(t.run, accepted(info));           // runs while the mapping change is uncommitted
      const during = (await one("SELECT public.tb_run_authoritative($1) a", [t.run])).a;
      await writer.query("COMMIT");
      const after = (await one("SELECT public.tb_run_authoritative($1) a", [t.run])).a;
      return r.outcome === "certified" && during === true && after === false ? true : { r, during, after };
    } finally { writer.release(); }
  });
  await check("12 rounds: finalisation and a mapping write (outside the summary) fired at the same moment — never an authoritative result resting on a changed dependency", async () => {
    const out = [];
    for (let round = 0; round < 12; round++) {
      const t = await attempt();
      await snapshot(t.run, depKeys(A, 2000));
      const i = 1800 + round;
      const [f] = await Promise.all([finalize(t.run, accepted(info)).catch((e) => ({ outcome: "error", code: e.code })), mapAccount(i)]);
      const authoritative = (await one("SELECT public.tb_run_authoritative($1) a", [t.run])).a;
      out.push(`${f.outcome}${f.error_code ? `:${f.error_code}` : ""}:${authoritative}`);
      if (authoritative !== false || !["certified", "failed"].includes(f.outcome) || (f.outcome === "failed" && f.error_code !== "DEPENDENCY_CHANGED")) return out;
    }
    console.log(`        outcomes: ${out.join(" ")}`);
    return true;
  });
  await check("a review DECISION (not only a mapping) on an account outside the summary also invalidates a certified result", async () => {
    const t = await attempt();
    await snapshot(t.run, depKeys(A, 2000));
    const r = await finalize(t.run, accepted(info));
    const before = (await one("SELECT public.tb_run_authoritative($1) a", [t.run])).a;
    // The real review RPC, as the account's reviewer: its decision and mapping triggers bump the account's revisions.
    await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, t.up, crypto.randomUUID(), JSON.stringify([{ account_code: accountCode(1700), account_name: accountName(1700),
      proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: "balance_sheet", classification: "current_assets", normal_balance: "debit" }])]);
    const viaTrigger = (await count("SELECT count(*) n FROM public.account_review_decisions WHERE company_id=$1 AND review_account_key=$2", [A, accountCode(1700)])) === 1;
    const after = (await one("SELECT public.tb_run_authoritative($1) a", [t.run])).a;
    return r.outcome === "certified" && before === true && after === false && viaTrigger ? true : { r, before, after, viaTrigger };
  });

  group("Processing admission — leased slots shared by every worker (tb_processing_slots)");
  const acquire = async (holder, lease = 60) => (await asService("SELECT public.tb_acquire_processing_slot($1,$2) s", [holder, lease]))[0].s;
  const releaseSlot = async (holder) => (await asService("SELECT public.tb_release_processing_slot($1) r", [holder]))[0].r;
  await check("capacity is two: two holders get slots 1 and 2, a third gets none (without blocking); a holder asking again keeps its slot", async () => {
    const [h1, h2, h3] = [uuid(), uuid(), uuid()];
    const a = await acquire(h1), b = await acquire(h2), c = await acquire(h3), again = await acquire(h1);
    const freed = await releaseSlot(h1), d = await acquire(h3), notHeld = await releaseSlot(uuid());
    await releaseSlot(h2); await releaseSlot(h3);
    return a === 1 && b === 2 && c === null && again === 1 && freed === true && d === 1 && notHeld === false ? true : { a, b, c, again, freed, d, notHeld };
  });
  await check("a killed worker's slot is reclaimed once its lease expires (never before)", async () => {
    const [h1, h2, h3] = [uuid(), uuid(), uuid()];
    await acquire(h1, 5); await acquire(h2, 60);
    const before = await acquire(h3);
    await admin.query("UPDATE public.tb_processing_slots SET lease_expires_at = now() - interval '1 second' WHERE holder=$1", [h1]);
    const after = await acquire(h3);
    const staleRelease = await releaseSlot(h1);
    await releaseSlot(h2); await releaseSlot(h3);
    return before === null && after !== null && staleRelease === false ? true : { before, after, staleRelease };
  });
  await check("20 simultaneous claims: exactly two granted, every other answered at once with none", async () => {
    const holders = Array.from({ length: 20 }, () => uuid());
    const got = await Promise.all(holders.map((h) => acquire(h)));
    const granted = got.filter((x) => x !== null);
    await Promise.all(holders.map((h) => releaseSlot(h)));
    return granted.length === 2 && new Set(granted).size === 2 ? true : got;
  });
  await refused("clients cannot claim or see slots", "42501", () => asUser(U.owner, "SELECT public.tb_acquire_processing_slot($1,60)", [uuid()]));
}

try { await main(); } catch (e) { record("unexpected", false, String(e?.stack ?? e)); }
finally { await stopDatabase(); }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => `${f.group} / ${f.name}`).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
