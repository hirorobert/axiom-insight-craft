/**
 * statementAggregationEngine.ts — Ω∞ public-sector / framework intelligence
 * engine, Slice 9: Financial Statement presentation mapping (Section XII).
 *
 * Pure aggregation, READ ONLY — no I/O, no Supabase, no writes. Implements
 * the pipeline Section XII mandates:
 *   Raw TB -> Account Nature -> Framework Presentation Mapping -> Statement
 *   Line -> Primary Statements
 * using the AccountNature/IpsasPresentationCode vocabulary already defined
 * in Slice 4 (museIpsasRulePack.ts) — deliberately NOT a second, parallel
 * classification concept (Section XXV: no duplicate authority).
 *
 * Scope: this slice implements the SFP-side invariant Section XII actually
 * lists first and most concretely — "Assets = Liabilities + Net Assets/
 * Equity" (with the period's surplus/deficit folding into net assets, since
 * a full-year trial balance's revenue/expense accounts ARE that movement).
 * Cash-opening-to-closing reconciliation, note-to-statement-line aggregation,
 * and comparative-value reconciliation are NOT implemented here — they
 * depend on Slices 10 (Cash Flow) and 11 (Disclosure/Movement) respectively,
 * which do not exist yet. Claiming those invariants here would be exactly
 * the false-completeness failure mode Section XVIII prohibits.
 */

import type { AccountNature, IpsasPresentationCode } from "./museIpsasRulePack";
import type { ClassificationOutcome } from "./museClassifier";

// ── Statement line aggregation ───────────────────────────────────────────────

export interface ClassifiedBalance {
  naturalAccountCode: string;
  accountNature: AccountNature;
  presentationCode: IpsasPresentationCode;
  debitAmount: number;
  creditAmount: number;
}

export interface StatementLineItem {
  presentationCode: IpsasPresentationCode;
  accountNature: AccountNature;
  /** Normal-balance-signed net amount — positive when the balance runs in its expected direction. */
  netAmount: number;
  accountCount: number;
}

export type SectionTotals = Record<AccountNature, number>;

export interface StatementPresentationResult {
  sectionTotals: SectionTotals;
  lineItems: StatementLineItem[];
  /** REVENUE - EXPENSE for the accounts supplied. */
  surplusForPeriod: number;
  /** ASSET - LIABILITY - NET_ASSETS(opening) - surplusForPeriod. Should be ~0. */
  accountingEquationVariance: number;
  accountingEquationHolds: boolean;
}

/**
 * Matches the ±1 TZS tolerance pattern already used elsewhere in this
 * codebase for balance-sheet-equation checks (PHASE-0 audit §5,
 * process-trial-balance/index.ts's checkBalanceSheetEquation) — reusing the
 * same tolerance convention rather than inventing a new one.
 */
const ACCOUNTING_EQUATION_TOLERANCE_TZS = 1;

/**
 * ASSET/EXPENSE are debit-normal; LIABILITY/NET_ASSETS/REVENUE are
 * credit-normal. Exported so Slice 10's cash-flow engines reuse this
 * exact convention instead of re-deriving it (Section XXV: no duplicate
 * authority).
 */
export function normalBalanceSign(nature: AccountNature): 1 | -1 {
  return nature === "ASSET" || nature === "EXPENSE" ? 1 : -1;
}

/**
 * Aggregate classified, balanced accounts into statement-line totals and
 * check the accounting equation. Callers supply already-classified accounts
 * (e.g. from museClassifier.ts) paired with their actual TB balances — this
 * function does no classification itself, only aggregation and reconciliation.
 */
export function aggregateStatementPresentation(
  balances: ClassifiedBalance[],
): StatementPresentationResult {
  const sectionTotals: SectionTotals = {
    ASSET: 0,
    LIABILITY: 0,
    NET_ASSETS: 0,
    REVENUE: 0,
    EXPENSE: 0,
  };
  const lineMap = new Map<string, StatementLineItem>();

  for (const b of balances) {
    const sign = normalBalanceSign(b.accountNature);
    const net = sign * (b.debitAmount - b.creditAmount);
    sectionTotals[b.accountNature] += net;

    const existing = lineMap.get(b.presentationCode);
    if (existing) {
      existing.netAmount += net;
      existing.accountCount += 1;
    } else {
      lineMap.set(b.presentationCode, {
        presentationCode: b.presentationCode,
        accountNature: b.accountNature,
        netAmount: net,
        accountCount: 1,
      });
    }
  }

  const surplusForPeriod = sectionTotals.REVENUE - sectionTotals.EXPENSE;
  const accountingEquationVariance =
    sectionTotals.ASSET - sectionTotals.LIABILITY - sectionTotals.NET_ASSETS - surplusForPeriod;

  return {
    sectionTotals,
    lineItems: Array.from(lineMap.values()),
    surplusForPeriod,
    accountingEquationVariance,
    accountingEquationHolds: Math.abs(accountingEquationVariance) <= ACCOUNTING_EQUATION_TOLERANCE_TZS,
  };
}

// ── Statement readiness gate (Section XII: never mark ready over a material gap) ──

export interface StatementReadiness {
  ready: boolean;
  unresolvedCount: number;
  unresolvedMaterialBalance: number;
  blockingReason?: string;
}

/**
 * "No statement may be marked ready while a material unresolved mapping
 * prevents a reliable total" (Section XII). Immaterial unresolved accounts
 * (below the caller-supplied threshold) do not block — this is "optimise
 * toward ZERO UNNECESSARY REVIEW", not zero review.
 */
export function assessStatementReadiness(
  outcomes: ClassificationOutcome[],
  balanceByCode: Map<string, number>,
  materialityThresholdTzs: number,
): StatementReadiness {
  const unresolved = outcomes.filter((o) => o.outcome === "UNRESOLVED");
  const unresolvedMaterialBalance = unresolved.reduce(
    (sum, o) => sum + Math.abs(balanceByCode.get(o.naturalAccountCode) ?? 0),
    0,
  );
  const ready = unresolvedMaterialBalance <= materialityThresholdTzs;

  return {
    ready,
    unresolvedCount: unresolved.length,
    unresolvedMaterialBalance,
    blockingReason: ready
      ? undefined
      : `${unresolved.length} unresolved account(s) totalling ${unresolvedMaterialBalance.toLocaleString()} ` +
        `TZS exceed the materiality threshold of ${materialityThresholdTzs.toLocaleString()} TZS.`,
  };
}
