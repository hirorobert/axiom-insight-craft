#!/usr/bin/env node
// Real-PostgreSQL proof for 20261229100000_checkout_terms_acceptance.sql (PR #266: the Terms version a purchase accepted is
// recorded on the checkout intent once, by the server, immutably). Embedded PostgreSQL by default (DB_PROOF_MODULES_DIR as for
// the other proofs); DB_PROOF_MODE=external in CI. TERMS_ACCEPTANCE_ABSENT=1 replays the chain WITHOUT the migration: exactly the
// "after" cases must fail (their failure is the defect: no acceptance can be recorded and nothing protects one).
//
//   Chain        every migration before the file applies; the file applies once; a replay is a no-op (idempotent)
//   One function exactly one acquire_checkout_attempt exists afterwards, with 16 arguments and two defaults (no overload: a
//                14-argument call resolves to it and is REFUSED - after this migration no intent exists without the acknowledgement)
//   No bypass    the 14-argument call (what the pre-release function sends), a missing consent or a NULL version: refused, nothing written
//   Recorded     the 16-argument call records terms_version, terms_accepted, terms_accepted_at (server clock), terms_accepted_by_user_id
//                (the authenticated purchaser) and immediate_service_consent, and nothing else changes on the row
//   Retry        a second acquisition for the same customer and plan returns the existing intent (REUSE/ALREADY/OPEN) and leaves
//                its acceptance exactly as recorded — even when the retry names a different version
//   Immutable    changing, removing or ADDING any acceptance key by UPDATE is refused (TERMS_ACCEPTANCE_IMMUTABLE), for
//                service_role too; a historical intent (no keys) cannot receive one retrospectively
//   Merges       every existing writer merges metadata with ||: manual-review / failed reasons and the provider's results land
//                beside the frozen acceptance (the function's own PRE_PROVIDER_LEASE_EXPIRED path included)
//   Authority    anon/authenticated cannot EXECUTE the function (42501); only service_role
//   Settlement   the settlement path (commit_verified_commercial_payment) completes a paid intent whose acceptance stays intact
// Mock and local only: no provider is contacted and no money moves.
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
const ABSENT = process.env.TERMS_ACCEPTANCE_ABSENT === "1";
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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-terms-acceptance-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE terms_acceptance_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/terms_acceptance_proof`;
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
const code = (e) => (e && (e.code ?? "")) + ":" + String(e?.message ?? "").split("\n")[0];

const MIGRATION = "20261229100000_checkout_terms_acceptance.sql";
const VERSION = "2026-11-13.proofversion0";
const OTHER_VERSION = "2026-12-01.otherversion00";

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: 12 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);
  group(ABSENT ? "Migration chain WITHOUT the migration (regression run)" : "Migration chain");
  await check(`every migration before ${MIGRATION} applies`, async () => { if (cut < 0) return "missing"; for (const f of files.slice(0, cut)) await applyMigration(f); return true; });
  await check(`${MIGRATION} is the last file of the chain (it follows the consolidated release tail)`, async () => files.at(-1) === MIGRATION ? true : files.slice(-3));
  if (!ABSENT) {
    await check(`${MIGRATION} applies`, async () => { await applyMigration(MIGRATION); return true; });
    await check("a replay of the migration is a no-op (idempotent)", async () => { await applyMigration(MIGRATION); return true; });
  }

  const nArgs = async () => (await admin.query("SELECT p.pronargs, p.pronargdefaults FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='acquire_checkout_attempt' ORDER BY 1")).rows;
  group("One function, no overload");
  await check("exactly one acquire_checkout_attempt exists, with 16 arguments and two defaults (the old signature is absent)", async () => {
    const r = await nArgs(); return r.length === 1 && Number(r[0].pronargs) === 16 && Number(r[0].pronargdefaults) === 2 ? true : r;
  });

  const mkUser = async (label) => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id.slice(0, 8)}@example.test`]); return id; };
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  await admin.query("UPDATE public.commercial_offers SET is_purchasable = true WHERE offer_code LIKE 'CFOCLOSE_%_GLOBAL_USD_ANNUAL'");
  const account = async (label) => { const uid = await mkUser(label); const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id; return { uid, bc }; };
  const setState = (s) => admin.query("UPDATE public.commercial_platform_state SET state=$1 WHERE id = true", [s]);
  const offer = async (plan) => (await admin.query("SELECT co.* FROM public.commercial_offers co JOIN public.commercial_plans cp ON cp.id=co.plan_id WHERE cp.code=$1 AND co.market_code='GLOBAL' AND co.currency_code='USD' AND co.billing_interval='ANNUAL'", [plan])).rows[0];
  const ARGS14 = "$1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10::smallint,'POLAR','production',$11,$12";
const ARGS16 = ARGS14 + ",$13,$14";
  const acquire14 = async (acct, plan, ref = `SAFF-${uuid().slice(0, 10)}`) => {
    await setState("CUSTOMER_PAYMENTS_ENABLED");
    try { const o = await offer(plan); return (await one(SERVICE, `SELECT public.acquire_checkout_attempt(${ARGS14}) r`, [acct.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, acct.uid, ref])).r; }
    finally { await setState("PAYMENTS_DISABLED"); }
  };
  const acquire15 = async (acct, plan, version, ref = `SAFF-${uuid().slice(0, 10)}`, consent = true) => {
    await setState("CUSTOMER_PAYMENTS_ENABLED");
    try { const o = await offer(plan); return (await one(SERVICE, `SELECT public.acquire_checkout_attempt(${ARGS16}) r`, [acct.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, acct.uid, ref, version, consent])).r; }
    finally { await setState("PAYMENTS_DISABLED"); }
  };
  const meta = async (id) => (await admin.query("SELECT metadata, status, created_at, expected_amount_minor, saff_reference FROM public.payment_checkout_intents WHERE id=$1", [id])).rows[0];
  const KEYS = ["terms_version", "terms_accepted", "terms_accepted_at", "terms_accepted_by_user_id", "immediate_service_consent"];

  group("No intent without the acknowledgement (a 14-argument caller - the pre-release function - is refused, nothing written)");
  const A = await account("old-caller");
  await check("a 14-argument acquisition is REFUSED with TERMS_ACCEPTANCE_REQUIRED and creates no intent", async () => {
    const e = await errOf(() => acquire14(A, "SOLO"));
    const n = await admin.query("SELECT count(*)::int n FROM public.payment_checkout_intents WHERE billing_customer_id=$1", [A.bc]);
    return e && /TERMS_ACCEPTANCE_REQUIRED/.test(e.message) && n.rows[0].n === 0 ? true : { e: code(e), n: n.rows[0].n };
  });
  await check("a version without the consent flag (false, or NULL) is refused the same way; nothing written", async () => {
    const e1 = await errOf(() => acquire15(A, "SOLO", VERSION, `SAFF-${uuid().slice(0, 10)}`, false));
    const e2 = await errOf(() => acquire15(A, "SOLO", VERSION, `SAFF-${uuid().slice(0, 10)}`, null));
    const n = await admin.query("SELECT count(*)::int n FROM public.payment_checkout_intents WHERE billing_customer_id=$1", [A.bc]);
    return e1 && e2 && /TERMS_ACCEPTANCE_REQUIRED/.test(e1.message) && /TERMS_ACCEPTANCE_REQUIRED/.test(e2.message) && n.rows[0].n === 0 ? true : { e1: code(e1), e2: code(e2), n: n.rows[0].n };
  });
  // A historical intent (created before this migration) for the immutability cases: inserted as the pre-release function would have.
  let a14;
  await check("a historical intent (inserted without the keys, as before the migration) carries NO acceptance key", async () => {
    const o = await offer("SOLO");
    a14 = (await admin.query("INSERT INTO public.payment_checkout_intents (billing_customer_id, commercial_offer_id, plan_id, product_id, market_code, expected_amount_minor, currency_code, currency_exponent, billing_interval, billing_interval_count, provider, provider_environment, saff_reference, status, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'POLAR','production',$11,'FAILED',$12) RETURNING id AS intent_id",
      [A.bc, o.id, o.plan_id, product, o.market_code, o.amount_minor, o.currency_code, o.currency_exponent, o.billing_interval, o.billing_interval_count, `SAFF-${uuid().slice(0, 10)}`, A.uid])).rows[0];
    const m = await meta(a14.intent_id); return KEYS.every((k) => !(k in m.metadata)) ? true : m.metadata;
  });

  group("Recorded acceptance (after)");
  const B = await account("accepting");
  let b15;
  await check("a 16-argument acquisition records terms_version, terms_accepted, terms_accepted_at, terms_accepted_by_user_id (the purchaser) and immediate_service_consent", async () => {
    b15 = await acquire15(B, "PRACTICE", VERSION);
    if (b15.action !== "NEW_ATTEMPT") return b15;
    const m = await meta(b15.intent_id);
    const at = m.metadata.terms_accepted_at && new Date(m.metadata.terms_accepted_at);
    return m.metadata.terms_version === VERSION && m.metadata.terms_accepted === true && m.metadata.immediate_service_consent === true && m.metadata.terms_accepted_by_user_id === B.uid && at && Math.abs(at - new Date(m.created_at)) < 5000 ? true : m.metadata;
  });
  await check("nothing else on the row changed shape: status CREATING, the expected amount, the reference, and exactly the five keys", async () => {
    const m = await meta(b15.intent_id); const o = await offer("PRACTICE");
    return m.status === "CREATING" && Number(m.expected_amount_minor) === Number(o.amount_minor) && m.saff_reference === b15.saff_reference && Object.keys(m.metadata).sort().join() === KEYS.slice().sort().join() ? true : m;
  });

  group("Retry and replay");
  await check("a second acquisition for the same customer and plan returns the existing intent and does not touch its acceptance, even with another version", async () => {
    const again = await acquire15(B, "PRACTICE", OTHER_VERSION);
    const m = await meta(b15.intent_id);
    return ["ALREADY_IN_PROGRESS", "REUSE_EXISTING", "OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT", "MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT"].includes(again.action) && m.metadata.terms_version === VERSION && m.metadata.terms_accepted_by_user_id === B.uid ? true : { again, m: m.metadata };
  });
  await check("a 14-argument retry (the pre-release function) for the same customer still returns the existing intent read-only and leaves its acceptance intact", async () => {
    const again = await acquire14(B, "PRACTICE");
    const m = await meta(b15.intent_id);
    return again.action !== "NEW_ATTEMPT" && m.metadata.terms_version === VERSION && m.metadata.immediate_service_consent === true ? true : { again, m: m.metadata };
  });

  group("Immutability (the acceptance is written at acquisition and nowhere else)");
  await check("changing terms_version by UPDATE is refused, even as service_role", async () => {
    const e = await errOf(() => one(SERVICE, "UPDATE public.payment_checkout_intents SET metadata = metadata || jsonb_build_object('terms_version', $2::text) WHERE id=$1", [b15.intent_id, OTHER_VERSION]));
    return e && /TERMS_ACCEPTANCE_IMMUTABLE/.test(e.message) && (await meta(b15.intent_id)).metadata.terms_version === VERSION ? true : code(e);
  });
  await check("removing the acceptance keys is refused", async () => {
    const e = await errOf(() => admin.query("UPDATE public.payment_checkout_intents SET metadata = metadata - 'terms_version' - 'terms_accepted_at' - 'terms_accepted_by_user_id' WHERE id=$1", [b15.intent_id]));
    return e && /TERMS_ACCEPTANCE_IMMUTABLE/.test(e.message) ? true : code(e);
  });
  await check("changing terms_accepted_by_user_id, terms_accepted_at, terms_accepted or immediate_service_consent is refused", async () => {
    const e1 = await errOf(() => admin.query("UPDATE public.payment_checkout_intents SET metadata = metadata || jsonb_build_object('terms_accepted_by_user_id', $2::text) WHERE id=$1", [b15.intent_id, A.uid]));
    const e2 = await errOf(() => admin.query("UPDATE public.payment_checkout_intents SET metadata = metadata || jsonb_build_object('terms_accepted_at', now()) WHERE id=$1", [b15.intent_id]));
    const e3 = await errOf(() => admin.query("UPDATE public.payment_checkout_intents SET metadata = metadata || jsonb_build_object('immediate_service_consent', false) WHERE id=$1", [b15.intent_id]));
    const e4 = await errOf(() => admin.query("UPDATE public.payment_checkout_intents SET metadata = metadata || jsonb_build_object('terms_accepted', false) WHERE id=$1", [b15.intent_id]));
    return [e1, e2, e3, e4].every((e) => e && /TERMS_ACCEPTANCE_IMMUTABLE/.test(e.message)) ? true : [e1, e2, e3, e4].map(code);
  });
  await check("a historical intent without acceptance cannot receive one retrospectively", async () => {
    const e = await errOf(() => admin.query("UPDATE public.payment_checkout_intents SET metadata = metadata || jsonb_build_object('terms_version', $2::text, 'terms_accepted', true, 'terms_accepted_at', now(), 'terms_accepted_by_user_id', $3::text, 'immediate_service_consent', true) WHERE id=$1", [a14.intent_id, VERSION, A.uid]));
    const after = await meta(a14.intent_id);
    return e && /TERMS_ACCEPTANCE_IMMUTABLE/.test(e.message) && KEYS.every((k) => !(k in after.metadata)) ? true : code(e);
  });
  await check("other metadata keys still merge beside the frozen acceptance (manual_review_reason, provider results)", async () => {
    await admin.query("UPDATE public.payment_checkout_intents SET metadata = metadata || jsonb_build_object('manual_review_reason', 'PROOF', 'provider_result', jsonb_build_object('status', 200)) WHERE id=$1", [b15.intent_id]);
    const m = await meta(b15.intent_id);
    return m.metadata.manual_review_reason === "PROOF" && m.metadata.terms_version === VERSION && m.metadata.terms_accepted_by_user_id === B.uid ? true : m.metadata;
  });
  await check("the function's own PRE_PROVIDER_LEASE_EXPIRED merge (an expired CREATING lease) keeps the acceptance and lets a new attempt record its own", async () => {
    const C = await account("lease");
    const first = await acquire15(C, "SOLO", VERSION);
    if (first.action !== "NEW_ATTEMPT") return first;
    await admin.query("UPDATE public.payment_checkout_intents SET creation_lease_expires_at = now() - interval '1 minute' WHERE id=$1", [first.intent_id]);
    const second = await acquire15(C, "SOLO", OTHER_VERSION);
    const m1 = await meta(first.intent_id);
    const m2 = second.action === "NEW_ATTEMPT" ? await meta(second.intent_id) : null;
    return m1.metadata.terms_version === VERSION && m1.metadata.failed_reason === "PRE_PROVIDER_LEASE_EXPIRED" && m2 && m2.metadata.terms_version === OTHER_VERSION ? true : { second, m1: m1.metadata, m2: m2?.metadata };
  });

  group("Authority");
  await check("authenticated cannot EXECUTE acquire_checkout_attempt (42501); anon neither", async () => {
    const o = await offer("SOLO"); const D = await account("direct");
    const e1 = await errOf(() => one(user(D.uid), `SELECT public.acquire_checkout_attempt(${ARGS16}) r`, [D.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, D.uid, `SAFF-${uuid().slice(0, 10)}`, VERSION, true]));
    const e2 = await errOf(() => one(ANON, `SELECT public.acquire_checkout_attempt(${ARGS16}) r`, [D.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, D.uid, `SAFF-${uuid().slice(0, 10)}`, VERSION, true]));
    return e1?.code === "42501" && e2?.code === "42501" ? true : { e1: code(e1), e2: code(e2) };
  });
  await check("the owner can still READ their own intent's recorded acceptance (SELECT policy unchanged); another user cannot", async () => {
    const mine = await one(user(B.uid), "SELECT metadata->>'terms_version' v FROM public.payment_checkout_intents WHERE id=$1", [b15.intent_id]);
    const theirs = await one(user(A.uid), "SELECT metadata->>'terms_version' v FROM public.payment_checkout_intents WHERE id=$1", [b15.intent_id]);
    return mine?.v === VERSION && theirs === undefined ? true : { mine, theirs };
  });

  group("Settlement keeps the acceptance");
  await check("a paid intent (provider session, then the settlement commit) completes with the acceptance intact", async () => {
    const E = await account("paid");
    const a = await acquire15(E, "SOLO", VERSION);
    if (a.action !== "NEW_ATTEMPT") return a;
    const session = uuid();
    await one(SERVICE, "SELECT public.begin_provider_checkout_request($1,$2) r", [a.intent_id, a.creation_token]);
    await one(SERVICE, "SELECT public.persist_checkout_provider_result($1,$2,$3,$4) r", [a.intent_id, a.creation_token, session, `https://polar.example.test/checkout/${session}`]);
    const o = await offer("SOLO"); const tx = `order-${session}`;
    const r = (await one(SERVICE, `SELECT public.commit_verified_commercial_payment($1,'POLAR',$2,'paid','SUCCEEDED',$3,'USD',$4,now(),'PROVIDER_API_VERIFY',$5,$6,$7) r`,
      [a.intent_id, tx, Number(o.amount_minor), "h".repeat(64), crypto.createHash("sha256").update(`POLAR:${tx}:${a.intent_id}`).digest("hex"), a.saff_reference, "production"])).r;
    const m = await meta(a.intent_id);
    return m.status === "SUCCEEDED" && m.metadata.terms_version === VERSION && m.metadata.terms_accepted_by_user_id === E.uid ? true : { r, m };
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n──────────────────────────────────────────\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
  console.log(`CHECKOUT TERMS ACCEPTANCE: ${failed.length === 0 ? "PASSED" : "FAILED"}`);
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`shutdown error: ${e?.stack ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
