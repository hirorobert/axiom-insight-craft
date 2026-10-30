#!/usr/bin/env bun
// Real-PostgreSQL proof of 20261207100000 (IPSAS accrual preparation, first chain) on the full chain:
//   - only an authorised member of a company whose framework is ipsas_accrual reads or writes; viewers, outsiders, anon and
//     service_role get nothing; tables are not reachable directly; the helpers are not callable by API roles;
//   - the server recomputes the assessment from persisted inputs: forged confirmation / total / TB / ready fields in a payload
//     change nothing; TB facts come from the CERTIFIED rows; an absent key is unknown, never zero;
//   - the SQL calculation equals the independently hand-derived fixture (365-day year, part-year addition, mid-year
//     disposal) and the TypeScript rules on a set of mutations (same blocker codes);
//   - a confirmation binds one exact subject hash: any change to the estimate or the prior-figure set voids it;
//   - twenty identical requests record ONE revision; twenty writers on one revision record ONE and 19 are stale; the same
//     request id with changed intent is refused; history is append-only;
//   - the opening bridge never plugs: a residual is a named blocker with the exact amount, bridged only by evidenced items;
//   - real SME authority rows are byte-identical after all of it; a revoked preparer reads/writes nothing, replay included.
// Synthetic data only. Result: PROOF_RESULT_FILE (default proof-results/ipsasPreparation.present.json).
//
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) bun scripts/db-proof/ipsasPreparation.mjs
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/ipsasPreparation.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChain, certifier, csv, FY2025, FY2026, makeWorld, openDatabase, prepareReporting, REPO, reporter, uuid } from "./lib/reportingKit.mjs";
import { CASES, PROOF } from "./ipsasPreparation.manifest.mjs";
import { computePpeWorkpaper } from "../../src/lib/ipsasAccrual/ppeWorkpaper.ts";
import { computeOpeningBridge } from "../../src/lib/ipsasAccrual/openingBridge.ts";
import { baseInput as handInput, EXPECTED as HAND } from "../../src/lib/ipsasAccrual/ipsasAccrual.fixture.ts";

const MIGRATION = "20261207100000_ipsas_accrual_preparation.sql";
const RESULT_FILE = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results", `${PROOF}.present.json`);
const { group, check, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
let db;
const ids = new Set(CASES.map((c) => c.id));
const recorded = [];
const startedAt = new Date().toISOString();
const manifestSha256 = hex(fs.readFileSync(new URL("./ipsasPreparation.manifest.mjs", import.meta.url), "utf8"));
async function kase(id, title, fn) {
  if (!ids.has(id)) throw new Error(`proof defect: case ${id} is not in the manifest`);
  if (recorded.some((r) => r.id === id)) throw new Error(`proof defect: case ${id} recorded twice`);
  let outcome = "fail", detail = "";
  await check(`[${id}] ${title}`, async () => {
    try { const r = await fn(); if (r === true) { outcome = "pass"; return true; } detail = JSON.stringify(r)?.slice(0, 1500) ?? ""; return r; }
    catch (e) { detail = `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}`; throw e; }
  });
  recorded.push({ id, title, outcome, detail });
}
function writeResult(completed, crashed, crashMessage) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256, startedAt, finishedAt: new Date().toISOString(), completed, crashed, crashMessage: crashMessage ?? null,
    cases: recorded.map(({ id, outcome, detail }) => ({ id, outcome, ...(detail ? { detail } : {}) })) }, null, 2) + "\n");
  console.log(`structured result: ${RESULT_FILE}`);
}

// ── Synthetic figures (TZS, exponent 2), by hand ─────────────────────────────────────────────────────────────────────
// Certified trial balances (reportingKit TB): FY2026 equipment 20,000.00 less accumulated depreciation 6,000.00 = 14,000.00 (1,400,000 minor);
// FY2025 20,000.00 less 4,000.00 = 16,000.00 (1,600,000); depreciation expense 6200 = 2,000.00 (200,000).
// One class, cost 2,000,000, residual 0, ten-year straight line, available the whole year (2026: 365 days): 200,000 a year.
const CLASS_ID = "33333333-3333-4333-8333-333333333333";
const REG = { type: "register", reference: "Fixed asset register FY2026" };
const item = (over = {}) => ({ label: "E1", costMinor: "2000000", residualMinor: "0", openingAccumulatedMinor: "400000", method: "straight-line", lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", availableFrom: "", derecognisedOn: "", ...over });
const estimate = (over = {}) => ({ basis: "cost", method: "straight-line", lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", residualMinor: "0", convention: "daily",
  factors: { usage: "single shift", wear: "annual service", obsolescence: "none expected", legalLimits: "none" }, chargeSource: "calculated", registerChargeMinor: "", registerReference: "",
  items: [item()], calculatedChargeMinor: "", chargeDifference: { amountMinor: "", explanation: "", evidence: "" }, changedSincePrior: "no", changeDescription: "", changeEffectMinor: "",
  rationale: "Ten years of single-shift use expected", evidence: "Maintenance plan MP-2026", ...over });
const cls = (over = {}) => ({ classId: CLASS_ID, label: "Equipment", accounts: "1500, 1510", measurementModel: "cost",
  opening: { grossMinor: "2000000", accumulatedDepreciationMinor: "400000", accumulatedImpairmentMinor: "0", carryingMinor: "1600000" },
  closing: { grossMinor: "2000000", accumulatedDepreciationMinor: "600000", accumulatedImpairmentMinor: "0", carryingMinor: "1400000" },
  movements: [{ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "200000", accumulatedImpairmentMinor: "0", source: REG, note: "" }],
  disposals: [], estimate: estimate(), ...over });
const none = () => ({ status: "none_with_basis", text: "Checked the asset register and board minutes", evidence: "Register FY2026 and minutes", checkedBy: "", flags: { applies: false } });
const answers = () => ({ heritage_assets: none(), infrastructure_assets: none(), impairment_indicators: none(), held_for_sale: none(), commitments_restrictions: none() });
const wp = (A, over = {}) => ({ contract: "cfoclose-ipsas-ppe-workpaper/1", companyId: A, periodYear: 2026, period: { start: "2026-01-01", end: "2026-12-31" }, convention: "daily",
  classes: [cls()], entityAnswers: answers(), depreciationDifference: null, tbSelection: { ppeAccountKeys: ["1500", "1510"], depreciationExpenseKeys: ["6200"] }, ...over });
const prior = (A, over = {}) => ({ contract: "cfoclose-ipsas-prior-figures/1", companyId: A, periodYear: 2026, currency: "TZS", scale: 2,
  lines: [{ lineId: "ppe", label: "Property, plant and equipment", amountMinor: "1600000", locator: "Statement of financial position, p. 12" }], items: [], ...over });
const bridgeItem = (over = {}) => ({ id: "BRIDGE-ITEM-1", groupId: "", lineId: "ppe", kind: "prior-period-error", amountMinor: "-100000", evidenceRef: "Correcting journal J-2026-014", authorityReference: "Approved by the finance committee, minute 4/2026", ...over });

// TypeScript rules over the same persisted inputs the server assessed
const tsPpe = (payload, a) => [...new Set(computePpeWorkpaper({ period: payload.period, convention: payload.convention, entityAnswers: payload.entityAnswers, depreciationDifference: payload.depreciationDifference ?? null,
  tb: { ppeCarryingOpeningMinor: a.tb.ppeCarryingOpeningMinor ?? null, ppeCarryingClosingMinor: a.tb.ppeCarryingClosingMinor ?? null, depreciationExpenseMinor: a.tb.depreciationExpenseMinor ?? null },
  classes: payload.classes.map((c) => ({ ...c, estimateConfirmed: a.confirmedClasses[c.classId] === true })) }).issues.map((i) => `${i.code}|${i.classId ?? ""}`))].sort();
const sqlPpe = (a) => [...(a.ppe?.codes ?? [])].sort();

async function main() {
  db = await openDatabase("ipsas_preparation_proof");
  const admin = db.admin;
  group("Chain and fixtures");
  await kase("setup.chain-applies", `the full chain applies and ${MIGRATION} installs its tables and functions`, async () => {
    const err = await applyChain(db);
    if (err) return err;
    const r = await db.one(`SELECT to_regclass('public.ipsas_prep_revisions') IS NOT NULL a, to_regclass('public.ipsas_confirmations') IS NOT NULL b,
      to_regprocedure('public.ipsas_save_preparation(uuid,integer,text,jsonb,uuid,uuid)') IS NOT NULL c, to_regprocedure('public.ipsas_confirm(uuid,integer,text,text,uuid,uuid)') IS NOT NULL d,
      to_regprocedure('public.ipsas_prep_context(uuid,integer)') IS NOT NULL e`);
    return r.a && r.b && r.c && r.d && r.e ? true : r;
  });
  const W = await makeWorld(db);
  const { U, A: SME } = W;
  const AI = await W.company(U.owner, "Synthetic NGO", "ipsas_accrual");
  for (const k of ["preparer", "partner", "viewer"]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [AI, U[k], k]);
  await W.rollout(AI, true); await W.rollout(SME, true); await W.rollout(W.B, true);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const ctx = (uid = U.preparer, company = AI) => asU(uid, "SELECT public.ipsas_prep_context($1,2026) r", [company]).then((x) => x.r);
  const save = (kind, payload, { uid = U.preparer, company = AI, expected = null, request = uuid() } = {}) =>
    asU(uid, "SELECT public.ipsas_save_preparation($1,2026,$2,$3::jsonb,$4,$5) r", [company, kind, JSON.stringify(payload), expected, request]).then((x) => x.r);
  const confirm = (kind, key, rev, { uid = U.partner, request = uuid(), company = AI } = {}) =>
    asU(uid, "SELECT public.ipsas_confirm($1,2026,$2,$3,$4,$5) r", [company, kind, key, rev, request]).then((x) => x.r);
  const latest = async (kind) => (await ctx(U.owner))[kind === "ppe_workpaper" ? "workpaper" : "priorFigures"];
  const count = async (t) => Number((await admin.query(`SELECT count(*) n FROM public.${t}`)).rows[0].n);
  let wpRev = null;

  await kase("setup.world-and-certified-years", "an IPSAS company with a preparer, a partner and a viewer, and the 2025 and 2026 trial balances certified by the real engine", async () => {
    const k = await certifier(db, U);
    for (const [y, col] of [[2025, FY2025], [2026, FY2026]]) {
      const u = await k.upload(AI, y, csv(col));
      if (y === 2025) await k.review(AI, u); // Shared mapping is reviewed once; reviewing it again invalidates the first certification.
      await k.certify(AI, u);
    }
    const n = await db.one("SELECT count(*)::int n FROM public.tb_certifications WHERE company_id=$1", [AI]);
    return n.n >= 2 ? true : n;
  });
  await kase("static.no-outer-transaction-no-bare-write", "the migration supplies no outer BEGIN/COMMIT and no DELETE/UPDATE without a WHERE clause (PostgREST safeupdate)", async () => {
    const text = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8");
    const stripped = text.replace(/\$\$[\s\S]*?\$\$/g, "").replace(/--.*$/gm, "");
    const outer = stripped.split("\n").filter((l) => /^(BEGIN|COMMIT|ROLLBACK);\s*$/.test(l.trim()));
    const bare = [...text.matchAll(/\b(DELETE\s+FROM|UPDATE)\s+[a-z_."]+\s*(SET[^;]*)?;/gi)].filter((m) => !/WHERE/i.test(m[0]));
    return outer.length === 0 && bare.length === 0 && !text.includes("\u0000") ? true : { outer, bare: bare.map((m) => m[0]) };
  });

  group("Authority");
  await kase("authz.privileges-and-internals", "API roles reach no table directly and none of the helper functions; only the three RPCs are executable, and only by authenticated", async () => {
    const t = [];
    for (const table of ["ipsas_prep_revisions", "ipsas_confirmations"])
      for (const role of ["authenticated", "anon", "service_role"]) {
        try { await db.asRole(role, U.owner, `SELECT * FROM public.${table}`, []); t.push(`${role} read ${table}`); } catch (e) { if (e.code !== "42501") t.push(`${role}:${e.code}`); }
      }
    const fn = async (sig, role) => (await db.one("SELECT has_function_privilege($1, $2, 'EXECUTE') ok", [role, sig])).ok;
    const internals = ["_ipsas_ppe_assess(jsonb,jsonb,jsonb)", "_ipsas_bridge_assess(jsonb,jsonb,boolean)", "_ipsas_live(uuid,integer)", "_ipsas_tb_facts(uuid,integer,jsonb)", "_ipsas_refusal(uuid,uuid,text)", "_ipsas_class_roll(jsonb)"];
    for (const s of internals) for (const role of ["authenticated", "anon", "service_role"]) if (await fn(`public.${s}`, role)) t.push(`${role} may execute ${s}`);
    const rpcs = ["ipsas_prep_context(uuid,integer)", "ipsas_save_preparation(uuid,integer,text,jsonb,uuid,uuid)", "ipsas_confirm(uuid,integer,text,text,uuid,uuid)"];
    for (const s of rpcs) { if (!(await fn(`public.${s}`, "authenticated"))) t.push(`authenticated lacks ${s}`); for (const role of ["anon", "service_role"]) if (await fn(`public.${s}`, role)) t.push(`${role} may execute ${s}`); }
    return t.length === 0 ? true : t;
  });
  await kase("authz.viewer-outsider-anon-service-refused", "a viewer and another workspace's owner read and write nothing; anon and service_role cannot call the RPCs", async () => {
    const before = await count("ipsas_prep_revisions");
    const r = [await ctx(U.viewer), await ctx(U.ownerB), await save("ppe_workpaper", wp(AI), { uid: U.viewer }), await save("ppe_workpaper", wp(AI), { uid: U.ownerB })];
    let anon = "ran", svc = "ran";
    try { await db.asRole("anon", null, "SELECT public.ipsas_prep_context($1,2026)", [AI]); } catch (e) { anon = e.code; }
    try { await db.asRole("service_role", null, "SELECT public.ipsas_save_preparation($1,2026,'ppe_workpaper','{}'::jsonb,NULL,$2)", [AI, uuid()]); } catch (e) { svc = e.code; }
    return r.every((x) => x.outcome === "forbidden") && anon === "42501" && svc === "42501" && (await count("ipsas_prep_revisions")) === before ? true : { r: r.map((x) => x.outcome), anon, svc };
  });
  await kase("authz.framework-gate", "an IFRS for SMEs workspace is not served by the IPSAS preparation, even to its owner", async () => {
    const c = await ctx(U.owner, SME);
    const s = await save("ppe_workpaper", wp(SME), { uid: U.owner, company: SME });
    return c.outcome === "framework_not_ipsas_accrual" && s.outcome === "framework_not_ipsas_accrual" ? true : { c: c.outcome, s: s.outcome };
  });
  await kase("authz.preparer-cannot-confirm", "a preparer (no review capability) cannot record a confirmation", async () => {
    const r = await save("ppe_workpaper", wp(AI));
    const c = await confirm("ppe_class_estimate", CLASS_ID, r.revisionId, { uid: U.preparer });
    wpRev = r.revisionId;
    return r.outcome === "recorded" && c.outcome === "forbidden" ? true : { r: r.outcome, c: c.outcome };
  });

  group("Saving");
  await kase("save.invalid-and-cross-company-refused", "a payload for another company or year, a wrong contract or an invalid class identity is refused before any write", async () => {
    const before = await count("ipsas_prep_revisions");
    const bad = [wp(W.B), wp(AI, { periodYear: 2025 }), wp(AI, { contract: "cfoclose-equipment-workpaper/2" }), wp(AI, { classes: [cls({ classId: "not-a-uuid" })] }), wp(AI, { tbSelection: null }), wp(AI, { period: { start: "x", end: "y" } })];
    const out = [];
    for (const p of bad) out.push((await save("ppe_workpaper", p, { expected: wpRev })).outcome);
    out.push((await save("nonsense", wp(AI))).outcome);
    out.push((await save("prior_figures", prior(AI, { lines: [{ lineId: "revenue", label: "Revenue", amountMinor: "1", locator: "p. 3" }] }))).outcome);
    return out.every((o) => o === "invalid_request") && (await count("ipsas_prep_revisions")) === before ? true : out;
  });
  await kase("save.draft-recorded-and-stale", "an incomplete draft is saved (not rejected), a second save against the old revision is stale, and nothing is ready", async () => {
    const c0 = await ctx();
    const stale = await save("ppe_workpaper", wp(AI), { expected: null });
    const r = await save("ppe_workpaper", wp(AI, { entityAnswers: {} }), { expected: c0.workpaper.id });
    wpRev = r.revisionId;
    return r.outcome === "recorded" && stale.outcome === "stale" && stale.currentId === c0.workpaper.id && r.assessment.ppe.state === "incomplete" && r.assessment.ppe.codes.includes("ENTITY_QUESTION_UNRESOLVED:heritage_assets|") ? true : { r, stale };
  });
  await kase("save.forged-authority-fields-ignored", "a payload that claims confirmation, a ready state, TB figures or an assessment changes nothing: the server derives all of them", async () => {
    const forged = wp(AI, { entityAnswers: {}, tb: { ppeCarryingClosingMinor: "1400000" }, assessment: { state: "ready-for-review", codes: [] }, state: "ready-for-review", confirmedClasses: { [CLASS_ID]: true },
      classes: [cls({ estimateConfirmed: true, confirmed: true, confirmedBy: U.owner })] });
    const r = await save("ppe_workpaper", forged, { expected: wpRev });
    wpRev = r.revisionId;
    const a = r.assessment;
    return a.ppe.codes.includes("ESTIMATE_UNCONFIRMED|" + CLASS_ID) && a.confirmedClasses[CLASS_ID] === undefined && a.ppe.state === "incomplete" && a.tb.certificationId ? true : a;
  });

  group("Replay and concurrency");
  await kase("save.twenty-way-same-request", "twenty identical requests record one revision; every caller gets the same receipt", async () => {
    const before = await count("ipsas_prep_revisions");
    const p = wp(AI, { entityAnswers: answers() }), request = uuid(), expected = wpRev;
    const rs = await Promise.all(Array.from({ length: 20 }, () => save("ppe_workpaper", p, { expected, request })));
    const ids = new Set(rs.map((r) => r.revisionId));
    wpRev = rs[0].revisionId;
    return rs.every((r) => r.outcome === "recorded") && ids.size === 1 && (await count("ipsas_prep_revisions")) === before + 1 && rs.filter((r) => r.replay).length >= 19 ? true : { n: ids.size, outcomes: rs.map((r) => r.outcome) };
  });
  await kase("save.twenty-writers-one-revision", "twenty distinct requests against one expected revision record exactly one and the other nineteen are stale", async () => {
    const before = await count("ipsas_prep_revisions"), expected = wpRev;
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => save("ppe_workpaper", wp(AI, { convention: i % 2 ? "daily" : "full-period" }), { expected })));
    const won = rs.filter((r) => r.outcome === "recorded"), stale = rs.filter((r) => r.outcome === "stale");
    if (won.length === 1) wpRev = won[0].revisionId;
    return won.length === 1 && stale.length === 19 && (await count("ipsas_prep_revisions")) === before + 1 ? true : { won: won.length, stale: stale.length, other: rs.map((r) => r.outcome) };
  });
  await kase("save.changed-intent-same-request", "the same request id with a different payload is refused and writes nothing", async () => {
    const request = uuid(), before = await count("ipsas_prep_revisions");
    const a = await save("ppe_workpaper", wp(AI, { convention: "daily" }), { expected: wpRev, request });
    wpRev = a.revisionId;
    const b = await save("ppe_workpaper", wp(AI, { convention: "full-period" }), { expected: wpRev, request });
    return a.outcome === "recorded" && b.outcome === "request_reused" && (await count("ipsas_prep_revisions")) === before + 1 ? true : { a: a.outcome, b: b.outcome };
  });

  group("Server recalculation");
  await kase("calc.sql-equals-hand-derived-fixture", "the server's recalculation of the hand-derived fixture gives 873,972,602 and 240,000,000, a 374,794,521 loss on disposal and carrying totals 6,320,000,000 → 5,331,232,877", async () => {
    const hand = handInput();
    const payload = wp(AI, { period: hand.period, convention: hand.convention, classes: hand.classes.map(({ estimateConfirmed, ...c }) => c), entityAnswers: hand.entityAnswers });
    const r = await save("ppe_workpaper", payload, { expected: wpRev });
    wpRev = r.revisionId;
    const [v, o] = r.assessment.ppe.classes;
    const t = r.assessment.ppe.totals;
    const ok = v.chargeCalculatedMinor === HAND.vehiclesCharge && o.chargeCalculatedMinor === HAND.officeCharge && v.disposalGainMinor === HAND.v2Loss && v.rollForward === "agrees" && o.rollForward === "agrees"
      && t.openingCarryingMinor === HAND.openingCarrying && t.closingCarryingMinor === HAND.closingCarrying && t.depreciationMinor === HAND.depreciation;
    const equal = JSON.stringify(sqlPpe(r.assessment)) === JSON.stringify(tsPpe(payload, r.assessment));
    return ok && equal ? true : { v, o, t, sql: sqlPpe(r.assessment), ts: tsPpe(payload, r.assessment) };
  });

  group("Trial balance facts");
  await kase("tb.facts-from-certified-rows", "closing, opening and depreciation expense are read from the certified rows (1,400,000 / 1,600,000 / 200,000), whatever the browser says", async () => {
    const r = await save("ppe_workpaper", wp(AI), { expected: wpRev });
    wpRev = r.revisionId;
    const tb = r.assessment.tb;
    return tb.ppeCarryingClosingMinor === "1400000" && tb.ppeCarryingOpeningMinor === "1600000" && tb.depreciationExpenseMinor === "200000" && !!tb.certificationId && !!tb.priorCertificationId ? true : tb;
  });
  await kase("tb.unknown-is-not-zero", "an account key absent from the certified rows makes the figure unknown with a named blocker; a wrong selection is a stated difference", async () => {
    const ghost = await save("ppe_workpaper", wp(AI, { tbSelection: { ppeAccountKeys: ["1500", "9999"], depreciationExpenseKeys: ["6200"] } }), { expected: wpRev });
    wpRev = ghost.revisionId;
    const wrong = await save("ppe_workpaper", wp(AI, { tbSelection: { ppeAccountKeys: ["1500"], depreciationExpenseKeys: ["6200"] } }), { expected: wpRev });
    wpRev = wrong.revisionId;
    const g = ghost.assessment, w = wrong.assessment;
    return g.tb.ppeCarryingClosingMinor === null && g.ppe.codes.includes("TB_CARRYING_CLOSING_UNKNOWN|") && g.ppe.codes.includes("TB_CARRYING_OPENING_UNKNOWN|")
      && w.ppe.codes.includes("TB_CARRYING_CLOSING_DIFFERENCE|") && !w.ppe.codes.includes("TB_CARRYING_CLOSING_UNKNOWN|") ? true : { g: g.ppe.codes, w: w.ppe.codes };
  });

  group("Confirmation");
  await kase("confirm.estimate-bound-to-exact-subject", "a partner's confirmation clears ESTIMATE_UNCONFIRMED for that exact estimate; changing the estimate voids it; the unchanged estimate in a later revision keeps it", async () => {
    const r1 = await save("ppe_workpaper", wp(AI), { expected: wpRev }); wpRev = r1.revisionId;
    const c = await confirm("ppe_class_estimate", CLASS_ID, wpRev);
    const a1 = (await ctx(U.owner)).assessment;
    const r2 = await save("ppe_workpaper", wp(AI, { entityAnswers: answers(), depreciationDifference: null }), { expected: wpRev }); wpRev = r2.revisionId;
    const keeps = !r2.assessment.ppe.codes.includes("ESTIMATE_UNCONFIRMED|" + CLASS_ID);
    const changed = cls({ estimate: estimate({ items: [item({ lifeYears: "8" })], rationale: "Eight years after a condition review" }) });
    const r3 = await save("ppe_workpaper", wp(AI, { classes: [changed] }), { expected: wpRev }); wpRev = r3.revisionId;
    const voided = r3.assessment.ppe.codes.includes("ESTIMATE_UNCONFIRMED|" + CLASS_ID);
    const back = await save("ppe_workpaper", wp(AI), { expected: wpRev }); wpRev = back.revisionId;
    const restored = !back.assessment.ppe.codes.includes("ESTIMATE_UNCONFIRMED|" + CLASS_ID);
    return c.outcome === "confirmed" && a1.confirmedClasses[CLASS_ID] === true && keeps && voided && restored ? true : { c: c.outcome, keeps, voided, restored };
  });
  await kase("confirm.stale-unknown-not-confirmable", "a confirmation against an old revision is stale; an unknown class, an unknown subject kind and an estimate with no charge source are refused", async () => {
    const old = wpRev;
    const r = await save("ppe_workpaper", wp(AI), { expected: old }); wpRev = r.revisionId;
    const stale = await confirm("ppe_class_estimate", CLASS_ID, old);
    const unknown = await confirm("ppe_class_estimate", "44444444-4444-4444-8444-444444444444", wpRev);
    const kind = await confirm("approval", CLASS_ID, wpRev);
    const blank = await save("ppe_workpaper", wp(AI, { classes: [cls({ estimate: estimate({ chargeSource: "" }) })] }), { expected: wpRev }); wpRev = blank.revisionId;
    const notc = await confirm("ppe_class_estimate", CLASS_ID, wpRev);
    const good = await save("ppe_workpaper", wp(AI), { expected: wpRev }); wpRev = good.revisionId;
    return stale.outcome === "stale" && unknown.outcome === "unknown_subject" && kind.outcome === "invalid_request" && notc.outcome === "not_confirmable" ? true : { stale: stale.outcome, unknown: unknown.outcome, kind: kind.outcome, notc: notc.outcome };
  });
  await kase("confirm.replay-and-changed-intent", "repeating a confirmation request returns its receipt; reusing the id for another subject is refused; twenty concurrent confirmations are all the same receipt", async () => {
    const request = uuid(), n0 = await count("ipsas_confirmations");
    const rs = await Promise.all(Array.from({ length: 20 }, () => confirm("ppe_class_estimate", CLASS_ID, wpRev, { request })));
    const reused = await confirm("prior_figure_set", "prior_figures", wpRev, { request });
    return rs.every((x) => x.outcome === "confirmed") && new Set(rs.map((x) => x.confirmationId)).size === 1 && reused.outcome === "request_reused" && (await count("ipsas_confirmations")) === n0 + 1 ? true : { ids: new Set(rs.map((x) => x.confirmationId)).size, reused: reused.outcome };
  });

  group("Reaching review");
  await kase("ready.complete-slice-reaches-review", "with the bases, estimates, ties and entity answers in place and the estimate confirmed, the slice is ready for review — and says official issuance is not what it means", async () => {
    const r = await save("ppe_workpaper", wp(AI), { expected: wpRev }); wpRev = r.revisionId;
    const a = r.assessment.ppe;
    return a.state === "ready-for-review" && a.codes.length === 0 && a.totals.closingCarryingMinor === "1400000" && a.totals.depreciationMinor === "200000" && JSON.stringify(tsPpe(wp(AI), r.assessment)) === "[]" ? true : a;
  });

  group("Opening bridge");
  let priorRev = null;
  await kase("bridge.unconfirmed-then-agrees", "a printed prior figure is unconfirmed until a partner confirms that exact set; then it agrees to the workpaper opening", async () => {
    const p = await save("prior_figures", prior(AI), { expected: null }); priorRev = p.revisionId;
    const unconfirmed = p.assessment.bridge;
    const c = await confirm("prior_figure_set", "prior_figures", priorRev);
    const after = c.assessment.bridge;
    return unconfirmed.codes.includes("PUBLISHED_FIGURE_UNCONFIRMED|ppe") && unconfirmed.state === "blocked" && c.outcome === "confirmed" && after.state === "agrees" && after.lines[0].status === "agrees" ? true : { unconfirmed, after };
  });
  await kase("bridge.residual-never-plugged", "a different printed figure voids the confirmation; once confirmed, the opening differs by exactly 100,000 and that is a blocker, not an adjustment", async () => {
    const p = await save("prior_figures", prior(AI, { lines: [{ lineId: "ppe", label: "Property, plant and equipment", amountMinor: "1700000", locator: "Statement of financial position, p. 12" }] }), { expected: priorRev }); priorRev = p.revisionId;
    const voided = p.assessment.bridge.codes.includes("PUBLISHED_FIGURE_UNCONFIRMED|ppe");
    const c = await confirm("prior_figure_set", "prior_figures", priorRev);
    const b = c.assessment.bridge, line = b.lines[0];
    return voided && b.state === "blocked" && b.codes.includes("OPENING_RESIDUAL_UNEXPLAINED|ppe") && line.differenceMinor === "-100000" && line.residualMinor === "-100000" && line.bridgedMinor === "0" ? true : b;
  });
  await kase("bridge.evidenced-item-bridges-exactly", "an evidenced, authorised item for exactly the difference bridges it; a different amount does not; the printed figure stays as printed", async () => {
    const mk = (items) => prior(AI, { lines: [{ lineId: "ppe", label: "Property, plant and equipment", amountMinor: "1700000", locator: "Statement of financial position, p. 12" }], items });
    const off = await save("prior_figures", mk([bridgeItem({ amountMinor: "-99999" })]), { expected: priorRev }); priorRev = off.revisionId;
    await confirm("prior_figure_set", "prior_figures", priorRev);
    const offB = (await ctx(U.owner)).assessment.bridge;
    const exact = await save("prior_figures", mk([bridgeItem()]), { expected: priorRev }); priorRev = exact.revisionId;
    const c = await confirm("prior_figure_set", "prior_figures", priorRev);
    const b = c.assessment.bridge;
    return offB.state === "blocked" && offB.lines[0].residualMinor === "-1" && b.state === "bridged" && b.lines[0].status === "bridged" && b.lines[0].publishedMinor === "1700000" && b.lines[0].residualMinor === "0" ? true : { offB, b };
  });
  await kase("bridge.invalid-items-and-foreign-source", "an item without evidence or authority, a one-sided reclassification, a duplicate item id and a source document of another company are refused", async () => {
    const mk = (items) => prior(AI, { items });
    const codes = async (items) => (await save("prior_figures", mk(items), { expected: priorRev })).assessment;
    const noEv = await codes([bridgeItem({ evidenceRef: "" })]); priorRev = (await ctx(U.owner)).priorFigures.id;
    const oneSided = await codes([bridgeItem({ kind: "reclassification", groupId: "GROUP-1" })]); priorRev = (await ctx(U.owner)).priorFigures.id;
    const dup = await codes([bridgeItem(), bridgeItem()]); priorRev = (await ctx(U.owner)).priorFigures.id;
    const foreign = await save("prior_figures", prior(AI, { lines: [{ lineId: "ppe", label: "PPE", amountMinor: "1600000", locator: "p. 12", sourceDocumentId: uuid() }] }), { expected: priorRev });
    return [noEv, oneSided, dup].every((a) => a.bridge.codes.includes("BRIDGE_ITEM_INVALID|")) && foreign.outcome === "source_mismatch" ? true : { noEv: noEv.bridge.codes, oneSided: oneSided.bridge.codes, dup: dup.bridge.codes, foreign: foreign.outcome };
  });
  await kase("bridge.sql-equals-typescript-rules", "the server's bridge status and codes equal the TypeScript rules on agree, residual, bridged, unconfirmed and invalid-item inputs", async () => {
    const out = [];
    const cases = [
      [prior(AI), true], [prior(AI), false], [prior(AI, { lines: [{ lineId: "ppe", label: "PPE", amountMinor: "1700000", locator: "p. 12" }] }), true],
      [prior(AI, { lines: [{ lineId: "ppe", label: "PPE", amountMinor: "1700000", locator: "p. 12" }], items: [bridgeItem()] }), true],
      [prior(AI, { lines: [{ lineId: "ppe", label: "PPE", amountMinor: "1700000", locator: "p. 12" }], items: [bridgeItem({ authorityReference: "x" })] }), true],
      [prior(AI, { lines: [{ lineId: "ppe", label: "PPE", amountMinor: null, locator: "p. 12" }] }), true],
    ];
    for (const [payload, confirmed] of cases) {
      const sql = (await db.one("SELECT public._ipsas_bridge_assess($1::jsonb, $2::jsonb, $3) r", [JSON.stringify(payload), JSON.stringify({ ppe: "1600000" }), confirmed])).r;
      const ts = computeOpeningBridge(payload.lines.map((l) => ({ ...l, confirmed })), [{ lineId: "ppe", label: "PPE", amountMinor: "1600000", source: "prior-tb-closing", reference: "x" }], payload.items);
      const tsCodes = [...new Set([...ts.blockers.map((b) => `${b.code}|${b.lineId ?? ""}`), ...(ts.itemProblems.length ? ["BRIDGE_ITEM_INVALID|"] : [])])].sort();
      if (JSON.stringify([...sql.codes].sort()) !== JSON.stringify(tsCodes) || sql.state !== ts.state) out.push({ sql: sql.codes, ts: tsCodes, s1: sql.state, s2: ts.state });
    }
    return out.length === 0 ? true : out;
  });

  group("SQL equals TypeScript");
  await kase("calc.sql-equals-typescript-rules", "the same blocker codes from SQL and TypeScript on mutations: revaluation, missing life, unexplained charge, unsupported movement, heritage applies, register without reference, no convention, duplicate class, dropped item, empty answers", async () => {
    const base = () => wp(AI);
    const mut = [
      wp(AI, { classes: [cls({ measurementModel: "revaluation" })] }),
      wp(AI, { classes: [cls({ estimate: estimate({ items: [item({ lifeYears: "" })] }) })] }),
      wp(AI, { classes: [cls({ closing: { grossMinor: "2000000", accumulatedDepreciationMinor: "600001", accumulatedImpairmentMinor: "0", carryingMinor: "1399999" }, movements: [{ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "200001", accumulatedImpairmentMinor: "0", source: REG, note: "" }] })] }),
      wp(AI, { classes: [cls({ movements: [{ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "200000", accumulatedImpairmentMinor: "0", source: REG, note: "" }, { kind: "revaluations_and_oci_impairment", grossMinor: "0", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", source: REG, note: "" }] })] }),
      wp(AI, { entityAnswers: { ...answers(), heritage_assets: { status: "answered", text: "The trust holds a collection", evidence: "Collection register", checkedBy: "", flags: { applies: true } } } }),
      wp(AI, { classes: [cls({ estimate: estimate({ chargeSource: "register", registerChargeMinor: "200000", registerReference: "" }) })] }),
      wp(AI, { classes: [cls({ estimate: estimate({ chargeSource: "register", registerChargeMinor: "200000", registerReference: "Register export 2026" }) })] }),
      wp(AI, { convention: "" }),
      wp(AI, { classes: [cls(), cls({ classId: "55555555-5555-4555-8555-555555555555" })] }),
      wp(AI, { classes: [cls({ estimate: estimate({ items: [item({ costMinor: "1999999" })] }) })] }),
      wp(AI, { entityAnswers: {} }),
      wp(AI, { classes: [] }),
      wp(AI, { depreciationDifference: { amountMinor: "5", explanation: "unused", evidence: "unused" } }),
    ];
    const bad = [];
    let rev = (await ctx(U.owner)).workpaper.id;
    for (const [i, payload] of [base(), ...mut].entries()) {
      const r = await save("ppe_workpaper", payload, { expected: rev });
      if (r.outcome !== "recorded") { bad.push({ i, outcome: r.outcome }); continue; }
      rev = r.revisionId;
      const s = sqlPpe(r.assessment), t = tsPpe(payload, r.assessment);
      if (JSON.stringify(s) !== JSON.stringify(t)) bad.push({ i, sql: s, ts: t });
    }
    const restore = await save("ppe_workpaper", base(), { expected: rev }); wpRev = restore.revisionId;
    return bad.length === 0 ? true : bad;
  });

  group("History and preservation");
  await kase("history.append-only", "revisions and confirmations cannot be updated, deleted or truncated, even by the database administrator's ordinary statements", async () => {
    const r = [];
    for (const sql of ["UPDATE public.ipsas_prep_revisions SET kind = kind WHERE true", "DELETE FROM public.ipsas_prep_revisions WHERE true", "TRUNCATE public.ipsas_prep_revisions",
      "UPDATE public.ipsas_confirmations SET subject_key = subject_key WHERE true", "DELETE FROM public.ipsas_confirmations WHERE true", "TRUNCATE public.ipsas_confirmations"]) {
      // TRUNCATE of the revisions table is refused earlier by PostgreSQL itself (0A000: referenced by a foreign key); both are refusals.
      try { await admin.query(sql); r.push(`allowed: ${sql}`); } catch (e) { if (e.code !== "42501" && !(e.code === "0A000" && sql.startsWith("TRUNCATE"))) r.push(`${e.code}: ${sql}`); }
    }
    return r.length === 0 ? true : r;
  });
  await kase("preserve.sme-authority-byte-identical", "real SME authority rows (certified years, presentation, schedules, notes, evidence, equipment workpapers) are byte-identical after every IPSAS operation above", async () => {
    const k = await certifier(db, U);
    await prepareReporting(db, W, k, { year: 2026 });
    const rowsOf = async (sql, p = []) => hex(JSON.stringify((await admin.query(sql, p)).rows));
    const snap = async () => hex(JSON.stringify([
      ...(await Promise.all(["fs_schedule_submissions", "fs_disclosure_texts", "financial_evidence_batches", "fs_equipment_workpapers", "financial_statement_reports"].map((t) => rowsOf(`SELECT to_jsonb(t)::text j FROM public.${t} t ORDER BY 1`)))),
      await rowsOf("SELECT to_jsonb(t)::text j FROM public.tb_certifications t WHERE company_id=$1 ORDER BY 1", [SME]),
      await rowsOf("SELECT to_jsonb(c)::text j FROM public.companies c WHERE id=$1", [SME])]));
    const before = await snap();
    const r = await save("ppe_workpaper", wp(AI), { expected: wpRev }); wpRev = r.revisionId;
    await confirm("ppe_class_estimate", CLASS_ID, wpRev);
    await ctx(U.owner);
    const sme = await ctx(U.owner, SME);
    return before === (await snap()) && sme.outcome === "framework_not_ipsas_accrual" ? true : { sme: sme.outcome };
  });
  await kase("access.revoked-preparer-refused-incl-replay", "a preparer whose membership is withdrawn reads and writes nothing, and cannot replay an earlier request to read its receipt", async () => {
    const request = uuid(), p = wp(AI), exp = wpRev;
    const first = await save("ppe_workpaper", p, { expected: exp, request }); wpRev = first.revisionId;
    await admin.query("UPDATE public.firm_members SET accepted_at=NULL WHERE company_id=$1 AND user_id=$2", [AI, U.preparer]);
    const before = await count("ipsas_prep_revisions");
    const c = await ctx(), s = await save("ppe_workpaper", p, { expected: wpRev }), replay = await save("ppe_workpaper", p, { expected: exp, request });
    return first.outcome === "recorded" && c.outcome === "forbidden" && s.outcome === "forbidden" && replay.outcome === "forbidden" && replay.revisionId === undefined && (await count("ipsas_prep_revisions")) === before ? true : { c: c.outcome, s: s.outcome, replay };
  });
}

let crashed = false, crashMessage = null;
try { await main(); } catch (e) { crashed = true; crashMessage = `${e.code ?? ""}:${String(e?.stack ?? e).slice(0, 2000)}`; console.error(e.stack ?? e); }
writeResult(!crashed, crashed, crashMessage);
const ok = finish("IPSAS_PREPARATION", crashed);
await db?.close();
process.exit(ok ? 0 : 1);
