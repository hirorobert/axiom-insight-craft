/** Inert candidate proof; no network or database calls. Does not establish SQL/FINAL/issuance compatibility. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createProofRegistry, type KernelAdapter, type KernelSnapshot } from "../../../release/candidates/framework-kernel-r1/kernel";
import { smeProofAdapter } from "../../../release/candidates/framework-kernel-r1/smeAdapter";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { assembleComposedReport, evaluateComposedReport } from "@/lib/financialGeneration/composedReport";
import { compileSavedReport } from "@/lib/reporting/serverCompilation";
import { composition, COMPARATIVE_DATES } from "@/lib/statements/compositionFixture";
import type { NotesStatus } from "@/lib/notes/notesStatus";
import type { CanonicalFinancialStatementReport } from "@/lib/canonicalStatement/types";
import { CANONICAL_SCHEMA_VERSION } from "@/lib/canonicalStatement/types";
import { CANONICAL_CONCEPTS as C } from "@/lib/canonicalStatement/concepts";
import { fact, line } from "@/lib/canonicalStatement/fixtures/builders";

const ROOT = path.resolve(__dirname, "../../..");
const compilerBytes = fs.readFileSync(path.join(ROOT, "supabase/functions/_shared/statementCompiler.generated.mjs"));
const compilerSha = createHash("sha256").update(compilerBytes).digest("hex");
const identity = { companyId: "11111111-1111-4111-8111-111111111111", reportId: "proof-report", reportVersion: 1 };
const period = { start: "2026-01-01", end: "2026-12-31" };
const clock = "2026-10-26T00:00:00.000Z";
const makeSource = () => {
  const dependencies = { state: "current", dependenciesSha256: "d".repeat(64), compositionSha256: composition.compositionSha256,
    notesStatusSha256: "c".repeat(64), comparativeStatusSha256: null };
  const notes = { state: "evaluated", contract: "fs-notes-status/2", periodYear: 2026, packId: "ifrs-for-smes/2015",
    compositionSha256: composition.compositionSha256, requirements: [], blockers: [], statusSha256: "c".repeat(64) } as NotesStatus;
  const built = assembleComposedReport({ ...identity, legalName: "Independent synthetic company", composition, notes,
    dependencies: { dependenciesSha256: dependencies.dependenciesSha256, compositionSha256: dependencies.compositionSha256, notesStatusSha256: dependencies.notesStatusSha256, comparativeStatusSha256: null }, currentDates: period, comparativeDates: COMPARATIVE_DATES, cashScope: { current: [], comparative: [] }, disclosures: [], evidence: [] });
  const canonical = JSON.parse(canonicalStringify(built.report));
  return { saved: { company_id: identity.companyId, report_id: identity.reportId, report_version: identity.reportVersion,
    report_document: canonical, document_hash: "f".repeat(64), period_year: 2026, provenance_origin: "TRIAL_BALANCE_DERIVED",
    evidence_batch_ids: [], created_at: clock }, composition: structuredClone(composition), notes, dependencies,
    input: { state: "current", inputSha256: composition.inputSha256,
      current: { accounts: [], reportingStart: period.start, reportingEnd: period.end },
      comparative: { state: "available", accounts: [], reportingStart: COMPARATIVE_DATES.start, reportingEnd: COMPARATIVE_DATES.end } },
    evidence: [], disclosures: [], companyName: "Independent synthetic company" };
};
function snapshot(registry: ReturnType<typeof createProofRegistry>, payload: unknown, index = 0): KernelSnapshot {
  return { schema: "framework-kernel-snapshot/1", identity: { ...identity }, selection: structuredClone(registry.inventory[index]), period, evaluatedAt: clock, payload };
}
/** Independent artificial vocabulary; no SME lines or disclosure identifiers. Not an accounting standard. */
function syntheticAdapter(): KernelAdapter {
  return {
    descriptor: { schema: "framework-kernel-descriptor/1", pack: { family: "SYNTHETIC_TEST", packId: "test-only/artificial-position", edition: "proof", revision: "1" },
      canonicalKind: "IFRS", periodStarts: { from: "2020-01-01", before: null },
      adapter: { id: "test-only-artificial-adapter", version: "1", sourceSha256: sha256Hex("artificial fixture declaration only") },
      encodingSha256: sha256Hex("resources = obligations + interests; 100 = 30 + 70") },
    assemble: (s) => {
      const payload = s.payload as { resources: string; obligations: string; interests: string };
      const facts = [fact("resources", payload.resources, "TZS", 2), fact("obligations", payload.obligations, "TZS", 2), fact("interests", payload.interests, "TZS", 2)];
      return { schemaVersion: CANONICAL_SCHEMA_VERSION, reportIdentity: s.identity, entity: { legalName: "TEST ONLY — not a framework release" },
        period: { periodId: "CURRENT", startDate: s.period.start, endDate: s.period.end, periodYear: 2026 }, comparativePeriods: [],
        // Canonical schema has no synthetic enum. The reserved test-only version prevents a compliance identity claim.
        framework: { kind: "IFRS", version: "test-only/artificial-position" },
        presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
        statements: [{ statementId: "artificial.position", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "Artificial resources and interests", sections: [
          { sectionId: "artificial.values", label: "Proof values", lines: [
            line("artificial.resources", "Resources", C.TOTAL_ASSETS, "TOTAL", "resources"),
            line("artificial.obligations", "Obligations", C.TOTAL_LIABILITIES, "TOTAL", "obligations", { normalBalance: "CREDIT_NORMAL" }),
            line("artificial.interests", "Interests", C.TOTAL_EQUITY, "TOTAL", "interests", { normalBalance: "CREDIT_NORMAL" }),
          ] },
        ] }], facts, notes: [], noteReferences: [], accountingPolicies: [], textualDisclosures: [], provenanceOrigin: "TRIAL_BALANCE_DERIVED" } as CanonicalFinancialStatementReport;
    },
  };
}

describe("framework kernel candidate compatibility and extension proof", () => {
  it("the SME compatibility adapter preserves the existing compiler document and evaluation bytes", async () => {
    const source = makeSource();
    const old = await compileSavedReport({ rpc: async () => ({ data: source, error: null }), select: async () => { throw Error("unexpected read"); } }, identity);
    const registry = createProofRegistry([smeProofAdapter(compilerSha)]);
    const result = await registry.compile(snapshot(registry, source), identity);
    expect(JSON.parse(canonicalStringify(result.document))).toEqual(old.canonicalDocument);
    expect(JSON.parse(canonicalStringify(result.evaluation))).toEqual(old.evaluation);
    expect(result.publicationAuthorized).toBe(false);
  });
  it("runs a non-SME vocabulary through the same snapshot, identity, validation and canonical rule pipeline", async () => {
    const registry = createProofRegistry([smeProofAdapter(compilerSha), syntheticAdapter()]);
    const result = await registry.compile(snapshot(registry, { resources: "100.00", obligations: "30.00", interests: "70.00" }, 1), identity);
    expect(result.document.framework.version).toBe("test-only/artificial-position");
    expect(result.document.statements[0].sections[0].lines.every(l => l.lineId.startsWith("artificial."))).toBe(true);
    const equation = result.evaluation.findings.filter(f => f.ruleId === "sfp-equation");
    expect(equation.length).toBeGreaterThan(0);
    expect(equation.every(f => f.outcome === "PASS")).toBe(true);
    expect(result.publicationAuthorized).toBe(false);
  });
  it("evaluates an independently seeded equation defect instead of accepting adapter success as accounting proof", async () => {
    const registry = createProofRegistry([syntheticAdapter()]);
    const result = await registry.compile(snapshot(registry, { resources: "101.00", obligations: "30.00", interests: "70.00" }), identity);
    expect(result.outcome).toBe("COMPILED_WITH_FINDINGS");
    expect(result.evaluation.findings.some(f => f.ruleId === "sfp-equation" && f.outcome === "FAIL")).toBe(true);
    expect(result.publicationAuthorized).toBe(false);
  });
  it("detaches and freezes source and results before returning them", async () => {
    const registry = createProofRegistry([syntheticAdapter()]);
    const raw = snapshot(registry, { resources: "100.00", obligations: "30.00", interests: "70.00" });
    const result = await registry.compile(raw, identity);
    (raw.payload as Record<string, string>).resources = "999.00";
    expect((result.sourceSnapshot.payload as Record<string, string>).resources).toBe("100.00");
    expect(Object.isFrozen(result.document.facts[0].value)).toBe(true);
    const replay = await registry.compile(result.sourceSnapshot, identity);
    expect(replay.proofSha256).toBe(result.proofSha256);
  });
  it("same bytes give the same proof; changed source or pack revision gives another proof", async () => {
    const a = syntheticAdapter(); const b = syntheticAdapter(); b.descriptor.pack.revision = "2";
    const registry = createProofRegistry([a, b]);
    const payload = { resources: "100.00", obligations: "30.00", interests: "70.00" };
    const first = await registry.compile(snapshot(registry, payload), identity);
    expect((await registry.compile(snapshot(registry, payload), identity)).proofSha256).toBe(first.proofSha256);
    expect((await registry.compile(snapshot(registry, { ...payload, resources: "101.00" }), identity)).proofSha256).not.toBe(first.proofSha256);
    expect((await registry.compile(snapshot(registry, payload, 1), identity)).proofSha256).not.toBe(first.proofSha256);
  });
});

describe("registry and source boundary refusals", () => {
  it("refuses duplicate revisions even if their supplied contents differ", () => {
    const a = syntheticAdapter(); const b = syntheticAdapter(); b.descriptor.encodingSha256 = "e".repeat(64);
    expect(() => createProofRegistry([a, b])).toThrow("DUPLICATE_PACK_REVISION");
  });
  it("captures descriptors independently of mutable registration objects", () => {
    const adapter = syntheticAdapter(); const registry = createProofRegistry([adapter]);
    adapter.descriptor.pack.revision = "999";
    expect(registry.inventory[0].revision).toBe("1");
    expect(Object.isFrozen(registry.inventory[0])).toBe(true);
  });
  it.each(["companyId", "reportId", "reportVersion"])("refuses a changed request %s before invoking the adapter", async key => {
    const registry = createProofRegistry([syntheticAdapter()]);
    const request = { ...identity, [key]: key === "reportVersion" ? 2 : "other" };
    await expect(registry.compile(snapshot(registry, {}), request)).rejects.toThrow("SOURCE_SCOPE_MISMATCH");
  });
  it.each(["packId", "edition", "revision", "family", "descriptorSha256"])("refuses altered selection %s", async key => {
    const registry = createProofRegistry([syntheticAdapter()]); const raw = structuredClone(snapshot(registry, {}));
    Object.assign(raw.selection, { [key]: key === "descriptorSha256" ? "a".repeat(64) : key === "family" ? "IFRS" : "unknown" });
    await expect(registry.compile(raw, identity)).rejects.toThrow(key === "descriptorSha256" ? "PACK_DESCRIPTOR_CHANGED" : "PACK_REVISION_UNKNOWN");
  });
  it.each(["2026-02-30", "2026-13-01", "", "2026-1-1"])("refuses malformed calendar dates (%s)", async start => {
    const registry = createProofRegistry([syntheticAdapter()]);
    await expect(registry.compile({ ...snapshot(registry, {}), period: { ...period, start } }, identity)).rejects.toThrow("INVALID_SOURCE_SNAPSHOT");
  });
  it.each(["2019-12-31", "2027-01-01"])("refuses starts outside the exact adapter period window (%s)", async start => {
    const adapter = syntheticAdapter(); adapter.descriptor.periodStarts.before = "2027-01-01";
    const registry = createProofRegistry([adapter]);
    await expect(registry.compile({ ...snapshot(registry, {}), period: { start, end: "2027-12-31" } }, identity)).rejects.toThrow("EDITION_PERIOD_UNSUPPORTED");
  });
  it("does not choose an edition or register a new family from browser fields", async () => {
    const registry = createProofRegistry([smeProofAdapter(compilerSha)]);
    const raw = snapshot(registry, makeSource());
    Object.assign(raw.selection, { family: "IPSAS_ACCRUAL", packId: "ipsas/current" });
    await expect(registry.compile(raw, identity)).rejects.toThrow("PACK_REVISION_UNKNOWN");
    await expect(registry.compile({ ...snapshot(registry, {}), enabled: true }, identity)).rejects.toThrow("INVALID_SOURCE_SNAPSHOT");
  });
  it.each([undefined, NaN, Infinity, 9007199254740992, 1n, new Date(), () => 1])("refuses a lossy or non-JSON source value (%s)", async value => {
    const registry = createProofRegistry([syntheticAdapter()]);
    await expect(registry.compile(snapshot(registry, { value }), identity)).rejects.toThrow("SOURCE_NOT_JSON");
  });
  it("refuses prototype keys and accessors before hashing; never invokes a getter", async () => {
    const registry = createProofRegistry([syntheticAdapter()]); let called = false;
    const payload = Object.defineProperty({}, "value", { enumerable: true, get() { called = true; return 1; } });
    await expect(registry.compile(snapshot(registry, payload), identity)).rejects.toThrow("SOURCE_NOT_JSON");
    expect(called).toBe(false);
    await expect(registry.compile(snapshot(registry, JSON.parse('{"__proto__":{"hidden":true}}')), identity)).rejects.toThrow("SOURCE_NOT_JSON");
  });
  it.each(["scope", "framework", "period", "provenance", "shape"])("refuses an adapter emitting the wrong %s", async change => {
    const adapter = syntheticAdapter(); const original = adapter.assemble;
    adapter.assemble = async s => {
      const r = structuredClone(await original(s));
      if (change === "scope") r.reportIdentity = { ...r.reportIdentity, companyId: "other" };
      if (change === "framework") r.framework = { ...r.framework, version: "ifrs-for-smes/2015" };
      if (change === "period") r.period = { ...r.period, startDate: "2025-01-01" };
      if (change === "provenance") r.provenanceOrigin = "DOCUMENT_REVIEWED";
      if (change === "shape") r.schemaVersion = "invalid" as never;
      return r;
    };
    const registry = createProofRegistry([adapter]);
    const expected = { scope: "ADAPTER_SCOPE_MISMATCH", framework: "ADAPTER_FRAMEWORK_MISMATCH", period: "ADAPTER_PERIOD_MISMATCH", provenance: "ADAPTER_PROVENANCE_MISMATCH", shape: "failed validation" }[change];
    await expect(registry.compile(snapshot(registry, { resources: "100.00", obligations: "30.00", interests: "70.00" }), identity)).rejects.toThrow(expected);
  });
});


describe("proof-only release boundaries", () => {
  it("checks the SME adapter source digest against the actual generated artifact manifest", () => {
    const manifest = fs.readFileSync(path.join(ROOT, "supabase/functions/_shared/statementCompiler.manifest.mjs"), "utf8");
    expect(manifest).toContain(compilerSha);
    expect(smeProofAdapter(compilerSha).descriptor.adapter.sourceSha256).toBe(compilerSha);
  });
  it("neither active product code nor the deployed compiler imports the candidate", () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    const files = walk(path.join(ROOT, "src")).filter(f => /\.(tsx?|mjs)$/.test(f) && !/\.test\./.test(f));
    for (const file of files) expect(fs.readFileSync(file, "utf8"), file).not.toContain("framework-kernel-r1");
    expect(compilerBytes.toString()).not.toContain("framework-kernel-proof/1");
  });
  it("the existing runtime still refuses a new edition and rejects synthetic composition payloads", async () => {
    const source = makeSource();
    const db = { rpc: async () => ({ data: source, error: null }), select: async () => { throw Error("unexpected read"); } };
    source.composition.pack.packId = "ifrs-for-smes/2025";
    await expect(compileSavedReport(db, identity)).rejects.toThrow("FRAMEWORK_EDITION_UNSUPPORTED");
    Object.assign(source.composition.pack, { family: "synthetic", packId: "test-only/artificial-position" });
    await expect(compileSavedReport(db, identity)).rejects.toThrow("unrecognised payload");
  });
  it("keeps concurrent compilations independent and freezes their source before adapter suspension", async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>(resolve => { release = resolve; });
    const adapter = syntheticAdapter(); const assemble = adapter.assemble;
    adapter.assemble = async s => { await wait; return assemble(s); };
    const registry = createProofRegistry([adapter]);
    const first = snapshot(registry, { resources: "100.00", obligations: "30.00", interests: "70.00" });
    const second = snapshot(registry, { resources: "101.00", obligations: "30.00", interests: "70.00" });
    const a = registry.compile(first, identity), b = registry.compile(second, identity);
    (first.payload as Record<string, string>).resources = "999.00";
    release(); const [ar, br] = await Promise.all([a, b]);
    expect(ar.document.facts[0].value?.minorUnits).toBe(10000n);
    expect(br.document.facts[0].value?.minorUnits).toBe(10100n);
    expect(ar.proofSha256).not.toBe(br.proofSha256);
  });
  it("preserves missing monetary facts as missing and genuine zero as zero", async () => {
    const registry = createProofRegistry([syntheticAdapter()]);
    const zero = await registry.compile(snapshot(registry, { resources: "0.00", obligations: "0.00", interests: "0.00" }), identity);
    const missing = await registry.compile(snapshot(registry, { resources: null, obligations: "0.00", interests: "0.00" }), identity);
    expect(zero.document.facts[0].value?.minorUnits).toBe(0n);
    expect(missing.document.facts[0].value).toBeNull();
    expect(missing.evaluation.findings.some(f => f.outcome === "INSUFFICIENT_EVIDENCE")).toBe(true);
  });
  it("checks every recorded integration boundary against its current source bytes", async () => {
    const { execFileSync } = await import("node:child_process");
    expect(execFileSync(process.execPath, ["release/candidates/framework-kernel-r1/inventory.mjs", "--check"], { cwd: ROOT, encoding: "utf8" })).toContain("FRAMEWORK_KERNEL_BOUNDARIES: OK");
  });
});
