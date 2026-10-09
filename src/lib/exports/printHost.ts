// exports/printHost.ts — the ONLY thing that prints from the Exports page. Pure.
//
// A browser prints the page it shows. On the Exports page that page is the workspace: navigation, buttons, the next
// action and a preview frame clipped to its on-screen box. So the sealed pack is printed from a dedicated host instead:
// a direct child of <body>, outside the application root, holding the pack in a shadow root (its styles cannot leak in
// or out). While the Exports page is open, a print rule hides every other child of <body> — whether printing starts
// from "Print / save as PDF" or from the browser's own print. Nothing of the workspace can reach the PDF, and the pack
// flows over as many pages as it needs.

export const PRINT_HOST_ID = "cfoclose-print-host";
export const PRINT_ROOT_CLASS = "cfoclose-print-pack";

/** The document-level rules (page size and margins, what prints). @page cannot live in a shadow root. */
export function printDocumentCss(pageRule: string): string {
  return `@media screen{#${PRINT_HOST_ID}{display:none!important}}`
    + `@media print{html.${PRINT_ROOT_CLASS} body>*:not(#${PRINT_HOST_ID}){display:none!important}`
    + `html.${PRINT_ROOT_CLASS},html.${PRINT_ROOT_CLASS} body{background:#fff!important;height:auto!important;overflow:visible!important}`
    + `#${PRINT_HOST_ID}{display:block!important}}${pageRule}`;
}

/**
 * The pack's own HTML (reportPack.ts) split for the print host: its @page rule for the document, and its styles and
 * content for the shadow root, with `body` selectors re-pointed at the wrapper. Refuses anything that is not a pack.
 */
export function packForPrintHost(packHtml: string): { readonly pageRule: string; readonly shadowHtml: string } {
  const style = /<style>([\s\S]*?)<\/style>/.exec(packHtml);
  const body = /<body>([\s\S]*)<\/body>/.exec(packHtml);
  if (!style || !body) throw new Error("not a report pack");
  const pageRule = /@page\{[^}]*\}/.exec(style[1])?.[0] ?? "";
  const css = style[1].replace(/@page\{[^}]*\}/, "").replace(/\bbody(?=[{:])/g, ".pack");
  return { pageRule, shadowHtml: `<style>:host{all:initial;display:block}${css}</style><div class="pack">${body[1]}</div>` };
}
