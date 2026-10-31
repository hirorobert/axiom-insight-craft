/**
 * IPSAS accrual grants and revenue by period — bounded preparation (charter R1, R2, R6, R7, G5, G6; proposed spec §8).
 * Pure and advisory: ipsas_save_grants recalculates every figure here on the server (SQL twin, same blocker codes) and the
 * period itself comes from the server's certified upload, never from the browser.
 *
 * WHAT DECIDES REVENUE. Revenue is never derived from cash received or from expenditure incurred. For an arrangement with
 * obligations it is the sum of the amounts the entity has evidenced as SATISFIED per obligation (each with a stated basis and
 * evidence); for a pure restriction, or an arrangement with no present obligation, it is the amount of resources recognised.
 * Receivable (recognised − cash) and liability (recognised − cumulative revenue) are separate outputs, so a restricted fund is
 * not automatically a liability, and a cash receipt is not automatically revenue.
 *
 * WHAT IS DISTINGUISHED. Restriction, condition and binding-arrangement are separate classifications and the period selects
 * which set is valid: periods beginning before 1 January 2026 use the IPSAS 23 vocabulary (restriction-only,
 * enforceable-condition); periods beginning on or after it use the IPSAS 47 vocabulary (binding-arrangement,
 * without-binding-with-present-obligation, without-binding-no-present-obligation). A classification from the wrong set is a
 * blocker. Early application, first-period transition and every complexity (variable consideration, financing, agency,
 * non-cash, modification, credit loss, foreign currency) route to a governed workpaper that does not exist yet: they stay
 * open, they are never "not applicable" and never approximated. The vocabulary and bounded model come from the reviewed
 * candidate in #216; no paragraph-level mapping has been reviewed by an accounting author (UNASSIGNED).
 */
import { formatEquipmentAmount } from "../preparation/equipment";
import type { Answer } from "../preparation/equipmentModel";
import type { PrepTask } from "./preview";

export const GRANTS_CONTRACT = "cfoclose-ipsas-grants/1";
export const GRANTS_CONTENT_VERSION = "ipsas-accrual-grants-bounded/1";
export const IPSAS47_FIRST_PERIOD_START = "2026-01-01";
/** Period starts the routing has been reviewed for (same window as the #216 profile). */
export const REVIEWED_FROM = "2024-01-01", REVIEWED_BEFORE = "2027-01-01";

export const CLASSIFICATIONS_23 = ["restriction-only", "enforceable-condition"] as const;
export const CLASSIFICATIONS_47 = ["binding-arrangement", "without-binding-with-present-obligation", "without-binding-no-present-obligation"] as const;
export type GrantClassification = (typeof CLASSIFICATIONS_23)[number] | (typeof CLASSIFICATIONS_47)[number] | "";
const WITH_OBLIGATIONS = new Set(["enforceable-condition", "binding-arrangement", "without-binding-with-present-obligation"]);
export const SATISFACTION_BASES = ["milestone-delivered", "output-measure", "time-elapsed", "agreement-stated-expenditure"] as const;
export const COMPLEXITIES = ["variableConsideration", "financing", "agent", "nonCash", "modification", "creditLoss", "foreignCurrency"] as const;
export const COMPLEXITY_LABELS: Record<(typeof COMPLEXITIES)[number], string> = {
  variableConsideration: "variable or contingent amounts", financing: "a significant financing element", agent: "the entity acting as agent or pass-through",
  nonCash: "non-cash resources (goods, services in kind)", modification: "a modification of the agreement", creditLoss: "doubt about collecting the amount", foreignCurrency: "a currency other than the presentation currency",
};
export type GrantObligation = { id: string; label: string; allocatedMinor: string; satisfiedMinor: string; satisfactionBasis: (typeof SATISFACTION_BASES)[number] | ""; satisfactionEvidence: string };
export type Grant = {
  grantId: string; reference: string; grantor: string; agreementEvidence: string;
  classification: GrantClassification; classificationBasis: string; classificationEvidence: string;
  considerationMinor: string; recognisedResourcesMinor: string; cashReceivedMinor: string;
  priorCumulativeRevenueMinor: string; priorEvidence: string;
  complexities: Record<(typeof COMPLEXITIES)[number], boolean | null>; complexityBasis: string;
  obligations: GrantObligation[];
};
export type GrantsTb = { revenueMinor: string | null; liabilityMinor: string | null; receivableMinor: string | null };
export type GrantsInput = {
  period: { start: string; end: string } | null;
  entityAnswers: Record<string, Answer>;
  tb: GrantsTb;
  grants: (Grant & { assessmentConfirmed: boolean })[];
};
export const GRANT_ENTITY_QUESTIONS = [
  { id: "early_application_47", label: "Has the entity elected to apply the new revenue standard before its mandatory date?", when: "ipsas23", routesTo: "early-application transition analysis" },
  { id: "transition_47", label: "Is this the first period in which the entity applies the new revenue standard?", when: "ipsas47", routesTo: "first-application transition analysis (choices and comparatives)" },
] as const;

export type GrantIssue = { code: string; grantId: string | null; message: string; needs: string; owner: "preparer" | "management" | "reviewer"; area: "bring" | "prepare" };
export type GrantFigures = { grantId: string; cumulativeRevenueMinor: string | null; periodRevenueMinor: string | null; liabilityMinor: string | null; receivableMinor: string | null; cashReceivedMinor: string | null; considerationMinor: string | null };
export type GrantsResult = {
  contract: typeof GRANTS_CONTRACT; model: "ipsas23" | "ipsas47" | null; state: "incomplete" | "ready-for-review";
  grants: GrantFigures[];
  totals: { periodRevenueMinor: string | null; liabilityMinor: string | null; receivableMinor: string | null };
  issues: GrantIssue[];
};

const EXACT = /^(0|-?[1-9][0-9]{0,30})$/, NAT = /^(0|[1-9][0-9]{0,30})$/;
const nat = (v: string | null | undefined): bigint | null => (typeof v === "string" && NAT.test(v) ? BigInt(v) : null);
const exact = (v: string | null | undefined): bigint | null => (typeof v === "string" && EXACT.test(v) ? BigInt(v) : null);
const enough = (v: string | null | undefined, n = 3) => typeof v === "string" && v.trim().length >= n;

export function grantModel(start: string | null): { model: "ipsas23" | "ipsas47" | null; reviewed: boolean } {
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return { model: null, reviewed: false };
  return { model: start < IPSAS47_FIRST_PERIOD_START ? "ipsas23" : "ipsas47", reviewed: start >= REVIEWED_FROM && start < REVIEWED_BEFORE };
}
/** Codes that mean the figures of a grant cannot be calculated (so they are NOT computed, rather than guessed). */
const FIGURE_BLOCKERS = new Set(["GRANT_CLASSIFICATION_REQUIRED", "CLASSIFICATION_PERIOD_MISMATCH", "GRANT_AMOUNT_NOT_EXACT", "COMPLEXITY_UNANSWERED", "COMPLEX_GRANT_WORKPAPER_REQUIRED",
  "NOT_FULLY_FUNDED_GRANT_WORKPAPER_REQUIRED", "CASH_EXCEEDS_RECOGNISED_RESOURCES", "OBLIGATIONS_REQUIRED", "OBLIGATION_ALLOCATION_MISMATCH", "OBLIGATIONS_CONTRADICT_CLASSIFICATION",
  "OBLIGATION_SATISFACTION_EXCEEDS_ALLOCATION", "DUPLICATE_OBLIGATION", "REVENUE_REVERSAL_WORKPAPER_REQUIRED"]);

export function computeGrants(input: GrantsInput): GrantsResult {
  const issues: GrantIssue[] = [];
  const add = (code: string, grantId: string | null, message: string, needs: string, owner: GrantIssue["owner"] = "preparer", area: GrantIssue["area"] = "prepare") => issues.push({ code, grantId, message, needs, owner, area });
  const { model, reviewed } = grantModel(input.period?.start ?? null);
  if (model === null) add("PERIOD_UNKNOWN", null, "The reporting period of the certified trial balance is not available, so the period's revenue requirements cannot be selected.", "A certified trial balance for the year (the period is read from it, not typed).", "preparer", "bring");
  else if (!reviewed) add("PERIOD_PROFILE_NOT_REVIEWED", null, "This reporting period is outside the window for which grant routing has been reviewed.", "Accounting review of the period's revenue requirements.", "management", "prepare");
  const resolved = (a: Answer | undefined) => !!a && ["answered", "none_with_basis", "not_applicable"].includes(a.status) && enough(a.text, 8) && enough(a.evidence);
  for (const q of GRANT_ENTITY_QUESTIONS) {
    if (model !== q.when) continue;
    const a = input.entityAnswers[q.id];
    if (!resolved(a)) add(`ENTITY_QUESTION_UNRESOLVED:${q.id}`, null, `${q.label} Answer it with the records checked.`, "A management answer with evidence.", "management");
    else if (a!.flags.applies === true) add(`SPECIALISED_ROUTE_REQUIRED:${q.id}`, null, `This applies. It needs a ${q.routesTo}, which has no module here.`, `A governed workpaper covering the ${q.routesTo}.`, "management");
    else if (a!.flags.applies !== false) add(`ENTITY_QUESTION_UNRESOLVED:${q.id}`, null, `State whether "${q.label}" applies.`, "A management answer.", "management");
  }
  const ids = new Set<string>(), refs = new Set<string>();
  const figures: GrantFigures[] = [];
  let rev: bigint | null = 0n, liab: bigint | null = 0n, recv: bigint | null = 0n;
  for (const g of input.grants) {
    const where = g.reference.trim() || g.grantId;
    const before = issues.length;
    const addG = (code: string, message: string, needs: string, owner: GrantIssue["owner"] = "preparer") => add(code, g.grantId, message, needs, owner);
    if (ids.has(g.grantId)) addG("DUPLICATE_GRANT_ID", `Grant identity ${g.grantId} is used twice.`, "Remove the duplicate.");
    ids.add(g.grantId);
    if (refs.has(where)) addG("DUPLICATE_GRANT_REFERENCE", `Agreement "${where}" is recorded twice.`, "Merge the entries.");
    refs.add(where);
    if (!enough(g.agreementEvidence)) addG("AGREEMENT_EVIDENCE_MISSING", `Name the signed agreement (or other binding evidence) for "${where}".`, "The agreement or award letter, retained as evidence.");
    if (!enough(g.classificationBasis, 8) || !enough(g.classificationEvidence) || !enough(g.complexityBasis, 8)) addG("GRANT_BASIS_MISSING", `Record why "${where}" is classified as it is, and why none of the unsupported complexities applies, with the evidence.`, "Management's reading of the agreement's rights, obligations and any return clause.", "management");
    const c = g.classification;
    const valid23 = (CLASSIFICATIONS_23 as readonly string[]).includes(c), valid47 = (CLASSIFICATIONS_47 as readonly string[]).includes(c);
    if (c === "") addG("GRANT_CLASSIFICATION_REQUIRED", `Classify "${where}": restriction, condition, or the binding-arrangement model for the period. Cash received does not decide this.`, "The agreement's terms: is there an obligation to return resources, or to perform?", "management");
    else if (model !== null && ((model === "ipsas23" && !valid23) || (model === "ipsas47" && !valid47))) addG("CLASSIFICATION_PERIOD_MISMATCH", `"${c}" is not a classification available for this reporting period.`, `One of: ${(model === "ipsas23" ? CLASSIFICATIONS_23 : CLASSIFICATIONS_47).join(", ")}.`, "management");
    const cons = nat(g.considerationMinor), rec = nat(g.recognisedResourcesMinor), cash = nat(g.cashReceivedMinor), prior = nat(g.priorCumulativeRevenueMinor);
    if (cons === null || rec === null || cash === null || prior === null) addG("GRANT_AMOUNT_NOT_EXACT", `Enter exact amounts for "${where}" (type 0 only for a verified zero).`, "The agreement, receipts and prior-period schedule.");
    for (const k of COMPLEXITIES) if (g.complexities[k] === null || typeof g.complexities[k] !== "boolean") { addG("COMPLEXITY_UNANSWERED", `Say whether "${where}" involves ${COMPLEXITY_LABELS[k]}.`, "A yes/no answer for every complexity.", "management"); break; }
    if (COMPLEXITIES.some((k) => g.complexities[k] === true)) addG("COMPLEX_GRANT_WORKPAPER_REQUIRED", `"${where}" involves ${COMPLEXITIES.filter((k) => g.complexities[k] === true).map((k) => COMPLEXITY_LABELS[k]).join(", ")}; no calculation exists for that here and none is approximated.`, "A governed workpaper for the complexity.", "management");
    if (cons !== null && rec !== null && cons !== rec) addG("NOT_FULLY_FUNDED_GRANT_WORKPAPER_REQUIRED", `The agreed amount and the resources recognised for "${where}" differ; a partly funded or conditional-funding arrangement needs a governed workpaper.`, "A governed workpaper covering receivable and commitment treatment.", "management");
    if (rec !== null && cash !== null && cash > rec) addG("CASH_EXCEEDS_RECOGNISED_RESOURCES", `Cash received for "${where}" exceeds the resources recognised; an advance before recognition needs a governed workpaper.`, "Bank receipts and the date the recognition criteria were met.");
    const hasObl = WITH_OBLIGATIONS.has(c);
    let allocated = 0n, satisfied = 0n, oblOk = true;
    const oids = new Set<string>();
    for (const o of g.obligations) {
      const al = nat(o.allocatedMinor), sa = nat(o.satisfiedMinor);
      if (!enough(o.id, 1) || oids.has(o.id)) addG("DUPLICATE_OBLIGATION", `Each obligation of "${where}" needs its own identity.`, "Rename or remove.");
      oids.add(o.id);
      if (al === null || sa === null) { addG("GRANT_AMOUNT_NOT_EXACT", `Enter exact allocated and satisfied amounts for obligation "${o.label || o.id}".`, "The agreement's allocation and the delivery records."); oblOk = false; continue; }
      if (sa > al) addG("OBLIGATION_SATISFACTION_EXCEEDS_ALLOCATION", `Obligation "${o.label || o.id}" is recorded as more satisfied than allocated.`, "Correct the satisfied amount.");
      if (sa > 0n && (!(SATISFACTION_BASES as readonly string[]).includes(o.satisfactionBasis) || !enough(o.satisfactionEvidence))) addG("SATISFACTION_EVIDENCE_MISSING", `State how "${o.label || o.id}" was satisfied (milestone, output, time, or expenditure the agreement itself names) and the evidence. Spending alone is not satisfaction.`, "Delivery records, milestone sign-off or the grantor's acceptance.", "management");
      allocated += al; satisfied += sa;
    }
    if (hasObl && oblOk && (g.obligations.length === 0)) addG("OBLIGATIONS_REQUIRED", `"${where}" has obligations under its classification; record them with their allocated amounts.`, "The agreement's deliverables or conditions.");
    else if (hasObl && oblOk && cons !== null && allocated !== cons) addG("OBLIGATION_ALLOCATION_MISMATCH", `The obligations of "${where}" are allocated ${allocated} but the agreed amount is ${cons}.`, "An allocation that sums exactly to the agreed amount.");
    if (!hasObl && c !== "" && g.obligations.length > 0) addG("OBLIGATIONS_CONTRADICT_CLASSIFICATION", `"${where}" is classified as having no obligation but obligations are recorded.`, "Change the classification or remove the obligations.", "management");
    if (!enough(g.priorEvidence) && prior !== null && prior > 0n) addG("PRIOR_REVENUE_EVIDENCE_MISSING", `Name the prior-period schedule that supports the revenue already recognised for "${where}".`, "The prior period's issued or confirmed grant schedule.");
    // figures: calculated only when nothing that affects them is open; otherwise NOT computed (never defaulted)
    const mineBlockers = issues.slice(before).filter((i) => FIGURE_BLOCKERS.has(i.code));
    let f: GrantFigures = { grantId: g.grantId, cumulativeRevenueMinor: null, periodRevenueMinor: null, liabilityMinor: null, receivableMinor: null, cashReceivedMinor: cash === null ? null : cash.toString(), considerationMinor: cons === null ? null : cons.toString() };
    if (!mineBlockers.length && cons !== null && rec !== null && cash !== null && prior !== null && oblOk) {
      const cumulative = hasObl ? satisfied : rec;
      if (prior > cumulative) addG("REVENUE_REVERSAL_WORKPAPER_REQUIRED", `Revenue already recognised for "${where}" exceeds the cumulative revenue now supported; a reversal or correction needs a governed workpaper.`, "A governed workpaper (error correction, refund or change in estimate).", "management");
      else f = { ...f, cumulativeRevenueMinor: cumulative.toString(), periodRevenueMinor: (cumulative - prior).toString(), liabilityMinor: (rec - cumulative).toString(), receivableMinor: (rec - cash).toString() };
    }
    if (!g.assessmentConfirmed) addG("GRANT_ASSESSMENT_UNCONFIRMED", `A reviewer has not confirmed the assessment of "${where}" (classification, obligations, satisfaction). Until then its figures are proposals.`, "Confirmation by a reviewer, recorded against the assessment as it now stands.", "reviewer");
    figures.push(f);
    rev = rev !== null && f.periodRevenueMinor !== null ? rev + BigInt(f.periodRevenueMinor) : null;
    liab = liab !== null && f.liabilityMinor !== null ? liab + BigInt(f.liabilityMinor) : null;
    recv = recv !== null && f.receivableMinor !== null ? recv + BigInt(f.receivableMinor) : null;
  }
  if (input.grants.length === 0) {
    const a = input.entityAnswers["no_grants"];
    if (!resolved(a)) add("ENTITY_QUESTION_UNRESOLVED:no_grants", null, "No grant is recorded. Say whether the entity has any grant or donor agreement this period, with the records checked; 'no' needs a basis.", "A management answer with evidence.", "management");
    else if (a!.flags.applies !== false) add("NO_GRANTS_RECORDED", null, "The entity says it has grants, but none is recorded.", "Record each agreement.");
  }
  const tie = (code: string, label: string, mine: bigint | null, tb: string | null) => {
    const v = exact(tb);
    if (v === null) add(`${code}_UNKNOWN`, null, `The certified trial balance gives no ${label}; the grant schedule cannot be tied to it.`, "Map the account(s) in the trial balance review (a missing figure is not zero).", "preparer", "bring");
    else if (mine !== null && mine !== v) add(`${code}_DIFFERENCE`, null, `The grant schedule's ${label} (${mine}) differs from the trial balance (${v}) by ${mine - v}.`, "The journal, grant not yet recorded, or mapping that explains it. Nothing is adjusted automatically.");
  };
  tie("TB_GRANT_REVENUE", "grant revenue", rev, input.tb.revenueMinor);
  tie("TB_GRANT_LIABILITY", "unfulfilled grant obligation", liab, input.tb.liabilityMinor);
  tie("TB_GRANT_RECEIVABLE", "grant receivable", recv, input.tb.receivableMinor);
  const s = (v: bigint | null) => (v === null ? null : v.toString());
  return { contract: GRANTS_CONTRACT, model, state: issues.length ? "incomplete" : "ready-for-review", grants: figures, totals: { periodRevenueMinor: s(rev), liabilityMinor: s(liab), receivableMinor: s(recv) }, issues };
}

/* ── generated policy, note and tasks ───────────────────────────────────────────────────────────────────────────────── */
export const GRANTS_NOTE_LABEL = "Prepared from confirmed facts — review required";
export type GrantsNote = {
  label: typeof GRANTS_NOTE_LABEL; contentVersion: "ipsas-accrual-grants-note/1";
  policy: { id: string; text: string; unresolved: boolean }[];
  table: { columns: string[]; rows: { grantId: string | null; label: string; cells: (string | null)[] }[] } | null;
  bindings: Record<string, { kind: "amount"; value: string }>; unresolved: string[];
};
const CLASS_WORDS: Record<string, string> = {
  "restriction-only": "is subject to a restriction on how the resources may be used, with no obligation to return them. It is recognised as revenue when the recognition criteria are met; the restriction is disclosed and does not by itself create a liability",
  "enforceable-condition": "is subject to a condition: if the condition is not fulfilled the resources must be returned. A liability is recognised on receipt and revenue is recognised as the condition is satisfied",
  "binding-arrangement": "is governed by a binding arrangement with performance obligations. Revenue is recognised as each obligation is satisfied, and the unsatisfied part is a liability",
  "without-binding-with-present-obligation": "has no binding arrangement but gives rise to a present obligation. Revenue is recognised as the obligation is satisfied, and the unsatisfied part is a liability",
  "without-binding-no-present-obligation": "has no binding arrangement and no present obligation. It is recognised as revenue when the resources are recognised",
};
export function generateGrantsNote(input: GrantsInput, result: GrantsResult, display: { currency: string; exponent: number }, entityName: string): GrantsNote {
  const bindings: GrantsNote["bindings"] = {}, unresolved: string[] = [];
  const fmt = (ref: string, minor: string | null): string | null => { if (minor === null) return null; bindings[ref] = { kind: "amount", value: minor }; return formatEquipmentAmount(minor, display); };
  const policy: GrantsNote["policy"] = [];
  if (result.model === null) { unresolved.push("The reporting period is unknown, so the revenue requirements are not selected."); policy.push({ id: "policy.grants.basis", text: "The revenue requirements applicable to this period have not been established.", unresolved: true }); }
  else policy.push({ id: "policy.grants.basis", unresolved: false, text: `${entityName.trim()} recognises grant revenue under the ${result.model === "ipsas23" ? "requirements for non-exchange revenue that apply to reporting periods beginning before 1 January 2026" : "revenue requirements that apply to reporting periods beginning on or after 1 January 2026"}, assessed for each agreement. Cash received and expenditure incurred do not by themselves determine when revenue is recognised.` });
  const rows: NonNullable<GrantsNote["table"]>["rows"] = [];
  for (const g of input.grants) {
    const f = result.grants.find((x) => x.grantId === g.grantId)!;
    const label = g.reference.trim() || g.grantId;
    if (!g.assessmentConfirmed || f.periodRevenueMinor === null || !g.classification) {
      unresolved.push(`The assessment of "${label}" is not confirmed or not complete; no wording or figures are generated for it.`);
      policy.push({ id: `policy.grants.${g.grantId}`, text: `${label}: its classification and satisfaction await confirmation.`, unresolved: true });
      continue;
    }
    policy.push({ id: `policy.grants.${g.grantId}`, unresolved: false, text: `The grant ${label}${g.grantor.trim() ? ` from ${g.grantor.trim()}` : ""} ${CLASS_WORDS[g.classification]}.` });
    const n = (k: string, v: string | null) => fmt(`fact.grant.${g.grantId}.${k}`, v);
    rows.push({ grantId: g.grantId, label, cells: [n("consideration", f.considerationMinor), n("cash", f.cashReceivedMinor), n("cumulative", f.cumulativeRevenueMinor), n("period", f.periodRevenueMinor), n("liability", f.liabilityMinor), n("receivable", f.receivableMinor)] });
  }
  const t = result.totals;
  const table = input.grants.length ? { columns: ["Agreed", "Cash received", "Cumulative revenue", "Revenue this period", "Liability", "Receivable"], rows: [...rows,
    ...(rows.length === input.grants.length ? [{ grantId: null, label: "Total", cells: [null, null, null, fmt("fact.grants.total.period", t.periodRevenueMinor), fmt("fact.grants.total.liability", t.liabilityMinor), fmt("fact.grants.total.receivable", t.receivableMinor)] }] : [])] } : null;
  if (result.issues.length) unresolved.push(`${result.issues.length} grant matter(s) are still open; the figures above are not final.`);
  return { label: GRANTS_NOTE_LABEL, contentVersion: "ipsas-accrual-grants-note/1", policy, table, bindings, unresolved };
}

const WHY: [RegExp, string, string[]][] = [
  [/^GRANT_CLASSIFICATION|^CLASSIFICATION_PERIOD|^GRANT_BASIS|^AGREEMENT_EVIDENCE/, "Whether a grant is a restriction, a condition or a binding arrangement decides whether any of it is a liability and when revenue is recognised.", ["Grant revenue", "Unfulfilled grant obligations", "Grants note"]],
  [/^OBLIGATION|^DUPLICATE_OBLIGATION|^SATISFACTION|^REVENUE_REVERSAL|^PRIOR_REVENUE/, "Revenue follows the evidenced satisfaction of each obligation, not the cash received or money spent.", ["Grant revenue", "Unfulfilled grant obligations"]],
  [/^COMPLEX|^NOT_FULLY|^CASH_EXCEEDS|^GRANT_AMOUNT/, "This arrangement is outside what can be calculated here; it is left open rather than approximated.", ["Grant revenue", "Grants note"]],
  [/^ENTITY_QUESTION|^SPECIALISED|^PERIOD|^NO_GRANTS/, "The period's revenue requirements and any transition decide which treatment applies.", ["Grant revenue", "Comparatives"]],
  [/^TB_GRANT/, "The grant schedule has to tie to the certified trial balance before the statements can rely on it.", ["Statement of financial position", "Statement of financial performance"]],
  [/^GRANT_ASSESSMENT_UNCONFIRMED/, "A reviewer's confirmation turns the proposals into the entity's assessment.", ["Grants note"]],
];
export function grantTasks(r: GrantsResult): PrepTask[] {
  const rank = { bring: 0, prepare: 1 } as const;
  return r.issues.map((i) => {
    const hit = WHY.find(([re]) => re.test(i.code));
    return { id: `grants:${i.code}:${i.grantId ?? "entity"}`, title: i.code.replace(/:.*/, "").toLowerCase().replace(/_/g, " ").replace(/^tb /, "trial balance ").replace(/^./, (x) => x.toUpperCase()),
      missing: i.message, why: hit?.[1] ?? "This is needed before the grants can be reviewed.", acceptedEvidence: i.needs, responsible: i.owner, area: i.area, target: i.grantId ? `grants:${i.grantId}` : "grants", status: "open" as const, affects: hit?.[2] ?? ["Grants note"] };
  }).sort((a, b) => rank[a.area as "bring" | "prepare"] - rank[b.area as "bring" | "prepare"] || (a.id < b.id ? -1 : 1));
}
