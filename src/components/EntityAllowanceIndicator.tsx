import { Link } from "react-router-dom";
import { Building2 } from "lucide-react";
import { useMyEntityCapacity } from "@/hooks/useMyEntityCapacity";

/**
 * Workspace entity switcher allowance (directive §12): "1 of 5 active entities" / "12 of 25 active entities" /
 * "Unlimited active entities", with a quiet "Manage entities" link. No progress bars, badges or celebratory effects.
 * At the limit the count is emphasised but the explanation stays on the Add-entity flow, not here.
 */
export function EntityAllowanceIndicator({ manageTo = "/settings", className = "" }: { manageTo?: string; className?: string }) {
  const { capacity, loading } = useMyEntityCapacity();
  if (loading || !capacity) return null;
  const used = capacity.used ?? 0;
  const atLimit = !capacity.unlimited && capacity.determined && capacity.capacity !== null && used >= capacity.capacity;
  const label = capacity.unlimited
    ? "Unlimited active entities"
    : capacity.determined && capacity.capacity !== null
      ? `${used} of ${capacity.capacity} active ${capacity.capacity === 1 ? "entity" : "entities"}`
      : `${used} active entities`;
  return (
    <div className={`flex items-center gap-2 text-sm ${className}`} data-testid="entity-allowance">
      <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
      <span className={atLimit ? "font-medium text-foreground" : "text-muted-foreground"}>{label}</span>
      <span aria-hidden className="text-border">·</span>
      <Link to={manageTo} className="text-primary underline-offset-2 hover:underline">Manage entities</Link>
    </div>
  );
}
