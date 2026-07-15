/**
 * CommandCenter — Partner-level all-companies command view.
 *
 * Phase A placeholder: route /command resolves here.
 * FirmDashboardPanel arrives in Phase C when it is re-homed from Monitor.
 *
 * This is the authenticated post-login landing for firm partners who need
 * a cross-engagement view before drilling into a specific workspace.
 */

import { Link } from "react-router-dom";
import { BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function CommandCenter() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-6">
      <BarChart3 className="w-10 h-10 text-muted-foreground/40" />
      <div className="text-center">
        <p className="text-base font-semibold text-foreground">Command Center</p>
        <p className="text-sm text-muted-foreground mt-1 max-w-xs">
          Partner-level engagement overview — full content arrives in Phase C.
        </p>
      </div>
      <Button variant="outline" asChild>
        <Link to="/dashboard">Go to Dashboard</Link>
      </Button>
    </div>
  );
}
