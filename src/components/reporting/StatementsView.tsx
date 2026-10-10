/**
 * Financial Statements › Statements. The two statements exactly as the database composed them (fs_statement_composition):
 * every figure is the server's, a figure it did not compute is shown as missing with its reason. Enter (or "Trace") on a
 * line opens its lineage — accounts, certification, adjustments, assignment, bridge or restatement — in the evidence panel.
 * Accounts not on a line are listed with the one action that fixes them: assigning a presentation line (server-checked).
 */
import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EvidenceIntake } from "./EvidenceIntake";
import { DataTable, type DataColumn } from "@/components/workbench/DataTable";
import { SecondaryPanel } from "@/components/workbench/SecondaryPanel";
import { presentAmount } from "@/lib/presentation/amounts";
import { IFRS_FOR_SMES_2015 } from "@/lib/frameworkPacks/ifrsForSmes";
import { statementViews, type Composition, type CompositionLine, type StatementRow } from "@/lib/statements/composition";
import type { NotesStatus } from "@/lib/notes/notesStatus";
import { Notice, outcomeText, useAttempt, type PageProps } from "./shared";

const NOT_COMPOSED: Record<string, string> = {
  unavailable: "Financial statements are not enabled for this company.",
  no_authority: "There is no reviewed trial balance for this year yet. Review the trial balance first.",
  legacy_certification: "This year's trial balance was reviewed before exact amounts were recorded. Review it again.",
  currency_unknown: "The trial balance has no currency recorded.",
  edition_unresolved: "The IFRS for SMEs edition cannot be decided for this period.",
  invalid_request: "The request was not valid.",
};

type Row = StatementRow & { key: string };

export function StatementsView(p: PageProps) {
  const c = p.state.composition;
  if (!c) return null;
  if (c.state !== "composed") return <p role="status" data-testid="statements-not-composed">{NOT_COMPOSED[c.state] ?? `Not composed (${c.state}).`}</p>;
  return <Composed {...p} c={c} />;
}

function Composed(p: PageProps & { c: Composition }) {
  const tci = p.state.notes?.state === "evaluated" ? (p.state.notes as NotesStatus).requirements.find((r) => r.requirementId === "smes.sci.5_5_i") ?? null : null;
  const views = useMemo(() => {
    const v = statementViews(p.c);
    if (tci?.status !== "composed" || !tci.totalsMinor) return v;
    // Total comprehensive income (5.5(i)) — the server's figure: profit or loss, as no other comprehensive income is decided.
    const amt = (m: string | undefined) => (m === undefined ? presentAmount({ kind: "missing", reason: "not composed for this period" }) : presentAmount({ kind: "amount", minor: BigInt(m), exponent: p.c.current.exponent }));
    return v.map((s) => (s.id !== "SCI" ? s : { ...s, rows: [...s.rows, { kind: "total" as const, label: "Total comprehensive income for the period", current: amt(tci.totalsMinor!.current), comparative: amt(tci.totalsMinor!.comparative) }] }));
  }, [p.c, tci]);
  const [open, setOpen] = useState<Row | null>(null);
  const cmpYear = p.c.comparative.periodYear;
  const columns: DataColumn<Row>[] = [
    { id: "label", header: "Line", wrap: true, render: (r) => <span className={r.kind === "heading" ? "font-semibold" : r.kind === "total" ? "font-semibold" : r.kind === "subtotal" ? "font-medium" : "pl-3"}>{r.label}</span> },
    { id: "cur", header: `FY${p.c.current.periodYear}`, kind: "amount", render: (r) => (r.current ? <Amt t={r.current} /> : "") },
    { id: "cmp", header: cmpYear ? `FY${cmpYear}` : "Comparative", kind: "amount", render: (r) => (r.comparative ? <span><Amt t={r.comparative} />{r.comparativeAsReported ? <span className="block text-xs text-muted-foreground">as reported <Amt t={r.comparativeAsReported} /></span> : null}</span> : "") },
    { id: "trace", header: "Lineage", render: (r) => (r.lineage ? <button type="button" className="text-primary underline" data-trace={r.lineId} onClick={() => setOpen(r)} tabIndex={-1}>Trace</button> : "") },
  ];
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground" data-testid="composition-identity">
        {p.c.pack.packId === "ifrs-for-smes/2025" ? "IFRS for SMEs (third edition, 2025)" : "IFRS for SMEs (2015 edition)"}{p.c.pack.earlyApplication ? " — early application elected" : ""} · {p.c.current.currency} ·
        composition <code>{p.c.compositionSha256.slice(0, 12)}</code>
      </p>
      {views.map((v) => (
        <section key={v.id} aria-labelledby={`h-${v.id}`}>
          <h2 id={`h-${v.id}`} className="mb-2 text-base font-semibold">{v.title}</h2>
          <DataTable label={v.title} columns={columns} rows={v.rows.map((r, i) => ({ ...r, key: `${v.id}:${i}` }))} rowId={(r) => r.key} onOpen={(r) => r.lineage && setOpen(r)} maxHeight={640} />
        </section>
      ))}
      {tci && tci.status !== "composed" ? (
        <p role={tci.status === "unsupported" ? "alert" : "status"} className="text-sm" data-testid="tci-limitation">
          Total comprehensive income is not shown: {tci.basis ?? "decide 5.5(g) and 5.5(h) on the Notes page."}{" "}
          <Link className="text-primary underline" to={p.hrefFor("fs-notes", p.reportVersion)}>Notes →</Link>
        </p>
      ) : null}
      <NotPresented {...p} />
      {/* Cash-flow and equity evidence is part of preparing the statements; Sign-off only summarises it. */}
      <EvidenceIntake {...p} mode="prepare" />
      <SecondaryPanel open={open !== null} title={open ? `Lineage — ${open.label}` : ""} onClose={() => setOpen(null)} returnSelector={open ? `[data-trace="${open.lineId}"]` : undefined}>
        {open?.lineage ? <Lineage lineage={open.lineage} exponent={p.c.current.exponent} /> : null}
      </SecondaryPanel>
    </div>
  );
}

function Amt({ t }: { t: ReturnType<typeof presentAmount> }) {
  return <span data-state={t.state} title={t.description ?? undefined} className={t.state === "missing" ? "text-muted-foreground" : ""}>{t.text}{t.description ? <span className="sr-only"> ({t.description})</span> : null}</span>;
}

function Lineage({ lineage, exponent }: { lineage: CompositionLine["lineage"]; exponent: number }) {
  return (
    <div data-testid="lineage-panel">
      <p className="mb-2 text-muted-foreground">Every figure is the server's: the account's certified amount, plus approved adjustments, on the assignment shown.</p>
      <table className="w-full text-xs">
        <thead><tr><th className="text-left">Period</th><th className="text-left">Source</th><th className="text-right">Amount</th></tr></thead>
        <tbody>
          {lineage.map((x, i) => (
            <tr key={i} className="align-top">
              <td>{x.period}</td>
              <td>
                {x.kind === "restatement" ? <>Approved restatement <code>{x.restatementId?.slice(0, 8)}</code></> : <>{x.accountCode ?? x.accountKey} {x.accountName}</>}
                <span className="block text-muted-foreground">
                  {x.certificationId ? <>certification <code>{x.certificationId.slice(0, 8)}</code>; </> : null}
                  {x.adjustmentIds.length ? <>adjustments {x.adjustmentIds.map((a) => a.slice(0, 8)).join(", ")}; certified {presentAmount({ kind: "amount", minor: BigInt(x.certifiedAmountMinor), exponent }).text}; </> : null}
                  {x.assignmentSeq !== null ? <>assignment #{x.assignmentSeq}</> : null}
                  {x.bridgeId ? <>; bridged <code>{x.bridgeId.slice(0, 8)}</code></> : null}
                </span>
              </td>
              <td className="text-right tabular-nums">{presentAmount({ kind: "amount", minor: BigInt(x.amountMinor), exponent }).text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS: Record<string, string> = { unassigned: "Not on a line", incompatible: "On an incompatible line", excluded: "Excluded" };

function NotPresented(p: PageProps & { c: Composition }) {
  const rows = p.c.accountsNotPresented.filter((a) => a.period === "current");
  const canAssign = p.allowed.includes("prepare_close");
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useAttempt(p.newRequestId);
  const reasonId = useId();
  if (rows.length === 0) return <p className="text-sm" data-testid="all-presented">Every account of FY{p.c.current.periodYear} is on a presentation line.</p>;
  const lines = IFRS_FOR_SMES_2015.lines;
  const chosen = rows.filter((a) => choice[a.accountKey]).map((a) => ({ accountKey: a.accountKey, lineId: choice[a.accountKey] }));
  const assign = async () => {
    setBusy(true);
    try {
      const r = await p.clients.composition.assign(p.companyId, chosen, reason.trim(), attempt.idFor(JSON.stringify([chosen, reason])));
      setNotice(r.outcome === "recorded" ? `${r.count} account(s) assigned.` : r.outcome === "unknown_line" ? `Unknown line ${r.lineId}.` : outcomeText(r));
      if (r.outcome === "recorded") { attempt.done(); setChoice({}); setReason(""); await p.refresh(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="h-np" data-testid="not-presented">
      <h2 id="h-np" className="mb-2 text-base font-semibold">Accounts not presented ({rows.length})</h2>
      <p className="mb-2 text-sm text-muted-foreground">Totals stay missing until every account is on a compatible line. The server checks each assignment against the account's nature.</p>
      <ul className="space-y-2 text-sm">
        {rows.map((a) => (
          <li key={a.accountKey} className="flex flex-wrap items-center gap-2">
            <span className="min-w-[16rem]">{a.accountCode ?? a.accountKey} {a.accountName} <span className="text-muted-foreground">({STATUS[a.status] ?? a.status}; {a.classification})</span></span>
            {canAssign ? (
              <select aria-label={`Presentation line for ${a.accountName}`} className="rounded-md border border-input bg-background px-2 py-1" value={choice[a.accountKey] ?? ""}
                onChange={(e) => setChoice((c) => ({ ...c, [a.accountKey]: e.target.value }))}>
                <option value="">Choose a line…</option>
                {lines.map((l) => <option key={l.id} value={l.id}>{l.statement === "SFP" ? "Position" : "Income"} — {l.label}</option>)}
              </select>
            ) : null}
          </li>
        ))}
      </ul>
      {canAssign ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label htmlFor={reasonId} className="text-sm">Reason<input id={reasonId} className="ml-2 rounded-md border border-input px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button type="button" className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50" disabled={busy || chosen.length === 0 || reason.trim().length < 3} onClick={() => void assign()}>
            Assign {chosen.length || ""} account{chosen.length === 1 ? "" : "s"}
          </button>
        </div>
      ) : <p className="text-sm text-muted-foreground">A preparer assigns presentation lines.</p>}
      <Notice text={notice} />
    </section>
  );
}
