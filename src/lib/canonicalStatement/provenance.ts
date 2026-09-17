// canonicalStatement/provenance.ts — read-only fact-lineage helpers.
//
// Appending a corrected fact version is NOT exposed here — the only public
// way to do that is `reviewState.ts`'s `recordFactCorrection`, which
// appends the corrected MonetaryFact and its CorrectFactDecision together,
// atomically. A lower-level "append a fact version without its decision"
// primitive is deliberately not exported from this module tree.

import type { MonetaryFact } from "./types";

export class FactVersionConflictError extends Error {
  constructor(factId: string, expectedSupersedesVersion: number, actualLatestVersion: number) {
    super(
      `CORRECT_FACT for "${factId}" declares supersedesVersion=${expectedSupersedesVersion}, ` +
        `but the latest known version is ${actualLatestVersion} — re-read the fact before correcting it`,
    );
    this.name = "FactVersionConflictError";
  }
}

/** Returns the fact with the highest `version` for a given `factId`, or undefined if none exists. */
export function resolveLatestFact(facts: readonly MonetaryFact[], factId: string): MonetaryFact | undefined {
  let latest: MonetaryFact | undefined;
  for (const fact of facts) {
    if (fact.factId !== factId) continue;
    if (!latest || fact.version > latest.version) latest = fact;
  }
  return latest;
}

/** Precomputes factId -> latest-version fact once, for O(1) lookup during rule evaluation. */
export function indexLatestFacts(facts: readonly MonetaryFact[]): ReadonlyMap<string, MonetaryFact> {
  const index = new Map<string, MonetaryFact>();
  for (const fact of facts) {
    const current = index.get(fact.factId);
    if (!current || fact.version > current.version) index.set(fact.factId, fact);
  }
  return index;
}
