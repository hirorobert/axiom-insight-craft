/**
 * MonitorWorkspace — Portfolio Intelligence & Filing Calendar.
 *
 * Re-homes from Dashboard:
 *   MaonoDashboard, ComplianceScorecard, FirmDashboardPanel,
 *   FilingCalendarPanel, PaymentLedgerPanel
 *
 * Always available — no lock gate.
 */

import { useWorkspace } from "@/contexts/WorkspaceContext";
import { MaonoDashboard } from "@/components/maono/MaonoDashboard";
import { ComplianceScorecard } from "@/components/ComplianceScorecard";
import { FirmDashboardPanel } from "@/components/FirmDashboardPanel";
import { FilingCalendarPanel } from "@/components/FilingCalendarPanel";
import { PaymentLedgerPanel } from "@/components/PaymentLedgerPanel";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export default function MonitorWorkspace() {
  const { upload } = useWorkspace();

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Maono — only when upload has mapping data */}
      {upload?.status === "complete" && upload.is_valid === true && upload.company_id && (
        <MaonoDashboard
          companyId={upload.company_id}
          userRole="accountant"
          supabaseUrl={SUPABASE_URL}
          supabaseAnonKey={SUPABASE_ANON_KEY}
        />
      )}

      {/* Compliance Scorecard — all-company view */}
      <ComplianceScorecard />

      {/* Filing Calendar — multi-company deadline view */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <FilingCalendarPanel />
        <PaymentLedgerPanel />
      </div>

      {/* Firm Dashboard — partner-level overview */}
      <FirmDashboardPanel />
    </div>
  );
}
