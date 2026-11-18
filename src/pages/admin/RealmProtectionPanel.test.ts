// @vitest-environment jsdom
// The platform-owner control for the realmID encryption backfill: it sends only { action } with the signed-in session, says nothing but counts,
// and never reports success unless the function answered 200 "complete" with no problem rows.
import { createElement as h, act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, click } from "@/lib/workbench/testkit/dom";
import RealmProtectionPanel, { describeMaintenanceAnswer } from "./RealmProtectionPanel";

const tally = (o: Record<string, number>) => ({ total: 0, protected: 0, already: 0, verified: 0, unprotected: 0, mismatched: 0, refused: 0, ...o });
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
let ui: ReturnType<typeof mount> | null = null;
afterEach(() => { ui?.unmount(); ui = null; });

describe("describeMaintenanceAnswer", () => {
  it("reports success only for 200 complete with no problem rows, in counts", () => {
    const r = describeMaintenanceAnswer("protect", 200, { outcome: "complete", action: "protect", connections: tally({ total: 3, protected: 2, already: 1 }), operations: tally({ total: 1, protected: 1 }) });
    expect(r).toEqual({ ok: true, text: expect.stringContaining("Encryption complete. Connections: 2 encrypted now, 1 already encrypted (of 3)") });
    const v = describeMaintenanceAnswer("verify", 200, { outcome: "complete", connections: tally({ total: 3, verified: 3 }), operations: tally({ total: 1, verified: 1 }) });
    expect(v).toEqual({ ok: true, text: "Check complete. Connections: 3 of 3 checked. Disconnect records: 1 of 1 checked." });
  });
  it("an incomplete run is never success and says how many need attention", () => {
    const r = describeMaintenanceAnswer("verify", 409, { outcome: "incomplete", connections: tally({ total: 3, verified: 2, mismatched: 1 }), operations: tally({ total: 1, verified: 1 }) });
    expect(r.ok).toBe(false); expect(r.text).toContain("1 record(s) need attention");
    // A 200 that still carries problem counts, or a 200 without "complete", is not success either.
    expect(describeMaintenanceAnswer("protect", 200, { outcome: "complete", connections: tally({ refused: 1 }), operations: tally({}) }).ok).toBe(false);
    expect(describeMaintenanceAnswer("protect", 200, { outcome: "incomplete", connections: tally({}), operations: tally({}) }).ok).toBe(false);
  });
  it.each([
    [401, { outcome: "unauthorized" }, "Sign in again"],
    [403, { outcome: "forbidden" }, "Only the platform owner"],
    [503, { outcome: "not_configured" }, "not configured"],
    [503, { outcome: "unavailable" }, "could not be checked"],
    [500, { outcome: "failed" }, "did not finish"],
    [null, null, "did not finish"],
    [200, null, "did not finish"],
  ])("status %s is refused plainly", (status, body, text) => {
    const r = describeMaintenanceAnswer("protect", status as number | null, body);
    expect(r.ok).toBe(false); expect(r.text).toContain(text);
  });
  it("never echoes anything but counts (a stray field in the answer is not shown)", () => {
    const r = describeMaintenanceAnswer("protect", 200, { outcome: "complete", realm: "9130350000000001", connections: tally({ total: 1, protected: 1 }), operations: tally({}) });
    expect(r.text).not.toContain("9130350000000001");
  });
});

describe("key rotation answers", () => {
  const kt = (o: Record<string, unknown>) => ({ total: 0, byKey: {}, resealed: 0, already: 0, none: 0, stale: 0, busy: 0, unreadable: 0, mismatched: 0, refused: 0, ...o });
  it("keys: success shows counts by key id only", () => {
    const r = describeMaintenanceAnswer("keys", 200, { outcome: "complete", currentKeyId: "k1", connectionRealms: kt({ total: 3, byKey: { k1: 3 } }), refreshTokens: kt({ total: 3, byKey: { k1: 3 } }), operationRealms: kt({ total: 3, byKey: { k1: 3 } }) });
    expect(r).toEqual({ ok: true, text: "Key check complete. Sealing key: k1. Connections: 3 company IDs readable by key (k1: 3); 3 sign-in tokens readable by key (k1: 3). Disconnect records: 3 readable by key (k1: 3)." });
  });
  it("reseal: incomplete when anything is stale, busy or unreadable; a 503 is never success", () => {
    const r = describeMaintenanceAnswer("reseal", 409, { outcome: "incomplete", currentKeyId: "k2", connectionRealms: kt({ total: 3, resealed: 3 }), refreshTokens: kt({ total: 3, resealed: 2, busy: 1 }), operationRealms: kt({ total: 3, resealed: 3 }) });
    expect(r.ok).toBe(false); expect(r.text).toContain("1 record(s) need attention"); expect(r.text).toContain("Moved to k2");
    expect(describeMaintenanceAnswer("reseal", 503, { outcome: "unavailable" })).toEqual({ ok: false, text: expect.stringContaining("not installed") });
  });
  it("never shows a key value, an envelope or a malformed key name", () => {
    const r = describeMaintenanceAnswer("keys", 200, { outcome: "complete", currentKeyId: "AAAA/secret==", connectionRealms: kt({ total: 1, byKey: { "v1.k1.zzz": 1, k1: 1 } }), refreshTokens: kt({}), operationRealms: kt({}) });
    expect(r.text).not.toContain("secret"); expect(r.text).not.toContain("zzz"); expect(r.text).toContain("Sealing key: unknown");
  });
});

describe("the control", () => {
  it("sends exactly the chosen action, one at a time, and shows the result", async () => {
    let release: (v: { status: number; body: unknown }) => void = () => {};
    const run = vi.fn(() => new Promise<{ status: number; body: unknown }>(r => { release = r; }));
    ui = mount(h(RealmProtectionPanel, { run }));
    const [encrypt, check] = Array.from(ui.container.querySelectorAll("button"));
    click(encrypt);
    expect(run).toHaveBeenCalledWith("protect");
    expect(encrypt.disabled).toBe(true); expect(check.disabled).toBe(true);
    click(check); expect(run).toHaveBeenCalledTimes(1);
    release({ status: 200, body: { outcome: "complete", connections: tally({ total: 1, protected: 1 }), operations: tally({}) } });
    await flush();
    expect(ui.container.querySelector('[role="status"]')?.textContent).toContain("Encryption complete");
    click(check); expect(run).toHaveBeenLastCalledWith("verify");
  });
  it("a thrown call is shown as not finished, never as success", async () => {
    ui = mount(h(RealmProtectionPanel, { run: async () => { throw new Error("network"); } }));
    click(ui.container.querySelector("button")!); await flush();
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain("did not finish");
  });
});
