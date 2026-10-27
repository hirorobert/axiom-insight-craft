/** Original preparation questions, not reproduced standards text or a compliance checklist. */
export const EQUIPMENT_CONTENT_VERSION = "sme-2015-equipment-preparation/1";
export const EQUIPMENT_SOURCE = {
  framework: "ifrs-for-smes/2015",
  url: "https://www.ifrs.org/content/dam/ifrs/supporting-implementation/smes/module-17.pdf",
  checkedOn: "2026-10-27",
  status: "primary-source-checked; independent-accountant-review-pending",
} as const;
export const EQUIPMENT_QUESTIONS = [
  {
    id: "recognition",
    refs: ["17.4", "17.5"],
    question:
      "Does the entity control the equipment, and what supports its recorded value?",
    evidence:
      "Purchase, grant, ownership or control records; investigate missing items rather than creating a balancing asset.",
  },
  {
    id: "components",
    refs: ["17.16"],
    question:
      "Do significant parts wear out differently and need separate depreciation?",
    evidence:
      "Register, maintenance plan and significant component costs; explain the grouping decision.",
  },
  {
    id: "basis",
    refs: ["17.15", "17.15A", "17.15B"],
    question: "Which measurement model applies to this entire asset class?",
    evidence:
      "Approved policy and, where relevant, valuation records. A model choice does not perform a valuation.",
  },
  {
    id: "estimates",
    refs: ["17.18", "17.19", "17.21"],
    question:
      "What useful lives and residual values reflect the way this entity uses the equipment?",
    evidence:
      "Expected use, condition, repairs, replacement plans and restrictions. Do not substitute tax rates or a universal equipment life.",
  },
  {
    id: "method",
    refs: ["17.22", "17.23"],
    question:
      "Which depreciation method reflects consumption, and have changed circumstances been considered?",
    evidence:
      "Usage pattern, available-for-use dates and evidence of changes; the uploaded charge does not determine the policy.",
  },
  {
    id: "gross",
    refs: ["17.31(d)"],
    question:
      "What are the gross amounts and accumulated deductions at each reporting date?",
    evidence:
      "Register and ledger balances, with depreciation and impairment distinguished. A net balance alone cannot answer this.",
  },
  {
    id: "movements",
    refs: ["17.31(e)"],
    question: "What supported movements explain the change in carrying amount?",
    evidence:
      "Register, ledger or explicitly reviewed movement accounts. Disposal carrying amounts are not disposal cash proceeds.",
  },
  {
    id: "restrictions",
    refs: ["17.32"],
    question:
      "Are assets restricted or pledged, and are there contractual purchase commitments?",
    evidence:
      "Security documents, contracts and management confirmation; no balance in the TB is not proof of none.",
  },
  {
    id: "revaluation",
    refs: ["17.33"],
    question:
      "If revaluation is used, what valuation evidence and additional disclosures are needed?",
    evidence:
      "Date, valuer, valuation basis and relevant revaluation information; ask only when the revaluation model is selected.",
  },
] as const;

export type GrossBalances = {
  openingGross: string;
  openingDepreciation: string;
  openingImpairment: string;
  closingGross: string;
  closingDepreciation: string;
  closingImpairment: string;
};
export function grossReconciliation(
  b: GrossBalances,
  opening: string | null,
  closing: string | null,
) {
  const exact = /^(0|[1-9][0-9]{0,30})$/;
  if (
    !Object.values(b).every((v) => exact.test(v)) ||
    opening === null ||
    closing === null ||
    !/^(0|-?[1-9][0-9]{0,30})$/.test(opening) ||
    !/^(0|-?[1-9][0-9]{0,30})$/.test(closing)
  )
    return {
      state: "incomplete" as const,
      openingDifference: null,
      closingDifference: null,
    };
  const o =
    BigInt(b.openingGross) -
    BigInt(b.openingDepreciation) -
    BigInt(b.openingImpairment) -
    BigInt(opening);
  const c =
    BigInt(b.closingGross) -
    BigInt(b.closingDepreciation) -
    BigInt(b.closingImpairment) -
    BigInt(closing);
  return {
    state: o === 0n && c === 0n ? ("agrees" as const) : ("difference" as const),
    openingDifference: o.toString(),
    closingDifference: c.toString(),
  };
}

export function preparationInputs(
  policy: {
    basis: string;
    method: string;
    usefulLife: string;
    residualValue: string;
    rationale: string;
    evidence: string;
  },
  grossState: string,
  movementState: string,
  judgements: Record<string, string>,
) {
  const supplied = (s: string | undefined) => !!s && s.trim().length >= 3;
  return EQUIPMENT_QUESTIONS.filter(
    (q) => q.id !== "revaluation" || policy.basis === "revaluation",
  ).map((q) => ({
    ...q,
    entered:
      q.id === "basis"
        ? !!policy.basis && supplied(policy.evidence)
        : q.id === "method"
          ? !!policy.method && supplied(policy.rationale)
          : q.id === "estimates"
            ? !!policy.usefulLife.trim() &&
              !!policy.residualValue.trim() &&
              supplied(policy.rationale) &&
              supplied(policy.evidence)
            : q.id === "gross"
              ? grossState === "agrees"
              : q.id === "movements"
                ? movementState === "agrees"
                : supplied(judgements[q.id]),
    usesExistingFields: [
      "basis",
      "method",
      "estimates",
      "gross",
      "movements",
    ].includes(q.id),
  }));
}
