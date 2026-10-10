import { useEffect, useId, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/workbench/ConfirmDialog";
import { ConflictNotice } from "@/components/workbench/ConflictNotice";
import { DataTable, type DataColumn } from "@/components/workbench/DataTable";
import { SecondaryPanel } from "@/components/workbench/SecondaryPanel";
import { useGuardedRequest } from "@/components/workbench/useGuardedRequest";
import type { InspectResult, InspectSheet, LayoutAnswer, LayoutClient, LayoutProfile, LayoutReport } from "@/lib/workbench/intake/layoutClient";
import type { LayoutAssistClient } from "@/lib/workbench/intake/layoutAssistClient";
import {
  COLUMN_ROLES, DISPOSITION_WORDS, NUMBER_FORMAT_CHOICES, draftFromProfile, draftFromSuggestion, draftProblems, headerCells, sampleAmounts, toProfile,
  type ColumnRole, type LayoutDraft,
} from "@/lib/workbench/intake/layoutDraft";

export interface LayoutTemplateRow { id: string; templateKey: string; version: number; name: string; profile: LayoutProfile }

type RowView = { rowNumber: number; disposition: string; detail: string | null };
const ROW_COLUMNS: readonly DataColumn<RowView>[] = [
  { id: "row", header: "Row", render: (r) => String(r.rowNumber) },
  { id: "disposition", header: "Read as", render: (r) => DISPOSITION_WORDS[r.disposition] ?? r.disposition },
  { id: "detail", header: "Detail", render: (r) => r.detail ?? "—", wrap: true },
];

/**
 * Trial balance › Intake: the manual layout for one uploaded file. The person states where the trial balance is (sheet,
 * header row, the column of each role, the number format) and validates it against the WHOLE file on the server; the
 * report lists every row's disposition. Confirming records the layout for this file (expected confirmation number);
 * the existing result then needs a new check. Nothing here writes a financial record.
 */
export function LayoutEditor(p: {
  client: LayoutClient;
  companyId: string;
  uploadId: string;
  periodLabel: string;
  templates: readonly LayoutTemplateRow[];
  onConfirmed?: (confirmationNo: number) => void;
  newKey?: () => string;
  /** AI-assisted suggestions (I1-C): passed only when released; offered only for a sheet the automatic reading could not read. */
  assist?: LayoutAssistClient;
  /**
   * Lead with a summary of the automatic reading; the editor opens on request. It opens by itself whenever detection did
   * not settle the layout (no automatic reading, an ambiguous or undetected number format, an unreadable file) or the
   * caller says the file needs a layout (its check failed).
   */
  startCollapsed?: boolean;
  needsLayout?: boolean;
}) {
  const ids = { sheet: useId(), header: useId(), format: useId(), sign: useId(), template: useId(), name: useId() };
  const inspected = useGuardedRequest<LayoutAnswer<InspectResult>>("layout-inspect", `${p.companyId}|${p.uploadId}`, () => p.client.inspect(p.uploadId), [p.client]);
  const [draft, setDraft] = useState<LayoutDraft | null>(null);
  const [template, setTemplate] = useState<LayoutTemplateRow | null>(null);
  const [report, setReport] = useState<LayoutReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [busy, setBusy] = useState<null | "validate" | "confirm" | "save" | "suggest">(null);
  // The current draft came from a suggestion (cleared by any change the person makes).
  const [suggested, setSuggested] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState<{ what: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  // Several plausible number formats give different values: the person must confirm the declared one explicitly.
  const [formatConfirmed, setFormatConfirmed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const inspect = inspected.state.status === "ready" && inspected.state.value.kind === "ok" ? inspected.state.value.value : null;
  const kind = inspect?.kind ?? "csv";
  const sheet: InspectSheet | null = useMemo(() => inspect?.sheets?.find((s) => s.name === (draft?.sheetName ?? null)) ?? inspect?.sheets?.[0] ?? null, [inspect, draft?.sheetName]);

  // A fresh inspection (new file or reload) starts from the server's automatic reading; nothing is kept from another file.
  useEffect(() => {
    if (!inspect?.sheets?.length) return;
    const first = inspect.sheets.length === 1 ? inspect.sheets[0] : inspect.sheets.find((s) => s.suggestion) ?? inspect.sheets[0];
    const d0 = draftFromSuggestion(first);
    setDraft(d0);
    setReport(null); setTemplate(null); setConflict(null);
    // Whether the automatic reading settled the layout is decided once, from the server's reading (never from the
    // person's later edits): no reading, an undetected or ambiguous number format, or an incomplete layout opens the editor.
    setExpanded(!first.suggestion || d0.numberFormat === null || draftProblems(d0, inspect.kind ?? "csv").length > 0);
  }, [inspect]);

  if (inspected.state.status === "loading" || inspected.state.status === "idle") return <p role="status">Reading the file…</p>;
  if (inspected.state.status === "error") return <p role="alert">The file could not be read right now. Nothing was changed. <button type="button" onClick={inspected.reload} className="underline">Try again</button></p>;
  const answer = inspected.state.value;
  if (answer.kind === "unavailable") {
    return <p role="status" className="text-sm text-muted-foreground">Manual layouts are not available yet. The automatic reading of your file still works as before.</p>;
  }
  if (answer.kind !== "ok") return <p role="alert">{"message" in answer ? answer.message : "The file could not be read."}</p>;
  if (answer.value.status === "unreadable" || !draft) return <p role="alert">{answer.value.issue?.message ?? "The file could not be read."}</p>;

  const headers = headerCells(sheet, draft.headerRow);
  const problems = draftProblems(draft, kind);
  const profile = toProfile(draft, kind);
  const change = (next: Partial<LayoutDraft>) => { setDraft({ ...draft, ...next }); setReport(null); setNotice(null); setFormatConfirmed(false); setSuggested(false); };
  const formatAmbiguous = !!report?.numberFormats?.ambiguous;
  const setRole = (role: ColumnRole, header: string) => change({ columns: { ...draft.columns, [role]: header || null } });
  const evidence = sheet?.numberFormats;
  const balanceOnly = !!draft.columns.balance && !(draft.columns.debit && draft.columns.credit);
  const detectedFormat = NUMBER_FORMAT_CHOICES.find((f) => f.id === draft.numberFormat) ?? null;
  // The detected format is settled only when the file's own amounts allow exactly one reading and it is the one chosen.
  const formatSettled = !!detectedFormat && !!evidence && !evidence.ambiguous && evidence.textCells > 0 && evidence.consistent.includes(detectedFormat.id);
  const examples = sampleAmounts(sheet, draft);
  const showEditor = !p.startCollapsed || expanded || !!p.needsLayout;

  const handle = <T,>(a: LayoutAnswer<T>, what: string): T | null => {
    if (a.kind === "ok") return a.value;
    if (a.kind === "conflict") setConflict({ what });
    else if (a.kind === "unavailable") setNotice("Manual layouts are not available yet. Nothing was changed.");
    else if (a.kind === "invalid") setNotice(`${a.message} ${a.errors.join(" ")}`);
    else { setNotice(a.message); if (a.report) { setReport(a.report); setReportOpen(true); } }
    return null;
  };
  const validate = async () => {
    if (!profile) return;
    setBusy("validate");
    try {
      const v = handle(await p.client.validate(p.uploadId, profile), "this file's layout");
      if (v) { setReport(v.report); setReportOpen(true); setNotice(v.report.layoutFits ? "The layout fits the whole file. Review the report, then confirm it." : "The layout does not fit the file. The report lists why."); }
    } finally { setBusy(null); }
  };
  const confirm = async () => {
    if (!profile) return;
    setBusy("confirm");
    try {
      const v = handle(await p.client.confirm(p.uploadId, profile, answer.value.currentConfirmationNo, template?.id ?? null, formatAmbiguous && formatConfirmed), "this file's layout");
      if (v) {
        setReport(v.report);
        setNotice(v.unchanged || v.replay ? `This layout was already confirmed for this file (confirmation ${v.confirmationNo}).` : `Layout confirmed for this file (confirmation ${v.confirmationNo}). Run a new check to read the trial balance with it.`);
        p.onConfirmed?.(v.confirmationNo);
      }
    } finally { setBusy(null); setConfirming(false); }
  };
  const suggest = async () => {
    if (!p.assist || !sheet || !inspect?.sheets) return;
    setBusy("suggest");
    try {
      const v = handle(await p.assist.suggest(p.uploadId, inspect.sheets.indexOf(sheet), (p.newKey ?? (() => crypto.randomUUID()))()), "this file's layout");
      if (v) {
        setDraft(draftFromProfile(v.layout)); setTemplate(null); setFormatConfirmed(false);
        setReport(v.report); setReportOpen(true); setSuggested(true);
        setNotice(v.report.layoutFits
          ? "A layout was suggested and checked against the whole file. Review every column before you confirm — nothing is confirmed until you do."
          : "A layout was suggested, but it does not fit the whole file. The report lists why; set the columns yourself.");
      }
    } finally { setBusy(null); }
  };
  const save = async () => {
    if (!profile || !templateName.trim()) return;
    setBusy("save");
    try {
      const sameName = template && template.name === templateName.trim();
      const key = sameName ? template!.templateKey : (p.newKey ?? (() => crypto.randomUUID()))();
      const v = handle(await p.client.saveTemplate(p.companyId, key, sameName ? template!.version : 0, templateName.trim(), profile), "this template");
      if (v) setNotice(v.unchanged || v.replay ? `Template “${templateName.trim()}” is unchanged (version ${v.version}).` : `Saved template “${templateName.trim()}”, version ${v.version}.`);
    } finally { setBusy(null); }
  };

  if (!showEditor) {
    const confirmedNo = answer.value.currentConfirmationNo;
    return (
      <section aria-labelledby={`${ids.sheet}-h`} className="space-y-2 text-sm" data-testid="layout-summary">
        <h2 id={`${ids.sheet}-h`} className="text-base font-semibold">File layout</h2>
        <p>{confirmedNo === 0 ? "Read automatically" : `Confirmed layout (confirmation ${confirmedNo})`}{sheet?.name ? `: sheet “${sheet.name}”` : ""}, headers on row {draft.headerRow}.</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {COLUMN_ROLES.filter((r) => draft.columns[r.id]).map((r) => (
            <div key={r.id} className="contents"><dt className="text-muted-foreground">{r.label}</dt><dd>“{draft.columns[r.id]}”</dd></div>
          ))}
        </dl>
        <p data-testid="layout-number-format">Amounts are written as <span className="font-mono">{detectedFormat!.example}</span> ({detectedFormat!.label.toLowerCase()})
          {examples.length ? <>, for example {examples.map((e, i) => <span key={e}>{i ? " and " : ""}<span className="font-mono">“{e}”</span></span>)} in this file</> : null}.</p>
        <button type="button" className="rounded-md border border-input bg-background px-3 py-1.5" onClick={() => setExpanded(true)} data-testid="layout-change">Change the layout</button>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${ids.sheet}-h`} className="space-y-4">
      <h2 id={`${ids.sheet}-h`} className="text-base font-semibold">File layout</h2>
      {conflict ? <ConflictNotice conflict={{ kind: "version_conflict", detail: null }} what={conflict.what} onReload={() => { setConflict(null); inspected.reload(); }} /> : null}
      <p role="status" aria-live="polite" className="text-sm">{notice ?? `Confirmed layouts for this file: ${answer.value.currentConfirmationNo === 0 ? "none (the automatic reading is used)" : answer.value.currentConfirmationNo}.`}</p>

      {p.templates.length > 0 ? (
        <div>
          <label htmlFor={ids.template} className="block text-sm font-medium">Start from a saved template</label>
          <select id={ids.template} className="mt-1 rounded-md border border-input bg-background px-2 py-1 text-sm" value={template?.id ?? ""}
            onChange={(e) => {
              const t = p.templates.find((x) => x.id === e.target.value) ?? null;
              setTemplate(t);
              if (t) { setDraft(draftFromProfile(t.profile)); setTemplateName(t.name); setReport(null); }
            }}>
            <option value="">No template</option>
            {p.templates.map((t) => <option key={t.id} value={t.id}>{t.name} (version {t.version})</option>)}
          </select>
          {template ? <p className="mt-1 text-sm text-muted-foreground">Using template “{template.name}” (version {template.version}). It is checked again against this file before anything is confirmed.</p> : null}
        </div>
      ) : null}

      {kind === "workbook" ? (
        <div>
          <label htmlFor={ids.sheet} className="block text-sm font-medium">Sheet</label>
          <select id={ids.sheet} className="mt-1 rounded-md border border-input bg-background px-2 py-1 text-sm" value={draft.sheetName ?? ""}
            onChange={(e) => change({ sheetName: e.target.value || null, headerRow: null, columns: { accountCode: null, accountName: null, debit: null, credit: null, balance: null }, dimensions: [] })}>
            <option value="">Choose a sheet</option>
            {answer.value.sheets?.map((s) => <option key={s.name ?? ""} value={s.name ?? ""}>{s.name} ({s.rowCount} rows)</option>)}
          </select>
        </div>
      ) : null}

      {sheet ? (
        <div>
          <p className="text-sm font-medium" id={ids.header}>Header row: {draft.headerRow ?? "not chosen"}</p>
          <div className="max-h-64 overflow-auto rounded-md border border-border">
            <table className="w-full text-xs" aria-labelledby={ids.header}>
              <caption className="sr-only">First rows of the file. Choose the row that holds the column headers.</caption>
              <tbody>
                {sheet.preview.map((r) => (
                  <tr key={r.rowNumber} className={r.rowNumber === draft.headerRow ? "bg-muted font-semibold" : undefined}>
                    <th scope="row" className="px-2 py-1 text-left">
                      <button type="button" aria-pressed={r.rowNumber === draft.headerRow} className="underline" onClick={() => change({ headerRow: r.rowNumber, columns: { accountCode: null, accountName: null, debit: null, credit: null, balance: null }, dimensions: [] })}>
                        Row {r.rowNumber}
                      </button>
                    </th>
                    {r.cells.map((c, i) => <td key={i} className="whitespace-nowrap px-2 py-1">{c ?? ""}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {draft.headerRow !== null ? (
        <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <legend className="text-sm font-medium">Columns</legend>
          {COLUMN_ROLES.map((r) => {
            const id = `${ids.header}-${r.id}`;
            return (
              <div key={r.id}>
                <label htmlFor={id} className="block text-sm">{r.label}</label>
                <select id={id} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-sm" value={draft.columns[r.id] ?? ""} onChange={(e) => setRole(r.id, e.target.value)}>
                  <option value="">Not in this file</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            );
          })}
        </fieldset>
      ) : null}

      {(() => {
        const choices = NUMBER_FORMAT_CHOICES.map((f) => {
          const id = `${ids.format}-${f.id}`;
          const fits = !evidence || evidence.textCells === 0 || evidence.consistent.includes(f.id);
          return (
            <div key={f.id} className="flex items-center gap-2 text-sm">
              <input type="radio" id={id} name={ids.format} checked={draft.numberFormat === f.id} onChange={() => change({ numberFormat: f.id })} />
              <label htmlFor={id}><span className="font-mono">{f.example}</span> — {f.label}{fits ? "" : " (does not match this file's amounts)"}</label>
            </div>
          );
        });
        // Detected and unambiguous: lead with the reading and the file's own examples; the alternatives stay one click away.
        return formatSettled && detectedFormat ? (
          <fieldset data-testid="number-format-detected">
            <legend className="text-sm font-medium">How amounts are written</legend>
            <p className="text-sm">Detected: <span className="font-mono">{detectedFormat.example}</span> — {detectedFormat.label}
              {examples.length ? <> (for example {examples.map((e, i) => <span key={e}>{i ? ", " : ""}<span className="font-mono">“{e}”</span></span>)})</> : null}.</p>
            <details className="mt-1">
              <summary className="cursor-pointer text-sm">Use a different format</summary>
              <div className="mt-1">{choices}</div>
            </details>
          </fieldset>
        ) : (
          <fieldset>
            <legend className="text-sm font-medium">How amounts are written</legend>
            {evidence?.ambiguous ? <p className="text-sm text-[#7a4a00]"><span aria-hidden="true">! </span>The amounts in this file can be read more than one way (for example “1.234”). Choose the format your system exported.</p> : null}
            {choices}
          </fieldset>
        );
      })()}

      {balanceOnly ? (
        <fieldset>
          <legend className="text-sm font-medium">A positive balance is</legend>
          {(["debit_positive", "credit_positive"] as const).map((s) => (
            <div key={s} className="flex items-center gap-2 text-sm">
              <input type="radio" id={`${ids.sign}-${s}`} name={ids.sign} checked={draft.balanceSign === s} onChange={() => change({ balanceSign: s })} />
              <label htmlFor={`${ids.sign}-${s}`}>{s === "debit_positive" ? "a debit" : "a credit"}</label>
            </div>
          ))}
        </fieldset>
      ) : null}

      {problems.length > 0 ? (
        <ul aria-label="Still needed" className="list-disc pl-5 text-sm text-muted-foreground">{problems.map((x) => <li key={x}>{x}</li>)}</ul>
      ) : null}

      {report && formatAmbiguous ? (
        <div role="group" aria-labelledby={`${ids.format}-amb`} className="rounded-md border border-[#7a4a00] bg-[#fdf8ee] p-3 text-sm text-[#5c3800]" data-testid="number-format-ambiguity">
          <p id={`${ids.format}-amb`} className="font-semibold"><span aria-hidden="true">! </span>These amounts can be read in more than one way, with different values.</p>
          <ul className="mt-1 list-disc pl-5">
            {(report.numberFormats?.examples ?? []).map((e) => (
              <li key={`${e.row}-${e.column}`}>
                Row {e.row} ({e.column}) “{e.text}”: {Object.entries(e.readings).map(([f, val]) => `${val} as ${NUMBER_FORMAT_CHOICES.find((c) => c.id === f)?.example ?? f}`).join(" · ")}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-start gap-2">
            <input id={`${ids.format}-ack`} type="checkbox" checked={formatConfirmed} onChange={(e) => setFormatConfirmed(e.target.checked)} />
            <label htmlFor={`${ids.format}-ack`}>
              I confirm the amounts are written as <span className="font-mono">{NUMBER_FORMAT_CHOICES.find((c) => c.id === report.numberFormats?.declared)?.example}</span> — the whole file was checked in this format.
            </label>
          </div>
        </div>
      ) : null}

      {suggested ? (
        <p className="rounded-md border border-input p-2 text-sm" data-testid="layout-suggested">
          Suggested layout — advisory. It was made from a sample of the file with account names and amounts removed; every
          column above is yours to check and change.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {p.assist && sheet && !sheet.suggestion ? (
          <button type="button" className="rounded-md border border-input bg-background px-3 py-1.5 text-sm" disabled={busy !== null} onClick={() => void suggest()} data-testid="layout-suggest">
            {busy === "suggest" ? "Preparing a suggestion…" : "Suggest a layout"}
          </button>
        ) : null}
        <button type="button" className="rounded-md border border-input bg-background px-3 py-1.5 text-sm" disabled={!profile || busy !== null} onClick={validate} data-testid="layout-validate">
          {busy === "validate" ? "Checking the whole file…" : "Check against the whole file"}
        </button>
        <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" disabled={!report?.layoutFits || (formatAmbiguous && !formatConfirmed) || busy !== null} onClick={() => setConfirming(true)} data-testid="layout-confirm">
          Confirm layout for this file
        </button>
        {report ? <button type="button" className="rounded-md border border-input bg-background px-3 py-1.5 text-sm" onClick={() => setReportOpen(true)} data-report-trigger>Open the report</button> : null}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={ids.name} className="block text-sm">Template name</label>
          <input id={ids.name} className="mt-1 rounded-md border border-input bg-background px-2 py-1 text-sm" value={templateName} maxLength={120} onChange={(e) => setTemplateName(e.target.value)} />
        </div>
        <button type="button" className="rounded-md border border-input bg-background px-3 py-1.5 text-sm" disabled={!profile || !templateName.trim() || busy !== null} onClick={save}>
          {template && template.name === templateName.trim() ? "Save as a new version" : "Save as template"}
        </button>
      </div>

      <SecondaryPanel open={reportOpen && !!report} title="Layout check — every row" onClose={() => setReportOpen(false)} returnSelector="[data-report-trigger]">
        {report ? <ReportView report={report} /> : null}
      </SecondaryPanel>
      <ConfirmDialog
        open={confirming} title="Confirm this layout" period={p.periodLabel} version={`confirmation ${answer.value.currentConfirmationNo + 1}`}
        consequences="This file will be read with this layout from now on. A current result for it will need a new check. The layout is recorded with this file and cannot be edited; a later change is a new confirmation."
        confirmLabel="Confirm layout" busy={busy === "confirm"} onConfirm={() => void confirm()} onCancel={() => setConfirming(false)}
      />
    </section>
  );
}

function ReportView({ report }: { report: LayoutReport }) {
  const rows = useMemo(() => report.rows.map(([rowNumber, disposition, detail]) => ({ rowNumber, disposition, detail })), [report]);
  return (
    <div className="space-y-3 text-sm">
      <p><span aria-hidden="true" className="font-bold">{report.layoutFits ? "✓ " : "✕ "}</span>{report.layoutFits ? "The layout fits the file." : "The layout does not fit the file."}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        <dt>Rows read</dt><dd className="tabular-nums">{report.lineageSummary.rowsRead ?? 0}</dd>
        <dt>Accounts</dt><dd className="tabular-nums">{report.accounts}</dd>
        <dt>Total debits</dt><dd className="tabular-nums">{report.totals ? `${report.totals.debit}${report.currency ? ` ${report.currency}` : ""}` : "— (not computed: the file could not be read with this layout)"}</dd>
        <dt>Total credits</dt><dd className="tabular-nums">{report.totals ? `${report.totals.credit}${report.currency ? ` ${report.currency}` : ""}` : "— (not computed)"}</dd>
        <dt>Difference</dt><dd className="tabular-nums">{report.totals ? report.totals.difference : "— (not computed)"}</dd>
      </dl>
      {report.issues.length > 0 ? (
        <ul aria-label="Issues" className="space-y-1">
          {report.issues.map((i, n) => <li key={n}><span className="font-semibold">{i.severity === "blocking" ? "Blocking" : "Review"}:</span> {i.message}</li>)}
        </ul>
      ) : <p>No issues found.</p>}
      <DataTable label="Every row of the file" columns={ROW_COLUMNS} rows={rows} rowId={(r) => String(r.rowNumber)} maxHeight={360} />
    </div>
  );
}
