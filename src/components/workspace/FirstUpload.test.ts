import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: () => ({ select: () => ({ order: async () => ({ data: [] }) }) }), rpc: vi.fn(), functions: { invoke: vi.fn() }, storage: { from: () => ({}) } } }));
vi.mock("@/lib/ensureFreshSession", () => ({ ensureFreshSession: async () => undefined }));

const { default: FirstUpload, FIRST_UPLOAD_COPY } = await import("./FirstUpload");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const html = renderToStaticMarkup(createElement(FirstUpload, { onChoosePlan: () => {}, onOpenResult: () => {} }));

describe("FirstUpload: the first visit (Phase 2 P2-3)", () => {
  it("one clear upload action, with the supported formats and the enforced size limit visible", () => {
    expect(text(html)).toContain(FIRST_UPLOAD_COPY.heading);
    expect(text(html)).toContain("CSV or Excel (.csv, .xlsx, .xls), up to 10 MB.");
    expect((html.match(/<button/g) ?? []).length).toBe(1);
    expect(html).toContain('data-testid="first-upload-choose"');
  });
  it("the file input accepts exactly the supported types and has an accessible name (keyboard reaches the visible button)", () => {
    expect(html).toMatch(/accept="\.csv,\.xlsx,\.xls"/);
    expect(html).toMatch(/aria-label="Choose a trial balance file"/);
    expect(html).toMatch(/tabindex="-1"/i);
  });
  it("before a file is stored there is no confirmation card, no draft claim and no figure", () => {
    expect(html).not.toContain('data-testid="first-upload-confirm"');
    expect(text(html)).not.toContain(FIRST_UPLOAD_COPY.draft);
    expect(text(html)).not.toMatch(/\d{1,3}(,\d{3})+(\.\d+)?/);
  });
});
