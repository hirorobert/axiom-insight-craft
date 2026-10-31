// Native proof of the workspace source-access repairs (independent review of #229: findings 2, 3 and 5, and the re-review of finding 3 and the audit
// semantics), on the full migration chain in a disposable loopback database. Synthetic data only; never a hosted database; no Storage token is minted (the
// signer is a local stand-in, and says so).
//
// The download sequence under test is supabase/functions/_shared/sourceDownload.ts itself, run with REAL database dependencies: the precheck is
// can_user_act_on_workspace (as the service role, exactly as the function calls it), the upload row is read from trial_balance_uploads, the issuance
// decision is decide_trial_balance_source_download_issuance and a refusal is record_trial_balance_source_download_denial, both as the service role. Only
// Storage signing is local: a stand-in that returns an obviously fake URL (optionally after a checkpoint), so the proof can place a withdrawal at an exact
// point of the sequence. That is orchestration evidence; it is NOT evidence of what Storage does with a token, or of response delivery to a browser.
//
// ORDERING CONTRACT under test. The decision's COMMIT is the ordering point. Two deterministic orderings, placed with barriers (never sleeps):
//   * withdrawal commits first -> no 'issued' record and no link is returned;
//   * the issuance decision is admitted first (parked inside its transaction, after its locks and authority judgement, before the record is written) -> every
//     writer of the authority inputs must WAIT for it, so the withdrawal is ordered after the issuance; the link can still be delivered afterwards.
// A test-only BEFORE INSERT trigger on the decision table takes an advisory lock that a barrier session holds: that parks the decision after admission and
// before persistence. The proof observes pg_locks to know the decision is parked and whether the writer blocks or finishes.
//
// HARNESS CONTRACT. Every wait is bounded (scripts/db-proof/lib/checkpoints.mjs). An operation that finishes before its checkpoint, a callback that is never
// called, a thrown error and a hang are STRUCTURED FAILURES of that case; each case has a deadline; a watchdog bounds the whole run and writes the result
// file before exiting; cleanup always releases the barrier, cancels blocked backends, rolls back open sessions and drops the test-only triggers. Run against
// the rejected implementation this proof terminates by itself and reports which cases fail and why.
// DB_PROOF_MODE=external DB_PROOF_CONN=postgres://... | DB_PROOF_MODULES_DIR=<dir>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChain, certifier, csv, FY2026, makeWorld, openDatabase, REPO, uuid } from "./lib/reportingKit.mjs";
import { awaitCheckpoint, awaitCondition, checkpoint, HarnessFailure, runCase, withDeadline } from "./lib/checkpoints.mjs";
import { CASES, PROOF } from "./sourceAccessAuthority.manifest.mjs";
import { runSourceDownload } from "../../supabase/functions/_shared/sourceDownload.ts";

const results = [], failures = [];
const manifest = fs.readFileSync(new URL("./sourceAccessAuthority.manifest.mjs", import.meta.url));
const output = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results/sourceAccessAuthority.present.json");
const CASE_DEADLINE_MS = Number(process.env.PROOF_CASE_DEADLINE_MS ?? 60_000);
const RUN_DEADLINE_MS = Number(process.env.PROOF_RUN_DEADLINE_MS ?? 420_000);
let db, W, U, completed = false, crashed = false, crashMessage = null, seq = 0;

function writeResult() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), completed, crashed, crashMessage, cases: results }, null, 2) + "\n");
}
// The watchdog: whatever is stuck, the run ends, reports what it has, marks the cases it never reached, and exits non-zero.
const watchdog = setTimeout(() => {
  for (const c of CASES) if (!results.some((r) => r.id === c.id)) { results.push({ id: c.id, outcome: "fail", code: "run_deadline", detail: `run_deadline: the run exceeded ${RUN_DEADLINE_MS} ms before this case finished` }); failures.push(c.id); }
  crashed = false; completed = true; writeResult();
  console.log(`SOURCE_ACCESS_AUTHORITY: run deadline exceeded after ${RUN_DEADLINE_MS} ms; FAILED: ${failures.join(", ")}`);
  process.exit(1);
}, RUN_DEADLINE_MS);

async function kase(id, fn) {
  if (process.env.SOURCE_ONLY && !id.startsWith("setup.") && !id.includes(process.env.SOURCE_ONLY)) return;
  assert(CASES.some((c) => c.id === id), `case ${id} not in manifest`); assert(!results.some((c) => c.id === id), `duplicate ${id}`);
  try { await runCase(fn, { deadlineMs: CASE_DEADLINE_MS }); results.push({ id, outcome: "pass" }); console.log("PASS", id); }
  catch (e) {
    const code = e instanceof HarnessFailure ? e.code : e.code ?? "assertion";
    results.push({ id, outcome: "fail", code, detail: `${code}: ${String(e.message).split("\n")[0]}` }); failures.push(id);
    console.log("FAIL", id, "-", `[${code}]`, String(e.message).split("\n")[0].slice(0, 500));
  }
}
const one = async (sql, p = []) => (await db.admin.query(sql, p)).rows[0];
const CAP = "manage_source_files";
const TABLE = "public.trial_balance_source_download_events";

async function newAccount() {
  const uid = uuid();
  await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [uid, `srcowner-${uid}@example.test`]);
  const prod = (await db.one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  const bc = (await db.one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
  await db.admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 8 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  return uid;
}
/** A workspace with an upload; `U.preparer` and `U.viewer` may be added as accepted members, `U.partner` is a grant-only collaborator (no membership). */
async function workspace() {
  const owner = await newAccount();
  const A = await W.company(owner, `Source access case ${++seq}`, "ipsas_accrual");
  const k = await certifier(db, { ...U, owner });
  const upload = await k.upload(A, 2026, csv(FY2026));
  return { A, owner, uploadId: upload.id };
}
const addMember = (A, uid, role = "preparer") => db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, uid, role]);
const grant = async (w, uid, cap = CAP) => { const r = (await db.asRole("authenticated", w.owner, "SELECT * FROM public.grant_workspace_capability($1,$2,$3)", [w.A, uid, cap]))[0]; assert.equal(r.outcome, "granted", JSON.stringify(r)); return r.grant_id; };
const allowed = async (w, uid) => (await db.asService("SELECT public.can_user_act_on_workspace($1,$2,$3) r", [uid, w.A, CAP])).r;
const removeMember = (w, uid) => db.asRole("authenticated", w.owner, "DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [w.A, uid]);
const openGrants = async (w, uid) => Number((await one("SELECT count(*) n FROM public.workspace_capability_grants WHERE company_id=$1 AND grantee_user_id=$2 AND revoked_at IS NULL", [w.A, uid])).n);
const events = (w) => db.admin.query(`SELECT * FROM ${TABLE} WHERE company_id=$1 ORDER BY occurred_at, id`, [w.A]).then((r) => r.rows);
const outcomes = async (w) => (await events(w)).map((e) => e.outcome);

// ── database sessions: tracked, bounded, always cleaned up ───────────────────────────────────────────────────────────
async function session(scope, role, uid) {
  const c = await db.pool.connect();
  let finished = false, settled = false, result = null;
  await c.query("BEGIN");
  if (role !== "postgres") { await c.query(`SET LOCAL ROLE ${role}`); await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]); }
  const pid = (await c.query("SELECT pg_backend_pid() p")).rows[0].p;
  const finish = async (how) => { if (finished) return; finished = true; try { await c.query(how); } catch { /* the backend was cancelled */ } finally { c.release(); } };
  scope.defer(async () => {
    if (finished) return;
    if (!settled) await db.admin.query("SELECT pg_cancel_backend($1)", [pid]).catch(() => {});   // a blocked statement must not outlive its case
    await finish("ROLLBACK");
  });
  return {
    pid, get settled() { return settled; }, get result() { return result; },
    start: (sql, p) => c.query(sql, p).then((x) => { settled = true; result = { rows: x.rows, rowCount: x.rowCount }; return result; }, (err) => { settled = true; result = { err }; return result; }),
    commit: () => finish("COMMIT"), rollback: () => finish("ROLLBACK"),
  };
}
/** A session holding the barrier lock; the test-only trigger makes an issuance INSERT wait for it. */
async function barrier(scope) {
  const c = await db.pool.connect();
  await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(hashtextextended('proof-download-barrier', 0))");
  let done = false;
  const release = async () => { if (done) return; done = true; try { await c.query("COMMIT"); } finally { c.release(); } };
  scope.defer(release);
  return { release };
}
async function installTrigger(scope, name, fn, when = "WHEN (NEW.outcome = 'issued')") {
  await db.admin.query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${TABLE} FOR EACH ROW ${when} EXECUTE FUNCTION public.${fn}()`);
  scope.defer(() => db.admin.query(`DROP TRIGGER IF EXISTS ${name} ON ${TABLE}`));
}
const waitingAny = async (pid) => (await db.admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted", [pid])).rowCount > 0;
const waitingAdvisory = async (pid) => (await db.admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted AND locktype='advisory'", [pid])).rowCount > 0;

// ── the writers of the authority inputs (each is a way a withdrawal happens) ─────────────────────────────────────────
const WRITERS = {
  "explicit-revoke": { role: "authenticated", as: (w) => w.owner, sql: "SELECT * FROM public.revoke_workspace_capability($1,$2,$3)", params: (w) => [w.A, U.preparer, CAP] },
  "member-removal": { role: "authenticated", as: (w) => w.owner, sql: "DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", params: (w) => [w.A, U.preparer], prep: (w) => addMember(w.A, U.preparer) },
  "plan-lapse": { role: "postgres", as: () => null, sql: "UPDATE public.commercial_licences SET effective_end = now() - interval '1 minute' WHERE billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id=$1)", params: (w) => [w.owner] },
};
async function startWriter(scope, name, w) {
  const WR = WRITERS[name]; const s = await session(scope, WR.role, WR.as(w));
  return { s, run: () => s.start(WR.sql, WR.params(w)) };
}

// ── the orchestration with REAL database dependencies ───────────────────────────────────────────────────────────────
const DECIDE = "SELECT public.decide_trial_balance_source_download_issuance($1,$2,$3,$4,$5,$6,$7,$8) r";
const decideParams = (r) => [r.userId, r.companyId, r.uploadId, r.signingStartedAt, r.signingCompletedAt, r.linkExpiresAt, r.linkExpirySource, r.sha256];
const resolveUpload = async (id) => (await one("SELECT id, company_id, user_id, file_path, file_name, file_size, source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [id])) ?? null;
const canDownload = async (userId, companyId) => (await db.asService("SELECT public.can_user_act_on_workspace($1,$2,$3) r", [userId, companyId, CAP])).r === true;
const recordDenial = async (e) => { await db.asService("SELECT public.record_trial_balance_source_download_denial($1,$2,$3,$4) r", [e.userId, e.companyId, e.uploadId, e.sha256]); };
/**
 * The dependencies of one download. `decide` runs the real decision in a tracked session and announces it through hooks.onDecisionSession, so a test can park
 * it. `record` is the REJECTED implementation's name for its unconditional insert: the current orchestration never calls it, but the rejected one does, and
 * the same dependencies let this repaired proof run against it (its schema, its columns, a tracked and parkable session).
 */
function makeDeps(scope, uid, over = {}, hooks = {}) {
  const inSession = async (sql, params) => {
    const s = await session(scope, "service_role");
    hooks.onDecisionSession?.(s);
    const r = await s.start(sql, params);
    if (r.err) { await s.rollback(); throw r.err; }
    await s.commit();
    return r;
  };
  return {
    authenticate: async () => uid,
    resolveUpload, canDownload, recordDenial,
    sign: async () => ({ url: "https://signer.invalid/proof-only-not-a-storage-token" }),
    decide: async (req) => (await inSession(DECIDE, decideParams(req))).rows[0].r.outcome,
    // rejected implementation only (its columns): an unconditional insert as the service role
    record: async (e) => {
      try {
        await inSession(`INSERT INTO ${TABLE} (company_id, upload_id, actor_user_id, outcome, link_expires_at, object_sha256) VALUES ($1,$2,$3,$4,$5,$6)`, [e.companyId, e.uploadId, e.userId, e.outcome, e.expiresAt, e.sha256]);
        return true;
      } catch { return false; }
    },
    ...over,
  };
}
const request = (w) => ({ uploadId: w.uploadId, companyId: w.A });
/** For cases that need no parking: a one-shot scope-less set of dependencies. */
const plain = (uid, over = {}) => {
  const noScope = { defer() {} };
  return makeDeps(noScope, uid, over);
};

try {
  db = await openDatabase("source_access_authority");
  await kase("setup.chain-and-world", async () => {
    const err = await applyChain(db); assert.equal(err, null, String(err));
    W = await makeWorld(db); U = W.U;
    // test-only helpers: a barrier that parks an issuance INSERT, and a failure injector
    await db.admin.query(`CREATE FUNCTION public.proof_download_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('proof-download-barrier', 0)); RETURN NEW; END $$`);
    await db.admin.query(`CREATE FUNCTION public.proof_download_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'proof: injected audit-insert failure' USING ERRCODE = 'P0001'; END $$`);
  });
  if (failures.length) throw new Error("setup failed");

  // ── finding 2 ────────────────────────────────────────────────────────────────────────────
  await kase("removal.the-grant-is-revoked-in-the-removing-transaction", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); const g = await grant(w, U.preparer);
    assert.equal(await allowed(w, U.preparer), true, "precondition: the member's grant authorises file access");
    const res = await removeMember(w, U.preparer); assert.equal(res.length, 0);
    assert.equal((await one("SELECT count(*) n FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [w.A, U.preparer])).n, "0", "the membership is gone");
    assert.equal(await allowed(w, U.preparer), false, "removal must end file access: the real database predicate is now false");
    const row = await one("SELECT revoked_at, revoked_by_user_id FROM public.workspace_capability_grants WHERE id=$1", [g]);
    assert(row.revoked_at && row.revoked_by_user_id === w.owner, "the grant is revoked, by the person who removed the member");
    const ev = await one("SELECT action, outcome, actor_user_id FROM public.workspace_capability_grant_events WHERE grant_id=$1 AND action='revoke'", [g]);
    assert.deepEqual([ev.action, ev.outcome, ev.actor_user_id], ["revoke", "applied", w.owner], "the revocation is recorded exactly as an explicit revocation is");
  });
  await kase("removal.the-download-path-refuses-and-records-the-denial", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); await grant(w, U.preparer);
    assert.equal((await runSourceDownload(plain(U.preparer), request(w))).outcome, "ready", "precondition: before removal the member is served");
    await removeMember(w, U.preparer);
    const r = await runSourceDownload(plain(U.preparer), request(w));
    assert.deepEqual(r, { status: 403, outcome: "forbidden" }, "after removal a NEW link request is refused");
    assert.deepEqual(await outcomes(w), ["issued", "denied"]);
  });
  await kase("removal.a-collaborator-who-was-never-a-member-keeps-access", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); await grant(w, U.preparer); await grant(w, U.partner);   // partner: grant only, no membership
    await removeMember(w, U.preparer);
    assert.equal(await allowed(w, U.partner), true, "the supported grant-only collaborator path is not removed by removing someone else");
    assert.equal(await openGrants(w, U.partner), 1);
  });
  await kase("removal.owner-other-members-and-other-workspaces-are-untouched", async () => {
    const w = await workspace(), other = await workspace();
    for (const x of [w, other]) await addMember(x.A, U.preparer);
    await addMember(w.A, U.viewer); await grant(w, U.preparer); await grant(w, U.viewer); await grant(other, U.preparer);
    await removeMember(w, U.preparer);
    assert.equal(await allowed(w, w.owner), true, "the workspace owner is unaffected");
    assert.equal(await allowed(w, U.viewer), true, "another member's grant is unaffected");
    assert.equal(await allowed(other, U.preparer), true, "the same person's grant in ANOTHER workspace is unaffected: revocation is scoped to the workspace they were removed from");
  });
  await kase("removal.reinstatement-does-not-resurrect-old-grants", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); await grant(w, U.preparer);
    await removeMember(w, U.preparer); await addMember(w.A, U.preparer);
    assert.equal(await allowed(w, U.preparer), false, "re-adding the person does not bring back what removal ended");
    await grant(w, U.preparer);
    assert.equal(await allowed(w, U.preparer), true, "an explicit new grant by the owner does");
    assert.equal(Number((await one("SELECT count(*) n FROM public.workspace_capability_grants WHERE company_id=$1 AND grantee_user_id=$2", [w.A, U.preparer])).n), 2, "the revoked grant stays as history beside the new one");
  });
  await kase("removal.a-pending-invitation-removes-nothing", async () => {
    const w = await workspace(); await grant(w, U.preparer);                                                   // an independent grant ...
    await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,invitation_expires_at) VALUES ($1,$2,'preparer', now() + interval '1 day')", [w.A, U.preparer]);   // ... and a pending invitation, never accepted
    await removeMember(w, U.preparer);
    assert.equal(await allowed(w, U.preparer), true, "deleting a never-accepted invitation ends no access, because it gave none");
  });
  await kase("removal.a-demotion-changes-the-title-not-independent-grants", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer, "partner"); await grant(w, U.preparer);
    await db.asRole("authenticated", w.owner, "UPDATE public.firm_members SET role='viewer' WHERE company_id=$1 AND user_id=$2", [w.A, U.preparer]);
    assert.equal(await allowed(w, U.preparer), true, "a title change is not removal: independent grants are explicit and are kept");
  });
  await kase("removal.the-whole-removal-rolls-back-together", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); const g = await grant(w, U.preparer);
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated"); await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [w.owner]);
      await c.query("DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [w.A, U.preparer]);
      await c.query("ROLLBACK");
    } finally { c.release(); }
    assert.equal(await allowed(w, U.preparer), true, "a rolled-back removal leaves the grant in force");
    assert.equal((await one("SELECT revoked_at FROM public.workspace_capability_grants WHERE id=$1", [g])).revoked_at, null);
    assert.equal(Number((await one("SELECT count(*) n FROM public.workspace_capability_grant_events WHERE grant_id=$1 AND action='revoke'", [g])).n), 0);
  });

  // ── finding 3: the issuance decision's commit is the ordering point ─────────────────────────────────────────────────
  await kase("ordering.withdrawal-commits-first-no-issuance-no-url", async (scope) => {
    const w = await workspace(); await grant(w, U.preparer);
    const signing = checkpoint("signing-started");
    const d = makeDeps(scope, U.preparer, { sign: async () => { await signing.hit(); return { url: "https://signer.invalid/SECRET-proof-token" }; } });
    const download = runSourceDownload(d, request(w));
    await awaitCheckpoint(signing, download, { what: "the download" });                            // authority was read once and signing is now pending
    await db.asRole("authenticated", w.owner, "SELECT * FROM public.revoke_workspace_capability($1,$2,$3)", [w.A, U.preparer, CAP]);   // the withdrawal COMMITS before the decision begins
    signing.release();
    const r = await withDeadline(download, "the download after signing");
    assert.deepEqual(r, { status: 403, outcome: "forbidden" }, "a withdrawal that committed first wins");
    assert(!JSON.stringify(r).includes("SECRET"), "the minted link was discarded unseen");
    assert.deepEqual(await outcomes(w), ["withdrawn_before_issue"], "no 'issued' record exists");
  });
  const decisionFirst = (writerName) => async (scope) => {
    const w = await workspace(); await grant(w, U.preparer); await WRITERS[writerName].prep?.(w);
    await installTrigger(scope, "proof_download_barrier", "proof_download_barrier");
    const bar = await barrier(scope);
    const started = checkpoint("decision-session-started");
    const d = makeDeps(scope, U.preparer, {}, { onDecisionSession: (s) => { void started.hit(s); } });
    const download = runSourceDownload(d, request(w));
    const ds = await awaitCheckpoint(started, download, { what: "the download" });
    await awaitCondition("the issuance decision is parked inside its transaction, after admission and before its record", () => waitingAdvisory(ds.pid), download);
    const wr = await startWriter(scope, writerName, w); const wp = wr.run();
    const waits = await awaitCondition(`the withdrawal (${writerName}) waits for the pending issuance decision`, () => waitingAny(wr.s.pid), wp, { allowSettle: true });
    await bar.release();
    const r = await withDeadline(download, "the download after the barrier is released");
    if (!waits) {
      await wr.s.commit();
      assert.fail(`VIOLATION: the withdrawal (${writerName}) COMPLETED while an authorised issuance decision was pending, and the decision then ${r.outcome === "ready" ? "issued a link" : `answered ${r.outcome}`} after that withdrawal had committed`);
    }
    const wres = await withDeadline(wp, `the withdrawal (${writerName}) after the decision committed`);
    assert(!wres.err, `the withdrawal must complete once the decision committed (${wres.err?.message})`);
    await wr.s.commit();
    assert.equal(r.outcome, "ready", "the decision committed before the withdrawal: it is ordered first");
    assert(r.url, "response delivery after the withdrawal is permitted under the contract: the link issued by the committed decision is returned");
    assert.deepEqual(await outcomes(w), ["issued"], "exactly the one committed issuance decision");
    assert.equal(await allowed(w, U.preparer), false, "the withdrawal applied after the issuance");
    assert.deepEqual(await runSourceDownload(plain(U.preparer), request(w)), { status: 403, outcome: "forbidden" }, "and the very next request is refused");
  };
  for (const name of Object.keys(WRITERS)) await kase(`ordering.decision-commits-first.${name}-waits-and-the-link-may-be-delivered`, decisionFirst(name));
  const holderFirst = (writerName) => async (scope) => {
    const w = await workspace(); await grant(w, U.preparer); await WRITERS[writerName].prep?.(w);
    const wr = await startWriter(scope, writerName, w);
    const wres = await withDeadline(wr.run(), `the withdrawal (${writerName}), left uncommitted`);
    assert(!wres.err, `the withdrawal statement must run (${wres.err?.message})`);
    const started = checkpoint("decision-session-started");
    const d = makeDeps(scope, U.preparer, {}, { onDecisionSession: (s) => { void started.hit(s); } });
    const download = runSourceDownload(d, request(w));
    const ds = await awaitCheckpoint(started, download, { what: "the download" });
    await awaitCondition(`the issuance decision waits behind the withdrawal (${writerName}) that already holds its locks`, () => waitingAny(ds.pid), download);
    await wr.s.commit();
    const r = await withDeadline(download, "the download after the withdrawal committed");
    assert.deepEqual(r, { status: 403, outcome: "forbidden" }, "the withdrawal that took its locks first is ordered first: no link");
    assert.deepEqual(await outcomes(w), ["withdrawn_before_issue"]);
  };
  for (const name of ["explicit-revoke", "member-removal"]) await kase(`ordering.withdrawal-holding-its-locks-first.${name}-is-ordered-first`, holderFirst(name));
  await kase("ordering.a-collaborator-who-was-never-a-member-is-issued-and-unaffected-by-others", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); await grant(w, U.preparer); await grant(w, U.partner);
    await removeMember(w, U.preparer);
    const r = await runSourceDownload(plain(U.partner), request(w));
    assert.equal(r.outcome, "ready", "the grant-only collaborator is served; removing someone else changed nothing for them");
    assert.deepEqual(await outcomes(w), ["issued"]);
    assert.equal((await events(w))[0].actor_user_id, U.partner);
  });
  await kase("ordering.concurrent-downloads-and-a-revocation-terminate-in-one-order", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    const downloads = Array.from({ length: 6 }, () => runSourceDownload(plain(U.preparer), request(w)));
    const revoke = db.asRole("authenticated", w.owner, "SELECT * FROM public.revoke_workspace_capability($1,$2,$3)", [w.A, U.preparer, CAP]);
    const settled = await withDeadline(Promise.allSettled([...downloads, revoke]), "six downloads and a revocation at once", 30_000);
    const failed = settled.filter((s) => s.status === "rejected"); assert.equal(failed.length, 0, `no deadlock or error: ${failed.map((f) => f.reason?.message).join("; ")}`);
    const rs = settled.slice(0, 6).map((s) => s.value.outcome);
    assert(rs.every((o) => o === "ready" || o === "forbidden"), `only ready or forbidden: ${rs.join(",")}`);
    const evs = await events(w);
    assert.equal(evs.filter((e) => e.outcome === "issued").length, rs.filter((o) => o === "ready").length, "every link returned has exactly one committed issuance decision, and no other does");
    const firstWithdrawn = evs.findIndex((e) => e.outcome !== "issued");
    if (firstWithdrawn >= 0) assert(evs.slice(firstWithdrawn).every((e) => e.outcome !== "issued"), "once a withdrawal has been seen by a decision, no later decision issues");
    assert.equal(await allowed(w, U.preparer), false);
  });

  // ── expiry ───────────────────────────────────────────────────────────────────────────────
  await kase("expiry.signing-delay-records-the-bound-from-signing-completion", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    let offset = 0;
    const d = makeDeps({ defer() {} }, U.preparer, { now: () => Date.now() + offset, sign: async () => { offset += 25_000; return { url: "https://signer.invalid/proof-only-not-a-storage-token" }; } });
    const r = await runSourceDownload(d, request(w));
    assert.equal(r.outcome, "ready");
    const e = (await events(w))[0];
    assert.equal(e.link_expiry_source, "bound_signing_completed_plus_ttl");
    assert.equal(e.link_expires_at - e.signing_completed_at, 60_000, "expiry = signing completion + the requested lifetime");
    assert.equal(e.signing_completed_at - e.signing_started_at, 25_000, "the signing interval is recorded");
    assert(e.link_expires_at - e.occurred_at >= 80_000, "it is NOT 'decision time + 60 s': the delayed signature is accounted for");
  });
  await kase("expiry.signer-exp-is-recorded-as-such", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    const exp = Math.floor((Date.now() + 45_000) / 1000) * 1000;
    const r = await runSourceDownload(plain(U.preparer, { sign: async () => ({ url: "https://signer.invalid/proof-only-not-a-storage-token", expiresAtMs: exp }) }), request(w));
    assert.equal(r.outcome, "ready");
    const e = (await events(w))[0];
    assert.equal(e.link_expiry_source, "signer_token_exp"); assert.equal(e.link_expires_at.getTime(), exp);
  });
  await kase("expiry.expired-before-issuance-is-refused-and-recorded", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    const r = await runSourceDownload(plain(U.preparer, { sign: async () => ({ url: "https://signer.invalid/SECRET-proof-token", expiresAtMs: Date.now() - 5_000 }) }), request(w));
    assert.deepEqual(r, { status: 503, outcome: "link_expired" }); assert(!JSON.stringify(r).includes("SECRET"));
    assert.deepEqual(await outcomes(w), ["expired_before_issue"], "the refusal is a recorded decision; no 'issued' record");
  });

  // ── audit semantics ───────────────────────────────────────────────────────────────────────
  await kase("record.issuance-means-decision-not-delivery", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    await assert.rejects(async () => { await runSourceDownload(plain(U.preparer), request(w)); throw new Error("response write failed"); }, /response write failed/);   // delivery fails / the caller disconnects after the decision
    await runSourceDownload(plain(U.preparer), request(w)).then(() => {});                                                                            // a caller that never reads its answer
    const evs = await events(w);
    assert.deepEqual(evs.map((e) => e.outcome), ["issued", "issued"], "each committed decision stands; nothing marks, updates or removes it when delivery fails");
    const comment = (await one("SELECT obj_description('public.trial_balance_source_download_events'::regclass) c")).c;
    assert(/NOT evidence that a response was delivered or a file downloaded/.test(comment), "the schema says what an issued record is not");
  });
  await kase("record.no-decision-no-link", async (scope) => {
    const w = await workspace(); await grant(w, U.preparer);
    await installTrigger(scope, "proof_download_fail", "proof_download_fail", "");
    const r = await runSourceDownload(plain(U.preparer), request(w));
    assert.deepEqual(r, { status: 503, outcome: "audit_unavailable" }); assert.equal(r.url, undefined, "no link without its committed decision");
    assert.equal((await events(w)).length, 0, "the failed decision left nothing behind");
  });
  await kase("record.denied-is-recorded-for-a-precheck-refusal", async () => {
    const w = await workspace();
    const r = await runSourceDownload(plain(U.preparer), request(w));
    assert.deepEqual(r, { status: 403, outcome: "forbidden" });
    const e = (await events(w))[0];
    assert.deepEqual([e.outcome, e.signing_started_at, e.link_expires_at, e.link_expiry_source, e.actor_user_id], ["denied", null, null, null, U.preparer], "a denial signed nothing, so it carries no signing or expiry data");
  });
  await kase("record.holds-no-url-and-has-the-signing-shape", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    assert.equal((await runSourceDownload(plain(U.preparer), request(w))).outcome, "ready");
    const rows = await events(w); assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "issued"); assert(rows[0].link_expires_at && rows[0].signing_started_at && rows[0].signing_completed_at, "an issued record carries the signing interval and the expiry"); assert.equal(rows[0].actor_user_id, U.preparer);
    const cols = (await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='trial_balance_source_download_events'")).rows.map((x) => x.column_name);
    assert(!cols.some((c) => /url|token|path|signed/.test(c)), `no column can hold a URL, token or path: ${cols.join(",")}`);
    const dump = JSON.stringify((await db.admin.query(`SELECT * FROM ${TABLE} WHERE company_id=$1`, [w.A])).rows);
    assert(!/signer\.invalid|token|workspaces\//.test(dump), "no stored value contains a URL, a token or a path");
    await assert.rejects(() => db.admin.query(`INSERT INTO ${TABLE} (company_id, upload_id, actor_user_id, outcome) VALUES ($1,$2,$3,'issued')`, [w.A, w.uploadId, U.preparer]), /chk_tbsde_signing_complete/, "an 'issued' row without its signing data cannot exist");
  });
  await kase("record.only-the-decision-functions-write", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    await assert.rejects(() => db.asService(`INSERT INTO ${TABLE} (company_id, upload_id, actor_user_id, outcome) VALUES ($1,$2,$3,'denied')`, [w.A, w.uploadId, U.preparer]), /permission denied/, "the service role has no direct insert: no unconditional audit insert exists");
    for (const sql of ["SELECT public.decide_trial_balance_source_download_issuance($1,$2,$3,now(),now(),now() + interval '1 minute','signer_token_exp',NULL)", "SELECT public.record_trial_balance_source_download_denial($1,$2,$3,NULL)"]) {
      await assert.rejects(() => db.asRole("authenticated", w.owner, sql, [U.preparer, w.A, w.uploadId]), /permission denied/, "no signed-in user can call the decision functions");
    }
    const bad = (await db.asService(DECIDE, [U.preparer, w.A, uuid(), new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), "signer_token_exp", null])).r;
    assert.equal(bad.outcome, "invalid", "an upload that does not exist records nothing");
    assert.equal((await events(w)).length, 0);
  });
  await kase("record.append-only-and-readable-only-by-the-workspace-owner", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    await runSourceDownload(plain(U.preparer), request(w));
    const id = (await one(`SELECT id FROM ${TABLE} WHERE company_id=$1`, [w.A])).id;
    for (const sql of [`UPDATE ${TABLE} SET outcome='denied' WHERE id=$1`, `DELETE FROM ${TABLE} WHERE id=$1`]) {
      await assert.rejects(() => db.admin.query(sql, [id]), /append-only/, "even the database owner cannot change or delete a record");
    }
    await assert.rejects(() => db.admin.query(`TRUNCATE ${TABLE}`), /append-only/);
    await assert.rejects(() => db.asRole("authenticated", w.owner, `INSERT INTO ${TABLE} (company_id, upload_id, actor_user_id, outcome) VALUES ($1,$2,$3,'denied')`, [w.A, w.uploadId, w.owner]), /permission denied/, "no signed-in user can write a record");
    assert.equal((await db.asRole("authenticated", w.owner, `SELECT id FROM ${TABLE} WHERE company_id=$1`, [w.A])).length, 1, "the workspace owner can read the workspace's records");
    assert.equal((await db.asRole("authenticated", U.preparer, `SELECT id FROM ${TABLE} WHERE company_id=$1`, [w.A])).length, 0, "the person who was served cannot");
    assert.equal((await db.asRole("authenticated", U.ownerB, `SELECT id FROM ${TABLE}`, [])).length, 0, "another workspace's owner sees nothing of it");
  });
  completed = failures.length === 0;
} catch (e) { crashed = true; crashMessage = `${e.code ?? ""}: ${e.stack ?? e.message}`; console.error(crashMessage); process.exitCode = 1; }
finally {
  clearTimeout(watchdog);
  writeResult();
  console.log(`SOURCE_ACCESS_AUTHORITY: ${results.filter((r) => r.outcome === "pass").length}/${CASES.length} passed${failures.length ? `; FAILED: ${failures.join(", ")}` : ""}`);
  if (failures.length) process.exitCode = 1;
  await db?.close(); process.exit(process.exitCode ?? 0);
}
