/** Advisory preparation only. Saved schedules, report readiness and approval remain server authorities. */
export const MINOR = /^(0|-?[1-9][0-9]{0,30})$/;
export type SourceFact = {
  documentSha256: string | null;
  page: number | null;
  origin?: "document" | "manual";
  sourceRef?: string;
  printedAmount?: string;
  printedUnitsExponent?: number;
  entity: string;
  periodEnd: string;
  currency: string;
  scale: number;
  label: string;
  amountMinor: string;
  confirmed: boolean;
};
export type BridgeAdjustment = {
  amountMinor: string;
  reason: string;
  evidence: string;
};
export type Movement = { kind: string; amountMinor: string; evidence: string };
export type EquipmentPolicy = {
  assetClass: string;
  basis: "cost" | "revaluation" | "";
  method: "straight-line" | "reducing-balance" | "units-of-production" | "";
  usefulLife: string;
  residualValue: string;
  rationale: string;
  evidence: string;
};
const hasText = (v: string) => v.trim().length >= 3;
const validDate = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
function value(v: string): bigint | null {
  return MINOR.test(v) ? BigInt(v) : null;
}

export function openingBridge(
  prior: SourceFact | null,
  adjustments: readonly BridgeAdjustment[],
  openingMinor: string,
  context: {
    entity: string;
    priorPeriodEnd: string;
    currency: string;
    exponent: number;
  },
) {
  const problems: string[] = [];
  if (!validDate(context.priorPeriodEnd))
    problems.push("Confirm the recorded prior reporting date.");
  if (!prior || !prior.confirmed)
    problems.push("Confirm the prior-report figure against its original page.");
  if (prior) {
    if (!hasText(prior.entity) || !hasText(prior.label))
      problems.push("Identify the source entity and figure.");
    if (prior.origin === "manual") {
      if (!hasText(prior.sourceRef ?? ""))
        problems.push(
          "A reviewed source reference is required for a manually entered figure.",
        );
    } else if (
      !prior.documentSha256 ||
      !/^[a-f0-9]{64}$/.test(prior.documentSha256) ||
      !Number.isInteger(prior.page) ||
      prior.page! < 1
    )
      problems.push("The original document fingerprint and page are required.");
    if (
      prior.entity !== context.entity ||
      prior.periodEnd !== context.priorPeriodEnd ||
      prior.currency !== context.currency ||
      prior.scale !== context.exponent
    )
      problems.push(
        "Resolve the entity, period, currency or unit difference before comparing figures.",
      );
  }
  const start = prior ? value(prior.amountMinor) : null,
    end = value(openingMinor);
  if (start === null || end === null)
    problems.push("Enter exact prior closing and current opening amounts.");
  if (
    adjustments.some(
      (a) =>
        value(a.amountMinor) === null ||
        !hasText(a.reason) ||
        !hasText(a.evidence),
    )
  )
    problems.push(
      "Each opening adjustment needs an exact amount, reason and evidence.",
    );
  if (problems.length)
    return {
      state: "incomplete" as const,
      problems,
      differenceMinor: null,
      bridgedMinor: null,
    };
  const bridged =
    start! + adjustments.reduce((n, a) => n + BigInt(a.amountMinor), 0n);
  const difference = end! - bridged;
  return {
    state: difference === 0n ? ("agrees" as const) : ("difference" as const),
    problems:
      difference === 0n
        ? []
        : [
            "Explain the opening difference with supported adjustments; do not invent a balancing asset.",
          ],
    differenceMinor: difference.toString(),
    bridgedMinor: bridged.toString(),
  };
}

/** Movement accounts may be used only after the preparer identifies what each account represents. A balance difference is not an additions figure. */
export function reconcileEquipment(
  openingMinor: string,
  movements: readonly Movement[],
  closingMinor: string,
  statementClosingMinor: string | null,
) {
  const problems: string[] = [];
  if (
    value(openingMinor) === null ||
    value(closingMinor) === null ||
    movements.some((m) => value(m.amountMinor) === null)
  )
    problems.push("Enter exact schedule amounts.");
  if (
    new Set(movements.map((m) => m.kind)).size !== movements.length ||
    movements.some((m) => !hasText(m.kind))
  )
    problems.push("Each movement type must be identified once.");
  if (movements.some((m) => !hasText(m.evidence)))
    problems.push(
      "Identify register, ledger or reviewed movement-account evidence for every movement.",
    );
  if (statementClosingMinor === null || value(statementClosingMinor) === null)
    problems.push(
      "Complete statement presentation to obtain the server closing amount.",
    );
  if (problems.length)
    return {
      state: "incomplete" as const,
      problems,
      movementDifferenceMinor: null,
      statementDifferenceMinor: null,
    };
  const movementDifference =
    BigInt(closingMinor) -
    BigInt(openingMinor) -
    movements.reduce((n, m) => n + BigInt(m.amountMinor), 0n);
  const statementDifference =
    BigInt(closingMinor) - BigInt(statementClosingMinor!);
  if (movementDifference !== 0n)
    problems.push("The movement schedule does not add up.");
  if (statementDifference !== 0n)
    problems.push(
      "The closing schedule does not agree to the server statement line.",
    );
  return {
    state: problems.length ? ("difference" as const) : ("agrees" as const),
    problems,
    movementDifferenceMinor: movementDifference.toString(),
    statementDifferenceMinor: statementDifference.toString(),
  };
}

export function policyDraft(p: EquipmentPolicy): {
  text: string | null;
  problems: string[];
} {
  const problems: string[] = [];
  if (
    ![p.assetClass, p.rationale, p.evidence].every(hasText) ||
    !p.usefulLife.trim() ||
    !p.residualValue.trim() ||
    !["cost", "revaluation"].includes(p.basis) ||
    !["straight-line", "reducing-balance", "units-of-production"].includes(
      p.method,
    )
  )
    problems.push(
      "Complete the policy choices and supporting reasoning. Useful lives are entity estimates, not a universal IFRS rate.",
    );
  if (problems.length) return { text: null, problems };
  const basis =
    p.basis === "cost"
      ? "cost less accumulated depreciation and impairment"
      : "a revaluation basis, subject to a separately completed valuation and revaluation assessment";
  return {
    text: `${p.assetClass.trim()} is measured on ${basis}. Depreciation uses the ${p.method} method. Estimated useful lives: ${p.usefulLife.trim()}. Residual values: ${p.residualValue.trim()}. The estimates reflect ${p.rationale.trim()}. Supporting record: ${p.evidence.trim()}.`,
    problems,
  };
}

/** Single exact formatter, never Number(minor): financial amounts may exceed JS safe integers. */
export function formatMinor(minor: string, exponent: number): string {
  if (
    !MINOR.test(minor) ||
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 4
  )
    throw new Error("Invalid amount or exponent");
  const n = BigInt(minor),
    abs = (n < 0n ? -n : n).toString().padStart(exponent + 1, "0");
  return `${n < 0n ? "-" : ""}${exponent ? `${abs.slice(0, -exponent)}.${abs.slice(-exponent)}` : abs}`;
}

/** Presentation only: exact integer arithmetic and reconciliation results are unchanged. */
export type EquipmentAmountDisplay = { currency: string; exponent: number };
export function formatEquipmentAmount(minor: string | bigint, display?: EquipmentAmountDisplay): string {
  if (!display) return minor.toString();
  const [whole, fraction] = formatMinor(minor.toString(), display.exponent).split(".");
  return `${display.currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** Normalize printed source units exactly; malformed grouping and unsupported precision are refused. */
export function parseSourceAmount(
  text: string,
  currencyExponent: number,
  unitsExponent: number,
): string | null {
  if (
    !Number.isInteger(currencyExponent) ||
    currencyExponent < 0 ||
    currencyExponent > 4 ||
    ![0, 3, 6].includes(unitsExponent)
  )
    return null;
  let t = text.trim();
  const parentheses = t.startsWith("(") && t.endsWith(")");
  if (parentheses) t = t.slice(1, -1);
  const match = /^(-?)(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/.exec(t);
  if (!match || (parentheses && match[1])) return null;
  const exponent = currencyExponent + unitsExponent,
    fraction = match[3] ?? "";
  if (fraction.length > exponent) return null;
  const digits = match[2].replace(/,/g, "") + fraction.padEnd(exponent, "0");
  if (digits.length > 31) return null;
  return ((parentheses || match[1] ? -1n : 1n) * BigInt(digits)).toString();
}

/** Calendar anchor only, never an inferred balance or reporting election. */
export function openingAnchorDate(
  priorEnd: string | null | undefined,
  currentStart: string | null | undefined,
): string | null {
  if (priorEnd && validDate(priorEnd.slice(0, 10)))
    return priorEnd.slice(0, 10);
  if (!currentStart || !validDate(currentStart.slice(0, 10))) return null;
  const date = new Date(`${currentStart.slice(0, 10)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
