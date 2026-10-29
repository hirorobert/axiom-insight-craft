export const PROOF = "ipsasStatementReview";
export const CASES = Object.freeze([
  ["setup.chain","setup"], ["setup.certified-periods","setup"],
  ["auth.privileges","control"], ["auth.roles-and-tenants","control"], ["auth.framework-rollout","control"],
  ["auth.reviewer-read-without-prepare","control"],
  ["read.incomplete-is-not-zero","control"], ["save.presentation-and-hand-totals","control"],
  ["read.contra-and-provenance","control"], ["read.prior-reference-only","control"],
  ["save.invalid-fields-and-caption","control"], ["save.duplicate-unknown-and-stale","control"],
  ["save.same-request-replay","control"], ["save.changed-intent-refused","control"],
  ["save.concurrent-request","control"], ["save.concurrent-revision","control"],
  ["source.approved-adjustment-invalidates","control"], ["source.adjusted-versus-certified","control"],
  ["auth.revocation-before-admission","control"], ["auth.admitted-write-before-revocation","control"],
  ["auth.strict-isolation-refused","control"],
  ["history.append-only","control"], ["preserve.sme-and-publications","control"],
  ["read.never-issuable","control"],
].map(([id,kind])=>Object.freeze({id,kind,modes:["present"]})));
