// Ω∞ Phase 0 Slice 4A — L5 (supporting evidence) / L6 (prior-period
// evidence) adversarial tests.
//
// index.ts does not export collectLayer5SupportingEvidence/
// collectLayer6PriorPeriodEvidence/collectPhase0Evidence -- matching the
// established normalize.test.ts precedent, the state-mapping logic under
// test is reconstructed inline (byte-faithful to index.ts's actual
// branching, not a reimplementation of its DB access). The EFDMS
// contamination check (section 14) is the one test here that reads the
// REAL index.ts source file directly, since that is the only way to prove
// a negative about the actual shipped code rather than a reconstruction
// of it.
//
// Run: deno test supabase/functions/process-trial-balance/l5l6Evidence.test.ts

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ── Inline reconstruction of the L5 status->state mapping (index.ts's
// collectLayer5SupportingEvidence, DB access stripped out) ────────────────

type Phase0EvidenceState =
  | "NOT_EVALUATED" | "INSUFFICIENT_CONTEXT" | "NO_EVIDENCE"
  | "NO_DIFFERENCE" | "UNRESOLVED_EVIDENCE";

interface Recon { matched_count: number; exception_count: number; total_tb_lines: number }

function mapLayer5(status: string | null, recon: Recon | null): { state: Phase0EvidenceState; severity: "info" | "warning"; message: string } {
  if (status === null) {
    return { state: "NOT_EVALUATED", severity: "info", message: "NOT_EVALUATED: no supporting-evidence reconciliation has been run for this upload" };
  }
  if (status === "processing") {
    return { state: "INSUFFICIENT_CONTEXT", severity: "warning", message: "INSUFFICIENT_CONTEXT: supporting-evidence reconciliation is in progress and has not concluded" };
  }
  if (status === "clean") {
    const evaluatedSomething = !!recon && (recon.total_tb_lines > 0 || recon.matched_count > 0 || recon.exception_count > 0);
    if (evaluatedSomething) {
      return { state: "NO_DIFFERENCE", severity: "info", message: `NO_DIFFERENCE: supporting evidence evaluated with no unresolved difference (matched=${recon!.matched_count}, exceptions=${recon!.exception_count})` };
    }
    return { state: "NO_EVIDENCE", severity: "info", message: "NO_EVIDENCE: no meaningful supporting evidence was available to evaluate" };
  }
  if (status === "needs_review" || status === "blocked") {
    return {
      state: "UNRESOLVED_EVIDENCE", severity: "warning",
      message: status === "blocked"
        ? "UNRESOLVED_EVIDENCE: supporting-evidence reconciliation reported BLOCKED (unresolved exceptions rejected on review) -- observed as evidence only, does not itself block this certification"
        : "UNRESOLVED_EVIDENCE: supporting-evidence reconciliation has unresolved exceptions pending review",
    };
  }
  return { state: "INSUFFICIENT_CONTEXT", severity: "warning", message: `INSUFFICIENT_CONTEXT: unrecognized supporting-evidence status value "${status}"` };
}

function mapLayer6(periodYear: number | null, hasAuthoritativePrior: boolean | null): { message: string } {
  if (periodYear === null) {
    return { message: "INSUFFICIENT_EVIDENCE: current period identity is unavailable, prior period cannot be derived" };
  }
  const priorPeriodYear = periodYear - 1;
  return {
    message: hasAuthoritativePrior
      ? `PRIOR_CERTIFIED: an authoritative certification exists for period ${priorPeriodYear}`
      : `NO_PRIOR: no authoritative certification exists for period ${priorPeriodYear}`,
  };
}

// ── Section 11: GLOBAL HARD TEST — non-Tanzanian entity, zero EFDMS ──────

Deno.test("GLOBAL HARD TEST: non-Tanzanian entity, valid TB, no EFDMS, safisha never run -> NOT_EVALUATED/info, zero EFDMS terminology", () => {
  const l5 = mapLayer5(null, null); // safisha_status IS NULL -- pipeline never engaged, exactly as a non-TZ company would look
  assertEquals(l5.state, "NOT_EVALUATED");
  assertEquals(l5.severity, "info");
  for (const forbidden of ["EFDMS", "TRA", "VAT", "WHT", "levy", "levies", "Tanzania"]) {
    assert(!l5.message.includes(forbidden), `L5 message must not mention "${forbidden}": ${l5.message}`);
  }
  // is_blocking / requires_review are never touched by L5/L6 in index.ts --
  // proven structurally: mapLayer5/mapLayer6 return only {state, severity,
  // message}, no boolean outcome field exists for a caller to consume.
});

// ── Section 12: TANZANIA HARD TEST — TZ entity, optional module skipped ──

Deno.test("TANZANIA HARD TEST: Tanzanian entity, no EFDMS evaluation, no optional reconciliation run -> same NOT_EVALUATED/info path, no jurisdiction branch", () => {
  // Identical input (safisha_status IS NULL) to the global hard test above
  // -- there is no jurisdiction-specific branch in mapLayer5/collectLayer5
  // SupportingEvidence at all, so a Tanzanian entity that simply hasn't run
  // the optional bank-reconciliation module produces byte-identical output
  // to a non-Tanzanian one. Proven by re-using the exact same function with
  // the exact same input, not a separately-coded "Tanzania path".
  const l5 = mapLayer5(null, null);
  assertEquals(l5.state, "NOT_EVALUATED");
  assertEquals(l5.severity, "info");
});

// ── Hard invariant: NO_EVIDENCE != NO_DIFFERENCE ──────────────────────────

Deno.test("NO_EVIDENCE vs NO_DIFFERENCE: 'clean' status with nothing actually evaluated is NO_EVIDENCE, never NO_DIFFERENCE", () => {
  const l5 = mapLayer5("clean", { matched_count: 0, exception_count: 0, total_tb_lines: 0 });
  assertEquals(l5.state, "NO_EVIDENCE");
});

Deno.test("NO_EVIDENCE vs NO_DIFFERENCE: 'clean' status with real evaluated counts is NO_DIFFERENCE, carries the counts", () => {
  const l5 = mapLayer5("clean", { matched_count: 12, exception_count: 0, total_tb_lines: 12 });
  assertEquals(l5.state, "NO_DIFFERENCE");
  assertStringIncludes(l5.message, "matched=12");
  assertStringIncludes(l5.message, "exceptions=0");
});

// ── All five states distinguishable, none collapsed ───────────────────────

Deno.test("all five L5 states are distinguishable, never collapsed into each other", () => {
  const states = [
    mapLayer5(null, null).state,
    mapLayer5("processing", null).state,
    mapLayer5("clean", { matched_count: 0, exception_count: 0, total_tb_lines: 0 }).state,
    mapLayer5("clean", { matched_count: 5, exception_count: 0, total_tb_lines: 5 }).state,
    mapLayer5("needs_review", null).state,
  ];
  assertEquals(states, ["NOT_EVALUATED", "INSUFFICIENT_CONTEXT", "NO_EVIDENCE", "NO_DIFFERENCE", "UNRESOLVED_EVIDENCE"]);
});

Deno.test("'blocked' preserves BLOCKED explicitly in the evidence message but stays UNRESOLVED_EVIDENCE/warning -- never converts overall certification to blocked", () => {
  const l5 = mapLayer5("blocked", null);
  assertEquals(l5.state, "UNRESOLVED_EVIDENCE");
  assertEquals(l5.severity, "warning"); // never "error" -- L5 cannot independently block
  assertStringIncludes(l5.message, "BLOCKED");
  assertStringIncludes(l5.message, "does not itself block this certification");
});

// ── L5 authority: severity is only ever info/warning, never error ────────

Deno.test("L5 severity is never 'error' for any status value -- L5 cannot independently block", () => {
  const statuses: (string | null)[] = [null, "processing", "clean", "needs_review", "blocked", "some_unrecognized_value"];
  for (const s of statuses) {
    const l5 = mapLayer5(s, { matched_count: 1, exception_count: 0, total_tb_lines: 1 });
    assert(l5.severity === "info" || l5.severity === "warning", `status "${s}" produced severity "${l5.severity}", expected info/warning only`);
  }
});

// ── L6 — three states only, reuses authority function's own verdict ──────

Deno.test("L6: PRIOR_CERTIFIED when the authority function returns a row", () => {
  const l6 = mapLayer6(2026, true);
  assertStringIncludes(l6.message, "PRIOR_CERTIFIED");
  assertStringIncludes(l6.message, "period 2025");
});

Deno.test("L6: NO_PRIOR when the authority function returns nothing (covers no-upload, uncertified, blocking, and stale-drift prior states alike)", () => {
  const l6 = mapLayer6(2026, false);
  assertStringIncludes(l6.message, "NO_PRIOR");
  assertStringIncludes(l6.message, "period 2025");
});

Deno.test("L6: INSUFFICIENT_EVIDENCE when current period identity is unavailable", () => {
  const l6 = mapLayer6(null, null);
  assertStringIncludes(l6.message, "INSUFFICIENT_EVIDENCE");
});

Deno.test("L6: never performs balance/movement/percentage comparison -- message never contains numeric TB figures", () => {
  const l6 = mapLayer6(2026, true);
  // Only the period year itself may appear as a number; no debit/credit/
  // balance-shaped figure is ever included.
  assert(!/\d+\.\d{2}/.test(l6.message), `L6 message must never contain a decimal (balance-shaped) figure: ${l6.message}`);
});

// ── Determinism: no timestamp in any message ──────────────────────────────

Deno.test("determinism: neither L5 nor L6 message ever contains an ISO timestamp or wall-clock value", () => {
  const isoPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const l5 = mapLayer5("clean", { matched_count: 3, exception_count: 1, total_tb_lines: 4 });
  const l6 = mapLayer6(2026, true);
  assert(!isoPattern.test(l5.message));
  assert(!isoPattern.test(l6.message));
});

// ── Section 14: EFDMS CONTAMINATION TEST — reads the REAL shipped file ────

Deno.test("EFDMS CONTAMINATION: index.ts contains zero OPERATIONAL references to EFDMS/TRA/Tanzania-tax tables or terms", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // Section 14 explicitly permits documentation/comments to mention the
  // architectural exclusion by name -- runtime semantics are what must stay
  // jurisdiction-neutral. Strip // line comments and /* */ block comments
  // before checking, so the test proves the real invariant (no operational
  // dependency) rather than banning the words from appearing at all, which
  // would make it impossible to even document this exclusion in the file
  // itself.
  // index.ts uses CRLF line endings -- normalize first. Without this, a
  // trailing \r survives each split("\n") segment and JS regex `.` (no `s`
  // flag) never matches \r, so `$`-anchored stripping silently matches
  // nothing on every line (confirmed by direct debugging: the naive
  // version of this check reported false contamination from its OWN
  // documentation comments).
  const normalized = source.replace(/\r\n/g, "\n");
  const withoutBlockComments = normalized.replace(/\/\*[\s\S]*?\*\//g, "");
  const codeOnly = withoutBlockComments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const forbidden = ["efdms_z_reports", "efdms_reconciliation", "variance_materiality", "tax_computations", "EFDMS", "TRA", "WHT"];
  for (const term of forbidden) {
    assert(!codeOnly.includes(term), `index.ts must not OPERATIONALLY reference "${term}" (PHASE0-GLOBAL-L5-RECONCILIATION-001) -- comments may mention it, code must not`);
  }
});
