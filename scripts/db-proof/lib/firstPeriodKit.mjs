// Shared helpers for proofs that need a GENUINE, verified first reporting period (20261223100000; ported from PR #256): evidence revisions, the
// preparer's structured claim and a different approver's decision, all through the real functions as real users.
// Nothing here asserts; callers check the returned outcomes.
import crypto from "node:crypto";
import { uuid } from "./reportingKit.mjs";

export const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/**
 * The browser client reads fs_reporting_input through a schema that requires dates on a comparative; a first period has none ({state:"missing", periodYear}).
 * That limitation is in the pinned statement-compiler closure (src/lib/reporting/signoff.ts), so correcting it is a compiler release (its own PR). These proofs
 * test the SERVER's first-period controls, which need a saved version in a first-period workspace; this wrapper supplies the dates as null on a missing
 * comparative, in the HARNESS only, so the unchanged client can prepare that version. It adds nothing else and never touches a present comparative.
 */
export function withMissingComparativeDates(d) {
  if (process.env.FIRST_PERIOD_PRODUCT_CLIENT === "1") return d; // the compiler follow-up (20261228100000) proves the PRODUCT client reads a missing comparative itself
  return { ...d, rpc: async (fn, args) => {
    const r = await d.rpc(fn, args);
    if (fn === "fs_reporting_input" && r.data && r.data.comparative && r.data.comparative.state === "missing") {
      r.data.comparative = { reportingStart: null, reportingEnd: null, ...r.data.comparative };
    }
    return r;
  } };
}

/** Records one evidence revision as `uid`. */
export async function recordEvidence(db, uid, company, year, kind, reference, { issuedOn = "2026-06-01", asserted, document = reference, note = null, retract = false } = {}) {
  return (await db.asUser(uid, "SELECT public.fs_record_first_period_evidence($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,$10) r",
    [company, year, kind, reference, issuedOn, asserted ?? null, sha(document), note, retract, uuid()])).r;
}

/** A first-period claim as `uid`. */
export async function submitClaim(db, uid, company, year, subject, facts, basis, evidenceIds) {
  return (await db.asUser(uid, "SELECT public.fs_submit_first_period_claim($1,$2,$3,$4::jsonb,$5,$6::uuid[],$7) r",
    [company, year, subject, JSON.stringify(facts), basis, evidenceIds, uuid()])).r;
}

/** An approver's decision as `uid`. */
export async function decide(db, uid, company, year, subject, verify, reason = "Reviewed against the cited evidence") {
  return (await db.asUser(uid, "SELECT public.fs_decide_first_period($1,$2,$3,$4,$5,$6) r", [company, year, subject, verify, reason, uuid()])).r;
}

export const status = async (db, uid, company, year) => (await db.asUser(uid, "SELECT public.fs_first_period_status($1,$2) r", [company, year])).r;
/** The blockers exactly as a member sees them (fs_report_readiness runs fs_publication_blockers under the member's own session). */
export const blockersOf = async (db, uid, company, reportId, version) => (await db.asUser(uid, "SELECT public.fs_report_readiness($1,$2,$3) r", [company, reportId, version])).r.blockers;

/**
 * A genuine first period: an entity registered inside the reporting period, its certificate cited, its facts recorded by the
 * preparer and verified by a different approver. Returns the identifiers so a scenario can build on them.
 */
export async function verifyGenuineFirstPeriod(db, U, company, year, { name, start, end, registrationDate, effectiveStart = registrationDate, regNo = "CN-2026-0042", tin, commencementRef } = {}) {
  const cert = await recordEvidence(db, U.preparer, company, year, "certificate_of_incorporation", `Certificate of incorporation ${regNo}`, { asserted: registrationDate, issuedOn: registrationDate });
  const ids = [cert.evidenceId];
  let commencement = null;
  if (effectiveStart !== registrationDate) {
    commencement = await recordEvidence(db, U.preparer, company, year, "commencement_resolution", commencementRef ?? "Board resolution to commence trading", { asserted: effectiveStart, issuedOn: effectiveStart });
    ids.push(commencement.evidenceId);
  }
  const facts = { legalName: name, registrationNumber: regNo, basis: "incorporated_in_period", registrationDate, effectiveStart, reportingStart: start, reportingEnd: end, priorStatementsPrepared: false, ...(tin ? { tin } : {}) };
  const claim = await submitClaim(db, U.preparer, company, year, "first_period", facts, "Incorporated during the reporting period; the certificate establishes the registration date and no earlier period exists.", ids);
  const decision = await decide(db, U.partner, company, year, "first_period", true, "Certificate agrees to the registration date; period dates agree to the reviewed trial balance.");
  return { cert, commencement, claim, decision, facts, evidenceIds: ids };
}
