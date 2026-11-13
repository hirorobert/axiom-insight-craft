import type { Evidence, Extraction } from "../../../../supabase/functions/_shared/readiness/types";
import { isIsoDate } from "./amount";
import { IntakeError } from "./errors";
import { sha256Hex } from "./sha256";

/**
 * Evidence register: a JSON array of the documents the accountant holds and the facts each one states.
 *   [{ "id", "kind", "extraction", "facts": { "amount", "date", "ref", "counterparty", "account", "entry", ... },
 *      "file_name", "file_sha256" }]
 * `amount` facts are signed minor-unit strings; `date`, `period_start` and `period_end` facts are ISO dates. `ai_unconfirmed`
 * is accepted and kept (the engine ignores such facts until a person confirms them or they reproduce an independent control).
 * Errors name the record by position (1-based) in place of a line number.
 */
const EXTRACTIONS: readonly Extraction[] = ["human_confirmed", "reproduced", "ai_unconfirmed"];
export interface EvidenceDocument { id: string; file_name: string | null; file_sha256: string | null }
export interface EvidenceRegisterResult { evidence: Record<string, Evidence>; documents: EvidenceDocument[]; fileSha256: string }

export function parseEvidenceRegister(jsonText: string, file: string): EvidenceRegisterResult {
  let data: unknown;
  try { data = JSON.parse(jsonText); } catch (e) { throw new IntakeError(`not valid JSON (${(e as Error).message})`, file, 1); }
  if (!Array.isArray(data)) throw new IntakeError("the register must be a JSON array", file, 1);
  if (data.length === 0) throw new IntakeError("the register is empty (an empty register is not evidence)", file, 1);
  const evidence: Record<string, Evidence> = {};
  const documents: EvidenceDocument[] = [];
  data.forEach((raw, i) => {
    const n = i + 1;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new IntakeError("each record must be an object", file, n);
    const r = raw as Record<string, unknown>;
    const id = r.id;
    if (typeof id !== "string" || id.trim() === "") throw new IntakeError("id is required", file, n);
    if (Object.prototype.hasOwnProperty.call(evidence, id)) throw new IntakeError(`duplicate id "${id}"`, file, n);
    if (typeof r.kind !== "string" || r.kind.trim() === "") throw new IntakeError(`${id}: kind is required`, file, n);
    if (typeof r.extraction !== "string" || !(EXTRACTIONS as readonly string[]).includes(r.extraction)) throw new IntakeError(`${id}: extraction "${String(r.extraction)}" must be one of ${EXTRACTIONS.join(", ")}`, file, n);
    const facts: Record<string, string> = {};
    if (r.facts !== undefined) {
      if (typeof r.facts !== "object" || r.facts === null || Array.isArray(r.facts)) throw new IntakeError(`${id}: facts must be an object`, file, n);
      for (const [k, v] of Object.entries(r.facts as Record<string, unknown>)) {
        if (typeof v !== "string") throw new IntakeError(`${id}: fact "${k}" must be text`, file, n);
        if (k === "amount" && !/^-?\d+$/.test(v)) throw new IntakeError(`${id}: amount "${v}" is not a minor-unit string`, file, n);
        if ((k === "date" || k === "period_start" || k === "period_end") && !isIsoDate(v)) throw new IntakeError(`${id}: ${k} "${v}" is not an ISO date (YYYY-MM-DD)`, file, n);
        facts[k] = v;
      }
    }
    const sha = r.file_sha256;
    if (sha !== undefined && sha !== null && (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha))) throw new IntakeError(`${id}: file_sha256 must be 64 lower-case hex digits`, file, n);
    const name = r.file_name;
    if (name !== undefined && name !== null && typeof name !== "string") throw new IntakeError(`${id}: file_name must be text`, file, n);
    evidence[id] = { kind: r.kind, extraction: r.extraction as Extraction, facts };
    documents.push({ id, file_name: (name as string | undefined) ?? null, file_sha256: (sha as string | undefined) ?? null });
  });
  return { evidence, documents, fileSha256: sha256Hex(jsonText) };
}
