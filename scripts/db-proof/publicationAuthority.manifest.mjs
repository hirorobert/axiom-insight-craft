// The reviewed case manifest of scripts/db-proof/publicationAuthority.mjs (one mode: the FINAL authority PRESENT). Every case
// must pass; the structured result is validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "publicationAuthority";
export const CASES = Object.freeze([
  { id: "setup.chain", kind: "setup", modes: ["present"] },
  { id: "setup.world", kind: "setup", modes: ["present"] },
  { id: "a1.two-lineages-reviewed", kind: "control", modes: ["present"] },
  { id: "a2.concurrent-first-finals", kind: "control", modes: ["present"] },
  { id: "a3.competing-final-refused", kind: "control", modes: ["present"] },
  { id: "a4.replacement-authorization", kind: "control", modes: ["present"] },
  { id: "a5.replacement-must-name-current", kind: "control", modes: ["present"] },
  { id: "a6.first-authority-issued", kind: "control", modes: ["present"] },
  { id: "a7.explicit-replacement", kind: "control", modes: ["present"] },
  { id: "a8.replacement-retry-is-replay", kind: "control", modes: ["present"] },
  { id: "a9.replaced-lineage-superseded", kind: "control", modes: ["present"] },
  { id: "a10.new-authority-issues", kind: "control", modes: ["present"] },
  { id: "a11.seal-waits-for-replacement", kind: "control", modes: ["present"] },
  { id: "a12.replacement-waits-for-seal", kind: "control", modes: ["present"] },
  { id: "a13.expiry-and-revocation", kind: "control", modes: ["present"] },
  { id: "a14.comparative-uses-authority", kind: "control", modes: ["present"] },
  { id: "a15.tenant-and-scope-isolation", kind: "control", modes: ["present"] },
  { id: "a16.authority-history", kind: "control", modes: ["present"] },
]);
