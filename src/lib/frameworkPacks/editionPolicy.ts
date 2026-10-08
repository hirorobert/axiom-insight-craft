// frameworkPacks/editionPolicy.ts — which IFRS for SMEs edition a report applies. Pure. Any server-side copy of this
// decision must reproduce the table below exactly and be pinned to it by a test.
//
//   period START unknown                       → refused (no default edition, ever)
//   period start before 2017-01-01             → refused: earlier editions are not encoded
//   period start on or after 2027-01-01        → third edition (2025) — mandatory
//   otherwise                                  → 2015 edition, unless an early-application election of the third edition
//                                                is recorded WITH a jurisdiction confirmation reference; then 2025, and the
//                                                early-application disclosure becomes applicable.
//
// Jurisdiction: the IASB permits earlier application, but a national regulator may not (in Tanzania, no NBAA
// pronouncement adopting the third edition was found on 2026-10-08). The election therefore carries the reference of the
// confirmation that the jurisdiction permits it; without one, early application is refused.

import { IFRS_FOR_SMES_2015, IFRS_FOR_SMES_2025 } from "./ifrsForSmes";
import type { FrameworkPack } from "./types";

export interface EarlyApplicationElection {
  readonly edition: "2025";
  /** Reference of the confirmation that the reporting jurisdiction permits early application (pronouncement, circular, regulator letter). */
  readonly jurisdictionConfirmation: string;
}

export type EditionDecision =
  | { readonly state: "resolved"; readonly pack: FrameworkPack; readonly earlyApplication: boolean }
  | { readonly state: "refused"; readonly reason: "PERIOD_START_UNKNOWN" | "EDITION_UNSUPPORTED" | "EARLY_APPLICATION_UNCONFIRMED" };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date in YYYY-MM-DD (2026-02-30 is refused, not rolled over). */
function isCalendarDate(s: string | null | undefined): s is string {
  if (!s || !ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function resolveIfrsForSmesEdition(periodStart: string | null | undefined, election: EarlyApplicationElection | null = null): EditionDecision {
  if (!isCalendarDate(periodStart)) return { state: "refused", reason: "PERIOD_START_UNKNOWN" };
  if (periodStart < IFRS_FOR_SMES_2015.edition.effectiveForPeriodsBeginningOnOrAfter) return { state: "refused", reason: "EDITION_UNSUPPORTED" };
  if (periodStart >= IFRS_FOR_SMES_2025.edition.effectiveForPeriodsBeginningOnOrAfter) return { state: "resolved", pack: IFRS_FOR_SMES_2025, earlyApplication: false };
  if (election) {
    if (!election.jurisdictionConfirmation || election.jurisdictionConfirmation.trim().length < 3) return { state: "refused", reason: "EARLY_APPLICATION_UNCONFIRMED" };
    return { state: "resolved", pack: IFRS_FOR_SMES_2025, earlyApplication: true };
  }
  return { state: "resolved", pack: IFRS_FOR_SMES_2015, earlyApplication: false };
}
