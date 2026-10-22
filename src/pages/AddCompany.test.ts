import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
const reads = vi.hoisted(() => ({ discovery: { loading: false, fetchFailed: false, refresh: vi.fn() }, billing: { loading: false, error: null, summary: { licenceStatus: "ACTIVE" } }, capacity: { loading: false, error: false, capacity: { determined: true, capacity: 5, used: 0 } } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "invented", email: "invented@example.test" }, loading: false, signOut: vi.fn() }) }));
vi.mock("@/hooks/useAccountHome", () => ({ useAccountHome: () => reads.discovery }));
vi.mock("@/hooks/useBillingSummary", () => ({ useBillingSummary: () => reads.billing }));
vi.mock("@/hooks/useMyEntityCapacity", () => ({ useMyEntityCapacity: () => reads.capacity }));
vi.mock("@/components/workspace/FirstRunEngagement", () => ({ default: () => createElement("form", { "data-testid": "existing-creation-contract" }) }));
import AddCompany from "./AddCompany";
const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AddCompany)));
beforeEach(() => { reads.discovery.loading = false; reads.discovery.fetchFailed = false; reads.billing.loading = false; reads.billing.error = null; reads.billing.summary.licenceStatus = "ACTIVE"; reads.capacity.loading = false; reads.capacity.capacity.used = 0; });
describe("focused company setup", () => {
  it("does not mount a writer until discovery, billing and capacity have all resolved", () => {
    for (const read of [reads.discovery, reads.billing, reads.capacity]) {
      read.loading = true;
      expect(render()).not.toContain("existing-creation-contract");
      read.loading = false;
    }
    expect(render()).toContain("existing-creation-contract");
  });
  it("a failed discovery stays a retriable error, never an empty account", () => {
    reads.discovery.fetchFailed = true;
    const html = render();
    expect(html).toContain("Try again");
    expect(html).not.toContain("existing-creation-contract");
  });
  it("no plan or exhausted capacity preserves historical access and withholds the form", () => {
    reads.billing.summary.licenceStatus = "EXPIRED";
    expect(render()).toContain("Choose a plan before adding a company");
    expect(render()).not.toContain("existing-creation-contract");
    reads.billing.summary.licenceStatus = "ACTIVE";
    reads.capacity.capacity.used = 5;
    expect(render()).toContain("Your company capacity is in use");
    expect(render()).not.toContain("existing-creation-contract");
    expect(render()).toContain("existing companies and records remain accessible");
  });
});
