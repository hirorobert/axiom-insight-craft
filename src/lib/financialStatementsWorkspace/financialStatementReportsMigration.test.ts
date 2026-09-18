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
import { execSync } from "node:child_process";
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

// ─── SECURITY DEFINER / RPC proof ────────────────────────────────────────────
// Static, non-executing: every function is parsed out of the real SQL text, so a
// function added later cannot slip past these invariants.

interface ParsedFn {
  name: string;
  signature: string;
  body: string;
  full: string;
  definer: boolean;
}

function parseFunctions(sqlText: string): ParsedFn[] {
  const out: ParsedFn[] = [];
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\)\s+RETURNS[\s\S]*?\$\$;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sqlText))) {
    const full = m[0];
    out.push({ name: m[1], signature: m[2], body: full.slice(full.indexOf("$$")), full, definer: /SECURITY DEFINER/.test(full) });
  }
  return out;
}

const RPCS = ["save_financial_statement_report", "save_financial_statement_evaluation", "append_financial_statement_reviewer_decision"] as const;

describe("financial_statement_reports migration — SECURITY DEFINER / RPC security proof", () => {
  const code = () => sql.replace(/--.*$/gm, "");
  const fns = () => parseFunctions(code());
  const definers = () => fns().filter((f) => f.definer);

  it("the complete set of SECURITY DEFINER functions is exactly the helper plus the three RPCs (no others can be added silently)", () => {
    expect(definers().map((f) => f.name).sort()).toEqual([...RPCS, "fsr_actor_member_id"].sort());
  });

  it("every SECURITY DEFINER function pins search_path = pg_catalog, public", () => {
    for (const f of definers()) expect(f.full, f.name).toMatch(/SET search_path = pg_catalog, public/);
  });

  it("the trigger guard functions also pin search_path (and are not SECURITY DEFINER)", () => {
    for (const f of fns().filter((x) => !x.definer)) {
      expect(f.full, f.name).toMatch(/SET search_path = pg_catalog, public/);
    }
  });

  it("no function accepts actor authority as an argument (no member/actor/reviewer/user/uid parameter)", () => {
    for (const f of fns()) expect(f.signature, f.name).not.toMatch(/firm_member|member_id|actor|reviewer|created_by|user_id|\buid\b/i);
  });

  it("the actor is derived server-side: the helper reads auth.uid(), refuses null, and requires accepted membership of the company", () => {
    const helper = fns().find((f) => f.name === "fsr_actor_member_id")!;
    expect(helper.body).toMatch(/auth\.uid\(\)/);
    expect(helper.body).toMatch(/v_uid IS NULL[\s\S]{0,120}?RAISE EXCEPTION[\s\S]{0,80}?42501/);
    expect(helper.body).toMatch(/fm\.user_id = v_uid/);
    expect(helper.body).toMatch(/fm\.company_id = p_company_id/);
    expect(helper.body).toMatch(/fm\.accepted_at IS NOT NULL/);
    expect(helper.body).toMatch(/v_member IS NULL[\s\S]{0,120}?RAISE EXCEPTION[\s\S]{0,120}?42501/);
  });

  it("every RPC resolves the actor through the helper first, before touching any table", () => {
    for (const name of RPCS) {
      const f = fns().find((x) => x.name === name)!;
      const helperAt = f.body.indexOf("public.fsr_actor_member_id(p_company_id)");
      expect(helperAt, name).toBeGreaterThan(-1);
      const firstTable = f.body.search(/(FROM|INTO|UPDATE|DELETE FROM)\s+public\.financial_statement_/);
      expect(helperAt, name).toBeLessThan(firstTable);
    }
  });

  it("no function trusts a session identity other than auth.uid() (no auth.users, current_user, session_user, service_role, or JWT-claim reads)", () => {
    for (const f of definers()) {
      expect(f.body, f.name).not.toMatch(/auth\.users|current_user|session_user|service_role|request\.jwt|current_setting/i);
    }
  });

  it("the stored decision never carries a client-supplied actor: reviewerId is stripped and the reviewer column is the derived member", () => {
    const f = fns().find((x) => x.name === "append_financial_statement_reviewer_decision")!;
    expect(f.body).toMatch(/v_clean JSONB := p_decision - 'reviewerId'/);
    expect(f.body).toMatch(/VALUES \(\s*p_decision_id, p_report_id, p_company_id, v_clean, v_actor\s*\)/);
  });

  it("cross-company access is rejected in every RPC (membership, lineage ownership, and report-belongs-to-company)", () => {
    const save = fns().find((x) => x.name === "save_financial_statement_report")!;
    expect(save.body.match(/is not accessible to this company/g)!.length).toBeGreaterThanOrEqual(2);
    expect(save.body).toMatch(/v_latest\.company_id <> p_company_id/);
    expect(save.body).toMatch(/v_row\.company_id <> p_company_id/);
    const ev = fns().find((x) => x.name === "save_financial_statement_evaluation")!;
    expect(ev.body).toMatch(/fsr\.company_id = p_company_id/);
    const dec = fns().find((x) => x.name === "append_financial_statement_reviewer_decision")!;
    expect(dec.body).toMatch(/fsr\.company_id = p_company_id/);
  });

  it("report versions: transaction advisory lock BEFORE any read, exact latest+1, exact replay, conflicting replay refused (PT409)", () => {
    const f = fns().find((x) => x.name === "save_financial_statement_report")!;
    expect(f.body).toMatch(/pg_advisory_xact_lock\(hashtext\('financial_statement_reports:' \|\| p_report_id\)\)/);
    expect(f.body.indexOf("pg_advisory_xact_lock")).toBeLessThan(f.body.search(/SELECT \* INTO v_row/));
    expect(f.body).toMatch(/p_report_version <> COALESCE\(v_latest\.report_version, 0\) \+ 1/);
    expect(f.body).toMatch(/v_row\.company_id = p_company_id AND v_row\.content_hash = p_content_hash[\s\S]{0,40}?RETURN v_row/);
    expect(f.body).toMatch(/STALE_REPORT_VERSION[\s\S]{0,160}?PT409/);
    expect(f.body).toMatch(/cannot change its period or provenance origin/);
  });

  it("evaluations and decisions: serialised by advisory lock, exact replay returns the stored row, any other replay is REPLAY_CONFLICT (PT409)", () => {
    for (const name of ["save_financial_statement_evaluation", "append_financial_statement_reviewer_decision"]) {
      const f = fns().find((x) => x.name === name)!;
      expect(f.body, name).toMatch(/pg_advisory_xact_lock\(hashtext\(/);
      expect(f.body.indexOf("pg_advisory_xact_lock"), name).toBeLessThan(f.body.search(/SELECT \* INTO v_row/));
      expect(f.body, name).toMatch(/REPLAY_CONFLICT[\s\S]{0,160}?PT409/);
    }
    const ev = fns().find((x) => x.name === "save_financial_statement_evaluation")!;
    expect(ev.body).toMatch(/v_row\.input_hash = p_input_hash[\s\S]{0,60}?v_row\.findings = p_findings/);
    const dec = fns().find((x) => x.name === "append_financial_statement_reviewer_decision")!;
    expect(dec.body).toMatch(/v_row\.decision = v_clean/);
  });

  it("no RPC swallows a unique violation to fake success (serialisation replaces the old retry-and-return handler)", () => {
    expect(code()).not.toMatch(/EXCEPTION\s+WHEN\s+unique_violation/i);
  });

  it("grants: every RPC is revoked from PUBLIC, anon and authenticated, then granted to authenticated ONLY; the helper has no grant at all", () => {
    for (const name of RPCS) {
      expect(code(), name).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
      expect(code(), name).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO authenticated;`));
    }
    expect(code()).toMatch(/REVOKE ALL ON FUNCTION public\.fsr_actor_member_id\(UUID\) FROM PUBLIC, anon, authenticated;/);
    expect(code()).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.fsr_actor_member_id/);
    // The complete list of GRANT targets anywhere in the file:
    const targets = [...code().matchAll(/GRANT\s+[\w, ]+\s+ON\s+[\s\S]*?\s+TO\s+(\w+)\s*;/gi)].map((m) => m[1].toLowerCase());
    expect(new Set(targets)).toEqual(new Set(["authenticated"]));
    expect(code()).not.toMatch(/\bTO\s+(PUBLIC|anon|service_role)\b/i);
  });

  it("the client contract matches: no write request carries an actor and the Edge Function is documented to use the caller's JWT", () => {
    expect(sql).toMatch(/CALLER's JWT \(never a service-role/);
    const contract = fs.readFileSync(path.join(REPO_ROOT, "src/lib/financialStatementsWorkspace/persistenceContract.ts"), "utf8");
    expect(contract).toMatch(/caller's own JWT/);
  });

  const gitOut = (args: string): string | null => {
    try {
      return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  const baseRef = gitOut("rev-parse --verify --quiet origin/main") === null ? null : "origin/main";

  it.skipIf(baseRef === null)("no historical migration is edited, renamed or deleted: the only change under supabase/migrations is this one added file", () => {
    const status = (gitOut(`diff --name-status ${baseRef}...HEAD -- supabase/migrations supabase/migrations_historical`) ?? "").trim();
    const lines = status === "" ? [] : status.split(/\r?\n/);
    for (const line of lines) expect(line, "only additions are allowed").toMatch(/^A\t/);
    const added = lines.map((l) => l.split("\t")[1]);
    for (const f of added) expect(f).toBe("supabase/migrations/20260917000000_financial_statement_reports.sql");
  });
});
