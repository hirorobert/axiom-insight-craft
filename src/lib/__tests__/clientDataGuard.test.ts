/**
 * The repository carries no client records: every tracked text file is free of denylisted identifiers and amounts
 * (stored as salted hashes only) and of text that labels its content as taken from a client's books.
 * The seeded cases prove each detector fires on an injected denylist, so a weakened guard cannot pass silently.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DENYLIST, EXCLUDED, makeScanner, normaliseAmount, scanFiles, trackedTextFiles } from "../../../scripts/ci/clientDataGuard.mjs";

const SALT = "seeded-test-salt:";
const digest = (token: string) => createHash("sha256").update(SALT + token).digest("hex");
// An injected denylist of invented tokens: the word "zanzibarqa" and the amount 7,412,369.53.
const seeded = makeScanner({ salt: SALT, words: [digest("zanzibarqa")], amounts: [digest("7412369.53")] });

describe("client-data guard", () => {
  it("the current tree has no hit", () => {
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(1000);
    expect(scanFiles(files)).toEqual([]);
  });

  it("detects a denylisted identifier, case-insensitively, by its hash", () => {
    expect(seeded("const company = 'Zanzibarqa Council';")).toEqual([{ kind: "denylisted-token", at: 17 }]);
    expect(seeded("const company = 'Mfano District Council';")).toEqual([]);
  });

  it("detects a denylisted amount in every written form", () => {
    for (const text of ["debit: 7412369.53", "TZS 7,412,369.53", "credit: 7_412_369.53", "7412369.530"]) {
      expect(seeded(text), text).toEqual([expect.objectContaining({ kind: "denylisted-amount" })]);
    }
    expect(seeded("debit: 7412369.54")).toEqual([]);
  });

  it("detects text that labels its balances as genuine client data", () => {
    // Built by concatenation so this file's own text never matches the patterns it tests.
    expect(seeded("/** " + "REAL" + " debit/credit balances from a council trial balance */")).toEqual([
      expect.objectContaining({ kind: "self-labelled-real" }),
    ]);
    expect(seeded("// a clean trial balance extracted from the client's " + "audited accounts")).toHaveLength(1);
    expect(seeded("// independently invented synthetic data")).toEqual([]);
  });

  it("ignores amounts too small or too round to identify anything", () => {
    expect(normaliseAmount("999999.99")).toBeNull();
    expect(normaliseAmount("1_250_000_000.0")).toBeNull();
    expect(normaliseAmount("18400000")).toBeNull();
    expect(normaliseAmount("1234567")).toBe("1234567.00");
    expect(normaliseAmount("7,412,369.53")).toBe("7412369.53");
  });

  it("the committed denylist holds hashes only — no identifier or amount in clear text", () => {
    for (const h of [...DENYLIST.words, ...DENYLIST.amounts]) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(DENYLIST.amounts.length).toBeGreaterThan(300);
    expect(DENYLIST.words.length).toBeGreaterThan(0);
  });

  it("only immutable migration chains, lockfiles and binaries are outside the scan", () => {
    const excluded = (p: string) => EXCLUDED.some((re: RegExp) => re.test(p));
    expect(excluded("supabase/migrations/20260101000000_x.sql")).toBe(true);
    expect(excluded("release/wrappers/20261020100000_x.wrapper.sql")).toBe(true);
    expect(excluded("src/lib/accounting/anything.fixture.ts")).toBe(false);
    expect(excluded("scripts/fixtures/synthetic-sme-tb-2025.csv")).toBe(false);
    expect(excluded("docs/anything.md")).toBe(false);
    expect(excluded("supabase/functions/process-trial-balance/index.ts")).toBe(false);
  });
});
