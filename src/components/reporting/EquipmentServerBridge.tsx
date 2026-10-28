import { canonicalStringify } from "@/lib/canonicalStatement/serialization";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActivity } from "@/components/feedback/useActivity";
import { useBusyState } from "@/hooks/useBusyState";
import { commitProblemWords, noteProposal, NOTE_REQUIREMENTS, workpaperClient, type EquipmentContextV2, type NoteInsertion, type NoteRequirement } from "@/lib/preparation/workpaperClient";
import type { ReportingDb } from "@/lib/reporting/signoff";
import { Notice, useAttempt } from "./shared";

const NOTE_WORDS: Record<NoteRequirement, { label: string; heading: string }> = {
  "smes.note.policies": { label: "Accounting policies (equipment section)", heading: "Equipment — reviewed section" },
  "smes.note.subclassifications": { label: "Equipment note (classes, cost, depreciation and movements)", heading: "Property, plant and equipment — reviewed section" },
  "smes.note.estimates": { label: "Key sources of estimation uncertainty (equipment)", heading: "Equipment estimates — reviewed section" },
};
const button = "rounded-md border border-input px-3 py-2 text-sm disabled:opacity-50";

/**
 * Keeps the preparation in CFOClose: reads the saved context (recorded classes, notes, prior answers), saves drafts,
 * and records the reviewed preparation — every class, the answers and the reviewed notes — in ONE server transaction.
 * Never treats an unavailable backend or a lost response as a save; an unknown outcome keeps its request identity.
 */
export function EquipmentServerBridge(p: {
  db: ReportingDb;
  companyId: string;
  periodYear: number;
  payload: Record<string, unknown>;
  /** Every class reconciles, the bridge agrees and the statements are the reviewed ones. */
  canCommit: boolean;
  /** canCommit and every applicable question resolved: the reviewed notes may be saved with it. */
  canCommitNotes: boolean;
  proposals: Record<NoteRequirement, string | null>;
  sourceDocumentId: string | null;
  onContext: (c: EquipmentContextV2) => void;
  onRestore: (data: unknown, sourceDocumentId: string | null) => void;
  onLoadClasses: (rows: NonNullable<EquipmentContextV2["schedule"]>["rows"]) => void;
  refresh: () => Promise<void>;
  /** A stable request identity per attempt (tests supply a deterministic one). */
  newRequestId?: () => string;
}) {
  const api = useMemo(() => workpaperClient(p.db), [p.db]);
  const [context, setContext] = useState<EquipmentContextV2 | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [writing, setBusy] = useBusyState();
  const [loading, setLoading] = useState(false);
  const busy = writing || loading;
  useActivity(loading, "Reading equipment preparation…");
  const readGeneration = useRef(0);
  const readingLock = useRef(false), writingLock = useRef(false);
  const callbacks = useRef(p); callbacks.current = p;
  const [unknownCommit, setUnknownCommit] = useState(false);
  const pendingRetry = useRef<null | (() => Promise<void>)>(null);
  const live = useRef(true);
  const draftAttempt = useAttempt(p.newRequestId), commitAttempt = useAttempt(p.newRequestId);
  // Proposals are bound to the inputs and the note revisions they were prepared from.
  const inputsKey = canonicalStringify([p.payload, p.sourceDocumentId]);
  const [prepared, setPrepared] = useState<{ inputsKey: string; workpaperId: string | null; scheduleId: string | null; bodies: Record<NoteRequirement, string>; baseIds: Record<NoteRequirement, string | null> } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const proposalCurrent = !!prepared && prepared.inputsKey === inputsKey && !!context && prepared.workpaperId === (context.workpaper?.id ?? null) && prepared.scheduleId === (context.schedule?.id ?? null)
    && NOTE_REQUIREMENTS.every((r) => prepared.baseIds[r] === (context.notes[r]?.id ?? null));
  const currentSaved = !!context?.workpaper && context.workpaper.sourceDocumentId === p.sourceDocumentId && canonicalStringify(context.workpaper.payload) === canonicalStringify(p.payload);

  const readBlocked = useRef(false); readBlocked.current = writing || unknownCommit;
  const load = useCallback(async () => {
    if (readBlocked.current || writingLock.current) return;
    const generation = ++readGeneration.current;
    readingLock.current = true; setLoading(true);
    try {
      const c = await api.context(p.companyId, p.periodYear);
      if (!live.current || readGeneration.current !== generation) return;
      setContext(c); setReviewed(false); callbacks.current.onContext(c);
      setNotice(`${c.schedule ? `The recorded schedule has ${c.schedule.rows.length} class${c.schedule.rows.length === 1 ? "" : "es"}: ${c.schedule.rows.map((r) => r.classLabel).join(", ")}.` : "No equipment schedule is recorded yet."} ${c.workpaper ? (c.workpaper.contract === "cfoclose-equipment-workpaper/2" ? "A saved preparation is available; restore it explicitly to replace this browser draft." : "A saved single-class workpaper exists; it cannot be restored into this multi-class preparation.") : "No saved preparation yet."} ${c.priorAnswers.length ? `${c.priorAnswers.length} answers from the prior period can be reused after review.` : ""}`.trim());
    } catch {
      if (live.current && readGeneration.current === generation) setNotice("Server preparation storage could not be read. The backend may not be installed, or access may have changed. Your browser draft is kept; download it before leaving.");
    } finally { if (readGeneration.current === generation) { readingLock.current = false; if (live.current) setLoading(false); } }
  }, [api, p.companyId, p.periodYear]);
  const invalidateReads = useCallback(() => { readGeneration.current++; }, []);
  useEffect(() => { void load(); return invalidateReads; }, [load, invalidateReads]);
  const saveDraft = async () => {
    if (!context || readingLock.current || !setBusy(true)) return;
    writingLock.current = true;
    try {
      const r = await api.saveDraft(p.companyId, p.periodYear, p.payload, context.workpaper?.id ?? null, p.sourceDocumentId, draftAttempt.idFor(JSON.stringify([p.payload, context.workpaper?.id ?? null, p.sourceDocumentId])));
      if (!live.current) return;
      if (r.outcome === "recorded" && r.workpaperId) {
        draftAttempt.done();
        setContext({ ...context, workpaper: { id: r.workpaperId, payload: p.payload, sourceDocumentId: p.sourceDocumentId, createdAt: r.createdAt ?? "", contract: "cfoclose-equipment-workpaper/2" } });
        setNotice(`Draft saved (${r.workpaperId}). ${r.sourceRetained ? "The server linked the retained original document." : "The original PDF is NOT retained by this save."} A draft records no schedule, answer or note.`);
      } else setNotice(r.outcome === "recorded" ? "Could not confirm the draft save: incomplete receipt. Retry unchanged." : commitProblemWords({ outcome: r.outcome, currentId: r.currentId ?? undefined }));
    } catch { if (live.current) setNotice("Could not confirm the draft save. Retry the same unchanged draft with its original request identity."); }
    finally { writingLock.current = false; if (live.current) setBusy(false); }
  };
  const commit = async (withNotes: boolean) => {
    if (!context || readingLock.current || !p.canCommit || (withNotes && (!p.canCommitNotes || !reviewed || !proposalCurrent)) || !setBusy(true)) return;
    writingLock.current = true;
    const notes: NoteInsertion[] = withNotes && prepared ? NOTE_REQUIREMENTS.filter((r) => prepared.bodies[r].trim()).map((r) => ({ requirementId: r, expectedTextId: prepared.baseIds[r], body: prepared.bodies[r] })) : [];
    const expectedWorkpaper = withNotes && prepared ? prepared.workpaperId : context.workpaper?.id ?? null;
    const expectedSchedule = withNotes && prepared ? prepared.scheduleId : context.schedule?.id ?? null;
    const key = JSON.stringify([p.payload, p.sourceDocumentId, expectedWorkpaper, expectedSchedule, notes]);
    pendingRetry.current = () => commit(withNotes);
    try {
      const r = await api.commit(p.companyId, p.periodYear, p.payload, expectedWorkpaper, p.sourceDocumentId, expectedSchedule, notes, commitAttempt.idFor(key));
      if (!live.current) return;
      const scheduleOk = r.schedule?.outcome === "unchanged" || !!r.schedule?.submissionId;
      const notesOk = (r.notes ?? []).length === notes.length && (r.notes ?? []).every((n) => n.outcome === "unchanged" || !!n.textId);
      if (r.outcome === "recorded" && r.workpaperId && scheduleOk && notesOk) {
        commitAttempt.done(); setUnknownCommit(false); pendingRetry.current = null;
        setNotice(r.replay ? "The earlier save was confirmed by its server receipt. Read the current preparation before making further changes." : `Recorded: workpaper ${r.workpaperId}, ${notes.length ? `every class, ${r.answersRecorded ?? 0} answers and ${notes.length} reviewed note${notes.length === 1 ? "" : "s"}` : "every class and the answers"} in one transaction. The server's reconciliation decides readiness; this is not an approval.`);
        setContext(null); setPrepared(null); setReviewed(false);
        try { await p.refresh(); } catch { if (live.current) setNotice("Recorded; the readiness display could not refresh. Reload to read the server status."); }
      } else {
        setUnknownCommit(r.outcome === "recorded");
        setNotice(r.outcome === "recorded" ? "Could not confirm the save: incomplete receipt. Retry unchanged." : `${commitProblemWords(r)} Your edits are kept.`);
      }
    } catch { if (live.current) { setUnknownCommit(true); setNotice("Could not confirm the save. Retry the unchanged preparation to retrieve its server receipt; nothing is lost."); } }
    finally { writingLock.current = false; if (live.current) setBusy(false); }
  };
  const prepareNotes = () => {
    if (!context) return;
    const bodies = Object.fromEntries(NOTE_REQUIREMENTS.map((r) => [r, p.proposals[r] ? noteProposal(context.notes[r]?.body ?? null, NOTE_WORDS[r].heading, p.proposals[r]!) : ""])) as Record<NoteRequirement, string>;
    const baseIds = Object.fromEntries(NOTE_REQUIREMENTS.map((r) => [r, context.notes[r]?.id ?? null])) as Record<NoteRequirement, string | null>;
    setPrepared({ inputsKey, workpaperId: context.workpaper?.id ?? null, scheduleId: context.schedule?.id ?? null, bodies, baseIds });
    setReviewed(false);
  };
  return (
    <section className="space-y-3 rounded-md border border-border p-3" aria-label="Saved equipment preparation and reviewed notes">
      <h4 className="font-medium">Keep the preparation in CFOClose</h4>
      <p className="text-sm">Read what is recorded, save a draft, or record every class, the answers and the reviewed notes together in one server transaction. Nothing here approves the report.</p>
      {loading ? <p role="status">Reading the recorded equipment preparation…</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || unknownCommit} className={button} onClick={() => void load()}>Read the recorded preparation</button>
        {context?.schedule ? <button type="button" disabled={busy || unknownCommit} className={button} onClick={() => p.onLoadClasses(context.schedule!.rows)}>Load the recorded classes into this preparation</button> : null}
        {context?.workpaper?.contract === "cfoclose-equipment-workpaper/2" ? <button type="button" disabled={busy || unknownCommit} className={button} onClick={() => p.onRestore(context.workpaper!.payload, context.workpaper!.sourceDocumentId)}>Restore the saved preparation</button> : null}
        {context ? <button type="button" disabled={busy || unknownCommit} className={button} onClick={() => void saveDraft()}>Save a draft</button> : null}
        {context ? <button type="button" disabled={busy || unknownCommit || !p.canCommit} className={button} data-testid="commit-classes" onClick={() => void commit(false)}>Record every class and the answers</button> : null}
      </div>
      {context ? <p className="text-sm">{currentSaved ? "This draft matches the saved preparation." : "Browser changes are not saved yet."}{!p.canCommit ? " Recording needs every class reconciled, the opening bridge agreed and the reviewed statements current." : ""}</p> : null}
      {context ? (
        <div className="space-y-2">
          <button type="button" disabled={busy || unknownCommit || !p.canCommitNotes} className={button} data-testid="prepare-notes" onClick={prepareNotes}>Prepare the three note proposals for review</button>
          {!p.canCommitNotes ? <p className="text-sm">Note proposals need every applicable question answered.</p> : null}
          {prepared && !proposalCurrent ? <p role="alert" className="text-sm">The preparation or a recorded note changed since these proposals were prepared. Prepare them again from the current figures; your wording is kept here until then.</p> : null}
          {prepared ? NOTE_REQUIREMENTS.map((r) => (
            <label key={r} className="block text-sm">{NOTE_WORDS[r].label} — the WHOLE note as it will be recorded (existing wording kept; review all of it)
              <textarea rows={8} maxLength={20000} className="mt-1 block w-full rounded-md border border-input bg-background p-2 text-sm" aria-label={`Proposed ${NOTE_WORDS[r].label}`} value={prepared.bodies[r]} disabled={busy || unknownCommit}
                onChange={(ev) => { setPrepared({ ...prepared, bodies: { ...prepared.bodies, [r]: ev.target.value } }); setReviewed(false); }} />
            </label>
          )) : null}
          {prepared ? (
            <>
              <label className="flex gap-2 text-sm">
                <input type="checkbox" data-testid="notes-reviewed" checked={reviewed} disabled={busy || unknownCommit || !proposalCurrent} onChange={(ev) => setReviewed(ev.target.checked)} />
                <span>I reviewed each whole note, its evidence and the other applicable policies; record this wording for review.</span>
              </label>
              <button type="button" disabled={busy || unknownCommit || !reviewed || !proposalCurrent || !p.canCommitNotes} className={button} data-testid="commit-all" onClick={() => void commit(true)}>Record every class, the answers and the reviewed notes together</button>
            </>
          ) : null}
        </div>
      ) : null}
      {unknownCommit ? <button type="button" disabled={busy} className={button} onClick={() => void pendingRetry.current?.()}>Retry the original unconfirmed save</button> : null}
      <Notice text={notice} />
    </section>
  );
}
