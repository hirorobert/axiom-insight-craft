// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mount, key, type Mounted } from "@/lib/workbench/testkit/dom";
import { AccountShell } from "./AccountShell";

let ui: Mounted | undefined;
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => undefined;
});
afterEach(() => { ui?.unmount(); ui = undefined; });
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };

describe("header menus retain deterministic keyboard dismissal", () => {
  for (const label of ["Settings menu", "Account menu"]) {
    it(`${label}: Escape closes the menu and returns focus to its own trigger`, async () => {
      ui = mount(h(MemoryRouter, null, h(AccountShell, { onSignOut: vi.fn(), identity: { name: "Fixture Accountant", email: "fixture@example.test" } }, h("h1", null, "Engagements"))));
      const trigger = ui.container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
      act(() => trigger.focus());
      key(trigger, "ArrowDown");
      await settle();
      const menu = document.querySelector('[role="menu"][data-state="open"]')!;
      expect(menu).not.toBeNull();
      key(menu, "Escape");
      await settle();
      expect(document.querySelector('[role="menu"][data-state="open"]')).toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(trigger);
    });
  }
});
