// NON-PRODUCTION HARNESS. A stand-in for src/contexts/AuthContext with a switchable synthetic identity (no GoTrue).
import { createContext, useContext, useState, type ReactNode } from "react";

export interface SyntheticUser { id: string; email: string }
interface Ctx { user: SyntheticUser | null; loading: boolean; switchTo: (u: SyntheticUser | null) => void; signOut: () => Promise<void> }
const AuthContext = createContext<Ctx | null>(null);
let current: SyntheticUser | null = null;
/** The identity the synthetic backend answers as (what a real JWT would carry). */
export const currentSyntheticUser = () => current;

export function AuthProvider({ children, initial }: { children: ReactNode; initial: SyntheticUser | null }) {
  const [user, setUser] = useState<SyntheticUser | null>(() => { current = initial; return initial; });
  const switchTo = (u: SyntheticUser | null) => { current = u; setUser(u); };
  return <AuthContext.Provider value={{ user, loading: false, switchTo, signOut: async () => switchTo(null) }}>{children}</AuthContext.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthContext);
  if (!c) throw new Error("synthetic AuthProvider missing");
  return c;
}
