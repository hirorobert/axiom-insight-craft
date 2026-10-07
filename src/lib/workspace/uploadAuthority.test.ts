/**
 * F2 — the database's authority answer for one upload (tb_upload_authority / tb_upload_attempts, S2) turned into one
 * notice and at most one action; an unreadable answer is never current; the history reads plainly.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  attemptLabel, authorityNotice, parseAttemptHistory, parseUploadAuthority, type UploadAuthority,
} from "./uploadAuthority";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } } }));
const { ProcessingAuthorityNoticeView, loadUploadAuthority } = await import("@/components/workspace/ProcessingAuthorityNoticeView");

const raw = (over: Record<string, unknown> = {}) => ({
  upload_id: "u1", authoritative: false, reason: "dependency_changed", certification_id: "c1", current_engine_run_id: "r1",
  current_attempt_status: "completed", current_attempt_code: null, current_attempt_lease_expired: false, processing_attempt: 2, ...over,
});
const auth = (over: Record<string, unknown> = {}) => parseUploadAuthority(raw(over)) as UploadAuthority;
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("parseUploadAuthority", () => {
  it("reads the database's answer", () => {
    expect(auth()).toMatchObject({ uploadId: "u1", reason: "dependency_changed", authoritative: false, processingAttempt: 2, attemptStatus: "completed" });
  });
  it("refuses anything inconsistent or unknown (never read as current)", () => {
    for (const bad of [null, [], {}, raw({ reason: "something_new" }), raw({ reason: "current", authoritative: false }),
      raw({ reason: "dependency_changed", authoritative: true }), raw({ processing_attempt: -1 }), raw({ current_attempt_status: "paused" }), raw({ upload_id: "" })]) {
      expect(parseUploadAuthority(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("authorityNotice", () => {
  it("a current result, and states the verdict already explains, add nothing", () => {
    for (const reason of ["not_certified", "blocked", "needs_review", "upload_not_active"]) expect(authorityNotice(auth({ reason }))).toBeNull();
    expect(authorityNotice(auth({ reason: "current", authoritative: true }))).toBeNull();
    expect(authorityNotice(auth({ reason: "attempt_failed", current_attempt_status: "failed", current_attempt_code: "INGESTION_REFUSED" }))).toBeNull();
    expect(authorityNotice(auth({ reason: "attempt_abandoned", current_attempt_status: "abandoned", current_attempt_code: "UPLOAD_RETIRED" }))).toBeNull();
  });
  it("Needs re-check — a changed input, a legacy result, a changed file, a later check — offers Check again", () => {
    for (const reason of ["dependency_changed", "legacy_certification", "source_changed", "superseded_attempt"]) {
      expect(authorityNotice(auth({ reason })), reason).toMatchObject({ label: "Needs re-check", tone: "warning", action: "check_again" });
    }
  });
  it("Processing stopped — a failed or closed check — offers Check again; an input changed mid-run is a re-check", () => {
    expect(authorityNotice(auth({ reason: "attempt_failed", current_attempt_status: "failed", current_attempt_code: "INVARIANT_VIOLATION" })))
      .toMatchObject({ label: "Processing stopped", tone: "error", action: "check_again" });
    expect(authorityNotice(auth({ reason: "attempt_failed", current_attempt_status: "failed", current_attempt_code: "DEPENDENCY_CHANGED" })))
      .toMatchObject({ label: "Needs re-check", tone: "warning", action: "check_again" });
    for (const code of ["LEASE_EXPIRED", "DRAINED_AT_CUTOVER"]) {
      expect(authorityNotice(auth({ reason: "attempt_abandoned", current_attempt_status: "abandoned", current_attempt_code: code })), code)
        .toMatchObject({ label: "Processing stopped", action: "check_again" });
    }
  });
  it("a running check: Checking (no action); one whose lease expired: Retry now", () => {
    expect(authorityNotice(auth({ reason: "attempt_running", current_attempt_status: "running" }))).toMatchObject({ label: "Checking", action: null });
    expect(authorityNotice(auth({ reason: "attempt_running", current_attempt_status: "running", current_attempt_lease_expired: true })))
      .toMatchObject({ label: "Processing stopped", action: "retry_now" });
  });
  it("a requested check that may not have started (invalidated, or the running one preempted): Retry now", () => {
    expect(authorityNotice(auth({ reason: "invalidated" }))).toMatchObject({ label: "New check requested", action: "retry_now" });
    expect(authorityNotice(auth({ reason: "attempt_abandoned", current_attempt_status: "abandoned", current_attempt_code: "PREEMPTED" })))
      .toMatchObject({ label: "New check requested", action: "retry_now" });
  });
  it("an unreadable answer is unknown, never current, and offers nothing", () => {
    expect(authorityNotice(null)).toMatchObject({ label: "Status unknown", action: null });
  });
});

describe("history", () => {
  it("reads attempts newest first and labels each plainly", () => {
    const h = parseAttemptHistory([
      { attempt_no: 3, status: "completed", code: null, started_at: "2026-10-07T10:00:00Z", completed_at: "2026-10-07T10:00:05Z" },
      { attempt_no: 2, status: "abandoned", code: "PREEMPTED", started_at: "2026-10-07T09:00:00Z", completed_at: "2026-10-07T09:01:00Z" },
      { attempt_no: 1, status: "failed", code: "DEPENDENCY_CHANGED", started_at: "2026-10-07T08:00:00Z", completed_at: "2026-10-07T08:00:03Z" },
    ])!;
    expect(h.map(attemptLabel)).toEqual(["Check 3 — completed", "Check 2 — replaced by a newer check", "Check 1 — stopped: an input changed while it ran"]);
  });
  it("an unreadable history is null (not an empty one)", () => {
    expect(parseAttemptHistory({})).toBeNull();
    expect(parseAttemptHistory([{ attempt_no: 1, status: "weird", started_at: "x" }])).toBeNull();
  });
});

describe("ProcessingAuthorityNoticeView and its reads", () => {
  const view = (state: object, canAct = true) => text(renderToStaticMarkup(createElement(ProcessingAuthorityNoticeView, { state, busy: false, canAct, onAction: () => {} } as never)));
  it("shows the notice with its one action; hides the action without authority to act", () => {
    const state = { loaded: true, authority: auth(), attempts: [] };
    expect(view(state)).toContain("Needs re-check.");
    expect(view(state)).toContain("Check again");
    expect(view(state, false)).not.toContain("Check again");
  });
  it("shows nothing for a current result with no history", () => {
    expect(view({ loaded: true, authority: auth({ reason: "current", authoritative: true }), attempts: [] })).toBe("");
  });
  it("reads both RPCs; an error on either is unknown (never current)", async () => {
    const rpc = vi.fn(async (fn: string) => fn === "tb_upload_authority" ? { data: null, error: { message: "x" } } : { data: [], error: null });
    const s = await loadUploadAuthority(rpc, "u1");
    expect(rpc).toHaveBeenCalledWith("tb_upload_authority", { p_upload_id: "u1" });
    expect(rpc).toHaveBeenCalledWith("tb_upload_attempts", { p_upload_id: "u1" });
    expect(s).toEqual({ loaded: true, authority: null, attempts: [] });
    expect(authorityNotice(s.authority)?.label).toBe("Status unknown");
  });
});

describe("Prepare Data wiring", () => {
  const prep = readFileSync(resolve(__dirname, "../../pages/workspace/PrepareWorkspace.tsx"), "utf8");
  it("the notice's action is the page's reprocess handler (tbu_request_reprocess), offered only to someone the server accepts", () => {
    const at = prep.indexOf("<ProcessingAuthorityNotice");
    expect(at).toBeGreaterThan(-1);
    const block = prep.slice(at, at + 900);
    expect(block).toMatch(/onAction=\{\(\) => void handleRetry\(\)\}/);
    expect(block).toMatch(/canAct=\{mayRequestReprocess\(upload, capabilityState, commercialState\) && verdict\.primaryAction\?\.kind !== "retry"\}/);
    const retry = prep.slice(prep.indexOf("const handleRetry"), prep.indexOf("const onPrimary"));
    expect(retry).toMatch(/requestReprocess\(supabase as unknown as ReprocessClient, upload\.id/);
  });
});
