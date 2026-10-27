// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  mount,
  click,
  typeInto,
  type Mounted,
} from "@/lib/workbench/testkit/dom";
import { EquipmentServerBridge } from "./EquipmentServerBridge";
const id = "11111111-1111-4111-8111-111111111111",
  old = "22222222-2222-4222-8222-222222222222",
  newer = "33333333-3333-4333-8333-333333333333";
let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});
const flush = async () => {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
};
const button = (label: string) =>
  [...m!.container.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  )!;
const text = () => m!.container.textContent ?? "";
function world() {
  let currentId = old;
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => ({
    data:
      name === "fs_equipment_context"
        ? {
            outcome: "available",
            workpaper: null,
            policy: {
              id: currentId,
              body: "Inventory policy remains here.",
              sourceRef: "Approved inventory workpaper",
            },
          }
        : name === "fs_save_equipment_workpaper"
          ? { outcome: "recorded", workpaperId: id, sourceRetained: false }
          : {
              outcome: "recorded",
              workpaperId: id,
              note: { outcome: "recorded", textId: newer },
              schedule: { outcome: "recorded", submissionId: id },
            },
    error: null,
  }));
  const payload = {
    contract: "cfoclose-equipment-workpaper/1",
    companyId: "company",
    periodYear: 2025,
  };
  const props = {
    db: { rpc, select: vi.fn() },
    companyId: "company",
    periodYear: 2025,
    payload,
    canCommit: true,
    policy: "Equipment policy from confirmed answers.",
    equipmentNote: "Equipment gross and net balances.",
    sourceDocumentId: null,
    onRestore: vi.fn(),
    refresh: vi.fn(async () => {}),
  };
  return {
    rpc,
    props,
    advance: () => {
      currentId = newer;
    },
  };
}
async function saved(w: ReturnType<typeof world>) {
  m = mount(h(EquipmentServerBridge, w.props));
  click(button("Read saved preparation and current policy"));
  await flush();
  click(button("Save workpaper to CFOClose"));
  await flush();
}
it("never treats an unavailable candidate backend as a save", async () => {
  const w = world();
  w.rpc.mockRejectedValue(new Error("not installed"));
  m = mount(h(EquipmentServerBridge, w.props));
  click(button("Read saved preparation and current policy"));
  await flush();
  expect(text()).toContain("could not be read");
  expect(button("Save workpaper to CFOClose")).toBeUndefined();
});
it("saves a workpaper without claiming its missing PDF was retained", async () => {
  const w = world();
  await saved(w);
  expect(text()).toContain("original PDF is NOT retained");
  expect(text()).toContain("matches the saved workpaper");
});
it("keeps request identity after an unknown workpaper write", async () => {
  const w = world();
  m = mount(h(EquipmentServerBridge, w.props));
  click(button("Read saved preparation and current policy"));
  await flush();
  w.rpc.mockRejectedValueOnce(new Error("lost"));
  click(button("Save workpaper to CFOClose"));
  await flush();
  expect(text()).toContain("Could not confirm the workpaper save");
  click(button("Save workpaper to CFOClose"));
  await flush();
  const calls = w.rpc.mock.calls.filter(
    (c) => c[0] === "fs_save_equipment_workpaper",
  );
  expect(calls[0][1].p_request_id).toBe(calls[1][1].p_request_id);
});
it("preserves the current note in an explicit whole-note review proposal", async () => {
  const w = world();
  await saved(w);
  click(button("Prepare note insertion for review"));
  const body = m!.container.querySelector("textarea")!;
  expect(body.value).toContain("Inventory policy remains here.");
  expect(body.value).toContain("Equipment policy from confirmed answers.");
  expect(
    button("Save workpaper, schedule and reviewed note together").disabled,
  ).toBe(true);
  click(m!.container.querySelector("input[type=checkbox]")!);
  click(button("Save workpaper, schedule and reviewed note together"));
  await flush();
  expect(w.rpc).toHaveBeenLastCalledWith(
    "fs_commit_equipment_preparation",
    expect.objectContaining({
      p_expected_note_id: old,
      p_requirement_id: "smes.note.policies",
    }),
  );
});
it("does not silently adopt a newer policy revision while keeping an old edited proposal", async () => {
  const w = world();
  await saved(w);
  click(button("Prepare note insertion for review"));
  typeInto(
    m!.container.querySelector("textarea")!,
    "My carefully edited whole note.",
  );
  w.advance();
  click(button("Read saved preparation and current policy"));
  await flush();
  expect(m!.container.querySelectorAll("textarea")[1].value).toBe(
    "My carefully edited whole note.",
  );
  expect(
    button("Save workpaper, schedule and reviewed note together").disabled,
  ).toBe(true);
  expect(text()).toContain("Your proposal is kept");
});
it("retries the original atomic save after an unknown outcome even if browser inputs then change", async () => {
  const w = world();
  await saved(w);
  click(button("Prepare note insertion for review"));
  click(m!.container.querySelector("input[type=checkbox]")!);
  w.rpc.mockRejectedValueOnce(new Error("answer lost"));
  click(button("Save workpaper, schedule and reviewed note together"));
  await flush();
  expect(button("Read saved preparation and current policy").disabled).toBe(
    true,
  );
  m!.rerender(
    h(EquipmentServerBridge, {
      ...w.props,
      payload: { ...w.props.payload, newUnsavedInput: "changed afterwards" },
    }),
  );
  click(button("Retry the original unconfirmed save"));
  await flush();
  const calls = w.rpc.mock.calls.filter(
    (c) => c[0] === "fs_commit_equipment_preparation",
  );
  expect(calls).toHaveLength(2);
  expect(calls[0][1]).toEqual(calls[1][1]);
});
it("recognizes a saved JSONB workpaper when the server returns object keys in a different order", async () => {
  const w = world();
  w.rpc.mockResolvedValueOnce({
    data: {
      outcome: "available",
      workpaper: {
        id,
        payload: {
          periodYear: 2025,
          companyId: "company",
          contract: "cfoclose-equipment-workpaper/1",
        },
        sourceDocumentId: null,
        createdAt: "2026-10-27T00:00:00Z",
      },
      policy: { id: old, body: "Existing policy", sourceRef: "Source" },
    },
    error: null,
  } as never);
  m = mount(h(EquipmentServerBridge, w.props));
  click(button("Read saved preparation and current policy"));
  await flush();
  expect(text()).toContain("matches the saved workpaper");
});
