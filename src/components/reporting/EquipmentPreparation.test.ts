// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { EquipmentPreparation } from "./EquipmentPreparation";
import type { PageProps } from "./shared";
vi.mock("@/lib/preparation/priorReport", () => ({ readPriorPage: vi.fn() }));

// Synthetic figures (TZS, exponent 2), calculated by hand. The composed PPE line is 14,000.00 (prior 16,000.00); the
// expense line the depreciation is presented in is 9,900.00. Two classes that together reconcile:
//   Equipment       10,000 → 8,750 (gross 12,500; acc dep 2,500 → 3,750; depreciation 1,250)
//   Motor vehicles   6,000 → 5,250 (gross  7,500; acc dep 1,500 → 2,250; depreciation   750)
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
let m: Mounted | null = null;
let rpc: ReturnType<typeof vi.fn>;
const text = () => m!.container.textContent ?? "";
const button = (name: string) => [...m!.container.querySelectorAll("button")].find((b) => b.textContent === name)!;
const el = (ariaLabel: string) => m!.container.querySelector(`[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
const labelled = (startsWith: string) => [...m!.container.querySelectorAll("label")].find((l) => l.textContent?.startsWith(startsWith))!.querySelector("input,select,textarea") as HTMLInputElement;
function set(target: Element | null, value: string | boolean) {
  if (!target) throw new Error("missing field");
  const e = target as HTMLInputElement;
  if (e.tagName === "SELECT") act(() => { e.value = String(value); e.dispatchEvent(new Event("change", { bubbles: true })); });
  else if (e.type === "checkbox") { if (e.checked !== !!value) click(e); }
  else typeInto(e as HTMLInputElement, String(value));
}
const RECORDED = { classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] };
const WP = "11111111-1111-4111-8111-111111111111", SCHED = "22222222-2222-4222-8222-222222222222", POL = "33333333-3333-4333-8333-333333333333", EST = "44444444-4444-4444-8444-444444444444", SUB = "55555555-5555-4555-8555-555555555555";
function context(over: Record<string, unknown> = {}) {
  return {
    outcome: "available", contract: "fs-equipment-context/2", workpaper: null,
    notes: { "smes.note.policies": { id: POL, body: "Historical cost.", sourceRef: "Notes v1" }, "smes.note.subclassifications": { id: SUB, body: "All receivables from third parties.", sourceRef: "Notes v1" }, "smes.note.estimates": { id: EST, body: "Useful lives.", sourceRef: "Notes v1" } },
    schedule: { id: SCHED, sourceRef: "Fixed asset register 2026", createdAt: "2027-01-01T00:00:00Z", contentSha256: "a".repeat(64), rows: [RECORDED] },
    answers: [], priorAnswers: [], ...over,
  };
}
function props(over: Partial<PageProps> = {}): PageProps {
  return {
    companyId: "company-a", periodYear: 2026, legalName: "Synthetic SME", allowed: ["prepare_close"], reportVersion: 2, hrefFor: (page) => `/reports/${page}`,
    newRequestId: () => "request-one", refresh: vi.fn(async () => {}),
    state: {
      notes: { state: "evaluated", requirements: [] },
      composition: {
        state: "composed", pack: { packId: "ifrs-for-smes/2015" }, compositionSha256: "a".repeat(64), blockers: [], accountsNotPresented: [], totals: { current: { state: "complete" } }, comparative: { state: "unavailable" },
        current: { currency: "TZS", exponent: 2 },
        lines: [{ lineId: "sfp.property_plant_and_equipment", current: { amountMinor: "1400000" } }, { lineId: "sci.operating_expenses_by_function", current: { amountMinor: "990000" } }],
      },
    },
    db: { rpc: (name: string, args: Record<string, unknown>) => rpc(name, args) },
    clients: { signoff: { input: async () => ({ comparative: { reportingEnd: "2025-12-31" }, current: { reportingStart: "2026-01-01", reportingEnd: "2026-12-31" } }) } },
    ...over,
  } as unknown as PageProps;
}
async function start(p = props()) { m = mount(h(MemoryRouter, null, h(EquipmentPreparation, p))); await flush(); click(button("Start guided equipment preparation")); await flush(); }
async function priorFigure() {
  set(labelled("Available prior-year source"), "reference");
  set(labelled("Prior figure source reference"), "Reviewed opening register page A1");
  set(labelled("Prior reporting date"), "2025-12-31");
  set(labelled("Equipment net amount as printed"), "16,000.00");
  set(labelled("Currency printed"), "TZS");
  set(labelled("Units printed"), "0");
  click(m!.container.querySelector("[data-testid=confirm-prior-figure]")!);
}
function fillClass(L: string, opening: [string, string, string], closing: [string, string, string], depreciation: string) {
  set(el(`${L}: accounts`), "1500, 1510");
  set(el(`${L}: opening total cost before depreciation (gross carrying amount)`), opening[0]);
  set(el(`${L}: opening depreciation charged in total (accumulated)`), opening[1]);
  set(el(`${L}: opening impairment recognised in total (accumulated)`), "0");
  set(el(`${L}: opening carrying amount (net)`), opening[2]);
  set(el(`${L}: closing total cost before depreciation (gross carrying amount)`), closing[0]);
  set(el(`${L}: closing depreciation charged in total (accumulated)`), closing[1]);
  set(el(`${L}: closing impairment recognised in total (accumulated)`), "0");
  set(el(`${L}: closing carrying amount (net)`), closing[2]);
  if (!el(`${L}: Depreciation for the year Accumulated depreciation`)) set(el(`${L}: add a change`), "depreciation");
  set(el(`${L}: Depreciation for the year Accumulated depreciation`), depreciation);
  set(el(`${L}: Depreciation for the year record type`), "register");
  set(el(`${L}: Depreciation for the year reference`), "Synthetic register depreciation report 2026");
  set(el(`${L}: measurement basis`), "cost");
  set(el(`${L}: depreciation method`), "straight-line");
  set(el(`${L}: useful life in years`), "10");
  set(el(`${L}: residual value`), "0");
  set(el(`${L}: part-year convention`), "full-period");
  set(el(`${L}: charge source`), "register");
  set(el(`${L}: register reference`), "Synthetic register depreciation report 2026");
  set(el(`${L}: register charge`), depreciation);
  set(el(`${L}: changed since prior`), "no");
  set(el(`${L}: rationale`), "Expected ten years of two-shift use");
  set(el(`${L}: estimate evidence`), "Capital budget and maintenance plan");
}
function answerWritten(prefix: string, id: string, status: "answered" | "none_with_basis", textValue = "Synthetic answer on file") {
  set(el(`${prefix}${id} status`), status);
  if (status === "answered") set(el(`${prefix}${id} answer`), textValue);
  else set(el(`${prefix}${id} checked by`), "Synthetic preparer, 2027-01-15");
  set(el(`${prefix}${id} evidence`), "Engagement file E-2026");
}
async function completePreparation() {
  await priorFigure();
  click(button("Read the recorded preparation")); await flush();
  click(button("Load the recorded classes into this preparation")); await flush();
  click(button("Add a class")); await flush();
  set([...m!.container.querySelectorAll('[aria-label="Class name"]')][1], "Motor vehicles");
  fillClass("Equipment", ["12,500.00", "2,500.00", "10,000.00"], ["12,500.00", "3,750.00", "8,750.00"], "1,250.00");
  fillClass("Motor vehicles", ["7,500.00", "1,500.00", "6,000.00"], ["7,500.00", "2,250.00", "5,250.00"], "750.00");
  click(m!.container.querySelector("[data-testid=confirm-movement-coverage]")!);
  click(button("Add a destination")); await flush();
  set(el("Destination 1 target"), "sci.operating_expenses_by_function");
  set(el("Destination 1 amount"), "2,000.00");
  set(el("Destination 1 evidence"), "Expense ledger 6200 Depreciation");
  for (const [id, status] of [["restrictions_security", "none_with_basis"], ["commitments", "none_with_basis"], ["impairment", "answered"], ["events_after", "none_with_basis"], ["framework_history", "answered"]] as const) answerWritten("", id, status);
  for (const L of ["Equipment", "Motor vehicles"]) { answerWritten(`${L}: `, "recognition", "answered", "All items owned; invoices on file"); answerWritten(`${L}: `, "components", "answered", "No major parts; uniform items"); }
  await flush();
}
const commitCalls = () => rpc.mock.calls.filter(([n]) => n === "fs_commit_equipment_preparation_v2");
beforeEach(() => {
  rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "fs_equipment_context_v2") return { data: context(), error: null };
    if (name === "fs_commit_equipment_preparation_v2") {
      const notes = (args.p_notes as { requirementId: string }[]).map((n) => ({ requirementId: n.requirementId, outcome: "recorded", textId: POL }));
      return { data: { outcome: "recorded", workpaperId: WP, createdAt: "2027-01-02T00:00:00Z", sourceRetained: false, schedule: { outcome: "recorded", submissionId: SCHED }, notes, answersRecorded: 9, replay: false }, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
});
afterEach(() => { m?.unmount(); m = null; vi.clearAllMocks(); });

it("loads the recorded class with its carrying amounts and recorded depreciation, assumes nothing else, and asks only the applicable questions", async () => {
  await start();
  click(button("Read the recorded preparation")); await flush();
  expect(text()).toContain("The recorded schedule has 1 class: Equipment.");
  click(button("Load the recorded classes into this preparation")); await flush();
  expect((el("Equipment: opening carrying amount (net)") as HTMLInputElement).value).toBe("16000.00");
  expect((el("Equipment: Depreciation for the year Accumulated depreciation") as HTMLInputElement).value).toBe("2000.00");
  expect((el("Equipment: opening total cost before depreciation (gross carrying amount)") as HTMLInputElement).value).toBe("");
  expect((el("Equipment: useful life in years"))).toBeNull();
  expect(text()).toContain("Roll-forward of Equipment: more information needed");
  const asked = [...m!.container.querySelectorAll("[data-question]")].map((q) => q.getAttribute("data-question"));
  expect(asked).toEqual(expect.arrayContaining(["impairment", "events_after", "restrictions_security", "commitments", "recognition", "components", "gross", "movements"]));
  expect(asked).not.toContain("addition_cost");
  expect(asked).not.toContain("lease");
  expect(commitCalls()).toHaveLength(0);
});

it("records two reconciled classes, nine answers and three reviewed notes through one server call with the expected revisions", async () => {
  await start();
  await completePreparation();
  expect(text()).toContain("Roll-forward of Equipment: cost, accumulated depreciation, impairment and carrying amount all agree");
  expect(text()).toContain("Roll-forward of Motor vehicles: cost, accumulated depreciation");
  expect(m!.container.querySelector("[data-testid=statement-status]")!.textContent).toContain("agree to the server statement line");
  expect(m!.container.querySelector("[data-testid=tieout-status]")!.textContent).toContain("account for the whole charge");
  expect(m!.container.querySelector("[data-testid=bridge-status]")!.textContent).toContain("arithmetic agrees");
  expect(m!.container.querySelector("[data-testid=questions-summary]")!.textContent).toContain("Every applicable question is answered");
  expect((m!.container.querySelector("[data-testid=proposal-smes\\.note\\.policies]") as HTMLTextAreaElement).value).toContain("Motor vehicles is measured at cost");
  click(button("Prepare the three note proposals for review")); await flush();
  const policy = m!.container.querySelector('[aria-label="Proposed Accounting policies (equipment section)"]') as HTMLTextAreaElement;
  expect(policy.value.startsWith("Historical cost.")).toBe(true);
  click(m!.container.querySelector("[data-testid=notes-reviewed]")!);
  click(m!.container.querySelector("[data-testid=commit-all]")!); await flush();
  expect(commitCalls()).toHaveLength(1);
  const args = commitCalls()[0][1] as Record<string, unknown>;
  const payload = args.p_payload as { classes: { label: string; movements: { accumulatedDepreciationMinor: string }[] }[]; schedule: { rows: { classLabel: string; openingMinor: string; closingMinor: string }[] }; questions: { unresolved: unknown[] } };
  expect(args.p_expected_schedule_id).toBe(SCHED);
  expect(args.p_expected_workpaper_id).toBeNull();
  expect(args.p_request_id).toBe("request-one");
  expect(payload.classes.map((c) => c.label)).toEqual(["Equipment", "Motor vehicles"]);
  expect(payload.schedule.rows).toEqual([
    expect.objectContaining({ classLabel: "Equipment", openingMinor: "1000000", closingMinor: "875000", movements: [{ kind: "depreciation", amountMinor: "-125000" }] }),
    expect.objectContaining({ classLabel: "Motor vehicles", openingMinor: "600000", closingMinor: "525000", movements: [{ kind: "depreciation", amountMinor: "-75000" }] }),
  ]);
  expect(payload.questions.unresolved).toEqual([]);
  const notes = args.p_notes as { requirementId: string; expectedTextId: string; body: string }[];
  expect(notes.map((n) => n.requirementId).sort()).toEqual(["smes.note.estimates", "smes.note.policies", "smes.note.subclassifications"]);
  expect(notes.find((n) => n.requirementId === "smes.note.policies")).toMatchObject({ expectedTextId: POL });
  expect(notes.find((n) => n.requirementId === "smes.note.policies")!.body.startsWith("Historical cost.")).toBe(true);
  expect(text()).toContain("Recorded: workpaper");
});

it("never collapses the recorded class: removing it is refused until it is retired with a reason, and nothing is sent", async () => {
  await start();
  await completePreparation();
  click(button("Remove Equipment")); await flush();
  expect(m!.container.querySelector("[data-testid=preservation]")!.textContent).toContain('has a class "Equipment" that this preparation does not include');
  expect((m!.container.querySelector("[data-testid=commit-classes]") as HTMLButtonElement).disabled).toBe(true);
  click(button("Retire a recorded class with a reason")); await flush();
  expect(m!.container.querySelector("[data-testid=preservation]")!.textContent).toContain('Retiring class "Equipment" needs a reason');
  expect(commitCalls()).toHaveLength(0);
});

it("a difference is shown exactly and never balanced; the record button stays disabled", async () => {
  await start();
  await completePreparation();
  set(el("Equipment: Depreciation for the year Accumulated depreciation"), "1,000.00");
  await flush();
  expect(text()).toContain("Accumulated depreciation: opening plus movements does not equal closing (difference 25000)");
  expect((m!.container.querySelector("[data-testid=commit-classes]") as HTMLButtonElement).disabled).toBe(true);
  expect(m!.container.querySelector("[data-testid=tieout-status]")!.textContent).toContain("differ by -25000");
});

it("conditional questions follow the facts: additions open the cost question, its flags open follow-ups, and expensed items block it", async () => {
  await start();
  await completePreparation();
  set(el("Equipment: add a change"), "additions"); await flush();
  expect([...m!.container.querySelectorAll("[data-question=addition_cost]")]).toHaveLength(0); // amount not yet entered
  set(el("Equipment: Additions (purchases) Cost"), "500.00");
  set(el("Equipment: Additions (purchases) record type"), "journal");
  set(el("Equipment: Additions (purchases) reference"), "Invoice J-7"); await flush();
  expect(m!.container.querySelector("[data-question=addition_cost]")).not.toBeNull();
  expect(m!.container.querySelector("[data-question=replacement]")).toBeNull();
  set(el("Equipment: addition_cost status"), "answered");
  set(el("Equipment: addition_cost replacement_or_inspection"), true);
  set(el("Equipment: addition_cost expensed_items_included"), true); await flush();
  expect(m!.container.querySelector("[data-question=replacement]")).not.toBeNull();
  expect(text()).toContain("expensed under the 2015 edition (17.11, 25.2)");
  expect(m!.container.querySelector("[data-testid=questions-summary]")!.textContent).toMatch(/still need/);
});

it("refuses a useful-life rationale that cites a tax class as an entity estimate", async () => {
  await start();
  await completePreparation();
  set(el("Motor vehicles: rationale"), "As per TRA class 2 (25%)"); await flush();
  expect(text()).toContain("must be the entity's own estimate of expected use");
  expect((m!.container.querySelector("[data-testid=commit-classes]") as HTMLButtonElement).disabled).toBe(true);
});

it("keeps every edit after a server refusal (class dropped, stale schedule) and says nothing was saved", async () => {
  await start();
  await completePreparation();
  rpc.mockImplementationOnce(async (name: string) => (name === "fs_commit_equipment_preparation_v2" ? { data: { outcome: "stale_schedule", currentId: SCHED }, error: null } : { data: context(), error: null }));
  click(m!.container.querySelector("[data-testid=commit-classes]")!); await flush();
  expect(text()).toContain("The equipment schedule changed while you were preparing");
  expect(text()).toContain("Your edits are kept");
  expect((el("Motor vehicles: closing carrying amount (net)") as HTMLInputElement).value).toBe("5,250.00");
  rpc.mockImplementationOnce(async () => ({ data: { outcome: "invalid_preparation", problems: [{ code: "CLASS_DROPPED", class: "Equipment" }] }, error: null }));
  click(m!.container.querySelector("[data-testid=commit-classes]")!); await flush();
  expect(text()).toContain("CLASS_DROPPED class Equipment");
  expect(commitCalls()).toHaveLength(2);
});

it("a lost response keeps the request identity: the retry sends the same request id and the page never says nothing was recorded", async () => {
  await start();
  await completePreparation();
  rpc.mockImplementationOnce(async () => { throw new Error("lost answer"); });
  click(m!.container.querySelector("[data-testid=commit-classes]")!); await flush();
  expect(text()).toContain("Could not confirm the save");
  expect(text()).not.toContain("nothing was saved");
  click(button("Retry the original unconfirmed save")); await flush();
  expect(commitCalls()).toHaveLength(2);
  expect(commitCalls()[0][1].p_request_id).toBe(commitCalls()[1][1].p_request_id);
  expect(text()).toContain("Recorded: workpaper");
});

it("a changed statement keeps the workpaper and requires renewed review before recording", async () => {
  const p = props();
  await start(p);
  await completePreparation();
  m!.rerender(h(MemoryRouter, null, h(EquipmentPreparation, { ...p, state: { ...p.state, composition: { ...p.state.composition, compositionSha256: "c".repeat(64) } } } as PageProps)));
  await flush();
  expect(text()).toContain("Your workpaper is kept");
  expect((el("Motor vehicles: closing carrying amount (net)") as HTMLInputElement).value).toBe("5,250.00");
  expect((m!.container.querySelector("[data-testid=commit-classes]") as HTMLButtonElement).disabled).toBe(true);
  click(button("Review refreshed statement figures")); await flush();
  expect((m!.container.querySelector("[data-testid=confirm-prior-figure]") as HTMLInputElement).checked).toBe(false);
});

it("offers last year's recorded answer for explicit reuse, never silently", async () => {
  rpc.mockImplementation(async (name: string) => {
    if (name === "fs_equipment_context_v2") return { data: context({ priorAnswers: [{ classKey: null, classLabel: null, questionId: "commitments", status: "none_with_basis", answer: { status: "none_with_basis", text: "", evidence: "Contracts register checked", checkedBy: "A. Preparer, 2026-01-20", flags: {} }, workpaperId: WP, createdAt: "2026-01-20T00:00:00Z" }] }), error: null };
    throw new Error("unexpected");
  });
  await start();
  click(button("Read the recorded preparation")); await flush();
  expect(text()).toContain("1 answers from the prior period can be reused after review");
  expect((el("commitments status") as HTMLSelectElement).value).toBe("unresolved");
  click(button("Reuse last year's answer, then review it")); await flush();
  expect((el("commitments status") as HTMLSelectElement).value).toBe("none_with_basis");
  expect((el("commitments checked by") as HTMLInputElement).value).toBe("A. Preparer, 2026-01-20");
});

it("does not expose the preparation to a reader", async () => {
  m = mount(h(MemoryRouter, null, h(EquipmentPreparation, props({ allowed: ["review_close"] })))); await flush();
  expect(text()).toBe("");
  expect(rpc).not.toHaveBeenCalled();
});
