// Test fixture (synthetic): fs_first_period_status payloads in the exact shape 20261223100000 returns. Used only by tests.
import type { Subject } from "./firstPeriodReview";
import { FIRST_PERIOD_NEXT_ACTIONS } from "@/lib/comparatives/firstPeriodNextActions";

const H = (c: string) => c.repeat(64);
export const CERT = { id: "00000000-0000-4000-8000-0000000000c1", kind: "certificate_of_incorporation", reference: "Certificate of incorporation CN-2026-0042", revision: 1,
  issuedOn: "2026-02-03", assertedDate: "2026-02-03", documentSha256: H("a"), note: null, recordedAt: "2026-03-01T09:00:00+00:00", recordedByYou: false } as const;

export const item = (code: string, detail: string | null = null) => ({ code, detail, nextAction: FIRST_PERIOD_NEXT_ACTIONS[code] ?? null });
export interface SubjectOver { state?: string; items?: ReturnType<typeof item>[]; claim?: boolean | { recordedByYou: boolean }; decision?: null | "verified" | "not_verified" | "withdrawn"; factIssues?: string[] }

export function subject(subject: Subject, o: SubjectOver = {}) {
  const items = o.items ?? [];
  const claim = o.claim === undefined || o.claim === false ? null : {
    id: "00000000-0000-4000-8000-0000000000a1",
    facts: subject === "first_period"
      ? { legalName: "Synthetic SME Limited", registrationNumber: "CN-2026-0042", basis: "incorporated_in_period", registrationDate: "2026-02-03", effectiveStart: "2026-02-03",
          reportingStart: "2026-02-03", reportingEnd: "2026-12-31", priorStatementsPrepared: false }
      : { basis: "nil_opening", bookkeepingStart: "2026-02-03" },
    basisText: "Incorporated on 3 February 2026; this is the entity's first period.", evidenceIds: [CERT.id], recordedAt: "2026-03-02T09:00:00+00:00",
    recordedByYou: typeof o.claim === "object" ? o.claim.recordedByYou : false,
  };
  const decision = !o.decision ? null : { id: "00000000-0000-4000-8000-0000000000d1", outcome: o.decision, reason: "Certificate agrees to the registration date.",
    ruleVersion: subject === "first_period" ? "first-period-rules/1" : "opening-balance-rules/1", decidedAt: "2026-03-03T09:00:00+00:00", decidedByYou: false };
  return {
    subject, rules: subject === "first_period" ? "first-period-rules/1" : "opening-balance-rules/1", state: o.state ?? (items.length ? "pending" : "verified"),
    factIssues: o.factIssues ?? [], pending: items.map((i) => (i.detail ? `${i.code}:${i.detail}` : i.code)), items,
    claimId: claim?.id ?? null, decisionId: decision?.id ?? null, binding: claim ? H("b") : null, claim, decision,
    cited: claim ? [{ id: CERT.id, kind: CERT.kind, reference: CERT.reference, revision: 1, issuedOn: CERT.issuedOn, assertedDate: CERT.assertedDate, documentSha256: CERT.documentSha256, current: true }] : [],
  };
}

export function fpStatus(first: ReturnType<typeof subject>, opening: ReturnType<typeof subject> = subject("opening_balances", { items: [item("OPENING_SUPPORT_MISSING")] }),
  extra: { legacy?: boolean; evidence?: unknown[]; period?: { reportingStart: string | null; reportingEnd: string | null } } = {}) {
  return {
    state: "evaluated", periodYear: 2026, entity: { legalName: "Synthetic SME Limited", tin: "123456789" },
    period: extra.period ?? { reportingStart: "2026-02-03", reportingEnd: "2026-12-31" },
    evidence: extra.evidence ?? [CERT], firstPeriod: first, openingBalances: opening,
    legacyDeclaration: extra.legacy ? { action: "declared", evidenceKind: "certificate_of_incorporation", evidenceRef: "Certificate no. 9", evidenceDate: "2018-03-02", recordedAt: "2026-01-05T09:00:00+00:00", satisfiesRequirement: false } : null,
  };
}
