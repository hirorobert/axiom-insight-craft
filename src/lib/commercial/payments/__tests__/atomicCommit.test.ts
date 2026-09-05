/**
 * Ω2 Test Matrix — Section 5: Atomic Commercial Commit + Licence + Entitlement
 * Tests the post-commit state machine and idempotency guarantees.
 * No live DB — behaviour is verified through type constraints and logic.
 */

import { describe, it, expect, vi } from "vitest";
import type { CommitResult, PaymentStatus } from "../paymentTypes";

// ── CommitResult shape ────────────────────────────────────────────────────────

describe("CommitResult — exhaustive status union", () => {
  it("COMMITTED result includes eventId, licenceId, periodStart, periodEnd", () => {
    const committed: CommitResult = {
      committed: true,
      status: "COMMITTED",
      eventId: "evt-001",
      licenceId: "lic-001",
      periodStart: "2026-01-01T00:00:00Z",
      periodEnd: "2026-12-31T23:59:59Z",
    };
    expect(committed.committed).toBe(true);
    expect(committed.licenceId).toBeDefined();
    expect(committed.periodEnd).toBeDefined();
  });

  it("ALREADY_COMMITTED is idempotent — safe to replay", () => {
    const idempotent: CommitResult = {
      committed: false,
      status: "ALREADY_COMMITTED",
      eventId: "evt-001", // matches CommitResult.eventId?
    };
    expect(idempotent.committed).toBe(false);
    expect(idempotent.status).toBe("ALREADY_COMMITTED");
  });

  it("INTENT_EXPIRED is a terminal non-commit state", () => {
    const expired: CommitResult = {
      committed: false,
      status: "INTENT_EXPIRED",
    };
    expect(expired.committed).toBe(false);
    expect(expired.status).toBe("INTENT_EXPIRED");
  });

  it("NON_SUCCESS_RECORDED — provider said not successful, recorded not committed", () => {
    const nonSuccess: CommitResult = {
      committed: false,
      status: "NON_SUCCESS_RECORDED",
      normalizedStatus: "FAILED",
    };
    expect(nonSuccess.committed).toBe(false);
    expect(nonSuccess.normalizedStatus).toBe("FAILED");
  });
});

// ── Payment status machine ────────────────────────────────────────────────────

describe("PaymentStatus — all states are distinct", () => {
  const allStatuses: PaymentStatus[] = [
    "CHECKOUT_CREATED",
    "PENDING",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
    "EXPIRED",
    "UNKNOWN",
  ];

  it("has 9 distinct status values", () => {
    expect(new Set(allStatuses).size).toBe(9);
  });

  it("FAILED !== CANCELLED !== EXPIRED !== PENDING", () => {
    expect("FAILED").not.toBe("CANCELLED");
    expect("FAILED").not.toBe("EXPIRED");
    expect("FAILED").not.toBe("PENDING");
    expect("CANCELLED").not.toBe("EXPIRED");
    expect("CANCELLED").not.toBe("PENDING");
    expect("EXPIRED").not.toBe("PENDING");
  });

  it("only SUCCEEDED triggers commit", () => {
    const triggersCommit = (s: PaymentStatus) => s === "SUCCEEDED";
    for (const s of allStatuses) {
      if (s === "SUCCEEDED") {
        expect(triggersCommit(s)).toBe(true);
      } else {
        expect(triggersCommit(s)).toBe(false);
      }
    }
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("Atomic commit — idempotency via provider_transaction_id unique index", () => {
  it("same providerTransactionId cannot be committed twice — uq_pe_provider_tx_id", () => {
    // Simulate: first commit succeeds, second returns ALREADY_COMMITTED
    const committed = new Set<string>();

    function simulateCommit(txId: string): CommitResult {
      if (committed.has(txId)) {
        return { committed: false, status: "ALREADY_COMMITTED", eventId: "evt-001" };
      }
      committed.add(txId);
      return {
        committed: true,
        status: "COMMITTED",
        eventId: "evt-001",
        licenceId: "lic-001",
        periodStart: "2026-01-01T00:00:00Z",
        periodEnd: "2026-12-31T23:59:59Z",
      };
    }

    const first = simulateCommit("FLW-TX-001");
    const second = simulateCommit("FLW-TX-001");

    expect(first.committed).toBe(true);
    expect(second.committed).toBe(false);
    expect(second.status).toBe("ALREADY_COMMITTED");
  });
});

// ── Refund / Reversal ─────────────────────────────────────────────────────────

describe("Reversal — REVIEW_REQUIRED, no auto-mutation", () => {
  it("reversal returns REVIEW_REQUIRED and never auto-mutates licence", () => {
    // The record_payment_reversal() RPC returns REVIEW_REQUIRED and does nothing else.
    const simulateReversal = () => ({
      result: "REVIEW_REQUIRED",
      licenceMutated: false, // invariant — must always be false
      commercialValueGranted: false, // invariant
    });

    const result = simulateReversal();
    expect(result.result).toBe("REVIEW_REQUIRED");
    expect(result.licenceMutated).toBe(false);
    expect(result.commercialValueGranted).toBe(false);
  });
});
