import { describe, it, expect } from "vitest";
import {
  interpretCertification,
  normalizeCertifiedRow,
  resolveCashState,
  certifiedRowKey,
  sumRequiringAll,
  loadCashPerimeter,
  type CertifiedTbClient,
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

describe("loadCashPerimeter — S1 review provenance (20261006100000)", () => {
  // A stand-in for the service-role client: records the exact query and answers like PostgREST.
  const client = (rows: unknown[] | null, error: { message: string } | null = null) => {
    const seen: { table?: string; cols?: string; eq?: [string, unknown] } = {};
    const c: CertifiedTbClient = {
      rpc: async () => ({ data: null, error: null }),
      from: (table) => ({
        select: (cols) => ({
          eq: async (col, val) => { Object.assign(seen, { table, cols, eq: [col, val] }); return { data: rows, error }; },
        }),
      }),
    };
    return { c, seen };
  };

  it("reads only this company's rows, with review_decision_id", async () => {
    const { c, seen } = client([]);
    await loadCashPerimeter(c, "co-1");
    expect(seen).toEqual({ table: "account_mappings", cols: "account_key, is_cash_account, review_decision_id", eq: ["company_id", "co-1"] });
  });

  it("a flag counts only on a row with review provenance; unproven, cleared or malformed links decide nothing", async () => {
    const { c } = client([
      { account_key: "1000", is_cash_account: true, review_decision_id: "d-1" },   // reviewed cash
      { account_key: "1100", is_cash_account: false, review_decision_id: "d-2" },  // reviewed not-cash
      { account_key: "1200", is_cash_account: true, review_decision_id: null },    // unproven / cleared by an edit
      { account_key: "1300", is_cash_account: true },                              // field absent
      { account_key: "1400", is_cash_account: true, review_decision_id: "" },      // malformed
      { account_key: "1500", is_cash_account: true, review_decision_id: 42 },      // malformed
      { account_key: "1600", is_cash_account: null, review_decision_id: "d-3" },   // reviewed, flag undecided
    ]);
    const r = await loadCashPerimeter(c, "co-1");
    expect(r.state).toBe("KNOWN");
    const decided = (r as { value: { decided: Map<string, boolean> } }).value.decided;
    expect([...decided.entries()]).toEqual([["1000", true], ["1100", false]]);
    expect(resolveCashState({ decided }, "1200")).toBe("UNKNOWN");
    expect(resolveCashState({ decided }, "1600")).toBe("UNKNOWN");
  });

  it("mixed accounts: the reviewed account is known, the unproven one stays UNKNOWN (never NOT_CASH)", async () => {
    const { c } = client([
      { account_key: "1000", is_cash_account: true, review_decision_id: "d-1" },
      { account_key: "1001", is_cash_account: false, review_decision_id: null },
    ]);
    const r = await loadCashPerimeter(c, "co-1");
    const decided = (r as { value: { decided: Map<string, boolean> } }).value.decided;
    expect(resolveCashState({ decided }, "1000")).toBe("CASH");
    expect(resolveCashState({ decided }, "1001")).toBe("UNKNOWN");
  });

  it("pre-S1 schema (column review_decision_id does not exist) → CANNOT_ASSESS, never a perimeter", async () => {
    const { c } = client(null, { message: 'column account_mappings.review_decision_id does not exist' });
    const r = await loadCashPerimeter(c, "co-1");
    expect(r.state).toBe("CANNOT_ASSESS");
  });
});

describe("normalizeCertifiedRow — exact tb-row/1 fields (E2)", () => {
  const base = { accountCode: "1510", accountName: "Accumulated depreciation", nature: "asset", subNature: "non_current_assets", debitBalance: 0, creditBalance: 300, netBalance: 300 };
  it("a legacy row (no contract) has no exact fields and keeps its figures", () => {
    const r = normalizeCertifiedRow(base);
    expect(r?.rowContract).toBeNull();
    expect(r?.classSideMinor).toBeNull();
    expect(r?.creditBalance).toBe(300);
  });
  it("a tb-row/1 row exposes the exact figures, with the class side recomputed (a contra asset is negative)", () => {
    const r = normalizeCertifiedRow({ ...base, rowContract: "tb-row/1", debitMinor: "0", creditMinor: "30000", classSideMinor: "-30000" });
    expect(r).toMatchObject({ rowContract: "tb-row/1", debitMinor: "0", creditMinor: "30000", classSideMinor: "-30000" });
  });
  it("credit-side natures recompute credit − debit", () => {
    const r = normalizeCertifiedRow({ ...base, nature: "liability", subNature: "current_liabilities", rowContract: "tb-row/1", debitMinor: "100", creditMinor: "300", classSideMinor: "200" });
    expect(r?.classSideMinor).toBe("200");
  });
  it("a tb-row/1 row with a missing, malformed or inconsistent figure is unreadable (never a number)", () => {
    for (const bad of [
      { rowContract: "tb-row/1", debitMinor: "0", creditMinor: "30000" },
      { rowContract: "tb-row/1", debitMinor: "0", creditMinor: "300.00", classSideMinor: "-30000" },
      { rowContract: "tb-row/1", debitMinor: "-0", creditMinor: "30000", classSideMinor: "-30000" },
      { rowContract: "tb-row/1", debitMinor: "0", creditMinor: "30000", classSideMinor: "30000" },
      { rowContract: "tb-row/1", debitMinor: "-5", creditMinor: "0", classSideMinor: "-5" },
      { rowContract: "tb-row/2", debitMinor: "0", creditMinor: "30000", classSideMinor: "-30000" },
    ]) expect(normalizeCertifiedRow({ ...base, ...bad }), JSON.stringify(bad)).toBeNull();
  });
  it("exact beyond 2^53", () => {
    // The legacy float is whatever the engine wrote; the exact field is the string.
    const r = normalizeCertifiedRow({ ...base, debitBalance: Number("9007199254740993"), creditBalance: 0, rowContract: "tb-row/1", debitMinor: "9007199254740993", creditMinor: "0", classSideMinor: "9007199254740993" });
    expect(r?.classSideMinor).toBe("9007199254740993");
  });
});
