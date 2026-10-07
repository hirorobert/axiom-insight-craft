import { TONE_COLOR, TONE_ICON, type StatusWord as StatusWordValue } from "@/lib/workbench/statusWords";

/** A server status shown as text with an icon. Colour is never the only signal. */
export function StatusWord({ value, className }: { value: StatusWordValue; className?: string }) {
  return (
    <span className={className} style={{ color: TONE_COLOR[value.tone] }} data-tone={value.tone}>
      <span aria-hidden="true" className="inline-block w-[1.1em] text-center font-bold">{TONE_ICON[value.tone]}</span>
      {value.text}
    </span>
  );
}
