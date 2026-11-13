/**
 * Rows → engine input, and the orchestration of one readiness run.
 *
 * rfr_load_inputs (service role) returns the books as stored; buildReadinessInput turns them into the engine's input;
 * runReadinessCheck evaluates and records the result with rfr_record_run, which refuses a run made over rows that changed
 * after they were loaded. Nothing here reads the clock or the network except through the injected RPC.
 *
 * Input payload conventions (one row per family and key, stored as sent, hashed by the database):
 *   ledger_snapshot / gl   { snapshot, accounts: {accountKey: openingMinor}, entries: LedgerEntry[], postings?: Posting[], scope_limited? }
 *   bank_account / <id>    Bank
 *   evidence / <id>        Evidence
 *   opening_bridge / bridge, cutoff / cutoff, double_charge / double_charge, entry_support / entry_support,
 *   deposit / deposit, obe / obe, population / population      the engine's own shape of the same name
 *   citation / <id>        { rule, framework, provision, status }
 */
import { evaluateReadiness } from "./engine.ts";
import { big, str } from "./money.ts";
import type { AdjustmentRow, Bank, Cutoff, CorrectionVerification, DoubleCharge, Evidence, Ledger, Line, OpeningBridge, Period, ReadinessInput, ReadinessResult, ScopeFacts } from "./types.ts";

export interface LoadedInputs {
  state: "current" | "not_enabled" | "no_authority" | "period_unknown";
  contentSha256?: string; certificationId?: string;
  period?: { start: string; end: string; currency: string; exponent: number };
  scope?: { rulePackId: string; rulePackVersion: string; facts: ScopeFacts };
  accounts?: { key: string; code: string | null; name: string; classification: string; debitMinor: string; creditMinor: string }[];
  inputs?: { family: string; key: string; source: string; payload: Record<string, unknown> }[];
  adjustments?: { adjustmentId: string; correctionId: string; scope: string; reversesCorrection: string | null; anchor: string[]; lines: Line[] }[];
  corrections?: { correctionId: string; bundle: string | null; scope: string; anchor: string[]; supersedes?: string | null; binding: "applied" | "requires_revalidation" | "not_carried"; lines: Line[] }[];
}
export interface Posting { id: string; lines: Line[]; links?: string[] }
type Payloads = Record<string, Record<string, unknown>>;

export function buildReadinessInput(l: LoadedInputs): ReadinessInput {
  if (l.state !== "current" || !l.period || !l.scope || !l.accounts) throw new Error(`cannot build a readiness input from state ${l.state}`);
  const by = (family: string): Payloads => Object.fromEntries((l.inputs ?? []).filter((i) => i.family === family).map((i) => [i.key, i.payload]));
  const tbAccounts: Record<string, { closing: string }> = {};
  for (const a of l.accounts) tbAccounts[a.key] = { closing: str(big(a.debitMinor) - big(a.creditMinor)) };
  const one = <T>(family: string, key = family): T | undefined => by(family)[key] as T | undefined;
  const ledgerPayload = one<Ledger & { postings?: Posting[] }>("ledger_snapshot", "gl");
  const ledger: Ledger | null = ledgerPayload ? { snapshot: ledgerPayload.snapshot, scope_limited: ledgerPayload.scope_limited, accounts: ledgerPayload.accounts, entries: ledgerPayload.entries } : null;
  const banks = Object.values(by("bank_account")) as unknown as Bank[];
  const evidence = by("evidence") as unknown as Record<string, Evidence>;
  const citations = Object.values(by("citation")) as unknown as NonNullable<ReadinessInput["citations"]>;

  // Persisted approved adjustments that APPLY are the only adjustment rows the engine sees: one path.
  const reporting_adjustments: AdjustmentRow[] = (l.adjustments ?? []).map((a) => ({
    id: a.adjustmentId, correction_id: a.correctionId, approved: true, lines: a.lines, scope: a.scope, reverses: a.reversesCorrection,
  }));

  // Source verification: each approved correction is looked for in the ledger snapshot, as a bundle when it has one (a QuickBooks
  // journal fixes the NET of its bundle). The correction counts as applied for the verdict only when its adjustment applies.
  const correction_verification: CorrectionVerification[] = [];
  if (ledgerPayload?.postings) {
    const groups = new Map<string, NonNullable<LoadedInputs["corrections"]>>();
    for (const c of l.corrections ?? []) { const k = c.bundle ?? c.correctionId; const g = groups.get(k); if (g) g.push(c); else groups.set(k, [c]); }
    for (const [bundle, members] of groups) {
      const net = new Map<string, bigint>();
      for (const m of members) for (const ln of m.lines) net.set(ln.account, (net.get(ln.account) ?? 0n) + big(ln.amount));
      const effect: Line[] = [...net].filter(([, v]) => v !== 0n).map(([account, v]) => ({ account, amount: str(v) }));
      const anchor = [...new Set([bundle, ...members.flatMap((m) => [m.correctionId, ...m.anchor])])];
      // Applied corrections that supersede this bundle (or one of its members) carry the residual of a partial source fix.
      const ids = new Set([bundle, ...members.map((m) => m.correctionId)]);
      const superseding = (l.corrections ?? []).filter((c) => c.binding === "applied" && c.supersedes && ids.has(c.supersedes));
      const completed_by: Line[] | undefined = superseding.length ? superseding.flatMap((c) => c.lines) : undefined;
      for (const m of members) {
        correction_verification.push({ id: m.correctionId, scope: m.scope, effect, anchor, adjustment_approved: members.every((x) => x.binding === "applied"), ...(completed_by ? { completed_by } : {}),
          snapshot: { id: ledgerPayload.snapshot, postings: ledgerPayload.postings } });
      }
    }
  }

  return {
    period: l.period as Period,
    tb: { validated: true, accounts: tbAccounts },
    ledger, evidence, banks,
    scope_facts: l.scope.facts,
    population: one("population"), opening_bridge: one<OpeningBridge>("opening_bridge"), cutoff: one<Cutoff>("cutoff"),
    double_charge: one<DoubleCharge>("double_charge"), entry_support: one("entry_support"), deposit: one("deposit"), obe_reconstruction: one("obe"),
    citations: citations.length ? citations : undefined,
    reporting_adjustments, correction_verification: correction_verification.length ? correction_verification : undefined,
  };
}

export interface RpcLike { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }

export type CheckOutcome =
  | { outcome: "recorded"; runId: string; balancesAgree: boolean; result: ReadinessResult }
  | { outcome: "not_enabled" | "no_authority" | "period_unknown" | "input_changed" | "invalid_request" };

/** Load → evaluate → record. One retry when the books changed between the load and the record (the record refuses stale runs). */
export async function runReadinessCheck(db: RpcLike, companyId: string, periodYear: number): Promise<CheckOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await db.rpc("rfr_load_inputs", { p_company_id: companyId, p_period_year: periodYear });
    if (error) throw new Error(`rfr_load_inputs failed: ${error.message}`);
    const loaded = data as LoadedInputs;
    if (loaded.state !== "current") return { outcome: loaded.state };
    const result = evaluateReadiness(buildReadinessInput(loaded));
    const rec = await db.rpc("rfr_record_run", { p_company_id: companyId, p_period_year: periodYear, p_content_sha256: loaded.contentSha256, p_result: result });
    if (rec.error) throw new Error(`rfr_record_run failed: ${rec.error.message}`);
    const r = rec.data as { outcome: string; runId?: string; balancesAgree?: boolean };
    if (r.outcome === "recorded") return { outcome: "recorded", runId: r.runId as string, balancesAgree: r.balancesAgree === true, result };
    if (r.outcome !== "input_changed") return { outcome: r.outcome as "not_enabled" | "no_authority" | "invalid_request" };
  }
  return { outcome: "input_changed" };
}
