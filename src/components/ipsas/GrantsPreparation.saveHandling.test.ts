// @vitest-environment jsdom
/**
 * Save handling of the grants section, tested independently of the PPE page (the code is similar, but similarity is not evidence):
 * a receipt confirms the SUBMITTED snapshot only; an edit typed while the save is in flight survives and stays unsaved; one request per key;
 * an answer for another company, period or actor is dropped; an unknown outcome is retried as the original request.
 */
import { createElement as h } from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { GrantsPreparation } from "./GrantsPreparation";
import { CO, CO2, heldDb } from "./preparationHarness";

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });
const props = (db: unknown, over: Record<string, unknown> = {}) => ({ companyId: CO, periodYear: 2026, legalName: "Mwamba Community Trust", db, canPrepare: true, canConfirm: false, area: "prepare", ...over });
const button = (text: string) => [...m!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const field = () => m!.container.querySelector("#gr0-ref") as HTMLInputElement;
const type = (v: string) => act(() => typeInto(field(), v));
async function openWithOneGrant(db: unknown, over: Record<string, unknown> = {}) {
  m = mount(h(GrantsPreparation, props(db, over) as never)); await flush();
  act(() => click(button("Add a grant")));
}
const saveGrants = async () => { await act(async () => { click(button("Save grants")); }); await flush(); };
const release = async (hd: ReturnType<typeof heldDb>, i: number, how: "recorded" | "stale" | "lost" = "recorded") => { await act(async () => { hd.held[i].release(how); await Promise.resolve(); }); await flush(); };

describe("grants save handling", () => {
  it("REPRODUCTION (grants, independently): an edit typed while the save is in flight survives the receipt and the refresh, and stays dirty", async () => {
    const hd = heldDb();
    await openWithOneGrant(hd.db);
    type("First saved reference");
    await saveGrants();
    expect(hd.held).toHaveLength(1);
    type("New unsaved reference");
    await release(hd, 0);
    expect(hd.calls.filter((c) => c.name === "ipsas_grants_context").length).toBeGreaterThan(1);
    expect(field().value).toBe("New unsaved reference");
    expect(button("Save grants").disabled).toBe(false);
    expect((hd.stored.grants!.payload.grants as { reference: string }[])[0].reference).toBe("First saved reference");
  });

  it("with no edit after submission the draft adopts the server's recorded version and nothing is dirty", async () => {
    const hd = heldDb();
    await openWithOneGrant(hd.db);
    type("Only reference");
    await saveGrants();
    await release(hd, 0);
    expect(field().value).toBe("Only reference");
    expect(button("Save grants").disabled).toBe(true);        // nothing unsaved
    expect(m!.container.textContent).toContain("This is the server's recorded version");
  });

  it("the next save carries the NEW snapshot, the new expected revision and a NEW request identity", async () => {
    const hd = heldDb();
    await openWithOneGrant(hd.db);
    type("First");
    await saveGrants();
    type("Second");
    await release(hd, 0);
    await saveGrants();
    expect(hd.held).toHaveLength(2);
    expect((hd.held[1].args.p_payload as { grants: { reference: string }[] }).grants[0].reference).toBe("Second");
    expect(hd.held[1].args.p_expected_id).toBe(hd.stored.grants!.id);
    expect(hd.held[1].args.p_request_id).not.toBe(hd.held[0].args.p_request_id);
  });

  it("a second click while a save is in flight does not start an overlapping submission", async () => {
    const hd = heldDb();
    await openWithOneGrant(hd.db);
    type("A");
    await saveGrants();
    await act(async () => { click(button("Save grants")); }); await flush();
    expect(hd.held).toHaveLength(1);
    expect(button("Save grants").disabled).toBe(true);
  });

  it("'Send the same request again' resends the ORIGINAL request (payload and identity) even if the draft was edited after the unknown outcome", async () => {
    const hd = heldDb();
    await openWithOneGrant(hd.db);
    type("Original intent");
    await saveGrants();
    const original = hd.held[0].args;
    await release(hd, 0, "lost");
    expect(m!.container.textContent).toContain("We could not confirm whether this was saved");
    type("Edited after the lost response");
    await act(async () => { click(button("Send the same request again")); }); await flush();
    expect(hd.held).toHaveLength(2);
    expect(hd.held[1].args.p_request_id).toBe(original.p_request_id);
    expect((hd.held[1].args.p_payload as { grants: { reference: string }[] }).grants[0].reference).toBe("Original intent");
    await release(hd, 1);
    expect(field().value).toBe("Edited after the lost response");
    expect(button("Save grants").disabled).toBe(false);
  });

  it("a stale refusal after submission keeps the newer edit", async () => {
    const hd = heldDb();
    await openWithOneGrant(hd.db);
    type("First");
    await saveGrants();
    type("Newer");
    await release(hd, 0, "stale");
    expect(m!.container.textContent).toContain("Someone saved a newer version");
    expect(field().value).toBe("Newer");
  });
});

describe("grants: a late answer for another company, period or actor", () => {
  it("is discarded, and an old operation cannot clear the newer scope's pending state or identity", async () => {
    const hd = heldDb();
    await openWithOneGrant(hd.db);
    type("Company A");
    await saveGrants();
    const idA = hd.held[0].args.p_request_id;
    m!.rerender(h(GrantsPreparation, props(hd.db, { companyId: CO2 }) as never)); await flush();
    expect(m!.container.querySelector("#gr0-ref")).toBeNull();
    act(() => click(button("Add a grant")));
    type("Company B");
    await saveGrants();                                         // the new scope's own operation, same key
    expect(hd.held).toHaveLength(2);
    expect(hd.held[1].args.p_request_id).not.toBe(idA);
    await release(hd, 0);                                       // A answers late
    expect(m!.container.textContent).toContain("Saving…");     // B still pending
    expect(button("Save grants").disabled).toBe(true);
    await release(hd, 1);
    expect(field().value).toBe("Company B");
    expect(m!.container.textContent).toContain("This is the server's recorded version");
  });

  it("another period is treated the same", async () => {
    const hd = heldDb();
    await openWithOneGrant(hd.db);
    type("FY2026");
    await saveGrants();
    m!.rerender(h(GrantsPreparation, props(hd.db, { periodYear: 2027 }) as never)); await flush();
    await release(hd, 0);
    expect(m!.container.textContent).not.toContain("This is the server's recorded version");
    expect(m!.container.querySelector("#gr0-ref")).toBeNull();
  });

  it("another actor's client starts clean: the first actor's late answer changes nothing", async () => {
    const hdA = heldDb(), hdB = heldDb();
    await openWithOneGrant(hdA.db);
    type("Actor A");
    await saveGrants();
    m!.rerender(h(GrantsPreparation, props(hdB.db) as never)); await flush();
    await release(hdA, 0);
    expect(m!.container.textContent).not.toContain("This is the server's recorded version");
    expect(m!.container.textContent).not.toContain("Saving…");
    expect(m!.container.querySelector("#gr0-ref")).toBeNull();
  });

  it("losing the right to prepare while a save is pending: the answer is shown honestly and the editor is no longer offered", async () => {
    const hd = heldDb();
    await openWithOneGrant(hd.db);
    type("Before revocation");
    await saveGrants();
    m!.rerender(h(GrantsPreparation, props(hd.db, { canPrepare: false }) as never)); await flush();
    expect(field().disabled).toBe(true);
    expect(button("Save grants").disabled).toBe(true);
    await release(hd, 0);
    expect(m!.container.textContent).toContain("This is the server's recorded version");
  });
});
