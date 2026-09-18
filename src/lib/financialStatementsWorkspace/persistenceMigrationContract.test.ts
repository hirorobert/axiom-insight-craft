// Static contract for the two UNAPPLIED financial-statements migrations. The
// behavioural proof is scripts/db-proof/run.mjs (real PostgreSQL); this suite is
// the fast, always-on guard that the SQL text cannot silently lose a security
// property between runs of that proof.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../../supabase/migrations");
const ROLLOUT = "20260920000000_financial_statements_rollout_control.sql";
const PERSIST = "20260920100000_financial_statements_persistence.sql";
const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8").replace(/\r\n/g, "\n");
const rollout = read(ROLLOUT);
const persist = read(PERSIST);
const both = `${rollout}\n${persist}`;

/** Splits into `CREATE [OR REPLACE] FUNCTION ... $$;` blocks. */
function functionBlocks(sql: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\n\$\$;/g;
  for (let m = re.exec(sql); m; m = re.exec(sql)) out.push({ name: m[1], body: m[0] });
  return out;
}
const fns = [...functionBlocks(rollout), ...functionBlocks(persist)];

describe("financial-statements migrations — ordering and isolation", () => {
  it("both migrations exist and sort after every other migration", () => {
    const all = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all.slice(-2)).toEqual([ROLLOUT, PERSIST]);
  });

  it("neither migration touches a table it does not own (only the new fs tables, plus reads of companies/firm_members)", () => {
    const written = [...both.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|CREATE TABLE(?: IF NOT EXISTS)?)\s+public\.(\w+)/g)].map((m) => m[1]);
    const foreign = written.filter((t) => !/^financial_(evidence_batches|statement_\w+|statements_rollout_\w+)$/.test(t));
    expect(foreign).toEqual([]);
  });

  it("does not modify financial-engine, tax or account-mapping tables or reference result_json", () => {
    expect(both).not.toMatch(/tax_computations|account_mappings|engine_runs|statement_sign_offs|result_json/);
  });

  it("never names a hosted project or embeds a credential", () => {
    expect(both).not.toMatch(/bvyivmmfjejbmqoydezk|service_role_key|eyJ[A-Za-z0-9_-]{20,}|password\s*=/i);
  });
});

describe("financial-statements migrations — function hardening", () => {
  it("finds the expected function set", () => {
    const names = fns.map((f) => f.name).sort();
    for (const n of ["fs_actor_member_id", "fs_save_report_version", "fs_apply_correction_group", "fs_ingest_evidence_batch", "fs_set_publication_state", "fs_rollout_allows", "fs_set_kill_switch", "financial_statements_workspace_access"]) {
      expect(names).toContain(n);
    }
  });

  it.each(fns.map((f) => [f.name, f.body] as const))("%s pins search_path", (_n, body) => {
    expect(body).toMatch(/SET search_path = pg_catalog, public/);
  });

  it("every client-callable writer is SECURITY DEFINER", () => {
    for (const n of ["fs_ingest_evidence_batch", "fs_save_report_version", "fs_save_evaluation", "fs_append_decision", "fs_apply_correction_group", "fs_set_publication_state"]) {
      expect(fns.find((f) => f.name === n)?.body, n).toMatch(/SECURITY DEFINER/);
    }
  });

  it("no function grants EXECUTE to anon or PUBLIC, and every function is revoked from them first", () => {
    expect(both).not.toMatch(/GRANT\s+EXECUTE[^;]*\bTO\b[^;]*\b(anon|PUBLIC)\b/i);
    expect(both).not.toMatch(/GRANT\s+(?:ALL|INSERT|UPDATE|DELETE|TRUNCATE)[^;]*ON\s+public\.financial[^;]*TO[^;]*\b(anon|authenticated|PUBLIC)\b/i);
    for (const { name } of fns) {
      if (name === "fs_append_only_guard" || name === "fs_rollout_audit_guard") continue; // trigger functions
      expect(both, name).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(`));
    }
  });

  it("operator controls are service_role only and re-check the role inside the function body", () => {
    for (const n of ["fs_set_company_rollout", "fs_set_kill_switch"]) {
      expect(both).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}\\([^)]*\\) TO service_role;`));
      expect(fns.find((f) => f.name === n)?.body).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
    }
  });

  it("the actor is derived from auth.uid() and never taken from an argument", () => {
    const actor = fns.find((f) => f.name === "fs_actor_member_id")!.body;
    expect(actor).toMatch(/auth\.uid\(\)/);
    expect(actor).toMatch(/fs_rollout_allows/);
    for (const { name, body } of fns) {
      const header = body.split(/\bAS \$\$/)[0];
      if (name === "fs_actor_member_id") continue;
      expect(header, name).not.toMatch(/p_(actor|reviewer|firm_member|user)\w*/i);
    }
  });

  it("writers resolve the actor through the gate helper", () => {
    for (const n of ["fs_ingest_evidence_batch", "fs_save_report_version", "fs_save_evaluation", "fs_append_decision", "fs_apply_correction_group", "fs_set_publication_state"]) {
      expect(fns.find((f) => f.name === n)?.body, n).toMatch(/fs_actor_member_id\(p_company_id\)/);
    }
  });

  it("version writers serialise with an advisory lock", () => {
    for (const n of ["fs_ingest_evidence_batch", "fs_save_report_version", "fs_apply_correction_group", "fs_set_publication_state", "fs_append_decision"]) {
      expect(fns.find((f) => f.name === n)?.body, n).toMatch(/pg_advisory_xact_lock/);
    }
  });
});

describe("financial-statements migrations — table hardening", () => {
  const tables = [...both.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1]);

  it("creates exactly the expected nine tables", () => {
    expect(tables.sort()).toEqual(
      [
        "financial_evidence_batches",
        "financial_statement_correction_groups",
        "financial_statement_evaluations",
        "financial_statement_publications",
        "financial_statement_reports",
        "financial_statement_reviewer_decisions",
        "financial_statements_rollout_audit",
        "financial_statements_rollout_companies",
        "financial_statements_rollout_state",
      ].sort(),
    );
  });

  it("uses no floating-point or numeric money column types", () => {
    expect(both).not.toMatch(/\b(FLOAT|DOUBLE PRECISION|REAL|NUMERIC|DECIMAL|MONEY)\b\s*(?:\(|,|NOT|NULL|DEFAULT|\n)/i);
  });

  it("history tables use ON DELETE RESTRICT and never CASCADE (the allowlist row alone may cascade)", () => {
    const withoutAllowlist = persist;
    expect(withoutAllowlist).not.toMatch(/ON DELETE CASCADE/);
    expect(withoutAllowlist).not.toMatch(/ON DELETE SET NULL/);
  });

  it("the six history tables get append-only triggers, RLS, and SELECT-only grants through the member helper", () => {
    expect(persist).toMatch(/BEFORE UPDATE OR DELETE ON public\.%I FOR EACH ROW EXECUTE FUNCTION public\.fs_append_only_guard/);
    expect(persist).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(persist).toMatch(/GRANT SELECT ON public\.%I TO authenticated/);
    expect(persist).toMatch(/get_member_company_ids\(\)/);
    // The policy must not query firm_members directly (authenticated has no SELECT on it).
    expect(persist).not.toMatch(/CREATE POLICY[\s\S]{0,200}FROM public\.firm_members/);
  });

  it("the rollout tables have RLS enabled and no client grants", () => {
    expect(rollout.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(3);
    expect(rollout).not.toMatch(/GRANT[^;]*ON public\.financial_statements_rollout_\w+ TO[^;]*(authenticated|anon)/);
  });

  it("the rollout defaults to denied", () => {
    expect(rollout).toMatch(/kill_switch\s+BOOLEAN\s+NOT NULL DEFAULT false/);
    expect(rollout).toMatch(/enabled\s+BOOLEAN\s+NOT NULL DEFAULT false/);
    expect(rollout).toMatch(/COALESCE\(\(SELECT c\.enabled[^)]*\), false\)/);
  });
});
