#!/usr/bin/env node
// Phase 5 — ACCOUNTING BOUNDARIES regression harness. Runnable: node research/phase5/tests/accounting_boundaries.test.mjs
// Invented data only — NO private amounts or documents, NO model training. Each case asserts a boundary the prototype must
// NEVER cross (fabricated authority, invented balancing entries, net presentation without a bridge, movement splits from two
// TBs, merged signed-prior/comparative figures, mutated historical artefacts), plus MUSE candidate-rule scoping.
import {
  prepaymentBridge, assessNetFromClosingOnly, netMovement, splitMovement, assertBalancedAdjustment,
  adjustedImbalance, classifyPriorRepresentation, linkCorrectedVersion, museObservation, BoundaryRefusal,
} from "../prototype/boundaries.mjs";

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d !== undefined ? `  — ${JSON.stringify(d, (k, v) => typeof v === "bigint" ? String(v) : v)}` : ""}`); } };
const group = (n) => console.log(`\n== ${n}`);
const refused = (fn) => { try { fn(); return null; } catch (e) { return e instanceof BoundaryRefusal ? e.code : e.message; } };

group("Prepayments require the three-component bridge (arithmetic agreement ≠ net-presentation authority)");
{
  const b = prepaymentBridge({ opening: 1200000, additions: 3600000, release: 300000 });
  check("with all three components, closing = opening + additions - release (exact BigInt)", b.closing === 4500000n && b.net_presentation_authorised === true, b);
  check("missing the release component → net presentation refused (bridge incomplete)",
    refused(() => prepaymentBridge({ opening: 1200000, additions: 3600000 })) === "NET_PRESENTATION_REQUIRES_THREE_COMPONENT_BRIDGE");
  check("a closing figure that merely agrees arithmetically does NOT authorise net presentation",
    assessNetFromClosingOnly().net_presentation_authorised === false);
}

group("Two TBs establish NET movement only — never gross additions, credit movements or a split");
{
  const m = netMovement(36000000, 45000000);
  check("net movement = closing - opening, labelled NET_MOVEMENT (not additions, not a split, not cash flow)",
    m.net === 9000000n && m.kind === "NET_MOVEMENT" && !m.is_gross_additions && !m.is_movement_split && !m.is_cash_flow, m);
  check("attempting to split a net movement into additions/disposals from two TBs is refused",
    refused(() => splitMovement()) === "MOVEMENT_SPLIT_REQUIRES_TRANSACTION_EVIDENCE");
}

group("Source imbalance survives a balanced adjustment; no balancing entry is invented");
{
  // Invented: source is out of balance by 30,000,000 (debit-heavy). A balanced adjustment (5,000,000 each side) is applied.
  const balanced = [{ debitMinor: 5000000, creditMinor: 0 }, { debitMinor: 0, creditMinor: 5000000 }];
  check("a balanced adjustment is accepted (Σdebit = Σcredit > 0, each line one side)", assertBalancedAdjustment(balanced).balanced === true);
  const r = adjustedImbalance(70000000, 40000000, balanced);
  check("the adjusted imbalance equals the source imbalance (the balanced layer cures nothing)",
    r.source_difference === 30000000n && r.adjustment_difference === 0n && r.adjusted_difference === 30000000n, r);
  check("an UNBALANCED adjustment is refused — the prototype never invents a balancing entry",
    refused(() => assertBalancedAdjustment([{ debitMinor: 5000000, creditMinor: 0 }])) === "UNBALANCED_ADJUSTMENT");
  check("a two-sided (not one-side-only) line is refused", refused(() => assertBalancedAdjustment([{ debitMinor: 1, creditMinor: 1 }])) === "ADJUSTMENT_LINE_ONE_SIDE_ONLY");
}

group("Signed prior figure is distinct from a comparative (source precision preserved)");
{
  const c = classifyPriorRepresentation({ signedInCurrentColumn: -4500000, comparativeColumnValue: 4200000 });
  check("a signed prior figure and a comparative figure are preserved separately, never merged",
    c.signed_prior_figure === -4500000n && c.comparative_figure === 4200000n && c.merged === false, c);
}

group("Corrected source is a linked immutable version; outputs re-evaluated; history unchanged");
{
  const link = linkCorrectedVersion({ version: "src-v1" }, { version: "src-v2" }, [{ id: "stmt-1" }, { id: "review-1" }]);
  check("the correction links a NEW version and leaves the original signed artefact unchanged", link.supersedes === "src-v1" && link.version === "src-v2" && link.original_unchanged === true);
  check("every dependent output is marked requires_revalidation (re-evaluated, not silently carried)", link.affected_outputs.every((o) => o.status === "requires_revalidation") && link.affected_outputs.length === 2);
  check("a correction that reuses the same version is refused (a correction must be a new version)",
    refused(() => linkCorrectedVersion({ version: "x" }, { version: "x" })) === "CORRECTION_REQUIRES_NEW_VERSION");
}

group("MUSE observations are candidate rules — scoped, evidenced, proposed; never global; approval ≠ reuse");
{
  const obs = museObservation({ entity: "co-A", chartVersion: "chart-2026.1", years: [2025, 2026], observation: "Account 1500 series is the motor-vehicle lifecycle", evidence: { kind: "FAR_schedule", ref: "synthetic" } });
  check("a MUSE observation is a CANDIDATE rule scoped to entity + chart version + years", obs.kind === "MUSE_CANDIDATE_RULE" && obs.scope.entity === "co-A" && obs.scope.chartVersion === "chart-2026.1" && obs.scope.years.length === 2);
  check("it carries evidence, is PROPOSED (not auto-applied), is not global, and reuse still needs context compatibility",
    obs.evidence && obs.status === "PROPOSED" && obs.is_global === false && obs.reuse_requires_context_compatibility === true);
  check("a MUSE observation without scope is refused", refused(() => museObservation({ observation: "x", evidence: {} })) === "MUSE_OBSERVATION_REQUIRES_SCOPE");
  check("a MUSE observation without evidence is refused", refused(() => museObservation({ entity: "co-A", chartVersion: "v1", years: [2026], observation: "x" })) === "MUSE_OBSERVATION_REQUIRES_EVIDENCE");
}

console.log(`\n${pass}/${pass + fail} accounting-boundary checks passed.`);
process.exit(fail ? 1 : 0);
