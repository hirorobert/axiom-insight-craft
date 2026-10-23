import { PendingStatus } from "@/components/feedback/Activity";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useAccountHome } from "@/hooks/useAccountHome";
import { useBillingSummary } from "@/hooks/useBillingSummary";
import { useMyEntityCapacity } from "@/hooks/useMyEntityCapacity";
import { companyCreation } from "@/lib/workspace/accountNextAction";
import { AccountShell } from "@/components/account/AccountShell";
import FirstRunEngagement from "@/components/workspace/FirstRunEngagement";
import { Button } from "@/components/ui/button";

/** A focused view over the EXISTING creation contract, not a second writer. */
export default function AddCompany() {
  const { user, loading: authLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const discovery = useAccountHome();
  const billing = useBillingSummary();
  const capacity = useMyEntityCapacity(!!user);
  const creation = companyCreation({ billing: { loading: billing.loading, error: !!billing.error, summary: billing.summary }, capacity: { loading: capacity.loading, error: !!capacity.error, answer: capacity.capacity } });
  if (!authLoading && !user) return <Navigate to="/auth" replace />;
  const waiting = authLoading || discovery.loading || billing.loading || capacity.loading;
  const unavailable = discovery.fetchFailed || creation === "unknown";
  return <AccountShell setup identity={{ name: user?.user_metadata?.display_name, email: user?.email }} onSignOut={async () => { await signOut(); navigate("/auth", { replace: true }); }}>
    <nav aria-label="Breadcrumb" className="mb-5 flex gap-2 text-xs text-muted-foreground"><Link to="/dashboard" state={{ forceHub: true }} className="hover:text-foreground">Engagements</Link><span aria-hidden="true">/</span><span>Add company</span></nav>
    <div className="max-w-5xl" data-testid="company-setup-page">
      {waiting ? <PendingStatus label="Checking your account…" skeleton /> : unavailable ? <div role="alert" className="space-y-4"><h1 className="text-2xl font-semibold">We couldn’t confirm your account</h1><p>Your existing work is unchanged. Refresh the account checks before adding a company.</p><Button onClick={() => { void discovery.refresh(); billing.retry(); capacity.retry(); }}>Try again</Button></div>
        : creation === "allowed" ? <FirstRunEngagement layout="page" onCreated={(id, year) => navigate(`/workspace/${id}/${year}`, { replace: true })} />
        : <div className="space-y-4"><h1 className="text-2xl font-semibold">{creation === "needs_plan" ? "Choose a plan before adding a company" : "Your company capacity is in use"}</h1><p className="text-sm text-muted-foreground">Your existing companies and records remain accessible.</p><Button asChild><Link to="/plans">{creation === "needs_plan" ? "Choose a plan" : "See larger plans"}</Link></Button></div>}
    </div>
  </AccountShell>;
}
