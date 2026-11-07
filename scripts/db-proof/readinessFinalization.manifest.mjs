// The reviewed case manifest of scripts/db-proof/readinessFinalization.mjs (one mode: Ready for Reporting PRESENT). Every case
// must pass; the structured result is validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "readinessFinalization";
export const CASES = Object.freeze([
  { id: "setup.chain", kind: "setup", modes: ["present"] },
  { id: "setup.world1", kind: "setup", modes: ["present"] },
  { id: "a1.not-opted-in-unchanged", kind: "control", modes: ["present"] },
  { id: "a2.opt-in-and-authority", kind: "control", modes: ["present"] },
  { id: "a3.unevaluated-blocks-review-drafting-allowed", kind: "control", modes: ["present"] },
  { id: "a4.run-recorded-ready", kind: "control", modes: ["present"] },
  { id: "a5.review-binds-content", kind: "control", modes: ["present"] },
  { id: "c1.change-commits-before-finalize", kind: "contract", modes: ["present"] },
  { id: "c1b.stale-review-refused", kind: "contract", modes: ["present"] },
  { id: "c3.non-read-committed-refused", kind: "contract", modes: ["present"] },
  { id: "c2.finalize-commits-before-change", kind: "contract", modes: ["present"] },
  { id: "c4.every-writer-takes-the-scope-lock", kind: "contract", modes: ["present"] },
  { id: "c7.bound-evidence-retained", kind: "contract", modes: ["present"] },
  { id: "a6.next-version-sees-change", kind: "control", modes: ["present"] },
  { id: "setup.world2", kind: "setup", modes: ["present"] },
  { id: "f1.qbo-no-attestation-holds", kind: "freshness", modes: ["present"] },
  { id: "f2.qbo-expired-attestation-holds", kind: "freshness", modes: ["present"] },
  { id: "f3.qbo-changed-source-holds", kind: "freshness", modes: ["present"] },
  { id: "f4.qbo-attestation-for-other-content-holds", kind: "freshness", modes: ["present"] },
  { id: "f5.identical-books-renew-without-rereview", kind: "freshness", modes: ["present"] },
  { id: "f6.attestation-life-and-authority", kind: "freshness", modes: ["present"] },
]);
