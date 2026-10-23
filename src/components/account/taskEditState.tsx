import { createContext, useCallback, useMemo, useState, useRef, type ReactNode } from "react";
import type { EditState } from "./managementState";
type Registry = { edits: Record<string, EditState>; current: React.MutableRefObject<Record<string, EditState>>; register: (id: string, state: EditState | null) => void };
export const TaskEditContext = createContext<Registry | null>(null);
export function TaskEditProvider({ children }: { children: ReactNode }) {
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const current = useRef<Record<string, EditState>>({});
  const register = useCallback((id: string, state: EditState | null) => {
    const previous = current.current;
    if (state && previous[id]?.dirty === state.dirty && previous[id]?.busy === state.busy) return;
    if (!state && !previous[id]) return;
    const next = { ...previous }; if (state) next[id] = state; else delete next[id];
    current.current = next; setEdits(next);
  }, []);
  return <TaskEditContext.Provider value={useMemo(() => ({ edits, current, register }), [edits, register])}>{children}</TaskEditContext.Provider>;
}
