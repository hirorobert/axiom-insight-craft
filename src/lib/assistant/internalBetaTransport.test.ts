import fs from "node:fs";
import path from "node:path";
import { RELEASE_JOURNAL, checkReleaseEntry } from "../../../scripts/ci/releaseJournal.mjs";
import { describe, expect, it } from "vitest";
import { BATCHES, artifactBytes, checkTransportMirror, renderAll, transportForms, REGISTERED_TRANSPORT_FORMS } from "../../../scripts/release/internalBetaStagedTransport.mjs";

describe("internal-beta registered exact-byte transport", () => {
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

describe("canonical beta migration registration", () => {
  it("accepts exactly registered bytes and refuses altered source or mirror without claiming hosted application", () => {
    const journal = RELEASE_JOURNAL as Record<string, unknown>;
    const read = (name: string) => fs.readFileSync(path.join(process.cwd(), "supabase/migrations", name));
    for (const form of transportForms()) {
      const tag = `9999_${form.name}`;
      journal[tag] = { kind: "beta_staged_transport", sha256: form.hashes[0] };
      try {
        const result = checkReleaseEntry(tag, form.text, read);
        expect(result.problems).toEqual([]);
        expect(checkReleaseEntry(tag, `${form.text} `, read).problems.length).toBeGreaterThan(0);
        if (result.covers) {
          expect(checkReleaseEntry(tag, form.text, (name: string) => Buffer.concat([read(name), Buffer.from(" ")])).problems.length).toBeGreaterThan(0);
        }
      } finally { delete journal[tag]; }
    }
    // Exactly the three hosted mirrors applied as journal ids 84–86 are registered; nothing else.
    expect(Object.keys(journal).filter(tag => /beta_staged_transport|beta_1_|beta_2_/.test(tag))).toEqual([
      "0083_internal_beta_staged_transport", "0084_beta_1_assistant_controls_staged_apply", "0085_beta_2_internal_policy_staged_apply"]);
  });
});
