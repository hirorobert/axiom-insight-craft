#!/usr/bin/env node
// QuickBooks realmID protection Phase C v2 on the LOCAL Supabase stack (`supabase start` in CI applies EVERY migration, the four cutover parts
// included, to a throwaway database): the post-redaction token-key and index-key rotation and the index-key homogeneity gate driven through the
// REAL PostgREST API (where Supabase's safeupdate guard refuses any UPDATE or DELETE without a WHERE clause, even inside SECURITY DEFINER), with
// the REAL orchestration (supabase/functions/_shared/qboRealmBackfill.ts) and the REAL crypto modules. API level: no Intuit, no browser.
//
// REAL here: PostgREST, its roles and grants, safeupdate, the installed migrations, AES-256-GCM envelopes and HMAC indexes.
// OPERATOR actions by the service role (recorded in the results): creating the Auth users, granting the owners a plan, creating the companies,
// storing the connections through qbo_store_connection (what qbo-finish-connection does after Intuit), and admitting the maintenance caller
// (decided in production by qbo-realm-protect's platform-owner check, proven in scripts/db-proof/qboRealmProtection.mjs).
// NOT proven here: the Edge Function qbo-realm-protect itself, Intuit, the hosted database.
//
//   bun scripts/e2e/qboRotationStackJourney.mjs <evidence-dir>       (after `supabase start`; reads `supabase status -o json`)
//
// Keys are random and live only in this process; nothing printed or recorded contains a key, a token, an envelope or a realm.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { assertLocalStack } from "./localStackFixtures.mjs";
import { replayRedaction } from "../db-proof/lib/qboRedactionReplay.mjs";

const RP = await import("../../supabase/functions/_shared/qboRealmProtection.ts");
const TE = await import("../../supabase/functions/_shared/qboTokenEnvelope.ts");
const { runRealmBackfill } = await import("../../supabase/functions/_shared/qboRealmBackfill.ts");
const { isRotationRefusal } = await import("../../supabase/functions/_shared/qboConnect.ts");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "e2e-evidence/qbo-rotation"));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
let group = "";
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "journey.log"), s + "\n"); };
const startGroup = (g) => { group = g; log(`\n== ${g}`); };
const scrub = (v) => JSON.parse(JSON.stringify(v ?? null).replace(/v1\.[A-Za-z0-9_.-]+|h1\.[a-z0-9-]+\.[0-9a-f]{64}|\b\d{16}\b/g, "…"));
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ group, name, ok: r === true, detail: r === true ? undefined : scrub(r) });
    log(`  ${r === true ? "PASS" : "FAIL"}  ${name}${r === true ? "" : `\n        ${JSON.stringify(scrub(r))?.slice(0, 1500)}`}`);
  } catch (e) {
    results.push({ group, name, ok: false, detail: String(e?.message ?? e).slice(0, 300) });
    log(`  FAIL  ${name}\n        ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}`);
  }
}

const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const apiUrl = status.API_URL, anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY, serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
assertLocalStack({ apiUrl, anonKey, serviceRoleKey: serviceKey });
const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

const run = Date.now().toString(36);
const mk = (who) => ({ email: `${who}.${run}@e2e-local.test`, password: `E2e!${crypto.randomBytes(12).toString("base64url")}` });
const U = { a: mk("qbo-rot-a"), b: mk("qbo-rot-b") };
for (const u of Object.values(U)) {
  const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
  if (error) throw new Error(`creating a test user failed: ${error.message}`);
  u.id = data.user.id;
}
async function grantPlan(userId) {
  const prod = (await admin.from("commercial_products").select("id").eq("code", "CFOCLOSE").single()).data;
  const plan = (await admin.from("commercial_plans").select("id").eq("product_id", prod.id).eq("code", "PRACTICE").single()).data;
  const bc = await admin.from("billing_customers").insert({ owner_user_id: userId, product_id: prod.id }).select("id").single();
  if (bc.error) throw new Error(`billing customer: ${bc.error.message}`);
  const lic = await admin.from("commercial_licences").insert({ billing_customer_id: bc.data.id, plan_id: plan.id, status: "ACTIVE", source: "ADMIN_GRANT",
    effective_start: new Date(Date.now() - 86400000).toISOString(), additional_seats: 4 });
  if (lic.error) throw new Error(`licence: ${lic.error.message}`);
}
await grantPlan(U.a.id); await grantPlan(U.b.id);
const newCompany = async (u, name) => {
  const { data, error } = await admin.from("companies").insert({ user_id: u.id, name }).select("id").single();
  if (error) throw new Error(`company: ${error.message}`);
  return data.id;
};
const A = await newCompany(U.a, "Invented Rotation Trading Ltd"), B = await newCompany(U.b, "Invented Rotation Holdings Ltd");

const key = (id) => ({ id, bytes: new Uint8Array(crypto.randomBytes(32)) });
const K2 = key("k2"), K3 = key("k3"), IDX2 = key("idx2"), IDX3 = key("idx3");
const TODAY = { current: K2, all: [K2], index: IDX2 }, TOKEN_ROT = { current: K3, all: [K3, K2], index: IDX2 };
const INDEX_ROT = { current: K3, all: [K3, K2], index: IDX3, indexAll: [IDX3, IDX2] };
const SHARED = "9130353000000031", SOLO = "9130353000000032", LATE = "9130353000000033";
const kid = (e) => (e ?? "").split(".")[1];
const rpc = async (fn, args) => { const { data, error } = await admin.rpc(fn, args); if (error) throw Object.assign(new Error(error.message), { code: error.code }); return data; };
const store = async (company, actor, realm, keys) => {
  const p = await RP.protectRealm(realm, "sandbox", company, keys);
  const token = await TE.sealSecret("rt-" + crypto.randomBytes(16).toString("hex"), keys.current, TE.connectionBinding(company, realm, "sandbox"));
  return admin.rpc("qbo_store_connection", { p_company_id: company, p_actor_user_id: actor, p_realm_id: null, p_environment: "sandbox", p_envelope: token,
    p_refresh_expires_at: new Date(Date.now() + 100 * 86400000).toISOString(), p_hard_expires_at: null, p_realm_envelope: p.envelope, p_realm_index: p.index });
};
const conn = async (id) => (await admin.from("qbo_connections").select("realm_id,realm_envelope,realm_index,refresh_token_envelope,status").eq("id", id).single()).data;
// The dependency wiring of supabase/functions/qbo-realm-protect/index.ts after the cutover, over PostgREST: realm_id is never selected.
const deps = (over = {}) => ({
  authorize: async () => ({ ok: true, actor: "operator" }),
  listConnections: async () => ((await admin.from("qbo_connections").select("id,company_id,environment,realm_envelope,realm_index,refresh_token_envelope").neq("status", "disconnected").order("created_at")).data ?? []).map((x) => ({ ...x, realm_id: null })),
  listOperations: async () => ((await admin.from("qbo_disconnect_operations").select("id:connection_id,company_id,environment,realm_envelope,realm_index").order("created_at")).data ?? []).map((x) => ({ ...x, realm_id: null })),
  status: async () => rpc("qbo_realm_protection_status", {}),
  coverage: async () => rpc("qbo_realm_key_coverage", {}),
  indexCoverage: async () => rpc("qbo_realm_index_coverage", {}),
  resealConnection: (a) => rpc("qbo_reseal_connection_realm", a), resealOperation: (a) => rpc("qbo_reseal_disconnect_realm", a), resealToken: (a) => rpc("qbo_reseal_refresh_token", a),
  reindexConnection: (a) => rpc("qbo_reindex_connection_realm", a), reindexOperation: (a) => rpc("qbo_reindex_disconnect_realm", a),
  ...over,
});
let SA, SB, SO;

startGroup("The four cutover parts are installed by `supabase start`; connections stored after the redaction");
await check("the migrations installed the post-redaction rotation and the homogeneity gate (functions present, writers gone)", async () => {
  const { data, error } = await admin.rpc("qbo_realm_protection_status", {});
  const gone = await admin.rpc("qbo_verify_connection_realm", { p_connection: crypto.randomUUID(), p_realm_id: "1", p_realm_envelope: "v1.k2.a.b", p_realm_index: "h1.idx2." + "0".repeat(64) });
  return !error && data && gone.error && /function|schema cache/i.test(gone.error.message) || { error, gone: gone.error?.message };
});
await check("two workspaces connect the same QuickBooks company and one connects another, under k2 and idx2, without plaintext", async () => {
  const a = await store(A, U.a.id, SHARED, TODAY), b = await store(B, U.b.id, SHARED, TODAY), s = await store(A, U.a.id, SOLO, TODAY);
  if (a.error || b.error || s.error) return { a: a.error?.message, b: b.error?.message, s: s.error?.message };
  SA = a.data; SB = b.data; SO = s.data;
  const rows = await Promise.all([SA, SB, SO].map(conn));
  return rows.every((x) => x.realm_id === null && kid(x.realm_envelope) === "k2" && kid(x.realm_index) === "idx2") || rows.map((x) => ({ realm_id: x.realm_id !== null }));
});

startGroup("Token-key rotation k2 -> k3 through PostgREST (safeupdate active)");
await check("the reseal completes: every realm envelope and refresh token on k3, realm_id NULL, index unchanged", async () => {
  const before = await Promise.all([SA, SB, SO].map(conn));
  const x = await runRealmBackfill(deps(), TOKEN_ROT, { action: "reseal" });
  const after = await Promise.all([SA, SB, SO].map(conn));
  return x.status === 200 && after.every((c, i) => kid(c.realm_envelope) === "k3" && kid(c.refresh_token_envelope) === "k3" && c.realm_id === null && c.realm_index === before[i].realm_index)
    || { status: x.status, outcome: x.outcome, connectionRealms: x.connectionRealms, refreshTokens: x.refreshTokens };
});
await check("a downgrade submitted through PostgREST is answered 'downgrade' and changes nothing", async () => {
  const a = await conn(SA);
  const o = await rpc("qbo_reseal_connection_realm", { p_connection: SA, p_realm_id: null, p_expected_envelope: a.realm_envelope, p_new_envelope: await RP.sealRealm(SHARED, "sandbox", A, K2), p_realm_index: a.realm_index });
  return o === "downgrade" && JSON.stringify(await conn(SA)) === JSON.stringify(a) || o;
});

startGroup("Index-key rotation idx2 -> idx3 through PostgREST; the homogeneity gate while it is half done");
await check("moving only the first connection leaves the indexes mixed", async () => {
  const x = await runRealmBackfill(deps({ reindexConnection: async (a) => a.p_connection === SA ? rpc("qbo_reindex_connection_realm", a) : "interrupted" }), INDEX_ROT, { action: "reindex" });
  return x.status === 409 && kid((await conn(SA)).realm_index) === "idx3" && kid((await conn(SB)).realm_index) === "idx2" || { status: x.status };
});
await check("a connect is refused with the database's mid-rotation code (HTTP 409 / PT409), which the function maps to rotation_in_progress", async () => {
  const s = await store(B, U.b.id, LATE, INDEX_ROT);
  return s.error && isRotationRefusal(s.error) || { error: s.error?.message, code: s.error?.code };
});
await check("the other sharer's disconnect is refused as rotation_in_progress, never revoked as unshared", async () => {
  const b = await rpc("qbo_begin_disconnect", { p_connection: SB, p_actor: U.b.id, p_request: crypto.randomUUID() });
  return b?.outcome === "rotation_in_progress" && (await conn(SB)).status !== "disconnected" || b;
});
await check("the retry completes; the sharers' indexes are equal again; the disconnect now finds the sharer and stays local (20261231400000: no revocation, the other sharer still active)", async () => {
  const x = await runRealmBackfill(deps(), INDEX_ROT, { action: "reindex" });
  const a = await conn(SA), b = await conn(SB);
  const d = await rpc("qbo_begin_disconnect", { p_connection: SB, p_actor: U.b.id, p_request: crypto.randomUUID() });
  const b2 = await conn(SB), a2 = await conn(SA);
  return x.status === 200 && a.realm_index === b.realm_index && kid(a.realm_index) === "idx3" && d?.outcome === "local_only" && !d?.envelope
    && b2.status === "disconnected" && b2.refresh_token_envelope === null && a2.status === "active" || { status: x.status, d, b2: b2?.status, a2: a2?.status };
});
await check("a connect after the rotation is stored under k3 and idx3", async () => {
  const s = await store(B, U.b.id, LATE, { current: K3, all: [K3], index: IDX3 });
  const c = s.data ? await conn(s.data) : null;
  return !s.error && c.realm_id === null && kid(c.realm_envelope) === "k3" && kid(c.realm_index) === "idx3" || s.error?.message;
});

startGroup("Who may call it, through the real API");
await check("anon cannot execute a rotation function or the homogeneity helper", async () => {
  const r1 = await anon.rpc("qbo_reseal_connection_realm", { p_connection: SA, p_realm_id: null, p_expected_envelope: "v1.k9.a.b", p_new_envelope: "v1.k9.a.b", p_realm_index: "h1.idx3.x" });
  const r2 = await anon.rpc("qbo_index_key_mixed", { p_key_id: "idx3" });
  const r3 = await admin.rpc("qbo_index_key_mixed", { p_key_id: "idx3" });
  return !!r1.error && !!r2.error && !!r3.error || { r1: r1.error?.message, r2: r2.error?.message, r3: r3.error?.message };
});

startGroup("The irreversible redaction (20261231300000) under this stack's PostgreSQL with safeupdate loaded (seeded, rolled back)");
// `supabase start` applied the redaction to EMPTY tables, so none of its UPDATE/DELETE statements touched a row. Here the committed file runs
// again in full on seeded rows holding a plaintext realm, in one transaction with safeupdate loaded into the session, and is rolled back.
const dbUrl = status.DB_URL;
const runtime = {};
await check("the stack's database is loopback-only; which roles preload safeupdate is recorded", async () => {
  const u = new URL(dbUrl);
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) return "DB_URL is not loopback";
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  try {
    const r = await c.query("select current_user u, current_setting('server_version') v, (select coalesce(string_agg(rolname || ':' || array_to_string(rolconfig, ','), ' '), '') from pg_roles where array_to_string(rolconfig, ',') ilike '%safeupdate%') preload");
    Object.assign(runtime, r.rows[0]);
    log(`        runtime: user=${runtime.u} server=${runtime.v} safeupdate preloaded for: ${runtime.preload || "(no role)"}`);
    return true;
  } finally { await c.end(); }
});
await check("the redaction runs to completion as postgres with safeupdate ACTIVE: live plaintext removed, pending operation cleared, history byte-identical", async () => {
  // The local stack's superuser (same loopback server and password as DB_URL) may LOAD safeupdate; the replay then runs as postgres.
  const su = new URL(dbUrl); su.username = "supabase_admin";
  const c = new pg.Client({ connectionString: su.toString() });
  await c.connect();
  try {
    await c.query("BEGIN");
    const x = await replayRedaction(c, {
      migrationSql: fs.readFileSync(path.join(REPO, "supabase/migrations/20261231300000_qbo_realm_protection_cutover_redaction.sql"), "utf8"),
      protect: (realm) => RP.protectRealm(realm, "sandbox", A, { current: K3, all: [K3], index: IDX3 }),
      sealToken: (realm) => TE.sealSecret("rt-" + crypto.randomBytes(16).toString("hex"), K3, TE.connectionBinding(A, realm, "sandbox")),
      companyId: A, actorId: U.a.id, loadSafeupdate: true, runAs: "postgres" });
    await c.query("ROLLBACK");
    runtime.redaction = x.detail;
    return x.ok && x.detail.runAs === "postgres" || x.detail;
  } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { await c.end(); }
});
await check("after the rollback the stack is exactly as before: the redaction's final rules are installed and no seeded row remains", async () => {
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  try {
    const r = (await c.query("select (select count(*)::int from pg_constraint where conname in ('chk_qbo_connections_live_no_plaintext','chk_qbo_disconnect_operations_no_plaintext','chk_qbo_oauth_states_no_plaintext')) n, to_regclass('public.uq_qbo_connections_live') is null dropped, (select count(*)::int from public.qbo_connections where realm_id is not null and status <> 'disconnected') live_plain")).rows[0];
    return r.n === 3 && r.dropped && r.live_plain === 0 || r;
  } finally { await c.end(); }
});

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, runtime, boundaries: {
  real: ["PostgREST, its roles and grants, and safeupdate", "every migration installed by supabase start, the four cutover parts included", "the real orchestration and crypto modules",
    "the committed redaction file executed in full under this PostgreSQL with safeupdate loaded (seeded rows, rolled back)"],
  operatorActionsByServiceRole: ["create Auth users", "grant the owners a plan", "create the companies", "store connections through qbo_store_connection", "admit the maintenance caller"],
  notProven: ["the qbo-realm-protect Edge Function and its platform-owner check (database proof)", "Intuit", "the hosted database",
    "the hosted migrator's own role and session settings (Lovable applies migrations outside PostgREST)"] }, finishedAt: new Date().toISOString() }, null, 2));
const failed = results.filter((r) => !r.ok);
log(`\nchecks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
log(failed.length || !results.length ? "QBO_ROTATION_STACK_JOURNEY: FAILED" : "QBO_ROTATION_STACK_JOURNEY: ALL PASSED");
setTimeout(() => process.exit(results.length && failed.length === 0 ? 0 : 1), 300);
