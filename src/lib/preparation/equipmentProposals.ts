/**
 * Original wording proposals generated from confirmed answers and reconciled figures (charter P3, R7): the policy
 * section (8.5, 17.31(a)–(c)), the estimates section (8.7, 10.18) and the equipment note (17.31(d)–(e), 17.30, 17.32,
 * 17.33, 20.13, 24.6, 27.32). Every proposal is output for a named person's review; nothing here is recorded until the
 * reviewer saves the whole note through the server.
 */
import { formatMinor } from "./equipment";
import { CONVENTION_WORDS } from "./depreciation";
import { classRollForward, disposalResults, movementCarryingMinor, PPE_MOVEMENT_KINDS, value, type DepreciationDestination } from "./equipmentSchedule";
import type { Answer, EquipmentClass } from "./equipmentModel";

const LABELS: Record<(typeof PPE_MOVEMENT_KINDS)[number], string> = {
  additions: "Additions",
  disposals: "Disposals (carrying amount)",
  business_combinations: "Acquired through business combinations",
  revaluations_and_oci_impairment: "Revaluations and impairment in other comprehensive income",
  transfers_investment_property: "Transfers to or from investment property at fair value",
  impairment_profit_or_loss: "Impairment losses recognised or reversed in profit or loss",
  depreciation: "Depreciation",
  other: "Other changes",
};
const money = (minor: string | null, currency: string, exponent: number) => (minor === null || value(minor) === null ? "(not available)" : `${currency} ${formatMinor(minor, exponent)}`);
const methodWords = (e: EquipmentClass["estimate"]) =>
  e.method === "straight-line" ? `on a straight-line basis over an estimated useful life of ${e.lifeYears.trim()} years`
    : e.method === "reducing-balance" ? `on a reducing-balance basis at ${e.ratePercent.trim()}% per year`
      : e.method === "units-of-production" ? `by units of production over a total expected output of ${e.totalUnits.trim()} units`
        : "(method not recorded)";
const conventionWords = (c: string) => (c === "daily" || c === "full-period" ? CONVENTION_WORDS[c] : "(convention not recorded)");
const answered = (a: Answer | undefined) => !!a && a.status === "answered" && a.text.trim().length >= 3;
const none = (a: Answer | undefined) => !!a && a.status === "none_with_basis";

/** The equipment section of the accounting policies (8.5(a)–(b); 17.31(a)–(c)), one paragraph per class. */
export function policyProposalV2(classes: readonly EquipmentClass[], currency: string, exponent: number): string {
  const paras: string[] = [];
  for (const c of classes) {
    const e = c.estimate;
    const basis = e.basis === "revaluation"
      ? `${c.label.trim()} is measured at a revalued amount less subsequent accumulated depreciation and impairment losses. Revaluation gains are recognised in other comprehensive income, which this report cannot yet present; the revaluation treatment is recorded as an unsupported case for review.`
      : `${c.label.trim()} is measured at cost less accumulated depreciation and any accumulated impairment losses.`;
    paras.push(`${basis} Depreciation is charged ${methodWords(e)}, ${conventionWords(e.convention)}, with an estimated residual value of ${money(e.residualMinor, currency, exponent)}. Depreciation begins when an item is available for use and ceases when it is derecognised.`);
    if (c.answers.components?.flags.components_identified) paras.push(`Major components of ${c.label.trim()} with different patterns of consumption are depreciated separately over their own useful lives.`);
    if (answered(c.answers.replacement)) paras.push(`The cost of replacing a part of an item of ${c.label.trim()} is added to its carrying amount when incurred and the carrying amount of the replaced part is derecognised; day-to-day servicing is recognised in profit or loss as incurred.`);
    if (answered(c.answers.spares)) paras.push(`Spare parts and stand-by equipment in ${c.label.trim()} expected to be used over more than one period are recognised as equipment; other spares are inventory.`);
    if (answered(c.answers.lease)) paras.push(`Equipment held under finance leases within ${c.label.trim()} is recognised at the lower of its fair value and the present value of the minimum lease payments and is depreciated over the shorter of the lease term and its useful life unless ownership is reasonably certain.`);
    if (answered(c.answers.grant)) paras.push(`Equipment funded by a government grant within ${c.label.trim()} is recognised at the fair value of the asset received; the grant is recognised in income when receivable or when its conditions are met, and is not deducted from the asset.`);
    if (answered(c.answers.dismantling)) paras.push(`The initial estimate of the cost of dismantling items of ${c.label.trim()} and restoring their site is included in the cost of the asset, with a corresponding provision.`);
  }
  paras.push("Gains and losses on the disposal of equipment are the difference between the net disposal proceeds and the carrying amount and are recognised in profit or loss; they are not presented as revenue. At each reporting date the entity assesses whether there is any indication that equipment is impaired.");
  return paras.join("\n\n");
}

/** The equipment part of the key sources of estimation uncertainty (8.7) and any change in estimate (10.18). */
export function estimatesProposalV2(classes: readonly EquipmentClass[], currency: string, exponent: number): string {
  const paras: string[] = [];
  for (const c of classes) {
    const e = c.estimate;
    const life = e.method === "straight-line" ? `a useful life of ${e.lifeYears.trim()} years` : e.method === "reducing-balance" ? `a rate of ${e.ratePercent.trim()}% per year` : e.method === "units-of-production" ? `a total expected output of ${e.totalUnits.trim()} units` : "(estimate not recorded)";
    paras.push(`${c.label.trim()} (carrying amount ${money(c.closing.carryingMinor, currency, exponent)} at the end of the period): the depreciation charge depends on management's estimate of ${life} and a residual value of ${money(e.residualMinor, currency, exponent)}, based on ${e.rationale.trim() || "(rationale not recorded)"}. These estimates are reviewed when there is an indication that expected use, wear, technology or market prices have changed.`);
    if (e.changedSincePrior === "yes") paras.push(`Change in estimate for ${c.label.trim()}: ${e.changeDescription.trim() || "(not described)"}. The effect on the current period's depreciation is ${money(e.changeEffectMinor, currency, exponent)}; the change is applied prospectively and prior periods are not restated.`);
  }
  return paras.join("\n\n");
}

/** The equipment note: per-class gross and accumulated amounts, the reconciliation, disposals and the other disclosures. */
export function equipmentNoteProposalV2(
  classes: readonly EquipmentClass[],
  entityAnswers: Record<string, Answer>,
  destinations: readonly DepreciationDestination[],
  currency: string,
  exponent: number,
): string {
  const paras: string[] = [`Property, plant and equipment — equipment classes. Amounts in ${currency}.`];
  for (const c of classes) {
    const roll = classRollForward(c.label, { opening: c.opening, closing: c.closing }, c.movements, c.disposals);
    const dep = (minor: string, imp: string) => (value(minor) === null || value(imp) === null ? "(not available)" : formatMinor((BigInt(minor) + BigInt(imp)).toString(), exponent));
    paras.push(`${c.label.trim()}: gross carrying amount ${money(c.opening.grossMinor, currency, exponent)} at the start and ${money(c.closing.grossMinor, currency, exponent)} at the end of the period; accumulated depreciation and impairment ${dep(c.opening.accumulatedDepreciationMinor, c.opening.accumulatedImpairmentMinor)} at the start and ${dep(c.closing.accumulatedDepreciationMinor, c.closing.accumulatedImpairmentMinor)} at the end (of which impairment ${money(c.opening.accumulatedImpairmentMinor, currency, exponent)} and ${money(c.closing.accumulatedImpairmentMinor, currency, exponent)}); carrying amount ${money(c.opening.carryingMinor, currency, exponent)} and ${money(c.closing.carryingMinor, currency, exponent)}.`);
    const lines = c.movements.map((m) => `${LABELS[m.kind]} ${money(movementCarryingMinor(m), currency, exponent)}${m.grossMinor !== "0" && value(m.grossMinor) !== null ? ` (cost ${formatMinor(m.grossMinor, exponent)})` : ""}`);
    paras.push(`Reconciliation of the carrying amount of ${c.label.trim()}: opening ${money(c.opening.carryingMinor, currency, exponent)}; ${lines.join("; ") || "no movements"}; closing ${money(c.closing.carryingMinor, currency, exponent)}${roll.state === "agrees" ? "" : " (reconciliation not yet agreed)"}.`);
    const d = disposalResults(c.disposals);
    if (c.disposals.length) paras.push(`Disposals of ${c.label.trim()}: ${c.disposals.map((x, i) => `${x.reference.trim() || "item"} (cost ${money(x.costMinor, currency, exponent)}, carrying amount ${money(d.items[i].carryingMinor, currency, exponent)}, proceeds ${d.items[i].proceedsMinor === null ? "not yet confirmed" : money(d.items[i].proceedsMinor, currency, exponent)})`).join("; ")}. ${d.totalGainMinor === null ? "The gain or loss cannot be stated until every proceeds figure is confirmed." : `The resulting ${BigInt(d.totalGainMinor) >= 0n ? "gain" : "loss"} of ${money((BigInt(d.totalGainMinor) < 0n ? -BigInt(d.totalGainMinor) : BigInt(d.totalGainMinor)).toString(), currency, exponent)} is recognised in profit or loss.`}`);
    if (c.estimate.basis === "revaluation") paras.push(`${c.label.trim()} is carried at revalued amounts: ${answered(c.answers.revaluation) ? c.answers.revaluation!.text.trim() : "(valuation information not yet recorded)"}. Revaluation changes in other comprehensive income are an unsupported reporting case; this note cannot be finalised on that basis.`);
    if (answered(c.answers.lease)) paras.push(`Finance leases in ${c.label.trim()}: ${c.answers.lease!.text.trim()}`);
    if (answered(c.answers.grant)) paras.push(`Government grants relating to ${c.label.trim()}: ${c.answers.grant!.text.trim()}`);
  }
  const dest = destinations.filter((d) => d.target).map((d) => `${d.target.startsWith("sci.") ? d.target.slice(4).replace(/_/g, " ") : d.target.replace(/_/g, " ")} ${money(d.amountMinor, currency, exponent)}`);
  if (dest.length) paras.push(`The depreciation charge for the period is included in: ${dest.join("; ")}.`);
  const imp = entityAnswers.impairment;
  if (imp?.status === "answered" && imp.flags.indicator_present) paras.push(`Impairment: ${entityAnswers.impairment_measurement?.text.trim() || "(measurement not yet recorded)"}`);
  else if (none(imp) || (imp?.status === "answered" && !imp.flags.indicator_present)) paras.push("At the reporting date there was no indication that any item of equipment was impaired.");
  const sec = entityAnswers.restrictions_security;
  paras.push(answered(sec) ? `Restricted title and security: ${sec!.text.trim()}` : none(sec) ? "No equipment is pledged as security and the entity holds unrestricted title to all equipment." : "Restricted title and security: (not yet recorded)");
  const com = entityAnswers.commitments;
  paras.push(answered(com) ? `Contractual commitments to acquire equipment: ${com!.text.trim()}` : none(com) ? "There are no contractual commitments to acquire equipment at the reporting date." : "Contractual commitments: (not yet recorded)");
  const tr = entityAnswers.transition;
  if (answered(tr)) paras.push(`First-time adoption: ${tr!.text.trim()}`);
  const ev = entityAnswers.events_after;
  if (answered(ev)) paras.push(`Events after the reporting period relating to equipment: ${ev!.text.trim()} (to be carried into the events-after-the-period note).`);
  return paras.join("\n\n");
}
