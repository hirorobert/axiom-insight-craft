import { createContext, useContext, useEffect, useId } from "react";
type Register = (id: string, label: string | null) => void;
export const ActivityContext = createContext<Register>(() => undefined);


/** The registration is removed on completion AND unmount (including route changes). */
export function useActivity(pending: boolean, label: string) {
  const register = useContext(ActivityContext);
  const id = useId();
  useEffect(() => {
    if (!pending) return;
    register(id, label);
    return () => register(id, null);
  }, [pending, label, id, register]);
}

