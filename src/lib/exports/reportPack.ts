// exports/reportPack.ts — the printable reporting pack and its spreadsheet, rendered ONLY from a saved report version (the
// immutable document) and, when signed, its sign-off binding (fs_publication_bindings, 20261021100000).
//
// Draft and final are the same rendering: the only differences are the status banner (DRAFT / REVIEWED watermark vs
// the FINAL seal with the content and dependencies identities). The same document always renders the same bytes.
// Preparer wording is escaped, never interpreted. Self-approved and self-revalidated adjustments are disclosed. Nothing
// here adds up a figure: statements print the document's own facts.

import type { CanonicalFinancialStatementReport, MonetaryFact, Statement } from "@/lib/canonicalStatement/types";
import { formatMinorAmount } from "@/lib/presentation/amounts";

export interface PackAdjustmentDisclosure {
  readonly number: number;
  readonly reason: string;
  readonly totalMinor: string;
  readonly selfApproved: boolean;
  readonly selfRevalidated: boolean;
}
export interface PackSignOff {
  readonly state: "REVIEWED" | "FINAL";
  readonly signedAt: string;
  readonly signedBy: string;
  readonly contentHash: string;
  readonly dependenciesSha256: string;
}
export interface PackInput {
  readonly document: CanonicalFinancialStatementReport & { readonly reportingDependencies?: { readonly dependenciesSha256: string } };
  readonly entityName: string;
  readonly editionTitle: string;
  /** The latest sign-off of THIS version (null: draft). A FINAL without its binding is refused. */
  readonly signOff: PackSignOff | null;
  readonly adjustments: readonly PackAdjustmentDisclosure[];
}
export interface ReportPack {
  readonly html: string;
  readonly csv: string;
  /** The rendering of everything except the status banner/seal — identical for draft and final of the same version. */
  readonly body: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const ACCOUNT_DETAIL = /^line:(detail|restatement):/;
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function buildReportPack(input: PackInput): ReportPack {
  const doc = input.document;
  if (input.signOff?.state === "FINAL" && input.signOff.contentHash.length !== 64) throw new Error("a FINAL pack needs its sign-off binding");
  const facts = new Map<string, MonetaryFact>(doc.facts.map((f) => [f.factId, f]));
  const periods = [doc.period.periodId, ...doc.comparativePeriods.map((p) => p.periodId)];
  const periodLabel = (id: string) => (id === doc.period.periodId ? String(doc.period.periodYear) : String(doc.comparativePeriods.find((p) => p.periodId === id)?.periodYear ?? id));
  const amount = (factId: string | undefined): string => {
    const f = factId ? facts.get(factId) : undefined;
    if (!f) return "—";
    if (f.value === null) return "—";
    return formatMinorAmount(f.value.minorUnits, f.value.scale);
  };
  const csvRows: string[][] = [["Statement", "Section", "Line", ...periods.map(periodLabel)]];
  const statementHtml = (s: Statement) => {
    const rows = s.sections.flatMap((sec) => [
      `<tr class="section"><th colspan="${periods.length + 1}" scope="rowgroup">${esc(sec.label)}</th></tr>`,
      ...sec.lines.flatMap((l) => {
        const cells = periods.map((p) => amount(l.factBindings.find((b) => b.periodId === p)?.factId));
        csvRows.push([s.title, sec.label, l.label, ...cells]);
        // Account detail lines (line:detail:…) are the trace behind a presented line: in the spreadsheet, not on the face.
        if (ACCOUNT_DETAIL.test(l.lineId)) return [];
        const presented = l.role === "DETAIL" || l.castingChildLineIds.every((id) => ACCOUNT_DETAIL.test(id));
        return [`<tr class="${presented ? "line" : l.role.toLowerCase()}"><th scope="row">${esc(l.label)}</th>${cells.map((c) => `<td class="num">${esc(c)}</td>`).join("")}</tr>`];
      }),
    ]);
    return `<section class="statement"><h2>${esc(s.title)}</h2><table><thead><tr><th scope="col">${esc(doc.presentationCurrency?.currency ?? "")}</th>${periods.map((p) => `<th scope="col" class="num">${esc(periodLabel(p))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></section>`;
  };
  const notes = doc.textualDisclosures.map((d) => `<section class="note"><h3>${esc(d.disclosureId)}</h3><p>${esc(d.text).replace(/\n/g, "<br>")}</p></section>`).join("");
  const adj = input.adjustments.filter((a) => a.selfApproved || a.selfRevalidated);
  const disclosure = adj.length === 0
    ? `<p>No adjustment was approved or revalidated by its own proposer.</p>`
    : `<ul>${adj.map((a) => `<li>Adjustment ${a.number} (${esc(formatMinorAmount(BigInt(a.totalMinor), doc.presentationCurrency.scale))}): ${a.selfApproved ? "self-approved" : ""}${a.selfApproved && a.selfRevalidated ? " and " : ""}${a.selfRevalidated ? "self-revalidated" : ""} — ${esc(a.reason)}</li>`).join("")}</ul>`;
  const body = [
    `<header><h1>${esc(input.entityName)}</h1><p>Financial statements for the year ended ${esc(doc.period.endDate)} · ${esc(input.editionTitle)} · ${esc(doc.presentationCurrency.currency)}</p></header>`,
    ...doc.statements.map(statementHtml),
    `<section class="notes"><h2>Notes</h2>${notes}</section>`,
    `<section class="audit"><h2>Approval disclosures</h2>${disclosure}</section>`,
  ].join("\n");
  const s = input.signOff;
  const banner = !s
    ? `<div class="banner draft" role="status">DRAFT — not signed off. Figures may change.</div>`
    : s.state === "REVIEWED"
      ? `<div class="banner reviewed" role="status">REVIEWED — not final. Reviewed by ${esc(s.signedBy)} on ${esc(s.signedAt)}.</div>`
      : `<div class="banner final" role="status">FINAL — signed off by ${esc(s.signedBy)} on ${esc(s.signedAt)}. Content SHA-256 ${esc(s.contentHash)}; reporting dependencies SHA-256 ${esc(s.dependenciesSha256)}.</div>`;
  const css = `@page{size:A4;margin:18mm}body{font-family:system-ui,sans-serif;font-variant-numeric:tabular-nums}thead{display:table-header-group}.statement{break-inside:avoid-page}table{width:100%;border-collapse:collapse}th{text-align:left;font-weight:400;padding:2px 6px}td{padding:2px 6px}.num{text-align:right}thead th{font-weight:600;border-bottom:1px solid #000}tr.section th{font-weight:600;padding-top:8px}tr.subtotal th,tr.subtotal td{border-top:1px solid #999;font-weight:600}tr.total th,tr.total td{border-top:1px solid #000;border-bottom:3px double #000;font-weight:600}.banner{padding:6px 10px;border:1px solid;overflow-wrap:anywhere}.banner.draft::after,.banner.reviewed::after{content:"";}${!s || s.state !== "FINAL" ? `body::before{content:"${!s ? "DRAFT" : "REVIEWED"}";position:fixed;top:40%;left:15%;font-size:96px;opacity:.08;transform:rotate(-30deg)}` : ""}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(input.entityName)} — ${esc(String(doc.period.periodYear))}</title><style>${css}</style></head><body>${banner}\n${body}</body></html>`;
  return { html, body, csv: csvRows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n" };
}
