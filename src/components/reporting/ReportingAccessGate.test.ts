// @vitest-environment jsdom
/**
 * S2-C07 — a customer who opens a reporting page for a company outside the pilot is told what it is and how to ask.
 * The neutral boundary of the other withheld routes (moduleAvailability.test.ts §3) is unchanged.
 */
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "@/lib/workbench/testkit/dom";

const { state } = vi.hoisted(() => ({ state: { reporting: { state: "disabled", reason: "NOT_ENABLED" } as Record<string, unknown>, statements: true } }));
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ companyId: "c1", access: { statements: state.statements } }) }));
vi.mock("@/hooks/useReportingAccess", () => ({ useReportingAccess: () => state.reporting }));
vi.mock("@/lib/workspace/workspaceAccess", () => ({ canOpenStage: (access: { statements: boolean }) => access.statements }));

import ReportingAccessGate from "./ReportingAccessGate";

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });
const render = () => mount(h(MemoryRouter, null, h(ReportingAccessGate, null, h("p", null, "reporting page"))));

describe("S2-C07 · the reporting boundary names the pilot and the way to ask", () => {
  for (const [label, reporting, statements] of [
    ["the company is not in the pilot", { state: "disabled", reason: "NOT_ENABLED" }, true],
    ["the access read failed", { state: "disabled", reason: "UNKNOWN" }, true],
    ["the stage is not open to this member", { state: "enabled", role: null }, false],
  ] as const) {
    it(`${label}: says financial reporting is a pilot by invitation, links to support, and renders no reporting page`, () => {
      state.reporting = reporting; state.statements = statements;
      m = render();
      const t = m.container.textContent ?? "";
      expect(t).toContain("Financial reporting is a pilot by invitation");
      expect(t).toContain("support@cfoclose.com");
      expect(m.container.querySelector('a[href^="mailto:support@cfoclose.com"]')).not.toBeNull();
      expect(m.container.querySelector('a[href="/dashboard"]')).not.toBeNull();
      expect(t).not.toContain("reporting page");
    });
  }
  it("enabled: the reporting page renders", () => {
    state.reporting = { state: "enabled", role: "owner" }; state.statements = true;
    m = render();
    expect(m.container.textContent).toContain("reporting page");
  });
});
