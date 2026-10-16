/**
 * No layout → byte-identical ingestion. Every corpus case (repository fixtures under several currencies and periods,
 * plus one file per automatic-path behaviour) is read with the current code and must reproduce, exactly, the digest
 * origin/main's ingestion code produced (pinned with its provenance in __fixtures__/ingest-characterization.json).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { readTrialBalanceSource, type XlsxLike } from "../../../supabase/functions/_shared/tbSource";
import { characterizationCorpus, resultText } from "./characterizationCorpus";

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__/ingest-characterization.json"), "utf8")) as {
  provenance: Record<string, string>; digests: Record<string, string>;
};

describe("ingestion characterization (no layout)", () => {
  const corpus = characterizationCorpus();

  it("the corpus is the pinned one: same cases, nothing dropped", () => {
    expect(corpus.map((c) => c.name).sort()).toEqual(Object.keys(golden.digests).sort());
    expect(corpus.length).toBeGreaterThanOrEqual(150);
    expect(golden.provenance.generatedWith).toMatch(/^origin\/main [0-9a-f]{40}$/);
  });

  it("every case reproduces origin/main's output exactly", () => {
    const differ: string[] = [];
    for (const c of corpus) {
      const r = readTrialBalanceSource(c.bytes, { fileName: c.fileName, periodYear: c.periodYear, currency: c.currency }, XLSX as unknown as XlsxLike);
      // Keep every pinned behavioural digest. Only the intentionally bumped parser version is normalised.
      // The title-block evidence (tb-ingest-3.2.0, §3.3/§3.4) is a new, additive output with its own tests
      // (titleBlockEvidence.test.ts, reviewRules.test.ts), as are the review-only rules (§3.6); every pre-existing field stays pinned.
      const { evidence: _evidence, reviewChecks: _reviewChecks, ...pinned } = r;
      const digest = createHash("sha256").update(resultText({ ...pinned, version: "tb-ingest-3.0.0" })).digest("hex");
      if (digest !== golden.digests[c.name]) differ.push(c.name);
    }
    expect(differ).toEqual([]);
  }, 60_000);
});
