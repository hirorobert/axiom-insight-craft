// Static contract for the two UNAPPLIED financial-statements migrations. The
// behavioural proof is scripts/db-proof/run.mjs (real PostgreSQL); this suite is
// the fast, always-on guard that the SQL text cannot silently lose a security
// property between runs of that proof.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FRAMEWORK_PROFILES } from "./frameworkProfiles";

const DIR = path.resolve(__dirname, "../../../supabase/migrations");
const ROLLOUT = "20260919100000_financial_statements_rollout_control.sql";
const PERSIST = "20260919110000_financial_statements_persistence.sql";
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
    // Later forward-only migrations (workspace setup authority, service enquiry intake, its activation-readiness hardening, discard-authority hardening) may follow; nothing else may sort between or before them.
    const LATER = ["20260920100000_workspace_setup_authority.sql", "20260921100000_service_enquiry_intake.sql", "20260922100000_service_enquiry_activation_readiness.sql", "20260922180000_discard_trial_balance_authority.sql"];
    const all = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql") && !LATER.includes(f)).sort();
    expect(all.slice(-2)).toEqual([ROLLOUT, PERSIST]);
    expect(fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort().slice(-LATER.length)).toEqual(LATER);
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
    for (const n of ["fs_actor_member_id", "fs_save_report_version", "fs_apply_correction_group", "fs_commit_revision", "fs_set_publication_state", "fs_rollout_allows", "fs_set_kill_switch", "financial_statements_workspace_access"]) {
      expect(names).toContain(n);
    }
  });

  it.each(fns.map((f) => [f.name, f.body] as const))("%s pins search_path", (_n, body) => {
    expect(body).toMatch(/SET search_path = pg_catalog, public/);
  });

  it("every client-callable writer is SECURITY DEFINER", () => {
    for (const n of ["fs_commit_revision", "fs_save_report_version", "fs_save_evaluation", "fs_append_decision", "fs_apply_correction_group", "fs_set_publication_state"]) {
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

  it("an evidence-correction step binds its decision to the exact evidence version it stores, atomically with the report version", () => {
    const g = fns.find((f) => f.name === "fs_apply_correction_group")!.body;
    for (const needle of ["newBatchId", "supersedesBatchId", "fs_ingest_evidence_internal", "INSERT INTO public.financial_statement_reports", "INSERT INTO public.financial_statement_reviewer_decisions"]) expect(g, needle).toContain(needle);
    expect(g).toMatch(/does not match the evidence version the step stores/);
  });

  it("the actor is derived from auth.uid() and never taken from an argument", () => {
    const actor = fns.find((f) => f.name === "fs_actor_member_id")!.body;
    expect(actor).toMatch(/auth\.uid\(\)/);
    expect(actor).toMatch(/fs_rollout_allows/);
    for (const { name, body } of fns) {
      const header = body.split(/\bAS \$\$/)[0];
      if (name === "fs_actor_member_id" || name === "fs_audit_event" || name === "fs_ingest_evidence_internal") continue; // internal: revoked from every client role
      expect(header, name).not.toMatch(/p_(actor|reviewer|firm_member|user)\w*/i);
    }
  });

  it("writers resolve the actor through the gate helper", () => {
    for (const n of ["fs_commit_revision", "fs_save_report_version", "fs_save_evaluation", "fs_append_decision", "fs_apply_correction_group", "fs_set_publication_state"]) {
      expect(fns.find((f) => f.name === n)?.body, n).toMatch(/fs_actor_member_id\(p_company_id\)/);
    }
  });

  it("version writers serialise with an advisory lock (ingest does so inside its internal implementation)", () => {
    for (const n of ["fs_ingest_evidence_internal", "fs_commit_revision", "fs_save_report_version", "fs_apply_correction_group", "fs_set_publication_state", "fs_append_decision"]) {
      expect(fns.find((f) => f.name === n)?.body, n).toMatch(/pg_advisory_xact_lock/);
    }
  });
});

describe("financial-statements migrations — table hardening", () => {
  const tables = [...both.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1]);

  it("creates exactly the expected eleven tables", () => {
    expect(tables.sort()).toEqual(
      [
        "financial_evidence_batches",
        "financial_statement_audit_events",
        "financial_statement_correction_groups",
        "financial_statement_framework_requirements",
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

  it("publication readiness is decided by the database: the gate calls fs_publication_blockers and no client role can call it or the internals", () => {
    const pub = fns.find((f) => f.name === "fs_set_publication_state")!.body;
    expect(pub).toMatch(/fs_publication_blockers\(/);
    expect(pub).toMatch(/BLOCKED:/);
    for (const n of ["fs_publication_blockers", "fs_unmet_reconciliation_count", "fs_audit_event", "fs_ingest_evidence_internal"]) {
      expect(both, n).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${n}\\(`));
      expect(both, n).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${n}\\([^)]*\\) TO[^;]*authenticated`));
    }
    const blockers = fns.find((f) => f.name === "fs_publication_blockers")!.body;
    for (const code of ["FRAMEWORK_UNKNOWN", "MISSING_STATEMENT:", "COMPARATIVE_PERIOD_MISSING", "COMPARATIVE_FIGURES_MISSING:", "REQUIRED_EVIDENCE_MISSING:", "EVIDENCE_NOT_VALID:", "EVIDENCE_SUPERSEDED:", "EVIDENCE_MISSING:", "NOT_EVALUATED", "BLOCKING_FINDINGS:", "RECONCILIATION_UNMET:", "NOT_LATEST_VERSION",
      "CASHFLOW_CLOSING_CASH_MISSING", "CASHFLOW_LEDGER_AUTHORITY_MISSING", "CASHFLOW_LEDGER_AUTHORITY_UNRESOLVED", "MAPPING_REVIEW_UNRECORDED", "MAPPING_UNREVIEWED:",
      "DISCLOSURE_CHECKLIST_ABSENT:", "DISCLOSURE_CHECKLIST_INCOMPLETE:", "BUDGET_COMPARISON_GAP", "BUDGET_COMPARISON_MISSING", "BUDGET_LINE_UNMATCHED:", "BUDGET_EXPLANATION_MISSING:", "BUDGET_LINE_UNREADABLE:"]) expect(blockers, code).toContain(code);
  });

  it("there is no standalone client function that accepts evidence: evidence enters only through fs_commit_revision or a correction group", () => {
    expect(persist).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fs_ingest_evidence_batch/);
    expect(persist).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.fs_ingest_evidence_(batch|internal)/);
    const internalCallers = fns.filter((f) => f.body.includes("fs_ingest_evidence_internal(") && f.name !== "fs_ingest_evidence_internal").map((f) => f.name).sort();
    expect(internalCallers).toEqual(["fs_apply_correction_group", "fs_commit_revision"]);
  });

  it("a revision is atomic and attributable: authorises first, refuses stale before any write, converges on replays, and records evidence + version + evaluation + audit", () => {
    const b = fns.find((f) => f.name === "fs_commit_revision")!.body;
    const at = (needle: string) => { const i = b.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    expect(at("fs_actor_member_id(p_company_id)")).toBeLessThan(at("fs_ingest_evidence_internal("));
    expect(at("STALE_REPORT_VERSION")).toBeLessThan(at("fs_ingest_evidence_internal("));
    expect(at("REPLAY_CONFLICT")).toBeLessThan(at("fs_ingest_evidence_internal("));
    for (const needle of ["not referenced by the report version it creates", "INSERT INTO public.financial_statement_reports", "fs_store_evaluation(", "INSERT INTO public.financial_statement_correction_groups", "'REVISION_COMMITTED'", "pg_advisory_xact_lock"]) expect(b, needle).toContain(needle);
    expect(persist).toMatch(/'REVISION_COMMITTED', 'EVALUATION_RECORDED'\)\)/); // allowed audit actions
  });

  it("framework requirements are seeded for exactly the four frameworks and are immutable", () => {
    expect(persist).toMatch(/\('IFRS',[^)]*\)/);
    for (const k of ["IFRS", "IFRS_FOR_SMES", "IPSAS_ACCRUAL", "IPSAS_CASH"]) expect(persist).toContain(`('${k}',`);
    expect(persist).toMatch(/trg_fsfr_immutable BEFORE UPDATE OR DELETE ON public\.financial_statement_framework_requirements/);
  });

  it("the database's framework requirements are the product's framework profiles: statements, evidence, disclosure areas and mapping review", () => {
    const rows = [...persist.matchAll(/\('(IFRS|IFRS_FOR_SMES|IPSAS_ACCRUAL|IPSAS_CASH)',\s*ARRAY\[([^\]]*)\],\s*(true|false),\s*ARRAY\[([^\]]*)\],\s*ARRAY\[([^\]]*)\],\s*(true|false),\s*'([\d.]+)'\)/g)];
    expect(rows.map((m) => m[1]).sort()).toEqual(["IFRS", "IFRS_FOR_SMES", "IPSAS_ACCRUAL", "IPSAS_CASH"]);
    const list = (raw: string) => [...raw.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    for (const m of rows) {
      const profile = FRAMEWORK_PROFILES[m[1] as keyof typeof FRAMEWORK_PROFILES];
      const requiredStatements = profile.expectedStatements.filter((e) => e.requirement === "REQUIRED" && e.kind !== "BUDGET_VS_ACTUAL" && e.kind !== "STATEMENT_OF_COMPREHENSIVE_INCOME").map((e) => e.kind).sort();
      expect(list(m[2]), `${m[1]} statements`).toEqual(requiredStatements);
      expect(m[3], `${m[1]} comparatives`).toBe(String(profile.comparativesRequired));
      expect(list(m[5]), `${m[1]} disclosure areas`).toEqual(profile.disclosureAreas.map((a) => a.id).sort());
      expect(m[6], `${m[1]} mapping review`).toBe(String(profile.trialBalance.status === "SUPPORTED"));
      const evidence = list(m[4]);
      if (profile.basis === "CASH") expect(evidence).toEqual(["IPSAS_CASH_RECEIPTS_PAYMENTS"]);
      else expect(evidence).toEqual(["EQUITY_MOVEMENTS", "TRANSACTION_LEDGER"]); // the cash flow and changes in equity exist only as generated from this evidence
    }
  });

  it("every reconciliation rule the database treats as mandatory exists in the rule pack, and the pack's cash rollforward is among them", () => {
    const mandatory = [...(persist.match(/f\.j ->> 'ruleId' IN \(([^)]*)\)/)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(mandatory).toContain("cashflow-account-rollforward");
    const rulesSrc = fs.readFileSync(path.resolve(__dirname, "../canonicalStatement/rules/rulePack.ts"), "utf8");
    expect(rulesSrc).toContain("cashLedgerRollforwardRule");
    for (const id of mandatory) {
      const found = fs.readdirSync(path.resolve(__dirname, "../canonicalStatement/rules")).some((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && fs.readFileSync(path.resolve(__dirname, "../canonicalStatement/rules", f), "utf8").includes(`"${id}"`));
      expect(found, id).toBe(true);
    }
  });

  it("the history tables get append-only triggers, RLS, and SELECT-only grants through the member helper", () => {
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
