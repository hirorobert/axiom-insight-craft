import type { BillingSummary } from "@/hooks/useBillingSummary";
import type { CapacityAnswer } from "./paidActions";

/** Presentation gate for the zero-entity path only. Existing workspaces never pass through this gate. */
export function decideEmptyAccountScreen(
  billing: BillingSummary | null,
  capacity: CapacityAnswer | null,
  hasSharedWorkspaces: boolean,
): "plans" | "setup" | "unavailable" | "shared" {
  if (hasSharedWorkspaces) return "shared";
  if (!billing || !capacity) return "unavailable";
  if (billing.licenceStatus !== "ACTIVE" && billing.licenceStatus !== "GRACE") return "plans";
  // Undetermined capacity is a normal server answer for "by agreement" plans
  // (e.g. Enterprise, whose entity_capacity is NULL) — not a read failure.
  // Mount setup and let the server remain the enforcement authority at create_entity.
  if (!capacity.determined || capacity.capacity === null) return "setup";
  if (capacity.used === null || capacity.used >= capacity.capacity) return "unavailable";
  return "setup";
}
