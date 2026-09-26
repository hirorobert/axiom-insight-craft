/**
 * Structured outcome of create_entity (20260925100000). The server creates the workspace for the signed-in user,
 * enforces the plan's entity capacity transactionally, and is idempotent per request id. This parser reads only the
 * returned fields and fails closed on anything unexpected.
 */
import type { CapacityAnswer } from "./paidActions";

export type CreateEntityOutcome =
  | { readonly kind: "created"; readonly companyId: string; readonly replayed: boolean }
  | { readonly kind: "capacity"; readonly capacity: CapacityAnswer }
  | { readonly kind: "failed"; readonly reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseCreateEntityOutcome(raw: unknown): CreateEntityOutcome {
  if (!raw || typeof raw !== "object") return { kind: "failed", reason: "no_response" };
  const r = raw as Record<string, unknown>;
  switch (r.outcome) {
    case "created":
    case "already_created":
      return typeof r.company_id === "string" && UUID.test(r.company_id)
        ? { kind: "created", companyId: r.company_id, replayed: r.outcome === "already_created" }
        : { kind: "failed", reason: "malformed" };
    case "capacity_reached":
    case "capacity_undetermined":
      return {
        kind: "capacity",
        capacity: {
          capacity: num(r.capacity),
          used: num(r.used),
          planCode: typeof r.plan_code === "string" ? r.plan_code : null,
          determined: r.outcome === "capacity_reached",
        },
      };
    default:
      return { kind: "failed", reason: typeof r.outcome === "string" ? r.outcome : "unknown" };
  }
}
