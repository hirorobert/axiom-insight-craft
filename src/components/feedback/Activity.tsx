import { ActivityContext, useActivity } from "./useActivity";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useIsFetching, useIsMutating } from "@tanstack/react-query";

/** Only actual pending work registers here. Route clicks never start a pretend timer. */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [activities, setActivities] = useState<Record<string, string>>({});
  const register = useCallback<(id: string, label: string | null) => void>((id, label) => setActivities((current) => {
    if (label === null) {
      if (!(id in current)) return current;
      const next = { ...current }; delete next[id]; return next;
    }
    return current[id] === label ? current : { ...current, [id]: label };
  }), []);
  const fetching = useIsFetching();
  const mutating = useIsMutating();
  const labels = useMemo(() => Object.values(activities), [activities]);
  const active = labels.length > 0 || fetching > 0 || mutating > 0;
  const [longWait, setLongWait] = useState(false);
  useEffect(() => {
    setLongWait(false);
    if (!active) return;
    const timer = setTimeout(() => setLongWait(true), 12000);
    return () => clearTimeout(timer);
  }, [active]);
  const label = labels[0] ?? (mutating ? "Saving changes…" : "Loading…");
  return <ActivityContext.Provider value={register}>
    {children}
    {active && <div data-testid="activity-indicator" className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden bg-primary/15" aria-hidden="true"><div className="h-full w-1/3 bg-primary motion-safe:animate-[activity-travel_1.2s_ease-in-out_infinite]" /></div>}
    {active && longWait && <div role="status" className="pointer-events-none fixed bottom-4 right-4 z-[100] max-w-xs rounded-sm border border-border bg-background px-4 py-3 text-sm shadow-sm">Still waiting for a response. The result has not been confirmed yet.</div>}
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{active ? label : ""}</div>
  </ActivityContext.Provider>;
}

export function PendingStatus({ label = "Loading…", className = "", skeleton = false }: { label?: string; className?: string; skeleton?: boolean }) {
  useActivity(true, label);
  // Feedback is immediate; decorative skeletons wait briefly and never hold ready content back.
  const [showSkeleton, setShowSkeleton] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setShowSkeleton(true), 180); return () => clearTimeout(timer); }, []);
  return <div className={`space-y-4 ${className}`} aria-busy="true">
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />{label}</p>
    {skeleton && <div aria-hidden="true" className={`space-y-3 ${showSkeleton ? "visible" : "invisible"}`}>
      <div className="h-9 w-full rounded-sm bg-muted motion-safe:animate-pulse" />
      {[0, 1, 2].map((row) => <div key={row} className="h-12 w-full rounded-sm bg-muted/60 motion-safe:animate-pulse" />)}
    </div>}
  </div>;
}

export function PagePending() {
  return <PendingStatus label="Opening page…" className="mx-auto w-full max-w-6xl p-6" skeleton />;
}
