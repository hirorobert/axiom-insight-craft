// The reviewed case manifest of scripts/db-proof/trackAHardening.mjs (release batch track-a-r1: 20261127100000 and
// 20261128100000, installed on a database that already holds a FINAL, a sealed official pack and a sign-off). Every case
// must pass; the structured result is validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "trackAHardening";
export const CASES = Object.freeze([
  { id: "setup.chain-before", kind: "setup", modes: ["present"] },
  { id: "setup.world-and-fixtures", kind: "setup", modes: ["present"] },
  { id: "m1.order-refused", kind: "control", modes: ["present"] },
  { id: "m2.interruption-rolls-back", kind: "control", modes: ["present"] },
  { id: "m3.apply-then-retry-refused", kind: "control", modes: ["present"] },
  { id: "m4.fixtures-preserved", kind: "control", modes: ["present"] },
  { id: "b1.direct-authority-writes-refused", kind: "control", modes: ["present"] },
  { id: "b2.authority-guard-binds-table-owner", kind: "control", modes: ["present"] },
  { id: "b3.flag-spoofing-ignored", kind: "control", modes: ["present"] },
  { id: "b4.intent-not-forgeable", kind: "control", modes: ["present"] },
  { id: "b5.legitimate-replacement", kind: "control", modes: ["present"] },
  { id: "b6.intent-confined-to-transaction", kind: "control", modes: ["present"] },
  { id: "c1.truncate-refused-every-role", kind: "control", modes: ["present"] },
  { id: "c2.history-update-delete-refused", kind: "control", modes: ["present"] },
  { id: "d1.direct-framework-update-refused", kind: "control", modes: ["present"] },
  { id: "d2.authorized-change-audited-and-invalidates", kind: "control", modes: ["present"] },
  { id: "d3.replay-and-idempotency", kind: "control", modes: ["present"] },
  { id: "d4.business-refusals", kind: "control", modes: ["present"] },
  { id: "d5.authorization-and-tenancy", kind: "control", modes: ["present"] },
  { id: "e1.final-waits-for-framework-change", kind: "control", modes: ["present"] },
  { id: "e2.framework-change-waits-for-final", kind: "control", modes: ["present"] },
  { id: "e3.framework-changes-serialize", kind: "control", modes: ["present"] },
  { id: "e4.other-periods-not-blocked", kind: "control", modes: ["present"] },
  { id: "f1.invariants-hold", kind: "control", modes: ["present"] },
]);
