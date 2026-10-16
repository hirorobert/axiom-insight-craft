/**
 * certificationFindings.test.ts — the bounded certification summary (supabase/functions/_shared/certificationFindings.ts)
 * and the limits that bound one certification (account bound vs. certified-rows CHECK and dependency-key cap). The
 * database side (complete findings stored, summary refused when it disagrees) is proven on PostgreSQL by
 * scripts/db-proof/certificationCapacity.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUMMARY_BUDGET_BYTES, SUMMARY_EXAMPLES_PER_KIND, FindingsSummaryTooLarge, isFindingCountRecord, summarizeFindings,
  type CertificationFinding,
} from "../../../supabase/functions/_shared/certificationFindings";
import { TB_UPLOAD_POLICY, checkAccountCount } from "../../../supabase/functions/_shared/uploadPolicy";
import { computeCertificationReadiness, type TbCertificationRow } from "./computeCertificationReadiness";

const REPO = path.resolve(__dirname, "../../..");
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

const A = ["Trade", "Accrued", "Prepaid", "Staff", "Motor", "Office", "Loan", "Rental", "Consulting", "Freight"];
const B = ["receivables", "payables", "expenses", "income", "deposits", "advances", "fees", "provisions"];
const needsReview = (i: number): CertificationFinding => {
  const name = `${A[i % A.length]} ${B[(i * 7) % B.length]} - branch ${1000 + ((i * 7919) % 9000)}`;
  const code = String(100000 + i);
  return { code: "NEEDS_REVIEW", layer: 4, severity: "warning", accountCode: code, message: `No classification found for "${name}" (${code})` };
};
const kind = (e: { layer: number; code: string; severity: string }) => `${e.layer}|${e.code}|${e.severity}`;

/** The invariants tb_finalize_attempt enforces, checked here on the pure output. */
function agrees(findings: CertificationFinding[], summary: unknown[]): true | string {
  const kinds = new Set(findings.map(kind));
  for (const k of kinds) if (!summary.some((e) => kind(e as CertificationFinding) === k)) return `kind ${k} missing`;
  for (const e of summary) {
    if (isFindingCountRecord(e)) {
      const total = findings.filter((f) => kind(f) === kind(e)).length;
      const examples = summary.filter((x) => !isFindingCountRecord(x) && kind(x as CertificationFinding) === kind(e)).length;
      if (e.summary.total !== total || e.summary.omitted !== total - examples || e.summary.omitted < 1) return `count for ${kind(e)}`;
      if (summary.filter((x) => isFindingCountRecord(x) && kind(x) === kind(e)).length !== 1) return `two count records for ${kind(e)}`;
    } else if (!findings.some((f) => JSON.stringify(f) === JSON.stringify(e))) return "an example is not a finding";
  }
  return true;
}

describe("summarizeFindings — the bounded certification summary", () => {
  it("findings that fit are the summary, verbatim (an earlier engine's row shape)", () => {
    const f = Array.from({ length: 50 }, (_, i) => needsReview(i));
    const s = summarizeFindings(f);
    expect(s.summarized).toBe(false);
    expect(s.exceptions).toEqual(f);
  });

  it("400 unclassified accounts (refused by the 64 KB CHECK before the repair) become a bounded summary that agrees", () => {
    const f = Array.from({ length: 400 }, (_, i) => needsReview(i));
    expect(bytes(f)).toBeGreaterThan(SUMMARY_BUDGET_BYTES);
    const s = summarizeFindings(f);
    expect(s.summarized).toBe(true);
    expect(bytes(s.exceptions)).toBeLessThanOrEqual(SUMMARY_BUDGET_BYTES);
    expect(agrees(f, s.exceptions)).toBe(true);
    const counts = s.exceptions.filter(isFindingCountRecord);
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ code: "NEEDS_REVIEW", layer: 4, severity: "warning", accountCode: null, summary: { total: 400, omitted: 400 - SUMMARY_EXAMPLES_PER_KIND } });
    expect(counts[0].message).toBe(`${400 - SUMMARY_EXAMPLES_PER_KIND} more findings of this kind are recorded in full with this certification (400 in total).`);
    // Examples come first, in recorded order; the count record follows them.
    expect(s.exceptions.slice(0, SUMMARY_EXAMPLES_PER_KIND)).toEqual(f.slice(0, SUMMARY_EXAMPLES_PER_KIND));
  });

  it("every kind is represented — a single error among thousands of warnings is never summarised away", () => {
    const f = [...Array.from({ length: 1999 }, (_, i) => needsReview(i)),
      { code: "TRIAL_BALANCE_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "Debits (10.00) != Credits (8.00)" } as CertificationFinding,
      ...Array.from({ length: 30 }, (_, i): CertificationFinding => ({ code: "L6_PRIOR_SIGNAL", layer: 6, severity: "info", accountCode: String(i), message: `Prior period ${i}` }))];
    const s = summarizeFindings(f);
    expect(agrees(f, s.exceptions)).toBe(true);
    expect(s.exceptions.some((e) => e.severity === "error" && e.layer === 3)).toBe(true);
    expect(new Set(s.exceptions.map(kind))).toEqual(new Set(f.map(kind)));
  });

  it("readiness reaches the same verdict, blocker and layer states from the summary as from the complete findings", () => {
    for (const findings of [
      Array.from({ length: 2000 }, (_, i) => needsReview(i)),
      [...Array.from({ length: 800 }, (_, i) => needsReview(i)), { code: "TRIAL_BALANCE_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "Debits (10.00) != Credits (8.00)" } as CertificationFinding],
    ]) {
      const s = summarizeFindings(findings);
      expect(s.summarized).toBe(true);
      const isBlocking = findings.some((f) => f.severity === "error");
      const row = (exceptions: unknown[]): TbCertificationRow => ({ id: "c", sequence_no: 1, company_id: "co", upload_id: "u", period_year: 2026,
        is_blocking: isBlocking, requires_review: !isBlocking, exceptions: exceptions as TbCertificationRow["exceptions"], certified_at: "2026-10-16T00:00:00Z" });
      const input = (r: TbCertificationRow) => ({ uploadExists: true, currentUploadId: "u", authoritative: null, latestForUpload: r, fetchFailed: false });
      const full = computeCertificationReadiness(input(row(findings)) as never);
      const summarized = computeCertificationReadiness(input(row(s.exceptions)) as never);
      expect(summarized.verdict).toBe(full.verdict);
      expect(summarized.headline).toBe(full.headline);
      expect(summarized.blocker).toBe(full.blocker);
      expect(summarized.checks.map((c) => [c.id, c.state])).toEqual(full.checks.map((c) => [c.id, c.state]));
      // The layer's detail names the count instead of repeating every account.
      const l4 = summarized.checks.find((c) => c.id === "l4_classification")!;
      expect(l4.detail).toContain("recorded in full with this certification");
    }
  });

  it("long messages: examples are dropped before the bound is exceeded, the count record stays", () => {
    const long = (i: number): CertificationFinding => ({ ...needsReview(i), message: `No classification found for "${"x".repeat(9000)} ${i}"` });
    const f = Array.from({ length: 40 }, (_, i) => long(i));
    const s = summarizeFindings(f);
    expect(bytes(s.exceptions)).toBeLessThanOrEqual(SUMMARY_BUDGET_BYTES);
    expect(agrees(f, s.exceptions)).toBe(true);
    expect(s.exceptions.filter((e) => !isFindingCountRecord(e)).length).toBeLessThan(SUMMARY_EXAMPLES_PER_KIND);
  });

  it("refuses (never truncates) when even one count record per kind would not fit", () => {
    const f = Array.from({ length: 2000 }, (_, i): CertificationFinding => ({ code: `CODE_${i}`, layer: 2, severity: "warning", accountCode: null, message: "m" }));
    expect(() => summarizeFindings(f, 1024)).toThrow(FindingsSummaryTooLarge);
  });

  it("the summary budget is half the column's 65,536-byte CHECK (stored jsonb measured about 8% above JSON text)", () => {
    const sql = fs.readFileSync(path.join(REPO, "supabase/migrations/20260902130000_safisha_certification_foundation.sql"), "utf8");
    expect(sql).toMatch(/pg_column_size\(exceptions\) <= 65536/);
    expect(SUMMARY_BUDGET_BYTES * 2).toBe(65_536);
  });
});

describe("one certification's limits — separate, and consistent with the database", () => {
  it("the account bound refuses explicitly above it, never at it", () => {
    expect(checkAccountCount(TB_UPLOAD_POLICY.maxAccounts)).toBeNull();
    expect(checkAccountCount(TB_UPLOAD_POLICY.maxAccounts + 1)).toMatchObject({ code: "TOO_MANY_ACCOUNTS", severity: "blocking" });
  });

  it("the account bound fits the dependency-key cap (four keys per account plus four fixed keys)", () => {
    const sql = fs.readFileSync(path.join(REPO, "supabase/migrations/20261107100000_certification_findings_capacity.sql"), "utf8");
    const cap = Number(/jsonb_array_length\(p_keys\) > (\d+)/.exec(sql)![1]);
    expect(4 * TB_UPLOAD_POLICY.maxAccounts + 4).toBeLessThanOrEqual(cap);
  });

  it("the certified-rows bound stays under the rows_snapshot CHECK with margin for jsonb overhead", () => {
    const sql = fs.readFileSync(path.join(REPO, "supabase/migrations/20260902130000_safisha_certification_foundation.sql"), "utf8");
    expect(sql).toMatch(/pg_column_size\(rows_snapshot\) <= 1048576/);
    expect(TB_UPLOAD_POLICY.maxCertifiedRowsBytes * 1.1).toBeLessThan(1_048_576);
  });

  it("findings per certification stay far below the database's findings limit", () => {
    const sql = fs.readFileSync(path.join(REPO, "supabase/migrations/20261107100000_certification_findings_capacity.sql"), "utf8");
    const limit = Number(/tb_certification_findings_limit\(\)\s+RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS \$\$ SELECT (\d+)/.exec(sql)![1]);
    // One finding per account at most per kind; a handful of kinds.
    expect(TB_UPLOAD_POLICY.maxAccounts * 10).toBeLessThanOrEqual(limit);
  });
});
