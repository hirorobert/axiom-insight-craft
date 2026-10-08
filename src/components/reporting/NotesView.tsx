/**
 * Financial Statements › Notes. Every requirement of the edition in force, with the server's status for it (fs_notes_status)
 * — one word per server state, nothing merged. A conditional requirement needs a recorded decision (applicable or not,
 * with a reason); a disclosure needs the preparer's wording and its source. Nothing is generated: missing stays missing,
 * and a blocking requirement that is missing blocks sign-off on the server.
 */
import { useId, useMemo, useState } from "react";
import { IFRS_FOR_SMES_2015, IFRS_FOR_SMES_2025 } from "@/lib/frameworkPacks/ifrsForSmes";
import { STATUS_WORDS, needsWork, type NotesStatus, type RequirementState } from "@/lib/notes/notesStatus";
import { StatusWord } from "@/components/workbench/StatusWord";
import type { StatusTone } from "@/lib/workbench/statusWords";
import { Notice, outcomeText, useAttempt, type PageProps } from "./shared";

const TONE: Record<string, StatusTone> = {
  provided: "ok", satisfied: "ok", composed: "ok", evidence_present: "ok", derived: "ok", reconciled: "ok", not_applicable: "neutral",
  reconciled_opening_unverified: "attention", missing: "blocked", undecided: "attention", dates_unknown: "blocked", incomplete: "blocked",
  evidence_missing: "blocked", closing_mismatch: "blocked", opening_mismatch: "blocked",
};

export function NotesView(p: PageProps) {
  const n = p.state.notes;
  if (!n) return null;
  if (n.state !== "evaluated") return <p role="status">Notes are not available ({n.state}).</p>;
  return <Evaluated {...p} n={n as NotesStatus} />;
}

function Evaluated(p: PageProps & { n: NotesStatus }) {
  const pack = p.n.packId === "ifrs-for-smes/2025" ? IFRS_FOR_SMES_2025 : IFRS_FOR_SMES_2015;
  const byId = useMemo(() => new Map(pack.requirements.map((r) => [r.id, r])), [pack]);
  const rows = p.n.requirements.filter((r) => r.kind !== "SCHEDULE");
  const open = rows.filter((r) => r.blocking && needsWork(r)).length;
  const [selected, setSelected] = useState<string | null>(rows.find((r) => r.blocking && needsWork(r))?.requirementId ?? null);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <section aria-labelledby="h-req">
        <h2 id="h-req" className="mb-2 text-base font-semibold">{pack.edition.title} — {open === 0 ? "no blocking requirement is open" : `${open} blocking requirement${open === 1 ? "" : "s"} open`}</h2>
        <ul className="divide-y divide-border border-y border-border text-sm" data-testid="requirements">
          {rows.map((r) => {
            const def = byId.get(r.requirementId);
            return (
              <li key={r.requirementId} className={selected === r.requirementId ? "bg-[#eef3fb]" : ""}>
                <button type="button" className="flex w-full flex-wrap items-baseline gap-x-3 px-2 py-2 text-left" aria-pressed={selected === r.requirementId} onClick={() => setSelected(r.requirementId)}
                  data-requirement={r.requirementId}>
                  <span className="min-w-[14rem] flex-1">{def?.label ?? r.requirementId}{r.blocking ? "" : <span className="text-muted-foreground"> (not blocking)</span>}</span>
                  <span className="text-xs text-muted-foreground">{def?.citations.map((c) => c.paragraph).join(", ")}</span>
                  <StatusWord value={{ text: STATUS_WORDS[r.status], tone: TONE[r.status] ?? "neutral" }} />
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {selected ? <RequirementPanel key={selected} {...p} r={rows.find((x) => x.requirementId === selected)!} label={byId.get(selected)?.label ?? selected} condition={byId.get(selected)?.condition ?? null} /> : null}
    </div>
  );
}

function RequirementPanel(p: PageProps & { n: NotesStatus; r: RequirementState; label: string; condition: string | null }) {
  const canPrepare = p.allowed.includes("prepare_close");
  const ids = { body: useId(), source: useId(), reason: useId() };
  const [body, setBody] = useState("");
  const [source, setSource] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useAttempt(p.newRequestId);
  const run = async (key: string, f: (requestId: string) => Promise<{ outcome: string }>) => {
    setBusy(true);
    try {
      const r = await f(attempt.idFor(key));
      setNotice(outcomeText(r));
      if (r.outcome === "recorded") { attempt.done(); setBody(""); setReason(""); await p.refresh(); }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Nothing was recorded."); }
    finally { setBusy(false); }
  };
  const decidable = p.r.status === "undecided" || p.r.basis === "decision" || p.condition !== null;
  const writable = p.r.kind === "DISCLOSURE" && p.r.status !== "not_applicable";
  return (
    <aside aria-labelledby="h-panel" className="space-y-3 border-l border-border pl-4 text-sm" data-testid="requirement-panel">
      <h2 id="h-panel" className="text-base font-semibold">{p.label}</h2>
      <p className="text-muted-foreground">Status: {STATUS_WORDS[p.r.status]}{p.r.sourceRef ? ` · source ${p.r.sourceRef}` : ""}</p>
      {p.condition ? <p>Applies when: {p.condition}</p> : null}
      {p.r.status === "evidence_missing" ? <p>This statement is built from evidence (the transaction ledger or equity movements). Add it on the Sign-off page with the next report version.</p> : null}
      {!canPrepare ? <p className="text-muted-foreground">A preparer records decisions and wording.</p> : (
        <>
          {decidable ? (
            <fieldset className="space-y-2">
              <legend className="font-medium">Applicability</legend>
              <label htmlFor={ids.reason} className="block">Reason<input id={ids.reason} className="mt-1 block w-full rounded-md border border-input px-2 py-1" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              <div className="flex gap-2">
                {(["applicable", "not_applicable"] as const).map((d) => (
                  <button key={d} type="button" className="rounded-md border border-input px-3 py-1 disabled:opacity-50" disabled={busy || reason.trim().length < 3}
                    onClick={() => void run(`d|${p.r.requirementId}|${d}|${reason}`, (rid) => p.clients.notes.decide(p.companyId, p.periodYear, p.r.requirementId, d, reason.trim(), rid))}>
                    {d === "applicable" ? "Applies" : "Does not apply"}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          {writable ? (
            <fieldset className="space-y-2">
              <legend className="font-medium">Wording</legend>
              <label htmlFor={ids.body} className="block">Disclosure text (your words, shown verbatim)<textarea id={ids.body} data-testid="wording-body" rows={6} className="mt-1 block w-full rounded-md border border-input px-2 py-1" value={body} onChange={(e) => setBody(e.target.value)} /></label>
              <label htmlFor={ids.source} className="block">Source (document, working paper)<input id={ids.source} data-testid="wording-source" className="mt-1 block w-full rounded-md border border-input px-2 py-1" value={source} onChange={(e) => setSource(e.target.value)} /></label>
              <button type="button" className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" disabled={busy || body.trim().length === 0 || source.trim().length < 3}
                onClick={() => void run(`w|${p.r.requirementId}|${body}|${source}`, (rid) => p.clients.notes.disclose(p.companyId, p.periodYear, p.r.requirementId, body.trim(), source.trim(), rid))}>
                Record wording
              </button>
            </fieldset>
          ) : null}
        </>
      )}
      <Notice text={notice} />
    </aside>
  );
}
