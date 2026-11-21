#!/usr/bin/env node
// Real-PostgreSQL ADVERSARIAL proof of QuickBooks realmID protection Phase C v2 (20261231100000, 200000, 250000, 300000) applied over the full chain as
// hosted today (Phases A/B, the token-key reseal 20261230400000, its guard repair 20261230410000 and the index-key rotation 20261230500000), and of
// the property v1 (PR #282) lost: AFTER the plaintext realm is removed, the token key (k2 -> k3) and the index key (idx2 -> idx3) can still be
// rotated, forwards only, through the REAL orchestration (supabase/functions/_shared/qboRealmBackfill.ts) with the REAL modules, and every rule
// holds while a rotation is half done (index-key homogeneity), after an interruption, and against downgrades, stale or cross-tenant submissions,
// forged keys, unauthorised roles, mistyped migrations and plaintext reintroduction. Terminal connections keep their plaintext and never change.
//
//   bun scripts/db-proof/qboRealmCutoverRotation.mjs                                  (CI: DB_PROOF_MODE=external DB_PROOF_CONN=<loopback db>)
//   DB_PROOF_MODULES_DIR=<dir with embedded-postgres + pg> node scripts/db-proof/qboRealmCutoverRotation.mjs   (local; Node >= 22.6 strips types)
//
// Loopback only; no Intuit, no hosted project, no secret: every key is random and lives only in this process. Nothing here proves anything about
// the hosted database; the hosted pre-checks are in docs/release/qbo-realm-protection-r1/README.md.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, applyChainBefore, makeWorld, migrationText, reporter } from "./lib/reportingKit.mjs";
import { replayRedaction } from "./lib/qboRedactionReplay.mjs";

const RP = await import("../../supabase/functions/_shared/qboRealmProtection.ts");
const TE = await import("../../supabase/functions/_shared/qboTokenEnvelope.ts");
const { runRealmBackfill, decideMaintenanceAuthority } = await import("../../supabase/functions/_shared/qboRealmBackfill.ts");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CUTOVER_V2 = ["20261231100000_qbo_realm_protection_cutover_schema.sql", "20261231200000_qbo_realm_protection_cutover_functions.sql",
  "20261231250000_qbo_realm_rotation_post_redaction.sql", "20261231300000_qbo_realm_protection_cutover_redaction.sql"];
const [P1, P2, P3, P4] = CUTOVER_V2;
const key = (id) => ({ id, bytes: new Uint8Array(crypto.randomBytes(32)) });
const K2 = key("k2"), K3 = key("k3"), IDX2 = key("idx2"), IDX3 = key("idx3"), STRANGER = key("k4");
const TODAY = { current: K2, all: [K2], index: IDX2 };                                         // as hosted after 21 Nov: k2 seals, idx2 indexes
const TOKEN_ROT = { current: K3, all: [K3, K2], index: IDX2 };                                 // QBO_TOKEN_KEY_NEXT_* = k3
const INDEX_ROT = { current: K3, all: [K3, K2], index: IDX3, indexAll: [IDX3, IDX2] };         // QBO_REALM_INDEX_KEY_NEXT_* = idx3
const AFTER = { current: K3, all: [K3], index: IDX3 };                                         // k2 and idx2 retired from the ring
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const kid = (e) => (e ?? "").split(".")[1];
const one = (s) => s.replace(/\r\n/g, "\n");

async function main() {
  const r = reporter();
  const db = await openDatabase("qbo_realm_cutover_rotation");
  let crashed = false;
  try {
    const failed = await applyChainBefore(db, P1);
    if (failed) throw new Error(`chain: ${failed}`);
    const w = await makeWorld(db);
    const svc = (s, p = []) => db.asService(s, p);
    const errOf = async (sql) => { try { await db.admin.query(sql); return ""; } catch (e) { return String(e.message); } };
    const digest = async (fn) => (await db.one("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') d from pg_proc where oid = to_regprocedure($1)", [fn]))?.d ?? null;
    const SHARED = "9130352000000021", SOLO = "9130352000000022", PEND = "9130352000000023", GONE = "9130352000000024", LATE = "9130352000000025";
    const tokenFor = (company, realm, keys) => TE.sealSecret("rt-" + crypto.randomBytes(16).toString("hex"), keys.current, TE.connectionBinding(company, realm, "sandbox"));
    const storeB = async (company, actor, realm, keys) => {   // Phase B (as hosted today): plaintext plus protection
      const p = await RP.protectRealm(realm, "sandbox", company, keys);
      return (await svc("select public.qbo_store_connection($1,$2,$3,'sandbox',$4,now()+interval '100 days',null,$5,$6) id", [company, actor, realm, await tokenFor(company, realm, keys), p.envelope, p.index])).id;
    };
    const storeC = async (company, actor, realm, keys) => {   // after the cutover: protection only
      const p = await RP.protectRealm(realm, "sandbox", company, keys);
      return (await svc("select public.qbo_store_connection($1,$2,null,'sandbox',$3,now()+interval '100 days',null,$4,$5) id", [company, actor, await tokenFor(company, realm, keys), p.envelope, p.index])).id;
    };
    // Live as hosted: two workspaces share one QuickBooks company, one solo; one disconnect begun whose revocation is still pending (the connection
    // is terminal at once, its operation pending); one disconnected and revoked (terminal; its operation finished).
    const SA = await storeB(w.A, w.U.owner, SHARED, TODAY), SB = await storeB(w.B, w.U.ownerB, SHARED, TODAY);
    const SO = await storeB(w.A, w.U.owner, SOLO, TODAY), PO = await storeB(w.B, w.U.ownerB, PEND, TODAY), GO = await storeB(w.A, w.U.owner, GONE, TODAY);
    const pend = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [PO, w.U.ownerB, crypto.randomUUID()])).r;
    const gone = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [GO, w.U.owner, crypto.randomUUID()])).r;
    await svc("select public.qbo_finish_disconnect($1,$2,$3,$4)", [GO, w.U.owner, (await db.one("select request_id from public.qbo_disconnect_operations where connection_id=$1", [GO])).request_id, gone.leaseId]);

    await db.admin.query("insert into public.commercial_admins(user_id, active, authority) values ($1,true,'platform_owner')", [w.U.viewer]);
    const owner = () => decideMaintenanceAuthority("Bearer aaa.bbb.ccc", { userIdOf: async () => w.U.viewer, isPlatformOwner: async (u) => (await svc("select public.is_platform_owner($1) r", [u])).r });
    const exists = async (fn) => (await db.one("select to_regprocedure($1) is not null ok", [fn])).ok;
    // The same dependency wiring as supabase/functions/qbo-realm-protect/index.ts: rows listed by the service role; after the cutover the selects
    // never include realm_id and the protect/verify writers are absent.
    const depsOf = async (wrap = {}) => {
      const cut = !(await exists("public.qbo_verify_connection_realm(uuid,text,text,text)"));
      const cols = cut ? "id, company_id, environment, realm_envelope, realm_index, refresh_token_envelope" : "id, company_id, environment, realm_id, realm_envelope, realm_index, refresh_token_envelope";
      const opCols = cut ? "connection_id as id, company_id, environment, realm_envelope, realm_index" : "connection_id as id, company_id, environment, realm_id, realm_envelope, realm_index";
      const norm = (rows) => cut ? rows.map((x) => ({ ...x, realm_id: null })) : rows;
      const rpc = (fn, n) => async (a) => (await svc(`select public.${fn}(${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(",")}) o`, Object.values(a))).o;
      return {
        authorize: owner,
        listConnections: async () => norm((await db.admin.query(`select ${cols} from public.qbo_connections where status <> 'disconnected' order by created_at`)).rows),
        listOperations: async () => norm((await db.admin.query(`select ${opCols} from public.qbo_disconnect_operations order by created_at`)).rows),
        ...(cut ? {} : {
          protectConnection: async () => "invalid", protectOperation: async () => "invalid",
          verifyConnection: async (a) => (await svc("select public.qbo_verify_connection_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
          verifyOperation: async (a) => (await svc("select public.qbo_verify_disconnect_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
        }),
        status: async () => (await svc("select public.qbo_realm_protection_status() s")).s,
        resealConnection: wrap.resealConnection ?? (async (a) => (await svc("select public.qbo_reseal_connection_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_expected_envelope, a.p_new_envelope, a.p_realm_index])).o),
        resealOperation: async (a) => (await svc("select public.qbo_reseal_disconnect_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_expected_envelope, a.p_new_envelope, a.p_realm_index])).o,
        resealToken: rpc("qbo_reseal_refresh_token", 3),
        coverage: async () => (await svc("select public.qbo_realm_key_coverage() c")).c,
        reindexConnection: wrap.reindexConnection ?? (async (a) => (await svc("select public.qbo_reindex_connection_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_expected_index, a.p_new_index])).o),
        reindexOperation: async (a) => (await svc("select public.qbo_reindex_disconnect_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_expected_index, a.p_new_index])).o,
        indexCoverage: async () => (await svc("select public.qbo_realm_index_coverage() c")).c,
      };
    };
    const run = async (keys, action, wrap) => runRealmBackfill(await depsOf(wrap), keys, { action });
    const ALL = "select 'c' t, id::text k, realm_id, realm_envelope, realm_index, realm_verified_at::text v, refresh_token_envelope tok, status from public.qbo_connections union all select 'o', connection_id::text, realm_id, realm_envelope, realm_index, realm_verified_at::text, pending_envelope, outcome from public.qbo_disconnect_operations union all select 's', id::text, realm_id, realm_envelope, realm_index, null, code_envelope, null from public.qbo_oauth_states order by 1,2";
    const snap = async () => (await db.admin.query(ALL)).rows;
    const conn = async (id) => db.one("select realm_id, realm_envelope, realm_index, refresh_token_envelope, realm_verified_at::text v, status from public.qbo_connections where id=$1", [id]);
    const op = async (id) => db.one("select realm_id, realm_envelope, realm_index, outcome from public.qbo_disconnect_operations where connection_id=$1", [id]);
    const terminal = async () => ({ c: await conn(GO), o: await op(GO) });
    const LIVE = [SA, SB, SO];
    const mixed = async (k) => (await db.one("select public.qbo_index_key_mixed($1) m", [k])).m;

    r.group("Before Phase C: the hosted state (k2, idx2), every live row verified");
    await r.check("every live connection and both operations verify; the guards are the reviewed 20261230500000 bodies", async () => {
      const v = await run(TODAY, "verify");
      return v.status === 200 && v.connections.verified === 3 && v.operations.verified === 2
        && await digest("public.qbo_connections_guard()") === "db305b361f0dfc402501a21437dfe7282cbe95769eef8e3d3a95dc162d38d0c8"
        && await digest("public.qbo_disconnect_operations_guard()") === "819623c9a8339c85513f4acf0c922629d9438f844cd2a99f6ceaa19918f4ce69" && pend.outcome === "pending" || v;
    });
    const before = await snap();
    const term0 = await terminal();

    r.group("Order and self-verification: nothing applies out of order or mistyped, and a refusal changes nothing");
    await r.check("parts 2, 3 and 4 before part 1 are refused (PREFLIGHT_REFUSED) and change nothing", async () => {
      for (const f of [P2, P3, P4]) { const m = await errOf(migrationText(f)); if (!m.includes("PREFLIGHT_REFUSED")) return { f, m }; }
      return same(await snap(), before);
    });
    await r.check("part 1 with ONE character changed in a guard body fails its own postcondition: no constraint, no helper, guards unchanged", async () => {
      const text = migrationText(P1), bad = text.replace("never back, never another value.", "never back, never another value!");
      const m = bad === text ? "typo not applied" : await errOf(bad);
      return m.includes("POSTCONDITION") && !(await exists("public.qbo_key_version(text,text)")) && !(await exists("public.qbo_index_key_mixed(text)"))
        && await digest("public.qbo_connections_guard()") === "db305b361f0dfc402501a21437dfe7282cbe95769eef8e3d3a95dc162d38d0c8" && same(await snap(), before) || m;
    });
    await r.check("part 1 over guards that are not the reviewed 20261230500000 bodies is refused", async () => {
      const c = await db.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("CREATE OR REPLACE FUNCTION public.qbo_disconnect_operations_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $g$ BEGIN RETURN NEW; END; $g$");
        let m = ""; try { await c.query(migrationText(P1)); } catch (e) { m = String(e.message); }
        return m.includes("PREFLIGHT_REFUSED") || m;
      } finally { await c.query("ROLLBACK"); c.release(); }
    });
    await db.admin.query(migrationText(P1));
    await r.check("part 1 applied: no row changed; part 3 or 4 before part 2 is refused", async () => {
      for (const f of [P3, P4]) { const m = await errOf(migrationText(f)); if (!m.includes("PREFLIGHT_REFUSED")) return { f, m }; }
      return same(await snap(), before);
    });
    await db.admin.query(migrationText(P2));
    await r.check("part 2 applied: the redaction (part 4) is refused while the post-redaction rotation (part 3) is not installed", async () => {
      const m = await errOf(migrationText(P4));
      return m.includes("PREFLIGHT_REFUSED") && m.includes("Phase C v2 functions") && same(await snap(), before) || m;
    });
    const oldReseal = await digest("public.qbo_reseal_connection_realm(uuid,text,text,text,text)");
    await r.check("part 3 with one character changed in a rotation body fails its own postcondition: the previous bodies stay", async () => {
      const text = migrationText(P3), bad = text.replace("RETURN 'downgrade'; END IF;\n    PERFORM set_config('qbo.realm_reseal', 'connection:'", "RETURN 'downgrade';  END IF;\n    PERFORM set_config('qbo.realm_reseal', 'connection:'");
      const m = bad === text ? "typo not applied" : await errOf(bad);
      return m.includes("POSTCONDITION") && await digest("public.qbo_reseal_connection_realm(uuid,text,text,text,text)") === oldReseal || m;
    });
    await db.admin.query(migrationText(P3));
    await db.admin.query(migrationText(P4));
    await r.check("each of the four parts replayed is a no-op", async () => { const s = await snap(); for (const f of CUTOVER_V2) await db.admin.query(migrationText(f)); return same(await snap(), s); });

    r.group("Redacted: no live plaintext; historical evidence (terminal connections, finished operations) unchanged");
    await r.check("no live connection and no PENDING disconnect operation holds a plaintext realm; every protection is unchanged and still opens", async () => {
      for (const id of LIVE) { const c = await conn(id), b = before.find((x) => x.t === "c" && x.k === id); if (c.realm_id !== null || c.realm_envelope !== b.realm_envelope || c.realm_index !== b.realm_index) return id; }
      return (await op(PO)).realm_id === null && (await op(PO)).outcome === "pending" || "pending op";
    });
    await r.check("the FINISHED disconnect operation (revoked) is historical evidence: its plaintext and protection are byte-identical", async () => {
      const o = await op(GO), b = before.find((x) => x.t === "o" && x.k === GO);
      return o.realm_id === GONE && o.outcome === "revoked" && o.realm_envelope === b.realm_envelope && o.realm_index === b.realm_index || o;
    });
    await r.check("the redaction executed in full once more on seeded pre-redaction rows (rolled back): live plaintext removed, history byte-identical", async () => {
      const s0 = await snap();
      const c = await db.pool.connect();
      try {
        await c.query("BEGIN");
        const x = await replayRedaction(c, { migrationSql: migrationText(P4), protect: (realm) => RP.protectRealm(realm, "sandbox", w.A, TODAY),
          sealToken: (realm) => tokenFor(w.A, realm, TODAY), companyId: w.A, actorId: w.U.owner });
        await c.query("ROLLBACK");
        return x.ok && same(await snap(), s0) || x.detail;
      } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
    });
    await r.check("the redaction refuses when a body it depends on was changed after part 3 (the store function), and changes nothing", async () => {
      const c = await db.pool.connect();
      try {
        await c.query("BEGIN");
        for (const [t, k] of [["qbo_connections", "chk_qbo_connections_live_no_plaintext"], ["qbo_disconnect_operations", "chk_qbo_disconnect_operations_no_plaintext"], ["qbo_oauth_states", "chk_qbo_oauth_states_no_plaintext"]]) await c.query(`ALTER TABLE public.${t} DROP CONSTRAINT ${k}`);
        const def = (await c.query("select pg_get_functiondef('public.qbo_store_connection(uuid,uuid,text,text,text,timestamptz,timestamptz,text,text)'::regprocedure) d")).rows[0].d;
        await c.query(def.replace("QBO_INDEX_ROTATION_IN_PROGRESS: an index-key rotation", "QBO_INDEX_ROTATION_IN_PROGRESS: an index key rotation"));
        let m = ""; try { await c.query(migrationText(P4)); } catch (e) { m = String(e.message); }
        return m.includes("PREFLIGHT_REFUSED") || m;
      } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
    });
    await r.check("the terminal (disconnected) connections keep their plaintext and protection, unchanged", async () => {
      const t = await terminal(), p = await conn(PO);
      return same(t.c, term0.c) && t.c.realm_id === GONE && p.realm_id === PEND && same(p, (({ realm_id, realm_envelope, realm_index, refresh_token_envelope, v, status }) => ({ realm_id, realm_envelope, realm_index, refresh_token_envelope, v, status }))({ ...before.find((x) => x.t === "c" && x.k === PO), refresh_token_envelope: before.find((x) => x.t === "c" && x.k === PO).tok })) || { t, p };
    });
    await r.refused("a plaintext can never come back to a live row, even through the superuser", "23001", () => db.admin.query("update public.qbo_connections set realm_id=$2 where id=$1", [SA, SHARED]));
    await r.refused("nor to a disconnect operation", "23001", () => db.admin.query("update public.qbo_disconnect_operations set realm_id=$2 where connection_id=$1", [PO, PEND]));

    r.group("Token-key rotation k2 -> k3 AFTER the redaction, through the real orchestration");
    await r.check("an interrupted run (the service fails after the first row) leaves every row either moved or untouched, never half-written", async () => {
      let n = 0;
      const x = await run(TOKEN_ROT, "reseal", { resealConnection: async (a) => { if (n++ > 0) throw new Error("connection lost"); return (await svc("select public.qbo_reseal_connection_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_expected_envelope, a.p_new_envelope, a.p_realm_index])).o; } });
      const ks = await Promise.all(LIVE.map(async (id) => kid((await conn(id)).realm_envelope)));
      return x.status === 409 && x.connectionRealms.resealed === 1 && x.connectionRealms.refused === 2 && ks.filter((k) => k === "k3").length === 1 && ks.filter((k) => k === "k2").length === 2 || { x, ks };
    });
    await r.check("the retry completes: every live realm envelope, refresh token and operation envelope is on k3; realm_id stays NULL; the index is unchanged", async () => {
      const x = await run(TOKEN_ROT, "reseal");
      for (const id of LIVE) {
        const c = await conn(id), b = before.find((y) => y.t === "c" && y.k === id);
        if (kid(c.realm_envelope) !== "k3" || kid(c.refresh_token_envelope) !== "k3" || c.realm_id !== null || c.realm_index !== b.realm_index) return { id, c };
      }
      for (const id of [PO, GO]) if (kid((await op(id)).realm_envelope) !== "k3") return `op ${id}`;
      return x.status === 200 && x.connectionRealms.already === 1 && x.connectionRealms.resealed === 2 || x;
    });
    await r.check("each new envelope opens under k3 ALONE to the same realm, bound to its own workspace only", async () => {
      const a = await conn(SA), b = await conn(SB);
      return await RP.openRealm(a.realm_envelope, "sandbox", w.A, [K3]) === SHARED && await RP.openRealm(b.realm_envelope, "sandbox", w.B, [K3]) === SHARED
        && await RP.openRealm(a.realm_envelope, "sandbox", w.B, [K3]).then(() => false, () => true);
    });
    await r.check("a second run is a no-op (already on k3)", async () => { const s = await snap(); const x = await run(TOKEN_ROT, "reseal"); return x.status === 200 && same(await snap(), s) || x; });
    await r.check("the terminal connection was never touched", async () => same((await terminal()).c, term0.c));
    const a3 = await conn(SA);
    await r.check("downgrades are refused by the database: back to k2, a same-version rewrite, or an unversioned key -> 'downgrade', nothing changes", async () => {
      const back = await RP.sealRealm(SHARED, "sandbox", w.A, K2), again = await RP.sealRealm(SHARED, "sandbox", w.A, K3);
      const odd = await RP.sealRealm(SHARED, "sandbox", w.A, { id: "kx", bytes: K3.bytes });
      const outs = [];
      for (const e of [back, again, odd]) outs.push((await svc("select public.qbo_reseal_connection_realm($1,null,$2,$3,$4) o", [SA, a3.realm_envelope, e, a3.realm_index])).o);
      const tok = (await svc("select public.qbo_reseal_refresh_token($1,$2,$3) o", [SA, a3.refresh_token_envelope, await tokenFor(w.A, SHARED, TODAY)])).o;
      return same(outs, ["downgrade", "downgrade", "downgrade"]) && tok === "downgrade" && same(await conn(SA), a3) || { outs, tok };
    });
    await r.check("a stale or cross-tenant submission is refused: another row's expected envelope -> 'stale'; a plaintext offered for comparison -> 'realm_mismatch'", async () => {
      const b3 = await conn(SB), next = await RP.sealRealm(SHARED, "sandbox", w.A, key("k5"));
      const stale = (await svc("select public.qbo_reseal_connection_realm($1,null,$2,$3,$4) o", [SA, b3.realm_envelope, next, a3.realm_index])).o;
      const plain = (await svc("select public.qbo_reseal_connection_realm($1,$2,$3,$4,$5) o", [SA, SHARED, a3.realm_envelope, next, a3.realm_index])).o;
      return stale === "stale" && plain === "realm_mismatch" && same(await conn(SA), a3) || { stale, plain };
    });
    await r.refused("the guard itself refuses an older key even inside the reseal marker (the superuser, bypassing the function)", "23001", async () => {
      const c = await db.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("select set_config('qbo.realm_reseal', 'connection:' || $1::text, true)", [SA]);
        await c.query("update public.qbo_connections set realm_envelope=$2, realm_verified_at=clock_timestamp() where id=$1", [SA, await RP.sealRealm(SHARED, "sandbox", w.A, K2)]);
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    });
    await r.check("a process holding the wrong keys reads nothing and submits nothing (unreadable), the database unchanged", async () => {
      const s = await snap();
      const x = await run({ current: STRANGER, all: [STRANGER], index: IDX2 }, "reseal");
      return x.status === 409 && x.connectionRealms.unreadable === 3 && x.connectionRealms.resealed === 0 && same(await snap(), s) || x;
    });

    r.group("Index-key rotation idx2 -> idx3 AFTER the redaction; homogeneity while it is half done");
    const idx2 = Object.fromEntries(await Promise.all(LIVE.map(async (id) => [id, (await conn(id)).realm_index])));
    await r.check("a run that moves only the first connection leaves the indexes mixed, and the database says so", async () => {
      const x = await run(INDEX_ROT, "reindex", { reindexConnection: async (a) => a.p_connection === SA ? (await svc("select public.qbo_reindex_connection_realm($1,$2,$3,$4,$5) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_expected_index, a.p_new_index])).o : "interrupted" });
      return x.status === 409 && kid((await conn(SA)).realm_index) === "idx3" && kid((await conn(SB)).realm_index) === "idx2" && await mixed("idx3") && await mixed("idx2") || x;
    });
    await r.check("THE v1 HAZARD is real here: the two workspaces sharing one QuickBooks company no longer have equal indexes", async () => (await conn(SA)).realm_index !== (await conn(SB)).realm_index);
    await r.check("so a disconnect of the other sharer is refused as rotation_in_progress (not treated as unshared and revoked); nothing changes", async () => {
      const s = await snap();
      const b = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [SB, w.U.ownerB, crypto.randomUUID()])).r;
      return b.outcome === "rotation_in_progress" && same(await snap(), s) || b;
    });
    await r.refused("a reconnect under the NEW index key is refused while mixed (it could duplicate a live row)", "PT409", () => storeC(w.B, w.U.ownerB, SHARED, INDEX_ROT), "QBO_INDEX_ROTATION_IN_PROGRESS");
    await r.refused("a reconnect under the OLD index key is refused too", "PT409", () => storeC(w.A, w.U.owner, SOLO, TOKEN_ROT), "QBO_INDEX_ROTATION_IN_PROGRESS");
    await r.check("a re-index waits for a connect or disconnect in flight (the shared/exclusive lock), never commits inside it", async () => {
      const holder = await db.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("select pg_advisory_xact_lock_shared(hashtextextended('qbo-index-rotation', 0))");
        const b = await conn(SB), next = await RP.realmIndex(SHARED, "sandbox", IDX3);
        let done = false;
        const p = svc("select public.qbo_reindex_connection_realm($1,null,$2,$3,$4) o", [SB, b.realm_envelope, b.realm_index, next]).then((x) => { done = true; return x.o; });
        await new Promise((res) => setTimeout(res, 300));
        const waited = done === false;
        await holder.query("COMMIT");
        return waited && await p === "reindexed" || { waited };
      } finally { await holder.query("ROLLBACK").catch(() => undefined); holder.release(); }
    });
    await r.check("the retry completes: every live connection and both operations on idx3; envelopes and tokens unchanged; no longer mixed", async () => {
      const envs = Object.fromEntries(await Promise.all(LIVE.map(async (id) => [id, (await conn(id)).realm_envelope])));
      const x = await run(INDEX_ROT, "reindex");
      for (const id of LIVE) { const c = await conn(id); if (kid(c.realm_index) !== "idx3" || c.realm_envelope !== envs[id] || c.realm_id !== null) return { id, c }; }
      for (const id of [PO, GO]) if (kid((await op(id)).realm_index) !== "idx3") return `op ${id}`;
      return x.status === 200 && !(await mixed("idx3")) || x;
    });
    await r.check("the new index is exactly HMAC(idx3) of the realm; the sharers' indexes are equal again", async () =>
      (await conn(SA)).realm_index === await RP.realmIndex(SHARED, "sandbox", IDX3) && (await conn(SA)).realm_index === (await conn(SB)).realm_index && idx2[SA] !== (await conn(SA)).realm_index);
    await r.check("now the sharer's disconnect is refused as shared_connection (the sharer is found by its index) and the reconnect finds the SAME row", async () => {
      const b = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [SB, w.U.ownerB, crypto.randomUUID()])).r;
      const id = await storeC(w.A, w.U.owner, SHARED, AFTER);
      return b.outcome === "shared_connection" && id === SA || { b, id };
    });
    await r.check("a pending revocation still blocks reconnecting that company in any workspace, found by its idx3 index", async () => {
      try { await storeC(w.A, w.U.owner, PEND, AFTER); return "stored"; } catch (e) { return /QBO_REVOKE_PENDING/.test(e.message) || e.message; }
    });
    await r.refused("the database still refuses a second live row for the same (workspace, index, environment)", "23505", async () => {
      const a = await conn(SA);
      await db.admin.query("insert into public.qbo_connections (company_id, connected_by_user_id, environment, refresh_token_envelope, envelope_key_id, refresh_expires_at, realm_envelope, realm_index) values ($1,$2,'sandbox',$3,'k3',now()+interval '1 day',$4,$5)",
        [w.A, w.U.owner, await tokenFor(w.A, SHARED, AFTER), a.realm_envelope, a.realm_index]);
    });
    await r.check("index downgrades are refused: back to idx2, or an unversioned index key -> 'downgrade'", async () => {
      const a = await conn(SA);
      const outs = [];
      for (const k of [IDX2, { id: "idxz", bytes: IDX3.bytes }]) outs.push((await svc("select public.qbo_reindex_connection_realm($1,null,$2,$3,$4) o", [SA, a.realm_envelope, a.realm_index, await RP.realmIndex(SHARED, "sandbox", k)])).o);
      return same(outs, ["downgrade", "downgrade"]) && same(await conn(SA), a) || outs;
    });
    await r.check("with k2 and idx2 retired from the ring, every live row resolves and verifies under k3 and idx3 alone", async () => {
      const v = await run(AFTER, "verify"), x = await run(AFTER, "keys"), i = await run(AFTER, "index_keys");
      return v.status === 200 && v.connections.verified >= 3 && x.status === 200 && i.status === 200 && same(i.connectionIndexes.byKey, { idx3: i.connectionIndexes.total }) || { v, x, i };
    });
    await r.check("a new connection after both rotations is stored without plaintext, under k3 and idx3", async () => {
      const id = await storeC(w.B, w.U.ownerB, LATE, AFTER), c = await conn(id);
      return c.realm_id === null && kid(c.realm_envelope) === "k3" && kid(c.realm_index) === "idx3" || c;
    });
    await r.check("the terminal connection and its plaintext were never touched by either rotation; a re-index of it answers terminal_unchanged", async () => {
      const g = await conn(GO);
      const o = (await svc("select public.qbo_reindex_connection_realm($1,null,$2,$3,$4) o", [GO, g.realm_envelope, g.realm_index, await RP.realmIndex(GONE, "sandbox", IDX3)])).o;
      return same(g, term0.c) && g.realm_id === GONE && o === "terminal_unchanged" || { g, o };
    });

    r.group("Who may call it");
    await r.check("anon and members cannot execute any rotation function, the homogeneity helper or the key-version helper; the service role only the rotation functions", async () => {
      const fns = ["public.qbo_reseal_connection_realm(uuid,text,text,text,text)", "public.qbo_reseal_disconnect_realm(uuid,text,text,text,text)", "public.qbo_reseal_refresh_token(uuid,text,text)",
        "public.qbo_reindex_connection_realm(uuid,text,text,text,text)", "public.qbo_reindex_disconnect_realm(uuid,text,text,text,text)"];
      const can = async (role, fn) => (await db.one("select has_function_privilege($1, $2, 'EXECUTE') ok", [role, fn])).ok;
      for (const fn of fns) if (await can("anon", fn) || await can("authenticated", fn) || !(await can("service_role", fn))) return fn;
      for (const role of ["anon", "authenticated", "service_role"]) if (await can(role, "public.qbo_index_key_mixed(text)")) return role;
      return !(await can("authenticated", "public.qbo_key_version(text,text)")) && !(await can("anon", "public.qbo_key_version(text,text)"));
    });
    await r.refused("a signed-in member calling a reseal directly is refused", "42501", () => db.asUser(w.U.owner, "select public.qbo_reseal_connection_realm($1,null,'v1.k9.a.b','v1.k9.a.b','h1.idx3.x') o", [SA]));

    r.group("Static: no statement the PostgREST safeupdate guard would refuse");
    await r.check("every UPDATE and DELETE in the four migrations has a WHERE clause (functions are called through PostgREST in production)", async () => {
      const bad = [];
      for (const f of CUTOVER_V2) {
        const sql = one(fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8")).replace(/--[^\n]*/g, "");
        for (const m of sql.matchAll(/\b(UPDATE\s+public\.\w+\s+SET|DELETE\s+FROM\s+public\.\w+)[\s\S]*?;/gi)) if (!/\bWHERE\b/i.test(m[0])) bad.push(`${f}: ${m[0].slice(0, 80)}`);
      }
      return bad.length === 0 || bad;
    });
  } catch (e) {
    crashed = true;
    console.error("CRASH", e?.stack ?? e);
  } finally {
    await db.close();
  }
  process.exit(r.finish("QBO realm Phase C v2 cutover and post-redaction rotation", crashed) ? 0 : 1);
}

await main();
