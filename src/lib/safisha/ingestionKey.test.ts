/**
 * The ingestion identity as the product sends it: one key per selected evidence file, created at selection and reused by
 * every request for that selection (retries, the re-call after column mapping). Behaviour against the database is proven
 * by scripts/db-proof/safishaIngestion.mjs; this pins the caller wiring.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newIngestionKey } from "./ingestionKey";

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const GATE = read("src/components/safisha/SafishaGate.tsx");
const MODAL = read("src/components/safisha/FieldMappingModal.tsx");

describe("ingestion keys", () => {
  it("every selection gets a new key (a new upload action is never assumed to be a retry)", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIngestionKey()));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the key is created once, when the file is selected, and stored with that selection", () => {
    expect(GATE).toContain('toAdd.push({ file: f, sourceType, isPdf, ingestionKey: newIngestionKey(), status: "queued" });');
    expect(GATE.match(/newIngestionKey\(\)/g)).toHaveLength(1);
  });

  it("every ingest request for a selection sends that selection's key — including the re-call after column mapping", () => {
    expect(GATE).toContain('form.append("ingestion_key", ev.ingestionKey);');
    expect(GATE).toContain("ingestionKey:      ev.ingestionKey,");
    expect(GATE).toContain("ingestionKey={mappingNeeded.ingestionKey}");
    expect(MODAL).toContain('form.append("ingestion_key",   ingestionKey);');
  });
});
