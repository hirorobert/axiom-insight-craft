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
import { EvidencePanel, PublicationControls, SaveBar } from "@/components/financialStatements/EvidenceUi";
import { FsRpcTransport } from "./rpcTransport";
import { ZERO_TOLERANCE } from "@/lib/canonicalStatement/money";
import { auditExport, buildLineage, canonicalJsonExport, checklistCsv, evidenceExport, findingsCsv, lineageTag, outputReportFor, UNSAVED_DRAFT_LABEL, versionLabelOf } from "./exports";
import { evaluateReport, evaluateReportPure, prepareTrialBalanceReport } from "./evaluationOrchestrator";
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
    checklist: [],
    evidenceIndex: {},
    cashPerimeter: null,
    budgetComparison: null,
    persistedVersion: null,
    versionLabel: "Unsaved draft",
    output: { report: outputReportFor(snapshot.report, null), evaluation: evaluateReportPure(snapshot.report, ZERO_TOLERANCE, () => "1970-01-01T00:00:00.000Z"), lineage: buildLineage({ report: outputReportFor(snapshot.report, null), persistedVersion: null, evaluation: evaluateReportPure(snapshot.report, ZERO_TOLERANCE, () => "1970-01-01T00:00:00.000Z"), publicationState: null }) },
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
  it('labels the workspace "Internal preview — Unsaved draft"', async () => {
    hookState.model = await makeModel();
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(FinancialStatementsWorkspace, { companyId: "c", periodYear: 2025, companyName: "Acme Ltd", companyTin: null, reportingFramework: "full_ifrs", currency: "TZS", fiscalYearEnd: null, currentUpload: null, uploads: [] })));
    expect(text(html)).toContain("Internal preview — Unsaved draft");
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
    expect(PRINT_CSS).toContain('content: "DRAFT — NOT CERTIFIED — NOT FOR FILING OR CLIENT ISSUE"');
    expect(t).not.toMatch(/\b(Approved by|Approved on|Signed off|Final version|Final statements|Issued|Authorised for issue|Status: (Final|Approved))\b/i);
    expect(html).not.toContain("signature-blocks"); // only when explicitly configured
    expect(t).toContain("Not available — no reliable DOCX generator exists yet");
  });

  it("every printed page carries the exact draft marking, in the top margin box and as a repeating watermark", () => {
    const mark = "DRAFT — NOT CERTIFIED — NOT FOR FILING OR CLIENT ISSUE";
    expect(PRINT_CSS).toContain(`@page { size: A4 portrait; margin: 15mm; @top-center { content: "${mark}"`);
    expect(PRINT_CSS).toContain(`@page fs-landscape { size: A4 landscape; margin: 15mm; @top-center { content: "${mark}"`);
    expect(PRINT_CSS).toContain(`#fs-print-document::before { content: "${mark}"; position: fixed;`);
  });

  it("Reporting Pack: downloads exist only with a host-supplied deliverer (issue → seal → save); a locked workspace sees the plan explanation, never a file button", async () => {
    const model = await makeModel();
    const bare = renderToStaticMarkup(createElement(OutputsStage, { model }));
    expect(bare).not.toContain('data-testid="export-buttons"');
    const issuer = async () => "delivered" as const;
    const withIssuer = renderToStaticMarkup(createElement(OutputsStage, { model, deliverDownload: issuer }));
    expect(withIssuer).toContain('data-testid="export-buttons"');
    const locked = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(OutputsStage, { model, deliverDownload: issuer, downloadsLocked: true })));
    expect(locked).not.toContain('data-testid="export-buttons"');
    expect(locked).toContain('data-testid="outputs-downloads-locked"');
    expect(text(locked)).toContain("Preview remains available.");
    expect(text(locked)).toContain("Draft — not reviewed or approved"); // the web preview stays available whatever the plan
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

// ── D. persisted version authority: print, JSON, evidence and audit identify the SAME lineage ─────────────────────────
describe("version authority — persisted, unsaved, restored and historical outputs", () => {
  const EPOCH = () => "1970-01-01T00:00:00.000Z";
  const outputFor = async (persistedVersion: number | null, publicationState: "DRAFT" | "REVIEWED" | "FINAL" | null = null) => {
    const model = await makeModel();
    const report = outputReportFor(model.snapshot!.report, persistedVersion);
    const evaluation = evaluateReportPure(persistedVersion === null ? model.snapshot!.report : report, ZERO_TOLERANCE, EPOCH);
    const lineage = buildLineage({ report, persistedVersion, evaluation, publicationState });
    return { model: { ...model, persistedVersion, versionLabel: versionLabelOf(persistedVersion), output: { report, evaluation, lineage } } as FinancialStatementsWorkspaceModel, report, evaluation, lineage };
  };
  const renderOutputs = (model: FinancialStatementsWorkspaceModel) => text(renderToStaticMarkup(createElement(OutputsStage, { model })));
  const files = (o: Awaited<ReturnType<typeof outputFor>>) => {
    const evidence = [] as never[];
    return [
      canonicalJsonExport(o.report, o.lineage),
      evidenceExport(o.report, evidence, o.lineage),
      auditExport({ report: o.report, lineage: o.lineage, evaluation: o.evaluation, decisions: [], evidence, publication: null, exportedAt: null }),
      findingsCsv(o.report, o.evaluation.findings, o.lineage),
      checklistCsv(o.report, [{ areaId: "basis-of-preparation", label: "Basis of preparation", reference: "IAS 1", state: "MISSING" }], o.lineage),
    ];
  };

  it("UNSAVED work says exactly \"Unsaved draft\": in the print header, the file names and the document — never a version counter", async () => {
    const o = await outputFor(null);
    expect(UNSAVED_DRAFT_LABEL).toBe("Unsaved draft");
    const html = renderToStaticMarkup(createElement(OutputsStage, { model: o.model }));
    expect(html).toMatch(/data-testid="print-version">Unsaved draft</);
    expect(text(html)).not.toMatch(/report [0-9a-f]{8} · Version/);
    for (const f of files(o)) {
      expect(f.fileName, f.fileName).toContain("-unsaved-draft.");
      expect(f.fileName).not.toMatch(/-v\d+\./);
    }
    const canonical = JSON.parse(files(o)[0].content);
    expect(canonical.lineage).toMatchObject({ reportVersion: null, persisted: false, label: "Unsaved draft" });
    expect(canonical.report.reportIdentity.reportVersion).toBe(0); // 0 = not persisted; the transient counter is never exported
  });

  it("a historical view shows ITS OWN state, not the working draft's: version 3 (FINAL) beside a latest version with no state, and never the latest version's readiness", async () => {
    const o = await outputFor(3, "FINAL");
    const viewing = { reportVersion: 3, state: "FINAL" } as FinancialStatementsWorkspaceModel["viewing"];
    const model = { ...o.model, saveStatus: "SAVED", viewing, readOnly: true, publication: null, readiness: { ready: true, blockers: [] } } as unknown as FinancialStatementsWorkspaceModel;
    const html = renderToStaticMarkup(createElement(OutputsStage, { model }));
    expect(html).toMatch(/data-testid="publication-state"[^>]*>[^<]*Report state[^<]*(<!-- -->)?\s*(<!-- -->)?of version 3 — FINAL \(read-only\)/);
    expect(html).not.toContain('data-testid="server-readiness"');
    const live = renderToStaticMarkup(createElement(OutputsStage, { model: { ...model, viewing: null, readOnly: false } as FinancialStatementsWorkspaceModel }));
    expect(live).toContain('data-testid="server-readiness"');
    expect(text(live)).toContain("no state recorded");
  });

  it("a PERSISTED version is shown and exported under ITS persisted number, with its own evaluation lineage", async () => {
    const o = await outputFor(7, "REVIEWED");
    const html = renderToStaticMarkup(createElement(OutputsStage, { model: o.model }));
    expect(html).toMatch(/data-testid="print-version">Version 7</);
    expect(text(html)).toContain(`evaluation ${o.evaluation.evaluationRunId.slice(0, 8)}`);
    for (const f of files(o)) expect(f.fileName, f.fileName).toContain("-v7.");
    expect(JSON.parse(files(o)[0].content).report.reportIdentity.reportVersion).toBe(7);
  });

  it("JSON, evidence, audit and CSV outputs all identify the SAME report, version and evaluation", async () => {
    const o = await outputFor(4, "DRAFT");
    const [canonical, evidence, audit, findings, checklist] = files(o);
    const lineageOf = (f: { content: string }) => JSON.parse(f.content).lineage;
    expect(lineageOf(evidence)).toEqual(lineageOf(canonical));
    expect(lineageOf(audit)).toEqual(lineageOf(canonical));
    expect(lineageOf(canonical)).toMatchObject({ reportId: o.report.reportIdentity.reportId, reportVersion: 4, persisted: true, evaluation: { evaluationRunId: o.evaluation.evaluationRunId, inputHash: o.evaluation.inputHash } });
    expect(JSON.parse(audit.content).report).toMatchObject({ reportVersion: 4, versionLabel: "Version 4", contentHash: lineageOf(canonical).contentHash });
    for (const csv of [findings, checklist]) expect(csv.content).toContain(lineageTag(o.lineage));
    expect(new Set([canonical, evidence, audit, findings, checklist].map((f) => f.fileName.replace(/\.[a-z-]+\.(json|csv)$/, ""))).size).toBe(1);
  });

  it("the content hash in the lineage is the hash of the exported document, so a stored version and its export agree", async () => {
    const o = await outputFor(3);
    expect(o.lineage.contentHash).toBe(JSON.parse(files(o)[0].content).lineage.contentHash);
    expect((await outputFor(3)).lineage.contentHash).toBe(o.lineage.contentHash); // deterministic
    expect((await outputFor(4)).lineage.contentHash).not.toBe(o.lineage.contentHash); // the version is part of the identity
  });

  it("RESTORED and HISTORICAL outputs carry their own persisted version, never the session's", async () => {
    const restored = await outputFor(5);
    const historical = await outputFor(2, "FINAL");
    expect(renderOutputs(restored.model)).toContain("Version 5");
    const h = renderOutputs(historical.model);
    expect(h).toContain("Version 2");
    expect(h).not.toContain("Version 5");
    expect(historical.lineage.publicationState).toBe("FINAL");
  });

  it("the workspace header uses the same label", async () => {
    const o = await outputFor(9);
    hookState.model = o.model;
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(FinancialStatementsWorkspace, { companyId: "c", periodYear: 2025, companyName: "Acme Ltd", companyTin: null, reportingFramework: "full_ifrs", currency: "TZS", fiscalYearEnd: null, currentUpload: null, uploads: [] })));
    expect(text(html)).toContain("Internal preview — Version 9");
  });
});

describe("viewer / read-only access — no mutating control is offered, and the server still refuses", () => {
  const viewerOf = async (over: Record<string, unknown> = {}) => ({ ...(await makeModel()), saveStatus: "UNSAVED", readOnly: true, readOnlyAccess: true, publication: null, readiness: { ready: true, blockers: [] }, ...over }) as unknown as FinancialStatementsWorkspaceModel;
  const editorOf = async (over: Record<string, unknown> = {}) => ({ ...(await makeModel()), saveStatus: "UNSAVED", readOnly: false, readOnlyAccess: false, publication: null, readiness: { ready: true, blockers: [] }, ...over }) as unknown as FinancialStatementsWorkspaceModel;

  it("the save bar explains \"Read-only access\" and offers no Save, even with unsaved changes", async () => {
    const viewer = renderToStaticMarkup(createElement(SaveBar, { model: await viewerOf() }));
    expect(viewer).toContain('data-testid="read-only-access"');
    expect(text(viewer)).toContain("Read-only access");
    expect(text(viewer)).toContain("Your role is viewer");
    expect(viewer).not.toContain('data-testid="save-button"');
    const editor = renderToStaticMarkup(createElement(SaveBar, { model: await editorOf() }));
    expect(editor).toContain('data-testid="save-button"');
    expect(editor).not.toContain("read-only-access");
  });

  it("evidence cannot be added: every field and the Add button sit in a disabled fieldset for a viewer, and not for an editor", async () => {
    const viewer = renderToStaticMarkup(createElement(EvidencePanel, { model: await viewerOf() }));
    expect(viewer).toMatch(/<fieldset disabled="" class="contents" data-testid="evidence-form-fields">/);
    const editor = renderToStaticMarkup(createElement(EvidencePanel, { model: await editorOf() }));
    expect(editor).toMatch(/<fieldset class="contents" data-testid="evidence-form-fields">/);
  });

  it("Reviewed / Final / Draft, and their reason field, are disabled and explained for a viewer; an authorised editor keeps an enabled reason field", async () => {
    const viewer = renderToStaticMarkup(createElement(PublicationControls, { model: await viewerOf({ saveStatus: "SAVED" }) }));
    for (const s of ["draft", "reviewed", "final"]) expect(viewer).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*data-testid="publication-${s}"|<button[^>]*data-testid="publication-${s}"[^>]*disabled=""`));
    expect(viewer).toMatch(/<input[^>]*disabled=""[^>]*data-testid="publication-reason"/);
    expect(viewer).toContain('data-testid="publication-read-only"');
    const editor = renderToStaticMarkup(createElement(PublicationControls, { model: await editorOf({ saveStatus: "SAVED" }) }));
    expect(editor).not.toMatch(/<input[^>]*disabled=""[^>]*data-testid="publication-reason"/);
    expect(editor).not.toContain("publication-read-only");
  });

  it("review decisions cannot be recorded: every decision form is marked read-only with its inputs and submit disabled", async () => {
    const model = await viewerOf();
    expect(model.views.filter((v) => v.record.actionable).length).toBeGreaterThan(0); // non-vacuous
    const html = renderToStaticMarkup(createElement(ReviewStage, { model, onFocusLine: () => undefined }));
    const forms = html.match(/<form[^>]*aria-label="Decide finding[^>]*>[\s\S]*?<\/form>/g) ?? [];
    expect(forms.length).toBeGreaterThan(0);
    for (const f of forms) {
      expect(f).toContain('data-read-only="yes"');
      expect(f).toMatch(/<fieldset disabled="">/);
      expect(f).toMatch(/<textarea[^>]*disabled=""/);
      expect(f).toMatch(/<button[^>]*type="submit"[^>]*disabled=""|<button[^>]*disabled=""[^>]*type="submit"/);
    }
    const editorHtml = renderToStaticMarkup(createElement(ReviewStage, { model: await editorOf(), onFocusLine: () => undefined }));
    expect(editorHtml).not.toContain('data-read-only="yes"');
    expect(editorHtml).not.toMatch(/<textarea[^>]*disabled=""/);
  });

  it("the hook refuses every mutating action for a viewer BEFORE doing anything (save, decide, add evidence, correct evidence, set publication)", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/hooks/useFinancialStatementsWorkspace.ts"), "utf8");
    expect(src).toContain('const viewerReadOnly = access?.enabled === true && access.role === "viewer";');
    const firstStatementAfter = (needle: string) => src.slice(src.indexOf(needle) + needle.length).split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
    expect(firstStatementAfter("const decide = useCallback(\n    async (request: DecisionRequest): Promise<DecisionResult> => {")).toMatch(/^if \(viewerReadOnly\) return/);
    expect(firstStatementAfter("(request: EvidenceAddRequest): EvidenceAddResult => {")).toMatch(/^if \(viewerReadOnly\) return/);
    expect(firstStatementAfter("(request: EvidenceCorrectionRequest): EvidenceCorrectionOutcome => {")).toMatch(/^if \(viewerReadOnly\) return/);
    expect(firstStatementAfter('async (state: "DRAFT" | "REVIEWED" | "FINAL", why: string) => {')).toMatch(/^if \(viewerReadOnly\) return/);
    expect(firstStatementAfter("const save = useCallback(async () => {")).toMatch(/^if \(viewing \|\| viewerReadOnly/);
    expect(src).toMatch(/readOnly: viewing !== null \|\| viewerReadOnly, readOnlyAccess: viewerReadOnly/);
  });

  it("the transport passes the caller's role through, and anything but an explicit server 'viewer' leaves the workspace editable-by-the-server's-rules (the server still decides)", async () => {
    const mk = (payload: unknown) => new FsRpcTransport({ rpc: async () => ({ data: payload, error: null }), select: async () => ({ data: [], error: null }) } as never);
    expect(await mk({ enabled: true, reason: "ENABLED", role: "viewer" }).access("c")).toEqual({ enabled: true, reason: "ENABLED", role: "viewer" });
    expect(await mk({ enabled: true, reason: "ENABLED", role: "partner" }).access("c")).toMatchObject({ role: "partner" });
    expect(await mk({ enabled: true, reason: "ENABLED" }).access("c")).toMatchObject({ role: null });
    expect(await mk({ enabled: false, reason: "NOT_A_MEMBER" }).access("c")).toMatchObject({ enabled: false, role: null });
  });
});
