/**
 * H2 characterization gate rules (scripts/db-proof/lib/defectLedger.mjs) and the registered ledger
 * (scripts/db-proof/fixtures/h2-known-defects.json). A reproduced defect is never a pass; a silently fixed defect, a different
 * wrong value, a missing or unregistered probe, a failed or missing requirement, and any infrastructure failure all fail.
 * The behaviour itself is proven by scripts/db-proof/tbHandlerCharacterization.mjs (real handler, real PostgreSQL).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canon, classifyProbe, gateVerdict, validateLedger } from "../../../scripts/db-proof/lib/defectLedger.mjs";
import { jwtSubject, makeClient, mintTestJwt } from "../../../scripts/db-proof/lib/functionHarness.mjs";

const ROOT = path.join(__dirname, "../../../");
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/db-proof/fixtures/h2-known-defects.json"), "utf8"));

describe("classifyProbe", () => {
  const signature = { cash_total: 30500 };
  const oracle = { cash_total: 60500 };
  it("reproduced only on an exact signature match that differs from the oracle", () => {
    expect(classifyProbe({ observed: { cash_total: 30500 }, signature, oracle })).toBe("reproduced");
  });
  it("matching the oracle is 'fixed' (fails until the ledger entry is removed)", () => {
    expect(classifyProbe({ observed: { cash_total: 60500 }, signature, oracle })).toBe("fixed");
  });
  it("any other value is a mismatch — including a near miss, an extra field, a type change or a missing field", () => {
    for (const observed of [{ cash_total: 30501 }, { cash_total: 30500, extra: 1 }, { cash_total: "30500" }, {}, null]) {
      expect(classifyProbe({ observed, signature, oracle }), JSON.stringify(observed)).toBe("mismatch");
    }
  });
  it("key order does not matter; array order does", () => {
    expect(canon({ b: 1, a: { d: 2, c: 3 } })).toBe(canon({ a: { c: 3, d: 2 }, b: 1 }));
    expect(classifyProbe({ observed: { x: [2, 1] }, signature: { x: [1, 2] }, oracle: { x: [] } })).toBe("mismatch");
  });
});

describe("validateLedger", () => {
  it("the committed ledger is valid and EMPTY since E2 (every registered defect fixed), and names the engines still run", () => {
    expect(() => validateLedger(ledger)).not.toThrow();
    expect(ledger.defects).toEqual([]);
    expect(ledger.engine_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ledger.e1_engine_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ledger.handler_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("an empty list is valid; a missing or non-array list is not", () => {
    expect(() => validateLedger({ defects: [] })).not.toThrow();
    expect(() => validateLedger({})).toThrow();
    expect(() => validateLedger({ defects: {} })).toThrow();
  });
  it("refuses incomplete, null-signature, blank-assertion and duplicate entries", () => {
    const base = { defect: "D7", probe: "P", assertion: "a", signature: { x: 1 } };
    for (const bad of [{ ...base, signature: null }, { ...base, assertion: " " }, { ...base, probe: undefined }, { ...base, defect: undefined }]) {
      expect(() => validateLedger({ defects: [bad] })).toThrow();
    }
    expect(() => validateLedger({ defects: [base, base] })).toThrow(/twice/);
    // Since E2 an empty list is a valid ledger (no registered defect); see the next block for what is still refused.
    expect(() => validateLedger({ defects: [] })).not.toThrow();
  });
});

describe("gateVerdict", () => {
  const base = () => ({
    requiredRequirements: ["R1", "R2"], requirementResults: new Map([["R1", true], ["R2", true]]),
    registeredProbes: ["P1", "P2"], probeResults: new Map([["P1", "reproduced"], ["P2", "reproduced"]]), infrastructureFailure: false,
  });
  it("passes only when requirements pass and every registered probe is reproduced", () => {
    expect(gateVerdict(base()).ok).toBe(true);
    expect(gateVerdict(base()).reproduced).toEqual(["P1", "P2"]);
  });
  it("fails on a failed requirement, a requirement that did not run, or an infrastructure failure", () => {
    const a = base(); a.requirementResults.set("R2", false); expect(gateVerdict(a).ok).toBe(false);
    const b = base(); b.requirementResults.delete("R2"); expect(gateVerdict(b)).toMatchObject({ ok: false, missingRequirements: ["R2"] });
    const c = base(); c.infrastructureFailure = true; expect(gateVerdict(c).ok).toBe(false);
  });
  it("fails on a fixed, mismatched, errored, missing or unregistered probe", () => {
    for (const s of ["fixed", "mismatch", "error"]) { const g = base(); g.probeResults.set("P2", s); expect(gateVerdict(g).ok, s).toBe(false); }
    const m = base(); m.probeResults.delete("P2"); expect(gateVerdict(m)).toMatchObject({ ok: false, missingProbes: ["P2"] });
    const u = base(); u.probeResults.set("P3", "reproduced"); expect(gateVerdict(u)).toMatchObject({ ok: false, unregisteredProbes: ["P3"] });
  });
});

describe("harness additions used by H2", () => {
  it("test tokens decode to their subject; anything but a three-part token has none", () => {
    expect(jwtSubject(mintTestJwt("user-1"))).toBe("user-1");
    for (const t of ["user-1", "a.b", "", null, "a.b.c"]) expect(jwtSubject(t)).toBeNull();
  });
  it(".or() accepts only eq and is terms; anything else throws (a handler needing more fails loudly)", () => {
    const q = makeClient({} as never, "service_role", null).from("account_mappings");
    expect(() => q.or("company_id.eq.x,company_id.is.null")).not.toThrow();
    for (const bad of ["company_id.neq.x", "company_id.is.maybe", "name.ilike.%x%", "company_id.eq.x,and(a.eq.1)"]) {
      expect(() => makeClient({} as never, "service_role", null).from("account_mappings").or(bad), bad).toThrow();
    }
    expect(() => makeClient({} as never, "service_role", null).from("t").is("c", "x" as never)).toThrow();
  });
});
