import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM release tool without type declarations
import { BATCHES, BOOTSTRAP_PREDECESSOR, SOURCE_COMMIT, CHECKS_COMMIT, artifactBytes, kindsOf, renderAll, renderApply, transportForms, checkTransportMirror } from "../../../scripts/release/fsIntegrityStagedTransport.mjs";
// @ts-expect-error plain ESM release tool without type declarations
import { RELEASE_JOURNAL } from "../../../scripts/ci/releaseJournal.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

describe("fs-integrity-r1 exact-byte staged transport", () => {
  it("pins the merged sources, the corrected checks and the journal predecessor", () => {
    expect(SOURCE_COMMIT).toBe("27f48f7f4b061ff3ef727aa47ebdf8dac369e543");
    expect(CHECKS_COMMIT).toBe("56edbf85912b9d347387d15e3d482ff7799dbf5c");
    expect(BOOTSTRAP_PREDECESSOR.hash).toBe(sha(fs.readFileSync(path.join(ROOT, "drizzle/migrations/0074_tb_decision_catalogue_read_predicate.sql"))));
    expect(BATCHES.map((b: { source: string }) => b.source)).toEqual([
      "20261123100000_fs_server_compilation.sql", "20261124100000_fs_publication_integrity_gate.sql",
      "20261125100000_fs_final_authority.sql", "20261126100000_fs_document_structure.sql"]);
    BATCHES.forEach((b: { artifacts: Record<string, { bytes: number; sha256: string }> }, i: number) => {
      for (const k of kindsOf(i)) { const bytes = artifactBytes(i, k); expect([bytes.length, sha(bytes)]).toEqual([b.artifacts[k].bytes, b.artifacts[k].sha256]); }
      expect(fs.readFileSync(path.join(ROOT, `supabase/migrations/${BATCHES[i].source}`)).equals(artifactBytes(i, "source"))).toBe(true);
    });
    expect(kindsOf(0)).toContain("preflight");
    expect(kindsOf(3)).toContain("postcondition");
  }, 30_000);

  it("tracked files equal their rendering and every form is registered with its exact hash", () => {
    for (const [rel, text] of Object.entries(renderAll() as Record<string, string>)) expect(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel).toBe(text);
    const forms = transportForms();
    forms.forEach((f: { text: string; hashes: string[] }, i: number) => {
      const tag = Object.keys(RELEASE_JOURNAL).find((t) => t.startsWith(String(75 + i).padStart(4, "0") + "_"))!;
      expect(RELEASE_JOURNAL[tag]).toEqual({ kind: "fsi_staged_transport", sha256: f.hashes[0] });
      expect(checkTransportMirror(tag, f.text).problems).toEqual([]);
      expect(checkTransportMirror(tag, f.text.replace("GENERATED", "generated")).problems.length).toBeGreaterThan(0);
    });
  }, 30_000);

  it("orders every refusal before execution and consumption", () => {
    BATCHES.forEach((_: unknown, i: number) => {
      const t: string = renderApply(i);
      const at = (s: string) => t.indexOf(s);
      expect(at("FSI_TRANSPORT_WRONG_PREDECESSOR")).toBeLessThan(at("EXECUTE v_wrapper"));
      expect(at("FSI_TRANSPORT_ALREADY_APPLIED")).toBeLessThan(at("EXECUTE v_wrapper"));
      expect(at("FSI_TRANSPORT_STAGE_MISSING_OR_MODIFIED")).toBeLessThan(at("EXECUTE v_wrapper"));
      expect(at("EXECUTE v_wrapper")).toBeLessThan(at("FSI_TRANSPORT_BASELINE_CHANGED"));
      expect(at("FSI_TRANSPORT_BASELINE_CHANGED")).toBeLessThan(at("UPDATE cfoclose_fsi_release.staged_artifacts"));
      expect(t).not.toMatch(/\b(COMMIT|ROLLBACK)\b/);
    });
  });
});
