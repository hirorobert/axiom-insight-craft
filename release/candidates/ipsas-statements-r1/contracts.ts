/** Inert, JSON-only preparation boundary. Supplied confirmation identities are NOT authenticated authority. */
import { z } from "zod";
import { evidenceSchema, identifier, minor } from "../ipsas-accrual-r1/contracts";

const entry = z.object({ accountId: identifier, debitDeltaMinor: minor, creditDeltaMinor: minor }).strict();
const restatement = z.object({
  id: identifier, kind: z.enum(["error-correction", "policy-change", "presentation-reclassification"]),
  reason: z.string().trim().min(8).max(2000), authorityReference: z.string().trim().min(3).max(1000),
  evidence: evidenceSchema, openingBridgeId: identifier.nullable(), entries: z.array(entry).min(2).max(2000),
}).strict();
const noteRow = z.object({ id: identifier, label: z.string().trim().min(1).max(250),
  currentMinor: minor.nullable(), comparativeMinor: minor.nullable(), evidenceId: identifier }).strict();
const tie = z.object({ target: identifier, rowIds: z.array(identifier).min(1).max(1000) }).strict();
const note = z.object({ id: identifier, title: z.string().trim().min(1).max(250), requirementId: identifier,
  evidence: z.array(evidenceSchema).min(1).max(100), paragraphs: z.array(z.string().trim().min(1).max(4000)).max(30),
  rows: z.array(noteRow).max(1000), ties: z.array(tie).max(100),
}).strict();

export const statementSetInput = z.object({
  schema: z.literal("ipsas-statement-set-input/1"), preparation: z.unknown(),
  comparativeRestatements: z.array(restatement).max(100), notes: z.array(note).max(100),
  // A draft checklist, not an accountant-reviewed assertion of the complete requirement universe.
  requirements: z.array(z.object({ id: identifier, label: z.string().trim().min(1).max(250),
    applicability: z.enum(["applicable", "not-applicable", "unresolved"]),
    support: z.enum(["supported", "external-workpaper", "unsupported", "not-assessed"]),
    noteIds: z.array(identifier).max(100), evidence: evidenceSchema.nullable(),
  }).strict()).max(1000),
}).strict();
export type StatementSetInput = z.infer<typeof statementSetInput>;
export type StatementKind = "SFP" | "SFPERF" | "SCNA" | "SCF" | "SCBA";
export type Figure = { amountMinor: string | null; sourceRefs: string[] };
export type Row = { id: string; label: string; role: "detail" | "total"; section: string;
  current: Figure; asReported: Figure | null; comparative: Figure | null; noteIds: string[] };
export type Statement = { id: StatementKind; title: string; rows: Row[] };
export type Task = { code: string; target: string; action: string; acceptedEvidence: string; owner: "preparer" | "accounting-reviewer" | "technical-owner" };
