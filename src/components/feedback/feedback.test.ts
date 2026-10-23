// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mount, click, key, typeInto, axeViolations, type Mounted } from "@/lib/workbench/testkit/dom";
import { ActivityProvider, PendingStatus } from "./Activity";
import { ActionButton } from "./ActionButton";
import { useBusyState } from "@/hooks/useBusyState";
import { ConfirmDialog } from "@/components/workbench/ConfirmDialog";

let ui: Mounted | undefined;
afterEach(() => { ui?.unmount(); ui = undefined; vi.useRealTimers(); });
function frame(children: ReturnType<typeof h>) {
  return h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, h(ActivityProvider, null, children));
}
const bar = () => document.querySelector('[data-testid="activity-indicator"]');

describe("truthful pending feedback", () => {
  it("acknowledges immediately, takes a synchronous lock, and unlocks only after the promise settles", async () => {
    let release!: () => void;
    const request = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    let invoke!: () => Promise<void>;
    function Example() {
      const [busy, setBusy] = useBusyState("Saving the decision…");
      invoke = async () => { if (!setBusy(true)) return; try { await request(); } finally { setBusy(false); } };
      return h(ActionButton, { busy, busyLabel: "Saving…", onClick: () => void invoke() }, "Record decision");
    }
    ui = mount(frame(h(Example)));
    act(() => { void invoke(); void invoke(); });
    expect(request).toHaveBeenCalledTimes(1);
    const button = ui.container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Saving…");
    expect(bar()).not.toBeNull();
    await act(async () => { release(); });
    expect(button.disabled).toBe(false);
    expect(bar()).toBeNull();
    expect(button.textContent).toBe("Record decision");
  });

  it("keeps concurrent work visible until every source finishes; unmount cleans up", () => {
    ui = mount(frame(h("div", null, h(PendingStatus, { key: "a", label: "Reading statements…" }), h(PendingStatus, { key: "b", label: "Reading notes…" }))));
    expect(bar()).not.toBeNull();
    ui.rerender(frame(h("div", null, h(PendingStatus, { key: "b", label: "Reading notes…" }))));
    expect(bar()).not.toBeNull();
    ui.rerender(frame(h("div", null, "Ready")));
    expect(bar()).toBeNull();
  });

  it("delays decoration, never invents percentages, and does not hold ready content back", () => {
    vi.useFakeTimers();
    ui = mount(frame(h(PendingStatus, { label: "Reading engagements…", skeleton: true })));
    expect(ui.container.textContent).toContain("Reading engagements…");
    expect(ui.container.querySelector(".invisible")).not.toBeNull();
    expect(ui.container.querySelector('[role="progressbar"]')).toBeNull();
    act(() => vi.advanceTimersByTime(180));
    expect(ui.container.querySelector(".invisible")).toBeNull();
    ui.rerender(frame(h("p", null, "Ready")));
    expect(ui.container.textContent).toContain("Ready");
    expect(bar()).toBeNull();
  });

  it("keeps a long wait uncertain, without inventing a failure or completing it on a timer", () => {
    vi.useFakeTimers();
    ui = mount(frame(h(PendingStatus, { label: "Checking the report…" })));
    act(() => vi.advanceTimersByTime(12000));
    expect(ui.container.textContent).toContain("The result has not been confirmed yet");
    expect(bar()).not.toBeNull();
    ui.rerender(frame(h("p", null, "Ready")));
    expect(ui.container.textContent).not.toContain("Still waiting");
    expect(bar()).toBeNull();
  });

  it("does not show activity for an instant page with no pending work", () => {
    ui = mount(frame(h("h1", null, "Companies")));
    expect(bar()).toBeNull();
  });

  it("preserves a confirmation reason and refuses Escape and Cancel during the commit", () => {
    const cancel = vi.fn(), confirm = vi.fn();
    const props = { open: true, title: "Approve as final", period: "FY2026", version: "Version 1", consequences: "This version is sealed.", reasonMinLength: 3, confirmLabel: "Approve as final", onConfirm: confirm, onCancel: cancel };
    ui = mount(h(ConfirmDialog, props));
    typeInto(ui.container.querySelector("textarea")!, "Reviewed the source evidence");
    ui.rerender(h(ConfirmDialog, { ...props, busy: true }));
    key(ui.container.querySelector('[role="dialog"]')!, "Escape");
    const buttons = [...ui.container.querySelectorAll("button")];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    click(buttons[1]);
    expect(cancel).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    ui.rerender(h(ConfirmDialog, props));
    expect(ui.container.querySelector("textarea")!.value).toBe("Reviewed the source evidence");
  });

  it("labels pending feedback for assistive technology", async () => {
    ui = mount(h(PendingStatus, { label: "Preparing the stored report…", skeleton: true }));
    expect(await axeViolations(ui.container)).toEqual([]);
  });
});
