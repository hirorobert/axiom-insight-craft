import { useEffect, useId, useRef, type ReactNode } from "react";
import { trapTab, useFocusReturn } from "./useFocusReturn";

/**
 * Secondary panel for technical detail opened on demand (lineage, hashes, rule citations, history). Focus moves into it
 * when it opens; Esc or Close returns focus to the element that opened it (or `returnSelector` if that was re-rendered).
 */
export function SecondaryPanel({ open, title, onClose, returnSelector, children }: {
  open: boolean;
  title: string;
  onClose: () => void;
  returnSelector?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return <PanelOpen title={title} onClose={onClose} returnSelector={returnSelector}>{children}</PanelOpen>;
}

function PanelOpen({ title, onClose, returnSelector, children }: { title: string; onClose: () => void; returnSelector?: string; children: ReactNode }) {
  const titleId = useId();
  const box = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useFocusReturn(true, returnSelector);
  useEffect(() => { close.current?.focus(); }, []);
  return (
    <aside
      ref={box}
      role="complementary"
      aria-labelledby={titleId}
      className="fixed right-0 top-0 z-50 h-screen w-[420px] max-w-[96vw] overflow-auto border-l border-border bg-background p-5 shadow-lg"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } trapTab(e, box.current); }}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold">{title}</h2>
        <button ref={close} type="button" className="rounded-md border border-input px-2 py-1 text-sm" onClick={onClose}>Close</button>
      </div>
      <div className="mt-3 text-sm">{children}</div>
    </aside>
  );
}
