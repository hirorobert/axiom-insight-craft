import { useCallback, useRef, useState } from "react";
import { useActivity } from "@/components/feedback/useActivity";

/** A synchronous local lock plus visible state. This complements, never replaces, server controls.
 * setBusy(true) acquires the lock and returns false if an action is already in flight.
 * The owning handler must release it in finally. No automatic retry of writes.
 */
export function useBusyState(label = "Recording changes…"): readonly [boolean, (value: boolean) => boolean] {
  const lock = useRef(false);
  const [busy, update] = useState(false);
  useActivity(busy, label);
  const setBusy = useCallback((value: boolean) => {
    if (value && lock.current) return false;
    lock.current = value;
    update(value);
    return true;
  }, []);
  return [busy, setBusy] as const;
}
