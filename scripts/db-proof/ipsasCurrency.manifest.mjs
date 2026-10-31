// The reviewed case manifest of scripts/db-proof/ipsasCurrency.mjs (independent review of #229, finding 4). Every case must pass in present mode; the
// structured result is validated by scripts/ci/validateProofResult.mjs against this list.
export const PROOF = "ipsasCurrency";
export const DENOMINATIONS = Object.freeze(["tzs-2", "usd-2", "jpy-0", "kwd-3"]);
const control = (id) => ({ id, kind: "control", modes: ["present"] });
export const CASES = Object.freeze([
  { id: "setup.chain-and-world", kind: "setup", modes: ["present"] },
  // For each supported denomination, with a trial balance really processed and certified in that currency: the server states it, the figures are exact
  // minor units of it, a payload entered in it is accepted and reopens unchanged, one entered in another is refused by name, and nothing is written.
  ...DENOMINATIONS.flatMap((d) => [
    control(`${d}.server-states-the-denomination`),
    control(`${d}.figures-are-exact-minor-units`),
    control(`${d}.matching-payload-saved-and-reopened`),
    control(`${d}.other-denomination-refused-nothing-written`),
    control(`${d}.prior-figures-currency-and-scale-checked`),
  ]),
  control("unsupported.exponent-four-refused-by-name"),
  control("unknown.no-certified-source-refused-by-name"),
  control("prior-period.different-currency-makes-the-opening-unknown"),
  control("saved-draft.entered-in-another-denomination-is-never-reread"),
  control("grants.same-rules-and-live-presentation"),
  control("confirmations.refuse-a-mismatched-denomination"),
  control("persisted.nothing-written-by-a-refusal"),
]);
