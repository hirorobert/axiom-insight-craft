import { Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSessionContext } from "@/components/SessionTimeoutProvider";
import { cn } from "@/lib/utils";

export function SessionIndicator() {
  const { timeRemaining, isWarning, isCritical, extendSession } = useSessionContext();

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors",
                isCritical
                  ? "bg-destructive/10 text-destructive"
                  : isWarning
                    ? "bg-warning/10 text-warning"
                    : "bg-muted text-muted-foreground"
              )}
            >
              <Clock className="w-3 h-3" />
              <span>{formatTime(timeRemaining)}</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={extendSession}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>Session expires in {formatTime(timeRemaining)}</p>
          <p className="text-xs text-muted-foreground">Click refresh to extend</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
