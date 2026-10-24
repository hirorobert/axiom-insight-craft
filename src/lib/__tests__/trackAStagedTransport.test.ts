import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM release tool without type declarations
import { BATCHES, BOOTSTRAP_PREDECESSOR, SOURCE_COMMIT, CHECKS_COMMIT, artifactBytes, kindsOf, renderAll, renderApply, transportForms, checkTransportMirror, REGISTERED_TRANSPORT_FORMS } from "../../../scripts/release/trackAStagedTransport.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

// Literal identities (independent of the module): the committed bytes at e7886489 and the registered submission forms.
const SOURCES = [
  ["20261127100000_fs_track_a_authority_hardening.sql", 40457, "72c11b685b17261d2932d7b1182c4fea649096a2ba1b3ff06270d89ac7da4d4a"],
  ["20261128100000_companies_framework_change_guard.sql", 3043, "e5ff37296d50e152f86c89652eb238b27ba66b2161bb1bd8aa71e9daf4918d41"],
] as const;
const FORMS = [
  ["track_a_staged_transport", 7750, "7b51e2c625e371779d7f67cfc8c2d150181ac1812da556d64e3f40f79390533e"],
  ["tra_1_authority_hardening_staged_apply", 7981, "3f27a234df1a744c5651dc7755126b46d1924cf922d93a6d42198c4d7c1cbd9b"],
  ["tra_2_framework_guard_staged_apply", 7434, "d4952e29098cc841c236e0a9f9d7fec7ede69ae9b838c5b0ed509532e3702f86"],
] as const;

describe("track-a-r1 exact-byte staged transport", () => {
  it("pins the committed sources and checks and the journal predecessor (hosted id 80 = 0079)", () => {
    expect(SOURCE_COMMIT).toBe("e7886489cd9d7b2fed8d8bbddf9267612d424b50");
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
