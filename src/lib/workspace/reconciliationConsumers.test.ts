/**
 * Every frontend consumer of reconciliation "clean" / readiness, driven with a raw "clean" status over EMPTY, PARTIAL,
 * ESCALATED, PENDING, REJECTED and UNREADABLE evidence: none of them unlocks a readiness-dependent action. Only a
 * complete reconciliation does. A static guard pins the full list of raw "clean" comparisons so a new consumer cannot
 * appear without being added here.
 *
 * Consumers (traced):
 *   1. deriveWorkspaceState — Prepare "passed" and the later-stage unlocks (taxBlocked = !safishaClean). Fed the
 *      EFFECTIVE status (effectiveSafishaStatus, applied in fetchWorkspaceSnapshot.toUploadSnapshot).
 *   2. trialBalanceVerdict.evidenceCleared — hides evidence verification and offers "Continue to Reconcile".
 *   3. trialBalanceReadiness → trialBalanceReviewStep / deriveOrientationSummary (Overview, hub) [#45 adds trialBalanceTask, tested there].
 *   4. SafishaGate / ExceptionQueue — display the reconciliation's own result inside the gate; they unlock nothing
 *      (the page re-reads the snapshot, i.e. 1–3).
 * Server consumers are covered by the disposable-PostgreSQL proof and the release report (maono_check_safisha_gate).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveWorkspaceState } from "./deriveWorkspaceState";
import { deriveOrientationSummary, trialBalanceReviewStep } from "./deriveOrientationSummary";
import { deriveTrialBalanceVerdict } from "./trialBalanceVerdict";
import { effectiveSafishaStatus, trialBalanceReadiness, type EvidenceRead } from "./trialBalanceReadiness";
import type { UploadSnapshot } from "./types";

const none = { pending: 0, approved: 0, rejected: 0, escalated: 0, approvedTbLines: 0 };
const ev = (over: Record<string, unknown>, exceptions: Partial<typeof none> | null = {}): EvidenceRead => ({
  state: "read",
  evidence: { status: "clean", matched_count: 4, exception_count: 0, total_tb_lines: 4, ...over, exceptions: exceptions === null ? null : { ...none, ...exceptions } },
});

const COMPLETE = ev({});
const NOT_COMPLETE: Record<string, EvidenceRead | undefined> = {
  empty: ev({ matched_count: 0, total_tb_lines: 0 }),
  partial: ev({ matched_count: 1 }),
  escalated: ev({ matched_count: 3, exception_count: 1 }, { escalated: 1 }),
  pending: ev({ matched_count: 3, exception_count: 1 }, { pending: 1 }),
  rejected: ev({ matched_count: 3, exception_count: 1 }, { rejected: 1 }),
  exceptions_unreadable: ev({}, null),
  read_failed: { state: "failed" },
  never_read: undefined,
};
const READABLE_INCOMPLETE = ["empty", "partial", "escalated", "pending", "rejected"];

const snapshot = (safishaStatus: string | null): UploadSnapshot => ({
  id: "u1", companyId: "c1", companyName: "Co", periodYear: 2025, status: "complete", isValid: true, safishaStatus,
  uploadedAt: "2026-01-01T00:00:00Z", processedAt: "2026-01-01T00:00:00Z", hasMapping: false, hesabuPassedAt: null,
  kingaSignedAt: null, filingSubmittedAt: null, certificationVerdict: "certified", certificationBlocker: null,
});
const unlocked = (safishaStatus: string | null) => {
  const s = deriveWorkspaceState("c1", "Co", 2025, snapshot(safishaStatus));
  return { prepare: s.missions.prepare.status, statements: s.missions.statements.status, tax: s.missions.tax.status };
};

describe("a raw 'clean' over incomplete evidence unlocks nothing", () => {
  it("baseline: a COMPLETE reconciliation unlocks every consumer", () => {
    expect(effectiveSafishaStatus("clean", COMPLETE)).toBe("clean");
    expect(trialBalanceReadiness({ certificationVerdict: "certified", safishaStatus: "clean", reconciliation: COMPLETE }).ready).toBe(true);
    const v = deriveTrialBalanceVerdict({ upload: { id: "u1", status: "complete", safisha_status: "clean", reconciliation: COMPLETE }, readiness: { verdict: "certified", blocker: null, checks: [] }, canRetry: true });
    expect(v.evidenceCleared).toBe(true);
  });

  for (const [name, read] of Object.entries(NOT_COMPLETE)) {
    it(`${name}: no readiness, no 'Continue', no cleared evidence${READABLE_INCOMPLETE.includes(name) ? ", and the state engine sees it as under review" : ""}`, () => {
      // 3. readiness, review step, orientation, task
      expect(trialBalanceReadiness({ certificationVerdict: "certified", safishaStatus: "clean", reconciliation: read }).ready).toBe(false);
      const state = deriveWorkspaceState("c1", "Co", 2025, snapshot("clean"));
      expect(trialBalanceReviewStep(state, "clean", read)?.ready).toBe(false);
      expect(deriveOrientationSummary(state, ["FINANCIAL_STATEMENTS"], "clean", read).currentStatusLabel).not.toBe("Trial balance ready");
      // 2. verdict
      const v = deriveTrialBalanceVerdict({ upload: { id: "u1", status: "complete", safisha_status: "clean", reconciliation: read }, readiness: { verdict: "certified", blocker: null, checks: [] }, canRetry: true });
      expect(v.evidenceCleared).toBe(false);
      expect(v.primaryAction?.kind).toBe("verify_evidence");
      // 1. state engine: readable-but-incomplete evidence is downgraded before it reaches deriveWorkspaceState
      const effective = effectiveSafishaStatus("clean", read);
      if (READABLE_INCOMPLETE.includes(name)) {
        expect(effective).toBe("needs_review");
        expect(unlocked("clean").prepare).toBe("passed");   // what the raw status alone would have unlocked
        expect(unlocked(effective).prepare).toBe("blocked"); // what the state engine actually receives
      }
    });
  }

  it("the effective status never upgrades anything to clean", () => {
    for (const raw of [null, "processing", "needs_review", "blocked"]) for (const read of [COMPLETE, ...Object.values(NOT_COMPLETE)]) {
      expect(effectiveSafishaStatus(raw, read)).toBe(raw);
    }
  });
});

describe("static guard: every raw 'clean' comparison in the frontend is accounted for", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? (e.name === "__tests__" ? [] : walk(p)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
  it("only the reviewed consumers compare against 'clean'", () => {
    const hits = walk(path.join(ROOT, "src")).filter((f) => /(===|!==)\s*["']clean["']/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/")).sort();
    expect(hits).toEqual([
      "src/components/safisha/ExceptionQueue.tsx",    // shows the gate's own result; unlocks nothing
      "src/components/safisha/SafishaGate.tsx",       // shows the gate's own result; unlocks nothing
      "src/lib/workspace/deriveWorkspaceState.ts",    // fed effectiveSafishaStatus (fetchWorkspaceSnapshot)
      "src/lib/workspace/trialBalanceReadiness.ts",   // the one definition
    ]);
    const snap = fs.readFileSync(path.join(ROOT, "src/lib/workspace/fetchWorkspaceSnapshot.ts"), "utf8");
    expect(snap).toMatch(/safishaStatus: effectiveSafishaStatus\(upload\.safisha_status \?\? null, upload\.reconciliation\)/);
  });
});
