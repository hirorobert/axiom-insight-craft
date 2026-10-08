/**
 * Financial Statements › Schedules. Each movement schedule the edition requires (property, plant and equipment;
 * investment property; intangibles; provisions) with the server's reconciliation of the schedule to the composed
 * statements: closing to this year's line, opening to the approved prior year's. Entry is structured (classes, opening,
 * movements by the cited kinds, closing); the server checks each class adds up and reconciles the totals.
 */
import { useId, useState } from "react";
import { IFRS_FOR_SMES_2015 } from "@/lib/frameworkPacks/ifrsForSmes";
import { parseAmountToMinor } from "@/lib/closeReview/adjustments";
import { STATUS_WORDS, scheduleReconciliation, type NotesStatus, type RequirementState } from "@/lib/notes/notesStatus";
import type { ScheduleDefinition } from "@/lib/frameworkPacks/types";
import { Notice, outcomeText, useAttempt, type PageProps } from "./shared";

interface ClassDraft { label: string; opening: string; closing: string; movements: Record<string, string> }
const emptyClass = (): ClassDraft => ({ label: "", opening: "", closing: "", movements: {} });

/** "1,234.56" or "-1,234.56" → minor units as text; null when not an exact amount at this exponent. */
export function signedMinor(text: string, exponent: number): string | null {
  const t = text.trim();
  const neg = t.startsWith("-");
  const v = parseAmountToMinor(neg ? t.slice(1) : t, exponent);
  return v === null ? null : (neg && v !== 0n ? -v : v).toString();
}

export function SchedulesView(p: PageProps) {
  const n = p.state.notes;
  if (!n || n.state !== "evaluated") return <p role="status">Schedules are not available{n ? ` (${n.state})` : ""}.</p>;
  const notes = n as NotesStatus;
  const exponent = p.state.composition?.state === "composed" ? p.state.composition.current.exponent : 2;
  const rows = notes.requirements.filter((r) => r.kind === "SCHEDULE");
  return (
    <div className="space-y-6">
      {rows.map((r) => {
        const def = IFRS_FOR_SMES_2015.schedules.find((s) => s.requirementId === r.requirementId);
        return def ? <Schedule key={r.requirementId} {...p} r={r} def={def} exponent={exponent} /> : null;
      })}
    </div>
  );
}

function Schedule(p: PageProps & { r: RequirementState; def: ScheduleDefinition; exponent: number }) {
  const rec = scheduleReconciliation(p.r, p.exponent);
  const [entering, setEntering] = useState(false);
  return (
    <section aria-labelledby={`h-${p.def.id}`} className="border-b border-border pb-4" data-schedule={p.def.id}>
      <h2 id={`h-${p.def.id}`} className="text-base font-semibold">{p.def.label}</h2>
      <p className="text-sm">Status: <span data-testid={`schedule-status-${p.def.id}`}>{STATUS_WORDS[p.r.status]}</span>{p.r.sourceRef ? ` · source ${p.r.sourceRef}` : ""}</p>
      {rec ? (
        <table className="mt-2 text-sm" aria-label={`${p.def.label} reconciliation`}>
          <thead><tr><th /><th className="px-3 text-right">Schedule</th><th className="px-3 text-right">Statements</th></tr></thead>
          <tbody className="tabular-nums">
            <tr><th className="text-left font-normal">Opening</th><td className="px-3 text-right">{rec.opening.schedule.text}</td><td className="px-3 text-right">{rec.opening.statement.text}</td></tr>
            <tr><th className="text-left font-normal">Closing</th><td className="px-3 text-right">{rec.closing.schedule.text}</td><td className="px-3 text-right">{rec.closing.statement.text}</td></tr>
            {rec.difference ? <tr><th className="text-left font-normal">Difference</th><td className="px-3 text-right" colSpan={2}>{rec.difference.text}</td></tr> : null}
          </tbody>
        </table>
      ) : null}
      {p.r.status === "not_applicable" ? null : p.allowed.includes("prepare_close") ? (
        entering ? <Entry {...p} onDone={() => setEntering(false)} /> : <button type="button" className="mt-2 rounded-md border border-input px-3 py-1 text-sm" onClick={() => setEntering(true)}>{p.r.submissionId ? "Replace the schedule" : "Enter the schedule"}</button>
      ) : <p className="text-sm text-muted-foreground">A preparer enters schedules.</p>}
    </section>
  );
}

function Entry(p: PageProps & { r: RequirementState; def: ScheduleDefinition; exponent: number; onDone: () => void }) {
  const [classes, setClasses] = useState<ClassDraft[]>([emptyClass()]);
  const [source, setSource] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useAttempt(p.newRequestId);
  const sourceId = useId();
  const set = (i: number, f: (c: ClassDraft) => ClassDraft) => setClasses((cs) => cs.map((c, j) => (j === i ? f(c) : c)));
  const built = classes.map((c) => {
    const opening = signedMinor(c.opening, p.exponent), closing = signedMinor(c.closing, p.exponent);
    const movements = p.def.movements.filter((m) => (c.movements[m.kind] ?? "").trim() !== "").map((m) => {
      const v = signedMinor(c.movements[m.kind], p.exponent);
      // A decrease is entered as a positive amount and recorded as a decrease; "either" keeps the sign as entered.
      return { kind: m.kind, amountMinor: v === null ? null : m.sign === "decrease" && !v.startsWith("-") && v !== "0" ? `-${v}` : v };
    });
    return { classLabel: c.label.trim(), openingMinor: opening, closingMinor: closing, movements };
  });
  const invalid = built.some((b) => !b.classLabel || b.openingMinor === null || b.closingMinor === null || b.movements.some((m) => m.amountMinor === null)) || source.trim().length < 3;
  const save = async () => {
    setBusy(true);
    try {
      const rows = built.map((b) => ({ classLabel: b.classLabel, openingMinor: b.openingMinor!, closingMinor: b.closingMinor!, movements: b.movements.map((m) => ({ kind: m.kind, amountMinor: m.amountMinor! })) }));
      const r = await p.clients.notes.recordSchedule(p.companyId, p.periodYear, p.def.id, rows, source.trim(), attempt.idFor(JSON.stringify([rows, source])));
      setNotice(r.outcome === "recorded" ? "Schedule recorded; the server reconciled it to the statements." : outcomeText(r));
      if (r.outcome === "recorded") { attempt.done(); await p.refresh(); p.onDone(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); }
  };
  return (
    <form className="mt-3 space-y-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (!invalid && !busy) void save(); }} aria-label={`${p.def.label} entry`}>
      {classes.map((c, i) => (
        <fieldset key={i} className="space-y-1 border border-border p-2">
          <legend className="px-1 font-medium">Class {i + 1}</legend>
          <label className="block">Class<input className="ml-2 rounded-md border border-input px-2 py-0.5" value={c.label} onChange={(e) => set(i, (x) => ({ ...x, label: e.target.value }))} /></label>
          <label className="block">Opening carrying amount<input inputMode="decimal" className="ml-2 rounded-md border border-input px-2 py-0.5 text-right" value={c.opening} onChange={(e) => set(i, (x) => ({ ...x, opening: e.target.value }))} /></label>
          {p.def.movements.map((m) => (
            <label key={m.kind} className="block">{m.label}{m.sign === "decrease" ? " (enter as a positive amount)" : m.sign === "either" ? " (negative for a decrease)" : ""}
              <input inputMode="decimal" className="ml-2 rounded-md border border-input px-2 py-0.5 text-right" value={c.movements[m.kind] ?? ""} onChange={(e) => set(i, (x) => ({ ...x, movements: { ...x.movements, [m.kind]: e.target.value } }))} /></label>
          ))}
          <label className="block">Closing carrying amount<input inputMode="decimal" className="ml-2 rounded-md border border-input px-2 py-0.5 text-right" value={c.closing} onChange={(e) => set(i, (x) => ({ ...x, closing: e.target.value }))} /></label>
          {classes.length > 1 ? <button type="button" className="text-xs underline" onClick={() => setClasses((cs) => cs.filter((_, j) => j !== i))}>Remove this class</button> : null}
        </fieldset>
      ))}
      <button type="button" className="rounded-md border border-input px-2 py-0.5" onClick={() => setClasses((cs) => [...cs, emptyClass()])}>Add a class</button>
      <label htmlFor={sourceId} className="block">Source (register, working paper)<input id={sourceId} className="ml-2 rounded-md border border-input px-2 py-0.5" value={source} onChange={(e) => setSource(e.target.value)} /></label>
      <div className="flex gap-2">
        <button type="submit" className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" disabled={busy || invalid}>Record the schedule</button>
        <button type="button" className="rounded-md border border-input px-3 py-1" onClick={p.onDone}>Cancel</button>
      </div>
      <Notice text={notice} />
    </form>
  );
}
