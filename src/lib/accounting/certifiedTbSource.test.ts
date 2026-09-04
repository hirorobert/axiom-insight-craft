import { describe, it, expect } from "vitest";
import {
  interpretCertification,
  normalizeCertifiedRow,
  resolveCashState,
  certifiedRowKey,
  sumRequiringAll,
} from "../../../supabase/functions/_shared/certifiedTbSource";

const row = (over: Record<string, unknown> = {}) => ({
  accountCode: "1001",
  accountName: "Cash at bank",
  nature: "asset",
  subNature: "current_assets",
  debitBalance: 1000,
  creditBalance: 0,
  netBalance: 1000,
  evidenceTier: 1,
  requiresReview: false,
  ...over,
});

describe("normalizeCertifiedRow", () => {
  it("reads a well-formed certified row", () => {
    expect(normalizeCertifiedRow(row())).toMatchObject({
      accountCode: "1001",
      subNature: "current_assets",
      debitBalance: 1000,
      netBalance: 1000,
    });
  });

  it("returns null (unknown) rather than zero when balances are missing", () => {
    expect(normalizeCertifiedRow(row({ debitBalance: undefined }))).toBeNull();
    expect(normalizeCertifiedRow(row({ creditBalance: "abc" }))).toBeNull();
  });

  it("returns null when certified classification is absent", () => {
    expect(normalizeCertifiedRow(row({ subNature: undefined }))).toBeNull();
    expect(normalizeCertifiedRow(row({ nature: undefined }))).toBeNull();
  });

  it("derives net balance from debit/credit when absent", () => {
    expect(normalizeCertifiedRow(row({ netBalance: null, debitBalance: 300, creditBalance: 120 })!)!.netBalance)
      .toBe(180);
  });
});

describe("interpretCertification", () => {
  it("is CANNOT_ASSESS when no certification exists", () => {
    expect(interpretCertification(null).state).toBe("CANNOT_ASSESS");
  });

  it("is CANNOT_ASSESS when the certification is blocking", () => {
    const r = interpretCertification({ is_blocking: true, rows_snapshot: [row()] });
    expect(r.state).toBe("CANNOT_ASSESS");
  });

  it("is CANNOT_ASSESS when the snapshot carries no rows", () => {
    expect(interpretCertification({ is_blocking: false, rows_snapshot: [] }).state).toBe("CANNOT_ASSESS");
  });

  it("fails closed when any snapshot row is unreadable", () => {
    const r = interpretCertification({ is_blocking: false, rows_snapshot: [row(), { accountName: "x" }] });
    expect(r.state).toBe("CANNOT_ASSESS");
  });

  it("returns KNOWN with provenance for a clean certification", () => {
    const r = interpretCertification({
      id: "cert-1",
      upload_id: "up-1",
      period_year: 2026,
      source_file_hash: "abc",
      certified_at: "2026-01-01T00:00:00Z",
      is_blocking: false,
      requires_review: false,
      rows_snapshot: [row(), row({ accountCode: "4000", subNature: "revenue", nature: "income" })],
    });
    expect(r.state).toBe("KNOWN");
    if (r.state !== "KNOWN") return;
    expect(r.value.certificationId).toBe("cert-1");
    expect(r.value.sourceFileHash).toBe("abc");
    expect(r.value.rows).toHaveLength(2);
  });
});

describe("resolveCashState (tri-state authority)", () => {
  const perimeter = { decided: new Map<string, boolean>([["1001", true], ["1200", false]]) };

  it("resolves explicit professional decisions", () => {
    expect(resolveCashState(perimeter, "1001")).toBe("CASH");
    expect(resolveCashState(perimeter, "1200")).toBe("NOT_CASH");
  });

  it("treats an undecided account as UNKNOWN, never as NOT_CASH", () => {
    expect(resolveCashState(perimeter, "1500")).toBe("UNKNOWN");
  });
});

describe("certifiedRowKey", () => {
  it("prefers the account code", () => {
    expect(certifiedRowKey({ accountCode: "1001", accountName: "Cash" })).toBe("1001");
  });

  it("falls back to the normalized account name", () => {
    expect(certifiedRowKey({ accountCode: null, accountName: "  Trade Receivables (Net) " }))
      .toBe("trade receivables net");
  });
});

describe("sumRequiringAll", () => {
  it("sums when every component is known", () => {
    expect(sumRequiringAll([10, 20, -5])).toBe(25);
  });

  it("is unknown when any component is unknown", () => {
    expect(sumRequiringAll([10, null, 5])).toBeNull();
  });

  it("distinguishes an explicit zero from unknown", () => {
    expect(sumRequiringAll([0, 0])).toBe(0);
  });

  it("fails closed on non-finite input", () => {
    expect(sumRequiringAll([Number.POSITIVE_INFINITY, 1])).toBeNull();
  });
});
