import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveCompanyEdit } from "./companyEdit";
import type { FrameworkChangeResult } from "./companyFramework";
import { deriveFrameworkFieldLock, guardCompanyFieldChange } from "@/lib/accounting/companyFieldLock";

const writes = (framework: FrameworkChangeResult | (() => Promise<FrameworkChangeResult>), details: { error: unknown } | "throw") => {
  const calls: string[] = [];
  return {
    calls,
    changeFramework: async () => { calls.push("framework"); return typeof framework === "function" ? framework() : framework; },
    updateDetails: async () => { calls.push("details"); if (details === "throw") throw new TypeError("Failed to fetch"); return details; },
  };
};

describe("saveCompanyEdit — every way a two-write save can end is reported as exactly what is known", () => {
  it("framework committed and details saved: saved", async () => {
    const w = writes({ kind: "changed", from: null, to: "full_ifrs", eventId: "e" }, { error: null });
    expect((await saveCompanyEdit(w, { frameworkTo: "full_ifrs" })).kind).toBe("saved");
    expect(w.calls).toEqual(["framework", "details"]);
  });
  it("uncertain framework answer: the details are NOT attempted and nothing claims the change was not saved", async () => {
    const w = writes({ kind: "uncertain" }, { error: null });
    const r = await saveCompanyEdit(w, { frameworkTo: "full_ifrs" });
    expect(r.kind).toBe("framework_uncertain");
    expect(w.calls).toEqual(["framework"]);
    expect("message" in r && r.message).toMatch(/could not confirm/i);
    expect("message" in r && r.message).not.toMatch(/nothing was saved|not changed/i);
  });
  it("a definite refusal: nothing was written, the details are not attempted, and the message says so", async () => {
    for (const refusal of [{ kind: "locked", current: "ifrs_for_smes" }, { kind: "stale", current: null }, { kind: "processing", current: null }, { kind: "forbidden" }, { kind: "error" }] as FrameworkChangeResult[]) {
      const w = writes(refusal, { error: null });
      const r = await saveCompanyEdit(w, { frameworkTo: "full_ifrs" });
      expect(r.kind).toBe("framework_not_saved");
      expect(w.calls).toEqual(["framework"]);
      expect("message" in r && r.message).toMatch(/No company details were saved/);
    }
  });
  it("framework committed, details failed (a refusal or a lost response): partial, naming the saved framework", async () => {
    for (const details of [{ error: { code: "23514" } }, "throw"] as const) {
      const w = writes({ kind: "changed", from: "ifrs_for_smes", to: "full_ifrs", eventId: "e" }, details);
      const r = await saveCompanyEdit(w, { frameworkTo: "full_ifrs" });
      expect(r.kind).toBe("partial");
      expect("message" in r && r.message).toMatch(/reporting framework is saved as Full IFRS/);
      expect("message" in r && r.message).toMatch(/could not be confirmed as saved/);
    }
  });
  it("a replayed framework request (the resend after an uncertain answer) counts as committed", async () => {
    const w = writes({ kind: "replayed", from: null, to: "ipsas_accrual", eventId: "e" }, { error: null });
    expect((await saveCompanyEdit(w, { frameworkTo: "ipsas_accrual" })).kind).toBe("saved");
  });
  it("no framework change requested: only the details are written; their failure is not confirmed, never 'nothing saved'", async () => {
    const ok = writes({ kind: "error" }, { error: null });
    expect((await saveCompanyEdit(ok, { frameworkTo: null })).kind).toBe("saved");
    expect(ok.calls).toEqual(["details"]);
    const bad = writes({ kind: "error" }, "throw");
    const r = await saveCompanyEdit(bad, { frameworkTo: null });
    expect(r.kind).toBe("details_not_confirmed");
    expect(bad.calls).toEqual(["details"]);
  });
});

describe("initial framework selection — the form follows the server policy without reopening a decided framework", () => {
  it("a never-decided framework (NULL) may record its first decision whatever the processing state (the server permits and audits it)", () => {
    for (const processingCertainty of ["checking", "processed", "check_failed", "not_processed"] as const) {
      expect(deriveFrameworkFieldLock({ current: null, processingCertainty }).locked).toBe(false);
      expect(guardCompanyFieldChange({ locked: processingCertainty !== "not_processed", frameworkLocked: false, frameworkChanged: true, fiscalYearEndChanged: false }).allowed).toBe(true);
    }
  });
  it("a decided framework keeps the existing lock exactly: locked when processed, while checking and when the check failed", () => {
    for (const processingCertainty of ["checking", "processed", "check_failed"] as const) {
      const lock = deriveFrameworkFieldLock({ current: "ifrs_for_smes", processingCertainty });
      expect(lock.locked).toBe(true);
      expect(guardCompanyFieldChange({ locked: true, frameworkLocked: lock.locked, frameworkChanged: true, fiscalYearEndChanged: false }))
        .toEqual({ allowed: false, blockedField: "reporting_framework" });
    }
    expect(deriveFrameworkFieldLock({ current: "ifrs_for_smes", processingCertainty: "not_processed" }).locked).toBe(false);
  });
  it("the fiscal year end lock is unchanged by an open first framework decision", () => {
    expect(guardCompanyFieldChange({ locked: true, frameworkLocked: false, frameworkChanged: false, fiscalYearEndChanged: true }))
      .toEqual({ allowed: false, blockedField: "fiscal_year_end" });
  });
});

describe("CompanyManager wires these paths (source)", () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, "../../components/CompanyManager.tsx"), "utf8");
  const submit = SRC.slice(SRC.indexOf("const handleSubmit"), SRC.indexOf("const refreshEditingCompany"));
  it("the framework request id comes from frameworkRequestFor (kept across an uncertain answer), never minted per submission", () => {
    expect(submit).toMatch(/frameworkRequestFor\(frameworkRequest\.current,/);
    expect(submit).not.toMatch(/requestId:\s*crypto\.randomUUID\(\)/);
    expect(submit).toMatch(/if \(outcome\.kind !== "framework_uncertain"\) frameworkRequest\.current = null;/);
  });
  it("the save goes through saveCompanyEdit; uncertain and partial outcomes re-read the company before the next save", () => {
    expect(submit).toMatch(/await saveCompanyEdit\(/);
    expect(submit).toMatch(/outcome\.kind === "framework_uncertain" \|\| outcome\.kind === "partial"\) await refreshEditingCompany\(editing\.id\)/);
    expect(submit).not.toMatch(/Nothing was saved/);
  });
  it("the framework field's editability and the submit guard use the framework's own lock; the fiscal year end keeps the general lock", () => {
    expect(SRC).toMatch(/const frameworkLock = deriveFrameworkFieldLock\(/);
    expect(SRC).toMatch(/const frameworkEditable = !frameworkLock\.locked;/);
    expect(SRC).toMatch(/const fiscalYearEndEditable = !fieldLock\.locked;/);
    expect(submit).toMatch(/frameworkLocked: !!editingCompany && frameworkLock\.locked,/);
  });
});
