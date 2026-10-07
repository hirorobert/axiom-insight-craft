import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { batchEligibility, rovingIndex, type BatchCheck } from "@/lib/workbench/table";
import { presentAmount, type AmountCell } from "@/lib/presentation/amounts";

/**
 * The workbench data table: sticky header, tabular right-aligned amounts, roving keyboard focus (↑/↓/Home/End/PageUp/
 * PageDown), Space to select, Enter to open, guarded batch actions and row-level messages. Search and filters are
 * controlled by the caller (server-backed in the product); the table only renders what it is given.
 */
export interface DataColumn<Row> {
  readonly id: string;
  readonly header: string;
  /** "amount" columns are right-aligned with tabular numerals and render AmountCell values. */
  readonly kind?: "text" | "amount";
  readonly render: (row: Row) => ReactNode | AmountCell;
  /** Allow long text to wrap within the column (account names). */
  readonly wrap?: boolean;
}

export interface BatchAction<Row> {
  readonly id: string;
  readonly label: string;
  readonly check: BatchCheck<Row>;
  readonly run: (rows: readonly Row[]) => void;
}

export interface DataTableProps<Row> {
  readonly label: string;
  readonly columns: readonly DataColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowId: (row: Row) => string;
  readonly onOpen?: (row: Row) => void;
  readonly selectable?: boolean;
  readonly batchActions?: readonly BatchAction<Row>[];
  /** A message shown directly beneath a row (failure with its recovery action). */
  readonly rowMessage?: (row: Row) => ReactNode | null;
  readonly empty?: ReactNode;
  readonly maxHeight?: number;
  /** Rows rendered at first and per "Show next" step (measured: rendering 20,000 rows at once is too slow). */
  readonly pageSize?: number;
}

function AmountView({ cell }: { cell: AmountCell }) {
  const a = presentAmount(cell);
  const style = a.state === "missing" ? "text-muted-foreground" : a.state === "stale" ? "italic text-[#5b4b8a]" : a.state === "reference" ? "text-[#5f6b7a]" : "";
  return (
    <span className={style} data-state={a.state} title={a.description ?? undefined}>
      {a.state === "stale" ? <span aria-hidden="true">↻ </span> : null}
      {a.text}
      {a.description ? <span className="sr-only"> ({a.description})</span> : null}
    </span>
  );
}

const isAmountCell = (v: unknown): v is AmountCell =>
  !!v && typeof v === "object" && "kind" in (v as Record<string, unknown>) && ["amount", "missing", "stale", "reference"].includes(String((v as { kind: unknown }).kind));

export function DataTable<Row>(p: DataTableProps<Row>) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focusIndex, setFocusIndex] = useState(0);
  const pageSize = p.pageSize ?? 500;
  const [limit, setLimit] = useState(pageSize);
  const body = useRef<HTMLTableSectionElement>(null);
  const ids = useMemo(() => p.rows.map(p.rowId), [p.rows, p.rowId]);
  const visible = useMemo(() => p.rows.slice(0, limit), [p.rows, limit]);

  // Keep the selection to rows that still exist (filters or a refresh can remove rows).
  useEffect(() => {
    const present = new Set(ids);
    setSelected((s) => {
      const keep = [...s].filter((id) => present.has(id));
      return keep.length === s.size ? s : new Set(keep);
    });
    setFocusIndex((i) => Math.min(i, Math.max(Math.min(ids.length, limit) - 1, 0)));
  }, [ids, limit]);

  const focusRow = (i: number) => {
    setFocusIndex(i);
    const tr = body.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row]')[i];
    tr?.focus();
  };
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectedRows = p.rows.filter((r) => selected.has(p.rowId(r)));

  return (
    <div>
      {p.selectable && p.batchActions?.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-2" role="toolbar" aria-label={`${p.label} actions`}>
          <span className="text-sm text-muted-foreground" aria-live="polite">{selected.size} selected</span>
          {p.batchActions.map((a) => {
            const el = batchEligibility(selectedRows, p.rowId, a.check);
            return (
              <span key={a.id} className="inline-flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-md border border-input px-3 py-1 text-sm disabled:opacity-50"
                  disabled={!el.ok}
                  aria-describedby={el.ok === false && selected.size > 0 ? `${a.id}-why` : undefined}
                  onClick={() => { if (el.ok) { a.run(selectedRows); setSelected(new Set()); } }}
                >
                  {a.label}
                </button>
                {el.ok === false && selected.size > 0 ? <span id={`${a.id}-why`} className="text-sm text-muted-foreground">{el.reason}</span> : null}
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="overflow-auto border-y border-border" style={{ maxHeight: p.maxHeight ?? 520 }}>
        <table role="grid" className="w-full border-separate border-spacing-0 text-sm" aria-label={p.label} aria-multiselectable={p.selectable || undefined}>
          <thead>
            <tr>
              {p.selectable ? <th className="sticky top-0 z-[1] border-b border-border bg-background px-2 py-2"><span className="sr-only">Select</span></th> : null}
              {p.columns.map((c) => (
                <th key={c.id} scope="col" className={["sticky top-0 z-[1] whitespace-nowrap border-b border-border bg-background px-3 py-2 font-semibold text-muted-foreground", c.kind === "amount" ? "text-right" : "text-left"].join(" ")}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody ref={body}>
            {p.rows.length === 0 ? (
              <tr><td colSpan={p.columns.length + (p.selectable ? 1 : 0)} className="px-3 py-6 text-center text-muted-foreground">{p.empty ?? "Nothing to show."}</td></tr>
            ) : visible.flatMap((r, i) => {
              const id = p.rowId(r);
              const msg = p.rowMessage?.(r) ?? null;
              const row = (
                <tr
                  key={id}
                  data-row={id}
                  tabIndex={i === focusIndex ? 0 : -1}
                  aria-selected={p.selectable ? selected.has(id) : undefined}
                  className="outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#1f5fbf] aria-selected:bg-[#eef3fb]"
                  onFocus={() => setFocusIndex(i)}
                  onKeyDown={(e) => {
                    const next = rovingIndex(i, e.key, visible.length);
                    if (next !== null) { e.preventDefault(); focusRow(next); return; }
                    if (e.key === " " && p.selectable && e.target === e.currentTarget) { e.preventDefault(); toggle(id); return; }
                    if (e.key === "Enter" && p.onOpen && e.target === e.currentTarget) { e.preventDefault(); p.onOpen(r); }
                  }}
                >
                  {p.selectable ? (
                    <td className="border-b border-border/60 px-2 py-1.5">
                      <input type="checkbox" aria-label={`Select ${id}`} checked={selected.has(id)} onChange={() => toggle(id)} tabIndex={-1} />
                    </td>
                  ) : null}
                  {p.columns.map((c) => {
                    const v = c.render(r);
                    return (
                      <td key={c.id} className={["border-b border-border/60 px-3 py-1.5 align-top", c.kind === "amount" ? "whitespace-nowrap text-right tabular-nums" : "", c.wrap ? "max-w-[340px] [overflow-wrap:anywhere]" : ""].join(" ")}>
                        {isAmountCell(v) ? <AmountView cell={v} /> : (v as ReactNode)}
                      </td>
                    );
                  })}
                </tr>
              );
              return msg
                ? [row, <tr key={`${id}-msg`}><td colSpan={p.columns.length + (p.selectable ? 1 : 0)} className="border-b border-border/60 bg-[#fcf2f2] px-3 py-1.5 text-sm text-[#7a1a1a]" role="alert">{msg}</td></tr>]
                : [row];
            })}
          </tbody>
        </table>
      </div>
      {p.rows.length > visible.length ? (
        <div className="mt-2 flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">Showing {visible.length.toLocaleString("en-US")} of {p.rows.length.toLocaleString("en-US")} rows</span>
          <button type="button" className="rounded-md border border-input px-3 py-1" onClick={() => setLimit((l) => l + pageSize)}>
            Show next {Math.min(pageSize, p.rows.length - visible.length).toLocaleString("en-US")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
