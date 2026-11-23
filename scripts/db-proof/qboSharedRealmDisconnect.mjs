#!/usr/bin/env node
// Real-PostgreSQL proof of 20261231400000 (a shared QuickBooks company no longer blocks a disconnect; launch blocker B1, 2026-11-23), applied
// over the full chain as hosted today (Phase C v2 complete). Reproduces the deadlock on the current body first, then proves through the REAL
// disconnect orchestration (supabase/functions/_shared/qboDisconnect.ts) with the REAL envelope modules that:
//   · every sharer can disconnect; while another active connection shares the realm the disconnect is local (token destroyed, no envelope sent,
//     nothing revoked at Intuit) and answered exactly like a token-less disconnect (tenant-neutral);
//   · the last active connection's disconnect revokes at Intuit exactly once, as before; a solo connection is unchanged;
//   · replays are idempotent, a second request is refused, simultaneous sharers serialise so exactly one revokes;
//   · no row ever holds a plaintext realm; nothing outside the disconnected connections and their operations changes;
//   · the migration refuses a mistyped installed body and an incomplete Phase C, replays as a no-op, and leaves the function service-only.
//
//   bun scripts/db-proof/qboSharedRealmDisconnect.mjs                                   (CI: DB_PROOF_MODE=external DB_PROOF_CONN=<loopback db>)
//   DB_PROOF_MODULES_DIR=<dir with embedded-postgres + pg> node scripts/db-proof/qboSharedRealmDisconnect.mjs   (local; Node >= 22.6 strips types)
// Loopback only; no Intuit, no hosted project, no secret: every key is random and lives only in this process.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, applyChainBefore, makeWorld, migrationText, reporter } from "./lib/reportingKit.mjs";

const RP = await import("../../supabase/functions/_shared/qboRealmProtection.ts");
const TE = await import("../../supabase/functions/_shared/qboTokenEnvelope.ts");
const { runQboDisconnect } = await import("../../supabase/functions/_shared/qboDisconnect.ts");
const { generate, TARGET, OLD_DIGEST } = await import("../release/genQboSharedRealmDisconnect.mjs");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FN = "public.qbo_begin_disconnect(uuid,uuid,uuid)";
const key = (id) => ({ id, bytes: new Uint8Array(crypto.randomBytes(32)) });
const KEYS = { current: key("k2"), all: [], index: key("idx2") };
KEYS.all = [KEYS.current];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const r = reporter();
  const db = await openDatabase("qbo_shared_realm_disconnect");
  let crashed = false;
  try {
    const failed = await applyChainBefore(db, TARGET);
    if (failed) throw new Error(`chain: ${failed}`);
    const w = await makeWorld(db);
    const C = await w.company(w.U.owner, "Third workspace"), D = await w.company(w.U.ownerB, "Fourth workspace");
    const svc = (s, p = []) => db.asService(s, p);
    const errOf = async (sql) => { try { await db.admin.query(sql); return ""; } catch (e) { return String(e.message); } };
    const digest = async () => (await db.one("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') d from pg_proc where oid = to_regprocedure($1)", [FN]))?.d ?? null;
    const SHARED = "9130353000000031", SOLO = "9130353000000032", PAIR = "9130353000000033", RACE = "9130353000000034";
    const store = async (company, actor, realm) => {   // after the cutover: protection only, as qbo-finish-connection stores it
      const p = await RP.protectRealm(realm, "sandbox", company, KEYS);
      const tok = await TE.sealSecret("rt-" + crypto.randomBytes(16).toString("hex"), KEYS.current, TE.connectionBinding(company, realm, "sandbox"));
      return (await svc("select public.qbo_store_connection($1,$2,null,'sandbox',$3,now()+interval '100 days',null,$4,$5) id", [company, actor, tok, p.envelope, p.index])).id;
    };
    const ALL = `select 'c' t, id::text k, company_id::text co, realm_id, realm_envelope, realm_index, refresh_token_envelope tok, status from public.qbo_connections
                 union all select 'o', connection_id::text, company_id::text, realm_id, realm_envelope, realm_index, pending_envelope, outcome from public.qbo_disconnect_operations order by 1, 2`;
    const snap = async () => (await db.admin.query(ALL)).rows;
    const conn = async (id) => db.one("select realm_id, refresh_token_envelope tok, status from public.qbo_connections where id=$1", [id]);
    const op = async (id) => db.one("select realm_id, realm_envelope, realm_index, pending_envelope, outcome, request_id from public.qbo_disconnect_operations where connection_id=$1", [id]);
    const begin = async (id, actor, req) => (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [id, actor, req])).r;
    // The deps of supabase/functions/qbo-disconnect/index.ts, with Intuit replaced by a recorder.
    const revoked = [];
    const deps = (actor) => ({
      authenticate: async () => actor,
      begin: async (id, a, request) => begin(id, a, request),
      realm: (connectionId, b) => RP.realmForOperation({ id: connectionId, company_id: b.companyId ?? "", environment: b.environment ?? "sandbox", realm_id: null,
        realm_envelope: b.realmEnvelope ?? null, realm_index: b.realmIndex ?? null }, KEYS, null),
      open: async (envelope, binding) => { try { return await TE.openSecret(envelope, KEYS.all, binding); } catch { return null; } },
      revoke: async (environment, token) => { revoked.push({ environment, token }); return true; },
      finish: async (id, a, request, lease) => (await svc("select public.qbo_finish_disconnect($1,$2,$3,$4) r", [id, a, request, lease])).r === true,
    });
    const disconnect = (actor, connectionId, requestId) => runQboDisconnect(deps(actor), { connectionId, requestId });

    // Three workspaces share one QuickBooks company (as on hosted: US 9355 in three workspaces); one solo connection.
    const SA = await store(w.A, w.U.owner, SHARED), SB = await store(w.B, w.U.ownerB, SHARED), SC = await store(C, w.U.owner, SHARED);
    const SO = await store(D, w.U.ownerB, SOLO);

    r.group("The defect on the body installed today (Phase C v2 part 2)");
    await r.check("the installed body is the reviewed part 2 body", async () => await digest() === OLD_DIGEST || await digest());
    await r.check("every sharer is refused 'shared_connection' (HTTP 409): none of three workspaces can ever disconnect; nothing changes", async () => {
      const before = await snap();
      const a = await disconnect(w.U.owner, SA, crypto.randomUUID()), b = await disconnect(w.U.ownerB, SB, crypto.randomUUID()), c = await disconnect(w.U.owner, SC, crypto.randomUUID());
      return [a, b, c].every((x) => x.status === 409 && x.outcome === "shared_connection") && same(await snap(), before) && revoked.length === 0 || { a, b, c };
    });

    r.group("The migration verifies itself");
    const text = migrationText(TARGET);
    await r.check("the committed file is exactly what its generator writes from the reviewed part 2 text", async () => generate().text === text);
    await r.check("a mistyped installed body is refused (PREFLIGHT_REFUSED) and nothing changes", async () => {
      const c = await db.pool.connect();
      try {
        await c.query("BEGIN");
        const def = (await c.query("select pg_get_functiondef($1::regprocedure) d", [FN])).rows[0].d;
        await c.query(def.replace("'request_conflict'", "'request_conflict' "));
        let m = ""; try { await c.query(text); } catch (e) { m = String(e.message); }
        await c.query("ROLLBACK");
        return m.includes("PREFLIGHT_REFUSED") && await digest() === OLD_DIGEST || m;
      } finally { c.release(); }
    });
    await r.check("an incomplete Phase C (the redaction's final rule absent) is refused and nothing changes", async () => {
      const c = await db.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("ALTER TABLE public.qbo_connections DROP CONSTRAINT chk_qbo_connections_live_no_plaintext");
        let m = ""; try { await c.query(text); } catch (e) { m = String(e.message); }
        await c.query("ROLLBACK");
        return m.includes("PREFLIGHT_REFUSED") && await digest() === OLD_DIGEST || m;
      } finally { c.release(); }
    });
    const rows0 = await snap();
    await r.check("applies; the body is the pinned one; SECURITY DEFINER, fixed search_path, service role only; no row changed", async () => {
      await db.admin.query(text);
      const f = await db.one("select prosecdef, proconfig from pg_proc where oid = to_regprocedure($1)", [FN]);
      const g = await db.one(`select has_function_privilege('authenticated',$1,'EXECUTE') a, has_function_privilege('anon',$1,'EXECUTE') n, has_function_privilege('service_role',$1,'EXECUTE') s`, [FN]);
      return await digest() === generate().newDigest && f.prosecdef && same(f.proconfig, ["search_path=pg_catalog, public"]) && !g.a && !g.n && g.s && same(await snap(), rows0) || { f, g };
    });
    await r.check("a replay is a no-op", async () => (await errOf(text)) === "" && await digest() === generate().newDigest && same(await snap(), rows0));
    await r.refused("an authenticated user still cannot call it directly", "42501",
      () => db.asUser(w.U.owner, "select public.qbo_begin_disconnect($1,$2,$3)", [SA, w.U.owner, crypto.randomUUID()]));

    r.group("Every sharer can disconnect; only the last revokes at Intuit");
    const reqA = crypto.randomUUID(), reqB = crypto.randomUUID(), reqC = crypto.randomUUID();
    let firstSharer = null;
    await r.check("first sharer: local disconnect, HTTP 202 'local_only', nothing sent to Intuit; its token destroyed; the other two untouched", async () => {
      const others = (await snap()).filter((x) => x.k !== SA);
      const x = await disconnect(w.U.owner, SA, reqA);
      firstSharer = x;
      const c = await conn(SA), o = await op(SA);
      return x.status === 202 && x.outcome === "local_only" && revoked.length === 0
        && c.status === "disconnected" && c.tok === null && c.realm_id === null
        && o.outcome === "local_only" && o.pending_envelope === null && o.realm_id === null && !!o.realm_envelope && !!o.realm_index
        && same((await snap()).filter((y) => y.k !== SA), others) || { x, c, o };
    });
    await r.check("the database answer carries no lease and no token envelope for a shared realm", async () => {
      const b = await begin(SA, w.U.owner, reqA);   // the idempotent replay of the same request returns the recorded operation
      return b.outcome === "local_only" && !b.envelope && !b.leaseId || b;
    });
    await r.check("second sharer: local as well (one other still active)", async () => {
      const x = await disconnect(w.U.ownerB, SB, reqB);
      return x.status === 202 && x.outcome === "local_only" && revoked.length === 0 && (await conn(SB)).tok === null && (await op(SB)).outcome === "local_only" || x;
    });
    await r.check("last sharer: revoked at Intuit exactly once with ITS OWN token, then finished ('revoked', HTTP 200)", async () => {
      const tokBefore = (await conn(SC)).tok;
      const x = await disconnect(w.U.owner, SC, reqC);
      const o = await op(SC);
      const own = await TE.openSecret(tokBefore, KEYS.all, TE.connectionBinding(C, SHARED, "sandbox"));
      return x.status === 200 && x.outcome === "disconnected" && revoked.length === 1 && revoked[0].token === own && o.outcome === "revoked" && o.pending_envelope === null
        && (await conn(SC)).status === "disconnected" || { x, o, n: revoked.length };
    });
    await r.check("replays of all three requests answer as before and revoke nothing again", async () => {
      const a = await disconnect(w.U.owner, SA, reqA), b = await disconnect(w.U.ownerB, SB, reqB), c = await disconnect(w.U.owner, SC, reqC);
      return a.outcome === "local_only" && b.outcome === "local_only" && c.outcome === "disconnected" && revoked.length === 1 || { a, b, c };
    });
    await r.check("a different request on a disconnected connection is refused (request_conflict) and changes nothing", async () => {
      const s = await snap(); const x = await disconnect(w.U.owner, SA, crypto.randomUUID());
      return x.status === 409 && x.outcome === "request_conflict" && same(await snap(), s) || x;
    });
    await r.check("another workspace's owner cannot disconnect a connection it has no right to (forbidden, HTTP 403) and nothing changes", async () => {
      const s = await snap(); const x = await disconnect(w.U.owner, SO, crypto.randomUUID());
      return x.status === 403 && x.outcome === "forbidden" && same(await snap(), s) && revoked.length === 1 || x;
    });

    r.group("Unshared connections are unchanged; the answer never distinguishes a shared realm");
    await r.check("a solo connection is revoked by its owner exactly as before (pending -> revoked, HTTP 200)", async () => {
      const x = await disconnect(w.U.ownerB, SO, crypto.randomUUID());
      return x.status === 200 && x.outcome === "disconnected" && (await op(SO)).outcome === "revoked" && revoked.length === 2 || x;
    });
    await r.check("a sharer needing reconnection (no token) is not counted: the other's disconnect revokes; its own is the same 'local_only' answer as a shared one", async () => {
      const P1 = await store(w.A, w.U.owner, PAIR), P2 = await store(w.B, w.U.ownerB, PAIR);
      await svc("select public.qbo_mark_reconnect_needed($1,$2)", [P1, (await conn(P1)).tok]);
      const n = revoked.length;
      const x = await disconnect(w.U.ownerB, P2, crypto.randomUUID());   // P1 is not active, so P2 is the last active connection: revoke
      const y = await disconnect(w.U.owner, P1, crypto.randomUUID());    // P1 holds no token: local
      return (await conn(P1)).status === "disconnected" && x.outcome === "disconnected" && revoked.length === n + 1
        && same(y, { status: 202, outcome: "local_only" }) && same(firstSharer, y) || { x, y, firstSharer };
    });

    r.group("Simultaneous sharers serialise on the realm lock: exactly one revokes");
    await r.check("two sharers disconnecting at the same moment: one local, one pending, never two revocations and never none", async () => {
      const R1 = await store(w.A, w.U.owner, RACE), R2 = await store(w.B, w.U.ownerB, RACE);
      const c1 = await db.pool.connect(), c2 = await db.pool.connect();
      try {
        await c1.query("BEGIN"); await c2.query("BEGIN");
        const a = (await c1.query("select public.qbo_begin_disconnect($1,$2,$3) r", [R1, w.U.owner, crypto.randomUUID()])).rows[0].r;   // holds the realm lock
        const pb = c2.query("select public.qbo_begin_disconnect($1,$2,$3) r", [R2, w.U.ownerB, crypto.randomUUID()]);
        await new Promise((res) => setTimeout(res, 300));
        await c1.query("COMMIT");
        const b = (await pb).rows[0].r; await c2.query("COMMIT");
        const outcomes = [a.outcome, b.outcome].sort();
        return same(outcomes, ["local_only", "pending"]) && a.outcome === "local_only" && b.outcome === "pending" && !!b.envelope || { a: a.outcome, b: b.outcome };
      } finally { c1.release(); c2.release(); }
    });

    r.group("Invariants");
    await r.check("no connection, operation or OAuth state written here holds a plaintext realm", async () =>
      (await db.one("select (select count(*) from public.qbo_connections where realm_id is not null) + (select count(*) from public.qbo_disconnect_operations where realm_id is not null) + (select count(*) from public.qbo_oauth_states where realm_id is not null) n")).n === "0");
    await r.check("every operation keeps the connection's realm protection (envelope and index); a local one never holds a pending envelope", async () =>
      (await db.one("select count(*) filter (where realm_envelope is null or realm_index is null) a, count(*) filter (where outcome = 'local_only' and pending_envelope is not null) b from public.qbo_disconnect_operations")).a === "0"
      && (await db.one("select count(*) filter (where outcome = 'local_only' and pending_envelope is not null) b from public.qbo_disconnect_operations")).b === "0");
    await r.check("every UPDATE and DELETE in the migration has a WHERE clause (PostgREST safeupdate)", async () => {
      const sql = text.replace(/\r\n/g, "\n").replace(/--[^\n]*/g, "");
      const bad = [...sql.matchAll(/\b(UPDATE\s+public\.\w+\s+SET|DELETE\s+FROM\s+public\.\w+)[\s\S]*?;/gi)].filter((m) => !/\bWHERE\b/i.test(m[0])).map((m) => m[0].slice(0, 80));
      return bad.length === 0 || bad;
    });
    await r.check("the migration file is LF-only and under the hosted migrator's verbatim limit", async () =>
      !fs.readFileSync(path.join(REPO, "supabase/migrations", TARGET)).includes(13) && Buffer.byteLength(text) < 20000);
  } catch (e) {
    crashed = true;
    console.error("CRASH", e?.stack ?? e);
  } finally {
    await db.close();
  }
  process.exit(r.finish("QBO shared-realm local disconnect", crashed) ? 0 : 1);
}

await main();
