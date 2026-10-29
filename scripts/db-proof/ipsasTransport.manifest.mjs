// The reviewed case manifest of scripts/db-proof/ipsasTransport.mjs (exact-byte transport of 20261207100000). Every case must
// pass in present mode; the structured result is validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "ipsasTransport";
export const CASES = Object.freeze([
  { id: "setup.real-predecessor-chain", kind: "setup", modes: ["present"] },
  { id: "bootstrap.wrong-predecessor-refused", kind: "control", modes: ["present"] },
  { id: "bootstrap.exact-id-required", kind: "control", modes: ["present"] },
  { id: "bootstrap.private-install", kind: "control", modes: ["present"] },
  { id: "bootstrap.existing-schema-refused", kind: "control", modes: ["present"] },
  { id: "stage.client-roles-denied", kind: "control", modes: ["present"] },
  { id: "apply.missing-stage-refused", kind: "control", modes: ["present"] },
  { id: "stage.one-byte-tamper-refused", kind: "control", modes: ["present"] },
  { id: "stage.unknown-artifact-refused", kind: "control", modes: ["present"] },
  { id: "stage.exact-source-inert", kind: "control", modes: ["present"] },
  { id: "stage.immutable-evidence", kind: "control", modes: ["present"] },
  { id: "apply.rehash-does-not-trust-metadata", kind: "control", modes: ["present"] },
  { id: "apply.prerequisite-missing-refused", kind: "control", modes: ["present"] },
  { id: "apply.unexpected-journal-head-refused", kind: "control", modes: ["present"] },
  { id: "apply.late-failure-rolls-back", kind: "control", modes: ["present"] },
  { id: "apply.baseline-change-rolls-back", kind: "control", modes: ["present"] },
  { id: "apply.privilege-postcondition-rolls-back", kind: "control", modes: ["present"] },
  { id: "apply.binding-independent-of-session-search-path", kind: "control", modes: ["present"] },
  { id: "apply.concurrent-installed-exactly-once", kind: "control", modes: ["present"] },
  { id: "apply.duplicate-refused", kind: "control", modes: ["present"] },
  { id: "installed.equals-direct-application", kind: "control", modes: ["present"] },
  { id: "installed.authority-matrix-and-framework-gate", kind: "control", modes: ["present"] },
  { id: "preservation.actual-records-and-settings", kind: "control", modes: ["present"] },
]);
