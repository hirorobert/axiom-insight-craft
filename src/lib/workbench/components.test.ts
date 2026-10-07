// @vitest-environment jsdom
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "@/components/workbench/ConfirmDialog";
import { SecondaryPanel } from "@/components/workbench/SecondaryPanel";
import { DraftState, draftStateText } from "@/components/workbench/DraftState";
import { NextOpenItem, WorkbenchNav } from "@/components/workbench/WorkbenchNav";
import { StatusWord } from "@/components/workbench/StatusWord";
import { deriveWorkbenchNavigation } from "./routes";
import { MISSION_STATUS_WORDS } from "./statusWords";
import { axeViolations, click, key, mount, typeInto, type Mounted } from "./testkit/dom";

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; });

function withTrigger(child: (open: boolean) => ReturnType<typeof h>) {
  // A trigger button that has focus before the dialog/panel opens.
  const trigger = document.createElement("button");
  trigger.textContent = "Open";
  document.body.appendChild(trigger);
  trigger.focus();
  return { trigger, el: (open: boolean) => child(open) };
}

describe("ConfirmDialog (material actions only)", () => {
  const base = { title: "Approve ADJ-001", period: "FY2025", version: "4", consequences: "Profit changes from 7,280,000 to 6,080,000.", confirmLabel: "Approve" };
  it("states period, version and consequences; focuses the reason; requires it", async () => {
    const onConfirm = vi.fn();
    m = mount(h(ConfirmDialog, { ...base, open: true, reasonMinLength: 5, onConfirm, onCancel: () => {} }));
    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(dlg.textContent).toContain("FY2025");
    expect(dlg.textContent).toContain("4");
    expect(dlg.textContent).toContain("Profit changes");
    const reason = dlg.querySelector("textarea")!;
    expect(document.activeElement).toBe(reason);
    const ok = [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Approve")!;
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    typeInto(reason, "abc");
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    typeInto(reason, "Agreed to letter");
    expect((ok as HTMLButtonElement).disabled).toBe(false);
    click(ok);
    expect(onConfirm).toHaveBeenCalledWith("Agreed to letter");
    expect(await axeViolations(dlg)).toEqual([]);
  });
  it("requires the acknowledgement for a self-approval", () => {
    m = mount(h(ConfirmDialog, { ...base, open: true, acknowledgement: "This self-approval will be disclosed.", onConfirm: () => {}, onCancel: () => {} }));
    const dlg = document.querySelector('[role="dialog"]')!;
    const ok = [...dlg.querySelectorAll("button")].find((b) => b.textContent === "Approve") as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    click(dlg.querySelector('input[type="checkbox"]')!);
    expect(ok.disabled).toBe(false);
  });
  it("Escape cancels and returns focus to the trigger; Tab stays inside", () => {
    const { trigger, el } = withTrigger((open) => h(ConfirmDialog, { ...base, open, reasonMinLength: 5, onConfirm: () => {}, onCancel: () => m!.rerender(el(false)) }));
    m = mount(el(true));
    const dlg = document.querySelector('[role="dialog"]')!;
    const buttons = [...dlg.querySelectorAll("button")];
    const last = buttons[buttons.length - 1] as HTMLElement;
    last.focus();
    key(last, "Tab");
    expect(dlg.contains(document.activeElement)).toBe(true);
    key(document.activeElement!, "Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("SecondaryPanel", () => {
  it("moves focus in on open and back to the opener on Escape", async () => {
    const { trigger, el } = withTrigger((open) => h(SecondaryPanel, { open, title: "Where this figure comes from", onClose: () => m!.rerender(el(false)) }, "Lineage"));
    m = mount(el(true));
    const panel = document.querySelector('[role="complementary"]')!;
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(await axeViolations(panel)).toEqual([]);
    key(document.activeElement!, "Escape");
    expect(document.querySelector('[role="complementary"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("DraftState", () => {
  it("never reads as submitted or approved", () => {
    for (const s of ["saving", "saved", "failed"] as const) {
      const t = draftStateText(s, "10:42");
      expect(t.replace(/not submitted/i, "")).not.toMatch(/submitted/i);
      expect(t).not.toMatch(/approved/i);
    }
    expect(draftStateText("saved", "10:42")).toContain("not submitted");
    m = mount(h(DraftState, { state: "failed", savedAt: null, onRetry: () => {} }));
    expect(m.container.querySelector('[role="status"]')!.textContent).toContain("Draft not saved");
  });
});

describe("WorkbenchNav", () => {
  const BASE = "/workspace/c1/2025";
  const model = deriveWorkbenchNavigation(BASE, [
    { id: "overview", label: "Overview", href: BASE, disabled: false, inputEvidenceOnly: false },
    { id: "prepare", label: "Prepare", href: `${BASE}/prepare`, disabled: false, inputEvidenceOnly: false },
    { id: "reconcile", label: "Reconcile", href: `${BASE}/reconcile`, disabled: false, inputEvidenceOnly: false },
  ]);
  it("lists the released groups, marks the current page, carries the report version, and passes axe", async () => {
    m = mount(h(MemoryRouter, null, h(WorkbenchNav, { model, activePage: "tb-review", reportVersion: 4, groupStatus: () => MISSION_STATUS_WORDS.review_required })));
    const nav = m.container.querySelector('nav[aria-label="Engagement"]')!;
    const text = nav.textContent ?? "";
    expect(text).toContain("Trial Balance");
    expect(text).not.toMatch(/Close Review|Financial Statements|Sign-off/);
    expect(text).not.toMatch(/Tax|Monitor|Compliance|Filing/);
    const current = nav.querySelector('[aria-current="page"]')!;
    expect(current.textContent).toBe("Account review");
    for (const a of nav.querySelectorAll("a")) expect(a.getAttribute("href")).toMatch(/\?v=4$/);
    expect(text).toContain("Reconcile");
    expect(text).toContain("Needs review");
    expect(await axeViolations(nav)).toEqual([]);
  });
  it("renders the inline next open item as one link carrying the version", () => {
    m = mount(h(MemoryRouter, null, h(NextOpenItem, { label: "Review 1 account", href: `${BASE}/trial-balance/review`, reportVersion: 4 })));
    const a = m.container.querySelector('[data-testid="next-open-item"] a')!;
    expect(a.getAttribute("href")).toBe(`${BASE}/trial-balance/review?v=4`);
  });
  it("StatusWord pairs icon and text", () => {
    m = mount(h(StatusWord, { value: MISSION_STATUS_WORDS.blocked }));
    expect(m.container.textContent).toBe("✕Blocked");
    expect(m.container.querySelector('[aria-hidden="true"]')!.textContent).toBe("✕");
  });
});
