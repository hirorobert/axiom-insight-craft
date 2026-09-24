/**
 * EngagementHub.shared.test.ts — the "Shared with you" row (PR #32 access bridge) stays within the screen however long
 * the workspace name is. The staging browser suite caught it overflowing at 320–375px: the list's implicit grid
 * column grew to the unbreakable name. The browser suite measures the rendered row at every viewport; this pins the
 * two classes that prevent it.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import EngagementHub from "./EngagementHub";

const LONG = "Browser Acceptance 1790234805819-60edf1-a-very-long-unbreakable-workspace-name";

describe("EngagementHub — Shared with you", () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(EngagementHub, {
    entries: [],
    companiesWithoutEngagement: [],
    onResume: () => {},
    onStartService: () => {},
    sharedWorkspaces: [{ id: "s1", name: LONG, capabilities: ["manage_source_files"], fiscal_year_end: null, reporting_framework: null, currency: null, created_at: null }],
    onOpenShared: () => {},
  })));

  it("lists the shared workspace and says it opens Prepare Data", () => {
    expect(html).toContain("Shared with you");
    expect(html).toContain(LONG);
    expect(html).toContain('data-testid="open-shared-s1"');
    expect(html).toContain("Prepare Data");
  });
  it("the list column may shrink (minmax(0,1fr)) and the name truncates instead of widening the row", () => {
    expect(html).toMatch(/<ul class="grid grid-cols-1 gap-2" data-testid="shared-workspaces-list">/);
    expect(html).toMatch(/<span class="min-w-0 [^"]*truncate">Browser Acceptance/);
  });
});
