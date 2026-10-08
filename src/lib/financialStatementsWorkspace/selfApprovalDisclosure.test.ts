/**
 * Self-approved adjustments are never hidden (revision 5 C8): the audit export carries a Close Review appendix with an
 * explicit "approved by the preparer" list (both periods), and the sign-off controls show it. Without an authoritative
 * input (legacy route) the export is unchanged.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicationControls } from "@/components/financialStatements/EvidenceUi";
import type { FinancialStatementsWorkspaceModel } from "@/hooks/useFinancialStatementsWorkspace";
import type { CurrentReportingInput } from "./authoritativeInput";
import { auditExport, closeReviewAppendix, type ExportLineage } from "./exports";

const adj = (id: string, number: number, selfApproved: boolean, kind: "adjustment" | "reversal" = "adjustment") =>
  ({ id, number, kind, reverses: null, totalMinor: "1500", reason: `Reason ${number}`, selfApproved, selfRevalidated: false });
const period = { certificationId: "cert-1", uploadId: "upl-1", periodYear: 2025, certifiedAt: "x", periodId: "p", currency: "TZS", exponent: 2, reportingStart: null, reportingEnd: null, accounts: [] };
const INPUT: CurrentReportingInput = {
  state: "current", contract: "fs-reporting-input/1", current: period,
  comparative: { ...period, certificationId: "cert-0", periodYear: 2024, state: "available", adjustments: [adj("p1", 1, true)] },
  adjustments: [adj("a1", 1, false), adj("a2", 2, true), { ...adj("a3", 3, false), selfRevalidated: true }], findings: {}, adjustmentsRequiringRevalidation: 0, inputSha256: "a".repeat(64),
};

describe("audit export — Close Review appendix", () => {
  it("lists the input identity, both periods' certifications, every applied adjustment and, explicitly, the self-approved ones", () => {
    const a = closeReviewAppendix(INPUT);
    expect(a.inputSha256).toBe("a".repeat(64));
    expect(a.current.certificationId).toBe("cert-1");
    expect(a.comparative).toMatchObject({ state: "available", certificationId: "cert-0", periodYear: 2024 });
    expect(a.adjustments.map((x) => x.number)).toEqual([1, 2, 3]);
    expect(a.approvedByThePreparer.map((x) => x.adjustmentId)).toEqual(["a2", "a3", "p1"]);
  });
  it("is part of the audit bundle when the figures came from the authoritative input, and absent otherwise", () => {
    const report = { reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 }, period: { periodYear: 2025 }, entity: { legalName: "Acme" }, framework: { kind: "IFRS" }, provenanceOrigin: "TRIAL_BALANCE_DERIVED", facts: [] } as never;
    const lineage = { reportId: "r", companyId: "c", periodYear: 2025, reportVersion: 1, persisted: true, label: "Version 1", contentHash: "h", evaluation: null, publicationState: null } as ExportLineage;
    const base = { report, lineage, evaluation: null, decisions: [], evidence: [], publication: null, exportedAt: null };
    expect(JSON.parse(auditExport({ ...base, closeReview: INPUT }).content).closeReview.approvedByThePreparer).toHaveLength(3);
    expect(JSON.parse(auditExport(base).content).closeReview).toBeUndefined();
  });
});

describe("sign-off controls — disclosure", () => {
  const model = (ai: CurrentReportingInput | null) => ({ authoritativeInput: ai, saveStatus: "SAVED", viewing: null, publication: null, readiness: null, readOnlyAccess: false, readOnly: false, setPublication: async () => ({ ok: true, message: "" }) }) as unknown as FinancialStatementsWorkspaceModel;
  it("names every self-approved adjustment (both periods)", () => {
    const html = renderToStaticMarkup(createElement(PublicationControls, { model: model(INPUT) }));
    expect(html).toContain("Approved by the preparer");
    expect(html).toContain("Adjustment 2");
    expect(html).toContain("Self-revalidated after a re-check");
    expect(html).toContain("Reason 1");
  });
  it("says so plainly when there are none; nothing is shown on the legacy route", () => {
    const none = renderToStaticMarkup(createElement(PublicationControls, { model: model({ ...INPUT, adjustments: [adj("a1", 1, false)], comparative: { state: "missing", periodYear: 2024 } }) }));
    expect(none).toContain("No adjustment in these figures was approved by its own preparer.");
    expect(renderToStaticMarkup(createElement(PublicationControls, { model: model(null) }))).not.toContain("self-approval-disclosure");
  });
});
