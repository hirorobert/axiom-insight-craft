#!/usr/bin/env node
// Proof for the INERT realmID-protection candidate (release/candidates/qbo-realm-protection-r0; awaiting Intuit clarification).
//
//   DB_PROOF_MODULES_DIR=<dir with embedded-postgres + pg> node scripts/db-proof/qboRealmProtectionCandidate.mjs
//
// One throwaway PostgreSQL receives the whole current chain, then EXISTING QuickBooks connections are created through the real service-role
// functions (two workspaces sharing one QuickBooks company, a second company, and a disconnected connection with a pending revocation).
// Then the candidate's Phase A SQL is applied and every live connection is backfilled with the candidate module's envelope and keyed index.
// Asserted: nothing existing changes (identity, status, token envelope, leases, expiry, pending revocation, history counts); each envelope
// opens to exactly its realm and only for its own workspace; shared realms share one index; the backfill refuses a wrong plaintext, never
// overwrites, never touches a terminal row and is service-role only; the existing functions keep working afterwards. Requires Node >= 22.6
// (TypeScript type stripping) to import the candidate module.
import crypto from "node:crypto";
import fs from "node:fs";
import { openDatabase, applyChain, makeWorld, reporter, REPO } from "./lib/reportingKit.mjs";

const { protectExistingRealm, openRealm, realmIndex } = await import("../../release/candidates/qbo-realm-protection-r0/realmProtection.ts");
const CANDIDATE = `${REPO}/release/candidates/qbo-realm-protection-r0/phase-a-additive.sql`;
const key = (id) => ({ id, bytes: new Uint8Array(crypto.randomBytes(32)) });

async function main() {
  const r = reporter();
  const db = await openDatabase("qbo_realm_candidate");
  let crashed = false;
  try {
    const failed = await applyChain(db);
    if (failed) throw new Error(`chain: ${failed}`);
    const w = await makeWorld(db);
    const svc = (s, p = []) => db.asService(s, p);
    const env = (c) => "v1.k1." + "a".repeat(16) + "." + c.repeat(40);
    const store = async (company, actor, realm, environment, e) => (await svc("select public.qbo_store_connection($1,$2,$3,$4,$5,now()+interval '100 days',null) id", [company, actor, realm, environment, e])).id;
    const SHARED = "9130350000000001", OTHER = "9130350000000002", GONE = "9130350000000003";
    const A1 = await store(w.A, w.U.owner, SHARED, "sandbox", env("b"));
    const B1 = await store(w.B, w.U.ownerB, SHARED, "sandbox", env("c"));
    const A2 = await store(w.A, w.U.owner, OTHER, "production", env("d"));
    const AG = await store(w.A, w.U.owner, GONE, "sandbox", env("e"));
    const begun = (await svc("select public.qbo_begin_disconnect($1,$2,$3) r", [AG, w.U.owner, crypto.randomUUID()])).r;
    const lease = (await svc("select public.qbo_acquire_refresh_lease($1,$2,90) id", [A2, env("d")])).id;

    const snapshot = async () => (await db.admin.query(`SELECT id, company_id, connected_by_user_id, realm_id, environment, status, refresh_token_envelope, envelope_key_id,
      refresh_expires_at, hard_expires_at, refresh_lease_until, refresh_lease_id, created_at, disconnected_at FROM public.qbo_connections ORDER BY id`)).rows;
    const others = async () => (await db.admin.query(`SELECT (SELECT count(*) FROM public.qbo_disconnect_operations) ops, (SELECT count(*) FROM public.qbo_pulls) pulls,
      (SELECT count(*) FROM public.qbo_pull_intents) intents, (SELECT count(*) FROM public.qbo_oauth_states) states,
      (SELECT string_agg(outcome, ',') FROM public.qbo_disconnect_operations) outcomes`)).rows[0];
    const before = await snapshot(), beforeOthers = await others();

    r.group("Existing connections before the candidate");
    await r.check("four connections exist: three live (two workspaces share one QuickBooks company) and one disconnected with a pending revocation", async () =>
      before.length === 4 && before.filter((x) => x.status === "active").length === 3 && begun?.outcome === "pending" && lease !== null || { n: before.length, begun });

    r.group("Phase A applied (additive)");
    await db.admin.query(fs.readFileSync(CANDIDATE, "utf8"));
    await r.check("every existing column of every connection is unchanged, and so are revocations, pulls, intents and OAuth states", async () =>
      JSON.stringify(await snapshot()) === JSON.stringify(before) && JSON.stringify(await others()) === JSON.stringify(beforeOthers));
    await r.check("the new columns are empty until backfilled", async () => (await db.one("select count(*)::int n from public.qbo_connections where realm_envelope is not null or realm_index is not null")).n === 0);

    r.group("Backfill through the service-only function");
    const K1 = key("k1"), K0 = key("k0"), IDX = key("idx1");
    const rows = (await db.admin.query("select id, company_id, realm_id, environment, status from public.qbo_connections order by id")).rows;
    const outcomes = {};
    for (const row of rows) {
      const args = await protectExistingRealm(row, K1, [K1, K0], IDX);
      outcomes[row.id] = (await svc("select public.qbo_protect_connection_realm($1,$2,$3,$4) o", [args.p_connection, args.p_realm_id, args.p_realm_envelope, args.p_realm_index])).o;
    }
    await r.check("each live connection is protected; the disconnected (terminal) one is left unchanged", async () =>
      outcomes[A1] === "protected" && outcomes[B1] === "protected" && outcomes[A2] === "protected" && outcomes[AG] === "terminal_unchanged" || outcomes);
    await r.check("after backfill every existing column is still unchanged (only realm_envelope, realm_index and updated_at were written)", async () => JSON.stringify(await snapshot()) === JSON.stringify(before));
    const prot = Object.fromEntries((await db.admin.query("select id, company_id, environment, realm_id, realm_envelope, realm_index from public.qbo_connections")).rows.map((x) => [x.id, x]));
    await r.check("each envelope opens to exactly its realm, with the current or the previous key ring", async () => {
      for (const id of [A1, B1, A2]) { const x = prot[id]; if ((await openRealm(x.realm_envelope, x.environment, x.company_id, [K0, K1])) !== x.realm_id) return id; }
      return true;
    });
    await r.check("an envelope moved to another workspace does not open", async () => {
      try { await openRealm(prot[A1].realm_envelope, "sandbox", w.B, [K1]); return "opened"; } catch { return true; }
    });
    await r.check("two workspaces connected to the SAME QuickBooks company share one index (shared-realm checks keep working); different realms do not", async () =>
      prot[A1].realm_index === prot[B1].realm_index && prot[A1].realm_index !== prot[A2].realm_index && prot[A1].realm_index === await realmIndex(SHARED, "sandbox", IDX));
    await r.check("the index reveals nothing without its key: another key gives an unrelated index", async () => prot[A1].realm_index !== await realmIndex(SHARED, "sandbox", key("idx2")));
    await r.check("replay is idempotent; a wrong plaintext and a different index are refused; nothing is overwritten", async () => {
      const again = await protectExistingRealm(prot[A1], K1, [K1], IDX);
      const replay = (await svc("select public.qbo_protect_connection_realm($1,$2,$3,$4) o", [A1, SHARED, again.p_realm_envelope, again.p_realm_index])).o;
      const wrong = (await svc("select public.qbo_protect_connection_realm($1,$2,$3,$4) o", [A1, OTHER, again.p_realm_envelope, again.p_realm_index])).o;
      const conflict = (await svc("select public.qbo_protect_connection_realm($1,$2,$3,$4) o", [A1, SHARED, again.p_realm_envelope, await realmIndex(SHARED, "sandbox", key("idx3"))])).o;
      const still = (await db.one("select realm_envelope from public.qbo_connections where id=$1", [A1])).realm_envelope;
      return replay === "already_protected" && wrong === "realm_mismatch" && conflict === "index_conflict" && still === prot[A1].realm_envelope || { replay, wrong, conflict };
    });
    await r.refused("a signed-in member cannot call the backfill", "42501", () => db.asUser(w.U.owner, "select public.qbo_protect_connection_realm($1,$2,$3,$4)", [A1, SHARED, prot[A1].realm_envelope, prot[A1].realm_index]));
    await r.refused("a malformed envelope or index is refused by the constraint", "23514", () => db.admin.query("update public.qbo_connections set realm_envelope='plain', realm_index='h1.idx1.' || repeat('0',64) where id=$1", [A2]));

    r.group("Existing functions keep working on protected connections");
    await r.check("the held import lease is released and re-acquired; a member still sees the connection status", async () => {
      await svc("select public.qbo_release_refresh_lease($1,$2)", [A2, lease]);
      const again = (await svc("select public.qbo_acquire_refresh_lease($1,$2,90) id", [A2, env("d")])).id;
      const seen = await db.asRole("authenticated", w.U.owner, "select * from public.qbo_connection_status($1)", [w.A]);
      return again !== null && seen.length === 3 || { again, seen: seen.length };
    });
    await r.check("reconnecting the same QuickBooks company replaces the token on the SAME live row and keeps its protection", async () => {
      const id = await store(w.B, w.U.ownerB, SHARED, "sandbox", env("f"));
      const row = await db.one("select status, refresh_token_envelope, realm_envelope, realm_index from public.qbo_connections where id=$1", [B1]);
      return id === B1 && row.status === "active" && row.refresh_token_envelope === env("f") && row.realm_envelope === prot[B1].realm_envelope && row.realm_index === prot[B1].realm_index || { id, B1, row };
    });
  } catch (e) {
    crashed = true;
    console.error("CRASH", e?.stack ?? e);
  } finally {
    await db.close();
  }
  process.exit(r.finish("QBO realm protection candidate (inert)", crashed) ? 0 : 1);
}

await main();
