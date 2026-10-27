/**
 * Guidance for the account-correction journey (accountCorrection.ts): facts the check recorded, what could make a balance
 * legitimate, what decides it, and a writing aid for the reason. Pure; nothing here classifies an account, reads a name or
 * a balance side as accounting evidence, or changes a server decision. No classification or AI authority.
 *
 * Three kinds of words are kept apart on the page:
 *   FACT        what the certified check recorded (classification used, balance side, evidence tier) — from the finding row;
 *   POSSIBILITY what could make that fact legitimate, stated conditionally — a signal to review, never a conclusion;
 *   JUDGEMENT   what the reviewer decides, with what evidence — left to the person.
 * "Wrong" is never said, and nothing universal is claimed: the applicable framework's criteria and the reporting-date
 * facts decide, and the browser holds neither.
 */
import { classificationMeta, isClassification, type ClassificationValue } from "@/lib/accounting/classificationMeta";
import type { FindingRow } from "@/lib/closeReview/findings";
import { classificationWords } from "./reviewConfirmation";

/**
 * The amount sentence. Reclassification and correction of an amount are different things: the first changes which
 * category presents the account; the second is an adjustment (Close Review › Adjustments: a balanced, approved journal on
 * the authoritative trial balance — 20261015100000), offered only where that page is reachable. The uploaded amount is
 * never described as verified.
 */
export const AMOUNT_GUIDANCE = "Changing the classification does not change the uploaded amount. If the amount itself is wrong, that is an adjustment, not a reclassification: use the adjustment workflow.";

/** What each selectable category means, conditionally. Educational only; nothing here is a fact about the account being reviewed. */
export const CLASS_GUIDANCE: Record<ClassificationValue, string> = {
  current_assets: "Assets that meet the applicable framework's current criteria at the reporting date (typically realised, sold or consumed within the operating cycle or twelve months). A credit balance here is a signal to review, not evidence of an allowance or adjustment.",
  non_current_assets: "Assets that do not meet the current criteria at the reporting date, and the accounts that reduce them. An asset's cost, its accumulated depreciation (a credit against that cost) and the period's depreciation charge are three different balances.",
  current_liabilities: "Obligations that meet the applicable framework's current criteria at the reporting date (settlement due within the operating cycle or twelve months, or no unconditional right to defer). Maturity comes from the agreement and the reporting-date facts, not from the account name.",
  non_current_liabilities: "Obligations that do not meet the current criteria at the reporting date under the applicable framework. Check the agreement and any covenant, waiver or refinancing facts at the reporting date.",
  equity: "Owners' interests, such as share capital, reserves and retained earnings. The nature of the transaction behind the balance decides.",
  revenue: "Income from ordinary activities. An account whose name contains \"sales\" may still record a cost; what it records decides.",
  cost_of_goods_sold: "Costs of the goods or services sold in the period, where the entity presents such a line. An expense: a debit balance is expected.",
  operating_expenses: "Expenses of the period recognised in profit or loss, including the period's depreciation charge unless the applicable framework requires that charge to be included in the cost of another asset (for example inventory).",
  other_income: "Income presented separately from ordinary revenue under the applicable framework and the entity's activities.",
  taxes: "The period's tax expense. A tax balance owed or receivable at the reporting date is a liability or an asset, not the expense.",
};

const SIDE_WORDS: Record<"debit" | "credit", string> = { debit: "debit", credit: "credit" };

/** The side the classification expects (from the class table) and the side the balance is on (from the amounts). */
export function balanceSides(f: Pick<FindingRow, "classification" | "debit_minor" | "credit_minor">): { expected: "debit" | "credit" | null; actual: "debit" | "credit" | "zero" | null } {
  const expected = f.classification && isClassification(f.classification) ? classificationMeta(f.classification).normal_balance : null;
  if (f.debit_minor === null || f.credit_minor === null) return { expected, actual: null };
  let actual: "debit" | "credit" | "zero" | null = null;
  try {
    const d = BigInt(f.debit_minor), c = BigInt(f.credit_minor);
    actual = d > c ? "debit" : c > d ? "credit" : "zero";
  } catch { actual = null; }
  return { expected, actual };
}

/**
 * What recording a disposition on a warning does and does not establish — the current product's limitation, stated once.
 * A warning may be recorded as Explained, Accepted or Not applicable under the existing rules (findingResolved).
 */
export const DISPOSITION_LIMITS = "Recording a decision on the finding closes it under the current rules. It does not record a contra-account treatment, prove the balance or its presentation, replace required evidence or independent review, or settle other reporting requirements.";

export interface FindingGuidance {
  /** What the check recorded (FACT). */
  found: string;
  /** What could make that fact legitimate (POSSIBILITY, conditional), or null when the rule leaves no such case. */
  legitimateIf: string | null;
  /** What evidence decides it (JUDGEMENT left to the reviewer). */
  decides: string;
  /** What a classification correction does to THIS finding, and what it does not do. */
  correctionEffect: string;
  /** True when a classification correction cannot by itself close this finding and an explanation or review decision remains. */
  explanationRemains: boolean;
}

/**
 * The finding's guidance from its recorded facts only. `savedClassification` is the mapping's latest saved value (null
 * when none): when it differs from the one the check used, the correction is pending a re-check and the words say so.
 */
export function findingGuidance(f: Pick<FindingRow, "rule_id" | "classification" | "debit_minor" | "credit_minor" | "detail">, savedClassification: string | null): FindingGuidance {
  const used = f.classification ? classificationWords(f.classification) : "an unknown classification";
  const { expected, actual } = balanceSides(f);
  const onSide = actual === "debit" || actual === "credit" ? `a ${SIDE_WORDS[actual]} balance` : "a balance";
  const expectedWords = expected ? `${SIDE_WORDS[expected]} balance` : "balance on the class's normal side";
  const assetSide = f.classification === "current_assets" || f.classification === "non_current_assets";
  const expenseSide = f.classification === "cost_of_goods_sold" || f.classification === "operating_expenses" || f.classification === "taxes";

  if (f.rule_id === "A03") {
    return {
      found: `This account is designated as cash, was classified as ${used} (an asset), and the check recorded ${onSide}.`,
      legitimateIf: "If the account was genuinely overdrawn at the reporting date, the applicable framework may require it to be presented as a liability (an overdraft) rather than a negative asset.",
      decides: "The bank statement or confirmation at the reporting date, and whether the balance is one overdrawn account or several accounts netted together.",
      correctionEffect: "Classifying the account as a liability presents it as an overdraft; the next check then no longer raises this finding. Kept as an asset, the finding stays open: it is mandatory and is resolved only when an approved adjustment clears the credit balance.",
      explanationRemains: false,
    };
  }
  if (f.rule_id === "A10") {
    const tier = typeof f.detail?.evidenceTier === "number" ? f.detail.evidenceTier : null;
    const tierWords = tier === 4 ? "a keyword match (evidence tier 4)" : tier === 5 ? "a general rule (evidence tier 5)" : "an automatic suggestion";
    return {
      found: `The check certified this account as ${used} on ${tierWords}, not on a reviewed decision.`,
      legitimateIf: "The suggestion may be right; what is missing is a person's confirmation.",
      decides: "What the account records: the ledger, the chart of accounts or the underlying documents.",
      correctionEffect: "Saving a classification here (the same one or another) records a reviewed decision; the next check uses it and no longer raises this finding. An explanation on the finding records that you reviewed it without changing the classification.",
      explanationRemains: false,
    };
  }
  // A01: balance on the side opposite to its class.
  const legitimateIf = assetSide
    ? "A credit on an asset account may be legitimate where the account reduces a related asset (accumulated depreciation, an allowance) or where evidence supports a refund or overpayment due; the credit balance alone establishes none of these."
    : expenseSide
      ? "A credit on an expense account may be legitimate where evidence supports a recovery, refund or reversal larger than the period's charge."
      : (f.classification === "revenue" || f.classification === "other_income")
        ? "A debit on an income account may be legitimate where evidence supports returns, discounts or a reversal larger than the period's income."
        : (f.classification === "current_liabilities" || f.classification === "non_current_liabilities" || f.classification === "equity")
          ? "A debit on a liability or equity account may be legitimate where evidence supports an overpayment, an amount netted against it, or accumulated losses."
          : null;
  const pendingAnother = !!savedClassification && savedClassification !== f.classification;
  const correctionEffect = pendingAnother
    ? `The saved classification (${classificationWords(savedClassification!)}) has not been used by a check yet. If ${classificationWords(savedClassification!)} expects the side this balance is on, the next check no longer raises this finding; otherwise it is raised again and needs a decision.`
    : assetSide
      ? "If the account belongs to another category, correct it: the next check uses the saved category. If it stays an asset with a credit balance, this warning is raised again after the check; CFOClose records a confirmed treatment only for a current-asset closing-stock credit (Account review, \"keep as mapped\"), so for other asset credits the finding is closed by a decision on it."
      : "If the account belongs to a category whose normal side matches this balance, correct it: the next check uses the saved category and no longer raises this finding. If the category is right, record a decision on the finding instead.";
  return {
    found: `The check used ${used}, which expects a ${expectedWords}; the trial balance carries ${onSide} on this account.`,
    legitimateIf,
    decides: "What the account records and the evidence for the balance: the ledger, the register or schedule behind it, and the underlying documents. A name or a balance side is a signal to review, not evidence.",
    correctionEffect,
    explanationRemains: true,
  };
}

// ── The reason writing aid ──────────────────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER = "[describe what this account records and the evidence you checked]";
const PLACEHOLDER_RE = /\[describe what this account records and the evidence you checked\]/i;
/** The least a person must write beyond the template for the reason to count as theirs. */
export const REASON_AUTHORED_MIN = 10;

/** The opening the aid writes: the selected categories only (never evidence, never a checked document, never a review). */
export function correctionReasonDraft(previous: string | null, next: ClassificationValue): string {
  const from = previous && isClassification(previous) ? classificationWords(previous) : "the previous classification";
  return `Changing from ${from} to ${classificationWords(next)} because ${PLACEHOLDER}`;
}

/**
 * What the person wrote themselves: the template's opening and placeholder are not theirs. A reason is complete when the
 * placeholder is gone AND at least REASON_AUTHORED_MIN characters are the person's own. A template with the placeholder
 * deleted and nothing written is not a reason.
 */
export function authoredReason(reason: string): string {
  return reason.replace(PLACEHOLDER_RE, "").replace(/^\s*Changing from .+? to .+? because\s*/i, "").trim();
}
export function guidanceReasonComplete(reason: string): boolean {
  return !PLACEHOLDER_RE.test(reason) && authoredReason(reason).length >= REASON_AUTHORED_MIN;
}
