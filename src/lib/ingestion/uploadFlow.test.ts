import { describe, expect, it } from "vitest";
import {
  INITIAL_FLOW, actionsFor, checkFinished, classifyCheckAnswer, classifySourceFailure, isBusy, reduceFlow, stepsFor,
  validateFileChoice, type FlowEvent, type FlowState,
} from "./uploadFlow";

const run = (...events: FlowEvent[]) => events.reduce(reduceFlow, INITIAL_FLOW);
const FILE = { name: "tb-2025.xlsx", size: 48_213 };
const selected = run({ type: "SELECT", file: FILE });
const started = reduceFlow(selected, { type: "START", clientRequestId: "req-1" });
const uploaded = reduceFlow(started, { type: "UPLOADED", reservationId: "res-1" });
const registered = reduceFlow(uploaded, { type: "REGISTERED", uploadId: "up-1" });
const checkFail = (retry: "same_request" | "new_request" | "none" | "wait") =>
  reduceFlow(registered, { type: "FAILED", failure: { step: "check", retry, fileSaved: true, message: "x" } });

const ALL_STATES: FlowState[] = [
  INITIAL_FLOW, selected, run({ type: "SELECT", file: { ...FILE, previouslyCheckedAt: "2026-09-01T00:00:00Z" } }), started, uploaded, registered,
  reduceFlow(registered, { type: "CHECKED" }), checkFail("same_request"), checkFail("new_request"), checkFail("none"),
  reduceFlow(started, { type: "FAILED", failure: classifySourceFailure("upload", { code: "upload_failed", retryable: true }) }),
  reduceFlow(uploaded, { type: "FAILED", failure: classifySourceFailure("register", { code: "forbidden" }) }),
  run({ type: "SELECT", file: { name: "notes.pdf", size: 10 } }),
];

describe("one visible primary action, buttons by state", () => {
  it("every state has at most one primary action, and none while a step runs", () => {
    for (const s of ALL_STATES) {
      const { primary, secondary } = actionsFor(s);
      expect(secondary.every((a) => a.id !== primary?.id)).toBe(true);
      if (isBusy(s)) expect(primary).toBeNull();
    }
  });

  it("the empty state's primary action is choosing the file; a chosen file is uploaded and checked", () => {
    expect(actionsFor(INITIAL_FLOW).primary).toEqual({ id: "choose", label: "Choose trial balance file" });
    expect(actionsFor(selected)).toEqual({
      primary: { id: "start", label: "Upload and check" },
      secondary: [{ id: "choose_other", label: "Choose a different file" }, { id: "remove", label: "Remove" }],
    });
    expect(actionsFor(ALL_STATES[2]).primary?.label).toBe("Upload again and check");
  });

  it("a failure offers the one safe retry, or a different file when nothing can be retried", () => {
    expect(actionsFor(checkFail("same_request")).primary).toEqual({ id: "retry", label: "Check again" });
    expect(actionsFor(checkFail("none")).primary).toBeNull(); // the file is saved; nothing to choose or retry here
    expect(actionsFor(ALL_STATES[10]).primary).toEqual({ id: "retry", label: "Try again" });
    expect(actionsFor(ALL_STATES[11]).primary).toEqual({ id: "choose_other", label: "Choose a different file" });
  });
});

describe("genuine progress", () => {
  it("a step is done only after its call returned, active while in flight, never a guessed percentage", () => {
    expect(stepsFor(selected)).toEqual([]);
    expect(stepsFor(started).map((s) => s.status)).toEqual(["active", "pending", "pending"]);
    expect(stepsFor(uploaded).map((s) => s.status)).toEqual(["done", "active", "pending"]);
    expect(stepsFor(registered).map((s) => s.status)).toEqual(["done", "done", "active"]);
    expect(stepsFor(reduceFlow(registered, { type: "CHECKED" })).map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(stepsFor(checkFail("same_request")).map((s) => s.status)).toEqual(["done", "done", "failed"]);
    expect(JSON.stringify(stepsFor(registered))).not.toMatch(/%|\d+ ?percent/);
  });

  it("events out of order are ignored (no step can be skipped)", () => {
    expect(reduceFlow(selected, { type: "REGISTERED", uploadId: "u" })).toBe(selected);
    expect(reduceFlow(started, { type: "CHECKED" })).toBe(started);
    expect(reduceFlow(INITIAL_FLOW, { type: "START", clientRequestId: "r" })).toBe(INITIAL_FLOW);
    // A new file cannot replace one that is being uploaded or checked.
    expect(reduceFlow(registered, { type: "SELECT", file: FILE })).toBe(registered);
    expect(reduceFlow(registered, { type: "CLEAR" })).toBe(registered);
  });
});

describe("idempotent retries keep the identities already obtained", () => {
  it("a failed check retries with the SAME request id (server replays or finishes it once)", () => {
    const retried = reduceFlow(checkFail("same_request"), { type: "RETRY", newClientRequestId: "req-2" });
    expect(retried).toMatchObject({ phase: "checking", clientRequestId: "req-1", uploadId: "up-1", reservationId: "res-1" });
  });

  it("only a spent identity (conflict / recorded failure) gets a new request id", () => {
    const retried = reduceFlow(checkFail("new_request"), { type: "RETRY", newClientRequestId: "req-2" });
    expect(retried).toMatchObject({ phase: "checking", clientRequestId: "req-2", uploadId: "up-1" });
  });

  it("a failed registration retries with the same reservation; a failed upload starts the transfer again", () => {
    const regFail = reduceFlow(uploaded, { type: "FAILED", failure: classifySourceFailure("register", { code: "object_missing", retryable: true }) });
    expect(reduceFlow(regFail, { type: "RETRY", newClientRequestId: "n" })).toMatchObject({ phase: "registering", reservationId: "res-1" });
    const upFail = ALL_STATES[10];
    expect(reduceFlow(upFail, { type: "RETRY", newClientRequestId: "n" })).toMatchObject({ phase: "uploading", reservationId: null, uploadId: null, clientRequestId: "req-1" });
  });

  it("nothing is retried when the refusal is final", () => {
    const s = checkFail("none");
    expect(reduceFlow(s, { type: "RETRY", newClientRequestId: "n" })).toBe(s);
  });
});

describe("actionable errors", () => {
  it("refuses a wrong or empty file before anything is sent, naming the file and the fix", () => {
    expect(validateFileChoice({ name: "tb.pdf", size: 10 })).toBe("“tb.pdf” is not a spreadsheet. Upload the trial balance as .xlsx, .xls or .csv.");
    expect(validateFileChoice({ name: "tb.csv", size: 0 })).toMatch(/is empty/);
    expect(validateFileChoice({ name: "TB.XLSX", size: 1 })).toBeNull();
    expect(ALL_STATES[12]).toMatchObject({ phase: "empty", choiceError: expect.stringMatching(/not a spreadsheet/) });
  });

  it("maps every check answer to a plain sentence and the one safe retry", () => {
    expect(classifyCheckAnswer({ httpStatus: 200, body: { status: "blocked" } })).toEqual({ kind: "finished" });
    expect(classifyCheckAnswer({ httpStatus: 200, body: { replay: true, status: "completed" } })).toEqual({ kind: "finished" });
    expect(classifyCheckAnswer({ httpStatus: 200, body: { replay: true, status: "failed" } })).toMatchObject({ kind: "failed", failure: { retry: "new_request" } });
    expect(classifyCheckAnswer({ httpStatus: null, body: null })).toMatchObject({ kind: "failed", failure: { retry: "same_request", fileSaved: true } });
    expect(classifyCheckAnswer({ httpStatus: 503, body: null })).toMatchObject({ failure: { retry: "same_request" } });
    expect(classifyCheckAnswer({ httpStatus: 409, body: { status: "in_progress" } })).toEqual({ kind: "wait" });
    expect(classifyCheckAnswer({ httpStatus: 409, body: { error: "Idempotency conflict" } })).toMatchObject({ failure: { retry: "new_request" } });
    expect(classifyCheckAnswer({ httpStatus: 403, body: {} })).toMatchObject({ failure: { retry: "none", message: expect.stringMatching(/Prepare access/) } });
    expect(classifyCheckAnswer({ httpStatus: 402, body: { message: "Your plan has ended." } })).toMatchObject({ failure: { retry: "none", message: "Your plan has ended." } });
    expect(classifyCheckAnswer({ httpStatus: 409, body: { message: "This trial balance is no longer active." } })).toMatchObject({ failure: { retry: "none", message: "This trial balance is no longer active." } });
  });

  it("maps transfer and registration failures", () => {
    expect(classifySourceFailure("upload", { code: "forbidden" })).toMatchObject({ retry: "none", message: expect.stringMatching(/permission/) });
    expect(classifySourceFailure("register", { code: "active_upload_exists" })).toMatchObject({ retry: "none", message: expect.stringMatching(/Replace/) });
    expect(classifySourceFailure("upload", { code: "upload_failed", retryable: true })).toMatchObject({ retry: "start_over", fileSaved: false });
  });

  it("a running status is not a finished check", () => {
    for (const s of ["pending", "processing", "queued", "validating", null, undefined]) expect(checkFinished(s)).toBe(false);
    for (const s of ["complete", "blocked", "needs_review", "error"]) expect(checkFinished(s)).toBe(true);
  });
});
