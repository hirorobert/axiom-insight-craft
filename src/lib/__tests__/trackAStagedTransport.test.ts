import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM release tool without type declarations
import { BATCHES, BOOTSTRAP_PREDECESSOR, SOURCE_COMMIT, CHECKS_COMMIT, artifactBytes, kindsOf, renderAll, renderApply, transportForms, checkTransportMirror, REGISTERED_TRANSPORT_FORMS } from "../../../scripts/release/trackAStagedTransport.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

// Literal identities (independent of the module): the committed bytes at fce4c13c and the registered submission forms.
const SOURCES = [
  ["20261127100000_fs_track_a_authority_hardening.sql", 44872, "a3b39b90f8a6f2b1e48372203c26618b3f864da22db16d53a96932cc21bd9e99"],
  ["20261128100000_companies_framework_change_guard.sql", 3800, "80626d259948579f39b2a8f32d8df4a4baadcb6592a369801335c70399278d1d"],
] as const;
const FORMS = [
  ["track_a_staged_transport", 7750, "b92ec084d09998f6e80c7ac48d3533d6a5123c2d32f569d6efe1f792c787422f"],
  ["tra_1_authority_hardening_staged_apply", 7981, "636370c97a2dc51db4867f5a5c757eabfff838b4d6cef7ab958067e8834141f9"],
  ["tra_2_framework_guard_staged_apply", 7434, "7be675f1066aa17090007d039a412b70a2c120fa8fab008d7bfd0ceee1b3523f"],
] as const;

describe("track-a-r1 exact-byte staged transport", () => {
  it("pins the committed sources and checks and the journal predecessor (hosted id 80 = 0079)", () => {
    expect(SOURCE_COMMIT).toBe("fce4c13c5824a718d1d38732fe8127d19726d167");
    expect(CHECKS_COMMIT).toBe(SOURCE_COMMIT);
    expect(BOOTSTRAP_PREDECESSOR.id).toBe(80);
    expect(BOOTSTRAP_PREDECESSOR.hash).toBe(sha(fs.readFileSync(path.join(ROOT, "drizzle/migrations/0079_fsi_4_document_structure_staged_apply.sql"))));
    expect(BATCHES.map((b: { source: string }) => b.source)).toEqual(SOURCES.map((s) => s[0]));
    BATCHES.forEach((b: { artifacts: Record<string, { bytes: number; sha256: string }> }, i: number) => {
      for (const k of kindsOf(i)) { const bytes = artifactBytes(i, k); expect([bytes.length, sha(bytes)]).toEqual([b.artifacts[k].bytes, b.artifacts[k].sha256]); }
      const working = fs.readFileSync(path.join(ROOT, `supabase/migrations/${SOURCES[i][0]}`));
      expect([working.length, sha(working)]).toEqual([SOURCES[i][1], SOURCES[i][2]]);
      expect(working.equals(artifactBytes(i, "source"))).toBe(true);
    });
    expect(kindsOf(0)).toEqual(["source", "wrapper", "preflight", "postcondition"]);
    expect(kindsOf(1)).toEqual(["source", "wrapper", "postcondition"]);
  }, 30_000);

  it("tracked files equal their rendering and every form is registered with its exact literal hash", () => {
    for (const [rel, text] of Object.entries(renderAll() as Record<string, string>)) expect(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel).toBe(text);
    const forms = transportForms();
    expect(forms.map((f: { name: string; bytes: number; hashes: string[] }) => [f.name, f.bytes, f.hashes[0]])).toEqual(FORMS.map((f) => [...f]));
    forms.forEach((f: { name: string; text: string; hashes: string[] }, i: number) => {
      const tag = `${String(80 + i).padStart(4, "0")}_${f.name}`;
      expect(REGISTERED_TRANSPORT_FORMS[f.name]).toBe(FORMS[i][2]);
      expect(checkTransportMirror(tag, f.text).problems).toEqual([]);
      expect(checkTransportMirror(tag, f.text.replace("GENERATED", "generated")).problems.length).toBeGreaterThan(0);
    });
    expect(checkTransportMirror("0081_tra_9_unknown_staged_apply", "x").problems.length).toBeGreaterThan(0);
  }, 30_000);

  it("orders every refusal before execution and consumption; batch 2 requires batch 1; nothing controls the transaction", () => {
    BATCHES.forEach((_: unknown, i: number) => {
      const t: string = renderApply(i);
      const at = (s: string) => t.indexOf(s);
      expect(at("TRA_TRANSPORT_WRONG_PREDECESSOR")).toBeLessThan(at("EXECUTE v_wrapper"));
      expect(at("TRA_TRANSPORT_ALREADY_APPLIED")).toBeLessThan(at("EXECUTE v_wrapper"));
      expect(at("TRA_TRANSPORT_STAGE_MISSING_OR_MODIFIED")).toBeLessThan(at("EXECUTE v_wrapper"));
      expect(at("EXECUTE v_wrapper")).toBeLessThan(at("EXECUTE v_postcondition"));
      expect(at("EXECUTE v_postcondition")).toBeLessThan(at("TRA_TRANSPORT_BASELINE_CHANGED"));
      expect(at("TRA_TRANSPORT_BASELINE_CHANGED")).toBeLessThan(at("UPDATE cfoclose_tra_release.staged_artifacts"));
      expect(t).toContain("public.fs_report_authority_events");
      expect(t).not.toMatch(/\b(COMMIT|ROLLBACK)\b/);
    });
    expect(renderApply(0).indexOf("EXECUTE v_preflight")).toBeLessThan(renderApply(0).indexOf("EXECUTE v_wrapper"));
    expect(renderApply(1)).toContain("c_prior CONSTANT text := 'tra-1-authority-hardening'");
    expect(renderApply(1)).not.toContain("EXECUTE v_preflight");
  });
});
