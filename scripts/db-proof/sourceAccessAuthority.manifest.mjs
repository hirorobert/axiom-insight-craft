// The reviewed case manifest of scripts/db-proof/sourceAccessAuthority.mjs (independent review of #229, findings 2, 3 and 5, and the re-review of the
// issuance ordering and the audit semantics). Every case must pass in present mode; the structured result is validated by scripts/ci/validateProofResult.mjs
// against this list.
export const PROOF = "sourceAccessAuthority";
const control = (id) => ({ id, kind: "control", modes: ["present"] });
export const ISSUANCE_WRITERS = Object.freeze(["explicit-revoke", "member-removal", "plan-lapse"]);
export const HOLDER_FIRST_WRITERS = Object.freeze(["explicit-revoke", "member-removal"]);
export const CASES = Object.freeze([
  { id: "setup.chain-and-world", kind: "setup", modes: ["present"] },
  // finding 2: removing a member ends that person's access; supported independent access is preserved
  control("removal.the-grant-is-revoked-in-the-removing-transaction"),
  control("removal.the-download-path-refuses-and-records-the-denial"),
  control("removal.a-collaborator-who-was-never-a-member-keeps-access"),
  control("removal.owner-other-members-and-other-workspaces-are-untouched"),
  control("removal.reinstatement-does-not-resurrect-old-grants"),
  control("removal.a-pending-invitation-removes-nothing"),
  control("removal.a-demotion-changes-the-title-not-independent-grants"),
  control("removal.the-whole-removal-rolls-back-together"),
  // finding 3: the issuance decision's COMMIT is the ordering point; both orderings, with barriers
  control("ordering.withdrawal-commits-first-no-issuance-no-url"),
  ...ISSUANCE_WRITERS.map((w) => control(`ordering.decision-commits-first.${w}-waits-and-the-link-may-be-delivered`)),
  ...HOLDER_FIRST_WRITERS.map((w) => control(`ordering.withdrawal-holding-its-locks-first.${w}-is-ordered-first`)),
  control("ordering.a-collaborator-who-was-never-a-member-is-issued-and-unaffected-by-others"),
  control("ordering.concurrent-downloads-and-a-revocation-terminate-in-one-order"),
  // expiry: the signer's own exp or nothing; a margin judged as late as practical and again before the response; no estimate
  control("expiry.the-signers-own-exp-is-recorded-with-its-freshness-evaluation"),
  control("expiry.a-link-without-a-readable-exp-is-never-issued-or-recorded"),
  control("expiry.whole-second-signer-counterexample-nothing-is-claimed-beyond-the-true-exp"),
  control("expiry.freshness-is-evaluated-after-the-locks-a-delayed-decision-is-refused"),
  control("expiry.the-link-ran-out-after-the-decision-the-response-is-withheld-and-the-decision-stands"),
  control("expiry.the-database-refuses-bad-inputs-and-the-constraints-pin-outcome-to-margin"),
  // owner identity: every authority input is judged under the locks of the account it is judged for
  control("ownership.transfer-committed-first-the-new-owner-is-the-account-judged-and-protected"),
  control("ownership.transfer-between-the-owner-read-and-the-company-lock-is-refused"),
  control("ownership.transfer-waits-for-an-admitted-decision-then-the-new-owner-governs"),
  // finding 5: what a record means, and the only ways to write one
  control("record.issuance-means-decision-not-delivery"),
  control("record.no-decision-no-link"),
  control("record.denied-is-recorded-for-a-precheck-refusal"),
  control("record.holds-no-url-and-has-the-signing-shape"),
  control("record.only-the-decision-functions-write"),
  control("record.append-only-and-readable-only-by-the-workspace-owner"),
]);
