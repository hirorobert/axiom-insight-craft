/**
 * IPSAS accrual property, plant and equipment — cost-model preparation (charter R1, R2, R5, G4, G5; proposed spec §8).
 * Pure and advisory: ipsas_save_preparation recalculates every figure here on the server and refuses what disagrees.
 *
 * REUSE AND ITS LIMIT. The exact-integer arithmetic (depreciation per item, class roll-forward, disposal gain/loss) is
 * framework-neutral and is reused unchanged from src/lib/preparation. What is NOT reused: the IFRS-for-SMEs 2015
 * question set, movement kinds that only exist there (OCI revaluation), the composed-statement destinations (sci.*) and
 * every section citation. This module supports ONLY the cost model on ordinary assets. Anything else is an explicit
 * blocker, never "not applicable": a revaluation model, heritage or infrastructure assets, impairment indicators,
 * held-for-sale items, public-sector combinations and investment-property transfers each need an approved native
 * module or a sufficient governed workpaper, and this slice has neither. Standards are named at standard level only;
 * paragraph-level mapping awaits the accounting content owner (UNASSIGNED) — see the implementation record.
 *
 * The entity's own estimates are required inputs. The calculator never supplies a life, rate, residual value or
 * convention, and an illustrative figure is never confirmed on the entity's behalf.
 */
import { classCharge, type DepreciationConvention, type DepreciationItem } from "../preparation/depreciation";
import type { Answer, ClassEstimate } from "../preparation/equipmentModel";
import { classRollForward, disposalResults, type BalanceSet, type ClassMovement, type DisposalItem, type RollForwardResult } from "../preparation/equipmentSchedule";

export const PPE_CONTRACT = "cfoclose-ipsas-ppe-workpaper/1";
export const PPE_CONTENT_VERSION = "ipsas-accrual-ppe-cost-model/1";

/** Movement kinds this slice can carry. The rest (OCI revaluation, combinations, investment-property transfers) are refused. */
export const SUPPORTED_MOVEMENT_KINDS = ["additions", "disposals", "impairment_profit_or_loss", "depreciation", "other"] as const;

export type PpeClassInput = {
  classId: string;
  label: string;
  accounts: string;
  measurementModel: "cost" | "revaluation" | "";
  opening: BalanceSet;
  closing: BalanceSet;
  movements: ClassMovement[];
  disposals: DisposalItem[];
  estimate: ClassEstimate;
  /** Set by the server from a recorded management confirmation; a browser value is only a preview of it. */
  estimateConfirmed: boolean;
};
/** Facts the server reads from the reviewed trial balance. null = not available, never zero. */
export type TbFacts = { ppeCarryingOpeningMinor: string | null; ppeCarryingClosingMinor: string | null; depreciationExpenseMinor: string | null };
export type PpeInput = {
  period: { start: string; end: string };
  classes: PpeClassInput[];
  entityAnswers: Record<string, Answer>;
  tb: TbFacts;
  /** Explained difference between the schedule's depreciation and the trial balance expense, if any. */
  depreciationDifference: { amountMinor: string; explanation: string; evidence: string } | null;
  convention: DepreciationConvention | "";
};

/** Entity-level questions whose answer routes the preparation. "applies: true" on the first four has no native module here. */
export const PPE_ENTITY_QUESTIONS = [
  { id: "heritage_assets", label: "Does the entity hold heritage assets?", routesTo: "IPSAS 45 heritage-asset requirements", unsupportedIfApplies: true },
  { id: "infrastructure_assets", label: "Does the entity hold infrastructure assets?", routesTo: "IPSAS 45 infrastructure-asset requirements", unsupportedIfApplies: true },
  { id: "impairment_indicators", label: "Is there any indication that an asset is impaired?", routesTo: "IPSAS 21 / IPSAS 26 impairment assessment", unsupportedIfApplies: true },
  { id: "held_for_sale", label: "Are any assets held for sale or part of a discontinued operation?", routesTo: "IPSAS 44", unsupportedIfApplies: true },
  { id: "commitments_restrictions", label: "Are there commitments to acquire assets, or restrictions on title or pledges?", routesTo: "IPSAS 45 disclosures", unsupportedIfApplies: false },
] as const;

export type PpeIssue = {
  code: string;
  classId: string | null;
  message: string;
  /** What evidence settles it. */
  needs: string;
  /** Who can answer it: a capability, not a person. */
  owner: "preparer" | "management" | "reviewer";
  area: "bring" | "prepare";
};
export type PpeClassResult = {
  classId: string;
  label: string;
  rollForward: RollForwardResult;
  chargeCalculatedMinor: string | null;
  chargeSourceMinor: string | null;
  depreciationMovementMinor: string | null;
  disposalGainMinor: string | null;
  estimateReady: boolean;
};
export type PpeResult = {
  contract: typeof PPE_CONTRACT;
  contentVersion: typeof PPE_CONTENT_VERSION;
  state: "incomplete" | "ready-for-review";
  classes: PpeClassResult[];
  totals: { openingCarryingMinor: string | null; closingCarryingMinor: string | null; depreciationMinor: string | null; disposalGainMinor: string | null };
  issues: PpeIssue[];
};

const EXACT = /^(0|-?[1-9][0-9]{0,30})$/;
const exact = (v: string | null | undefined): bigint | null => (typeof v === "string" && EXACT.test(v) ? BigInt(v) : null);
const enough = (v: string | null | undefined, n = 3) => typeof v === "string" && v.trim().length >= n;
const depreciationMovement = (c: PpeClassInput): bigint | null => {
  const m = c.movements.find((x) => x.kind === "depreciation");
  return m ? exact(m.accumulatedDepreciationMinor) : 0n;
};

export function computePpeWorkpaper(input: PpeInput): PpeResult {
  const issues: PpeIssue[] = [];
  const add = (i: PpeIssue) => issues.push(i);
  if (!input.classes.length) add({ code: "NO_ASSET_CLASSES", classId: null, message: "No asset class has been recorded.", needs: "The fixed-asset register or the prior report's PPE note.", owner: "preparer", area: "prepare" });
  const labels = new Set<string>(), ids = new Set<string>();
  const results: PpeClassResult[] = [];
  let openingSum: bigint | null = 0n, closingSum: bigint | null = 0n, depreciationSum: bigint | null = 0n, gainSum: bigint | null = 0n;

  for (const c of input.classes) {
    const where = c.label.trim() || c.classId;
    if (ids.has(c.classId)) add({ code: "DUPLICATE_CLASS_ID", classId: c.classId, message: `Class identity ${c.classId} is used twice.`, needs: "Remove the duplicate.", owner: "preparer", area: "prepare" });
    ids.add(c.classId);
    if (labels.has(where)) add({ code: "DUPLICATE_CLASS_LABEL", classId: c.classId, message: `Class "${where}" is named twice.`, needs: "Merge or rename.", owner: "preparer", area: "prepare" });
    labels.add(where);

    // 1. Measurement model: the cost model only.
    if (c.measurementModel === "") add({ code: "MEASUREMENT_MODEL_REQUIRED", classId: c.classId, message: `Record the measurement model for "${where}".`, needs: "The entity's accounting policy for this class.", owner: "management", area: "prepare" });
    else if (c.measurementModel === "revaluation" || c.estimate.basis === "revaluation") add({ code: "REVALUATION_MODEL_NOT_SUPPORTED", classId: c.classId, message: `"${where}" uses a revaluation measurement basis. This preparation supports the cost model only; a valuation workpaper is required and is not yet available.`, needs: "A governed valuation workpaper (valuer, date, method, revaluation surplus roll-forward).", owner: "management", area: "prepare" });
    else if (c.estimate.basis !== "cost") add({ code: "MEASUREMENT_BASIS_MISMATCH", classId: c.classId, message: `The estimate for "${where}" does not state the cost basis.`, needs: "Confirm the cost basis in the class estimate.", owner: "preparer", area: "prepare" });

    // 2. Movement kinds.
    for (const m of c.movements) if (!(SUPPORTED_MOVEMENT_KINDS as readonly string[]).includes(m.kind))
      add({ code: "UNSUPPORTED_MOVEMENT_KIND", classId: c.classId, message: `Movement "${m.kind}" in "${where}" has no IPSAS preparation route in this slice.`, needs: "A governed workpaper for that movement (revaluation, combination or investment-property transfer).", owner: "preparer", area: "prepare" });

    // 3. Roll-forward (opening + movements = closing, per column), with disposals itemised.
    const roll = classRollForward(where, { opening: c.opening, closing: c.closing }, c.movements, c.disposals);
    if (roll.state === "incomplete") for (const p of roll.problems) add({ code: "ROLL_FORWARD_INCOMPLETE", classId: c.classId, message: p, needs: "The register or ledger movement that supports the figure.", owner: "preparer", area: "prepare" });
    else if (roll.state === "difference") for (const p of roll.problems) add({ code: "ROLL_FORWARD_DIFFERENCE", classId: c.classId, message: p, needs: "The missing movement, with its register or journal reference. Nothing is inferred.", owner: "preparer", area: "prepare" });

    // 4. Depreciation: the entity's estimate drives a recalculation; the schedule's movement must agree or be explained.
    const e = c.estimate;
    const depMove = depreciationMovement(c);
    let calc: string | null = null, source: string | null = null;
    if (e.chargeSource === "calculated") {
      if (input.convention === "") add({ code: "CONVENTION_REQUIRED", classId: c.classId, message: "Record the entity's part-period depreciation convention.", needs: "The accounting policy (daily, or whole-period).", owner: "management", area: "prepare" });
      const r = classCharge(e.items, input.period, input.convention);
      if (r.state === "calculated") {
        calc = r.chargeMinor; source = r.chargeMinor;
        // The item register must be the class: every item's cost, and its opening accumulated depreciation, tie to the schedule.
        const additions = c.movements.find((m) => m.kind === "additions");
        const itemCost = e.items.reduce((n, i) => n + (exact(i.costMinor) ?? 0n), 0n);
        const itemOpeningAcc = e.items.reduce((n, i) => n + (exact(i.openingAccumulatedMinor) ?? 0n), 0n);
        const og = exact(c.opening.grossMinor), ad = additions ? exact(additions.grossMinor) : 0n, oa = exact(c.opening.accumulatedDepreciationMinor);
        if (og !== null && ad !== null && itemCost !== og + ad) add({ code: "ITEMS_COST_NOT_CLASS_GROSS", classId: c.classId, message: `The items listed for "${where}" cost ${itemCost}, but opening gross plus additions is ${og + ad}.`, needs: "A complete item register for the class (every item, including those disposed of in the period).", owner: "preparer", area: "prepare" });
        if (oa !== null && itemOpeningAcc !== oa) add({ code: "ITEMS_ACCUMULATED_NOT_CLASS_OPENING", classId: c.classId, message: `Opening accumulated depreciation on the items (${itemOpeningAcc}) differs from the class opening (${oa}).`, needs: "The register's accumulated depreciation at the start of the period.", owner: "preparer", area: "prepare" });
      } else {
        for (const it of r.items) if (it.result.state === "insufficient") add({ code: "ESTIMATE_MISSING", classId: c.classId, message: `"${it.label || where}": still needed — ${it.result.missing.join("; ")}.`, needs: "Management's own estimate (life or rate, residual value, available-for-use date) with its basis. No default is supplied.", owner: "management", area: "prepare" });
        if (!r.items.length) add({ code: "ESTIMATE_MISSING", classId: c.classId, message: `List the depreciable items of "${where}" with the entity's life, residual value and available-for-use date.`, needs: "Fixed-asset register and management's estimates.", owner: "management", area: "prepare" });
      }
    } else if (e.chargeSource === "register") {
      const reg = exact(e.registerChargeMinor);
      if (reg === null || reg < 0n || !enough(e.registerReference)) add({ code: "REGISTER_CHARGE_INCOMPLETE", classId: c.classId, message: `State the register's depreciation charge for "${where}" and name the register.`, needs: "The register's depreciation report.", owner: "preparer", area: "prepare" });
      else source = reg.toString();
    } else add({ code: "CHARGE_SOURCE_REQUIRED", classId: c.classId, message: `Say whether the charge for "${where}" is calculated here from the entity's estimates or taken from a register.`, needs: "A decision by the preparer.", owner: "preparer", area: "prepare" });

    let chargeDiff: bigint | null = null;
    if (depMove === null) add({ code: "DEPRECIATION_MOVEMENT_NOT_EXACT", classId: c.classId, message: `The depreciation movement of "${where}" is not an exact amount.`, needs: "The ledger or register amount.", owner: "preparer", area: "prepare" });
    else if (source !== null) {
      chargeDiff = depMove - BigInt(source);
      if (chargeDiff !== 0n) {
        const d = e.chargeDifference, stated = exact(d.amountMinor);
        if (stated === null || stated !== chargeDiff || !enough(d.explanation) || !enough(d.evidence))
          add({ code: "CHARGE_DIFFERENCE_UNEXPLAINED", classId: c.classId, message: `The schedule charges ${depMove} for "${where}" but the ${e.chargeSource === "calculated" ? "calculation" : "register"} gives ${source} (difference ${chargeDiff}). Explain exactly this difference; it is not adjusted automatically.`, needs: "An explanation with evidence for exactly the difference.", owner: "preparer", area: "prepare" });
      }
    }

    // 5. Estimate confirmation (a decision by management, recorded by the server).
    const estimateReady = e.chargeSource !== "" && c.estimateConfirmed;
    if (!c.estimateConfirmed) add({ code: "ESTIMATE_UNCONFIRMED", classId: c.classId, message: `Management has not confirmed the useful lives, methods and residual values for "${where}". Until it does they are proposals.`, needs: "Confirmation by a responsible person, recorded against the estimate as it now stands.", owner: "management", area: "prepare" });
    if (!enough(e.rationale, 8) || !enough(e.evidence)) add({ code: "ESTIMATE_BASIS_MISSING", classId: c.classId, message: `Record the basis of the estimates for "${where}" (usage, wear, obsolescence, legal limits) and the evidence reviewed.`, needs: "Management's assessment and supporting records.", owner: "management", area: "prepare" });

    // 6. Disposals: proceeds unknown is not zero.
    const disp = disposalResults(c.disposals);
    if (disp.unresolved > 0) add({ code: "DISPOSAL_PROCEEDS_UNKNOWN", classId: c.classId, message: `${disp.unresolved} disposal(s) in "${where}" have unknown proceeds or carrying amount; the gain or loss is not computed.`, needs: "Sale agreement, receipt or write-off authority for each item.", owner: "preparer", area: "prepare" });

    const op = exact(c.opening.carryingMinor), cl = exact(c.closing.carryingMinor);
    openingSum = openingSum !== null && op !== null ? openingSum + op : null;
    closingSum = closingSum !== null && cl !== null ? closingSum + cl : null;
    depreciationSum = depreciationSum !== null && depMove !== null ? depreciationSum + depMove : null;
    gainSum = gainSum !== null && disp.unresolved === 0 ? gainSum + BigInt(disp.totalGainMinor ?? "0") : null;
    results.push({ classId: c.classId, label: where, rollForward: roll, chargeCalculatedMinor: calc, chargeSourceMinor: source, depreciationMovementMinor: depMove === null ? null : depMove.toString(), disposalGainMinor: disp.unresolved === 0 ? (disp.totalGainMinor ?? "0") : null, estimateReady });
  }

  // 7. Ties to the reviewed trial balance. Unknown stays unknown.
  const tie = (code: string, label: string, schedule: bigint | null, tb: string | null) => {
    const tbv = exact(tb);
    if (tbv === null) add({ code: `${code}_UNKNOWN`, classId: null, message: `The reviewed trial balance gives no ${label}; the schedule cannot be tied to it.`, needs: "Map the account(s) in the trial balance review (a missing figure is not zero).", owner: "preparer", area: "bring" });
    else if (schedule !== null && schedule !== tbv) add({ code: `${code}_DIFFERENCE`, classId: null, message: `The schedule's ${label} (${schedule}) differs from the trial balance (${tbv}) by ${schedule - tbv}.`, needs: "The journal, register correction or mapping that explains the difference.", owner: "preparer", area: "prepare" });
  };
  tie("TB_CARRYING_OPENING", "opening PPE carrying amount", openingSum, input.tb.ppeCarryingOpeningMinor);
  tie("TB_CARRYING_CLOSING", "closing PPE carrying amount", closingSum, input.tb.ppeCarryingClosingMinor);
  const tbDep = exact(input.tb.depreciationExpenseMinor);
  if (tbDep === null) tie("TB_DEPRECIATION", "depreciation expense", depreciationSum, null);
  else if (depreciationSum !== null && depreciationSum !== tbDep) {
    const d = input.depreciationDifference, diff = depreciationSum - tbDep, stated = d ? exact(d.amountMinor) : null;
    if (!d || stated !== diff || !enough(d.explanation) || !enough(d.evidence))
      add({ code: "TB_DEPRECIATION_DIFFERENCE", classId: null, message: `Depreciation in the schedule (${depreciationSum}) differs from the trial balance expense (${tbDep}) by ${diff}. Explain exactly this difference (for example capitalised depreciation or a different expense line).`, needs: "An explanation with evidence for exactly the difference.", owner: "preparer", area: "prepare" });
  }

  // 8. Entity questions: each is answered explicitly; "applies" on a question without a module is a blocker, not an exclusion.
  for (const q of PPE_ENTITY_QUESTIONS) {
    const a = input.entityAnswers[q.id];
    const resolved = !!a && (a.status === "answered" || a.status === "none_with_basis" || a.status === "not_applicable") && enough(a.text, 8) && enough(a.evidence);
    if (!resolved) add({ code: `ENTITY_QUESTION_UNRESOLVED:${q.id}`, classId: null, message: `${q.label} Answer it with the evidence reviewed — "no" needs a basis too.`, needs: "A management answer with the records checked.", owner: "management", area: "prepare" });
    else if (q.unsupportedIfApplies && a.flags.applies === true) add({ code: `SPECIALISED_ROUTE_REQUIRED:${q.id}`, classId: null, message: `This applies to the entity. It needs ${q.routesTo}, which has no native module in this slice.`, needs: `A governed workpaper covering ${q.routesTo}.`, owner: "management", area: "prepare" });
    else if (q.unsupportedIfApplies && a.flags.applies !== false) add({ code: `ENTITY_QUESTION_UNRESOLVED:${q.id}`, classId: null, message: `State whether "${q.label}" applies (yes or no).`, needs: "A management answer.", owner: "management", area: "prepare" });
  }

  const s = (v: bigint | null) => (v === null ? null : v.toString());
  return { contract: PPE_CONTRACT, contentVersion: PPE_CONTENT_VERSION, state: issues.length ? "incomplete" : "ready-for-review", classes: results, totals: { openingCarryingMinor: s(openingSum), closingCarryingMinor: s(closingSum), depreciationMinor: s(depreciationSum), disposalGainMinor: s(gainSum) }, issues };
}

export type { DepreciationItem };
