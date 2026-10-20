// @vitest-environment jsdom
/**
 * The focused upload page's own parts: the entity pre-check (the engine's normalisation, parity pinned), the saved
 * uploads list with explicit removal, and the entity list read. Invented data only.
 */
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, type Mounted } from "@/lib/workbench/testkit/dom";
import { findSameEntity, normaliseEntityName } from "@/lib/workspace/entityPrecheck";
import { normaliseEntityName as engineNormalise } from "../../supabase/functions/_shared/tbIngestion";
import { listSavedDrafts, removeSavedDraft } from "@/lib/workspace/savedDrafts";
import { fetchPortfolioEntities } from "@/lib/workspace/portfolioClient";
import { SavedDrafts } from "@/components/workspace/SavedDrafts";

type Args = Record<string, unknown>;
const flush = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };

describe("entity pre-check", () => {
  it("normalises exactly as the engine compares a file's entity with the workspace", () => {
    for (const n of ["The Invented Traders Limited", "INVENTED TRADERS LTD.", "Invented & Sons Company", "  invented   corporation ", "Ünïcode Wörks Incorporated"]) {
      expect(normaliseEntityName(n)).toBe(engineNormalise(n));
    }
  });
  it("finds an existing entity written differently; never a different name; nothing for an empty name", () => {
    const entities = [{ id: "a", name: "Invented Traders Ltd" }, { id: "b", name: "Invented Holdings" }];
    expect(findSameEntity("The Invented Traders Limited", entities)?.id).toBe("a");
    expect(findSameEntity("Invented Traders East", entities)).toBeNull();
    expect(findSameEntity("   ", entities)).toBeNull();
  });
});

describe("reads", () => {
  it("the entity list is read strictly with its true total; anything else is unavailable", async () => {
    const ok = await fetchPortfolioEntities(async () => ({ data: { outcome: "ok", entities: [{ id: "a", name: "Invented A", code: null, tin: "1" }], total: 3 }, error: null }));
    expect(ok).toEqual({ kind: "ok", entities: [{ id: "a", name: "Invented A", code: null, tin: "1" }], total: 3 });
    expect(await fetchPortfolioEntities(async () => ({ data: { outcome: "unauthenticated" }, error: null }))).toEqual({ kind: "unavailable" });
  });
  it("saved drafts: rows read strictly; removal outcomes in words", async () => {
    const list = await listSavedDrafts(async () => ({ data: [{ draft_id: "d", file_name: "fy.csv", file_size: 10, state: "reserved", created_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-08T00:00:00Z", stored: true }, { bad: 1 }], error: null }));
    expect(list).toMatchObject({ kind: "ok", drafts: [{ id: "d", fileName: "fy.csv", state: "reserved", stored: true }] });
    expect(await removeSavedDraft(async () => ({ data: "not_eligible", error: null }), "d")).toEqual({ removed: false, message: "That file is being checked now, so it cannot be removed." });
    expect(await removeSavedDraft(async () => ({ data: "deleted", error: null }), "d")).toEqual({ removed: true, message: "Removed." });
  });
});

describe("SavedDrafts", () => {
  let m: Mounted | null = null;
  afterEach(() => { m?.unmount(); m = null; });
  it("lists saved files; removal needs an explicit confirmation; a file being checked cannot be removed", async () => {
    let rows = [
      { draft_id: "d1", file_name: "invented-fy2025.csv", file_size: 2048, state: "reserved", created_at: "2026-10-01T09:00:00Z", expires_at: "2026-10-08T09:00:00Z", stored: true },
      { draft_id: "d2", file_name: "invented-fy2024.xlsx", file_size: 4096, state: "committing", created_at: "2026-10-01T08:00:00Z", expires_at: "2026-10-08T08:00:00Z", stored: true },
    ];
    const rpc = vi.fn(async (fn: string, a: Args) => {
      if (fn === "list_trial_balance_drafts") return { data: rows, error: null };
      rows = rows.filter((r) => r.draft_id !== a.p_draft_id);
      return { data: "deleted", error: null };
    });
    m = mount(createElement(SavedDrafts, { rpc }));
    await flush();
    const el = m.container;
    expect(el.querySelector("[data-testid=saved-draft-d1]")?.textContent).toContain("invented-fy2025.csv");
    expect(el.querySelector("[data-testid=saved-draft-remove-d2]")).toBeNull();
    expect(el.querySelector("[data-testid=saved-draft-d2]")?.textContent).toContain("Being checked");
    click(el.querySelector("[data-testid=saved-draft-remove-d1]")!);
    expect(rpc.mock.calls.some((c) => c[0] === "delete_trial_balance_draft")).toBe(false);
    expect(await axeViolations(el)).toEqual([]);
    click(el.querySelector("[data-testid=saved-draft-confirm-d1]")!); await flush();
    expect(rpc).toHaveBeenCalledWith("delete_trial_balance_draft", { p_draft_id: "d1" });
    expect(el.querySelector("[data-testid=saved-drafts-message]")?.textContent).toBe("Removed.");
    expect(el.querySelector("[data-testid=saved-draft-d1]")).toBeNull();
  });
});
