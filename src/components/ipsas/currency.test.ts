// @vitest-environment jsdom
// Independent review of #229, finding 4: the pages read and write every amount in the denomination the SERVER confirmed from the certified period.
// They used to assume TZS with two decimals, so a JPY balance of 14,000 was shown as 140.00 and a typed 14,000 was stored as 1,400,000 minor units.
import { createElement as h, act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { IpsasPreparation } from "./IpsasPreparation";
import { GrantsPreparation } from "./GrantsPreparation";
import { entity47, grantA } from "@/lib/ipsasAccrual/grants.fixture";

const CO = "99999999-9999-4999-8999-999999999999", REV = "88888888-8888-4888-8888-888888888888", CERT = "77777777-7777-4777-8777-777777777777";
const known = (currency: string, exponent: number) => ({ state: "known", currency, exponent });
type Call = { name: string; args: Record<string, unknown> };
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const tab = (name: string) => [...m!.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name)!;
const button = (text: string) => [...m!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;
const text = () => m!.container.textContent ?? "";

const assessmentOf = (presentation: unknown, tb: Record<string, string | null> = {}) => ({
  tb: { certificationId: CERT, isBlocking: false, requiresReview: false, ppeCarryingClosingMinor: null, ppeCarryingOpeningMinor: null, depreciationExpenseMinor: null, ...tb },
  confirmedClasses: {}, priorConfirmed: false, ppe: null, bridge: null, workpaperId: null, priorFiguresId: null, ...(presentation === undefined ? {} : { presentation }),
});
function prepDb(a: unknown, workpaper: unknown = null, priorFigures: unknown = null) {
  const calls: Call[] = [];
  return { calls, db: { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "ipsas_prep_context") return { data: { outcome: "available", workpaper, priorFigures, confirmations: [], assessment: a }, error: null };
    if (name === "ipsas_grants_context") return { data: { outcome: "available", register: null, confirmations: [], live: { period: { certificationId: null, start: null, end: null }, revisionId: null, tb: null, confirmedGrants: {}, assessment: null } }, error: null };
    if (name === "ipsas_save_preparation") return { data: { outcome: "recorded", revisionId: REV, assessment: a }, error: null };
    return { data: null, error: { message: "unexpected" } };
  } } };
}
const prepProps = (db: unknown) => ({ companyId: CO, periodYear: 2026, legalName: "Mwamba Community Trust", db, canPrepare: true, canConfirm: false, prepareHref: "/p" });
const savedPayload = (calls: Call[]) => calls.find((c) => c.name === "ipsas_save_preparation")!.args.p_payload as { presentation: unknown; classes: { opening: { grossMinor: string } }[] };
const field = (id: string) => m!.container.querySelector(`#${id}`) as HTMLInputElement;

describe("PPE preparation reads and writes amounts in the server-confirmed denomination", () => {
  it("JPY (no decimals): the unit is stated, a server figure of 14,000 is shown as 14,000 (never 140.00), a typed whole amount is stored exactly and a decimal is refused", async () => {
    const { db, calls } = prepDb(assessmentOf(known("JPY", 0), { ppeCarryingClosingMinor: "14000", ppeCarryingOpeningMinor: "16000", depreciationExpenseMinor: "2000" }));
    m = mount(h(IpsasPreparation, prepProps(db) as never)); await flush();
    expect(text()).toContain("JPY (whole units, no decimals)");
    expect(text()).toContain("closing 14,000, opening 16,000");
    expect(text()).not.toContain("140.00");
    act(() => click(tab("Complete preparation"))); act(() => click(button("Add an asset class")));
    act(() => typeInto(field("c0-openingg"), "14,000.5"));
    expect(text()).toContain("whole units only, no decimals");
    act(() => typeInto(field("c0-openingg"), "14,000")); act(() => typeInto(field("c0-label"), "Vehicles"));
    await act(async () => { click(button("Save preparation")); }); await flush();
    const p = savedPayload(calls);
    expect(p.classes[0].opening.grossMinor).toBe("14000");
    expect(p.presentation).toEqual({ currency: "JPY", exponent: 0 });
  });
  it("KWD (three decimals): 12.345 is exactly 12345 minor units, a fourth decimal is refused, and 14,000,000 minor units read 14,000.000", async () => {
    const { db, calls } = prepDb(assessmentOf(known("KWD", 3), { ppeCarryingClosingMinor: "14000000", ppeCarryingOpeningMinor: "16000000", depreciationExpenseMinor: "2000000" }));
    m = mount(h(IpsasPreparation, prepProps(db) as never)); await flush();
    expect(text()).toContain("KWD (3 decimal places)");
    expect(text()).toContain("closing 14,000.000, opening 16,000.000");
    act(() => click(tab("Complete preparation"))); act(() => click(button("Add an asset class")));
    act(() => typeInto(field("c0-openingg"), "12.3456"));
    expect(text()).toContain("at most 3 decimal places");
    act(() => typeInto(field("c0-openingg"), "12.345")); act(() => typeInto(field("c0-label"), "Vessels"));
    await act(async () => { click(button("Save preparation")); }); await flush();
    expect(savedPayload(calls).classes[0].opening.grossMinor).toBe("12345");
    expect(savedPayload(calls).presentation).toEqual({ currency: "KWD", exponent: 3 });
  });
  it.each([["TZS"], ["USD"]])("%s (two decimals): 1,234.50 is 123450 and the denomination travels with the saved draft", async (code) => {
    const { db, calls } = prepDb(assessmentOf(known(code, 2)));
    m = mount(h(IpsasPreparation, prepProps(db) as never)); await flush();
    expect(text()).toContain(`${code} (2 decimal places)`);
    act(() => click(tab("Complete preparation"))); act(() => click(button("Add an asset class")));
    act(() => typeInto(field("c0-openingg"), "1,234.50")); act(() => typeInto(field("c0-label"), "Equipment"));
    await act(async () => { click(button("Save preparation")); }); await flush();
    expect(savedPayload(calls).classes[0].opening.grossMinor).toBe("123450");
    expect(savedPayload(calls).presentation).toEqual({ currency: code, exponent: 2 });
  });
  it.each([
    ["the server could not confirm one (unknown)", { state: "unknown" }, "not confirmed yet"],
    ["the server reports one this release does not support", { state: "unsupported", currency: "XTS", exponent: 4 }, "not supported in this release"],
    ["the server said nothing (never read as a default)", undefined, "not confirmed yet"],
  ])("no amount is shown or editable when %s", async (_why, presentation, words) => {
    const { db } = prepDb(assessmentOf(presentation, { ppeCarryingClosingMinor: "1400000" }));
    m = mount(h(IpsasPreparation, prepProps(db) as never)); await flush();
    expect(m.container.querySelector('[data-testid="denomination-blocked"]')?.textContent).toContain(words);
    expect(m.container.querySelector('[role="tablist"]')).toBeNull();
    expect(m.container.querySelectorAll("input").length).toBe(0);
    expect(text()).not.toContain("14,000.00");
  });
  it("a draft saved in another denomination is never re-read under this one: it is not displayed and cannot be saved over", async () => {
    const saved = { id: REV, payload: { contract: "cfoclose-ipsas-ppe-workpaper/1", companyId: CO, periodYear: 2026, presentation: { currency: "JPY", exponent: 0 }, period: { start: "2026-01-01", end: "2026-12-31" }, convention: "daily",
      classes: [{ classId: "33333333-3333-4333-8333-333333333333", label: "Secret yen equipment", accounts: "1500", measurementModel: "cost", opening: { grossMinor: "14000", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", carryingMinor: "14000" },
        closing: { grossMinor: "14000", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", carryingMinor: "14000" }, movements: [], disposals: [], estimate: {} }], entityAnswers: {}, depreciationDifference: null, tbSelection: { ppeAccountKeys: [], depreciationExpenseKeys: [] } },
      sha256: "a".repeat(64), createdAt: "2026-10-30T00:00:00Z" };
    const { db, calls } = prepDb(assessmentOf(known("TZS", 2)), saved);
    m = mount(h(IpsasPreparation, prepProps(db) as never)); await flush();
    expect(m.container.querySelector('[data-testid="denomination-blocked"]')?.textContent).toContain("different currency or unit");
    expect(text()).not.toContain("Secret yen equipment");
    expect(text()).not.toContain("14,000");
    expect(calls.filter((c) => c.name === "ipsas_save_preparation")).toHaveLength(0);
  });
  it("prior figures entered with another currency or scale are not displayed either", async () => {
    const prior = { id: REV, payload: { contract: "cfoclose-ipsas-prior-figures/1", companyId: CO, periodYear: 2026, currency: "TZS", scale: 0, lines: [{ lineId: "ppe", label: "Property, plant and equipment (carrying amount)", amountMinor: "1400000", locator: "p.4" }], items: [] }, sha256: "b".repeat(64), createdAt: "2026-10-30T00:00:00Z" };
    const { db } = prepDb(assessmentOf(known("TZS", 2)), null, prior);
    m = mount(h(IpsasPreparation, prepProps(db) as never)); await flush();
    expect(m.container.querySelector('[data-testid="denomination-blocked"]')).not.toBeNull();
  });
});

describe("grants preparation reads and writes amounts in the server-confirmed denomination", () => {
  const live = (presentation: unknown) => ({ period: { certificationId: CERT, start: "2026-01-01", end: "2026-12-31" }, revisionId: null, tb: null, ...(presentation === undefined ? {} : { presentation }), confirmedGrants: {}, assessment: null });
  function grantsDb(presentation: unknown, register: unknown = null) {
    const calls: Call[] = [];
    return { calls, db: { rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "ipsas_grants_context") return { data: { outcome: "available", register, confirmations: [], live: live(presentation) }, error: null };
      if (name === "ipsas_save_grants") return { data: { outcome: "recorded", revisionId: REV, live: live(presentation) }, error: null };
      return { data: null, error: { message: "unexpected" } };
    } } };
  }
  const gp = (db: unknown) => ({ companyId: CO, periodYear: 2026, legalName: "Mwamba Community Trust", db, canPrepare: true, canConfirm: false, area: "prepare" });
  it("JPY: the consideration 1,000 is stored as 1000 minor units and the draft carries its denomination", async () => {
    const { db, calls } = grantsDb(known("JPY", 0));
    m = mount(h(GrantsPreparation, gp(db) as never)); await flush();
    act(() => click(button("Add a grant")));
    act(() => typeInto(field("gr0-cons"), "1,000.5"));
    expect(text()).toContain("whole units only, no decimals");
    act(() => typeInto(field("gr0-cons"), "1,000")); act(() => typeInto(field("gr0-ref"), "DONOR-X"));
    await act(async () => { click(button("Save grants")); }); await flush();
    const p = calls.find((c) => c.name === "ipsas_save_grants")!.args.p_payload as { presentation: unknown; grants: { considerationMinor: string }[] };
    expect(p.grants[0].considerationMinor).toBe("1000");
    expect(p.presentation).toEqual({ currency: "JPY", exponent: 0 });
  });
  it.each([["unknown", { state: "unknown" }, "not confirmed yet"], ["unsupported", { state: "unsupported", currency: "XTS", exponent: 4 }, "not supported in this release"], ["absent", undefined, "not confirmed yet"]])(
    "no amount is shown or editable when the denomination is %s", async (_n, presentation, words) => {
      const { db } = grantsDb(presentation);
      m = mount(h(GrantsPreparation, gp(db) as never)); await flush();
      expect(m.container.querySelector('[data-testid="denomination-blocked"]')?.textContent).toContain(words);
      expect(m.container.querySelectorAll("input").length).toBe(0);
    });
  it("a register saved in another denomination is not displayed and cannot be saved over", async () => {
    const register = { id: REV, payload: { contract: "cfoclose-ipsas-grants/1", companyId: CO, periodYear: 2026, presentation: { currency: "JPY", exponent: 0 }, entityAnswers: entity47(), tbSelection: { revenueKeys: [], liabilityKeys: [], receivableKeys: [] }, grants: [{ ...grantA(), reference: "SECRET-YEN-GRANT" }] }, sha256: "a".repeat(64), createdAt: "2026-10-30T00:00:00Z" };
    const { db, calls } = grantsDb(known("TZS", 2), register);
    m = mount(h(GrantsPreparation, gp(db) as never)); await flush();
    expect(m.container.querySelector('[data-testid="denomination-blocked"]')?.textContent).toContain("different currency or unit");
    expect(text()).not.toContain("SECRET-YEN-GRANT");
    expect(calls.filter((c) => c.name === "ipsas_save_grants")).toHaveLength(0);
  });
});
