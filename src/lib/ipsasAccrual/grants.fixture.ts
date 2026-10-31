/**
 * Synthetic grant fixtures (TZS, exponent 2). Entity, donors and every figure are invented. Expected results are derived by
 * hand here, independently of the production formulas.
 *
 * IPSAS 47 period (2026-01-01 .. 2026-12-31)
 *   Grant A "DONOR-X-HEALTH": agreed and recognised 12,000,000.00; cash received 7,500,000.00; prior cumulative revenue 2,000,000.00
 *     O1 allocated 5,000,000 satisfied 5,000,000 · O2 allocated 4,000,000 satisfied 1,500,000 · O3 allocated 3,000,000 satisfied 0
 *     cumulative revenue = 5,000,000 + 1,500,000                              = 6,500,000.00
 *     revenue this period = 6,500,000 − 2,000,000                             = 4,500,000.00
 *     liability = recognised 12,000,000 − cumulative 6,500,000                = 5,500,000.00
 *     receivable = recognised 12,000,000 − cash 7,500,000                     = 4,500,000.00   (cash does not enter revenue)
 *   Grant B "DONOR-Y-UNRESTRICTED": no binding arrangement, no present obligation; 2,000,000.00 recognised, all received
 *     cumulative = recognised 2,000,000 · period revenue 2,000,000 · liability 0 · receivable 0
 *   Totals: period revenue 6,500,000.00 · liability 5,500,000.00 · receivable 4,500,000.00   (minor: 650000000 / 550000000 / 450000000)
 * IPSAS 23 period (2025-01-01 .. 2025-12-31)
 *   Grant C "DONOR-Z-CONDITION": enforceable condition; 6,000,000.00 recognised and received; condition satisfied to 2,400,000.00
 *     revenue 2,400,000 · liability 3,600,000 · receivable 0
 *   Grant D "DONOR-W-RESTRICTED": restriction only; 1,000,000.00 recognised; cash 400,000.00
 *     revenue = recognised 1,000,000 (a restriction is not a liability) · liability 0 · receivable 600,000
 *   Totals: revenue 3,400,000.00 · liability 3,600,000.00 · receivable 600,000.00
 */
import { emptyAnswer } from "../preparation/equipmentModel";
import { COMPLEXITIES, type Grant, type GrantsInput } from "./grants";

export const P47 = { start: "2026-01-01", end: "2026-12-31" } as const;
export const P23 = { start: "2025-01-01", end: "2025-12-31" } as const;
export const DISPLAY = { currency: "TZS", exponent: 2 } as const;
const noComplexity = () => Object.fromEntries(COMPLEXITIES.map((k) => [k, false])) as Grant["complexities"];
const base = (over: Partial<Grant>): Grant => ({
  grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reference: "AGREEMENT-1", grantor: "Synthetic Donor", agreementEvidence: "Signed grant agreement GA-2026-01",
  classification: "", classificationBasis: "Agreement clause 4 states deliverables and a refund on non-delivery", classificationEvidence: "Agreement GA-2026-01 clauses 4 and 9",
  considerationMinor: "0", recognisedResourcesMinor: "0", cashReceivedMinor: "0", priorCumulativeRevenueMinor: "0", priorEvidence: "", complexities: noComplexity(),
  complexityBasis: "No variable amounts, financing, agency, in-kind, modification, collection doubt or foreign currency", obligations: [], ...over,
});
const ob = (id: string, allocated: string, satisfied: string, basis: "milestone-delivered" | "output-measure" | "" = "milestone-delivered") =>
  ({ id, label: id, allocatedMinor: allocated, satisfiedMinor: satisfied, satisfactionBasis: satisfied === "0" ? "" as const : basis, satisfactionEvidence: satisfied === "0" ? "" : "Grantor acceptance letter and delivery report" });

export const grantA = (over: Partial<Grant> = {}): Grant => base({ grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reference: "DONOR-X-HEALTH", grantor: "Donor X", classification: "binding-arrangement",
  considerationMinor: "1200000000", recognisedResourcesMinor: "1200000000", cashReceivedMinor: "750000000", priorCumulativeRevenueMinor: "200000000", priorEvidence: "Issued grant schedule FY2025",
  obligations: [ob("O1", "500000000", "500000000"), ob("O2", "400000000", "150000000", "output-measure"), ob("O3", "300000000", "0")], ...over });
export const grantB = (over: Partial<Grant> = {}): Grant => base({ grantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", reference: "DONOR-Y-UNRESTRICTED", grantor: "Donor Y", classification: "without-binding-no-present-obligation",
  considerationMinor: "200000000", recognisedResourcesMinor: "200000000", cashReceivedMinor: "200000000", ...over });
export const grantC = (over: Partial<Grant> = {}): Grant => base({ grantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", reference: "DONOR-Z-CONDITION", grantor: "Donor Z", classification: "enforceable-condition",
  considerationMinor: "600000000", recognisedResourcesMinor: "600000000", cashReceivedMinor: "600000000", obligations: [ob("C1", "600000000", "240000000")], ...over });
export const grantD = (over: Partial<Grant> = {}): Grant => base({ grantId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", reference: "DONOR-W-RESTRICTED", grantor: "Donor W", classification: "restriction-only",
  considerationMinor: "100000000", recognisedResourcesMinor: "100000000", cashReceivedMinor: "40000000", ...over });

const answer = (applies: boolean) => ({ ...emptyAnswer(), status: "none_with_basis" as const, text: "Checked the board minutes and accounting policy file", evidence: "Minutes 2026-02 and policy file", flags: { applies } });
export const entity47 = () => ({ transition_47: answer(false) });
export const entity23 = () => ({ early_application_47: answer(false) });
export const TB47 = { revenueMinor: "650000000", liabilityMinor: "550000000", receivableMinor: "450000000" };
export const TB23 = { revenueMinor: "340000000", liabilityMinor: "360000000", receivableMinor: "60000000" };
export const input47 = (over: Partial<GrantsInput> = {}): GrantsInput => ({ period: { ...P47 }, entityAnswers: entity47(), tb: TB47, grants: [{ ...grantA(), assessmentConfirmed: true }, { ...grantB(), assessmentConfirmed: true }], ...over });
export const input23 = (over: Partial<GrantsInput> = {}): GrantsInput => ({ period: { ...P23 }, entityAnswers: entity23(), tb: TB23, grants: [{ ...grantC(), assessmentConfirmed: true }, { ...grantD(), assessmentConfirmed: true }], ...over });
export const confirmed = (g: Grant) => ({ ...g, assessmentConfirmed: true });
