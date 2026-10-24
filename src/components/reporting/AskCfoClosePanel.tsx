/**
 * Ask CFOClose (Release 0.1) — the assistant panel for ONE statement line, opened from the Statements page while the
 * reviewed gate (src/lib/assistant/gate.ts) is on. Two model-backed actions (explain the movement, draft commentary) and one
 * ordinary navigation (show the supporting records = the existing lineage panel). Nothing here writes a financial record;
 * the draft is text the person may copy — it is never inserted into a report.
 *
 * The header always states the company, period, line and data status. Answers are rendered as TEXT (React escapes it);
 * every figure in them was rendered by the server from the database's own figures. A response that arrives after the
 * person moved to another company, period or line is discarded (assistantClient.ts).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  assistantSession, BLOCK_TITLES, contextKeyFor, statusWords,
  type AssistantAction, type AssistantInvoke, type AssistantOutcome, type Refinement, type RenderedAnswer,
} from "@/lib/assistant/assistantClient";

export interface AskCfoClosePanelProps {
  readonly companyId: string;
  readonly periodYear: number;
  readonly legalName: string;
  readonly lineId: string;
  readonly lineLabel: string;
  /** e.g. "Composed from certified trial balances · comparative available". */
  readonly dataStatus: string;
  readonly onShowRecords: () => void;
  readonly rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  /** The reporting transport's function call (src/lib/reporting/supabaseDb.ts — the one sanctioned Edge Function path). */
  readonly invoke: AssistantInvoke;
}

export function AskCfoClosePanel(p: AskCfoClosePanelProps) {
  const session = useMemo(() => assistantSession(p.invoke), [p.invoke]);
  const contextKey = contextKeyFor(p.companyId, p.periodYear, p.lineId);
  const active = useRef(contextKey);
  active.current = contextKey;
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<AssistantAction | null>(null);
  const [outcome, setOutcome] = useState<AssistantOutcome | null>(null);
  const [draft, setDraft] = useState("");
  const rpc = useRef(p.rpc);
  rpc.current = p.rpc;

  // A new company, period or line is a new conversation: nothing carries over.
  useEffect(() => {
    setOutcome(null); setDraft(""); setBusy(null);
    let live = true;
    void Promise.resolve(rpc.current("ai_assistant_status", { p_company_id: p.companyId })).then(({ data, error }) => {
      if (!live) return;
      setStatus(error ? "unavailable" : String((data as { state?: unknown } | null)?.state ?? "unavailable"));
    }, () => live && setStatus("unavailable"));
    return () => { live = false; };
  }, [contextKey, p.companyId]);

  const ask = async (action: AssistantAction, refinement: Refinement | null = null) => {
    setBusy(action);
    const { ticket, outcome: o } = await session.ask({ action, companyId: p.companyId, periodYear: p.periodYear, lineId: p.lineId, refinement });
    if (!session.accepts(ticket, active.current)) return; // the person moved on: discard
    setBusy(null);
    setOutcome(o);
    if (o.kind === "answered" && o.answer.draftText !== null) setDraft(o.answer.draftText);
  };

  const unavailable = status === null ? null : statusWords(status);
  const answer = outcome?.kind === "answered" ? outcome.answer : null;
  return (
    <div className="space-y-4" data-testid="ask-cfoclose">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="ask-context">
        <dt className="text-muted-foreground">Company</dt><dd>{p.legalName}</dd>
        <dt className="text-muted-foreground">Period</dt><dd>FY{p.periodYear}</dd>
        <dt className="text-muted-foreground">Line</dt><dd>{p.lineLabel}</dd>
        <dt className="text-muted-foreground">Data</dt><dd>{p.dataStatus}</dd>
      </dl>
      {unavailable ? <p role="status" className="text-sm" data-testid="ask-unavailable">{unavailable}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
          disabled={status !== "available" || busy !== null} onClick={() => void ask("explain_movement")} data-testid="ask-explain">
          {busy === "explain_movement" ? "Explaining…" : "Explain this movement"}
        </button>
        <button type="button" className="rounded-md border px-3 py-1 text-sm disabled:opacity-50"
          disabled={status !== "available" || busy !== null} onClick={() => void ask("draft_commentary")} data-testid="ask-draft">
          {busy === "draft_commentary" ? "Drafting…" : "Draft commentary"}
        </button>
        <button type="button" className="rounded-md border px-3 py-1 text-sm" onClick={p.onShowRecords} data-testid="ask-records">Show supporting records</button>
      </div>
      {busy ? <p role="status" className="text-sm text-muted-foreground">Reading this line's figures and asking the assistant…</p> : null}
      {outcome && outcome.kind !== "answered" ? <p role={outcome.kind === "failed" ? "alert" : "status"} className="text-sm" data-testid="ask-outcome">{outcome.message}</p> : null}
      {answer ? <Answer answer={answer} replay={outcome?.kind === "answered" && outcome.replay} /> : null}
      {answer?.draftText !== null && answer ? (
        <div className="space-y-2" data-testid="ask-draft-editor">
          <label className="block text-sm font-medium" htmlFor="ask-draft-text">Draft — not reviewed</label>
          <textarea id="ask-draft-text" className="h-40 w-full rounded-md border p-2 text-sm" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            Figures as of composition {answer.asOf.compositionSha256.slice(0, 12)}. Your edits are your own: edited text is not checked by CFOClose,
            and nothing is added to the report unless you put it there.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded-md border px-3 py-1 text-sm" onClick={() => void navigator.clipboard?.writeText(draft)}>Copy draft</button>
            {(["shorter", "more_formal", "plain_language"] as const).map((r) => (
              <button key={r} type="button" className="rounded-md border px-3 py-1 text-sm disabled:opacity-50" disabled={busy !== null || status !== "available"}
                onClick={() => void ask("draft_commentary", r)}>{r === "shorter" ? "Shorter" : r === "more_formal" ? "More formal" : "Plain language"}</button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Answer({ answer, replay }: { answer: RenderedAnswer; replay: boolean }) {
  return (
    <section aria-label={answer.label} className="space-y-3" data-testid="ask-answer">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {answer.label} · advisory, not reviewed{replay ? " · previously given" : ""} · as of composition {answer.asOf.compositionSha256.slice(0, 12)}
      </p>
      {answer.blocks.filter((b) => b.kind !== "draft").map((b, i) => (
        <div key={i} data-block={b.kind}>
          <h3 className="text-sm font-semibold">{BLOCK_TITLES[b.kind]}{b.author === "application" ? " (CFOClose)" : ""}</h3>
          <p className="text-sm">
            {b.parts.map((part, j) => (part.kind === "fact"
              ? <strong key={j} className={part.status === "composed" ? "tabular-nums" : "font-normal italic"} data-fact={part.factId}>{part.text}</strong>
              : <span key={j}>{part.text}</span>))}
          </p>
          {b.sources.length ? <p className="text-xs text-muted-foreground">Sources: {b.sources.map((s) => s.label).join("; ")}</p> : null}
        </div>
      ))}
    </section>
  );
}
