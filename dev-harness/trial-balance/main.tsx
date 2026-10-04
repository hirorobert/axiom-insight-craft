// NON-PRODUCTION HARNESS. The REAL Prepare page — PrepareWorkspace inside the real useWorkspaceData / WorkspaceContext —
// against the in-browser synthetic backend (syntheticBackend.ts), so upload, review, retry, failure recovery and
// readiness can be exercised in a browser with no network and no credentials. The engagement context is a fixed
// synthetic value (the mandate layer is not under test here).
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import "../../src/index.css";
import { Toaster } from "../../src/components/ui/sonner";
import PrepareWorkspace from "../../src/pages/workspace/PrepareWorkspace";
import { useWorkspaceData } from "../../src/hooks/useWorkspaceData";
import { WorkspaceContext } from "../../src/contexts/WorkspaceContext";
import { EngagementContext, type EngagementContextValue } from "../../src/contexts/EngagementContext";
import { AuthProvider } from "./syntheticAuth";
import { COMPANY, ENGAGEMENT, PERIOD, tb, type Injection } from "./syntheticBackend";

if (!import.meta.env.DEV) {
  throw new Error("dev-harness is a non-production tool and cannot run in a production build.");
}

const engagement = {
  engagement: { id: ENGAGEMENT, fiscal_period_id: PERIOD, company_id: COMPANY },
  mandate: { capabilities: ["FINANCIAL_STATEMENTS"] }, authorities: [], events: [], canAmend: true, loading: false,
  refresh: () => undefined, createEngagement: async () => undefined, grantCapability: async () => undefined, revokeCapability: async () => undefined,
  missionViews: [],
} as unknown as EngagementContextValue;

/** Reconciliation states the browser test switches between (written straight into the synthetic tables).
 *  running / open / rejected are an existing INCOMPLETE session (status processing / needs_review / blocked, with a
 *  pending or rejected exception); partial / escalated carry a raw "clean" over incomplete evidence; complete is complete. */
type ReconKind = "none" | "running" | "open" | "rejected" | "partial" | "escalated" | "complete";
function setReconciliation(kind: ReconKind) {
  const upload = tb.tables.trial_balance_uploads[0];
  if (!upload) return;
  tb.tables.safisha_reconciliations = [];
  tb.tables.safisha_exceptions = [];
  upload.safisha_status = null;
  if (kind === "none") return;
  const status = kind === "running" ? "processing" : kind === "open" ? "needs_review" : kind === "rejected" ? "blocked" : "clean";
  const action = kind === "open" || kind === "running" ? "pending" : kind === "rejected" ? "rejected" : kind === "escalated" ? "escalated" : "approved";
  const recon = { id: "rrrrrrrr-0000-4000-8000-000000000001", tb_upload_id: upload.id, created_at: new Date().toISOString(), total_tb_lines: 4, exception_count: 1, status, matched_count: kind === "partial" ? 1 : 3 };
  tb.tables.safisha_reconciliations.push(recon);
  tb.tables.safisha_exceptions.push({ id: "xxxxxxxx-0000-4000-8000-000000000001", reconciliation_id: recon.id, tb_txn_id: "tb-line-4", reviewer_action: action });
  upload.safisha_status = status;
}

function Controls({ refresh }: { refresh: () => void }) {
  const [, force] = useState(0);
  const act = (f: () => void) => () => { f(); force((n) => n + 1); refresh(); };
  const inject = (i: Injection) => () => { tb.inject = i; force((n) => n + 1); };
  return (
    <div style={{ padding: 8, fontFamily: "monospace", fontSize: 12, borderBottom: "1px solid #ccc", display: "flex", flexWrap: "wrap", gap: 6 }} data-testid="harness-bar">
      <span>next check: <b data-testid="harness-inject">{tb.inject ?? "normal"}</b></span>
      {(["drop_before", "drop_after", "server_error", "in_progress", "upload_fails"] as Injection[]).map((i) => (
        <button key={i} data-testid={`inject-${i}`} onClick={inject(i)}>{i}</button>
      ))}
      <span>· viewer:</span>
      <button data-testid="viewer-owner" onClick={act(() => { tb.viewer = "owner"; })}>owner</button>
      <button data-testid="viewer-prepare" onClick={act(() => { tb.viewer = "prepare_only"; })}>prepare-only</button>
      <span>· reconciliation:</span>
      {(["none", "running", "open", "rejected", "partial", "escalated", "complete"] as const).map((k) => (
        <button key={k} data-testid={`recon-${k}`} onClick={act(() => setReconciliation(k))}>{k}</button>
      ))}
      <span>· runs: <b data-testid="harness-runs">{tb.runs}</b></span>
    </div>
  );
}

function Page() {
  const data = useWorkspaceData();
  return (
    <WorkspaceContext.Provider value={data}>
      <EngagementContext.Provider value={engagement}>
        <Controls refresh={data.refreshUpload} />
        <div style={{ padding: 16 }}><PrepareWorkspace /></div>
      </EngagementContext.Provider>
    </WorkspaceContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={[`/workspace/${COMPANY}/2025/prepare`]}>
    <AuthProvider>
      <Routes>
        <Route path="/workspace/:companyId/:periodYear/prepare" element={<Page />} />
      </Routes>
      <Toaster />
    </AuthProvider>
  </MemoryRouter>,
);
