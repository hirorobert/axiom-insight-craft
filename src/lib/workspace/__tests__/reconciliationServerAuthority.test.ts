/**
 * Static contract of 20261004100000_reconciliation_server_authority.sql and the two functions that use it. The behaviour is
 * proven on real PostgreSQL by scripts/db-proof/reconciliationAuthority.mjs (upgrade byte-identical, client writes
 * unchanged, derived counts, escalated/rejected unresolved, forgery refused per role, MAONO gate, re-apply); this file keeps
 * the contract visible in the fast suite.
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

describe("reconciliation server authority migration", () => {
  it("completeness: at least one trial-balance line, nothing pending, escalated or rejected, every line matched or approved", () => {
    expect(SQL).toContain("(total > 0 AND pending = 0 AND escalated = 0 AND rejected = 0 AND matched + approved = total)");
    expect(SQL).toContain("count(x.*) FILTER (WHERE x.reviewer_action <> 'approved') AS unresolved");
  });

  it("the resolver marks 'clean' only when complete; otherwise blocked (rejected investigate) or needs_review", () => {
    const resolver = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION public.safisha_resolve_exception"), SQL.indexOf("CREATE OR REPLACE FUNCTION public.safisha_reconciliation_authority"));
    expect(resolver).toMatch(/ELSIF public\.safisha_reconciliation_complete\(v_exception\.reconciliation_id\) THEN\s+UPDATE safisha_reconciliations SET\s+status\s+= 'clean'/);
    expect(resolver).toMatch(/ELSE\s+UPDATE safisha_reconciliations SET status = 'needs_review'/);
    // 'clean' is written exactly twice — the reconciliation and its upload — both inside the complete branch.
    const complete = resolver.slice(resolver.indexOf("ELSIF public.safisha_reconciliation_complete"), resolver.search(/ELSE\s+UPDATE safisha_reconciliations SET status = 'needs_review'/));
    expect([...resolver.matchAll(/status\s*=\s*'clean'/g)]).toHaveLength(2);
    expect([...complete.matchAll(/status\s*=\s*'clean'/g)]).toHaveLength(2);
  });

  it("client roles cannot write results or readiness; no writer records an incomplete 'clean'", () => {
    expect(SQL).toContain("IF current_user IN ('authenticated', 'anon') THEN");
    expect(SQL).toContain("NEW.status NOT IN ('processing', 'needs_review')");
    expect(SQL).toContain("IF current_user IN ('authenticated', 'anon') AND NEW.safisha_status IN ('clean', 'blocked') THEN");
    expect(SQL).toContain("IF NEW.safisha_status = 'clean' AND NOT public.safisha_upload_reconciliation_complete(NEW.id) THEN");
    expect(SQL).toMatch(/CREATE TRIGGER ab_reconciliation_authority BEFORE INSERT OR UPDATE ON public\.safisha_reconciliations/);
    expect(SQL).toMatch(/CREATE TRIGGER ab_upload_reconciliation_status_authority BEFORE INSERT OR UPDATE OF safisha_status ON public\.trial_balance_uploads/);
  });

  it("the guards run after the existing write wall (trigger names sort after aa_reconciliation_write_wall)", () => {
    expect("ab_reconciliation_authority" > "aa_reconciliation_write_wall").toBe(true);
  });

  it("grants: the match RPC and the resolver are service-role only; trigger functions are not callable by clients", () => {
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.safisha_record_match_result(uuid, uuid) FROM PUBLIC, anon, authenticated;");
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION public.safisha_record_match_result(uuid, uuid) TO service_role;");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.safisha_reconciliation_authority() FROM PUBLIC, anon, authenticated;");
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.safisha_upload_status_authority() FROM PUBLIC, anon, authenticated;");
  });

  it("is forward-only and replay-safe: no row read-modified or removed, no table altered", () => {
    expect(SQL).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+(TABLE|FUNCTION|POLICY))\b/i);
    // The only insert is the resolver's existing append-only audit row.
    expect([...SQL.matchAll(/INSERT\s+INTO\s+([\w.]+)/gi)].map((m) => m[1])).toEqual(["safisha_audit_log"]);
    expect([...SQL.matchAll(/DROP TRIGGER IF EXISTS (\w+)/g)].map((m) => m[1])).toEqual(["ab_reconciliation_authority", "ab_upload_reconciliation_status_authority"]);
    expect(MIGRATION).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("is proven in CI on a throwaway database", () => {
    expect(read(".github/workflows/ci.yml")).toContain("run: node scripts/db-proof/reconciliationAuthority.mjs");
  });
});

describe("reconciliation functions", () => {
  it("safisha-match records its result through the service-role RPC with the JWT user as the actor", () => {
    expect(MATCH).toContain('admin.rpc("safisha_record_match_result", {\n      p_recon_id: reconciliation_id,\n      p_actor:    user.id,');
    // The legacy client writes remain only as the fallback for a database the migration has not reached yet.
    expect(MATCH).toMatch(/recordErr\.code === "PGRST202" \|\| recordErr\.code === "42883"/);
  });

  it("safisha-resolve calls the service-role-only resolver with the JWT user as the reviewer", () => {
    expect(RESOLVE).toMatch(/const admin = createClient\(Deno\.env\.get\("SUPABASE_URL"\)!, Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)!\);\s+const \{ data: resolveResult, error: resolveErr \} = await admin\.rpc\(/);
    expect(RESOLVE).toContain("p_reviewer_id:  user.id,");
  });
});
