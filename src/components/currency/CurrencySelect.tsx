/**
 * CurrencySelect — the one searchable currency selector (ARIA 1.2 combobox with a listbox popup).
 *
 *   · Typing filters the list visibly, by code or name; when nothing matches the popup says "No currencies found".
 *   · The value changes ONLY when the user explicitly chooses an option (click, or Enter on the highlighted option).
 *     Typing, leaving the field or pressing Escape never selects, guesses or defaults a currency; the previous explicit
 *     choice (or none) is kept.
 *   · Keyboard: ArrowDown/ArrowUp move through the matches, Enter chooses, Escape closes, Home/End jump.
 *
 * The caller renders the visible <label htmlFor={id}>. Options come from the caller (the server's registry, the ISO
 * registry or a fixed list); nothing is ordered by presumed geography. `noneOption` adds one explicit choice meaning
 * "no separate currency" (value ""), e.g. a prior period that uses this period's currency.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { CURRENCY_SELECT_COPY, currencyLabel, filterCurrencies, type CurrencyOption } from "@/lib/currency/currencyOptions";

export function CurrencySelect({ id, value, onChange, options: currencyOptions, noneOption, loading = false, disabled = false, describedBy, required, className, testId }: {
  id: string;
  /** The explicitly chosen ISO code, or "" when none has been chosen. */
  value: string;
  onChange: (code: string) => void;
  options: readonly CurrencyOption[];
  /** An explicit first choice meaning "none" (value ""), shown with this text. */
  noneOption?: string;
  loading?: boolean;
  disabled?: boolean;
  describedBy?: string;
  required?: boolean;
  className?: string;
  testId?: string;
}) {
  const listId = useId();
  const statusId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const options = useMemo<CurrencyOption[]>(() => (noneOption ? [{ code: "", name: noneOption }, ...currencyOptions] : [...currencyOptions]), [currencyOptions, noneOption]);
  const display = (o: CurrencyOption) => (o.code ? currencyLabel(o) : o.name ?? "");
  const selected = options.find((o) => o.code === value) ?? (value ? { code: value } : null);
  const matches = useMemo(() => filterCurrencies(options, query), [options, query]);
  const off = disabled || loading;

  const show = (q: string) => {
    setQuery(q);
    setOpen(true);
    // Highlight the current choice when it is among the matches, else the first match (highlight is not a choice).
    const list = filterCurrencies(options, q);
    const at = list.findIndex((o) => o.code === value);
    setActive(at >= 0 ? at : 0);
  };
  const close = () => { setOpen(false); setQuery(""); };
  const choose = (o: CurrencyOption) => { onChange(o.code); close(); };
  const scrollTo = (i: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  };
  const move = (i: number) => { const n = Math.max(0, Math.min(matches.length - 1, i)); setActive(n); scrollTo(n); };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (off) return;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); if (!open) show(query); else move(active + 1); break;
      case "ArrowUp": e.preventDefault(); if (!open) show(query); else move(active - 1); break;
      case "Home": if (open) { e.preventDefault(); move(0); } break;
      case "End": if (open) { e.preventDefault(); move(matches.length - 1); } break;
      case "Enter":
        if (open) { e.preventDefault(); const o = matches[active]; if (o) choose(o); }
        break;
      case "Escape": if (open) { e.preventDefault(); close(); } break;
      default: break;
    }
  };

  const optionId = (i: number) => `${listId}-o${i}`;
  return (
    <div className={cn("relative", className)} data-testid={testId ? `${testId}-field` : undefined}>
      <div className="relative">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? optionId(active) : undefined}
          aria-describedby={[describedBy, statusId].filter(Boolean).join(" ")}
          aria-required={required || undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={off}
          placeholder={loading ? CURRENCY_SELECT_COPY.loading : CURRENCY_SELECT_COPY.placeholder}
          value={open ? query : selected ? display(selected) : ""}
          onChange={(e) => show(e.target.value)}
          onClick={() => { if (!open && !off) show(""); }}
          onBlur={close}
          onKeyDown={onKeyDown}
          className="h-10 w-full border border-input bg-white px-3 pr-9 text-[14px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          data-testid={testId}
          data-value={value}
        />
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      </div>
      <div hidden={!open} className="absolute left-0 right-0 z-50 mt-1 border border-border bg-white shadow-md" data-testid={testId ? `${testId}-popup` : undefined}>
        <ul id={listId} ref={listRef} role="listbox" aria-label="Currencies" className="max-h-60 overflow-auto py-1" data-testid={testId ? `${testId}-list` : undefined}>
          {open && matches.map((o, i) => (
            <li
              key={o.code || "none"}
              id={optionId(i)}
              data-index={i}
              role="option"
              aria-selected={o.code === value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
              onMouseMove={() => { if (active !== i) setActive(i); }}
              className={cn("flex cursor-pointer items-center gap-2 px-3 py-2 text-[14px] text-foreground", i === active && "bg-muted")}
              data-testid={testId ? `${testId}-option-${o.code || "none"}` : undefined}
            >
              <span className="w-4 shrink-0">{o.code === value ? <Check className="h-4 w-4" aria-hidden="true" /> : null}</span>
              {o.code ? <span className="font-medium">{o.code}</span> : null}
              {o.name ? <span className={o.code ? "text-muted-foreground" : "text-foreground"}>{o.name}</span> : null}
            </li>
          ))}
        </ul>
        {open && matches.length === 0 && (
          <p className="px-3 py-2 text-[14px] text-muted-foreground" data-testid={testId ? `${testId}-none` : undefined}>{CURRENCY_SELECT_COPY.none}</p>
        )}
      </div>
      <span id={statusId} role="status" aria-live="polite" className="sr-only">
        {open ? (matches.length === 0 ? CURRENCY_SELECT_COPY.none : `${matches.length} ${matches.length === 1 ? "currency" : "currencies"} found`) : ""}
      </span>
    </div>
  );
}
