import { describe, expect, it } from "vitest";
import { BATCHES, artifactBytes, checkTransportMirror, renderAll, transportForms, REGISTERED_TRANSPORT_FORMS } from "../../../scripts/release/internalBetaStagedTransport.mjs";

describe("internal-beta candidate exact-byte transport", () => {
  it("pins original source bytes and rejects altered journal text", () => {
    expect(BATCHES[0].artifacts.source.bytes).toBe(38510);
    expect(BATCHES[0].artifacts.source.sha256).toBe("84695443fc325657b68b159f753a788c16249fac92b0e78176e9876a4994fd3f");
    expect(artifactBytes(0, "source").length).toBe(38510);
    for (const form of transportForms()) {
      expect(form.hashes[0]).toBe(REGISTERED_TRANSPORT_FORMS[form.name]);
      expect(checkTransportMirror(`0083_${form.name}`, form.text).problems).toEqual([]);
      expect(checkTransportMirror(`0083_${form.name}`, `${form.text} `).problems.length).toBeGreaterThan(0);
    }
  });
  it("contains only the two new release sources, not completed reporting installation", () => {
    expect(BATCHES.map(b => b.source)).toEqual(["20261201100000_assistant_controls.sql", "20261202100000_internal_beta_policy.sql"]);
    expect(Object.keys(renderAll())).toHaveLength(5);
  });
});