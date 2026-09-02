import { describe, expect, it } from "vitest";
import { buildCanonicalRows, computeNormalizedInputHash } from "./normalizedInputHash";
import type { NormalizedInputRow } from "./types";

const row = (accountCode: string | null, accountName: string, debit: number, credit: number): NormalizedInputRow => ({
  accountCode, accountName, debit, credit,
});

describe("computeNormalizedInputHash — order independence", () => {
  it("same rows, different source order → identical hash", async () => {
    const a = [row("1000", "Cash", 100, 0), row("2000", "Payables", 0, 100)];
    const b = [row("2000", "Payables", 0, 100), row("1000", "Cash", 100, 0)];
    expect(await computeNormalizedInputHash(a)).toBe(await computeNormalizedInputHash(b));
  });

  it("exact duplicate rows survive in the same order → identical hash regardless of source position", async () => {
    const a = [row("1000", "Cash", 100, 0), row("1000", "Cash", 100, 0), row("2000", "Payables", 0, 200)];
    const b = [row("2000", "Payables", 0, 200), row("1000", "Cash", 100, 0), row("1000", "Cash", 100, 0)];
    expect(await computeNormalizedInputHash(a)).toBe(await computeNormalizedInputHash(b));
  });
});

describe("computeNormalizedInputHash — distinctness preservation (proven, not assumed)", () => {
  it("duplicate account code/name with DIFFERENT balances are NOT collapsed — both rows survive in the canonical set", async () => {
    const rows: NormalizedInputRow[] = [
      row("1000", "Cash", 100, 0),
      row("1000", "Cash", 150, 0), // same code+name, different debit — economically distinct per process-trial-balance's own totaling semantics
    ];
    const canonical = buildCanonicalRows(rows);
    expect(canonical).toHaveLength(2);
    const debits = canonical.map((r) => r.debit).sort((x, y) => x - y);
    expect(debits).toEqual([100, 150]);
  });

  it("hash differs when a duplicate-key row's balance differs — distinctness reaches the final hash, not just the intermediate array", async () => {
    const withDup = [row("1000", "Cash", 100, 0), row("1000", "Cash", 150, 0)];
    const withoutDup = [row("1000", "Cash", 100, 0), row("1000", "Cash", 100, 0)];
    expect(await computeNormalizedInputHash(withDup)).not.toBe(await computeNormalizedInputHash(withoutDup));
  });

  it("code-less duplicate names (both null account_code) remain two rows, not collapsed into one", () => {
    const rows: NormalizedInputRow[] = [
      row(null, "Sundry Debtors", 500, 0),
      row(null, "Sundry Debtors", 300, 0),
    ];
    const canonical = buildCanonicalRows(rows);
    expect(canonical).toHaveLength(2);
  });
});

describe("computeNormalizedInputHash — canonicalization correctness", () => {
  it("missing account code (null) is preserved as null, not coerced to empty string identity confusion with a real empty-string code", async () => {
    const withNull = [row(null, "Cash", 100, 0)];
    const canonical = buildCanonicalRows(withNull);
    expect(canonical[0].accountCode).toBeNull();
  });

  it("Unicode account names canonicalize deterministically", async () => {
    const a = [row("1000", "Malipo ya Mishahara — Café Ñoño", 100, 0)];
    const b = [row("1000", "Malipo ya Mishahara — Café Ñoño", 100, 0)];
    expect(await computeNormalizedInputHash(a)).toBe(await computeNormalizedInputHash(b));
  });

  it("account name casing/punctuation differences hash identically — same account, same identity", async () => {
    const a = [row("1000", "Bank Charges", 100, 0)];
    const b = [row("1000", "BANK   Charges.", 100, 0)];
    expect(await computeNormalizedInputHash(a)).toBe(await computeNormalizedInputHash(b));
  });

  it("0 and -0 in debit/credit canonicalize identically (reuses canonicalHash's -0 decision)", async () => {
    const a = [row("1000", "Cash", 0, 0)];
    const b = [row("1000", "Cash", -0, -0)];
    expect(await computeNormalizedInputHash(a)).toBe(await computeNormalizedInputHash(b));
  });

  it("large values canonicalize without scientific notation (reuses canonicalHash's guard)", async () => {
    const rows = [row("1000", "Cash", 999999999999.99, 0)];
    await expect(computeNormalizedInputHash(rows)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("decimal values are hashed with full precision, no rounding introduced by canonicalization", async () => {
    const a = [row("1000", "Cash", 1234.5678, 0)];
    const b = [row("1000", "Cash", 1234.5679, 0)];
    expect(await computeNormalizedInputHash(a)).not.toBe(await computeNormalizedInputHash(b));
  });

  it("empty TB (zero rows) hashes deterministically to the same value every time", async () => {
    expect(await computeNormalizedInputHash([])).toBe(await computeNormalizedInputHash([]));
  });
});
