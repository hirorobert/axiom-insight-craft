// Deterministic multi-session proof of the IPSAS mutation ordering contract (independent review of #229, finding 1), on the full migration chain in a
// disposable loopback database. Synthetic data only; never a hosted database.
//
// CONTRACT under test. A mutation is ADMITTED when _ipsas_authorize_mutation has taken its locks and re-judged authority. From then until its
// transaction commits, a withdrawal of any authority input (membership removal, a demotion that removes authority, an explicit capability
// revocation, rollout closure, a framework change, a plan lapse) must not COMPLETE: it waits for the mutation to commit. If the withdrawal is already
// in flight, the mutation waits and then refuses, or refuses at once (authority_changing); it never commits a write, and never hands out a response,
// under authority withdrawn before that commit.
//
// METHOD, per scenario - no sleep decides an ordering; every wait polls pg_locks / pg_stat_activity for the observable state, bounded:
//   admitted-first: a test-only BEFORE INSERT trigger on the five target tables takes an advisory lock that a barrier session holds, so the mutation is
//   parked AFTER admission and BEFORE persistence (observed: it waits on an advisory lock). (A table lock would park it at function entry, before
//   admission, where a withdrawal is legitimately first.) The writer then runs in its own session. An idempotent replay has no insert to park at, so it
//   is run to completion inside an OPEN transaction: its locks last until it commits, which is what the writer must wait for. Observed: does the
//   writer's statement FINISH (a withdrawal completed while an admitted mutation is pending - a violation if the mutation then answers or persists) or
//   BLOCK behind the mutation (the contract)? The barrier is released and the mutation's outcome, the persisted rows and a fresh read are inspected.
//   writer-first: the writer holds its locks uncommitted when the mutation arrives; the mutation must not commit after the withdrawal committed.
// DB_PROOF_MODE=external DB_PROOF_CONN=postgres://... | DB_PROOF_MODULES_DIR=<dir>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChain, certifier, csv, FY2025, FY2026, makeWorld, openDatabase, REPO, uuid } from "./lib/reportingKit.mjs";
import { CASES, MUTATIONS, PROOF, WRITERS } from "./ipsasAuthorityRaces.manifest.mjs";
import { entity47, grantA } from "../../src/lib/ipsasAccrual/grants.fixture.ts";

const results = [];
const manifest = fs.readFileSync(new URL("./ipsasAuthorityRaces.manifest.mjs", import.meta.url));
const output = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results/ipsasAuthorityRaces.present.json");
let db, W, U, completed = false, crashed = false, crashMessage = null, seq = 0;
const failures = [];
async function kase(id, fn) {
  if (process.env.RACE_ONLY && !id.startsWith("setup.") && !id.includes(process.env.RACE_ONLY)) return;
  assert(CASES.some((c) => c.id === id), `case ${id} not in manifest`); assert(!results.some((c) => c.id === id), `duplicate ${id}`);
  try { await fn(); results.push({ id, outcome: "pass" }); console.log("PASS", id); }
  catch (e) { results.push({ id, outcome: "fail", detail: `${e.code ?? ""}: ${String(e.message).split("\n")[0]}` }); failures.push(id); console.log("FAIL", id, "-", String(e.message).split("\n")[0].slice(0, 400)); }
}
const TIMEOUT = 25000;
const until = async (what, fn, ms = TIMEOUT) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); }
};
const one = async (sql, p = []) => (await db.admin.query(sql, p)).rows[0];
const count = async (table, company) => Number((await one(`SELECT count(*) n FROM public.${table}${company ? " WHERE company_id=$1" : ""}`, company ? [company] : [])).n);
const waitingAny = async (pid) => (await db.admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted", [pid])).rowCount > 0;
const waitingAdvisory = async (pid) => (await db.admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted AND locktype='advisory'", [pid])).rowCount > 0;
const REFUSALS = new Set(["forbidden", "feature_disabled", "framework_not_ipsas_accrual", "authority_changing"]);
const isRefusal = (r) => REFUSALS.has(r?.outcome);

// ── payloads (shape copied from ipsasAuthorityOrdering.mjs; only what the validation needs) ──────────────────────
const CLASS_ID = "33333333-3333-4333-8333-333333333333", GRANT_ID = "55555555-5555-4555-8555-555555555555";
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
const PRES = { currency: "TZS", exponent: 2 };
const wp = (A) => ({ contract: "cfoclose-ipsas-ppe-workpaper/1", companyId: A, periodYear: 2026, presentation: PRES, period: { start: "2026-01-01", end: "2026-12-31" }, convention: "daily", classes: [cls()],
  entityAnswers: { heritage_assets: none(), infrastructure_assets: none(), impairment_indicators: none(), held_for_sale: none(), commitments_restrictions: none() }, depreciationDifference: null,
  tbSelection: { ppeAccountKeys: ["1500", "1510"], depreciationExpenseKeys: ["6200"] } });
const grants = (A) => ({ contract: "cfoclose-ipsas-grants/1", companyId: A, periodYear: 2026, presentation: PRES, entityAnswers: {}, tbSelection: { revenueKeys: [], liabilityKeys: [], receivableKeys: [] }, grants: [{ grantId: GRANT_ID, obligations: [] }] });
/** A grant the server can confirm: it needs a classification with a basis and a reporting period read from a certified trial balance. */
const confirmable = (A) => ({ contract: "cfoclose-ipsas-grants/1", companyId: A, periodYear: 2026, presentation: PRES, entityAnswers: entity47(), tbSelection: { revenueKeys: [], liabilityKeys: [], receivableKeys: [] }, grants: [grantA()] });
const CAPTIONS = { 1000: "cash", 1100: "receivables_current", 1200: "inventories", 1500: "ppe", 1510: "ppe", 2000: "payables", 2100: "other_liabilities_current", 2500: "borrowings_non_current", 3000: "contributed_capital", 3100: "accumulated", 4000: "fees", 4100: "investment_income", 5000: "supplies", 6000: "employees", 6100: "supplies", 6200: "depreciation", 6300: "finance", 7000: "other_expenses" };

const SAVE = "SELECT public.ipsas_save_preparation($1,2026,'ppe_workpaper',$2::jsonb,$3,$4) r";
const CONFIRM = "SELECT public.ipsas_confirm($1,2026,'ppe_class_estimate',$2,$3,$4) r";
const SAVE_G = "SELECT public.ipsas_save_grants($1,2026,$2::jsonb,$3,$4) r";
const CONFIRM_G = "SELECT public.ipsas_confirm_grant($1,2026,$2,$3,$4) r";
const SAVE_S = "SELECT public.ipsas_save_presentation($1,2026,$2::jsonb,$3,$4,$5) r";
const asU = (uid, sql, p) => db.asUser(uid, sql, p).then((x) => x.r);

// ── sessions ───────────────────────────────────────────────────────────────────────────────────────────────────
async function openSession(role, uid) {
  const c = await db.pool.connect();
  await c.query("BEGIN");
  if (role !== "postgres") { await c.query(`SET LOCAL ROLE ${role}`); await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]); }
  const pid = (await c.query("SELECT pg_backend_pid() p")).rows[0].p;
  let settled = false, done = false, result = null;
  const finish = async (how) => { if (done) return; done = true; try { await c.query(how); } finally { c.release(); } };
  return {
    pid, get settled() { return settled; }, get result() { return result; },
    start: (sql, p) => c.query(sql, p).then((x) => { settled = true; result = { rows: x.rows, rowCount: x.rowCount }; return result; }, (err) => { settled = true; result = { err }; return result; }),
    commit: () => finish("COMMIT"), rollback: () => finish("ROLLBACK"),
  };
}
async function holdBarrier() {
  const c = await db.pool.connect();
  await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(hashtextextended('proof-barrier', 0))");
  let done = false;
  return { release: async () => { if (done) return; done = true; try { await c.query("COMMIT"); } finally { c.release(); } } };
}
async function newAccount() {
  const uid = uuid();
  await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [uid, `raceowner-${uid}@example.test`]);
  const prod = (await db.one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  const bc = (await db.one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
  await db.admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  return uid;
}
// Every mutation now needs the server-confirmed denomination of a certified current period (finding 4), so every company is certified.
async function freshCompany({ certified = true } = {}) {
  const owner = await newAccount();
  const A = await W.company(owner, `Race case ${++seq}`, "ipsas_accrual");
  for (const k of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], k]);
  await W.rollout(A, true);
  if (certified) {
    const k = await certifier(db, { ...U, owner });
    for (const [y, col] of [[2025, FY2025], [2026, FY2026]]) { const u = await k.upload(A, y, csv(col)); if (y === 2025) await k.review(A, u); await k.certify(A, u); }
  }
  return { A, owner };
}

// ── what each of the five mutation RPCs is, and what it touches right after admission ───────────────────────────
const TABLE = { "prep-save": "ipsas_prep_revisions", confirm: "ipsas_confirmations", "grants-save": "ipsas_grant_revisions", "grant-confirm": "ipsas_grant_confirmations", "statement-save": "ipsas_presentation_revisions" };
const READ = { "prep-save": "SELECT public.ipsas_prep_context($1,2026) r", confirm: "SELECT public.ipsas_prep_context($1,2026) r", "grants-save": "SELECT public.ipsas_grants_context($1,2026) r",
  "grant-confirm": "SELECT public.ipsas_grants_context($1,2026) r", "statement-save": "SELECT public.ipsas_statement_review($1,2026) r" };
const MUT = {
  "prep-save": { actor: "preparer", cap: "prepare_close",
    prepare: async () => ({}), run: (c) => [SAVE, [c.A, JSON.stringify(wp(c.A)), null, uuid()]] },
  confirm: { actor: "partner", cap: "review_close",
    prepare: async (c) => ({ rev: (await asU(U.preparer, SAVE, [c.A, JSON.stringify(wp(c.A)), null, uuid()])).revisionId, seeded: ["ipsas_prep_revisions"] }),
    run: (c, p) => [CONFIRM, [c.A, CLASS_ID, p.rev, uuid()]] },
  "grants-save": { actor: "preparer", cap: "prepare_close",
    prepare: async () => ({}), run: (c) => [SAVE_G, [c.A, JSON.stringify(grants(c.A)), null, uuid()]] },
  "grant-confirm": { actor: "partner", cap: "review_close", certified: true,
    prepare: async (c) => { const saved = await asU(U.preparer, SAVE_G, [c.A, JSON.stringify(confirmable(c.A)), null, uuid()]); assert.equal(saved.outcome, "recorded"); return { rev: saved.revisionId, seeded: ["ipsas_grant_revisions"] }; },
    run: (c, p) => [CONFIRM_G, [c.A, grantA().grantId, p.rev, uuid()]] },
  "statement-save": { actor: "preparer", cap: "prepare_close", certified: true,
    prepare: async (c) => ({ scope: (await asU(U.preparer, "SELECT public.ipsas_statement_review($1,2026) r", [c.A])) }),
    run: (c, p) => [SAVE_S, [c.A, JSON.stringify(p.scope.accounts.map((a) => ({ period: a.period, accountKey: a.accountKey, captionId: CAPTIONS[a.accountKey], zeroDisposition: null, reason: null }))), p.scope.revisionId, p.scope.inputSha256, uuid()]] },
  replay: { actor: "preparer", cap: "prepare_close", read: "prep-save", open: true,
    prepare: async (c) => { const request = uuid(); const first = await asU(U.preparer, SAVE, [c.A, JSON.stringify(wp(c.A)), null, request]); assert.equal(first.outcome, "recorded"); return { request, seeded: ["ipsas_prep_revisions"] }; },
    run: (c, p) => [SAVE, [c.A, JSON.stringify(wp(c.A)), null, p.request]] },
};
// ── the writers of the authority inputs, each through its normal path ───────────────────────────────────────────
const WRITER = {
  "member-removal": { role: "authenticated", as: (c) => c.owner, sql: "DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", params: (c, a) => [c.A, a], rows: 1 },
  "role-demotion": { role: "authenticated", as: (c) => c.owner, sql: "UPDATE public.firm_members SET role='viewer' WHERE company_id=$1 AND user_id=$2", params: (c, a) => [c.A, a], rows: 1 },
  "explicit-revoke": { role: "authenticated", as: (c) => c.owner, sql: "SELECT public.revoke_member_capability($1,$2,$3,'race proof') r", params: (c, a, cap) => [c.A, a, cap], result: (r) => r.outcome === "revoked" },
  "rollout-closure": { role: "service_role", as: () => null, sql: "SELECT public.fs_set_company_rollout($1,false,'race proof','proof')", params: (c) => [c.A] },
  "framework-change": { role: "authenticated", as: (c) => c.owner, sql: "SELECT public.set_company_reporting_framework($1,'ifrs_for_smes','ipsas_accrual','race proof',$2) r", params: (c) => [c.A, uuid()],
    effective: async (c) => (await one("SELECT reporting_framework f FROM public.companies WHERE id=$1", [c.A])).f !== "ipsas_accrual" },
  "plan-lapse": { role: "postgres", as: () => null, sql: "UPDATE public.commercial_licences SET effective_end = now() - interval '1 minute' WHERE billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id=$1)", params: (c) => [c.owner], atLeast: 1 },
};
const expectedRows = {}; const book = (t, n) => { expectedRows[t] = (expectedRows[t] ?? 0) + n; };
const tableOf = (m) => (m === "replay" ? TABLE["prep-save"] : TABLE[m]);
const readOf = (m) => READ[m === "replay" ? "prep-save" : m];

/** set_company_reporting_framework refuses FRAMEWORK_LOCKED once a certified trial balance exists, so it is no withdrawal for a mutation that needs one (the presentation save, a grant confirmation). */
const applicable = (m, w) => w !== "framework-change";
async function withdrawalEffective(w, c, m) {
  const wr = WRITER[w];
  if (wr.effective) assert(await wr.effective(c), `${w} did not withdraw authority (precondition of the case)`);
  if (["member-removal", "role-demotion", "explicit-revoke"].includes(w)) {
    const held = (await one("SELECT public.has_workspace_capability($1,$2,$3) v", [c.A, U[MUT[m].actor], MUT[m].cap])).v;
    assert.equal(held, false, `after ${w} committed the actor must no longer hold ${MUT[m].cap}`);
  }
  const read = await asU(U[MUT[m].actor], readOf(m), [c.A]);
  if (["rollout-closure", "framework-change", "plan-lapse"].includes(w)) assert(isRefusal(read), `after ${w} committed, a fresh read by the actor must be refused (got ${JSON.stringify(read).slice(0, 120)})`);
}
async function startWriter(w, c, m) {
  const wr = WRITER[w], actor = U[MUT[m].actor];
  const s = await openSession(wr.role, wr.as(c));
  return { s, run: () => s.start(wr.sql, wr.params(c, actor, MUT[m].cap)) };
}
function checkWriterResult(w, res) {
  const wr = WRITER[w];
  assert(!res.err, `the writer failed: ${res.err?.message}`);
  if (wr.rows !== undefined) assert.equal(res.rowCount, wr.rows, `${w} must change exactly the actor's row (row security or the path refused it)`);
  if (wr.atLeast !== undefined) assert(res.rowCount >= wr.atLeast, `${w} changed nothing`);
  if (wr.result) assert(wr.result(res.rows[0].r), `${w} reported ${JSON.stringify(res.rows[0]?.r)}`);
}

/** The mutation is parked AFTER admission and BEFORE persistence; the withdrawal then arrives. */
async function admittedFirst(m, w) {
  const c = await freshCompany({ certified: MUT[m].certified });
  const prep = await MUT[m].prepare(c);
  for (const t of prep.seeded ?? []) book(t, 1);
  const before = await count(tableOf(m), c.A);
  const [sql, params] = MUT[m].run(c, prep);
  const open = MUT[m].open === true;
  const barrier = open ? { release: async () => {} } : await holdBarrier();
  const ms = await openSession("authenticated", U[MUT[m].actor]);
  const wt = await startWriter(w, c, m);
  let released = false, mDone = false, wCommitted = false;
  try {
    const mp = ms.start(sql, params);
    if (open) await until("the replay to answer (its transaction stays open)", () => ms.settled);
    else await until("the mutation to be admitted and parked at the barrier", async () => { if (ms.settled) throw new Error(`the mutation settled before it parked: ${JSON.stringify(ms.result).slice(0, 220)}`); return waitingAdvisory(ms.pid); });
    const wp = wt.run();
    const state = await until("the withdrawal to finish or to block", async () => (wt.s.settled ? "finished" : (await waitingAny(wt.s.pid)) ? "blocked" : false), 12000);
    if (state === "finished") { checkWriterResult(w, wt.s.result); await wt.s.commit(); wCommitted = true; }
    await barrier.release(); released = true;
    const mr = await mp; mDone = true;
    assert(!mr.err, `the mutation errored: ${mr.err?.message}`);
    const outcome = mr.rows[0].r;
    console.log(`  . ${m} x ${w}: withdrawal ${state}; mutation answered ${JSON.stringify(outcome.outcome)}`);
    await ms.commit();
    let wr; if (state === "blocked") { wr = await wp; checkWriterResult(w, wr); await wt.s.commit(); wCommitted = true; }
    const after = await count(tableOf(m), c.A);
    const wrote = !outcome.replay && ["recorded", "confirmed"].includes(outcome.outcome) ? 1 : 0;
    assert.equal(after - before, wrote, `persisted rows (${after - before}) must equal what the outcome ${JSON.stringify(outcome.outcome)} reports`);
    book(tableOf(m), wrote);
    if (open) { assert.equal(state, "blocked", "an admitted replay holds its authority until it commits: the withdrawal must wait for it"); }
    else if (state === "finished") {
      assert(isRefusal(outcome) && wrote === 0,
        `VIOLATION: the withdrawal (${w}) COMPLETED while an admitted ${m} was pending, and the mutation then ${wrote ? "persisted a write" : "answered"} (${JSON.stringify(outcome).slice(0, 160)}) under authority withdrawn before its commit`);
    } else {
      assert(!isRefusal(outcome), `an admitted ${m} must complete when the withdrawal waited for it (got ${JSON.stringify(outcome)})`);
    }
    await withdrawalEffective(w, c, m);
  } finally {
    if (!released) await barrier.release().catch(() => {});
    await ms.rollback().catch(() => {}); if (!wCommitted) await wt.s.rollback().catch(() => {});
  }
}
/** The withdrawal is in flight (uncommitted) when the mutation arrives: the mutation waits or refuses, and never commits after the withdrawal. */
async function writerFirst(m, w) {
  const c = await freshCompany({ certified: MUT[m].certified });
  const prep = await MUT[m].prepare(c);
  for (const t of prep.seeded ?? []) book(t, 1);
  const before = await count(tableOf(m), c.A);
  const [sql, params] = MUT[m].run(c, prep);
  const wt = await startWriter(w, c, m);
  const ms = await openSession("authenticated", U[MUT[m].actor]);
  let wCommitted = false;
  try {
    const wp = wt.run(); const wres = await wp; checkWriterResult(w, wres);              // the withdrawal's statement has run and holds its locks
    const mp = ms.start(sql, params);
    const state = await until("the mutation to finish or to block", async () => (ms.settled ? "finished" : (await waitingAny(ms.pid)) ? "blocked" : false), 12000);
    let outcome;
    if (state === "finished") {                                                         // it did not wait: it must have refused, or it commits BEFORE the withdrawal does
      const r = ms.result; assert(!r.err, `the mutation errored: ${r.err?.message}`); outcome = r.rows[0].r; await ms.commit();
      await wt.s.commit(); wCommitted = true;
    } else {
      await wt.s.commit(); wCommitted = true;                                           // the withdrawal commits; only now can the waiting mutation continue
      const r = await mp; assert(!r.err, `the mutation errored: ${r.err?.message}`); outcome = r.rows[0].r; await ms.commit();
      assert(isRefusal(outcome), `a mutation that waited for an in-flight withdrawal (${w}) must refuse, got ${JSON.stringify(outcome)}`);
    }
    const after = await count(tableOf(m), c.A);
    const wrote = !outcome.replay && ["recorded", "confirmed"].includes(outcome.outcome) ? 1 : 0;
    console.log(`  . ${m} x ${w} (writer first): mutation ${state}; answered ${JSON.stringify(outcome.outcome)}`);
    assert.equal(after - before, wrote); book(tableOf(m), wrote);
    await withdrawalEffective(w, c, m);
  } finally { await ms.rollback().catch(() => {}); if (!wCommitted) await wt.s.rollback().catch(() => {}); }
}

try {
  db = await openDatabase("ipsas_authority_races");
  await kase("setup.chain-and-world", async () => {
    const err = await applyChain(db); assert.equal(err, null, String(err));
    W = await makeWorld(db); U = W.U;
    assert((await one("SELECT to_regprocedure('public.ipsas_save_presentation(uuid,integer,jsonb,uuid,text,uuid)') IS NOT NULL v")).v);
    // TEST-ONLY barrier (this disposable database only): blocks an INSERT while a barrier session holds the advisory lock; changes no row and no outcome.
    await db.admin.query("CREATE FUNCTION public.proof_barrier() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('proof-barrier', 0)); RETURN NEW; END $f$");
    for (const t of Object.values(TABLE)) await db.admin.query(`CREATE TRIGGER aa_proof_barrier BEFORE INSERT ON public.${t} FOR EACH ROW EXECUTE FUNCTION public.proof_barrier()`);
  });
  if (failures.length) throw new Error("setup failed");
  for (const m of MUTATIONS) for (const w of WRITERS) { if (applicable(m, w)) await kase(`admitted-first.${m}.${w}`, () => admittedFirst(m, w)); }
  for (const w of ["member-removal", "explicit-revoke"]) await kase(`admitted-first.replay.${w}`, () => admittedFirst("replay", w));
  for (const w of WRITERS.filter((x) => x !== "framework-change")) await kase(`writer-first.prep-save.${w}`, () => writerFirst("prep-save", w));
  for (const m of MUTATIONS.filter((x) => x !== "prep-save")) await kase(`writer-first.${m}.member-removal`, () => writerFirst(m, "member-removal"));

  // ── the framework writer, at the helper every mutation calls (a framework change is locked once a certified trial balance exists, so no mutation can be
  //    caught mid-flight by one; the helper's ordering is what keeps it that way) ─────────────────────────────────────────────────────────────────────
  const HELPER = "SELECT public._ipsas_authorize_mutation($1,$2,'prepare_close') r";
  await kase("helper-level.framework-change-waits-for-an-admitted-helper", async () => {
    const c = await freshCompany({ certified: false });
    const adm = await openSession("postgres", null), wt = await startWriter("framework-change", c, "prep-save");
    try {
      const a = await adm.start(HELPER, [c.A, U.preparer]);
      assert(!a.err && a.rows[0].r === null, `admission must succeed: ${JSON.stringify(a)}`);
      const wp = wt.run();
      const state = await until("the framework change to finish or to block", async () => (wt.s.settled ? "finished" : (await waitingAny(wt.s.pid)) ? "blocked" : false), 12000);
      assert.equal(state, "blocked", "a framework change must wait for an admitted mutation's transaction");
      await adm.commit();
      const res = await wp; assert(!res.err && res.rows[0].r.outcome === "changed", JSON.stringify(res.err?.message ?? res.rows[0]));
      await wt.s.commit();
      assert.equal((await one("SELECT reporting_framework f FROM public.companies WHERE id=$1", [c.A])).f, "ifrs_for_smes");
    } finally { await adm.rollback().catch(() => {}); await wt.s.rollback().catch(() => {}); }
  });
  await kase("helper-level.an-in-flight-framework-change-makes-admission-refuse", async () => {
    const c = await freshCompany({ certified: false });
    const adm = await openSession("postgres", null), wt = await startWriter("framework-change", c, "prep-save");
    let wCommitted = false;
    try {
      const w = await wt.run(); assert(!w.err && w.rows[0].r.outcome === "changed");       // the change has run and holds its lock, uncommitted
      const ap = adm.start(HELPER, [c.A, U.preparer]);
      const state = await until("admission to finish or to block", async () => (adm.settled ? "finished" : (await waitingAny(adm.pid)) ? "blocked" : false), 12000);
      assert.equal(state, "blocked", "admission must wait for a framework change that is already in flight");
      await wt.s.commit(); wCommitted = true;
      const r = await ap; assert(!r.err, r.err?.message);
      assert.equal(r.rows[0].r, "framework_not_ipsas_accrual", "after the change committed, admission refuses by name");
    } finally { await adm.rollback().catch(() => {}); if (!wCommitted) await wt.s.rollback().catch(() => {}); }
  });

  await kase("contention.terminates-without-deadlock-or-partial-write", async () => {
    const c = await freshCompany();
    const base = await asU(U.preparer, SAVE, [c.A, JSON.stringify(wp(c.A)), null, uuid()]); assert.equal(base.outcome, "recorded"); book("ipsas_prep_revisions", 1);
    const settle = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("did not terminate (possible deadlock)")), 40000))]).then((r) => ({ r }), (e) => ({ e }));
    const ops = [];
    for (let i = 0; i < 6; i++) ops.push(settle(asU(U.preparer, SAVE, [c.A, JSON.stringify({ ...wp(c.A), convention: i % 2 ? "daily" : "full-period" }), base.revisionId, uuid()])));
    for (let i = 0; i < 3; i++) ops.push(settle(asU(U.partner, CONFIRM, [c.A, CLASS_ID, base.revisionId, uuid()])));
    ops.push(settle(asU(c.owner, WRITER["explicit-revoke"].sql, [c.A, U.preparer, "prepare_close"])));
    ops.push(settle(asU(c.owner, WRITER["explicit-revoke"].sql, [c.A, U.partner, "review_close"])));
    ops.push(settle(db.asRole("authenticated", c.owner, WRITER["member-removal"].sql, [c.A, U.viewer]).then(() => ({ outcome: "removed" }))));
    ops.push(settle(db.asService(WRITER["rollout-closure"].sql, [c.A]).then(() => ({ outcome: "closed" }))));
    const out = await Promise.all(ops);
    const errors = out.filter((x) => x.e).map((x) => `${x.e.code ?? ""} ${x.e.message}`);
    assert.deepEqual(errors, [], `no operation may error, deadlock or hang: ${errors.join(" | ")}`);
    const saved = out.slice(0, 6).filter((x) => x.r.outcome === "recorded").length, confirmed = out.slice(6, 9).filter((x) => x.r.outcome === "confirmed").length;
    book("ipsas_prep_revisions", saved); book("ipsas_confirmations", confirmed);
    assert.equal(await count("ipsas_prep_revisions", c.A), 1 + saved); assert.equal(await count("ipsas_confirmations", c.A), confirmed);
  });
  if (!process.env.RACE_ONLY) await kase("persisted.no-partial-or-cross-company-writes", async () => {
    for (const t of ["ipsas_prep_revisions", "ipsas_confirmations", "ipsas_grant_revisions", "ipsas_grant_confirmations", "ipsas_presentation_revisions"])
      assert.equal(await count(t), expectedRows[t] ?? 0, `${t} holds exactly the rows the recorded outcomes account for`);
  });
  completed = failures.length === 0;
} catch (e) { crashed = true; crashMessage = `${e.code ?? ""}: ${e.stack ?? e.message}`; console.error(crashMessage); process.exitCode = 1; }
finally {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), completed, crashed, crashMessage, cases: results }, null, 2) + "\n");
  console.log(`IPSAS_AUTHORITY_RACES: ${results.filter((r) => r.outcome === "pass").length}/${CASES.length} passed${failures.length ? `; FAILED: ${failures.join(", ")}` : ""}`);
  if (failures.length) process.exitCode = 1;
  await db?.close(); process.exit(process.exitCode ?? 0);
}
