/**
 * computeCertificationReadiness — six-layer SAFISHA readiness, sourced from
 * the AUTHORITATIVE tb_certifications ledger (Slice 4B), not the mutable
 * trial_balance_uploads.processing_result projection computePreflight.ts
 * reads. Pure projection. No writes, no inference: a layer with no recorded
 * evidence is "pending" (NOT_COMPUTED), never silently "passed".
 *
 * Layer semantics are grounded in the exact `layer` values process-trial-
 * balance/index.ts actually assigns (SafishaExceptionRecord), not invented:
 *   L1 — file read/structured. Never itself an exception: a certification
 *        row can only exist after the file parsed, so its mere presence is
 *        the evidence for this layer.
 *   L2 — data quality (malformed numeric / parse-level errors).
 *   L3 — arithmetic integrity (TB imbalance AND statement/balance-sheet
 *        equation — both use layer 3 in the source of truth). Told apart by
 *        their recorded exception code only (classifyLayer3): debit/credit
 *        imbalance (TRIAL_BALANCE_IMBALANCE; legacy L3_TB_IMBALANCE), statement
 *        equation (BALANCE_SHEET_EQUATION_FAILED), or unknown — an unknown code
 *        keeps its recorded message and severity and is never read as clear.
 *        A row carrying ANY layer-3 exception is never "certified", even when
 *        get_authoritative_certification returned it (the engine records an
 *        equation failure as a non-blocking warning). No stored result proves
 *        the statement equation exactly: the earlier engine compared rounded
 *        floats, so a layer 3 with no exception says debits equal credits and
 *        that the equation is NOT EXACTLY VERIFIED — never that it holds.
 *   L4 — classification completeness (NEEDS_REVIEW / unresolved accounts).
 *   L5 — supporting evidence (generic bank/subledger reconciliation signal,
 *        Slice 4A). Informational only — never drives is_blocking/
 *        requires_review.
 *   L6 — prior-period signal (Slice 4A). Informational only, same as L5.
 *
 * Iron Dome: NULL means NOT COMPUTED. A fetch failure must never collapse
 * into "pending" (which means "nothing to report yet") or "certified" — it
 * gets its own "unknown" verdict so the UI never fabricates an answer.
 *
 * Upload-identity binding (DEFECT-SLICE4B-UPLOAD-IDENTITY-UNVERIFIED-001,
 * fixed here): get_authoritative_certification answers "what is
 * authoritative for this company/period?" — NOT "is that authority for the
 * upload currently on screen?". A user can view an older upload (history
 * panel / ?upload= deep link) while a DIFFERENT, newer upload for the same
 * company/period is the one actually certified. `authoritative` is only
 * ever treated as certifying the displayed upload when
 * `authoritative.upload_id === currentUploadId` — verified explicitly
 * below, never assumed from company+period matching alone. When it belongs
 * to a different upload, the verdict is "superseded", never "certified":
 * a real, currently-live certification exists, it is simply not for this
 * upload. This is NOT the same claim as "stale" (this upload's own
 * certification drifted) — conflating the two would fabricate a cause this
 * code cannot prove (no source/input hash comparison happens in React;
 * see the "stale" branch below).
 */

import type {
  PreflightCheck,
  PreflightCheckState,
  PreflightResult,
  PreflightVerdict,
} from "./computePreflight";

export interface TbCertificationExceptionRecord {
  code: string;
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  severity: "error" | "warning" | "info";
  accountCode: string | null;
  message: string;
}

export interface TbCertificationRow {
  id: string;
  sequence_no: number;
  company_id: string;
  upload_id: string;
  period_year: number | null;
  is_blocking: boolean;
  requires_review: boolean;
  exceptions: TbCertificationExceptionRecord[];
  certified_at: string;
}

export interface CertificationReadinessInput {
  /** False before any trial balance has ever been uploaded for this workspace/period. */
  uploadExists: boolean;
  /**
   * id of the upload currently displayed. Required, explicit input (never
   * inferred from closure state) — this is what `authoritative`/
   * `latestForUpload` are checked against before either can be presented as
   * authority for what is on screen.
   */
  currentUploadId: string | null;
  /**
   * get_authoritative_certification(company_id, period_year) result.
   * Present when a certification is eligible (not blocking, not
   * requires_review) AND current for THAT function's own company/period
   * scope — which may or may not be the upload currently displayed. Only
   * ever used to certify the displayed upload when
   * `authoritative.upload_id === currentUploadId`.
   */
  authoritative: TbCertificationRow | null;
  /**
   * Latest tb_certifications row committed for the CURRENT upload
   * specifically (always upload_id === currentUploadId by construction of
   * the query that produces it), regardless of eligibility. Null if no
   * certification was ever committed for this upload. Diagnostic only —
   * never treated as authoritative on its own, never used to produce a
   * "certified" verdict.
   */
  latestForUpload: TbCertificationRow | null;
  /** True if either read failed. Must win over every other field. */
  fetchFailed?: boolean;
  /**
   * PPG-1 Finding 1: true while useCertificationReadiness is (re)fetching —
   * covers both the initial load AND every revalidation triggered after a
   * mutation that can change certification truth (reprocess, decision
   * resolution). UI state is never certification authority on its own, but
   * it must also never keep presenting a PREVIOUSLY-fetched "certified"
   * verdict as current truth while a fresher read is in flight — that would
   * be exactly the stale-authority display this input exists to prevent.
   * Every other verdict (review/blocked/stale/superseded/unknown/pending)
   * is already conservative and is left untouched while revalidating; only
   * "certified" is downgraded, because it is the only verdict whose being
   * stale is unsafe rather than merely over-cautious.
   */
  revalidating?: boolean;
  /**
   * What the upload's own stored result recorded about the statement equation (readRecordedEquation on
   * processing_result). "failed" and "unreadable" are never reviewed, even when the certification carries no layer-3
   * exception for them. Omitted = not read (the certification alone decides).
   */
  recordedEquation?: RecordedEquation;
}

/**
 * The statement-equation record in the stored result (processing_result.validation_report.balance_sheet_equation),
 * read only from its own `passed` field — never computed from the recorded amounts:
 *   failed      passed === false: a recorded failure;
 *   not_failed  passed === true: no recorded failure (which does NOT prove the equation exactly);
 *   unreadable  passed present but not a boolean (null, a string, a number): malformed — held, never a pass;
 *   absent      no record, or a record without `passed`: nothing recorded either way.
 */
export type RecordedEquation = "failed" | "not_failed" | "unreadable" | "absent";

export function readRecordedEquation(processingResult: unknown): RecordedEquation {
  const obj = (v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const eq = obj(obj(obj(processingResult)?.validation_report)?.balance_sheet_equation);
  if (!eq || !("passed" in eq) || eq.passed === undefined) return "absent";
  return eq.passed === false ? "failed" : eq.passed === true ? "not_failed" : "unreadable";
}

/** The one sentence for a statement-equation failure recorded in the stored result itself. */
export const RECORDED_EQUATION_FAILURE = "The statement equation does not hold: the engine recorded a failure in this result.";
/** The one sentence for a stored statement-equation record that cannot be read. */
export const RECORDED_EQUATION_UNREADABLE = "The recorded statement-equation result could not be read, so this trial balance cannot be shown as reviewed.";

/** The reason a stored equation record holds a result for review, or null when it does not. */
export function recordedEquationHold(recorded: RecordedEquation | undefined): string | null {
  return recorded === "failed" ? RECORDED_EQUATION_FAILURE : recorded === "unreadable" ? RECORDED_EQUATION_UNREADABLE : null;
}

/**
 * tb_certifications.exceptions is JSONB NOT NULL DEFAULT '[]' with CHECK (jsonb_typeof(exceptions) = 'array')
 * (20260902130000); its elements are not shape-checked by the database. So [] is the one legitimate empty value, and a
 * row is MALFORMED when the list is not an array or an entry is not an object with a layer 1–6. Malformed findings are
 * never read as "no findings": the result is unknown, never certified.
 */
export function exceptionsMalformed(row: TbCertificationRow): boolean {
  if (!Array.isArray(row.exceptions)) return true;
  return row.exceptions.some((e) => e === null || typeof e !== "object" || Array.isArray(e) || ![1, 2, 3, 4, 5, 6].includes((e as { layer?: unknown }).layer as number));
}

const LAYER_META: Record<1 | 2 | 3 | 4 | 5 | 6, { id: string; label: string }> = {
  1: { id: "l1_structure", label: "File read and structured" },
  2: { id: "l2_data_quality", label: "Data quality" },
  3: { id: "l3_arithmetic", label: "Arithmetic integrity" },
  4: { id: "l4_classification", label: "Classification completeness" },
  5: { id: "l5_supporting_evidence", label: "Supporting evidence" },
  6: { id: "l6_prior_period", label: "Prior-period signal" },
};

const PASSED_DETAIL: Record<2 | 3 | 4, string> = {
  2: "No data-quality errors raised.",
  3: "Total debits equal total credits. Statement equation: not exactly verified (recorded by an earlier engine).",
  4: "All accounts are classified.",
};

/** Layer-3 exception codes, by what they record. Anything else is unknown and is never guessed at. */
export const LAYER3_PARITY_CODES: ReadonlySet<string> = new Set(["TRIAL_BALANCE_IMBALANCE", "L3_TB_IMBALANCE"]);
export const LAYER3_EQUATION_CODES: ReadonlySet<string> = new Set(["BALANCE_SHEET_EQUATION_FAILED"]);

/** How a layer-3 result is labelled: by the recorded code, never by the message text. */
export const LAYER3_LABEL = {
  parity: "Debits equal credits",
  equation: "Statement equation",
  unknown: "Arithmetic check",
} as const;
export type Layer3Kind = keyof typeof LAYER3_LABEL;

/** The statement equation's display wording wherever a stored result does not prove it exactly. */
export const EQUATION_NOT_EXACTLY_VERIFIED = "Not exactly verified — recorded by an earlier engine; re-check after the engine update.";

/** A row's layer-3 exceptions, split by recorded code. Order within each group is the recorded order. */
export function classifyLayer3(exceptions: readonly TbCertificationExceptionRecord[] | null | undefined): Record<Layer3Kind, TbCertificationExceptionRecord[]> {
  const out: Record<Layer3Kind, TbCertificationExceptionRecord[]> = { parity: [], equation: [], unknown: [] };
  for (const e of Array.isArray(exceptions) ? exceptions : []) {
    if (!e || e.layer !== 3) continue;
    const code = typeof e.code === "string" ? e.code : "";
    out[LAYER3_PARITY_CODES.has(code) ? "parity" : LAYER3_EQUATION_CODES.has(code) ? "equation" : "unknown"].push(e);
  }
  return out;
}

/** The kind a layer-3 check is shown as: debit/credit imbalance first, then the statement equation, then unknown. */
function layer3Kind(groups: Record<Layer3Kind, TbCertificationExceptionRecord[]>): Layer3Kind | null {
  return groups.parity.length ? "parity" : groups.equation.length ? "equation" : groups.unknown.length ? "unknown" : null;
}

/** "Assets (10.00) != Liabilities (8.00)" → "Assets (10.00) does not equal Liabilities (8.00)"; the code prefix removed. */
function recordedMessage(e: TbCertificationExceptionRecord): string {
  const m = typeof e.message === "string" ? e.message : "";
  return m.replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, "").replace(/\s*!=\s*/g, " does not equal ").trim();
}

/**
 * The plain reason a layer-3 exception gives for review or a block, naming what was recorded. An unknown code keeps
 * its recorded message; nothing is inferred about it.
 */
export function layer3Reason(e: TbCertificationExceptionRecord): string {
  const code = typeof e.code === "string" ? e.code : "";
  const recorded = recordedMessage(e);
  if (LAYER3_EQUATION_CODES.has(code)) return `The statement equation does not hold${recorded ? `: ${recorded}` : "."}`;
  if (LAYER3_PARITY_CODES.has(code)) return `Debits and credits do not agree${recorded ? `: ${recorded}` : "."}`;
  return recorded || `An arithmetic check recorded ${code || "an unidentified exception"}.`;
}

function buildLayerChecks(row: TbCertificationRow | null): PreflightCheck[] {
  return ([1, 2, 3, 4, 5, 6] as const).map((layer) => {
    const meta = LAYER_META[layer];

    if (!row) {
      return { id: meta.id, label: meta.label, state: "pending", detail: "Not checked yet." };
    }

    if (layer === 1) {
      // Never itself an exception source — a committed row is proof enough.
      return {
        id: meta.id,
        label: meta.label,
        state: "passed",
        detail: "Every row in the file was read and totalled.",
      };
    }

    const entries = exceptionsOf(row).filter((e) => e.layer === layer);
    // Layer 3 is labelled by what its recorded codes say (debits/credits, statement equation, or unknown).
    const label = layer === 3 && entries.length > 0 ? LAYER3_LABEL[layer3Kind(classifyLayer3(entries))!] : meta.label;

    if (entries.length === 0) {
      if (layer === 5 || layer === 6) {
        // Certifications committed before Slice 4A shipped this evidence
        // genuinely have nothing here — that is NOT_COMPUTED, not "clean".
        return { id: meta.id, label: meta.label, state: "pending", detail: "Not available for this certification." };
      }
      return { id: meta.id, label: meta.label, state: "passed", detail: PASSED_DETAIL[layer] };
    }

    const hasError = entries.some((e) => e.severity === "error");
    const hasWarning = entries.some((e) => e.severity === "warning");
    const hasUnknownSeverity = entries.some((e) => e.severity !== "error" && e.severity !== "warning" && e.severity !== "info");
    // Layer 3: an exception is never clear. An "info" or unknown-severity layer-3 entry is held for review, not passed.
    const state: PreflightCheckState = hasError ? "failed" : hasWarning ? "review" : layer === 3 || hasUnknownSeverity ? "review" : "passed";
    const detail = layer === 3 ? entries.map(layer3Reason).join(" ") : entries.map((e) => e.message).join(" ");
    return { id: meta.id, label, state, detail };
  });
}

/** A row's recorded exceptions. Only called on rows that are not malformed (exceptionsMalformed); never crashes. */
function exceptionsOf(row: TbCertificationRow): TbCertificationExceptionRecord[] {
  return Array.isArray(row.exceptions) ? row.exceptions.filter((e) => e !== null && typeof e === "object") : [];
}

/** The verdict for a row whose findings are malformed: unknown, never certified, never a crash. */
function malformedResult(): PreflightResult {
  const checks = buildLayerChecks(null);
  return {
    verdict: "unknown",
    headline: "Certification findings could not be read",
    blocker: "The recorded certification findings are not in the expected form, so this trial balance cannot be shown as reviewed.",
    checks,
    passedCount: 0,
    totalCount: checks.length,
  };
}

function layer3Entries(row: TbCertificationRow): TbCertificationExceptionRecord[] {
  return exceptionsOf(row).filter((e) => e.layer === 3);
}

function countPassed(checks: PreflightCheck[]): number {
  return checks.filter((c) => c.state === "passed").length;
}

export function computeCertificationReadiness(input: CertificationReadinessInput): PreflightResult {
  if (!input.uploadExists) {
    return {
      verdict: "pending",
      headline: "No trial balance imported yet",
      blocker: "Import a trial balance to start the pre-flight check.",
      checks: [],
      passedCount: 0,
      totalCount: 0,
    };
  }

  if (input.fetchFailed) {
    const checks = buildLayerChecks(null);
    return {
      verdict: "unknown",
      headline: "Could not verify certification status",
      blocker: "A connection problem prevented reading the authoritative certification. Try again.",
      checks,
      passedCount: 0,
      totalCount: checks.length,
    };
  }

  // Authority may only be attributed to the upload on screen. Company/period
  // matching alone (which is all get_authoritative_certification checks) is
  // not sufficient — verified explicitly here, not assumed.
  if (input.authoritative && input.authoritative.upload_id === input.currentUploadId) {
    if (exceptionsMalformed(input.authoritative)) return malformedResult();
    const checks = buildLayerChecks(input.authoritative);
    // A recorded layer-3 exception (the engine certifies an equation failure as a non-blocking warning) is never
    // certified: it is held for review, or blocked when recorded as an error, with the recorded reason.
    const l3 = layer3Entries(input.authoritative);
    if (l3.length > 0 && !input.revalidating) {
      const blocking = l3.find((e) => e.severity === "error");
      return {
        verdict: blocking ? "blocked" : "review",
        headline: blocking ? "Not reviewed — an arithmetic check failed" : "Not reviewed — an arithmetic check needs review",
        blocker: layer3Reason(blocking ?? l3[0]),
        checks,
        passedCount: countPassed(checks),
        totalCount: checks.length,
      };
    }

    if (input.revalidating) {
      // A fresher read is in flight after a certification-affecting
      // mutation — do not keep presenting this (possibly now-superseded)
      // "certified" verdict as current fact. The six-layer detail from the
      // last-known certification is kept visible (better than blanking the
      // panel), but the headline verdict is downgraded to "pending" until
      // the revalidation resolves one way or the other.
      return {
        verdict: "pending",
        headline: "Re-checking certification status…",
        blocker: "Confirming your recent change before certification is reconfirmed.",
        checks,
        passedCount: countPassed(checks),
        totalCount: checks.length,
      };
    }

    // A statement-equation failure recorded in the stored result itself is never certified either; the layer-3 check
    // shows it (debit/credit parity is a separate, recorded fact and is not changed here).
    const hold = recordedEquationHold(input.recordedEquation);
    if (hold) {
      const held = checks.map((c) => (c.id === "l3_arithmetic"
        ? { ...c, label: LAYER3_LABEL.equation, state: "review" as const, detail: hold }
        : c));
      return {
        verdict: "review",
        headline: "Not reviewed — an arithmetic check needs review",
        blocker: hold,
        checks: held,
        passedCount: countPassed(held),
        totalCount: held.length,
      };
    }

    return {
      verdict: "certified",
      headline: "Certified — safe to prepare statements",
      blocker: null,
      checks,
      passedCount: countPassed(checks),
      totalCount: checks.length,
    };
  }

  if (input.authoritative && input.authoritative.upload_id !== input.currentUploadId) {
    // A real, currently-live certification exists for this company/period —
    // just not for the upload being displayed. Diagnostic detail for THIS
    // upload (if any) still comes from latestForUpload, but the verdict can
    // never be "certified": that would attribute another upload's authority
    // to this one. No chronology is claimed ("newer") — only sequence_no
    // (certification order) is available here, not upload recency, and
    // conflating the two would be exactly the fabrication this hardening
    // pass exists to remove.
    const checks = buildLayerChecks(input.latestForUpload);
    return {
      verdict: "superseded",
      headline: "Not the current certified upload",
      blocker: "This trial balance is not the current certified upload for this period.",
      checks,
      passedCount: countPassed(checks),
      totalCount: checks.length,
    };
  }

  if (input.latestForUpload && input.latestForUpload.upload_id === input.currentUploadId) {
    const row = input.latestForUpload;
    if (exceptionsMalformed(row)) return malformedResult();
    const checks = buildLayerChecks(row);
    const passedCount = countPassed(checks);

    if (row.is_blocking) {
      const failing = exceptionsOf(row).find((e) => e.severity === "error");
      return {
        verdict: "blocked",
        headline: "Not certified — the trial balance does not hold",
        blocker: failing ? (failing.layer === 3 ? layer3Reason(failing) : failing.message) : "This trial balance failed certification.",
        checks,
        passedCount,
        totalCount: checks.length,
      };
    }

    if (row.requires_review) {
      const reviewItem = exceptionsOf(row).find((e) => e.layer === 4);
      // A recorded layer-3 reason is named first (it is never replaced by the generic classification text).
      const l3 = layer3Entries(row);
      const reasons = [...(l3.length ? [layer3Reason(l3.find((e) => e.severity === "error") ?? l3[0])] : []), ...(reviewItem ? [reviewItem.message] : [])];
      return {
        verdict: "review",
        headline: "Needs your decision before statements",
        blocker: reasons.length ? reasons.join(" ") : "Some accounts still need a classification decision.",
        checks,
        passedCount,
        totalCount: checks.length,
      };
    }

    // Eligible at commit time (not blocking, not requires_review), yet the
    // authoritative RPC found nothing for this company/period at all — so
    // no OTHER upload is certified either (that case was already handled
    // above). The exact cause is not provable here: React never compares
    // source_file_hash/normalized_input_hash (no such fields are even read
    // into TbCertificationRow), so wording must not claim a specific cause
    // ("the file changed") that isn't proven.
    return {
      verdict: "stale",
      headline: "Certification is no longer current",
      blocker: "This trial balance does not have a current authoritative certification.",
      checks,
      passedCount,
      totalCount: checks.length,
    };
  }

  // Upload exists; no certification has ever been committed for it yet.
  const checks = buildLayerChecks(null);
  return {
    verdict: "pending",
    headline: "Pre-flight check running",
    blocker: "Statements open once this trial balance is certified.",
    checks,
    passedCount: 0,
    totalCount: checks.length,
  };
}

export type { PreflightResult, PreflightVerdict, PreflightCheck, PreflightCheckState };
