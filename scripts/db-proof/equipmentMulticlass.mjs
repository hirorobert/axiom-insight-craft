#!/usr/bin/env bun
// Real-PostgreSQL proof of 20261206100000 (multi-class, evidence-linked equipment preparation) on the full chain:
//   - the context loads the recorded schedule's classes, the notes and the latest answers; viewers, outsiders, anon and
//     service_role read nothing;
//   - the commit refuses, before any write: changed statements, a stale workpaper / schedule / note, a dropped class, a
//     gross or accumulated roll-forward difference (never balanced by an invented movement), a depreciation charge
//     whose destinations do not account for it, an estimate stated as a tax class, an unresolved mandatory question when
//     reviewed notes are included, a cross-company call;
//   - twelve concurrent identical commits record ONE workpaper, ONE two-class schedule (both classes preserved), the
//     answers as facts and the reviewed notes (existing wording preserved); replay returns the receipt; a changed intent
//     under the same request is refused;
//   - a disposal with confirmed proceeds and part of the depreciation capitalised reconcile through cost and
//     accumulated depreciation; a class is retired only with a reason and evidence;
//   - answers recorded for a period are offered to the next period; history is append-only; earlier schedule and
//     disclosure records and a FINAL version issued before the preparation are byte-identical afterwards; a revoked
//     preparer reads and writes nothing.
// Every case has a stable id in equipmentMulticlass.manifest.mjs; the run writes a structured result
// (PROOF_RESULT_FILE, default proof-results/equipmentMulticlass.present.json). Synthetic data only.
//
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) bun scripts/db-proof/equipmentMulticlass.mjs
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/equipmentMulticlass.mjs
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { applyChain, certifier, clientDb, csv, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, FY2026, makeWorld, openDatabase, prepareReporting, REPO, reporter, uuid } from "./lib/reportingKit.mjs";
import { classFromScheduleRow, excludeReviewedZeroMovements } from "../../src/lib/preparation/equipmentEditor.ts";
import { CASES, PROOF } from "./equipmentMulticlass.manifest.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const MIGRATION = "20261206100000_fs_equipment_multiclass.sql";
const MODE = "present";
const RESULT_FILE = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results", `${PROOF}.${MODE}.json`);
const { group, check, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const errOf = (e) => `${e.code ?? ""}:${String(e.message).split("\n")[0]}`;
let db;

const ids = new Set(CASES.map((c) => c.id));
const recorded = [];
const startedAt = new Date().toISOString();
const manifestSha256 = hex(fs.readFileSync(new URL("./equipmentMulticlass.manifest.mjs", import.meta.url), "utf8"));
async function kase(id, title, fn) {
  if (!ids.has(id)) throw new Error(`proof defect: case ${id} is not in the manifest`);
  if (recorded.some((r) => r.id === id)) throw new Error(`proof defect: case ${id} recorded twice`);
  let outcome = "fail", detail = "";
  await check(`[${id}] ${title}`, async () => {
    try { const r = await fn(); if (r === true) { outcome = "pass"; return true; } detail = JSON.stringify(r)?.slice(0, 1500) ?? ""; return r; }
    catch (e) { detail = `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}${e.where ? ` | where: ${String(e.where).slice(0, 300)}` : ""}`; throw e; }
  });
  recorded.push({ id, title, outcome, detail });
}
function writeResult(completed, crashed, crashMessage) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ proof: PROOF, mode: MODE, manifestSha256, startedAt, finishedAt: new Date().toISOString(), completed, crashed, crashMessage: crashMessage ?? null,
    cases: recorded.map(({ id, outcome, detail }) => ({ id, outcome, ...(detail ? { detail } : {}) })) }, null, 2) + "\n");
  console.log(`structured result: ${RESULT_FILE}`);
}

// ── Synthetic figures (TZS, exponent 2), calculated by hand ───────────────────────────────────────────────────────────
// The fixture's composed PPE line: 20,000.00 cost less 6,000.00 accumulated depreciation = 14,000.00 (prior 16,000.00);
// the depreciation expense account 6200 = 2,000.00, presented on sci.operating_expenses_by_function (9,900.00).
// Split into two classes that together still reconcile to the statements and preserve the recorded class "Equipment":
//   Equipment       gross 12,500 / acc dep 2,500 → 10,000 opening; depreciation 1,250; closing 12,500 / 3,750 → 8,750
//   Motor vehicles  gross  7,500 / acc dep 1,500 →  6,000 opening; depreciation   750; closing  7,500 / 2,250 → 5,250
const EQUIPMENT_ID = "11111111-1111-4111-8111-111111111111", VEHICLES_ID = "22222222-2222-4222-8222-222222222222";
const src = (reference) => ({ type: "register", reference });
const answered = (text, flags = {}) => ({ status: "answered", text, evidence: "Synthetic engagement file E-2026", checkedBy: "", flags });
const none = () => ({ status: "none_with_basis", text: "", evidence: "Loan register, contracts and board minutes checked", checkedBy: "Synthetic preparer, 2027-01-15", flags: {} });
const estimate = (over = {}) => ({
  basis: "cost", method: "straight-line", lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", residualMinor: "0", convention: "full-period",
  factors: { usage: "two shifts", wear: "annual service", obsolescence: "none expected", legalLimits: "none" },
  chargeSource: "register", registerChargeMinor: "125000", registerReference: "Synthetic register depreciation report 2026", items: [],
  changedSincePrior: "no", changeDescription: "", changeEffectMinor: "", rationale: "Expected ten years of two-shift use", evidence: "Capital budget and maintenance plan", ...over,
});
const cls = (classId, label, accounts, opening, closing, movements, estimateOver = {}, disposals = []) => ({
  classId, label, origin: "existing", accounts,
  opening: { grossMinor: opening[0], accumulatedDepreciationMinor: opening[1], accumulatedImpairmentMinor: "0", carryingMinor: opening[2] },
  closing: { grossMinor: closing[0], accumulatedDepreciationMinor: closing[1], accumulatedImpairmentMinor: "0", carryingMinor: closing[2] },
  movements, disposals, estimate: estimate(estimateOver),
  answers: { recognition: answered("All items owned; invoices and registration documents on file"), components: answered("No major parts with different lives; uniform items") },
});
const dep = (minor, ref = "Synthetic register depreciation report 2026") => ({ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: minor, accumulatedImpairmentMinor: "0", source: src(ref), note: "" });
const equipmentClass = () => cls(EQUIPMENT_ID, "Equipment", "1500 Equipment at cost, 1510 Accumulated depreciation", ["1250000", "250000", "1000000"], ["1250000", "375000", "875000"], [dep("125000")]);
const vehiclesClass = () => cls(VEHICLES_ID, "Motor vehicles", "1500 (vehicle items), 1510", ["750000", "150000", "600000"], ["750000", "225000", "525000"], [dep("75000")], { registerChargeMinor: "75000" });
const entityAnswers = () => ({
  restrictions_security: none(), commitments: none(), events_after: none(),
  impairment: answered("No damage, obsolescence, idle items or early disposal plans; checklist signed", { indicator_present: false }),
  framework_history: answered("Prepared under the IFRS for SMEs since FY2020", { first_smes_statements: false }),
});
const payloadFor = (A, compositionSha256, over = {}) => ({
  contract: "cfoclose-equipment-workpaper/2", companyId: A, periodYear: 2026, compositionSha256, currency: "TZS", exponent: 2,
  priorSource: { fact: null }, openingBridge: { adjustments: [], openingMinor: "1600000" },
  classes: [equipmentClass(), vehiclesClass()], retiredClasses: [],
  destinations: [{ target: "sci.operating_expenses_by_function", amountMinor: "200000", evidence: "Expense ledger 6200 Depreciation", explanation: "" }],
  entityAnswers: entityAnswers(), questions: { unresolved: [] }, contentVersion: "sme-2015-equipment-preparation/2", ...over,
});

async function main() {
  db = await openDatabase("equipment_multiclass_proof");
  const admin = db.admin;
  group("Chain and fixtures");
  await kase("setup.chain-applies", `the full chain applies and ${MIGRATION} installs its table and functions`, async () => {
    const err = await applyChain(db);
    if (err) return err;
    const r = await db.one(`SELECT to_regclass('public.fs_equipment_answers') IS NOT NULL t,
      to_regprocedure('public.fs_commit_equipment_preparation_v2(uuid,integer,jsonb,uuid,uuid,uuid,jsonb,uuid)') IS NOT NULL c,
      to_regprocedure('public.fs_equipment_context_v2(uuid,integer)') IS NOT NULL x, to_regprocedure('public.fs_save_equipment_workpaper_v2(uuid,integer,jsonb,uuid,uuid,uuid)') IS NOT NULL s,
      has_function_privilege('authenticated','public._fs_equipment_v2_problems(jsonb,jsonb,jsonb,boolean,date,date)','EXECUTE') internal_exposed`);
    return r.t && r.c && r.x && r.s && r.internal_exposed === false ? true : r;
  });
  const W = await makeWorld(db);
  const { U, A, B } = W;
  await W.rollout(A, true); await W.rollout(B, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const ctx = (uid = U.preparer, company = A, year = Y) => asU(uid, "SELECT public.fs_equipment_context_v2($1,$2) r", [company, year]).then((x) => x.r);
  const commit = (p, { uid = U.preparer, company = A, expectedWorkpaper = null, expectedSchedule = null, notes = [], request = uuid(), source = null } = {}) =>
    asU(uid, "SELECT public.fs_commit_equipment_preparation_v2($1,2026,$2::jsonb,$3,$4,$5,$6::jsonb,$7) r", [company, JSON.stringify(p), expectedWorkpaper, source, expectedSchedule, JSON.stringify(notes), request]).then((x) => x.r);
  const counts = async () => JSON.stringify((await admin.query("SELECT (SELECT count(*) FROM public.fs_equipment_workpapers) w,(SELECT count(*) FROM public.fs_schedule_submissions) s,(SELECT count(*) FROM public.fs_disclosure_texts) t,(SELECT count(*) FROM public.fs_equipment_policy_insertions) n,(SELECT count(*) FROM public.fs_equipment_answers) a")).rows[0]);
  const notesStatus = async () => (await asU(U.preparer, "SELECT public.fs_notes_status($1,2026) r", [A])).r;
  const ppeStatus = async () => (await notesStatus()).requirements.find((r) => r.requirementId === "smes.schedule.ppe");
  let compose, baseCounts, snapshotBefore;
  const snapshot = async () => hex(JSON.stringify([
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.fs_schedule_submissions t ORDER BY seq")).rows,
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.fs_disclosure_texts t ORDER BY seq")).rows,
  ]));
  await kase("setup.world-and-fixtures", "two certified years, presentation, notes, a one-class PPE schedule (Equipment 16,000 → 14,000), comparatives approved; the statements compose", async () => {
    await prepareReporting(db, W, k, { year: Y });
    compose = (await asU(U.owner, "SELECT public.fs_statement_composition($1,2026) r", [A])).r;
    const ppe = compose.lines.find((l) => l.lineId === "sfp.property_plant_and_equipment");
    const opex = compose.lines.find((l) => l.lineId === "sci.operating_expenses_by_function");
    baseCounts = await counts(); snapshotBefore = await snapshot();
    return compose.state === "composed" && ppe?.current.amountMinor === "1400000" && opex?.current.amountMinor === "990000" && (await ppeStatus())?.status === "reconciled" ? true : { state: compose.state, ppe: ppe?.current, opex: opex?.current };
  });
  await kase("static.no-outer-transaction-no-bare-write", "the migration supplies no outer BEGIN/COMMIT (the native migrator owns the transaction) and no DELETE/UPDATE without a WHERE clause (PostgREST safeupdate)", async () => {
    const text = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8");
    const stripped = text.replace(/\$\$[\s\S]*?\$\$/g, "").replace(/--.*$/gm, "");
    const outer = stripped.split("\n").filter((l) => /^(BEGIN|COMMIT|ROLLBACK);\s*$/.test(l.trim()));
    const bare = [...text.matchAll(/\b(DELETE\s+FROM|UPDATE)\s+[a-z_."]+\s*(SET[^;]*)?;/gi)].filter((m) => !/WHERE/i.test(m[0]));
    return outer.length === 0 && bare.length === 0 && !text.includes("\u0000") ? true : { outer, bare: bare.map((m) => m[0]) };
  });

  group("Context and drafts");
  await kase("ctx.viewer-outsider-refused", "a viewer and another workspace's owner read no preparation context", async () =>
    (await ctx(U.viewer)).outcome === "forbidden" && (await ctx(U.ownerB)).outcome === "forbidden" ? true : "readable");
  let base;
  await kase("ctx.existing-classes-loaded", "the preparer's context carries the recorded schedule's classes, the three notes and (as yet) no answers", async () => {
    base = await ctx();
    return base.outcome === "available" && base.schedule?.rows?.length === 1 && base.schedule.rows[0].classLabel === "Equipment" && base.notes["smes.note.policies"]?.body === "Historical cost."
      && base.notes["smes.note.estimates"]?.body === "Useful lives." && base.notes["smes.note.subclassifications"]?.body === "All receivables from third parties." && base.answers.length === 0 && base.priorAnswers.length === 0 && base.workpaper === null ? true : base;
  });
  await kase("draft.save-stale-and-v1-contract", "a draft saves (compare-and-set), a second save against the old revision is stale, and the single-class /1 contract is not a /2 draft", async () => {
    const draft = payloadFor(A, compose.compositionSha256, { classes: [equipmentClass()], entityAnswers: {} });
    const save = (expected, req = uuid(), p = draft) => asU(U.preparer, "SELECT public.fs_save_equipment_workpaper_v2($1,2026,$2::jsonb,$3,NULL,$4) r", [A, JSON.stringify(p), expected, req]).then((x) => x.r);
    const r1 = await save(null);
    const r2 = await save(null);
    const r3 = await save(null, uuid(), { ...draft, contract: "cfoclose-equipment-workpaper/1" });
    const c = await ctx();
    return r1.outcome === "recorded" && r2.outcome === "stale" && r2.currentId === r1.workpaperId && r3.outcome === "invalid_request" && c.workpaper?.id === r1.workpaperId && c.workpaper.contract === "cfoclose-equipment-workpaper/2" ? true : { r1, r2, r3 };
  });
  let draftId = (await ctx()).workpaper.id;
  const scheduleId0 = base.schedule.id;
  let scheduleId = scheduleId0;
  const notesFor = (c, policyText, estimatesText) => [
    { requirementId: "smes.note.policies", expectedTextId: c.notes["smes.note.policies"]?.id ?? null, body: `${c.notes["smes.note.policies"]?.body ?? ""}\n\nEquipment — reviewed section\n\n${policyText}` },
    { requirementId: "smes.note.estimates", expectedTextId: c.notes["smes.note.estimates"]?.id ?? null, body: `${c.notes["smes.note.estimates"]?.body ?? ""}\n\n${estimatesText}` },
  ];
  const POLICY = "Equipment and motor vehicles are measured at cost less accumulated depreciation; straight-line over 10 years; no residual value.";
  const ESTIMATES = "Useful lives of equipment (10 years) and motor vehicles (10 years) are the entity's estimates; carrying amounts 8,750.00 and 5,250.00.";

  group("Refusals before any write");
  const unchanged = async () => (await counts()) === (await counts.base);
  counts.base = await counts();
  await kase("commit.cross-company-refused", "the preparer of A cannot prepare B's equipment", async () =>
    (await commit(payloadFor(B, compose.compositionSha256), { company: B })).outcome === "forbidden" && (await unchanged()) ? true : "written");
  await kase("commit.stale-inputs-refused", "a workpaper reviewed against other statements is refused (stale_inputs) with nothing written", async () =>
    (await commit(payloadFor(A, "0".repeat(64)), { expectedWorkpaper: draftId, expectedSchedule: scheduleId })).outcome === "stale_inputs" && (await unchanged()) ? true : "written");
  await kase("commit.rollforward-difference-refused", "a closing gross amount the movements do not reach is named (ROLLFORWARD_GROSS, difference 100,000) and nothing is stored", async () => {
    const p = payloadFor(A, compose.compositionSha256);
    p.classes[0].closing.grossMinor = "1350000"; p.classes[0].closing.carryingMinor = "975000";
    p.classes[1].closing.carryingMinor = "425000"; p.classes[1].closing.accumulatedDepreciationMinor = "325000"; p.classes[1].movements = [dep("175000")];
    const r = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const codes = (r.problems ?? []).map((x) => `${x.code}${x.differenceMinor ? ":" + x.differenceMinor : ""}`);
    return r.outcome === "invalid_preparation" && codes.includes("ROLLFORWARD_GROSS:100000") && (await unchanged()) ? true : { r: r.outcome, codes };
  });
  await kase("commit.missing-movement-never-balanced", "a class whose depreciation movement is missing shows the exact accumulated-depreciation and carrying differences; no balancing movement is ever created", async () => {
    const p = payloadFor(A, compose.compositionSha256);
    p.classes[0].movements = [];
    p.destinations = [{ target: "sci.operating_expenses_by_function", amountMinor: "75000", evidence: "Expense ledger 6200", explanation: "" }];
    const r = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const acc = (r.problems ?? []).find((x) => x.code === "ROLLFORWARD_ACCUMULATED_DEPRECIATION" && x.class === "Equipment");
    const rows = await admin.query("SELECT rows FROM public.fs_schedule_submissions WHERE company_id=$1 ORDER BY seq DESC LIMIT 1", [A]);
    return r.outcome === "invalid_preparation" && acc?.differenceMinor === "125000" && (await unchanged()) && rows.rows[0].rows.length === 1 ? true : { r: r.outcome, acc };
  });
  await kase("commit.class-dropped-refused", "a preparation that omits the recorded class Equipment is refused by name (CLASS_DROPPED) and the schedule keeps it", async () => {
    const p = payloadFor(A, compose.compositionSha256, { classes: [{ ...vehiclesClass(), closing: { grossMinor: "750000", accumulatedDepreciationMinor: "225000", accumulatedImpairmentMinor: "0", carryingMinor: "525000" } }] });
    p.destinations = [{ target: "sci.operating_expenses_by_function", amountMinor: "75000", evidence: "Expense ledger 6200", explanation: "" }];
    const r = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const codes = (r.problems ?? []).map((x) => `${x.code}:${x.class ?? ""}`);
    return r.outcome === "invalid_preparation" && codes.includes("CLASS_DROPPED:Equipment") && (await unchanged()) && (await ctx()).schedule.rows[0].classLabel === "Equipment" ? true : { r: r.outcome, codes };
  });
  await kase("commit.destinations-mismatch-refused", "depreciation of 2,000 with destinations of 1,500 is refused (difference 500); an amount above its composed line is refused too", async () => {
    const p = payloadFor(A, compose.compositionSha256, { destinations: [{ target: "sci.operating_expenses_by_function", amountMinor: "150000", evidence: "Expense ledger 6200", explanation: "" }] });
    const r = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    // 2,000,000 on cost of sales exceeds that composed line (1,400,000); the by-nature line is not composed for this entity.
    const q = payloadFor(A, compose.compositionSha256, { destinations: [{ target: "sci.cost_of_sales", amountMinor: "2000000", evidence: "Cost of sales ledger", explanation: "" }, { target: "sci.depreciation_and_amortisation", amountMinor: "0", evidence: "Expense ledger", explanation: "" }] });
    const r2 = await commit(q, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const codes2 = (r2.problems ?? []).map((x) => x.code);
    const mm = (r.problems ?? []).find((x) => x.code === "DEPRECIATION_DESTINATIONS_MISMATCH");
    return r.outcome === "invalid_preparation" && mm?.differenceMinor === "50000" && codes2.includes("DESTINATION_LINE_ABSENT") && codes2.includes("DEPRECIATION_EXCEEDS_LINE") && (await unchanged()) ? true : { r: r.outcome, mm, codes2 };
  });
  await kase("commit.tax-class-estimate-refused", "a useful life rationale that cites a tax class is not an entity estimate (ESTIMATE_NOT_ENTITY_SPECIFIC); a non-numeric life is incomplete", async () => {
    const p = payloadFor(A, compose.compositionSha256);
    p.classes[1].estimate.rationale = "As per TRA class 2 (25%)";
    const r = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const q = payloadFor(A, compose.compositionSha256); q.classes[1].estimate.lifeYears = "per template";
    const r2 = await commit(q, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const codes = (r.problems ?? []).map((x) => `${x.code}:${x.class}`), codes2 = (r2.problems ?? []).map((x) => `${x.code}:${x.class}`);
    return codes.includes("ESTIMATE_NOT_ENTITY_SPECIFIC:Motor vehicles") && codes2.includes("ESTIMATE_INCOMPLETE:Motor vehicles") && (await unchanged()) ? true : { codes, codes2 };
  });
  group("Depreciation recalculated by the server");
  const sqlCharge = (item, start, end, convention) => db.one("SELECT public._fs_equipment_depreciation_charge($1::jsonb,$2::date,$3::date,$4) r", [JSON.stringify(item), start, end, convention]).then((x) => x.r);
  const baseItem = { label: "Machine", costMinor: "1200000", residualMinor: "0", openingAccumulatedMinor: "0", method: "straight-line", lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", availableFrom: "", derecognisedOn: "" };
  await kase("calc.sql-equals-typescript-fixtures", "the database's calculator gives the hand-calculated figures of src/lib/preparation/depreciation.test.ts: twelve-month, six-month, eighteen-month, leap, non-calendar, addition, disposal, reducing balance, units, cap, partial-month refusal", async () => {
    const expect = [
      [{}, "2026-01-01", "2026-12-31", "daily", "120000"], [{}, "2026-01-01", "2026-12-31", "full-period", "120000"],
      [{}, "2026-01-01", "2026-06-30", "daily", "59507"], [{}, "2026-01-01", "2026-06-30", "full-period", "60000"],
      [{}, "2026-01-01", "2027-06-30", "daily", "179507"], [{}, "2026-01-01", "2027-06-30", "full-period", "180000"],
      [{}, "2028-01-01", "2028-12-31", "daily", "120000"], [{ availableFrom: "2028-12-31" }, "2028-01-01", "2028-12-31", "daily", "328"],
      [{}, "2025-07-01", "2026-06-30", "daily", "120000"], [{}, "2027-07-01", "2028-06-30", "daily", "120000"], [{}, "2025-07-01", "2026-06-30", "full-period", "120000"],
      [{ availableFrom: "2026-04-01" }, "2026-01-01", "2026-06-30", "daily", "29918"], [{ availableFrom: "2026-04-01" }, "2026-01-01", "2026-06-30", "full-period", "60000"],
      [{ derecognisedOn: "2026-04-01" }, "2026-01-01", "2026-06-30", "daily", "29589"], [{ derecognisedOn: "2025-12-15" }, "2026-01-01", "2026-06-30", "full-period", "0"], [{ availableFrom: "2026-08-01" }, "2026-01-01", "2026-06-30", "full-period", "0"],
      [{}, "2026-01-01", "2026-06-15", "daily", "54575"],
      [{ costMinor: "1000000", method: "reducing-balance", ratePercent: "25" }, "2026-01-01", "2026-06-30", "daily", "123973"],
      [{ costMinor: "1000000", openingAccumulatedMinor: "250000", method: "reducing-balance", ratePercent: "25" }, "2026-01-01", "2026-12-31", "full-period", "187500"],
      [{ costMinor: "100001", method: "reducing-balance", ratePercent: "33.333" }, "2026-01-01", "2026-12-31", "full-period", "33333"],
      [{ costMinor: "800000", method: "units-of-production", totalUnits: "100000", unitsThisPeriod: "12000" }, "2026-01-01", "2026-06-15", "full-period", "96000"],
      [{ costMinor: "900000", residualMinor: "100000", lifeYears: "4", availableFrom: "2026-10-01" }, "2026-01-01", "2026-12-31", "daily", "50411"],
      [{ costMinor: "900000", residualMinor: "950000", lifeYears: "4" }, "2026-01-01", "2026-12-31", "full-period", "0"],
      [{ costMinor: "1000000", residualMinor: "100000", openingAccumulatedMinor: "850000" }, "2026-01-01", "2026-12-31", "full-period", "50000"],
      [{ costMinor: "365000", lifeYears: "1", derecognisedOn: "2026-04-01" }, "2026-01-01", "2026-12-31", "daily", "90000"],
    ];
    const got = [];
    for (const [over, s, e, conv, want] of expect) { const r = await sqlCharge({ ...baseItem, ...over }, s, e, conv); if (r.state !== "calculated" || r.chargeMinor !== want) got.push({ over, s, e, conv, want, r }); }
    const partial = await sqlCharge(baseItem, "2026-01-01", "2026-06-15", "full-period");
    const noLife = await sqlCharge({ ...baseItem, lifeYears: "" }, "2026-01-01", "2026-12-31", "daily");
    const badDate = await sqlCharge({ ...baseItem, availableFrom: "2026-02-30" }, "2026-01-01", "2026-12-31", "daily");
    return got.length === 0 && partial.state === "insufficient" && /whole months/.test(partial.missing.join()) && noLife.missing.join() === "useful life in years" && badDate.missing.join() === "available-for-use date" ? true : { got, partial, noLife, badDate };
  });
  await kase("commit.register-charge-mismatch-refused", "REVIEW FINDING: a direct RPC whose register charge (1,250) differs from the recorded depreciation (1,000) is refused by name (DEPRECIATION_CHARGE_MISMATCH, difference -25,000 minor) with nothing written; an explanation for a different amount is refused (CHARGE_DIFFERENCE_MISMATCH); the exact explained difference with evidence is accepted by the validator", async () => {
    const p = payloadFor(A, compose.compositionSha256);
    p.classes[0].movements = [dep("100000")]; p.classes[0].closing.accumulatedDepreciationMinor = "350000"; p.classes[0].closing.carryingMinor = "900000";
    p.classes[1].closing.carryingMinor = "500000"; p.classes[1].closing.accumulatedDepreciationMinor = "250000"; p.classes[1].movements = [dep("100000")]; // keeps the 14,000 total
    p.destinations = [{ target: "sci.operating_expenses_by_function", amountMinor: "200000", evidence: "Expense ledger 6200", explanation: "" }];
    const r1 = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const mm = (r1.problems ?? []).find((x) => x.code === "DEPRECIATION_CHARGE_MISMATCH" && x.class === "Equipment");
    p.classes[0].estimate.chargeDifference = { amountMinor: "-20000", explanation: "Register includes an item scrapped in January", evidence: "Register reconciliation R-3" };
    const r2 = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const cd = (r2.problems ?? []).find((x) => x.code === "CHARGE_DIFFERENCE_MISMATCH");
    p.classes[0].estimate.chargeDifference.amountMinor = "-25000";
    const r3 = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const vehiclesOnly = (r3.problems ?? []).filter((x) => x.class === "Equipment");
    return r1.outcome === "invalid_preparation" && mm?.scheduleMinor === "100000" && mm.chargeMinor === "125000" && mm.differenceMinor === "-25000"
      && r2.outcome === "invalid_preparation" && cd?.explainedMinor === "-20000" && cd.differenceMinor === "-25000"
      && r3.outcome === "invalid_preparation" && vehiclesOnly.length === 0 && (r3.problems ?? []).some((x) => x.code === "DEPRECIATION_CHARGE_MISMATCH" && x.class === "Motor vehicles")
      && (await unchanged()) ? true : { r1: r1.outcome, mm, r2: r2.outcome, cd, r3 };
  });
  await kase("commit.calculated-charge-tampering-refused", "REVIEW FINDING: a direct RPC declaring a calculated charge equal to the recorded depreciation (1,000) while its items compute 1,200 is refused (CHARGE_RECALCULATION_MISMATCH: declared 100,000, server 120,000) and the recorded depreciation itself is refused (DEPRECIATION_CHARGE_MISMATCH); an item that cannot be calculated is named (CHARGE_NOT_CALCULABLE); an honest 1,200 is accepted by the validator", async () => {
    const items = [{ ...baseItem, label: "Motor", costMinor: "400000", lifeYears: "5" }, { ...baseItem, label: "Frame", costMinor: "600000", lifeYears: "15" }];
    const p = payloadFor(A, compose.compositionSha256);
    p.classes[0].estimate = estimate({ chargeSource: "calculated", registerChargeMinor: "", registerReference: "", items, calculatedChargeMinor: "100000" });
    p.classes[0].movements = [dep("100000")]; p.classes[0].closing.accumulatedDepreciationMinor = "350000"; p.classes[0].closing.carryingMinor = "900000";
    p.classes[1].closing.carryingMinor = "500000"; p.classes[1].closing.accumulatedDepreciationMinor = "250000"; p.classes[1].movements = [dep("100000")]; p.classes[1].estimate.registerChargeMinor = "100000";
    p.destinations = [{ target: "sci.operating_expenses_by_function", amountMinor: "200000", evidence: "Expense ledger 6200", explanation: "" }];
    const r1 = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const rc = (r1.problems ?? []).find((x) => x.code === "CHARGE_RECALCULATION_MISMATCH");
    const dm = (r1.problems ?? []).find((x) => x.code === "DEPRECIATION_CHARGE_MISMATCH" && x.class === "Equipment");
    p.classes[0].estimate.items[0].lifeYears = "";
    const r2 = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    const nc = (r2.problems ?? []).find((x) => x.code === "CHARGE_NOT_CALCULABLE");
    p.classes[0].estimate.items[0].lifeYears = "5"; p.classes[0].estimate.calculatedChargeMinor = "120000"; p.classes[0].movements = [dep("120000")];
    p.classes[0].closing.accumulatedDepreciationMinor = "370000"; p.classes[0].closing.carryingMinor = "880000";
    p.classes[1].closing.carryingMinor = "520000"; p.classes[1].closing.accumulatedDepreciationMinor = "230000"; p.classes[1].movements = [dep("80000")]; p.classes[1].estimate.registerChargeMinor = "80000";
    const r3 = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId });
    return r1.outcome === "invalid_preparation" && rc?.declaredMinor === "100000" && rc.serverMinor === "120000" && dm?.chargeMinor === "120000"
      && r2.outcome === "invalid_preparation" && nc?.item === "Motor" && nc.missing.join() === "useful life in years"
      && r3.outcome === "recorded" && (await ctx()).schedule.rows[0].movements[0].amountMinor === "-120000" ? true : { r1: r1.outcome, rc, dm, r2: r2.outcome, nc, r3 };
  });
  // The honest commit above recorded a new workpaper and schedule; later cases expect the latest revisions (the
  // fixture's original schedule id stays available as a superseded revision).
  const afterCalc = await ctx();
  draftId = afterCalc.workpaper.id; scheduleId = afterCalc.schedule.id; counts.base = await counts();
  await kase("commit.unresolved-question-refuses-notes", "with reviewed notes attached, an unresolved mandatory question (impairment assessment) refuses the commit; without notes the same payload is a valid schedule-only save and is still refused for the missing answer", async () => {
    const c = await ctx();
    const p = payloadFor(A, compose.compositionSha256); delete p.entityAnswers.impairment;
    const r = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId, notes: notesFor(c, POLICY, ESTIMATES) });
    const codes = (r.problems ?? []).map((x) => `${x.code}:${x.questionId ?? ""}`);
    const q = payloadFor(A, compose.compositionSha256, { questions: { unresolved: [{ id: "lease", classId: VEHICLES_ID }] } });
    const r2 = await commit(q, { expectedWorkpaper: draftId, expectedSchedule: scheduleId, notes: notesFor(c, POLICY, ESTIMATES) });
    return r.outcome === "invalid_preparation" && codes.includes("QUESTION_UNRESOLVED:impairment") && r2.outcome === "invalid_preparation" && r2.problems.some((x) => x.code === "QUESTIONS_UNRESOLVED") && (await unchanged()) ? true : { r: r.outcome, codes, r2: r2.outcome };
  });

  group("The reviewed multi-class commit");
  let receipt, commitRequest, commitPayload, commitNotes;
  await kase("commit.multiclass-recorded-concurrently", "twelve simultaneous identical commits record ONE workpaper, ONE two-class schedule (Equipment kept, Motor vehicles added), seven answers and two notes; the server reconciles the schedule to the statements", async () => {
    const c = await ctx();
    commitRequest = uuid(); commitPayload = payloadFor(A, compose.compositionSha256); commitNotes = notesFor(c, POLICY, ESTIMATES);
    const results = await Promise.all(Array.from({ length: 12 }, () => commit(commitPayload, { expectedWorkpaper: draftId, expectedSchedule: scheduleId, notes: commitNotes, request: commitRequest })));
    receipt = results.find((r) => r.replay === false) ?? results[0];
    const after = await ctx();
    const rows = after.schedule.rows;
    const st = await ppeStatus();
    const ok = results.every((r) => r.outcome === "recorded" && r.workpaperId === receipt.workpaperId && r.schedule?.submissionId === receipt.schedule.submissionId)
      && results.filter((r) => r.replay === false).length === 1
      && rows.length === 2 && rows[0].classLabel === "Equipment" && rows[0].openingMinor === "1000000" && rows[0].closingMinor === "875000" && rows[0].movements[0].amountMinor === "-125000"
      && rows[1].classLabel === "Motor vehicles" && rows[1].closingMinor === "525000"
      && receipt.answersRecorded === 9 && after.answers.length === 9 && receipt.notes.length === 2 && receipt.notes.every((n) => n.outcome === "recorded")
      && st.status === "reconciled" && st.scheduleClosingMinor === "1400000" && st.scheduleOpeningMinor === "1600000"
      && (await db.count("SELECT count(*) n FROM public.fs_equipment_workpapers WHERE request_id=$1", [commitRequest])) === 1;
    return ok ? true : { results: results.map((r) => r.outcome), rows, receipt, st: st?.status };
  });
  await kase("commit.notes-whole-and-preserving", "the recorded policy and estimates notes are the WHOLE reviewed texts, keeping the existing wording, with the workpaper as their source; the subclassifications note is untouched", async () => {
    const c = await ctx();
    const okPolicy = c.notes["smes.note.policies"].body.startsWith("Historical cost.") && c.notes["smes.note.policies"].body.includes(POLICY) && c.notes["smes.note.policies"].sourceRef === `Reviewed equipment workpaper ${receipt.workpaperId}`;
    const okEst = c.notes["smes.note.estimates"].body.startsWith("Useful lives.") && c.notes["smes.note.estimates"].body.includes(ESTIMATES);
    return okPolicy && okEst && c.notes["smes.note.subclassifications"].body === "All receivables from third parties." ? true : c.notes;
  });
  await kase("commit.replay-returns-receipt", "the same request repeated (a lost response) returns the original receipt as a replay and writes nothing", async () => {
    const before = await counts();
    const r = await commit(commitPayload, { expectedWorkpaper: draftId, expectedSchedule: scheduleId, notes: commitNotes, request: commitRequest });
    return r.outcome === "recorded" && r.replay === true && r.workpaperId === receipt.workpaperId && r.schedule.submissionId === receipt.schedule.submissionId && r.notes.length === 2 && r.answersRecorded === 9 && (await counts()) === before ? true : r;
  });
  await kase("commit.changed-intent-refused", "the same request with a different payload is refused (request_reused)", async () => {
    const p = { ...commitPayload, destinations: [...commitPayload.destinations, { target: "other", amountMinor: "0", evidence: "x y z", explanation: "nothing" }] };
    return (await commit(p, { expectedWorkpaper: draftId, expectedSchedule: scheduleId, notes: commitNotes, request: commitRequest })).outcome === "request_reused" ? true : "accepted";
  });
  await kase("commit.zero-effect-review-retained", "an explicit evidenced zero-effect cleanup decision is retained by the real atomic server commit and replay, without dropping classes or changing their reconciled figures", async () => {
    const c = await ctx();
    const review = excludeReviewedZeroMovements(classFromScheduleRow({ classLabel: "Equipment", openingMinor: "1000000", closingMinor: "875000", movements: [{kind:"depreciation", amountMinor:"-125000"}, {kind:"disposals", amountMinor:"0"}] }, 2), 2,
      "Synthetic test reviewer", "SYNTHETIC disposal log: no such events").answers.zero_effect_row_review;
    const p = payloadFor(A, compose.compositionSha256); p.classes[0].answers.zero_effect_row_review = review;
    const request = uuid();
    const opts = { expectedWorkpaper: c.workpaper.id, expectedSchedule: c.schedule.id, request };
    const r = await commit(p, opts); const again = await commit(p, opts); const after = await ctx();
    const fact = after.answers.find(x => x.questionId === "zero_effect_row_review" && x.classKey === EQUIPMENT_ID);
    return r.outcome === "recorded" && r.answersRecorded === 10 && again.replay === true && again.workpaperId === r.workpaperId
      && fact?.workpaperId === r.workpaperId && isDeepStrictEqual(fact.answer, review)
      && after.schedule.rows.length === 2 && (await ppeStatus()).status === "reconciled" ? true : {r,again,fact};
  });
  await kase("commit.stale-workpaper-schedule-note-refused", "a commit against the superseded workpaper, schedule or note revision is refused by name with nothing written", async () => {
    const c = await ctx(); const before = await counts();
    const p = payloadFor(A, compose.compositionSha256);
    const r1 = await commit(p, { expectedWorkpaper: draftId, expectedSchedule: c.schedule.id });
    const r2 = await commit(p, { expectedWorkpaper: c.workpaper.id, expectedSchedule: scheduleId0 });
    const r3 = await commit(p, { expectedWorkpaper: c.workpaper.id, expectedSchedule: c.schedule.id, notes: [{ requirementId: "smes.note.policies", expectedTextId: base.notes["smes.note.policies"].id, body: "Would overwrite another writer." }] });
    return r1.outcome === "stale" && r1.currentId === c.workpaper.id && r2.outcome === "stale_schedule" && r2.currentId === c.schedule.id && r3.outcome === "stale_note" && r3.requirementId === "smes.note.policies" && (await counts()) === before ? true : { r1: r1.outcome, r2: r2.outcome, r3: r3.outcome };
  });
  await kase("commit.disposal-gain-and-capitalised-depreciation", "a vehicle disposed of (cost 1,500 / acc dep 600 / proceeds 1,000 → gain 100), a replacement addition and depreciation partly capitalised into inventories reconcile through cost and accumulated depreciation; the schedule records both classes", async () => {
    const c = await ctx();
    // Motor vehicles: 6,000 + 1,500 − 900 − 1,350 = 5,250; gross 7,500 + 1,500 − 1,500 = 7,500; acc dep 1,500 + 1,350 − 600 = 2,250.
    const vehicles = cls(VEHICLES_ID, "Motor vehicles", "1500 (vehicle items), 1510", ["750000", "150000", "600000"], ["750000", "225000", "525000"],
      [{ kind: "additions", grossMinor: "150000", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", source: src("Invoice V-2026-07"), note: "" },
       { kind: "disposals", grossMinor: "-150000", accumulatedDepreciationMinor: "-60000", accumulatedImpairmentMinor: "0", source: src("Disposal register D-3"), note: "" },
       dep("135000")], { registerChargeMinor: "135000" },
      [{ reference: "Pickup T-7", date: "2026-03-31", costMinor: "150000", accumulatedDepreciationMinor: "60000", accumulatedImpairmentMinor: "0", proceedsMinor: "100000", source: src("Sale agreement S-7 and bank receipt") }]);
    vehicles.answers.addition_cost = answered("Price and delivery; ready for use 1 July 2026", {});
    const p = payloadFor(A, compose.compositionSha256, { classes: [equipmentClass(), vehicles], destinations: [
      { target: "sci.operating_expenses_by_function", amountMinor: "200000", evidence: "Expense ledger 6200", explanation: "" },
      { target: "capitalised_inventories", amountMinor: "60000", evidence: "Production overhead absorption working W-4", explanation: "" }] });
    const r = await commit(p, { expectedWorkpaper: c.workpaper.id, expectedSchedule: c.schedule.id });
    const after = await ctx();
    const v = after.schedule?.rows?.find((x) => x.classLabel === "Motor vehicles");
    return r.outcome === "recorded" && r.schedule.outcome === "recorded" && v && JSON.stringify(v.movements) === JSON.stringify([{ kind: "additions", amountMinor: "150000" }, { kind: "disposals", amountMinor: "-90000" }, { kind: "depreciation", amountMinor: "-135000" }])
      && after.schedule.rows.length === 2 && (await ppeStatus()).status === "reconciled" && r.notes.length === 0 ? true : { r, v };
  });
  await kase("commit.retire-class-with-reason", "a recorded class may be retired only with a reason and evidence; the retirement is refused without them", async () => {
    const c = await ctx();
    // Everything in Equipment: 16,000 → 14,000 (gross 20,000 / acc dep 4,000 → 6,000), the vehicles retired with a reason.
    const all = cls(EQUIPMENT_ID, "Equipment", "1500, 1510", ["2000000", "400000", "1600000"], ["2000000", "600000", "1400000"], [dep("200000")], { registerChargeMinor: "200000" });
    const bad = payloadFor(A, compose.compositionSha256, { classes: [all], retiredClasses: [{ label: "Motor vehicles", reason: "", evidence: "" }] });
    const r1 = await commit(bad, { expectedWorkpaper: c.workpaper.id, expectedSchedule: c.schedule.id });
    const good = payloadFor(A, compose.compositionSha256, { classes: [all], retiredClasses: [{ label: "Motor vehicles", reason: "Vehicles reclassified into Equipment per the reviewed register", evidence: "Register reclassification memo R-9" }] });
    const r2 = await commit(good, { expectedWorkpaper: c.workpaper.id, expectedSchedule: c.schedule.id });
    const after = await ctx();
    return r1.outcome === "invalid_preparation" && r1.problems.some((x) => x.code === "RETIREMENT_MALFORMED") && r2.outcome === "recorded" && after.schedule.rows.length === 1 && after.schedule.rows[0].classLabel === "Equipment" && (await ppeStatus()).status === "reconciled" ? true : { r1: r1.outcome, r2: r2.outcome };
  });

  group("Facts, history and access");
  await kase("answers.reused-next-period", "the answers recorded for 2026 are offered to the 2027 preparation as prior answers (entity and class level), latest revision per question", async () => {
    const next = await ctx(U.preparer, A, 2027);
    const prior = next.priorAnswers;
    const imp = prior.find((a) => a.questionId === "impairment" && a.classKey === null);
    const rec = prior.find((a) => a.questionId === "recognition" && a.classKey === EQUIPMENT_ID);
    const n = await db.count("SELECT count(DISTINCT (coalesce(class_key,''), question_id)) n FROM public.fs_equipment_answers WHERE company_id=$1 AND period_year=2026", [A]);
    return next.outcome === "available" && next.answers.length === 0 && prior.length === n && imp?.status === "answered" && imp.answer.flags.indicator_present === false && rec?.classLabel === "Equipment" ? true : { n, prior: prior.length, imp, rec };
  });
  await kase("history.append-only-and-api-roles", "answers cannot be updated, deleted or truncated even by the table owner; anon and service_role cannot call the context or the commit; authenticated cannot call the internal validator", async () => {
    const refusals = [];
    for (const sql of ["UPDATE public.fs_equipment_answers SET status='answered'", "DELETE FROM public.fs_equipment_answers", "TRUNCATE public.fs_equipment_answers"]) {
      try { await admin.query(sql); refusals.push(`${sql.split(" ")[0]}:allowed`); } catch (e) { refusals.push(`${sql.split(" ")[0]}:${e.code}`); }
    }
    for (const role of ["anon", "service_role"]) {
      try { await db.asRole(role, null, "SELECT public.fs_equipment_context_v2($1,2026)", [A]); refusals.push(`${role}:ctx:allowed`); } catch (e) { refusals.push(`${role}:ctx:${e.code}`); }
      try { await db.asRole(role, null, "SELECT public.fs_commit_equipment_preparation_v2($1,2026,'{}'::jsonb,NULL,NULL,NULL,'[]'::jsonb,$2)", [A, uuid()]); refusals.push(`${role}:commit:allowed`); } catch (e) { refusals.push(`${role}:commit:${e.code}`); }
    }
    try { await db.asRole("authenticated", U.preparer, "SELECT public._fs_equipment_v2_problems('{}'::jsonb,'[]'::jsonb,'{}'::jsonb,false,NULL,NULL)", []); refusals.push("validator:allowed"); } catch (e) { refusals.push(`validator:${e.code}`); }
    return refusals.every((r) => r.endsWith(":42501")) ? true : refusals;
  });
  await kase("history.earlier-records-preserved", "every schedule submission and disclosure text that existed before the preparation is byte-identical afterwards (append-only history; the first class record is still there)", async () => {
    const earlier = hex(JSON.stringify([
      (await admin.query("SELECT to_jsonb(t)::text j FROM public.fs_schedule_submissions t WHERE t.id = $1", [scheduleId0])).rows,
      (await admin.query("SELECT to_jsonb(t)::text j FROM public.fs_disclosure_texts t WHERE t.id = ANY($1::uuid[])", [[base.notes["smes.note.policies"].id, base.notes["smes.note.estimates"].id, base.notes["smes.note.subclassifications"].id]])).rows,
    ]));
    const beforeRows = hex(JSON.stringify([
      (await admin.query("SELECT to_jsonb(t)::text j FROM public.fs_schedule_submissions t WHERE t.id = $1", [scheduleId0])).rows,
      (await admin.query("SELECT to_jsonb(t)::text j FROM public.fs_disclosure_texts t WHERE t.id = ANY($1::uuid[])", [[base.notes["smes.note.policies"].id, base.notes["smes.note.estimates"].id, base.notes["smes.note.subclassifications"].id]])).rows,
    ]));
    const first = await db.one("SELECT rows FROM public.fs_schedule_submissions WHERE id=$1", [scheduleId0]);
    const totalSubs = await db.count("SELECT count(*) n FROM public.fs_schedule_submissions WHERE company_id=$1 AND schedule_id='ppe'", [A]);
    // fixture + the honest calculated-charge commit + the multi-class commit + the disposal commit + the retirement = 5 submissions.
    return earlier === beforeRows && first.rows.length === 1 && first.rows[0].closingMinor === "1400000" && totalSubs === 5 ? true : { totalSubs, first: first.rows };
  });

  group("Issued history");
  let finalLineage, finalSnap;
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const parse = (type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type], fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${JSON.stringify(r).slice(0, 300)}`);
    return r.batch;
  };
  const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
  const finalState = async (rid) => hex(JSON.stringify([
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.financial_statement_publications t WHERE report_id=$1 ORDER BY 1", [rid])).rows,
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.fs_publication_bindings t WHERE report_id=$1 ORDER BY 1", [rid])).rows,
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.financial_statement_reports t WHERE report_id=$1 ORDER BY 1", [rid])).rows,
  ]));
  await kase("issued.final-untouched-by-later-preparation", "a version saved on the current preparation is REVIEWED and FINAL; a later equipment preparation (a changed class estimate) is recorded as new history and the FINAL's publication, binding and report rows are byte-identical; the FINAL version is no longer current for the changed dependencies", async () => {
    const rid = `rpt-eq-${uuid()}`;
    const saved = await prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence: allEvidence(), idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
    if (saved.outcome !== "saved") return saved;
    const rd = await partner.c.readiness(A, rid, saved.reportVersion);
    if (!rd.ready) return { blockers: rd.blockers };
    const rv = await partner.c.setState(A, rid, saved.reportVersion, "REVIEWED", "Reviewed the equipment preparation");
    const f = await owner.c.setState(A, rid, saved.reportVersion, "FINAL", "Approved for issue");
    finalLineage = { rid, v: saved.reportVersion }; finalSnap = await finalState(rid);
    const c = await ctx();
    const all = cls(EQUIPMENT_ID, "Equipment", "1500, 1510", ["2000000", "400000", "1600000"], ["2000000", "600000", "1400000"], [dep("200000")], { registerChargeMinor: "200000", lifeYears: "8", rationale: "Expected eight years after the usage review" });
    const r = await commit(payloadFor(A, compose.compositionSha256, { classes: [all] }), { expectedWorkpaper: c.workpaper.id, expectedSchedule: c.schedule.id, notes: notesFor(c, "Equipment is depreciated straight-line over 8 years.", "Useful life of equipment revised to 8 years.") });
    const deps = await pre.c.dependencies(A, Y);
    const report = await db.one("SELECT report_document#>>'{reportingDependencies,dependenciesSha256}' d FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=$2", [rid, saved.reportVersion]);
    return rv.state === "REVIEWED" && f.state === "FINAL" && r.outcome === "recorded" && (await finalState(rid)) === finalSnap && deps.dependenciesSha256 !== report.d ? true : { rv: rv.state, f: f.state, r: r.outcome, same: (await finalState(rid)) === finalSnap, depsChanged: deps.dependenciesSha256 !== report.d };
  });
  await kase("access.revoked-preparer-refused", "a preparer whose membership is withdrawn reads no context and commits nothing", async () => {
    await admin.query("UPDATE public.firm_members SET accepted_at=NULL WHERE company_id=$1 AND user_id=$2", [A, U.preparer]);
    const before = await counts();
    const c = await ctx();
    const r = await commit(payloadFor(A, compose.compositionSha256));
    return c.outcome === "forbidden" && r.outcome === "forbidden" && (await counts()) === before ? true : { c: c.outcome, r: r.outcome };
  });
}

let crashed = false, crashMessage = null;
try { await main(); } catch (e) { crashed = true; crashMessage = `${e.code ?? ""}:${String(e?.stack ?? e).slice(0, 2000)}`; console.error(e.stack ?? e); }
writeResult(!crashed, crashed, crashMessage);
const ok = finish("EQUIPMENT_MULTICLASS", crashed);
await db?.close();
process.exit(ok ? 0 : 1);
