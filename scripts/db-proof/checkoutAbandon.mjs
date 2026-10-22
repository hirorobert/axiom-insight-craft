#!/usr/bin/env node
// Real-PostgreSQL proof for 20261119100000_customer_checkout_abandon.sql (abandon_unpaid_checkout). Embedded PostgreSQL by
// default (DB_PROOF_MODULES_DIR as for the other proofs); DB_PROOF_MODE=external in CI.
//
//   Before       without the migration, an unpaid PENDING checkout blocks every new attempt (OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT)
//                and nothing lets the customer out
//   Authority    service role only (anon/authenticated: 42501); only the intent's owner; only a PENDING intent with no
//                confirmed payment; audited exactly once; a second abandon is idempotent and writes nothing
//   Unblocked    after an abandon, a new attempt — another plan or the same one — is acquired
//   Late payment a payment on the abandoned session is never lost: placed by the normal rule when nothing replaced it, one
//                recovery case (PAYMENT_AFTER_REPLACEMENT_STARTED) when a newer attempt exists
//   Both paid    abandoning leaves the provider session payable (a commercial-policy change): when the old and the replacement
//                sessions are both paid, exactly one term is granted and the extra charge is one OPEN recovery case
//   Review       an uncertain MANUAL_REVIEW attempt is never abandoned by the customer; it closes only on the provider's own
//                final answer (expired → closed, paid → placed); a genuine review case (a payment awaiting placement) is kept
//   Race         12 concurrent abandons: exactly one transition and one audit row; an abandon racing a verified payment: the
//                charge is always placed, never lost
// Mock and local only: no provider is contacted and no money moves. (Whether the session is unpaid is the Edge Function's
// provider check; this proof covers the database authority.)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
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

let pool, admin, embeddedServer = null, embeddedDir = null;
function assertLocal(u) {
  const url = new URL(u);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`REFUSED: ${url.hostname} is not loopback`);
  if (u.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project reference");
}
async function startDatabase() {
  if (MODE === "external") { assertLocal(process.env.DB_PROOF_CONN); return process.env.DB_PROOF_CONN; }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-checkout-abandon-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE checkout_abandon_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/checkout_abandon_proof`;
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
    const role = caller.kind === "anon" ? "anon" : caller.kind === "service" ? "service_role" : "authenticated";
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, caller.uid ?? ""]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally { c.release(); }
}
const user = (uid) => ({ kind: "user", uid });
const SERVICE = { kind: "service" };
const ANON = { kind: "anon" };
const one = async (caller, sql, params) => (await asCaller(caller, async (c) => (await c.query(sql, params)).rows))[0];
const uuid = () => globalThis.crypto.randomUUID();
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const MIGRATION = "20261119100000_customer_checkout_abandon.sql";

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: 20 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);
  group("Migration chain");
  await check(`every migration before ${MIGRATION} applies`, async () => { if (cut < 0) return "missing"; for (const f of files.slice(0, cut)) await applyMigration(f); return true; });

  const mkUser = async (label) => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id.slice(0, 8)}@example.test`]); return id; };
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const PLAN = Object.fromEntries((await admin.query("SELECT code, id FROM public.commercial_plans WHERE product_id=$1", [product])).rows.map((r) => [r.code, r.id]));
  await admin.query("UPDATE public.commercial_offers SET is_purchasable = true WHERE offer_code LIKE 'CFOCLOSE_%_GLOBAL_USD_ANNUAL'");
  const account = async (label) => { const uid = await mkUser(label); const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id; return { uid, bc }; };
  const setState = (s) => admin.query("UPDATE public.commercial_platform_state SET state=$1 WHERE id = true", [s]);
  const offer = async (plan) => (await admin.query("SELECT co.* FROM public.commercial_offers co JOIN public.commercial_plans cp ON cp.id=co.plan_id WHERE cp.code=$1 AND co.market_code='GLOBAL' AND co.billing_interval='ANNUAL' AND co.is_active ORDER BY co.created_at DESC LIMIT 1", [plan])).rows[0];
  const acquire = async (acct, plan, env = "production") => {
    await setState(env === "sandbox" ? "SANDBOX_ONLY" : "CUSTOMER_PAYMENTS_ENABLED");
    try {
      const o = await offer(plan);
      return (await one(SERVICE, `SELECT public.acquire_checkout_attempt($1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10::smallint,'POLAR',$11,$12,$13) r`,
        [acct.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, env, acct.uid, `SAFF-${uuid().slice(0, 12)}`])).r;
    } finally { await setState("PAYMENTS_DISABLED"); }
  };
  /** A Polar checkout session created for a new attempt: the intent is PENDING with the session id. */
  const checkout = async (acct, plan, env = "production") => {
    const a = await acquire(acct, plan, env);
    if (a.action !== "NEW_ATTEMPT") throw new Error(`acquire: ${JSON.stringify(a)}`);
    const session = uuid();
    await one(SERVICE, "SELECT public.begin_provider_checkout_request($1,$2) r", [a.intent_id, a.creation_token]);
    await one(SERVICE, "SELECT public.persist_checkout_provider_result($1,$2,$3,$4) r", [a.intent_id, a.creation_token, session, `https://polar.example.test/checkout/${session}`]);
    const o = await offer(plan);
    return { id: a.intent_id, ref: a.saff_reference, session, amount: Number(o.amount_minor), env };
  };
  /** What settle.ts sends after reading the provider: the canonical key is sha256(provider:transaction:intent). */
  const commit = (i, { tx = `order-${i.session}`, status = "SUCCEEDED", key = null } = {}) =>
    one(SERVICE, `SELECT public.commit_verified_commercial_payment($1,'POLAR',$2,$3,$4,$5,'USD',$6,now(),'PROVIDER_API_VERIFY',$7,$8,$9) r`,
      [i.id, tx, status === "SUCCEEDED" ? "paid" : status.toLowerCase(), status, i.amount, "h".repeat(64), key ?? crypto.createHash("sha256").update(`POLAR:${tx}:${i.id}`).digest("hex"), i.ref, i.env]).then((x) => x.r);
  const lic = async (acct) => (await admin.query("SELECT l.id, l.status FROM public.commercial_licences l WHERE l.billing_customer_id=$1", [acct.bc])).rows;
  const status = async (i) => (await admin.query("SELECT status FROM public.payment_checkout_intents WHERE id=$1", [i.id])).rows[0].status;
  const audits = async (i) => (await admin.query("SELECT * FROM public.billing_audit_events WHERE action='CHECKOUT_ABANDONED_BY_CUSTOMER' AND previous_state->>'checkout_intent_id' = $1::text", [i.id])).rows;
  const abandon = (i, actor, caller = SERVICE) => one(caller, "SELECT public.abandon_unpaid_checkout($1,$2) r", [i.id, actor]).then((x) => x.r);

  group("Before the correction · an unpaid checkout traps the customer");
  await check("an unpaid PENDING checkout blocks a new attempt for another plan (OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT), and no function lets the customer leave it", async () => {
    const a = await account("before");
    await checkout(a, "PRACTICE");
    const r = await acquire(a, "SOLO");
    const fn = (await admin.query("SELECT to_regprocedure('public.abandon_unpaid_checkout(uuid,uuid)') f")).rows[0].f;
    return r.action === "OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT" && fn === null ? true : { r, fn };
  });

  group("The migration");
  await check("it applies; a second application is refused (PREFLIGHT_REFUSED); every later migration applies", async () => {
    await applyMigration(MIGRATION);
    const e = await errOf(() => applyMigration(MIGRATION));
    for (const f of files.slice(cut + 1)) await applyMigration(f);
    return /already in force/.test(e?.message ?? "") ? true : e?.message ?? "applied twice";
  });

  group("Authority");
  await check("anon and authenticated cannot execute it (42501), not even the owner; nothing changes", async () => {
    const a = await account("roles");
    const i = await checkout(a, "SOLO");
    const e1 = await errOf(() => abandon(i, a.uid, ANON));
    const e2 = await errOf(() => abandon(i, a.uid, user(a.uid)));
    return e1?.code === "42501" && e2?.code === "42501" && (await status(i)) === "PENDING" && (await audits(i)).length === 0 ? true : { e1: e1?.message, e2: e2?.message };
  });
  await check("another customer cannot abandon it: NOT_FOUND_OR_NOT_OWNER (the same answer as an unknown intent); nothing changes", async () => {
    const a = await account("owner");
    const b = await account("other");
    const i = await checkout(a, "SOLO");
    const r = await abandon(i, b.uid);
    const unknown = await abandon({ id: uuid() }, a.uid);
    return r.abandoned === false && r.reason === "NOT_FOUND_OR_NOT_OWNER" && unknown.reason === "NOT_FOUND_OR_NOT_OWNER" && (await status(i)) === "PENDING" && (await audits(i)).length === 0 ? true : { r, unknown };
  });
  await check("the owner abandons an unpaid PENDING checkout: CANCELLED with cancel_reason CUSTOMER_ABANDONED_UNPAID, audited exactly once", async () => {
    const a = await account("abandon");
    const i = await checkout(a, "PRACTICE");
    const r = await abandon(i, a.uid);
    const row = (await admin.query("SELECT status, completed_at, metadata FROM public.payment_checkout_intents WHERE id=$1", [i.id])).rows[0];
    const au = await audits(i);
    return r.abandoned === true && r.already === false && row.status === "CANCELLED" && row.completed_at !== null && row.metadata.cancel_reason === "CUSTOMER_ABANDONED_UNPAID"
      && row.metadata.cancelled_by === a.uid && au.length === 1 && au[0].actor_user_id === a.uid && au[0].billing_customer_id === a.bc ? true : { r, row, au };
  });
  await check("a second abandon is idempotent: abandoned, already — no second audit row, nothing rewritten", async () => {
    const a = await account("again");
    const i = await checkout(a, "SOLO");
    await abandon(i, a.uid);
    const before = (await admin.query("SELECT metadata, completed_at FROM public.payment_checkout_intents WHERE id=$1", [i.id])).rows[0];
    const r = await abandon(i, a.uid);
    const after = (await admin.query("SELECT metadata, completed_at FROM public.payment_checkout_intents WHERE id=$1", [i.id])).rows[0];
    return r.abandoned === true && r.already === true && (await audits(i)).length === 1 && JSON.stringify(before) === JSON.stringify(after) ? true : { r };
  });
  await check("a paid intent (SUCCEEDED) is never abandoned: NOT_PENDING; its licence stands", async () => {
    const a = await account("paid");
    const i = await checkout(a, "SOLO");
    await commit(i);
    const r = await abandon(i, a.uid);
    return r.abandoned === false && r.reason === "NOT_PENDING" && (await status(i)) === "SUCCEEDED" && (await lic(a)).length === 1 && (await audits(i)).length === 0 ? true : r;
  });

  group("Unblocked · the customer chooses another plan");
  await check("after an abandon, a new attempt for ANOTHER plan is acquired (NEW_ATTEMPT), and so is one for the same plan", async () => {
    const a = await account("another");
    const i = await checkout(a, "PRACTICE");
    const blocked = await acquire(a, "SOLO");
    await abandon(i, a.uid);
    const r = await acquire(a, "SOLO");
    const b = await account("same");
    const j = await checkout(b, "PRACTICE");
    await abandon(j, b.uid);
    const r2 = await acquire(b, "PRACTICE");
    return blocked.action === "OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT" && r.action === "NEW_ATTEMPT" && r2.action === "NEW_ATTEMPT" ? true : { blocked, r, r2 };
  });

  group("Late payment · a payment on the abandoned session is never lost");
  await check("nothing replaced it: the payment is placed by the normal rule (one 12-month term), the intent becomes SUCCEEDED, marked late", async () => {
    const a = await account("late");
    const i = await checkout(a, "SOLO");
    await abandon(i, a.uid);
    const r = await commit(i);
    const ls = await lic(a);
    return r.status === "COMMITTED" && r.late_payment === true && ls.length === 1 && ls[0].status === "ACTIVE" && (await status(i)) === "SUCCEEDED" ? true : { r, ls };
  });
  await check("a newer attempt started: the old payment is recorded once as RECOVERY_REQUIRED (PAYMENT_AFTER_REPLACEMENT_STARTED) with an OPEN case; no automatic term", async () => {
    const a = await account("late-repl");
    const i = await checkout(a, "PRACTICE");
    await abandon(i, a.uid);
    const repl = await checkout(a, "SOLO");
    const r = await commit(i);
    const c = (await admin.query("SELECT status, newer_attempt_id FROM public.payment_recovery_cases WHERE checkout_intent_id=$1", [i.id])).rows;
    return r.status === "RECOVERY_REQUIRED" && r.reason === "PAYMENT_AFTER_REPLACEMENT_STARTED" && c.length === 1 && c[0].status === "OPEN" && c[0].newer_attempt_id === repl.id && (await lic(a)).length === 0 ? true : { r, c };
  });

  group("Both sessions paid · the commercial-policy consequence of leaving a checkout");
  await check("abandon, then a replacement, then BOTH are paid (replacement first): exactly one term (the replacement's), two recorded charges, one OPEN recovery case for the old one — no second entitlement, nothing lost", async () => {
    const a = await account("both-paid");
    const old = await checkout(a, "PRACTICE");
    await abandon(old, a.uid);
    const repl = await checkout(a, "SOLO");
    const r1 = await commit(repl);
    const r2 = await commit(old);
    const ls = await lic(a);
    const paid = (await admin.query("SELECT checkout_intent_id, licence_id FROM public.payment_events WHERE billing_customer_id=$1 AND event_type='PAYMENT_CONFIRMED'", [a.bc])).rows;
    const cases = (await admin.query("SELECT status, reason FROM public.payment_recovery_cases WHERE billing_customer_id=$1", [a.bc])).rows;
    return r1.status === "COMMITTED" && r2.status === "RECOVERY_REQUIRED" && ls.length === 1 && paid.length === 2
      && paid.find((p) => p.checkout_intent_id === old.id)?.licence_id === null && cases.length === 1 && cases[0].status === "OPEN"
      && cases[0].reason === "PAYMENT_AFTER_REPLACEMENT_STARTED" ? true : { r1, r2, ls, paid, cases };
  });
  await check("…in the other order (old first, then the replacement): one term, the old charge is the recovery case, the replacement places the term", async () => {
    const a = await account("both-paid-2");
    const old = await checkout(a, "PRACTICE");
    await abandon(old, a.uid);
    const repl = await checkout(a, "SOLO");
    const r1 = await commit(old);
    const r2 = await commit(repl);
    const ls = await lic(a);
    const cases = (await admin.query("SELECT count(*)::int n FROM public.payment_recovery_cases WHERE billing_customer_id=$1", [a.bc])).rows[0].n;
    return r1.status === "RECOVERY_REQUIRED" && r2.status === "COMMITTED" && ls.length === 1 && cases === 1 ? true : { r1, r2, ls, cases };
  });

  group("Review cases · recovered only on provider evidence, genuine ones preserved");
  const uncertain = async (acct, plan) => {
    const r = await acquire(acct, plan);
    if (r.action !== "NEW_ATTEMPT") throw new Error(`acquire: ${JSON.stringify(r)}`);
    await one(SERVICE, "SELECT public.begin_provider_checkout_request($1,$2) r", [r.intent_id, r.creation_token]);
    const u = (await one(SERVICE, "SELECT public.mark_checkout_attempt_uncertain($1,$2,'PROVIDER_RESULT_PERSISTENCE_UNCERTAIN') r", [r.intent_id, r.creation_token])).r;
    if (u?.updated !== true) throw new Error(`uncertain: ${JSON.stringify(u)}`);
    const o = await offer(plan);
    return { id: r.intent_id, ref: r.saff_reference, session: uuid(), amount: Number(o.amount_minor), env: "production" };
  };
  await check("an uncertain MANUAL_REVIEW attempt blocks new ones; the customer cannot abandon it (NOT_PENDING); once the provider reports the session EXPIRED it closes and a new attempt is acquired", async () => {
    const a = await account("review-uncertain");
    const i = await uncertain(a, "SOLO");
    const blocked = await acquire(a, "PRACTICE");
    const ab = await abandon(i, a.uid);
    const r = await commit(i, { status: "EXPIRED" });
    const after = await acquire(a, "PRACTICE");
    return blocked.action === "MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT" && ab.abandoned === false && ab.reason === "NOT_PENDING"
      && r.status === "NON_SUCCESS_RECORDED" && (await status(i)) === "EXPIRED" && after.action === "NEW_ATTEMPT" ? true : { blocked, ab, r, after };
  });
  await check("an uncertain review case the provider reports PAID is placed (never closed as unpaid)", async () => {
    const a = await account("review-paid");
    const i = await uncertain(a, "SOLO");
    const r = await commit(i);
    return r.status === "COMMITTED" && (await lic(a)).length === 1 ? true : r;
  });
  await check("a genuine review case — a payment awaiting placement — is preserved: never abandoned, a provider non-success cannot close it, and it keeps blocking", async () => {
    const a = await account("review-genuine");
    const i = await checkout(a, "SOLO");
    await commit(i);
    // Force the placement-review state the commit writes when a paid term cannot be placed by rule.
    await admin.query("ALTER TABLE public.payment_checkout_intents DISABLE TRIGGER USER");
    try {
      await admin.query("UPDATE public.payment_checkout_intents SET status='MANUAL_REVIEW', metadata = metadata || '{\"manual_review_reason\":\"PAID_LICENCE_PLACEMENT_REQUIRED\"}' WHERE id=$1", [i.id]);
    } finally { await admin.query("ALTER TABLE public.payment_checkout_intents ENABLE TRIGGER USER"); }
    const ab = await abandon(i, a.uid);
    const r = await commit(i, { status: "EXPIRED", tx: `order-expired-${i.session}` });
    const blocked = await acquire(a, "PRACTICE");
    return ab.abandoned === false && r.status === "INTENT_ALREADY_RESOLVED" && (await status(i)) === "MANUAL_REVIEW"
      && blocked.action === "MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT" && (await audits(i)).length === 0 ? true : { ab, r, blocked };
  });

  group("Race");
  await check("12 concurrent abandons of one checkout: exactly one transition and one audit row; every call answers abandoned", async () => {
    const a = await account("race");
    const i = await checkout(a, "SOLO");
    const rs = await Promise.allSettled(Array.from({ length: 12 }, () => abandon(i, a.uid)));
    const ok = rs.filter((x) => x.status === "fulfilled").map((x) => x.value);
    return ok.length === 12 && ok.filter((r) => r.already === false).length === 1 && ok.every((r) => r.abandoned === true) && (await audits(i)).length === 1 ? true : { rejected: rs.filter((x) => x.status === "rejected").map((x) => x.reason.message), ok };
  });
  await check("20 rounds of an abandon racing a verified payment: the charge is always placed, never lost; the abandon either came first (the payment is then placed late) or answers NOT_PENDING", async () => {
    const out = [];
    for (let k = 0; k < 20; k++) {
      const a = await account(`race-pay-${k}`);
      const i = await checkout(a, "SOLO");
      const [ab, cm] = await Promise.allSettled([abandon(i, a.uid), commit(i)]);
      const ls = await lic(a);
      const fine = ab.status === "fulfilled" && cm.status === "fulfilled" && cm.value.status === "COMMITTED" && ls.length === 1 && (await status(i)) === "SUCCEEDED"
        && ((ab.value.abandoned === true && cm.value.late_payment === true) || (ab.value.abandoned === false && ab.value.reason === "NOT_PENDING"));
      out.push(fine || { ab: ab.value ?? ab.reason?.message, cm: cm.value ?? cm.reason?.message, ls });
    }
    const bad = out.filter((x) => x !== true);
    return bad.length === 0 ? true : bad.slice(0, 3);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  FAILED  [${f.group}] ${f.name}`);
  return failed.length ? 1 : 0;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`FATAL: ${e?.stack ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
