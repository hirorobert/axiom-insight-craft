// The known-defect ledger rules for characterization gates (H2). Pure; unit-tested in src/lib/__tests__/h2DefectLedger.test.ts.
//
// A registered defect probe is "reproduced" only when the observed value equals the ledger's exact signature AND differs from
// the independent oracle. Reproduced is never a pass: it is reported separately from requirements. Anything else fails:
//   fixed     observed equals the oracle (the defect is gone; the fixing PR must remove the ledger entry)
//   mismatch  observed equals neither (a different wrong value — an unregistered behaviour)
//   error     the probe threw (infrastructure or harness failure)

/** Stable JSON: object keys sorted at every depth. */
export function canon(v) {
  return JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
}

/** Validates the ledger shape; throws on any incomplete or duplicate entry. */
export function validateLedger(ledger) {
  if (!ledger || !Array.isArray(ledger.defects) || ledger.defects.length === 0) throw new Error("ledger has no defects");
  const seen = new Set();
  for (const d of ledger.defects) {
    if (!d || typeof d.probe !== "string" || typeof d.defect !== "string" || typeof d.assertion !== "string" || d.assertion.trim() === "") throw new Error(`ledger entry incomplete: ${JSON.stringify(d)}`);
    if (d.signature === undefined || d.signature === null) throw new Error(`ledger entry ${d.probe} has no signature`);
    if (seen.has(d.probe)) throw new Error(`ledger probe ${d.probe} is registered twice`);
    seen.add(d.probe);
  }
  return ledger;
}

/** Classifies one probe result against its ledger signature and its oracle. */
export function classifyProbe({ observed, signature, oracle }) {
  const o = canon(observed);
  if (o === canon(oracle)) return "fixed";
  if (o === canon(signature)) return "reproduced";
  return "mismatch";
}

/**
 * The gate verdict. Passes only when: no infrastructure failure; every required requirement ran and passed; every registered
 * probe ran and was reproduced exactly; no unregistered probe ran.
 */
export function gateVerdict({ requiredRequirements, requirementResults, registeredProbes, probeResults, infrastructureFailure }) {
  const failedRequirements = [...requirementResults].filter(([, ok]) => ok !== true).map(([id]) => id);
  const missingRequirements = requiredRequirements.filter((id) => !requirementResults.has(id));
  const badProbes = [...probeResults].filter(([, s]) => s !== "reproduced").map(([id, s]) => `${id}:${s}`);
  const missingProbes = registeredProbes.filter((id) => !probeResults.has(id));
  const unregisteredProbes = [...probeResults.keys()].filter((id) => !registeredProbes.includes(id));
  const ok = !infrastructureFailure && failedRequirements.length === 0 && missingRequirements.length === 0
    && badProbes.length === 0 && missingProbes.length === 0 && unregisteredProbes.length === 0;
  return { ok, failedRequirements, missingRequirements, badProbes, missingProbes, unregisteredProbes,
    reproduced: [...probeResults].filter(([, s]) => s === "reproduced").map(([id]) => id) };
}
