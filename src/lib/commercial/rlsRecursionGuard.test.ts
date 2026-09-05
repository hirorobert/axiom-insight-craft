/**
 * Ω1-RLS1 — regression guard for DEFECT-Ω1-COMMERCIAL-RLS-RECURSION-001.
 *
 * NON-EXECUTABLE DB BEHAVIOR NOTICE: this environment has no live Postgres
 * connection (same limitation as every other RLS/RPC guarantee in this
 * repository — see CLAUDE.md's registered defects). "Anonymous sees
 * false", "ordinary authenticated sees false", "admin sees true" are
 * genuine RLS/auth.uid() runtime behaviors that cannot be exercised by a
 * unit test without a real database. What CAN be proven here, and is
 * proven below, is the structural fact that makes those behaviors true:
 * that no policy in the live migration set queries commercial_admins
 * recursively from within its own policy, and that every former
 * "EXISTS (SELECT ... FROM commercial_admins ...)" admin branch has been
 * replaced by a call to the SECURITY DEFINER helper is_commercial_admin(),
 * which is the documented, standard fix for this exact class of Postgres
 * 42P17 error.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const OMEGA1_MIGRATION = path.join(
  __dirname,
  "../../../supabase/migrations/20260904180000_commercial_foundation_wave_omega1.sql",
);
const RLS1_MIGRATION = path.join(
  __dirname,
  "../../../supabase/migrations/20260905120000_fix_commercial_admin_rls_recursion.sql",
);

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

describe("Ω1-RLS1 forward migration exists and does not touch the live Ω1 migration", () => {
  it("the original Ω1 migration file is unmodified by this repair (still contains the original recursive EXISTS branches, proving no history rewrite)", () => {
    const sql = fs.readFileSync(OMEGA1_MIGRATION, "utf-8");
    const adminExistsBranches = (sql.match(/EXISTS \(SELECT 1 FROM public\.commercial_admins ca WHERE ca\.user_id = auth\.uid\(\) AND ca\.active\)/g) ?? []).length;
    // Six original policies each had this exact branch when Ω1 was authored.
    // This assertion is about the ORIGINAL file's own history, not about
    // runtime behavior — Ω1-RLS1 is a forward migration, never an edit to
    // this file.
    expect(adminExistsBranches).toBe(6);
  });

  it("the Ω1-RLS1 forward migration file exists and sorts after the Ω1 migration by filename", () => {
    expect(fs.existsSync(RLS1_MIGRATION)).toBe(true);
    const omega1Name = path.basename(OMEGA1_MIGRATION);
    const rls1Name = path.basename(RLS1_MIGRATION);
    expect(rls1Name > omega1Name).toBe(true);
  });
});

describe("is_commercial_admin() helper — defined with the required security properties", () => {
  const sql = stripSqlComments(fs.readFileSync(RLS1_MIGRATION, "utf-8"));

  it("is SECURITY DEFINER, STABLE, and pins search_path", () => {
    const fnMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.is_commercial_admin\(\)[\s\S]*?\$\$;/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];
    expect(fnBody).toMatch(/SECURITY DEFINER/);
    expect(fnBody).toMatch(/STABLE/);
    expect(fnBody).toMatch(/SET search_path = public, pg_catalog/);
  });

  it("takes no parameters (derives identity from auth.uid() only, never an arbitrary caller-supplied user_id)", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.is_commercial_admin\(\)\s*\n\s*RETURNS BOOLEAN/);
  });

  it("returns false for an unauthenticated caller before any query runs", () => {
    const fnMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.is_commercial_admin\(\)[\s\S]*?\$\$;/);
    expect(fnMatch![0]).toMatch(/IF v_user_id IS NULL THEN\s*\n\s*RETURN false;/);
  });

  it("is a pure read (no INSERT/UPDATE/DELETE) — cannot be used to self-escalate", () => {
    const fnMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.is_commercial_admin\(\)[\s\S]*?\$\$;/);
    const fnBody = fnMatch![0];
    expect(fnBody).not.toMatch(/INSERT INTO|UPDATE public\.|DELETE FROM/);
  });

  it("never references any accounting-authority table (orthogonality preserved)", () => {
    const fnMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.is_commercial_admin\(\)[\s\S]*?\$\$;/);
    const fnBody = fnMatch![0];
    expect(fnBody).not.toMatch(/firm_members|account_mappings|tax_computations|trial_balance_uploads|account_review_decisions/);
  });

  it("is granted to authenticated only, never to anon or PUBLIC", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.is_commercial_admin\(\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.is_commercial_admin\(\) TO authenticated;/);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.is_commercial_admin\(\) TO (PUBLIC|anon)/);
  });
});

describe("all six affected policies now use the helper, none contain a recursive commercial_admins subquery", () => {
  const sql = stripSqlComments(fs.readFileSync(RLS1_MIGRATION, "utf-8"));

  const affectedPolicies = [
    "ca_select_self_or_admin",
    "bc_select_owner_or_admin",
    "cl_select_owner_or_admin",
    "pe_select_owner_or_admin",
    "eo_select_owner_or_admin",
    "bae_select_owner_or_admin",
  ];

  it.each(affectedPolicies)("%s is rewritten via ALTER POLICY to call public.is_commercial_admin()", (policyName) => {
    const pattern = new RegExp(`ALTER POLICY "${policyName}"[\\s\\S]*?public\\.is_commercial_admin\\(\\)`);
    expect(sql).toMatch(pattern);
  });

  it("the forward migration contains zero live (non-comment) EXISTS-against-commercial_admins subqueries", () => {
    // The rollback block is comment-only and already stripped above, so any
    // remaining match here would be a live statement, not documentation.
    expect(sql).not.toMatch(/EXISTS \(SELECT 1 FROM public\.commercial_admins/);
  });

  it("commercial_admins' own policy specifically no longer self-references its own table", () => {
    const caPolicyMatch = sql.match(/ALTER POLICY "ca_select_self_or_admin" ON public\.commercial_admins\s*\n\s*USING \(([\s\S]*?)\);/);
    expect(caPolicyMatch).not.toBeNull();
    const usingClause = caPolicyMatch![1];
    expect(usingClause).not.toMatch(/commercial_admins/);
    expect(usingClause).toMatch(/is_commercial_admin\(\)/);
  });

  it("owner-scoping predicates are preserved byte-for-byte alongside the new admin branch", () => {
    expect(sql).toMatch(/owner_user_id = auth\.uid\(\)\s*\n\s*OR public\.is_commercial_admin\(\)/);
    expect(sql).toMatch(/billing_customer_id IN \(SELECT id FROM public\.billing_customers WHERE owner_user_id = auth\.uid\(\)\)\s*\n\s*OR public\.is_commercial_admin\(\)/g);
  });
});

describe("public catalogue policies are untouched (no broadened anonymous access)", () => {
  it("neither commercial_products nor commercial_plans policies are referenced by this migration", () => {
    const sql = stripSqlComments(fs.readFileSync(RLS1_MIGRATION, "utf-8"));
    expect(sql).not.toMatch(/cprod_select_public|cplan_select_public/);
  });
});
