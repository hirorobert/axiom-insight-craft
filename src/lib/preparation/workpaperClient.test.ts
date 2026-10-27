import { expect, it, vi } from "vitest";
import { workpaperClient, policyProposal } from "./workpaperClient";
const id = "11111111-1111-4111-8111-111111111111";
it("preserves the existing note in a reviewable proposal without silently replacing it", () => {
  expect(
    policyProposal(
      "Existing inventory and revenue policies.",
      "Equipment uses a supported method.",
    ),
  ).toBe(
    "Existing inventory and revenue policies.\n\nEquipment — proposed section for review\n\nEquipment uses a supported method.",
  );
  expect(
    policyProposal(
      "Already includes the equipment wording.",
      "equipment wording.",
    ),
  ).toBe("Already includes the equipment wording.");
  expect(() => policyProposal("Existing", "")).toThrow();
});
it("sends version preconditions and the original request identity to the server", async () => {
  const rpc = vi.fn(async () => ({
    data: { outcome: "recorded", workpaperId: id },
    error: null,
  }));
  const c = workpaperClient({ rpc });
  await c.save("company", 2025, { contract: "draft" }, null, null, id);
  expect(rpc).toHaveBeenCalledWith(
    "fs_save_equipment_workpaper",
    expect.objectContaining({
      p_expected_id: null,
      p_request_id: id,
      p_source_document_id: null,
    }),
  );
  rpc.mockResolvedValueOnce({
    data: { outcome: "recorded", textId: id },
    error: null,
  } as never);
  await c.recordPolicy(
    "company",
    2025,
    id,
    null,
    "Reviewed entire policy note",
    id,
  );
  expect(rpc).toHaveBeenLastCalledWith(
    "fs_record_reviewed_equipment_note",
    expect.objectContaining({
      p_workpaper_id: id,
      p_expected_policy_id: null,
      p_request_id: id,
    }),
  );
});
it("does not fabricate availability or a receipt after a malformed/error response", async () => {
  const c = workpaperClient({
    rpc: async () => ({
      data: { outcome: "available", workpaper: { id: "bad" } },
      error: null,
    }),
  });
  await expect(c.context("company", 2025)).rejects.toThrow();
  await expect(
    workpaperClient({
      rpc: async () => ({ data: null, error: { message: "transport lost" } }),
    }).save("c", 2025, {}, null, null, id),
  ).rejects.toThrow("could not confirm");
});
