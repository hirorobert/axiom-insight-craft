/**
 * Editor-side helpers for the IPSAS preparation page: strict decimal ↔ minor-unit conversion and empty templates. The
 * payload IS the editor state (string fields), so what the page shows is exactly what the server is sent; the server's
 * assessment, not anything computed here, decides what is complete.
 */
import { emptyAnswer } from "../preparation/equipmentModel";
import type { DepreciationItem } from "../preparation/depreciation";
import type { ClassMovement, DisposalItem } from "../preparation/equipmentSchedule";
import type { PpeClassInput } from "./ppeWorkpaper";
import { COMPLEXITIES, type Grant, type GrantObligation } from "./grants";

/**
 * The denomination every amount on these pages is read in, as CONFIRMED BY THE SERVER from the certified current period (independent review of
 * #229, finding 4). There is no default: the page used to assume TZS with two decimals, so a JPY balance of 14,000 was shown as 140.00. Exponents
 * 0 to 3 are supported (JPY, TZS and USD, KWD); anything else the server reports is "unsupported" and "unknown" means no certified source.
 */
export type Presentation = { currency: string; exponent: 0 | 1 | 2 | 3 };
export type PresentationState = ({ state: "known" } & Presentation) | { state: "unknown" } | { state: "unsupported"; currency?: unknown; exponent?: unknown };
/** The server's confirmed denomination, or null. Checked at runtime: only an ISO-shaped code with exponent 0 to 3 in state "known" counts. */
export const knownPresentation = (p: { state?: string; currency?: unknown; exponent?: unknown } | null | undefined): Presentation | null =>
  p && p.state === "known" && typeof p.currency === "string" && /^[A-Z]{3}$/.test(p.currency) && (p.exponent === 0 || p.exponent === 1 || p.exponent === 2 || p.exponent === 3)
    ? { currency: p.currency, exponent: p.exponent } : null;
export const sameDenomination = (a: Presentation | null | undefined, b: Presentation | null | undefined): boolean => !!a && !!b && a.currency === b.currency && a.exponent === b.exponent;
export const denominationWords = (p: Presentation): string => `${p.currency} (${p.exponent === 0 ? "whole units, no decimals" : `${p.exponent} decimal place${p.exponent === 1 ? "" : "s"}`})`;

/**
 * "1,234.50" → "123450" (for exponent 2). Thousands separators are accepted; more decimals than the unit has, a sign in the wrong
 * place, text, or an empty value is NOT coerced: it returns null (a blank is unknown, never zero). The exponent is the server's, never assumed.
 */
export function toMinor(text: string, exponent: number): string | null {
  const t = text.trim().replace(/,/g, "");
  const m = /^(-)?(\d{1,24})(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  const frac = m[3] ?? "";
  if (frac.length > exponent) return null;
  const digits = (m[2] + frac.padEnd(exponent, "0")).replace(/^0+(?=\d)/, "");
  if (digits === "0") return "0";
  return (m[1] ? "-" : "") + digits;
}
/** "123450" → "1,234.50" (plain, no currency). null → "". */
export function fromMinor(minor: string | null | undefined, exponent: number): string {
  if (minor === null || minor === undefined || !/^(0|-?[1-9][0-9]{0,30})$/.test(minor)) return "";
  const neg = minor.startsWith("-"), d = (neg ? minor.slice(1) : minor).padStart(exponent + 1, "0");
  const whole = d.slice(0, d.length - exponent).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${whole}${exponent ? "." + d.slice(d.length - exponent) : ""}`;
}

export const newId = (): string => globalThis.crypto.randomUUID();
const REG = (): ClassMovement["source"] => ({ type: "register", reference: "" });

export const emptyItem = (): DepreciationItem => ({ label: "", costMinor: "", residualMinor: "", openingAccumulatedMinor: "0", method: "straight-line", lifeYears: "", ratePercent: "", totalUnits: "", unitsThisPeriod: "", availableFrom: "", derecognisedOn: "" });
export const emptyDisposal = (): DisposalItem => ({ reference: "", date: "", costMinor: "", accumulatedDepreciationMinor: "", accumulatedImpairmentMinor: "0", proceedsMinor: null, source: REG() });
export const emptyClass = (): PpeClassInput => ({
  classId: newId(), label: "", accounts: "", measurementModel: "", estimateConfirmed: false,
  opening: { grossMinor: "", accumulatedDepreciationMinor: "", accumulatedImpairmentMinor: "0", carryingMinor: "" },
  closing: { grossMinor: "", accumulatedDepreciationMinor: "", accumulatedImpairmentMinor: "0", carryingMinor: "" },
  movements: [
    { kind: "additions", grossMinor: "0", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", source: REG(), note: "" },
    { kind: "disposals", grossMinor: "0", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", source: REG(), note: "" },
    { kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "", accumulatedImpairmentMinor: "0", source: REG(), note: "" },
  ],
  disposals: [],
  estimate: { basis: "cost", method: "", lifeYears: "", ratePercent: "", totalUnits: "", unitsThisPeriod: "", residualMinor: "", convention: "", factors: { usage: "", wear: "", obsolescence: "", legalLimits: "" },
    chargeSource: "", registerChargeMinor: "", registerReference: "", items: [emptyItem()], calculatedChargeMinor: "", chargeDifference: { amountMinor: "", explanation: "", evidence: "" },
    changedSincePrior: "", changeDescription: "", changeEffectMinor: "", rationale: "", evidence: "" },
});

export type WorkpaperDraft = {
  contract: "cfoclose-ipsas-ppe-workpaper/1"; companyId: string; periodYear: number;
  /** The denomination these amounts were entered in (the server's, at the time); the server refuses a payload that does not carry the current one. */
  presentation: Presentation | null;
  period: { start: string; end: string }; convention: "daily" | "full-period" | "";
  classes: PpeClassInput[]; entityAnswers: Record<string, ReturnType<typeof emptyAnswer> & { flags: Record<string, boolean> }>;
  depreciationDifference: { amountMinor: string; explanation: string; evidence: string } | null;
  tbSelection: { ppeAccountKeys: string[]; depreciationExpenseKeys: string[] };
};
export const emptyWorkpaper = (companyId: string, periodYear: number, presentation: Presentation | null): WorkpaperDraft => ({
  contract: "cfoclose-ipsas-ppe-workpaper/1", companyId, periodYear, presentation,
  period: { start: `${periodYear}-01-01`, end: `${periodYear}-12-31` }, convention: "",
  classes: [], entityAnswers: {}, depreciationDifference: null, tbSelection: { ppeAccountKeys: [], depreciationExpenseKeys: [] },
});
export type PriorDraft = {
  contract: "cfoclose-ipsas-prior-figures/1"; companyId: string; periodYear: number; currency: string; scale: number;
  lines: { lineId: "ppe"; label: string; amountMinor: string | null; locator: string; sourceDocumentId?: string }[];
  items: { id: string; groupId: string; lineId: "ppe"; kind: string; amountMinor: string; evidenceRef: string; authorityReference: string }[];
};
export const emptyPrior = (companyId: string, periodYear: number, presentation: Presentation | null): PriorDraft => ({
  contract: "cfoclose-ipsas-prior-figures/1", companyId, periodYear, currency: presentation?.currency ?? "", scale: presentation?.exponent ?? 0,
  lines: [{ lineId: "ppe", label: "Property, plant and equipment (carrying amount)", amountMinor: null, locator: "" }], items: [],
});

/** Carrying amount derived from the three exact columns, or "" while any is not exact. The server re-checks the identity. */
export function carrying(g: string, d: string, i: string): string {
  const ok = (v: string) => /^(0|-?[1-9][0-9]{0,30})$/.test(v);
  return ok(g) && ok(d) && ok(i) ? (BigInt(g) - BigInt(d) - BigInt(i)).toString() : "";
}
export function stableJson(v: unknown): string {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(norm(v));
}

export type GrantsDraft = {
  contract: "cfoclose-ipsas-grants/1"; companyId: string; periodYear: number;
  presentation: Presentation | null;
  entityAnswers: Record<string, ReturnType<typeof emptyAnswer> & { flags: Record<string, boolean> }>;
  tbSelection: { revenueKeys: string[]; liabilityKeys: string[]; receivableKeys: string[] };
  grants: Grant[];
};
export const emptyGrantsDraft = (companyId: string, periodYear: number, presentation: Presentation | null): GrantsDraft => ({
  contract: "cfoclose-ipsas-grants/1", companyId, periodYear, presentation, entityAnswers: {}, tbSelection: { revenueKeys: [], liabilityKeys: [], receivableKeys: [] }, grants: [],
});
export const emptyObligation = (n: number): GrantObligation => ({ id: `OBL-${n}`, label: "", allocatedMinor: "", satisfiedMinor: "0", satisfactionBasis: "", satisfactionEvidence: "" });
export const emptyGrant = (): Grant => ({
  grantId: newId(), reference: "", grantor: "", agreementEvidence: "", classification: "", classificationBasis: "", classificationEvidence: "",
  considerationMinor: "", recognisedResourcesMinor: "", cashReceivedMinor: "0", priorCumulativeRevenueMinor: "0", priorEvidence: "",
  complexities: Object.fromEntries(COMPLEXITIES.map((k) => [k, null])) as Grant["complexities"], complexityBasis: "", obligations: [],
});
