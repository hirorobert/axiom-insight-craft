import { useCallback, useEffect, useRef, useState } from "react";
import { createRequestGuard } from "@/lib/workbench/requestSequence";

export type GuardedState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "error"; readonly error: unknown };

/**
 * Runs reads bound to the current context key. A response is applied only if it is the newest on this channel and the
 * context has not changed since it was issued (requestSequence.ts). Changing the context resets to "loading".
 */
export function useGuardedRequest<T>(channel: string, contextKey: string, load: () => Promise<T>, deps: readonly unknown[] = []) {
  const guard = useRef(createRequestGuard());
  const active = useRef(contextKey);
  active.current = contextKey;
  const [state, setState] = useState<GuardedState<T>>({ status: "idle" });
  const run = useCallback(() => {
    const ticket = guard.current.begin(channel, contextKey);
    setState({ status: "loading" });
    load().then(
      (value) => { if (guard.current.accepts(ticket, active.current)) setState({ status: "ready", value }); },
      (error) => { if (guard.current.accepts(ticket, active.current)) setState({ status: "error", error }); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, contextKey, ...deps]);
  useEffect(() => { run(); }, [run]);
  return { state, reload: run };
}
