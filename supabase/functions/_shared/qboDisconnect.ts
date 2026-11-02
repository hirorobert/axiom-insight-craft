import { connectionBinding, type EnvelopeBinding } from "./qboTokenEnvelope.ts";
import type { QboEnvironment } from "./qboReadOnlyGuard.ts";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseDisconnectRequest(v: unknown): { connectionId: string; requestId: string } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 2 || typeof o.connectionId !== "string" || typeof o.requestId !== "string" || !UUID.test(o.connectionId) || !UUID.test(o.requestId)) return null;
  return { connectionId: o.connectionId, requestId: o.requestId };
}
export interface DisconnectDeps {
  authenticate(): Promise<string | null>;
  begin(connectionId: string, actor: string, requestId: string): Promise<{ outcome: string; leaseId?: string; envelope?: string; companyId?: string; realmId?: string; environment?: QboEnvironment }>;
  open(envelope: string, binding: EnvelopeBinding): Promise<string | null>;
  revoke(environment: QboEnvironment, token: string): Promise<boolean>;
  finish(connectionId: string, actor: string, requestId: string, leaseId: string): Promise<boolean>;
}
/** Local terminal state comes first. Pending encrypted revocation material is inaccessible to import/refresh; retry reuses the exact request. */
export async function runQboDisconnect(d: DisconnectDeps, request: ReturnType<typeof parseDisconnectRequest>): Promise<{ status: number; outcome: string }> {
  const actor = await d.authenticate(); if (!actor) return { status: 401, outcome: "unauthenticated" };
  if (!request) return { status: 400, outcome: "invalid_request" };
  const b = await d.begin(request.connectionId, actor, request.requestId);
  if (b.outcome === "forbidden") return { status: 403, outcome: "forbidden" };
  if (b.outcome === "busy" || b.outcome === "revocation_busy" || b.outcome === "request_conflict") return { status: 409, outcome: b.outcome };
  if (b.outcome === "revoked") return { status: 200, outcome: "disconnected" };
  if (b.outcome === "local_only") return { status: 202, outcome: "local_only" };
  if (b.outcome !== "pending" || !b.leaseId || !b.envelope || !b.companyId || !b.realmId || !b.environment) return { status: 503, outcome: "disconnect_unconfirmed" };
  const token = await d.open(b.envelope, connectionBinding(b.companyId, b.realmId, b.environment));
  if (!token) return { status: 202, outcome: "revocation_pending" };
  try {
    if (!(await d.revoke(b.environment, token))) return { status: 202, outcome: "revocation_pending" };
    return (await d.finish(request.connectionId, actor, request.requestId, b.leaseId))
      ? { status: 200, outcome: "disconnected" } : { status: 202, outcome: "revocation_pending" };
  } catch { return { status: 202, outcome: "revocation_pending" }; }
}