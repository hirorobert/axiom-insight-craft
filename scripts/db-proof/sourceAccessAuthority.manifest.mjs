// The reviewed case manifest of scripts/db-proof/sourceAccessAuthority.mjs (independent review of #229, findings 2, 3 and 5). Every case must pass in
// present mode; the structured result is validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "sourceAccessAuthority";
const control = (id) => ({ id, kind: "control", modes: ["present"] });
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
  // finding 3: the order around the one asynchronous step
  control("signing.withdrawal-while-signing-returns-no-link"),
  control("signing.withdrawal-after-the-second-read-is-ordered-after-issuance"),
  // finding 5: the durable decision record
  control("record.issuance-is-recorded-before-the-link-and-holds-no-url"),
  control("record.no-record-no-link"),
  control("record.append-only-and-readable-only-by-the-workspace-owner"),
]);
