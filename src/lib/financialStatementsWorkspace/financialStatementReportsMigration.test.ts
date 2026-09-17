/**
 * Static migration-contract test for
 * supabase/migrations/20260917000000_financial_statement_reports.sql.
 *
 * This migration is deliberately UNAPPLIED (see its own header) — this test
 * never executes it against a database. It only asserts structural
 * invariants by reading the real SQL file, mirroring the established
 * pattern in src/lib/__tests__/migrationReplayCompatibilityGuard.test.ts.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(__dirname, "../../../");
const MIGRATION_PATH = path.join(REPO_ROOT, "supabase/migrations/20260917000000_financial_statement_reports.sql");

let sql: string;

beforeAll(() => {
  sql = fs.readFileSync(MIGRATION_PATH, "utf8");
});

describe("financial_statement_reports migration contract", () => {
  it("exists and declares itself unapplied", () => {
    expect(sql).toMatch(/THIS MIGRATION IS UNAPPLIED/);
    expect(sql).toMatch(/Do not run `supabase db push`/);
  });

  it("creates all three tables", () => {
    expect(sql).toMatch(/CREATE TABLE public\.financial_statement_reports/);
    expect(sql).toMatch(/CREATE TABLE public\.financial_statement_evaluations/);
    expect(sql).toMatch(/CREATE TABLE public\.financial_statement_reviewer_decisions/);
  });

  it("enables RLS on all three tables", () => {
    for (const table of ["financial_statement_reports", "financial_statement_evaluations", "financial_statement_reviewer_decisions"]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    }
  });

  it("scopes every SELECT policy through firm_members company membership", () => {
    const selectPolicies = sql.match(/CREATE POLICY "[a-z_]+_select"[\s\S]*?;/g) ?? [];
    expect(selectPolicies.length).toBe(3);
    for (const policy of selectPolicies) {
      expect(policy).toMatch(/firm_members/);
      expect(policy).toMatch(/accepted_at IS NOT NULL/);
    }
  });

  it("revokes all direct access from anon/authenticated on every table (writes are RPC-only)", () => {
    const revokeStatements = sql.match(/REVOKE ALL ON public\.\w+ FROM PUBLIC, anon, authenticated;/g) ?? [];
    expect(revokeStatements).toHaveLength(3);
  });

  it("grants only SELECT to authenticated on every table — no direct INSERT/UPDATE/DELETE policy exists", () => {
    expect(sql.match(/GRANT SELECT ON public\.\w+ TO authenticated;/g) ?? []).toHaveLength(3);
    // Never a bare INSERT/UPDATE/DELETE policy for authenticated/anon.
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]{0,200}?FOR (INSERT|UPDATE|DELETE)[\s\S]{0,200}?TO (authenticated|anon)/);
  });

  it("declares an idempotency-enforcing UNIQUE constraint on every table", () => {
    expect(sql).toMatch(/CONSTRAINT uq_fsr_report_id_version UNIQUE \(report_id, report_version\)/);
    expect(sql).toMatch(/CONSTRAINT uq_fse_evaluation_run_id UNIQUE \(evaluation_run_id\)/);
    expect(sql).toMatch(/CONSTRAINT uq_fsrd_report_decision UNIQUE \(report_id, decision_id\)/);
  });

  it("guards every table with a trigger that rejects at least DELETE (append-only)", () => {
    for (const [table, guard] of [
      ["financial_statement_reports", "financial_statement_reports_guard"],
      ["financial_statement_evaluations", "financial_statement_evaluations_guard"],
      ["financial_statement_reviewer_decisions", "financial_statement_reviewer_decisions_guard"],
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TRIGGER trg_\\w+\\s+BEFORE UPDATE OR DELETE ON public\\.${table}[\\s\\S]*?EXECUTE FUNCTION public\\.${guard}`));
      expect(sql).toMatch(new RegExp(`FUNCTION public\\.${guard}[\\s\\S]{0,400}?RAISE EXCEPTION`));
    }
  });

  it("carries all three service-role-only SECURITY DEFINER write RPCs", () => {
    for (const fn of ["save_financial_statement_report", "save_financial_statement_evaluation", "append_financial_statement_reviewer_decision"]) {
      expect(sql).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
      // Each function body must be SECURITY DEFINER and re-verify firm membership or report existence — never trust the caller.
      const fnMatch = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]*?\\$\\$;`));
      expect(fnMatch).toBeTruthy();
      expect(fnMatch![0]).toMatch(/SECURITY DEFINER/);
    }
    // Every write RPC is revoked from anon/authenticated and granted only to service_role.
    const grants = sql.match(/GRANT EXECUTE ON FUNCTION public\.\w+\([^)]*\) TO service_role;/g) ?? [];
    expect(grants).toHaveLength(3);
    const revokes = sql.match(/REVOKE ALL ON FUNCTION public\.\w+\([^)]*\) FROM PUBLIC, anon, authenticated;/g) ?? [];
    expect(revokes).toHaveLength(3);
  });

  it("stores monetary report content only as JSONB, never as a floating-point numeric column", () => {
    expect(sql).toMatch(/report_document\s+JSONB\s+NOT NULL/);
    expect(sql).not.toMatch(/\bfindings\s+FLOAT\b/i);
    expect(sql).not.toMatch(/DOUBLE PRECISION/i);
  });

  it("never defaults a financial/content column to a sentinel value (NULL-means-NOT-COMPUTED discipline)", () => {
    // report_document / content_hash / findings / decision / input_hash must never carry a DEFAULT.
    expect(sql).not.toMatch(/report_document\s+JSONB\s+NOT NULL\s+DEFAULT/);
    expect(sql).not.toMatch(/findings\s+JSONB\s+NOT NULL\s+DEFAULT/);
    expect(sql).not.toMatch(/decision\s+JSONB\s+NOT NULL\s+DEFAULT/);
  });

  it("foreign-keys every company_id to companies and every actor id to firm_members, never auth.users directly", () => {
    const fkMatches = sql.match(/FOREIGN KEY \([a-z_]+\) REFERENCES public\.\w+\(/g) ?? [];
    expect(fkMatches.length).toBeGreaterThanOrEqual(5);
    expect(sql).not.toMatch(/REFERENCES auth\.users/);
  });

  it("uses ON DELETE RESTRICT for every foreign key — an immutable evidentiary/audit row is never silently cascaded away", () => {
    const fkBlocks = sql.match(/FOREIGN KEY[\s\S]*?ON DELETE \w+/g) ?? [];
    expect(fkBlocks.length).toBeGreaterThan(0);
    for (const block of fkBlocks) {
      expect(block).toMatch(/ON DELETE RESTRICT/);
    }
  });
});
