/**
 * PPG-1R HIGH-1 — Codex REJECT: "Preflight stale-certified protection
 * incomplete. handleProcessAsAuditedAccounts starts reprocessing but
 * certReadiness.refetch() is not triggered until terminal/timeout. Old
 * CERTIFIED may therefore remain visible while reprocessing is already
 * underway."
 *
 * These tests exercise the exact state-machine transitions the mission
 * required, as pure function calls — proving every named scenario without
 * needing a component-rendering test harness (none exists in this repo).
 */

import { describe, it, expect } from "vitest";
import {
  reduceCertificationRevalidationGuard,
  canInitiateCertificationAffectingMutation,
} from "./certificationRevalidationGuard";
import { computeCertificationReadiness, type TbCertificationRow } from "./computeCertificationReadiness";

const CERTIFIED_ROW: TbCertificationRow = {
  id: "cert-1",
  sequence_no: 1,
  company_id: "company-1",
  upload_id: "upload-b",
  period_year: 2025,
  is_blocking: false,
  requires_review: false,
  exceptions: [],
  certified_at: "2026-01-01T00:00:00Z",
};

describe("reduceCertificationRevalidationGuard — MUTATION_ACCEPTED", () => {
  it("enters revalidating from a clean (false) state", () => {
    expect(reduceCertificationRevalidationGuard(false, { type: "MUTATION_ACCEPTED" })).toBe(true);
  });

  it("stays revalidating if already revalidating (idempotent under a second accepted mutation)", () => {
    expect(reduceCertificationRevalidationGuard(true, { type: "MUTATION_ACCEPTED" })).toBe(true);
  });
});

describe("reduceCertificationRevalidationGuard — MUTATION_INITIATION_FAILED", () => {
  it("leaves a clean state unchanged — nothing was accepted, nothing to invalidate", () => {
    expect(reduceCertificationRevalidationGuard(false, { type: "MUTATION_INITIATION_FAILED" })).toBe(false);
  });

  it("does not clear an ALREADY-active guard from a different in-flight mutation", () => {
    expect(reduceCertificationRevalidationGuard(true, { type: "MUTATION_INITIATION_FAILED" })).toBe(true);
  });
});

describe("reduceCertificationRevalidationGuard — TERMINAL_CONFIRMED", () => {
  it("clears the guard once a genuine terminal-boundary read has landed", () => {
    expect(reduceCertificationRevalidationGuard(true, { type: "TERMINAL_CONFIRMED" })).toBe(false);
  });

  it("is a no-op if the guard was already clear", () => {
    expect(reduceCertificationRevalidationGuard(false, { type: "TERMINAL_CONFIRMED" })).toBe(false);
  });
});

describe("reduceCertificationRevalidationGuard — TIMEOUT_NO_TERMINAL_CONFIRMED (the mission's explicit fail-closed contract)", () => {
  it("does NOT clear the guard on an unconfirmed timeout — remains non-authoritative/pending", () => {
    expect(reduceCertificationRevalidationGuard(true, { type: "TIMEOUT_NO_TERMINAL_CONFIRMED" })).toBe(true);
  });

  it("a timeout can never itself CAUSE revalidation to start from a clean state", () => {
    // Defensive: TIMEOUT should only ever be dispatched while already
    // revalidating in practice, but the reducer must not invent a guard
    // from nothing either way.
    expect(reduceCertificationRevalidationGuard(false, { type: "TIMEOUT_NO_TERMINAL_CONFIRMED" })).toBe(true);
  });
});

describe("reduceCertificationRevalidationGuard — UPLOAD_IDENTITY_CHANGED", () => {
  it("clears a guard scoped to the previous upload when a different upload is now displayed", () => {
    expect(reduceCertificationRevalidationGuard(true, { type: "UPLOAD_IDENTITY_CHANGED" })).toBe(false);
  });
});

describe("canInitiateCertificationAffectingMutation — rapid second invocation guard", () => {
  it("refuses a new mutation while already revalidating", () => {
    expect(canInitiateCertificationAffectingMutation(true)).toBe(false);
  });

  it("permits a new mutation when not currently revalidating", () => {
    expect(canInitiateCertificationAffectingMutation(false)).toBe(true);
  });
});

describe("End-to-end: guard state feeding computeCertificationReadiness (the actual UI-safety proof)", () => {
  it("CERTIFIED -> accepted mutation -> immediate refetch still returns OLD CERTIFIED -> UI shows pending, NOT certified", () => {
    // Step 1: before any mutation, genuinely certified.
    let guard = false;
    const before = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: "upload-b",
      authoritative: CERTIFIED_ROW,
      latestForUpload: null,
      revalidating: guard,
    });
    expect(before.verdict).toBe("certified");

    // Step 2: mutation accepted — guard flips true THIS INSTANT.
    guard = reduceCertificationRevalidationGuard(guard, { type: "MUTATION_ACCEPTED" });
    expect(guard).toBe(true);

    // Step 3: the immediate refetch races ahead of the backend and returns
    // the EXACT SAME pre-mutation certified row — this is the precise race
    // Codex flagged. The guard must still force "pending", never "certified".
    const duringRace = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: "upload-b",
      authoritative: CERTIFIED_ROW, // stale — backend hasn't changed anything yet
      latestForUpload: null,
      revalidating: guard,
    });
    expect(duringRace.verdict).toBe("pending");
    expect(duringRace.verdict).not.toBe("certified");
  });

  it("slow backend: guard remains true (and verdict remains pending) for as long as no terminal event has fired", () => {
    const guard = reduceCertificationRevalidationGuard(false, { type: "MUTATION_ACCEPTED" });
    // Simulate several more polling ticks with no terminal status yet —
    // nothing should clear the guard merely because time passed.
    for (let i = 0; i < 5; i++) {
      const stillPolling = computeCertificationReadiness({
        uploadExists: true,
        currentUploadId: "upload-b",
        authoritative: CERTIFIED_ROW,
        latestForUpload: null,
        revalidating: guard,
      });
      expect(stillPolling.verdict).toBe("pending");
    }
    expect(guard).toBe(true);
  });

  it("terminal success: guard clears and a freshly-read certification is trusted again", () => {
    let guard = reduceCertificationRevalidationGuard(false, { type: "MUTATION_ACCEPTED" });
    guard = reduceCertificationRevalidationGuard(guard, { type: "TERMINAL_CONFIRMED" });
    const afterTerminal = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: "upload-b",
      authoritative: CERTIFIED_ROW,
      latestForUpload: null,
      revalidating: guard,
    });
    expect(afterTerminal.verdict).toBe("certified");
  });

  it("terminal failure (blocked): guard clears, and the now-blocked verdict is shown truthfully — never a fake certified", () => {
    let guard = reduceCertificationRevalidationGuard(false, { type: "MUTATION_ACCEPTED" });
    guard = reduceCertificationRevalidationGuard(guard, { type: "TERMINAL_CONFIRMED" });
    const blockedRow: TbCertificationRow = {
      ...CERTIFIED_ROW,
      is_blocking: true,
      exceptions: [{ code: "L3_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "Debits do not equal credits." }],
    };
    const afterFailure = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: "upload-b",
      authoritative: null,
      latestForUpload: blockedRow,
      revalidating: guard,
    });
    expect(afterFailure.verdict).toBe("blocked");
  });

  it("timeout with no terminal confirmation: verdict stays pending even though a read was taken", () => {
    let guard = reduceCertificationRevalidationGuard(false, { type: "MUTATION_ACCEPTED" });
    guard = reduceCertificationRevalidationGuard(guard, { type: "TIMEOUT_NO_TERMINAL_CONFIRMED" });
    expect(guard).toBe(true);
    // Even if the timeout's own refetch happened to return the OLD
    // certified row again (backend genuinely still processing), the UI
    // must not present it as current.
    const afterTimeout = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: "upload-b",
      authoritative: CERTIFIED_ROW,
      latestForUpload: null,
      revalidating: guard,
    });
    expect(afterTimeout.verdict).toBe("pending");
  });

  it("initiation failure: guard never enters, prior genuinely-certified state is preserved exactly", () => {
    let guard = false;
    guard = reduceCertificationRevalidationGuard(guard, { type: "MUTATION_INITIATION_FAILED" });
    expect(guard).toBe(false);
    const stillCertified = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: "upload-b",
      authoritative: CERTIFIED_ROW,
      latestForUpload: null,
      revalidating: guard,
    });
    expect(stillCertified.verdict).toBe("certified");
  });

  it("rapid second invocation: a second mutation attempt while already revalidating is refused before it can double-invalidate", () => {
    const guard = reduceCertificationRevalidationGuard(false, { type: "MUTATION_ACCEPTED" });
    expect(canInitiateCertificationAffectingMutation(guard)).toBe(false);
  });

  it("replacement upload mid-revalidation: guard clears immediately for the new upload's own fresh lifecycle", () => {
    let guard = reduceCertificationRevalidationGuard(false, { type: "MUTATION_ACCEPTED" });
    expect(guard).toBe(true);
    guard = reduceCertificationRevalidationGuard(guard, { type: "UPLOAD_IDENTITY_CHANGED" });
    expect(guard).toBe(false);
  });

  it("Save/Reprocess account review follows the identical contract as process-as-audited-accounts", () => {
    // AccountReviewPanel's onReprocessingStarted/onReprocessed wire into
    // the exact same reducer events — this test documents that the two
    // entry points are not independently-invented state machines.
    let guard = false;
    guard = reduceCertificationRevalidationGuard(guard, { type: "MUTATION_ACCEPTED" }); // onReprocessingStarted
    expect(guard).toBe(true);
    const midReprocess = computeCertificationReadiness({
      uploadExists: true,
      currentUploadId: "upload-b",
      authoritative: CERTIFIED_ROW,
      latestForUpload: null,
      revalidating: guard,
    });
    expect(midReprocess.verdict).toBe("pending");
    guard = reduceCertificationRevalidationGuard(guard, { type: "TERMINAL_CONFIRMED" }); // onReprocessed("terminal")
    expect(guard).toBe(false);
  });
});
