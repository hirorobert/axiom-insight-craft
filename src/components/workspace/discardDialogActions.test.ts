/**
 * discardDialogActions.test.ts — the safe action ("Keep current upload") precedes the destructive one ("Discard
 * upload") in the DOM, in tab order, for screen readers, and on screen at every width: stacked on top on phones, on the
 * left in a row from `sm` up. The shared shadcn footer uses flex-col-reverse, which put Discard FIRST on phones while
 * the DOM said the opposite; the discard dialog overrides it. (The staging browser suite measures the rendered order
 * at 320/375/768/1440.)
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";

const SRC = fs.readFileSync(path.join(process.cwd(), "src/components/workspace/DiscardUploadDialog.tsx"), "utf8");
const footerClass = SRC.match(/<AlertDialogFooter data-testid="discard-dialog-actions" className="([^"]+)"/)?.[1] ?? "";

describe("discard dialog action order", () => {
  it("the rendered footer stacks top-down on phones and runs left-to-right from sm up — never reversed", () => {
    const html = renderToStaticMarkup(createElement(AlertDialogFooter, { className: footerClass }, "x"));
    const cls = html.match(/class="([^"]+)"/)?.[1].split(/\s+/) ?? [];
    expect(cls).toContain("flex-col");
    expect(cls).not.toContain("flex-col-reverse");
    expect(cls).toContain("sm:flex-row");
    expect(cls.some((c) => /(^|:)(flex-row-reverse|order-)/.test(c))).toBe(false);
  });
  it("in the DOM, Keep current upload comes before both destructive actions", () => {
    const footer = SRC.slice(SRC.indexOf('data-testid="discard-dialog-actions"'));
    const keep = footer.indexOf("Keep current upload");
    expect(keep).toBeGreaterThan(-1);
    expect(keep).toBeLessThan(footer.indexOf('"Discard upload"'));
    expect(keep).toBeLessThan(footer.indexOf('"Cancel replacement"'));
    expect(footer.slice(0, footer.indexOf("</AlertDialogFooter>"))).not.toMatch(/\border-/);
  });
  it("the Keep button carries no reversed-stack margin", () => {
    expect(SRC).toMatch(/<AlertDialogCancel className="mt-0 rounded-none" disabled=\{busy\}>\s*Keep current upload/);
  });
  it("the discard copy says what happens, and when Undo becomes available", () => {
    expect(SRC).toContain("Removes this unprocessed upload from the workspace.");
    expect(SRC).toContain("A short Undo window becomes available after removal completes successfully.");
    expect(SRC).not.toContain("Permanently removes this unprocessed upload.");
  });
});
