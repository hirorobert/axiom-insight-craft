// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { EquipmentServerBridge } from "./EquipmentServerBridge";
const wp = "11111111-1111-4111-8111-111111111111", sched = "22222222-2222-4222-8222-222222222222", old = "33333333-3333-4333-8333-333333333333", newer = "44444444-4444-4444-8444-444444444444";
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; });
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const button = (label: string) => [...m!.container.querySelectorAll("button")].find((b) => b.textContent === label)!;
const text = () => m!.container.textContent ?? "";
function world() {
  let policyId = old;
  const rpc = vi.fn(async (name: string) => ({
    data: name === "fs_equipment_context_v2"
      ? { outcome: "available", contract: "fs-equipment-context/2", workpaper: null, schedule: { id: sched, sourceRef: "Register", createdAt: "2027-01-01T00:00:00Z", contentSha256: "a".repeat(64), rows: [{ classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [] }] },
          notes: { "smes.note.policies": { id: policyId, body: "Inventory policy remains here.", sourceRef: "Approved inventory workpaper" }, "smes.note.subclassifications": null, "smes.note.estimates": null }, answers: [], priorAnswers: [] }
      : { outcome: "recorded", workpaperId: wp, schedule: { outcome: "recorded", submissionId: sched }, notes: [{ outcome: "recorded", textId: newer, requirementId: "smes.note.policies" }, { outcome: "recorded", textId: newer, requirementId: "smes.note.estimates" }], answersRecorded: 9, replay: false },
    error: null,
  }));
  const props = {
    db: { rpc, select: vi.fn() }, companyId: "company", periodYear: 2026, payload: { contract: "cfoclose-equipment-workpaper/2", companyId: "company", periodYear: 2026 }, canCommit: true, canCommitNotes: true,
    proposals: { "smes.note.policies": "Equipment policy from confirmed answers.", "smes.note.estimates": "Useful lives are estimates.", "smes.note.subclassifications": null },
    sourceDocumentId: null, onContext: vi.fn(), onRestore: vi.fn(), onLoadClasses: vi.fn(), refresh: vi.fn(async () => {}),
  };
  return { rpc, props, advance: () => { policyId = newer; } };
}
async function prepared(w: ReturnType<typeof world>) {
  m = mount(h(EquipmentServerBridge, w.props));
  click(button("Read the recorded preparation")); await flush();
  click(button("Prepare the three note proposals for review")); await flush();
}
it("prepares whole-note proposals that keep the existing wording, and records them with the revisions they were prepared from", async () => {
  const w = world();
  await prepared(w);
  expect(w.props.onContext).toHaveBeenCalled();
  const policy = m!.container.querySelector('[aria-label="Proposed Accounting policies (equipment section)"]') as HTMLTextAreaElement;
  expect(policy.value).toBe("Inventory policy remains here.\n\nEquipment — reviewed section\n\nEquipment policy from confirmed answers.");
  typeInto(policy, policy.value + " Reviewed by the preparer.");
  click(m!.container.querySelector("[data-testid=notes-reviewed]")!);
  click(m!.container.querySelector("[data-testid=commit-all]")!); await flush();
  const call = w.rpc.mock.calls.find(([n]) => n === "fs_commit_equipment_preparation_v2")!;
  expect(call[1]).toMatchObject({ p_expected_schedule_id: sched, p_expected_workpaper_id: null });
  const notes = (call[1] as { p_notes: { requirementId: string; expectedTextId: string | null; body: string }[] }).p_notes;
  expect(notes).toHaveLength(2);
  expect(notes[0]).toMatchObject({ requirementId: "smes.note.policies", expectedTextId: old });
  expect(notes[0].body).toContain("Reviewed by the preparer.");
  expect(text()).toContain("2 reviewed notes in one transaction");
});
it("a proposal prepared from an older note revision is not recorded against the newer one; the wording is kept", async () => {
  const w = world();
  await prepared(w);
  w.advance();
  click(button("Read the recorded preparation")); await flush();
  expect(text()).toContain("a recorded note changed since these proposals were prepared");
  expect((m!.container.querySelector("[data-testid=notes-reviewed]") as HTMLInputElement).disabled).toBe(true);
  expect((m!.container.querySelector("[data-testid=commit-all]") as HTMLButtonElement).disabled).toBe(true);
  expect((m!.container.querySelector('[aria-label="Proposed Accounting policies (equipment section)"]') as HTMLTextAreaElement).value).toContain("Equipment policy from confirmed answers.");
  expect(w.rpc.mock.calls.some(([n]) => n === "fs_commit_equipment_preparation_v2")).toBe(false);
});
it("a lost response is retried with the unchanged request and preconditions, and a refusal keeps the proposal", async () => {
  const w = world();
  w.rpc.mockImplementationOnce(async () => ({ data: { outcome: "available", contract: "fs-equipment-context/2", workpaper: null, schedule: null, notes: { "smes.note.policies": { id: old, body: "Inventory policy remains here.", sourceRef: null }, "smes.note.subclassifications": null, "smes.note.estimates": null }, answers: [], priorAnswers: [] }, error: null }));
  await prepared(w);
  click(m!.container.querySelector("[data-testid=notes-reviewed]")!);
  w.rpc.mockImplementationOnce(async () => { throw new Error("lost"); });
  click(m!.container.querySelector("[data-testid=commit-all]")!); await flush();
  expect(text()).toContain("Could not confirm the save");
  w.rpc.mockImplementationOnce(async () => ({ data: { outcome: "stale_note", requirementId: "smes.note.policies", currentId: newer }, error: null }));
  click(button("Retry the original unconfirmed save")); await flush();
  const calls = w.rpc.mock.calls.filter(([n]) => n === "fs_commit_equipment_preparation_v2");
  expect(calls).toHaveLength(2);
  expect(calls[0][1]).toEqual(calls[1][1]);
  expect(text()).toContain("Another person changed the policies note");
  expect(text()).toContain("Your edits are kept");
});
it("a draft save is a draft: compare-and-set on the latest revision, no schedule, no answers, no notes", async () => {
  const w = world();
  w.rpc.mockImplementation(async (name: string) => ({ data: name === "fs_equipment_context_v2" ? { outcome: "available", contract: "fs-equipment-context/2", workpaper: { id: wp, payload: {}, sourceDocumentId: null, createdAt: "", contract: "cfoclose-equipment-workpaper/2" }, schedule: null, notes: { "smes.note.policies": null, "smes.note.subclassifications": null, "smes.note.estimates": null }, answers: [], priorAnswers: [] } : { outcome: "recorded", workpaperId: newer, sourceRetained: false }, error: null }));
  m = mount(h(EquipmentServerBridge, w.props));
  click(button("Read the recorded preparation")); await flush();
  click(button("Save a draft")); await flush();
  expect(w.rpc).toHaveBeenLastCalledWith("fs_save_equipment_workpaper_v2", expect.objectContaining({ p_expected_id: wp }));
  expect(text()).toContain("A draft records no schedule, answer or note.");
  click(button("Restore the saved preparation"));
  expect(w.props.onRestore).toHaveBeenCalledWith(w.props.payload, null);
});
