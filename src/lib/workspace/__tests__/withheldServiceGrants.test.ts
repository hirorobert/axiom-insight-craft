/**
 * Static contract of 20261002100000_refuse_withheld_service_grants.sql. The behaviour is proven on real PostgreSQL by
 * scripts/db-proof/serviceWithholding.mjs (clean install, upgrade with history, RPC/role/replay/concurrency refusals,
 * re-application, zero deletion); this file keeps the contract visible in the fast suite.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261002100000_refuse_withheld_service_grants.sql"), "utf8");
const SQL = MIGRATION.replace(/--[^\n]*/g, "");

describe("withheld-service grant refusal migration", () => {
  it("refuses exactly the three withheld services, on GRANT only, at the one table every grant path writes", () => {
    expect(SQL).toContain("IF NEW.action = 'GRANT' AND NEW.capability IN ('TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION') THEN");
    expect(SQL).toMatch(/CREATE OR REPLACE TRIGGER trg_refuse_withheld_service_grant\s+BEFORE INSERT ON public\.engagement_mandate_events\s+FOR EACH ROW/);
    expect(SQL).not.toMatch(/BEFORE (INSERT OR )?UPDATE|BEFORE DELETE/);
    expect(SQL).not.toMatch(/FINANCIAL_STATEMENTS|MONITORING/);
  });

  it("raises only the controlled SERVICE_NOT_AVAILABLE (PT422), with no internal wording", () => {
    expect([...SQL.matchAll(/RAISE EXCEPTION '([^']+)'/g)].map((m) => m[1])).toEqual(["SERVICE_NOT_AVAILABLE"]);
    expect([...SQL.matchAll(/ERRCODE = '([^']+)'/g)].map((m) => m[1])).toEqual(["PT422"]);
    expect(SQL).not.toMatch(/iron dome|kinga|hesabu|safisha|maono/i);
  });

  it("is forward-only and replay-safe, and changes or removes nothing", () => {
    expect(SQL).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|ALTER\s+TABLE)\b/i);
    expect(SQL).not.toMatch(/INSERT\s+INTO/i);
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.refuse_withheld_service_grant\(\)/);
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.refuse_withheld_service_grant() FROM PUBLIC, anon, authenticated, service_role;");
    expect(SQL).not.toMatch(/SECURITY DEFINER/);
    expect(SQL).toMatch(/SET search_path = pg_catalog, public/);
  });

  it("names no customer, engagement or record", () => {
    expect(MIGRATION).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("is proven in CI on a throwaway database", () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/createdb withholding_proof\n\s+node scripts\/db-proof\/serviceWithholding\.mjs/);
  });
});
