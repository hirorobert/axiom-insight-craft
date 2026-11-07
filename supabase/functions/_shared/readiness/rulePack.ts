import type { ScopeFacts } from "./types.ts";

/**
 * The rule pack: which facts about a reporting scope REQUIRE which checks, and which findings are POSITIVE PROOF of each.
 * It is server data, versioned. The caller never supplies the list of required checks; it can only add to it.
 *
 * Nothing starts READY: a required scope is READY only when at least one proof rule below has passed for it (or a
 * confirmed finding is resolved by an effective correction) and no finding holds it.
 */
export interface RulePack {
  id: string; version: string;
  /** Scope kinds that cannot be evaluated without a General Ledger snapshot (spec §2.1). */
  glDependent(scope: string): boolean;
  proofRules(scope: string): string[];
  deriveRequired(facts: ScopeFacts | undefined, hasLedger: boolean): Set<string>;
}

export const PILOT_RULE_PACK: RulePack = {
  id: "rfr-pilot-ipsas-accrual", version: "1.0.0",
  glDependent: (s) => s.startsWith("cash:") || s.startsWith("suspense:") || s === "completeness:liabilities",
  proofRules(scope) {
    if (scope === "ledger") return ["LEDGER_TIEOUT"];
    if (scope.startsWith("cash:")) return ["CASH_TIES_TO_TB", "BANK_CLOSED_EVIDENCED", "DORMANT_BALANCE_CONFIRMED"];
    if (scope.startsWith("population:")) return ["BANK_POPULATION_CONFIRMED"];
    if (scope === "deposits") return ["DEPOSIT_HISTORY_EXPLAINED"];
    if (scope === "opening:equity") return ["OBE_CONTENT_VERIFIED"];
    if (scope.startsWith("opening:")) return ["OPENING_AGREES", "OPENING_DIFFERENCE_EXPLAINED"];
    if (scope.startsWith("suspense:")) return ["ENTRIES_SUPPORTED"];
    if (scope === "completeness:liabilities") return ["CUTOFF_SEARCH_COMPLETE"];
    if (scope === "payables") return ["CORRECTION_VERIFIED_IN_SOURCE", "CORRECTION_COMPLETED_BY_RESIDUAL", "CORRECTION_NOT_CORRECTED_IN_SOURCE", "OPENING_PAYABLE_SETTLEMENT_TESTED"];
    if (scope === "pack") return ["EVIDENCE_SINGLE_USE_OK"];
    if (scope === "rule_pack") return ["CITATIONS_VERIFIED"];
    return [];
  },
  deriveRequired(facts, hasLedger) {
    const r = new Set<string>(["pack", "rule_pack"]);
    const f = facts ?? {};
    for (const b of f.banks ?? []) r.add(`cash:${b}`);
    for (const b of f.banks_requiring_confirmation ?? []) r.add(`population:${b}`);
    if (f.deposits) r.add("deposits");
    for (const l of f.opening_lines ?? []) r.add(`opening:${l}`);
    if (f.opening_equity) r.add("opening:equity");
    for (const k of f.suspense_accounts ?? []) r.add(`suspense:${k}`);
    if (f.liabilities_completeness) r.add("completeness:liabilities");
    if (f.payables_settlement) r.add("payables");
    if (hasLedger) r.add("ledger");
    return r;
  },
};

/** Longest source-freshness attestation the server may issue (spec §9.3). */
export const FRESHNESS_MAX_MS = 10 * 60 * 1000;
