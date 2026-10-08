/**
 * One subject's Close Review history (roadmap increment 8): every comment with its current text and earlier versions,
 * every lifecycle event, and — for a member who may write — a comment box. A member who may not write reads only.
 * Writes go through the server function; a retry of the same send reuses its request id (never recorded twice).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { buildTimeline, COMMENT_REFUSALS, type SubjectKind, type TimelineClient, type TimelineItem } from "@/lib/closeReview/timeline";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const EVENT_WORDS: Record<string, string> = {};

export function ReviewTimeline(p: {
  client: TimelineClient;
  companyId: string;
  subjectKind: SubjectKind;
  subjectId: string;
  canComment: boolean;
  currentUserId: string | null;
  names?: Record<string, string>;
  newRequestId?: () => string;
}) {
  const ids = { box: useId(), list: useId() };
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const seq = useRef(0);
  const nameOf = (u: string | null) => (u ? p.names?.[u] ?? "A member" : "The system");

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const rows = await p.client.read(p.companyId, p.subjectKind, p.subjectId);
      if (mine === seq.current) { setItems(buildTimeline(rows)); setError(null); }
    } catch {
      if (mine === seq.current) setError("The history could not be read. Nothing was changed.");
    }
  }, [p.client, p.companyId, p.subjectKind, p.subjectId]);
  useEffect(() => { void load(); }, [load]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    // The same content retried keeps its request id; different content gets a new one.
    const key = `${editing ?? ""}|${body}`;
    if (!pending.current || pending.current.key !== key) pending.current = { key, id: (p.newRequestId ?? (() => crypto.randomUUID()))() };
    setBusy(true);
    try {
      const r = await p.client.comment(p.companyId, p.subjectKind, p.subjectId, body, pending.current.id, editing);
      if (r.outcome === "recorded") {
        pending.current = null; setText(""); setEditing(null); setStatus(editing ? "Your edit was recorded; the earlier text stays in the history." : "Comment recorded.");
        await load();
      } else setStatus(COMMENT_REFUSALS[r.outcome]);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "The comment could not be sent. Nothing was recorded.");
    } finally { setBusy(false); }
  };

  return (
    <section aria-labelledby={`${ids.list}-h`} className="space-y-3">
      <h3 id={`${ids.list}-h`} className="text-sm font-semibold">History and comments</h3>
      {error ? <p role="alert" className="text-sm">{error} <button type="button" className="underline" onClick={() => void load()}>Try again</button></p> : null}
      {items === null && !error ? <p role="status" className="text-sm">Reading the history…</p> : null}
      {items && items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing recorded yet.</p> : null}
      {items && items.length > 0 ? (
        <ol className="space-y-2" aria-label="History, oldest first">
          {items.map((it) => it.kind === "comment" ? (
            <li key={it.id} className="rounded-md border border-input p-2 text-sm" data-testid="timeline-comment">
              <p className="text-xs text-muted-foreground">{nameOf(it.author)} · {when(it.at)}{it.edited ? " · edited" : ""}</p>
              <p className="whitespace-pre-wrap">{it.text}</p>
              {it.edited ? (
                <details className="mt-1 text-xs">
                  <summary>Earlier versions ({it.versions.length - 1})</summary>
                  <ol className="ml-4 list-decimal">{it.versions.slice(0, -1).map((v, i) => <li key={i}>{v.text} <span className="text-muted-foreground">({when(v.at)})</span></li>)}</ol>
                </details>
              ) : null}
              {p.canComment && it.author !== null && it.author === p.currentUserId ? (
                <button type="button" className="mt-1 text-xs underline" onClick={() => { setEditing(it.id); setText(it.text); document.getElementById(ids.box)?.focus(); }}>Edit</button>
              ) : null}
            </li>
          ) : (
            <li key={it.id} className="text-sm" data-testid="timeline-event">
              <span className="text-xs text-muted-foreground">{when(it.at)} · {nameOf(it.author)} · </span>{EVENT_WORDS[it.eventType] ?? it.eventType.replace(/_/g, " ")}
            </li>
          ))}
        </ol>
      ) : null}
      {p.canComment ? (
        <div className="space-y-1">
          <label htmlFor={ids.box} className="block text-sm font-medium">{editing ? "Edit your comment" : "Add a comment"}</label>
          <textarea id={ids.box} className="w-full rounded-md border border-input bg-background p-2 text-sm" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-2">
            <button type="button" className="rounded-md border border-input bg-background px-3 py-1.5 text-sm" disabled={busy || text.trim() === ""} onClick={() => void send()}>
              {busy ? "Sending…" : editing ? "Save edit" : "Add comment"}
            </button>
            {editing ? <button type="button" className="text-sm underline" onClick={() => { setEditing(null); setText(""); }}>Cancel edit</button> : null}
          </div>
        </div>
      ) : <p className="text-xs text-muted-foreground">Read only — comments need Prepare or Review in this workspace.</p>}
      <p role="status" aria-live="polite" className="text-sm">{status ?? ""}</p>
    </section>
  );
}
