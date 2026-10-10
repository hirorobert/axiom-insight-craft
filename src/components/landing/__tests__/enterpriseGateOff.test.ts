/**
 * The plans with the service-enquiry gate OFF: no contact or activation link may appear, and nothing may imply that a plan
 * can be self-activated — a plain statement takes each action's place, and manual activation is still stated beside it.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/serviceEnquiry/serviceEnquiryGate", async () => {
  const real = await vi.importActual<typeof import("@/lib/serviceEnquiry/serviceEnquiryGate")>("@/lib/serviceEnquiry/serviceEnquiryGate");
  return { ...real, SERVICE_ENQUIRY_PHASE1_ENABLED: false, SERVICE_ENQUIRY_SURFACES: real.surfacesFor(false) };
});

describe("Plans, enquiry gate OFF", () => {
  it("renders controlled statements and no link", async () => {
    const { CapacityPlans } = await import("@/components/landing/CapacityPlans");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CapacityPlans)));
    expect(html).toContain('data-testid="enterprise-unavailable"');
    expect(html).toContain("Terms are agreed directly with our team.");
    expect(html).not.toMatch(/\/contact|Discuss Enterprise|Request activation|plan=/);
    expect(html).toContain('data-testid="plan-unavailable-Solo"');
    expect(html).toContain("Plans are activated by our team.");
    // The proposed-price note is stated once, under the table (no per-row repetition).
    expect(html).toContain('data-testid="plans-activation-note"');
  });
});
