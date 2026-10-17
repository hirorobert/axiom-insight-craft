#!/usr/bin/env bun
// Real-PostgreSQL proof of repair B — accounts with different codes may share a name (20261108100000).
//
//   reproduction   on the chain WITHOUT the repair, through the real review RPC: reviewing 4100 "Sales" after 4000 "Sales"
//                  fails with a raw unique violation (uq_acct_map_company_norm_name), and so does renaming a coded account
//                  to a name another code already uses;
//   repair         applied over the same database (existing mappings, decisions and history byte-identical); applying it
//                  again is refused by its preflight;
//   identity       same-name/different-code accounts are reviewed and kept apart (two keys, two decisions, nothing merged);
//                  renaming works; codeless names stay unique (company and global); a codeless and a coded account may
//                  share a name; tenants stay isolated;
//   concurrency    12 concurrent acceptances of two same-name accounts: every one recorded, exactly two mappings.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/accountIdentity.mjs
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
const REPAIR_FILE = "20261108100000_account_identity_codeless_name.sql";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-account-identity-proof-"));
  const port = 56000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE account_identity_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/account_identity_proof`;
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

const decision = (code, name, cls = "revenue", statement = "income_statement", normal = "credit") =>
  ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement, classification: cls, normal_balance: normal });
const FINGERPRINT = `SELECT md5(coalesce((SELECT string_agg(to_jsonb(m)::text, ',' ORDER BY m.id) FROM public.account_mappings m), ''))
  || md5(coalesce((SELECT string_agg(to_jsonb(d)::text, ',' ORDER BY d.id) FROM public.account_review_decisions d), '')) fp`;

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

  group("Replay — the chain up to (not including) the repair");
  await check(`${REPAIR_FILE} is in the chain and everything before it applies`, async () => {
    const cut = files.indexOf(REPAIR_FILE);
    if (cut < 0) return `${REPAIR_FILE} missing`;
    for (const f of files.slice(0, cut)) {
      let t = migrationSql(REPO, f);
      if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      try { await admin.query(t); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; }
    }
    return true;
  });

  const U = { ownerA: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const uid of [U.ownerA, U.ownerB]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='FIRM'", [bc, prod]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Identity A') RETURNING id", [U.ownerA])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Identity B') RETURNING id", [U.ownerB])).id;
  const seedUpload = async (company, uid) => (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, user_id)
    VALUES ('tb.csv',$1,100,'processing',$2,2026,$3) RETURNING id`, [`${uid}/${uuid()}.csv`, company, uid])).id;
  const upA = await seedUpload(A, U.ownerA), upB = await seedUpload(B, U.ownerB);
  const review = async (uid, company, upload, decisions, requestId = uuid()) =>
    (await asRole("authenticated", uid, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb) r", [company, upload, requestId, JSON.stringify(decisions)]))[0].r;
  const mapping = (company, key) => one("SELECT * FROM public.account_mappings WHERE company_id=$1 AND account_key=$2", [company, key]);

  group("Reproduction — the defect, on the chain without the repair (real review RPC)");
  await check("4000 \"Sales\" is reviewed", async () => (await review(U.ownerA, A, upA, [decision("4000", "Sales")])) !== null);
  await refused("reviewing 4100 \"Sales\" (a different code, the same name) fails with a raw unique violation", "23505",
    () => review(U.ownerA, A, upA, [decision("4100", "Sales")]), "uq_acct_map_company_norm_name");
  await check("…and records nothing for 4100", async () => (await count("SELECT count(*) n FROM public.account_review_decisions WHERE company_id=$1 AND review_account_key='4100'", [A])) === 0);
  await check("5000 \"Rent\" is reviewed", async () => (await review(U.ownerA, A, upA, [decision("5000", "Rent", "operating_expenses", "income_statement", "debit")])) !== null);
  await refused("renaming 5000 to \"Sales\" (a name 4000 uses) fails the same way", "23505",
    () => review(U.ownerA, A, upA, [decision("5000", "Sales", "operating_expenses", "income_statement", "debit")]), "uq_acct_map_company_norm_name");
  // History that must survive the repair untouched: a codeless reviewed account, and a second decision on 4000.
  await review(U.ownerA, A, upA, [decision(null, "Petty cash", "current_assets", "balance_sheet", "debit")]);
  await review(U.ownerA, A, upA, [decision("4000", "Sales", "other_income", "income_statement", "credit")]);
  const before = (await one(FINGERPRINT)).fp;

  // The hosted database carries the 20260703100000 indexes under names no migration here creates (uq_mappings_company_code,
  // uq_mappings_company_name). The repair identifies every account-identity index by its DEFINITION. Each scenario runs in
  // one transaction on the owner connection and is rolled back, so the chain below is untouched.
  group("Hosted shape — identity by definition, never by name (each scenario rolled back)");
  const repairSql = migrationSql(REPO, REPAIR_FILE);
  const IDX = "SELECT string_agg(indexname || '=' || indexdef, ' | ' ORDER BY indexname) s FROM pg_indexes WHERE schemaname='public' AND tablename='account_mappings'";
  const HOSTED_NAMES = "ALTER INDEX public.uq_acct_map_company_code RENAME TO uq_mappings_company_code; ALTER INDEX public.uq_acct_map_company_norm_name RENAME TO uq_mappings_company_name;";
  const inTx = async (fn) => { await admin.query("BEGIN"); try { return await fn(); } finally { await admin.query("ROLLBACK"); } };
  const defOf = async (name) => (await admin.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1", [name])).rows[0]?.indexdef ?? null;
  const reviewTx = async (uid, company, upload, decisions) => {
    await admin.query("SAVEPOINT rv");
    try {
      await admin.query("SET LOCAL ROLE authenticated");
      await admin.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
      const r = (await admin.query("SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb) r", [company, upload, uuid(), JSON.stringify(decisions)])).rows[0].r;
      await admin.query("RESET ROLE"); await admin.query("RELEASE SAVEPOINT rv"); return r;
    } catch (e) { await admin.query("ROLLBACK TO SAVEPOINT rv"); await admin.query("RESET ROLE"); throw e; }
  };
  const refusedTx = (name, mutation, text) => check(name, () => inTx(async () => {
    await admin.query(mutation);
    const pre = (await admin.query(IDX)).rows[0].s;
    await admin.query("SAVEPOINT ap");
    let err = null;
    try { await admin.query(repairSql); } catch (e) { err = e; }
    await admin.query("ROLLBACK TO SAVEPOINT ap");
    const post = (await admin.query(IDX)).rows[0].s;
    return err?.code === "P0001" && String(err.message).includes(text) && pre === post ? true : { code: err?.code, message: err?.message, unchanged: pre === post };
  }));

  await check("with the HOSTED names: reproduction fails on uq_mappings_company_name; the repair replaces exactly that index, keeps uq_mappings_company_code and the key byte-identical, and 4100 \"Sales\" is then reviewed", () => inTx(async () => {
    await admin.query(HOSTED_NAMES);
    let reproduced = false;
    try { await reviewTx(U.ownerA, A, upA, [decision("4100", "Sales")]); } catch (e) { reproduced = e.code === "23505" && String(e.message).includes("uq_mappings_company_name"); }
    const code0 = await defOf("uq_mappings_company_code"), key0 = await defOf("uq_acct_map_company_key"), fp0 = (await admin.query(FINGERPRINT)).rows[0].fp;
    await admin.query(repairSql);
    const fpSame = (await admin.query(FINGERPRINT)).rows[0].fp === fp0;
    const ok = reproduced && fpSame && (await defOf("uq_mappings_company_name")) === null && (await defOf("uq_acct_map_company_norm_name")) === null
      && (await defOf("uq_mappings_company_code")) === code0 && (await defOf("uq_acct_map_company_key")) === key0
      && /NULLS NOT DISTINCT WHERE \(\(account_code IS NULL\) AND \(normalized_account_name IS NOT NULL\)\)/.test((await defOf("uq_acct_map_company_codeless_name")) ?? "");
    const reviewed = ok ? (await reviewTx(U.ownerA, A, upA, [decision("4100", "Sales")])) !== null : false;
    const two = Number((await admin.query("SELECT count(*) n FROM public.account_mappings WHERE company_id=$1 AND account_code IN ('4000','4100')", [A])).rows[0].n) === 2;
    return ok && reviewed && two ? true : { reproduced, fpSame, ok, reviewed, two, idx: (await admin.query(IDX)).rows[0].s };
  }));
  await check("hosted names with a NULLS DISTINCT all-names index and a NULLS DISTINCT code index: accepted; the all-names index is replaced, the code index kept", () => inTx(async () => {
    await admin.query(`${HOSTED_NAMES}
      DROP INDEX public.uq_mappings_company_name; CREATE UNIQUE INDEX uq_mappings_company_name ON public.account_mappings (company_id, normalized_account_name) WHERE normalized_account_name IS NOT NULL;
      DROP INDEX public.uq_mappings_company_code; CREATE UNIQUE INDEX uq_mappings_company_code ON public.account_mappings (company_id, account_code) WHERE account_code IS NOT NULL;`);
    const code0 = await defOf("uq_mappings_company_code");
    await admin.query(repairSql);
    return (await defOf("uq_mappings_company_name")) === null && (await defOf("uq_mappings_company_code")) === code0 && (await defOf("uq_acct_map_company_codeless_name")) !== null
      ? true : (await admin.query(IDX)).rows[0].s;
  }));
  await check("both name families present (old and hosted all-names indexes): both are replaced, nothing else changes", () => inTx(async () => {
    await admin.query("CREATE UNIQUE INDEX uq_mappings_company_name ON public.account_mappings (company_id, normalized_account_name) NULLS NOT DISTINCT WHERE normalized_account_name IS NOT NULL;");
    await admin.query(repairSql);
    return (await defOf("uq_mappings_company_name")) === null && (await defOf("uq_acct_map_company_norm_name")) === null && (await defOf("uq_acct_map_company_code")) !== null
      ? true : (await admin.query(IDX)).rows[0].s;
  }));
  await refusedTx("an unrecognised unique index on the name (extra column) refuses everything, nothing changed",
    "CREATE UNIQUE INDEX uq_mappings_name_statement ON public.account_mappings (company_id, normalized_account_name, statement);", "not a recognised account-identity definition");
  await refusedTx("an all-names-like index with another predicate refuses everything, nothing changed",
    `${HOSTED_NAMES} DROP INDEX public.uq_mappings_company_name; CREATE UNIQUE INDEX uq_mappings_company_name ON public.account_mappings (company_id, normalized_account_name) WHERE account_code IS NOT NULL;`, "not a recognised account-identity definition");
  await refusedTx("reversed key columns refuse everything, nothing changed",
    `${HOSTED_NAMES} DROP INDEX public.uq_mappings_company_name; CREATE UNIQUE INDEX uq_mappings_company_name ON public.account_mappings (normalized_account_name, company_id) WHERE normalized_account_name IS NOT NULL;`, "not a recognised account-identity definition");
  await refusedTx("a non-default collation on the all-names index refuses everything, nothing changed",
    `${HOSTED_NAMES} DROP INDEX public.uq_mappings_company_name; CREATE UNIQUE INDEX uq_mappings_company_name ON public.account_mappings (company_id, normalized_account_name COLLATE "POSIX") WHERE normalized_account_name IS NOT NULL;`, "not valid, plain and default");
  await refusedTx("an INVALID all-names index refuses everything, nothing changed",
    `${HOSTED_NAMES} UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'public.uq_mappings_company_name'::regclass;`, "not valid, plain and default");
  await refusedTx("a missing code index refuses everything, nothing changed",
    `${HOSTED_NAMES} DROP INDEX public.uq_mappings_company_code;`, "account key or code identity index is missing");
  await refusedTx("a key index without NULLS NOT DISTINCT refuses everything, nothing changed",
    "DROP INDEX public.uq_acct_map_company_key; CREATE UNIQUE INDEX uq_acct_map_company_key ON public.account_mappings (company_id, account_key);", "not a recognised account-identity definition");
  await refusedTx("no all-names index at all refuses everything, nothing changed",
    "DROP INDEX public.uq_acct_map_company_norm_name;", "no all-names identity index to replace");
  await check("every scenario was rolled back: the chain's indexes and every mapping and decision are unchanged", async () =>
    (await one(FINGERPRINT)).fp === before && (await defOf("uq_acct_map_company_norm_name")) !== null && (await defOf("uq_acct_map_company_codeless_name")) === null ? true : "changed");

  group("Repair — applied over the same database");
  await check(`${REPAIR_FILE} applies and leaves every mapping and decision byte-identical`, async () => {
    await admin.query(migrationSql(REPO, REPAIR_FILE));
    return (await one(FINGERPRINT)).fp === before ? true : "changed";
  });
  await refused("applying it again is refused by its preflight", "P0001", () => admin.query(migrationSql(REPO, REPAIR_FILE)), "PREFLIGHT_REFUSED");
  await check("the indexes: codeless-name unique (NULLS NOT DISTINCT), the old all-names index gone, code and key unchanged", async () => {
    const ix = Object.fromEntries((await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename='account_mappings' AND indexname LIKE 'uq_acct_map_%'")).rows.map((r) => [r.indexname, r.indexdef]));
    return !ix.uq_acct_map_company_norm_name && /NULLS NOT DISTINCT WHERE \(\(account_code IS NULL\) AND \(normalized_account_name IS NOT NULL\)\)/.test(ix.uq_acct_map_company_codeless_name ?? "")
      && !!ix.uq_acct_map_company_code && !!ix.uq_acct_map_company_key ? true : ix;
  });

  group("Identity — same name, different codes, kept apart");
  await check("4100 \"Sales\" is now reviewed: two mappings, two keys, each with its own decision; 4000 untouched", async () => {
    const before4000 = await mapping(A, "4000");
    await review(U.ownerA, A, upA, [decision("4100", "Sales", "revenue")]);
    const m40 = await mapping(A, "4000"), m41 = await mapping(A, "4100");
    const d41 = await one("SELECT review_account_key FROM public.account_review_decisions WHERE id=$1", [m41.review_decision_id]);
    return JSON.stringify(m40) === JSON.stringify(before4000) && m41.classification === "revenue" && m40.classification === "other_income"
      && m41.review_decision_id !== m40.review_decision_id && d41.review_account_key === "4100" ? true : { m40, m41 };
  });
  await check("both in ONE batch (4200 and 4300 \"Commission\"): accepted together, still two accounts", async () => {
    await review(U.ownerA, A, upA, [decision("4200", "Commission"), decision("4300", "Commission", "other_income")]);
    return (await count("SELECT count(*) n FROM public.account_mappings WHERE company_id=$1 AND normalized_account_name='commission'", [A])) === 2 ? true : "count";
  });
  await check("renaming 5000 to \"Sales\" now works: the key is still 5000, the previous name is in the decision's history", async () => {
    await review(U.ownerA, A, upA, [decision("5000", "Sales", "operating_expenses", "income_statement", "debit")]);
    const m = await mapping(A, "5000");
    const last = await one("SELECT previous_value FROM public.account_review_decisions WHERE id=$1", [m.review_decision_id]);
    return m.normalized_account_name === "sales" && last.previous_value?.account_name === "Rent"
      && (await count("SELECT count(*) n FROM public.account_mappings WHERE company_id=$1 AND normalized_account_name='sales'", [A])) === 3 ? true : { m, last };
  });
  await check("a codeless account may share a name with coded ones (codeless \"Sales\" is its own key)", async () => {
    await review(U.ownerA, A, upA, [decision(null, "Sales", "revenue")]);
    const m = await mapping(A, "sales");
    return m && m.account_code === null && (await count("SELECT count(*) n FROM public.account_mappings WHERE company_id=$1 AND normalized_account_name='sales'", [A])) === 4 ? true : m;
  });
  await check("a codeless name stays ONE account: reviewing \"Petty cash\" again updates it (one mapping, two decisions)", async () => {
    await review(U.ownerA, A, upA, [decision(null, "Petty  cash!", "current_assets", "balance_sheet", "debit")]);
    return (await count("SELECT count(*) n FROM public.account_mappings WHERE company_id=$1 AND account_key='petty cash'", [A])) === 1
      && (await count("SELECT count(*) n FROM public.account_review_decisions WHERE company_id=$1 AND review_account_key='petty cash'", [A])) === 2 ? true : "counts";
  });
  await refused("a second codeless row with the same name in one company is refused (database owner, direct insert)", "23505",
    () => admin.query("INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, normalized_account_name, statement, classification, line_item, normal_balance) VALUES ($1,$2,NULL,'Petty cash','petty cash','balance_sheet','current_assets','x','debit')", [U.ownerA, A]));
  await refused("…and two GLOBAL codeless rows with one name are refused (NULLS NOT DISTINCT kept)", "23505", async () => {
    await admin.query("INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, normalized_account_name, statement, classification, line_item, normal_balance) VALUES ($1,NULL,NULL,'Audit fee','audit fee','income_statement','operating_expenses','x','debit')", [U.ownerA]);
    await admin.query("INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, normalized_account_name, statement, classification, line_item, normal_balance) VALUES ($1,NULL,NULL,'Audit fee','audit fee','income_statement','operating_expenses','x','debit')", [U.ownerA]);
  });
  await refused("a duplicate CODE is still refused in one company", "23505",
    () => admin.query("INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, normalized_account_name, statement, classification, line_item, normal_balance) VALUES ($1,$2,'4000','Other','other','income_statement','revenue','x','credit')", [U.ownerA, A]));

  group("Tenants — the same codes and names in another company are independent");
  await check("company B reviews 4000 and 4100 \"Sales\": its own two mappings; A unchanged", async () => {
    const aBefore = (await pool.query("SELECT to_jsonb(m)::text t FROM public.account_mappings m WHERE company_id=$1 ORDER BY id", [A])).rows.map((r) => r.t).join();
    await review(U.ownerB, B, upB, [decision("4000", "Sales", "cost_of_goods_sold", "income_statement", "debit"), decision("4100", "Sales")]);
    const aAfter = (await pool.query("SELECT to_jsonb(m)::text t FROM public.account_mappings m WHERE company_id=$1 ORDER BY id", [A])).rows.map((r) => r.t).join();
    return aBefore === aAfter && (await mapping(B, "4000")).classification === "cost_of_goods_sold" && (await mapping(A, "4000")).classification === "other_income" ? true : "tenancy";
  });
  await refused("a member of B cannot review A's accounts", "42501", () => review(U.ownerB, A, upA, [decision("4100", "Sales")]));

  group("Concurrency — 12 concurrent acceptances of two same-name accounts");
  await check("every acceptance recorded (12 decisions), exactly two mappings, no error", async () => {
    const rs = await Promise.allSettled(Array.from({ length: 12 }, (_, k) => review(U.ownerA, A, upA, [decision(k % 2 ? "6100" : "6000", "Consulting fees", "operating_expenses", "income_statement", "debit")])));
    const failed = rs.filter((r) => r.status === "rejected").map((r) => `${r.reason.code} ${String(r.reason.message).split("\n")[0]}`);
    const maps = await count("SELECT count(*) n FROM public.account_mappings WHERE company_id=$1 AND normalized_account_name='consulting fees'", [A]);
    const decs = await count("SELECT count(*) n FROM public.account_review_decisions WHERE company_id=$1 AND review_account_key IN ('6000','6100')", [A]);
    return failed.length === 0 && maps === 2 && decs === 12 ? true : { failed, maps, decs };
  });

  group("Impact detection — the owner's read-only queries (scripts/db-preflight/processingIntegrityImpact.sql)");
  // A certification as an earlier engine could record it: 4100 "Sales" certified by NAME (tier 2) after a reviewed
  // decision for "Sales" existed only under code 4000 — the silent wrong-code reuse generation 6 no longer performs.
  const reuse = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, user_id)
    VALUES ('tb.csv',$1,100,'processing',$2,2027,$3) RETURNING id`, [`${U.ownerA}/${uuid()}.csv`, A, U.ownerA])).id;
  const SRC = crypto.createHash("sha256").update("impact-detection").digest("hex");
  const b = (await asRole("service_role", null, "SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v4',4,'workspace_user',NULL,$4,600) r", [reuse, uuid(), SRC, U.ownerA]))[0].r;
  await asRole("service_role", null, "SELECT public.tb_snapshot_dependencies($1,$2::jsonb)", [b.engine_run_id, JSON.stringify([{ scope: A, key: "#currency" }])]);
  const row = { accountCode: "4900", accountName: "Sales", nature: "income", subNature: "other_income", debitBalance: 0, creditBalance: 10, netBalance: 10, evidenceTier: 2, ruleId: null, requiresReview: false };
  const fin = (await asRole("service_role", null, "SELECT public.tb_finalize_attempt($1,$2::jsonb) r", [b.engine_run_id, JSON.stringify({ outcome: "certified",
    upload: { status: "complete", is_valid: true, processing_result: { status: "valid" }, validation_report: { ok: true }, accounting_errors: [] },
    certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: false, requires_review: false, exceptions: [], rows_snapshot: [row] } })]))[0].r;
  const sql = fs.readFileSync(path.join(REPO, "scripts/db-preflight/processingIntegrityImpact.sql"), "utf8");
  const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
  await check(`every query (${statements.length}) runs in a READ ONLY transaction (nothing can be written)`, async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN TRANSACTION READ ONLY");
      for (const st of statements) await c.query(st);
      await c.query("ROLLBACK");
      return statements.every((st) => /^SELECT\b/i.test(st)) && statements.length >= 7 ? true : "not all SELECT";
    } finally { c.release(); }
  });
  await check("B1 finds the seeded wrong-code reuse (4900 certified by name after a decision under 4000) and nothing for correctly coded accounts", async () => {
    const rows = (await pool.query(statements[0])).rows;
    const hit = rows.filter((r) => r.certification_id === fin.certification_id);
    return fin.outcome === "certified" && hit.length >= 1 && hit.every((r) => r.certified_code === "4900" && r.decision_code !== "4900")
      && rows.every((r) => r.certified_code !== r.decision_code) ? true : { fin, hit, n: rows.length };
  });
}

try { await main(); } catch (e) { record("unexpected", false, String(e?.stack ?? e)); }
finally { await stopDatabase(); }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => `${f.group} / ${f.name}`).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
