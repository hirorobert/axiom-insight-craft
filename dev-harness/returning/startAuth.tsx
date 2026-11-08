// NON-PRODUCTION HARNESS. A stand-in for src/contexts/AuthContext: the SIMULATED signed-in person of the bridge (no GoTrue).
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { SIM_USER, simUserId } from "./bridgeSupabase";

interface Ctx { user: { id: string; email: string } | null; session: null; loading: boolean; emailVerified: boolean; signOut: () => Promise<void> }
const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => { void simUserId().then(setId); }, []);
  const value: Ctx = { user: id ? { id, email: `${SIM_USER}@example.test` } : null, session: null, loading: id === null, emailVerified: true, signOut: async () => undefined };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthContext);
  if (!c) throw new Error("harness AuthProvider missing");
  return c;
}
