/**
 * Jurisdiction pack contract. A pack is a self-contained set of statutory panels for ONE filing jurisdiction. Global code
 * depends only on these types and on `packLoader`; it never imports a pack's modules.
 */
import type { ComponentType } from "react";

export interface PackPanelProps {
  companyId: string;
  uploadId: string;
  periodYear: number;
  periodMonth?: number;
  periodEndMonth?: number;
  companyName?: string;
  companyTin?: string;
  userId: string;
  /** Tax-computation result callback (tax panel only). */
  onResultChange?: (result: unknown) => void;
}

export type PackPanelId =
  | "taxComputation"
  | "transferPricing"
  | "thinCap"
  | "addBacks"
  | "findings"
  | "auditReadiness"
  | "reconciliation"
  | "filingChecklist"
  | "paymentLedger";

export interface JurisdictionPack {
  readonly code: string;
  readonly panels: Partial<Record<PackPanelId, ComponentType<PackPanelProps>>>;
}
