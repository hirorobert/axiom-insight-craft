/** /plans, checkout and orders: the signed-in AccountShell when signed in, the public Header and Footer otherwise. */
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { useAuth } from "@/contexts/AuthContext";
import { AccountShell } from "./AccountShell";

/** A page reachable signed in or out: the account frame when signed in, the public frame otherwise. */
export function AccountOrPublicFrame({ children, publicMainClassName, accountMainClassName }: {
  children: ReactNode;
  publicMainClassName: string;
  accountMainClassName?: string;
}) {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  if (user) return <AccountShell mainClassName={accountMainClassName} onSignOut={() => { void signOut().then(() => navigate("/auth", { replace: true })); }}>{children}</AccountShell>;
  // While the session is being read, neither frame: no public "Sign in" flash for a signed-in person.
  if (loading) return <div className="min-h-screen bg-background"><main id="main-content" className={accountMainClassName ?? publicMainClassName}>{children}</main></div>;
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main id="main-content" className={publicMainClassName}>{children}</main>
      <Footer />
    </div>
  );
}
