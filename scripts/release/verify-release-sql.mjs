// Executes docs/release/sql against a DISPOSABLE database (the one started by
// scripts/db-proof/serve.mjs) and proves: preflight passes before / refuses after the
// release, postcondition passes only when the release landed default denied, and the
// operator scripts work and are audited. Loopback only; it never reads a credential.
//
// Usage: DB_PROOF_MODULES_DIR=<dir with node_modules/pg> node scripts/release/verify-release-sql.mjs
// (with `node scripts/db-proof/serve.mjs` running, which writes .db-proof-seed.json)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MOD = process.env.DB_PROOF_MODULES_DIR ? path.resolve(process.env.DB_PROOF_MODULES_DIR) : REPO;
const { Client } = createRequire(path.join(MOD, "noop.js"))("pg");
const seed = JSON.parse(fs.readFileSync(path.join(REPO, ".db-proof-seed.json"), "utf8"));
if (!/^postgres:\/\/[^@]*@(localhost|127\.0\.0\.1)[:/]/.test(seed.url) || seed.url.includes("bvyivmmfjejbmqoydezk")) throw new Error("REFUSED: not a loopback disposable database");
const base = seed.url.replace(/\/e2e$/, "");

const boot = new Client({ connectionString: seed.url });
await boot.connect();
await boot.query("DROP DATABASE IF EXISTS rel_check");
await boot.query("CREATE DATABASE rel_check");
await boot.end();
const c = new Client({ connectionString: `${base}/rel_check` });
await c.connect();
await c.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
const dir = path.join(REPO, "supabase/migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const CRON = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const apply = async (f) => {
  let t = fs.readFileSync(path.join(dir, f), "utf8");
  if (f === CRON) {
    const l = t.split("\n");
    t = l.slice(0, l.findIndex((x) => x.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  }
  await c.query(t);
};
for (const f of files.slice(0, -2)) await apply(f);
const sql = (n) => fs.readFileSync(path.join(REPO, "docs/release/sql", n), "utf8");
let failures = 0;
const run = async (label, text, expectOk) => {
  try {
    await c.query(text);
    if (!expectOk) failures++;
    console.log(`${expectOk ? "PASS" : "FAIL(unexpected success)"}  ${label}`);
  } catch (e) {
    if (expectOk) failures++;
    console.log(`${expectOk ? "FAIL(unexpected error)" : "PASS"}  ${label}${expectOk ? ` -> ${e.message.split("\n")[0]}` : ""}`);
  }
};
await run("preflight succeeds on a database that lacks the release", sql("01_preflight.sql"), true);
await apply(files.at(-2));
await apply(files.at(-1));
await run("preflight refuses once the release objects exist", sql("01_preflight.sql"), false);
await run("postcondition passes on a fresh default-denied release", sql("02_postcondition.sql"), true);
const owner = (await c.query("INSERT INTO auth.users (id,email) VALUES (gen_random_uuid(),'o@x.test') RETURNING id")).rows[0].id;
const cid = (await c.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'C') RETURNING id", [owner])).rows[0].id;
await run("activate script (placeholders replaced) succeeds", sql("03_activate_company.sql").replace("<COMPANY_UUID>", cid).replace("<why this company, ticket id>", "canary ticket 123").replace("<operator name>", "ops-a"), true);
await run("postcondition refuses when a company is enabled at release time", sql("02_postcondition.sql"), false);
await run("deactivate script succeeds", sql("04_deactivate_company.sql").replace("<COMPANY_UUID>", cid).replace("<why withdrawn, ticket id>", "canary complete 123").replace("<operator name>", "ops-a"), true);
await run("kill switch script succeeds", sql("05_kill_switch.sql").replace("<incident id and reason>", "drill incident 42").replace("<operator name>", "ops-a"), true);
await run("postcondition refuses while the kill switch is engaged", sql("02_postcondition.sql"), false);
const audit = (await c.query("SELECT scope, new_state FROM public.financial_statements_rollout_audit ORDER BY seq")).rows;
const auditOk = JSON.stringify(audit) === JSON.stringify([{ scope: "COMPANY", new_state: true }, { scope: "COMPANY", new_state: false }, { scope: "KILL_SWITCH", new_state: true }]);
if (!auditOk) failures++;
console.log(`${auditOk ? "PASS" : "FAIL"}  every operator action is in the append-only audit log (${audit.length} rows)`);
await c.end();
console.log(failures === 0 ? "RELEASE_SQL: ALL PASSED" : `RELEASE_SQL: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
