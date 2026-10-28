// The reviewed case manifest of scripts/db-proof/completeSmeReport.mjs: ONE complete SME report, end to end, on two
// materially different synthetic cases driven through the SAME runner (no case-specific branch): the acceptance-r1
// engagement (the hosted demo company's dedicated FY2025/FY2024 engagement, replicated) and Mwanza Agro Supplies
// (year to 30 June, two equipment classes, an addition and a disposal with proceeds, a director's loan, a post-period
// dividend). Every case must pass in present mode; the structured result is validated by
// scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "completeSmeReport";
const journey = (pfx) => [
  { id: `${pfx}.setup.engagement`, kind: "setup", modes: ["present"] },
  { id: `${pfx}.notes.outstanding-before`, kind: "control", modes: ["present"] },
  { id: `${pfx}.equipment.applicable-questions-answered`, kind: "control", modes: ["present"] },
  { id: `${pfx}.equipment.draft-retained-on-reload`, kind: "control", modes: ["present"] },
  { id: `${pfx}.equipment.recorded-from-register`, kind: "control", modes: ["present"] },
  { id: `${pfx}.equipment.reload-shows-recorded`, kind: "control", modes: ["present"] },
  { id: `${pfx}.notes.every-requirement-resolved`, kind: "control", modes: ["present"] },
  { id: `${pfx}.statements.version-after-close-review`, kind: "control", modes: ["present"] },
  { id: `${pfx}.statements.expected-totals`, kind: "control", modes: ["present"] },
  { id: `${pfx}.statements.reconciliations`, kind: "control", modes: ["present"] },
  { id: `${pfx}.review.policy-and-two-approvers`, kind: "control", modes: ["present"] },
  { id: `${pfx}.issuance.official-pack-verified`, kind: "control", modes: ["present"] },
  { id: `${pfx}.final.preserved-after-later-change`, kind: "control", modes: ["present"] },
];
export const CASES = Object.freeze([
  { id: "setup.chain-applies", kind: "setup", modes: ["present"] },
  { id: "static.one-runner-no-case-branch", kind: "control", modes: ["present"] },
  ...journey("c1"),
  ...journey("c2"),
]);
