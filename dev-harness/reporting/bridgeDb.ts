// NON-PRODUCTION. The reporting workbench's ReportingDb over the loopback bridge of scripts/db-proof/serveReporting.mjs
// (a disposable PostgreSQL). Refuses any non-loopback URL. `x-sim-user` names a fixture user; it is NOT authentication.
import { parseMyWorkspaceCapabilities } from "../../src/lib/auth/workspaceCapabilities";
import type { ReportingDb } from "../../src/lib/reporting/signoff";

export function assertLoopback(url: string): void {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`dev-harness bridge must be loopback, got ${host}`);
}

export function reportingBridgeDb(bridge: string, simUser: string): ReportingDb {
  assertLoopback(bridge);
  const post = async (p: string, body: unknown) => {
    const r = await fetch(`${bridge}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-sim-user": simUser }, body: JSON.stringify(body) });
    const json = await r.json();
    return r.ok ? { data: json, error: null } : { data: null, error: json.error as { message: string; code?: string } };
  };
  return { rpc: (fn, args) => post(`/rpc/${fn}`, args), select: (t, f) => post(`/select/${t}`, f) };
}

/** The simulated user's capabilities, from the same server function the app's hook reads. */
export async function loadAllowed(db: ReportingDb, companyId: string): Promise<string[]> {
  const r = await db.rpc("get_my_workspace_capabilities", { p_company_id: companyId });
  return parseMyWorkspaceCapabilities(r.data)?.allowed ?? [];
}

export async function loadReportingSeed(bridge: string, simUser: string): Promise<{ companyId: string; periodYear: number }> {
  assertLoopback(bridge);
  return (await fetch(`${bridge}/seed`, { method: "POST", headers: { "x-sim-user": simUser }, body: "{}" })).json();
}
