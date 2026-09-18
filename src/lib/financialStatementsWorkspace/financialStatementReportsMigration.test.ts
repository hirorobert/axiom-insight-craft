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

describe("financial_statement_reports migration — proofs required by the workspace directive", () => {
  const code = () => sql.replace(/--.*$/gm, "");
  const migrationsDir = path.join(REPO_ROOT, "supabase/migrations");
  const otherMigrations = () =>
    fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && f !== "20260917000000_financial_statement_reports.sql")
      .map((f) => ({ f, text: fs.readFileSync(path.join(migrationsDir, f), "utf8").replace(/--.*$/gm, "") }));

  it("append-only evaluation history: no UPDATE/DELETE path exists and a trigger rejects both", () => {
    expect(sql).toMatch(/financial_statement_evaluations_guard[\s\S]{0,300}?RAISE EXCEPTION/);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.financial_statement_evaluations/);
    expect(code()).not.toMatch(/\bUPDATE\s+public\.financial_statement_\w+\s+SET/i);
    expect(code()).not.toMatch(/\bDELETE\s+FROM\s+public\.financial_statement_/i);
  });

  it("report-version concurrency: per-report advisory lock, exact latest+1 check, conflicting replay refused", () => {
    const fn = sql.match(/CREATE OR REPLACE FUNCTION public\.save_financial_statement_report\([\s\S]*?\$\$;/)![0];
    expect(fn).toMatch(/pg_advisory_xact_lock\(hashtext\('financial_statement_reports:' \|\| p_report_id\)\)/);
    expect(fn).toMatch(/p_report_version <> COALESCE\(v_latest, 0\) \+ 1/);
    expect(fn).toMatch(/STALE_REPORT_VERSION/);
    expect(fn).toMatch(/v_row\.content_hash = p_content_hash/);
    // lock must be taken before the first read of the lineage
    expect(fn.indexOf("pg_advisory_xact_lock")).toBeLessThan(fn.indexOf("SELECT * INTO v_row"));
    // a report lineage can never move to a different company
    expect(fn).toMatch(/report % belongs to a different company/);
  });

  it("firm/company authorization: every write RPC verifies membership or lineage ownership itself", () => {
    const fns = ["save_financial_statement_report", "save_financial_statement_evaluation", "append_financial_statement_reviewer_decision"];
    for (const name of fns) {
      const fn = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$;`))![0];
      expect(fn).toMatch(/firm_members fm|financial_statement_reports fsr/);
      expect(fn).toMatch(/SET search_path = pg_catalog, public/);
    }
    // members are always "accepted", never merely invited
    expect(sql.match(/accepted_at IS NOT NULL/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it("no float monetary authority: no numeric/float/real/money column anywhere", () => {
    expect(code()).not.toMatch(/\b(NUMERIC|DECIMAL|FLOAT|REAL|DOUBLE PRECISION|MONEY)\b/i);
  });

  it("no destructive behaviour: no DROP/TRUNCATE/ALTER of existing objects, and every FK is RESTRICT", () => {
    // The only ALTER TABLE permitted is enabling RLS on the tables this migration itself creates.
    const withoutRls = code().replace(/ALTER TABLE public\.financial_statement_\w+ ENABLE ROW LEVEL SECURITY;/g, "");
    expect(withoutRls).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|FUNCTION|POLICY|TRIGGER|SCHEMA|TYPE)|TRUNCATE|ALTER\s+TABLE)\b/i);
    expect(code()).not.toMatch(/ON DELETE (CASCADE|SET NULL|SET DEFAULT)/i);
  });

  it("compatibility with current main: is the newest migration, and creates nothing another migration already created", () => {
    const names = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    expect(names[names.length - 1]).toBe("20260917000000_financial_statement_reports.sql");
    const created = [...code().matchAll(/CREATE\s+(?:OR REPLACE\s+)?(?:TABLE|FUNCTION|TRIGGER|INDEX|UNIQUE INDEX)\s+(?:IF NOT EXISTS\s+)?(?:public\.)?(\w+)/gi)].map((m) => m[1].toLowerCase());
    expect(created.length).toBeGreaterThan(10);
    for (const { f, text } of otherMigrations()) {
      for (const name of created) {
        expect(text.toLowerCase(), `${name} also created in ${f}`).not.toMatch(new RegExp(`create\\s+(?:or replace\\s+)?(?:unique\\s+)?(?:table|function|trigger|index)\\s+(?:if not exists\\s+)?(?:public\\.)?${name}\\b`));
      }
    }
  });

  it("only depends on tables that earlier migrations create (companies, firm_members)", () => {
    const referenced = new Set([...code().matchAll(/REFERENCES\s+public\.(\w+)/gi)].map((m) => m[1]));
    for (const table of referenced) {
      if (table.startsWith("financial_statement_reports")) continue;
      const defined = otherMigrations().some(({ text }) => new RegExp(`create\\s+table\\s+(?:if not exists\\s+)?public\\.${table}\\b`, "i").test(text));
      expect(defined, `${table} is not created by any other migration`).toBe(true);
    }
  });

  it("persistence stays disabled in source until the migration is applied", () => {
    const gate = fs.readFileSync(path.join(REPO_ROOT, "src/lib/financialStatementsWorkspace/persistenceGate.ts"), "utf8");
    expect(gate).toMatch(/FINANCIAL_STATEMENT_PERSISTENCE_ENABLED = false;/);
  });
});
