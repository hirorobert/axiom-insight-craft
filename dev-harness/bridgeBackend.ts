// NON-PRODUCTION. A FsBackend over the loopback PostgREST-style bridge started by
// scripts/db-proof/serve.mjs (a disposable PostgreSQL). Refuses any non-loopback URL.
// The `x-sim-user` header names a fixture user; it is NOT authentication (no GoTrue).
import type { FsBackend } from "../src/lib/financialStatementsWorkspace/rpcTransport";

export function assertLoopback(url: string): void {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`dev-harness bridge must be loopback, got ${host}`);
}

export function bridgeBackend(bridge: string, simUser: string): FsBackend {
  assertLoopback(bridge);
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${bridge}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-sim-user": simUser }, body: JSON.stringify(body) });
    const json = await r.json();
    return r.ok ? { data: json, error: null } : { data: null, error: json.error as { code?: string; message: string } };
  };
  return {
    rpc: (fn, args) => post(`/rpc/${fn}`, args),
    select: (table, filters) => post(`/select/${table}`, filters) as never,
  };
}

export async function loadSeed(bridge: string): Promise<{ companyA: string; companyB: string; users: Record<string, string> }> {
  assertLoopback(bridge);
  return (await fetch(`${bridge}/seed`, { method: "POST", headers: { "content-type": "application/json", "x-sim-user": "owner" }, body: "{}" })).json();
}
