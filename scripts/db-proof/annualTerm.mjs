#!/usr/bin/env node
// Real-PostgreSQL proof of the 12-month commercial term (20261001120000_annual_commercial_term.sql).
//
//   Gate      the committable statuses are DERIVED from the live functions; every invalid shape (MONTHLY × 1, ANNUAL × 2;
//             ANNUAL × NULL cannot exist) in every committable status refuses the migration with schema and business rows
//             byte-identical; terminal statuses do not block; the migration refuses while an invalid intent can be fulfilled; the read-only
//             preflight lists it and reads FAIL, then PASS once it is resolved through the existing failure path;
//   Existing  every pre-existing licence is unchanged in every column; no renewal state is introduced; only the CFOCLOSE
//             self-serve monthly offers are retired; an existing monthly-paid licence can end earlier, never be extended;
//   Intents   exactly ANNUAL × 1 on INSERT and on UPDATE of plan/interval/count; the CFOCLOSE product boundary holds
//             (a same-code plan of another product is outside it, and cannot be moved inside);
//   Recon     reconciliation is an exact predicate (provider-verified or reviewed-with-evidence CANCELLED / EXPIRED /
//             REFUNDED, or SUCCEEDED with its licence); every non-final outcome refuses the migration with Section B empty;
//             a paid MONTHLY × 1 or ANNUAL × 2 checkout never creates a licence, even forced past the intent guard;
//   Cancel    admin_cancel_future_licence: future-only, CFOCLOSE-only, ACTIVE/PENDING-only; CANCELLED with dates
//             byte-identical; one immutable audit event; idempotent per key; irreversible; controlled outcomes; client
//             roles refused; evidence, the current licence and every other row untouched; concurrency and rollback proven;
//             the idempotency key is bound to licence + reason + actor (any other reuse: idempotency_conflict, no write);
//   Licences  a payment-created self-serve licence is exactly 12 months (NULL, 11, 13 and 24 months refused); after
//             insertion it may only end earlier; no row becomes one by an UPDATE; Enterprise is untouched;
//   Payments  an annual payment yields one exact 12-month entitled licence; an upgrade still ends the current one early;
//   Access    suspension and expiry refuse new privileged actions and keep the workspace readable;
//   Contract  every refusal is SQLSTATE PT422 with ANNUAL_TERM_REQUIRED / INVALID_COMMERCIAL_TERM /
//             INVALID_OPEN_CHECKOUT_INTENTS — no internal wording; no client grant; checkout stays disabled; re-runnable.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/annualTerm.mjs
//
// It reads no Supabase credential and refuses every non-loopback host and the production project reference.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MIGRATION = "20261001120000_annual_commercial_term.sql";
const PREFLIGHT = "scripts/db-preflight/annualTermPreflight.sql";
const MODE = process.env.DB_PROOF_MODE ?? "embedded";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;

const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") {
  results.push({ group: currentGroup, name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}
async function check(name, fn) {
  try {
    const r = await fn();
    record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)}`);
  } catch (e) {
    record(name, false, String(e?.message ?? e).split("\n")[0]);
  }
}

let pool;
let admin;
let embeddedServer = null;
let embeddedDir = null;

function assertLocal(u) {
  const url = new URL(u);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`REFUSED: ${url.hostname} is not loopback`);
  if (u.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project reference");
}
async function startDatabase() {
  if (MODE === "external") { assertLocal(process.env.DB_PROOF_CONN); return process.env.DB_PROOF_CONN; }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-annual-term-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE annual_term_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/annual_term_proof`;
}
async function stopDatabase() {
  try { await pool?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  if (embeddedServer) { try { await embeddedServer.stop(); } catch { /* ignore */ } }
  if (embeddedDir) { try { fs.rmSync(embeddedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ } }
}

const migrationFiles = () => fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
async function applyMigration(f) {
  let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
  if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  try { await admin.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
}

async function asCaller(caller, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (caller.kind === "anon") {
      await c.query("SET LOCAL ROLE anon");
      await c.query("SELECT set_config('request.jwt.claim.role','anon',true), set_config('request.jwt.claim.sub','',true)");
    } else if (caller.kind === "service") {
      await c.query("SET LOCAL ROLE service_role");
      await c.query("SELECT set_config('request.jwt.claim.role','service_role',true), set_config('request.jwt.claim.sub','',true)");
    } else {
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [caller.uid]);
    }
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally { c.release(); }
}
const user = (uid) => ({ kind: "user", uid });
const ANON = { kind: "anon" };
const q = (caller, sql, params) => asCaller(caller, async (c) => (await c.query(sql, params)).rows);
const one = async (caller, sql, params) => (await q(caller, sql, params))[0];
const uuid = () => globalThis.crypto.randomUUID();
const codeOf = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.code ?? String(e.message); } };
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: 8 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);

  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);
  group("Migration chain");
  await check(`every migration before ${MIGRATION} applies, and ${MIGRATION} is the newest`, async () => {
    if (cut < 0) return "migration not found";
    if (cut !== files.length - 1) return `not the newest migration (followed by ${files.slice(cut + 1).join(", ")})`;
    for (const f of files.slice(0, cut)) await applyMigration(f);
    return true;
  });
  await check("the migration raises only controlled application errors — no internal implementation wording", async () => {
    const sql = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8").replace(/--[^\n]*/g, "");
    const raised = [...sql.matchAll(/RAISE EXCEPTION '([^']+)'/g)].map((m) => m[1]);
    const ok = raised.length >= 4 && raised.every((m) => ["ANNUAL_TERM_REQUIRED", "INVALID_COMMERCIAL_TERM", "INVALID_OPEN_CHECKOUT_INTENTS", "UNRECONCILED_PROVIDER_CHECKOUTS", "CANCELLED_LICENCE_IMMUTABLE"].includes(m))
      && [...sql.matchAll(/ERRCODE = '([^']+)'/g)].every((m) => m[1] === "PT422") && !/iron dome|renewal/i.test(sql);
    return ok ? true : raised.join(",");
  });

  // ── Fixtures that exist BEFORE the migration ─────────────────────────────────────────────────────────────────────
  const mkUser = async (label) => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id}@example.test`]); return id; };
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const planId = async (code, prod = product) => (await admin.query("SELECT id FROM public.commercial_plans WHERE product_id=$1 AND code=$2", [prod, code])).rows[0].id;
  const PLAN = { SOLO: await planId("SOLO"), PRACTICE: await planId("PRACTICE"), FIRM: await planId("FIRM"), ENTERPRISE: await planId("ENTERPRISE") };
  const offer = async (code) => (await admin.query("SELECT * FROM public.commercial_offers WHERE offer_code=$1", [code])).rows[0];
  const ADMIN = await mkUser("admin");
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [ADMIN]);

  // A different product whose plan carries the SAME code (SOLO) — outside the CFOCLOSE boundary.
  const other = (await admin.query("INSERT INTO public.commercial_products (code, name) VALUES ('OTHERPROD', 'Other product') RETURNING id")).rows[0].id;
  const OTHER_SOLO = (await admin.query(`INSERT INTO public.commercial_plans (product_id, code, name, feature_codes, entity_capacity, included_seats, additional_seats_purchasable, is_public, sales_mode)
    SELECT $1, code, name, feature_codes, entity_capacity, included_seats, additional_seats_purchasable, false, sales_mode FROM public.commercial_plans WHERE id = $2 RETURNING id`, [other, PLAN.SOLO])).rows[0].id;
  const cfoSoloMonthly = await offer("CFOCLOSE_SOLO_GLOBAL_USD_MONTHLY");
  await admin.query(`INSERT INTO public.commercial_offers (offer_code, plan_id, market_code, currency_code, amount_minor, currency_exponent, billing_interval, billing_interval_count)
    VALUES ('OTHERPROD_SOLO_GLOBAL_USD_MONTHLY', $1, $2, 'USD', 4900, 2, 'MONTHLY', 1)`, [OTHER_SOLO, cfoSoloMonthly.market_code]);

  const account = async (label, planCode, licence = {}) => {
    const uid = await mkUser(label);
    const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id;
    let lic = null;
    let co = null;
    if (planCode) {
      // The workspace is created while the licence is current (company creation is capacity-gated), then the licence
      // is put into its target state — as a real account reaches it. (These writes precede the migration.)
      lic = (await admin.query(`INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start)
        VALUES ($1,$2,'ACTIVE',$3,now() - interval '1 day') RETURNING id`, [bc, PLAN[planCode], licence.source ?? "ADMIN_GRANT"])).rows[0].id;
      co = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,$2) RETURNING id", [uid, `${label} Co`])).rows[0].id;
      await admin.query("UPDATE public.commercial_licences SET status=$2, effective_start=$3, effective_end=$4 WHERE id=$1",
        [lic, licence.status ?? "ACTIVE", licence.start ?? new Date(Date.now() - 86_400_000), licence.end ?? null]);
    }
    return { uid, bc, lic, co };
  };
  const intentRow = async (acct, o, over = {}) => (await admin.query(`INSERT INTO public.payment_checkout_intents
        (billing_customer_id, commercial_offer_id, plan_id, market_code, expected_amount_minor, currency_code, currency_exponent,
         billing_interval, billing_interval_count, provider, saff_reference, status, created_by_user_id, provider_environment, product_id, provider_checkout_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'STRIPE',$10,$13,$11,'sandbox',$12,$14) RETURNING id`,
      [acct.bc, o.id, over.plan_id ?? o.plan_id, o.market_code, o.amount_minor, o.currency_code, o.currency_exponent,
       over.billing_interval ?? o.billing_interval, ("billing_interval_count" in over) ? over.billing_interval_count : o.billing_interval_count, `SAFF-${uuid()}`, acct.uid, over.product_id ?? product,
       over.status ?? 'PENDING', over.provider_checkout_ref ?? null])).rows[0].id;
  const intent = async (acct, offerCode, over) => intentRow(acct, await offer(offerCode), over);
  const commit = async (intentId, amount, status = "SUCCEEDED", method = "PROVIDER_API_VERIFY") => (await admin.query(`SELECT public.commit_verified_commercial_payment($1,'STRIPE',$2,$3,$4,$5,'USD',$6,now(),$9,$7,$8,'sandbox') r`,
    [intentId, `tx-${uuid()}`, status.toLowerCase(), status, amount, "h".repeat(64), `idem-${uuid()}`, `SAFF-${uuid()}`, method])).rows[0].r;
  const commitAs = async (intentId, status, method) => {
    const amount = (await admin.query("SELECT expected_amount_minor a FROM public.payment_checkout_intents WHERE id=$1", [intentId])).rows[0].a;
    return commit(intentId, Number(amount), status, method);
  };
  const licenceInsert = (bc, plan, start, end, source = "STRIPE_VERIFIED_PAYMENT", status = "PENDING") =>
    admin.query(`INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [bc, plan, status, source, start, end]).then((r) => r.rows[0].id);
  const isPT422 = (e, msg) => e?.code === "PT422" && e?.message === msg;

  const P = {
    annualAdmin: await account("annual-admin", "PRACTICE", { start: new Date(Date.now() - 30 * 86_400_000), end: new Date(Date.now() + 335 * 86_400_000) }),
    monthlyPaid: await account("monthly-paid", "SOLO", { source: "STRIPE_VERIFIED_PAYMENT", start: new Date(Date.now() - 5 * 86_400_000), end: new Date(Date.now() + 25 * 86_400_000) }),
    suspended: await account("suspended", "FIRM", { status: "SUSPENDED" }),
    expired: await account("expired", "SOLO", { status: "EXPIRED", start: new Date(Date.now() - 400 * 86_400_000), end: new Date(Date.now() - 35 * 86_400_000) }),
  };
  const pending = await account("pending-monthly", null);
  const pendingMonthlyIntent = await intent(pending, "CFOCLOSE_SOLO_GLOBAL_USD_MONTHLY");
  // The production scenario, built BEFORE the migration through the real verified-payment path: a current annual Solo
  // licence, then a MONTHLY purchase that stacks a one-month licence after it (start = the annual licence's end).
  const stacked = await account("stacked", null);
  await commit(await intent(stacked, "CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL"), 49000);
  const stackedCo = (await q(user(stacked.uid), "INSERT INTO public.companies (user_id,name) VALUES ($1,'Stacked Co') RETURNING id", [stacked.uid]))[0].id;
  const stackedMonthlyIntent = await intent(stacked, "CFOCLOSE_SOLO_GLOBAL_USD_MONTHLY");
  await commit(stackedMonthlyIntent, 4900);
  const stackedLic = async () => (await admin.query(`SELECT l.id, l.status, l.effective_start, l.effective_end, l.effective_start > now() AS future
      FROM public.commercial_licences l WHERE l.billing_customer_id=$1 ORDER BY l.effective_start`, [stacked.bc])).rows;
  const [stackedAnnual, stackedFuture] = await stackedLic();
  const fullLic = async () => (await admin.query("SELECT to_jsonb(l) AS row FROM public.commercial_licences l ORDER BY id")).rows;
  const snapOffers = async () => (await admin.query("SELECT offer_code, to_jsonb(o) AS row FROM public.commercial_offers o ORDER BY offer_code")).rows;
  const platformState = async () => (await admin.query("SELECT state FROM public.commercial_platform_state")).rows.map((r) => r.state).join(",");
  const platformBefore = await platformState();
  const runPreflight = async () => {
    const sql = fs.readFileSync(path.join(REPO, PREFLIGHT), "utf8");
    const c = await pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      const res = await c.query(sql);
      await c.query("ROLLBACK");
      return (Array.isArray(res) ? res : [res]).map((r) => r.rows);
    } finally { c.release(); }
  };

  // ── Committable statuses, derived from the live database ─────────────────────────────────────────────────────────
  group("Committable statuses · derived from the live functions, not assumed");
  const vocabulary = async () => {
    const def = (await admin.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='chk_pci_status'")).rows[0].d;
    return [...def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  };
  const fnDef = async (name) => (await admin.query("SELECT string_agg(pg_get_functiondef(p.oid), E'\\n') d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1", [name])).rows[0].d ?? "";
  const listIn = (text) => [...text.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  let FULFILLABLE = [];
  let TERMINAL = [];
  await check("derive: vocabulary − (statuses the commit/claim guards accept, closed under every status transition into them) = the migration's terminal set", async () => {
    const vocab = await vocabulary();
    const direct = new Set();
    for (const fn of ["commit_verified_commercial_payment", "claim_verification_attempt"]) {
      for (const m of (await fnDef(fn)).matchAll(/status\s+NOT\s+IN\s*\(([^)]*)\)/gi)) listIn(m[1]).forEach((s) => direct.add(s));
    }
    // Every UPDATE of payment_checkout_intents.status in every public function, with its source-status filter. A statement
    // without an inline filter takes the status literals its function selects on (e.g. acquire_checkout_attempt's
    // v_existing lookup) — never "any status".
    const transitions = [];
    const fns = (await admin.query("SELECT p.proname, pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'")).rows;
    for (const { proname, d } of fns) {
      if (!/UPDATE\s+public\.payment_checkout_intents/i.test(d)) continue;
      const fnFilters = [...d.matchAll(/status\s+(?:=\s*'([A-Z_]+)'|IN\s*\(([^)]*)\))/gi)].flatMap((m) => (m[1] ? [m[1]] : listIn(m[2])));
      for (const stmt of d.split(";").filter((x) => /UPDATE\s+public\.payment_checkout_intents/i.test(x))) {
        const to = stmt.match(/SET[\s\S]*?\bstatus\s*=\s*(?:CASE[\s\S]*?END|'([A-Z_]+)')/i);
        if (!to) continue;
        const targets = to[1] ? [to[1]] : listIn(to[0]);
        const where = stmt.split(/\bWHERE\b/i)[1] ?? "";
        const inline = [...where.matchAll(/status\s+(?:=\s*'([A-Z_]+)'|IN\s*\(([^)]*)\))/gi)].flatMap((m) => (m[1] ? [m[1]] : listIn(m[2])));
        transitions.push({ proname, from: inline.length ? inline : fnFilters, to: targets });
      }
    }
    const closure = new Set(direct);
    for (let grew = true; grew;) {
      grew = false;
      for (const t of transitions) if (t.to.some((s) => closure.has(s))) for (const f of t.from) if (!closure.has(f)) { closure.add(f); grew = true; }
    }
    FULFILLABLE = vocab.filter((s) => closure.has(s));
    TERMINAL = vocab.filter((s) => !closure.has(s));
    const sql = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8").replace(/--[^\n]*/g, "");
    const gateTerminal = listIn(sql.match(/i\.status NOT IN \(([^)]*)\)/)[1]);
    const ok = [...direct].sort().join() === "MANUAL_REVIEW,PENDING"
      && JSON.stringify([...TERMINAL].sort()) === JSON.stringify([...gateTerminal].sort())
      && FULFILLABLE.length >= 4;
    return ok ? true : { vocab, direct: [...direct], FULFILLABLE, TERMINAL, gateTerminal };
  });
  console.log(`        committable (fulfillable): ${FULFILLABLE.join(", ")}   terminal: ${TERMINAL.join(", ")}`);

  // ── Every invalid shape × every committable status refuses the migration, atomically ─────────────────────────────
  group("Zero-state refusal · every invalid shape × every committable status, atomic");
  const BUSINESS_FP = `SELECT md5(string_agg(x, '|' ORDER BY x)) AS fp FROM (
    SELECT 'c:'||table_name||'.'||column_name||':'||data_type||':'||coalesce(column_default,'')||is_nullable AS x FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT 'f:'||p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
    UNION ALL SELECT 't:'||tgname||':'||tgrelid::regclass::text FROM pg_trigger WHERE NOT tgisinternal
    UNION ALL SELECT 'k:'||conname||':'||conrelid::regclass::text||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT 'o:'||to_jsonb(o)::text FROM public.commercial_offers o
    UNION ALL SELECT 'l:'||to_jsonb(l)::text FROM public.commercial_licences l
    UNION ALL SELECT 'i:'||to_jsonb(i)::text FROM public.payment_checkout_intents i
    UNION ALL SELECT 'e:'||to_jsonb(e)::text FROM public.payment_events e
    UNION ALL SELECT 'a:'||to_jsonb(a)::text FROM public.billing_audit_events a
    UNION ALL SELECT 's:'||to_jsonb(s)::text FROM public.commercial_platform_state s
  ) z`;
  const fingerprint = async () => (await admin.query(BUSINESS_FP)).rows[0].fp;
  const migrationText = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8");
  const SHAPES = [
    { label: "MONTHLY × 1", offer: "CFOCLOSE_SOLO_GLOBAL_USD_MONTHLY", over: {} },
    { label: "ANNUAL × 2", offer: "CFOCLOSE_PRACTICE_GLOBAL_USD_ANNUAL", over: { billing_interval_count: 2 } },
  ];
  for (const shape of SHAPES) {
    for (const status of FULFILLABLE) {
      await check(`existing ${shape.label} intent in ${status}: the migration refuses (PT422 INVALID_OPEN_CHECKOUT_INTENTS) and schema + business rows are byte-identical`, async () => {
        const a = await account(`gate-${status}`, null);
        const id = await intent(a, shape.offer, { ...shape.over, status });
        const before = await fingerprint();
        let err = null;
        try { await admin.query(migrationText); } catch (e) { err = e; }
        const after = await fingerprint();
        await admin.query("DELETE FROM public.payment_checkout_intents WHERE id=$1", [id]);   // fixture cleanup
        return isPT422(err, "INVALID_OPEN_CHECKOUT_INTENTS") && before === after ? true : { code: err?.code, msg: err?.message, same: before === after };
      });
    }
  }
  await check("ANNUAL × NULL cannot exist: billing_interval_count is NOT NULL (23502) — and the predicate would catch it anyway (NULL IS DISTINCT FROM 1)", async () => {
    const a = await account("gate-null", null);
    const e = await errOf(() => intent(a, "CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL", { billing_interval_count: null, forceNull: true }));
    const distinct = (await admin.query("SELECT (NULL::smallint IS DISTINCT FROM 1) AS d")).rows[0].d;
    return e?.code === "23502" && distinct === true ? true : { code: e?.code, msg: e?.message, distinct };
  });
  await check("an invalid intent in a TERMINAL status does not block (it can no longer be fulfilled)", async () => {
    const ids = [];
    for (const status of TERMINAL) { const a = await account(`term-${status}`, null); ids.push(await intent(a, "CFOCLOSE_SOLO_GLOBAL_USD_MONTHLY", { status })); }
    const sets = await runPreflight();
    const gate = sets[sets.length - 1][0];
    const ok = Number(gate.invalid_fulfillable_intents) === 1;   // only the pre-existing PENDING monthly fixture remains open
    return ok ? true : JSON.stringify(gate);
  });

  // ── Zero-state gate ──────────────────────────────────────────────────────────────────────────────────────────────
  group("Zero-state gate · an open monthly intent blocks the migration");
  await check("the preflight runs READ ONLY, lists the monthly-paid licence and the open monthly intent, and reads GATE = FAIL", async () => {
    const sets = await runPreflight();
    const flat = JSON.stringify(sets);
    const gate = sets[sets.length - 1][0];
    return flat.includes(P.monthlyPaid.lic) && flat.includes(pendingMonthlyIntent) && gate.gate === "FAIL" && Number(gate.invalid_fulfillable_intents) === 1 ? true : JSON.stringify(gate);
  });
  const offersBeforeGate = await snapOffers();
  await check("the migration REFUSES to apply while the open monthly intent exists (PT422 INVALID_OPEN_CHECKOUT_INTENTS) and changes nothing", async () => {
    let err = null;
    try { await admin.query(fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8")); } catch (e) { err = e; }
    const triggers = (await admin.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'trg_commercial_annual_term_%'")).rows[0].n;
    const offersSame = JSON.stringify(await snapOffers()) === JSON.stringify(offersBeforeGate);
    return isPT422(err, "INVALID_OPEN_CHECKOUT_INTENTS") && triggers === 0 && offersSame ? true : { code: err?.code, msg: err?.message, triggers, offersSame };
  });
  await check("the operator resolves it through the existing failure path (provider reported not paid): no licence, intent CANCELLED", async () => {
    const r = await commit(pendingMonthlyIntent, 4900, "CANCELLED");
    const st = (await admin.query("SELECT status FROM public.payment_checkout_intents WHERE id=$1", [pendingMonthlyIntent])).rows[0].status;
    const lic = (await admin.query("SELECT count(*)::int n FROM public.commercial_licences WHERE billing_customer_id=$1", [pending.bc])).rows[0].n;
    return r.committed === false && st === "CANCELLED" && lic === 0 ? true : { r, st, lic };
  });
  await check("the preflight now reads GATE = PASS: no invalid fulfillable intent, no unreconciled provider checkout", async () => {
    const sets = await runPreflight();
    const gate = sets[sets.length - 1][0];
    return gate.gate === "PASS" && Number(gate.invalid_fulfillable_intents) === 0 && Number(gate.unreconciled_provider_checkouts) === 0 ? true : JSON.stringify(gate);
  });

  // ── Reconciliation: the exact authoritative predicate, enforced by the migration itself ──────────────────────────
  group("Reconciliation · Section B empty, Section C decides — enforced by the migration, not only the preflight");
  const evidenceEvent = (intentId, { normalized, method = "MANUAL_ADMIN", payloadHash = "e".repeat(64), txId = `tx-${uuid()}` }) =>
    admin.query(`INSERT INTO public.payment_events (billing_customer_id, provider, external_event_id, idempotency_key, event_type, amount, currency,
        amount_minor, provider_transaction_id, provider_status, normalized_status, saff_reference, payload_hash, verified_at, verification_method,
        checkout_intent_id, commercial_offer_id, plan_id, event_time, metadata)
      SELECT i.billing_customer_id, 'STRIPE', $2, $3, CASE WHEN $4 = 'REFUNDED' THEN 'REFUND' ELSE 'CANCELLATION' END, i.expected_amount_minor / 100.0,
             i.currency_code, i.expected_amount_minor, $2, lower($4), $4, i.saff_reference, $5, now(), $6, i.id, i.commercial_offer_id, i.plan_id, now(),
             '{"reviewed_decision":true}'::jsonb
        FROM public.payment_checkout_intents i WHERE i.id = $1`, [intentId, txId, `idem-${uuid()}`, normalized, payloadHash, method]);
  const providerBacked = async (label) => {
    const a = await account(`recon-${label}`, null);
    return intent(a, "CFOCLOSE_SOLO_GLOBAL_USD_MONTHLY", { provider_checkout_ref: `prov-${uuid()}` });
  };
  const migrationOutcome = async () => { try { await admin.query(migrationText); return null; } catch (e) { return e; } };
  const NON_FINAL = [
    ["no event at all (locally expired)", async (id) => { await admin.query("UPDATE public.payment_checkout_intents SET status='EXPIRED' WHERE id=$1", [id]); }],
    ["a WEBHOOK_ONLY cancellation", (id) => commitAs(id, "CANCELLED", "WEBHOOK_ONLY")],
    ["a provider-verified FAILED attempt (transient)", (id) => commitAs(id, "FAILED")],
    ["a provider-verified UNKNOWN outcome", (id) => commitAs(id, "UNKNOWN")],
    ["a provider-verified PARTIALLY_REFUNDED outcome", (id) => commitAs(id, "PARTIALLY_REFUNDED")],
    ["a provider-verified PENDING (non-final) outcome", (id) => commitAs(id, "PENDING")],
    ["a MANUAL_ADMIN refund WITHOUT provider evidence (no payload hash)", async (id) => {
      await admin.query("UPDATE public.payment_checkout_intents SET status='FAILED' WHERE id=$1", [id]);
      await evidenceEvent(id, { normalized: "REFUNDED", payloadHash: null });
    }],
  ];
  for (const [label, setup] of NON_FINAL) {
    await check(`${label} does NOT reconcile: B empty, C non-empty → the migration refuses (PT422 UNRECONCILED_PROVIDER_CHECKOUTS), byte-identical`, async () => {
      const id = await providerBacked(label.slice(0, 12));
      await setup(id);
      const gate = (await runPreflight()).at(-1)[0];
      const before = await fingerprint();
      const err = await migrationOutcome();
      const after = await fingerprint();
      // Close the case the way an operator must: a reviewed decision recorded WITH the provider's evidence.
      await evidenceEvent(id, { normalized: "REFUNDED" });
      const ok = Number(gate.invalid_fulfillable_intents) === 0 && Number(gate.unreconciled_provider_checkouts) === 1 && gate.gate === "FAIL"
        && isPT422(err, "UNRECONCILED_PROVIDER_CHECKOUTS") && before === after;
      return ok ? true : { gate, code: err?.code, msg: err?.message, same: before === after };
    });
  }
  const FINAL = [
    ["a provider-verified CANCELLED outcome (unpaid, cancelled at the provider)", (id) => commitAs(id, "CANCELLED")],
    ["a provider-verified EXPIRED outcome (unpaid, expired at the provider)", (id) => commitAs(id, "EXPIRED")],
    ["a provider-verified REFUNDED outcome (paid, refunded — never fulfilled)", (id) => commitAs(id, "REFUNDED")],
    ["a MANUAL_ADMIN refund/void decision WITH the provider's evidence", async (id) => {
      await admin.query("UPDATE public.payment_checkout_intents SET status='CANCELLED' WHERE id=$1", [id]);
      await evidenceEvent(id, { normalized: "CANCELLED" });
    }],
  ];
  for (const [label, setup] of FINAL) {
    await check(`${label} reconciles: no licence created, the preflight gate stays PASS`, async () => {
      const id = await providerBacked(`f-${label.slice(0, 10)}`);
      await setup(id);
      const gate = (await runPreflight()).at(-1)[0];
      const licences = (await admin.query("SELECT count(*)::int n FROM public.payment_events WHERE checkout_intent_id=$1 AND licence_id IS NOT NULL", [id])).rows[0].n;
      return gate.gate === "PASS" && licences === 0 ? true : { gate, licences };
    });
  }

  const licBefore = await fullLic();
  const offersBefore = await snapOffers();
  group("Apply");
  await check(`${MIGRATION} applies once the gate is clear`, async () => { await applyMigration(MIGRATION); return true; });

  // ── Existing state ───────────────────────────────────────────────────────────────────────────────────────────────
  group("Existing licences and offers");
  await check("every licence that existed before is unchanged in EVERY column (no column was added)", async () =>
    JSON.stringify(await fullLic()) === JSON.stringify(licBefore) ? true : "a pre-existing licence changed");
  await check("no renewal state exists: no renewal_status column, no stop_commercial_renewal function", async () => {
    const col = (await admin.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='commercial_licences' AND column_name='renewal_status'")).rows[0].n;
    const fn = (await admin.query("SELECT count(*)::int n FROM pg_proc WHERE proname='stop_commercial_renewal'")).rows[0].n;
    return col === 0 && fn === 0 ? true : { col, fn };
  });
  await check("only the CFOCLOSE SOLO / PRACTICE / FIRM monthly offers changed, and only to retired; the other product's SOLO monthly offer is untouched", async () => {
    const before = new Map(offersBefore.map((r) => [r.offer_code, r.row]));
    const bad = [];
    for (const { offer_code, row } of await snapOffers()) {
      const was = before.get(offer_code);
      if (!/^CFOCLOSE_(SOLO|PRACTICE|FIRM)_.*_MONTHLY$/.test(offer_code)) { if (JSON.stringify(was) !== JSON.stringify(row)) bad.push(`changed: ${offer_code}`); continue; }
      if (row.is_active || row.is_purchasable || row.effective_end === null) bad.push(`not retired: ${offer_code}`);
      for (const k of ["amount_minor", "currency_code", "billing_interval", "billing_interval_count", "plan_id"]) if (was[k] !== row[k]) bad.push(`${offer_code}.${k}`);
    }
    return bad.length ? bad.join(" | ") : true;
  });
  await check("the existing monthly-paid licence is preserved: it can still end earlier (admin expiry) but can never be extended", async () => {
    const extend = await errOf(() => admin.query("UPDATE public.commercial_licences SET effective_end = effective_end + interval '11 months' WHERE id=$1", [P.monthlyPaid.lic]));
    const expire = await errOf(() => one(user(ADMIN), "SELECT public.admin_transition_licence_status($1,'EXPIRED','natural expiry test') r", [P.monthlyPaid.lic]));
    const after = (await admin.query("SELECT status FROM public.commercial_licences WHERE id=$1", [P.monthlyPaid.lic])).rows[0].status;
    return isPT422(extend, "INVALID_COMMERCIAL_TERM") && expire === null && after === "EXPIRED" ? true : { extend: extend?.message, expire: expire?.message, after };
  });

  // ── Checkout intents ─────────────────────────────────────────────────────────────────────────────────────────────
  group("Checkout intents · exactly ANNUAL × 1 for the CFOCLOSE self-serve plans");
  const fresh = await account("fresh", null);
  await check("a new MONTHLY intent for Solo, Practice or Firm is refused: PT422 ANNUAL_TERM_REQUIRED", async () => {
    const out = [];
    for (const o of ["CFOCLOSE_SOLO_GLOBAL_USD_MONTHLY", "CFOCLOSE_PRACTICE_GLOBAL_USD_MONTHLY", "CFOCLOSE_FIRM_GLOBAL_USD_MONTHLY"]) out.push(isPT422(await errOf(() => intent(fresh, o)), "ANNUAL_TERM_REQUIRED"));
    return out.every(Boolean) ? true : out.join(",");
  });
  await check("an ANNUAL intent with an interval count other than 1 is refused", async () =>
    isPT422(await errOf(() => intent(fresh, "CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL", { billing_interval_count: 2 })), "ANNUAL_TERM_REQUIRED"));
  const annualIntent = await intent(fresh, "CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL");
  await check("an annual intent changed to MONTHLY afterwards is refused, and so is a changed interval count", async () => {
    const a = await errOf(() => admin.query("UPDATE public.payment_checkout_intents SET billing_interval='MONTHLY' WHERE id=$1", [annualIntent]));
    const b = await errOf(() => admin.query("UPDATE public.payment_checkout_intents SET billing_interval_count=3 WHERE id=$1", [annualIntent]));
    return isPT422(a, "ANNUAL_TERM_REQUIRED") && isPT422(b, "ANNUAL_TERM_REQUIRED") ? true : { a: a?.message, b: b?.message };
  });
  await check("wrong product, same plan code: a MONTHLY intent on the other product's SOLO is allowed (outside the boundary)…", async () =>
    (await errOf(() => intent(fresh, "OTHERPROD_SOLO_GLOBAL_USD_MONTHLY", { product_id: other }))) === null);
  await check("…and moving that monthly intent onto a CFOCLOSE self-serve plan afterwards is refused (plan changed after insertion)", async () => {
    const mover = await account("intent-mover", null);   // one open intent per customer and product
    const id = await intent(mover, "OTHERPROD_SOLO_GLOBAL_USD_MONTHLY", { product_id: other });
    return isPT422(await errOf(() => admin.query("UPDATE public.payment_checkout_intents SET plan_id=$2 WHERE id=$1", [id, PLAN.SOLO])), "ANNUAL_TERM_REQUIRED");
  });
  await check("no open self-serve monthly intent can exist after the migration (none can be paid without a licence)", async () =>
    (await admin.query(`SELECT count(*)::int n FROM public.payment_checkout_intents i JOIN public.commercial_plans cp ON cp.id=i.plan_id
      JOIN public.commercial_products p ON p.id=cp.product_id WHERE p.code='CFOCLOSE' AND cp.code IN ('SOLO','PRACTICE','FIRM')
      AND i.billing_interval IS DISTINCT FROM 'ANNUAL' AND i.status IN ('CREATED','PENDING','MANUAL_REVIEW')`)).rows[0].n === 0);

  // ── Licences ─────────────────────────────────────────────────────────────────────────────────────────────────────
  group("Payment-created licences · the canonical 12-month term");
  const t0 = new Date(Date.UTC(2027, 0, 31, 12));        // month-end start: interval arithmetic is the database's own
  const plus = async (months) => (await admin.query(`SELECT $1::timestamptz + make_interval(months => $2) t`, [t0, months])).rows[0].t;
  for (const [label, end] of [["NULL effective_end (indefinite)", null], ["11 months", 11], ["13 months", 13], ["24 months (unauthorised multi-year)", 24]]) {
    await check(`${label} is refused: PT422 INVALID_COMMERCIAL_TERM`, async () => {
      const b = await account(`l-${label.slice(0, 4)}`, null);
      return isPT422(await errOf(async () => licenceInsert(b.bc, PLAN.SOLO, t0, end === null ? null : await plus(end))), "INVALID_COMMERCIAL_TERM");
    });
  }
  const b12 = await account("l-12", null);
  let lic12 = null;
  await check("exactly 12 months is accepted", async () => { lic12 = await licenceInsert(b12.bc, PLAN.SOLO, t0, await plus(12)); return !!lic12; });
  await check("INSERT-then-UPDATE: extending, nulling, re-planning, re-sourcing or moving the start of that licence is refused", async () => {
    const tries = [
      ["UPDATE public.commercial_licences SET effective_end = effective_end + interval '1 month' WHERE id=$1", [lic12]],
      ["UPDATE public.commercial_licences SET effective_end = NULL WHERE id=$1", [lic12]],
      ["UPDATE public.commercial_licences SET plan_id = $2 WHERE id=$1", [lic12, PLAN.FIRM]],
      ["UPDATE public.commercial_licences SET source = 'ADMIN_GRANT' WHERE id=$1", [lic12]],
      ["UPDATE public.commercial_licences SET effective_start = effective_start - interval '6 months' WHERE id=$1", [lic12]],
    ];
    const out = [];
    for (const [sql, params] of tries) out.push(isPT422(await errOf(() => admin.query(sql, params)), "INVALID_COMMERCIAL_TERM"));
    return out.every(Boolean) ? true : out.join(",");
  });
  await check("…while ending it earlier (expiry, suspension, the commit's own truncation) is allowed", async () =>
    (await errOf(() => admin.query("UPDATE public.commercial_licences SET effective_end = effective_end - interval '3 months' WHERE id=$1", [lic12]))) === null);
  await check("a non-payment licence cannot be turned into a payment-created self-serve licence by an UPDATE", async () => {
    const b = await account("l-admin", null);
    const id = await licenceInsert(b.bc, PLAN.SOLO, t0, await plus(1), "ADMIN_GRANT");
    return isPT422(await errOf(() => admin.query("UPDATE public.commercial_licences SET source='STRIPE_VERIFIED_PAYMENT' WHERE id=$1", [id])), "INVALID_COMMERCIAL_TERM");
  });
  await check("wrong product, same plan code: a one-month payment licence on the other product's SOLO is allowed, but moving it onto CFOCLOSE SOLO is refused", async () => {
    const b = await account("l-other", null);
    const id = await licenceInsert(b.bc, OTHER_SOLO, t0, await plus(1));
    return isPT422(await errOf(() => admin.query("UPDATE public.commercial_licences SET plan_id=$2 WHERE id=$1", [id, PLAN.SOLO])), "INVALID_COMMERCIAL_TERM") ? true : "move allowed";
  });
  await check("Enterprise stays contract-based: a payment licence of any period is not constrained", async () => {
    const b = await account("l-ent", null);
    return (await errOf(async () => licenceInsert(b.bc, PLAN.ENTERPRISE, t0, await plus(3)))) === null;
  });

  // ── The verified-payment path ────────────────────────────────────────────────────────────────────────────────────
  group("Verified payment path");
  const annual = await account("annual-buyer", null);
  const authz = async (who, co, cap = "REPORTING_PACK_EXPORT") => (await one(user(who), "SELECT public.authorize_paid_action($1,$2) r", [co, cap])).r;
  await check("an ANNUAL Practice payment commits into exactly one licence of exactly 12 months, which entitles", async () => {
    const r = await commit(await intent(annual, "CFOCLOSE_PRACTICE_GLOBAL_USD_ANNUAL"), 99000);
    const lic = (await admin.query("SELECT status, effective_end = effective_start + interval '12 months' AS exact FROM public.commercial_licences WHERE billing_customer_id=$1", [annual.bc])).rows;
    annual.co = (await q(user(annual.uid), "INSERT INTO public.companies (user_id,name) VALUES ($1,'Annual Co') RETURNING id", [annual.uid]))[0].id;
    const ok = (await authz(annual.uid, annual.co)).allowed === true;
    return r?.committed === true && lic.length === 1 && lic[0].status === "ACTIVE" && lic[0].exact === true && ok ? true : { r, lic, ok };
  });
  await check("an upgrade payment (Practice → Firm) still works: the current licence is ended early, the new one is exactly 12 months", async () => {
    const r = await commit(await intent(annual, "CFOCLOSE_FIRM_GLOBAL_USD_ANNUAL"), 299000);
    const rows = (await admin.query(`SELECT cp.code, l.effective_end <= now() + interval '1 minute' AS ended, l.effective_end = l.effective_start + interval '12 months' AS exact
      FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id=l.plan_id WHERE l.billing_customer_id=$1 ORDER BY l.created_at`, [annual.bc])).rows;
    return r?.committed === true && rows.length === 2 && rows[0].code === "PRACTICE" && rows[0].ended && rows[1].code === "FIRM" && rows[1].exact ? true : { r, rows };
  });

  // ── Access after suspension and expiry ───────────────────────────────────────────────────────────────────────────
  group("Suspension and expiry keep the archive readable");
  await check("SUSPENDED: a new privileged action is refused; the workspace is still read", async () =>
    (await authz(P.suspended.uid, P.suspended.co)).allowed === false && (await q(user(P.suspended.uid), "SELECT id FROM public.companies WHERE id=$1", [P.suspended.co])).length === 1);
  await check("EXPIRED: a new privileged action is refused; the workspace is still read", async () =>
    (await authz(P.expired.uid, P.expired.co)).allowed === false && (await q(user(P.expired.uid), "SELECT id FROM public.companies WHERE id=$1", [P.expired.co])).length === 1);

  // ── Client boundary, platform state, re-application ──────────────────────────────────────────────────────────────
  group("No client grant · checkout disabled · re-runnable");
  await check("an authenticated holder cannot insert, extend or reactivate a licence", async () => {
    const u = P.expired;
    await errOf(() => q(user(u.uid), "INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start) VALUES ($1,$2,'ACTIVE','ADMIN_GRANT',now())", [u.bc, PLAN.SOLO]));
    await errOf(() => q(user(u.uid), "UPDATE public.commercial_licences SET status='ACTIVE', effective_end = now() + interval '5 years' WHERE id=$1", [u.lic]));
    const row = (await admin.query("SELECT status FROM public.commercial_licences WHERE id=$1", [u.lic])).rows[0];
    const n = (await admin.query("SELECT count(*)::int n FROM public.commercial_licences WHERE billing_customer_id=$1", [u.bc])).rows[0].n;
    return row.status === "EXPIRED" && n === 1 ? true : { row, n };
  });
  await check("the guard functions are not callable by clients", async () =>
    (await errOf(() => q(user(P.expired.uid), "SELECT public.commercial_is_cfoclose_self_serve_plan($1)", [PLAN.SOLO]))) !== null);
  await check("self-serve checkout stays disabled: the platform payment state is unchanged by the migration and reads PAYMENTS_DISABLED", async () => {
    const now = await platformState();
    return now === platformBefore && now === "PAYMENTS_DISABLED" ? true : { platformBefore, now };
  });
  // ── admin_cancel_future_licence ──────────────────────────────────────────────────────────────────────────────────
  group("admin_cancel_future_licence · contract");
  const OUTSIDER = await mkUser("outsider");
  const REASON = "FUTURE_SANDBOX_MONTHLY_TERM_CANCELLED_BEFORE_ANNUAL_ONLY_ENFORCEMENT";
  const cancelAs = async (who, licId, key = uuid(), reason = REASON) => (await one(user(who), "SELECT public.admin_cancel_future_licence($1,$2,$3) r", [licId, reason, key])).r;
  const licRow = async (id) => (await admin.query("SELECT to_jsonb(l) - 'updated_at' AS row FROM public.commercial_licences l WHERE id=$1", [id])).rows[0]?.row;
  const auditCount = async (licId) => (await admin.query("SELECT count(*)::int n FROM public.billing_audit_events WHERE action='FUTURE_LICENCE_CANCELLED' AND new_state->>'licence_id'=$1", [licId])).rows[0].n;
  const otherTables = async () => {
    const tables = (await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
      AND table_name NOT IN ('commercial_licences','billing_audit_events') ORDER BY 1`)).rows.map((r) => r.table_name);
    const parts = [];
    for (const t of tables) parts.push(`${t}:${(await admin.query(`SELECT md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) h FROM public."${t}" x`)).rows[0].h}`);
    return parts.join("|");
  };
  const futureLicence = async (label, { status = "ACTIVE", startDays = 30, plan = PLAN.SOLO } = {}) => {
    const b = await account(`cf-${label}`, null);
    return licenceInsert(b.bc, plan, new Date(Date.now() + startDays * 86_400_000), new Date(Date.now() + (startDays + 30) * 86_400_000), "ADMIN_GRANT", status);
  };
  const summary = async (who) => (await one(user(who), "SELECT public.get_my_billing_summary() r")).r;

  await check("the stacked fixture is the production shape: a current annual licence and a future one-month licence starting at its end", async () =>
    stackedAnnual.status === "ACTIVE" && stackedAnnual.future === false && stackedFuture.status === "ACTIVE" && stackedFuture.future === true
      && +stackedFuture.effective_start === +stackedAnnual.effective_end ? true : { stackedAnnual, stackedFuture });
  await check("before cancellation the future licence is inventoried in preflight Section A and is the account's scheduled next licence", async () => {
    const a = (await runPreflight())[0].map((r) => r.licence_id);
    const s = await summary(stacked.uid);
    return a.includes(stackedFuture.id) && s?.next_effective_start !== null && s?.next_effective_start !== undefined ? true : { a, s };
  });

  const annualBefore = await licRow(stackedAnnual.id);
  const futureBefore = await licRow(stackedFuture.id);
  const evidenceBefore = JSON.stringify((await admin.query("SELECT to_jsonb(i) AS i FROM public.payment_checkout_intents i WHERE id=$1", [stackedMonthlyIntent])).rows)
    + JSON.stringify((await admin.query("SELECT to_jsonb(e) AS e FROM public.payment_events e WHERE checkout_intent_id=$1 ORDER BY id", [stackedMonthlyIntent])).rows);
  const othersBefore = await otherTables();
  const KEY = uuid();
  let first;
  await check("valid future ACTIVE licence → cancelled; status CANCELLED and every other column (both dates included) byte-identical", async () => {
    first = await cancelAs(ADMIN, stackedFuture.id, KEY);
    const after = await licRow(stackedFuture.id);
    const sameExceptStatus = JSON.stringify({ ...after, status: futureBefore.status }) === JSON.stringify(futureBefore);
    return first.outcome === "cancelled" && first.replayed === false && after.status === "CANCELLED" && sameExceptStatus
      && after.effective_start === futureBefore.effective_start && after.effective_end === futureBefore.effective_end ? true : { first, after, futureBefore };
  });
  await check("one immutable audit event: account, actor, licence, previous → new status, dates, reason, idempotency key, timestamp", async () => {
    const e = (await admin.query("SELECT * FROM public.billing_audit_events WHERE action='FUTURE_LICENCE_CANCELLED' AND correlation_id=$1", [KEY])).rows;
    const ev = e[0];
    const ok = e.length === 1 && ev.id === first.audit_event_id && ev.billing_customer_id === stacked.bc && ev.actor_user_id === ADMIN && ev.reason === REASON
      && ev.previous_state.status === "ACTIVE" && ev.new_state.status === "CANCELLED" && ev.new_state.licence_id === stackedFuture.id
      && ev.new_state.account_id === stacked.bc && ev.created_at instanceof Date;
    const immutable = (await errOf(() => admin.query("UPDATE public.billing_audit_events SET reason='x' WHERE id=$1", [ev.id]))) !== null
      && (await errOf(() => admin.query("DELETE FROM public.billing_audit_events WHERE id=$1", [ev.id]))) !== null;
    return ok && immutable ? true : { e, immutable };
  });
  await check("idempotent: the same key returns the original result and writes no second audit event; a new key reads already_cancelled", async () => {
    const replay = await cancelAs(ADMIN, stackedFuture.id, KEY);
    const again = await cancelAs(ADMIN, stackedFuture.id, uuid());
    return replay.outcome === "cancelled" && replay.replayed === true && replay.audit_event_id === first.audit_event_id
      && again.outcome === "already_cancelled" && (await auditCount(stackedFuture.id)) === 1 ? true : { replay, again };
  });
  await check("evidence untouched: the checkout intent and its payment events (transaction reference, evidence hash) are byte-identical", async () => {
    const now = JSON.stringify((await admin.query("SELECT to_jsonb(i) AS i FROM public.payment_checkout_intents i WHERE id=$1", [stackedMonthlyIntent])).rows)
      + JSON.stringify((await admin.query("SELECT to_jsonb(e) AS e FROM public.payment_events e WHERE checkout_intent_id=$1 ORDER BY id", [stackedMonthlyIntent])).rows);
    return now === evidenceBefore ? true : "evidence changed";
  });
  await check("the current annual licence is byte-identical and still entitles; no company, upload, statement, certification, engine-run or other row changed", async () => {
    const annualNow = await licRow(stackedAnnual.id);
    const entitled = (await authz(stacked.uid, stackedCo)).allowed === true;
    const others = (await otherTables()) === othersBefore;
    return JSON.stringify(annualNow) === JSON.stringify(annualBefore) && entitled && others ? true : { entitled, others };
  });
  await check("the entitlement resolver never treats it as effective: no longer the scheduled next licence; preflight A no longer lists it; gate PASS", async () => {
    const s = await summary(stacked.uid);
    const sets = await runPreflight();
    const a = sets[0].map((r) => r.licence_id);
    return (s?.next_effective_start ?? null) === null && !a.includes(stackedFuture.id) && sets.at(-1)[0].gate === "PASS" ? true : { s, a, gate: sets.at(-1)[0] };
  });
  await check("irreversible: return to ACTIVE, extension, re-plan, re-source and re-dating are refused (PT422 CANCELLED_LICENCE_IMMUTABLE), by admin RPC or direct write", async () => {
    const tries = [
      () => one(user(ADMIN), "SELECT public.admin_transition_licence_status($1,'ACTIVE','reactivate') r", [stackedFuture.id]),
      () => admin.query("UPDATE public.commercial_licences SET status='ACTIVE' WHERE id=$1", [stackedFuture.id]),
      () => admin.query("UPDATE public.commercial_licences SET effective_end = effective_end + interval '1 year' WHERE id=$1", [stackedFuture.id]),
      () => admin.query("UPDATE public.commercial_licences SET plan_id=$2 WHERE id=$1", [stackedFuture.id, PLAN.FIRM]),
      () => admin.query("UPDATE public.commercial_licences SET source='ADMIN_GRANT' WHERE id=$1", [stackedFuture.id]),
      () => admin.query("UPDATE public.commercial_licences SET effective_start = effective_start - interval '1 day' WHERE id=$1", [stackedFuture.id]),
    ];
    const out = [];
    // On this payment-created licence the term guard may answer first (INVALID_COMMERCIAL_TERM); either is a PT422 refusal.
    for (const t of tries) { const e = await errOf(t); out.push(e?.code === "PT422" && /CANCELLED_LICENCE_IMMUTABLE|INVALID_COMMERCIAL_TERM/.test(e.message)); }
    const row = await licRow(stackedFuture.id);
    return out.every(Boolean) && row.status === "CANCELLED" && row.effective_end === futureBefore.effective_end ? true : out.join(",");
  });

  group("admin_cancel_future_licence · refusals (controlled outcomes, no SQL details)");
  const startedLic = await futureLicence("started", { startDays: -5 });
  const cases = [
    ["a currently effective licence", startedLic, "not_future"],
    ["a future SUSPENDED licence", await futureLicence("susp", { status: "SUSPENDED" }), "invalid_state"],
    ["a future EXPIRED licence", await futureLicence("exp", { status: "EXPIRED" }), "invalid_state"],
    ["a licence of another product (same plan code)", await futureLicence("other", { plan: OTHER_SOLO }), "invalid_state"],
  ];
  for (const [label, id, expected] of cases) {
    await check(`${label} → ${expected}; nothing changes`, async () => {
      const before = await licRow(id);
      const r = await cancelAs(ADMIN, id);
      return r.outcome === expected && Object.keys(r).length <= 2 && JSON.stringify(await licRow(id)) === JSON.stringify(before) && (await auditCount(id)) === 0 ? true : r;
    });
  }
  const pendingFuture = await futureLicence("pending", { status: "PENDING" });
  await check("a future PENDING licence → cancelled", async () => (await cancelAs(ADMIN, pendingFuture)).outcome === "cancelled");
  await check("irreversible on its own: on a non-payment licence (no term guard) every resurrection is refused by CANCELLED_LICENCE_IMMUTABLE", async () => {
    const tries = [
      () => one(user(ADMIN), "SELECT public.admin_transition_licence_status($1,'ACTIVE','reactivate') r", [pendingFuture]),
      () => admin.query("UPDATE public.commercial_licences SET status='PENDING' WHERE id=$1", [pendingFuture]),
      () => admin.query("UPDATE public.commercial_licences SET effective_end = effective_end + interval '1 year' WHERE id=$1", [pendingFuture]),
      () => admin.query("UPDATE public.commercial_licences SET plan_id=$2 WHERE id=$1", [pendingFuture, PLAN.FIRM]),
      () => admin.query("UPDATE public.commercial_licences SET source='ADMIN_REGRANT' WHERE id=$1", [pendingFuture]),
      () => admin.query("UPDATE public.commercial_licences SET additional_seats = 5 WHERE id=$1", [pendingFuture]),
    ];
    const out = [];
    for (const t of tries) { const e = await errOf(t); out.push(e?.code === "PT422" && /CANCELLED_LICENCE_IMMUTABLE/.test(e.message)); }
    return out.every(Boolean) && (await licRow(pendingFuture)).status === "CANCELLED" ? true : out.join(",");
  });
  await check("an uncontrolled reason or missing key → invalid_request", async () => {
    const id = await futureLicence("reason");
    const a = await cancelAs(ADMIN, id, uuid(), "free text reason");
    const b = (await one(user(ADMIN), "SELECT public.admin_cancel_future_licence($1,$2,NULL) r", [id, REASON])).r;
    return a.outcome === "invalid_request" && b.outcome === "invalid_request" && (await auditCount(id)) === 0 ? true : { a, b };
  });
  await check("outsider → forbidden; a missing ID is indistinguishable (identical answer for outsider and admin)", async () => {
    const realId = await futureLicence("victim");
    const a = await cancelAs(OUTSIDER, realId);
    const b = await cancelAs(OUTSIDER, uuid());
    const c = await cancelAs(ADMIN, uuid());
    const same = [a, b, c].every((r) => JSON.stringify(r) === JSON.stringify({ outcome: "forbidden" }));
    return same && (await licRow(realId)).status === "ACTIVE" ? true : { a, b, c };
  });
  await check("client roles cannot execute it: anon and service_role are refused by privilege", async () => {
    const anon = await errOf(() => q(ANON, "SELECT public.admin_cancel_future_licence($1,$2,$3)", [uuid(), REASON, uuid()]));
    const svc = await errOf(() => asCaller({ kind: "service" }, (c) => c.query("SELECT public.admin_cancel_future_licence($1,$2,$3)", [uuid(), REASON, uuid()])));
    const grants = (await admin.query(`SELECT grantee FROM information_schema.routine_privileges WHERE routine_schema='public'
      AND routine_name='admin_cancel_future_licence' AND privilege_type='EXECUTE' ORDER BY 1`)).rows.map((r) => r.grantee);
    return anon?.code === "42501" && svc?.code === "42501" && !grants.includes("PUBLIC") && !grants.includes("anon") && !grants.includes("service_role") ? true : { anon: anon?.code, svc: svc?.code, grants };
  });

  group("admin_cancel_future_licence · concurrency, boundary and rollback");
  const session = async (who) => {
    const c = await pool.connect();
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [who]);
    return c;
  };
  const call = (c, id, key) => c.query("SELECT public.admin_cancel_future_licence($1,$2,$3) r", [id, REASON, key]).then((r) => r.rows[0].r);
  await check("two simultaneous cancellations (different keys): one transition, one audit event; the other reads already_cancelled", async () => {
    const id = await futureLicence("race-2");
    const c1 = await session(ADMIN), c2 = await session(ADMIN);
    try {
      const r1 = await call(c1, id, uuid());
      const p2 = call(c2, id, uuid());                 // blocks on the row lock
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("COMMIT");
      const r2 = await p2; await c2.query("COMMIT");
      return r1.outcome === "cancelled" && r2.outcome === "already_cancelled" && (await auditCount(id)) === 1 ? true : { r1, r2 };
    } finally { c1.release(); c2.release(); }
  });
  await check("two simultaneous cancellations with the SAME key: one audit event; the second returns the original result", async () => {
    const id = await futureLicence("race-same");
    const key = uuid();
    const c1 = await session(ADMIN), c2 = await session(ADMIN);
    try {
      const r1 = await call(c1, id, key);
      const p2 = call(c2, id, key);
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("COMMIT");
      const r2 = await p2; await c2.query("COMMIT");
      return r1.outcome === "cancelled" && r2.outcome === "cancelled" && r2.replayed === true && r2.audit_event_id === r1.audit_event_id && (await auditCount(id)) === 1 ? true : { r1, r2 };
    } finally { c1.release(); c2.release(); }
  });
  await check("cancellation racing a re-activation / re-plan: the blocked write is refused after the cancellation commits — no resurrection", async () => {
    const id = await futureLicence("race-replan");
    const c1 = await session(ADMIN);
    const c2 = await pool.connect();
    try {
      const r1 = await call(c1, id, uuid());
      const p2 = errOf(() => c2.query("UPDATE public.commercial_licences SET status='ACTIVE', plan_id=$2, effective_end = effective_end + interval '1 year' WHERE id=$1", [id, PLAN.FIRM]));
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("COMMIT");
      const e2 = await p2;
      const row = await licRow(id);
      return r1.outcome === "cancelled" && e2?.code === "PT422" && row.status === "CANCELLED" && row.plan_id === PLAN.SOLO ? true : { r1, e2: e2?.message, row };
    } finally { c1.release(); c2.release(); }
  });
  await check("cancellation racing another admin transition: the first lock holder wins deterministically (both orders)", async () => {
    // Order 1: the cancellation holds the lock; the SUSPEND transition then fails (immutable).
    const a = await futureLicence("race-adm-1");
    const c1 = await session(ADMIN), c2 = await session(ADMIN);
    let o1;
    try {
      const r1 = await call(c1, a, uuid());
      const p2 = errOf(() => c2.query("SELECT public.admin_transition_licence_status($1,'SUSPENDED','race') r", [a]));
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("COMMIT");
      const e2 = await p2; try { await c2.query("ROLLBACK"); } catch { /* aborted */ }
      o1 = r1.outcome === "cancelled" && /CANCELLED_LICENCE_IMMUTABLE/.test(e2?.message ?? "") && (await licRow(a)).status === "CANCELLED";
    } finally { c1.release(); c2.release(); }
    // Order 2: the SUSPEND transition holds the lock; the cancellation then reads invalid_state.
    const b = await futureLicence("race-adm-2");
    const d1 = await session(ADMIN), d2 = await session(ADMIN);
    let o2;
    try {
      await d1.query("SELECT public.admin_transition_licence_status($1,'SUSPENDED','race') r", [b]);
      const p2 = call(d2, b, uuid());
      await new Promise((r) => setTimeout(r, 300));
      await d1.query("COMMIT");
      const r2 = await p2; await d2.query("COMMIT");
      o2 = r2.outcome === "invalid_state" && (await licRow(b)).status === "SUSPENDED" && (await auditCount(b)) === 0;
    } finally { d1.release(); d2.release(); }
    return o1 && o2 ? true : { o1, o2 };
  });
  await check("start boundary: a licence starting exactly at the transaction timestamp (and one already started) → not_future", async () => {
    const b = await account("boundary", null);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const id = (await c.query(`INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end)
        VALUES ($1,$2,'ACTIVE','ADMIN_GRANT',transaction_timestamp(), transaction_timestamp() + interval '1 month') RETURNING id`, [b.bc, PLAN.SOLO])).rows[0].id;
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [ADMIN]);
      const r = await call(c, id, uuid());
      await c.query("ROLLBACK");
      return r.outcome === "not_future" ? true : r;
    } finally { c.release(); }
  });
  await check("rollback: a cancellation inside a rolled-back transaction leaves the licence, the audit log and every other row unchanged", async () => {
    const id = await futureLicence("rollback");
    const before = await licRow(id);
    const othersPre = await otherTables();
    const c = await session(ADMIN);
    try {
      const r = await call(c, id, uuid());
      await c.query("ROLLBACK");
      return r.outcome === "cancelled" && JSON.stringify(await licRow(id)) === JSON.stringify(before) && (await auditCount(id)) === 0 && (await otherTables()) === othersPre ? true : r;
    } finally { c.release(); }
  });

  group("admin_cancel_future_licence · the idempotency key is bound to the whole request (licence, reason, actor)");
  const ADMIN2 = await mkUser("admin2");
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [ADMIN2]);
  const ledger = async () => (await admin.query(`SELECT md5(coalesce((SELECT string_agg(to_jsonb(l)::text, '|' ORDER BY l.id) FROM public.commercial_licences l), '')
      || coalesce((SELECT string_agg(to_jsonb(e)::text, '|' ORDER BY e.id) FROM public.billing_audit_events e), '')) h`)).rows[0].h;
  const REASON_B = "SECOND_CONTROLLED_REASON";
  const bLic = await futureLicence("bind-a");
  const bOther = await futureLicence("bind-b");
  const BKEY = uuid();
  const original = await cancelAs(ADMIN, bLic, BKEY, REASON);
  await check("1. same key + same licence + same reason + same actor → the original result; no second audit event", async () => {
    const r = await cancelAs(ADMIN, bLic, BKEY, REASON);
    return original.outcome === "cancelled" && r.outcome === "cancelled" && r.replayed === true && r.audit_event_id === original.audit_event_id
      && (await auditCount(bLic)) === 1 ? true : { original, r };
  });
  const conflictCase = async (label, fn) => check(label, async () => {
    const before = await ledger();
    const r = await fn();
    const after = await ledger();
    return JSON.stringify(r) === JSON.stringify({ outcome: "idempotency_conflict" }) && before === after ? true : { r, same: before === after };
  });
  await conflictCase("2. same key + a DIFFERENT licence → idempotency_conflict; licences and audit events byte-identical (the other licence stays ACTIVE)",
    async () => { const r = await cancelAs(ADMIN, bOther, BKEY, REASON); return (await licRow(bOther)).status === "ACTIVE" ? r : { r, status: "changed" }; });
  await conflictCase("3. same key + same licence + a DIFFERENT reason → idempotency_conflict; byte-identical",
    () => cancelAs(ADMIN, bLic, BKEY, REASON_B));
  await conflictCase("3b. same key + same licence + same reason from a DIFFERENT commercial admin → idempotency_conflict; byte-identical",
    () => cancelAs(ADMIN2, bLic, BKEY, REASON));
  await check("4. an unauthorised caller reusing a valid key → exactly {outcome: forbidden}: no original result, no audit id; byte-identical", async () => {
    const before = await ledger();
    const r = await cancelAs(OUTSIDER, bLic, BKEY, REASON);
    return JSON.stringify(r) === JSON.stringify({ outcome: "forbidden" }) && (await ledger()) === before ? true : r;
  });
  await check("5a. concurrent same key, two DIFFERENT licences: exactly one accepted, the other idempotency_conflict; one audit event; the loser untouched", async () => {
    const x = await futureLicence("cc-x"), y = await futureLicence("cc-y");
    const key = uuid();
    const c1 = await session(ADMIN), c2 = await session(ADMIN);
    try {
      const r1 = await call(c1, x, key);
      const p2 = call(c2, y, key);                      // blocks on the key's unique index until c1 resolves
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("COMMIT");
      const r2 = await p2; await c2.query("COMMIT");
      const events = (await admin.query("SELECT count(*)::int n FROM public.billing_audit_events WHERE action='FUTURE_LICENCE_CANCELLED' AND correlation_id=$1", [key])).rows[0].n;
      return r1.outcome === "cancelled" && r2.outcome === "idempotency_conflict" && events === 1 && (await licRow(y)).status === "ACTIVE" ? true : { r1, r2, events };
    } finally { c1.release(); c2.release(); }
  });
  await check("5b. concurrent same key, same licence, DIFFERENT reasons: exactly one accepted, the other idempotency_conflict; one audit event", async () => {
    const z = await futureLicence("cc-z");
    const key = uuid();
    const c1 = await session(ADMIN), c2 = await session(ADMIN);
    try {
      const r1 = (await c1.query("SELECT public.admin_cancel_future_licence($1,$2,$3) r", [z, REASON, key])).rows[0].r;
      const p2 = c2.query("SELECT public.admin_cancel_future_licence($1,$2,$3) r", [z, REASON_B, key]).then((r) => r.rows[0].r);
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("COMMIT");
      const r2 = await p2; await c2.query("COMMIT");
      const ev = (await admin.query("SELECT reason FROM public.billing_audit_events WHERE action='FUTURE_LICENCE_CANCELLED' AND correlation_id=$1", [key])).rows;
      return r1.outcome === "cancelled" && r2.outcome === "idempotency_conflict" && ev.length === 1 && ev[0].reason === REASON ? true : { r1, r2, ev };
    } finally { c1.release(); c2.release(); }
  });

  // ── Backstop: a paid invalid checkout never creates a licence ────────────────────────────────────────────────────
  group("Backstop · a paid MONTHLY × 1 or ANNUAL × 2 checkout never creates a licence");
  for (const shape of SHAPES) {
    await check(`paid ${shape.label}: even forced past the intent guard, the verified-payment commit creates no licence and writes nothing (licences, intents, events byte-identical)`, async () => {
      const a = await account(`paid-${shape.label.slice(0, 7)}`, null);
      // Simulate an invalid intent that slipped past the intent guard (e.g. hand-inserted): the licence guard is the backstop.
      await admin.query("ALTER TABLE public.payment_checkout_intents DISABLE TRIGGER trg_commercial_annual_term_intent_guard");
      let id;
      try { id = await intent(a, shape.offer, shape.over); } finally {
        await admin.query("ALTER TABLE public.payment_checkout_intents ENABLE TRIGGER trg_commercial_annual_term_intent_guard");
      }
      const amount = (await admin.query("SELECT expected_amount_minor a FROM public.payment_checkout_intents WHERE id=$1", [id])).rows[0].a;
      const before = await fingerprint();
      const err = await errOf(() => commit(id, Number(amount)));
      const after = await fingerprint();
      const lic = (await admin.query("SELECT count(*)::int n FROM public.commercial_licences WHERE billing_customer_id=$1", [a.bc])).rows[0].n;
      await admin.query("DELETE FROM public.payment_checkout_intents WHERE id=$1", [id]);   // fixture cleanup (no event was written)
      return isPT422(err, "INVALID_COMMERCIAL_TERM") && before === after && lic === 0 ? true : { code: err?.code, msg: err?.message, same: before === after, lic };
    });
  }

  await check("applying the migration a second time changes nothing", async () => {
    const lic = await fullLic(); const off = await snapOffers();
    await applyMigration(MIGRATION);
    return JSON.stringify(await fullLic()) === JSON.stringify(lic) && JSON.stringify(await snapOffers()) === JSON.stringify(off) ? true : "changed on re-application";
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`FATAL: ${e?.message ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
