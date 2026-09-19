/**
 * Saved work: reload recovery, saved-version history, read-only historical view,
 * evidence corrections and the multi-account cash perimeter. Presentation only —
 * every state, figure and permission comes from the workspace model, and every
 * user-supplied string is rendered as a text node (React escapes it).
 */
import { useMemo, useState } from "react";
import { History, Lock, RotateCcw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/canonicalStatement/money";
import type { CorrectEvidenceDecision } from "@/lib/canonicalStatement/types";
import { EVIDENCE_TYPE_LABELS } from "@/lib/financialEvidence/types";
import type { EvidenceCorrectionOutcome, FinancialStatementsWorkspaceModel } from "@/hooks/useFinancialStatementsWorkspace";
import { CASH_PERIMETER_NOTE_ID } from "@/lib/financialGeneration/cashPerimeter";

const FIELD = "h-9 w-full border border-input bg-background px-2 text-sm text-foreground focus-visible:outline focus-visible:outline-2";

/** What happened to the saved report when this session opened — never silent. */
export function RestoreBanner({ model }: { model: FinancialStatementsWorkspaceModel }) {
  const r = model.restore;
  if (r.status === "LOADING") {
    return (
      <p role="status" className="text-xs text-muted-foreground" data-testid="restore-banner" data-restore-status="LOADING">
        Looking for saved work…
      </p>
    );
  }
  if (!r.message) return null;
  return (
    <Alert variant={r.status === "RESTORED" ? "default" : "destructive"} data-testid="restore-banner" data-restore-status={r.status}>
      <AlertDescription>{r.message}</AlertDescription>
    </Alert>
  );
}

/** Shown for as long as a stored version is displayed. Nothing on the page can change it. */
export function ReadOnlyBanner({ model }: { model: FinancialStatementsWorkspaceModel }) {
  const v = model.viewing;
  if (!v) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border border-primary bg-muted/40 p-3 fs-no-print" role="status" data-testid="readonly-banner" data-viewing-version={v.reportVersion}>
      <p className="flex items-center gap-2 text-sm text-foreground">
        <Lock className="h-4 w-4" aria-hidden="true" />
        <span>
          Viewing saved version {v.reportVersion} ({v.isLatest ? "latest" : "historical"}, {v.state.toLowerCase()}) exactly as stored — read-only. The findings shown are the ones recorded for this version.
        </span>
      </p>
      <Button type="button" size="sm" onClick={model.closeVersion} data-testid="return-to-draft">
        <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        Return to the working draft
      </Button>
    </div>
  );
}

const STATE_TONE = { DRAFT: "outline", REVIEWED: "secondary", FINAL: "default" } as const;

export function SavedVersionsPanel({ model }: { model: FinancialStatementsWorkspaceModel }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const mine = useMemo(() => {
    const id = model.snapshot?.report.reportIdentity.reportId;
    return model.versions.filter((v) => !id || v.reportId === id).slice().sort((a, b) => b.reportVersion - a.reportVersion);
  }, [model.versions, model.snapshot]);
  if (model.saveStatus === "DISABLED" || model.saveStatus === "DENIED" || model.saveStatus === "CHECKING") return null;
  async function open(version: number) {
    const r = await model.openVersion(version);
    setMsg({ ok: r.ok, text: r.message });
  }
  return (
    <details className="border border-border p-3 fs-no-print" data-testid="saved-versions" open={model.viewing !== null}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
        <History className="h-4 w-4" aria-hidden="true" />
        Saved versions ({mine.length})
      </summary>
      {mine.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Nothing has been saved for this company and year yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-xs">
            <caption className="sr-only">Saved report versions, newest first</caption>
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-1 pr-2">Version</th>
                <th className="py-1 pr-2">Saved</th>
                <th className="py-1 pr-2">By</th>
                <th className="py-1 pr-2">State</th>
                <th className="py-1 pr-2">Evidence</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {mine.map((v) => {
                const showing = model.viewing?.reportVersion === v.reportVersion;
                return (
                  <tr key={v.reportVersion} className="border-b border-border" data-version={v.reportVersion} data-latest={v.isLatest ? "yes" : "no"}>
                    <td className="py-1 pr-2 tabular-nums font-medium">
                      v{v.reportVersion} {v.isLatest && <Badge variant="outline">latest</Badge>}
                    </td>
                    <td className="py-1 pr-2">{new Date(v.createdAt).toLocaleString()}</td>
                    <td className="py-1 pr-2">
                      {v.creatorRole} · <span className="font-mono">{v.creatorRef}</span>
                    </td>
                    <td className="py-1 pr-2">
                      <Badge variant={STATE_TONE[v.state]}>{v.state.toLowerCase()}</Badge>
                    </td>
                    <td className="py-1 pr-2 tabular-nums">{v.evidenceBatchIds.length}</td>
                    <td className="py-1 text-right">
                      {showing ? (
                        <Button type="button" size="sm" variant="outline" onClick={model.closeVersion} data-testid={`close-version-${v.reportVersion}`}>
                          Back to draft
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="outline" onClick={() => void open(v.reportVersion)} data-testid={`open-version-${v.reportVersion}`}>
                          {v.isLatest ? "View stored copy" : "View read-only"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {msg && (
        <p className={`mt-2 text-xs ${msg.ok ? "text-muted-foreground" : "text-destructive"}`} role="status" data-testid="saved-versions-message">
          {msg.text}
        </p>
      )}
    </details>
  );
}

const CORRECTABLE = new Set(["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "BUDGET", "IPSAS_CASH_RECEIPTS_PAYMENTS", "SUPPORTING_SCHEDULE", "NOTES_AND_POLICIES", "CASH_ACCOUNT_MAP", "PRIOR_PERIOD_STATEMENTS"]);

/** Correct one cell of the latest version of an evidence series: a new version, never an edit of the stored one. */
export function CorrectEvidenceForm({ model, evidenceBatchId }: { model: FinancialStatementsWorkspaceModel; evidenceBatchId: string }) {
  const entry = model.evidence.find((e) => e.batch.evidenceBatchId === evidenceBatchId);
  const [open, setOpen] = useState(false);
  const [row, setRow] = useState("1");
  const [column, setColumn] = useState("");
  const [value, setValue] = useState("");
  const [why, setWhy] = useState("");
  const [out, setOut] = useState<EvidenceCorrectionOutcome | null>(null);
  if (!entry || model.readOnly || !CORRECTABLE.has(entry.batch.evidenceType) || entry.batch.validationStatus === "INVALID" || entry.batch.validationStatus === "REQUIRES_REVIEW") return null;
  const columns = entry.batch.document.columns;
  const rowNumber = Number(row);
  const col = column || columns[0];
  const current = Number.isInteger(rowNumber) && rowNumber >= 1 ? entry.batch.document.rows[rowNumber - 1]?.[columns.indexOf(col)] : undefined;
  const isLatest = model.evidence.filter((e) => e.batch.seriesKey === entry.batch.seriesKey && e.batch.evidenceType === entry.batch.evidenceType && e.batch.periodRole === entry.batch.periodRole && e.version > entry.version).length === 0;
  if (!isLatest && !out) return null;
  if (!isLatest) {
    return (
      <Alert className="mt-2" data-testid="correct-message" role="status">
        <AlertDescription>{out?.message} This version is now superseded; the newer version below carries the correction.</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="mt-2" data-testid="correct-evidence">
      {!open ? (
        <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setOpen(true)} data-testid="correct-evidence-open">
          Correct a value
        </Button>
      ) : (
        <form
          className="grid gap-2 border border-border p-3 sm:grid-cols-2 lg:grid-cols-6"
          aria-label={`Correct ${EVIDENCE_TYPE_LABELS[entry.batch.evidenceType]}`}
          onSubmit={(e) => {
            e.preventDefault();
            const r = model.correctEvidence({ evidenceBatchId, rowNumber, column: col, newValue: value, rationale: why });
            setOut(r);
            if (r.ok) {
              setOpen(false);
              setWhy("");
            }
          }}
        >
          <label className="text-xs">
            <span className="mb-1 block font-medium">Row</span>
            <input className={FIELD} value={row} inputMode="numeric" onChange={(e) => setRow(e.target.value.replace(/\D/g, ""))} data-testid="correct-row" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium">Column</span>
            <select className={FIELD} value={col} onChange={(e) => setColumn(e.target.value)} data-testid="correct-column">
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs sm:col-span-2 lg:col-span-1" data-testid="correct-current">
            <span className="mb-1 block font-medium">Current value</span>
            <span className="break-all font-mono">{current === undefined ? "—" : current === "" ? "(empty)" : current}</span>
          </p>
          <label className="text-xs lg:col-span-1">
            <span className="mb-1 block font-medium">Corrected value</span>
            <input className={FIELD} value={value} onChange={(e) => setValue(e.target.value)} data-testid="correct-value" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="mb-1 block font-medium">Rationale (at least 8 characters)</span>
            <input className={FIELD} value={why} onChange={(e) => setWhy(e.target.value)} data-testid="correct-rationale" />
          </label>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-6">
            <Button type="submit" size="sm" disabled={current === undefined || why.trim().length < 8} data-testid="correct-submit">
              Record correction
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {out && (
        <Alert className="mt-2" variant={out.ok ? "default" : "destructive"} data-testid="correct-message" role="status">
          <AlertDescription>
            {out.message}
            {"diagnostics" in out && out.diagnostics.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {out.diagnostics.map((d, i) => (
                  <li key={i}>
                    {d.row ? `Row ${d.row}: ` : ""}
                    {d.message}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Every correction to source evidence: what changed, why, and which stored version it produced. */
export function EvidenceCorrectionHistory({ decisions }: { decisions: readonly CorrectEvidenceDecision[] }) {
  if (decisions.length === 0) return null;
  return (
    <ol className="mt-1 space-y-1 text-xs" data-testid="evidence-correction-history">
      {decisions.map((d) => (
        <li key={d.decisionId} data-evidence-correction={d.decisionId}>
          <span className="font-medium">{EVIDENCE_TYPE_LABELS[d.evidenceType as keyof typeof EVIDENCE_TYPE_LABELS] ?? d.evidenceType}</span> row {d.rowNumber}, <span className="font-mono">{d.column}</span>: <span className="font-mono">{d.previousValue || "(empty)"}</span> → <span className="font-mono">{d.correctedValue || "(empty)"}</span> — {d.rationale}
        </li>
      ))}
    </ol>
  );
}

const ROLE_LABEL: Record<string, string> = {
  gross: "Gross cash and equivalents (before ECL)",
  restricted: "of which restricted or designated",
  ecl: "ECL allowance on cash balances",
  overdraft: "Overdrafts included in cash and cash equivalents",
  cfexpected: "Cash-flow closing cash (gross + overdrafts)",
  net: "Net cash on the statement of financial position",
  excluded: "Balances mapped as not cash",
};

/** The multi-account cash perimeter and its reconciliation, from the explicit cash account map. */
export function CashPerimeterPanel({ model }: { model: FinancialStatementsWorkspaceModel }) {
  const perimeter = model.applied?.cashPerimeter;
  const report = model.snapshot?.report;
  if (!perimeter || !report) return null;
  const period = report.period.periodId;
  const fact = (role: string) => report.facts.filter((f) => f.factId === `fact:cashperim:${role}:${period}`).sort((a, b) => b.version - a.version)[0]?.value ?? null;
  const cats = perimeter.composition.find((c) => c.periodId === period);
  const note = report.notes.find((n) => n.noteId === CASH_PERIMETER_NOTE_ID);
  return (
    <section className="break-inside-avoid-page space-y-2" aria-labelledby="fs-cash-h" data-testid="cash-perimeter" data-perimeter-status={perimeter.status}>
      <h3 id="fs-cash-h" className="text-base font-semibold text-foreground">
        {note?.title ?? "Cash and cash equivalents"}
      </h3>
      {perimeter.status === "UNRESOLVED" ? (
        <Alert variant="destructive">
          <AlertDescription>
            <p>The cash perimeter is not established, so no cash reconciliation is shown. Nothing was estimated or plugged.</p>
            <ul className="mt-1 list-disc pl-5 text-xs">
              {perimeter.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] border-collapse text-sm">
              <caption className="sr-only">Cash perimeter and reconciliation</caption>
              <tbody>
                {(["gross", "restricted", "ecl", "overdraft", "cfexpected", "net", "excluded"] as const).map((role) => {
                  const v = fact(role);
                  return (
                    <tr key={role} className="border-b border-border" data-perimeter-role={role}>
                      <td className="py-1.5 pr-3">{ROLE_LABEL[role]}</td>
                      <td className="py-1.5 pl-2 text-right tabular-nums">{v ? formatMoney(v) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {cats && (
            <ul className="text-xs text-muted-foreground" data-testid="cash-perimeter-accounts">
              {cats.accounts.map((a) => (
                <li key={a.accountKey}>
                  <span className="font-mono">{a.accountKey}</span> · {a.category.replace(/_/g, " ").toLowerCase()} · {formatMoney(a.contribution)}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">Closing cash in the cash flow statement, less the ECL allowance and plus overdrafts included, equals net cash on the statement of financial position. Every account above is placed by the explicit cash account map; none is picked by position or name.</p>
        </>
      )}
    </section>
  );
}
