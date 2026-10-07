/**
 * Test helpers for jsdom component tests (used only by *.test.ts files with `// @vitest-environment jsdom`).
 * Mounts with React 18's act(), dispatches real keyboard events and runs axe-core.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted { container: HTMLElement; root: Root; rerender(el: ReactElement): void; unmount(): void }

export function mount(el: ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
  return {
    container,
    root,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
}

export function key(target: Element, k: string, opts: { shiftKey?: boolean } = {}) {
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, shiftKey: !!opts.shiftKey })); });
}

export function click(target: Element) {
  act(() => { (target as HTMLElement).click(); });
}

/** Sets a controlled input's value the way React observes it. */
export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

/** axe-core violations (WCAG 2.x A/AA rules). Colour contrast is verified from the colour tokens instead (no layout in jsdom). */
export async function axeViolations(node: Element): Promise<string[]> {
  const r = await axe.run(node, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, rules: { "color-contrast": { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.help}`);
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
