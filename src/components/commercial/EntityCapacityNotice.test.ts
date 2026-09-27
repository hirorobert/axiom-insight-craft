import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { EntityCapacityNotice } from "./EntityCapacityNotice";

const render = (props: Parameters<typeof EntityCapacityNotice>[0]) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(EntityCapacityNotice, props)));

describe("add-entity presentation", () => {
  it("keeps existing companies accessible at capacity and offers plans", () => {
    const html = render({ capacity: { determined: true, capacity: 1, used: 1, planCode: "SOLO" }, loading: false, error: false });
    expect(html).toContain("Entity capacity reached. Existing companies remain accessible.");
    expect(html).toContain("/plans");
    expect(html).not.toMatch(/deactivation/i);
  });
  it("distinguishes no plan from capacity and unknown reads", () => {
    expect(render({ capacity: { determined: true, capacity: 0, used: 1, planCode: null }, loading: false, error: false })).toContain("No active plan");
    expect(render({ capacity: null, loading: false, error: true, onRetry: () => undefined })).toContain("Retry");
    expect(render({ capacity: null, loading: true, error: false })).toContain("Checking entity capacity");
    expect(render({ capacity: { determined: true, capacity: 1, used: 0, planCode: "SOLO" }, loading: false, error: false })).toBe("");
  });
});