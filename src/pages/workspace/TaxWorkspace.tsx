/**
 * TaxWorkspace — Corporate Tax Computation (ITA Cap.332).
 *
 * Re-homes from Dashboard:
 *   KingaTaxPanel, KingaComparativePanel,
 *   TransferPricingPanel, CapitalAllowancesRegister,
 *   ThinCapWorkpaper, AddBacksWorkpaper
 *
 * Sub-navigation (tabs):
 *   Corporate Tax · Comparative · Workpapers
 *
 * KingaFindingsPanel moved to ComplianceWorkspace (Phase C) — matches
 * Architecture v3.1's stage-5 "KINGA findings" engine assignment.
 * AdjustingJournalPanel moved to ReconcileWorkspace (Phase C).
 *
 * Constitutional gate: prepare stage must be 'passed'.
 */

import { useState } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { WorkspaceGate } from "@/components/workspace/WorkspaceGate";

import { JurisdictionGate, JurisdictionPanel } from "@/components/jurisdiction/JurisdictionPanel";
import { useEngagement } from "@/contexts/EngagementContext";
import { serviceAvailability } from "@/lib/jurisdiction/registry";
import { KingaComparativePanel } from "@/components/KingaComparativePanel";
import { CapitalAllowancesRegister } from "@/components/CapitalAllowancesRegister";
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
  { id: "tax",         label: "Corporate Tax" },
  { id: "comparative", label: "Comparative" },
  { id: "workpapers",  label: "Workpapers" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function TaxWorkspace() {
  const { upload, company, workspaceState, companyId, periodYear } = useWorkspace();
  const { user } = useAuth();
  const { canAmend } = useEngagement();
  const jurisdiction = company?.filing_jurisdiction ?? null;
  const [activeTab, setActiveTab] = useState<TabId>("tax");
  const [taxResult, setTaxResult] = useState<TaxResultForExport | null>(null);

  const mission = workspaceState.missions.tax;

  // Tax computation is unavailable until a filing jurisdiction is selected — and only for one that ships a pack.
  if (!serviceAvailability("TAX_COMPUTATION", jurisdiction).available) {
    return <JurisdictionGate capability="TAX_COMPUTATION" jurisdiction={jurisdiction} companyId={companyId} canChange={canAmend} />;
  }

  if (mission.status === "locked") {
    return (
      <WorkspaceGate
        mission="Compute Tax"
        blocker={mission.blocker ?? "Complete prerequisites first"}
        prerequisiteHref={workspaceState.missions.prepare.status !== "passed"
          ? workspaceState.missions.prepare.href
          : workspaceState.missions.statements.href}
        prerequisiteLabel={workspaceState.missions.prepare.status !== "passed"
          ? "Go to Prepare Data"
          : "Go to Prepare Statements"}
      />
    );
  }

  if (!upload || !upload.company_id || upload.status !== "complete" || upload.is_valid !== true) {
    return (
      <WorkspaceGate
        mission="Compute Tax"
        blocker="Valid processed trial balance required"
        prerequisiteHref={`/workspace/${companyId}/${periodYear}/prepare`}
        prerequisiteLabel="Go to Prepare Data"
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
      {activeTab === "tax" && (
        <JurisdictionPanel
          jurisdiction={jurisdiction}
          panel="taxComputation"
          companyId={upload.company_id}
          uploadId={upload.id}
          periodYear={fpYear}
          periodEndMonth={fpMonth}
          companyName={upload.company_name ?? undefined}
          companyTin={company?.tin ?? undefined}
          userId={user?.id ?? ""}
          onResultChange={(r) => setTaxResult(r as TaxResultForExport | null)}
        />
      )}

      {activeTab === "comparative" && (
        <KingaComparativePanel companyId={upload.company_id} />
      )}

      {activeTab === "workpapers" && (
        <div className="space-y-6">
          <JurisdictionPanel
            jurisdiction={jurisdiction}
            panel="transferPricing"
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
          <JurisdictionPanel
            jurisdiction={jurisdiction}
            panel="thinCap"
            companyId={upload.company_id}
            uploadId={upload.id}
            periodYear={fpYear}
            companyName={upload.company_name ?? undefined}
            userId={user?.id ?? ""}
          />
          <JurisdictionPanel
            jurisdiction={jurisdiction}
            panel="addBacks"
            companyId={upload.company_id}
            uploadId={upload.id}
            periodYear={fpYear}
            companyName={upload.company_name ?? undefined}
            userId={user?.id ?? ""}
          />
        </div>
      )}
    </div>
  );
}
