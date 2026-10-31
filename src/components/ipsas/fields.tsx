import { useContext, useEffect, useRef, useState } from "react";
import { fromMinor, toMinor } from "@/lib/ipsasAccrual/draft";
import { ExponentContext } from "./exponentContext";

const input = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const label = "block text-xs font-medium text-muted-foreground mb-1";

export function Text({ id, name, value, onChange, hint, disabled, type = "text" }: { id: string; name: string; value: string; onChange: (v: string) => void; hint?: string; disabled?: boolean; type?: string }) {
  return (
    <div>
      <label htmlFor={id} className={label}>{name}</label>
      <input id={id} type={type} className={input} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** An amount typed in major units ("1,234.50"); the stored value is exact minor units, "" while the text is not an exact amount. */
export function Amount({ id, name, value, onChange, hint, disabled }: { id: string; name: string; value: string; onChange: (minor: string) => void; hint?: string; disabled?: boolean }) {
  const exponent = useContext(ExponentContext);
  const [text, setText] = useState(exponent === null ? "" : fromMinor(value, exponent));
  const focused = useRef(false);
  useEffect(() => { if (exponent !== null && !focused.current && (toMinor(text, exponent) ?? "") !== value) setText(fromMinor(value, exponent)); }, [value, text, exponent]);
  if (exponent === null) {
    return (
      <div>
        <label htmlFor={id} className={label}>{name}</label>
        <input id={id} className={input} value="" disabled readOnly aria-describedby={`${id}-hint`} />
        <p id={`${id}-hint`} className="mt-1 text-xs text-destructive">The reporting currency and units are not confirmed, so no amount can be entered or read here.</p>
      </div>
    );
  }
  const bad = text.trim() !== "" && toMinor(text, exponent) === null;
  return (
    <div>
      <label htmlFor={id} className={label}>{name}</label>
      <input id={id} inputMode="decimal" className={`${input} ${bad ? "border-destructive" : ""}`} value={text} disabled={disabled} aria-invalid={bad}
        aria-describedby={`${id}-hint`} onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }}
        onChange={(e) => { setText(e.target.value); onChange(toMinor(e.target.value, exponent) ?? ""); }} />
      <p id={`${id}-hint`} className={`mt-1 text-xs ${bad ? "text-destructive" : "text-muted-foreground"}`}>{bad ? `Not an exact amount (${exponent === 0 ? "whole units only, no decimals" : `at most ${exponent} decimal place${exponent === 1 ? "" : "s"}`}).` : hint ?? "Blank means not yet known — it is never read as zero."}</p>
    </div>
  );
}

export function Select({ id, name, value, onChange, options, disabled }: { id: string; name: string; value: string; onChange: (v: string) => void; options: [string, string][]; disabled?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className={label}>{name}</label>
      <select id={id} className={input} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}
