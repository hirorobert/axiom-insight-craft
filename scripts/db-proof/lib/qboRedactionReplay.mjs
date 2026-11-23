// Executes the REAL redaction migration (20261231300000) once more against seeded rows that still hold a plaintext realm, inside a transaction the
// caller rolls back. Shared by the disposable-database proof (plain PostgreSQL) and the local Supabase-stack journey (Supabase's PostgreSQL, with
// the safeupdate guard loaded into the session, so every UPDATE and DELETE the migration executes is checked by safeupdate itself).
//
// Why the migration's own final rules are undone first: on a database where the four parts are already installed, the redaction is a replay and
// returns before its first statement (it recognises itself by chk_qbo_connections_live_no_plaintext). To make PostgreSQL parse, plan and run each
// of its UPDATE and DELETE statements on real rows, the three no-plaintext constraints are dropped and the plaintext unique index re-created IN
// THIS TRANSACTION ONLY; seeded rows then reproduce the pre-redaction state (a live connection and a pending operation holding a verified
// plaintext; a terminal connection and a finished operation holding a plaintext as history). Nothing is committed.
//
// Returns { ok, detail }: ok only when the migration ran to completion, the live plaintext is gone, the history is byte-identical, and (when
// asked) safeupdate was demonstrably active in the session.
import { generate, OLD_DIGEST, partTwoDefinition } from "../../release/genQboSharedRealmDisconnect.mjs";

export async function replayRedaction(c, { migrationSql, protect, sealToken, companyId, actorId, loadSafeupdate = false, runAs = null }) {
  const detail = {};
  // On Supabase only a superuser may LOAD the library (supautils refuses it to postgres), and only authenticator preloads it. So the caller connects
  // as the local superuser, the library is loaded into THAT session, and everything below runs as `runAs` (postgres, the role that applies
  // migrations): the safeupdate hook stays installed in the session whatever the current role.
  if (loadSafeupdate) await c.query("LOAD 'safeupdate'");
  if (runAs) {
    if (!/^[a-z_][a-z0-9_]*$/.test(runAs)) throw new Error("runAs is not a role name");
    await c.query(`SET LOCAL ROLE ${runAs}`);
    detail.runAs = (await c.query("SELECT current_user u")).rows[0].u;
  }
  if (loadSafeupdate) {
    await c.query("SAVEPOINT safeupdate_probe");
    try { await c.query("DELETE FROM public.qbo_oauth_states"); detail.safeupdate = "an unqualified DELETE was NOT refused"; }
    catch (e) { detail.safeupdate = /WHERE/i.test(String(e.message)) ? "active" : `unexpected: ${String(e.message).slice(0, 120)}`; }
    await c.query("ROLLBACK TO SAVEPOINT safeupdate_probe");
  }
  // Undo the redaction's own final rules, in this transaction only, so that the migration runs in full instead of returning as a replay.
  for (const [t, k] of [["qbo_connections", "chk_qbo_connections_live_no_plaintext"], ["qbo_disconnect_operations", "chk_qbo_disconnect_operations_no_plaintext"],
    ["qbo_oauth_states", "chk_qbo_oauth_states_no_plaintext"]]) await c.query(`ALTER TABLE public.${t} DROP CONSTRAINT ${k}`);
  await c.query("CREATE UNIQUE INDEX uq_qbo_connections_live ON public.qbo_connections (company_id, realm_id, environment) WHERE status <> 'disconnected'");
  // The redaction's preflight pins every part 2 body. Phase D (20261231400000) later replaced qbo_begin_disconnect; on a database where it is
  // installed, the reviewed part 2 body is reinstated IN THIS TRANSACTION ONLY (exactly that one body, and only when the installed one is Phase D's
  // pinned body: any other difference still makes the redaction refuse, as it must).
  const installed = (await c.query("SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') d FROM pg_proc WHERE oid = to_regprocedure('public.qbo_begin_disconnect(uuid,uuid,uuid)')")).rows[0]?.d;
  if (installed === generate().newDigest) {
    await c.query(partTwoDefinition());
    detail.partTwoBodyReinstated = (await c.query("SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') d FROM pg_proc WHERE oid = to_regprocedure('public.qbo_begin_disconnect(uuid,uuid,uuid)')")).rows[0]?.d === OLD_DIGEST;
  }

  const LIVE = "9130354000000041", TERM = "9130354000000042";
  const pl = await protect(LIVE), pt = await protect(TERM);
  const live = (await c.query(`INSERT INTO public.qbo_connections (company_id, connected_by_user_id, realm_id, environment, status, refresh_token_envelope, envelope_key_id,
      refresh_expires_at, realm_envelope, realm_index, realm_verified_at)
    VALUES ($1,$2,$3,'sandbox','active',$4,split_part($4,'.',2),now()+interval '100 days',$5,$6,clock_timestamp()) RETURNING id`,
    [companyId, actorId, LIVE, await sealToken(LIVE), pl.envelope, pl.index])).rows[0].id;
  const term = (await c.query(`INSERT INTO public.qbo_connections (company_id, connected_by_user_id, realm_id, environment, status, disconnected_at, realm_envelope, realm_index,
      realm_verified_at) VALUES ($1,$2,$3,'sandbox','disconnected',clock_timestamp(),$4,$5,clock_timestamp()) RETURNING id`, [companyId, actorId, TERM, pt.envelope, pt.index])).rows[0].id;
  const op = (id, realm, p, outcome) => c.query(`INSERT INTO public.qbo_disconnect_operations (connection_id, request_id, actor_user_id, company_id, realm_id, environment, outcome,
      completed_at, realm_envelope, realm_index, realm_verified_at) VALUES ($1, gen_random_uuid(), $2, $3, $4, 'sandbox', $5, $6, $7, $8, clock_timestamp())`,
    [id, actorId, companyId, realm, outcome, outcome === "pending" ? null : new Date().toISOString(), p.envelope, p.index]);
  await op(live, LIVE, pl, "pending");
  await op(term, TERM, pt, "revoked");
  const HIST = `SELECT 'c' t, id::text k, ROW(realm_id, realm_envelope, realm_index, realm_verified_at, status)::text r FROM public.qbo_connections WHERE status = 'disconnected'
    UNION ALL SELECT 'o', connection_id::text, ROW(realm_id, realm_envelope, realm_index, realm_verified_at, outcome)::text FROM public.qbo_disconnect_operations WHERE outcome <> 'pending'
    UNION ALL SELECT 'i', id::text, ROW(realm_id, realm_envelope, realm_index)::text FROM public.qbo_pull_intents
    UNION ALL SELECT 'p', id::text, ROW(realm_id, realm_envelope, realm_index)::text FROM public.qbo_pulls ORDER BY 1, 2`;
  const history = JSON.stringify((await c.query(HIST)).rows);
  detail.seededHistoryRows = (await c.query(HIST)).rows.length;

  await c.query(migrationSql);   // the committed file, unchanged: preflight, gate, every UPDATE/DELETE, final rules, postcondition

  const lc = (await c.query("SELECT realm_id FROM public.qbo_connections WHERE id = $1", [live])).rows[0];
  const lo = (await c.query("SELECT realm_id FROM public.qbo_disconnect_operations WHERE connection_id = $1", [live])).rows[0];
  const tc = (await c.query("SELECT realm_id FROM public.qbo_connections WHERE id = $1", [term])).rows[0];
  const to = (await c.query("SELECT realm_id, outcome FROM public.qbo_disconnect_operations WHERE connection_id = $1", [term])).rows[0];
  const rules = (await c.query(`SELECT (SELECT count(*)::int FROM pg_constraint WHERE conname IN ('chk_qbo_connections_live_no_plaintext',
      'chk_qbo_disconnect_operations_no_plaintext', 'chk_qbo_oauth_states_no_plaintext')) n, to_regclass('public.uq_qbo_connections_live') IS NULL dropped`)).rows[0];
  detail.live = { connection: lc.realm_id === null, pendingOperation: lo.realm_id === null };
  detail.history = { unchanged: JSON.stringify((await c.query(HIST)).rows) === history, terminalKeepsPlaintext: tc.realm_id === TERM, finishedOpKeepsPlaintext: to.realm_id === TERM && to.outcome === "revoked" };
  detail.finalRules = rules;
  const ok = (!loadSafeupdate || detail.safeupdate === "active") && detail.live.connection && detail.live.pendingOperation
    && detail.history.unchanged && detail.history.terminalKeepsPlaintext && detail.history.finishedOpKeepsPlaintext && rules.n === 3 && rules.dropped;
  return { ok, detail };
}
