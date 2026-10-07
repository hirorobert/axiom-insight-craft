// @vitest-environment jsdom
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable, type DataColumn } from "@/components/workbench/DataTable";
import type { AmountCell } from "@/lib/presentation/amounts";
import { batchEligibility, matchesQuery, rovingIndex } from "./table";
import { axeViolations, click, key, mount, type Mounted } from "./testkit/dom";

type Row = { code: string; name: string; bal: AmountCell; needs: boolean };
const rows: Row[] = [
  { code: "1000", name: "Cash at bank – CRDB current account", bal: { kind: "amount", minor: 4820000000n, exponent: 2 }, needs: false },
  { code: "1410", name: "Suspense", bal: { kind: "amount", minor: 0n, exponent: 2 }, needs: true },
  { code: "2000", name: "Trade payables", bal: { kind: "amount", minor: -1870000000n, exponent: 2 }, needs: true },
  { code: "3100", name: "Retained earnings", bal: { kind: "missing", reason: "not computed" }, needs: false },
  { code: "6000", name: "Administrative expenses", bal: { kind: "stale", minor: 3826000000n, exponent: 2, reason: "account changed" }, needs: false },
];
const cols: DataColumn<Row>[] = [
  { id: "code", header: "Code", render: (r) => r.code },
  { id: "name", header: "Account", render: (r) => r.name, wrap: true },
  { id: "bal", header: "Balance", kind: "amount", render: (r) => r.bal },
];

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; });

describe("table rules", () => {
  it("roving focus clamps at the edges", () => {
    expect(rovingIndex(0, "ArrowUp", 5)).toBe(0);
    expect(rovingIndex(4, "ArrowDown", 5)).toBe(4);
    expect(rovingIndex(2, "Home", 5)).toBe(0);
    expect(rovingIndex(2, "End", 5)).toBe(4);
    expect(rovingIndex(2, "x", 5)).toBeNull();
  });
  it("a batch needs every selected row to qualify, and says why not", () => {
    const check = (r: Row) => (r.needs ? true : "Every selected account must need review.");
    expect(batchEligibility([rows[1], rows[2]], (r) => r.code, check)).toEqual({ ok: true });
    expect(batchEligibility([rows[1], rows[0]], (r) => r.code, check)).toEqual({ ok: false, reason: "Every selected account must need review.", failing: ["1000"] });
    expect(batchEligibility([], (r) => r.code, check).ok).toBe(false);
  });
  it("search matches every term", () => {
    expect(matchesQuery("cash crdb", ["1000", "Cash at bank – CRDB"])).toBe(true);
    expect(matchesQuery("cash nmb", ["1000", "Cash at bank – CRDB"])).toBe(false);
  });
});

describe("DataTable", () => {
  it("renders value states distinctly, right-aligns amounts, and passes axe", async () => {
    m = mount(h(DataTable<Row>, { label: "Accounts", columns: cols, rows, rowId: (r) => r.code }));
    const states = [...m.container.querySelectorAll("[data-state]")].map((e) => [e.getAttribute("data-state"), e.textContent]);
    expect(states).toEqual([
      ["amount", "48,200,000.00"],
      ["zero", "0.00"],
      ["amount", "(18,700,000.00)"],
      ["missing", "— (Not available: not computed)"],
      ["stale", "↻ 38,260,000.00 (Stale: account changed)"],
    ]);
    expect(m.container.querySelector("th:last-child")!.className).toContain("text-right");
    expect(m.container.querySelector("thead th")!.className).toContain("sticky");
    expect(await axeViolations(m.container)).toEqual([]);
  });
  it("moves focus with the keyboard, selects with Space, opens with Enter", () => {
    const onOpen = vi.fn();
    m = mount(h(DataTable<Row>, { label: "Accounts", columns: cols, rows, rowId: (r) => r.code, selectable: true, onOpen,
      batchActions: [{ id: "rev", label: "Mark reviewed", check: (r: Row) => (r.needs ? true : "Every selected account must need review."), run: () => {} }] }));
    const trs = () => [...m!.container.querySelectorAll<HTMLTableRowElement>("tr[data-row]")];
    expect(trs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    trs()[0].focus();
    key(trs()[0], "ArrowDown");
    expect((document.activeElement as HTMLElement).dataset.row).toBe("1410");
    key(document.activeElement!, " ");
    expect(trs()[1].getAttribute("aria-selected")).toBe("true");
    const batch = [...m.container.querySelectorAll("button")].find((b) => b.textContent === "Mark reviewed") as HTMLButtonElement;
    expect(batch.disabled).toBe(false);
    key(document.activeElement!, "ArrowUp");
    key(document.activeElement!, " ");
    expect(batch.disabled).toBe(true);
    expect(m.container.textContent).toContain("Every selected account must need review.");
    key(document.activeElement!, "Enter");
    expect(onOpen).toHaveBeenCalledWith(rows[0]);
  });
  it("runs a batch only on the selected, eligible rows and then clears the selection", () => {
    const run = vi.fn();
    m = mount(h(DataTable<Row>, { label: "Accounts", columns: cols, rows, rowId: (r) => r.code, selectable: true, batchActions: [{ id: "rev", label: "Mark reviewed", check: (r: Row) => (r.needs ? true : "no"), run }] }));
    for (const id of ["1410", "2000"]) click(m.container.querySelector(`input[aria-label="Select ${id}"]`)!);
    click([...m.container.querySelectorAll("button")].find((b) => b.textContent === "Mark reviewed")!);
    expect(run).toHaveBeenCalledWith([rows[1], rows[2]]);
    expect(m.container.textContent).toContain("0 selected");
  });
  it("explains a failure beside its row", () => {
    m = mount(h(DataTable<Row>, { label: "Accounts", columns: cols, rows, rowId: (r) => r.code, rowMessage: (r) => (r.code === "2000" ? "Malformed amount in row 14. Correct the file and upload again." : null) }));
    const alert = m.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("row 14");
    expect(alert.closest("tr")!.previousElementSibling!.getAttribute("data-row")).toBe("2000");
  });
});

describe("DataTable performance (jsdom proxy; see the implementation report for browser measurements)", () => {
  const big: Row[] = Array.from({ length: 20000 }, (_, i) => ({ code: String(100000 + i), name: `Account ${i}`, bal: { kind: "amount", minor: BigInt(i * 137), exponent: 2 }, needs: i % 7 === 0 }));
  it("at the 20,000-row intake limit renders the first 500 rows quickly and reveals the rest on request", () => {
    const t0 = performance.now();
    m = mount(h(DataTable<Row>, { label: "Accounts", columns: cols, rows: big, rowId: (r) => r.code }));
    const ms = performance.now() - t0;
    console.info(`[perf] DataTable 20,000 rows, first 500 rendered (jsdom): ${ms.toFixed(0)} ms`);
    expect(m.container.querySelectorAll("tr[data-row]").length).toBe(500);
    expect(m.container.textContent).toContain("Showing 500 of 20,000 rows");
    expect(ms).toBeLessThan(2500); // jsdom proxy budget; the full 20,000-row render measured 6,912 ms here before paging
    click([...m.container.querySelectorAll("button")].find((b) => b.textContent === "Show next 500")!);
    expect(m.container.querySelectorAll("tr[data-row]").length).toBe(1000);
  }, 120_000);
  it("keyboard End stays within the rendered rows", () => {
    m = mount(h(DataTable<Row>, { label: "Accounts", columns: cols, rows: big, rowId: (r) => r.code, pageSize: 50 }));
    const first = m.container.querySelector<HTMLTableRowElement>("tr[data-row]")!;
    first.focus();
    key(first, "End");
    expect((document.activeElement as HTMLElement).dataset.row).toBe(String(100000 + 49));
  }, 120_000);
});
