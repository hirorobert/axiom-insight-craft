/**
 * commercial-p3 correction: 20261031100000_sandbox_licence_isolation.sql was submitted once and failed atomically on the
 * hosted database (PT422 CANCELLED_LICENCE_IMMUTABLE; journal stayed at 53). It is superseded by 20261031110000. The exact
 * submitted bytes are kept as a record (source quarantined, wrapper in release/wrappers_historical/) and pinned; they are
 * never a registered submission form and never in the replayed chain.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { SUPERSEDED_SUBMISSIONS, currentChain } from "../../../scripts/db-proof/lib/parkedMigrations.mjs";
import { SUBMISSION_FORMS, submittedForm } from "../../../scripts/ci/releaseJournal.mjs";
import { RELEASE_BATCHES, wrapperFile } from "../../../scripts/release/selfCheckingWrapper.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const bytes = (p: string) => fs.readFileSync(path.join(ROOT, p));
const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const NOTICE_END = "-- ════════════════════════════════════════════════════════════════════════════\n\n";
const OLD = "20261031100000_sandbox_licence_isolation.sql";
const NEW = "20261031110000_sandbox_licence_isolation.sql";

/** The original bytes of a quarantined source: everything after its comment-only notice. */
const quarantined = (file: string) => {
  const text = bytes(file).toString("utf8");
  const at = text.indexOf(NOTICE_END);
  expect(text.startsWith("-- ════"), file).toBe(true);
  expect(at, file).toBeGreaterThan(0);
  const notice = text.slice(0, at + NOTICE_END.length);
  expect(notice.split("\n").filter((l) => l.length > 0).every((l) => l.startsWith("--")), "the notice is comment-only").toBe(true);
  return Buffer.from(text.slice(at + NOTICE_END.length), "utf8");
};

describe("superseded submissions (commercial-p3)", () => {
  const entry = SUPERSEDED_SUBMISSIONS[OLD];

  it("pins exactly the superseded sandbox licence isolation, superseded by 20261031110000", () => {
    expect(Object.keys(SUPERSEDED_SUBMISSIONS)).toEqual([OLD]);
    expect(entry.supersededBy).toBe(NEW);
    expect(entry.failure).toBe("PT422 CANCELLED_LICENCE_IMMUTABLE");
  });

  it("the quarantined source is the submitted bytes, byte for byte, after a comment-only notice", () => {
    const src = quarantined(entry.source.file);
    expect(src.length).toBe(entry.source.bytes);
    expect(sha256(src)).toBe(entry.source.sha256);
  });

  it("the historical wrapper is the submitted wrapper, byte for byte, and encloses that source", () => {
    const w = bytes(entry.wrapper.file);
    expect(w.length).toBe(entry.wrapper.bytes);
    expect(sha256(w)).toBe(entry.wrapper.sha256);
    expect(w.toString("utf8")).toContain(`c_sha256  CONSTANT text    := '${entry.source.sha256}';`);
  });

  it("is out of the replayed chain and out of release/wrappers/", () => {
    expect(currentChain(ROOT)).not.toContain(OLD);
    expect(currentChain(ROOT)).toContain(NEW);
    expect(fs.existsSync(path.join(ROOT, "supabase/migrations", OLD))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, wrapperFile(OLD)))).toBe(false);
    expect(RELEASE_BATCHES.flatMap((b) => [...b.sources])).not.toContain(OLD);
  });

  it("is never a registered submission form: neither its source nor its wrapper hash is registered for any source", () => {
    expect(OLD in SUBMISSION_FORMS).toBe(false);
    const registered = Object.values(SUBMISSION_FORMS).flatMap((f) => Object.values(f as Record<string, { sha256: string }>).map((x) => x.sha256));
    expect(registered).not.toContain(entry.source.sha256);
    expect(registered).not.toContain(entry.wrapper.sha256);
    const src = quarantined(entry.source.file), w = bytes(entry.wrapper.file);
    expect(submittedForm(OLD, src, w)).toBeNull();
    expect(submittedForm(OLD, src, src)).toBeNull();
    // Submitted in place of the replacement, it is not a form of the replacement either.
    expect(submittedForm(NEW, bytes(`supabase/migrations/${NEW}`), w)).toBeNull();
  });

  it("the replacement is commercial-p3's only source, with its own registered wrapper", () => {
    const p3 = RELEASE_BATCHES.find((b) => b.id === "commercial-p3");
    expect([...p3!.sources]).toEqual([NEW]);
    const w = bytes(wrapperFile(NEW));
    expect(submittedForm(NEW, bytes(`supabase/migrations/${NEW}`), w)).toBe("wrapper");
    expect(w.length).not.toBe(entry.wrapper.bytes);
  });
});
