// @vitest-environment jsdom
import { createElement as h, act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { axeViolations, click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { GrantsPreparation } from "./GrantsPreparation";
import { grantA, grantB, TB47, entity47 } from "@/lib/ipsasAccrual/grants.fixture";

const CO = "99999999-9999-4999-8999-999999999999", REV = "88888888-8888-4888-8888-888888888888";
const live = (model: "ipsas23" | "ipsas47" | null, over: Record<string, unknown> = {}) => ({
  period: { certificationId: null, start: model === "ipsas23" ? "2025-01-01" : model === "ipsas47" ? "2026-01-01" : null, end: model ? "2026-12-31" : null }, revisionId: null, tb: null, confirmedGrants: {}, assessment: null, ...over });
const ctxOf = (model: "ipsas23" | "ipsas47" | null, register: unknown = null, l: Record<string, unknown> = {}) => ({ outcome: "available", register, confirmations: [],
  live: live(model, { assessment: model ? { model, state: "incomplete", codes: [], grants: [], totals: { periodRevenueMinor: null, liabilityMinor: null, receivableMinor: null } } : null, ...l }) });
type Call = { name: string; args: Record<string, unknown> };
function fakeDb(o: { context?: unknown; save?: (n: number) => { data: unknown; error: unknown } }) {
  const calls: Call[] = []; let n = 0;
  return { calls, db: { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "ipsas_grants_context") return { data: o.context ?? ctxOf("ipsas47"), error: null };
    if (name === "ipsas_save_grants") return o.save!(++n);
    return { data: null, error: { message: "unexpected" } };
  } } };
}
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });
const props = (db: unknown, over: Record<string, unknown> = {}) => ({ companyId: CO, periodYear: 2026, legalName: "Mwamba Community Trust", db, canPrepare: true, canConfirm: false, area: "prepare", ...over });
const button = (text: string) => [...m!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;
const options = (id: string) => [...(m!.container.querySelector(`#${id}`) as HTMLSelectElement).options].map((o) => o.value).filter(Boolean);

describe("GrantsPreparation", () => {
  it("does not report no open matters while the authoritative context is pending or unreadable", async () => {
    let rejectRead!: (e: Error) => void;
    const pending = new Promise((_resolve, reject) => { rejectRead = reject; });
    const reported: unknown[] = [];
    const db = { rpc: () => pending };
    m = mount(h(GrantsPreparation, props(db, { onNextTask: (t: unknown) => reported.push(t) }) as never));
    await flush();
    expect(reported).not.toContain(null);
    await act(async () => { rejectRead(new Error("offline")); });
    await flush();
    expect(reported).not.toContain(null);
  });

  it("reports the missing grant register after a pending context resolves", async () => {
    let resolveRead!: (v: unknown) => void;
    const pending = new Promise(resolve => { resolveRead = resolve; });
    const reported: unknown[] = [];
    m = mount(h(GrantsPreparation, props({ rpc: () => pending }, { onNextTask: (t: unknown) => reported.push(t) }) as never));
    await flush();
    await act(async () => { resolveRead({ data: ctxOf("ipsas47"), error: null }); });
    await flush();
    expect(reported.at(-1)).toMatchObject({ id: "grants:none", title: "Record the grants" });
  });

  it("a saved register without a current assessment is unknown rather than no open matters", async () => {
    const reported: unknown[] = [];
    const { db } = fakeDb({ context: ctxOf("ipsas47", { id: REV, payload: { grants: [], tbSelection: {} } }, { assessment: null }) });
    m = mount(h(GrantsPreparation, props(db, { onNextTask: (t: unknown) => reported.push(t) }) as never));
    await flush();
    expect(reported).not.toContain(null);
  });
  it("offers only the classification vocabulary of the SERVER-derived period, and says the period is read, not typed", async () => {
    for (const [model, expected, absent] of [["ipsas47", "binding-arrangement", "restriction-only"], ["ipsas23", "restriction-only", "binding-arrangement"]] as const) {
      const { db } = fakeDb({ context: ctxOf(model) });
      m = mount(h(GrantsPreparation, props(db) as never)); await flush();
      act(() => click(button("Add a grant")));
      expect(options("gr0-class")).toContain(expected);
      expect(options("gr0-class")).not.toContain(absent);
      expect(m.container.textContent).toContain("read from the certified trial balance, not typed");
      m.unmount(); m = null;
    }
  });
  it("offers the period's vocabulary from the server-supplied period even before any grant has been saved (found by the browser journey)", async () => {
    const { db } = fakeDb({ context: { outcome: "available", register: null, confirmations: [], live: live("ipsas47") } });
    m = mount(h(GrantsPreparation, props(db) as never)); await flush();
    act(() => click(button("Add a grant")));
    expect(options("gr0-class")).toContain("binding-arrangement");
    expect(m.container.querySelector("#ga-transition_47")).not.toBeNull();
  });
  it("offers no classification until the trial balance is certified (no period, no vocabulary)", async () => {
    const { db } = fakeDb({ context: ctxOf(null) });
    m = mount(h(GrantsPreparation, props(db) as never)); await flush();
    act(() => click(button("Add a grant")));
    expect(options("gr0-class")).toEqual([]);
    expect(m.container.textContent).toContain("Upload and certify the trial balance first");
  });
  it("states that cash and spending never decide revenue", async () => {
    const { db } = fakeDb({});
    m = mount(h(GrantsPreparation, props(db) as never)); await flush();
    expect(m.container.textContent ?? "").toContain("Cash received and money spent never decide it");
    act(() => click(button("Add a grant")));
    expect(m.container.textContent).toContain("Cash received (does not decide revenue)");
  });
  it("a lost response is UNKNOWN, keeps the edits, and the retry reuses the ORIGINAL request identity", async () => {
    const { db, calls } = fakeDb({ save: (n) => (n === 1 ? { data: null, error: { message: "network" } } : { data: { outcome: "recorded", revisionId: REV, live: live("ipsas47") }, error: null }) });
    m = mount(h(GrantsPreparation, props(db) as never)); await flush();
    act(() => click(button("Add a grant")));
    act(() => typeInto(m!.container.querySelector("#gr0-ref") as HTMLInputElement, "DONOR-X-HEALTH"));
    await act(async () => { click(button("Save grants")); }); await flush();
    expect(m.container.textContent).toContain("We could not confirm whether this was saved");
    expect((m.container.querySelector("#gr0-ref") as HTMLInputElement).value).toBe("DONOR-X-HEALTH");
    await act(async () => { click(button("Send the same request again")); }); await flush();
    const saves = calls.filter((c) => c.name === "ipsas_save_grants");
    expect(saves.length).toBe(2);
    expect(saves[1].args.p_request_id).toBe(saves[0].args.p_request_id);
    expect(m.container.textContent).toContain("This is the server's recorded version");
  });
  it("a stale refusal is a refusal, not a save, and the edits are kept", async () => {
    const { db } = fakeDb({ save: () => ({ data: { outcome: "stale", currentId: REV }, error: null }) });
    m = mount(h(GrantsPreparation, props(db) as never)); await flush();
    act(() => click(button("Add a grant")));
    act(() => typeInto(m!.container.querySelector("#gr0-ref") as HTMLInputElement, "DONOR-Y"));
    await act(async () => { click(button("Save grants")); }); await flush();
    expect(m.container.textContent).toContain("Someone saved a newer version");
    expect(m.container.textContent).not.toContain("recorded version");
    expect((m.container.querySelector("#gr0-ref") as HTMLInputElement).value).toBe("DONOR-Y");
  });
  it("without the preparation capability nothing can be added or saved", async () => {
    const { db } = fakeDb({});
    m = mount(h(GrantsPreparation, props(db, { canPrepare: false }) as never)); await flush();
    expect((button("Add a grant") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Save grants") as HTMLButtonElement).disabled).toBe(true);
  });
  it("the review reads the period and names what remains, from the saved register", async () => {
    const g = { ...grantA(), classification: "" };
    const reg = { id: REV, payload: { contract: "cfoclose-ipsas-grants/1", companyId: CO, periodYear: 2026, entityAnswers: entity47(), tbSelection: { revenueKeys: [], liabilityKeys: [], receivableKeys: [] }, grants: [g, grantB()] }, sha256: "a".repeat(64), createdAt: "2026-10-29T00:00:00Z" };
    const l = { tb: TB47, assessment: { model: "ipsas47", state: "incomplete", codes: [`GRANT_CLASSIFICATION_REQUIRED|${g.grantId}`, `GRANT_ASSESSMENT_UNCONFIRMED|${g.grantId}`, `GRANT_ASSESSMENT_UNCONFIRMED|${grantB().grantId}`, "TB_GRANT_REVENUE_DIFFERENCE|"], grants: [], totals: { periodRevenueMinor: null, liabilityMinor: null, receivableMinor: null } } };
    const { db } = fakeDb({ context: ctxOf("ipsas47", reg, l) });
    m = mount(h(GrantsPreparation, props(db, { area: "review" }) as never)); await flush();
    const t = m.container.textContent ?? "";
    expect(t).toContain("Reporting period read from the certified trial balance");
    expect(t).toContain("What remains for grants");
    expect(t).toContain("Grant classification required");
  });
  it("has no accessibility violations on the editor", async () => {
    const { db } = fakeDb({});
    m = mount(h(GrantsPreparation, props(db) as never)); await flush();
    act(() => click(button("Add a grant")));
    act(() => click(button("Add an obligation")));
    expect(await axeViolations(m.container)).toEqual([]);
  });
});
