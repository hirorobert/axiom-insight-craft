// NON-PRODUCTION HARNESS. The real EngagementHub and the real useReviewActionAccess against the synthetic backend.
// The page re-renders every 100 ms and passes a NEW callback on every render (exactly like Dashboard), so the browser
// test can prove the click guard survives re-renders; the identity buttons prove access answers follow the signed-in user.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "../../src/index.css";
import EngagementHub from "../../src/pages/workspace/EngagementHub";
import { useReviewActionAccess } from "../../src/hooks/useReviewActionAccess";
import { addTrialBalanceReview, type AddReviewOutcome, type UnavailableServiceEngagement } from "../../src/lib/workspace/unavailableService";
import type { RpcClient } from "../../src/lib/workspace/workspaceSetupClient";
import { AuthProvider, useAuth } from "./syntheticAuth";
import { harness, supabase } from "./syntheticClient";

if (!import.meta.env.DEV) {
  throw new Error("dev-harness is a non-production tool and cannot run in a production build.");
}

const UNAVAILABLE: UnavailableServiceEngagement[] = [{ engagementId: "e1", companyId: "c1", companyName: "Synthetic Arusha", periodYear: 2025 }];
const outcomes: AddReviewOutcome[] = [];
(window as unknown as { __outcomes: AddReviewOutcome[] }).__outcomes = outcomes;

function Page() {
  const { user, switchTo } = useAuth();
  const [renders, setRenders] = useState(0);
  useEffect(() => { const t = setInterval(() => setRenders((n) => n + 1), 100); return () => clearInterval(t); }, []);
  const { gates, refresh } = useReviewActionAccess(UNAVAILABLE.map((u) => u.companyId));
  // A NEW function on every render, as in Dashboard.
  const onAdd = async (u: UnavailableServiceEngagement): Promise<AddReviewOutcome> => {
    const out = await addTrialBalanceReview(supabase as unknown as RpcClient, u.engagementId);
    outcomes.push(out);
    if (!out.ok) refresh();
    return out;
  };
  return (
    <div>
      <div style={{ padding: 8, fontFamily: "monospace", fontSize: 12, borderBottom: "1px solid #ccc" }} data-testid="harness-bar">
        user: <b data-testid="harness-user">{user?.id ?? "signed out"}</b> · renders: <span data-testid="harness-renders">{renders}</span> ·{" "}
        <button data-testid="as-owner" onClick={() => switchTo({ id: "owner-a", email: "owner@example.test" })}>as owner-a</button>{" "}
        <button data-testid="as-preparer" onClick={() => switchTo({ id: "preparer-b", email: "preparer@example.test" })}>as preparer-b</button>{" "}
        <button data-testid="sign-out" onClick={() => switchTo(null)}>sign out</button>
      </div>
      <EngagementHub
        entries={[]}
        companiesWithoutEngagement={[]}
        onResume={() => undefined}
        onStartService={() => undefined}
        unavailableEngagements={UNAVAILABLE}
        onAddTrialBalanceReview={onAdd}
        reviewGates={gates}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <AuthProvider initial={{ id: "owner-a", email: "owner@example.test" }}>
      <Page />
    </AuthProvider>
  </BrowserRouter>,
);
