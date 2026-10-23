// @vitest-environment jsdom
import { createElement as h } from "react";
import { MemoryRouter, Route, Routes, Outlet } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveWorkbenchNavigation } from "@/lib/workbench/routes";
import { CompanyWorkspaceHome } from "./CompanyWorkspaceHome";
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ company: { name: "DIVINE" }, companyId: "company-1", periodYear: 2025 }) }));
function render(reporting: boolean, version = "") {
  const model = deriveWorkbenchNavigation("/workspace/company-1/2025", [{ id: "overview", label: "Overview", href: "/workspace/company-1/2025", disabled: false }, { id: "prepare", label: "Trial Balance", href: "/workspace/company-1/2025/prepare", disabled: false }], undefined, reporting);
  return renderToStaticMarkup(h(MemoryRouter, { initialEntries: [`/workspace/company-1/2025?view=company${version}`] }, h(Routes, null,
    h(Route, { element: h(Outlet, { context: { model, next: { label: "Upload trial balance", href: "/workspace/company-1/2025/trial-balance/review" } } }) }, h(Route, { path: "/workspace/:company/:year", element: h(CompanyWorkspaceHome) })))));
}
describe("selected company task menu", () => {
  it("offers only the same authorised, released features as the rail, with the exact company and period", () => {
    const html = render(false);
    expect(html).toContain("DIVINE"); expect(html).toContain("FY2025"); expect(html).toContain('href="/workspace/company-1/2025/trial-balance/review"');
    expect(html).not.toContain("Financial Statements"); expect(html).not.toContain("Sign-off"); expect(html).not.toContain("Taxation");
    expect(html).toContain("Company details"); expect(html).toContain("company=company-1");
  });
  it("preserves the explicitly selected report version on every workspace task and Continue link", () => {
    const document = new DOMParser().parseFromString(render(true, "&v=7"), "text/html");
    const links = [...document.querySelectorAll('a[href^="/workspace/"]')];
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) expect(new URL(link.getAttribute("href")!, "https://fixture.invalid").searchParams.get("v")).toBe("7");
  });
  it("shows reporting features when the existing server-derived model enables them", () => {
    const html = render(true); expect(html).toContain("Financial Statements"); expect(html).toContain("Sign-off &amp; Exports");
  });
});
