// Deterministic multi-session proof of the IPSAS mutation authority ordering, on the full migration chain in a disposable loopback database.
//
// Question (independent review, source-level): ipsas_save_preparation / ipsas_confirm / ipsas_save_grants / ipsas_confirm_grant checked the
// caller's authority BEFORE waiting for their request and company-period advisory locks and did not check again afterwards. Can a request that was
// authorised, then waited, write after its authority was revoked?
//
// Method, per scenario - no sleeps for ordering, only polling of observable state with bounded timeouts:
//   1. a separate session HOLDS the protected lock (or a table lock) so the mutation must wait;
//   2. the mutation starts as an authenticated user and the proof waits until pg_locks shows it WAITING (not granted);
//   3. the authority change is made and COMMITTED through the normal path (revoke_member_capability, membership, rollout, framework, plan);
//   4. the held lock is released; the outcome and the persisted rows are inspected independently with the admin connection.
// The contract proven (docs/release/ipsas-accrual-chain-r1/AUTHORITY_ORDERING.md): a mutation never writes with authority that was revoked
// before it acquired its mutation boundary; revoking an explicit capability and a mutation of that person are serialised by one lock, so exactly
// one of them is first; the other inputs (membership, rollout, framework, plan) are re-evaluated after the boundary on a fresh snapshot.
// Synthetic data only. No hosted credentials. DB_PROOF_MODE=external DB_PROOF_CONN=postgres://... | DB_PROOF_MODULES_DIR=<dir>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChain, certifier, csv, FY2025, FY2026, makeWorld, openDatabase, REPO, uuid } from "./lib/reportingKit.mjs";
import { CASES, PROOF } from "./ipsasAuthorityOrdering.manifest.mjs";

const results = [];
const manifest = fs.readFileSync(new URL("./ipsasAuthorityOrdering.manifest.mjs", import.meta.url));
const output = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results/ipsasAuthorityOrdering.present.json");
let db, completed = false, crashed = false, crashMessage = null;
async function kase(id, fn) {
  assert(CASES.some((c) => c.id === id), `case ${id} not in manifest`); assert(!results.some((c) => c.id === id));
  try { await fn(); results.push({ id, outcome: "pass" }); console.log("PASS", id); }
  catch (e) { results.push({ id, outcome: "fail", detail: `${e.code ?? ""}: ${String(e.message).split("\n")[0]}` }); console.log("FAIL", id, "-", String(e.message).split("\n")[0].slice(0, 300)); throw e; }
}
/** Runs the cases after a failed one too (each is independent), so one run reports every defect. */
const failures = [];
async function each(id, fn) { try { await kase(id, fn); } catch (e) { failures.push(id); } }

const TIMEOUT = 20000;
const until = async (what, fn, ms = TIMEOUT) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};

// ── payloads (copied in shape from the ipsas proofs; only what the validation needs) ───────────────────────────────
const CLASS_ID = "33333333-3333-4333-8333-333333333333";
const GRANT_ID = "55555555-5555-4555-8555-555555555555";
const REG = { type: "register", reference: "Fixed asset register FY2026" };
const item = () => ({ label: "E1", costMinor: "2000000", residualMinor: "0", openingAccumulatedMinor: "400000", method: "straight-line", lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", availableFrom: "", derecognisedOn: "" });
const estimate = () => ({ basis: "cost", method: "straight-line", lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", residualMinor: "0", convention: "daily",
  factors: { usage: "single shift", wear: "annual service", obsolescence: "none expected", legalLimits: "none" }, chargeSource: "calculated", registerChargeMinor: "", registerReference: "",
  items: [item()], calculatedChargeMinor: "", chargeDifference: { amountMinor: "", explanation: "", evidence: "" }, changedSincePrior: "no", changeDescription: "", changeEffectMinor: "",
  rationale: "Ten years of single-shift use expected", evidence: "Maintenance plan MP-2026" });
const cls = () => ({ classId: CLASS_ID, label: "Equipment", accounts: "1500, 1510", measurementModel: "cost",
  opening: { grossMinor: "2000000", accumulatedDepreciationMinor: "400000", accumulatedImpairmentMinor: "0", carryingMinor: "1600000" },
  closing: { grossMinor: "2000000", accumulatedDepreciationMinor: "600000", accumulatedImpairmentMinor: "0", carryingMinor: "1400000" },
  movements: [{ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "200000", accumulatedImpairmentMinor: "0", source: REG, note: "" }], disposals: [], estimate: estimate() });
const none = () => ({ status: "none_with_basis", text: "Checked the asset register and board minutes", evidence: "Register FY2026 and minutes", checkedBy: "", flags: { applies: false } });
const wp = (A) => ({ contract: "cfoclose-ipsas-ppe-workpaper/1", companyId: A, periodYear: 2026, presentation: { currency: "TZS", exponent: 2 }, period: { start: "2026-01-01", end: "2026-12-31" }, convention: "daily", classes: [cls()],
  entityAnswers: { heritage_assets: none(), infrastructure_assets: none(), impairment_indicators: none(), held_for_sale: none(), commitments_restrictions: none() }, depreciationDifference: null,
  tbSelection: { ppeAccountKeys: ["1500", "1510"], depreciationExpenseKeys: ["6200"] } });
const grants = (A) => ({ contract: "cfoclose-ipsas-grants/1", companyId: A, periodYear: 2026, presentation: { currency: "TZS", exponent: 2 }, entityAnswers: {}, tbSelection: { revenueKeys: [], liabilityKeys: [], receivableKeys: [] }, grants: [{ grantId: GRANT_ID, obligations: [] }] });

const SAVE = "SELECT public.ipsas_save_preparation($1,2026,'ppe_workpaper',$2::jsonb,$3,$4) r";
const CONFIRM = "SELECT public.ipsas_confirm($1,2026,'ppe_class_estimate',$2,$3,$4) r";
const SAVE_G = "SELECT public.ipsas_save_grants($1,2026,$2::jsonb,$3,$4) r";
const CONFIRM_G = "SELECT public.ipsas_confirm_grant($1,2026,$2,$3,$4) r";

// ── session helpers ───────────────────────────────────────────────────────────────────────────────────────────────
async function beginAs(uid, isolation) {
  const c = await db.pool.connect();
  await c.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : "BEGIN");
  await c.query("SET LOCAL ROLE authenticated");
  await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
  const pid = (await c.query("SELECT pg_backend_pid() p")).rows[0].p;
  let done = false;
  const finish = async (how) => { if (done) return; done = true; try { await c.query(how); } finally { c.release(); } };
  return { pid, start: (sql, p) => c.query(sql, p).then((x) => ({ rows: x.rows }), (err) => ({ err })), commit: () => finish("COMMIT"), rollback: () => finish("ROLLBACK") };
}
async function hold(sql, params) {
  const c = await db.pool.connect();
  await c.query("BEGIN"); await c.query(sql, params);
  let done = false;
  return { release: async () => { if (done) return; done = true; try { await c.query("COMMIT"); } finally { c.release(); } } };
}
const holdAdvisory = (key) => hold("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
const holdTable = (table) => hold(`LOCK TABLE public.${table} IN ACCESS EXCLUSIVE MODE`);
const waitingOn = async (pid, locktype) => (await db.admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted AND locktype=$2", [pid, locktype])).rowCount > 0;
const one = async (sql, p = []) => (await db.admin.query(sql, p)).rows[0];
const count = async (table, company) => Number((await one(`SELECT count(*) n FROM public.${table}${company ? " WHERE company_id=$1" : ""}`, company ? [company] : [])).n);
const expectedRows = { ipsas_prep_revisions: 0, ipsas_confirmations: 0, ipsas_grant_revisions: 0, ipsas_grant_confirmations: 0 };
const bump = (table) => { expectedRows[table] += 1; };

let W, U;
let seq = 0;
/** A plan allows only so many entities, so the cases use the FIRM account (ownerB); the plan case brings an account of its own. */
async function newAccount() {
  const uid = uuid();
  await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [uid, `planowner-${uid}@example.test`]);
  const prod = (await db.one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  const bc = (await db.one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
  await db.admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  return uid;
}
async function freshCompany({ owner, framework = "ipsas_accrual", certified = true } = {}) {
  const A = await W.company(owner ?? U.ownerB, `Ordering case ${++seq}`, framework);
  for (const k of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], k]);
  await W.rollout(A, true);
  // A mutation needs the server-confirmed denomination of a certified current period (independent review of #229, finding 4). A framework change is
  // refused once a certified trial balance exists (FRAMEWORK_LOCKED), so that one case uses an uncertified company: the framework refusal comes from the
  // authority helper, before any denomination check.
  if (certified) {
    const k = await certifier(db, { ...U, owner: owner ?? U.ownerB });
    for (const [y, col] of [[2025, FY2025], [2026, FY2026]]) { const u = await k.upload(A, y, csv(col)); if (y === 2025) await k.review(A, u); await k.certify(A, u); }
  }
  return A;
}
const revoke = (company, uid, capability, by = U.ownerB) => db.asUser(by, "SELECT public.revoke_member_capability($1,$2,$3,'proof revocation') r", [company, uid, capability]).then((x) => x.r);
const asU = (uid, sql, p) => db.asUser(uid, sql, p).then((x) => x.r);

/** Starts `sql` as `uid` while `lockKey` is held elsewhere, waits until it is WAITING, makes `during()` happen, releases, and returns the outcome. */
async function duringWait({ lockKey, uid, sql, params, during }) {
  const h = await holdAdvisory(lockKey);
  const s = await beginAs(uid);
  let outcome;
  try {
    const p = s.start(sql, params);
    await until("the mutation to wait for the held lock", () => waitingOn(s.pid, "advisory"));
    if (during) await during();
    await h.release();
    outcome = await p;
    await s.commit();
  } catch (e) { try { await h.release(); } catch { /* */ } try { await s.rollback(); } catch { /* */ } throw e; }
  if (outcome.err) throw outcome.err;
  return outcome.rows[0].r;
}
const ppeKey = (A) => `ipsas:${A}:2026`;
const grantsKey = (A) => `ipsas_grants:${A}:2026`;

try {
  db = await openDatabase("ipsas_authority_ordering");
  await each("setup.chain-and-world", async () => {
    const err = await applyChain(db); assert.equal(err, null, String(err));
    W = await makeWorld(db); U = W.U;
    assert((await one("SELECT to_regprocedure('public.ipsas_save_grants(uuid,integer,jsonb,uuid,uuid)') IS NOT NULL v")).v);
  });
  if (failures.length) throw new Error("setup failed");

  // ── control: the same flow, nothing revoked, proceeds ─────────────────────────────────────────────────────────────
  await each("control.mutation-proceeds-when-nothing-is-revoked", async () => {
    const A = await freshCompany();
    const r = await duringWait({ lockKey: ppeKey(A), uid: U.preparer, sql: SAVE, params: [A, JSON.stringify(wp(A)), null, uuid()] });
    assert.equal(r.outcome, "recorded"); bump("ipsas_prep_revisions");
    assert.equal(await count("ipsas_prep_revisions", A), 1);
    const g = await duringWait({ lockKey: grantsKey(A), uid: U.preparer, sql: SAVE_G, params: [A, JSON.stringify(grants(A)), null, uuid()] });
    assert.equal(g.outcome, "recorded"); bump("ipsas_grant_revisions");
    assert.equal(await count("ipsas_grant_revisions", A), 1);
  });

  // ── the reported scenario, four mutation paths ────────────────────────────────────────────────────────────────────
  await each("revoked-during-wait.save-preparation", async () => {
    const A = await freshCompany();
    const r = await duringWait({ lockKey: ppeKey(A), uid: U.preparer, sql: SAVE, params: [A, JSON.stringify(wp(A)), null, uuid()],
      during: async () => assert.equal((await revoke(A, U.preparer, "prepare_close")).outcome, "revoked") });
    assert.deepEqual(r, { outcome: "forbidden" });
    assert.equal(await count("ipsas_prep_revisions", A), 0, "a mutation wrote with authority that had been revoked before it proceeded");
  });
  await each("revoked-during-wait.confirm", async () => {
    const A = await freshCompany();
    const saved = await asU(U.preparer, SAVE, [A, JSON.stringify(wp(A)), null, uuid()]); assert.equal(saved.outcome, "recorded"); bump("ipsas_prep_revisions");
    const ok = await duringWait({ lockKey: ppeKey(A), uid: U.partner, sql: CONFIRM, params: [A, CLASS_ID, saved.revisionId, uuid()] });
    assert.equal(ok.outcome, "confirmed"); bump("ipsas_confirmations");
    const r = await duringWait({ lockKey: ppeKey(A), uid: U.partner, sql: CONFIRM, params: [A, CLASS_ID, saved.revisionId, uuid()],
      during: async () => assert.equal((await revoke(A, U.partner, "review_close")).outcome, "revoked") });
    assert.deepEqual(r, { outcome: "forbidden" });
    assert.equal(await count("ipsas_confirmations", A), 1, "a confirmation was recorded with revoked authority");
  });
  await each("revoked-during-wait.save-grants", async () => {
    const A = await freshCompany();
    const r = await duringWait({ lockKey: grantsKey(A), uid: U.preparer, sql: SAVE_G, params: [A, JSON.stringify(grants(A)), null, uuid()],
      during: async () => assert.equal((await revoke(A, U.preparer, "prepare_close")).outcome, "revoked") });
    assert.deepEqual(r, { outcome: "forbidden" });
    assert.equal(await count("ipsas_grant_revisions", A), 0);
  });
  await each("revoked-during-wait.confirm-grant", async () => {
    const A = await freshCompany();
    const saved = await asU(U.preparer, SAVE_G, [A, JSON.stringify(grants(A)), null, uuid()]); assert.equal(saved.outcome, "recorded"); bump("ipsas_grant_revisions");
    const before = await count("ipsas_grant_confirmations", A);
    const control = await duringWait({ lockKey: grantsKey(A), uid: U.partner, sql: CONFIRM_G, params: [A, GRANT_ID, saved.revisionId, uuid()] });
    assert(!["forbidden", "feature_disabled", "framework_not_ipsas_accrual"].includes(control.outcome), `the control must pass authorisation (got ${control.outcome})`);
    if (control.outcome === "confirmed") bump("ipsas_grant_confirmations");
    const mid = await count("ipsas_grant_confirmations", A);
    const r = await duringWait({ lockKey: grantsKey(A), uid: U.partner, sql: CONFIRM_G, params: [A, GRANT_ID, saved.revisionId, uuid()],
      during: async () => assert.equal((await revoke(A, U.partner, "review_close")).outcome, "revoked") });
    assert.deepEqual(r, { outcome: "forbidden" });
    assert.equal(await count("ipsas_grant_confirmations", A), mid); assert(mid >= before);
  });
  await each("revoked-during-wait.idempotent-replay", async () => {
    const A = await freshCompany();
    const request = uuid(), payload = JSON.stringify(wp(A));
    const first = await asU(U.preparer, SAVE, [A, payload, null, request]); assert.equal(first.outcome, "recorded"); bump("ipsas_prep_revisions");
    const replay = await duringWait({ lockKey: ppeKey(A), uid: U.preparer, sql: SAVE, params: [A, payload, null, request],
      during: async () => assert.equal((await revoke(A, U.preparer, "prepare_close")).outcome, "revoked") });
    assert.deepEqual(replay, { outcome: "forbidden" }, "a revoked actor was handed the stored receipt of an earlier request");
    assert.equal(await count("ipsas_prep_revisions", A), 1);
  });

  // ── the other authority inputs, re-evaluated after the boundary ──────────────────────────────────────────────────
  await each("other-authority.membership-withdrawn-during-wait", async () => {
    const A = await freshCompany();
    const r = await duringWait({ lockKey: ppeKey(A), uid: U.preparer, sql: SAVE, params: [A, JSON.stringify(wp(A)), null, uuid()],
      during: async () => { await db.admin.query("UPDATE public.firm_members SET accepted_at=NULL WHERE company_id=$1 AND user_id=$2", [A, U.preparer]); } });
    assert.deepEqual(r, { outcome: "forbidden" });
    assert.equal(await count("ipsas_prep_revisions", A), 0);
  });
  await each("other-authority.rollout-closed-during-wait", async () => {
    const A = await freshCompany();
    const r = await duringWait({ lockKey: ppeKey(A), uid: U.preparer, sql: SAVE, params: [A, JSON.stringify(wp(A)), null, uuid()], during: async () => { await W.rollout(A, false); } });
    assert.deepEqual(r, { outcome: "feature_disabled" });
    assert.equal(await count("ipsas_prep_revisions", A), 0);
  });
  await each("other-authority.framework-changed-during-wait", async () => {
    const A = await freshCompany({ certified: false });
    const r = await duringWait({ lockKey: ppeKey(A), uid: U.preparer, sql: SAVE, params: [A, JSON.stringify(wp(A)), null, uuid()],
      during: async () => { // the audited path (a direct UPDATE is refused by the framework guard)
        const c = await asU(U.ownerB, "SELECT public.set_company_reporting_framework($1,'ifrs_for_smes','ipsas_accrual','proof framework change',$2) r", [A, uuid()]);
        assert(["changed", "applied", "recorded"].includes(c.outcome) || (await one("SELECT reporting_framework f FROM public.companies WHERE id=$1", [A])).f === "ifrs_for_smes", `the framework change did not commit: ${JSON.stringify(c)}`);
      } });
    assert.deepEqual(r, { outcome: "framework_not_ipsas_accrual" });
    assert.equal(await count("ipsas_prep_revisions", A), 0);
  });

  // ── the order between revocation and a mutation that has already passed the boundary ─────────────────────────────
  await each("order.revocation-waits-for-an-in-flight-mutation", async () => {
    const A = await freshCompany();
    const table = await holdTable("ipsas_prep_revisions");      // parks the mutation AFTER it has acquired its locks and re-checked authority
    const mut = await beginAs(U.preparer), rev = await beginAs(U.ownerB);
    let released = false;
    try {
      const m = mut.start(SAVE, [A, JSON.stringify(wp(A)), null, uuid()]);
      await until("the mutation to reach the table lock", () => waitingOn(mut.pid, "relation"));
      const r = rev.start("SELECT public.revoke_member_capability($1,$2,'prepare_close','proof revocation') r", [A, U.preparer]);
      await until("the revocation to WAIT for the in-flight mutation (one lock serialises them)", () => waitingOn(rev.pid, "advisory"), 8000);
      await table.release(); released = true;
      const mr = await m;
      assert.equal(mr.rows[0].r.outcome, "recorded"); bump("ipsas_prep_revisions");
      assert(await waitingOn(rev.pid, "advisory"), "the revocation must still wait until the mutation's transaction ends");
      await mut.commit();
      const rr = await r; assert.equal(rr.rows[0].r.outcome, "revoked");
      await rev.commit();
      assert.equal(await count("ipsas_prep_revisions", A), 1, "the mutation completed first and is recorded");
      assert.equal((await asU(U.preparer, SAVE, [A, JSON.stringify(wp(A)), (await one("SELECT id FROM public.ipsas_prep_revisions WHERE company_id=$1", [A])).id, uuid()])).outcome, "forbidden", "after the revocation committed, the next mutation is refused");
    } finally { if (!released) await table.release(); await mut.rollback().catch(() => {}); await rev.rollback().catch(() => {}); }
  });
  await each("order.plan-change-waits-for-an-in-flight-mutation", async () => {
    const planOwner = await newAccount();                        // an account of its own, so lapsing its plan affects no other case
    const A = await freshCompany({ owner: planOwner });
    const h = await holdAdvisory(ppeKey(A));
    const mut = await beginAs(U.preparer);
    const plan = await db.pool.connect();
    try {
      const m = mut.start(SAVE, [A, JSON.stringify(wp(A)), null, uuid()]);
      await until("the mutation to wait for the held lock", () => waitingOn(mut.pid, "advisory"));
      await plan.query("BEGIN");
      const planPid = (await plan.query("SELECT pg_backend_pid() p")).rows[0].p;
      const change = plan.query("UPDATE public.commercial_licences SET effective_end = now() - interval '1 minute' WHERE billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id=$1)", [planOwner]).then(() => "done", (e) => `error:${e.code}`);
      await until("the plan change to wait for the in-flight mutation (shared plan lock)", () => waitingOn(planPid, "advisory"), 8000);
      await h.release();
      const mr = await m; assert.equal(mr.rows[0].r.outcome, "recorded"); bump("ipsas_prep_revisions");
      await mut.commit();
      assert.equal(await change, "done"); await plan.query("COMMIT");
      assert.equal((await asU(U.preparer, SAVE, [A, JSON.stringify(wp(A)), null, uuid()])).outcome, "forbidden", "after the plan lapsed, mutations are refused");
    } finally { await h.release().catch(() => {}); await mut.rollback().catch(() => {}); try { await plan.query("ROLLBACK"); } catch { /* */ } plan.release(); }
  });
  await each("order.contention-terminates-without-deadlock", async () => {
    const A = await freshCompany();
    const base = await asU(U.preparer, SAVE, [A, JSON.stringify(wp(A)), null, uuid()]); assert.equal(base.outcome, "recorded"); bump("ipsas_prep_revisions");
    const one_ = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("operation did not terminate (possible deadlock)")), 30000))]);
    const settle = (p) => one_(p).then((r) => ({ r }), (e) => ({ e }));
    const ops = [];
    for (let i = 0; i < 8; i++) ops.push(settle(asU(U.preparer, SAVE, [A, JSON.stringify({ ...wp(A), convention: i % 2 ? "daily" : "full-period" }), base.revisionId, uuid()])));
    for (let i = 0; i < 3; i++) ops.push(settle(asU(U.partner, CONFIRM, [A, CLASS_ID, base.revisionId, uuid()])));
    ops.push(settle(revoke(A, U.preparer, "prepare_close")));
    ops.push(settle(revoke(A, U.partner, "review_close")));
    const out = await Promise.all(ops);
    const errors = out.filter((x) => x.e).map((x) => `${x.e.code ?? ""} ${x.e.message}`);
    assert.deepEqual(errors, [], "no operation may error or deadlock");
    const outcomes = out.map((x) => x.r.outcome ?? x.r);
    for (const o of outcomes) assert(["recorded", "stale", "forbidden", "confirmed", "revoked", "not_confirmable"].includes(o), `unexpected outcome ${o}`);
    const savedNow = out.slice(0, 8).filter((x) => x.r.outcome === "recorded").length;
    const confirmedNow = out.slice(8, 11).filter((x) => x.r.outcome === "confirmed").length;
    for (let i = 0; i < savedNow; i++) bump("ipsas_prep_revisions");
    for (let i = 0; i < confirmedNow; i++) bump("ipsas_confirmations");
    assert.equal(await count("ipsas_prep_revisions", A), 1 + savedNow, "every recorded outcome is exactly one row and nothing else was written");
    assert.equal(await count("ipsas_confirmations", A), confirmedNow);
    assert.equal((await asU(U.preparer, SAVE, [A, JSON.stringify(wp(A)), null, uuid()])).outcome, "forbidden", "both revocations are in force afterwards");
  });
  await each("isolation.stricter-than-read-committed-fails-closed", async () => {
    const A = await freshCompany();
    const s = await beginAs(U.preparer, "REPEATABLE READ");
    let res;
    try { res = await s.start(SAVE, [A, JSON.stringify(wp(A)), null, uuid()]); } finally { await s.rollback().catch(() => {}); }
    assert(res.err, "a mutation judged on a transaction-long snapshot must fail closed, not proceed");
    assert.equal(res.err.code, "25000");
    assert.equal(await count("ipsas_prep_revisions", A), 0);
  });
  await each("persisted.no-partial-or-cross-company-writes", async () => {
    for (const [t, n] of Object.entries(expectedRows)) assert.equal(await count(t), n, `${t} holds exactly the rows the recorded outcomes account for`);
  });
  completed = failures.length === 0;
} catch (e) { crashed = true; crashMessage = `${e.code ?? ""}: ${e.stack ?? e.message}`; console.error(crashMessage); process.exitCode = 1; }
finally {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), completed, crashed, crashMessage, cases: results }, null, 2) + "\n");
  console.log(`IPSAS_AUTHORITY_ORDERING: ${results.filter((r) => r.outcome === "pass").length}/${CASES.length} passed${failures.length ? `; FAILED: ${failures.join(", ")}` : ""}`);
  if (failures.length) process.exitCode = 1;
  await db?.close(); process.exit(process.exitCode ?? 0);
}
