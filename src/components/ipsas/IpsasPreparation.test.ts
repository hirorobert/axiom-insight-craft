// @vitest-environment jsdom
import { createElement as h } from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations, click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { IpsasPreparation } from "./IpsasPreparation";

const CO = "99999999-9999-4999-8999-999999999999";
const REV = "88888888-8888-4888-8888-888888888888";
const assessment = { tb: { certificationId: null, isBlocking: null, requiresReview: null, ppeCarryingClosingMinor: null, ppeCarryingOpeningMinor: null, depreciationExpenseMinor: null },
  confirmedClasses: {}, priorConfirmed: false, ppe: null, bridge: null, workpaperId: null, priorFiguresId: null };
const available = { outcome: "available", workpaper: null, priorFigures: null, confirmations: [], assessment };

type Call = { name: string; args: Record<string, unknown> };
function fakeDb(handlers: { save?: (n: number, args: Record<string, unknown>) => { data: unknown; error: unknown }; context?: unknown }) {
  const calls: Call[] = [];
  let saves = 0;
  return {
    calls,
    db: { rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "ipsas_prep_context") return { data: handlers.context ?? available, error: null };
      if (name === "ipsas_save_preparation") return handlers.save!(++saves, args);
      return { data: null, error: { message: "unexpected" } };
    } },
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });
const props = (db: unknown, over: Record<string, unknown> = {}) => ({ companyId: CO, periodYear: 2026, legalName: "Mwamba Community Trust", db, canPrepare: true, canConfirm: false, prepareHref: "/p", ...over });
const tab = (name: string) => [...m!.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name)!;
const button = (text: string) => [...m!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

describe("IpsasPreparation", () => {
  it("shows a named server refusal in plain words and offers no editor", async () => {
    const { db } = fakeDb({ context: { outcome: "framework_not_ipsas_accrual" } });
    m = mount(h(IpsasPreparation, props(db) as never)); await flush();
    expect(m.container.textContent).toContain("does not report under IPSAS accrual");
    expect(m.container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("offers five navigable areas, a single next step from persisted state, and states why issuance is unavailable", async () => {
    const { db } = fakeDb({});
    m = mount(h(IpsasPreparation, props(db) as never)); await flush();
    expect([...m.container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Bring information", "Complete preparation", "Review report", "Approve", "Issue & history"]);
    expect(m.container.querySelector('[aria-label="Next step"]')?.textContent).toContain("bring in the trial balance");
    act(() => click(tab("Issue & history")));
    expect(m.container.textContent).toContain("Official issuance is unavailable");
    expect(m.container.textContent).toContain("No IPSAS report has been issued");
    expect(m.container.textContent).toContain("no accounting author or reviewer");
  });

  it("a lost response is UNKNOWN, keeps the edits, and the retry reuses the ORIGINAL request identity", async () => {
    const { db, calls } = fakeDb({ save: (n) => (n === 1 ? { data: null, error: { message: "network" } } : { data: { outcome: "recorded", revisionId: REV, assessment }, error: null }) });
    m = mount(h(IpsasPreparation, props(db) as never)); await flush();
    act(() => click(tab("Complete preparation")));
    act(() => click(button("Add an asset class")));
    act(() => typeInto(m!.container.querySelector("#c0-label") as HTMLInputElement, "Motor vehicles"));
    await act(async () => { click(button("Save preparation")); });
    await flush();
    expect(m.container.textContent).toContain("We could not confirm whether this was saved");
    expect((m.container.querySelector("#c0-label") as HTMLInputElement).value).toBe("Motor vehicles");
    await act(async () => { click(button("Send the same request again")); });
    await flush();
    const saves = calls.filter((c) => c.name === "ipsas_save_preparation");
    expect(saves.length).toBe(2);
    expect(saves[1].args.p_request_id).toBe(saves[0].args.p_request_id);
    expect(saves[1].args.p_expected_id).toBeNull();
    expect(m.container.textContent).toContain("This is the server's recorded version");
  });

  it("a stale refusal is shown as a refusal (not a save) and the person's edits are kept", async () => {
    const { db } = fakeDb({ save: () => ({ data: { outcome: "stale", currentId: REV }, error: null }) });
    m = mount(h(IpsasPreparation, props(db) as never)); await flush();
    act(() => click(tab("Complete preparation")));
    act(() => click(button("Add an asset class")));
    act(() => typeInto(m!.container.querySelector("#c0-label") as HTMLInputElement, "Office equipment"));
    await act(async () => { click(button("Save preparation")); });
    await flush();
    expect(m.container.textContent).toContain("Someone saved a newer version");
    expect(m.container.textContent).not.toContain("recorded version");
    expect((m.container.querySelector("#c0-label") as HTMLInputElement).value).toBe("Office equipment");
  });

  it("an amount field never turns text into zero: an invalid entry is flagged and the stored value is blank", async () => {
    const { db, calls } = fakeDb({ save: () => ({ data: { outcome: "recorded", revisionId: REV, assessment }, error: null }) });
    m = mount(h(IpsasPreparation, props(db) as never)); await flush();
    act(() => click(tab("Complete preparation")));
    act(() => click(button("Add an asset class")));
    act(() => typeInto(m!.container.querySelector("#c0-openingg") as HTMLInputElement, "12.345"));
    expect(m.container.textContent).toContain("Not an exact amount");
    act(() => typeInto(m!.container.querySelector("#c0-label") as HTMLInputElement, "X"));
    await act(async () => { click(button("Save preparation")); }); await flush();
    const payload = calls.find((c) => c.name === "ipsas_save_preparation")!.args.p_payload as { classes: { opening: { grossMinor: string } }[] };
    expect(payload.classes[0].opening.grossMinor).toBe("");
  });

  it("has no accessibility violations on the preparation area", async () => {
    const { db } = fakeDb({});
    m = mount(h(IpsasPreparation, props(db) as never)); await flush();
    act(() => click(tab("Complete preparation")));
    act(() => click(button("Add an asset class")));
    expect(await axeViolations(m.container)).toEqual([]);
  });
});
