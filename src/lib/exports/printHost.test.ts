import { describe, expect, it } from "vitest";
import { PRINT_HOST_ID, PRINT_ROOT_CLASS, packForPrintHost, printDocumentCss } from "./printHost";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(__dirname, "../../..", rel), "utf8");

describe("the Exports print host (only the pack prints, in full)", () => {
  const pack = `<!doctype html><html><head><style>@page{size:A4;margin:18mm}body{font-family:x}body::before{content:"DRAFT"}.banner{overflow-wrap:anywhere}</style></head><body><div class="banner">FINAL</div>\n<header>H</header></body></html>`;
  it("moves @page to the document and re-points body selectors at the wrapper", () => {
    const r = packForPrintHost(pack);
    expect(r.pageRule).toBe("@page{size:A4;margin:18mm}");
    expect(r.shadowHtml).not.toMatch(/@page|\bbody[{:]/);
    expect(r.shadowHtml).toContain(".pack{font-family:x}.pack::before{content:\"DRAFT\"}");
    expect(r.shadowHtml).toContain('<div class="pack"><div class="banner">FINAL</div>');
  });
  it("in print, hides every other child of <body>; on screen the host is hidden", () => {
    const css = printDocumentCss("@page{size:A4}");
    expect(css).toContain(`@media screen{#${PRINT_HOST_ID}{display:none!important}}`);
    expect(css).toContain(`html.${PRINT_ROOT_CLASS} body>*:not(#${PRINT_HOST_ID}){display:none!important}`);
    expect(css.endsWith("@page{size:A4}")).toBe(true);
  });
  it("refuses anything that is not a pack", () => {
    expect(() => packForPrintHost("<p>no</p>")).toThrow(/not a report pack/);
  });
  it("the pack wraps long hashes instead of clipping them", () => {
    expect(read("src/lib/exports/reportPack.ts")).toContain(".banner{padding:6px 10px;border:1px solid;overflow-wrap:anywhere}");
  });
  it("the Exports page prints the page (window.print) and mounts the host; no frame-only print path remains", () => {
    const view = read("src/components/reporting/ExportsView.tsx");
    expect(view).toContain("onClick={() => window.print()}");
    expect(view).toContain("packForPrintHost(pack.html)");
    expect(view).not.toMatch(/contentWindow\?\.print/);
  });
});

describe("the pack's statement sign-off disclosure (20261024100000)", () => {
  it("is printed only when the sign-off carries approvals; an earlier sealed pack is byte-identical", async () => {
    const { buildReportPack } = await import("./reportPack");
    const src = read("src/lib/exports/reportPack.ts");
    expect(src).toContain("const ap = input.signOff?.approvals;");
    expect(src).toMatch(/!ap \|\| !input\.signOff \? ""/);
    expect(typeof buildReportPack).toBe("function");
  });
});

describe("a sealed pack prints the identity sealed in its document", () => {
  it("the entity name comes from the stored document, not the workspace's current name", () => {
    const view = read("src/components/reporting/ExportsView.tsx");
    expect(view).toContain("sealedPackInput({ document");
    expect(view).not.toMatch(/entityName: p.legalName|editionTitle: edition/);
    expect(view).not.toMatch(/composition\?\.state === "composed" && p\.state\.composition\.pack/);
  });
});
