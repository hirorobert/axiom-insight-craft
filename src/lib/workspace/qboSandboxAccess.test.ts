import { describe, expect, it, vi } from "vitest";
import { enrollSandbox, optedIn, sandboxActor, type SandboxAccessDeps } from "./qboSandboxAccess";
const scope = { companyId: "test-company", periodYear: 2026 };
function fixture(over: Partial<SandboxAccessDeps> = {}) {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
  const deps = { currentUser: vi.fn(async () => "owner"), platformOwner: vi.fn(async () => true), workspaceOwner: vi.fn(async () => "owner"), hasSources: vi.fn(async () => false), ...over };
  return { deps, storage };
}
describe("restricted Sandbox enrollment", () => {
  it("admits an empty owned workspace, scoped to actor, company and year", async () => {
    const { deps, storage } = fixture(); expect(await enrollSandbox(deps, storage, scope)).toBe(true);
    expect(optedIn(storage, scope)).toBe("owner");
    expect(optedIn(storage, { ...scope, periodYear: 2025 })).toBeNull();
    expect(optedIn(storage, { ...scope, companyId: "other" })).toBeNull();
  });
  it("refuses unauthenticated people before reading company data", async () => {
    const { deps, storage } = fixture({ currentUser: async () => null });
    expect(await enrollSandbox(deps, storage, scope)).toBe(false); expect(deps.workspaceOwner).not.toHaveBeenCalled();
  });
  it("refuses ordinary customers even when they own the company", async () => {
    const { deps, storage } = fixture({ platformOwner: async () => false });
    expect(await enrollSandbox(deps, storage, scope)).toBe(false); expect(deps.workspaceOwner).not.toHaveBeenCalled();
  });
  it("refuses another owner's workspace", async () => {
    const { deps, storage } = fixture({ workspaceOwner: async () => "other" });
    expect(await enrollSandbox(deps, storage, scope)).toBe(false); expect(deps.hasSources).not.toHaveBeenCalled();
  });
  it.each([true, null])("refuses a nonempty or unreadable source inventory (%s)", async value => {
    const { deps, storage } = fixture({ hasSources: async () => value });
    expect(await enrollSandbox(deps, storage, scope)).toBe(false); expect(optedIn(storage, scope)).toBeNull();
  });
  it("permits re-entry after importing but rechecks current ownership", async () => {
    const { deps, storage } = fixture(); await enrollSandbox(deps, storage, scope);
    deps.hasSources.mockResolvedValue(true); expect(await enrollSandbox(deps, storage, scope)).toBe(true);
    deps.workspaceOwner.mockResolvedValue("new-owner"); expect(await enrollSandbox(deps, storage, scope)).toBe(false);
  });
  it("does not reuse a prior actor's enrollment", async () => {
    const { deps, storage } = fixture(); await enrollSandbox(deps, storage, scope);
    deps.currentUser.mockResolvedValue("other"); deps.workspaceOwner.mockResolvedValue("other"); deps.hasSources.mockResolvedValue(true);
    expect(await enrollSandbox(deps, storage, scope)).toBe(false);
  });
  it("fails closed on unavailable storage and failed authority reads", async () => {
    const { deps } = fixture(); expect(await enrollSandbox(deps, null, scope)).toBe(false);
    expect(await sandboxActor({ ...deps, platformOwner: async () => { throw Error("offline"); } })).toBeNull();
    expect(await enrollSandbox(deps, { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); } }, scope)).toBe(false);
  });
});
