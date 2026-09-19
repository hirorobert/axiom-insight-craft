// Rule — the cash ledger is complete, account by account.
//
// The cash-flow statement is generated from a transaction ledger the preparer supplied. Rule 6 v2
// tests only that its NET result reaches the closing cash of the trial balance. That cannot tell a
// complete ledger from an incomplete one whose omissions happen to offset. This rule tests every
// established cash account separately:
//
//   movement recorded in the ledger for the account  =  movement of the account's balance
//                                                       between the two reviewed trial balances
//
// and reports any ledger row naming an account the cash review did not establish. It reads only
// facts the generator wrote (financialGeneration/cashLedgerAuthority.ts); it adjusts nothing and
// never reports a pass it could not compute (a missing input is INSUFFICIENT_EVIDENCE).

import { equalsWithinTolerance, formatMoney, subtractMoney } from "../money";
import { resolveFact } from "./shared";
import type { RuleContext, RuleDefinition, RuleEvaluationResult } from "./ruleEngine";

export const CASH_LEDGER_AUTHORITY_NOTE_ID = "note:cash-ledger-authority";
const EXPECTATION = "for every established cash account, the ledger movement equals the movement of the account's balance between the reviewed trial balances; no ledger row names any other account";

export const cashLedgerRollforwardRule: RuleDefinition = {
  ruleId: "cashflow-account-rollforward",
  ruleVersion: "1.0.0",
  title: "Cash ledger completeness (account rollforward)",
  evaluate(ctx: RuleContext): readonly RuleEvaluationResult[] {
    const note = ctx.report.notes.find((n) => n.noteId === CASH_LEDGER_AUTHORITY_NOTE_ID);
    if (!note) {
      return [{ outcome: "NOT_APPLICABLE", failureSeverity: "INFORMATIONAL", observedValues: {}, expectedRelationship: EXPECTATION, deterministicCalculation: "the report carries no cash ledger authority note (no ledger-derived cash flow)", evidenceReferences: [], affected: {}, remediationGuidance: "No action required.", discriminator: "no-ledger" }];
    }
    const affected = { noteId: note.noteId };
    const ids = note.monetaryFactIds;
    const ofRole = (role: string) => ids.filter((id) => id.startsWith(`fact:cashroll:${role}:`)).sort();
    const ledgerIds = ofRole("ledger");
    const orphanIds = ofRole("orphan");
    const results: RuleEvaluationResult[] = [];

    if (ledgerIds.length === 0 && orphanIds.length === 0) {
      return [{ outcome: "INSUFFICIENT_EVIDENCE", failureSeverity: "CRITICAL", observedValues: {}, expectedRelationship: EXPECTATION, deterministicCalculation: "the cash ledger could not be checked account by account: no established cash account was available", evidenceReferences: [], affected, remediationGuidance: "Supply a cash account map (or review exactly one account as cash) so the ledger can be tested account by account.", discriminator: "no-accounts" }];
    }

    for (const id of orphanIds) {
      const f = resolveFact(ctx, id);
      results.push({
        outcome: "FAIL",
        failureSeverity: "CRITICAL",
        observedValues: { orphanMovement: { kind: "MONEY", value: f.status === "PRESENT" ? f.money : null } },
        expectedRelationship: EXPECTATION,
        deterministicCalculation: f.status === "PRESENT" ? `ledger rows name an account that is not an established cash account (movement ${formatMoney(f.money)})` : "ledger rows name an account that is not an established cash account",
        evidenceReferences: [{ evidenceReferenceId: `${id}`, factId: id, noteId: note.noteId }],
        affected,
        remediationGuidance: "Correct the account code on those ledger rows, or add the account to the cash account map if it is genuinely a cash account. Nothing is reassigned automatically.",
        discriminator: id,
      });
    }

    for (const id of ledgerIds) {
      const key = id.slice("fact:cashroll:ledger:".length);
      const tbId = `fact:cashroll:tb:${key}`;
      const led = resolveFact(ctx, id);
      const tb = resolveFact(ctx, tbId);
      if (led.status !== "PRESENT" || tb.status !== "PRESENT") {
        results.push({
          outcome: "INSUFFICIENT_EVIDENCE",
          failureSeverity: "CRITICAL",
          observedValues: { ledgerMovement: { kind: "MONEY", value: led.status === "PRESENT" ? led.money : null }, trialBalanceMovement: { kind: "MONEY", value: tb.status === "PRESENT" ? tb.money : null } },
          expectedRelationship: EXPECTATION,
          deterministicCalculation: "the trial-balance movement of this cash account could not be established (a balance is missing in one of the two periods)",
          evidenceReferences: [{ evidenceReferenceId: id, factId: id, noteId: note.noteId }],
          affected,
          remediationGuidance: "Provide the account's balance in both reviewed trial balances; nothing is assumed in its place.",
          discriminator: id,
        });
        continue;
      }
      const same = led.money.currency === tb.money.currency && led.money.scale === tb.money.scale;
      const pass = same && equalsWithinTolerance(led.money, tb.money, ctx.tolerance);
      results.push({
        outcome: same ? (pass ? "PASS" : "FAIL") : "INSUFFICIENT_EVIDENCE",
        failureSeverity: "CRITICAL",
        observedValues: { ledgerMovement: { kind: "MONEY", value: led.money }, trialBalanceMovement: { kind: "MONEY", value: tb.money }, difference: { kind: "MONEY", value: same ? subtractMoney(led.money, tb.money) : null } },
        expectedRelationship: EXPECTATION,
        deterministicCalculation: same ? `ledger movement ${formatMoney(led.money)} vs trial-balance movement ${formatMoney(tb.money)}${pass ? "" : ` — difference ${formatMoney(subtractMoney(led.money, tb.money))}`}` : "denominated differently — cannot compare",
        evidenceReferences: [
          { evidenceReferenceId: `${id}:ledger`, factId: id, noteId: note.noteId },
          { evidenceReferenceId: `${id}:tb`, factId: tbId, noteId: note.noteId },
        ],
        affected,
        remediationGuidance: pass ? "No action required." : "The ledger is not complete for this account (a missing, duplicated or mis-stated row). Correct the ledger evidence; the difference is reported, never adjusted.",
        discriminator: id,
      });
    }
    return results;
  },
};
