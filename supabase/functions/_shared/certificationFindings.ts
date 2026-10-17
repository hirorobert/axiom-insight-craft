/**
 * certificationFindings — a certification's COMPLETE findings and the bounded summary kept on the certification row
 * (migration 20261107100000_certification_findings_capacity.sql).
 *
 * The complete findings are stored, in order, in tb_certification_findings. tb_certifications.exceptions holds them
 * verbatim when they fit SUMMARY_BUDGET_BYTES; otherwise a summary: for every kind of finding (layer, code, severity) up
 * to SUMMARY_EXAMPLES_PER_KIND verbatim examples, and, when any of that kind is left out, ONE count record carrying the
 * same layer, code and severity plus {"summary": {"omitted", "total"}}. Every kind is therefore represented, so readers
 * that look for an error or for a layer's presence see every unresolved finding. tb_finalize_attempt refuses a summary
 * that does not agree with the findings. Pure; no I/O.
 */

export interface CertificationFinding {
  code: string;
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  severity: "error" | "warning" | "info";
  accountCode: string | null;
  message: string;
}

export interface FindingCountRecord extends CertificationFinding {
  summary: { omitted: number; total: number };
}

export type SummaryEntry = CertificationFinding | FindingCountRecord;

/** The summary's size bound, in bytes of JSON text. The column CHECK is 65,536 bytes of stored jsonb (uncompressed). */
export const SUMMARY_BUDGET_BYTES = 32_768;
export const SUMMARY_EXAMPLES_PER_KIND = 5;

const encoder = new TextEncoder();
const bytesOf = (v: unknown) => encoder.encode(JSON.stringify(v)).length;
const kindOf = (f: CertificationFinding) => `${f.layer}|${f.code}|${f.severity}`;

function countRecord(first: CertificationFinding, omitted: number, total: number): FindingCountRecord {
  return {
    code: first.code, layer: first.layer, severity: first.severity, accountCode: null,
    message: `${omitted} more ${omitted === 1 ? "finding" : "findings"} of this kind ${omitted === 1 ? "is" : "are"} recorded in full with this certification (${total} in total).`,
    summary: { omitted, total },
  };
}

export class FindingsSummaryTooLarge extends Error {
  constructor() { super("FINDINGS_SUMMARY_TOO_LARGE"); }
}

/**
 * The entries for tb_certifications.exceptions. `summarized` is false exactly when they are the findings themselves.
 * Examples are added one per kind in turn (first findings first) while the budget allows; they keep recorded order,
 * and each kind's count record follows the examples.
 */
export function summarizeFindings(findings: readonly CertificationFinding[], budget = SUMMARY_BUDGET_BYTES): { exceptions: SummaryEntry[]; summarized: boolean } {
  if (bytesOf(findings) <= budget) return { exceptions: [...findings], summarized: false };

  const kinds = new Map<string, number[]>();
  findings.forEach((f, i) => { const k = kindOf(f); (kinds.get(k) ?? kinds.set(k, []).get(k)!).push(i); });

  const kept = new Map<string, number>([...kinds.keys()].map((k) => [k, 0]));
  const build = () => {
    const examples = [...kinds.entries()].flatMap(([k, idx]) => idx.slice(0, kept.get(k)!)).sort((a, b) => a - b).map((i) => findings[i]);
    const counts = [...kinds.entries()]
      .filter(([k, idx]) => kept.get(k)! < idx.length)
      .map(([k, idx]) => countRecord(findings[idx[0]], idx.length - kept.get(k)!, idx.length));
    return [...examples, ...counts];
  };

  let current = build();
  if (bytesOf(current) > budget) throw new FindingsSummaryTooLarge();
  for (let round = 0; round < SUMMARY_EXAMPLES_PER_KIND; round++) {
    for (const [k, idx] of kinds) {
      if (kept.get(k)! !== round || round >= idx.length) continue;
      kept.set(k, round + 1);
      const next = build();
      if (bytesOf(next) <= budget) current = next;
      else kept.set(k, round);
    }
  }
  return { exceptions: current, summarized: true };
}

/** True for a count record written by summarizeFindings. */
export function isFindingCountRecord(e: unknown): e is FindingCountRecord {
  return !!e && typeof e === "object" && "summary" in (e as Record<string, unknown>);
}
