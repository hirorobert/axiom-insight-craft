/**
 * Guidance for the account-correction journey (accountCorrection.ts): facts the check recorded, what would make a
 * balance legitimate, what decides it, and a writing aid for the reason. Pure; nothing here classifies an account,
 * reads a name as accounting treatment, or changes a server decision.
 *
 * Three kinds of words are kept apart on the page:
 *   FACT        what the certified check recorded (classification used, balance side, evidence tier) — from the finding row;
 *   POSSIBILITY what can make that fact legitimate (e.g. a contra account) — stated as a possibility, never a conclusion;
 *   JUDGEMENT   what the reviewer decides, with what evidence — left to the person.
 * "Wrong" is never said: a name is not evidence, and the browser holds no evidence beyond the finding's own facts.
 */
import { classificationMeta, isClassification, type ClassificationValue } from "@/lib/accounting/classificationMeta";
import type { FindingRow } from "@/lib/closeReview/findings";
import { classificationWords } from "./reviewConfirmation";

/**
 * The amount sentence. The uploaded amount is never described as verified: a classification changes how the account is
 * presented, not what was uploaded. An amount that is itself wrong is an adjustment (Close Review › Adjustments: a balanced,
 * approved journal on the authoritative trial balance — 20261015100000), offered only where that page is reachable.
 */
export const AMOUNT_GUIDANCE = "Changing the classification does not change the uploaded amount. If the amount itself is wrong, use the adjustment workflow.";

/** What each selectable category means. Educational only; nothing here is a fact about the account being reviewed. */
export const CLASS_GUIDANCE: Record<ClassificationValue, string> = {
  current_assets: "Resources expected to be realised or used within the operating cycle or the next year. A credit balance on a current asset can be legitimate for an allowance or a closing-stock adjustment; the evidence decides.",
  non_current_assets: "Longer-term resources such as property, plant and equipment, and the accounts that reduce them. Accumulated depreciation is a credit against the related asset; it is not this year's depreciation expense (an operating expense) and not the asset's cost.",
  current_liabilities: "Obligations due within the operating cycle or the next year under the applicable framework. A name alone does not establish when a loan is due: the agreement and the reporting-date rights decide.",
  non_current_liabilities: "Obligations that meet the applicable framework's non-current criteria at the reporting date. Check the agreement and the reporting-date rights; do not infer maturity from the account name.",
  equity: "Owners' interests, such as share capital, reserves and retained earnings. Check the nature of the transaction behind the balance.",
  revenue: "Income from ordinary activities. The cost of goods sold is an expense category even when its name contains \"sales\".",
  cost_of_goods_sold: "Costs of the goods or services sold in the period. An expense category; a debit balance is expected.",
  operating_expenses: "Costs of running the business, such as rent, salaries and this year's depreciation expense. Accumulated depreciation is not an expense: it sits against the related asset.",
  other_income: "Income presented separately from ordinary revenue under the applicable framework and the entity's activities.",
  taxes: "Tax expense of the period. A tax balance owed is a liability, not the period's tax expense.",
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

export interface FindingGuidance {
  /** What the check recorded (FACT). */
  found: string;
  /** When that fact can be legitimate (POSSIBILITY), or null when the rule leaves no such case. */
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
      legitimateIf: "A bank account genuinely overdrawn at the reporting date is a liability (an overdraft), not a negative asset.",
      decides: "The bank statement or confirmation at the reporting date, and whether the balance is one overdrawn account or several accounts netted together.",
      correctionEffect: "Classifying the account as a liability presents it as an overdraft; the next check then no longer raises this finding. Keeping it as an asset leaves this finding open: it is mandatory and is resolved only when an approved adjustment clears the credit balance.",
      explanationRemains: false,
    };
  }
  if (f.rule_id === "A10") {
    const tier = typeof f.detail?.evidenceTier === "number" ? f.detail.evidenceTier : null;
    const tierWords = tier === 4 ? "a keyword match (evidence tier 4)" : tier === 5 ? "a general rule (evidence tier 5)" : "an automatic suggestion";
    return {
      found: `The check certified this account as ${used} on ${tierWords}, not on a reviewed decision.`,
      legitimateIf: "The suggestion may well be right; what is missing is a person's confirmation.",
      decides: "What the account records: the ledger, the chart of accounts or the underlying documents.",
      correctionEffect: "Saving a classification here (the same one or another) records a reviewed decision; the next check uses it and no longer raises this finding for this account. An explanation on the finding records that you reviewed it without changing the classification.",
      explanationRemains: false,
    };
  }
  // A01: balance on the side opposite to its class.
  const legitimateIf = assetSide
    ? "A credit on an asset account is legitimate when the account reduces a related asset — accumulated depreciation, an allowance for doubtful debts, or a closing-stock adjustment — or when the balance is a refund or overpayment."
    : expenseSide
      ? "A credit on an expense account can be legitimate for a recovery, a refund or a reversal larger than the period's charge."
      : (f.classification === "revenue" || f.classification === "other_income")
        ? "A debit on an income account can be legitimate for returns, discounts or a reversal larger than the period's income."
        : (f.classification === "current_liabilities" || f.classification === "non_current_liabilities" || f.classification === "equity")
          ? "A debit on a liability or equity account can be legitimate for an overpayment, a receivable netted against it, or accumulated losses."
          : null;
  const pendingAnother = !!savedClassification && savedClassification !== f.classification;
  const correctionEffect = pendingAnother
    ? `The saved classification (${classificationWords(savedClassification!)}) has not been used by a check yet. If ${classificationWords(savedClassification!)} expects the side this balance is on, the next check no longer raises this finding; otherwise it is raised again and needs an explanation.`
    : assetSide
      ? "If the account belongs to another category, correct it: the next check uses the saved category. If it is an asset-reducing account that stays an asset, the balance stays on the unexpected side and this warning is raised again after the check — CFOClose records a confirmed treatment only for a current-asset closing-stock credit (Account review, \"keep as mapped\"); for every other asset credit, the finding is closed by recording your explanation on it."
      : "If the account belongs to a category whose normal side matches this balance, correct it: the next check uses the saved category and no longer raises this finding. If the category is right and the balance is legitimate, record your explanation on the finding instead.";
  return {
    found: `The check used ${used}, which expects a ${expectedWords}; the trial balance carries ${onSide} on this account.`,
    legitimateIf,
    decides: "What the account records and the evidence for the balance: the ledger, the register or schedule behind it, and the underlying documents. A name alone does not establish the treatment.",
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
