/**
 * uploadFlow — the trial-balance upload workflow as a pure state machine. The uploader renders exactly what this says.
 *
 *   empty → selected → uploading → registering → checking → done
 *                          └──────────┴─────────────┴──→ failed ──(retry)──→ the step that failed
 *
 * Progress is genuine: a step is "done" only when the call it stands for has returned, "active" while that call is in
 * flight, and nothing is shown as a percentage the browser cannot measure.
 *
 * Retries are idempotent by construction. Each step keeps the identity it was given:
 *   · upload    — nothing is registered yet, so a retry starts the upload again (the abandoned reservation is reclaimed
 *                 by the server's sweeper).
 *   · register  — retried with the SAME reservation (the server answers "already registered" if it got through).
 *   · check     — a transport failure or server error is retried with the SAME request id: the server replays a
 *                 finished run, reports one still running, or runs it once. Only a conflict or a recorded failure gets
 *                 a NEW request id, and only when the person asks.
 *
 * Every state has at most ONE primary action. A size limit is not checked here: the storage service enforces its own
 * and its refusal is reported as an upload failure.
 */

export type FlowPhase = "empty" | "selected" | "uploading" | "registering" | "checking" | "done" | "failed";
export type FlowStep = "upload" | "register" | "check";
export type RetryMode = "start_over" | "same_request" | "new_request" | "wait" | "none";

export interface SelectedFile {
  name: string;
  size: number;
  /** Set when a file with the same name already has an accepted check in this workspace. */
  previouslyCheckedAt?: string | null;
}

export interface FlowFailure {
  step: FlowStep;
  /** One plain sentence: what happened and what to do. */
  message: string;
  retry: RetryMode;
  /** True when the file is already saved in the workspace (only the check needs repeating). */
  fileSaved: boolean;
}

export interface FlowState {
  phase: FlowPhase;
  file: SelectedFile | null;
  /** A refusal of the chosen file before anything is sent (wrong type, empty, too large). */
  choiceError: string | null;
  reservationId: string | null;
  uploadId: string | null;
  clientRequestId: string | null;
  failure: FlowFailure | null;
}

export const INITIAL_FLOW: FlowState = {
  phase: "empty", file: null, choiceError: null, reservationId: null, uploadId: null, clientRequestId: null, failure: null,
};

export const ACCEPTED_EXTENSIONS = [".csv", ".xlsx", ".xls"] as const;

export function validateFileChoice(file: { name: string; size: number }): string | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return `“${file.name}” is not a spreadsheet. Upload the trial balance as .xlsx, .xls or .csv.`;
  }
  if (file.size === 0) return `“${file.name}” is empty. Export the trial balance again and upload the new file.`;
  return null;
}

export type FlowEvent =
  | { type: "SELECT"; file: SelectedFile }
  | { type: "CLEAR" }
  | { type: "START"; clientRequestId: string }
  | { type: "UPLOADED"; reservationId: string }
  | { type: "REGISTERED"; uploadId: string }
  | { type: "CHECKED" }
  | { type: "FAILED"; failure: FlowFailure }
  | { type: "RETRY"; newClientRequestId: string };

export function reduceFlow(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case "SELECT": {
      if (isBusy(state)) return state;
      const choiceError = validateFileChoice(event.file);
      return choiceError
        ? { ...INITIAL_FLOW, choiceError }
        : { ...INITIAL_FLOW, phase: "selected", file: event.file };
    }
    case "CLEAR":
      return isBusy(state) ? state : INITIAL_FLOW;
    case "START":
      if (state.phase !== "selected" || !state.file) return state;
      return { ...state, phase: "uploading", clientRequestId: event.clientRequestId, failure: null };
    case "UPLOADED":
      return state.phase === "uploading" ? { ...state, phase: "registering", reservationId: event.reservationId } : state;
    case "REGISTERED":
      return state.phase === "registering" ? { ...state, phase: "checking", uploadId: event.uploadId } : state;
    case "CHECKED":
      return state.phase === "checking" ? { ...state, phase: "done", failure: null } : state;
    case "FAILED":
      return isBusy(state) ? { ...state, phase: "failed", failure: event.failure } : state;
    case "RETRY": {
      if (state.phase !== "failed" || !state.failure) return state;
      const f = state.failure;
      if (f.retry === "none") return state;
      if (f.step === "upload" || f.retry === "start_over") {
        return { ...state, phase: "uploading", reservationId: null, uploadId: null, failure: null };
      }
      if (f.step === "register") return { ...state, phase: "registering", failure: null };
      // The check: the same request id unless the server said this identity is spent.
      return {
        ...state, phase: "checking", failure: null,
        clientRequestId: f.retry === "new_request" ? event.newClientRequestId : state.clientRequestId,
      };
    }
  }
}

export function isBusy(state: FlowState): boolean {
  return state.phase === "uploading" || state.phase === "registering" || state.phase === "checking";
}

export type StepStatus = "pending" | "active" | "done" | "failed";

export interface FlowStepView {
  id: FlowStep;
  label: string;
  status: StepStatus;
  detail?: string;
}

const STEP_LABEL: Record<FlowStep, string> = {
  upload: "Upload the file",
  register: "Save it to this period",
  check: "Check the trial balance",
};
const ORDER: FlowStep[] = ["upload", "register", "check"];
const ACTIVE_STEP: Partial<Record<FlowPhase, FlowStep>> = { uploading: "upload", registering: "register", checking: "check" };

export function stepsFor(state: FlowState): FlowStepView[] {
  if (state.phase === "empty" || state.phase === "selected") return [];
  const current = state.phase === "failed" ? state.failure?.step ?? null : ACTIVE_STEP[state.phase] ?? null;
  const currentIndex = state.phase === "done" ? ORDER.length : current ? ORDER.indexOf(current) : -1;
  return ORDER.map((id, i) => {
    const status: StepStatus = i < currentIndex ? "done" : i > currentIndex ? "pending" : state.phase === "failed" ? "failed" : "active";
    const detail = id === "check" && status === "active" ? "Reading every row, checking amounts and balance, classifying accounts. Usually under a minute." : undefined;
    return { id, label: STEP_LABEL[id], status, ...(detail ? { detail } : {}) };
  });
}

export type FlowActionId = "choose" | "start" | "retry" | "choose_other" | "remove";

export interface FlowAction {
  id: FlowActionId;
  label: string;
}

/** What the person can do now: at most one primary, then quiet secondary actions. Nothing while a step is running. */
export function actionsFor(state: FlowState): { primary: FlowAction | null; secondary: FlowAction[] } {
  switch (state.phase) {
    case "empty":
      return { primary: { id: "choose", label: "Choose trial balance file" }, secondary: [] };
    case "selected":
      return {
        primary: { id: "start", label: state.file?.previouslyCheckedAt ? "Upload again and check" : "Upload and check" },
        secondary: [{ id: "choose_other", label: "Choose a different file" }, { id: "remove", label: "Remove" }],
      };
    case "failed": {
      const f = state.failure;
      const canRetry = !!f && f.retry !== "none" && f.retry !== "wait";
      const retryLabel = f?.step === "check" ? "Check again" : "Try again";
      return canRetry
        ? { primary: { id: "retry", label: retryLabel }, secondary: f?.fileSaved ? [] : [{ id: "choose_other", label: "Choose a different file" }] }
        : { primary: f?.fileSaved ? null : { id: "choose_other", label: "Choose a different file" }, secondary: [] };
    }
    default:
      return { primary: null, secondary: [] };
  }
}

// ── Failure classification ───────────────────────────────────────────────────────────────────────────────────────────

/** A transfer/registration failure from lib/workspace/sourceUpload (SourceUploadError). */
export function classifySourceFailure(step: "upload" | "register", err: { code?: string; message?: string; retryable?: boolean }): FlowFailure {
  const code = err.code ?? "";
  if (code === "forbidden") {
    return { step, retry: "none", fileSaved: false, message: "You don't have permission to add files to this workspace. Ask the workspace owner for access to manage source files." };
  }
  if (code === "active_upload_exists") {
    return { step, retry: "none", fileSaved: false, message: "This period already has a trial balance. Use “Replace” on the current trial balance to swap it." };
  }
  if (step === "upload") {
    return { step, retry: "start_over", fileSaved: false, message: "The file could not be uploaded — the connection may have dropped. Try again; nothing was saved." };
  }
  if (code === "object_missing" || err.retryable) {
    return { step, retry: "same_request", fileSaved: false, message: "The upload finished but could not be saved to this period yet. Try again — the same upload is reused." };
  }
  return { step, retry: "start_over", fileSaved: false, message: err.message && err.message.length < 200 ? err.message : "The file could not be saved to this period. Try again." };
}

/** The check request's answer: HTTP status (null for a network/transport failure) and parsed body. */
export interface CheckAnswer {
  httpStatus: number | null;
  body: Record<string, unknown> | null;
}

export type CheckOutcome = { kind: "finished" } | { kind: "wait" } | { kind: "failed"; failure: FlowFailure };

export function classifyCheckAnswer(a: CheckAnswer): CheckOutcome {
  const body = a.body ?? {};
  const serverMessage = typeof body.message === "string" && body.message.length < 300 ? body.message : null;
  if (a.httpStatus === 200) {
    // A replay of a request whose run failed: this identity is spent; a fresh check needs a new one.
    if (body.replay === true && body.status === "failed") {
      return { kind: "failed", failure: { step: "check", retry: "new_request", fileSaved: true, message: "The earlier check of this file did not finish. Check it again." } };
    }
    return { kind: "finished" };
  }
  if (a.httpStatus === null || a.httpStatus >= 500) {
    return { kind: "failed", failure: { step: "check", retry: "same_request", fileSaved: true, message: "The file is saved, but the check could not be completed — the connection dropped or the service was busy. Check again; it will not be counted twice." } };
  }
  if (a.httpStatus === 403) {
    return { kind: "failed", failure: { step: "check", retry: "none", fileSaved: true, message: "The file is saved, but you don't have permission to check trial balances in this workspace. Ask the workspace owner for Prepare access." } };
  }
  if (a.httpStatus === 402) {
    return { kind: "failed", failure: { step: "check", retry: "none", fileSaved: true, message: serverMessage ?? "The file is saved, but checking trial balances is not included in the current plan." } };
  }
  if (a.httpStatus === 409 && body.status === "in_progress") return { kind: "wait" };
  if (a.httpStatus === 409 && body.error === "Idempotency conflict") {
    return { kind: "failed", failure: { step: "check", retry: "new_request", fileSaved: true, message: "The file changed since this check started. Check it again." } };
  }
  return { kind: "failed", failure: { step: "check", retry: "none", fileSaved: true, message: serverMessage ?? "The file is saved, but it cannot be checked in its current state." } };
}

// ── Polling while another check of the same upload runs ──────────────────────────────────────────────────────────────

const RUNNING_STATUSES = new Set(["pending", "processing", "queued", "validating"]);

/** True when the upload row shows a finished check (any recorded outcome). */
export function checkFinished(status: string | null | undefined): boolean {
  return !!status && !RUNNING_STATUSES.has(status);
}

/** Bounded back-off for waiting on a running check: 2s, 3s, 5s, 8s, then 10s — at most 12 polls (~1.6 minutes). */
export const POLL_DELAYS_MS: readonly number[] = [2000, 3000, 5000, 8000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000];
