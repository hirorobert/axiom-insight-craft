// @vitest-environment jsdom
/**
 * Provisional performance measurements for Trial balance › Intake (recorded, not capacity claims). Dataset: the largest
 * input the upload policy admits (uploadPolicy.ts: rows including the header, and cells, both exactly at the limit) — read
 * under a confirmed layout exactly as the server does
 * (readTrialBalanceSourceWithLayout), and the resulting every-row report rendered in the workbench table. The budgets are
 * generous ceilings for CI hardware; the measured values are printed for the release record.
 */
import { createElement as h } from "react";
import * as XLSX from "xlsx";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable } from "@/components/workbench/DataTable";
import { mount, type Mounted } from "../testkit/dom";
import { profileSha256, type LayoutProfile } from "../../../../supabase/functions/_shared/layoutProfile";
import { readTrialBalanceSourceWithLayout, type XlsxLike } from "../../../../supabase/functions/_shared/tbSource";
import { TB_UPLOAD_POLICY } from "../../../../supabase/functions/_shared/uploadPolicy";

// At the policy's limits: ROWS data rows + the header = maxRows lines; ROWS + 1 lines × COLUMNS ≤ maxCells.
const ROWS = TB_UPLOAD_POLICY.maxRows - 1;
const COLUMNS = Math.floor(TB_UPLOAD_POLICY.maxCells / TB_UPLOAD_POLICY.maxRows);
const BUDGET_MS = { serverRead: 10_000, firstPage: 2_000 };

function bigCsv(rows = ROWS, columns = COLUMNS): Uint8Array {
  const header = ["Code", "Name", "Soll", "Haben", ...Array.from({ length: columns - 4 }, (_, i) => `Memo ${i + 1}`)].join(";");
  const lines = [header];
  for (let i = 0; i < rows; i++) {
    const amount = `${(i % 9) + 1}.${String(i % 1000).padStart(3, "0")},${String((i % 99) + 1).padStart(2, "0")}`; // e.g. 3.217,19 — never zero
    const debit = i % 2 === 0;
    lines.push([`A${i}`, `Account ${i}`, debit ? amount : "", debit ? "" : amount, ...Array.from({ length: columns - 4 }, () => "x")].join(";"));
  }
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; });

describe("intake performance (provisional budgets)", () => {
  it(`reads ${ROWS.toLocaleString("en")} rows × ${COLUMNS} columns under a layout and renders the first page of the every-row report`, async () => {
    const bytes = bigCsv();
    expect(bytes.length).toBeLessThanOrEqual(TB_UPLOAD_POLICY.maxFileBytes);
    const layout: LayoutProfile = { format: "layout-template/1", sheet: { kind: "csv" }, headerRow: 1, numberFormat: "dot_comma", balanceSign: null,
      columns: { accountCode: "Code", accountName: "Name", debit: "Soll", credit: "Haben", balance: null, dimensions: [] } };
    const t0 = performance.now();
    const read = readTrialBalanceSourceWithLayout(bytes, { fileName: "big.csv", periodYear: 2025, currency: "TZS" }, XLSX as unknown as XlsxLike, layout, await profileSha256(layout));
    const serverRead = performance.now() - t0;
    expect(read.resolved).not.toBeNull();
    expect(read.result.lineage).toHaveLength(ROWS + 1);
    expect(read.result.accounts).toHaveLength(ROWS);

    const rows = read.result.lineage.map((l) => ({ rowNumber: l.rowNumber, disposition: l.disposition, detail: l.identity ?? l.reason ?? null }));
    const t1 = performance.now();
    m = mount(h(DataTable<(typeof rows)[number]>, {
      label: "Every row of the file", rows, rowId: (r) => String(r.rowNumber),
      columns: [{ id: "row", header: "Row", render: (r) => String(r.rowNumber) }, { id: "d", header: "Read as", render: (r) => r.disposition }, { id: "x", header: "Detail", render: (r) => r.detail ?? "—" }],
    }));
    const firstPage = performance.now() - t1;
    console.log(`[intake perf] file ${(bytes.length / 1e6).toFixed(2)} MB; server read under layout ${serverRead.toFixed(0)} ms (budget ${BUDGET_MS.serverRead}); report first page ${firstPage.toFixed(0)} ms (budget ${BUDGET_MS.firstPage}); rendered rows ${m.container.querySelectorAll("tbody tr").length}`);
    expect(serverRead).toBeLessThan(BUDGET_MS.serverRead);
    expect(firstPage).toBeLessThan(BUDGET_MS.firstPage);
  }, 60_000);

  it("the former 20,000-row × 40-column dataset is now refused by name before any check (no rows accepted, nothing truncated)", async () => {
    const layout: LayoutProfile = { format: "layout-template/1", sheet: { kind: "csv" }, headerRow: 1, numberFormat: "dot_comma", balanceSign: null,
      columns: { accountCode: "Code", accountName: "Name", debit: "Soll", credit: "Haben", balance: null, dimensions: [] } };
    const read = readTrialBalanceSourceWithLayout(bigCsv(20_000, 40), { fileName: "big.csv", periodYear: 2025, currency: "TZS" }, XLSX as unknown as XlsxLike, layout, await profileSha256(layout));
    expect(read.result.issues.map((i) => i.code)).toContain("TOO_MANY_ROWS");
    expect(read.result.accounts).toHaveLength(0);
    expect(read.result.blocking).toBe(true);
  }, 60_000);
});
