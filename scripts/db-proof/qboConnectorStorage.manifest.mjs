// The reviewed case manifest of scripts/db-proof/qboConnectorStorage.mjs (QuickBooks Online connector storage, migration 20261212100000, charter B9).
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
  // connections and tokens
  control("connection.store-requires-the-right-and-validates-the-envelope"),
  control("connection.storing-twice-replaces-the-one-live-connection"),
  control("connection.a-token-exists-exactly-while-the-connection-is-active"),
  control("rotation.is-compare-and-swap-and-only-one-concurrent-refresh-wins"),
  control("rotation.is-refused-for-an-inactive-connection"),
  control("reconnect-needed.deletes-the-dead-token"),
  control("disconnect.needs-the-right-deletes-the-token-and-is-terminal"),
  control("disconnect.then-a-new-live-connection-may-be-stored"),
  control("status.members-see-status-never-an-envelope-key-or-token"),
  control("company-deletion.removes-connections-and-states"),
  // provenance
  control("pull.record-requires-the-right-validates-and-is-one-per-upload"),
  control("pull.is-append-only-even-for-the-database-owner"),
  control("pull.is-readable-only-by-the-workspace-owner"),
  control("pull.holds-no-secret-url-or-payload-and-no-foreign-key"),
  // structure
  control("structure.row-level-security-on-and-no-client-grants-beyond-the-reviewed-ones"),
  control("structure.writers-are-security-definer-with-a-pinned-search-path-and-service-role-only"),
]);
