// The reviewed case manifest of scripts/db-proof/ipsasAuthorityRaces.mjs (independent review of #229, finding 1). Every case must pass in present
// mode; the structured result is validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "ipsasAuthorityRaces";
export const MUTATIONS = Object.freeze(["prep-save", "confirm", "grants-save", "grant-confirm", "statement-save"]);
// Every mutation now needs a certified trial balance (its denomination is the server's), and set_company_reporting_framework refuses FRAMEWORK_LOCKED
// once one exists: a framework change can no longer be a withdrawal that races an admitted mutation. The helper's framework lock is still what orders it,
// so it is proven at the helper itself (the "helper-level" cases) in both orderings.
export const WRITERS = Object.freeze(["member-removal", "role-demotion", "explicit-revoke", "rollout-closure", "framework-change", "plan-lapse"]);
const MUTATION_WRITERS = WRITERS.filter((w) => w !== "framework-change");
const control = (id) => ({ id, kind: "control", modes: ["present"] });
export const CASES = Object.freeze([
  { id: "setup.chain-and-world", kind: "setup", modes: ["present"] },
  // The withdrawal arrives AFTER the mutation was admitted and BEFORE it persists: it must wait for the mutation to commit (or the mutation must
  // refuse without persisting). Every mutation RPC against every writer of an authority input.
  ...MUTATIONS.flatMap((m) => MUTATION_WRITERS.map((w) => control(`admitted-first.${m}.${w}`))),
  // The same for an idempotent replay (the stored receipt must not be handed to someone whose access was withdrawn while it was served).
  control("admitted-first.replay.member-removal"),
  control("admitted-first.replay.explicit-revoke"),
  // The withdrawal is in flight (holding its locks, uncommitted) when the mutation arrives: the mutation waits or refuses and never commits after it.
  ...MUTATION_WRITERS.map((w) => control(`writer-first.prep-save.${w}`)),
  ...MUTATIONS.filter((m) => m !== "prep-save").map((m) => control(`writer-first.${m}.member-removal`)),
  // The framework writer, proven at the helper both five RPCs call.
  control("helper-level.framework-change-waits-for-an-admitted-helper"),
  control("helper-level.an-in-flight-framework-change-makes-admission-refuse"),
  control("contention.terminates-without-deadlock-or-partial-write"),
  control("persisted.no-partial-or-cross-company-writes"),
]);
