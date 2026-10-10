// reporting/sealedPack.ts — everything a pack prints about WHO and WHICH STANDARD comes from the saved version. Pure.
//
// A signed report's entity name, framework and edition are read from its stored document, never from the workspace's
// current settings: renaming the company, changing its framework or electing another edition later cannot change a
// historical export. New versions record the edition (framework.version = the composition's pack id) when they are
// saved. A version saved before that carries no edition; its edition is the one the standard's own rule gives for the
// document's period start (third edition mandatory from 2027-01-01) — the same label those versions were exported with.

import type { CanonicalFinancialStatementReport } from "@/lib/canonicalStatement/types";
import type { PackAdjustmentDisclosure, PackInput } from "@/lib/exports/reportPack";
import { packSignOffFor, type BindingRow } from "./packSignOff";

export const EDITION_TITLES: Readonly<Record<string, string>> = {
  "ifrs-for-smes/2015": "IFRS for SMEs (2015 edition)",
  "ifrs-for-smes/2025": "IFRS for SMEs Accounting Standard (third edition, 2025)",
};
const FRAMEWORK_TITLES: Readonly<Record<string, string>> = { IFRS: "IFRS", IPSAS_ACCRUAL: "IPSAS (accrual basis)", IPSAS_CASH: "IPSAS (cash basis)" };

/** The edition the document was saved under; for a document without one, the edition its period start requires. */
export function sealedEditionTitle(doc: Pick<CanonicalFinancialStatementReport, "framework" | "period">): string {
  if (doc.framework.kind !== "IFRS_FOR_SMES") return FRAMEWORK_TITLES[doc.framework.kind] ?? doc.framework.kind;
  const recorded = doc.framework.version ? EDITION_TITLES[doc.framework.version] : undefined;
  if (recorded) return recorded;
  return doc.period.startDate >= "2027-01-01" ? EDITION_TITLES["ifrs-for-smes/2025"] : EDITION_TITLES["ifrs-for-smes/2015"];
}

/** The pack input for one saved version: identity and edition from the document, sign-off from its bindings. */
export function sealedPackInput(p: {
  readonly document: PackInput["document"];
  readonly versionState: string;
  readonly bindings: readonly BindingRow[];
  readonly soloOwnerEvent: { readonly reason: string; readonly setAt: string } | null;
  readonly adjustments: readonly PackAdjustmentDisclosure[];
}): PackInput {
  return {
    document: p.document,
    entityName: p.document.entity.legalName,
    editionTitle: sealedEditionTitle(p.document),
    adjustments: p.adjustments,
    signOff: packSignOffFor(p.versionState, p.bindings, p.soloOwnerEvent),
  };
}
