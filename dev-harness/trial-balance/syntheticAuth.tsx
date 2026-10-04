// NON-PRODUCTION HARNESS. A stand-in for src/contexts/AuthContext with one synthetic signed-in user (no GoTrue).
import { createContext, useContext, type ReactNode } from "react";

interface Ctx { user: { id: string; email: string } | null; loading: boolean; signOut: () => Promise<void> }
const AuthContext = createContext<Ctx | null>(null);
export const HARNESS_USER = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "owner@example.test" };

export function AuthProvider({ children }: { children: ReactNode }) {
  return <AuthContext.Provider value={{ user: HARNESS_USER, loading: false, signOut: async () => undefined }}>{children}</AuthContext.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthContext);
  if (!c) throw new Error("synthetic AuthProvider missing");
  return c;
}
