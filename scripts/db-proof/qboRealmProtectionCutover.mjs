// Phase C (cutover) checks of the realmID protection proof (scripts/db-proof/qboRealmProtection.mjs runs them after Phases A and B, on the same
// throwaway database, when the cutover migrations are in the chain). IRREVERSIBLE for the plaintext: proven here only on a disposable database.
import crypto from "node:crypto";
import { chainFiles, migrationText } from "./lib/reportingKit.mjs";

// Phase C v2 (supersedes PR #282): four parts. The post-redaction key rotation (part 3) is proven adversarially in qboRealmCutoverRotation.mjs.
export const CUTOVER = ["20261231100000_qbo_realm_protection_cutover_schema.sql", "20261231200000_qbo_realm_protection_cutover_functions.sql",
  "20261231250000_qbo_realm_rotation_post_redaction.sql", "20261231300000_qbo_realm_protection_cutover_redaction.sql"];
const PHASE_B_LAST = "20261230300000_qbo_realm_protection_evidence.sql";

export async function cutoverChecks(c) {
  const { db, r, w, RP, KEYS, key, svc, env, sha, rnd, backfillDeps, runRealmBackfill, ids, realms, prot, before, importOnce } = c;
  const { A1, B1, A2, AG } = ids;
  const { SHARED, OTHER, GONE } = realms;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const plaintext = async () => (await db.one(`select (select count(*) from public.qbo_connections where status <> 'disconnected' and realm_id is not null)
    + (select count(*) from public.qbo_disconnect_operations where realm_id is not null) + (select count(*) from public.qbo_oauth_states where realm_id is not null) n`)).n;
  const conns = async () => (await db.admin.query("select id, company_id, realm_id, environment, status, refresh_token_envelope, realm_envelope, realm_index, realm_verified_at, created_at from public.qbo_connections order by id")).rows;

  // As hosted: the token-key reseal, its guard repair and the index-key rotation are installed before Phase C (every chain file between them).
  const chain = chainFiles();
  for (const f of chain.slice(chain.indexOf(PHASE_B_LAST) + 1, chain.indexOf(CUTOVER[0]))) await db.admin.query(migrationText(f));

  r.group("Phase C gate: refused until every row is protected and verified");
  const beforeGate = await conns();
  await r.check("parts 2, 3 or 4 before part 1 are refused, and nothing changes", async () => {
    for (const f of [CUTOVER[1], CUTOVER[2], CUTOVER[3]]) { try { await db.admin.query(migrationText(f)); return `${f} applied`; } catch (e) { if (!/PREFLIGHT_REFUSED/.test(e.message)) return e.message; } }
    return same(await conns(), beforeGate);
  });
  await r.check("connections stored after the verification pass (plaintext, not verified) make the cutover refuse: QBO_REALM_CUTOVER_REFUSED, nothing changed", async () => {
    try { await db.admin.query(migrationText(CUTOVER[0])); return "applied"; } catch (e) { if (!/QBO_REALM_CUTOVER_REFUSED/.test(e.message)) return e.message; }
    const n = await db.one("select count(*)::int n from pg_constraint where conname='chk_qbo_connections_realm_present'");
    return n.n === 0 && same(await conns(), beforeGate) || n;
  });
  const verified = await runRealmBackfill(backfillDeps, KEYS, { action: "verify" });
  await r.check("the verification pass now covers every row", async () => verified.status === 200 && verified.database.live_verified === verified.database.live_connections || verified);

  r.group("Phase C applied (schema, functions, post-redaction rotation, redaction)");
  const hist = (await db.admin.query("select id, realm_id, realm_envelope from public.qbo_pull_intents order by id")).rows;
  const histPulls = (await db.admin.query("select id, realm_id, realm_envelope from public.qbo_pulls order by id")).rows;
  const terminal = await db.one("select realm_id, realm_envelope from public.qbo_connections where id=$1", [AG]);
  for (const f of CUTOVER) await db.admin.query(migrationText(f));
  await r.check("each part replayed is a no-op", async () => { const s = await conns(); for (const f of CUTOVER) await db.admin.query(migrationText(f)); return same(await conns(), s); });
  await r.check("no live connection, disconnect operation or OAuth state holds a plaintext realm", async () => Number(await plaintext()) === 0);
  await r.check("every protection is unchanged and still opens to its realm; the index is unchanged", async () => {
    for (const id of [A1, B1]) {
      const x = await db.one("select company_id, environment, realm_envelope, realm_index from public.qbo_connections where id=$1", [id]);
      if (x.realm_envelope !== prot[id].realm_envelope || x.realm_index !== prot[id].realm_index || await RP.openRealm(x.realm_envelope, x.environment, x.company_id, KEYS.all) !== SHARED) return id;
    }
    return true;
  });
  await r.check("a disconnected (terminal) connection, historical intents and provenance rows are unchanged (append-only and terminal guards hold)", async () =>
    same(await db.one("select realm_id, realm_envelope from public.qbo_connections where id=$1", [AG]), terminal) && terminal.realm_id === GONE
      && same((await db.admin.query("select id, realm_id, realm_envelope from public.qbo_pull_intents order by id")).rows, hist)
      && same((await db.admin.query("select id, realm_id, realm_envelope from public.qbo_pulls order by id")).rows, histPulls) && hist.some((x) => x.realm_id === SHARED));
  await r.check("the status counts say what remains in clear (terminal rows and historical evidence) and that nothing live does", async () => {
    const s = (await svc("select public.qbo_realm_protection_status() s")).s;
    return s.live_plaintext === 0 && s.operations_plaintext === 0 && s.terminal_plaintext >= 1 && s.intents_plaintext_only >= 1 || s;
  });
  await r.check("the backfill writers are gone; verify is a local check over every envelope (counts only) and passes", async () => {
    const gone = (await db.one("select count(*)::int n from pg_proc where proname in ('qbo_protect_connection_realm','qbo_protect_disconnect_realm','qbo_verify_connection_realm','qbo_verify_disconnect_realm')")).n;
    const v = await runRealmBackfill({ ...backfillDeps, protectConnection: undefined, protectOperation: undefined, verifyConnection: undefined, verifyOperation: undefined }, KEYS, { action: "verify" });
    return gone === 0 && v.status === 200 && v.connections.mismatched === 0 && v.operations.mismatched === 0 || { gone, v };
  });
  await r.refused("a plaintext can never come back to a live row, even through the superuser", "23001", () => db.admin.query("update public.qbo_connections set realm_id=$2 where id=$1", [A1, SHARED]));
  await r.refused("a terminal row still cannot change", "23001", () => db.admin.query("update public.qbo_connections set realm_id=null where id=$1", [AG]));

  r.group("After the cutover: every rule on the index, no plaintext written");
  const storeC = (company, actor, realm, environment, e, p, plain = null) => svc("select public.qbo_store_connection($1,$2,$3,$4,$5,now()+interval '100 days',null,$6,$7) id", [company, actor, plain, environment, e, p?.envelope ?? null, p?.index ?? null]);
  await r.check("reconnecting the same QuickBooks company finds the SAME live row by its index", async () => {
    const id = (await storeC(w.A, w.U.owner, SHARED, "sandbox", env("n"), await RP.protectRealm(SHARED, "sandbox", w.A, KEYS))).id;
    const row = await db.one("select realm_id, refresh_token_envelope, realm_envelope from public.qbo_connections where id=$1", [A1]);
    return id === A1 && row.realm_id === null && row.refresh_token_envelope === env("n") && row.realm_envelope === prot[A1].realm_envelope || { id, row };
  });
  await r.check("a new connection is stored without plaintext, even when a Phase B caller still sends it", async () => {
    const R = "9130350000000007";
    const id = (await storeC(w.A, w.U.owner, R, "sandbox", env("o"), await RP.protectRealm(R, "sandbox", w.A, KEYS), R)).id;
    const row = await db.one("select realm_id, realm_envelope from public.qbo_connections where id=$1", [id]);
    return row.realm_id === null && await RP.openRealm(row.realm_envelope, "sandbox", w.A, KEYS.all) === R || row;
  });
  await r.refused("a connection without its protection is refused", "22023", () => storeC(w.A, w.U.owner, null, "sandbox", env("p"), null), "QBO_REALM_PROTECTION_REQUIRED");
  await r.refused("the database itself refuses a second live row for the same (workspace, index, environment)", "23505", () => db.admin.query(
    "insert into public.qbo_connections (company_id, connected_by_user_id, environment, refresh_token_envelope, envelope_key_id, refresh_expires_at, realm_envelope, realm_index) values ($1,$2,'sandbox',$3,'k1',now()+interval '1 day',$4,$5)",
    [w.A, w.U.owner, env("q"), prot[A1].realm_envelope, prot[A1].realm_index]));
  await r.refused("and a live row with a plaintext realm or without its index", "23514", () => db.admin.query(
    "insert into public.qbo_connections (company_id, connected_by_user_id, realm_id, environment, refresh_token_envelope, envelope_key_id, refresh_expires_at, realm_envelope, realm_index) values ($1,$2,'1','production',$3,'k1',now()+interval '1 day',$4,$5)",
    [w.A, w.U.owner, env("r"), prot[A1].realm_envelope, prot[A1].realm_index]));
  await r.check("a realm shared by two workspaces is detected by its index: one workspace cannot revoke it", async () =>
    (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [A1, w.U.owner, crypto.randomUUID()])).r.outcome === "shared_connection");
  await r.check("a pending revocation blocks reconnecting that company in any workspace, found by its index", async () => {
    const op = await db.one("select outcome, realm_id from public.qbo_disconnect_operations where connection_id=$1", [A2]);
    try { await storeC(w.B, w.U.ownerB, null, "production", env("s"), await RP.protectRealm(OTHER, "production", w.B, KEYS)); return "stored"; }
    catch (e) { return op.outcome === "pending" && op.realm_id === null && /QBO_REVOKE_PENDING/.test(e.message) || { op, e: e.message }; }
  });
  await r.check("the per-realm lock is taken on the index: a second workspace connecting the same company waits for the first", async () => {
    const R = "9130350000000008";
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN"); await holder.query("SET LOCAL ROLE service_role");
      await holder.query("select public.qbo_store_connection($1,$2,null,'sandbox',$3,now()+interval '100 days',null,$4,$5)", [w.A, w.U.owner, env("t"), ...Object.values(await RP.protectRealm(R, "sandbox", w.A, KEYS))]);
      let resolved = false;
      const pB = await RP.protectRealm(R, "sandbox", w.B, KEYS);
      const waiting = storeC(w.B, w.U.ownerB, null, "sandbox", env("u"), pB).then((x) => { resolved = true; return x; });
      await new Promise((res) => setTimeout(res, 200));
      const blocked = resolved === false;
      await holder.query("COMMIT");
      const second = await waiting;
      return blocked && typeof second.id === "string" || { blocked };
    } finally { await holder.query("ROLLBACK").catch(() => undefined); holder.release(); }
  });
  await r.check("OAuth return: the realm is parked only sealed (a Phase B caller's plaintext is ignored); a park without protection is refused", async () => {
    const st = rnd(), h = sha(rnd());
    await svc("select public.qbo_start_oauth_state($1,$2,$3,'sandbox',600,2026)", [sha(st), w.A, w.U.owner]);
    const p = await RP.protectParkedRealm(SHARED, h, KEYS);
    const bare = await db.asRole("service_role", null, "select * from public.qbo_record_oauth_return($1,null,$2,$3)", [sha(st), env("v"), h]);
    const ok = await db.asRole("service_role", null, "select * from public.qbo_record_oauth_return($1,$2,$3,$4,$5,$6,$7)", [sha(st), SHARED, env("v"), h, p.envelope, p.indexSandbox, p.indexProduction]);
    const row = await db.one("select realm_id, realm_envelope, realm_index from public.qbo_oauth_states where handoff_hash=$1", [h]);
    const taken = (await db.asRole("service_role", null, "select * from public.qbo_take_oauth_return($1,$2)", [h, w.U.owner]))[0];
    return bare.length === 0 && ok.length === 1 && row.realm_id === null && row.realm_index === p.indexSandbox && taken.realm_id === null && taken.realm_envelope === p.envelope || { bare, row, taken };
  });
  await r.check("import evidence: a new intent and its provenance row hold no plaintext and carry the connection's protection", async () => {
    const fresh = await importOnce(A1, SHARED, env("n"), "quickbooks-sandbox-2026-12-30.csv");
    const i = await db.one("select realm_id, realm_envelope, realm_index from public.qbo_pull_intents where reservation_id=$1", [fresh.reservation]);
    return fresh.done === "completed" && i.realm_id === null && i.realm_envelope === prot[A1].realm_envelope && i.realm_index === prot[A1].realm_index || { fresh, i };
  });
  await r.check("members still read status without a realm; anon and members cannot reach any writer", async () => {
    const rows = await db.asRole("authenticated", w.U.owner, "select * from public.qbo_connection_status($1)", [w.A]);
    for (const role of ["anon", "authenticated"]) {
      try { await db.asRole(role, w.U.owner, "select public.qbo_store_connection($1,$2,null,'sandbox',$3,now(),null,$4,$5)", [w.A, w.U.owner, env("w"), prot[A1].realm_envelope, prot[A1].realm_index]); return `${role} stored`; }
      catch (e) { if (e.code !== "42501") return e.message; }
    }
    return rows.length > 0 && rows.every((x) => !("realm_id" in x)) || rows;
  });
  void before; void key;
}
