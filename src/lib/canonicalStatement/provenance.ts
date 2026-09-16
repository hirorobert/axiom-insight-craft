// canonicalStatement/provenance.ts — append-only fact versioning.
//
// A MonetaryFact is never mutated. A correction produces a brand-new
// MonetaryFact object (version = supersedesVersion + 1) and is only ever
// added to a report's fact ledger alongside the CorrectFactDecision that
// justified it. `applyFactCorrection` returns a new report; it never
// mutates the one it was given.

import type { CanonicalFinancialStatementReport, CorrectFactDecision, MonetaryFact, ProvenanceRecord } from "./types";

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

/**
 * Appends a new, corrected MonetaryFact version to the report's fact
 * ledger. Never overwrites or removes the prior version — it remains in
 * `report.facts` for audit history. Throws FactVersionConflictError if the
 * decision's `supersedesVersion` is stale (someone else corrected the fact
 * first) rather than silently accepting an out-of-order correction.
 */
export function applyFactCorrection(
  report: CanonicalFinancialStatementReport,
  decision: CorrectFactDecision,
  provenance: ProvenanceRecord,
): CanonicalFinancialStatementReport {
  const latest = resolveLatestFact(report.facts, decision.factId);
  if (!latest) {
    throw new FactVersionConflictError(decision.factId, decision.supersedesVersion, -1);
  }
  if (latest.version !== decision.supersedesVersion || decision.newVersion !== decision.supersedesVersion + 1) {
    throw new FactVersionConflictError(decision.factId, decision.supersedesVersion, latest.version);
  }
  const correctedFact: MonetaryFact = {
    factId: decision.factId,
    version: decision.newVersion,
    value: decision.correctedValue,
    reportingPeriod: latest.reportingPeriod,
    signConvention: latest.signConvention,
    provenance,
    supersedesVersion: decision.supersedesVersion,
  };
  return { ...report, facts: [...report.facts, correctedFact] };
}
