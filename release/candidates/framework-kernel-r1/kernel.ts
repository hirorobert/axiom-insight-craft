/** Inert framework-kernel candidate. No production import, transport, writer or publication authority.
 * Authentication, authoritative source retrieval and transactional receipt persistence remain integration obligations.
 * A descriptor digest identifies declared content; it is NOT deployed-code attestation or accounting approval.
 */
import { z } from "zod";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { validateCanonicalReport } from "@/lib/canonicalStatement/validation";
import { evaluateComposedReport } from "@/lib/financialGeneration/composedReport";
import type { CanonicalFinancialStatementReport } from "@/lib/canonicalStatement/types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
});
const timestamp = z.string().datetime({ offset: true });
export const identitySchema = z.object({
  companyId: z.string().min(1).max(128), reportId: z.string().min(1).max(256), reportVersion: z.number().int().positive().safe(),
}).strict();
const referenceSchema = z.object({
  family: z.enum(["IFRS_FOR_SMES", "IFRS", "IPSAS_ACCRUAL", "IPSAS_CASH", "SYNTHETIC_TEST"]),
  packId: token, edition: token, revision: token,
}).strict();
const descriptorSchema = z.object({
  schema: z.literal("framework-kernel-descriptor/1"),
  pack: referenceSchema,
  canonicalKind: z.enum(["IFRS_FOR_SMES", "IFRS", "IPSAS_ACCRUAL", "IPSAS_CASH"]),
  // Boundary validation only: edition selection and jurisdiction adoption are NOT inferred here.
  periodStarts: z.object({ from: date, before: date.nullable() }).strict(),
  adapter: z.object({ id: token, version: token, sourceSha256: hash }).strict(),
  encodingSha256: hash,
}).strict().superRefine((d, ctx) => {
  if (d.periodStarts.before && d.periodStarts.before <= d.periodStarts.from) ctx.addIssue({ code: "custom", message: "empty period window" });
  if (d.pack.family !== "SYNTHETIC_TEST" && d.canonicalKind !== d.pack.family) ctx.addIssue({ code: "custom", message: "family mismatch" });
  if (d.pack.family === "SYNTHETIC_TEST" && !d.pack.packId.startsWith("test-only/")) ctx.addIssue({ code: "custom", message: "test namespace required" });
});
export type PackReference = z.infer<typeof referenceSchema>;
export type KernelDescriptor = z.infer<typeof descriptorSchema>;
export type KernelIdentity = z.infer<typeof identitySchema>;
const snapshotSchema = z.object({
  schema: z.literal("framework-kernel-snapshot/1"), identity: identitySchema,
  selection: referenceSchema.extend({ descriptorSha256: hash }).strict(),
  period: z.object({ start: date, end: date }).strict(),
  evaluatedAt: timestamp,
  payload: z.unknown().refine(v => v !== undefined, "source payload required"),
}).strict().superRefine((s, ctx) => {
  if (s.period.end < s.period.start) ctx.addIssue({ code: "custom", message: "reversed period" });
});
export type KernelSnapshot = z.infer<typeof snapshotSchema>;
export interface KernelAdapter {
  readonly descriptor: KernelDescriptor;
  /** Trusted, reviewed code, never supplied by a browser or selected by an arbitrary module path. */
  readonly assemble: (snapshot: KernelSnapshot) => Promise<CanonicalFinancialStatementReport> | CanonicalFinancialStatementReport;
}

export class KernelRefusal extends Error {
  constructor(readonly code: string) { super(code); this.name = "KernelRefusal"; }
}
const refuse = (code: string): never => { throw new KernelRefusal(code); };
const identityKey = (p: PackReference) => canonicalStringify(p);
function frozen<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const c of Object.values(v)) frozen(c);
    Object.freeze(v);
  }
  return v;
}
/** Lossless JSON boundary. Never silently strip undefined/functions, coerce non-finite values or permit hidden fields. */
function sourceCopy(v: unknown, depth = 0): unknown {
  if (depth > 128) return refuse("SOURCE_DEPTH_EXCEEDED");
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))) return v;
  if (Array.isArray(v)) return Array.from(v, c => sourceCopy(c, depth + 1));
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const k of Reflect.ownKeys(v)) {
      if (typeof k !== "string" || k === "__proto__") return refuse("SOURCE_NOT_JSON");
      const d = Object.getOwnPropertyDescriptor(v, k)!;
      if (!d.enumerable || !Object.hasOwn(d, "value")) return refuse("SOURCE_NOT_JSON");
      Object.defineProperty(out, k, { value: sourceCopy(d.value, depth + 1), enumerable: true, writable: true });
    }
    return out;
  }
  return refuse("SOURCE_NOT_JSON");
}

/** Append-only construction: a pack revision identifies exactly one descriptor; changes require another revision.
 * No mutable ACTIVE flag, browser activation parameter or production authorization is part of this proof registry.
 */
export function createProofRegistry(adapters: readonly KernelAdapter[]) {
  const entries = new Map<string, { descriptor: KernelDescriptor; digest: string; assemble: KernelAdapter["assemble"] }>();
  for (const adapter of adapters) {
    const parsed = descriptorSchema.safeParse(adapter.descriptor);
    if (!parsed.success || typeof adapter.assemble !== "function") refuse("INVALID_DESCRIPTOR");
    const descriptor = frozen(structuredClone(parsed.data));
    const key = identityKey(descriptor.pack);
    if (entries.has(key)) refuse("DUPLICATE_PACK_REVISION");
    entries.set(key, { descriptor, digest: sha256Hex(canonicalStringify(descriptor)), assemble: adapter.assemble });
  }
  const inventory = frozen([...entries.values()].map(e => ({ ...e.descriptor.pack, descriptorSha256: e.digest })));
  return Object.freeze({
    inventory,
    /** Pure compilation proof only: never saves a report, receipt, approval, FINAL or issued pack. */
    async compile(rawSnapshot: unknown, rawRequest: unknown) {
      // Validate and own the entire source BEFORE awaiting adapter work. A caller cannot change it mid-compilation.
      const detached = sourceCopy(rawSnapshot);
      const parsed = snapshotSchema.safeParse(detached);
      if (!parsed.success) refuse("INVALID_SOURCE_SNAPSHOT");
      const request = identitySchema.safeParse(sourceCopy(rawRequest));
      if (!request.success) refuse("INVALID_COMPILE_REQUEST");
      const snapshot = frozen(parsed.data);
      if (canonicalStringify(snapshot.identity) !== canonicalStringify(request.data)) refuse("SOURCE_SCOPE_MISMATCH");
      const { descriptorSha256, ...ref } = snapshot.selection;
      const entry = entries.get(identityKey(ref));
      if (!entry) refuse("PACK_REVISION_UNKNOWN");
      if (entry.digest !== descriptorSha256) refuse("PACK_DESCRIPTOR_CHANGED");
      const { from, before } = entry.descriptor.periodStarts;
      if (snapshot.period.start < from || (before && snapshot.period.start >= before)) refuse("EDITION_PERIOD_UNSUPPORTED");
      const sourceSnapshotSha256 = sha256Hex(canonicalStringify(snapshot));
      const assembled = structuredClone(await entry.assemble(snapshot));
      const canonical = validateCanonicalReport(assembled);
      // The base canonical validator strips extensions. Preserve the existing sign-off dependency binding explicitly.
      const deps = (assembled as CanonicalFinancialStatementReport & { reportingDependencies?: unknown }).reportingDependencies;
      const report = deps === undefined ? canonical : {
        ...canonical,
        reportingDependencies: z.object({ dependenciesSha256: hash, compositionSha256: hash,
          notesStatusSha256: hash.nullable(), comparativeStatusSha256: hash.nullable() }).strict().parse(deps),
      };
      if (canonicalStringify(report.reportIdentity) !== canonicalStringify(snapshot.identity)) refuse("ADAPTER_SCOPE_MISMATCH");
      if (report.framework.kind !== entry.descriptor.canonicalKind || report.framework.version !== entry.descriptor.pack.packId) refuse("ADAPTER_FRAMEWORK_MISMATCH");
      if (report.period.startDate !== snapshot.period.start || report.period.endDate !== snapshot.period.end) refuse("ADAPTER_PERIOD_MISMATCH");
      if (report.provenanceOrigin !== "TRIAL_BALANCE_DERIVED") refuse("ADAPTER_PROVENANCE_MISMATCH");
      const evaluation = evaluateComposedReport(report, () => snapshot.evaluatedAt);
      const documentSha256 = sha256Hex(canonicalStringify(report));
      const identity = {
        schema: "framework-kernel-proof/1", reportIdentity: snapshot.identity, selection: snapshot.selection,
        sourceSnapshotSha256, documentSha256, evaluationRunId: evaluation.evaluationRunId,
      } as const;
      const hasRuleFailures = evaluation.findings.some(f => f.outcome === "FAIL" || f.outcome === "INSUFFICIENT_EVIDENCE");
      return frozen({ ...identity, proofSha256: sha256Hex(canonicalStringify(identity)),
        outcome: hasRuleFailures ? "COMPILED_WITH_FINDINGS" as const : "COMPILED" as const,
        publicationAuthorized: false as const, document: report, evaluation, sourceSnapshot: snapshot });
    },
  });
}
