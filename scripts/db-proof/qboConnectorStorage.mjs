// Native proof of the QuickBooks Online connector storage (migration 20261212100000, charter B9): connections, single-use OAuth state and append-only
// provenance, on the full migration chain in a disposable loopback database. Synthetic data only; never a hosted database; no Intuit call and no real token
// (the "envelopes" below are well-formed strings of no value, the shape supabase/functions/_shared/qboTokenEnvelope.ts produces).
// DB_PROOF_MODE=external DB_PROOF_CONN=postgres://... | DB_PROOF_MODULES_DIR=<dir>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChain, makeWorld, openDatabase, REPO, uuid } from "./lib/reportingKit.mjs";
import { CASES, PROOF } from "./qboConnectorStorage.manifest.mjs";

const results = [], failures = [];
const manifest = fs.readFileSync(new URL("./qboConnectorStorage.manifest.mjs", import.meta.url));
const output = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results/qboConnectorStorage.present.json");
const RUN_DEADLINE_MS = Number(process.env.PROOF_RUN_DEADLINE_MS ?? 300_000);
let db, W, U, ACTOR, completed = false, crashed = false, crashMessage = null, seq = 0;

function writeResult() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), completed, crashed, crashMessage, cases: results }, null, 2));
}
const watchdog = setTimeout(() => {
  for (const c of CASES) if (!results.some((r) => r.id === c.id)) { results.push({ id: c.id, outcome: "fail", code: "run_deadline", detail: `run_deadline: exceeded ${RUN_DEADLINE_MS} ms before this case` }); failures.push(c.id); }
  completed = true; writeResult(); console.log(`QBO_CONNECTOR_STORAGE: run deadline exceeded; FAILED: ${failures.join(", ")}`); process.exit(1);
}, RUN_DEADLINE_MS);

async function kase(id, fn) {
  assert(CASES.some((c) => c.id === id), `case ${id} not in manifest`); assert(!results.some((c) => c.id === id), `duplicate ${id}`);
  try { await fn(); results.push({ id, outcome: "pass" }); console.log("PASS", id); }
  catch (e) {
    const code = e.code ?? "assertion";
    results.push({ id, outcome: "fail", code, detail: `${code}: ${String(e.message).split("\n")[0]}` }); failures.push(id);
    console.log("FAIL", id, "-", `[${code}]`, String(e.message).split("\n")[0].slice(0, 500));
  }
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rnd = () => crypto.randomBytes(8).toString("hex");
const one = async (sql, p = []) => (await db.admin.query(sql, p)).rows[0];
const svc = async (sql, p = []) => (await db.asService(sql, p));
const future = (days) => new Date(Date.now() + days * 864e5).toISOString();
const envelope = (key = "k1") => `v1.${key}.${rnd()}${rnd()}.${rnd()}${rnd()}${rnd()}`;
const realm = () => String(Math.floor(1e15 + Math.random() * 9e15));
const FN = {
  start: "SELECT public.qbo_start_oauth_state($1,$2,$3,$4,$5,$6) r",
  consume: "SELECT * FROM public.qbo_consume_oauth_state($1)",
  store: "SELECT public.qbo_store_connection($1,$2,$3,$4,$5,$6,$7) r",
  rotate: "SELECT public.qbo_rotate_refresh_token($1,$2,$3,$4,$5) r",
  reconnect: "SELECT public.qbo_mark_reconnect_needed($1) r",
  disconnect: "SELECT public.qbo_disconnect($1,$2) r",
  lease: "SELECT public.qbo_acquire_refresh_lease($1,$2,$3) r",
  release: "SELECT public.qbo_release_refresh_lease($1) r",
  intent: "SELECT public.qbo_record_pull_intent($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) r",
  complete: "SELECT public.qbo_complete_pull($1) r",
  pending: "SELECT public.qbo_complete_pending_pulls() r",
  house: "SELECT * FROM public.qbo_housekeeping()",
  retention: "SELECT * FROM public.qbo_provenance_past_retention($1::interval)",
};
const start = async (company, actor, env = "sandbox", ttl = 600, hash = sha(rnd()), year = 2026) => ({ hash, r: (await svc(FN.start, [hash, company, actor, env, ttl, year])).r });
const store = async (company, actor, over = {}) => {
  const o = { realm: realm(), env: "sandbox", env_: envelope(), ...over };
  return { ...o, id: (await svc(FN.store, [company, actor, o.realm, o.env, o.env_, future(100), future(1800)])).r };
};
const conn = (id) => one("SELECT * FROM public.qbo_connections WHERE id=$1", [id]);
const company = (owner = U.owner, name = `QBO proof ${++seq}`) => W.company(owner, name);
const intentArgs = (reservation, o = {}) => [reservation, o.connection ?? null, o.actor ?? U.owner, o.realm ?? realm(), o.env ?? "sandbox", o.start ?? "2026-01-01", o.end ?? "2026-10-31",
  o.method ?? "Accrual", o.minor ?? 75, o.currency ?? "USD", o.count ?? 46, o.raw ?? sha("raw" + rnd()), o.canonical ?? sha("canon" + rnd()), o.result ?? sha("result" + rnd())];
const denied = /permission denied/i;

try {
  db = await openDatabase("qbo_connector_storage");
  await kase("setup.chain-and-world", async () => {
    const err = await applyChain(db); assert.equal(err, null, String(err));
    W = await makeWorld(db); U = W.U;
    const basis = async (u, c = W.A) => (await svc("SELECT public.workspace_authority_basis($1,$2,'prepare_trial_balance') r", [u, c])).r;
    assert.ok(await basis(U.owner), "the workspace owner holds the right");
    assert.equal(await basis(U.viewer), null, "a viewer does not hold the right");
    assert.equal(await basis(U.ownerB), null, "another workspace's owner does not hold it here");
    // prepare_trial_balance reaches a non-owner only by an explicit grant (titles confer other capabilities): give it to the preparer.
    assert.equal(await basis(U.preparer), null, "a preparer holds no such right by title alone");
    const g = (await db.asRole("authenticated", U.owner, "SELECT * FROM public.grant_workspace_capability($1,$2,'prepare_trial_balance')", [W.A, U.preparer]))[0];
    assert.equal(g.outcome, "granted", JSON.stringify(g));
    assert.ok(await basis(U.preparer), "the explicit grant confers the right");
    ACTOR = U.preparer;
  });
  if (failures.length) throw new Error("setup failed");

  // ── secrecy ──────────────────────────────────────────────────────────────────────────────────────────────────────
  await kase("clients.cannot-read-or-write-connections-or-oauth-states", async () => {
    const c = await store(W.A, U.owner);
    for (const role of ["authenticated", "anon"]) {
      for (const t of ["qbo_connections", "qbo_oauth_states"]) {
        await assert.rejects(() => db.asRole(role, U.owner, `SELECT * FROM public.${t}`), denied, `${role} cannot read ${t}`);
      }
      await assert.rejects(() => db.asRole(role, U.owner, "UPDATE public.qbo_connections SET status='disconnected' WHERE id=$1", [c.id]), denied);
      await assert.rejects(() => db.asRole(role, U.owner, "DELETE FROM public.qbo_connections WHERE id=$1", [c.id]), denied);
      await assert.rejects(() => db.asRole(role, U.owner, "INSERT INTO public.qbo_oauth_states (state_hash, company_id, actor_user_id, environment, return_period_year, expires_at) VALUES ($1,$2,$3,'sandbox', 2026, now() + interval '5 minutes')", [sha(rnd()), W.A, U.owner]), denied);
    }
    assert.ok((await svc("SELECT count(*)::int n FROM public.qbo_connections")).n >= 1, "the service role can read connections (the Edge Function opens the envelope)");
    await assert.rejects(() => svc("UPDATE public.qbo_connections SET status='disconnected' WHERE id=$1", [c.id]), denied, "the service role cannot write the table directly either");
  });
  await kase("clients.cannot-call-the-writers-only-the-status-function", async () => {
    const calls = [[FN.start, [sha(rnd()), W.A, U.owner, "sandbox", 600, 2026]], [FN.consume, [sha(rnd())]], [FN.store, [W.A, U.owner, realm(), "sandbox", envelope(), future(1), null]],
      [FN.rotate, [uuid(), envelope(), envelope(), future(1), null]], [FN.reconnect, [uuid()]], [FN.disconnect, [uuid(), U.owner]], [FN.lease, [uuid(), envelope(), 60]], [FN.release, [uuid()]], [FN.intent, intentArgs(uuid())], [FN.complete, [uuid()]], [FN.pending, []], [FN.house, []], [FN.retention, ["7 years"]]];
    for (const role of ["authenticated", "anon"]) for (const [sql, p] of calls) await assert.rejects(() => db.asRole(role, U.owner, sql, p), denied, `${role}: ${sql.slice(0, 40)}`);
    await assert.doesNotReject(() => db.asRole("authenticated", U.owner, "SELECT * FROM public.qbo_connection_status($1)", [W.A]));
    await assert.rejects(() => db.asRole("anon", null, "SELECT * FROM public.qbo_connection_status($1)", [W.A]), denied, "anonymous callers cannot even ask for status");
  });

  // ── OAuth state ──────────────────────────────────────────────────────────────────────────────────────────────────
  await kase("state.start-stores-only-a-hash-and-requires-the-right", async () => {
    const a = await start(W.A, U.owner);
    assert.equal(a.r, "created");
    const row = await one("SELECT * FROM public.qbo_oauth_states WHERE state_hash=$1", [a.hash]);
    assert.equal(row.company_id, W.A); assert.equal(row.actor_user_id, U.owner); assert.equal(row.environment, "sandbox"); assert.equal(row.consumed_at, null);
    assert.equal((await start(W.A, U.viewer)).r, "forbidden", "a viewer cannot start a connection");
    assert.equal((await start(W.A, U.ownerB)).r, "forbidden", "another workspace's owner cannot");
    assert.equal((await start(uuid(), U.owner)).r, "forbidden", "an unknown workspace is refused");
    assert.equal((await start(W.A, U.owner, "sandbox", 600, "not-a-hash")).r, "invalid");
    assert.equal((await start(W.A, U.owner, "staging")).r, "invalid");
    assert.equal((await start(W.A, U.owner, "sandbox", 59)).r, "invalid", "shorter than a minute");
    assert.equal((await start(W.A, U.owner, "sandbox", 1801)).r, "invalid", "longer than thirty minutes");
    for (const bad of [1999, 2101, null]) assert.equal((await start(W.A, U.owner, "sandbox", 600, sha(rnd()), bad)).r, "invalid", `a return year of ${bad} is refused`);
    assert.equal(row.return_period_year, 2026, "the period page to return to is stored with the state");
    assert.equal((await svc(FN.start, [a.hash, W.A, U.owner, "sandbox", 600, 2026])).r, "invalid", "a repeated state is refused");
    const cols = (await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_name='qbo_oauth_states'")).rows.map((r) => r.column_name);
    assert.ok(!cols.includes("state"), "the state itself is never stored, only its hash");
  });
  await kase("state.is-single-use", async () => {
    const a = await start(W.A, ACTOR, "production");
    const first = (await db.asRole("service_role", null, FN.consume, [a.hash]));
    assert.equal(first.length, 1); assert.deepEqual([first[0].company_id, first[0].actor_user_id, first[0].environment, first[0].return_period_year], [W.A, ACTOR, "production", 2026]);
    assert.equal((await db.asRole("service_role", null, FN.consume, [a.hash])).length, 0, "the second use returns nothing");
    // two concurrent consumers: exactly one wins
    const b = await start(W.A, U.owner);
    const both = await Promise.all([db.asRole("service_role", null, FN.consume, [b.hash]), db.asRole("service_role", null, FN.consume, [b.hash])]);
    assert.equal(both.filter((r) => r.length === 1).length, 1, "exactly one of two concurrent consumers wins");
  });
  await kase("state.expired-or-unknown-returns-nothing", async () => {
    const a = await start(W.A, U.owner);
    await db.admin.query("UPDATE public.qbo_oauth_states SET created_at = now() - interval '2 hours', expires_at = now() - interval '90 minutes' WHERE state_hash=$1", [a.hash]);
    assert.equal((await db.asRole("service_role", null, FN.consume, [a.hash])).length, 0, "an expired state is not accepted");
    assert.equal((await db.asRole("service_role", null, FN.consume, [sha("never issued")])).length, 0, "an unknown state returns nothing");
    assert.equal((await db.asRole("service_role", null, FN.consume, ["short"])).length, 0, "a malformed state returns nothing");
    assert.equal((await one("SELECT consumed_at FROM public.qbo_oauth_states WHERE state_hash=$1", [a.hash])).consumed_at, null, "an expired state is not marked consumed");
  });
  await kase("state.consumed-but-the-actor-lost-the-right-returns-nothing-and-cannot-be-retried", async () => {
    const c = await company();
    const member = uuid();
    await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [member, `qbomember-${member}@example.test`]);
    await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now())", [c, member]);
    const grant = async () => (await db.asRole("authenticated", U.owner, "SELECT * FROM public.grant_workspace_capability($1,$2,'prepare_trial_balance')", [c, member]))[0];
    assert.equal((await grant()).outcome, "granted");
    const a = await start(c, member);
    assert.equal(a.r, "created", "the member held the right when the state was started");
    const rv = (await db.asRole("authenticated", U.owner, "SELECT * FROM public.revoke_workspace_capability($1,$2,'prepare_trial_balance')", [c, member]))[0];
    assert.ok(rv, "the right was revoked");
    assert.equal((await db.asRole("service_role", null, FN.consume, [a.hash])).length, 0, "the right is judged again at consumption: nothing is returned");
    assert.ok((await one("SELECT consumed_at FROM public.qbo_oauth_states WHERE state_hash=$1", [a.hash])).consumed_at, "the state is consumed all the same");
    assert.equal((await grant()).outcome, "granted", "the right is granted again");
    assert.equal((await db.asRole("service_role", null, FN.consume, [a.hash])).length, 0, "and the state cannot be retried even though the right returned");
  });
  await kase("state.lifetime-is-bounded-at-thirty-minutes", async () => {
    await assert.rejects(() => db.admin.query("INSERT INTO public.qbo_oauth_states (state_hash, company_id, actor_user_id, environment, return_period_year, expires_at) VALUES ($1,$2,$3,'sandbox', 2026, now() + interval '31 minutes')", [sha(rnd()), W.A, U.owner]), /chk_qbo_state_lifetime/);
    await assert.rejects(() => db.admin.query("INSERT INTO public.qbo_oauth_states (state_hash, company_id, actor_user_id, environment, return_period_year, expires_at) VALUES ($1,$2,$3,'sandbox', 2026, now() - interval '1 minute')", [sha(rnd()), W.A, U.owner]), /chk_qbo_state_lifetime/);
  });

  // ── connections and tokens ───────────────────────────────────────────────────────────────────────────────────────
  await kase("connection.store-requires-the-right-and-validates-the-envelope", async () => {
    await assert.rejects(() => svc(FN.store, [W.A, U.viewer, realm(), "sandbox", envelope(), future(1), null]), /FORBIDDEN/, "a viewer cannot connect");
    await assert.rejects(() => svc(FN.store, [W.A, U.ownerB, realm(), "sandbox", envelope(), future(1), null]), /FORBIDDEN/);
    await assert.rejects(() => svc(FN.store, [uuid(), U.owner, realm(), "sandbox", envelope(), future(1), null]), /FORBIDDEN/, "an unknown workspace is refused");
    await assert.rejects(() => svc(FN.store, [W.A, U.owner, "12ab", "sandbox", envelope(), future(1), null]), /chk_qbo_conn|violates check/i, "a malformed realm id");
    await assert.rejects(() => svc(FN.store, [W.A, U.owner, realm(), "staging", envelope(), future(1), null]), /violates check/i, "an unknown environment");
    for (const bad of ["a-clear-refresh-token", "v2.k1.aaaa.bbbb", "v1.K1.aaaa.bbbb", "v1.k1.aaaa", "v1.k1.aa aa.bbbb", ""]) {
      await assert.rejects(() => svc(FN.store, [W.A, U.owner, realm(), "sandbox", bad, future(1), null]), /violates check/i, `not an envelope: ${bad}`);
    }
    await assert.rejects(() => svc(FN.store, [W.A, U.owner, realm(), "sandbox", envelope(), null, null]), /violates check|null value/i, "an active connection needs its expiry");
    const c = await store(W.A, ACTOR, { env_: envelope("key-7") });
    const row = await conn(c.id);
    assert.equal(row.envelope_key_id, "key-7", "the key id is derived from the envelope, never supplied separately");
    assert.equal(row.connected_by_user_id, ACTOR); assert.equal(row.status, "active");
  });
  await kase("connection.storing-twice-replaces-the-one-live-connection", async () => {
    const r = realm();
    const a = await store(W.A, U.owner, { realm: r, env_: envelope("k1") });
    const b = await store(W.A, ACTOR, { realm: r, env_: envelope("k2") });
    assert.equal(b.id, a.id, "the same company, realm and environment keeps one connection");
    const row = await conn(a.id);
    assert.equal(row.refresh_token_envelope, b.env_); assert.equal(row.envelope_key_id, "k2"); assert.equal(row.connected_by_user_id, ACTOR);
    assert.equal(await db.count("SELECT count(*)::int n FROM public.qbo_connections WHERE company_id=$1 AND realm_id=$2 AND environment='sandbox'", [W.A, r]), 1);
    const other = await store(W.A, U.owner, { realm: r, env: "production" });
    assert.notEqual(other.id, a.id, "another environment is another connection");
    await assert.rejects(() => db.admin.query("INSERT INTO public.qbo_connections (company_id, connected_by_user_id, realm_id, environment, refresh_token_envelope, envelope_key_id, refresh_expires_at) VALUES ($1,$2,$3,'sandbox',$4,'k1', now() + interval '1 day')", [W.A, U.owner, r, envelope()]), /uq_qbo_connections_live/, "the database also refuses a second live row");
  });
  await kase("connection.a-token-exists-exactly-while-the-connection-is-active", async () => {
    const c = await store(W.A, U.owner);
    await assert.rejects(() => db.admin.query("UPDATE public.qbo_connections SET refresh_token_envelope = NULL WHERE id=$1", [c.id]), /chk_qbo_conn_token_iff_active/, "an active connection cannot lose its token");
    await assert.rejects(() => db.admin.query("UPDATE public.qbo_connections SET status='reconnect_needed' WHERE id=$1", [c.id]), /chk_qbo_conn_/, "an inactive connection cannot keep one");
    assert.equal((await svc(FN.reconnect, [c.id])).r, true);
    await assert.rejects(() => db.admin.query("UPDATE public.qbo_connections SET status='active' WHERE id=$1", [c.id]), /chk_qbo_conn_token_iff_active/, "it cannot be made active without a token");
  });
  await kase("rotation.is-compare-and-swap-and-only-one-concurrent-refresh-wins", async () => {
    const c = await store(W.A, U.owner, { env_: envelope("k1") });
    const e2 = envelope("k2"), e3 = envelope("k2");
    assert.equal((await svc(FN.rotate, [c.id, envelope("k1"), e2, future(100), future(1800)])).r, false, "a stale expectation changes nothing");
    assert.equal((await conn(c.id)).refresh_token_envelope, c.env_);
    assert.equal((await svc(FN.rotate, [c.id, c.env_, e2, future(100), future(1800)])).r, true);
    const after = await conn(c.id);
    assert.equal(after.refresh_token_envelope, e2); assert.equal(after.envelope_key_id, "k2");
    // two refreshes that both started from e2: exactly one wins
    const both = await Promise.all([db.asRole("service_role", null, FN.rotate, [c.id, e2, e3, future(100), future(1800)]), db.asRole("service_role", null, FN.rotate, [c.id, e2, envelope("k2"), future(100), future(1800)])]);
    assert.equal(both.filter((r) => r[0].r === true).length, 1, "exactly one of two concurrent refreshes wins");
    const current = (await conn(c.id)).refresh_token_envelope;
    await assert.rejects(() => svc(FN.rotate, [c.id, current, "not-an-envelope", future(1), null]), /violates check/i, "a malformed new envelope is refused");
  });
  await kase("rotation.is-refused-for-an-inactive-connection", async () => {
    const c = await store(W.A, U.owner);
    assert.equal((await svc(FN.reconnect, [c.id])).r, true);
    assert.equal((await svc(FN.rotate, [c.id, c.env_, envelope(), future(1), null])).r, false);
    assert.equal((await svc(FN.rotate, [uuid(), envelope(), envelope(), future(1), null])).r, false, "an unknown connection");
  });
  await kase("reconnect-needed.deletes-the-dead-token", async () => {
    const c = await store(W.A, U.owner);
    assert.equal((await svc(FN.reconnect, [c.id])).r, true);
    const row = await conn(c.id);
    assert.equal(row.status, "reconnect_needed");
    assert.deepEqual([row.refresh_token_envelope, row.envelope_key_id, row.refresh_expires_at, row.hard_expires_at], [null, null, null, null], "no token, key id or expiry is kept");
    assert.equal((await svc(FN.reconnect, [c.id])).r, false, "an already inactive connection is not changed again");
    const again = await store(W.A, U.owner, { realm: c.realm, env_: envelope() });
    assert.equal(again.id, c.id, "reconnecting stores a fresh token on the same connection");
    assert.equal((await conn(c.id)).status, "active");
  });
  await kase("disconnect.needs-the-right-deletes-the-token-and-is-terminal", async () => {
    const c = await store(W.A, U.owner);
    assert.equal((await svc(FN.disconnect, [c.id, U.viewer])).r, "forbidden");
    assert.equal((await svc(FN.disconnect, [c.id, U.ownerB])).r, "forbidden");
    assert.equal((await svc(FN.disconnect, [uuid(), U.owner])).r, "unknown");
    assert.equal((await conn(c.id)).status, "active", "a refused disconnect changes nothing");
    assert.equal((await svc(FN.disconnect, [c.id, ACTOR])).r, "disconnected");
    const row = await conn(c.id);
    assert.equal(row.status, "disconnected"); assert.ok(row.disconnected_at);
    assert.deepEqual([row.refresh_token_envelope, row.envelope_key_id, row.refresh_expires_at, row.hard_expires_at], [null, null, null, null], "the stored token is deleted");
    assert.equal((await svc(FN.disconnect, [c.id, U.owner])).r, "already");
    await assert.rejects(() => db.admin.query("UPDATE public.qbo_connections SET connected_by_user_id=$2 WHERE id=$1", [c.id, U.owner]), /QBO_CONNECTION_TERMINAL/, "a disconnected connection cannot change, even for the database owner");
    const live = await store(W.A, U.owner);
    await assert.rejects(() => db.admin.query("UPDATE public.qbo_connections SET realm_id='1' WHERE id=$1", [live.id]), /QBO_CONNECTION_IDENTITY_FIXED/);
    await assert.rejects(() => db.admin.query("UPDATE public.qbo_connections SET company_id=$2 WHERE id=$1", [live.id, W.B]), /QBO_CONNECTION_IDENTITY_FIXED/);
  });
  await kase("disconnect.then-a-new-live-connection-may-be-stored", async () => {
    const r = realm();
    const a = await store(W.A, U.owner, { realm: r });
    assert.equal((await svc(FN.disconnect, [a.id, U.owner])).r, "disconnected");
    const b = await store(W.A, U.owner, { realm: r });
    assert.notEqual(b.id, a.id, "a new connection, not the terminal one");
    assert.equal((await conn(a.id)).status, "disconnected"); assert.equal((await conn(b.id)).status, "active");
  });
  await kase("status.members-see-status-never-an-envelope-key-or-token", async () => {
    const c = await company(U.owner, `QBO status ${++seq}`);
    const cx = await store(c, U.owner);
    const cols = (await db.admin.query("SELECT a.attname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace, unnest(p.proargnames) WITH ORDINALITY a(attname,i) WHERE n.nspname='public' AND p.proname='qbo_connection_status'")).rows.map((r) => r.attname);
    for (const forbidden of ["refresh_token_envelope", "envelope_key_id", "hard_expires_at"]) assert.ok(!cols.includes(forbidden), `status never returns ${forbidden}`);
    const own = await db.asRole("authenticated", U.owner, "SELECT * FROM public.qbo_connection_status($1)", [c]);
    assert.equal(own.length, 1); assert.equal(own[0].id, cx.id); assert.equal(own[0].status, "active");
    assert.ok(!JSON.stringify(own).includes(cx.env_), "the envelope is not in what the owner sees");
    assert.equal((await db.asRole("authenticated", U.viewer, "SELECT * FROM public.qbo_connection_status($1)", [W.A])).length, 0, "a viewer sees nothing");
    assert.equal((await db.asRole("authenticated", U.ownerB, "SELECT * FROM public.qbo_connection_status($1)", [c])).length, 0, "another workspace's owner sees nothing");
    assert.equal((await db.asRole("authenticated", uuid(), "SELECT * FROM public.qbo_connection_status($1)", [c])).length, 0, "a stranger sees nothing");
  });
  await kase("company-deletion.removes-connections-and-states", async () => {
    // Deleting a workspace that still has its owner membership is refused by the existing last-owner guard, so the cascade is proved from the
    // constraint itself: both tables reference companies with ON DELETE CASCADE (the tokens go with the workspace), and nothing else references them.
    for (const t of ["qbo_connections", "qbo_oauth_states"]) {
      const fk = await one("SELECT confdeltype, confrelid::regclass::text AS ref FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=$1::regclass AND attname='company_id')]", [`public.${t}`]);
      assert.ok(fk, `${t}.company_id is a foreign key`);
      assert.equal(fk.ref, "companies"); assert.equal(fk.confdeltype, "c", `${t} cascades when its company is deleted`);
    }
    assert.equal(await db.count("SELECT count(*)::int n FROM pg_constraint WHERE confrelid IN ('public.qbo_connections'::regclass, 'public.qbo_oauth_states'::regclass)"), 0, "no other table references them, so nothing blocks the cascade");
  });

  // ── rotation lease (finding: two simultaneous refreshes must never both reach Intuit with the same token) ─────────
  await kase("lease.only-one-caller-holds-it-and-it-names-the-envelope", async () => {
    const c = await store(W.A, U.owner);
    assert.equal((await svc(FN.lease, [c.id, envelope("k1"), 60])).r, false, "an out-of-date envelope never gets the lease");
    assert.equal((await svc(FN.lease, [c.id, c.env_, 5])).r, false, "too short a lease is refused");
    assert.equal((await svc(FN.lease, [c.id, c.env_, 301])).r, false, "too long a lease is refused");
    assert.equal((await svc(FN.lease, [uuid(), c.env_, 60])).r, false, "an unknown connection");
    assert.equal((await svc(FN.lease, [c.id, c.env_, 60])).r, true, "the first caller takes it");
    assert.equal((await svc(FN.lease, [c.id, c.env_, 60])).r, false, "the second is told no, without any call to Intuit");
    const fresh = await store(W.A, U.owner);
    const both = await Promise.all(Array.from({ length: 8 }, () => db.asRole("service_role", null, FN.lease, [fresh.id, fresh.env_, 60])));
    assert.equal(both.filter((rows) => rows[0].r === true).length, 1, "of eight simultaneous callers exactly one holds the lease");
  });
  await kase("lease.lapses-by-itself-is-released-on-demand-and-is-cleared-by-rotation", async () => {
    const c = await store(W.A, U.owner);
    assert.equal((await svc(FN.lease, [c.id, c.env_, 60])).r, true);
    await db.admin.query("UPDATE public.qbo_connections SET refresh_lease_until = clock_timestamp() - interval '1 second' WHERE id=$1", [c.id]);
    assert.equal((await svc(FN.lease, [c.id, c.env_, 60])).r, true, "a lapsed lease (a crashed import) can be taken again");
    assert.equal((await svc(FN.release, [c.id])).r, true, "released on demand");
    assert.equal((await svc(FN.release, [c.id])).r, false, "releasing nothing changes nothing");
    assert.equal((await svc(FN.lease, [c.id, c.env_, 60])).r, true);
    const next = envelope("k1");
    assert.equal((await svc(FN.rotate, [c.id, c.env_, next, future(100), future(1800)])).r, true);
    assert.equal((await conn(c.id)).refresh_lease_until, null, "rotation clears the lease");
    assert.equal((await svc(FN.lease, [c.id, c.env_, 60])).r, false, "and the old envelope can no longer take one");
  });
  await kase("lease.never-outlives-an-active-token", async () => {
    const a = await store(W.A, U.owner), b = await store(W.A, U.owner), d = await store(W.A, U.owner);
    for (const x of [a, b, d]) assert.equal((await svc(FN.lease, [x.id, x.env_, 60])).r, true);
    assert.equal((await svc(FN.reconnect, [a.id])).r, true);
    assert.equal((await conn(a.id)).refresh_lease_until, null, "a dead token holds no lease");
    assert.equal((await svc(FN.disconnect, [b.id, U.owner])).r, "disconnected");
    assert.equal((await conn(b.id)).refresh_lease_until, null, "a disconnected connection holds no lease");
    assert.equal((await svc(FN.lease, [a.id, a.env_, 60])).r, false, "no lease on an inactive connection");
    await assert.rejects(() => db.admin.query("UPDATE public.qbo_connections SET refresh_lease_until = now() + interval '1 minute' WHERE id=$1", [a.id]), /violates check/i, "the table itself refuses a lease on an inactive connection");
    const again = await store(W.A, U.owner, { realm: (await conn(d.id)).realm_id });
    assert.equal((await conn(again.id)).refresh_lease_until, null, "reconnecting clears a stale lease");
  });

  // ── evidence: intent first, then the link to the upload ──────────────────────────────────────────────────────────
  const reserveAs = async (user, c) => (await db.asRole("authenticated", user, "SELECT * FROM public.reserve_trial_balance_source($1,'quickbooks.csv')", [c]))[0];
  const putObject = (p) => db.admin.query("INSERT INTO storage.objects (bucket_id, name) VALUES ('trial-balance-files', $1)", [p]);
  const registerAs = async (user, r, year) => (await db.asRole("authenticated", user, "SELECT * FROM public.register_trial_balance_upload($1,10,$2,NULL,NULL)", [r.reservation_id, year]))[0];
  // A reservation row for a person who could not reserve it themself (to prove the evidence function judges rights on its own).
  const fakeReservation = async (c, actor) => {
    const id = uuid();
    await db.admin.query("INSERT INTO public.trial_balance_source_reservations (id, company_id, object_path, file_name, actor_user_id, authority_basis, expires_at) VALUES ($1,$2,$3,'f.csv',$4,'explicit_capability', now() + interval '10 minutes')", [id, c, `workspaces/${c}/${id}/f.csv`, actor]);
    return id;
  };
  const rightOf = async (u, c, cap) => (await svc("SELECT public.workspace_authority_basis($1,$2,$3) r", [u, c, cap])).r;

  await kase("intent.needs-both-rights-the-actors-own-open-reservation-and-valid-facts", async () => {
    const c = await company(U.owner, `QBO intent ${++seq}`);
    await db.asRole("authenticated", U.owner, "SELECT * FROM public.grant_workspace_capability($1,$2,'prepare_trial_balance')", [c, ACTOR]);
    await db.asRole("authenticated", U.owner, "SELECT * FROM public.grant_workspace_capability($1,$2,'manage_source_files')", [c, U.partner]);
    assert.ok(await rightOf(ACTOR, c, "prepare_trial_balance"), "ACTOR holds prepare_trial_balance here");
    assert.equal(await rightOf(ACTOR, c, "manage_source_files"), null, "ACTOR does not hold manage_source_files");
    assert.ok(await rightOf(U.partner, c, "manage_source_files"), "the partner holds manage_source_files here");
    assert.equal(await rightOf(U.partner, c, "prepare_trial_balance"), null, "and not prepare_trial_balance");
    const reserved = await reserveAs(U.owner, c);
    assert.equal(reserved.outcome, "reserved");
    const forbid = (promise, why) => assert.rejects(() => promise, /FORBIDDEN/, why);
    await forbid(svc(FN.intent, intentArgs(await fakeReservation(c, ACTOR), { actor: ACTOR })), "prepare_trial_balance WITHOUT manage_source_files is refused");
    await forbid(svc(FN.intent, intentArgs(await fakeReservation(c, U.partner), { actor: U.partner })), "manage_source_files WITHOUT prepare_trial_balance is refused");
    await forbid(svc(FN.intent, intentArgs(await fakeReservation(c, U.viewer), { actor: U.viewer })), "a viewer is refused");
    await forbid(svc(FN.intent, intentArgs(await fakeReservation(c, U.ownerB), { actor: U.ownerB })), "another workspace's owner is refused");
    await forbid(svc(FN.intent, intentArgs(reserved.reservation_id, { actor: ACTOR })), "a reservation belongs to the person who made it");
    await forbid(svc(FN.intent, intentArgs(uuid())), "an unknown reservation is refused");
    await forbid(svc(FN.intent, intentArgs(null)), "no reservation is refused");
    const own = await fakeReservation(c, U.owner);
    await assert.rejects(() => svc(FN.intent, intentArgs(own, { realm: "x1" })), /violates check/i, "a malformed realm");
    for (const [label, over] of [["a short hash", { raw: "abc" }], ["an upper-case hash", { canonical: sha("x").toUpperCase() }], ["a bad currency", { currency: "usd" }],
      ["dates the wrong way round", { start: "2026-11-01", end: "2026-10-31" }], ["a negative count", { count: -1 }], ["an unknown method", { method: "Other" }], ["an unknown environment", { env: "test" }]]) {
      await assert.rejects(() => svc(FN.intent, intentArgs(reserved.reservation_id, over)), /violates check/i, label);
    }
    const expired = await fakeReservation(c, U.owner);
    await db.admin.query("UPDATE public.trial_balance_source_reservations SET expires_at = now() - interval '1 minute' WHERE id=$1", [expired]);
    await assert.rejects(() => svc(FN.intent, intentArgs(expired)), /RESERVATION_NOT_OPEN/, "an expired reservation");
    const id = (await svc(FN.intent, intentArgs(reserved.reservation_id))).r;
    const row = await one("SELECT * FROM public.qbo_pull_intents WHERE id=$1", [id]);
    assert.equal(row.company_id, c, "the workspace comes from the reservation, not from the caller");
    assert.equal(row.report, "TrialBalance"); assert.equal(row.actor_user_id, U.owner);
  });
  await kase("intent.is-idempotent-for-the-same-facts-and-refuses-different-facts", async () => {
    const c = await company(U.owner, `QBO intent ${++seq}`);
    const r = await reserveAs(U.owner, c);
    const args = intentArgs(r.reservation_id);
    const first = (await svc(FN.intent, args)).r;
    assert.equal((await svc(FN.intent, args)).r, first, "a retry with the same facts returns the same row");
    assert.equal(await db.count("SELECT count(*)::int n FROM public.qbo_pull_intents WHERE reservation_id=$1", [r.reservation_id]), 1);
    await assert.rejects(() => svc(FN.intent, intentArgs(r.reservation_id, { canonical: sha("different") })), /INTENT_CONFLICT/, "different facts for the same reservation are refused");
    const both = await Promise.allSettled([db.asRole("service_role", null, FN.intent, intentArgs((await reserveAs(U.owner, c)).reservation_id)), db.asRole("service_role", null, FN.intent, intentArgs((await reserveAs(U.owner, c)).reservation_id))]);
    assert.equal(both.filter((x) => x.status === "fulfilled").length, 2, "different reservations are independent");
  });
  await kase("completion.links-the-intent-to-the-upload-the-reservation-itself-created", async () => {
    const c = await company(U.ownerB, `QBO complete ${++seq}`);
    const r = await reserveAs(U.ownerB, c);
    const args = intentArgs(r.reservation_id, { actor: U.ownerB, count: 31, currency: "GBP" });
    await svc(FN.intent, args);
    assert.equal((await svc(FN.complete, [uuid()])).r, "no_intent", "no intent, nothing to link");
    assert.equal((await svc(FN.complete, [r.reservation_id])).r, "not_registered", "before the upload exists there is nothing to link, and nothing is invented");
    assert.equal(await db.count("SELECT count(*)::int n FROM public.qbo_pulls WHERE company_id=$1", [c]), 0);
    await putObject(r.object_path);
    const reg = await registerAs(U.ownerB, r, 2026);
    assert.equal(reg.outcome, "registered", JSON.stringify(reg));
    assert.equal((await svc(FN.complete, [r.reservation_id])).r, "completed");
    assert.equal((await svc(FN.complete, [r.reservation_id])).r, "already", "re-running changes nothing");
    const pull = await one("SELECT * FROM public.qbo_pulls WHERE company_id=$1", [c]);
    assert.equal(pull.upload_id, reg.upload_id, "the upload id is the reservation's own, not a caller's");
    assert.equal(pull.account_count, 31); assert.equal(pull.currency, "GBP"); assert.equal(pull.actor_user_id, U.ownerB);
    assert.equal(pull.raw_sha256, args[11]); assert.equal(pull.canonical_sha256, args[12]); assert.equal(pull.result_sha256, args[13]);
    assert.equal(await db.count("SELECT count(*)::int n FROM public.qbo_pulls WHERE company_id=$1", [c]), 1, "one import, one upload, one row");
    const intent = await one("SELECT recorded_at FROM public.qbo_pull_intents WHERE reservation_id=$1", [r.reservation_id]);
    assert.equal(new Date(pull.pulled_at).getTime(), new Date(intent.recorded_at).getTime(), "the pull is dated when it was fetched, not when it was linked");
  });
  await kase("completion.a-right-lost-after-registration-cannot-lose-the-evidence", async () => {
    const c = await company(U.ownerB, `QBO complete ${++seq}`);
    await db.asRole("authenticated", U.ownerB, "SELECT * FROM public.grant_workspace_capability($1,$2,'prepare_trial_balance')", [c, U.partner]);
    await db.asRole("authenticated", U.ownerB, "SELECT * FROM public.grant_workspace_capability($1,$2,'manage_source_files')", [c, U.partner]);
    const r = await reserveAs(U.partner, c);
    assert.equal(r.outcome, "reserved");
    await svc(FN.intent, intentArgs(r.reservation_id, { actor: U.partner }));
    await putObject(r.object_path);
    assert.equal((await registerAs(U.partner, r, 2026)).outcome, "registered");
    assert.equal((await db.asRole("authenticated", U.ownerB, "SELECT * FROM public.revoke_workspace_capability($1,$2,'prepare_trial_balance')", [c, U.partner]))[0].outcome, "revoked");
    assert.equal(await rightOf(U.partner, c, "prepare_trial_balance"), null, "the right is gone");
    assert.equal((await svc(FN.complete, [r.reservation_id])).r, "completed", "the evidence is still written: it copies facts that were authorised when they happened");
  });
  await kase("recovery.completes-every-missing-link-and-nothing-else", async () => {
    const c = await company(U.ownerB, `QBO recover ${++seq}`);
    const made = [];
    for (const year of [2024, 2025]) {
      const r = await reserveAs(U.ownerB, c);
      await svc(FN.intent, intentArgs(r.reservation_id, { actor: U.ownerB })); await putObject(r.object_path);
      made.push({ r, reg: await registerAs(U.ownerB, r, year) });
    }
    const neverRegistered = await reserveAs(U.ownerB, c);
    await svc(FN.intent, intentArgs(neverRegistered.reservation_id, { actor: U.ownerB }));   // fetched, never imported
    assert.equal(await db.count("SELECT count(*)::int n FROM public.qbo_pulls WHERE company_id=$1", [c]), 0, "simulated failure: the link was never written");
    assert.ok((await svc(FN.pending)).r >= 2, "recovery reports what it completed");
    assert.equal(await db.count("SELECT count(*)::int n FROM public.qbo_pulls WHERE company_id=$1", [c]), 2, "exactly the two imports that exist are linked");
    for (const m of made) assert.equal((await one("SELECT count(*)::int n FROM public.qbo_pulls WHERE upload_id=$1", [m.reg.upload_id])).n, 1);
    assert.equal((await one("SELECT count(*)::int n FROM public.qbo_pull_intents WHERE reservation_id=$1", [neverRegistered.reservation_id])).n, 1, "the fetched-but-not-imported report keeps its intent as evidence");
    assert.equal(await db.count("SELECT count(*)::int n FROM public.qbo_pulls p WHERE p.company_id=$1 AND p.upload_id IS NULL", [c]), 0);
    assert.equal((await svc(FN.pending)).r, 0, "a second run finds nothing left to do");
  });
  await kase("recovery.one-unlinkable-row-never-stops-the-rest", async () => {
    const c = await company(U.ownerB, `QBO recover ${++seq}`);
    const bad = await reserveAs(U.ownerB, c); await svc(FN.intent, intentArgs(bad.reservation_id, { actor: U.ownerB })); await putObject(bad.object_path);
    const good = await reserveAs(U.ownerB, c); await svc(FN.intent, intentArgs(good.reservation_id, { actor: U.ownerB })); await putObject(good.object_path);
    const regBad = await registerAs(U.ownerB, bad, 2023), regGood = await registerAs(U.ownerB, good, 2024);
    assert.equal(regBad.outcome, "registered"); assert.equal(regGood.outcome, "registered");
    // Corrupt the reservation of the first so its recorded person disagrees with the intent: it must be left alone, loudly, when completed directly.
    await db.admin.query("UPDATE public.trial_balance_source_reservations SET actor_user_id=$2 WHERE id=$1", [bad.reservation_id, U.partner]);
    await assert.rejects(() => svc(FN.complete, [bad.reservation_id]), /INTENT_MISMATCH/, "a disagreement is refused, never papered over");
    await svc(FN.pending);
    assert.equal((await one("SELECT count(*)::int n FROM public.qbo_pulls WHERE upload_id=$1", [regGood.upload_id])).n, 1, "the good one is completed");
    assert.equal((await one("SELECT count(*)::int n FROM public.qbo_pulls WHERE upload_id=$1", [regBad.upload_id])).n, 0, "the mismatched one is left for a person");
  });
  await kase("evidence.is-append-only-even-for-the-database-owner", async () => {
    const c = await company(U.ownerB, `QBO append ${++seq}`);
    const r = await reserveAs(U.ownerB, c); const intentId = (await svc(FN.intent, intentArgs(r.reservation_id, { actor: U.ownerB }))).r; await putObject(r.object_path);
    await registerAs(U.ownerB, r, 2026); await svc(FN.complete, [r.reservation_id]);
    const pullId = (await one("SELECT id FROM public.qbo_pulls WHERE company_id=$1", [c])).id;
    for (const [t, id] of [["qbo_pull_intents", intentId], ["qbo_pulls", pullId]]) {
      await assert.rejects(() => db.admin.query(`UPDATE public.${t} SET account_count=1 WHERE id=$1`, [id]), /append-only/, `${t} update`);
      await assert.rejects(() => db.admin.query(`DELETE FROM public.${t} WHERE id=$1`, [id]), /append-only/, `${t} delete`);
      await assert.rejects(() => db.admin.query(`TRUNCATE public.${t}`), /append-only/, `${t} truncate`);
      for (const role of ["authenticated", "service_role"]) {
        await assert.rejects(() => db.asRole(role, U.ownerB, `UPDATE public.${t} SET account_count=1 WHERE id=$1`, [id]), denied, `${role} cannot update ${t}`);
        await assert.rejects(() => db.asRole(role, U.ownerB, `DELETE FROM public.${t} WHERE id=$1`, [id]), denied, `${role} cannot delete ${t}`);
        await assert.rejects(() => db.asRole(role, U.ownerB, `INSERT INTO public.${t} SELECT * FROM public.${t} WHERE id=$1`, [id]), denied, `${role} cannot insert into ${t}`);
      }
    }
  });
  await kase("evidence.is-readable-only-by-the-workspace-owner", async () => {
    const c = await company(U.ownerB, `QBO read ${++seq}`);
    const r = await reserveAs(U.ownerB, c); await svc(FN.intent, intentArgs(r.reservation_id, { actor: U.ownerB })); await putObject(r.object_path);
    await registerAs(U.ownerB, r, 2026); await svc(FN.complete, [r.reservation_id]);
    for (const t of ["qbo_pull_intents", "qbo_pulls"]) {
      assert.equal((await db.asRole("authenticated", U.ownerB, `SELECT id FROM public.${t} WHERE company_id=$1`, [c])).length, 1, `the workspace owner reads ${t}`);
      assert.equal((await db.asRole("authenticated", U.owner, `SELECT id FROM public.${t} WHERE company_id=$1`, [c])).length, 0, `another workspace's owner sees nothing in ${t}`);
      assert.equal((await db.asRole("authenticated", U.preparer, `SELECT id FROM public.${t} WHERE company_id=$1`, [c])).length, 0, `a person with no part in this workspace sees nothing in ${t}`);
      await assert.rejects(() => db.asRole("anon", null, `SELECT id FROM public.${t}`), denied, `anonymous callers cannot read ${t}`);
    }
  });
  await kase("evidence.holds-no-secret-url-or-payload-and-no-foreign-key", async () => {
    const cols = async (t) => (await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [t])).rows.map((r) => r.column_name);
    assert.deepEqual(await cols("qbo_pulls"), ["id", "pulled_at", "company_id", "upload_id", "connection_id", "actor_user_id", "realm_id", "environment", "report", "start_date", "end_date", "accounting_method", "minor_version", "currency", "account_count", "raw_sha256", "canonical_sha256", "result_sha256"]);
    assert.deepEqual(await cols("qbo_pull_intents"), ["id", "recorded_at", "reservation_id", "company_id", "connection_id", "actor_user_id", "realm_id", "environment", "report", "start_date", "end_date", "accounting_method", "minor_version", "currency", "account_count", "raw_sha256", "canonical_sha256", "result_sha256"]);
    for (const t of ["qbo_pulls", "qbo_pull_intents"]) {
      for (const c of await cols(t)) assert.ok(!/token|secret|url|payload|body|password|key/i.test(c), `no column may hold a secret, URL or payload: ${t}.${c}`);
      assert.equal(await db.count(`SELECT count(*)::int n FROM pg_constraint WHERE conrelid='public.${t}'::regclass AND contype='f'`), 0, `${t} has no foreign keys: the record outlives uploads, connections and workspaces`);
    }
  });

  // ── cleanup and retention ────────────────────────────────────────────────────────────────────────────────────────
  await kase("housekeeping.removes-old-states-and-dead-connections-and-never-evidence", async () => {
    const c = await company(U.ownerB, `QBO house ${++seq}`);
    const old = await start(c, U.ownerB), recent = await start(c, U.ownerB), live = await store(c, U.ownerB), dead = await store(c, U.ownerB), hard = await store(c, U.ownerB);
    await db.admin.query("UPDATE public.qbo_oauth_states SET created_at = now() - interval '3 days', expires_at = now() - interval '3 days' + interval '10 minutes' WHERE state_hash=$1", [old.hash]);
    await db.admin.query("UPDATE public.qbo_oauth_states SET expires_at = now() - interval '1 hour', created_at = now() - interval '1 hour 10 minutes' WHERE state_hash=$1", [recent.hash]);
    await db.admin.query("UPDATE public.qbo_connections SET refresh_expires_at = now() - interval '1 second' WHERE id=$1", [dead.id]);
    await db.admin.query("UPDATE public.qbo_connections SET hard_expires_at = now() - interval '1 second' WHERE id=$1", [hard.id]);
    const r = await reserveAs(U.ownerB, c); await svc(FN.intent, intentArgs(r.reservation_id, { actor: U.ownerB })); await putObject(r.object_path); await registerAs(U.ownerB, r, 2026); await svc(FN.complete, [r.reservation_id]);
    const evidence = async () => (await one("SELECT (SELECT count(*) FROM public.qbo_pull_intents)::int i, (SELECT count(*) FROM public.qbo_pulls)::int p"));
    const before = await evidence();
    const out = (await db.asRole("service_role", null, FN.house))[0];
    assert.ok(out.states_removed >= 1, "the three-day-old state is removed");
    assert.equal(await db.count("SELECT count(*)::int n FROM public.qbo_oauth_states WHERE state_hash=$1", [old.hash]), 0);
    assert.equal(await db.count("SELECT count(*)::int n FROM public.qbo_oauth_states WHERE state_hash=$1", [recent.hash]), 1, "a state expired less than a day ago is kept");
    assert.equal(out.connections_expired, 2);
    for (const x of [dead, hard]) {
      const row = await conn(x.id);
      assert.equal(row.status, "reconnect_needed"); assert.equal(row.refresh_token_envelope, null, "the dead token is deleted"); assert.equal(row.refresh_lease_until, null);
    }
    assert.equal((await conn(live.id)).status, "active", "a live connection is untouched");
    assert.deepEqual(await evidence(), before, "evidence is never touched");
    assert.equal((await db.asRole("service_role", null, FN.house))[0].connections_expired, 0, "a second run finds nothing");
  });
  await kase("retention.only-counts-evidence-past-an-interval-of-at-least-a-year", async () => {
    const before = await one("SELECT (SELECT count(*) FROM public.qbo_pull_intents)::int i, (SELECT count(*) FROM public.qbo_pulls)::int p");
    const out = (await db.asRole("service_role", null, FN.retention, ["7 years"]))[0];
    assert.equal(Number(out.intents), 0); assert.equal(Number(out.pulls), 0, "nothing in this database is seven years old");
    const future1 = (await db.asRole("service_role", null, FN.retention, ["1 year"]))[0];
    assert.equal(Number(future1.pulls), 0);
    for (const bad of ["1 day", "11 months", null]) await assert.rejects(() => db.asRole("service_role", null, FN.retention, [bad]), /RETENTION_TOO_SHORT/, `refused: ${bad}`);
    assert.deepEqual(await one("SELECT (SELECT count(*) FROM public.qbo_pull_intents)::int i, (SELECT count(*) FROM public.qbo_pulls)::int p"), before, "it deletes nothing");
    for (const role of ["anon", "authenticated"]) await assert.rejects(() => db.asRole(role, U.owner, FN.retention, ["7 years"]), denied, `${role} cannot ask`);
  });

  // ── structure ────────────────────────────────────────────────────────────────────────────────────────────────────
  await kase("structure.row-level-security-on-and-no-client-grants-beyond-the-reviewed-ones", async () => {
    for (const t of ["qbo_connections", "qbo_oauth_states", "qbo_pulls", "qbo_pull_intents"]) {
      assert.equal((await one("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [`public.${t}`])).relrowsecurity, true, `${t} has row level security`);
    }
    const priv = async (role, t, p) => (await one("SELECT has_table_privilege($1,$2,$3) r", [role, `public.${t}`, p])).r;
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
      for (const role of ["anon", "authenticated"]) for (const t of ["qbo_connections", "qbo_oauth_states"]) assert.equal(await priv(role, t, p), false, `${role} has no ${p} on ${t}`);
      assert.equal(await priv("service_role", "qbo_oauth_states", p), false, `service_role has no ${p} on qbo_oauth_states (functions only)`);
    }
    assert.equal(await priv("service_role", "qbo_connections", "SELECT"), true);
    for (const t of ["qbo_pulls", "qbo_pull_intents"]) {
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) for (const role of ["anon", "authenticated", "service_role"]) assert.equal(await priv(role, t, p), false, `${role} has no ${p} on ${t}`);
      assert.equal(await priv("anon", t, "SELECT"), false);
      assert.equal(await priv("authenticated", t, "SELECT"), true, "reads are limited by the owner policy");
    }
  });
  await kase("structure.writers-are-security-definer-with-a-pinned-search-path-and-service-role-only", async () => {
    const writers = ["qbo_start_oauth_state", "qbo_consume_oauth_state", "qbo_store_connection", "qbo_acquire_refresh_lease", "qbo_release_refresh_lease", "qbo_rotate_refresh_token", "qbo_mark_reconnect_needed", "qbo_disconnect",
      "qbo_record_pull_intent", "qbo_complete_pull", "qbo_complete_pending_pulls", "qbo_housekeeping", "qbo_provenance_past_retention", "qbo_connection_status"];
    for (const f of writers) {
      const r = await one("SELECT p.prosecdef, p.proconfig, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1", [f]);
      assert.equal(r.prosecdef, true, `${f} is SECURITY DEFINER`);
      assert.ok((r.proconfig ?? []).some((c) => /^search_path=pg_catalog, public$/.test(c)), `${f} pins search_path`);
      const can = async (role) => (await one("SELECT has_function_privilege($1, $2::oid, 'EXECUTE') r", [role, r.oid])).r;
      assert.equal(await can("anon"), false, `${f}: anon cannot execute`);
      assert.equal(await can("service_role"), true, `${f}: service_role execute`);
      assert.equal(await can("authenticated"), f === "qbo_connection_status", `${f}: authenticated execute`);
    }
  });
  completed = failures.length === 0;
} catch (e) { crashed = true; crashMessage = `${e.code ?? ""}: ${e.stack ?? e.message}`; console.error(crashMessage); process.exitCode = 1; }
finally {
  clearTimeout(watchdog);
  writeResult();
  console.log(`QBO_CONNECTOR_STORAGE: ${results.filter((r) => r.outcome === "pass").length}/${CASES.length} passed${failures.length ? `; FAILED: ${failures.join(", ")}` : ""}`);
  if (failures.length) process.exitCode = 1;
  await db?.close(); process.exit(process.exitCode ?? 0);
}
