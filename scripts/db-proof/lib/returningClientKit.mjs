// Builds the returning client through the REAL server path (no seeding of issued history): three certified years, the prior-year
// pack finalised in CFOClose with an approved reporting adjustment, and the current-year report prepared up to the evidence.
import { ingestEvidence } from "../../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../../src/lib/reporting/prepareVersion.ts";
import { assignmentPairs, clientDb, uuid } from "./reportingKit.mjs";
import { ACCOUNTS, ACCRUAL_LINES, ASSIGN_RC, evidenceFor, PPE, tbCsv, WORDS } from "./returningClientWorld.mjs";

export const COMPANY_NAME = "Returning Client Limited";

export function toolkit(db, W, k, companyName = COMPANY_NAME) {
  const { U } = W;
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const decisionRows = ACCOUNTS.map((r) => [...r.slice(0, 5), r[0] === "3100"]);

  /** Upload + real-engine certification of one year from the exported (source ledger) trial balance. */
  async function certifyYear(A, year, first) {
    const up = await k.upload(A, year, tbCsv(year));
    if (first) await k.review(A, up, decisionRows);
    await k.certify(A, up);
    return up;
  }
  async function presentation(A) {
    return asU(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Presentation per the chart of accounts',$3) r", [A, JSON.stringify(assignmentPairs(ASSIGN_RC)), uuid()]).then((r) => r.r);
  }
  /** Close Review: findings checked and each explained (the accumulated depreciation contra account). */
  async function closeReview(A, year) {
    const run = (await asU(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, year])).r;
    const open = (await db.admin.query("SELECT f.id FROM public.close_review_findings f WHERE f.run_id=$1", [run.runId])).rows;
    for (const f of open) await asU(U.preparer, "SELECT public.close_review_finding_action($1,'explain','Accumulated depreciation is a contra-asset by design','Fixed asset register',$2) r", [f.id, uuid()]);
    return open.length;
  }
  /** Notes, decisions, the equipment schedule: everything but evidence, comparatives and the report. */
  async function notes(A, year) {
    await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,'smes.note.share_capital','applicable','The entity has share capital',$3)", [A, year, uuid()]);
    for (const id of ["smes.sci.5_5_e", "smes.sci.5_5_g", "smes.sci.5_5_h"]) await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,'not_applicable','None in the periods presented',$4)", [A, year, id, uuid()]);
    for (const [id, text] of Object.entries(WORDS(year))) await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,'Notes v1',$5)", [A, year, id, text, uuid()]);
    for (const id of ["smes.note.events_after", "smes.note.related_party_control", "smes.note.related_party_transactions"])
      await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,'not_applicable','None in the periods presented; no parent or controlling party',$4)", [A, year, id, uuid()]);
    await asU(U.preparer, "SELECT public.fs_record_schedule($1,$2,'ppe',$3::jsonb,'Fixed asset register',$4)", [A, year, JSON.stringify(PPE(year)), uuid()]);
  }
  const approveComparatives = (A, year) => asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,true,'Agreed to the prior year as reported',$3) r", [A, year, uuid()]).then((r) => r.r);
  const proposeAdjustment = (A, year, lines, reason) => asU(U.preparer, "SELECT public.close_review_propose_adjustment($1,$2,$3,'Audit adjustment schedule',$4::jsonb,'{}'::uuid[],$5,NULL) r", [A, year, reason, JSON.stringify(lines), uuid()]).then((r) => r.r);
  const approveAdjustment = (id) => asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed to the audit adjustment schedule',NULL,$2) r", [id, uuid()]).then((r) => r.r);

  const parse = (A, year, type, role, set) => {
    const y = role === "CURRENT" ? year : year - 1;
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${year}`, currency: "TZS", scale: 2, text: set[role][type], fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type}/${role} rejected: ${JSON.stringify(r).slice(0, 400)}`);
    return r.batch;
  };
  const allEvidence = (A, year, opts) => {
    const set = evidenceFor(year, opts);
    return [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(A, year, t, "CURRENT", set)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(A, year, t, "COMPARATIVE", set))];
  };
  const attempt = (A, year, rid, ev = []) => prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: year, legalName: companyName, reportId: rid, newEvidence: ev, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: `${year + 1}-02-02T09:00:00.000Z` });
  return { U, asU, as, pre, partner, owner, certifyYear, presentation, closeReview, notes, approveComparatives, proposeAdjustment, approveAdjustment, allEvidence, attempt, ACCRUAL_LINES };
}
