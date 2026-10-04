/**
 * Every frontend consumer of reconciliation "clean", driven with a raw "clean" status over EMPTY, PARTIAL, ESCALATED,
 * PENDING, REJECTED and UNREADABLE evidence: none of them unlocks anything that depends on a reconciliation. Only a
 * complete reconciliation does. A static guard pins the full list of raw "clean" comparisons so a new consumer cannot
 * appear without being added here.
 *
 * Scope (TB Review scope correction): supporting-evidence reconciliation is NOT part of Trial balance review. Its outcome
 * — a "Reviewed trial balance" — depends only on checks passed and classifications confirmed, so it is the SAME whatever
 * the reconciliation says, and it never claims reconciliation. What a reconciliation still gates is unchanged:
 *   1. deriveWorkspaceState — tax (taxBlocked = !safishaClean, the constitutional gate). Fed the EFFECTIVE status
 *      (effectiveSafishaStatus, applied in fetchWorkspaceSnapshot.toUploadSnapshot), so a raw "clean" over incomplete
 *      evidence never unlocks tax.
 *   2. evidenceState / reconciliationEvaluated — the one definition of a complete reconciliation.
 *   3. SafishaGate / ExceptionQueue — display the reconciliation's own result inside the gate; they unlock nothing.
 * Server consumers are covered by the disposable-PostgreSQL proofs (maono_check_safisha_gate, 20261004100000).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveWorkspaceState } from "./deriveWorkspaceState";
import { deriveOrientationSummary, trialBalanceReviewStep } from "./deriveOrientationSummary";
import { deriveTrialBalanceVerdict } from "./trialBalanceVerdict";
import { effectiveSafishaStatus, evidenceState, reconciliationEvaluated, trialBalanceReadiness, type EvidenceRead } from "./trialBalanceReadiness";
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

const snapshot = (safishaStatus: string | null, hesabuPassedAt: string | null = null): UploadSnapshot => ({
  id: "u1", companyId: "c1", companyName: "Co", periodYear: 2025, status: "complete", isValid: true, safishaStatus,
  uploadedAt: "2026-01-01T00:00:00Z", processedAt: "2026-01-01T00:00:00Z", hasMapping: false, hesabuPassedAt,
  kingaSignedAt: null, filingSubmittedAt: null, certificationVerdict: "certified", certificationBlocker: null,
});
/** The tax stage once statements are validated — the one workspace consumer of a reconciliation. */
const taxAfterStatements = (safishaStatus: string | null) => deriveWorkspaceState("c1", "Co", 2025, snapshot(safishaStatus, "2026-01-02T00:00:00Z")).missions.tax.status;
const verdictFor = () => deriveTrialBalanceVerdict({ upload: { id: "u1", status: "complete" }, readiness: { verdict: "certified", blocker: null, checks: [] }, canRetry: true });

describe("a raw 'clean' over incomplete evidence unlocks nothing that depends on a reconciliation", () => {
  it("baseline: a COMPLETE reconciliation is complete and unlocks tax", () => {
    expect(effectiveSafishaStatus("clean", COMPLETE)).toBe("clean");
    expect(evidenceState("clean", COMPLETE).state).toBe("complete");
    expect(reconciliationEvaluated(COMPLETE.state === "read" ? COMPLETE.evidence : null)).toBe(true);
    expect(taxAfterStatements(effectiveSafishaStatus("clean", COMPLETE))).toBe("ready");
  });

  for (const [name, read] of Object.entries(NOT_COMPLETE)) {
    it(`${name}: not complete; tax stays locked${READABLE_INCOMPLETE.includes(name) ? " (the state engine sees it as under review)" : ""}; the Trial balance review outcome is unaffected and never claims reconciliation`, () => {
      // 2. the one definition of completeness
      expect(evidenceState("clean", read).state).not.toBe("complete");
      // 1. state engine: readable-but-incomplete evidence is downgraded before it reaches deriveWorkspaceState
      const effective = effectiveSafishaStatus("clean", read);
      if (READABLE_INCOMPLETE.includes(name)) {
        expect(effective).toBe("needs_review");
        expect(taxAfterStatements("clean")).toBe("ready");   // what the raw status alone would have unlocked
        expect(taxAfterStatements(effective)).toBe("locked"); // what the state engine actually receives
      }
      // Trial balance review: identical outcome regardless of the reconciliation, and never "reconciled"
      const state = deriveWorkspaceState("c1", "Co", 2025, snapshot(effective));
      expect(state.missions.prepare.status).toBe("passed");
      expect(trialBalanceReviewStep(state)).toMatchObject({ ready: true, label: "Reviewed trial balance" });
      expect(deriveOrientationSummary(state, ["FINANCIAL_STATEMENTS"]).currentStatusLabel).toBe("Reviewed trial balance");
      expect(trialBalanceReadiness({ certificationVerdict: "certified" }).ready).toBe(true);
      const v = verdictFor();
      expect(v.statusLabel).toBe("Reviewed");
      expect(JSON.stringify([v, trialBalanceReviewStep(state), state.missions.prepare])).not.toMatch(/reconciled|audited|assured|signed off/i);
    });
  }

  it("the effective status never upgrades anything to clean", () => {
    for (const raw of [null, "processing", "needs_review", "blocked"]) for (const read of [COMPLETE, ...Object.values(NOT_COMPLETE)]) {
      expect(effectiveSafishaStatus(raw, read)).toBe(raw);
    }
  });

  it("tax stays locked for every non-clean status, with no reconciliation at all, and before statements are validated", () => {
    for (const raw of [null, "processing", "needs_review", "blocked"]) expect(taxAfterStatements(raw)).toBe("locked");
    expect(deriveWorkspaceState("c1", "Co", 2025, snapshot("clean")).missions.tax.status).toBe("locked");
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
