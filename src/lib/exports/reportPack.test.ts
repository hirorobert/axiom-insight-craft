import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildReportPack, type PackInput } from "./reportPack";

const fact = (factId: string, periodId: string, minor: bigint) => ({ factId, version: 1, value: { currency: "TZS", scale: 2, minorUnits: minor },
  reportingPeriod: { periodId, isComparative: periodId !== "CURRENT" }, signConvention: "DEBIT_POSITIVE",
  provenance: { source: { sourceDocumentId: "c", sourceHash: "a".repeat(64), artifactKind: "TRIAL_BALANCE" }, locator: { kind: "MANUAL", note: "x" }, extractionMethod: "TRIAL_BALANCE_DERIVED", extractionConfidence: { kind: "CERTAIN" }, originalText: "x" }, supersedesVersion: null });
const document = {
  schemaVersion: "1.0.0", reportIdentity: { reportId: "r", companyId: "c", reportVersion: 3 }, entity: { legalName: "Synthetic SME" },
  period: { periodId: "CURRENT", startDate: "2026-01-01", endDate: "2026-12-31", periodYear: 2026 },
  comparativePeriods: [{ periodId: "COMPARATIVE_1", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025, isRestated: false }],
  framework: { kind: "IFRS_FOR_SMES" }, presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
  statements: [{ statementId: "stmt:sfp", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "Statement of Financial Position", sections: [{ sectionId: "s", label: "Non-current assets", lines: [
    { lineId: "l1", label: "Property, plant and equipment", concept: "sfp.ppe", role: "DETAIL", normalBalance: "DEBIT_NORMAL", isContra: false, castingChildLineIds: [],
      factBindings: [{ periodId: "CURRENT", factId: "f:c" }, { periodId: "COMPARATIVE_1", factId: "f:p" }] },
    { lineId: "l2", label: "Investment property", concept: "sfp.ip", role: "DETAIL", normalBalance: "DEBIT_NORMAL", isContra: false, castingChildLineIds: [],
      factBindings: [{ periodId: "CURRENT", factId: "f:zero" }] },
  ] }] }],
  notes: [], noteReferences: [], accountingPolicies: [],
  textualDisclosures: [{ disclosureId: "smes.note.policies", text: "Historical cost.\n<script>alert(1)</script> & depreciation" }],
  facts: [fact("f:c", "CURRENT", 1400000n), fact("f:p", "COMPARATIVE_1", 1600000n), fact("f:zero", "CURRENT", 0n)],
  provenanceOrigin: "TRIAL_BALANCE_DERIVED", reportingDependencies: { dependenciesSha256: "d".repeat(64) },
} as unknown as PackInput["document"];
const base: PackInput = { document, entityName: "Synthetic SME Limited", editionTitle: "IFRS for SMEs (2015 edition)", signOff: null,
  adjustments: [{ number: 1, reason: "Rent accrual", totalMinor: "30000", selfApproved: false, selfRevalidated: false },
    { number: 2, reason: "Owner's accrual", totalMinor: "700", selfApproved: true, selfRevalidated: false },
    { number: 3, reason: "Carried forward", totalMinor: "500", selfApproved: false, selfRevalidated: true }] };
const FINAL = { state: "FINAL" as const, signedAt: "2027-03-01T10:00:00Z", signedBy: "Owner", contentHash: "c".repeat(64), dependenciesSha256: "d".repeat(64) };

describe("report pack: one rendering for draft and final", () => {
  it("draft and final differ ONLY in the banner/seal; the body is byte-identical", () => {
    const draft = buildReportPack(base);
    const fin = buildReportPack({ ...base, signOff: FINAL });
    expect(fin.body).toBe(draft.body);
    expect(draft.html).toContain("DRAFT — not signed off");
    expect(draft.html).toContain('content:"DRAFT"');
    expect(fin.html).toContain(`FINAL — signed off by Owner on 2027-03-01T10:00:00Z. Content SHA-256 ${"c".repeat(64)}; reporting dependencies SHA-256 ${"d".repeat(64)}.`);
    expect(fin.html).not.toContain('content:"DRAFT"');
    expect(buildReportPack({ ...base, signOff: { ...FINAL, state: "REVIEWED" } }).html).toContain('content:"REVIEWED"');
  });
  it("the same version renders the same bytes", () => {
    expect(buildReportPack(base).html).toBe(buildReportPack(base).html);
    expect(buildReportPack(base).csv).toBe(buildReportPack(base).csv);
  });
  it("figures are the document's own facts: amounts, zero as 0.00, a period without a fact as —", () => {
    const p = buildReportPack(base);
    expect(p.csv.split("\n")).toEqual([
      "Statement,Section,Line,2026,2025",
      'Statement of Financial Position,Non-current assets,"Property, plant and equipment","14,000.00","16,000.00"',
      "Statement of Financial Position,Non-current assets,Investment property,0.00,—",
      "",
    ]);
  });
  it("preparer wording is escaped, never interpreted; line breaks are kept", () => {
    const p = buildReportPack(base);
    expect(p.html).not.toContain("<script>");
    expect(p.html).toContain("Historical cost.<br>&lt;script&gt;alert(1)&lt;/script&gt; &amp; depreciation");
  });
  it("self-approved and self-revalidated adjustments are disclosed; others are not listed", () => {
    const p = buildReportPack(base);
    expect(p.body).toContain("Adjustment 2 (7.00): self-approved — Owner&#39;s accrual");
    expect(p.body).toContain("Adjustment 3 (5.00): self-revalidated — Carried forward");
    expect(p.body).not.toContain("Adjustment 1");
    expect(buildReportPack({ ...base, adjustments: [] }).body).toContain("No adjustment was approved or revalidated by its own proposer.");
  });
  it("prints as A4 with repeating table headers", () => {
    expect(buildReportPack(base).html).toMatch(/@page\{size:A4;margin:18mm\}.*thead\{display:table-header-group\}/);
  });
  it("the module computes no figure and reaches no withheld service", () => {
    const src = fs.readFileSync(path.join(__dirname, "reportPack.ts"), "utf8");
    expect(src).not.toMatch(/sumMoney|addMoney|\+ BigInt|kinga|generate-xbrl|generate-disclosure-notes/i);
  });
});
