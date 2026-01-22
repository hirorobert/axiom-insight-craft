import { AlertTriangle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BlockedExportOverlayProps {
  isBlocked: boolean;
  onViewErrors: () => void;
}

/**
 * AXIOM UI Governance: Disable export functionality when status ≠ VALID
 */
export function BlockedExportOverlay({ isBlocked, onViewErrors }: BlockedExportOverlayProps) {
  if (!isBlocked) return null;

  return (
    <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex flex-col items-center justify-center z-10 rounded-lg">
      <div className="flex flex-col items-center gap-3 p-6 text-center">
        <div className="w-12 h-12 rounded-full bg-destructive/20 flex items-center justify-center">
          <Lock className="w-6 h-6 text-destructive" />
        </div>
        <div>
          <p className="font-semibold text-foreground">Export Disabled</p>
          <p className="text-sm text-muted-foreground max-w-xs">
            Statements cannot be exported until all accounting validations pass
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onViewErrors} className="gap-2">
          <AlertTriangle className="w-4 h-4" />
          View Errors
        </Button>
      </div>
    </div>
  );
}
