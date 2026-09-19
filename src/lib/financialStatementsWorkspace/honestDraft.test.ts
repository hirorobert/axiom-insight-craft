/**
 * Honest-draft regression tests. While persistence is disabled the workspace is
 * an internal preview: every surface must say so, reviewer actions must say
 * "Session only", nothing may imply database persistence, and no approval or
 * final status may exist.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const hookState = vi.hoisted(() => ({ model: null as unknown }));
vi.mock("@/hooks/useFinancialStatementsWorkspace", () => ({ useFinancialStatementsWorkspace: () => hookState.model }));

import { ReviewStage, PersistenceBanner } from "@/components/financialStatements/NotesValidateReview";
import { OutputsStage, PRINT_CSS } from "@/components/financialStatements/OutputsStage";
import { FinancialStatementsWorkspace } from "@/components/financialStatements/FinancialStatementsWorkspace";
import type { FinancialStatementsWorkspaceModel } from "@/hooks/useFinancialStatementsWorkspace";
import { evaluateReport, prepareTrialBalanceReport } from "./evaluationOrchestrator";
import { InMemoryFinancialStatementReportRepository } from "./reportRepository";
import { buildFindingViews } from "./findingsView";
import { FRAMEWORK_PROFILES } from "./frameworkProfiles";
import { composeStatements } from "./statementComposition";
import { buildStructure } from "./structureModel";
import { deriveNoteNumbering } from "./noteNumbering";
import { buildSources } from "./sourcesModel";
import { resolveComparativeSource } from "./comparativeSource";
import type { ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";
import { FINANCIAL_STATEMENT_PERSISTENCE_ENABLED } from "./persistenceGate";

const ROOT = path.join(__dirname, "../../../");
const base = { currency: "TZS", scale: 2, periodId: "CURRENT", isComparative: false, isCashAccount: null, isRetainedEarnings: null, isPayrollAccount: null, sourceUploadId: "u", sourceHash: "9".repeat(64) };
const lines: ReviewedTrialBalanceAccountLine[] = [
  { ...base, accountKey: "1", accountName: "Cash", statement: "balance_sheet", classification: "current_assets", normalBalance: "debit", balance: 100 },
  { ...base, accountKey: "2", accountName: "Payables", statement: "balance_sheet", classification: "current_liabilities", normalBalance: "credit", balance: 30 },
  { ...base, accountKey: "3", accountName: "Capital", statement: "balance_sheet", classification: "equity", normalBalance: "credit", balance: 50 },
];

async function makeModel(): Promise<FinancialStatementsWorkspaceModel> {
  const repo = new InMemoryFinancialStatementReportRepository();
  const { snapshot } = await prepareTrialBalanceReport({ companyId: "c", periodYear: 2025, entityLegalName: "Acme Ltd", framework: "full_ifrs", currency: "TZS", currentPeriod: { startDate: "2025-01-01", endDate: "2025-12-31" }, reviewedAccountLines: lines }, repo);
  const evaluation = await evaluateReport(snapshot, repo);
  const profile = FRAMEWORK_PROFILES.IFRS;
  const composition = composeStatements({ profile, report: snapshot.report, comparativeAvailable: false, cashPerimeterReviewed: false });
  const structure = buildStructure({ profile, rawFramework: "full_ifrs", currency: "TZS", periodYear: 2025, period: { startDate: "2025-01-01", endDate: "2025-12-31", basis: "FISCAL_YEAR_END" }, comparativePeriodYear: 2024, comparativeAvailable: false, composition, mapping: { totalAccounts: 3, unmapped: [], ambiguous: [] } });
  return {
    status: "ready",
    reason: null,
    diagnostics: [],
    profile,
    sources: buildSources({ currentUpload: null, periodYear: 2025, comparative: resolveComparativeSource([], "c", 2025), documentReviewEnabled: false }),
    structure,
    composition,
    snapshot,
    evaluation,
    numbering: deriveNoteNumbering(snapshot.report),
    views: buildFindingViews(evaluation.findings, snapshot.decisions),
    persistence: "UNAVAILABLE",
    notice: null,
    decide: async () => ({ ok: true as const }),
    rerun: () => undefined,
    evidence: [],
    applied: null,
    addEvidence: () => ({ kind: "REJECTED" as const, diagnostics: [] }),
    removeUnsavedEvidence: () => undefined,
    saveStatus: "DISABLED" as const,
    saveMessage: null,
    access: null,
    storedVersion: null,
    save: async () => undefined,
    publication: null,
    setPublication: async () => ({ ok: false, message: "" }),
    correctEvidence: () => ({ ok: false as const, message: "", diagnostics: [] }),
    restore: { status: "IDLE" as const, message: null },
    versions: [],
    viewing: null,
    readOnly: false,
    openVersion: async () => ({ ok: false, message: "" }),
    closeVersion: () => undefined,
    reloadFromServer: () => undefined,
    readiness: null,
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("honest draft — persistence is disabled in source", () => {
  it("the persistence gate is off, so every claim below is true by construction", () => {
    expect(FINANCIAL_STATEMENT_PERSISTENCE_ENABLED).toBe(false);
  });
});

describe("honest draft — workspace header", () => {
  it('labels the workspace "Internal preview — unsaved draft"', async () => {
    hookState.model = await makeModel();
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(FinancialStatementsWorkspace, { companyId: "c", periodYear: 2025, companyName: "Acme Ltd", companyTin: null, reportingFramework: "full_ifrs", currency: "TZS", fiscalYearEnd: null, currentUpload: null, uploads: [] })));
    expect(text(html)).toContain("Internal preview — unsaved draft");
    expect(text(html)).not.toMatch(/Draft — not saved/);
  });
});

describe("honest draft — reviewer corrections and decisions are session-only", () => {
  it("says Session only, states the reload-loss BEFORE the submit control, and describes a correction as an in-memory transition", async () => {
    const model = await makeModel();
    const html = renderToStaticMarkup(createElement(ReviewStage, { model, onFocusLine: () => undefined }));
    const t = text(html);
    expect(t).toContain("Session only — saving is not available");
    expect(t).toContain("Nothing is written to any database");
    expect(t).toContain("reloading or leaving this page discards them");
    expect(t).toContain("Correction history (session only)");
    expect(t).toContain("in-memory draft");
    expect(t).toContain("not a database transaction and it is not saved");
    expect(t).toContain("Record decision (session only)");
    // The reload-loss disclosure appears before the submit button in every decision form.
    const forms = html.split("<form").slice(1);
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      const noticeAt = form.indexOf("Session only: this decision is held in this browser session and is lost if you reload or leave the page");
      const submitAt = form.indexOf('type="submit"');
      expect(noticeAt).toBeGreaterThan(-1);
      expect(noticeAt).toBeLessThan(submitAt);
    }
  });

  it('the banner can never say "Saved", whatever state a caller passes, while persistence is disabled', () => {
    for (const state of ["PERSISTED", "UNSAVED_DRAFT", "UNAVAILABLE"] as const) {
      const t = text(renderToStaticMarkup(createElement(PersistenceBanner, { state })));
      expect(t, state).toMatch(/Session only/);
      expect(t, state).not.toMatch(/\bSaved\b|are stored|is stored|written to the database/);
    }
    expect(renderToStaticMarkup(createElement(PersistenceBanner, { state: "PERSISTED" }))).toContain('data-persistence-state="UNAVAILABLE"');
  });
});

describe("honest draft — final outputs are draft-only; no approval or final status exists", () => {
  it("stamps DRAFT, watermarks the print, and offers no approval, sign-off, issue or final state", async () => {
    const model = await makeModel();
    const html = renderToStaticMarkup(createElement(OutputsStage, { model }));
    const t = text(html);
    expect(t).toContain("Draft — not reviewed or approved");
    expect(t).toContain("Everything below is a draft");
    expect(PRINT_CSS).toMatch(/content: "DRAFT"/);
    expect(t).not.toMatch(/\b(Approved by|Approved on|Signed off|Final version|Final statements|Issued|Authorised for issue|Status: (Final|Approved))\b/i);
    expect(html).not.toContain("signature-blocks"); // only when explicitly configured
    expect(t).toContain("Not available — no reliable DOCX generator exists yet");
  });

  it("signature placeholders appear only when explicitly configured, and still carry the draft stamp", async () => {
    const model = await makeModel();
    const html = renderToStaticMarkup(createElement(OutputsStage, { model, signatureBlocks: ["Director"] }));
    expect(html).toContain("signature-blocks");
    expect(text(html)).toContain("Draft — not reviewed or approved");
  });

  it("a Reviewed/Final state exists only as a SERVER-recorded publication state: no source defines an approval, sign-off or issue status, and the two modules that name a state cannot show one while saving is disabled", async () => {
    const dir = path.join(ROOT, "src/components/financialStatements");
    const files = fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
    const mayNameFinal = new Set(["EvidenceUi.tsx", "OutputsStage.tsx"]);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/["'`](APPROVED|ISSUED|SIGNED_OFF|SIGNED-OFF)["'`]/);
      if (!mayNameFinal.has(f)) expect(src, f).not.toMatch(/["'`]FINAL["'`]/);
      expect(src, f).not.toMatch(/statement_sign_offs|hesabu_gate_before_signoff/);
    }
    // With saving disabled (persistence gate off) no state control is offered and the stamp is DRAFT whatever a caller passes.
    const model = await makeModel();
    const html = renderToStaticMarkup(createElement(OutputsStage, { model }));
    expect(html).not.toContain("publication-controls");
    const { outputStatus } = await import("./exports");
    expect(outputStatus("FINAL", 1)).toBe("DRAFT"); // blockers always force DRAFT
    expect(outputStatus(null, 0)).toBe("DRAFT"); // a state the server never recorded is never shown
  });
});

describe("honest draft — no wording implies database persistence", () => {
  it("no workspace UI string claims that anything is, was or will be saved/stored/persisted", () => {
    const dir = path.join(ROOT, "src/components/financialStatements");
    const files = fs.readdirSync(dir).filter((f) => /\.tsx$/.test(f));
    const claim = /\b(has been|have been|was|were|is|are|will be|gets|get)\s+(saved|stored|persisted|written|recorded in the database)\b/i;
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const strings = [...src.matchAll(/["'`]([^"'`\n]{8,})["'`]|>\s*([^<>{}\n]{8,})\s*</g)].map((m) => m[1] ?? m[2]);
      for (const s of strings) {
        // The one allowed positive statement is the PERSISTED banner copy, which the banner itself remaps to session-only while persistence is disabled.
        if (s === "This evaluation and its decisions are stored.") continue;
        // Judge sentence by sentence; a negated sentence ("Nothing is written…", "It is not saved…") cannot be an affirmative claim.
        for (const sentence of s.split(/(?<=[.!?])\s+/)) {
          if (/\b(not|nothing|never|cannot|no|discards?|lost)\b/i.test(sentence)) continue;
          expect(sentence, `${f}: ${sentence}`).not.toMatch(claim);
        }
      }
    }
  });
});
