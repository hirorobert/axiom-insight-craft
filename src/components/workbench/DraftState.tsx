/**
 * Draft save state. A saved draft is never presented as submitted or approved.
 */
export type DraftSaveState = "idle" | "saving" | "saved" | "failed";

export function draftStateText(state: DraftSaveState, savedAt: string | null): string {
  switch (state) {
    case "idle": return "";
    case "saving": return "Saving draft…";
    case "saved": return savedAt ? `Draft saved ${savedAt} · not submitted` : "Draft saved · not submitted";
    case "failed": return "Draft not saved — retry";
  }
}

export function DraftState({ state, savedAt, onRetry }: { state: DraftSaveState; savedAt: string | null; onRetry?: () => void }) {
  const text = draftStateText(state, savedAt);
  return (
    <span role="status" aria-live="polite" className={state === "failed" ? "text-sm text-red-700" : "text-sm text-muted-foreground"}>
      {text}
      {state === "failed" && onRetry ? (
        <> <button type="button" className="underline" onClick={onRetry}>Retry</button></>
      ) : null}
    </span>
  );
}
