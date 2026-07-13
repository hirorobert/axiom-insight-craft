/**
 * WorkspaceGate — Locked workspace display.
 *
 * "Locked workspaces must display WHY they are locked.
 *  Do not silently hide prerequisites." — Constitutional Rule
 *
 * Shows: what is locked, why, and one link to resolve.
 */

import { Link } from "react-router-dom";
import { Lock, ChevronRight } from "lucide-react";

interface WorkspaceGateProps {
  mission: string;
  blocker: string;
  prerequisiteHref: string;
  prerequisiteLabel: string;
}

export function WorkspaceGate({
  mission,
  blocker,
  prerequisiteHref,
  prerequisiteLabel,
}: WorkspaceGateProps) {
  return (
    <div className="max-w-xl pt-4">
      <div className="border border-border p-8">
        <div className="flex items-start gap-4">
          <div className="p-2 border border-border">
            <Lock className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground mb-1">
              {mission} is locked
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed mb-4">
              {blocker}
            </p>
            <Link
              to={prerequisiteHref}
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
            >
              {prerequisiteLabel}
              <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
