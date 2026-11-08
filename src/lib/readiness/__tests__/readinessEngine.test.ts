import { describe, it, expect } from "vitest";
// @ts-expect-error plain ESM fixtures shared with the acceptance runner
import { CASES, t } from "../../../../scripts/acceptance/rfr-v3/cases.mjs";
// @ts-expect-error plain ESM comparison shared with the acceptance runner
import { compare, compareMutation, patched } from "../../../../scripts/acceptance/rfr-v3/compare.mjs";
import { evaluateReadiness, probative, effectiveCorrections, freshnessHolds, reviewHolds, type ReadinessInput } from "../../../../supabase/functions/_shared/readiness/index.ts";

/**
 * IMPLEMENTATION_TEST for the pure engine: every fixture and mutation of the acceptance contract, through the real
 * engine (not the reference model). The PostgreSQL contracts are proven separately by scripts/db-proof.
 */
type Case = { id: string; inputs: ReadinessInput; expected: unknown; mutations?: { id: string; patch: unknown; expected: unknown }[] };
const cases = CASES as Case[];

describe("acceptance contract through the real engine", () => {
  for (const c of cases) {
    it(`${c.id}`, () => {
      const r = evaluateReadiness(structuredClone(c.inputs));
      expect(compare(r, c.expected, c.inputs), c.id).toEqual([]);
    });
    for (const m of c.mutations ?? []) {
      it(`${m.id} (mutation of ${c.id})`, () => {
        const r = evaluateReadiness(patched(c.inputs, m.patch));
        expect(compareMutation(r, m), m.id).toEqual([]);
      });
    }
  }
  it("every fixture's required defect id is covered", () => {
    const defects = new Set(cases.map((c) => (c as unknown as { defect?: string }).defect).filter(Boolean));
    expect([...defects].sort()).toEqual(["D1", "D2", "D5"]);
  });
  it("is deterministic: the same input gives byte-identical output", () => {
    for (const c of cases) expect(JSON.stringify(evaluateReadiness(structuredClone(c.inputs)))).toBe(JSON.stringify(evaluateReadiness(structuredClone(c.inputs))));
  });
});

describe("probative evidence (D4)", () => {
  const ok = { kind: "supplier_invoice", extraction: "human_confirmed" as const, facts: { amount: "100", date: "2026-07-14", ref: "I1" } };
  it("needs every depended-on fact present and equal", () => {
    expect(probative(ok, { kind: "supplier_invoice", amount: "100", ref: "I1", within: ["2026-07-01", "2026-08-14"] }).ok).toBe(true);
    expect(probative({ ...ok, facts: { amount: "100" } }, { within: ["2026-07-01", "2026-08-14"] })).toEqual({ ok: false, why: "missing_fact:date" });
    expect(probative({ ...ok, facts: { ...ok.facts, date: "" } }, { within: ["2026-07-01", "2026-08-14"] })).toEqual({ ok: false, why: "missing_fact:date" });
    expect(probative(ok, { ref: "I2" })).toEqual({ ok: false, why: "fact_mismatch:ref" });
    expect(probative(ok, { account: "1010" })).toEqual({ ok: false, why: "missing_fact:account" });
    expect(probative(ok, { within: ["2026-08-01", "2026-08-14"] })).toEqual({ ok: false, why: "outside_window" });
  });
  it("compares amounts without sign only when asked", () => {
    const e = { ...ok, facts: { amount: "-100" } };
    expect(probative(e, { amount: "100" }).ok).toBe(false);
    expect(probative(e, { amount_abs: "100" }).ok).toBe(true);
  });
  it("AI extraction and absent evidence are never probative, and confirmation alone is not relevance", () => {
    expect(probative({ ...ok, extraction: "ai_unconfirmed" }, {})).toEqual({ ok: false, why: "extraction_unconfirmed" });
    expect(probative(undefined, {})).toEqual({ ok: false, why: "absent" });
    expect(probative({ kind: "opening_journal", extraction: "reproduced", facts: {} }, { amount_abs: "5" })).toEqual({ ok: false, why: "missing_fact:amount" });
  });
});

describe("effective corrections (D2)", () => {
  const line = (a: string, n: string) => ({ account: a, amount: n });
  const row = (id: string, lines: ReturnType<typeof line>[], extra = {}) => ({ id, cid: id, approved: true, lines, scope: "s", reverses: null, ...extra });
  const A = [line("5300", "100"), line("2200", "-100")];
  it("counts one identity once however often it is submitted", () => {
    const r = effectiveCorrections([row("c1", A), row("c1", A), row("c1", A)]);
    expect(r.effective.map((e) => e.cid)).toEqual(["c1"]);
  });
  it("refuses one identity with two effects and two identities with one effect", () => {
    expect(effectiveCorrections([row("c1", A), row("c1", [line("5300", "7"), line("2200", "-7")])]).effective).toEqual([]);
    expect(effectiveCorrections([row("c1", A), row("c2", [...A].reverse())]).effective).toEqual([]);
  });
  it("applies an approved reversal to both the target and itself", () => {
    const r = effectiveCorrections([row("c1", A), row("r1", [line("5300", "-100"), line("2200", "100")], { reverses: "c1" })]);
    expect(r.effective).toEqual([]);
  });
  it("ignores unapproved rows", () => {
    expect(effectiveCorrections([row("c1", A, { approved: false })]).effective).toEqual([]);
  });
});

describe("review and freshness are separate bindings (D5)", () => {
  const att = { pulled_at: "2026-11-07T10:00:00Z", expires_at: "2026-11-07T10:10:00Z", outcome: "confirmed" as const, tb_fingerprint: "tb", gl_fingerprint: "gl", bound_content_sha256: "c1" };
  const f = (a: Partial<typeof att> | null, now = "2026-11-07T10:05:00Z") => ({ source: "qbo" as const, now, bound: { tb_fingerprint: "tb", gl_fingerprint: "gl" }, attestation: a === null ? null : { ...att, ...a } });
  it("a renewed attestation for identical content needs no new review", () => {
    expect(reviewHolds({ review: { reviewed_content_sha256: "c1" }, content_sha256_now: "c1" })).toEqual([]);
    expect(freshnessHolds(f({}), "c1")).toEqual([]);
  });
  it("changed content needs re-review even when the attestation is fresh for the new content", () => {
    expect(reviewHolds({ review: { reviewed_content_sha256: "c1" }, content_sha256_now: "c2" })).toEqual(["REVIEW_STALE"]);
    expect(freshnessHolds(f({ bound_content_sha256: "c2" }), "c2")).toEqual([]);
  });
  it("missing, expired, mismatched, over-long and changed attestations hold", () => {
    expect(freshnessHolds(f(null), "c1")).toEqual(["SOURCE_FRESHNESS_UNDETERMINED"]);
    expect(freshnessHolds(f({}, "2026-11-07T10:10:00Z"), "c1")).toEqual(["SOURCE_FRESHNESS_STALE"]);
    expect(freshnessHolds(f({ bound_content_sha256: "c0" }), "c1")).toEqual(["SOURCE_FRESHNESS_MISMATCH"]);
    expect(freshnessHolds(f({ expires_at: "2026-11-07T11:00:00Z" }), "c1")).toEqual(["SOURCE_FRESHNESS_INVALID"]);
    expect(freshnessHolds(f({ gl_fingerprint: "other" }), "c1")).toEqual(["SOURCE_CHANGED:gl"]);
  });
  it("an export-bound workspace needs no attestation", () => {
    expect(freshnessHolds({ source: "export" }, "c1")).toEqual([]);
  });
});

describe("the food-rations correction, exact effect", () => {
  it("settles the payable to zero, lowers the expense by the one payment and leaves cash alone", () => {
    const c = cases.find((x) => x.id === "E2")!;
    const r = evaluateReadiness(structuredClone(c.inputs));
    expect(r.balances["2000"]).toBe("0");
    expect(r.balances["5607"]).toBe(t("105,279,755.00"));
    expect(r.balances["1020"]).toBe(t("65,772,218.34"));
    expect(r.balances.OBE).toBe(t("-271,838,585.30"));
    expect(r.finalization).toEqual({ held: false, reasons: [] });
  });
});

describe("a double charge corrected in the source ledger (reimport path)", () => {
  it("is resolved by the verified source fix, with nothing applied and balances equal to the corrected books", () => {
    const base = structuredClone(cases.find((x) => x.id === "E2")!.inputs) as ReadinessInput;
    // The books were corrected in QuickBooks: one journal Dr OBE / Cr 5607 for the bill, already inside the corrected TB.
    const eff = [{ account: "OBE", amount: t("33,518,793.00") }, { account: "5607", amount: t("-33,518,793.00") }];
    base.tb!.accounts["5607"].closing = t("105,279,755.00");
    base.tb!.accounts.OBE.closing = t("-271,838,585.30");
    base.ledger!.entries.push({ id: "QBO-JE-881#1", date: "2026-06-30", account: "OBE", amount: eff[0].amount, ref: "QBO-JE-881" }, { id: "QBO-JE-881#2", date: "2026-06-30", account: "5607", amount: eff[1].amount, ref: "QBO-JE-881" });
    base.ledger!.accounts.OBE = t("-305,357,378.30");
    base.ledger!.accounts["5607"] = "0";
    base.apply_proposals = []; base.approvals = [];
    base.correction_verification = [{ id: "corr:food:003/2024.2025", scope: "payables", effect: eff, anchor: ["003/2024.2025"], adjustment_approved: false,
      snapshot: { id: "s1", postings: [{ id: "QBO-JE-881", lines: eff, links: ["003/2024.2025"] }] } }];
    // The opening bridge no longer needs its own proposal: the source fix covers the net effect.
    const r = evaluateReadiness(base);
    expect(r.corrections[0].state).toBe("verified_in_source");
    expect(r.findings.find((f) => f.rule === "OPENING_PAYABLE_CHARGED_TO_EXPENSE")?.resolved_by).toBe("corr:food:003/2024.2025");
    expect(r.scopes.payables).toBe("READY");
    expect(r.applied_adjustments).toEqual([]);
  });
});
