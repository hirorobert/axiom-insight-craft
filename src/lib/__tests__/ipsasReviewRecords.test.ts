/**
 * The release records must describe the candidate as it is (independent review finding 3): no stale "no transport" / "no authenticated journey" claims,
 * the review package and the carry live in version control, and the evidence categories are reported separately rather than inflated.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const dir = "docs/release/ipsas-accrual-chain-r1";
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

describe("IPSAS release records", () => {
  it("no document still says that no installation transport or no authenticated journey exists", () => {
    for (const f of ["RECORD.md", "GRANTS.md", "TRANSPORT.md", "GRANTS_TRANSPORT.md"]) {
      const text = read(`${dir}/${f}`);
      for (const stale of ["no installation transport yet", "no staged transport exists for", "no authenticated end-to-end acceptance", "browser journey on a local Supabase stack**, **hosted"]) expect(text, `${f}: ${stale}`).not.toContain(stale);
    }
  });
  it("the review package is committed and states the findings, the evidence categories and what is not proven", () => {
    const p = read(`${dir}/REVIEW_PACKAGE.md`);
    for (const needle of ["Independent review findings", "CONFIRMED", "Setup assertions - 6", "Product acceptance assertions - 37", "not 37 independent user scenarios", "Operator/service-role integrity check - 1", "Recorded limitation (gap record) - 1",
      "Accountant acceptance - **none**", "not proven", "bearer credential", "bounded IPSAS preparation increment"]) expect(p, needle).toContain(needle);
    // the numbered list tags the first six checks as setup and the rest as acceptance, 43 in all
    expect((p.match(/\[SETUP\]/g) ?? []).length).toBe(6);
    expect((p.match(/\[ACCEPTANCE\]/g) ?? []).length).toBe(37);
  });
  it("the carry is committed with its verifier, and the authority contract and its proof are recorded", () => {
    expect(fs.existsSync(path.join(ROOT, `${dir}/carry/ipsas-auth-journey.carry.patch`))).toBe(true);
    const patch = read(`${dir}/carry/ipsas-auth-journey.carry.patch`);
    expect(patch).toContain("scripts/e2e/ipsasAuthJourney.mjs");
    expect(patch).toContain("src/lib/__tests__/ipsasAuthJourney.test.ts");
    expect(read("scripts/release/verifyCarry.mjs")).toContain("CARRY_VERIFIED");
    const c = read(`${dir}/AUTHORITY_ORDERING.md`);
    for (const needle of ["CONFIRMED", "request -> company-period -> member-capability (S) -> plan (S, re-entrant) -> named-user seats (S) -> framework (S) -> rollout (try, never waits)", "Ordering guarantee", "Replays are covered", "Fail closed"]) expect(c, needle).toContain(needle);
  });
  it("the migrations contain the boundary check in all four mutation functions, before any replay lookup", () => {
    for (const [file, fns] of [["supabase/migrations/20261207100000_ipsas_accrual_preparation.sql", ["ipsas_save_preparation", "ipsas_confirm"]], ["supabase/migrations/20261208100000_ipsas_grants.sql", ["ipsas_save_grants", "ipsas_confirm_grant"]]] as const) {
      const sql = read(file);
      for (const fn of fns) {
        const start = sql.indexOf(`CREATE FUNCTION public.${fn}(`);
        const body = sql.slice(start, sql.indexOf("\n$$;", start));
        const boundary = body.indexOf("_ipsas_authorize_mutation");
        const replay = body.search(/SELECT \* INTO v_prior/);
        const locks = body.lastIndexOf("pg_advisory_xact_lock");
        expect(boundary, fn).toBeGreaterThan(locks);
        expect(boundary, fn).toBeLessThan(replay);
      }
    }
  });
});
