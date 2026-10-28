import { z } from "zod";
import { DEPRECIATION_CONVENTIONS, DEPRECIATION_METHODS } from "./depreciation";
import { DESTINATION_TARGETS, EQUIPMENT_CONTRACT_V2, MOVEMENT_SOURCE_TYPES, PPE_MOVEMENT_KINDS } from "./equipmentSchedule";

/** Bounded restoration of a saved multi-class equipment workpaper (contract /2). Anything else is refused as a whole. */
const text = z.string().max(2000), amount = z.string().max(64), short = z.string().max(200);
const uuid = z.string().uuid();
const answer = z.object({
  status: z.enum(["unresolved", "answered", "none_with_basis", "not_applicable"]),
  text, evidence: text, checkedBy: short,
  flags: z.record(z.string().max(40), z.boolean()).refine((x) => Object.keys(x).length <= 12),
}).strict();
const source = z.object({ type: z.enum(["", ...MOVEMENT_SOURCE_TYPES]), reference: short }).strict();
const balances = z.object({ grossMinor: amount, accumulatedDepreciationMinor: amount, accumulatedImpairmentMinor: amount, carryingMinor: amount }).strict();
const movement = z.object({ kind: z.enum(PPE_MOVEMENT_KINDS), grossMinor: amount, accumulatedDepreciationMinor: amount, accumulatedImpairmentMinor: amount, source, note: text }).strict();
const disposal = z.object({ reference: short, date: z.string().max(10), costMinor: amount, accumulatedDepreciationMinor: amount, accumulatedImpairmentMinor: amount, proceedsMinor: amount.nullable(), source }).strict();
const item = z.object({
  label: short, costMinor: amount, residualMinor: amount, openingAccumulatedMinor: amount, method: z.enum(["", ...DEPRECIATION_METHODS]),
  lifeYears: z.string().max(24), ratePercent: z.string().max(24), totalUnits: z.string().max(24), unitsThisPeriod: z.string().max(24), availableFrom: z.string().max(10), derecognisedOn: z.string().max(10),
}).strict();
const estimate = z.object({
  basis: z.enum(["", "cost", "revaluation"]), method: z.enum(["", ...DEPRECIATION_METHODS]),
  lifeYears: z.string().max(24), ratePercent: z.string().max(24), totalUnits: z.string().max(24), unitsThisPeriod: z.string().max(24), residualMinor: amount,
  convention: z.enum(["", ...DEPRECIATION_CONVENTIONS]),
  factors: z.object({ usage: text, wear: text, obsolescence: text, legalLimits: text }).strict(),
  chargeSource: z.enum(["", "calculated", "register"]), registerChargeMinor: amount, registerReference: short, items: z.array(item).max(200),
  calculatedChargeMinor: amount, chargeDifference: z.object({ amountMinor: amount, explanation: text, evidence: text }).strict(),
  changedSincePrior: z.enum(["", "yes", "no"]), changeDescription: text, changeEffectMinor: amount, rationale: text, evidence: text,
}).strict();
const cls = z.object({
  classId: uuid, label: short, origin: z.enum(["existing", "new"]), accounts: text, opening: balances, closing: balances,
  movements: z.array(movement).max(8), disposals: z.array(disposal).max(200), estimate, answers: z.record(z.string().max(40), answer).refine((x) => Object.keys(x).length <= 30),
}).strict();
const editor = z.object({
  sourceMode: z.enum(["pdf", "reference"]), priorReference: text, page: z.string().max(3), priorAmount: amount, priorGross: amount, priorAccumulated: amount,
  priorDate: z.string().max(10), priorCurrency: z.string().max(3), priorUnits: z.enum(["", "0", "3", "6"]),
  adjustments: z.array(z.object({ amount, reason: text, evidence: text, category: z.enum(["", "correction", "restatement", "scope_change", "transition_adjustment", "other"]) }).strict()).max(100),
  classes: z.array(cls).max(100),
  retiredClasses: z.array(z.object({ label: short, reason: text, evidence: text }).strict()).max(100),
  destinations: z.array(z.object({ target: z.enum(["", ...DESTINATION_TARGETS]), amountMinor: amount, evidence: text, explanation: text }).strict()).max(20),
  entityAnswers: z.record(z.string().max(40), answer).refine((x) => Object.keys(x).length <= 30),
  read: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), page: z.number().int().min(1).max(200), pages: z.number().int().min(1).max(200), text: z.string().max(60000), method: z.enum(["text", "ocr"]) }).strict().nullable(),
}).strict();
type DeepRequired<T> = T extends (infer U)[] ? DeepRequired<U>[] : T extends object ? { [K in keyof T]-?: DeepRequired<T[K]> } : T;
export type EquipmentEditorV2 = DeepRequired<z.infer<typeof editor>>;

export function parseEquipmentEditorV2(data: unknown, companyId: string, periodYear: number): EquipmentEditorV2 {
  return z.object({ contract: z.literal(EQUIPMENT_CONTRACT_V2), companyId: z.literal(companyId), periodYear: z.literal(periodYear), editor }).parse(data).editor as EquipmentEditorV2;
}
