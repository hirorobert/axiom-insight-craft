import { z } from "zod";
const text = z.string().max(2000),
  amount = z.string().max(64);
const policy = z
  .object({
    assetClass: text,
    basis: z.enum(["", "cost", "revaluation"]),
    method: z.enum([
      "",
      "straight-line",
      "reducing-balance",
      "units-of-production",
    ]),
    usefulLife: text,
    residualValue: text,
    rationale: text,
    evidence: text,
  })
  .strict();
const gross = z
  .object({
    openingGross: amount,
    openingDepreciation: amount,
    openingImpairment: amount,
    closingGross: amount,
    closingDepreciation: amount,
    closingImpairment: amount,
  })
  .strict();
const editor = z
  .object({
    sourceMode: z.enum(["pdf", "reference"]),
    priorReference: text,
    page: z.string().max(3),
    priorAmount: amount,
    priorDate: z.string().max(10),
    priorCurrency: z.string().max(3),
    priorUnits: z.enum(["", "0", "3", "6"]),
    opening: amount,
    closing: amount,
    adjustments: z
      .array(z.object({ amount, reason: text, evidence: text }).strict())
      .max(100),
    movementValues: z.record(
      z.enum([
        "additions",
        "disposals",
        "business_combinations",
        "revaluations_and_oci_impairment",
        "transfers_investment_property",
        "impairment_profit_or_loss",
        "depreciation",
        "other",
      ]),
      amount,
    ),
    source: text,
    policy,
    gross,
    judgements: z
      .record(z.string().max(40), text)
      .refine((x) => Object.keys(x).length <= 12),
    read: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        page: z.number().int().min(1).max(200),
        pages: z.number().int().min(1).max(200),
        text: z.string().max(60000),
        method: z.enum(["text", "ocr"]),
      })
      .strict()
      .nullable(),
  })
  .strict();
type DeepRequired<T> = T extends (infer U)[]
  ? DeepRequired<U>[]
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<T[K]> }
    : T;
export function parseEquipmentEditor(
  data: unknown,
  companyId: string,
  periodYear: number,
) {
  const parsed = z
    .object({
      contract: z.literal("cfoclose-equipment-workpaper/1"),
      companyId: z.literal(companyId),
      periodYear: z.literal(periodYear),
      editor,
    })
    .parse(data);
  return parsed.editor as DeepRequired<z.infer<typeof editor>>;
}
