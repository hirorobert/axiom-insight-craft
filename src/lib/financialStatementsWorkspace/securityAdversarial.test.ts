/**
 * Adversarial and security regression suite for the client side of the
 * financial-statements product. The database side (RLS, tampered company ids,
 * replay/stale/conflict, concurrent writers, append-only history) is proven on a
 * real PostgreSQL by scripts/db-proof/run.mjs and saveFlow.pg.test.ts; this suite
 * covers everything a hostile file, URL, response or renderer input can do here.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canonicalStringify } from "@/lib/canonicalStatement/serialization";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport } from "@/lib/canonicalStatement/types";
import { toCsv, isFormulaLike } from "@/lib/financialEvidence/csv";
import { INTAKE_LIMITS, ingestEvidence } from "@/lib/financialEvidence/intake";
import { DiagnosticsTable } from "@/components/financialStatements/EvidenceUi";
import { PRINT_CSS } from "@/components/financialStatements/OutputsStage";
import { isWorkspaceStage } from "./nextAction";
import { canonicalJsonExport, findingsCsv } from "./exports";
import { FsRpcTransport, mapRpcError, type FsBackend } from "./rpcTransport";
import { createWorkspaceTransport } from "./supabaseFsBackend";
import { deserializeReport } from "./persistenceContract";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

const ROOT = path.join(__dirname, "../../../");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
};
const productSources = [...walk(path.join(ROOT, "src/components/financialStatements")), ...walk(path.join(ROOT, "src/lib/financialEvidence")), ...walk(path.join(ROOT, "src/lib/financialGeneration")), ...walk(path.join(ROOT, "src/lib/financialStatementsWorkspace")), path.join(ROOT, "src/hooks/useFinancialStatementsWorkspace.ts")];

const base = { companyId: "c1", periodRole: "CURRENT", reportingPeriodId: "FY2025", currency: "TZS", scale: 2 } as const;
const csvOf = (row: string) => `line_key,line_label,nature,original_budget\n${row}\n`;

describe("uploads: hostile files", () => {
  it("formula injection in every text position, including unicode look-alikes and leading whitespace tricks", () => {
    for (const payload of ["=cmd|' /C calc'!A0", "+1+1", "-2+3+cmd|' /C calc'!A0", "@SUM(1+1)", "＝1+1", "\t=1+1", "\r=1+1"]) {
      const r = ingestEvidence({ ...base, evidenceType: "BUDGET", text: csvOf(`k,"${payload.replace(/"/g, '""')}",REVENUE,1`) });
      expect(r.outcome === "PARSED" && r.batch.validationStatus, payload).toBe("INVALID");
    }
  });

  it("export neutralises anything a spreadsheet could evaluate, in every exported cell", () => {
    expect(isFormulaLike("=1")).toBe(true);
    const report = { entity: { legalName: "Acme" }, period: { periodYear: 2025 }, reportIdentity: { reportVersion: 1 } } as unknown as CanonicalFinancialStatementReport;
    const finding = { ruleId: "r", outcome: "FAIL", failureSeverity: "HIGH", actionable: true, affected: {}, deterministicCalculation: "=HYPERLINK(\"http://x\")", remediationGuidance: "+cmd", findingKey: "@k" } as never;
    const csv = findingsCsv(report, [finding], { reportId: "r", companyId: "c", periodYear: 2025, reportVersion: null, persisted: false, label: "Unsaved draft", contentHash: "h", evaluation: null, publicationState: null }).content;
    expect(csv).not.toMatch(/(^|,|\r\n)"?[=+@]/);
    expect(toCsv([["=1+1"]])).toBe("'=1+1\r\n");
  });

  it("oversized input is refused before parsing: file, rows, columns, text and amount digits", () => {
    expect(ingestEvidence({ ...base, evidenceType: "BUDGET", text: "a".repeat(INTAKE_LIMITS.maxChars + 1) })).toMatchObject({ outcome: "REJECTED" });
    const manyRows = "line_key,line_label,nature,original_budget\n" + Array.from({ length: INTAKE_LIMITS.maxRows + 1 }, (_, i) => `k${i},l,REVENUE,1`).join("\n");
    expect(ingestEvidence({ ...base, evidenceType: "BUDGET", text: manyRows })).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "TOO_MANY_ROWS" }] });
    expect(ingestEvidence({ ...base, evidenceType: "BUDGET", text: Array.from({ length: 41 }, (_, i) => `c${i}`).join(",") + "\n1" })).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "TOO_MANY_COLUMNS" }] });
    const r = ingestEvidence({ ...base, evidenceType: "BUDGET", text: csvOf(`k,l,REVENUE,${"9".repeat(31)}`) });
    expect(r.outcome === "PARSED" && r.batch.diagnostics.map((d) => d.code)).toContain("AMOUNT_TOO_LARGE");
  });

  it("binary, macro-enabled and archive uploads are refused by name, type and content", () => {
    for (const fileName of ["a.xlsm", "a.xls", "a.ods", "a.zip", "a.pdf", "a.docx", "a.exe", "a.svg", "a.html"]) {
      expect(ingestEvidence({ ...base, evidenceType: "BUDGET", fileName, text: "x" }), fileName).toMatchObject({ outcome: "REJECTED" });
    }
    expect(ingestEvidence({ ...base, evidenceType: "BUDGET", text: "PK\u0003\u0004..." })).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "XLSX_NOT_SUPPORTED" }] });
  });

  it("prototype-pollution style headers and keys are inert (columns are matched against an allowlist)", () => {
    const r = ingestEvidence({ ...base, evidenceType: "BUDGET", text: "__proto__,constructor,line_key,line_label,nature,original_budget\nx,y,k,l,REVENUE,1\n" });
    expect(r.outcome === "PARSED" && r.batch.diagnostics.filter((d) => d.code === "UNKNOWN_COLUMN").length).toBe(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("rendering: user text is always inert", () => {
  it("script and attribute-breaking payloads are escaped in diagnostics", () => {
    const html = renderToStaticMarkup(createElement(DiagnosticsTable, { diagnostics: [{ code: "X", severity: "ERROR", message: '<script>alert(1)</script><img src=x onerror=alert(2)>"\'>', row: 1, column: "c" }] }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("no product source can inject markup or execute text", () => {
    const banned = /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*["'`]/;
    const offenders = productSources.filter((f) => banned.test(fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("a tampered ?fs= deep link falls back to a real stage and never reaches the DOM as markup", () => {
    for (const bad of ["<script>", "../../etc", "statements;drop", "", "__proto__", "STATEMENTS"]) expect(isWorkspaceStage(bad), bad).toBe(false);
    expect(isWorkspaceStage("statements")).toBe(true);
  });
});

describe("print output: no overflow, no blank pages, no chrome", () => {
  it("isolates only the document, repeats headers, avoids row splits, wraps long cells and sets both page sizes", () => {
    expect(PRINT_CSS).toMatch(/body \*:not\(:has\(#fs-print-document\)\):not\(#fs-print-document\):not\(#fs-print-document \*\) \{ display: none !important; \}/);
    expect(PRINT_CSS).toMatch(/thead \{ display: table-header-group; \}/);
    expect(PRINT_CSS).toMatch(/tr \{ break-inside: avoid; \}/);
    expect(PRINT_CSS).toMatch(/overflow-wrap: anywhere/);
    expect(PRINT_CSS).toMatch(/@page \{ size: A4 portrait/);
    expect(PRINT_CSS).toMatch(/@page fs-landscape \{ size: A4 landscape/);
    expect(PRINT_CSS).toMatch(/counter\(page\)/);
    expect(PRINT_CSS).toMatch(/content: "DRAFT"/);
  });
});

describe("transport: identity, gates and hostile responses", () => {
  const captured: { fn: string; args: Record<string, unknown> }[] = [];
  const ok = (data: unknown = {}) => ({ data, error: null });
  const backend = (reply: (fn: string) => { data: unknown; error: { code?: string; message: string } | null }): FsBackend => ({
    async rpc(fn, args) {
      captured.push({ fn, args });
      return reply(fn);
    },
    async select() {
      return { data: [], error: null };
    },
  });

  it("no request the client can build carries an actor, reviewer, user or firm-member argument", async () => {
    const t = new FsRpcTransport(backend(() => ok({})));
    const batch = (ingestEvidence({ ...base, evidenceType: "BUDGET", text: csvOf("k,l,REVENUE,1") }) as { batch: never }).batch;
    const stub = { reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 }, period: { periodYear: 2025 }, provenanceOrigin: "TRIAL_BALANCE_DERIVED" } as unknown as CanonicalFinancialStatementReport;
    await t.commitRevision({ companyId: "c", reportId: "r", expectedReportVersion: 0, idempotencyKey: "idem-key-1", report: stub, evidence: [{ batch, expectedPreviousBatchId: null }], evidenceBatchIds: [(batch as { evidenceBatchId: string }).evidenceBatchId], evaluation: { evaluationRunId: "e", rulePackId: "p", rulePackVersion: "1", engineVersion: "1", inputHash: "h", findings: [] } }).catch(() => undefined);
    await t.appendDecision("r", "c", { decisionId: "d", decisionType: "DEFER", reviewerId: "attacker-chosen-firm-member", decidedAt: "x" } as never).catch(() => undefined);
    await t.setPublicationState("r", 1, "c", "REVIEWED", "long enough reason").catch(() => undefined);
    await t.access("c");
    const keys = captured.flatMap((c) => Object.keys(c.args));
    expect(keys.filter((k) => /actor|reviewer|firm_member|user_id|uid/i.test(k))).toEqual([]);
    const decisionArgs = captured.find((c) => c.fn === "fs_append_decision")!.args;
    expect(JSON.stringify(decisionArgs)).not.toContain("attacker-chosen-firm-member");
  });

  it("access is denied unless the server says exactly enabled: true", async () => {
    for (const reply of [{ enabled: "true" }, { enabled: 1 }, { enabled: false }, null, {}, "yes"]) {
      const t = new FsRpcTransport(backend(() => ok(reply)));
      expect((await t.access("c")).enabled, JSON.stringify(reply)).toBe(false);
    }
    expect((await new FsRpcTransport(backend(() => ({ data: null, error: { message: "boom" } }))).access("c")).enabled).toBe(false);
    expect((await new FsRpcTransport(backend(() => ok({ enabled: true, reason: "ENABLED" }))).access("c")).enabled).toBe(true);
  });

  it("unrecognised failures are UNKNOWN, never success; known codes map to typed kinds", () => {
    expect(mapRpcError({ message: "something odd" }).kind).toBe("UNKNOWN");
    expect(mapRpcError({ code: "PT403", message: "x" }).kind).toBe("FEATURE_DISABLED");
    expect(mapRpcError({ code: "42501", message: "x" }).kind).toBe("FORBIDDEN");
    expect(mapRpcError({ code: "PT409", message: "STALE_REPORT_VERSION: x" }).kind).toBe("STALE_VERSION");
    expect(mapRpcError({ code: "PT409", message: "REPLAY_CONFLICT: x" }).kind).toBe("REPLAY_CONFLICT");
    expect(mapRpcError({ code: "PT409", message: "BLOCKED: x" }).kind).toBe("BLOCKED");
    expect(mapRpcError({ code: "23505", message: "dup" }).isConflict).toBe(true);
  });

  it("no transport exists while the source gate is off, whatever the environment says", () => {
    expect(createWorkspaceTransport()).toBeNull();
    expect(createWorkspaceTransport(false)).toBeNull();
  });

  it("a tampered stored document is never trusted: it must re-validate as a canonical report", () => {
    const tampered = JSON.stringify({ schemaVersion: CANONICAL_SCHEMA_VERSION, reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 }, statements: "not-an-array" });
    expect(() => deserializeReport(tampered)).toThrow();
  });
});

describe("money never becomes a JSON number", () => {
  it("the canonical export carries every minor-unit amount as an exact string marker", () => {
    const report = {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      reportIdentity: { reportId: "r", companyId: "c", reportVersion: 1 },
      entity: { legalName: "Acme" },
      period: { periodId: "CURRENT", startDate: "2025-01-01", endDate: "2025-12-31", periodYear: 2025 },
      presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
      facts: [{ factId: "f", version: 1, value: { currency: "TZS", scale: 2, minorUnits: 9007199254740993n }, reportingPeriod: { periodId: "CURRENT", isComparative: false }, signConvention: "NATURAL", provenance: {}, supersedesVersion: null }],
    } as unknown as CanonicalFinancialStatementReport;
    const file = canonicalJsonExport(report, { reportId: "r", companyId: "c", periodYear: 2025, reportVersion: null, persisted: false, label: "Unsaved draft", contentHash: "h", evaluation: null, publicationState: null }).content;
    expect(file).toContain('"__bigint__": "9007199254740993"'); // beyond 2^53: a float would corrupt it
    expect(file).not.toMatch(/"minorUnits": \d/);
    expect(canonicalStringify(report)).toContain("9007199254740993");
  });

  it("no product source parses money with parseFloat/Number on evidence amounts or emits JSON numbers for amounts", () => {
    const offenders = walk(path.join(ROOT, "src/lib/financialGeneration")).concat(walk(path.join(ROOT, "src/lib/financialEvidence"))).filter((f) => /parseFloat\(|Number\(\s*(amount|value|cell|read\()/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
