/**
 * Tanzania jurisdiction pack. Loaded ONLY through src/lib/jurisdiction/packLoader.ts, and only when `TZ` was explicitly
 * selected as the workspace's filing jurisdiction. It supplies statutory panels and terminology; it supplies no global default.
 */
import type { ComponentType } from "react";
import type { JurisdictionPack, PackPanelProps } from "@/lib/jurisdiction/packTypes";
import { KingaTaxPanel } from "./KingaTaxPanel";
import { TransferPricingPanel } from "./TransferPricingPanel";
import { ThinCapWorkpaper } from "./ThinCapWorkpaper";
import { AddBacksWorkpaper } from "./AddBacksWorkpaper";
import { KingaFindingsPanel } from "./KingaFindingsPanel";
import { TRAAuditReadinessPanel } from "./TRAAuditReadinessPanel";
import { EFDMSReconciliationPanel } from "./EFDMSReconciliationPanel";
import { TRAFilingChecklist } from "./TRAFilingChecklist";
import { PaymentLedgerPanel } from "./PaymentLedgerPanel";
import { KingaComparativePanel } from "./KingaComparativePanel";
import { CapitalAllowancesRegister } from "./CapitalAllowancesRegister";
import { ClientSummaryPanel } from "./ClientSummaryPanel";
import { FilingCalendarPanel } from "./FilingCalendarPanel";

const tax: ComponentType<PackPanelProps> = (p) => (
  <KingaTaxPanel companyId={p.companyId} uploadId={p.uploadId} periodYear={p.periodYear} periodEndMonth={p.periodEndMonth ?? 12} companyName={p.companyName} companyTin={p.companyTin} userId={p.userId} onResultChange={p.onResultChange as never} />
);
const transferPricing: ComponentType<PackPanelProps> = (p) => <TransferPricingPanel companyId={p.companyId} uploadId={p.uploadId} periodYear={p.periodYear} companyName={p.companyName} userId={p.userId} />;
const thinCap: ComponentType<PackPanelProps> = (p) => <ThinCapWorkpaper companyId={p.companyId} uploadId={p.uploadId} periodYear={p.periodYear} companyName={p.companyName} />;
const addBacks: ComponentType<PackPanelProps> = (p) => <AddBacksWorkpaper companyId={p.companyId} uploadId={p.uploadId} periodYear={p.periodYear} companyName={p.companyName} userId={p.userId} />;
const findings: ComponentType<PackPanelProps> = (p) => <KingaFindingsPanel companyId={p.companyId} uploadId={p.uploadId} periodYear={p.periodYear} periodMonth={p.periodMonth ?? 12} companyName={p.companyName} userId={p.userId} />;
const auditReadiness: ComponentType<PackPanelProps> = (p) => <TRAAuditReadinessPanel companyId={p.companyId} uploadId={p.uploadId} periodYear={p.periodYear} periodMonth={p.periodMonth ?? 12} companyName={p.companyName} userId={p.userId} />;
const reconciliation: ComponentType<PackPanelProps> = (p) => <EFDMSReconciliationPanel companyId={p.companyId} uploadId={p.uploadId} periodYear={p.periodYear} periodMonth={p.periodMonth ?? 12} companyName={p.companyName} userId={p.userId} isVatRegistered={true} />;
const filingChecklist: ComponentType<PackPanelProps> = (p) => <TRAFilingChecklist uploadId={p.uploadId} companyId={p.companyId} periodYear={p.periodYear} periodMonth={p.periodMonth ?? 12} companyName={p.companyName} jurisdiction="TZ" />;
const paymentLedger: ComponentType<PackPanelProps> = () => <PaymentLedgerPanel />;
const comparative: ComponentType<PackPanelProps> = (p) => <KingaComparativePanel companyId={p.companyId} />;
const capitalAllowances: ComponentType<PackPanelProps> = (p) => <CapitalAllowancesRegister companyId={p.companyId} uploadId={p.uploadId} periodYear={p.periodYear} companyName={p.companyName} userId={p.userId} />;
const clientSummary: ComponentType<PackPanelProps> = (p) => <ClientSummaryPanel companyId={p.companyId} uploadId={p.uploadId} periodYear={p.periodYear} companyName={p.companyName} userId={p.userId} />;
const filingCalendar: ComponentType<PackPanelProps> = () => <FilingCalendarPanel />;

const pack: JurisdictionPack = {
  code: "TZ",
  panels: { taxComputation: tax, transferPricing, thinCap, addBacks, findings, auditReadiness, reconciliation, filingChecklist, paymentLedger, comparative, capitalAllowances, clientSummary, filingCalendar },
};

export default pack;
