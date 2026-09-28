import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { CapacityAnswer } from "@/lib/commercial/paidActions";

export function useMyEntityCapacity(enabled = true) {
  const [capacity, setCapacity] = useState<CapacityAnswer | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(false);
    supabase.rpc("get_my_entity_capacity").then(({ data, error: rpcError }) => {
      if (cancelled) return;
      const value = data && typeof data === "object" ? data as Record<string, unknown> : null;
      if (rpcError || !value || typeof value.determined !== "boolean" ||
          !Object.prototype.hasOwnProperty.call(value, "capacity") || !Object.prototype.hasOwnProperty.call(value, "used") ||
          (value.capacity !== null && (typeof value.capacity !== "number" || !Number.isSafeInteger(value.capacity) || value.capacity < 0)) ||
          (value.used !== null && (typeof value.used !== "number" || !Number.isSafeInteger(value.used) || value.used < 0)))) {
        setCapacity(null);
        setError(true);
      } else {
        setCapacity({ determined: value.determined, capacity: value.capacity as number | null,
          used: value.used as number | null, planCode: typeof value.plan_code === "string" ? value.plan_code : null });
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [enabled, attempt]);
  return { capacity, loading, error, retry: () => setAttempt((n) => n + 1) };
}
