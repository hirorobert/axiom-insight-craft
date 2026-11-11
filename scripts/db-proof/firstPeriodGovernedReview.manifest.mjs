// The reviewed case manifest of scripts/db-proof/firstPeriodGovernedReview.mjs (20261223100000, the standalone first-period
// governed review on main; defect S2-A03). Two modes: PRESENT applies the migration and every case must pass; ABSENT
// (FIRST_PERIOD_GATE_ABSENT=1) stops before it, and EXACTLY the weakness cases must fail - their failure is the old-certificate
// bypass. The structured result is validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "firstPeriodGovernedReview";
const P = ["present"];
export const CASES = Object.freeze([
  // Before the migration (both modes): the chain, issued history, legacy declarations, the read-only preflight, the bypass itself.
  { id: "setup.chain-before", kind: "setup" },
  { id: "setup.chain-tail", kind: "setup" },
  { id: "setup.issued-history", kind: "setup" },
  { id: "setup.legacy-workspaces", kind: "setup" },
  { id: "pre.rollout-preflight-read-only", kind: "control" },
  { id: "pre.old-rule-bypass-reproduces", kind: "setup" },
  // The defect: these must FAIL without the migration and PASS with it.
  { id: "w1.old-certificate-does-not-clear-blocker", kind: "weakness" },
  { id: "w2.declaration-alone-never-grants", kind: "weakness" },
  { id: "w3.signoff-names-unmet-requirement", kind: "weakness" },
  // The migration.
  { id: "mig.applies", kind: "control", modes: P },
  { id: "mig.rerun-refused", kind: "control", modes: P },
  { id: "mig.splice-line-subsequence", kind: "control", modes: P },
  { id: "mig.splices-present", kind: "control", modes: P },
  { id: "mig.no-bare-delete-update", kind: "control", modes: P },
  { id: "mig.access", kind: "control", modes: P },
  // Rollout effect.
  { id: "roll.no-claim-or-decision-created", kind: "control", modes: P },
  { id: "roll.legacy-one-reason-and-action", kind: "control", modes: P },
  { id: "roll.voided-declaration-names-earlier-books", kind: "control", modes: P },
  { id: "roll.issued-history-identical", kind: "control", modes: P },
  { id: "roll.comparative-path-blockers-unchanged", kind: "control", modes: P },
  // S1 the old-certificate bypass through the governed route.
  { id: "s1.honest-old-registration-not-eligible", kind: "control", modes: P },
  { id: "s1.forged-registration-date-refused", kind: "control", modes: P },
  { id: "s1.wrong-entity-or-dates-named", kind: "control", modes: P },
  { id: "s1.nothing-published", kind: "control", modes: P },
  { id: "s1.separation-of-duties", kind: "control", modes: P },
  // S2 a genuine first period, S5 opening support.
  { id: "s2.facts-missing-named", kind: "control", modes: P },
  { id: "s2.claim-pending-review", kind: "control", modes: P },
  { id: "s2.different-approver-grants", kind: "control", modes: P },
  { id: "s5.opening-support-missing", kind: "control", modes: P },
  { id: "s5.nil-opening-needs-evidence", kind: "control", modes: P },
  { id: "s5.reconciliation-refused", kind: "control", modes: P },
  { id: "s5.supported-nil-opening", kind: "control", modes: P },
  { id: "s2.signoff-stops-at-independent-blockers", kind: "control", modes: P },
  { id: "s2.cashflow-gap-independent", kind: "control", modes: P },
  // S3 activity before bookkeeping began, S4 dormancy.
  { id: "s3.pre-bookkeeping-activity-not-contradiction", kind: "control", modes: P },
  { id: "s3.items-reconciled", kind: "control", modes: P },
  { id: "s4.dormancy-unevidenced", kind: "control", modes: P },
  { id: "s4.dormancy-coverage-gap", kind: "control", modes: P },
  { id: "s4.prior-statements-not-eligible", kind: "control", modes: P },
  { id: "s4.dormancy-verified-by-other-approver", kind: "control", modes: P },
  // S6 later evidence, S7 later facts / period / identity: the decision goes stale.
  { id: "s6.contradiction-after-approval-stales", kind: "control", modes: P },
  { id: "s6.cannot-reverify-while-contradicted", kind: "control", modes: P },
  { id: "s6.retract-then-rereview", kind: "control", modes: P },
  { id: "s6.history-kept-and-benign-copy-stales", kind: "control", modes: P },
  { id: "s6.append-only", kind: "control", modes: P },
  { id: "s6.client-direct-write-refused", kind: "control", modes: P },
  { id: "s6.replay-and-request-reuse", kind: "control", modes: P },
  { id: "s7.new-facts-end-exception", kind: "control", modes: P },
  { id: "s7.period-change-stales", kind: "control", modes: P },
  { id: "s7.identity-change-stales", kind: "control", modes: P },
  // CMP the comparative path and the server-compilation splice.
  { id: "cmp.comparative-path-final", kind: "control", modes: P },
  { id: "cmp.server-compilation-bites", kind: "control", modes: P },
  // RACE evidence and decision changes against sign-off, both orderings.
  { id: "race.e1-evidence-first", kind: "control", modes: P },
  { id: "race.e2-signoff-first", kind: "control", modes: P },
  { id: "race.d1-decision-first", kind: "control", modes: P },
  { id: "race.d2-signoff-first-withdraw", kind: "control", modes: P },
  { id: "race.history-after", kind: "control", modes: P },
]);
