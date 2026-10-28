/**
 * Original preparation questions for equipment under the IFRS for SMEs 2015 edition, with the triggers that make a
 * follow-up applicable. Paragraph references were re-read against the pinned 2015 text on 2026-10-27; the wording is
 * the product's own, not the Standard's. Status: independent accounting review pending (no reviewer is named). This
 * module decides which questions apply and whether each is resolved; it never decides an accounting treatment.
 */
import { classRollForward, disposalResults, movementCarryingMinor, value } from "./equipmentSchedule";
import { classCharge, DEPRECIATION_METHODS, DEPRECIATION_CONVENTIONS } from "./depreciation";
import type { Answer, AnswerStatus, ClassEstimate, EquipmentClass, EquipmentPreparationV2 } from "./equipmentModel";

export const EQUIPMENT_QUESTIONS_VERSION = "sme-2015-equipment-questions/2";
export const EQUIPMENT_SOURCE_V2 = {
  framework: "ifrs-for-smes/2015",
  text: "IFRS for SMEs (2015 edition), Section 17 and the sections it depends on; paragraph numbers are the Standard's",
  sha256: "acc6500e58f9090eddc8e2b55bc531f93e718d320c7c40c695898bb82235eb9f",
  checkedOn: "2026-10-27",
  status: "primary-text-checked; independent-accountant-review-pending",
} as const;

export type QuestionKind = "mandatory" | "mandatory-when-applicable" | "entity-decision";
export type QuestionScope = "entity" | "class";
export type QuestionDefinition = {
  id: string;
  scope: QuestionScope;
  refs: readonly string[];
  kind: QuestionKind;
  question: string;
  purpose: string;
  evidence: string;
  /** Yes/no parts of the answer that make a follow-up applicable. */
  flags?: readonly { key: string; label: string }[];
  /** Resolved from the structured fields rather than a written answer. */
  structured?: "balances" | "movements" | "estimate" | "disposals" | "estimate-change" | "classes";
  /** Present on a follow-up: applies only when it returns true. */
  trigger?: (ctx: TriggerContext) => boolean;
};
type TriggerContext = { cls: EquipmentClass | null; entity: Record<string, Answer> };
const flag = (a: Answer | undefined, key: string) => !!a && a.status === "answered" && a.flags[key] === true;
const movementNonZero = (cls: EquipmentClass | null, kind: string) => !!cls && cls.movements.some((m) => m.kind === kind && movementCarryingMinor(m) !== null && movementCarryingMinor(m) !== "0");

export const EQUIPMENT_QUESTIONS_V2: readonly QuestionDefinition[] = Object.freeze([
  // ── Entity level, every period ──
  { id: "classes", scope: "entity", refs: ["4.11(a)", "17.31"], kind: "mandatory", structured: "classes",
    question: "Which classes of equipment does the entity report, and which accounts belong to each?",
    purpose: "Each class is disclosed separately; every equipment account must sit in exactly one class.",
    evidence: "Fixed asset register headings; the presentation assignments of the equipment accounts." },
  { id: "restrictions_security", scope: "entity", refs: ["17.32(a)"], kind: "mandatory-when-applicable",
    question: "Is any equipment used as security for a loan, or does someone else hold title to it or restrict its use? If yes, which items and what is their carrying amount?",
    purpose: "Restricted title and pledged items are disclosed with their carrying amounts.",
    evidence: "Loan agreements and security schedules, charge or lien registers, board minutes. For none: a dated confirmation naming who checked." },
  { id: "commitments", scope: "entity", refs: ["17.32(b)"], kind: "mandatory-when-applicable",
    question: "Has the entity signed contracts to buy equipment that had not been delivered by the year end? If yes, for what total amount?",
    purpose: "Contractual commitments to acquire equipment are disclosed; they are not in the schedule.",
    evidence: "Signed purchase orders or contracts. For none: a dated confirmation naming who checked." },
  { id: "impairment", scope: "entity", refs: ["17.24", "17.26", "27.7", "27.9"], kind: "mandatory",
    flags: [{ key: "indicator_present", label: "At least one sign of impairment exists" }],
    question: "At the reporting date, is there any sign that equipment is worth less than its carrying amount (damage, obsolescence, idle items, a plan to sell earlier than expected, a market fall)? The assessment itself is required every period.",
    purpose: "The impairment assessment is mandatory at each reporting date; measurement follows only when an indicator exists.",
    evidence: "An indicator checklist signed by management covering the 27.9 indicators; for none: who checked and when." },
  { id: "impairment_measurement", scope: "entity", refs: ["27.5", "27.8", "27.21", "27.30", "27.32"], kind: "mandatory-when-applicable",
    trigger: (c) => flag(c.entity.impairment, "indicator_present"),
    question: "For each item or group with an indicator: what is the recoverable amount, who prepared it, and what loss (or reversal, capped at the carrying amount that would have existed without the earlier loss) is recognised and in which income statement line?",
    purpose: "A loss is recognised only when the recoverable amount is below the carrying amount; the amount and its line item are disclosed per class.",
    evidence: "A recoverable-amount working (a governed workpaper), the impairment movement in the schedule, the line item in the statement of comprehensive income." },
  { id: "events_after", scope: "entity", refs: ["32.10", "32.11(c)"], kind: "mandatory",
    question: "After the year end but before these statements are authorised, did the entity buy, sell, lose or commit to major equipment?",
    purpose: "Non-adjusting events are disclosed by nature and financial effect; this answer feeds the events-after-the-period note decision.",
    evidence: "Board minutes, contracts, insurance claims after the year end. For none: who checked and when." },
  { id: "framework_history", scope: "entity", refs: ["35.7", "35.10(c)", "35.10(d)"], kind: "mandatory",
    flags: [{ key: "first_smes_statements", label: "These are the entity's first IFRS for SMEs financial statements" }],
    question: "Are these the entity's first financial statements under the IFRS for SMEs?",
    purpose: "First-time adoption changes the opening bridge (a transition adjustment) and requires the Section 35 disclosures.",
    evidence: "The prior-year statements' basis of preparation; the adoption decision." },
  { id: "transition", scope: "entity", refs: ["35.7", "35.10(c)", "35.10(d)", "35.13"], kind: "mandatory-when-applicable",
    trigger: (c) => flag(c.entity.framework_history, "first_smes_statements"),
    question: "Did the entity elect fair value or a previous revaluation as deemed cost for any equipment at the transition date? What is the effect on equity at the transition date and at the end of the latest prior period?",
    purpose: "The deemed-cost election becomes the gross carrying amount basis and the transition effect is explained.",
    evidence: "The transition working; the valuation used as deemed cost." },
  // ── Per class, every period ──
  { id: "recognition", scope: "class", refs: ["17.4", "2.27", "17.5"], kind: "mandatory",
    flags: [
      { key: "spares_held", label: "The class includes spare parts, stand-by or servicing equipment" },
      { key: "items_not_owned", label: "Some items are used but not owned (leased or similar)" },
      { key: "grant_or_donation", label: "Some items were funded by a government grant or donated" },
    ],
    question: "Does the entity own, or have the right to use and keep the benefits of, every item in this class? List the documents that show this and what each item cost.",
    purpose: "The recognition basis per item before any figure enters the schedule; items without documents stay open tasks, never balancing assets.",
    evidence: "Purchase invoices and receipts, title or registration documents, delivery and commissioning records, signed lease or grant agreements, the fixed asset register. Not accepted: a trial-balance balance alone." },
  { id: "components", scope: "class", refs: ["17.16", "17.6"], kind: "mandatory-when-applicable",
    flags: [{ key: "components_identified", label: "Yes: at least one major part is depreciated separately" }],
    question: "Does any item have a major part that will need replacing well before the rest of it? If yes, list each such part with its cost and how long it is expected to last. If no, say why (for example: items are low value or uniform).",
    purpose: "Whether component depreciation applies; each identified component gets its own life in the estimates.",
    evidence: "Register at component level, supplier cost breakdown, maintenance or replacement plan." },
  { id: "basis", scope: "class", refs: ["17.15", "17.15A", "17.15B"], kind: "entity-decision", structured: "estimate",
    question: "After buying equipment, does the entity keep this class at what it cost (less depreciation and any impairment), or does it regularly revalue it to its current value? The same choice applies to every item in the class.",
    purpose: "The measurement basis per class (17.31(a); policy note 8.5(a)).",
    evidence: "The written accounting policy approved by management; for revaluation, the valuation report." },
  { id: "estimates", scope: "class", refs: ["17.18", "17.19", "17.20", "17.21"], kind: "entity-decision", structured: "estimate",
    question: "For how many years (or how many units of output, if usage drives wear) does the entity expect to use this class, and what does it expect to receive for the items at the end of that time? Record the factors considered: expected usage, wear and maintenance, obsolescence, legal or contractual limits.",
    purpose: "The entity's own useful lives and residual values (17.31(c); estimates note 8.7). A tax class, a template or last year's note is not an estimate.",
    evidence: "Replacement plan or capital budget, maintenance records, lease or licence terms, history of disposals of similar items, a signed management representation." },
  { id: "method", scope: "class", refs: ["17.22", "17.23"], kind: "entity-decision", structured: "estimate",
    question: "Does the entity use up the benefit of this class evenly each year (straight-line), more in the early years (reducing balance), or in line with how much it produces (units of production)? Has the way it is used changed since last year?",
    purpose: "The depreciation method per class (17.31(b)) and the review of its pattern.",
    evidence: "Usage or output records (required for units of production, with the total expected capacity), the prior-year policy, maintenance patterns." },
  { id: "gross", scope: "class", refs: ["17.31(d)"], kind: "mandatory", structured: "balances",
    question: "At the start and at the end of the year: what was the total cost of this class before any depreciation, how much depreciation had been charged on it in total, and how much impairment had been recognised in total? Leave a box empty if you do not know; type 0 only if the register shows zero.",
    purpose: "The gross carrying amount and accumulated deductions at both dates, agreed to the carrying amounts.",
    evidence: "Fixed asset register totals at both dates; the prior-year equipment note for the opening amounts." },
  { id: "movements", scope: "class", refs: ["17.31(e)"], kind: "mandatory", structured: "movements",
    question: "What happened to this class during the year? For each kind of change give the cost, accumulated depreciation and impairment affected, and the record it comes from. The difference between two trial balances is not an answer.",
    purpose: "The reconciliation of the carrying amount with a source per movement; the gross roll-forward is checked, not only the net.",
    evidence: "Fixed asset register movement report, identified and reviewed ledger movement accounts, journals, disposal records." },
  // ── Per class, conditional ──
  { id: "addition_cost", scope: "class", refs: ["17.9", "17.10", "17.11", "17.12", "17.20", "25.2"], kind: "mandatory-when-applicable",
    trigger: (c) => movementNonZero(c.cls, "additions") || movementNonZero(c.cls, "business_combinations"),
    flags: [
      { key: "replacement_or_inspection", label: "An addition replaced a part or was a major inspection" },
      { key: "deferred_or_exchange", label: "An addition was paid beyond normal credit terms, or acquired by giving up another asset" },
      { key: "dismantling_obligation", label: "The entity must dismantle an item or restore its site when use ends" },
      { key: "expensed_items_included", label: "Start-up, training, advertising, administration or interest costs are inside the capitalised amount" },
    ],
    question: "What is included in the cost of each addition (price after discounts, duties, delivery, installation, testing)? When was each item ready for use? Under the 2015 edition, start-up, training, advertising, administration and interest costs are expensed, not capitalised.",
    purpose: "The elements of cost at recognition and the available-for-use date that starts depreciation.",
    evidence: "Invoices, import documents, commissioning records." },
  { id: "replacement", scope: "class", refs: ["17.6", "17.7"], kind: "mandatory-when-applicable",
    trigger: (c) => !!c.cls && flag(c.cls.answers.addition_cost, "replacement_or_inspection"),
    question: "What part or inspection was replaced, and what was the remaining carrying amount of the part or previous inspection it replaced? That carrying amount is derecognised (shown as a disposal or other change with evidence).",
    purpose: "Replacement capitalised, the replaced part derecognised; routine servicing stays an expense.",
    evidence: "Invoices; the register entry for the replaced part (or the replacement cost as an indication when impracticable)." },
  { id: "deferred_payment", scope: "class", refs: ["17.13", "17.14", "11.13"], kind: "mandatory-when-applicable",
    trigger: (c) => !!c.cls && flag(c.cls.answers.addition_cost, "deferred_or_exchange"),
    question: "What is the cash price today (or the fair value of the asset given up), and how was it determined? The schedule shows that amount, not the nominal contract price; the difference is a finance cost.",
    purpose: "Cost at the cash price equivalent or fair value; the financing element presented separately.",
    evidence: "Contract and payment terms; the discount-rate or fair-value working." },
  { id: "dismantling", scope: "class", refs: ["17.10(c)", "21.4", "21.5", "21.14"], kind: "mandatory-when-applicable",
    trigger: (c) => !!c.cls && flag(c.cls.answers.addition_cost, "dismantling_obligation"),
    question: "What will the dismantling or restoration cost, when, and is the obligation recorded as a provision? The present value forms part of the asset's cost and the provision appears in the provisions schedule in the same period.",
    purpose: "The dismantling estimate in the cost of the asset and the matching provision.",
    evidence: "Lease or licence terms, environmental obligations, the estimate and discounting working, the provisions schedule." },
  { id: "spares", scope: "class", refs: ["17.5"], kind: "mandatory-when-applicable",
    trigger: (c) => !!c.cls && flag(c.cls.answers.recognition, "spares_held"),
    question: "Which spare parts, stand-by or servicing items are expected to be used over more than one year (equipment), and which are inventory?",
    purpose: "Spares that meet the definition are equipment; the rest are inventory.",
    evidence: "Inventory and register listings; the expected period of use." },
  { id: "lease", scope: "class", refs: ["20.9", "20.10", "20.12", "20.13"], kind: "mandatory-when-applicable",
    trigger: (c) => !!c.cls && flag(c.cls.answers.recognition, "items_not_owned"),
    question: "Does the lease transfer substantially all the risks and rewards of ownership? If yes: fair value, present value of minimum payments, lease term, and whether ownership transfers at the end; the asset is depreciated over the shorter of the lease term and its useful life unless ownership is reasonably certain, and its net carrying amount per class is disclosed.",
    purpose: "Finance-lease equipment recognised at the lower of fair value and present value, depreciated under this section, disclosed per class.",
    evidence: "Lease agreement, payment schedule, the rate used." },
  { id: "grant", scope: "class", refs: ["24.4", "24.5", "24.6"], kind: "mandatory-when-applicable",
    trigger: (c) => !!c.cls && flag(c.cls.answers.recognition, "grant_or_donation"),
    question: "What conditions attach to the grant, and has it been recognised in income (when receivable, or when the conditions are met) or as a liability? The asset is shown at the fair value received, never net of the grant.",
    purpose: "Grant recognition and the 24.6 disclosures; the asset is not reduced by the grant under the 2015 edition.",
    evidence: "Grant agreement; the fair value of the asset received." },
  { id: "disposals", scope: "class", refs: ["17.27", "17.28", "17.29", "17.30"], kind: "mandatory-when-applicable", structured: "disposals",
    trigger: (c) => movementNonZero(c.cls, "disposals"),
    question: "For each item sold, scrapped or lost: date, original cost, depreciation to date, money received. The gain or loss is proceeds less carrying amount, in profit or loss (not revenue).",
    purpose: "Derecognition at the carrying amount, the gain or loss from confirmed proceeds, and the gross roll-forward through the disposal.",
    evidence: "Sale agreement, receipt, scrapping record, the register entry." },
  { id: "estimate_change", scope: "class", refs: ["17.19", "17.23", "10.16", "10.18"], kind: "mandatory-when-applicable", structured: "estimate-change",
    trigger: (c) => !!c.cls && c.cls.estimate.changedSincePrior === "yes",
    question: "What changed in the useful life, residual value or method, what is the new estimate, and what is the effect on this year's depreciation? The change applies prospectively; prior years are not restated.",
    purpose: "The nature and current-period effect of a change in estimate, disclosed in the notes.",
    evidence: "The revised schedule; evidence of the indicator (changed use, wear, technology, prices)." },
  { id: "revaluation", scope: "class", refs: ["17.15B", "17.15C", "17.15D", "17.33"], kind: "mandatory-when-applicable",
    trigger: (c) => !!c.cls && c.cls.estimate.basis === "revaluation",
    question: "For the revalued class: (a) the effective date of the valuation; (b) whether an independent valuer was involved; (c) the methods and main assumptions; (d) the carrying amount under the cost model; (e) the revaluation surplus at the start and end of the year and any restriction on its distribution. Revaluation gains go to other comprehensive income, which this product cannot yet finalise.",
    purpose: "The 17.33 disclosures; an explicit stop at the unsupported other-comprehensive-income case.",
    evidence: "Valuation report, surplus ledger, cost-model shadow register." },
]);

const hasText = (v: string | null | undefined) => typeof v === "string" && v.trim().length >= 3;

/** A reference to a tax class, a rate table or a template is an example, never the entity's estimate (17.18, 17.21). */
export function entityEstimateTextProblem(text: string): string | null {
  const t = text.toLowerCase();
  const patterns: [RegExp, string][] = [
    [/\b(tra|tax)\s+(class|rate|table|allowance)/i, "a tax class or rate"],
    [/\bwear\s*(and|&)\s*tear\b/i, "a wear-and-tear allowance"],
    [/\bclass\s+[1-8]\s*\(?\d{1,2}(\.\d)?\s*%/i, "a tax class rate"],
    [/\b(kpmg|deloitte|pwc|ernst|ey|bdo|grant thornton)\b/i, "an illustrative firm template"],
    [/\btemplate\b|\billustrative\b|\bmodel\s+financial\s+statements\b/i, "a template"],
    [/\bper\s+last\s+year'?s?\s+note\b|\bcopied\s+from\s+last\s+year\b/i, "last year's note copied without reassessment"],
  ];
  for (const [re, what] of patterns) if (re.test(t)) return `This reads as ${what}; the useful life and residual value must be the entity's own estimate of expected use.`;
  return null;
}

/** Problems with a written answer; "none" needs the person who checked and the evidence. */
export function answerProblems(a: Answer | undefined, def: QuestionDefinition): string[] {
  if (!a || a.status === "unresolved") return ["Not yet answered."];
  const out: string[] = [];
  if (a.status === "answered" && !hasText(a.text)) out.push("Write the answer.");
  if (a.status === "answered" && !hasText(a.evidence)) out.push("Name the supporting record.");
  if (a.status === "none_with_basis" && (!hasText(a.checkedBy) || !hasText(a.evidence))) out.push("'None' needs who checked and what was checked.");
  if (a.status === "not_applicable" && !hasText(a.text)) out.push("Say why this does not apply.");
  if (def.id === "addition_cost" && a.flags.expensed_items_included === true) out.push("Start-up, training, advertising, administration and interest costs are expensed under the 2015 edition (17.11, 25.2): remove them from the capitalised amount before continuing.");
  return out;
}

/** Completeness of a class's structured estimate (17.18–17.23); a text that cites a tax class or template is refused. */
export function estimateProblems(e: ClassEstimate, componentsIdentified: boolean): string[] {
  const out: string[] = [];
  if (!["cost", "revaluation"].includes(e.basis)) out.push("Choose the measurement basis for the whole class.");
  if (!(DEPRECIATION_METHODS as readonly string[]).includes(e.method)) out.push("Choose the depreciation method.");
  if (e.method === "straight-line" && !/^\d{1,15}(\.\d{1,6})?$/.test(e.lifeYears.trim()) ) out.push("Enter the useful life in years as a number.");
  if (e.method === "straight-line" && /^0+(\.0+)?$/.test(e.lifeYears.trim())) out.push("A useful life of zero is not an estimate.");
  if (e.method === "reducing-balance" && !/^\d{1,15}(\.\d{1,6})?$/.test(e.ratePercent.trim())) out.push("Enter the annual rate as a percentage number.");
  if (e.method === "units-of-production" && (!/^\d{1,15}(\.\d{1,6})?$/.test(e.totalUnits.trim()) || !/^\d{1,15}(\.\d{1,6})?$/.test(e.unitsThisPeriod.trim()))) out.push("Enter the total expected output and this period's output.");
  if (value(e.residualMinor) === null || e.residualMinor.startsWith("-")) out.push("Enter the residual value as an amount (0 only if the entity genuinely expects nothing).");
  if (!(DEPRECIATION_CONVENTIONS as readonly string[]).includes(e.convention)) out.push("Record the entity's part-year convention (full period or daily).");
  if (!(["calculated", "register"] as readonly string[]).includes(e.chargeSource)) out.push("Say where the period's depreciation charge comes from: this calculation, or an external register.");
  if (e.chargeSource === "register" && (!hasText(e.registerReference) || value(e.registerChargeMinor) === null)) out.push("Name the register and its charge for the period.");
  if (e.chargeSource === "calculated" && e.items.length === 0) out.push("Add the assets or components the charge is calculated from.");
  if (e.chargeSource === "calculated" && componentsIdentified && e.items.length < 2) out.push("Components were identified: list each component with its own cost and life.");
  if (!["yes", "no"].includes(e.changedSincePrior)) out.push("Say whether the life, residual value or method changed since last year.");
  if (e.changedSincePrior === "yes" && (!hasText(e.changeDescription) || value(e.changeEffectMinor) === null)) out.push("Describe the change and its effect on this year's depreciation.");
  if (!hasText(e.rationale)) out.push("Explain why these estimates reflect the entity's expected use.");
  if (!hasText(e.evidence)) out.push("Name the evidence supporting the estimates.");
  for (const t of [e.rationale, e.evidence, e.factors.usage, e.factors.wear, e.factors.obsolescence, e.factors.legalLimits, e.lifeYears, e.registerReference]) { const p = entityEstimateTextProblem(t); if (p) { out.push(p); break; } }
  return out;
}

/**
 * The schedule's depreciation for a class must be its charge — the register's figure, or the calculation over the
 * items — or the difference must be explained and evidenced for exactly that amount. Mirrors the server's
 * DEPRECIATION_CHARGE_MISMATCH / CHARGE_DIFFERENCE_MISMATCH / CHARGE_NOT_CALCULABLE refusals.
 */
export function chargeConsistencyProblems(cls: EquipmentClass, period: { start: string; end: string } | null): { problems: string[]; expectedMinor: string | null; scheduleMinor: string | null; differenceMinor: string | null } {
  const e = cls.estimate;
  const dep = cls.movements.find((m) => m.kind === "depreciation");
  const schedule = dep ? value(dep.accumulatedDepreciationMinor) : 0n;
  let expected: bigint | null = null;
  const problems: string[] = [];
  if (e.chargeSource === "register") expected = value(e.registerChargeMinor);
  else if (e.chargeSource === "calculated") {
    if (!period) problems.push("The reporting period dates are needed to calculate the charge.");
    else {
      const r = classCharge(e.items, period, e.convention);
      if (r.state === "calculated") expected = BigInt(r.chargeMinor);
      else problems.push(`The charge cannot be calculated yet: ${r.items.filter((i) => i.result.state === "insufficient").map((i) => `${i.label || "item"} needs ${(i.result as { missing: string[] }).missing.join(", ")}`).join("; ") || "add the assets or components"}.`);
    }
  }
  if (expected === null || schedule === null) return { problems, expectedMinor: expected === null ? null : expected.toString(), scheduleMinor: schedule === null ? null : schedule.toString(), differenceMinor: null };
  const diff = schedule - expected;
  if (diff !== 0n) {
    const d = e.chargeDifference;
    if (value(d.amountMinor) === null || !hasText(d.explanation) || !hasText(d.evidence)) problems.push(`The schedule's depreciation (${schedule}) differs from the ${e.chargeSource === "register" ? "register's" : "calculated"} charge (${expected}) by ${diff}: explain the difference and name its evidence, or correct the schedule. Nothing is adjusted for you.`);
    else if (BigInt(d.amountMinor) !== diff) problems.push(`The explained difference (${d.amountMinor}) is not the actual difference (${diff}).`);
  }
  return { problems, expectedMinor: expected.toString(), scheduleMinor: schedule.toString(), differenceMinor: diff.toString() };
}

export type EvaluatedQuestion = {
  def: QuestionDefinition;
  classId: string | null;
  classLabel: string | null;
  status: AnswerStatus | "resolved";
  resolved: boolean;
  problems: string[];
};

/**
 * The applicable questions for the whole preparation, each with its resolution. Only unanswered applicable questions
 * need attention (charter 11.5); a confirmed answer is reused by every output that depends on it.
 */
export function evaluateQuestions(prep: EquipmentPreparationV2, period: { start: string; end: string }): EvaluatedQuestion[] {
  const out: EvaluatedQuestion[] = [];
  const entity = prep.entityAnswers;
  for (const def of EQUIPMENT_QUESTIONS_V2) {
    if (def.scope !== "entity") continue;
    if (def.trigger && !def.trigger({ cls: null, entity })) continue;
    if (def.structured === "classes") {
      const problems: string[] = [];
      if (!prep.classes.length) problems.push("Add at least one class.");
      for (const c of prep.classes) if (!hasText(c.label)) problems.push("Name every class."); else if (!hasText(c.accounts)) problems.push(`Name the accounts that make up ${c.label}.`);
      const labels = prep.classes.map((c) => c.label.trim());
      if (new Set(labels).size !== labels.length) problems.push("Class names must be unique.");
      out.push({ def, classId: null, classLabel: null, status: problems.length ? "unresolved" : "resolved", resolved: !problems.length, problems });
      continue;
    }
    const a = entity[def.id];
    const problems = answerProblems(a, def);
    out.push({ def, classId: null, classLabel: null, status: a?.status ?? "unresolved", resolved: !problems.length, problems });
  }
  for (const cls of prep.classes) {
    const roll = classRollForward(cls.label, { opening: cls.opening, closing: cls.closing }, cls.movements, cls.disposals);
    for (const def of EQUIPMENT_QUESTIONS_V2) {
      if (def.scope !== "class") continue;
      if (def.trigger && !def.trigger({ cls, entity })) continue;
      let problems: string[] = [];
      let status: EvaluatedQuestion["status"] = "resolved";
      if (def.structured === "balances") problems = roll.netIdentity === null ? ["Enter all four amounts at both dates."] : roll.problems.filter((p) => /gross less accumulated/.test(p));
      else if (def.structured === "movements") problems = roll.state === "agrees" ? [] : roll.state === "incomplete" ? roll.problems : roll.problems;
      else if (def.structured === "estimate") {
        const e = estimateProblems(cls.estimate, flag(cls.answers.components, "components_identified"));
        problems = def.id === "basis" ? e.filter((p) => /measurement basis/.test(p)) : def.id === "method" ? e.filter((p) => /method|rate|output|changed/.test(p)) : e.filter((p) => !/measurement basis|method|rate as a percentage|expected output|changed/.test(p));
        if (def.id === "estimates" && problems.length === 0) problems.push(...chargeConsistencyProblems(cls, period.start && period.end ? period : null).problems);
      } else if (def.structured === "disposals") {
        const r = disposalResults(cls.disposals);
        problems = roll.problems.filter((p) => /dispos/i.test(p));
        if (r.unresolved) problems.push(`${r.unresolved} disposed item(s) have no confirmed proceeds; the gain or loss stays uncomputed until the proceeds (or a verified nil) are recorded.`);
      } else if (def.structured === "estimate-change") {
        if (!hasText(cls.estimate.changeDescription) || value(cls.estimate.changeEffectMinor) === null) problems = ["Describe the change and its effect on this year's depreciation."];
      } else {
        const a = cls.answers[def.id];
        problems = answerProblems(a, def);
        status = a?.status ?? "unresolved";
      }
      if (problems.length && status === "resolved") status = "unresolved";
      out.push({ def, classId: cls.classId, classLabel: cls.label, status, resolved: !problems.length, problems });
    }
  }
  return out;
}

export const unresolvedQuestions = (qs: readonly EvaluatedQuestion[]) => qs.filter((q) => !q.resolved);
export const questionKey = (q: EvaluatedQuestion) => `${q.def.id}${q.classId ? `@${q.classId}` : ""}`;
