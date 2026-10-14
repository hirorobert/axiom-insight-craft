import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import fs from "node:fs";
import path from "node:path";
import { CommercialAdminLink, isCommercialAdminAnswer } from "./CommercialAdminLink";

const render = (visible: boolean) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CommercialAdminLink, { visible })));

describe("Settings → Commercial administration link", () => {
  it("only a literal true from is_commercial_admin() with no error is authority", () => {
    expect(isCommercialAdminAnswer(true, null)).toBe(true);
    for (const [d, e] of [[false, null], [null, null], ["true", null], [1, null], [{}, null], [true, { code: "42501" }], [undefined, new Error("network")]] as const)
      expect(isCommercialAdminAnswer(d, e)).toBe(false);
  });
  it("administrator sees the link to the existing route; anyone else (or while loading / on error) sees nothing", () => {
    expect(render(true)).toContain('href="/commercial/admin"');
    expect(render(true)).toContain("Commercial administration");
    expect(render(false)).toBe("");
  });
  it("Settings uses the server predicate (never email or role) and the route is unchanged", () => {
    const settings = fs.readFileSync(path.join(__dirname, "../../pages/Settings.tsx"), "utf8");
    expect(settings).toMatch(/useIsCommercialAdmin\(user\?\.id\)/);
    expect(settings).not.toMatch(/@gmail\.com|cfoclose\.com/);
    const hook = fs.readFileSync(path.join(__dirname, "CommercialAdminLink.tsx"), "utf8");
    expect(hook).toContain('"is_commercial_admin"');
    expect(hook).not.toMatch(/email|role/i.test("") ? /x/ : /\.email|firm_members|localStorage/);
    expect(fs.readFileSync(path.join(__dirname, "../../App.tsx"), "utf8")).toContain('<Route path="/commercial/admin" element={<CommercialAdmin />} />');
  });
});
