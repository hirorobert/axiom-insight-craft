// NON-PRODUCTION. The two calls the returning-client harness makes beyond the reporting bridge: the Edge Function rfr-check-books (played in
// process by scripts/db-proof/serveReturning.mjs) and the seed. Refuses any non-loopback URL. `x-sim-user` names a fixture user; it is NOT authentication.
import { assertLoopback } from "../reporting/bridgeDb";

export function bridgeInvoke(bridge: string, simUser: string) {
  assertLoopback(bridge);
  return async (name: string, body: Record<string, unknown>) => {
    const r = await fetch(`${bridge}/invoke/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-sim-user": simUser }, body: JSON.stringify(body) });
    const json = await r.json();
    return r.ok ? { data: json, error: null } : { data: null, error: { message: String(json?.error?.message ?? "failed") } };
  };
}

export async function loadReturningSeed<T>(bridge: string, simUser: string): Promise<T> {
  assertLoopback(bridge);
  return (await (await fetch(`${bridge}/seed`, { method: "POST", headers: { "x-sim-user": simUser }, body: "{}" })).json()) as T;
}
