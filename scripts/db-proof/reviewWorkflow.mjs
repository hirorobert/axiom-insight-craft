#!/usr/bin/env bun
// Real-PostgreSQL proof of the reviewed reporting journey (20261112100000) — the persisted reviewer workflow, the
// authorised acceptance of prior-FINAL differences and the next-period roll-forward carry, through the browser's own
// client code (src/lib/reporting) where a page would act and through the database where an attacker or a defect would:
//
//   R1  a reviewer's BLOCKING comment on a figure blocks the version by name; an ADVISORY comment never does
//   R2  who may do what: the preparer responds but cannot resolve; a viewer and another workspace's owner are refused;
//       the reviewer resolves; request-id replays answer the same record, a changed request under the same id is refused
//   R3  a save does not resolve: a new version with the same figure keeps the blocking comment open; a resolved comment
//       stays resolved while its figure is unchanged, and is REOPENED BY CHANGE when an approved adjustment moves it
//   R4  CONTROL REMOVED (the 20261111100000 blockers text re-installed): an open blocking comment no longer blocks —
//       the regression; CONTROL RESTORED: it blocks again
//   R5  history: every event keeps its author, time, the version it was made on and the item's content then
//   A1  prior-FINAL differences: a prior-year adjustment approved after issue blocks the next period by name; a reviewer
//       accepts EXACTLY that set with a reason → accepted_differences, no blocker, both figures kept; a further change
//       re-blocks (the acceptance is not in force); the preparer cannot accept
//   F1  roll-forward carry: the prior year's wording and decisions are carried with provenance; NOTHING carried is current
//       (notes status and dependencies unchanged) until the preparer confirms one, which writes through the existing
//       authority with a reason naming the source; a withdrawn item stays withdrawn; replays are idempotent; a viewer and
//       another workspace are refused; the worklist names carries, evidence still to supply and the reconciliation
//   F2  edition change: FY2027 begins on 2027-01-01 and so resolves to the third edition by the edition policy; the carry
//       from FY2026 records every item as withdrawn (edition_changed) — nothing is carried under another edition
//   Order: F1 runs first (FY2025's wording and decisions carried into FY2026 before FY2026 is prepared), then R1–R5 on
//   FY2026, then A1 and F2 on FY2027.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/reviewWorkflow.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import { applyChain, certifier, chainFiles, clientDb, csv, DECISIONS_1_2_0, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, FY2025, FY2026, makeWorld, migrationText, openDatabase, prepareReporting, reporter, uuid, WORDS_1_2_0 } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const FILE = "20261112100000_fs_review_workflow_and_rollforward.sql";
const { group, check, refused, finish } = reporter();
let db;

async function main() {
  db = await openDatabase("review_proof");
  group("Replay");
  await check(`${FILE} is in the chain and the whole chain applies`, async () => (!chainFiles().includes(FILE) ? `${FILE} missing` : (await applyChain(db)) ?? true));
  await refused("re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");
  await check("static contract: no DELETE or UPDATE without a WHERE clause anywhere in the migration", async () => {
    const code = migrationText(FILE).replace(/--[^\n]*/g, "");
    const bare = [...code.matchAll(/\bDELETE\s+FROM\s+[\w.]+\s*;/gi), ...code.matchAll(/\bUPDATE\s+[\w.]+\s+SET\b(?:(?!\bWHERE\b)[^;])*;/gi)].map((m) => m[0].slice(0, 60));
    return bare.length === 0 ? true : bare;
  });

  const W = await makeWorld(db);
  const { U, A, B } = W;
  await W.rollout(A, true);
  await W.rollout(B, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const parse = (type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const body = (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type];
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: body, fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${JSON.stringify(r).slice(0, 300)}`);
    return r.batch;
  };
  const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
  const attempt = (who, rid, newEvidence = []) => prepareReportVersion(who.d, who.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  const latest = (rid) => db.count("SELECT coalesce(max(report_version),0) n FROM public.financial_statement_reports WHERE report_id=$1", [rid]);
  const readiness = (rid, v) => partner.c.readiness(A, rid, v);
  const rpc = (uid, sql, p) => asU(uid, sql, p).then((r) => r.r);
  const open = (uid, rid, v, kind, item, sev, body, req = uuid()) => rpc(uid, "SELECT public.fs_review_comment_open($1,$2,$3,$4,$5,$6,$7,$8) r", [A, rid, v, kind, item, sev, body, req]);
  const respond = (uid, id, body, req = uuid()) => rpc(uid, "SELECT public.fs_review_comment_respond($1,$2,$3,$4) r", [A, id, body, req]);
  const resolve = (uid, id, body, req = uuid()) => rpc(uid, "SELECT public.fs_review_comment_resolve($1,$2,$3,$4) r", [A, id, body, req]);
  const reopen = (uid, id, body, req = uuid()) => rpc(uid, "SELECT public.fs_review_comment_reopen($1,$2,$3,$4) r", [A, id, body, req]);
  const comments = (uid, rid, v) => rpc(uid, "SELECT public.fs_review_comments($1,$2,$3) r", [A, rid, v]);
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code ?? ""}:${String(e.message).split("\n")[0]}`; } };
  const adjust = async (minor, reason, lines = [{ accountKey: "6100", debitMinor: String(minor), creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: String(minor) }]) => {
    const prop = (await asU(U.preparer, "SELECT public.close_review_propose_adjustment($1,$2,$3,NULL,$4::jsonb,'{}'::uuid[],$5,NULL) r",
      [A, Y, reason, JSON.stringify(lines), uuid()])).r;
    const dec = (await asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed',NULL,$2) r", [prop.adjustmentId, uuid()])).r;
    return { prop, dec };
  };
  const FN_BLOCKERS = /CREATE OR REPLACE FUNCTION public\.fs_publication_blockers\(p_company_id UUID, p_report_id TEXT, p_version INTEGER\)[\s\S]*?\nEND;\n\$\$;/;
  const installBlockers = async (file) => { const m = migrationText(file).match(FN_BLOCKERS); if (!m) throw new Error(`no fs_publication_blockers in ${file}`); await db.admin.query(m[0]); };
  const PAYABLES = "fact:current:current_liabilities:sfp.trade_and_other_payables";

  group("Setup through the real functions");
  await check("two certified years (FY2025 reviewed, FY2026 certified on its mappings)", async () => {
    const p25 = await k.upload(A, Y - 1, csv(FY2025)); await k.review(A, p25); await k.certify(A, p25);
    const c26 = await k.upload(A, Y, csv(FY2026)); await k.certify(A, c26);
    return true;
  });
  const notesOf = (year) => asU(U.owner, "SELECT public.fs_notes_status($1,$2) r", [A, year]).then((r) => r.r);
  const depsOf = (year) => asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, year]).then((r) => r.r);
  const WORDS = { "smes.note.compliance": "Prepared in accordance with the IFRS for SMEs (2015 edition).", "smes.note.identification": "Synthetic SME Limited; year ended 31 December 2026; TZS.",
    "smes.note.policies": "Historical cost.", "smes.note.judgements": "None beyond estimates.", "smes.note.estimates": "Useful lives.", "smes.note.subclassifications": "All receivables from third parties.",
    "smes.note.share_capital": "10,000 ordinary shares, fully paid." };

  // ── F1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("F1. Roll-forward carry (FY2025 → FY2026): provenance, nothing current until confirmed, write-through on confirmation");
  await check("FY2025 holds the prior year's wording (13) and decisions (7) as the source", async () => {
    for (const [id, text] of Object.entries({ ...WORDS, ...WORDS_1_2_0 })) await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,'Notes FY2025',$5)", [A, Y - 1, id, text, uuid()]);
    await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,'smes.note.share_capital','applicable','The entity has share capital',$3)", [A, Y - 1, uuid()]);
    for (const id of ["smes.sci.5_5_e", "smes.sci.5_5_g", "smes.sci.5_5_h", ...DECISIONS_1_2_0]) await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,'not_applicable','None in the periods presented',$4)", [A, Y - 1, id, uuid()]);
    const w = await db.count("SELECT count(DISTINCT requirement_id) n FROM public.fs_disclosure_texts WHERE company_id=$1 AND period_year=$2 AND body IS NOT NULL", [A, Y - 1]);
    const d = await db.count("SELECT count(DISTINCT requirement_id) n FROM public.fs_requirement_decisions WHERE company_id=$1 AND period_year=$2", [A, Y - 1]);
    return w === 13 && d === 7 ? true : { w, d };
  });
  let carry, before, carried;
  await check("the preparer carries FY2025's in-force wording (13) and decisions (7) into FY2026 with provenance; the viewer and another workspace's owner are refused; a replay carries nothing more", async () => {
    before = { notes: (await notesOf(Y)).statusSha256, deps: (await depsOf(Y)).dependenciesSha256 };
    const vw = (await asU(U.viewer, "SELECT public.fs_rollforward_carry($1,$2,$3) r", [A, Y, uuid()])).r;
    const ob = (await asU(U.ownerB, "SELECT public.fs_rollforward_carry($1,$2,$3) r", [A, Y, uuid()])).r;
    carry = (await asU(U.preparer, "SELECT public.fs_rollforward_carry($1,$2,$3) r", [A, Y, uuid()])).r;
    const again = (await asU(U.preparer, "SELECT public.fs_rollforward_carry($1,$2,$3) r", [A, Y, uuid()])).r;
    const rows = (await db.admin.query("SELECT kind, status, source_period_year, source_record_id FROM public.fs_rollforward_carries WHERE company_id=$1 AND period_year=$2", [A, Y])).rows;
    return vw.outcome === "forbidden" && ob.outcome === "forbidden" && carry.outcome === "recorded" && carry.carried === 20 && carry.withdrawn === 0 && carry.editionChanged === false
      && again.carried === 0 && again.skipped === 20 && rows.length === 20 && rows.every((r) => r.status === "carried" && r.source_period_year === Y - 1 && r.source_record_id)
      && rows.filter((r) => r.kind === "wording").length === 13 ? true : { vw, ob, carry, again, rows: rows.length };
  });
  await check("NOTHING carried is current: FY2026's notes status and dependencies are unchanged by the carry", async () => {
    const after = { notes: (await notesOf(Y)).statusSha256, deps: (await depsOf(Y)).dependenciesSha256 };
    return after.notes === before.notes && after.deps === before.deps ? true : { before, after };
  });
  await check("the worklist names every carried item with its status and source, the six evidence families still to supply, and the prior-FINAL state (no issued FY2025)", async () => {
    const w = (await asU(U.preparer, "SELECT public.fs_rollforward_worklist($1,$2) r", [A, Y])).r;
    carried = w.carries;
    return w.state === "listed" && w.carries.length === 20 && w.carries.every((c) => c.status === "carried" && c.kindOfRequirement && c.sourcePeriodYear === Y - 1) && w.evidence.length === 6 && w.evidence.every((e) => e.supplied === false)
      && w.priorFinal.state === "no_prior_final" && w.presentation.carriesInherently === true ? true : { state: w.state, n: w.carries?.length, ev: w.evidence, pf: w.priorFinal?.state };
  });
  await check("confirming a carried wording writes it through fs_record_disclosure for FY2026 with a source naming FY2025; the notes status now shows it provided; a replay answers the same; a second decision is refused", async () => {
    const item = carried.find((c) => c.kind === "wording" && c.requirementId === "smes.note.policies");
    const req = uuid();
    const r = (await asU(U.preparer, "SELECT public.fs_rollforward_decide($1,$2,true,NULL,$3) r", [A, item.carryId, req])).r;
    const again = (await asU(U.preparer, "SELECT public.fs_rollforward_decide($1,$2,true,NULL,$3) r", [A, item.carryId, req])).r;
    const other = (await asU(U.preparer, "SELECT public.fs_rollforward_decide($1,$2,false,'changed my mind',$3) r", [A, item.carryId, uuid()])).r;
    const row = (await db.admin.query("SELECT body, source_ref FROM public.fs_disclosure_texts WHERE company_id=$1 AND period_year=$2 AND requirement_id='smes.note.policies' ORDER BY seq DESC LIMIT 1", [A, Y])).rows[0];
    const n = (await notesOf(Y)).requirements.find((x) => x.requirementId === "smes.note.policies");
    return r.outcome === "recorded" && r.status === "confirmed" && r.recordId && again.replay === true && other.outcome === "already_decided" && row && row.body === item.payload.body && /Carried forward from FY2025/.test(row.source_ref)
      && n.status === "provided" ? true : { r, again, other, row, n: n?.status };
  });
  await check("confirming a carried decision writes it through fs_decide_requirement; withdrawing another needs a reason and leaves no record in the authority", async () => {
    const dec = carried.find((c) => c.kind === "decision" && c.requirementId === "smes.note.related_party_control");
    const r = (await asU(U.preparer, "SELECT public.fs_rollforward_decide($1,$2,true,NULL,$3) r", [A, dec.carryId, uuid()])).r;
    const d = (await db.admin.query("SELECT decision, reason FROM public.fs_requirement_decisions WHERE company_id=$1 AND period_year=$2 AND requirement_id='smes.note.related_party_control' ORDER BY seq DESC LIMIT 1", [A, Y])).rows[0];
    const w = carried.find((c) => c.kind === "wording" && c.requirementId === "smes.note.kmp_compensation");
    const bad = (await asU(U.preparer, "SELECT public.fs_rollforward_decide($1,$2,false,NULL,$3) r", [A, w.carryId, uuid()])).r;
    const wd = (await asU(U.preparer, "SELECT public.fs_rollforward_decide($1,$2,false,'Compensation changed; will be written afresh',$3) r", [A, w.carryId, uuid()])).r;
    const none = await db.count("SELECT count(*) n FROM public.fs_disclosure_texts WHERE company_id=$1 AND period_year=$2 AND requirement_id='smes.note.kmp_compensation'", [A, Y]);
    const n = (await notesOf(Y)).requirements.find((x) => x.requirementId === "smes.note.related_party_control");
    return r.outcome === "recorded" && d && d.decision === "not_applicable" && /Carried forward from FY2025/.test(d.reason) && bad.outcome === "invalid_request" && wd.outcome === "recorded" && wd.status === "withdrawn" && none === 0
      && n.status === "not_applicable" ? true : { r, d, bad, wd, none, n: n?.status };
  });
  await check("the carried rows are decided once: a direct UPDATE back to carried, a change of payload, or a DELETE is refused", async () => {
    const id = carried.find((c) => c.kind === "wording" && c.requirementId === "smes.note.policies").carryId;
    const u1 = await refusal(() => db.admin.query("UPDATE public.fs_rollforward_carries SET status='carried', decided_at=NULL, decided_by_user_id=NULL, confirmation_record_id=NULL WHERE id=$1", [id]));
    const u2 = await refusal(() => db.admin.query("UPDATE public.fs_rollforward_carries SET payload='{}'::jsonb WHERE id=$1", [id]));
    const d = await refusal(() => db.admin.query("DELETE FROM public.fs_rollforward_carries WHERE id=$1", [id]));
    return /42501/.test(u1 ?? "") && /42501/.test(u2 ?? "") && /42501/.test(d ?? "") ? true : { u1, u2, d };
  });

  group("FY2026 prepared through the real functions (on the certified years above)");
  await check("prepared: presentation, Close Review, notes (pack 1.2.0; the confirmed carries are already in force), schedule, comparatives approved", async () => { await prepareReporting(db, W, k, { year: Y, uploads: false }); return true; });
  const rid = `rpt-review-${uuid()}`;
  let v = 0;
  await check("the first bound version is ready", async () => {
    const r = await attempt(pre, rid, allEvidence());
    v = await latest(rid);
    const rd = await readiness(rid, v);
    return r.outcome === "saved" && rd.ready === true ? true : { r: r.outcome, b: rd.blockers };
  });

  // ── R1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("R1. A blocking comment blocks the version by name; an advisory comment never does");
  let blocking, advisory;
  await check("the reviewer opens a BLOCKING comment on the trade payables figure and an ADVISORY one on the accounting policies note", async () => {
    const b = await open(U.partner, rid, v, "fact", PAYABLES, "blocking", "Payables look understated: the November rent invoice is missing. Please check the accruals.");
    const a = await open(U.partner, rid, v, "note", "smes.note.policies", "advisory", "Consider naming the depreciation method here.");
    blocking = b.commentId; advisory = a.commentId;
    return b.outcome === "recorded" && a.outcome === "recorded" ? true : { b, a };
  });
  await check("readiness names the blocking comment (REVIEW_COMMENT_UNRESOLVED:<id>) and nothing for the advisory one; REVIEWED is refused by name", async () => {
    const rd = await readiness(rid, v);
    const ref = await refusal(() => partner.c.setState(A, rid, v, "REVIEWED", "Attempted with an open finding"));
    return rd.ready === false && rd.blockers.includes(`REVIEW_COMMENT_UNRESOLVED:${blocking}`) && !rd.blockers.some((x) => x.endsWith(advisory)) && /PT409:.*REVIEW_COMMENT_UNRESOLVED/.test(ref ?? "") ? true : { b: rd.blockers, ref };
  });
  await check("a comment on a figure the version does not carry is refused (item_not_found); an invented severity is invalid", async () => {
    const r1 = await open(U.partner, rid, v, "fact", "fact:current:current_assets:sfp.goodwill", "blocking", "x");
    const r2 = await open(U.partner, rid, v, "fact", PAYABLES, "urgent", "x");
    return r1.outcome === "item_not_found" && r2.outcome === "invalid_request" ? true : { r1, r2 };
  });

  // ── R2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("R2. Who may do what");
  await check("the preparer cannot open a comment (forbidden) and cannot resolve the reviewer's finding (forbidden); the viewer can do neither; another workspace's owner is refused everywhere", async () => {
    const o = await open(U.preparer, rid, v, "fact", PAYABLES, "blocking", "x");
    const r = await resolve(U.preparer, blocking, "Fixed");
    const vo = await open(U.viewer, rid, v, "fact", PAYABLES, "advisory", "x");
    const vr = await respond(U.viewer, blocking, "x");
    const bo = await open(U.ownerB, rid, v, "fact", PAYABLES, "blocking", "x");
    const br = await respond(U.ownerB, blocking, "x");
    const bl = await comments(U.ownerB, rid, v);
    return o.outcome === "forbidden" && r.outcome === "forbidden" && vo.outcome === "forbidden" && vr.outcome === "forbidden" && bo.outcome === "forbidden" && br.outcome === "forbidden" && bl.state === "unavailable"
      ? true : { o, r, vo, vr, bo, br, bl: bl.state };
  });
  await check("the preparer responds; the comment is 'responded' and still blocks; a replay of the same request answers the same event, a different body under the same request id is refused", async () => {
    const req = uuid();
    const r1 = await respond(U.preparer, blocking, "Accrual posted through adjustment 2; please re-check.", req);
    const r2 = await respond(U.preparer, blocking, "Accrual posted through adjustment 2; please re-check.", req);
    const r3 = await respond(U.preparer, blocking, "Something else", req);
    const rd = await readiness(rid, v);
    const c = (await comments(U.preparer, rid, v)).comments.find((x) => x.commentId === blocking);
    return r1.outcome === "recorded" && r2.replay === true && r2.eventId === r1.eventId && r3.outcome === "request_reused" && c.state === "responded" && rd.blockers.includes(`REVIEW_COMMENT_UNRESOLVED:${blocking}`) ? true : { r1, r2, r3, c: c?.state, b: rd.blockers };
  });
  await check("opening the same comment twice under one request id answers the same comment; a changed body under that id is refused", async () => {
    const req = uuid();
    const a = await open(U.partner, rid, v, "note", "smes.note.estimates", "advisory", "Name the useful lives.", req);
    const b = await open(U.partner, rid, v, "note", "smes.note.estimates", "advisory", "Name the useful lives.", req);
    const c = await open(U.partner, rid, v, "note", "smes.note.estimates", "advisory", "Other words.", req);
    return a.outcome === "recorded" && b.replay === true && b.commentId === a.commentId && c.outcome === "request_reused" ? true : { a, b, c };
  });

  // ── R3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("R3. A save never resolves; unchanged content stays resolved; changed content reopens");
  let v2 = 0;
  await check("a new version with the same figures keeps the blocking comment open on the new version (a blanket save resolves nothing)", async () => {
    await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.judgements','None beyond estimates; reviewed again.','Notes v2',$3)", [A, Y, uuid()]);
    const r = await attempt(pre, rid);
    v2 = await latest(rid);
    const rd = await readiness(rid, v2);
    const c = (await comments(U.partner, rid, v2)).comments.find((x) => x.commentId === blocking);
    return r.outcome === "saved" && v2 === v + 1 && c.state === "responded" && c.changedSinceOpened === false && rd.blockers.includes(`REVIEW_COMMENT_UNRESOLVED:${blocking}`) ? true : { r: r.outcome, v2, c, b: rd.blockers };
  });
  await check("the reviewer resolves it: the version is ready; REVIEWED is recorded", async () => {
    const r = await resolve(U.partner, blocking, "Checked the accrual; agreed.");
    const rd = await readiness(rid, v2);
    const s = await partner.c.setState(A, rid, v2, "REVIEWED", "Reviewed after the finding was resolved");
    return r.outcome === "recorded" && rd.ready === true && s.state === "REVIEWED" ? true : { r, b: rd.blockers, s: s.state };
  });
  await check("reopening a resolved comment is the reviewer's act (the preparer is refused); it blocks again; the reviewer resolves it again", async () => {
    const p = await reopen(U.preparer, blocking, null);
    const r = await reopen(U.partner, blocking, "Please attach the invoice reference.");
    const rd = await readiness(rid, v2);
    const r2 = await resolve(U.partner, blocking, "Invoice reference attached in the working papers.");
    const rd2 = await readiness(rid, v2);
    return p.outcome === "forbidden" && r.outcome === "recorded" && rd.blockers.includes(`REVIEW_COMMENT_UNRESOLVED:${blocking}`) && r2.outcome === "recorded" && rd2.ready === true ? true : { p, r, b: rd.blockers, r2, b2: rd2.blockers };
  });
  let v3 = 0;
  await check("an approved adjustment moves the payables figure: the next version shows the resolved comment REOPENED BY CHANGE, with what changed, and is blocked; a comment on an unchanged figure stays as it was", async () => {
    const unchanged = await open(U.partner, rid, v2, "fact", "fact:current:non_current_assets:sfp.property_plant_and_equipment", "blocking", "Confirm the depreciation charge against the register.");
    await resolve(U.partner, unchanged.commentId, "Confirmed against the register.");
    // Dr trade payables 5.00 / Cr trade receivables 5.00: a settlement netting, no profit or cash effect — the equity and
    // cash-flow ties keep holding, the payables figure moves.
    await adjust(500, "Customer balance netted against the supplier balance", [{ accountKey: "2000", debitMinor: "500", creditMinor: "0" }, { accountKey: "1100", debitMinor: "0", creditMinor: "500" }]);
    const r = await attempt(pre, rid);
    v3 = await latest(rid);
    const cs = (await comments(U.partner, rid, v3)).comments;
    const c = cs.find((x) => x.commentId === blocking), u = cs.find((x) => x.commentId === unchanged.commentId);
    const rd = await readiness(rid, v3);
    return r.outcome === "saved" && c.state === "reopened_by_change" && c.changedSinceOpened === true && c.openedContent !== c.contentNow && u.state === "resolved" && u.changedSinceOpened === false
      && rd.blockers.includes(`REVIEW_COMMENT_UNRESOLVED:${blocking}`) && !rd.blockers.includes(`REVIEW_COMMENT_UNRESOLVED:${unchanged.commentId}`) ? true : { r: r.outcome, c, u, b: rd.blockers };
  });
  await check("the reviewer re-reviews the moved figure and resolves it against the new content: the version is ready", async () => {
    const r = await resolve(U.partner, blocking, "Re-checked after adjustment 1: payables now include the rent accrual.");
    const rd = await readiness(rid, v3);
    const c = (await comments(U.partner, rid, v3)).comments.find((x) => x.commentId === blocking);
    return r.outcome === "recorded" && rd.ready === true && c.state === "resolved" ? true : { r, b: rd.blockers, c: c?.state };
  });

  // ── R4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("R4. The control removed and restored");
  let late;
  await check("CONTROL REMOVED (20261111100000 blockers text installed): an open blocking comment on the latest version does NOT block it — the regression", async () => {
    late = await open(U.partner, rid, v3, "fact", PAYABLES, "blocking", "One more look at the accrual cut-off.");
    await installBlockers("20261111100000_fs_publication_controls.sql");
    try {
      const rd = await readiness(rid, v3);
      return late.outcome === "recorded" && rd.ready === true && !rd.blockers.some((b) => b.startsWith("REVIEW_COMMENT_UNRESOLVED")) ? true : { late, rd };
    } finally { await installBlockers(FILE); }
  });
  await check("CONTROL RESTORED: the same comment blocks the version by name; the postcondition's text is installed", async () => {
    const rd = await readiness(rid, v3);
    const t = (await db.admin.query("SELECT position('REVIEW_COMMENT_UNRESOLVED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) > 0 AS ok")).rows[0];
    return rd.ready === false && rd.blockers.includes(`REVIEW_COMMENT_UNRESOLVED:${late.commentId}`) && t.ok === true ? true : { b: rd.blockers, t };
  });

  // ── R5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("R5. History and sign-off");
  await check("every event keeps its actor's role, time, the version it was made on and the item's content then; the tables are append-only", async () => {
    const c = (await comments(U.owner, rid, v3)).comments.find((x) => x.commentId === blocking);
    const actions = c.events.map((e) => e.action);
    const upd = await refusal(() => db.admin.query("UPDATE public.fs_review_comments SET body='edited' WHERE id=$1", [blocking]));
    const del = await refusal(() => db.admin.query("DELETE FROM public.fs_review_comment_events WHERE comment_id=$1", [blocking]));
    return JSON.stringify(actions) === JSON.stringify(["opened", "responded", "resolved", "reopened", "resolved", "resolved"]) && c.events.every((e) => e.actorRole && e.at && e.contentAt && typeof e.reportVersion === "number")
      && c.events[0].reportVersion === v && c.events.at(-1).reportVersion === v3 && /42501/.test(upd ?? "") && /42501/.test(del ?? "") ? true : { actions, upd, del, e: c.events.slice(0, 2) };
  });
  let vFinal = 0;
  await check("the reviewer resolves the last finding; REVIEWED, then FINAL by the owner: the version is issued", async () => {
    await resolve(U.partner, late.commentId, "Cut-off confirmed.");
    const rd = await readiness(rid, v3);
    if (!rd.ready) return rd.blockers;
    const s1 = await partner.c.setState(A, rid, v3, "REVIEWED", "Reviewed");
    const s2 = await owner.c.setState(A, rid, v3, "FINAL", "Approved for issue");
    vFinal = v3;
    return s1.state === "REVIEWED" && s2.state === "FINAL" ? true : { s1: s1.state, s2: s2.state };
  });

  // ── A1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("A1. Prior-FINAL differences: blocked by name, accepted by a reviewer with a reason, re-blocked by a further change");
  const Y2 = Y + 1;
  await check("FY2027 certified; a prior-year adjustment (2.00) approved AFTER the issue: FY2027's reconciliation names exactly the two moved lines and blocks", async () => {
    const c = await k.upload(A, Y2, csv(FY2026)); await k.certify(A, c);
    await adjust(200, "Late rent invoice found after issue");
    const pf = (await asU(U.owner, "SELECT public.fs_prior_final_reconciliation($1,$2) r", [A, Y2])).r;
    const want = ["COMPARATIVE_NOT_AS_ISSUED:fact:comparative:current_liabilities:sfp.trade_and_other_payables:200", "COMPARATIVE_NOT_AS_ISSUED:fact:comparative:sci:sci.operating_expenses_by_function:200"];
    const d = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y2])).r;
    return pf.state === "differences" && pf.priorFinal.reportVersion === vFinal && JSON.stringify(pf.blockers) === JSON.stringify(want) && pf.differences.length === 2
      && pf.differences.every((x) => x.issuedMinor && x.comparativeAsReportedMinor && x.comparativePresentedMinor) && want.every((w) => d.blockers.includes(w)) ? true : { pf, d: d.blockers };
  });
  let accSha;
  await check("the preparer cannot accept (forbidden); a reason shorter than 8 characters is invalid; the reviewer accepts exactly that set: accepted_differences, no blocker, both figures kept beside the reason", async () => {
    const p = (await asU(U.preparer, "SELECT public.fs_accept_prior_final_differences($1,$2,true,'Prior-period adjustment approved after issue',$3) r", [A, Y2, uuid()])).r;
    const s = (await asU(U.partner, "SELECT public.fs_accept_prior_final_differences($1,$2,true,'short',$3) r", [A, Y2, uuid()])).r;
    const a = (await asU(U.partner, "SELECT public.fs_accept_prior_final_differences($1,$2,true,'Prior-period adjustment 2 approved after issue; disclosed as a comparative restatement',$3) r", [A, Y2, uuid()])).r;
    const pf = (await asU(U.owner, "SELECT public.fs_prior_final_reconciliation($1,$2) r", [A, Y2])).r;
    accSha = a.differencesSha256;
    return p.outcome === "forbidden" && s.outcome === "invalid_request" && a.outcome === "recorded" && pf.state === "accepted_differences" && pf.blockers.length === 0 && pf.acceptance.inForce === true
      && pf.differences.length === 2 && pf.acceptance.reason.includes("disclosed") ? true : { p, s, a, pf };
  });
  await check("a further prior-year adjustment (1.00) changes the set: the acceptance is no longer in force, the lines block again; the reviewer accepts the new set; the dependencies identity moved each time", async () => {
    const d0 = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y2])).r;
    await adjust(100, "Another late invoice");
    const pf = (await asU(U.owner, "SELECT public.fs_prior_final_reconciliation($1,$2) r", [A, Y2])).r;
    const d1 = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y2])).r;
    const a = (await asU(U.partner, "SELECT public.fs_accept_prior_final_differences($1,$2,true,'Prior-period adjustments 2 and 3 approved after issue',$3) r", [A, Y2, uuid()])).r;
    const pf2 = (await asU(U.owner, "SELECT public.fs_prior_final_reconciliation($1,$2) r", [A, Y2])).r;
    const d2 = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y2])).r;
    return pf.state === "differences" && pf.acceptance.inForce === false && pf.blockers.length === 2 && pf.blockers[0].endsWith(":300") && a.outcome === "recorded" && a.differencesSha256 !== accSha
      && pf2.state === "accepted_differences" && d0.dependenciesSha256 !== d1.dependenciesSha256 && d1.dependenciesSha256 !== d2.dependenciesSha256 ? true : { pf: pf.state, inForce: pf.acceptance?.inForce, b: pf.blockers, a, pf2: pf2.state };
  });
  await check("withdrawing the acceptance re-blocks; nothing to accept when reconciled is refused; the acceptance rows are append-only", async () => {
    const w = (await asU(U.partner, "SELECT public.fs_accept_prior_final_differences($1,$2,false,'Withdrawn for the proof',$3) r", [A, Y2, uuid()])).r;
    const pf = (await asU(U.owner, "SELECT public.fs_prior_final_reconciliation($1,$2) r", [A, Y2])).r;
    const n = (await asU(U.partner, "SELECT public.fs_accept_prior_final_differences($1,$2,true,'Nothing to accept here',$3) r", [A, Y, uuid()])).r;
    const upd = await refusal(() => db.admin.query("UPDATE public.fs_prior_final_acceptances SET reason='x' WHERE company_id=$1", [A]));
    return w.outcome === "recorded" && pf.state === "differences" && n.outcome === "nothing_to_accept" && /42501/.test(upd ?? "") ? true : { w, pf: pf.state, n, upd };
  });

  // ── F2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("F2. An edition change on the next period withdraws every carried decision");
  await check("FY2027 begins on 2027-01-01 and resolves to the third edition: the carry from FY2026 records every in-force item (13 wordings, 7 decisions) as withdrawn (edition_changed), none as carried; the worklist shows them", async () => {
    const r = (await asU(U.preparer, "SELECT public.fs_rollforward_carry($1,$2,$3) r", [A, Y2, uuid()])).r;
    const rows = (await db.admin.query("SELECT status, status_reason FROM public.fs_rollforward_carries WHERE company_id=$1 AND period_year=$2", [A, Y2])).rows;
    const w = (await asU(U.preparer, "SELECT public.fs_rollforward_worklist($1,$2) r", [A, Y2])).r;
    return r.outcome === "recorded" && r.editionChanged === true && r.sourcePackId === "ifrs-for-smes/2015" && r.targetPackId === "ifrs-for-smes/2025" && r.carried === 0 && r.withdrawn === 20
      && rows.length === 20 && rows.every((x) => x.status === "withdrawn" && /^edition_changed:/.test(x.status_reason)) && w.carries.length === 20 && w.editions.target === "ifrs-for-smes/2025" ? true : { r, rows: rows.length, w: w.state };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("REVIEW_WORKFLOW", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
