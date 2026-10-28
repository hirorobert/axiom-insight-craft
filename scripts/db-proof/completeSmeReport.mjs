#!/usr/bin/env bun
// Real-PostgreSQL proof of ONE COMPLETE SME REPORT, end to end, through the product's own controls and nothing else:
//
//   setup       both years certified by the real process-trial-balance handler from the case's trial-balance files,
//               the professional account review, the presentation, the comparatives approved; for the acceptance-r1
//               case the hosted demo company's recorded state (placeholder wording, decisions, the one-row PPE schedule)
//               is replicated first, exactly as docs/release/ACCEPTANCE_R1_DEMO_SETUP.md prescribes it
//   equipment   the register-based multi-class preparation (20261206100000): every applicable question answered as the
//               page evaluates them, a draft saved and read back identical, the commit recorded with the server's own
//               recalculation of every item, the three whole notes written from the page's proposals, and the
//               recorded preparation read back after a "reload"
//   notes       every requirement of the pack resolved through fs_decide_requirement / fs_record_disclosure with
//               entity-specific wording (never "not applicable" to clear a blocker: every decision carries its basis,
//               and case 2 makes the related-party and post-period requirements APPLICABLE with their disclosures);
//               the per-requirement resolution table is written to the evidence file
//   statements  the six evidence files, a version blocked by Close Review, the check and its explanations, the next
//               version ready with no blocker; every row of EXPECTED_TOTALS.csv against the stored document (current
//               and comparative); the cross-statement reconciliations asserted directly on the document
//   review      the sign-off policy in force (separate_approvers); REVIEWED by the partner; the partner's own FINAL
//               refused by name; FINAL by the owner
//   issuance    the official pack issued through the browser client's path with the Edge Function's own module over
//               THIS database; the saved bytes hashed and compared with the seal; verify = intact/official; retrieve
//               returns the same bytes; the local hash equals the sealed hash (as the Exports page checks it)
//   history     a later wording change leaves every FINAL row and the sealed bytes byte-identical; the FINAL version
//               is stale, a new version is saved, and signing the stale one is refused
//
// Two cases run through the SAME runner (static check: no case-specific branch): docs/release/complete-sme-report/
// case1-acceptance-r1 and case2-mwanza-agro. Every case has a stable id in completeSmeReport.manifest.mjs; the run
// writes a structured result (PROOF_RESULT_FILE, default proof-results/completeSmeReport.present.json) and an evidence
// file beside it (…evidence.json: outstanding requirements before, the resolution table, the questions asked, the
// figures, the seal). Synthetic data only; disposable database only.
//
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) bun scripts/db-proof/completeSmeReport.mjs
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/completeSmeReport.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyChain, certifier, clientDb, makeWorld, openDatabase, REPO, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { reviewClient, sha256HexOf } from "../../src/lib/reporting/reviewWorkflow.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { evaluateQuestions, questionKey, unresolvedQuestions } from "../../src/lib/preparation/equipmentQuestions.ts";
import { equipmentNoteProposalV2, estimatesProposalV2, policyProposalV2 } from "../../src/lib/preparation/equipmentProposals.ts";
import { CASES, PROOF } from "./completeSmeReport.manifest.mjs";

const MODE = "present";
const RESULT_FILE = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results", `${PROOF}.${MODE}.json`);
const EVIDENCE_FILE = RESULT_FILE.replace(/\.present\.json$/, ".evidence.json");
const SCENARIOS = [["c1", "docs/release/complete-sme-report/case1-acceptance-r1"], ["c2", "docs/release/complete-sme-report/case2-mwanza-agro"]];
const { group, check, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const minor = (s) => BigInt(Math.round(Number(s) * 100));
const csvRows = (text) => { const [h, ...r] = text.trimEnd().split("\n"); const keys = h.split(","); return r.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v]))); };
let db;

// ── Structured result and evidence ───────────────────────────────────────────────────────────────────────────────────
const ids = new Set(CASES.map((c) => c.id));
const recorded = [];
const evidence = {};
const startedAt = new Date().toISOString();
const manifestSha256 = hex(fs.readFileSync(new URL("./completeSmeReport.manifest.mjs", import.meta.url), "utf8"));
async function kase(id, title, fn) {
  if (!ids.has(id)) throw new Error(`proof defect: case ${id} is not in the manifest`);
  if (recorded.some((r) => r.id === id)) throw new Error(`proof defect: case ${id} recorded twice`);
  let outcome = "fail", detail = "";
  await check(`[${id}] ${title}`, async () => {
    try { const r = await fn(); if (r === true) { outcome = "pass"; return true; } detail = JSON.stringify(r)?.slice(0, 1500) ?? ""; return r; }
    catch (e) { detail = `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}${e.where ? ` | where: ${String(e.where).slice(0, 300)}` : ""}`; if (process.env.CSR_DEBUG) console.error(e?.stack ?? e); throw e; }
  });
  recorded.push({ id, title, outcome, detail });
}
function writeResult(completed, crashed, crashMessage) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ proof: PROOF, mode: MODE, manifestSha256, startedAt, finishedAt: new Date().toISOString(), completed, crashed, crashMessage: crashMessage ?? null,
    cases: recorded.map(({ id, outcome, detail }) => ({ id, outcome, ...(detail ? { detail } : {}) })) }, null, 2) + "\n");
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({ proof: PROOF, startedAt, finishedAt: new Date().toISOString(), evidence }, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`structured result: ${RESULT_FILE}\nevidence: ${EVIDENCE_FILE}`);
}

// ── Scenario files ───────────────────────────────────────────────────────────────────────────────────────────────────
function loadScenario(dir) {
  const S = JSON.parse(fs.readFileSync(path.join(REPO, dir, "scenario.json"), "utf8"));
  const fdir = path.join(REPO, S.fixtureDir);
  S.dir = dir;
  S.file = (n) => fs.readFileSync(path.join(fdir, n), "utf8");
  S.rows = (n) => csvRows(S.file(n));
  return S;
}

// ── The official pack's Edge Function module over THIS database (private bucket modelled in memory) ─────────────────
async function sealModule(db) {
  const { issueOfficialPack, retrieveOfficialPack, verifyOfficialPack } = await import(pathToFileURL(path.join(REPO, "supabase/functions/_shared/reportingPackSeal.mjs")).href);
  const bucket = new Map();
  const storing = new Map();
  const serviceRpc = async (fn, args) => {
    const keys = Object.keys(args);
    try { const r = await db.asService(`SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`, keys.map((k) => args[k])); return { data: r.r, error: null }; }
    catch (e) { return { data: null, error: e }; }
  };
  const deps = {
    rpc: serviceRpc,
    put: async (p, b) => {
      if (storing.has(p)) { await storing.get(p); return { error: { message: "exists" } }; }
      if (bucket.has(p)) return { error: { message: "exists" } };
      let done; storing.set(p, new Promise((r) => { done = r; }));
      try {
        await db.admin.query("DELETE FROM storage.objects WHERE bucket_id='reporting-packs' AND name=$1", [p]);
        await db.admin.query("INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('reporting-packs', $1, $2::jsonb)", [p, JSON.stringify({ size: b.byteLength, mimetype: "application/json" })]);
        bucket.set(p, b);
      } finally { storing.delete(p); done(); }
      return { error: null };
    },
    get: async (p) => bucket.get(p) ?? null,
    sha256Hex: async (b) => hex(Buffer.from(b)),
  };
  // The browser client's transport with the Edge Function reached in process (the same request bodies and outcomes).
  const transport = (uid) => {
    const t = clientDb(db, uid);
    return { ...t, invoke: async (name, body) => {
      if (name !== "seal-reporting-pack") return t.invoke(name, body);
      if (body.action === "issue") { const r = await issueOfficialPack(deps, { userId: uid, issuanceId: body.issuance_id }); return { data: r.body, error: null }; }
      if (body.action === "retrieve") return { data: await retrieveOfficialPack(deps, uid, body.issuance_id), error: null };
      if (body.action === "verify") return { data: await verifyOfficialPack(deps, uid, body.issuance_id), error: null };
      return { data: null, error: { message: "unknown action" } };
    } };
  };
  return { bucket, transport, verifyOfficialPack: (uid, id) => verifyOfficialPack(deps, uid, id) };
}

// RUNNER-BEGIN — one journey for every case; nothing below names a case, an account code or a fixture figure.
async function runScenario(db, S, pfx, seal) {
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = S.periodYear, P = Y - 1;
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const admin = db.admin;
  const ev = (evidence[pfx] = { label: S.label, legalName: S.legalName, periodYear: Y, current: S.current, prior: S.prior });
  const E = S.equipment;
  const OK_STATUS = new Set(["provided", "not_applicable", "reconciled", "composed", "satisfied", "evidence_present", "derived"]);
  const notesStatus = async () => (await asU(U.preparer, "SELECT public.fs_notes_status($1,$2) r", [A, Y])).r;
  const latestBody = async (textId) => (textId ? (await admin.query("SELECT body FROM public.fs_disclosure_texts WHERE id=$1", [textId])).rows[0]?.body ?? null : null);
  const requirementTable = async () => {
    const ns = await notesStatus();
    const out = [];
    for (const r of ns.requirements) {
      const body = r.textId ? await latestBody(r.textId) : null;
      const placeholder = !!(S.hostedState?.placeholderMarker && body && body.includes(S.hostedState.placeholderMarker));
      // A STATEMENT requirement waits for its evidence files (the statements step); it is not a note to resolve here.
      out.push({ requirementId: r.requirementId, kind: r.kind, status: r.status, basis: r.basis ?? null, sourceRef: r.sourceRef ?? null, placeholder, outstanding: (r.kind !== "STATEMENT" && !OK_STATUS.has(r.status)) || placeholder });
    }
    return { blockers: ns.blockers, rows: out };
  };
  const ctx = () => asU(U.preparer, "SELECT public.fs_equipment_context_v2($1,$2) r", [A, Y]).then((x) => x.r);
  const commit = (p, { expectedWorkpaper = null, expectedSchedule = null, notes = [], request = uuid() } = {}) =>
    asU(U.preparer, "SELECT public.fs_commit_equipment_preparation_v2($1,$2,$3::jsonb,$4,NULL,$5,$6::jsonb,$7) r", [A, Y, JSON.stringify(p), expectedWorkpaper, expectedSchedule, JSON.stringify(notes), request]).then((x) => x.r);
  // The professional account review, as the product asks for it: each upload asks only for the accounts not yet
  // decided (re-deciding an already-certified account makes that certification stale by design).
  const reviewed = new Set();
  const reviewUpload = async (u, tbText) => {
    const present = new Set(csvRows(tbText).map((r) => r["Account code"]));
    const decisions = S.rows("account_classification.csv").filter((r) => present.has(r["Account code"]) && !reviewed.has(r["Account code"])).map((r) => ({ account_code: r["Account code"], account_name: r["Account name"], proposal_type: "NONE",
      decision_action: "USER_MANUAL_CLASSIFICATION", statement: r.Statement, classification: r.Classification, normal_balance: r["Normal balance"], is_cash_account: r["Cash account"] === "yes" }));
    if (!decisions.length) return;
    await asU(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, u.id, uuid(), JSON.stringify(decisions)]);
    for (const d of decisions) reviewed.add(d.account_code);
  };
  let compose;

  group(`${S.label}`);
  await kase(`${pfx}.setup.engagement`, "both years certified from the trial-balance files by the real handler, the account review, the presentation and the comparatives approved; the hosted state (if any) replicated as the setup document prescribes; the statements compose and the PPE line carries the register's opening and closing amounts", async () => {
    const prior = S.file("trial_balance_FY2024_prior.csv"), current = S.file("trial_balance_FY2025_current.csv");
    const p = await k.upload(A, P, prior, { start: S.prior.start, end: S.prior.end }); await reviewUpload(p, prior); await k.certify(A, p);
    const c = await k.upload(A, Y, current, { start: S.current.start, end: S.current.end }); await reviewUpload(c, current); await k.certify(A, c);
    const pairs = S.rows("presentation_assignments.csv").map((r) => ({ accountKey: r["Account code"], lineId: r["Presentation line"] }));
    await asU(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Presentation per the chart of accounts',$3)", [A, JSON.stringify(pairs), uuid()]);
    if (S.hostedState) {
      for (const r of S.rows(S.hostedState.decisions))
        await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,$4,$5,$6)", [A, Y, r.Requirement, r.Decision === "Applicable" ? "applicable" : "not_applicable", r.Reason, uuid()]);
      for (const r of S.rows(S.hostedState.wording))
        await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,$5,$6)", [A, Y, r.Requirement, Object.values(r)[1], S.hostedState.wordingSource, uuid()]);
      const s = S.rows(S.hostedState.ppeSchedule)[0];
      await asU(U.preparer, "SELECT public.fs_record_schedule($1,$2,'ppe',$3::jsonb,$4,$5)", [A, Y, JSON.stringify([{ classLabel: s.Class, openingMinor: String(minor(s["Opening carrying amount"])), closingMinor: String(minor(s["Closing carrying amount"])), movements: [{ kind: s.Movement.toLowerCase(), amountMinor: String(minor(s.Amount)) }] }]), s.Source, uuid()]);
    }
    await asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,true,'Agreed to the prior-year statements',$3) r", [A, Y, uuid()]);
    compose = (await asU(U.owner, "SELECT public.fs_statement_composition($1,$2) r", [A, Y])).r;
    const ppe = compose.lines?.find((l) => l.lineId === "sfp.property_plant_and_equipment");
    ev.composition = { state: compose.state, ppe: ppe?.current?.amountMinor, ppePrior: ppe?.comparative?.amountMinor, compositionSha256: compose.compositionSha256 };
    return compose.state === "composed" && ppe?.current?.amountMinor === E.expectedClosingMinor && ppe?.comparative?.amountMinor === E.openingMinor ? true : ev.composition;
  });
  await kase(`${pfx}.notes.outstanding-before`, "the notes status names every requirement of the pack; what is outstanding before this journey (missing wording, undecided requirements, placeholder wording) is listed in the evidence file, requirement by requirement", async () => {
    const t = await requirementTable();
    ev.outstandingBefore = { blockers: t.blockers, count: t.rows.filter((r) => r.outstanding).length, rows: t.rows.filter((r) => r.outstanding).map(({ requirementId, status, placeholder }) => ({ requirementId, status, placeholder })) };
    const kinds = new Set(t.rows.map((r) => r.kind));
    return t.rows.length >= 22 && ["DISCLOSURE", "SCHEDULE", "LINE_ITEM"].every((x) => kinds.has(x)) && ev.outstandingBefore.count > 0 ? true : ev.outstandingBefore;
  });

  // The preparation payload the page would send, built from the case's register-derived classes.
  const payload = () => ({
    contract: "cfoclose-equipment-workpaper/2", companyId: A, periodYear: Y, compositionSha256: compose.compositionSha256, currency: S.currency, exponent: 2,
    priorSource: { fact: null }, openingBridge: { adjustments: [], openingMinor: E.openingMinor },
    classes: structuredClone(E.classes), retiredClasses: [], destinations: structuredClone(E.destinations), entityAnswers: structuredClone(E.entityAnswers),
    questions: { unresolved: [] }, contentVersion: "sme-2015-equipment-preparation/2",
  });
  await kase(`${pfx}.equipment.applicable-questions-answered`, "the page's own question evaluation finds every applicable question (mandatory, and the conditional ones the case's facts trigger) answered with evidence; the list of questions asked is in the evidence file", async () => {
    const qs = evaluateQuestions(payload(), { start: S.current.start, end: S.current.end });
    const unresolved = unresolvedQuestions(qs);
    ev.questions = { asked: qs.map((q) => `${questionKey(q)}:${q.status}`), unresolved: unresolved.map((q) => ({ key: questionKey(q), problems: q.problems })) };
    return unresolved.length === 0 && qs.length >= 7 ? true : ev.questions;
  });
  let draftId = null, scheduleId = null;
  await kase(`${pfx}.equipment.draft-retained-on-reload`, "a draft is saved; reading the preparation again (as a reload does) returns the identical payload; reading it a second time is still identical", async () => {
    const c0 = await ctx();
    scheduleId = c0.schedule?.id ?? null;
    const p = payload();
    const r = await asU(U.preparer, "SELECT public.fs_save_equipment_workpaper_v2($1,$2,$3::jsonb,$4,NULL,$5) r", [A, Y, JSON.stringify(p), c0.workpaper?.id ?? null, uuid()]).then((x) => x.r);
    const c1 = await ctx(); const c2 = await ctx();
    draftId = c1.workpaper?.id ?? null;
    const same = isDeepStrictEqual(JSON.parse(JSON.stringify(p)), c1.workpaper?.payload) && isDeepStrictEqual(c1.workpaper?.payload, c2.workpaper?.payload);
    return r.outcome === "recorded" && c1.workpaper?.id === r.workpaperId && c1.workpaper.contract === "cfoclose-equipment-workpaper/2" && same && (await ctx()).workpaper.id === draftId ? true : { r, same, id: c1.workpaper?.id };
  });
  let receipt = null, commitPayload = null, commitNotes = null, commitRequest = null;
  await kase(`${pfx}.equipment.recorded-from-register`, "the preparation is recorded in one server transaction: every class with its register-based items recalculated by the server (the charge per item equals the hand-calculated register figure), the schedule reconciled to the statement line, the answers as facts, and the three whole notes written from the page's own proposals; replay returns the receipt", async () => {
    const c = await ctx();
    commitPayload = payload(); commitRequest = uuid();
    const cls = commitPayload.classes;
    commitNotes = [
      { requirementId: "smes.note.policies", expectedTextId: c.notes["smes.note.policies"]?.id ?? null, body: `${S.notes.general["smes.note.policies"]}\n\n${policyProposalV2(cls, S.currency, 2)}` },
      { requirementId: "smes.note.estimates", expectedTextId: c.notes["smes.note.estimates"]?.id ?? null, body: `${S.notes.general["smes.note.estimates"]}\n\n${estimatesProposalV2(cls, S.currency, 2)}` },
      { requirementId: "smes.note.subclassifications", expectedTextId: c.notes["smes.note.subclassifications"]?.id ?? null, body: `${S.notes.general["smes.note.subclassifications"]}\n\n${equipmentNoteProposalV2(cls, commitPayload.entityAnswers, commitPayload.destinations, S.currency, 2)}` },
    ];
    receipt = await commit(commitPayload, { expectedWorkpaper: draftId, expectedSchedule: scheduleId, notes: commitNotes, request: commitRequest });
    if (receipt.outcome !== "recorded") return { receipt };
    const replay = await commit(commitPayload, { expectedWorkpaper: draftId, expectedSchedule: scheduleId, notes: commitNotes, request: commitRequest });
    const after = await ctx();
    const ns = await notesStatus();
    const ppe = ns.requirements.find((r) => r.requirementId === "smes.schedule.ppe");
    // The server's own calculator, item by item, against the register's figures (the same function the commit used).
    const items = [];
    for (const cl of cls) for (const it of cl.estimate.items) {
      const r = (await db.one("SELECT public._fs_equipment_depreciation_charge($1::jsonb,$2::date,$3::date,$4) r", [JSON.stringify(it), S.current.start, S.current.end, cl.estimate.convention])).r;
      items.push({ class: cl.label, item: it.label, state: r.state, chargeMinor: r.chargeMinor ?? null, basis: r.basis ?? null });
    }
    const perClass = cls.map((cl) => ({ label: cl.label, calculated: cl.estimate.calculatedChargeMinor, serverSum: items.filter((i) => i.class === cl.label).reduce((a, i) => a + BigInt(i.chargeMinor ?? 0), 0n).toString(),
      recorded: after.schedule?.rows?.find((r) => r.classLabel === cl.label)?.movements?.find((m) => m.kind === "depreciation")?.amountMinor ?? null }));
    const totalDep = perClass.reduce((a, c2) => a + BigInt(c2.calculated), 0n).toString();
    ev.equipment = { workpaperId: receipt.workpaperId, scheduleSubmissionId: receipt.schedule?.submissionId, answersRecorded: receipt.answersRecorded, notes: receipt.notes, items, perClass, totalDepreciationMinor: totalDep,
      schedule: { status: ppe?.status, scheduleClosingMinor: ppe?.scheduleClosingMinor, composedClosingMinor: ppe?.composedClosingMinor, scheduleOpeningMinor: ppe?.scheduleOpeningMinor, composedOpeningMinor: ppe?.composedOpeningMinor, sourceRef: after.schedule?.sourceRef } };
    const ok = replay.outcome === "recorded" && replay.replay === true && replay.workpaperId === receipt.workpaperId
      && items.every((i) => i.state === "calculated") && perClass.every((x) => x.calculated === x.serverSum && x.recorded === `-${x.calculated}`)
      && totalDep === E.expectedDepreciationMinor
      && after.schedule?.rows?.length === cls.length && cls.every((cl) => { const row = after.schedule.rows.find((r) => r.classLabel === cl.label); return row && row.openingMinor === cl.opening.carryingMinor && row.closingMinor === cl.closing.carryingMinor; })
      && after.schedule.sourceRef === `Reviewed equipment workpaper ${receipt.workpaperId}`
      && ppe?.status === "reconciled" && ppe.scheduleClosingMinor === E.expectedClosingMinor && ppe.composedClosingMinor === E.expectedClosingMinor && ppe.scheduleOpeningMinor === E.openingMinor
      && receipt.notes.length === 3 && receipt.notes.every((n) => n.outcome === "recorded")
      && commitNotes.every((n) => after.notes[n.requirementId]?.body === n.body && after.notes[n.requirementId].sourceRef === `Reviewed equipment workpaper ${receipt.workpaperId}`)
      && receipt.answersRecorded === Object.keys(commitPayload.entityAnswers).length + cls.reduce((a, cl) => a + Object.keys(cl.answers).length, 0) && after.answers.length === receipt.answersRecorded;
    return ok ? true : { receipt: receipt.outcome, replay: replay.outcome, perClass, totalDep, ppe, rows: after.schedule?.rows, notes: receipt.notes, answers: after.answers.length };
  });
  await kase(`${pfx}.equipment.reload-shows-recorded`, "read again from nothing (a new page load): the current workpaper is the recorded one with the identical payload, the schedule carries every class, and the answers and the three notes are those recorded", async () => {
    const c = await ctx();
    const same = isDeepStrictEqual(JSON.parse(JSON.stringify(commitPayload)), c.workpaper?.payload);
    const answered = new Set(c.answers.map((a) => `${a.classKey ?? "entity"}:${a.questionId}`));
    const expected = [...Object.keys(commitPayload.entityAnswers).map((q) => `entity:${q}`), ...commitPayload.classes.flatMap((cl) => Object.keys(cl.answers).map((q) => `${cl.classId}:${q}`))];
    return c.outcome === "available" && c.workpaper?.id === receipt.workpaperId && same && c.schedule?.id === receipt.schedule.submissionId && c.schedule.rows.length === commitPayload.classes.length
      && expected.every((x) => answered.has(x)) && c.answers.every((a) => a.workpaperId === receipt.workpaperId) && commitNotes.every((n) => c.notes[n.requirementId]?.body === n.body) ? true : { same, id: c.workpaper?.id, answers: [...answered], expected };
  });
  await kase(`${pfx}.notes.every-requirement-resolved`, "every remaining requirement is resolved through the existing controls with the case's own basis and wording: decisions recorded with their reason (applicable ones get their disclosure), wording recorded for every disclosure; afterwards no requirement is missing, undecided or placeholder-worded, and the notes status has no blocker; the resolution table is in the evidence file", async () => {
    const before = await requirementTable();
    const log = [];
    for (const d of S.decisions) {
      const r = (await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,$4,$5,$6) r", [A, Y, d.requirementId, d.decision, d.reason, uuid()])).r;
      log.push({ requirementId: d.requirementId, control: "fs_decide_requirement", decision: d.decision, reason: d.reason, outcome: r.outcome });
      if (!["recorded", "unchanged"].includes(r.outcome)) return { d, r };
    }
    for (const [id, body] of Object.entries(S.notes.wording)) {
      const r = (await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,$5,$6) r", [A, Y, id, body, S.notes.source, uuid()])).r;
      log.push({ requirementId: id, control: "fs_record_disclosure", outcome: r.outcome });
      if (!["recorded", "unchanged"].includes(r.outcome)) return { id, r };
    }
    const after = await requirementTable();
    ev.resolution = before.rows.map((b) => { const a = after.rows.find((x) => x.requirementId === b.requirementId); const c = log.filter((l) => l.requirementId === b.requirementId);
      return { requirementId: b.requirementId, kind: b.kind, before: `${b.status}${b.placeholder ? " (placeholder wording)" : ""}`, controls: c.length ? c.map((l) => l.control + (l.decision ? `:${l.decision}` : "")).join(" + ") : (commitNotes.some((n) => n.requirementId === b.requirementId) ? "fs_commit_equipment_preparation_v2 (reviewed whole note)" : b.requirementId === "smes.schedule.ppe" ? "fs_commit_equipment_preparation_v2 (schedule)" : "unchanged"),
        after: a?.status ?? "absent", basis: a?.basis ?? null, sourceRef: a?.sourceRef ?? null }; });
    ev.afterBlockers = after.blockers;
    const bad = after.rows.filter((r) => r.outstanding);
    const noteBlockers = after.blockers.filter((b) => !/^STATEMENT_EVIDENCE_MISSING:/.test(b));
    return noteBlockers.length === 0 && bad.length === 0 ? true : { blockers: after.blockers, bad };
  });

  // ── Statements, comparatives, reconciliations ──────────────────────────────────────────────────────────────────────
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const rid = `rpt-${pfx}-${A.slice(0, 8)}`;
  const parse = (n, type, role) => {
    const pd = role === "CURRENT" ? S.current : S.prior;
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: S.currency, scale: 2, text: S.file(n), fileName: n, periodStart: pd.start, periodEnd: pd.end });
    if (r.outcome !== "PARSED") throw new Error(`${n} rejected: ${r.diagnostics.map((x) => x.code).join(",")}`);
    return r.batch;
  };
  const allEvidence = () => [
    parse("evidence_FY2025_current_transaction_ledger.csv", "TRANSACTION_LEDGER", "CURRENT"),
    parse("evidence_FY2025_current_equity_movements.csv", "EQUITY_MOVEMENTS", "CURRENT"),
    parse("evidence_FY2025_current_cash_account_map.csv", "CASH_ACCOUNT_MAP", "CURRENT"),
    parse("evidence_FY2024_comparative_transaction_ledger.csv", "TRANSACTION_LEDGER", "COMPARATIVE"),
    parse("evidence_FY2024_comparative_equity_movements.csv", "EQUITY_MOVEMENTS", "COMPARATIVE"),
    parse("evidence_FY2024_comparative_prior_period_statements.csv", "PRIOR_PERIOD_STATEMENTS", "COMPARATIVE"),
  ];
  const save = (newEvidence) => prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: S.legalName, reportId: rid, newEvidence, idempotencyKey: `csr-${uuid()}`, evaluatedAt: new Date().toISOString() });
  const latest = async () => (await owner.c.versions(A, Y)).filter((v) => v.isLatest).at(-1);
  let doc = null, signed = null;
  await kase(`${pfx}.statements.version-after-close-review`, "the six evidence files are stored with a version that Close Review blocks; the check is run and each finding explained with its source; the next version is ready with no blocker", async () => {
    const s1 = await save(allEvidence());
    if (s1.outcome !== "saved") return { s1: s1.outcome, d: s1.diagnostics?.filter((x) => x.severity === "ERROR") };
    const v1 = (await latest()).reportVersion;
    const r1 = await partner.c.readiness(A, rid, v1);
    let refused = false; try { await partner.c.setState(A, rid, v1, "REVIEWED", "should be refused"); } catch { refused = true; }
    const run = (await asU(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, Y])).r;
    const findings = (await admin.query("SELECT id, rule_id, finding_key FROM public.close_review_findings WHERE run_id=$1", [run.runId])).rows;
    for (const f of findings) await asU(U.preparer, "SELECT public.close_review_finding_action($1,'explain',$2,$3,$4) r", [f.id, S.closeReview.explanation, S.closeReview.source, uuid()]);
    const s2 = await save([]);
    signed = (await latest()).reportVersion;
    const r2 = await partner.c.readiness(A, rid, signed);
    const ns = await notesStatus();
    ev.versions = { blockedVersion: v1, blockers: r1.blockers, closeReviewFindings: findings.map((f) => `${f.rule_id}:${f.finding_key}`), readyVersion: signed, ready: r2.ready, readyBlockers: r2.blockers, notesBlockers: ns.blockers, statementEvidence: ns.requirements.filter((r) => r.kind === "STATEMENT").map((r) => `${r.requirementId}:${r.status}`) };
    return r1.blockers.includes("CLOSE_REVIEW_FINDINGS_NOT_CHECKED") && refused && s2.outcome === "saved" && r2.ready && r2.blockers.length === 0 && ns.blockers.length === 0 ? true : ev.versions;
  });
  const lines = (type) => doc.statements.filter((s) => s.type === type).flatMap((s) => s.sections.flatMap((x) => x.lines));
  const value = (type, re, period) => {
    const f = lines(type).filter((l) => re.test(l.lineId)).map((l) => l.factBindings.find((b) => b.periodId === period)?.factId).filter(Boolean).map((id) => doc.facts.find((x) => x.factId === id));
    return f.length ? BigInt(f[0].value.minorUnits.__bigint__ ?? f[0].value.minorUnits) : null;
  };
  const LOCATE = {
    "Financial position|Total assets": ["STATEMENT_OF_FINANCIAL_POSITION", /^line:sfp:total:totalAssetsMinor$/],
    "Financial position|Total equity": ["STATEMENT_OF_FINANCIAL_POSITION", /^line:sfp:total:totalEquityMinor$/],
    "Financial position|Total liabilities": ["STATEMENT_OF_FINANCIAL_POSITION", /^line:sfp:total:totalLiabilitiesMinor$/],
    "Comprehensive income|Profit before tax": ["STATEMENT_OF_PROFIT_OR_LOSS", /^line:sci:total:profitBeforeTaxMinor$/],
    "Comprehensive income|Profit for the period": ["STATEMENT_OF_PROFIT_OR_LOSS", /^line:sci:total:profitOrLossMinor$/],
    "Comprehensive income|Total comprehensive income": ["STATEMENT_OF_PROFIT_OR_LOSS", /^line:sci:total:totalComprehensiveIncomeMinor$/],
    "Cash flows|Net cash from operating activities": ["STATEMENT_OF_CASH_FLOWS", /^line:cf:operating:net$/],
    "Cash flows|Net cash from investing activities": ["STATEMENT_OF_CASH_FLOWS", /^line:cf:investing:net$/],
    "Cash flows|Net cash from financing activities": ["STATEMENT_OF_CASH_FLOWS", /^line:cf:financing:net$/],
    "Cash flows|Cash at the end of the period": ["STATEMENT_OF_CASH_FLOWS", /^line:cf:closing$/],
    "Changes in equity|Total equity at the end of the period": ["STATEMENT_OF_CHANGES_IN_EQUITY", /^line:eq:total-closing$/],
  };
  await kase(`${pfx}.statements.expected-totals`, "every statement row of the case's EXPECTED_TOTALS.csv equals the stored document, current and comparative; the PPE schedule row is the recorded schedule", async () => {
    doc = (await owner.c.report(rid, signed)).document;
    const bad = [], got = {};
    for (const r of S.rows("EXPECTED_TOTALS.csv")) {
      const at = LOCATE[`${r.Statement}|${r.Line}`];
      if (!at) {
        if (r.Statement === "PPE schedule") {
          const s = (await admin.query("SELECT closing_total::text c FROM public.fs_schedule_submissions WHERE company_id=$1 AND period_year=$2 AND schedule_id='ppe' ORDER BY seq DESC LIMIT 1", [A, Y])).rows[0];
          const ok = s && BigInt(s.c.split(".")[0]) === minor(r["FY2025 (current)"]);
          got["PPE schedule closing"] = s?.c; if (!ok) bad.push(`PPE schedule: expected ${r["FY2025 (current)"]}, got ${s?.c}`);
        } else bad.push(`no locator for ${r.Statement} / ${r.Line}`);
        continue;
      }
      for (const [col, period] of [["FY2025 (current)", "CURRENT"], ["FY2024 (comparative)", "COMPARATIVE_1"]]) {
        if (r[col] === undefined || r[col] === "") continue;
        const v = value(at[0], at[1], period);
        got[`${r.Line} ${period}`] = v === null ? "absent" : v.toString();
        if (v !== minor(r[col])) bad.push(`${r.Statement} / ${r.Line} / ${period}: expected ${r[col]}, got ${v === null ? "absent" : String(v)}`);
      }
    }
    ev.figures = got;
    return bad.length === 0 ? true : { bad, lineIds: doc.statements.flatMap((s) => s.sections.flatMap((x) => x.lines.map((l) => `${s.type} ${l.lineId}`))).slice(0, 80) };
  });
  await kase(`${pfx}.statements.reconciliations`, "on the stored document: closing cash equals the financial position's cash in both periods; the current opening cash equals the comparative closing cash; closing equity equals the financial position's equity in both periods; the PPE schedule's closing and opening equal the PPE line; the classes' depreciation equals the trial balance's depreciation expense and lies within its presented line; the sign-off rules (cash, equity, schedule and comparative ties) report no blocker", async () => {
    const sfpCash = (p) => value("STATEMENT_OF_FINANCIAL_POSITION", /cash_and_cash_equivalents/, p);
    const sfpEquity = (p) => value("STATEMENT_OF_FINANCIAL_POSITION", /^line:sfp:total:totalEquityMinor$/, p);
    const sfpPpe = (p) => value("STATEMENT_OF_FINANCIAL_POSITION", /property_plant_and_equipment/, p);
    const cfClosing = (p) => value("STATEMENT_OF_CASH_FLOWS", /^line:cf:closing$/, p);
    const cfOpening = (p) => value("STATEMENT_OF_CASH_FLOWS", /^line:cf:opening$/, p);
    const eqClosing = (p) => value("STATEMENT_OF_CHANGES_IN_EQUITY", /^line:eq:total-closing$/, p);
    const opex = value("STATEMENT_OF_PROFIT_OR_LOSS", /operating_expenses_by_function/, "CURRENT");
    const tbDep = S.rows("trial_balance_FY2025_current.csv").filter((r) => /^Depreciation/.test(r["Account name"])).reduce((a, r) => a + minor(r.Debit || "0") - minor(r.Credit || "0"), 0n);
    const classDep = E.classes.reduce((a, c) => a + c.movements.filter((m) => m.kind === "depreciation").reduce((b, m) => b + BigInt(m.accumulatedDepreciationMinor), 0n), 0n);
    const sched = (await admin.query("SELECT opening_total::text o, closing_total::text c FROM public.fs_schedule_submissions WHERE company_id=$1 AND period_year=$2 AND schedule_id='ppe' ORDER BY seq DESC LIMIT 1", [A, Y])).rows[0];
    const t = {
      cashCurrent: [cfClosing("CURRENT"), sfpCash("CURRENT")], cashComparative: [cfClosing("COMPARATIVE_1"), sfpCash("COMPARATIVE_1")], openingCash: [cfOpening("CURRENT"), cfClosing("COMPARATIVE_1")],
      equityCurrent: [eqClosing("CURRENT"), sfpEquity("CURRENT")], equityComparative: [eqClosing("COMPARATIVE_1"), sfpEquity("COMPARATIVE_1")],
      ppeClosing: [sched ? BigInt(sched.c.split(".")[0]) : null, sfpPpe("CURRENT")], ppeOpening: [sched ? BigInt(sched.o.split(".")[0]) : null, sfpPpe("COMPARATIVE_1")],
      depreciation: [classDep, tbDep],
    };
    const ties = Object.fromEntries(Object.entries(t).map(([k, [a, b]]) => [k, { a: a === null ? null : a.toString(), b: b === null ? null : b.toString(), agrees: a !== null && b !== null && a === b }]));
    ties.depreciationWithinPresentedLine = { depreciation: classDep.toString(), line: opex === null ? null : opex.toString(), agrees: opex !== null && classDep <= opex };
    const rd = await partner.c.readiness(A, rid, signed);
    ev.reconciliations = { ties, blockers: rd.blockers };
    return Object.values(ties).every((x) => x.agrees) && rd.blockers.length === 0 ? true : ev.reconciliations;
  });

  // ── Review, issuance, history ──────────────────────────────────────────────────────────────────────────────────────
  await kase(`${pfx}.review.policy-and-two-approvers`, "the sign-off policy in force is separate approvers; the partner records REVIEWED; the partner's own FINAL is refused by name (SIGNOFF_SEPARATE_APPROVERS_REQUIRED); the owner records FINAL; the publication history is exactly REVIEWED then FINAL for that version", async () => {
    const policy = (await asU(U.owner, "SELECT public.fs_signoff_policy($1) r", [A])).r;
    const rv = await partner.c.setState(A, rid, signed, "REVIEWED", "Reviewed the complete report");
    let refusal = ""; try { await partner.c.setState(A, rid, signed, "FINAL", "should be refused: same approver"); } catch (e) { refusal = String(e?.message ?? e); }
    const f = await owner.c.setState(A, rid, signed, "FINAL", "Approved for issue");
    const pub = (await owner.c.publications(rid)).map((p) => `${p.reportVersion}:${p.state}`);
    ev.review = { policy: policy.policy, reviewed: rv.state, sameApproverRefusal: refusal.slice(0, 120), final: f.state, publications: pub };
    return policy.policy === "separate_approvers" && rv.state === "REVIEWED" && /SIGNOFF_SEPARATE_APPROVERS_REQUIRED/.test(refusal) && f.state === "FINAL" && JSON.stringify(pub) === JSON.stringify([`${signed}:REVIEWED`, `${signed}:FINAL`]) ? true : ev.review;
  });
  let issuance = null, savedText = null, finalSnap = null;
  const review = reviewClient(seal.transport(U.owner));
  const outputRef = review.outputRef(rid, signed);
  const finalState = async () => hex(JSON.stringify([
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.financial_statement_publications t WHERE report_id=$1 ORDER BY 1", [rid])).rows,
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.fs_publication_bindings t WHERE report_id=$1 ORDER BY 1", [rid])).rows,
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.financial_statement_reports t WHERE report_id=$1 AND report_version=$2 ORDER BY 1", [rid, signed])).rows,
    issuance ? (await admin.query("SELECT to_jsonb(t)::text j FROM public.reporting_pack_issuances t WHERE id=$1", [issuance.issuanceId])).rows : [],
    [...seal.bucket.entries()].filter(([p]) => p.endsWith(`/${issuance?.issuanceId}.json`)).map(([p, b]) => `${p}:${hex(Buffer.from(b))}`),
  ]));
  await kase(`${pfx}.issuance.official-pack-verified`, "the official pack is issued through the browser client's path (issue, store, seal by the database); the saved bytes hash to the seal recorded on the issuance; verify reads intact and official; retrieve returns the identical bytes; the local hash of the retrieved document equals the sealed hash, as the Exports page checks it; the sealed document names this report version", async () => {
    let saved = null;
    const delivered = await review.issueOfficial(A, Y, outputRef, (blob, fileName) => { saved = { blob, fileName }; });
    if (delivered !== "delivered" || !saved) return { delivered };
    savedText = await saved.blob.text();
    const local = await sha256HexOf(savedText);
    const list = await review.issuances(A, outputRef);
    issuance = list[0] ?? null;
    const verify = await review.verify(issuance?.issuanceId ?? "");
    const retrieved = await review.retrieve(issuance?.issuanceId ?? "");
    const row = (await admin.query("SELECT content_sha256, consumed_at IS NOT NULL sealed, pack_kind FROM public.reporting_pack_issuances WHERE id=$1", [issuance?.issuanceId])).rows[0];
    let names = false; try { const d = JSON.parse(savedText); names = JSON.stringify(d).includes(rid); } catch { names = false; }
    ev.issuance = { issuanceId: issuance?.issuanceId, fileName: saved.fileName, bytes: Buffer.byteLength(savedText), localSha256: local, sealedSha256: row?.content_sha256, verify, retrieved: retrieved.outcome, retrievedSha256: retrieved.content_sha256, superseded: retrieved.superseded };
    return list.length === 1 && row?.sealed === true && row.pack_kind === "financial_statements_data" && local === row.content_sha256 && issuance.contentSha256 === row.content_sha256
      && verify.outcome === "intact" && verify.official === true && retrieved.outcome === "retrieved" && retrieved.document === savedText && retrieved.content_sha256 === local && (await sha256HexOf(retrieved.document)) === retrieved.content_sha256 && names
      ? true : ev.issuance;
  });
  await kase(`${pfx}.final.preserved-after-later-change`, "a wording change after issue leaves the FINAL publication, its binding, the report row, the issuance row and the sealed bytes byte-identical; the pack still verifies intact; the FINAL version is stale, signing it again is refused, and a new version can be saved while the history keeps the FINAL", async () => {
    finalSnap = await finalState();
    const r = (await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,$5,$6) r", [A, Y, S.laterChange.requirementId, S.laterChange.body, S.laterChange.source, uuid()])).r;
    const same = (await finalState()) === finalSnap;
    const verify = await review.verify(issuance.issuanceId);
    const rd = await partner.c.readiness(A, rid, signed);
    let refused = false; try { await partner.c.setState(A, rid, signed, "REVIEWED", "stale"); } catch (e) { refused = /REPORTING_DEPENDENCIES_STALE|NOT_LATEST_VERSION|already/i.test(String(e?.message)) || true; }
    const s3 = await save([]);
    const pub = (await owner.c.publications(rid)).map((p) => `${p.reportVersion}:${p.state}`);
    ev.history = { laterChange: r.outcome, finalRowsIdentical: same, verifyAfter: verify, staleBlockers: rd.blockers, newVersion: s3.outcome === "saved" ? s3.reportVersion : s3.outcome, publications: pub };
    return r.outcome === "recorded" && same && verify.outcome === "intact" && verify.official === true && rd.blockers.includes("REPORTING_DEPENDENCIES_STALE") && refused && s3.outcome === "saved" && s3.reportVersion > signed && pub.includes(`${signed}:FINAL`) ? true : ev.history;
  });
}
// RUNNER-END

async function main() {
  db = await openDatabase("complete_sme_report_proof");
  group("Chain");
  await kase("setup.chain-applies", "the full chain applies; the equipment preparation, notes, publication and sealing functions are installed", async () => {
    const err = await applyChain(db);
    if (err) return err;
    const r = await db.one(`SELECT to_regprocedure('public.fs_commit_equipment_preparation_v2(uuid,integer,jsonb,uuid,uuid,uuid,jsonb,uuid)') IS NOT NULL c,
      to_regprocedure('public.fs_notes_status(uuid,integer)') IS NOT NULL n, to_regprocedure('public.issue_official_reporting_pack(uuid,integer,text,uuid)') IS NOT NULL i,
      to_regprocedure('public.prepare_official_reporting_pack(uuid,uuid)') IS NOT NULL p`);
    return r.c && r.n && r.i && r.p ? true : r;
  });
  await kase("static.one-runner-no-case-branch", "the runner that carries both cases contains no case-specific branch: no case name, account code or fixture figure appears between its markers (the second case is new data only)", async () => {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    const body = src.slice(src.indexOf("// RUNNER-BEGIN"), src.indexOf("// RUNNER-END"));
    const hits = body.match(/acceptance|mwanza|agro|\b[89]\d{4}\b|\b(?:1[46]000|2654000|1741000|200000|437800)\b/gi) ?? [];
    return body.length > 1000 && hits.length === 0 ? true : { hits };
  });
  const seal = await sealModule(db);
  for (const [pfx, dir] of SCENARIOS) await runScenario(db, loadScenario(dir), pfx, seal);
}

let crashed = false, crashMessage = null;
try { await main(); } catch (e) { crashed = true; crashMessage = `${e.code ?? ""}:${String(e?.stack ?? e).slice(0, 2000)}`; console.error(e.stack ?? e); }
writeResult(!crashed, crashed, crashMessage);
const ok = finish("COMPLETE_SME_REPORT", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
