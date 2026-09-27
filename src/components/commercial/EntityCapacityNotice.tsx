import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import type { CapacityAnswer } from "@/lib/commercial/paidActions";

/** Presentation only. The create_entity RPC remains the authority for every new entity. */
export function EntityCapacityNotice({ capacity, loading, error, onRetry }: {
  capacity: CapacityAnswer | null;
  loading: boolean;
  error: boolean;
  onRetry?: () => void;
}) {
  if (!loading && !error && capacity?.determined && capacity.capacity !== null && capacity.used !== null && capacity.used < capacity.capacity) return null;
  const message = loading ? "Checking entity capacity…" : error || !capacity || !capacity.determined || capacity.capacity === null || capacity.used === null
    ? "Entity capacity unavailable."
    : capacity.capacity === 0 && capacity.planCode === null
      ? "No active plan. Existing companies remain accessible."
      : "Entity capacity reached. Existing companies remain accessible.";
  return <div role="status" className="text-xs text-muted-foreground">{message} <Link className="underline" to="/plans">View plans</Link>{(error || !capacity) && onRetry && <Button variant="link" size="sm" onClick={onRetry}>Retry</Button>}</div>;
}