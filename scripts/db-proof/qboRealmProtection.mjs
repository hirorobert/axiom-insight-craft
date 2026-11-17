#!/usr/bin/env node
// Real-PostgreSQL proof of the QuickBooks realmID protection release (Intuit case 00232331; docs/release/qbo-realm-protection-r1/README.md):
// 20261230100000 (Phase A, additive schema), 20261230200000 + 20261230300000 (Phase B, dual write) and, when present in the chain, the cutover.
//
//   bun scripts/db-proof/qboRealmProtection.mjs                                     (CI: DB_PROOF_MODE=external DB_PROOF_CONN=<loopback db>)
//   DB_PROOF_MODULES_DIR=<dir with embedded-postgres + pg> node scripts/db-proof/qboRealmProtection.mjs   (local; Node >= 22.6 strips types)
//
// One throwaway PostgreSQL receives the chain BEFORE the release; EXISTING QuickBooks data is created through the real service-role functions of
// main (two workspaces sharing one QuickBooks company, a second company with a held import lease, a disconnected connection with a pending
// revocation, an OAuth return parked in clear, an import intent and its provenance row). Then the release is applied and the backfill runs through
// the REAL orchestration (supabase/functions/_shared/qboRealmBackfill.ts) with the REAL module (qboRealmProtection.ts). Loopback only; no Intuit,
// no hosted project, no secret: every key is random and lives only in this process.
import crypto from "node:crypto";
import { openDatabase, applyChainBefore, chainFiles, makeWorld, migrationText, reporter } from "./lib/reportingKit.mjs";

const RP = await import("../../supabase/functions/_shared/qboRealmProtection.ts");
const { runRealmBackfill } = await import("../../supabase/functions/_shared/qboRealmBackfill.ts");
const PHASE_A = "20261230100000_qbo_realm_protection_schema.sql";
const PHASE_B = ["20261230200000_qbo_realm_protection_connect.sql", "20261230300000_qbo_realm_protection_evidence.sql"];
const CUTOVER = "20261231100000_qbo_realm_protection_cutover.sql";
const key = (id) => ({ id, bytes: new Uint8Array(crypto.randomBytes(32)) });
const K1 = key("k1"), K0 = key("k0"), IDX = key("idx1");
const KEYS = { current: K1, all: [K1, K0], index: IDX };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rnd = () => crypto.randomBytes(32).toString("hex");

async function main() {
  const r = reporter();
  const db = await openDatabase("qbo_realm_protection");
  let crashed = false;
  try {
    const failed = await applyChainBefore(db, PHASE_A);
    if (failed) throw new Error(`chain: ${failed}`);
    const w = await makeWorld(db);
    const svc = (s, p = []) => db.asService(s, p);
    const env = (c) => "v1.k1." + "a".repeat(16) + "." + c.repeat(40);
    const SHARED = "9130350000000001", OTHER = "9130350000000002", GONE = "9130350000000003", NEWR = "9130350000000004";

    // ── existing data, written by main's functions ──────────────────────────────────────────────────────────────────
    const oldStore = async (company, actor, realm, environment, e) => (await svc("select public.qbo_store_connection($1,$2,$3,$4,$5,now()+interval '100 days',null) id", [company, actor, realm, environment, e])).id;
    const A1 = await oldStore(w.A, w.U.owner, SHARED, "sandbox", env("b"));
    const B1 = await oldStore(w.B, w.U.ownerB, SHARED, "sandbox", env("c"));
    const A2 = await oldStore(w.A, w.U.owner, OTHER, "production", env("d"));
    const AG = await oldStore(w.A, w.U.owner, GONE, "sandbox", env("e"));
    const begun = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [AG, w.U.owner, crypto.randomUUID()])).r;
    const lease = (await svc("select public.qbo_acquire_refresh_lease($1,$2,90) id", [A2, env("d")])).id;
    // An OAuth return parked in clear by main's callback, finished after the release.
    const oldState = rnd(), oldHandoff = rnd();
    await svc("select public.qbo_start_oauth_state($1,$2,$3,'sandbox',600,2026)", [sha(oldState), w.A, w.U.owner]);
    await db.asRole("service_role", null, "select * from public.qbo_record_oauth_return($1,$2,$3,$4)", [sha(oldState), NEWR, env("f"), sha(oldHandoff)]);
    // A historical import: intent and provenance row (registration simulated by the superuser exactly as register_trial_balance_upload records it).
    await db.asUser(w.U.owner, "select * from public.open_engagement_with_period($1,'2026-01-01','2026-12-31','USD',ARRAY['FINANCIAL_STATEMENTS'],NULL,NULL,NULL)", [w.A]);
    const period = (await db.one("select id from public.fiscal_periods where company_id=$1 and reporting_end='2026-12-31'", [w.A])).id;
    const importOnce = async (connection, realm, envelope, reservationName) => {
      const leaseId = (await svc("select public.qbo_acquire_refresh_lease($1,$2,90) id", [connection, envelope])).id;
      const res = await db.asUser(w.U.owner, "select * from public.reserve_trial_balance_source($1,$2)", [w.A, reservationName]);
      const basis = { operationLeaseId: leaseId, kind: "fiscal-ytd-as-of", fiscalStartMonth: 1, fiscalStart: "2026-01-01", asOf: "2026-12-31", currency: "USD", accountingMethod: "Accrual", preferencesSha256: "a".repeat(64) };
      await svc("select public.qbo_record_fiscal_pull_intent($1,$2,$3,$4,$5,$6,'sandbox','2026-01-01','2026-12-31','Accrual',75,'USD',45,$7,$8,$9) r",
        [period, JSON.stringify(basis), res.reservation_id, connection, w.U.owner, realm, sha(rnd()), sha(rnd()), sha(rnd())]);
      const upload = (await db.one("insert into public.trial_balance_uploads(file_name,file_path,file_size,status,user_id,company_id,period_year,period_id) values($1,$2,100,'pending',$3,$4,2026,$5) returning id",
        [reservationName, res.object_path, w.U.owner, w.A, period])).id;
      await db.admin.query("update public.trial_balance_source_reservations set consumed_at=now(), consumed_by_upload_id=$2 where id=$1", [res.reservation_id, upload]);
      const done = (await svc("select public.qbo_complete_pull($1) r", [res.reservation_id])).r;
      await svc("select public.qbo_release_refresh_lease($1,$2)", [connection, leaseId]);
      await db.admin.query("delete from public.trial_balance_uploads where id=$1", [upload]).catch(() => undefined);   // frees the period for the next import
      return { reservation: res.reservation_id, done };
    };
    const historical = await importOnce(A1, SHARED, env("b"), "quickbooks-historical.csv");

    const CONN_COLS = "id, company_id, connected_by_user_id, realm_id, environment, status, refresh_token_envelope, envelope_key_id, refresh_expires_at, hard_expires_at, refresh_lease_until, refresh_lease_id, created_at, disconnected_at";
    const snapshot = async () => ({
      connections: (await db.admin.query(`SELECT ${CONN_COLS} FROM public.qbo_connections ORDER BY id`)).rows,
      operations: (await db.admin.query("SELECT connection_id, request_id, actor_user_id, company_id, realm_id, environment, revoke_lease_id, revoke_lease_until, pending_envelope, outcome, created_at, completed_at FROM public.qbo_disconnect_operations ORDER BY connection_id")).rows,
      states: (await db.admin.query("SELECT id, state_hash, company_id, actor_user_id, environment, return_period_year, created_at, expires_at, consumed_at, realm_id, handoff_hash, code_envelope, handoff_expires_at, finished_at, finish_outcome FROM public.qbo_oauth_states ORDER BY id")).rows,
      intents: (await db.admin.query("SELECT id, recorded_at, reservation_id, company_id, connection_id, actor_user_id, prepare_basis, source_basis, realm_id, environment, report, start_date, end_date, accounting_method, minor_version, currency, account_count, raw_sha256, canonical_sha256, result_sha256 FROM public.qbo_pull_intents ORDER BY id")).rows,
      pulls: (await db.admin.query("SELECT id, pulled_at, company_id, upload_id, connection_id, actor_user_id, prepare_basis, source_basis, realm_id, environment, report, start_date, end_date, accounting_method, minor_version, currency, account_count, raw_sha256, canonical_sha256, result_sha256 FROM public.qbo_pulls ORDER BY id")).rows,
    });
    const before = await snapshot();
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    r.group("Existing QuickBooks data before the release (written by main's functions)");
    await r.check("three live connections (two workspaces share one QuickBooks company), a disconnected one with a pending revocation, a parked OAuth return, a historical import", async () =>
      before.connections.length === 4 && before.connections.filter((x) => x.status === "active").length === 3 && begun?.outcome === "pending" && lease !== null
        && before.states.some((s) => s.realm_id === NEWR && s.code_envelope) && before.intents.length === 1 && before.pulls.length === 1 && historical.done === "completed" || { before: before.connections.length, begun, historical });

    r.group("Phase A + B applied");
    for (const f of [PHASE_A, ...PHASE_B]) await db.admin.query(migrationText(f));
    await r.check("every pre-existing column of every row is byte-identical (connections, operations, OAuth states, intents, pulls); the new columns are empty", async () => {
      const empty = await db.one(`select (select count(*) from public.qbo_connections where realm_envelope is not null or realm_index is not null or realm_verified_at is not null)
        + (select count(*) from public.qbo_disconnect_operations where realm_envelope is not null) + (select count(*) from public.qbo_oauth_states where realm_envelope is not null)
        + (select count(*) from public.qbo_pull_intents where realm_envelope is not null) + (select count(*) from public.qbo_pulls where realm_envelope is not null) n`);
      return same(await snapshot(), before) && Number(empty.n) === 0 || "changed";
    });
    await r.check("each migration replayed is a no-op", async () => {
      for (const f of [PHASE_A, ...PHASE_B]) await db.admin.query(migrationText(f));
      return same(await snapshot(), before);
    });
    await r.refused("the append-only intents and pulls keep their guards (no UPDATE, even by the superuser)", "23001", () => db.admin.query("update public.qbo_pulls set realm_envelope=null"));
    await r.check("a member's status read carries no realm (the function has no realm column) and still lists the connections", async () => {
      const rows = await db.asRole("authenticated", w.U.owner, "select * from public.qbo_connection_status($1)", [w.A]);
      return rows.length === 3 && rows.every((x) => !("realm_id" in x) && !Object.values(x).map(String).some((v) => /^9130350/.test(v))) || rows;
    });
    await r.check("no QuickBooks function a member can execute returns or accepts a realm", async () => {
      const fns = (await db.admin.query(`select p.proname, p.proargnames from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname like 'qbo\\_%' and has_function_privilege('authenticated', p.oid, 'EXECUTE')`)).rows;
      const leaks = fns.filter((f) => (f.proargnames ?? []).some((a) => /realm/.test(a)));
      return fns.length === 2 && leaks.length === 0 || { fns, leaks };
    });

    r.group("Backfill: the real orchestration, service-only database functions");
    const backfillDeps = {
      authorize: () => true,
      listConnections: async () => (await db.admin.query("select id, company_id, environment, realm_id, realm_envelope, realm_index from public.qbo_connections where status <> 'disconnected'")).rows,
      listOperations: async () => (await db.admin.query("select connection_id as id, company_id, environment, realm_id, realm_envelope, realm_index from public.qbo_disconnect_operations")).rows,
      protectConnection: async (a) => (await svc("select public.qbo_protect_connection_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
      protectOperation: async (a) => (await svc("select public.qbo_protect_disconnect_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
      verifyConnection: async (a) => (await svc("select public.qbo_verify_connection_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
      verifyOperation: async (a) => (await svc("select public.qbo_verify_disconnect_realm($1,$2,$3,$4) o", [a.p_connection, a.p_realm_id, a.p_realm_envelope, a.p_realm_index])).o,
      status: async () => (await svc("select public.qbo_realm_protection_status() s")).s,
    };
    const protect = await runRealmBackfill(backfillDeps, KEYS, { action: "protect" });
    await r.check("protect: three live connections and one disconnect operation protected; the terminal connection is not listed and stays unchanged", async () =>
      protect.status === 200 && protect.connections.protected === 3 && protect.operations.protected === 1 && protect.database.live_protected === 3 && protect.database.operations_protected === 1 || protect);
    await r.check("the answer carries counts only: no realm, envelope, index or row id", async () => {
      const t = JSON.stringify(protect);
      return ![SHARED, OTHER, GONE, "v1.", "h1.", A1, B1, A2, AG].some((s) => t.includes(s)) || t;
    });
    await r.check("after the backfill every pre-existing column is still byte-identical (only the protection columns and updated_at were written)", async () => same(await snapshot(), before));
    const prot = Object.fromEntries((await db.admin.query("select id, company_id, environment, realm_id, realm_envelope, realm_index from public.qbo_connections")).rows.map((x) => [x.id, x]));
    await r.check("each envelope opens to exactly its realm with the key ring, and an envelope moved to another workspace does not open", async () => {
      for (const id of [A1, B1, A2]) { const x = prot[id]; if ((await RP.openRealm(x.realm_envelope, x.environment, x.company_id, [K0, K1])) !== x.realm_id) return id; }
      try { await RP.openRealm(prot[A1].realm_envelope, "sandbox", w.B, [K1]); return "opened elsewhere"; } catch { return true; }
    });
    await r.check("two workspaces connected to the SAME QuickBooks company share one index; different realms do not; another key gives an unrelated index", async () =>
      prot[A1].realm_index === prot[B1].realm_index && prot[A1].realm_index !== prot[A2].realm_index && prot[A1].realm_index === await RP.realmIndex(SHARED, "sandbox", IDX)
        && prot[A1].realm_index !== await RP.realmIndex(SHARED, "sandbox", key("idx2")));
    await r.check("replay is idempotent; a wrong plaintext and a conflicting index are refused; nothing is overwritten", async () => {
      const again = await runRealmBackfill(backfillDeps, KEYS, { action: "protect" });
      const args = await RP.protectExistingRealm({ id: A1, ...prot[A1] }, KEYS);
      const wrong = (await svc("select public.qbo_protect_connection_realm($1,$2,$3,$4) o", [A1, OTHER, args.p_realm_envelope, args.p_realm_index])).o;
      const conflict = (await svc("select public.qbo_protect_connection_realm($1,$2,$3,$4) o", [A1, SHARED, args.p_realm_envelope, await RP.realmIndex(SHARED, "sandbox", key("idx3"))])).o;
      const terminal = (await svc("select public.qbo_protect_connection_realm($1,$2,$3,$4) o", [AG, GONE, args.p_realm_envelope, args.p_realm_index])).o;
      const still = (await db.one("select realm_envelope from public.qbo_connections where id=$1", [A1])).realm_envelope;
      return again.connections.already === 3 && again.connections.protected === 0 && again.operations.already === 1 && wrong === "realm_mismatch" && conflict === "index_conflict"
        && terminal === "terminal_unchanged" && still === prot[A1].realm_envelope || { again, wrong, conflict, terminal };
    });
    await r.refused("a malformed envelope or index is refused by the table", "23514", () => db.admin.query("update public.qbo_oauth_states set realm_envelope='plain', realm_index='h1.idx1.'||repeat('0',64) where handoff_hash is not null"));
    await r.refused("a written protection is never changed, even by the superuser", "23001", () => db.admin.query("update public.qbo_connections set realm_index=$2 where id=$1", [A2, prot[A1].realm_index]));
    for (const role of ["authenticated", "anon"]) {
      for (const fn of ["qbo_protect_connection_realm($1,$2,$3,$4)", "qbo_verify_connection_realm($1,$2,$3,$4)", "qbo_protect_disconnect_realm($1,$2,$3,$4)", "qbo_verify_disconnect_realm($1,$2,$3,$4)"]) {
        await r.refused(`${role} cannot call ${fn.split("(")[0]}`, "42501", () => db.asRole(role, w.U.owner, `select public.${fn}`, [A1, SHARED, prot[A1].realm_envelope, prot[A1].realm_index]));
      }
      await r.refused(`${role} cannot read the protection counts`, "42501", () => db.asRole(role, w.U.owner, "select public.qbo_realm_protection_status()"));
    }

    r.group("Verification pass");
    const verify = await runRealmBackfill(backfillDeps, KEYS, { action: "verify" });
    await r.check("every live connection and every operation is opened, compared with its plaintext and index, and marked verified", async () =>
      verify.status === 200 && verify.connections.verified === 3 && verify.operations.verified === 1 && verify.database.live_verified === 3 && verify.database.operations_verified === 1 || verify);
    await r.check("a verification is refused for a realm that does not match the stored plaintext, or an envelope that is not the stored one", async () => {
      const wrongRealm = (await svc("select public.qbo_verify_connection_realm($1,$2,$3,$4) o", [A2, SHARED, prot[A2].realm_envelope, prot[A2].realm_index])).o;
      const wrongEnv = (await svc("select public.qbo_verify_connection_realm($1,$2,$3,$4) o", [A2, OTHER, prot[A1].realm_envelope, prot[A2].realm_index])).o;
      return wrongRealm === "realm_mismatch" && wrongEnv === "envelope_mismatch" || { wrongRealm, wrongEnv };
    });
    await r.check("a key ring without the sealing key cannot verify: the row is reported, never marked", async () => {
      const t = await runRealmBackfill({ ...backfillDeps, verifyConnection: async () => "verified" }, { current: K0, all: [K0], index: IDX }, { action: "verify" });
      return t.status === 409 && t.outcome === "incomplete" && t.connections.mismatched === 3 || t;
    });

    r.group("Phase B: the functions' new writes carry the protection");
    const startReturn = async (company, actor, environment) => { const s = rnd(); await svc("select public.qbo_start_oauth_state($1,$2,$3,$4,600,2026)", [sha(s), company, actor, environment]); return sha(s); };
    const callbackArgs = async (realm, handoffHash) => { const p = await RP.protectParkedRealm(realm, handoffHash, KEYS); return [p.envelope, p.indexSandbox, p.indexProduction]; };
    const ret = (stateHash, realm, handoffHash, prot3) => db.asRole("service_role", null, "select * from public.qbo_record_oauth_return($1,$2,$3,$4,$5,$6,$7)", [stateHash, realm, env("g"), handoffHash, ...prot3]);
    const take = async (handoffHash, actor) => (await db.asRole("service_role", null, "select * from public.qbo_take_oauth_return($1,$2)", [handoffHash, actor]))[0];
    await r.check("callback: the realm is parked sealed to the handoff with the index of the state's own environment", async () => {
      const h = sha(rnd()), st = await startReturn(w.A, w.U.owner, "production");
      const p3 = await callbackArgs(NEWR, h);
      const back = await ret(st, NEWR, h, p3);
      const row = await db.one("select realm_envelope, realm_index from public.qbo_oauth_states where handoff_hash=$1", [h]);
      const taken = await take(h, w.U.owner);
      return back.length === 1 && row.realm_envelope === p3[0] && row.realm_index === p3[2] && taken.outcome === "taken" && taken.realm_envelope === p3[0] && taken.realm_index === p3[2]
        && await RP.openParkedRealm(taken.realm_envelope, h, KEYS.all) === NEWR || { row, taken };
    });
    await r.check("a half-protected return is refused BEFORE the state is consumed; protection without a parked code is refused", async () => {
      const h = sha(rnd()), st = await startReturn(w.A, w.U.owner, "sandbox");
      const p3 = await callbackArgs(NEWR, h);
      const half = await ret(st, NEWR, h, [p3[0], null, p3[2]]);
      const noCode = await db.asRole("service_role", null, "select * from public.qbo_record_oauth_return($1,null,null,null,$2,$3,$4)", [st, ...p3]);
      const ok = await ret(st, NEWR, h, p3);
      return half.length === 0 && noCode.length === 0 && ok.length === 1 || { half, noCode, ok };
    });
    await r.check("an attempt parked in clear before the release is still finished once (transitional; its realm comes back for finish to protect)", async () => {
      const taken = await take(sha(oldHandoff), w.U.owner);
      return taken.outcome === "taken" && taken.realm_id === NEWR && taken.realm_envelope === null || taken;
    });
    const storeNew = (company, actor, realm, environment, e, p) => svc("select public.qbo_store_connection($1,$2,$3,$4,$5,now()+interval '100 days',null,$6,$7) id", [company, actor, realm, environment, e, p?.envelope ?? null, p?.index ?? null]);
    const pNew = await RP.protectRealm(NEWR, "sandbox", w.A, KEYS);
    const N1 = (await storeNew(w.A, w.U.owner, NEWR, "sandbox", env("h"), pNew)).id;
    await r.check("finish: a new connection is stored with its protection", async () => {
      const row = await db.one("select realm_id, realm_envelope, realm_index from public.qbo_connections where id=$1", [N1]);
      return row.realm_envelope === pNew.envelope && row.realm_index === pNew.index && row.realm_id === NEWR || row;
    });
    await r.check("reconnecting the same QuickBooks company replaces the token on the SAME live row and keeps the protection already written", async () => {
      const again = await RP.protectRealm(SHARED, "sandbox", w.B, KEYS);
      const id = (await storeNew(w.B, w.U.ownerB, SHARED, "sandbox", env("i"), again)).id;
      const row = await db.one("select status, refresh_token_envelope, realm_envelope, realm_index, realm_verified_at from public.qbo_connections where id=$1", [B1]);
      return id === B1 && row.status === "active" && row.refresh_token_envelope === env("i") && row.realm_envelope === prot[B1].realm_envelope && row.realm_index === prot[B1].realm_index && row.realm_verified_at !== null || { id, row };
    });
    await r.refused("a reconnect presenting a different index for the same realm is refused", "23505", () => storeNew(w.B, w.U.ownerB, SHARED, "sandbox", env("j"), { envelope: prot[B1].realm_envelope, index: "h1.idx9." + "0".repeat(64) }), "QBO_REALM_INDEX_CONFLICT");
    await r.refused("an envelope without an index (or the reverse) is refused", "22023", () => storeNew(w.A, w.U.owner, "9130350000000005", "sandbox", env("k"), { envelope: pNew.envelope, index: null }));
    await r.check("a function deployed before the release still stores a connection (the 7-argument call resolves; the backfill protects it later)", async () => {
      const id = await oldStore(w.A, w.U.owner, "9130350000000006", "sandbox", env("l"));
      const row = await db.one("select realm_envelope from public.qbo_connections where id=$1", [id]);
      const p = await runRealmBackfill(backfillDeps, KEYS, { action: "protect" });
      const after = await db.one("select realm_envelope from public.qbo_connections where id=$1", [id]);
      return row.realm_envelope === null && p.connections.protected === 1 && after.realm_envelope !== null || { row, p };
    });
    await r.check("import evidence: a new intent and its provenance row carry the CONNECTION's protection; the historical rows are unchanged", async () => {
      const fresh = await importOnce(A1, SHARED, env("b"), "quickbooks-sandbox-2026-12-31.csv");
      const i = await db.one("select realm_envelope, realm_index from public.qbo_pull_intents where reservation_id=$1", [fresh.reservation]);
      const p = await db.one("select p.realm_envelope, p.realm_index from public.qbo_pulls p join public.qbo_pull_intents i on i.reservation_id=$1 and p.connection_id=i.connection_id and p.pulled_at=i.recorded_at", [fresh.reservation]);
      const hist = await db.one("select realm_envelope from public.qbo_pull_intents where reservation_id=$1", [historical.reservation]);
      const s = await snapshot();
      return fresh.done === "completed" && i.realm_envelope === prot[A1].realm_envelope && i.realm_index === prot[A1].realm_index && p.realm_envelope === prot[A1].realm_envelope
        && hist.realm_envelope === null && same(s.intents.filter((x) => before.intents.some((b) => b.id === x.id)), before.intents) && same(s.pulls.filter((x) => before.pulls.some((b) => b.id === x.id)), before.pulls) || { i, p, hist };
    });
    await r.check("disconnect: the operation inherits the connection's protection and verification and returns its envelope; a shared realm is still refused", async () => {
      const shared = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [A1, w.U.owner, crypto.randomUUID()])).r;
      const b = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [A2, w.U.owner, crypto.randomUUID()])).r;
      return shared.outcome === "shared_connection" && b.outcome === "busy" || { shared, b };   // A2's import lease is still held
    });
    await r.check("after the lease is released the disconnect proceeds, and the operation carries the protection", async () => {
      await svc("select public.qbo_release_refresh_lease($1,$2)", [A2, lease]);
      const b = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [A2, w.U.owner, crypto.randomUUID()])).r;
      const op = await db.one("select realm_envelope, realm_index, realm_verified_at from public.qbo_disconnect_operations where connection_id=$1", [A2]);
      return b.outcome === "pending" && b.realmEnvelope === prot[A2].realm_envelope && b.realmIndex === prot[A2].realm_index && op.realm_envelope === prot[A2].realm_envelope && op.realm_verified_at !== null
        && await RP.openRealm(b.realmEnvelope, "production", w.A, KEYS.all) === OTHER || { b, op };
    });
    await r.check("a pending revocation still blocks reconnecting that QuickBooks company, in any workspace", async () => {
      try { await storeNew(w.B, w.U.ownerB, OTHER, "production", env("m"), await RP.protectRealm(OTHER, "production", w.B, KEYS)); return "stored"; } catch (e) { return /QBO_REVOKE_PENDING/.test(e.message) || e.message; }
    });

    if (chainFiles().includes(CUTOVER)) {
      const { cutoverChecks } = await import("./qboRealmProtectionCutover.mjs");
      await cutoverChecks({ db, r, w, RP, KEYS, key, svc, env, sha, rnd, backfillDeps, runRealmBackfill, ids: { A1, B1, A2, AG, N1 }, realms: { SHARED, OTHER, GONE, NEWR }, prot, before, snapshot, importOnce, CUTOVER });
    }
  } catch (e) {
    crashed = true;
    console.error("CRASH", e?.stack ?? e);
  } finally {
    await db.close();
  }
  process.exit(r.finish("QBO realm protection", crashed) ? 0 : 1);
}

await main();
