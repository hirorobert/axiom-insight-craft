// @vitest-environment jsdom
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictNotice } from "@/components/workbench/ConflictNotice";
import { contextKey } from "./context";
import { asVersionConflict, withExpectedVersion } from "./expectedVersion";
import { createRequestGuard } from "./requestSequence";
import { axeViolations, click, mount, type Mounted } from "./testkit/dom";

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; vi.useRealTimers(); });

const ctx = (periodYear = 2025, reportVersion: number | null = 4) => contextKey({ companyId: "c", periodYear, reportVersion });

describe("request sequence guard", () => {
  it("an older response that arrives after a newer one is discarded (deterministic timing)", async () => {
    vi.useFakeTimers();
    const g = createRequestGuard();
    let shown = "";
    const request = (label: string, ms: number) => {
      const t = g.begin("authority", ctx());
      return new Promise<void>((res) => setTimeout(() => { if (g.accepts(t, ctx())) shown = label; res(); }, ms));
    };
    const slowOld = request("old", 300);
    const fastNew = request("new", 50);
    await vi.advanceTimersByTimeAsync(400);
    await Promise.all([slowOld, fastNew]);
    expect(shown).toBe("new");
    expect(g.discarded.map((t) => t.seq)).toEqual([1]);
  });
  it("a response from an obsolete context (period or version switched) is discarded even if it is the newest", () => {
    const g = createRequestGuard();
    const t = g.begin("statements", ctx(2025, 4));
    expect(g.accepts(t, ctx(2024, 4))).toBe(false);
    const t2 = g.begin("statements", ctx(2025, 4));
    expect(g.accepts(t2, ctx(2025, 3))).toBe(false);
    const t3 = g.begin("statements", ctx(2025, 4));
    expect(g.accepts(t3, ctx(2025, 4))).toBe(true);
  });
  it("channels are independent", () => {
    const g = createRequestGuard();
    const a = g.begin("a", ctx());
    const b = g.begin("b", ctx());
    expect(g.accepts(a, ctx())).toBe(true);
    expect(g.accepts(b, ctx())).toBe(true);
  });
});

describe("expected-version writes", () => {
  it("recognises the server's version refusals and nothing else", () => {
    expect(asVersionConflict({ code: "40001", message: "CONTROL_VERSION_CONFLICT: current version 5" })).toEqual({ kind: "version_conflict", detail: null });
    expect(asVersionConflict({ message: "discard stale_version for id=u1" })?.kind).toBe("version_conflict");
    expect(asVersionConflict({ code: "PT409", message: "EXPECTED_VERSION_MISMATCH", details: "changed by R. Swai at 10:02Z" })?.detail).toBe("changed by R. Swai at 10:02Z");
    expect(asVersionConflict({ code: "42501", message: "permission denied" })).toBeNull();
    expect(asVersionConflict({ code: "PT409", message: "PROCESSING_FENCED" })).toBeNull();
    expect(asVersionConflict(null)).toBeNull();
  });
  it("adds the expected version to the RPC arguments", () => {
    expect(withExpectedVersion({ p_id: "x" }, 3)).toEqual({ p_id: "x", p_expected_version: 3 });
    expect(() => withExpectedVersion({}, -1)).toThrow();
  });
});

describe("ConflictNotice", () => {
  it("says nothing was recorded, takes focus, offers reload, and passes axe", async () => {
    const onReload = vi.fn();
    m = mount(h(ConflictNotice, { conflict: { kind: "version_conflict", detail: "changed by R. Swai at 10:02Z" }, what: "ADJ-001", onReload }));
    const alert = m.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Your change was not recorded.");
    expect(alert.textContent).toContain("R. Swai");
    expect(document.activeElement).toBe(alert);
    click(alert.querySelector("button")!);
    expect(onReload).toHaveBeenCalled();
    expect(await axeViolations(m.container)).toEqual([]);
  });
});
