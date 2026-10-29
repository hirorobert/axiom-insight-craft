// The reviewed case manifest of scripts/db-proof/ipsasAuthorityOrdering.mjs. Every case must pass in present mode; the structured result is
// validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "ipsasAuthorityOrdering";
export const CASES = Object.freeze([
  { id: "setup.chain-and-world", kind: "setup", modes: ["present"] },
  { id: "control.mutation-proceeds-when-nothing-is-revoked", kind: "control", modes: ["present"] },
  { id: "revoked-during-wait.save-preparation", kind: "control", modes: ["present"] },
  { id: "revoked-during-wait.confirm", kind: "control", modes: ["present"] },
  { id: "revoked-during-wait.save-grants", kind: "control", modes: ["present"] },
  { id: "revoked-during-wait.confirm-grant", kind: "control", modes: ["present"] },
  { id: "revoked-during-wait.idempotent-replay", kind: "control", modes: ["present"] },
  { id: "other-authority.membership-withdrawn-during-wait", kind: "control", modes: ["present"] },
  { id: "other-authority.rollout-closed-during-wait", kind: "control", modes: ["present"] },
  { id: "other-authority.framework-changed-during-wait", kind: "control", modes: ["present"] },
  { id: "order.revocation-waits-for-an-in-flight-mutation", kind: "control", modes: ["present"] },
  { id: "order.plan-change-waits-for-an-in-flight-mutation", kind: "control", modes: ["present"] },
  { id: "order.contention-terminates-without-deadlock", kind: "control", modes: ["present"] },
  { id: "isolation.stricter-than-read-committed-fails-closed", kind: "control", modes: ["present"] },
  { id: "persisted.no-partial-or-cross-company-writes", kind: "control", modes: ["present"] },
]);
