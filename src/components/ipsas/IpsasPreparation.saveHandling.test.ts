// @vitest-environment jsdom
/**
 * Save handling of the PPE preparation page (independent review finding: a successful save replaced edits typed while it was in flight).
 * Charter 11.3: a receipt confirms the SUBMITTED snapshot only; unknown outcomes are labelled and retried with the original request identity.
 * Each test holds the server's answer, edits, then releases it, so the order of events is explicit rather than timed.
 */
import { createElement as h } from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { IpsasPreparation } from "./IpsasPreparation";
import { CO, CO2, heldDb } from "./preparationHarness";

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });
const props = (db: unknown, over: Record<string, unknown> = {}) => ({ companyId: CO, periodYear: 2026, legalName: "Mwamba Community Trust", db, canPrepare: true, canConfirm: false, prepareHref: "/p", ...over });
const tab = (name: string) => [...m!.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name)!;
const button = (text: string) => [...m!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const label = () => (m!.container.querySelector("#c0-label") as HTMLInputElement).value;
const type = (id: string, v: string) => act(() => typeInto(m!.container.querySelector(id) as HTMLInputElement, v));
async function openWithOneClass(db: unknown, over: Record<string, unknown> = {}) {
  m = mount(h(IpsasPreparation, props(db, over) as never)); await flush();
  act(() => click(tab("Complete preparation")));
  act(() => click(button("Add an asset class")));
}
const savePreparation = async () => { await act(async () => { click(button("Save preparation")); }); await flush(); };
const release = async (hd: ReturnType<typeof heldDb>, i: number, how: "recorded" | "stale" | "lost" = "recorded") => { await act(async () => { hd.held[i].release(how); await Promise.resolve(); }); await flush(); };

describe("PPE save handling", () => {
  it("REPRODUCTION: an edit typed while the save is in flight survives the receipt and the context refresh, and stays dirty", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "First saved label");
    await savePreparation();
    expect(hd.held).toHaveLength(1);
    type("#c0-label", "New unsaved label");              // typed AFTER submission, while the request is pending
    await release(hd, 0);
    expect(hd.calls.filter((c) => c.name === "ipsas_prep_context").length).toBeGreaterThan(1); // the refresh really happened
    expect(label()).toBe("New unsaved label");
    expect(m!.container.textContent).toContain("You have unsaved edits");
    expect(button("Save preparation").disabled).toBe(false);
    // what the server recorded is exactly the submitted snapshot, not the newer text
    expect((hd.stored.ppe_workpaper!.payload.classes as { label: string }[])[0].label).toBe("First saved label");
  });

  it("with no edit after submission the draft adopts the server's recorded version and nothing is dirty", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "Only label");
    await savePreparation();
    await release(hd, 0);
    expect(label()).toBe("Only label");
    expect(m!.container.textContent).toContain("Everything shown is the server's saved version");
    expect(m!.container.textContent).toContain("This is the server's recorded version");
  });

  it("the next save after an in-flight edit carries the NEW snapshot with the new expected revision and a NEW request identity", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "First saved label");
    await savePreparation();
    type("#c0-label", "New unsaved label");
    await release(hd, 0);
    await savePreparation();
    expect(hd.held).toHaveLength(2);
    const [first, second] = hd.held.map((x) => x.args);
    expect((second.p_payload as { classes: { label: string }[] }).classes[0].label).toBe("New unsaved label");
    expect(second.p_expected_id).toBe(hd.stored.ppe_workpaper!.id);
    expect(second.p_request_id).not.toBe(first.p_request_id);
    await release(hd, 1);
    expect(label()).toBe("New unsaved label");
    expect(m!.container.textContent).toContain("Everything shown is the server's saved version");
  });

  it("a second click while a save is in flight does not start an overlapping submission; the unrelated prior-figure save is not frozen", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "A");
    await savePreparation();
    await act(async () => { click(button("Save preparation")); }); await flush();
    expect(hd.held).toHaveLength(1);                      // still one request: the control is held while its own save is pending
    expect(button("Save preparation").disabled).toBe(true);
    act(() => click(tab("Bring information")));
    type("#prior-amt", "16,000.00");
    await act(async () => { click(button("Save prior figure")); }); await flush();
    expect(hd.held).toHaveLength(2);                      // a different save key proceeds
    expect(hd.held[1].args.p_kind).toBe("prior_figures");
  });

  it("a lost response keeps the edits, is labelled unconfirmed, and the retry reuses the ORIGINAL request identity even after further typing was undone", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "Motor vehicles");
    await savePreparation();
    const original = hd.held[0].args.p_request_id;
    await release(hd, 0, "lost");
    expect(m!.container.textContent).toContain("We could not confirm whether this was saved");
    expect(label()).toBe("Motor vehicles");
    await act(async () => { click(button("Send the same request again")); }); await flush();
    expect(hd.held).toHaveLength(2);
    expect(hd.held[1].args.p_request_id).toBe(original);
    await release(hd, 1);
    expect(m!.container.textContent).toContain("This is the server's recorded version");
  });

  it("an old request completing AFTER a newer one does not clear the newer request's pending state or identity", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "One");
    await savePreparation();                              // request 1 in flight
    type("#c0-label", "Two");
    await release(hd, 0, "lost");                         // 1 ends unknown -> the person edits again and saves anew
    await savePreparation();                              // request 2 (new content, new identity) in flight
    expect(hd.held).toHaveLength(2);
    expect(m!.container.textContent).toContain("Saving…");
    // the old identity is retried by another path while 2 is pending? the control for this key is held, so nothing can overlap
    expect(button("Save preparation").disabled).toBe(true);
    await release(hd, 1);
    expect(label()).toBe("Two");
    expect(m!.container.textContent).toContain("Everything shown is the server's saved version");
  });

  it("'Send the same request again' resends the ORIGINAL request (payload and identity) even if the draft was edited after the unknown outcome; the edit stays unsaved", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "Original intent");
    await savePreparation();
    const original = hd.held[0].args;
    await release(hd, 0, "lost");
    type("#c0-label", "Edited after the lost response");
    await act(async () => { click(button("Send the same request again")); }); await flush();
    expect(hd.held).toHaveLength(2);
    expect(hd.held[1].args.p_request_id).toBe(original.p_request_id);
    expect((hd.held[1].args.p_payload as { classes: { label: string }[] }).classes[0].label).toBe("Original intent");
    await release(hd, 1);
    expect(label()).toBe("Edited after the lost response");
    expect(m!.container.textContent).toContain("You have unsaved edits");
  });

  it("a stale refusal after submission keeps the newer edit and names the refusal", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "First");
    await savePreparation();
    type("#c0-label", "Newer");
    await release(hd, 0, "stale");
    expect(m!.container.textContent).toContain("Someone saved a newer version");
    expect(label()).toBe("Newer");
  });
});

describe("a late answer for another company or period", () => {
  it("is discarded: it cannot change the draft, the banner, the request identity or the recovery state of the new scope", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "Company A label");
    await savePreparation();                              // pending for company A
    const idA = hd.held[0].args.p_request_id;
    // switch company on the SAME mounted component (the page also remounts by key; the component must be safe on its own)
    m!.rerender(h(IpsasPreparation, props(hd.db, { companyId: CO2 }) as never)); await flush();
    act(() => click(tab("Complete preparation")));
    expect(m!.container.querySelector("#c0-label")).toBeNull();     // company B has no class: its draft is its own
    await release(hd, 0);                                           // company A's answer arrives late
    expect(m!.container.querySelector("#c0-label")).toBeNull();
    expect(m!.container.textContent).not.toContain("This is the server's recorded version");
    expect(m!.container.textContent).not.toContain("Saving…");
    // company B can save with a fresh identity (A's identity was not carried over or deleted into B's state)
    act(() => click(button("Add an asset class")));
    type("#c0-label", "Company B label");
    await savePreparation();
    expect(hd.held).toHaveLength(2);
    expect(hd.held[1].args.p_company_id).toBe(CO2);
    expect(hd.held[1].args.p_request_id).not.toBe(idA);
  });

  it("a period change behaves the same", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "FY2026");
    await savePreparation();
    m!.rerender(h(IpsasPreparation, props(hd.db, { periodYear: 2027 }) as never)); await flush();
    await release(hd, 0);
    expect(m!.container.textContent).not.toContain("This is the server's recorded version");
    expect(m!.container.textContent).toContain("2027");
  });
});

describe("an old operation completing after a newer one has started", () => {
  it("cannot clear the newer operation's pending state, request identity or in-flight guard", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "Company A");
    await savePreparation();                                      // operation A: pending on key 'workpaper'
    m!.rerender(h(IpsasPreparation, props(hd.db, { companyId: CO2 }) as never)); await flush();
    act(() => click(tab("Complete preparation")));
    act(() => click(button("Add an asset class")));
    type("#c0-label", "Company B");
    await savePreparation();                                      // operation B: same key, newer scope
    const idB = hd.held[1].args.p_request_id;
    await release(hd, 0);                                         // A answers late
    expect(m!.container.textContent).toContain("Saving…");       // B is still pending
    expect(button("Save preparation").disabled).toBe(true);
    await act(async () => { click(button("Save preparation")); }); await flush();
    expect(hd.held).toHaveLength(2);                              // B's guard still holds: no third request
    await release(hd, 1);
    expect(m!.container.textContent).toContain("This is the server's recorded version");
    expect(hd.held[1].args.p_request_id).toBe(idB);
    expect(hd.stored.ppe_workpaper!.payload.companyId).toBe(CO2);
  });
});

describe("a change of actor or capability while a save is pending", () => {
  it("a different database client (another signed-in actor) starts clean: the old actor's late answer changes nothing", async () => {
    const hdA = heldDb(), hdB = heldDb();
    await openWithOneClass(hdA.db);
    type("#c0-label", "Actor A");
    await savePreparation();
    m!.rerender(h(IpsasPreparation, props(hdB.db) as never)); await flush();
    await release(hdA, 0);
    expect(m!.container.textContent).not.toContain("This is the server's recorded version");
    expect(m!.container.textContent).not.toContain("Saving…");
    expect(hdB.calls.filter((c) => c.name.startsWith("ipsas_save")).length).toBe(0);
  });

  it("losing the right to prepare while a save is pending: the pending answer is still shown honestly and the editor is no longer offered", async () => {
    const hd = heldDb();
    await openWithOneClass(hd.db);
    type("#c0-label", "Before revocation");
    await savePreparation();
    m!.rerender(h(IpsasPreparation, props(hd.db, { canPrepare: false }) as never)); await flush();
    expect((m!.container.querySelector("#c0-label") as HTMLInputElement).disabled).toBe(true);
    expect(button("Save preparation").disabled).toBe(true);
    await release(hd, 0);
    expect(m!.container.textContent).toContain("This is the server's recorded version");
    expect(button("Save preparation").disabled).toBe(true);
  });
});
