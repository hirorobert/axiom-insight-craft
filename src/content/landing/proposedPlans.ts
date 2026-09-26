/**
 * The proposed plans shown on the landing page: presentation only. Every figure is DERIVED from the one commercial
 * catalogue (PRICING_CATALOGUE, the client mirror of the database catalogue of PR #34), never restated here, so the
 * landing page can never drift from what the product enforces. Amounts are always shown beside the word "Proposed" and
 * never enter structured data.
 */
import { PRICING_CATALOGUE } from "@/lib/commercial/pricingCatalogue";

export interface ProposedPlan {
  readonly name: string;
  /** Proposed amount, always rendered beside the word "Proposed". Never structured data. */
  readonly proposedAmount: string;
  readonly proposedEntities: string;
  readonly proposedUsers: string;
  readonly proposedCapabilities: string;
}

const PUBLIC_CAPABILITIES = "Close Certification, Reporting Pack, Close Insights";
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const PROPOSED_PLANS: readonly ProposedPlan[] = PRICING_CATALOGUE.map((p) => ({
  name: p.name,
  proposedAmount: p.monthlyMinor === null ? "Proposed: terms agreed separately" : `Proposed: USD ${p.monthlyMinor / 100} per month`,
  proposedEntities: p.entityCapacity === null ? "Proposed: capacity agreed separately" : `Proposed: ${count(p.entityCapacity, "entity", "entities")}`,
  proposedUsers: p.includedSeats === null
    ? "Proposed: capacity agreed separately"
    : `Proposed: ${count(p.includedSeats, "named user", "named users")}${p.additionalSeat ? " included" : ""}`,
  proposedCapabilities: PUBLIC_CAPABILITIES,
}));
