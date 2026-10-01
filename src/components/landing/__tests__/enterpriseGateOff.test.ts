/**
 * Enterprise with the service-enquiry gate OFF: no contact link may appear, and nothing may imply that Enterprise can be
 * self-activated — a plain statement takes its place.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/serviceEnquiry/serviceEnquiryGate", async () => {
  const real = await vi.importActual<typeof import("@/lib/serviceEnquiry/serviceEnquiryGate")>("@/lib/serviceEnquiry/serviceEnquiryGate");
  return { ...real, SERVICE_ENQUIRY_PHASE1_ENABLED: false, SERVICE_ENQUIRY_SURFACES: real.surfacesFor(false) };
});

describe("Enterprise, enquiry gate OFF", () => {
  it("renders a controlled statement and no link", async () => {
    const { CapacityPlans } = await import("@/components/landing/CapacityPlans");
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CapacityPlans)));
    expect(html).toContain('data-testid="enterprise-unavailable"');
    expect(html).toContain("Terms are agreed directly with our team.");
    expect(html).not.toMatch(/\/contact|Discuss Enterprise|Choose Enterprise|plan=enterprise/);
    expect(html).toContain('data-testid="plan-action-Solo"');
  });
});
