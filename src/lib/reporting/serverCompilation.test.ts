import { describe, expect, it } from "vitest";
import { ingestEvidence } from "@/lib/financialEvidence/intake";
import { canonicalStringify } from "@/lib/canonicalStatement/serialization";
import { assembleComposedReport } from "@/lib/financialGeneration/composedReport";
import { composition, COMPARATIVE_DATES } from "@/lib/statements/compositionFixture";
import type { NotesStatus } from "@/lib/notes/notesStatus";
import { compileSavedReport, validateStoredEvidence } from "./serverCompilation";
import type { ReportingDb } from "./signoff";
const companyId = "11111111-1111-4111-8111-111111111111";
const dates = { start: "2026-01-01", end: "2026-12-31" };
function ledger() {
  const p = ingestEvidence({ companyId, evidenceType: "TRANSACTION_LEDGER", periodRole: "CURRENT", reportingPeriodId: "FY2026", currency: "TZS", scale: 2,
    text: "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nt1,2026-05-01,1000,Receipt,12.00,,OPERATING,Customer receipts\n" });
  if (p.outcome !== "PARSED") throw Error("fixture rejected"); return p.batch;
}
describe("server-side evidence validation", () => {
  it("derives VALID from the records even when the caller's flag says INVALID", () => {
    const b = ledger(); expect(validateStoredEvidence({ ...b, validationStatus: "INVALID" }, dates).validationStatus).toBe("VALID");
  });
  it.each(["2027-01-01", "2026-02-30"])("refuses forged VALID on an out-of-period or invalid date (%s)", date => {
    const b = ledger(); const rows = b.document.rows.map(r => r.map((v,i) => i === b.document.columns.indexOf("date") ? date : v));
    expect(() => validateStoredEvidence({ ...b, validationStatus: "VALID", diagnostics: [], document: { ...b.document, rows } }, dates)).toThrow("SERVER_EVIDENCE_INVALID");
  });
  it("refuses hidden denomination and evidence-identity changes", () => {
    const b = ledger(); expect(() => validateStoredEvidence({ ...b, document: { ...b.document, currency: "USD" } }, dates)).toThrow("SERVER_EVIDENCE_SCHEMA_INVALID");
    expect(() => validateStoredEvidence({ ...b, document: { ...b.document, reportingPeriodId: "FY2025" } }, dates)).toThrow("SERVER_EVIDENCE_SCHEMA_INVALID");
  });
});

function world() {
  const deps = { state: "current", dependenciesSha256: "d".repeat(64), compositionSha256: composition.compositionSha256, notesStatusSha256: "c".repeat(64), comparativeStatusSha256: null };
  const notes = { state: "evaluated", contract: "fs-notes-status/2", periodYear: 2026, packId: "ifrs-for-smes/2015", compositionSha256: composition.compositionSha256,
    requirements: [], blockers: [], statusSha256: "c".repeat(64) } as NotesStatus;
  const source = { state: "current", inputSha256: composition.inputSha256, current: { accounts: [], reportingStart: dates.start, reportingEnd: dates.end }, comparative: { state: "available", accounts: [], reportingStart: COMPARATIVE_DATES.start, reportingEnd: COMPARATIVE_DATES.end } };
  const built = assembleComposedReport({ companyId, reportId: "r1", reportVersion: 1, legalName: "Recorded company", composition, notes, dependencies: { dependenciesSha256: deps.dependenciesSha256, compositionSha256: deps.compositionSha256, notesStatusSha256: deps.notesStatusSha256, comparativeStatusSha256: deps.comparativeStatusSha256 },
    currentDates: dates, comparativeDates: COMPARATIVE_DATES, cashScope: { current: [], comparative: [] }, disclosures: [], evidence: [] });
  const canonical = JSON.parse(canonicalStringify(built.report));
  const saved = { company_id: companyId, report_id: "r1", report_version: 1, report_document: structuredClone(canonical), document_hash: "f".repeat(64), period_year: 2026, provenance_origin: "TRIAL_BALANCE_DERIVED", evidence_batch_ids: [], created_at: "2026-10-23T00:00:00Z" };
  const snapshot = { saved, composition, notes, dependencies: deps, input: source, evidence: [], disclosures: [], companyName: "Recorded company" };
  const db: ReportingDb = {
    rpc: async () => ({ error: null, data: snapshot }),
    select: async () => { throw Error("Compiler must not use paginated browser table reads"); },
  };
  return { db, saved, canonical, change: () => { snapshot.input.inputSha256 = "e".repeat(64); } };
}
describe("server compilation of the complete saved document", () => {
  const request = { companyId, reportId: "r1", reportVersion: 1 };
  it("rebuilds identical bytes and evaluates them without reading client findings", async () => {
    const w = world(); const result = await compileSavedReport(w.db, request); expect(result.matches).toBe(true);
    expect(result.canonicalDocument).toEqual(w.canonical); expect(result.evaluation.findings.length).toBeGreaterThan(0);
  });
  it.each(["label", "binding", "currency", "omission", "name"])("detects presentation tampering with correct retained monetary facts (%s)", async change => {
    const w = world(); const doc = w.saved.report_document;
    if (change === "name") doc.entity.legalName = "Another entity";
    if (change === "currency") doc.presentationCurrency.currency = "USD";
    if (change === "omission") doc.statements[0].sections[0].lines.pop();
    if (change === "label") doc.statements[0].sections[0].lines[0].label = "Invented label";
    if (change === "binding") doc.statements[0].sections[0].lines[0].factBindings = [];
    expect((await compileSavedReport(w.db, request)).matches).toBe(false);
  });
  it("refuses a source change in its source snapshot instead of recording mixed inputs", async () => {
    const w = world(); w.change(); await expect(compileSavedReport(w.db, request)).rejects.toThrow("SERVER_SOURCES_CHANGED");
  });
  it("fails closed on source-read errors and absent tenant records", async () => {
    const w = world(); const db = { ...w.db, rpc: async () => ({ data: null, error: { message: "REPORT_VERSION_NOT_FOUND" } }) };
    await expect(compileSavedReport(db, request)).rejects.toThrow("REPORT_VERSION_NOT_FOUND");
  });
});
