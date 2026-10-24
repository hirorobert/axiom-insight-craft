import { describe, expect, it } from "vitest";
import { expectedOutcome, normaliseManifest, validateProofResult } from "../../../scripts/ci/validateProofResult.mjs";
import * as gateManifest from "../../../scripts/db-proof/publicationIntegrityGate.manifest.mjs";
import * as authorityManifest from "../../../scripts/db-proof/publicationAuthority.manifest.mjs";

const MANIFEST = {
  PROOF: "demo",
  CASES: [
    { id: "setup.chain", kind: "setup", modes: ["present"] },
    { id: "setup.chain-before", kind: "setup", modes: ["absent"] },
    { id: "setup.world", kind: "setup" },
    { id: "h0.honest", kind: "control" },
    { id: "w1.tamper", kind: "weakness" },
    { id: "w2.tamper", kind: "weakness" },
  ],
};
const SHA = "a".repeat(64);
const result = (mode: "present" | "absent", cases: { id: string; outcome: "pass" | "fail" }[], extra: Record<string, unknown> = {}) =>
  ({ proof: "demo", mode, manifestSha256: SHA, completed: true, crashed: false, cases, ...extra });
const present = result("present", [{ id: "setup.chain", outcome: "pass" }, { id: "setup.world", outcome: "pass" }, { id: "h0.honest", outcome: "pass" }, { id: "w1.tamper", outcome: "pass" }, { id: "w2.tamper", outcome: "pass" }]);
const absent = result("absent", [{ id: "setup.chain-before", outcome: "pass" }, { id: "setup.world", outcome: "pass" }, { id: "h0.honest", outcome: "pass" }, { id: "w1.tamper", outcome: "fail" }, { id: "w2.tamper", outcome: "fail" }]);

describe("the structured proof contract: a command failure alone is never a reproduction", () => {
  it("accepts the two valid shapes: every case passes with the control present (exit 0); exactly the weakness cases fail with it absent (exit 1)", () => {
    expect(validateProofResult(present, MANIFEST, { mode: "present", exitCode: 0 }).ok).toBe(true);
    expect(validateProofResult(absent, MANIFEST, { mode: "absent", exitCode: 1 }).ok).toBe(true);
    expect(expectedOutcome("weakness", "absent")).toBe("fail");
    expect(expectedOutcome("control", "absent")).toBe("pass");
    expect(expectedOutcome("weakness", "present")).toBe("pass");
  });
  it("rejects an UNEXPECTED failure: a control or setup case failing in absent mode, or any case failing in present mode", () => {
    const badControl = result("absent", absent.cases.map((c) => (c.id === "h0.honest" ? { ...c, outcome: "fail" as const } : c)));
    const v = validateProofResult(badControl, MANIFEST, { mode: "absent", exitCode: 1 });
    expect(v.ok).toBe(false); expect(v.errors.join("\n")).toMatch(/h0\.honest \(control\) is fail; expected pass/);
    const badPresent = result("present", present.cases.map((c) => (c.id === "w1.tamper" ? { ...c, outcome: "fail" as const } : c)));
    expect(validateProofResult(badPresent, MANIFEST, { mode: "present", exitCode: 1 }).errors.join("\n")).toMatch(/w1\.tamper \(weakness\) is fail; expected pass/);
  });
  it("rejects a weakness case that PASSES in absent mode (the gate is not needed, or the proof does not exercise it)", () => {
    const notReproduced = result("absent", absent.cases.map((c) => (c.id === "w2.tamper" ? { ...c, outcome: "pass" as const } : c)));
    const v = validateProofResult(notReproduced, MANIFEST, { mode: "absent", exitCode: 1 });
    expect(v.ok).toBe(false); expect(v.errors.join("\n")).toMatch(/w2\.tamper \(weakness\) is pass; expected fail/);
  });
  it("rejects an INFRASTRUCTURE failure: a crash, an incomplete run, a failed setup case, an unpinned manifest, a malformed file", () => {
    expect(validateProofResult({ ...absent, crashed: true }, MANIFEST, { mode: "absent", exitCode: 1 }).errors.join("\n")).toMatch(/crashed/);
    expect(validateProofResult({ ...absent, completed: false }, MANIFEST, { mode: "absent", exitCode: 1 }).errors.join("\n")).toMatch(/completed/);
    const setupFailed = result("absent", absent.cases.map((c) => (c.id === "setup.world" ? { ...c, outcome: "fail" as const } : c)));
    expect(validateProofResult(setupFailed, MANIFEST, { mode: "absent", exitCode: 1 }).errors.join("\n")).toMatch(/setup\.world \(setup\) is fail/);
    expect(validateProofResult({ ...present, manifestSha256: "nope" }, MANIFEST, { mode: "present", exitCode: 0 }).errors.join("\n")).toMatch(/manifestSha256/);
    expect(validateProofResult("not an object", MANIFEST, { mode: "present", exitCode: 0 }).errors.join("\n")).toMatch(/not a JSON object/);
    expect(validateProofResult({ ...present, cases: "nope" }, MANIFEST, { mode: "present", exitCode: 0 }).errors.join("\n")).toMatch(/cases is not an array/);
  });
  it("rejects an INCOMPLETE report (a missing or skipped case), a duplicate, an extra or wrong-mode case", () => {
    expect(validateProofResult(result("present", present.cases.slice(0, -1)), MANIFEST, { mode: "present", exitCode: 0 }).errors.join("\n")).toMatch(/w2\.tamper \(weakness\) is missing/);
    expect(validateProofResult(result("present", [...present.cases, { id: "w2.tamper", outcome: "pass" }]), MANIFEST, { mode: "present", exitCode: 0 }).errors.join("\n")).toMatch(/reported more than once/);
    expect(validateProofResult(result("present", [...present.cases, { id: "zz.extra", outcome: "pass" }]), MANIFEST, { mode: "present", exitCode: 0 }).errors.join("\n")).toMatch(/zz\.extra is not in the manifest/);
    expect(validateProofResult(result("present", [...present.cases, { id: "setup.chain-before", outcome: "pass" }]), MANIFEST, { mode: "present", exitCode: 0 }).errors.join("\n")).toMatch(/setup\.chain-before is not in the manifest for mode present/);
  });
  it("binds the recorded outcomes to the captured exit status and the mode", () => {
    expect(validateProofResult(present, MANIFEST, { mode: "present", exitCode: 1 }).errors.join("\n")).toMatch(/present mode must exit 0/);
    expect(validateProofResult(absent, MANIFEST, { mode: "absent", exitCode: 0 }).errors.join("\n")).toMatch(/exited 0 although a case failed/);
    expect(validateProofResult(absent, MANIFEST, { mode: "present", exitCode: 1 }).errors.join("\n")).toMatch(/result\.mode "absent" is not the run's mode "present"/);
    expect(validateProofResult(present, MANIFEST, { mode: "present", exitCode: Number.NaN }).errors.join("\n")).toMatch(/exit code .* is not an integer/);
    expect(validateProofResult({ ...present, proof: "other" }, MANIFEST, { mode: "present", exitCode: 0 }).errors.join("\n")).toMatch(/result\.proof "other"/);
  });
  it("refuses a manifest with a duplicate id, an unknown kind or an invalid mode", () => {
    expect(() => normaliseManifest({ PROOF: "x", CASES: [{ id: "a.b", kind: "setup" }, { id: "a.b", kind: "control" }] })).toThrow(/duplicate case id/);
    expect(() => normaliseManifest({ PROOF: "x", CASES: [{ id: "a.b", kind: "bug" }] })).toThrow(/kind/);
    expect(() => normaliseManifest({ PROOF: "x", CASES: [{ id: "a.b", kind: "setup", modes: ["prod"] }] })).toThrow(/invalid modes/);
    expect(() => normaliseManifest({ PROOF: "x", CASES: [] })).toThrow(/non-empty CASES/);
  });
  it("the committed manifests are valid and name the reviewed weakness cases", () => {
    const gate = normaliseManifest(gateManifest);
    expect(gate.filter((c) => c.kind === "weakness").length).toBeGreaterThanOrEqual(20);
    expect(gate.find((c) => c.id === "setup.chain-before-gate")?.modes).toEqual(["absent"]);
    expect(gate.find((c) => c.id === "setup.chain")?.modes).toEqual(["present"]);
    expect(normaliseManifest(authorityManifest).every((c) => c.modes.join() === "present")).toBe(true);
  });
});
