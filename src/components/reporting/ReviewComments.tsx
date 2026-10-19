/**
 * Reviewer comments (20261112100000): version-bound, item-bound, with their history. A reviewer (review_close) opens a
 * BLOCKING finding or an ADVISORY comment on a figure, a note or a statement; the preparer (prepare_close) responds; the
 * reviewer resolves or reopens. The server computes each comment's state for the version shown — a resolved comment whose
 * item changed reads "reopened" — and names every unresolved blocking comment in the version's readiness. Nothing here
 * decides a state: every word is the server's.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { presentAmount } from "@/lib/presentation/amounts";
import { COMMENT_OUTCOME_WORDS, COMMENT_STATE_WORDS, type ReviewComment } from "@/lib/reporting/reviewWorkflow";
import { Notice, useAttempt, type PageProps } from "./shared";

/** The comments of one saved version, with the actions the caller's role allows. */
export function ReviewCommentsPanel(p: PageProps & { reportId: string; reportVersion: number; filter?: { itemKind: ReviewComment["itemKind"]; itemId: string } }) {
  const [list, setList] = useState<ReviewComment[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await p.clients.review.comments(p.companyId, p.reportId, p.reportVersion);
    setList(r.state === "listed" ? (r.comments ?? []) : []);
  }, [p.clients, p.companyId, p.reportId, p.reportVersion]);
  useEffect(() => { void load().catch((e) => setNotice((e as Error).message)); }, [load, p.state]);
  if (!list) return <p role="status" className="text-sm text-muted-foreground">Reading the reviewer's comments…</p>;
  const shown = p.filter ? list.filter((c) => c.itemKind === p.filter!.itemKind && c.itemId === p.filter!.itemId) : list;
  const openBlocking = shown.filter((c) => c.severity === "blocking" && c.state !== "resolved").length;
  return (
    <section aria-labelledby={`h-rc-${p.reportVersion}`} data-testid="review-comments" data-open-blocking={openBlocking}>
      {!p.filter ? <h2 id={`h-rc-${p.reportVersion}`} className="text-base font-semibold">Reviewer comments on version {p.reportVersion} — {shown.length === 0 ? "none" : openBlocking === 0 ? "no blocking finding open" : `${openBlocking} blocking finding${openBlocking === 1 ? "" : "s"} open`}</h2> : null}
      {shown.length === 0 && p.filter ? <p className="text-xs text-muted-foreground">No reviewer comment on this item.</p> : null}
      <ul className="space-y-3">
        {shown.map((c) => <CommentCard key={c.commentId} {...p} c={c} onChange={load} />)}
      </ul>
      <Notice text={notice} />
    </section>
  );
}

function itemWords(c: ReviewComment, exponent: number): string {
  if (c.itemKind === "fact") {
    const m = c.itemId.match(/^fact:(current|comparative):([a-z_]+):(sfp|sci)\.([a-z_]+)$/);
    const label = m ? `${m[4].replace(/_/g, " ")} (${m[1]}${m[2] === "sci" ? "" : `, ${m[2].replace(/_/g, " ")}`})` : c.itemId;
    const amt = (v: string) => (/^-?\d+$/.test(v) ? presentAmount({ kind: "amount", minor: BigInt(v), exponent }).text : v);
    return c.changedSinceOpened ? `${label}: was ${amt(c.openedContent)} when opened, now ${amt(c.contentNow)}` : `${label}: ${amt(c.contentNow)}`;
  }
  if (c.itemKind === "note") return `Note ${c.itemId.replace(/^smes\.note\./, "").replace(/_/g, " ")}${c.changedSinceOpened ? " — the wording changed since this was opened" : ""}`;
  return `Statement ${c.itemId.replace(/^STATEMENT_OF_/, "").replace(/_/g, " ").toLowerCase()}`;
}

function CommentCard(p: PageProps & { c: ReviewComment; onChange: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const id = useId();
  const canReview = p.allowed.includes("review_close"), canPrepare = p.allowed.includes("prepare_close");
  const exponent = p.state.composition?.state === "composed" ? p.state.composition.current.exponent : 2;
  const act = async (kind: "respond" | "resolve" | "reopen") => {
    setBusy(true);
    try {
      const rid = attempt.idFor(`${kind}|${p.c.commentId}|${body}`);
      const r = kind === "respond" ? await p.clients.review.respond(p.companyId, p.c.commentId, body.trim(), rid)
        : kind === "resolve" ? await p.clients.review.resolve(p.companyId, p.c.commentId, body.trim(), rid)
        : await p.clients.review.reopen(p.companyId, p.c.commentId, body.trim() || null, rid);
      setNotice(COMMENT_OUTCOME_WORDS[r.outcome] ?? `The server answered: ${r.outcome}.`);
      if (r.outcome === "recorded") { attempt.done(); setBody(""); await p.onChange(); await p.refresh(); }
    } catch (e) { setNotice(`Not recorded: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };
  const c = p.c;
  const tone = c.severity === "blocking" ? (c.state === "resolved" ? "border-[#22663f]" : "border-[#a12020]") : "border-[#5f6b7a]";
  return (
    <li className={`border-l-[3px] ${tone} pl-3 text-sm`} data-testid="review-comment" data-comment-id={c.commentId} data-severity={c.severity} data-state={c.state}>
      <p><span className="font-medium">{c.severity === "blocking" ? "Blocking finding" : "Advisory comment"}</span> · {COMMENT_STATE_WORDS[c.state]} · opened on version {c.openedOnVersion} by {c.authorRole ?? "a reviewer"} {c.openedAt.slice(0, 10)}</p>
      <p className="text-muted-foreground" data-testid="comment-item">{itemWords(c, exponent)}</p>
      <ol className="mt-1 space-y-0.5 text-xs" data-testid="comment-history">
        {c.events.map((e) => <li key={e.eventId}><span className="font-medium">{e.action}</span> by {e.actorRole ?? "member"} on version {e.reportVersion}, {e.at.slice(0, 16).replace("T", " ")}{e.body ? `: ${e.body}` : ""}</li>)}
      </ol>
      {(canReview || canPrepare) && (c.state !== "resolved" || canReview) ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label htmlFor={id} className="block grow">
            <span className="sr-only">Your note</span>
            <input id={id} className="w-full rounded-md border border-input px-2 py-1" placeholder={c.state === "resolved" ? "Reason to reopen (optional)" : "Your note"} value={body} onChange={(e) => setBody(e.target.value)} data-testid="comment-note" />
          </label>
          {c.state !== "resolved" && canPrepare ? <button type="button" className="rounded-md border border-input px-3 py-1 disabled:opacity-50" disabled={busy || body.trim().length === 0} onClick={() => void act("respond")} data-testid="comment-respond">Respond</button> : null}
          {c.state !== "resolved" && canReview ? <button type="button" className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" disabled={busy || body.trim().length === 0} onClick={() => void act("resolve")} data-testid="comment-resolve">Resolve</button> : null}
          {c.state === "resolved" && canReview ? <button type="button" className="rounded-md border border-input px-3 py-1 disabled:opacity-50" disabled={busy} onClick={() => void act("reopen")} data-testid="comment-reopen">Reopen</button> : null}
        </div>
      ) : null}
      <Notice text={notice} />
    </li>
  );
}

/** The reviewer's composer for one item of one version: a blocking finding or an advisory comment. */
export function CommentComposer(p: PageProps & { reportId: string; reportVersion: number; itemKind: ReviewComment["itemKind"]; itemId: string; label: string; onOpened?: () => void }) {
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<"blocking" | "advisory">("blocking");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useAttempt(p.newRequestId);
  const ids = { body: useId(), sev: useId() };
  if (!p.allowed.includes("review_close")) return null;
  const open = async () => {
    setBusy(true);
    try {
      const r = await p.clients.review.openComment({ companyId: p.companyId, reportId: p.reportId, reportVersion: p.reportVersion, itemKind: p.itemKind, itemId: p.itemId, severity, body: body.trim(),
        requestId: attempt.idFor(`open|${p.itemKind}|${p.itemId}|${severity}|${body}`) });
      setNotice(COMMENT_OUTCOME_WORDS[r.outcome] ?? `The server answered: ${r.outcome}.`);
      if (r.outcome === "recorded") { attempt.done(); setBody(""); p.onOpened?.(); await p.refresh(); }
    } catch (e) { setNotice(`Not recorded: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };
  return (
    <fieldset className="space-y-2 text-sm" data-testid="comment-composer">
      <legend className="font-medium">Comment on {p.label} (version {p.reportVersion})</legend>
      <label htmlFor={ids.sev} className="block">Kind
        <select id={ids.sev} className="ml-2 rounded-md border border-input bg-background px-2 py-1" value={severity} onChange={(e) => setSeverity(e.target.value as "blocking" | "advisory")} data-testid="comment-severity">
          <option value="blocking">Blocking finding — must be resolved before approval</option>
          <option value="advisory">Advisory comment — never blocks</option>
        </select>
      </label>
      <label htmlFor={ids.body} className="block">Your finding<textarea id={ids.body} rows={3} className="mt-1 block w-full rounded-md border border-input px-2 py-1" value={body} onChange={(e) => setBody(e.target.value)} data-testid="comment-body" /></label>
      <button type="button" className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50" disabled={busy || body.trim().length === 0} onClick={() => void open()} data-testid="comment-open">Record the comment</button>
      <Notice text={notice} />
    </fieldset>
  );
}
