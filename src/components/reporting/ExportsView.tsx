/**
 * Sign-off & Exports › Exports. The printable pack and the spreadsheet of a SAVED version, rendered only from the stored
 * document (re-validated) and — for a reviewed or final version — its server binding (the server's document hash and the
 * dependencies identity). Draft and final share one rendering; only the banner or seal differs. Nothing is recomputed.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { readStoredReport } from "@/lib/financialGeneration/composedReport";
import { buildReportPack, type ReportPack } from "@/lib/exports/reportPack";
import { adjustmentsClient } from "@/lib/closeReview/adjustments";
import { adjustmentDisclosures } from "@/lib/reporting/disclosures";
import { approverText, type SavedVersion } from "@/lib/reporting/signoff";
import { PRINT_HOST_ID, PRINT_ROOT_CLASS, packForPrintHost, printDocumentCss } from "@/lib/exports/printHost";
import type { PageProps } from "./shared";

export function ExportsView(p: PageProps) {
  const finals = p.state.versions.filter((v) => v.state === "FINAL").sort((a, b) => b.reportVersion - a.reportVersion);
  const chosen = p.state.versions.find((v) => v.reportVersion === p.reportVersion) ?? finals[0] ?? [...p.state.versions].sort((a, b) => b.reportVersion - a.reportVersion)[0] ?? null;
  if (!chosen) return <p>No report version is saved yet. <Link className="text-primary underline" to={p.hrefFor("signoff", null)}>Save one on the Sign-off page →</Link></p>;
  return <Pack key={`${chosen.reportId}:${chosen.reportVersion}`} {...p} v={chosen} />;
}

function Pack(p: PageProps & { v: SavedVersion }) {
  const [pack, setPack] = useState<ReportPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const adj = useMemo(() => adjustmentsClient(p.db as unknown as Parameters<typeof adjustmentsClient>[0]), [p.db]);
  const edition = p.state.composition?.state === "composed" && p.state.composition.pack.packId === "ifrs-for-smes/2025" ? "IFRS for SMEs Accounting Standard (third edition, 2025)" : "IFRS for SMEs (2015 edition)";
  useEffect(() => {
    let live = true;
    (async () => {
      const stored = await p.clients.signoff.report(p.v.reportId, p.v.reportVersion);
      if (!stored) throw new Error("The stored version could not be read.");
      const document = readStoredReport(stored.document);
      const bindings = p.v.state === "DRAFT" ? [] : (await p.clients.signoff.bindings(p.v.reportId)).filter((b) => b.reportVersion === p.v.reportVersion);
      const binding = bindings.find((b) => b.state === p.v.state) ?? null;
      const summary = await adj.summary(p.companyId, p.periodYear).catch(() => null);
      const out = buildReportPack({
        document, entityName: p.legalName, editionTitle: edition, adjustments: adjustmentDisclosures(summary),
        signOff: binding && (p.v.state === "REVIEWED" || p.v.state === "FINAL") ? { state: p.v.state, signedAt: binding.approvedAt ?? "time not recorded", signedBy: approverText(binding), contentHash: binding.documentSha256, dependenciesSha256: binding.dependenciesSha256 } : null,
      });
      if (live) setPack(out);
    })().catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [p.clients, p.v, p.companyId, p.periodYear, p.legalName, adj, edition]);
  // Printing prints ONLY the pack, in full (lib/exports/printHost.ts): a host outside the application root, the pack in its
  // shadow root, and a print rule hiding every other child of <body> while this page is open.
  useEffect(() => {
    if (!pack) return;
    const { pageRule, shadowHtml } = packForPrintHost(pack.html);
    const host = document.createElement("div");
    host.id = PRINT_HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.attachShadow({ mode: "open" }).innerHTML = shadowHtml;
    const style = document.createElement("style");
    style.textContent = printDocumentCss(pageRule);
    document.head.appendChild(style);
    document.body.appendChild(host);
    document.documentElement.classList.add(PRINT_ROOT_CLASS);
    return () => { document.documentElement.classList.remove(PRINT_ROOT_CLASS); host.remove(); style.remove(); };
  }, [pack]);
  const download = (name: string, type: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const base = `${p.legalName.replace(/[^A-Za-z0-9]+/g, "-")}-FY${p.periodYear}-v${p.v.reportVersion}-${p.v.state.toLowerCase()}`;
  if (error) return <p role="alert">The pack could not be prepared: {error}</p>;
  if (!pack) return <p role="status">Preparing the pack from the stored version…</p>;
  return (
    <div className="space-y-3 text-sm" data-testid="exports" data-state={p.v.state}>
      <p>Version {p.v.reportVersion} — {p.v.state === "FINAL" ? "final and sealed" : p.v.state === "REVIEWED" ? "reviewed (not final)" : "draft (not signed off)"}.
        {" "}{p.state.versions.length > 1 ? <>Other versions: {p.state.versions.filter((v) => v.reportVersion !== p.v.reportVersion).map((v) => <Link key={v.reportVersion} className="mr-2 text-primary underline" to={p.hrefFor("exports", v.reportVersion)}>v{v.reportVersion}</Link>)}</> : null}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground" onClick={() => window.print()} data-testid="print">Print / save as PDF</button>
        <button type="button" className="rounded-md border border-input px-3 py-1.5" onClick={() => download(`${base}.html`, "text/html", pack.html)}>Download HTML</button>
        <button type="button" className="rounded-md border border-input px-3 py-1.5" onClick={() => download(`${base}.csv`, "text/csv", pack.csv)}>Download spreadsheet (CSV)</button>
      </div>
      <iframe title={`Report pack — version ${p.v.reportVersion}`} srcDoc={pack.html} className="h-[70vh] w-full border border-border bg-white" data-testid="pack-preview" />
    </div>
  );
}
