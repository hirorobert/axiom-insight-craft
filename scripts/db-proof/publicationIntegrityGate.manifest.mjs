// The reviewed case manifest of scripts/db-proof/publicationIntegrityGate.mjs — the structured outcome contract CI validates
// with scripts/ci/validateProofResult.mjs. Every case has a stable id and a kind:
//   setup     infrastructure and fixtures: must pass in BOTH modes (a failure is an infrastructure failure, never evidence);
//   control   the honest path and the behaviours the gate must not change: must pass in BOTH modes;
//   weakness  a reviewed weakness the gate closes: must pass with the gate PRESENT and must FAIL with the gate ABSENT
//             (the chain replayed up to, and excluding, 20261124100000) — the reproduction of the prior behaviour.
// `modes` restricts a case to one mode (the two replay cases). Adding, removing or renaming a case here is a reviewed change:
// the validator refuses a result with a missing, duplicated, extra or wrong-outcome case, a crash or an incomplete run.
export const PROOF = "publicationIntegrityGate";
export const CASES = Object.freeze([
  { id: "setup.chain", kind: "setup", modes: ["present"] },
  { id: "setup.reapply-refused", kind: "setup", modes: ["present"] },
  { id: "setup.chain-before-gate", kind: "setup", modes: ["absent"] },
  { id: "setup.static-contract", kind: "setup" },
  { id: "setup.world", kind: "setup" },
  { id: "h0.honest-ready", kind: "control" },
  { id: "h0.honest-final", kind: "control" },
  // W1 — document closure (20261124100000)
  { id: "w1.fabricated-note-figure", kind: "weakness" },
  { id: "w1.second-fact-version", kind: "weakness" },
  { id: "w1.reader-prefers-latest-version", kind: "control" },
  { id: "w1.redenominated-facts", kind: "weakness" },
  { id: "w1.rescaled-fact", kind: "weakness" },
  { id: "w1.presentation-currency", kind: "weakness" },
  { id: "w1.period-header", kind: "weakness" },
  { id: "w1.comparative-header", kind: "weakness" },
  { id: "w1.provenance-relabelled", kind: "weakness" },
  // S1 — document structure (20261126100000)
  { id: "s1.swapped-line-binding", kind: "weakness" },
  { id: "s1.swapped-period-columns", kind: "weakness" },
  { id: "s1.relabelled-line", kind: "weakness" },
  { id: "s1.line-moved-to-another-section", kind: "weakness" },
  { id: "s1.duplicate-statement", kind: "weakness" },
  { id: "s1.fact-period-field", kind: "weakness" },
  { id: "s1.provenance-unbound", kind: "weakness" },
  { id: "s1.malformed-fact", kind: "weakness" },
  { id: "s1.total-role-flipped", kind: "weakness" },
  { id: "w1.builder-after-tampered-drafts", kind: "control" },
  // W3 — withdrawing a review
  { id: "w3.second-lineage-reviewed", kind: "control" },
  { id: "w3.preparer-cannot-withdraw", kind: "weakness" },
  { id: "w3.reviewer-withdraws-and-reviews", kind: "control" },
  // W2 — clearing a finding
  { id: "w2.blocking-finding-blocks", kind: "control" },
  { id: "w2.preparer-cannot-clear", kind: "weakness" },
  { id: "w2.preparer-defers-reviewer-clears", kind: "control" },
  // W4 — a superseded FINAL and the official pack
  { id: "w4.final-issued-officially", kind: "control" },
  { id: "w4.correction-becomes-final", kind: "control" },
  { id: "w4.superseded-issue-refused", kind: "weakness" },
  { id: "w4.pending-seal-refused", kind: "weakness" },
  { id: "w4.earlier-pack-disclosed-superseded", kind: "weakness" },
  { id: "w4.versions-list-superseded", kind: "weakness" },
  { id: "w4.new-final-issues", kind: "control" },
  { id: "w4.outsider-learns-nothing", kind: "control" },
  // I — issued history
  { id: "i.history-unchanged", kind: "control" },
]);
