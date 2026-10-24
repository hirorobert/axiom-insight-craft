// The reviewed case manifest of scripts/db-proof/publicationAuthorityLegacy.mjs (one mode): a database that already holds
// FINAL versions in two lineages of one period, and one single-lineage period, BEFORE 20261125100000 is applied. Every case
// must pass; the structured result is validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "publicationAuthorityLegacy";
export const CASES = Object.freeze([
  { id: "setup.chain-before-authority", kind: "setup", modes: ["present"] },
  { id: "setup.world", kind: "setup", modes: ["present"] },
  { id: "l1.legacy-two-finals", kind: "control", modes: ["present"] },
  { id: "l2.legacy-single-lineage", kind: "control", modes: ["present"] },
  { id: "l3.migration-detects-conflict", kind: "control", modes: ["present"] },
  { id: "l4.unresolved-refuses-final", kind: "control", modes: ["present"] },
  { id: "l5.unresolved-refuses-issuance", kind: "control", modes: ["present"] },
  { id: "l6.unresolved-blocks-next-year", kind: "control", modes: ["present"] },
  { id: "l7.designation-authorization", kind: "control", modes: ["present"] },
  { id: "l8.designation", kind: "control", modes: ["present"] },
  { id: "l9.after-designation", kind: "control", modes: ["present"] },
  { id: "l10.single-lineage-unchanged", kind: "control", modes: ["present"] },
]);
