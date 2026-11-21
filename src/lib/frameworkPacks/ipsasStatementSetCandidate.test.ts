import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { composeIpsasStatements } from "../../../release/candidates/ipsas-statements-r1/compose";
import { renderIpsasStatementReview, formatMinor } from "../../../release/candidates/ipsas-statements-r1/render";

const root = path.resolve(__dirname, "../../..");
const fixture = () => JSON.parse(fs.readFileSync(path.join(root, "docs/release/ipsas-statements-r1/synthetic-statement-input.json"), "utf8"));
const row = (r: ReturnType<typeof composeIpsasStatements>, id: string) => r.statements.flatMap(s => s.rows).find(r => r.id === id)!;
const evidence = () => fixture().notes[0].evidence[0];
const journal = () => ({ id: "reclass-1", kind: "presentation-reclassification", reason: "Reclassify a documented equipment balance to receivables", authorityReference: "Synthetic reviewer memo", evidence: evidence(), openingBridgeId: null,
  entries: [{ accountId: "cost", debitDeltaMinor: "0", creditDeltaMinor: "10000" }, { accountId: "ar", debitDeltaMinor: "10000", creditDeltaMinor: "0" }] });

describe("joined IPSAS statement candidate", () => {
  it("composes the four primary statements and the applicable budget without inventing authority", () => {
    const r = composeIpsasStatements(fixture());
    expect(r.statements.map(s => s.id)).toEqual(["SFP", "SFPERF", "SCNA", "SCF", "SCBA"]);
    expect(row(r, "sfp:assets").current.amountMinor).toBe("2300000");
    expect(row(r, "sfp:net-assets").current.amountMinor).toBe("1800000");
    expect(row(r, "sfperf:surplus").current.amountMinor).toBe("500000");
    expect(row(r, "scf:closing").current.amountMinor).toBe("900000");
    expect(r.checks.length).toBe(10);
    expect(r.checks.every(c => c.state === "agrees")).toBe(true);
    expect(r.publicationAuthorized).toBe(false);
    expect(r.officialIssuance.available).toBe(false);
    expect(r.officialIssuance.reasons).toContain("AUTHENTICATED_SOURCE_BINDING_NOT_IMPLEMENTED");
  });
  it("does not require a public budget from every NGO", () => {
    const f = fixture(); f.preparation.profile.publicBudget = "no"; f.preparation.budget = null;
    for (const g of f.preparation.grants) g.profile.publicBudget = "no";
    expect(composeIpsasStatements(f).statements.map(s => s.id)).not.toContain("SCBA");
  });
  it("uses the same contracts for a single public entity; does not infer eligibility from its name", () => {
    const f = fixture(); f.preparation.legalName = "Synthetic district authority";
    expect(composeIpsasStatements(f).statements).toEqual(composeIpsasStatements(fixture()).statements);
  });
  it("shows an incomplete budget statement and task when its approved budget is missing", () => {
    const f = fixture(); f.preparation.budget = null;
    const r = composeIpsasStatements(f);
    expect(r.statements.find(s => s.id === "SCBA")?.rows).toEqual([]);
    expect(r.tasks.find(t => t.code === "BUDGET_PREPARATION_REQUIRED")?.target).toBe("budget");
  });
  it("preserves no-comparative as missing, never as a zero column or an exemption", () => {
    const f = fixture(); f.preparation.comparative = null; f.preparation.profile.comparative = null;
    f.preparation.evidence = f.preparation.evidence.filter((e: {period: {start: string}}) => e.period.start === f.preparation.scope.period.start);
    for (const g of f.preparation.grants) g.profile.comparative = null;
    const r = composeIpsasStatements(f);
    expect(row(r, "sfp:assets").comparative).toBeNull();
    expect(r.officialIssuance.reasons).toContain("COMPARATIVES_OR_FIRST_PERIOD_ASSESSMENT_REQUIRED");
  });
  it("keeps unknown opening balances missing and creates a reconciliation task", () => {
    const f = fixture(); f.preparation.current.netAssets.openingMinor = null;
    const r = composeIpsasStatements(f);
    expect(row(r, "scna:opening").current.amountMinor).toBeNull();
    expect(r.checks.find(c => c.id === "current:net-assets")?.state).toBe("missing");
    expect(renderIpsasStatementReview(r)).toContain("Missing — not zero");
  });
  it("each displayed figure has source or formula references", () => {
    for (const s of composeIpsasStatements(fixture()).statements) for (const r of s.rows) {
      expect(r.current.sourceRefs.length).toBeGreaterThan(0);
      if (r.comparative) expect(r.comparative.sourceRefs.length).toBeGreaterThan(0);
    }
  });
});

describe("comparative journals and opening bridge", () => {
  it("preserves original figures while presenting the balanced non-cash reclassification", () => {
    const f = fixture(), original = JSON.stringify(f.preparation);
    f.comparativeRestatements = [journal()]; f.notes[0].rows[0].comparativeMinor = "990000";
    const r = composeIpsasStatements(f);
    expect(JSON.stringify(f.preparation)).toBe(original);
    expect(row(r, "sfp:ppe:non-current").asReported?.amountMinor).toBe("1000000");
    expect(row(r, "sfp:ppe:non-current").comparative?.amountMinor).toBe("990000");
    expect(row(r, "sfp:ppe:non-current").comparative?.sourceRefs).toContain("comparative-journal:reclass-1");
    expect(row(r, "sfp:assets").comparative?.amountMinor).toBe("1700000");
    expect(r.checks.every(c => c.state === "agrees")).toBe(true);
  });
  it("carries a result-changing correction into opening net assets exactly once", () => {
    const f = fixture();
    const j = journal(); j.kind = "error-correction"; j.entries[1].accountId = "dep";
    j.entries[0] = { accountId: "cost", debitDeltaMinor: "10000", creditDeltaMinor: "0" };
    j.entries[1] = { accountId: "dep", debitDeltaMinor: "0", creditDeltaMinor: "10000" };
    f.comparativeRestatements = [{ ...j, openingBridgeId: "opening-error" }];
    f.preparation.openingAdjustments = [{ id: "opening-error", kind: "correction", amountMinor: "10000", reason: "Evidenced prior depreciation correction", authorityReference: "Synthetic reviewer memo", evidenceId: "management-current" }];
    f.preparation.current.netAssets.openingMinor = "1310000";
    f.preparation.current.accounts.find((a: {id:string}) => a.id === "na").creditMinor = "1310000";
    f.preparation.current.accounts.find((a: {id:string}) => a.id === "ar").debitMinor = "210000";
    f.notes[0].rows[0].comparativeMinor = "1010000";
    const r = composeIpsasStatements(f);
    expect(row(r, "sfp:net-assets").asReported?.amountMinor).toBe("1300000");
    expect(row(r, "sfp:net-assets").comparative?.amountMinor).toBe("1310000");
    expect(r.checks.find(c => c.id === "opening-net-assets")?.differenceMinor).toBe("0");
    expect(r.comparativeJournalAudit[0].netAssetsDeltaMinor).toBe("10000");
  });
  it.each([
    ["unbalanced", (j: ReturnType<typeof journal>) => { j.entries[0].creditDeltaMinor = "9999"; }, "COMPARATIVE_JOURNAL_UNBALANCED"],
    ["unknown account", (j: ReturnType<typeof journal>) => { j.entries[0].accountId = "not-there"; }, "COMPARATIVE_JOURNAL_ACCOUNT_UNKNOWN"],
    ["cash restatement", (j: ReturnType<typeof journal>) => { j.entries[0].accountId = "bank"; }, "COMPARATIVE_CASH_RESTATEMENT_WORKPAPER_REQUIRED"],
    ["cross-company evidence", (j: ReturnType<typeof journal>) => { j.evidence.companyId = "other"; }, "EVIDENCE_SCOPE_MISMATCH"],
    ["duplicate entry", (j: ReturnType<typeof journal>) => { j.entries[1].accountId = "cost"; }, "DUPLICATE_COMPARATIVE_JOURNAL_ACCOUNT"],
  ])("refuses %s", (_, change, code) => {
    const f = fixture(), j = journal(); change(j); f.comparativeRestatements = [j];
    expect(() => composeIpsasStatements(f)).toThrow(code);
  });
  it("refuses a result-changing correction without its opening bridge", () => {
    const f = fixture(), j = journal(); j.kind = "error-correction"; j.entries[1].accountId = "dep"; f.comparativeRestatements = [j];
    expect(() => composeIpsasStatements(f)).toThrow("COMPARATIVE_OPENING_BRIDGE_REQUIRED");
  });
  it("does not mislabel a result-changing entry as a presentation reclassification", () => {
    const f = fixture(), j = journal(); j.entries[1].accountId = "dep"; f.comparativeRestatements = [j];
    expect(() => composeIpsasStatements(f)).toThrow("PRESENTATION_RECLASSIFICATION_CHANGES_NET_ASSETS");
  });
  it("refuses duplicate journal identities", () => {
    const f = fixture(); f.comparativeRestatements = [journal(), journal()];
    expect(() => composeIpsasStatements(f)).toThrow("DUPLICATE_COMPARATIVE_JOURNAL");
  });
});

describe("notes, checklist and digest boundaries", () => {
  it("links statement captions to numbered notes and notes back to statement targets", () => {
    const r = composeIpsasStatements(fixture());
    expect(row(r, "sfp:ppe:non-current").noteIds).toEqual(["ppe"]);
    expect(r.notes[0].number).toBe(1);
    expect(r.checks.filter(c => c.id.startsWith("note:")).every(c => c.state === "agrees")).toBe(true);
  });
  it("a one-minor-unit discrepancy creates a named blocker", () => {
    const f = fixture(); f.notes[0].rows[0].currentMinor = "1200001";
    const r = composeIpsasStatements(f);
    expect(r.checks.find(c => c.id === "note:ppe:sfp:ppe:non-current:current")?.differenceMinor).toBe("1");
    expect(r.tasks.some(t => t.target === "notes")).toBe(true);
  });
  it("null note figures are not silently summed as zero", () => {
    const f = fixture(); f.notes[0].rows[0].currentMinor = null;
    expect(composeIpsasStatements(f).checks.find(c => c.id.endsWith(":current") && c.id.startsWith("note:"))?.state).toBe("missing");
  });
  it.each([
    ["DUPLICATE_NOTE_ID", (f: ReturnType<typeof fixture>) => f.notes.push(structuredClone(f.notes[0]))],
    ["NOTE_FIGURE_EVIDENCE_MISSING", (f: ReturnType<typeof fixture>) => { f.notes[0].rows[0].evidenceId = "unknown"; }],
    ["NOTE_TIE_TARGET_UNKNOWN", (f: ReturnType<typeof fixture>) => { f.notes[0].ties[0].target = "unknown"; }],
    ["DUPLICATE_NOTE_TIE_ROW", (f: ReturnType<typeof fixture>) => f.notes[0].ties[0].rowIds.push("equipment")],
    ["NOTE_TIE_ROW_UNKNOWN", (f: ReturnType<typeof fixture>) => { f.notes[0].ties[0].rowIds = ["unknown"]; }],
  ])("refuses %s", (code, mutate) => { const f = fixture(); mutate(f); expect(() => composeIpsasStatements(f)).toThrow(code); });
  it("does not turn supplied support statuses or external links into issuance authority", () => {
    const f = fixture(); f.requirements[0].support = "external-workpaper";
    const r = composeIpsasStatements(f);
    expect(r.officialIssuance.reasons).toContain("GOVERNED_WORKPAPER_SERVER_VERIFICATION_REQUIRED:ppe-disclosure");
    expect(r.officialIssuance.available).toBe(false);
  });
  it("rejects conflicting revisions of a shared evidence identity across notes and requirements", () => {
    const f = fixture(); f.requirements[0].evidence.sourceRevision = "a".repeat(64);
    expect(() => composeIpsasStatements(f)).toThrow("EVIDENCE_ID_REUSED");
  });
  it("rejects note evidence for another period, not just another entity", () => {
    const f = fixture(); f.notes[0].evidence[0].period = { start: "2025-01-01", end: "2025-12-31" };
    f.notes[0].evidence[0].id = "wrong-period"; f.notes[0].rows[0].evidenceId = "wrong-period";
    expect(() => composeIpsasStatements(f)).toThrow("EVIDENCE_SCOPE_MISMATCH");
  });
  it("requires a record even for non-applicability and a note when declared required", () => {
    const f = fixture(); f.requirements[0].applicability = "not-applicable"; f.requirements[0].evidence = null;
    expect(composeIpsasStatements(f).officialIssuance.reasons).toContain("REQUIREMENT_ASSESSMENT_REQUIRED:ppe-disclosure");
    f.requirements[0].applicability = "applicable"; f.notes = [];
    expect(composeIpsasStatements(f).officialIssuance.reasons).toContain("REQUIRED_NOTE_MISSING:ppe-disclosure:ppe");
  });
  it("hashes note figures, but keeps narrative-only changes out of the accounting hash", () => {
    const f = fixture(), a = composeIpsasStatements(f);
    f.notes[0].paragraphs = ["Changed draft wording with unchanged amounts."];
    const b = composeIpsasStatements(f);
    expect(b.accountingResultSha256).toBe(a.accountingResultSha256);
    expect(b.provenanceSha256).not.toBe(a.provenanceSha256);
    f.notes[0].rows[0].currentMinor = "1200001";
    expect(composeIpsasStatements(f).accountingResultSha256).not.toBe(b.accountingResultSha256);
  });
  it("equivalent account and budget row order preserves the accounting hash", () => {
    const f = fixture(), a = composeIpsasStatements(f);
    f.preparation.current.accounts.reverse(); f.preparation.comparative.accounts.reverse(); f.preparation.budget.rows.reverse();
    const b = composeIpsasStatements(f);
    expect(b.accountingResultSha256).toBe(a.accountingResultSha256);
    expect(b.inputSha256).not.toBe(a.inputSha256);
  });
  it("binds the comparative period even when every monetary amount stays the same", () => {
    const f = fixture(), a = composeIpsasStatements(f);
    const revised = JSON.parse(JSON.stringify(f).replaceAll("2024-07-01", "2024-10-01"));
    const b = composeIpsasStatements(revised);
    expect(b.statements).toEqual(a.statements);
    expect(b.accountingResultSha256).not.toBe(a.accountingResultSha256);
  });
  it("owns and freezes its snapshot; changing the caller's input cannot change the result", () => {
    const f = fixture(), r = composeIpsasStatements(f), before = JSON.stringify(r);
    f.notes[0].rows[0].currentMinor = "1"; f.preparation.current.accounts[0].debitMinor = "1";
    expect(JSON.stringify(r)).toBe(before);
    expect(Object.isFrozen(r.statements[0].rows[0].current)).toBe(true);
  });
  it("rejects authority fields and non-JSON getters instead of silently trusting them", () => {
    const f = fixture(); f.publicationAuthorized = true;
    expect(() => composeIpsasStatements(f)).toThrow();
    let ran = false;
    expect(() => composeIpsasStatements(Object.defineProperty({}, "schema", { enumerable: true, get() { ran = true; return "x"; } }))).toThrow("SOURCE_NOT_JSON");
    expect(ran).toBe(false);
  });
});

describe("offline review renderer", () => {
  it("escapes entity and note text and includes no executable or external resources", () => {
    const f = fixture(); f.preparation.legalName = '<script>alert("x")</script>';
    f.notes[0].paragraphs = ['<img src="https://evil.example/x" onerror="alert(1)">'];
    const html = renderIpsasStatementReview(composeIpsasStatements(f));
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;"); expect(html).toContain("default-src 'none'");
    expect(html).toContain("NOT APPROVED OR ISSUED"); expect(html).not.toContain("<form");
  });
  it.each([["900719925474099312345", 2, "9,007,199,254,740,993,123.45"], ["-1", 2, "−0.01"], ["0", 0, "0"], [null, 2, "Missing — not zero"]] as const)("formats %s at scale %s exactly", (value, scale, expected) => {
    expect(formatMinor(value, scale)).toBe(expected);
  });
  it("shows budget original/final/actual/variance and retains the transition limitation", () => {
    const html = renderIpsasStatementReview(composeIpsasStatements(fixture()));
    expect(html).toContain("Actual on comparable basis"); expect(html).toContain("Budget-to-statement reconciliation");
    expect(html).toContain("COMPARATIVE_FRAMEWORK_AND_TRANSITION_REVIEW_REQUIRED");
  });
  it("is byte-deterministic for the same input", () => {
    expect(renderIpsasStatementReview(composeIpsasStatements(fixture()))).toBe(renderIpsasStatementReview(composeIpsasStatements(fixture())));
  });
  it("does not acquire a production import or provider/storage access", () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    expect(walk(path.join(root, "src")).filter(p => /\.[jt]sx?$/.test(p) && !p.includes(".test.") && fs.readFileSync(p, "utf8").includes("ipsas-statements-r1"))).toEqual([]);
    for (const p of walk(path.join(root, "release/candidates/ipsas-statements-r1")).filter(p => p.endsWith(".ts") && !p.endsWith("demo.ts"))) expect(fs.readFileSync(p, "utf8")).not.toMatch(/\bfetch\s*\(|createClient\s*\(|Deno\.serve|\.from\s*\(/);
  });
});
