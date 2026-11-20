#!/usr/bin/env node
// Real-PostgreSQL proof of the QuickBooks realm INDEX key rotation (20261230500000): every LIVE row's keyed realm index made by the retiring
// index key idx1 is moved onto an owner-held key idx2 while idx1 still recognises the old indexes, so nothing operational depends on idx1
// afterwards. The chain up to and including the token-key reseal and its guard repair is installed first; the data is written by the real
// Phase B service functions with REAL envelopes (AES-256-GCM under k2) and REAL HMAC indexes (idx1); the rotation runs through the REAL
// orchestration (supabase/functions/_shared/qboRealmBackfill.ts) with the REAL modules.
//
//   bun scripts/db-proof/qboRealmIndexRotation.mjs                                  (CI: DB_PROOF_MODE=external DB_PROOF_CONN=<loopback db>)
//   DB_PROOF_MODULES_DIR=<dir with embedded-postgres + pg> node scripts/db-proof/qboRealmIndexRotation.mjs   (local; Node >= 22.6 strips types)
//
// Loopback only; no Intuit, no hosted project, no secret: every key is random and lives only in this process.
import crypto from "node:crypto";
import { openDatabase, applyChainBefore, makeWorld, migrationText, reporter } from "./lib/reportingKit.mjs";

const RP = await import("../../supabase/functions/_shared/qboRealmProtection.ts");
const TE = await import("../../supabase/functions/_shared/qboTokenEnvelope.ts");
const { runRealmBackfill, decideMaintenanceAuthority } = await import("../../supabase/functions/_shared/qboRealmBackfill.ts");
const ROTATION = "20261230500000_qbo_realm_index_rotation.sql";
const key = (id) => ({ id, bytes: new Uint8Array(crypto.randomBytes(32)) });
const K2 = key("k2"), K3 = key("k3"), IDX1 = key("idx1"), IDX2 = key("idx2");
const OLD = { current: K2, all: [K2], index: IDX1 };                                 // today: idx1 makes and recognises every index
const NEXT = { current: K2, all: [K2], index: IDX2, indexAll: [IDX2, IDX1] };        // QBO_REALM_INDEX_KEY_NEXT_* = idx2; idx1 still recognises
const NEWONLY = { current: K2, all: [K2], index: IDX2 };                             // idx1 retired
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const iid = (i) => (i ?? "").split(".")[1];

const GUARDS = { conn: "db305b361f0dfc402501a21437dfe7282cbe95769eef8e3d3a95dc162d38d0c8", ops: "819623c9a8339c85513f4acf0c922629d9438f844cd2a99f6ceaa19918f4ce69" };
const BEFORE_GUARDS = { conn: "b3c9dcc9e504b27f60340fb3a77a97fe205bbf1e28704258b535d0f9897bc44a", ops: "ab3855f445f5d82b68f29dba324745752853a472ee065befdc207b15162099a0" };

async function main() {
  const r = reporter();
  const db = await openDatabase("qbo_realm_index_rotation");
  let crashed = false;
  try {
    const failed = await applyChainBefore(db, ROTATION);
    if (failed) throw new Error(`chain: ${failed}`);
    const w = await makeWorld(db);
    const svc = (s, p = []) => db.asService(s, p);
    const errOf = async (sql) => { try { await db.admin.query(sql); return ""; } catch (e) { return String(e.message); } };
    const bodies = async () => (await db.one(`select (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='public.qbo_connections_guard()'::regprocedure) conn,
      (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='public.qbo_disconnect_operations_guard()'::regprocedure) ops`));
    const installed = async () => (await db.one("select to_regprocedure('public.qbo_realm_index_coverage()') is not null ok")).ok;
    const SHARED = "9130351000000011", SOLO = "9130351000000012", GONE = "9130351000000014";
    const store = async (company, actor, realm, keys) => {
      const tokenEnv = await TE.sealSecret("rt-" + crypto.randomBytes(16).toString("hex"), keys.current, TE.connectionBinding(company, realm, "sandbox"));
      const p = await RP.protectRealm(realm, "sandbox", company, keys);
      return (await svc("select public.qbo_store_connection($1,$2,$3,'sandbox',$4,now()+interval '100 days',null,$5,$6) id", [company, actor, realm, tokenEnv, p.envelope, p.index])).id;
    };
    // Live: two workspaces share one QuickBooks company (as hosted today), one solo; one disconnected and revoked (its operation stays).
    const SA = await store(w.A, w.U.owner, SHARED, OLD), SB = await store(w.B, w.U.ownerB, SHARED, OLD);
    const SO = await store(w.A, w.U.owner, SOLO, OLD), GO = await store(w.B, w.U.ownerB, GONE, OLD);
    const begun = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [GO, w.U.ownerB, crypto.randomUUID()])).r;
    await svc("select public.qbo_finish_disconnect($1,$2,$3,$4)", [GO, w.U.ownerB, (await db.one("select request_id from public.qbo_disconnect_operations where connection_id=$1", [GO])).request_id, begun.leaseId]);

    await db.admin.query("insert into public.commercial_admins(user_id, active, authority) values ($1,true,'platform_owner')", [w.U.viewer]);
    const owner = () => decideMaintenanceAuthority("Bearer aaa.bbb.ccc", { userIdOf: async () => w.U.viewer, isPlatformOwner: async (u) => (await svc("select public.is_platform_owner($1) r", [u])).r });
    const depsOf = (wrap = {}) => ({
      authorize: owner,
      listConnections: async () => (await db.admin.query("select id, company_id, environment, realm_id, realm_envelope, realm_index, refresh_token_envelope from public.qbo_connections where status <> 'disconnected' order by created_at")).rows,
      listOperations: async () => (await db.admin.query("select connection_id as id, company_id, environment, realm_id, realm_envelope, realm_index from public.qbo_disconnect_operations order by created_at")).rows,
      protectConnection: async () => "invalid", protectOperation: async () => "invalid",
      verifyConnection: async (a) => (await svc("select public.qbo_verify_connection_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
      verifyOperation: async (a) => (await svc("select public.qbo_verify_disconnect_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
      status: async () => (await svc("select public.qbo_realm_protection_status() s")).s,
      resealConnection: async (a) => (await svc("select public.qbo_reseal_connection_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_expected_envelope, a.p_new_envelope, a.p_realm_index])).o,
      resealOperation: async (a) => (await svc("select public.qbo_reseal_disconnect_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_expected_envelope, a.p_new_envelope, a.p_realm_index])).o,
      resealToken: async (a) => (await svc("select public.qbo_reseal_refresh_token($1,$2,$3) o", [a.p_connection, a.p_expected_envelope, a.p_new_envelope])).o,
      coverage: async () => (await svc("select public.qbo_realm_key_coverage() c")).c,
      ...(wrap.noReindex ? {} : {
        reindexConnection: wrap.reindexConnection ?? (async (a) => (await svc("select public.qbo_reindex_connection_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_expected_index, a.p_new_index])).o),
        reindexOperation: async (a) => (await svc("select public.qbo_reindex_disconnect_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_expected_index, a.p_new_index])).o,
        indexCoverage: async () => (await svc("select public.qbo_realm_index_coverage() c")).c,
      }),
    });
    const run = (keys, action, wrap) => runRealmBackfill(depsOf(wrap), keys, { action });
    const ALL = "select 'c' t, id::text k, realm_id, realm_envelope, realm_index, realm_verified_at::text v, refresh_token_envelope tok, status from public.qbo_connections union all select 'o', connection_id::text, realm_id, realm_envelope, realm_index, realm_verified_at::text, pending_envelope, outcome from public.qbo_disconnect_operations union all select 's', id::text, realm_id, realm_envelope, realm_index, null, code_envelope, null from public.qbo_oauth_states order by 1,2";
    const snap = async () => (await db.admin.query(ALL)).rows;
    const conn = async (id) => db.one("select realm_envelope, realm_index, realm_id, refresh_token_envelope, realm_verified_at::text v from public.qbo_connections where id=$1", [id]);

    r.group("Before the migration: live rows indexed with idx1, the reseal guards installed");
    await r.check("every live connection and the revoked operation verify under idx1; the guards are the reviewed reseal/repair bodies", async () => {
      const v = await run(OLD, "verify", { noReindex: true });
      return v.status === 200 && v.connections.verified === 3 && v.operations.verified === 1 && same(await bodies(), BEFORE_GUARDS) || { v, b: await bodies() };
    });
    await r.check("without the migration the orchestration refuses to re-index (503 unavailable) and changes nothing", async () => {
      const x = await run(NEXT, "reindex", { noReindex: true });
      return x.status === 503 && !(await installed()) || x;
    });
    const before = await snap();

    r.group("Self-verification: a mistyped or unexpected installation changes nothing");
    await r.check("a migration whose guard body differs by one character fails its own postcondition; nothing is installed", async () => {
      const typo = migrationText(ROTATION).replace("AND NEW.realm_envelope IS NOT DISTINCT FROM OLD.realm_envelope AND NEW.realm_verified_at IS NOT NULL)) THEN\n        RAISE EXCEPTION 'QBO_DISCONNECT", "AND OLD.realm_envelope IS NOT DISTINCT FROM OLD.realm_envelope AND NEW.realm_verified_at IS NOT NULL)) THEN\n        RAISE EXCEPTION 'QBO_DISCONNECT");
      const m = typo === migrationText(ROTATION) ? "typo not applied" : await errOf(typo);
      return m.includes("POSTCONDITION: the QuickBooks index-key rotation is not installed exactly as reviewed") && !(await installed()) && same(await bodies(), BEFORE_GUARDS) && same(await snap(), before) || m;
    });
    await r.check("a guard that is not the reviewed reseal/repair body is refused before anything is changed", async () => {
      const c = await db.pool.connect();
      let m = "";
      try {
        await c.query("BEGIN");
        await c.query("CREATE OR REPLACE FUNCTION public.qbo_disconnect_operations_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $g$ BEGIN RETURN NEW; END; $g$");
        try { await c.query(migrationText(ROTATION)); } catch (e) { m = String(e.message); }
      } finally { await c.query("ROLLBACK"); c.release(); }
      return m.includes("PREFLIGHT_REFUSED: the realm guards are not the reviewed") && !(await installed()) && same(await bodies(), BEFORE_GUARDS) || m;
    });

    r.group("20261230500000 applied");
    await db.admin.query(migrationText(ROTATION));
    await r.check("no row changes; the guards are exactly the reviewed bodies", async () => same(await snap(), before) && same(await bodies(), GUARDS) || await bodies());
    await r.check("replay is a no-op", async () => { await db.admin.query(migrationText(ROTATION)); return same(await snap(), before) && same(await bodies(), GUARDS); });
    await r.check("a replay over unexpected guard bodies is refused", async () => {
      const c = await db.pool.connect();
      let m = "";
      try {
        await c.query("BEGIN");
        await c.query("CREATE OR REPLACE FUNCTION public.qbo_connections_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $g$ BEGIN RETURN NEW; END; $g$");
        try { await c.query(migrationText(ROTATION)); } catch (e) { m = String(e.message); }
      } finally { await c.query("ROLLBACK"); c.release(); }
      return m.includes("PREFLIGHT_REFUSED: the index rotation is installed with unexpected guard bodies") && same(await bodies(), GUARDS) || m;
    });
    await r.check("the three functions are executable by the service role only", async () => {
      const x = await db.one(`select has_function_privilege('service_role','public.qbo_reindex_connection_realm(uuid,text,text,text,text)','EXECUTE') a,
        has_function_privilege('authenticated','public.qbo_reindex_connection_realm(uuid,text,text,text,text)','EXECUTE') b, has_function_privilege('anon','public.qbo_reindex_disconnect_realm(uuid,text,text,text,text)','EXECUTE') c,
        has_function_privilege('authenticated','public.qbo_realm_index_coverage()','EXECUTE') d, has_function_privilege('service_role','public.qbo_reindex_disconnect_realm(uuid,text,text,text,text)','EXECUTE') e`);
      return x.a === true && x.b === false && x.c === false && x.d === false && x.e === true || x;
    });
    await r.refused("a member cannot call a re-index", "42501", () => db.asRole("authenticated", w.U.owner, "select public.qbo_reindex_connection_realm($1,'1','v1.k2.a.b','h1.idx1.x','h1.idx2.x')", [SA]));

    r.group("Guards: the protection is still written once, except the exact transitions inside the functions");
    const sa = await conn(SA);
    const idx2SA = await RP.realmIndex(SHARED, "sandbox", IDX2);
    const inTx = async (marker, sql, params) => {
      const c = await db.pool.connect();
      try { await c.query("BEGIN"); if (marker) await c.query("select set_config($1, $2, true)", marker); await c.query(sql, params); }
      finally { await c.query("ROLLBACK"); c.release(); }
    };
    await r.refused("a direct UPDATE of a connection's index (even by the superuser) is refused", "23001", () => db.admin.query("update public.qbo_connections set realm_index=$2, realm_verified_at=now() where id=$1", [SA, idx2SA]));
    await r.refused("a direct UPDATE of an operation's index is refused", "23001", () => db.admin.query("update public.qbo_disconnect_operations set realm_index=$2, realm_verified_at=now() where connection_id=$1", [GO, "h1.idx2." + "0".repeat(64)]));
    await r.refused("the reindex marker naming ANOTHER row does not open the guard", "23001", () => inTx(["qbo.realm_reindex", "connection:" + SB], "update public.qbo_connections set realm_index=$2, realm_verified_at=now() where id=$1", [SA, idx2SA]));
    await r.refused("with the right marker, an index under the SAME key is refused", "23001", () => inTx(["qbo.realm_reindex", "connection:" + SA], "update public.qbo_connections set realm_index=$2, realm_verified_at=now() where id=$1", [SA, "h1.idx1." + "0".repeat(64)]));
    await r.refused("with the right marker, changing the envelope too is refused", "23001", async () => inTx(["qbo.realm_reindex", "connection:" + SA], "update public.qbo_connections set realm_index=$2, realm_envelope=$3, realm_verified_at=now() where id=$1", [SA, idx2SA, await RP.sealRealm(SHARED, "sandbox", w.A, K3)]));
    await r.refused("the RESEAL marker cannot change an operation's index (now stated explicitly on the operation guard)", "23001", async () => {
      const o = await db.one("select company_id, realm_id from public.qbo_disconnect_operations where connection_id=$1", [GO]);
      return inTx(["qbo.realm_reseal", "operation:" + GO], "update public.qbo_disconnect_operations set realm_envelope=$2, realm_index=$3, realm_verified_at=now() where connection_id=$1", [GO, await RP.sealRealm(o.realm_id, "sandbox", o.company_id, K3), "h1.idx2." + "0".repeat(64)]);
    });
    await r.refused("an operation's identity still never changes", "23001", () => db.admin.query("update public.qbo_disconnect_operations set realm_id='9130351999999999' where connection_id=$1", [GO]));
    await r.check("the functions refuse: same key, wrong plaintext, a stale index, a stale envelope, a terminal connection, a malformed index; nothing changed", async () => {
      const call = async (id, realm, env, exp, nw) => (await svc("select public.qbo_reindex_connection_realm($1,$2,$3,$4,$5) o", [id, realm, env, exp, nw])).o;
      const g = await conn(GO);
      const got = [await call(SA, SHARED, sa.realm_envelope, sa.realm_index, "h1.idx1." + "3".repeat(64)),
        await call(SA, "9130351999999999", sa.realm_envelope, sa.realm_index, idx2SA), await call(SA, SHARED, sa.realm_envelope, "h1.idx1." + "1".repeat(64), idx2SA),
        await call(SA, SHARED, "v1.k2.AAAA.BBBB", sa.realm_index, idx2SA), await call(GO, GONE, g.realm_envelope, g.realm_index, "h1.idx2." + "0".repeat(64)),
        await call(SA, SHARED, sa.realm_envelope, sa.realm_index, "not-an-index"), await call(SA, SHARED, sa.realm_envelope, sa.realm_index, sa.realm_index)];
      return same(got, ["same_key", "realm_mismatch", "stale", "stale", "terminal_unchanged", "invalid", "already_reindexed"]) && same(await snap(), before) || got;
    });

    r.group("index_keys (read only) and the rotation window");
    await r.check("today's ring: every live index recognised under idx1; nothing is written", async () => {
      const x = await run(OLD, "index_keys");
      return x.status === 200 && same(x.connectionIndexes.byKey, { idx1: 3 }) && same(x.operationIndexes.byKey, { idx1: 1 })
        && x.database["live_index:idx1"] === 3 && x.database["operation_index:idx1"] === 1 && x.database["terminal_index:idx1"] === 1 && same(await snap(), before) || x;
    });
    await r.check("with the NEXT key configured, idx1 indexes are still recognised (key named by the index): nothing breaks before the move", async () => {
      const x = await run(NEXT, "index_keys");
      const resolved = await RP.resolveStoredRealm({ ...(await conn(SO)), company_id: w.A, environment: "sandbox" }, NEXT, { allowPlaintext: false });
      return x.status === 200 && same(x.connectionIndexes.byKey, { idx1: 3 }) && resolved.ok === true || { x, resolved };
    });
    await r.check("THE TRAP: if idx1 were removed BEFORE re-indexing, no live index is recognised (imports would be refused)", async () => {
      const x = await run(NEWONLY, "index_keys");
      return x.status === 409 && x.connectionIndexes.mismatched === 3 && x.operationIndexes.mismatched === 1 || x;
    });
    await r.refused("THE WINDOW: before re-indexing, a reconnect that computes an idx2 index is refused (QBO_REALM_INDEX_CONFLICT), so sandbox actions are frozen until the move", "23505",
      () => store(w.A, w.U.owner, SOLO, NEWONLY));

    r.group("reindex: every live row moves to idx2; envelopes, tokens and plaintext unchanged");
    await r.check("a concurrent change answers 'stale' (nothing overwritten) and the run reports incomplete", async () => {
      const x = await run(NEXT, "reindex", { reindexConnection: async (a) => (await svc("select public.qbo_reindex_connection_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, "h1.idx1." + "2".repeat(64), a.p_new_index])).o });
      return x.status === 409 && x.connectionIndexes.stale === 3 && x.operationIndexes.reindexed === 1 || x;
    });
    await r.check("the next run finishes: 3 connections re-indexed, the operation already done", async () => {
      const x = await run(NEXT, "reindex");
      return x.status === 200 && x.connectionIndexes.reindexed === 3 && x.operationIndexes.already === 1 && x.database["live_index:idx2"] === 3 && x.database["operation_index:idx2"] === 1 || x;
    });
    await r.check("envelopes, refresh tokens and plaintext are byte-identical; only index and verification time moved; the terminal connection keeps idx1", async () => {
      const after = await snap();
      const byKey = (rows) => new Map(rows.map((x) => [x.t + x.k, x]));
      const a = byKey(after), b = byKey(before);
      const ok = [...b.keys()].every((k) => { const x = a.get(k), y = b.get(k); return x && x.realm_id === y.realm_id && x.realm_envelope === y.realm_envelope && x.tok === y.tok && x.status === y.status
        && (x.t === "s" || (y.status === "disconnected" ? x.realm_index === y.realm_index : iid(x.realm_index) === "idx2" && x.v !== y.v)); });
      const term = await db.one("select realm_index from public.qbo_connections where id=$1", [GO]);
      return ok && iid(term.realm_index) === "idx1" && a.size === b.size || { after, before };
    });
    await r.check("the new index is exactly the HMAC idx2 makes for the same realm (the shared company still shares one index)", async () => {
      const a = await conn(SA), b = await conn(SB);
      return a.realm_index === idx2SA && b.realm_index === idx2SA || { a: a.realm_index, b: b.realm_index };
    });
    await r.check("repeating is a no-op", async () => {
      const s = await snap();
      const x = await run(NEXT, "reindex");
      return x.status === 200 && x.connectionIndexes.already === 3 && x.operationIndexes.already === 1 && same(await snap(), s) || x;
    });
    await r.check("after the move idx1 can be dropped from the ring: everything resolves and verifies under idx2 alone", async () => {
      const x = await run(NEWONLY, "index_keys");
      const v = await run(NEWONLY, "verify");
      return x.status === 200 && same(x.connectionIndexes.byKey, { idx2: 3 }) && v.status === 200 && v.connections.verified === 3 && v.operations.verified === 1 || { x, v };
    });
    await r.check("a reconnect after the move computes the same idx2 index and is accepted", async () => {
      const id = await store(w.A, w.U.owner, SOLO, NEWONLY);
      return id === SO || id;
    });
    await r.check("the token-key reseal still works after this migration: a connection and the operation move to k3, index unchanged", async () => {
      const K3RING = { current: K3, all: [K3, K2], index: IDX2 };
      const x = await run(K3RING, "reseal");
      const a = await conn(SA);
      return x.status === 200 && x.connectionRealms.resealed === 3 && x.operationRealms.resealed === 1 && (a.realm_envelope ?? "").split(".")[1] === "k3" && a.realm_index === idx2SA || x;
    });
    await r.check("a historical row (terminal connection) can never be re-indexed: the function answers terminal_unchanged", async () => {
      const g = await conn(GO);
      const o = (await svc("select public.qbo_reindex_connection_realm($1,$2,$3,$4,$5) o", [GO, GONE, g.realm_envelope, g.realm_index, "h1.idx2." + "0".repeat(64)])).o;
      return o === "terminal_unchanged" || o;
    });

  } catch (e) {
    crashed = true;
    console.error("CRASH", e?.stack ?? e);
  } finally {
    await db.close();
  }
  process.exit(r.finish("QBO realm index-key rotation", crashed) ? 0 : 1);
}

await main();
