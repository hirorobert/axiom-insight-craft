import { canonicalStringify } from "@/lib/canonicalStatement/serialization";
import { useMemo, useRef, useEffect, useState } from "react";
import { useBusyState } from "@/hooks/useBusyState";
import {
  workpaperClient,
  policyProposal,
  type EquipmentContext,
} from "@/lib/preparation/workpaperClient";
import type { ReportingDb } from "@/lib/reporting/signoff";
import { Notice, useAttempt, outcomeText } from "./shared";

/** Optional until the candidate migration is reviewed/installed. Never treats an unavailable backend as a save. */
export function EquipmentServerBridge(p: {
  db: ReportingDb;
  companyId: string;
  periodYear: number;
  payload: Record<string, unknown>;
  policy: string | null;
  canCommit: boolean;
  equipmentNote: string | null;
  onRestore: (data: unknown, sourceDocumentId: string | null) => void;
  refresh: () => Promise<void>;
  sourceDocumentId: string | null;
}) {
  const api = useMemo(() => workpaperClient(p.db), [p.db]);
  const [target, setTarget] = useState<"policy" | "equipmentNote">("policy");
  const [proposalScheduleId, setProposalScheduleId] = useState<string | null>(
    null,
  );
  const [proposalWorkpaperId, setProposalWorkpaperId] = useState<string | null>(
    null,
  );
  const [proposalInputs, setProposalInputs] = useState<string | null>(null);
  const inputsKey = canonicalStringify([p.payload, p.sourceDocumentId]);
  const [proposalBaseId, setProposalBaseId] = useState<string | null>(null);
  const targetDraft = target === "policy" ? p.policy : p.equipmentNote;
  const [context, setContext] = useState<EquipmentContext | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [body, setBody] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [proposalFor, setProposalFor] = useState<string | null>(null);
  const [unknownCommit, setUnknownCommit] = useState(false);
  const pendingRetry = useRef<null | (() => Promise<void>)>(null);
  const [busy, setBusy] = useBusyState();
  const live = useRef(true);
  const saveAttempt = useAttempt(),
    policyAttempt = useAttempt();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const currentSaved =
    !!context?.workpaper &&
    context.workpaper.sourceDocumentId === p.sourceDocumentId &&
    canonicalStringify(context.workpaper.payload) ===
      canonicalStringify(p.payload);
  const targetRecord = context?.[target] ?? null;
  const proposalCurrent =
    proposalFor === targetDraft &&
    proposalInputs === inputsKey &&
    proposalBaseId === (targetRecord?.id ?? null);
  const load = async () => {
    if (!setBusy(true)) return;
    try {
      const c = await api.context(p.companyId, p.periodYear);
      if (live.current) {
        setContext(c);
        setReviewed(false);

        setNotice(
          c.workpaper
            ? "Saved preparation is available. Restore it explicitly to replace this browser draft."
            : "No saved equipment workpaper yet.",
        );
      }
    } catch {
      if (live.current)
        setNotice(
          "Server preparation storage could not be read. The candidate backend may not be installed, or access may have changed. Your browser draft is kept; download it before leaving.",
        );
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const save = async () => {
    if (!context || !setBusy(true)) return;
    const key = JSON.stringify([
      p.payload,
      context.workpaper?.id ?? null,
      p.sourceDocumentId,
    ]);
    try {
      const r = await api.save(
        p.companyId,
        p.periodYear,
        p.payload,
        context.workpaper?.id ?? null,
        p.sourceDocumentId,
        saveAttempt.idFor(key),
      );
      if (!live.current) return;
      if (r.outcome === "recorded" && r.workpaperId) {
        saveAttempt.done();
        setContext({
          ...context,
          workpaper: {
            id: r.workpaperId,
            payload: p.payload,
            sourceDocumentId: p.sourceDocumentId,
            createdAt: r.createdAt ?? "",
          },
        });
        setNotice(
          `Workpaper saved (${r.workpaperId}). ${r.sourceRetained ? "The server linked its retained original document." : "The original PDF is NOT retained by this save; retain/upload it separately."} This does not save a schedule or approve the report.`,
        );
      } else
        setNotice(
          r.outcome === "recorded"
            ? "Could not confirm the workpaper save: incomplete receipt. Retry unchanged."
            : r.outcome === "stale"
              ? "A newer workpaper exists. Read it before deciding how to reconcile your draft. Your edits are kept."
              : r.outcome === "source_required"
                ? "Retain the original PDF through checked intake and save the linked workpaper before inserting this note."
                : r.outcome === "source_stale"
                  ? "The linked original is superseded or unavailable for review. Resolve the source record before inserting wording."
                  : outcomeText({ ...r, outcome: r.outcome }),
        );
    } catch {
      if (live.current)
        setNotice(
          "Could not confirm the workpaper save. Retry the same unchanged workpaper with its original request identity.",
        );
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const record = async () => {
    if (
      !context ||
      !p.canCommit ||
      !reviewed ||
      !proposalCurrent ||
      !setBusy(true)
    )
      return;
    const key = JSON.stringify([
      p.payload,
      p.sourceDocumentId,
      proposalWorkpaperId,
      proposalBaseId,
      body,
      target,
    ]);
    pendingRetry.current = record;
    try {
      const r = await api.commit(
        p.companyId,
        p.periodYear,
        p.payload,
        proposalWorkpaperId,
        p.sourceDocumentId,
        proposalBaseId,
        body,
        target === "policy"
          ? "smes.note.policies"
          : "smes.note.subclassifications",
        policyAttempt.idFor(key),
        proposalScheduleId,
      );
      if (!live.current) return;
      if (
        r.outcome === "recorded" &&
        r.workpaperId &&
        (r.note?.outcome === "unchanged" || r.note?.textId) &&
        (r.schedule?.outcome === "unchanged" || r.schedule?.submissionId)
      ) {
        policyAttempt.done();
        setUnknownCommit(false);
        pendingRetry.current = null;
        setContext({
          ...context,
          scheduleId: r.schedule?.submissionId ?? context.scheduleId ?? null,
          workpaper: {
            id: r.workpaperId,
            payload: p.payload,
            sourceDocumentId: p.sourceDocumentId,
            createdAt: r.createdAt ?? "",
          },
          [target]: {
            id: r.note?.textId ?? targetRecord!.id,
            body,
            sourceRef: `Reviewed equipment workpaper ${r.workpaperId}`,
          },
        });
        setReviewed(false);
        setProposalFor(null);
        if (r.replay) setContext(null);
        setNotice(
          r.replay
            ? "Previous save confirmed by its server receipt. Read the current preparation before making further changes."
            : "Workpaper, schedule and reviewed note saved together. This is not a FINAL approval or a conclusion that all disclosures are complete.",
        );
        try {
          await p.refresh();
        } catch {
          if (live.current)
            setNotice(
              "Policy wording recorded; the readiness display could not refresh. Reload to read the server status.",
            );
        }
      } else {
        setUnknownCommit(r.outcome === "recorded");
        setNotice(
          r.outcome === "stale"
            ? "Another person changed the policy note. Your proposal is kept. Read the latest note and reconcile it before retrying."
            : r.outcome === "stale_schedule"
              ? "The equipment schedule changed. Read the current preparation and reconcile the newer schedule before replacing it."
              : r.outcome === "multi_class_schedule"
                ? "The PPE schedule contains multiple asset classes. Nothing was saved. Use the full schedule editor to preserve all classes."
              : r.outcome === "stale_inputs"
                ? "The reporting inputs changed. Refresh the statements and save a reviewed current workpaper before inserting wording."
                : r.outcome === "recorded"
                  ? "Could not confirm policy insertion: incomplete receipt. Retry unchanged."
                  : r.outcome === "source_required"
                    ? "Retain the original PDF through checked intake and save the linked workpaper before inserting this note."
                    : r.outcome === "source_stale"
                      ? "The linked original is superseded or unavailable for review. Resolve the source record before inserting wording."
                      : outcomeText({ ...r, outcome: r.outcome }),
        );
      }
    } catch {
      if (live.current) setUnknownCommit(true);
      if (live.current)
        setNotice(
          "Could not confirm policy insertion. Retry the unchanged proposal to retrieve its server receipt.",
        );
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return (
    <section
      className="space-y-3 rounded-md border border-border p-3"
      aria-label="Saved equipment workpaper and policy insertion"
    >
      <h4 className="font-medium">Keep preparation in CFOClose</h4>
      <p className="text-sm">
        Save an unfinished workpaper as a draft, or save the workpaper,
        validated schedule and selected reviewed note together in one database
        transaction. Neither approves the report. Backend installation is
        required.
      </p>
      <button
        type="button"
        disabled={busy || unknownCommit}
        className="rounded-md border px-3 py-2 disabled:opacity-50"
        onClick={() => void load()}
      >
        Read saved preparation and current policy
      </button>
      {context ? (
        <>
          {context.workpaper ? (
            <button
              type="button"
              disabled={busy || unknownCommit}
              className="ml-2 rounded-md border px-3 py-2"
              onClick={() =>
                p.onRestore(
                  context.workpaper!.payload,
                  context.workpaper!.sourceDocumentId,
                )
              }
            >
              Restore saved browser draft
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy || unknownCommit}
            className="block rounded-md border px-3 py-2 disabled:opacity-50"
            onClick={() => void save()}
          >
            Save workpaper to CFOClose
          </button>
          <p className="text-sm">
            {currentSaved
              ? "This draft matches the saved workpaper."
              : "Browser changes are not saved in the workpaper yet."}
          </p>
          <label className="block">
            Note to prepare
            <select
              disabled={busy || unknownCommit || !!proposalFor}
              value={target}
              onChange={(e) =>
                setTarget(e.target.value as "policy" | "equipmentNote")
              }
              className="block rounded-md border p-2"
            >
              <option value="policy">Accounting policies</option>
              <option value="equipmentNote">
                Equipment within subclassifications and asset disclosures
              </option>
            </select>
          </label>
          <button
            type="button"
            disabled={busy || unknownCommit || !targetDraft || !p.canCommit}
            className="rounded-md border px-3 py-2 disabled:opacity-50"
            onClick={() => {
              setBody(policyProposal(targetRecord?.body ?? null, targetDraft!));
              setProposalFor(targetDraft);
              setProposalBaseId(targetRecord?.id ?? null);
              setProposalInputs(inputsKey);
              setProposalWorkpaperId(context.workpaper?.id ?? null);
              setProposalScheduleId(context.scheduleId ?? null);
              setReviewed(false);
            }}
          >
            Prepare note insertion for review
          </button>
          {proposalFor && !proposalCurrent ? (
            <div role="alert">
              <p>
                The note or preparation changed. Your proposal is kept.
                Reconcile it against the latest wording before recording.
              </p>
              <label className="block">
                Current saved note
                <textarea
                  readOnly
                  rows={5}
                  value={targetRecord?.body ?? ""}
                  className="block w-full rounded-md border p-2"
                />
              </label>
              <button
                type="button"
                disabled={busy || unknownCommit || proposalFor !== targetDraft}
                onClick={() => {
                  setProposalBaseId(targetRecord?.id ?? null);
                  setProposalWorkpaperId(context.workpaper?.id ?? null);
                  setProposalScheduleId(context.scheduleId ?? null);
                  setProposalInputs(inputsKey);
                  setReviewed(false);
                }}
              >
                I reconciled my proposal with this current note
              </button>
            </div>
          ) : null}
          {proposalFor ? (
            <div className="space-y-2">
              <p className="text-sm">
                Existing wording is preserved in this proposal. Review the
                ENTIRE note, remove duplicate or conflicting wording, and
                include other applicable policies or asset disclosures.
                Equipment wording alone is not a complete note.
              </p>
              <label className="block">
                Full proposed note
                <textarea
                  rows={10}
                  maxLength={20000}
                  className="mt-1 block w-full rounded-md border p-2"
                  value={body}
                  disabled={busy || unknownCommit}
                  onChange={(e) => {
                    setBody(e.target.value);
                    setReviewed(false);
                  }}
                />
              </label>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={busy || unknownCommit || !proposalCurrent}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                <span>
                  I reviewed the full note, its evidence and other applicable
                  policies; record this wording for review.
                </span>
              </label>
              <button
                type="button"
                disabled={
                  busy ||
                  unknownCommit ||
                  !reviewed ||
                  !body.trim() ||
                  !proposalCurrent
                }
                className="rounded-md border px-3 py-2 disabled:opacity-50"
                onClick={() => void record()}
              >
                Save workpaper, schedule and reviewed note together
              </button>
              <button
                type="button"
                disabled={busy || unknownCommit}
                onClick={() => {
                  setProposalFor(null);
                  setBody("");
                  setReviewed(false);
                }}
              >
                Discard this insertion proposal
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {unknownCommit ? (
        <button
          type="button"
          disabled={busy}
          className="rounded-md border px-3 py-2"
          onClick={() => void pendingRetry.current?.()}
        >
          Retry the original unconfirmed save
        </button>
      ) : null}
      <Notice text={notice} />
    </section>
  );
}
