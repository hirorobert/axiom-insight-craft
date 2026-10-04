/**
 * Static contract of 20261004100000_reconciliation_server_authority.sql and the two functions that use it. The behaviour is
 * proven on real PostgreSQL by scripts/db-proof/reconciliationAuthority.mjs (upgrade byte-identical, client writes
 * unchanged, findings validated, derived counts, escalated/rejected unresolved, senior decision, freshness, concurrency,
 * forgery refused per role, MAONO gate, re-apply) and scripts/db-proof/reconciliationFunctionMatrix.mjs (the real old
 * and new handlers against the old and new schema); this file keeps the contract visible in the fast suite.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const MIGRATION = read("supabase/migrations/20261004100000_reconciliation_server_authority.sql");
const SQL = MIGRATION.replace(/--[^\n]*/g, "");
const MATCH = read("supabase/functions/safisha-match/index.ts");
const RESOLVE = read("supabase/functions/safisha-resolve/index.ts");
const fnBody = (name: string) => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  return SQL.slice(start, SQL.indexOf("$$;", SQL.indexOf("AS $", start)) + 3);
};

describe("reconciliation server authority migration", () => {
  it("completeness: recorded lines only, every line matched or approved, nothing pending, escalated or rejected", () => {
    expect(SQL).toContain("(total > 0 AND recorded IS NOT DISTINCT FROM total AND pending = 0 AND escalated = 0 AND rejected = 0\n          AND matched + approved = total)");
    expect(SQL).toContain("count(x.*) FILTER (WHERE x.reviewer_action <> 'approved') AS unresolved");
  });

  it("one verdict for every writer: rejected investigate → blocked, complete → clean, otherwise needs_review", () => {
    expect(fnBody("_safisha_record_verdict")).toContain("v_status := CASE WHEN v_cov.rejected_investigate > 0 THEN 'blocked' WHEN v_cov.complete THEN 'clean' ELSE 'needs_review' END;");
    expect(fnBody("safisha_record_match_result")).toContain("v_status := public._safisha_record_verdict(p_recon_id, v_total);");
    expect(fnBody("safisha_decide_exception")).toContain("v_status := public._safisha_record_verdict(v_recon_id);");
    // The resolver no longer writes a status of its own.
    expect(fnBody("safisha_decide_exception")).not.toMatch(/status\s*=\s*'clean'/);
  });

  it("match and decision take the reconciliation lock first (no deadlock between them)", () => {
    expect(fnBody("safisha_record_match_result")).toMatch(/SELECT \* INTO v_recon FROM public\.safisha_reconciliations WHERE id = p_recon_id FOR UPDATE;/);
    const decide = fnBody("safisha_decide_exception");
    expect(decide.indexOf("FROM public.safisha_reconciliations WHERE id = v_recon_id FOR UPDATE")).toBeLessThan(decide.indexOf("FROM public.safisha_exceptions WHERE id = p_exception_id FOR UPDATE"));
    expect(fnBody("safisha_reconciliation_freshness")).toContain("FOR UPDATE");
  });

  it("findings are validated against the reconciliation's own rows and recorded once", () => {
    const match = fnBody("safisha_record_match_result");
    expect(match).toContain("id = v_tb AND reconciliation_id = p_recon_id AND source_id = 'tb'");
    expect(match).toContain("id = v_ev AND reconciliation_id = p_recon_id AND source_id <> 'tb'");
    expect(match).toContain("v_existing := v_existing + 1;");
  });

  it("an escalated exception is decided only by a different holder of review_close; approved and rejected stay final", () => {
    const decide = fnBody("safisha_decide_exception");
    expect(decide).toContain("PERFORM public._safisha_authorize(v_recon_id, p_reviewer_id, 'review_close');");
    expect(decide).toContain("SEPARATE_REVIEWER_REQUIRED");
    expect(fnBody("safisha_enforce_resolve_gate")).toContain("OR (OLD.reviewer_action = 'escalated' AND NEW.reviewer_action IN ('approved', 'rejected'))");
  });

  it("client roles cannot write results, readiness or exceptions; no writer records an incomplete 'clean'", () => {
    expect(SQL).toContain("NEW.status NOT IN ('processing', 'needs_review')");
    expect(SQL).toContain("IF current_user IN ('authenticated', 'anon') AND NEW.safisha_status IN ('clean', 'blocked') THEN");
    expect(SQL).toContain("IF NEW.safisha_status = 'clean' AND NOT public.safisha_upload_reconciliation_complete(NEW.id) THEN");
    expect(SQL).toContain("RECONCILIATION_RESULT_SERVER_ONLY: exceptions are recorded by the server");
    expect(SQL).toMatch(/CREATE TRIGGER ab_reconciliation_authority BEFORE INSERT OR UPDATE ON public\.safisha_reconciliations/);
    expect(SQL).toMatch(/CREATE TRIGGER ab_upload_reconciliation_status_authority BEFORE INSERT OR UPDATE OF safisha_status ON public\.trial_balance_uploads/);
    expect(SQL).toMatch(/CREATE TRIGGER ab_exception_authority BEFORE INSERT ON public\.safisha_exceptions/);
    // The guards sort after the existing write wall, so its plan and capability refusals come first.
    expect("ab_reconciliation_authority" > "aa_reconciliation_write_wall").toBe(true);
  });

  it("grants: match, decision and the legacy resolver are service-role only; helpers and triggers are not callable", () => {
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION public.safisha_record_match_result(uuid, uuid, jsonb) TO service_role;");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.safisha_record_match_result(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.safisha_decide_exception(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public._safisha_record_verdict(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public._safisha_authorize(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;");
    expect(SQL).toContain("REVOKE TRUNCATE ON public.safisha_reconciliations, public.safisha_transactions, public.safisha_exceptions, public.safisha_audit_log FROM anon, authenticated;");
  });

  it("is forward-only and replay-safe: no row removed, no table altered, only the established inserts", () => {
    expect(SQL).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE\s+(TABLE\s+)?public|ALTER\s+TABLE|DROP\s+(TABLE|FUNCTION|POLICY))\b/i);
    expect([...SQL.matchAll(/INSERT\s+INTO\s+([\w.]+)/gi)].map((m) => m[1]).sort()).toEqual(["public.safisha_audit_log", "public.safisha_exceptions"]);
    expect([...SQL.matchAll(/DROP TRIGGER IF EXISTS (\w+)/g)].map((m) => m[1])).toEqual(["ab_reconciliation_authority", "ab_upload_reconciliation_status_authority", "ab_exception_authority", "ac_reconciliation_freshness", "ac_reconciliation_freshness"]);
    expect(MIGRATION).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("is proven in CI on throwaway databases", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("run: node scripts/db-proof/reconciliationAuthority.mjs");
    expect(ci).toContain("run: bun scripts/db-proof/reconciliationFunctionMatrix.mjs");
  });
});

describe("reconciliation functions", () => {
  it("safisha-match records its run through the service-role RPC with the JWT user as the actor, and has no fallback", () => {
    expect(MATCH).toContain('admin.rpc("safisha_record_match_result", {\n      p_recon_id:   reconciliation_id,\n      p_actor:      user.id,\n      p_exceptions: exceptions,');
    expect(MATCH).not.toMatch(/\.from\("safisha_exceptions"\)\s*\.(insert|delete)/);
    expect(MATCH).not.toMatch(/\.from\("(safisha_reconciliations|trial_balance_uploads)"\)\s*\.update/);
  });

  it("safisha-resolve decides through the service-role-only decision with the JWT user as the reviewer", () => {
    expect(RESOLVE).toMatch(/const admin = createClient\(Deno\.env\.get\("SUPABASE_URL"\)!, Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)!\);\s+const \{ data: resolveResult, error: resolveErr \} = await admin\.rpc\(\s+"safisha_decide_exception",/);
    expect(RESOLVE).toContain("p_reviewer_id:  user.id,");
  });
});
