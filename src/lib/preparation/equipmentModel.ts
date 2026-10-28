/** The multi-class equipment preparation model (contract cfoclose-equipment-workpaper/2). Types only. */
import type { BalanceSet, ClassMovement, DepreciationDestination, DisposalItem, RetiredClass } from "./equipmentSchedule";
import type { DepreciationConvention, DepreciationItem, DepreciationMethod } from "./depreciation";

export type AnswerStatus = "unresolved" | "answered" | "none_with_basis" | "not_applicable";
/**
 * A recorded fact (charter L8): the answer, who checked it and the evidence. "None" is a fact with a basis, not an
 * empty field; flags are the structured yes/no parts that trigger follow-up questions.
 */
export type Answer = { status: AnswerStatus; text: string; evidence: string; checkedBy: string; flags: Record<string, boolean> };
export const emptyAnswer = (): Answer => ({ status: "unresolved", text: "", evidence: "", checkedBy: "", flags: {} });

/** The 17.21 factors the entity considered; recorded per class, never pre-filled. */
export type UsefulLifeFactors = { usage: string; wear: string; obsolescence: string; legalLimits: string };

export type ClassEstimate = {
  basis: "cost" | "revaluation" | "";
  method: DepreciationMethod | "";
  lifeYears: string;
  ratePercent: string;
  totalUnits: string;
  unitsThisPeriod: string;
  residualMinor: string;
  convention: DepreciationConvention | "";
  factors: UsefulLifeFactors;
  /** Where the period's charge in the schedule comes from: this calculator over the items, or an external register. */
  chargeSource: "calculated" | "register" | "";
  registerChargeMinor: string;
  registerReference: string;
  items: DepreciationItem[];
  changedSincePrior: "yes" | "no" | "";
  changeDescription: string;
  changeEffectMinor: string;
  rationale: string;
  evidence: string;
};
export const emptyEstimate = (): ClassEstimate => ({
  basis: "", method: "", lifeYears: "", ratePercent: "", totalUnits: "", unitsThisPeriod: "", residualMinor: "", convention: "",
  factors: { usage: "", wear: "", obsolescence: "", legalLimits: "" }, chargeSource: "", registerChargeMinor: "", registerReference: "", items: [],
  changedSincePrior: "", changeDescription: "", changeEffectMinor: "", rationale: "", evidence: "",
});

export type EquipmentClass = {
  /** Stable identity across saves (a UUID made when the class is added or loaded). */
  classId: string;
  label: string;
  /** Loaded from the recorded schedule, or added in this preparation. */
  origin: "existing" | "new";
  /** The source accounts (codes or names) that make up this class (4.11(a); charter R1). */
  accounts: string;
  opening: BalanceSet;
  closing: BalanceSet;
  movements: ClassMovement[];
  disposals: DisposalItem[];
  estimate: ClassEstimate;
  answers: Record<string, Answer>;
};
export const emptyBalances = (): BalanceSet => ({ grossMinor: "", accumulatedDepreciationMinor: "", accumulatedImpairmentMinor: "", carryingMinor: "" });

export type EquipmentPreparationV2 = {
  classes: EquipmentClass[];
  retiredClasses: RetiredClass[];
  destinations: DepreciationDestination[];
  entityAnswers: Record<string, Answer>;
};
