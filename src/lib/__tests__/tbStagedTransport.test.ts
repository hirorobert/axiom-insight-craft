import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM release tool without type declarations
import {
  APPROVED_COMMIT, BATCHES, BOOTSTRAP_PREDECESSOR, KINDS, REGISTERED_TRANSPORT_FORMS, TRANSPORT_DIR,
  checkTransportMirror, committedBytes, renderAll, renderApply, renderBootstrap, renderStage, transportForms,
} from "../../../scripts/release/tbStagedTransport.mjs";
import { BATCHES as FS_BATCHES, renderAll as renderFsAll } from "../../../scripts/release/stagedTransport.mjs";

const ROOT = path.resolve(__dirname, "../../..");

describe("Trial Balance exact-byte staged transport", () => {
  it("pins the merged-main source bytes, wrappers and read-only postconditions", () => {
    expect(APPROVED_COMMIT).toBe("5c69b1795be3020dbcd145dcab9f3828b3993814");
    expect(BOOTSTRAP_PREDECESSOR).toEqual({ id: 71, hash: "0eb1405df641e956ca43b4ad652f9ca263029352637e98d1ce482d5c2bb19910" });
    expect(BATCHES.map((b) => b.batch)).toEqual(["tb-portfolio-a1", "tb-decisions-b1"]);
    for (const b of BATCHES) {
      for (const kind of KINDS) {
        const a = kind === "source" ? b.sourceArtifact : b[kind];
        const committed = committedBytes(a.path);
        expect(committed.length, `${b.batch}/${kind} bytes`).toBe(a.bytes);
        expect(crypto.createHash("sha256").update(committed).digest("hex"), `${b.batch}/${kind} hash`).toBe(a.sha256);
        expect(fs.readFileSync(path.join(ROOT, a.path)).equals(committed), `${b.batch}/${kind} checkout`).toBe(true);
      }
    }
  });

  it("renders exactly nine tracked transport files and all journal forms are deterministic", () => {
    const rendered = renderAll();
    expect(Object.keys(rendered)).toHaveLength(9);
    for (const [rel, text] of Object.entries(rendered)) expect(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel).toBe(text);
    for (const f of transportForms()) {
      const reg = REGISTERED_TRANSPORT_FORMS[f.name];
      expect([reg.bytes, reg.sha256, reg.withFinalLf]).toEqual([f.bytes, ...f.hashes]);
      expect(f.text.endsWith("\n")).toBe(false);
    }
    expect(Object.keys(renderFsAll())).toHaveLength(21); // existing FS transport remains a separate five-batch route
    expect(FS_BATCHES.map((b) => b.batch)).toEqual(["fs-controls-r1", "fs-journey-r1", "fs-bounds-r1", "fs-capacity-r1", "fs-memo-r1"]);
  }, 30_000);

  it("pins predecessor identity and refusal ordering before every executable step", () => {
    const bootstrap = renderBootstrap();
    expect(bootstrap).toContain(`c_predecessor CONSTANT text[] := ARRAY['${BOOTSTRAP_PREDECESSOR.hash}']::text[]`);
    expect(bootstrap).toContain("TB_TRANSPORT_WRONG_PREDECESSOR");
    for (const [i, b] of BATCHES.entries()) {
      const text = renderApply(i);
      expect(text).toContain("c_predecessor CONSTANT text[]");
      expect(text).not.toContain("c_expected_predecessor");
      expect(text).toContain("TB_TRANSPORT_WRONG_PREDECESSOR");
      expect(text).toContain("TB_TRANSPORT_STAGE_MISSING_OR_MODIFIED");
      expect(text).toContain("TB_TRANSPORT_UNCERTAIN_STATE");
      expect(text).toContain("TB_TRANSPORT_ALREADY_APPLIED");
      expect(text.indexOf("TB_TRANSPORT_WRONG_PREDECESSOR")).toBeLessThan(text.indexOf("EXECUTE v_wrapper"));
      expect(text.indexOf("EXECUTE v_wrapper")).toBeLessThan(text.indexOf("UPDATE cfoclose_tb_release.staged_artifacts"));
      expect(text).not.toMatch(/\b(BEGIN\s+TRANSACTION|COMMIT|ROLLBACK)\b/i);
      expect(text).toContain(b.wrapper.sha256);
    }
  });

  it("rejects tampered transport text in the same way the migration-authority check will", () => {
    const f = transportForms()[1];
    expect(checkTransportMirror(`0072_${f.name}`, f.text).problems).toEqual([]);
    expect(checkTransportMirror(`0072_${f.name}`, f.text.replace("Exact source", "Tampered source")).problems.length).toBeGreaterThan(0);
    expect(checkTransportMirror("0072_unregistered", f.text).problems.length).toBeGreaterThan(0);
    expect(path.join(ROOT, TRANSPORT_DIR)).toContain("staged-transport-tb");
  });
});
