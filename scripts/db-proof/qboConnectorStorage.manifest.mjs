// The reviewed case manifest of scripts/db-proof/qboConnectorStorage.mjs (QuickBooks Online connector storage, migration 20261213100000, charter B9).
// Every case must pass in present mode; the structured result is validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "qboConnectorStorage";
const control = (id) => ({ id, kind: "control", modes: ["present"] });
export const CASES = Object.freeze([
  { id: "setup.chain-and-world", kind: "setup", modes: ["present"] },
  // secrecy: clients touch nothing; only the service role writes, through the functions
  control("clients.cannot-read-or-write-connections-or-oauth-states"),
  control("clients.cannot-call-the-writers-only-the-status-function"),
  // OAuth state
  control("state.start-stores-only-a-hash-and-requires-the-right"),
  control("state.is-single-use"),
  control("state.expired-or-unknown-returns-nothing"),
  control("state.consumed-but-the-actor-lost-the-right-returns-nothing-and-cannot-be-retried"),
  control("state.lifetime-is-bounded-at-thirty-minutes"),
  // the return leg (review r2, S4): the code is parked sealed; only the person who started the attempt takes it back
  control("return.parks-the-sealed-code-once-and-gives-back-only-where-to-return"),
  control("return.only-the-person-who-started-takes-it-and-any-answer-ends-it"),
  control("return.an-expired-handoff-gives-nothing-and-housekeeping-deletes-parked-codes"),
  control("return.a-starter-who-lost-either-right-cannot-take-it"),
  // connections and tokens
  control("connection.store-requires-the-right-and-validates-the-envelope"),
  control("connection.storing-twice-replaces-the-one-live-connection"),
  control("connection.a-token-exists-exactly-while-the-connection-is-active"),
  control("rotation.is-compare-and-swap-and-only-one-concurrent-refresh-wins"),
  control("rotation.a-retry-whose-first-answer-was-lost-is-recognised-and-writes-nothing-twice"),
  control("rotation.is-refused-for-an-inactive-connection"),
  control("reconnect-needed.deletes-the-dead-token"),
  control("reconnect-needed.only-for-the-token-intuit-refused-never-a-newer-one"),
  control("disconnect.needs-the-right-deletes-the-token-and-is-terminal"),
  control("disconnect.then-a-new-live-connection-may-be-stored"),
  control("status.members-see-status-never-an-envelope-key-or-token"),
  control("company-deletion.removes-connections-and-states"),
  // one rule: both rights for every connector function
  control("connector.every-function-needs-both-rights-and-neither-alone-is-enough"),
  // refresh lease: two simultaneous imports never present the same refresh token to Intuit together
  control("lease.only-one-caller-holds-it-and-it-names-the-envelope"),
  control("lease.lapses-by-itself-is-released-on-demand-and-is-cleared-by-rotation"),
  control("lease.never-outlives-an-active-token"),
  control("lease.only-its-holder-releases-it-a-lapsed-holder-cannot-clear-the-next-holders-lease"),
  // evidence: intent first, then the link to the upload; recoverable
  control("intent.needs-both-rights-the-actors-own-open-reservation-and-valid-facts"),
  control("intent.is-idempotent-for-the-same-facts-and-refuses-different-facts"),
  control("completion.links-the-intent-to-the-upload-the-reservation-itself-created"),
  control("completion.a-right-lost-after-registration-cannot-lose-the-evidence"),
  control("recovery.completes-every-missing-link-and-nothing-else"),
  control("recovery.one-unlinkable-row-never-stops-the-rest"),
  control("evidence.is-append-only-even-for-the-database-owner"),
  control("evidence.is-readable-only-by-the-workspace-owner"),
  control("evidence.holds-no-secret-url-or-payload-and-no-foreign-key"),
  // cleanup and retention
  control("housekeeping.removes-old-states-and-dead-connections-and-never-evidence"),
  control("retention.only-counts-evidence-past-an-interval-of-at-least-a-year"),
  // structure
  control("structure.row-level-security-on-and-no-client-grants-beyond-the-reviewed-ones"),
  control("structure.writers-are-security-definer-with-a-pinned-search-path-and-service-role-only"),
]);
