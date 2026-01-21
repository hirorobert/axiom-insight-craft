import { useState, useEffect } from "react";
import { Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSessionTimeout } from "@/hooks/useSessionTimeout";
import { cn } from "@/lib/utils";

export function SessionIndicator() {
  const { resetTimer, getTimeRemaining } = useSessionTimeout();
  const [timeRemaining, setTimeRemaining] = useState(getTimeRemaining());

  useEffect(() => {
    const interval = setInterval(() => {
      setTimeRemaining(getTimeRemaining());
    }, 1000);

    return () => clearInterval(interval);
  }, [getTimeRemaining]);

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const isWarning = timeRemaining <= 5 * 60 * 1000; // 5 minutes
  const isCritical = timeRemaining <= 2 * 60 * 1000; // 2 minutes

  const handleExtend = () => {
    resetTimer();
    setTimeRemaining(getTimeRemaining());
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
              onClick={handleExtend}
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
