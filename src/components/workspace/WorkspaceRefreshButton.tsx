import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { refreshWorkspaceReaders } from "@/hooks/useWorkspaceRefresh";
export function WorkspaceRefreshButton({companyId, periodYear, reads}: {companyId: string; periodYear: number; reads: Array<() => Promise<unknown>>}) {
  const running = useRef(false);
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">("idle");
  return <div className="flex items-center gap-2">
    <span role="status" className="max-w-48 text-xs text-muted-foreground">{status === "busy" ? "Refreshing workspace…" : status === "done" ? "Workspace updated" : status === "error" ? "Refresh incomplete. Try again." : ""}</span>
    <Button variant="ghost" size="sm" title="Refresh workspace data" aria-label="Refresh data" data-testid="workspace-refresh" disabled={status === "busy"} aria-busy={status === "busy"} className="h-9 w-9 p-0"
      onClick={async () => { if (running.current) return; running.current=true; setStatus("busy");
        try { await refreshWorkspaceReaders(companyId, periodYear, reads); setStatus("done"); }
        catch { setStatus("error"); } finally { running.current=false; }
      }}><RefreshCw className={`h-4 w-4 ${status === "busy" ? "animate-spin" : ""}`} /></Button>
  </div>;
}
