/**
 * KingaWorkspace — Corporate Tax Computation (ITA Cap.332).
 *
 * Re-homes from Dashboard:
 *   KingaFindingsPanel, KingaTaxPanel, KingaComparativePanel,
 *   TransferPricingPanel, CapitalAllowancesRegister,
 *   ThinCapWorkpaper, AddBacksWorkpaper, AdjustingJournalPanel
 *
 * Sub-navigation (tabs):
 *   Compliance · Corporate Tax · Comparative · Workpapers · Adjusting Entries
 *
 * Constitutional gate: safisha_status must be 'clean'.
 */

import { useState } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { WorkspaceGate } from "@/components/workspace/WorkspaceGate";

import { KingaFindingsPanel } from "@/components/KingaFindingsPanel";
import { KingaTaxPanel } from "@/components/KingaTaxPanel";
import { KingaComparativePanel } from "@/components/KingaComparativePanel";
import { TransferPricingPanel } from "@/components/TransferPricingPanel";
import { CapitalAllowancesRegister } from "@/components/CapitalAllowancesRegister";
import { ThinCapWorkpaper } from "@/components/ThinCapWorkpaper";
import { AddBacksWorkpaper } from "@/components/AddBacksWorkpaper";
import { AdjustingJournalPanel } from "@/components/AdjustingJournalPanel";
import type { TaxResultForExport } from "@/components/ExportStatements";
import type { WorkspaceUpload } from "@/hooks/useWorkspaceData";

// ── deriveFiscalPeriod ──────────────────────────────────────────────────────
function deriveFiscalPeriod(upload: WorkspaceUpload, fiscalYearEnd: string | null) {
  if (upload.period_year && upload.period_year > 2000) {
    const fyeStr = upload.fiscal_year_end ?? fiscalYearEnd;
    const month = fyeStr ? new Date(fyeStr).getMonth() + 1 : 12;
    return { periodYear: upload.period_year, periodEndMonth: isNaN(month) ? 12 : month };
  }
  if (upload.fiscal_year_end) {
    const d = new Date(upload.fiscal_year_end);
    if (!isNaN(d.getTime())) return { periodYear: d.getFullYear(), periodEndMonth: d.getMonth() + 1 };
  }
  if (fiscalYearEnd) {
    const d = new Date(fiscalYearEnd);
    if (!isNaN(d.getTime())) return { periodYear: d.getFullYear(), periodEndMonth: d.getMonth() + 1 };
  }
  const uploadDate = new Date(upload.uploaded_at);
  const uploadMonth = uploadDate.getMonth() + 1;
  const uploadYear = uploadDate.getFullYear();
  return { periodYear: uploadMonth <= 9 ? uploadYear - 1 : uploadYear, periodEndMonth: 12 };
}

// ── Sub-nav tabs ─────────────────────────────────────────────────────────────
const TABS = [
  { id: "compliance",  label: "Compliance Analysis" },
  { id: "tax",         label: "Corporate Tax" },
  { id: "comparative", label: "Comparative" },
  { id: "workpapers",  label: "Workpapers" },
  { id: "aje",         label: "Adjusting Entries" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function KingaWorkspace() {
  const { upload, company, workspaceState, companyId, periodYear } = useWorkspace();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<TabId>("compliance");
  const [taxResult, setTaxResult] = useState<TaxResultForExport | null>(null);

  const mission = workspaceState.missions.kinga;

  if (mission.status === "locked") {
    return (
      <WorkspaceGate
        mission="KINGA"
        blocker={mission.blocker ?? "Complete prerequisites first"}
        prerequisiteHref={workspaceState.missions.safisha.status !== "passed"
          ? workspaceState.missions.safisha.href
          : workspaceState.missions.hesabu.href}
        prerequisiteLabel={workspaceState.missions.safisha.status !== "passed"
          ? "Go to SAFISHA"
          : "Go to HESABU"}
      />
    );
  }

  if (!upload || !upload.company_id || upload.status !== "complete" || upload.is_valid !== true) {
    return (
      <WorkspaceGate
        mission="KINGA"
        blocker="Valid processed trial balance required"
        prerequisiteHref={`/workspace/${companyId}/${periodYear}/safisha`}
        prerequisiteLabel="Go to SAFISHA"
      />
    );
  }

  const { periodYear: fpYear, periodEndMonth: fpMonth } = deriveFiscalPeriod(
    upload,
    company?.fiscal_year_end ?? null,
  );

  return (
    <div className="space-y-0 max-w-5xl">
      {/* Sub-navigation */}
      <div className="border-b border-border mb-6">
        <div className="flex gap-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={[
                "px-4 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap",
                activeTab === tab.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
              ].join(" ")}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "compliance" && (
        <KingaFindingsPanel
          companyId={upload.company_id}
          uploadId={upload.id}
          periodYear={fpYear}
          periodMonth={fpMonth}
          companyName={upload.company_name ?? undefined}
          userId={user?.id ?? ""}
        />
      )}

      {activeTab === "tax" && (
        <KingaTaxPanel
          companyId={upload.company_id}
          uploadId={upload.id}
          periodYear={fpYear}
          periodEndMonth={fpMonth}
          companyName={upload.company_name ?? undefined}
          companyTin={company?.tin ?? undefined}
          userId={user?.id ?? ""}
          onResultChange={setTaxResult}
        />
      )}

      {activeTab === "comparative" && (
        <KingaComparativePanel companyId={upload.company_id} />
      )}

      {activeTab === "workpapers" && (
        <div className="space-y-6">
          <TransferPricingPanel
            companyId={upload.company_id}
            uploadId={upload.id}
            periodYear={fpYear}
            companyName={upload.company_name ?? undefined}
            userId={user?.id ?? ""}
          />
          <CapitalAllowancesRegister
            companyId={upload.company_id}
            uploadId={upload.id}
            periodYear={fpYear}
            companyName={upload.company_name ?? undefined}
            userId={user?.id ?? ""}
          />
          <ThinCapWorkpaper
            companyId={upload.company_id}
            uploadId={upload.id}
            periodYear={fpYear}
            companyName={upload.company_name ?? undefined}
          />
          <AddBacksWorkpaper
            companyId={upload.company_id}
            uploadId={upload.id}
            periodYear={fpYear}
            companyName={upload.company_name ?? undefined}
            userId={user?.id ?? ""}
          />
        </div>
      )}

      {activeTab === "aje" && (
        <AdjustingJournalPanel
          companyId={upload.company_id}
          uploadId={upload.id}
          periodYear={fpYear}
          companyName={upload.company_name ?? undefined}
          userId={user?.id ?? ""}
        />
      )}
    </div>
  );
}
