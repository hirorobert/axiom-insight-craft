/** Sandbox visibility only. This never grants connector authority: each backend operation still authenticates and checks both rights. */
export interface SandboxScope { companyId: string; periodYear: number }
export interface SandboxStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface SandboxAccessDeps {
  currentUser(): Promise<string | null>;
  platformOwner(userId: string): Promise<boolean>;
  workspaceOwner(companyId: string): Promise<string | null>;
  hasSources(companyId: string): Promise<boolean | null>;
}
const key = (s: SandboxScope) => `cfoclose:qbo-sandbox:${s.companyId}:${s.periodYear}`;
export function optedIn(storage: SandboxStorage | null, scope: SandboxScope): string | null {
  try { return storage?.getItem(key(scope)) || null; } catch { return null; }
}
export async function sandboxActor(deps: SandboxAccessDeps, companyId?: string): Promise<string | null> {
  try {
    const actor = await deps.currentUser();
    if (!actor || !(await deps.platformOwner(actor))) return null;
    if (companyId && await deps.workspaceOwner(companyId) !== actor) return null;
    return actor;
  } catch { return null; }
}
export async function enrollSandbox(deps: SandboxAccessDeps, storage: SandboxStorage | null, scope: SandboxScope): Promise<boolean> {
  const actor = await sandboxActor(deps, scope.companyId);
  if (!actor || !storage) return false;
  // Re-entry to this tab's already-enrolled test remains possible after its first import. No financial status is derived here.
  if (optedIn(storage, scope) === actor) return true;
  try {
    if (await deps.hasSources(scope.companyId) !== false) return false;
    storage.setItem(key(scope), actor);
    return optedIn(storage, scope) === actor;
  } catch { return false; }
}
