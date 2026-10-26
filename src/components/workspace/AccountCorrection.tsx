/**
 * AccountCorrection — the trial balance page's view of ONE account opened from a Close Review finding
 * (src/lib/workspace/accountCorrection.ts has the journey and its rules). Reads with the person's session; writes only
 * through the existing server functions (resolve_account_review_batch, the page's one reprocess path,
 * close_review_refresh_findings). Every state is derived from what the server holds, so a reload, Back or a deep link
 * lands on the same state; an unconfirmed save keeps its request id across a reload so a retry cannot record it twice.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ActionButton } from "@/components/feedback/ActionButton";
import { PendingStatus } from "@/components/feedback/Activity";
import { ConfirmDialog } from "@/components/workbench/ConfirmDialog";
import { CLASSIFICATIONS, isClassification, type ClassificationValue } from "@/lib/accounting/classificationMeta";
import { RULE_WORDS, type FindingsClient } from "@/lib/closeReview/findings";
import { presentAmount } from "@/lib/presentation/amounts";
import {
  correctionDecision, correctionView, findingReturnHref, parsePending, pendingKey, readCorrectionContext, reasonValid, returnStatus, saveCorrection,
  REASON_MAX, type CorrectionContext, type CorrectionDbReaders, type CorrectionLink, type ReturnStatus, type SaveOutcome,
} from "@/lib/workspace/accountCorrection";
import { classificationWords, DECISION_WORDS, memberWords } from "@/lib/workspace/reviewConfirmation";

type RpcError = { code?: string | null; message?: string | null } | null;
export interface AccountCorrectionProps {
  companyId: string;
  periodYear: number;
  link: CorrectionLink;
  reportVersion: number | null;
  /** The workspace's active trial balance (the one the page shows). */
  upload: { id: string; status: string } | null;
  /** Prepare, exercisable now, with the processing entitlement — the same authority the server checks. */
  canCorrect: boolean;
  currentUserId: string | null;
  findings: FindingsClient;
  readers: CorrectionDbReaders;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError }>;
  /** The page's one reprocess path (requestReprocess); throws with a person-readable message when refused. */
  startCheck: () => Promise<void>;
  /** Tells the page the upload changed (its own reads refresh). */
  onUploadChanged: () => void;
}

const store = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* the request id is still kept in memory */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* nothing to clear */ } },
};
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHECKING = new Set(["pending", "queued", "processing", "validating"]);

type Read = { state: "loading" } | { state: "failed" } | { state: "ready"; ctx: CorrectionContext };
type Check = { phase: "idle" } | { phase: "confirm" } | { phase: "running"; step: string } | { phase: "done"; status: ReturnStatus } | { phase: "failed"; words: string };

export function AccountCorrection(p: AccountCorrectionProps) {
  const ids = { h: useId(), cls: useId(), reason: useId() };
  const heading = useRef<HTMLHeadingElement>(null);
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [classification, setClassification] = useState<ClassificationValue | "">("");
  const [reason, setReason] = useState("");
  const [save, setSave] = useState<{ busy: boolean; outcome: SaveOutcome | null }>({ busy: false, outcome: null });
  const [check, setCheck] = useState<Check>({ phase: "idle" });
  const attempt = useRef<{ payload: string; requestId: string } | null>(null);
  const seq = useRef(0);
  const key = p.upload ? pendingKey(p.upload.id, p.link.accountKey) : null;
  const back = findingReturnHref(p.companyId, p.periodYear, p.link.findingKey, p.reportVersion);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const ctx = await readCorrectionContext({ summary: p.findings.summary, list: p.findings.list, states: p.findings.states, ...p.readers }, p.companyId, p.periodYear, p.link);
      if (mine === seq.current) setRead({ state: "ready", ctx });
      return ctx;
    } catch {
      if (mine === seq.current) setRead({ state: "failed" });
      return null;
    }
  }, [p.findings, p.readers, p.companyId, p.periodYear, p.link]);

  useEffect(() => { void reload(); }, [reload, p.upload?.id, p.upload?.status]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView?.({ block: "start" }); }, [p.link.findingKey]);

  // An unconfirmed save from before a reload: its content and request id come back, so "Try again" sends the same request.
  useEffect(() => {
    if (!key) return;
    const pending = parsePending(store.get(key));
    if (!pending) return;
    setClassification(pending.classification);
    setReason(pending.reason);
    attempt.current = { payload: `${pending.classification}|${pending.reason.trim()}`, requestId: pending.requestId };
    setSave({ busy: false, outcome: { kind: "unknown" } });
  }, [key]);

  const view = read.state === "ready" ? correctionView(read.ctx, p.upload) : null;
  // The pending save landed (the saved classification is the one that was sent): nothing is uncertain any more.
  useEffect(() => {
    if (!key || (view?.kind !== "ready" && view?.kind !== "needs_recheck") || save.outcome?.kind !== "unknown" || !attempt.current) return;
    const pendingCheck = view.kind === "needs_recheck" || view.savedNotChecked;
    if (pendingCheck && view.mapping?.classification === classification) { store.del(key); attempt.current = null; setSave({ busy: false, outcome: { kind: "saved" } }); }
  }, [view, key, classification, save.outcome]);

  // While the trial balance is being checked (by anyone), read again until it settles.
  const { onUploadChanged } = p;
  useEffect(() => {
    if (view?.kind !== "checking" || check.phase === "running") return;
    const t = setInterval(() => onUploadChanged(), 3000);
    return () => clearInterval(t);
  }, [view?.kind, check.phase, onUploadChanged]);

  const onSave = async () => {
    if ((view?.kind !== "ready" && view?.kind !== "needs_recheck") || !p.upload || !key || !isClassification(classification) || !reasonValid(reason) || save.busy) return;
    const decision = correctionDecision({ account_code: view.finding.account_code, account_name: view.finding.account_name ?? p.link.accountKey }, classification, reason, p.link.findingKey);
    const payload = `${classification}|${reason.trim()}`;
    if (!attempt.current || attempt.current.payload !== payload) attempt.current = { payload, requestId: crypto.randomUUID() };
    store.set(key, JSON.stringify({ requestId: attempt.current.requestId, classification, reason: reason.trim() }));
    setSave({ busy: true, outcome: null });
    const outcome = await saveCorrection(p.rpc, { companyId: p.companyId, uploadId: p.upload.id, requestId: attempt.current.requestId, decision });
    if (outcome.kind !== "unknown") { store.del(key); attempt.current = null; }
    setSave({ busy: false, outcome });
    if (outcome.kind === "saved") { setReason(""); setClassification(""); await reload(); }
  };

  const refreshFindings = async (): Promise<void> => {
    setCheck({ phase: "running", step: "Checking for findings on the reviewed trial balance…" });
    try {
      const r = await p.findings.refresh(p.companyId, p.periodYear);
      const ctx = await reload();
      setCheck({ phase: "done", status: ctx ? returnStatus(r.outcome, ctx) : { kind: "not_checked", words: "The findings could not be read after the check." } });
    } catch {
      setCheck({ phase: "failed", words: "The findings could not be checked. Nothing was changed by this attempt. Try again." });
    }
  };

  const onCheckAgain = async () => {
    if (!p.upload) return;
    const uploadId = p.upload.id;
    setCheck({ phase: "running", step: "Checking the trial balance with the saved classification…" });
    try { await p.startCheck(); }
    catch (e) { setCheck({ phase: "failed", words: `${e instanceof Error && e.message ? e.message : "The new check did not start."} Nothing was changed.` }); p.onUploadChanged(); return; }
    // The server's own state decides when the check has finished (bounded; the page keeps reading afterwards).
    let status: string | null = null;
    for (let i = 0; i < 90; i++) {
      status = await p.readers.uploadStatus(uploadId).catch(() => null);
      if (status && !CHECKING.has(status)) break;
      await sleep(2000);
    }
    p.onUploadChanged();
    if (!status || CHECKING.has(status)) { setCheck({ phase: "failed", words: "The check is still running. This page updates when it finishes; then check for findings." }); return; }
    if (status !== "complete") {
      await reload();
      setCheck({ phase: "done", status: { kind: "not_checked", words: status === "needs_review"
        ? "The trial balance was checked; some accounts still need review, so it is not reviewed yet and the findings were not checked."
        : "The check finished without a reviewed trial balance, so the findings were not checked. See the result on this page." } });
      return;
    }
    await refreshFindings();
  };

  const backLink = back ? <Link to={back} className="underline underline-offset-4" data-testid="correction-back">Back to the finding</Link> : null;
  const exponent = read.state === "ready" ? read.ctx.runExponent : null;
  const amount = (minor: string | null) => (minor === null || exponent === null ? "—" : presentAmount({ kind: "amount", minor: BigInt(minor), exponent }).text);

  let body: ReactNode;
  if (check.phase === "running") body = <PendingStatus label={check.step} />;
  else if (check.phase === "done") {
    body = (
      <div role="status" className="space-y-2 text-[13px]" data-testid="correction-result" data-result={check.status.kind}>
        <p className="font-medium">{check.status.words}</p>
        {check.status.kind === "no_longer_raised" ? <p className="text-muted-foreground">The earlier finding and its history stay in the record of the earlier check.</p> : null}
        <p>{backLink}</p>
      </div>
    );
  } else if (read.state === "loading") body = <PendingStatus label="Reading the account…" />;
  else if (read.state === "failed" || !view) body = <p role="alert" className="text-[13px]">The account could not be read. Nothing was changed. <button type="button" className="underline" onClick={() => void reload()}>Try again</button></p>;
  else if (view.kind === "checking") body = <PendingStatus label="The trial balance is being checked…" />;
  else if (view.kind === "unavailable" || view.kind === "no_authority") body = <p role="status" className="text-[13px]">{view.words} {backLink}</p>;
  else if (view.kind === "needs_review") body = <p role="status" className="text-[13px]">Some accounts on this trial balance need review, so it is not reviewed yet and its findings cannot be checked. Finish the account review below first.</p>;
  else if (view.kind === "other_trial_balance") body = <p role="status" className="text-[13px]">These findings were checked on a different trial balance from the one in use. Check for findings again on Close Review › Findings. {backLink}</p>;
  else if (view.kind === "not_raised") body = <p role="status" className="text-[13px]" data-testid="correction-not-raised">The current check of the reviewed trial balance does not raise this finding. {backLink}</p>;
  else if (view.kind === "findings_out_of_date") {
    body = (
      <div className="space-y-2 text-[13px]" data-testid="correction-findings-out-of-date">
        <p role="status">The trial balance has been checked again; its findings have not been checked on it yet.</p>
        {p.canCorrect ? <ActionButton type="button" className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" onClick={() => void refreshFindings()}>Check for findings</ActionButton>
          : <p className="text-muted-foreground">Checking for findings needs Prepare in this workspace.</p>}
      </div>
    );
  } else {
    const f = view.finding;
    const saved = view.mapping?.classification ?? null;
    const lastCheck = view.kind === "needs_recheck";
    // Saved but not yet used by a check: the reviewed result is out of date (needs_recheck), or this correction is newer
    // than the current findings (ready + savedNotChecked).
    const pendingCheck = lastCheck || view.savedNotChecked;
    const savedHere = view.kind === "needs_recheck" ? view.savedAfterCheck : view.savedNotChecked;
    const unchangedChoice = classification !== "" && classification === saved && !pendingCheck;
    body = (
      <div className="space-y-4 text-[13px]">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]" data-testid="correction-account">
          <dt className="text-muted-foreground">Account</dt><dd className="font-medium">{f.account_code ? <span className="tabular-nums">{f.account_code} </span> : null}{f.account_name}</dd>
          <dt className="text-muted-foreground">{lastCheck ? "Balance when last checked" : "Balance on the reviewed trial balance"}</dt>
          <dd className="tabular-nums" data-testid="correction-balance">Debit {amount(f.debit_minor)} · Credit {amount(f.credit_minor)}</dd>
          <dt className="text-muted-foreground">{lastCheck ? "Classification used when last checked" : "Classification used by the current check"}</dt><dd data-testid="correction-checked-class">{classificationWords(f.classification)}</dd>
          <dt className="text-muted-foreground">Saved classification</dt>
          <dd data-testid="correction-saved-class">
            {saved ? classificationWords(saved) : "No reviewed classification is saved for this account"}
            {view.decision ? <span className="text-muted-foreground"> — {DECISION_WORDS[view.decision.decision_action] ?? "Decision recorded"} by {memberWords(view.decidedBy ?? undefined, p.currentUserId)}, {when(view.decision.created_at)}</span> : null}
          </dd>
        </dl>
        {save.outcome?.kind === "saved" && pendingCheck ? <p role="status" className="font-medium" data-testid="correction-saved">Correction saved.</p> : null}
        {pendingCheck ? (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3" data-testid="correction-saved-not-checked">
            <p>{savedHere
              ? "The saved classification is not yet used by a check. Until the trial balance is checked again it is not reviewed, and its findings are not current."
              : "This trial balance's reviewed result is no longer current: a classification it used has changed. Check it again to apply the saved classifications."}</p>
            {p.canCorrect ? <ActionButton type="button" className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" data-testid="correction-check-again" onClick={() => setCheck({ phase: "confirm" })}>Check the trial balance again</ActionButton>
              : <p className="text-muted-foreground">Checking the trial balance again needs Prepare in this workspace.</p>}
          </div>
        ) : p.canCorrect ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void onSave(); }} data-testid="correction-form">
            <div className="space-y-1">
              <label htmlFor={ids.cls} className="block font-medium">Correct classification</label>
              <select id={ids.cls} required className="h-10 w-full max-w-sm rounded-md border border-input bg-background px-2" value={classification}
                onChange={(e) => setClassification(e.target.value as ClassificationValue | "")} disabled={save.busy}>
                <option value="">Choose a classification</option>
                {CLASSIFICATIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              {unchangedChoice ? <p className="text-muted-foreground">This is already the saved classification.</p> : null}
            </div>
            <div className="space-y-1">
              <label htmlFor={ids.reason} className="block font-medium">Reason for the correction</label>
              <textarea id={ids.reason} rows={3} maxLength={REASON_MAX} className="w-full rounded-md border border-input bg-background p-2" value={reason}
                onChange={(e) => setReason(e.target.value)} disabled={save.busy} />
            </div>
            <p className="text-muted-foreground">Saving records a review decision for this account in this company, by you, with your reason. Earlier decisions stay in the record and the uploaded file is not changed. The trial balance then needs to be checked again: until it is, it is not reviewed and its findings are not current.</p>
            <ActionButton type="submit" busy={save.busy} busyLabel="Saving…" className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
              disabled={!isClassification(classification) || !reasonValid(reason) || unchangedChoice} data-testid="correction-save">
              {save.outcome?.kind === "unknown" ? "Try again" : "Save correction"}
            </ActionButton>
          </form>
        ) : (
          <p className="text-muted-foreground" data-testid="correction-read-only">You can see this account. Correcting its classification needs Prepare in this workspace.</p>
        )}
      </div>
    );
  }

  return (
    <section id="account-correction" className="scroll-mt-24 space-y-4 border border-primary/40 bg-card px-5 py-5 sm:px-7" aria-labelledby={ids.h} data-testid="account-correction">
      <div className="space-y-1">
        <h2 id={ids.h} ref={heading} tabIndex={-1} className="text-base font-semibold focus:outline-none">Account from a Close Review finding</h2>
        <p className="text-[13px] text-muted-foreground">Finding: {RULE_WORDS[p.link.rule]?.title ?? p.link.rule} · FY{p.periodYear} {backLink ? <>· {backLink}</> : null}</p>
      </div>
      {body}
      {save.outcome?.kind === "refused" ? <p role="alert" className="text-[13px] text-destructive" data-testid="correction-refused">{save.outcome.words}</p> : null}
      {save.outcome?.kind === "unknown" && check.phase !== "running" ? (
        <p role="alert" className="text-[13px]" data-testid="correction-unknown">
          We could not confirm whether the correction was saved. Your choice is kept; "Try again" sends the same request
          (reference {attempt.current?.requestId.slice(0, 8)}), so it cannot be recorded twice.
        </p>
      ) : null}
      {check.phase === "failed" ? <p role="alert" className="text-[13px]" data-testid="correction-check-failed">{check.words}</p> : null}
      <ConfirmDialog open={check.phase === "confirm"} title="Check the trial balance again" period={`FY${p.periodYear}`} version={null}
        consequences="The trial balance is checked again with the saved classifications. Until the check finishes it is not reviewed, and its findings are checked again afterwards. The uploaded file, earlier decisions and earlier findings stay in the record."
        confirmLabel="Check again" onCancel={() => setCheck({ phase: "idle" })} onConfirm={() => void onCheckAgain()} />
    </section>
  );
}

