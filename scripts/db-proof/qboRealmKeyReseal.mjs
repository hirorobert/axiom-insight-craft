#!/usr/bin/env node
// Real-PostgreSQL proof of the QuickBooks token-key rotation (20261230400000): every LIVE row sealed with the retiring key k1 is moved onto an
// owner-held key k2 while k1 still opens, so nothing operational depends on k1 afterwards. Phases A and B are installed first; the data is written
// by the real Phase B service functions with REAL envelopes (AES-256-GCM refresh tokens and realm envelopes under k1, HMAC indexes under idx1);
// the rotation runs through the REAL orchestration (supabase/functions/_shared/qboRealmBackfill.ts) with the REAL modules.
//
//   bun scripts/db-proof/qboRealmKeyReseal.mjs                                      (CI: DB_PROOF_MODE=external DB_PROOF_CONN=<loopback db>)
//   DB_PROOF_MODULES_DIR=<dir with embedded-postgres + pg> node scripts/db-proof/qboRealmKeyReseal.mjs   (local; Node >= 22.6 strips types)
//
// Loopback only; no Intuit, no hosted project, no secret: every key is random and lives only in this process.
import crypto from "node:crypto";
import { openDatabase, applyChainBefore, makeWorld, migrationText, reporter } from "./lib/reportingKit.mjs";

const RP = await import("../../supabase/functions/_shared/qboRealmProtection.ts");
const TE = await import("../../supabase/functions/_shared/qboTokenEnvelope.ts");
const { runRealmBackfill, decideMaintenanceAuthority } = await import("../../supabase/functions/_shared/qboRealmBackfill.ts");
const RESEAL = "20261230400000_qbo_realm_key_reseal.sql";
const key = (id) => ({ id, bytes: new Uint8Array(crypto.randomBytes(32)) });
const K1 = key("k1"), K2 = key("k2"), IDX = key("idx1");
const KEYS1 = { current: K1, all: [K1], index: IDX };            // today: k1 seals and opens
const KEYS2 = { current: K2, all: [K2, K1], index: IDX };        // QBO_TOKEN_KEY_NEXT_* = k2 configured; k1 still opens
const KEYS2ONLY = { current: K2, all: [K2], index: IDX };        // k1 retired
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const kid = (e) => (e ?? "").split(".")[1];

async function main() {
  const r = reporter();
  const db = await openDatabase("qbo_realm_key_reseal");
  let crashed = false;
  try {
    const failed = await applyChainBefore(db, RESEAL);
    if (failed) throw new Error(`chain: ${failed}`);
    const w = await makeWorld(db);
    const svc = (s, p = []) => db.asService(s, p);
    const SHARED = "9130351000000001", SOLO = "9130351000000002", LEASED = "9130351000000003", GONE = "9130351000000004", LATE1 = "9130351000000005", LATE2 = "9130351000000006";
    const tokens = new Map();   // connection id -> plaintext refresh token (test only)
    const store = async (company, actor, realm, keys) => {
      const token = "rt-" + crypto.randomBytes(16).toString("hex");
      const tokenEnv = await TE.sealSecret(token, keys.current, TE.connectionBinding(company, realm, "sandbox"));
      const p = await RP.protectRealm(realm, "sandbox", company, keys);
      const id = (await svc("select public.qbo_store_connection($1,$2,$3,'sandbox',$4,now()+interval '100 days',null,$5,$6) id", [company, actor, realm, tokenEnv, p.envelope, p.index])).id;
      tokens.set(id, token);
      return id;
    };
    // Live: two workspaces share one QuickBooks company (as hosted today), one solo, one that will be under an import lease; one disconnected and revoked.
    const SA = await store(w.A, w.U.owner, SHARED, KEYS1), SB = await store(w.B, w.U.ownerB, SHARED, KEYS1);
    const SO = await store(w.A, w.U.owner, SOLO, KEYS1), LE = await store(w.A, w.U.owner, LEASED, KEYS1), GO = await store(w.B, w.U.ownerB, GONE, KEYS1);

    await db.admin.query("insert into public.commercial_admins(user_id, active, authority) values ($1,true,'commercial'),($2,true,'platform_owner')", [w.U.preparer, w.U.viewer]);
    const authorityOf = (uid) => decideMaintenanceAuthority("Bearer aaa.bbb.ccc", { userIdOf: async () => uid, isPlatformOwner: async (u) => (await svc("select public.is_platform_owner($1) r", [u])).r });
    const hasReseal = async () => (await db.one("select to_regprocedure('public.qbo_reseal_refresh_token(uuid,text,text)') is not null ok")).ok;
    const depsOf = (authorize, wrap = {}) => ({
      authorize,
      listConnections: async () => (await db.admin.query("select id, company_id, environment, realm_id, realm_envelope, realm_index, refresh_token_envelope from public.qbo_connections where status <> 'disconnected' order by created_at")).rows,
      listOperations: async () => (await db.admin.query("select connection_id as id, company_id, environment, realm_id, realm_envelope, realm_index from public.qbo_disconnect_operations order by created_at")).rows,
      protectConnection: async (a) => (await svc("select public.qbo_protect_connection_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
      protectOperation: async (a) => (await svc("select public.qbo_protect_disconnect_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
      verifyConnection: async (a) => (await svc("select public.qbo_verify_connection_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
      verifyOperation: async (a) => (await svc("select public.qbo_verify_disconnect_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
      status: async () => (await svc("select public.qbo_realm_protection_status() s")).s,
      ...(wrap.noReseal ? {} : {
        resealConnection: wrap.resealConnection ?? (async (a) => (await svc("select public.qbo_reseal_connection_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_expected_envelope, a.p_new_envelope, a.p_realm_index])).o),
        resealOperation: wrap.resealOperation ?? (async (a) => (await svc("select public.qbo_reseal_disconnect_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_expected_envelope, a.p_new_envelope, a.p_realm_index])).o),
        resealToken: wrap.resealToken ?? (async (a) => (await svc("select public.qbo_reseal_refresh_token($1,$2,$3) o", [a.p_connection, a.p_expected_envelope, a.p_new_envelope])).o),
        coverage: async () => (await svc("select public.qbo_realm_key_coverage() c")).c,
      }),
    });
    const owner = () => authorityOf(w.U.viewer);
    const run = (keys, action, wrap) => runRealmBackfill(depsOf(owner, wrap), keys, { action });

    r.group("Before the migration: Phase B data under k1, verified, one revoked disconnect");
    await r.check("the Phase B verification passes under k1 for every live connection", async () => {
      const v = await runRealmBackfill(depsOf(owner, { noReseal: true }), KEYS1, { action: "verify" });
      return v.status === 200 && v.connections.verified === 5 || v;
    });
    const begun = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [GO, w.U.ownerB, crypto.randomUUID()])).r;
    await svc("select public.qbo_finish_disconnect($1,$2,$3,$4)", [GO, w.U.ownerB, (await db.one("select request_id from public.qbo_disconnect_operations where connection_id=$1", [GO])).request_id, begun.leaseId]);
    await r.check("the revoked operation carries the connection's k1 envelope and verification; the terminal connection keeps its k1 envelope", async () => {
      const o = await db.one("select outcome, realm_envelope, realm_verified_at from public.qbo_disconnect_operations where connection_id=$1", [GO]);
      const c = await db.one("select status, realm_envelope from public.qbo_connections where id=$1", [GO]);
      return begun.outcome === "pending" && o.outcome === "revoked" && kid(o.realm_envelope) === "k1" && o.realm_verified_at !== null && c.status === "disconnected" && kid(c.realm_envelope) === "k1" || { begun, o, c };
    });
    await r.check("without the migration the orchestration refuses to re-seal (503 unavailable) and changes nothing", async () => {
      const x = await runRealmBackfill(depsOf(owner, { noReseal: true }), KEYS2, { action: "reseal" });
      return x.status === 503 && !(await hasReseal()) || x;
    });

    const ALL = "select 'c' t, id::text k, realm_id, realm_envelope, realm_index, realm_verified_at::text v, refresh_token_envelope tok, status from public.qbo_connections union all select 'o', connection_id::text, realm_id, realm_envelope, realm_index, realm_verified_at::text, pending_envelope, outcome from public.qbo_disconnect_operations union all select 's', id::text, realm_id, realm_envelope, null, null, code_envelope, null from public.qbo_oauth_states order by 1,2";
    const snap = async () => (await db.admin.query(ALL)).rows;
    const before = await snap();

    r.group("20261230400000 applied");
    await db.admin.query(migrationText(RESEAL));
    await r.check("no row changes (connections, operations, OAuth states identical)", async () => same(await snap(), before));
    await r.check("replay is a no-op", async () => { await db.admin.query(migrationText(RESEAL)); return same(await snap(), before); });
    await r.check("the four functions are executable by the service role only", async () => {
      const x = await db.one(`select has_function_privilege('service_role','public.qbo_reseal_connection_realm(uuid,text,text,text,text)','EXECUTE') a,
        has_function_privilege('authenticated','public.qbo_reseal_refresh_token(uuid,text,text)','EXECUTE') b, has_function_privilege('anon','public.qbo_reseal_disconnect_realm(uuid,text,text,text,text)','EXECUTE') c,
        has_function_privilege('authenticated','public.qbo_realm_key_coverage()','EXECUTE') d`);
      return x.a === true && x.b === false && x.c === false && x.d === false || x;
    });
    await r.refused("a member cannot call a re-seal", "42501", () => db.asRole("authenticated", w.U.owner, "select public.qbo_reseal_refresh_token($1,'v1.k1.a.b','v1.k2.a.b')", [SA]));

    r.group("Guards: the protection is still written once, except the exact reseal transition inside the function");
    const conn = async (id) => db.one("select realm_envelope, realm_index, realm_id, refresh_token_envelope from public.qbo_connections where id=$1", [id]);
    const sa = await conn(SA);
    const k2env = await RP.sealRealm(SHARED, "sandbox", w.A, K2);
    await r.refused("a direct UPDATE of a realm envelope (even by the superuser) is refused", "23001", () => db.admin.query("update public.qbo_connections set realm_envelope=$2, realm_verified_at=now() where id=$1", [SA, k2env]));
    await r.refused("the marker naming ANOTHER row does not open the guard", "23001", async () => {
      const c = await db.pool.connect();
      try { await c.query("BEGIN"); await c.query("select set_config('qbo.realm_reseal', 'connection:' || $1, true)", [SB]); await c.query("update public.qbo_connections set realm_envelope=$2, realm_verified_at=now() where id=$1", [SA, k2env]); }
      finally { await c.query("ROLLBACK"); c.release(); }
    });
    await r.refused("even with the right marker, a changed index is refused (idx1 is never rotated here)", "23001", async () => {
      const c = await db.pool.connect();
      try { await c.query("BEGIN"); await c.query("select set_config('qbo.realm_reseal', 'connection:' || $1, true)", [SA]); await c.query("update public.qbo_connections set realm_envelope=$2, realm_index=$3, realm_verified_at=now() where id=$1", [SA, k2env, "h1.idx1." + "0".repeat(64)]); }
      finally { await c.query("ROLLBACK"); c.release(); }
    });
    await r.refused("an operation's index can never change", "23001", () => db.admin.query("update public.qbo_disconnect_operations set realm_index=$2 where connection_id=$1", [GO, "h1.idx1." + "0".repeat(64)]));
    await r.check("the functions refuse: a same-key envelope, a wrong plaintext, a wrong index, a stale expectation, a terminal connection, a malformed envelope", async () => {
      const call = async (id, realm, exp, nw, idx) => (await svc("select public.qbo_reseal_connection_realm($1,$2,$3,$4,$5) o", [id, realm, exp, nw, idx])).o;
      const k1again = await RP.sealRealm(SHARED, "sandbox", w.A, K1);
      const got = [await call(SA, SHARED, sa.realm_envelope, k1again, sa.realm_index), await call(SA, "9130351999999999", sa.realm_envelope, k2env, sa.realm_index),
        await call(SA, SHARED, sa.realm_envelope, k2env, "h1.idx1." + "0".repeat(64)), await call(SA, SHARED, k1again, k2env, sa.realm_index),
        await call(GO, GONE, (await conn(GO)).realm_envelope, k2env, (await conn(GO)).realm_index), await call(SA, SHARED, sa.realm_envelope, "not-an-envelope", sa.realm_index)];
      return same(got, ["same_key", "realm_mismatch", "index_mismatch", "stale", "terminal_unchanged", "invalid"]) && same(await snap(), before) || got;
    });

    r.group("keys (read only): what the deployed runtime needs today");
    await r.check("under today's ring every live realm envelope, refresh token and operation envelope opens under k1; nothing is written", async () => {
      const x = await run(KEYS1, "keys");
      return x.status === 200 && same(x.connectionRealms.byKey, { k1: 4 }) && same(x.refreshTokens.byKey, { k1: 4 }) && same(x.operationRealms.byKey, { k1: 1 })
        && x.database["live_refresh_token:k1"] === 4 && x.database["terminal_realm:k1"] === 1 && same(await snap(), before) || x;
    });
    await r.check("THE TRAP: if k1 were replaced BEFORE re-sealing, nothing live opens (imports refused; a disconnect could not revoke and would stay pending)", async () => {
      const x = await run(KEYS2ONLY, "keys");
      const resolved = await RP.resolveStoredRealm({ ...(await conn(SO)), company_id: w.A, environment: "sandbox" }, KEYS2ONLY, { allowPlaintext: false });
      return x.status === 409 && x.connectionRealms.unreadable === 4 && x.refreshTokens.unreadable === 4 && x.operationRealms.unreadable === 1 && resolved.ok === false && resolved.reason === "unreadable" || { x, resolved };
    });
    await r.check("and the shared QuickBooks company cannot be disconnected from either workspace while the other is live (shared_connection), with or without k1", async () => {
      const a = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [SA, w.U.owner, crypto.randomUUID()])).r;
      const b = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [SB, w.U.ownerB, crypto.randomUUID()])).r;
      return a.outcome === "shared_connection" && b.outcome === "shared_connection" && same(await snap(), before) || { a, b };
    });

    r.group("reseal: authority, partial failure, an import's lease, a concurrent token rotation, concurrent runs");
    await r.check("a member and a commercial-tier administrator are refused (403) and nothing changes", async () => {
      const a = await runRealmBackfill(depsOf(() => authorityOf(w.U.owner)), KEYS2, { action: "reseal" });
      const b = await runRealmBackfill(depsOf(() => authorityOf(w.U.preparer)), KEYS2, { action: "keys" });
      return a.status === 403 && b.status === 403 && same(await snap(), before) || { a, b };
    });
    const lease = (await svc("select public.qbo_acquire_refresh_lease($1,$2,90) id", [LE, (await conn(LE)).refresh_token_envelope])).id;
    let crashOnce = true;
    const first = await run(KEYS2, "reseal", { resealOperation: async (a) => { if (crashOnce) { crashOnce = false; throw new Error("simulated interruption"); } return (await svc("select public.qbo_reseal_disconnect_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_expected_envelope, a.p_new_envelope, a.p_realm_index])).o; } });
    await r.check("first run: realms re-sealed, the leased token answers busy, the interrupted operation is left as it was (409 incomplete)", async () => {
      const le = await conn(LE), op = await db.one("select realm_envelope from public.qbo_disconnect_operations where connection_id=$1", [GO]);
      return first.status === 409 && first.connectionRealms.resealed === 4 && first.refreshTokens.resealed === 3 && first.refreshTokens.busy === 1 && first.operationRealms.refused === 1
        && kid(le.refresh_token_envelope) === "k1" && kid(op.realm_envelope) === "k1" || { first, le: kid(le.refresh_token_envelope), op: kid(op.realm_envelope) };
    });
    await svc("select public.qbo_release_refresh_lease($1,$2)", [LE, lease]);
    // A concurrent import rotates LE's refresh token (still sealed by the old functions with k1) between the listing and the submission.
    let rotated = null;
    const second = await run(KEYS2, "reseal", { resealToken: async (a) => {
      if (a.p_connection === LE && rotated === null) {
        rotated = "rt-rotated-" + crypto.randomBytes(8).toString("hex");
        const next = await TE.sealSecret(rotated, K1, TE.connectionBinding(w.A, LEASED, "sandbox"));
        const l = (await svc("select public.qbo_acquire_refresh_lease($1,$2,90) id", [LE, a.p_expected_envelope])).id;
        await svc("select public.qbo_rotate_leased_token($1,$2,$3,$4,now()+interval '100 days',null) r", [LE, l, a.p_expected_envelope, next]);
        await svc("select public.qbo_release_refresh_lease($1,$2)", [LE, l]);
      }
      return (await svc("select public.qbo_reseal_refresh_token($1,$2,$3) o", [a.p_connection, a.p_expected_envelope, a.p_new_envelope])).o;
    } });
    await r.check("second run: the concurrently rotated token answers stale (never overwritten); the interrupted operation completes", async () => {
      const le = await conn(LE);
      return second.status === 409 && second.refreshTokens.stale === 1 && second.connectionRealms.already === 4 && second.operationRealms.resealed === 1
        && kid(le.refresh_token_envelope) === "k1" && await TE.openSecret(le.refresh_token_envelope, KEYS1.all, TE.connectionBinding(w.A, LEASED, "sandbox")) === rotated || { second };
    });
    const third = await run(KEYS2, "reseal");
    await r.check("third run: complete; the rotated token (not the stale one) is now under k2", async () => {
      const le = await conn(LE);
      return third.status === 200 && third.refreshTokens.resealed === 1 && third.refreshTokens.already === 3
        && await TE.openSecret(le.refresh_token_envelope, KEYS2ONLY.all, TE.connectionBinding(w.A, LEASED, "sandbox")) === rotated || third;
    });
    // The old functions keep sealing with k1 until the new ones are deployed: two connections stored late, then two re-seal runs at once.
    const L1 = await store(w.A, w.U.owner, LATE1, KEYS1), L2 = await store(w.B, w.U.ownerB, LATE2, KEYS1);
    const [p, q] = await Promise.all([run(KEYS2, "reseal"), run(KEYS2, "reseal")]);
    const fourth = await run(KEYS2, "reseal");
    await r.check("two concurrent runs never double-write: each late row is re-sealed exactly once, the loser answers already/stale, a further run is complete", async () => {
      const total = (t) => p[t].resealed + q[t].resealed;
      return total("connectionRealms") === 2 && total("refreshTokens") === 2 && fourth.status === 200 && fourth.connectionRealms.resealed === 0 && fourth.refreshTokens.resealed === 0 || { p, q, fourth };
    });
    await r.check("replaying the re-seal changes nothing", async () => { const s = await snap(); const x = await run(KEYS2, "reseal"); return x.status === 200 && same(await snap(), s) || x; });

    r.group("After: k1 is no longer needed by any live row");
    await r.check("keys with k1 REMOVED from the ring: every live realm, token and operation opens under k2 (complete)", async () => {
      const x = await run(KEYS2ONLY, "keys");
      return x.status === 200 && same(x.connectionRealms.byKey, { k2: 6 }) && same(x.refreshTokens.byKey, { k2: 6 }) && same(x.operationRealms.byKey, { k2: 1 }) || x;
    });
    await r.check("the existing Phase B verification also passes with k1 removed", async () => {
      const v = await runRealmBackfill(depsOf(owner), KEYS2ONLY, { action: "verify" });
      return v.status === 200 && v.connections.verified === 6 && v.operations.verified === 1 || v;
    });
    await r.check("stored coverage: live rows only under k2; the terminal connection keeps its k1 envelope (never opened); no pending revocation", async () => {
      const c = (await svc("select public.qbo_realm_key_coverage() c")).c;
      return c["live_refresh_token:k2"] === 6 && c["live_realm:k2"] === 6 && c["operation_realm:k2"] === 1 && c["terminal_realm:k1"] === 1
        && !Object.keys(c).some((k) => k.startsWith("live_") && k.endsWith(":k1")) && !Object.keys(c).some((k) => k.startsWith("pending_revocation_token")) || c;
    });
    await r.check("identity preserved: every row's plaintext realm and idx1 index are unchanged; the terminal connection and the OAuth states are byte-identical", async () => {
      const now = await snap();
      const pick = (rows) => rows.filter((x) => x.t !== "s").filter((x) => before.some((b) => b.k === x.k)).map((x) => [x.k, x.realm_id, x.realm_index]);
      const term = (rows) => rows.find((x) => x.k === GO && x.t === "c");
      return same(pick(now), pick(before)) && same(term(now), term(before)) && same(now.filter((x) => x.t === "s"), before.filter((x) => x.t === "s")) || "changed";
    });
    await r.check("an import's path works with k1 removed: the realm resolves from the envelope and the token opens under its binding", async () => {
      const c = await conn(SO);
      const realm = await RP.realmForOperation({ id: SO, company_id: w.A, environment: "sandbox", ...c }, KEYS2ONLY, null);
      return realm.ok === true && realm.realmId === SOLO && await TE.openSecret(c.refresh_token_envelope, KEYS2ONLY.all, TE.connectionBinding(w.A, SOLO, "sandbox")) === tokens.get(SO) || realm;
    });
    await r.check("a disconnect works with k1 removed: begin returns the k2 token, which opens, and finish records the revocation; the company can be reconnected", async () => {
      const b = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [SO, w.U.owner, crypto.randomUUID()])).r;
      const realm = await RP.resolveStoredRealm({ company_id: b.companyId, environment: b.environment, realm_id: b.realmId, realm_envelope: b.realmEnvelope, realm_index: b.realmIndex }, KEYS2ONLY, { allowPlaintext: false });
      const token = realm.ok ? await TE.openSecret(b.envelope, KEYS2ONLY.all, TE.connectionBinding(b.companyId, realm.realmId, b.environment)) : null;
      const req = (await db.one("select request_id from public.qbo_disconnect_operations where connection_id=$1", [SO])).request_id;
      await svc("select public.qbo_finish_disconnect($1,$2,$3,$4)", [SO, w.U.owner, req, b.leaseId]);
      const o = await db.one("select outcome from public.qbo_disconnect_operations where connection_id=$1", [SO]);
      const again = await store(w.A, w.U.owner, SOLO, KEYS2);
      return b.outcome === "pending" && kid(b.envelope) === "k2" && token === tokens.get(SO) && o.outcome === "revoked" && typeof again === "string" || { b, token, o };
    });

    // ── 20261230410000: hosted journal 117 applied 20261230400000 with one transcribed line in the operation guard
    //    (NEW.realm_envelope → OLD.realm_envelope). The repair restores the reviewed body and verifies its own digest.
    r.group("guard repair (20261230410000)");
    const REPAIR = "20261230410000_qbo_reseal_operations_guard_repair.sql";
    const GOOD = "ab3855f445f5d82b68f29dba324745752853a472ee065befdc207b15162099a0", BAD = "d087625f8ffa333d1d90fb407099abc0461418b0425a9486a63e57d70a6ccd18";
    const REVIEWED_LINE = "IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope)\n       OR (OLD.realm_verified_at";
    const HOSTED_LINE = "IF (OLD.realm_envelope IS NOT NULL AND OLD.realm_envelope IS DISTINCT FROM OLD.realm_envelope)\n       OR (OLD.realm_verified_at";
    const GUARD_HEAD = "  CREATE OR REPLACE FUNCTION public.qbo_disconnect_operations_guard()";
    const guardDef = (text) => { const s = text.indexOf(GUARD_HEAD); return text.slice(s, text.indexOf("\n  $g$;\n", s) + 8); };
    const reviewedGuard = guardDef(migrationText(RESEAL));
    const hostedGuard = reviewedGuard.replace(REVIEWED_LINE, HOSTED_LINE);
    const bodySha = async () => (await db.one("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h from pg_proc where oid='public.qbo_disconnect_operations_guard()'::regprocedure")).h;
    const errOf = async (sql) => { try { await db.admin.query(sql); return "ok"; } catch (e) { return String(e.message).split("\n")[0]; } };
    // An envelope-only change (no new verification time) inside a block that always rolls back: "allowed" means the guard let it through.
    const envelopeOnly = async () => {
      const m = await errOf(`do $t$ begin update public.qbo_disconnect_operations set realm_envelope = realm_envelope || 'x' where connection_id = '${GO}'; raise exception 'ROLLED_BACK_AFTER_UPDATE'; end $t$`);
      return m.includes("ROLLED_BACK_AFTER_UPDATE") ? "allowed" : m.includes("QBO_DISCONNECT_IDENTITY_FIXED") ? "refused" : m;
    };
    await r.check("the repair is a no-op on a chain that applied 20261230400000 verbatim (reviewed body, envelope-only change refused)", async () => {
      const s = await snap();
      const before1 = await bodySha();
      await db.admin.query(migrationText(REPAIR));
      return hostedGuard !== reviewedGuard && before1 === GOOD && await bodySha() === GOOD && same(await snap(), s) && await envelopeOnly() === "refused" || { before1, differs: hostedGuard !== reviewedGuard };
    });
    await r.check("the hosted variant (digest d087625f…) lets an operation's envelope change without a new verification time", async () => {
      await db.admin.query(hostedGuard);
      return await bodySha() === BAD && await envelopeOnly() === "allowed" || { sha: await bodySha(), env: await envelopeOnly() };
    });
    await r.check("a transcription error in the repair itself fails its postcondition and changes nothing (the variant stays)", async () => {
      const mistyped = migrationText(REPAIR).replace(REVIEWED_LINE, REVIEWED_LINE.replace("NEW.realm_envelope IS DISTINCT", "NEW.realm_envelope  IS DISTINCT"));
      const m = await errOf(mistyped);
      return mistyped !== migrationText(REPAIR) && m.includes("POSTCONDITION") && await bodySha() === BAD || { m, sha: await bodySha() };
    });
    await r.check("an unexpected guard body is refused and left unchanged", async () => {
      await db.admin.query(hostedGuard.replace("RETURN NEW;", "RETURN NEW; -- other"));
      const other = await bodySha();
      const m = await errOf(migrationText(REPAIR));
      const ok = m.includes("PREFLIGHT_REFUSED: unexpected") && await bodySha() === other && other !== BAD && other !== GOOD;
      await db.admin.query(hostedGuard);
      return ok && await bodySha() === BAD || { m, other };
    });
    await r.check("the repair restores the reviewed body exactly (digest ab3855f4…), invoker, pinned search_path, trigger attached; no row changes", async () => {
      const s = await snap();
      await db.admin.query(migrationText(REPAIR));
      const p = await db.one("select prosecdef, proconfig from pg_proc where oid='public.qbo_disconnect_operations_guard()'::regprocedure");
      return await bodySha() === GOOD && p.prosecdef === false && same(p.proconfig, ["search_path=pg_catalog, public"]) && same(await snap(), s) || { sha: await bodySha(), p };
    });
    await r.check("after the repair an envelope-only change is refused again, and replaying the repair changes nothing", async () => {
      const s = await snap();
      const env = await envelopeOnly();
      await db.admin.query(migrationText(REPAIR));
      return env === "refused" && await bodySha() === GOOD && same(await snap(), s) || env;
    });
    await r.check("the reseal path still works after the repair: an operation moves to a further key k3 through qbo_reseal_disconnect_realm", async () => {
      const K3 = key("k3"), KEYS3 = { current: K3, all: [K3, K2, K1], index: IDX };
      const o = await db.one("select company_id, realm_id, realm_envelope, realm_index from public.qbo_disconnect_operations where connection_id=$1", [GO]);
      const p = await RP.protectRealm(o.realm_id, "sandbox", o.company_id, KEYS3);
      const out = (await svc("select public.qbo_reseal_disconnect_realm($1,$2,$3,$4,$5) o", [GO, o.realm_id, o.realm_envelope, p.envelope, o.realm_index])).o;
      const after = await db.one("select realm_envelope, realm_index from public.qbo_disconnect_operations where connection_id=$1", [GO]);
      return p.index === o.realm_index && out === "resealed" && kid(after.realm_envelope) === "k3" && after.realm_index === o.realm_index || { out, sameIndex: p.index === o.realm_index };
    });
    await r.check("the repair refuses when the reseal migration is absent (nothing changed)", async () => {
      await db.admin.query("alter function public.qbo_realm_key_coverage() rename to qbo_realm_key_coverage_hidden");
      const m = await errOf(migrationText(REPAIR));
      await db.admin.query("alter function public.qbo_realm_key_coverage_hidden() rename to qbo_realm_key_coverage");
      return m.includes("PREFLIGHT_REFUSED: the token-key reseal") && await bodySha() === GOOD || m;
    });
  } catch (e) {
    crashed = true;
    console.error("CRASH", e?.stack ?? e);
  } finally {
    await db.close();
  }
  process.exit(r.finish("QBO token-key reseal", crashed) ? 0 : 1);
}

await main();
