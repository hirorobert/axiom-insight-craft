import { expect, it, vi } from "vitest";
import { commitProblemWords, noteProposal, workpaperClient } from "./workpaperClient";
const id = "11111111-1111-4111-8111-111111111111";
it("keeps the whole existing note in a proposal and appends the equipment section once", () => {
  expect(noteProposal("Existing inventory and revenue policies.", "Equipment — reviewed section", "Equipment uses straight-line depreciation.")).toBe("Existing inventory and revenue policies.\n\nEquipment — reviewed section\n\nEquipment uses straight-line depreciation.");
  expect(noteProposal("Already includes the equipment wording.", "H", "equipment wording.")).toBe("Already includes the equipment wording.");
  expect(() => noteProposal("Existing", "H", "")).toThrow();
});
it("sends every expected revision, the notes and the request identity to the commit; validates the context shape", async () => {
  const rpc = vi.fn(async (name: string) => ({ data: name === "fs_commit_equipment_preparation_v2" ? { outcome: "recorded", workpaperId: id, schedule: { outcome: "recorded", submissionId: id }, notes: [{ outcome: "recorded", textId: id, requirementId: "smes.note.policies" }], answersRecorded: 3, replay: false } : { outcome: "recorded", workpaperId: id }, error: null }));
  const c = workpaperClient({ rpc });
  const r = await c.commit("company", 2026, { contract: "cfoclose-equipment-workpaper/2" }, null, null, id, [{ requirementId: "smes.note.policies", expectedTextId: null, body: "Whole note" }], id);
  expect(r.outcome).toBe("recorded");
  expect(rpc).toHaveBeenCalledWith("fs_commit_equipment_preparation_v2", expect.objectContaining({ p_expected_workpaper_id: null, p_expected_schedule_id: id, p_request_id: id, p_notes: [{ requirementId: "smes.note.policies", expectedTextId: null, body: "Whole note" }] }));
  await c.saveDraft("company", 2026, { contract: "cfoclose-equipment-workpaper/2" }, id, null, id);
  expect(rpc).toHaveBeenLastCalledWith("fs_save_equipment_workpaper_v2", expect.objectContaining({ p_expected_id: id, p_request_id: id }));
  await expect(workpaperClient({ rpc: async () => ({ data: { outcome: "available", contract: "fs-equipment-context/2", workpaper: { id: "bad" } }, error: null }) }).context("company", 2026)).rejects.toThrow();
  await expect(workpaperClient({ rpc: async () => ({ data: null, error: { message: "transport lost" } }) }).commit("c", 2026, {}, null, null, null, [], id)).rejects.toThrow("could not confirm");
});
it("names every refusal in plain words with the server's detail, and never calls a refusal a save", () => {
  expect(commitProblemWords({ outcome: "invalid_preparation", problems: [{ code: "CLASS_DROPPED", class: "Equipment" }, { code: "ROLLFORWARD_GROSS", class: "Motor vehicles", differenceMinor: "100000" }] })).toBe("The preparation is not complete or does not reconcile; nothing was saved. CLASS_DROPPED class Equipment ROLLFORWARD_GROSS class Motor vehicles difference 100000 (minor units)");
  expect(commitProblemWords({ outcome: "stale_note", requirementId: "smes.note.estimates" })).toContain("changed the estimates note");
  expect(commitProblemWords({ outcome: "something_new" })).toBe("The server answered: something_new.");
  for (const o of ["stale", "stale_schedule", "stale_inputs", "request_reused", "forbidden", "invalid_schedule"]) expect(commitProblemWords({ outcome: o })).toMatch(/kept|nothing was saved|refused/);
});
