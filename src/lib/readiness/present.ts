/**
 * Plain-language issues from a readiness result: ONE issue per held scope, each with the exact figures, what is already
 * held, the exact inputs still missing, and ONE next action. Pure and deterministic; it reads the result, never the books.
 *
 * Rules for the words: no internal engine names and no statutory wording (those belong in a jurisdiction pack), figures are
 * formatted from minor units without floating point, and a rule this module does not know still yields an issue with a
 * generic next action. Nothing a held scope has is ever dropped.
 */
import type { DoubleCharge, Evidence, Finding, Line, ReadinessResult } from "../../../supabase/functions/_shared/readiness/types";

export interface PresentContext {
  currency?: string; exponent?: number;
  accountNames?: Record<string, string>;
  evidence?: Record<string, Evidence | undefined>;
  doubleCharge?: DoubleCharge;
  cashAccounts?: string[];
  periodEnd?: string;
}
export type NextActionKind = "upload_evidence" | "confirm_facts" | "review_correction" | "decide" | "map_account";
export interface NextAction { kind: NextActionKind; label: string; request: string }
export interface CorrectionView { id: string; summary: string; lines: Line[]; effectInWords: string }
export interface Issue {
  scope: string; group: string; headline: string; evidenceHeld: string[]; missing: string[];
  nextAction: NextAction; correction?: CorrectionView; relatedCorrections: CorrectionView[]; rules: string[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function dateInWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}
export function formatMinor(minor: string, ctx: PresentContext = {}): string {
  const x = ctx.exponent ?? 2;
  const neg = minor.startsWith("-");
  const digits = (neg ? minor.slice(1) : minor).padStart(x + 1, "0");
  const whole = digits.slice(0, digits.length - x).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = x === 0 ? whole : `${whole}.${digits.slice(digits.length - x)}`;
  return `${ctx.currency ? `${ctx.currency} ` : ""}${neg ? "-" : ""}${body}`;
}

export function groupOf(scope: string): string {
  if (scope === "ledger" || scope.startsWith("suspense:")) return "Ledger";
  if (scope.startsWith("cash:") || scope.startsWith("population:") || scope === "deposits") return "Cash";
  if (scope.startsWith("opening:")) return "Opening balances";
  if (scope === "payables") return "Payables";
  if (scope === "completeness:liabilities") return "Unrecorded liabilities";
  if (scope === "rule_pack") return "Rule pack";
  return "Evidence";
}

const RANK: Record<string, number> = { evidence_missing: 0, incomplete: 0, confirmed: 1, suspected: 2 };
const PASS_WORDS: Record<string, string> = {
  LEDGER_TIEOUT: "The General Ledger reproduces the trial balance", STATEMENT_DUPLICATE_IGNORED: "A duplicate statement file was ignored", STATEMENT_OVERLAP_CONSISTENT: "Overlapping statement files agree",
  SUPPLIED_PAGES_MATCHED: "The pages supplied were matched", OPENING_AGREES: "The opening balance agrees to the approved figure", OPENING_DIFFERENCE_EXPLAINED: "The opening difference is explained by a document that states it",
  DEPOSIT_MOVEMENT: "A deposit movement is evidenced", CUTOFF_SEARCH_COMPLETE: "The search after year end is complete", BANK_RECONCILIATION_CLEAN_NOT_COMPLETENESS: "The bank reconciliation is clean (it does not test unrecorded liabilities)",
  OBE_ARITHMETIC: "The opening equity figure was reproduced arithmetically", BANK_POPULATION_CONFIRMED: "The bank confirmed every account it holds", TIMING_ITEM_CLEARED: "An outstanding item cleared after year end",
  CORRECTION_DUPLICATE_IGNORED: "A repeated submission of a correction counted once", CORRECTION_REVERSED: "A correction was reversed",
};
const SIGNALS_UNCHECKED: Record<string, { what: string; import: string[] }> = {
  ledger: { what: "whether the General Ledger reproduces the trial balance", import: ["The General Ledger for the period"] },
  payables: { what: "whether any payment settled an approved opening payable and was charged to expense", import: ["The General Ledger for the period", "The bank statement", "The approved prior-year figures"] },
  "completeness:liabilities": { what: "whether goods received before year end were invoiced after it and left unrecorded", import: ["The payments listing after year end", "The supplier invoice register after year end"] },
  deposits: { what: "the history of the deposits", import: ["Deposit certificates or the bank's confirmation"] },
  "opening:equity": { what: "what makes up the opening equity", import: ["The opening journal entries and the General Ledger of the equity account"] },
  pack: { what: "that one document supports one reported balance", import: ["The evidence register"] },
  rule_pack: { what: "that the rules rest on verified provisions", import: ["A verified citation register"] },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const asNum = (v: unknown): string | undefined => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
const FACT_PROBLEM = /^(missing_fact|fact_mismatch|extraction_unconfirmed|wrong_kind|outside_window)/;
const nameOf = (a: string, ctx: PresentContext) => ctx.accountNames?.[a] ?? a;

function correctionView(id: string, lines: Line[], ctx: PresentContext): CorrectionView {
  const side = (l: Line) => (l.amount.startsWith("-") ? "Credit" : "Debit");
  const summary = lines.map((l) => `${side(l)} ${nameOf(l.account, ctx)} ${formatMinor(l.amount.replace(/^-/, ""), ctx)}`).join("; ");
  const cashTouched = lines.some((l) => (ctx.cashAccounts ?? ["1020"]).includes(l.account));
  const dc = ctx.doubleCharge;
  let effect: string;
  if (dc && id === dc.correction_id) effect = `Lowers this year's ${nameOf(dc.expense_account, ctx).toLowerCase()} expense by ${formatMinor(dc.amount, ctx)} and settles the opening payable. Cash does not change.`;
  else effect = `Records ${summary}. ${cashTouched ? "Changes cash." : "Cash does not change."}`;
  return { id, summary, lines, effectInWords: effect };
}

interface Described { headline: string; missing: string[]; evidenceHeld?: string[]; action: NextAction; correctionId?: string }

function describe(f: Finding, r: ReadinessResult, ctx: PresentContext): Described {
  const d = (f.detail ?? {}) as Record<string, unknown>;
  const money = (v: unknown) => formatMinor(String(v), ctx);
  const upload = (label: string, request: string): NextAction => ({ kind: "upload_evidence", label, request });
  const why = typeof d.why === "string" ? d.why : "";
  switch (f.rule) {
    case "LEDGER_REQUIRED": case "OPENING_NOT_COMPARED": case "ENTRY_SUPPORT_NOT_RUN": case "MATCH_NOT_RUN": case "CUTOFF_LEDGER_NOT_RELIED": case "ENTRY_SUPPORT_NOT_RELIED": case "LEDGER_NOT_RELIED": {
      const req = asNum(d.request) ?? "General Ledger detail for the period (an export of every transaction)";
      return { headline: "This check needs the General Ledger, which has not been imported or does not reproduce the trial balance.", missing: ["General Ledger detail for the period that reproduces the trial balance"], action: upload("Import the General Ledger", req) };
    }
    case "LEDGER_TIEOUT_FAILED": {
      const accts = (Array.isArray(d.accounts) ? d.accounts : []) as { account: string; reason: string; ledger?: string; tb?: string }[];
      const parts = accts.map((a) => (a.reason === "population" ? `${nameOf(a.account, ctx)} is not in both the ledger and the trial balance` : `${nameOf(a.account, ctx)}: ledger ${money(a.ledger)} against trial balance ${money(a.tb)}`));
      const allPop = accts.length > 0 && accts.every((a) => a.reason === "population");
      return { headline: `The General Ledger does not reproduce the trial balance. ${parts.join("; ")}.`, missing: ["A General Ledger that reproduces every trial balance account"],
        action: allPop ? { kind: "map_account", label: "Match every ledger account to a trial balance account", request: parts.join("; ") } : upload("Import the complete General Ledger", "A General Ledger export for the whole period whose balances equal the trial balance") };
    }
    case "BANK_ACCOUNT_UNRESOLVED": return { headline: `A bank account (${f.scope.replace("cash:", "")}) appears in your records but is not part of the books.`, missing: ["The ledger account for this bank account, or evidence that it is closed"], action: { kind: "map_account", label: "Choose the ledger account for this bank account", request: "Match the bank account to a ledger account" } };
    case "BANK_ACCOUNT_NOT_IN_LEDGER": return { headline: "A bank account has statements but no account in your ledger, so its balance cannot be reported yet.", missing: ["The ledger account this bank account belongs to"], action: { kind: "map_account", label: "Choose the ledger account for this bank account", request: "Match the bank account to a ledger account" } };
    case "BANK_POPULATION_UNCONFIRMED": return { headline: "The bank has not confirmed every account it holds for you.", missing: [asNum(d.request) ?? "The bank's confirmation of every account held at period end"], action: upload("Upload the bank's confirmation", asNum(d.request) ?? "Confirmation listing every account held at period end") };
    case "BANK_CLOSURE_UNEVIDENCED": return { headline: "This bank account is recorded as closed, but no closure letter states it.", missing: ["A closure letter naming the account, dated before the period starts"], action: FACT_PROBLEM.test(why) ? { kind: "confirm_facts", label: "Confirm what the closure letter states", request: why } : upload("Upload the closure letter", "A bank closure letter naming the account and its date") };
    case "STATEMENT_OVERLAP_CONFLICT": return { headline: `Two statement files cover the same days and disagree${Array.isArray(d.files) ? ` (${(d.files as string[]).join(" and ")})` : ""}.`, missing: [], action: { kind: "decide", label: "Decide which statement is right", request: "Compare the two files and withdraw the one that is wrong" } };
    case "RUNNING_BALANCE_BREAK": return { headline: `The printed balances on ${asNum(d.file) ?? "the statement"} do not follow from its rows at ${dateInWords(String(d.at))}: the rows give ${money(d.expected)}, the statement prints ${money(d.printed)}.`, missing: [`The missing or misread page of ${asNum(d.file) ?? "the statement"} around ${dateInWords(String(d.at))}`], action: upload("Upload the missing page", `The page of ${asNum(d.file) ?? "the statement"} that covers ${dateInWords(String(d.at))}`) };
    case "STATEMENT_PAGES_MISSING": {
      const pages = (Array.isArray(d.pages) ? d.pages : []) as number[];
      const missing = pages.map((p) => `Page ${p} of ${asNum(d.of) ?? "?"} of ${asNum(d.file) ?? "the statement"}`);
      return { headline: `${asNum(d.file) ?? "The statement"} is incomplete: ${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")} of ${asNum(d.of) ?? "?"} ${pages.length === 1 ? "is" : "are"} missing, so the closing balance is not evidenced.`, missing, action: upload(`Upload ${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")}`, missing.join("; ")) };
    }
    case "STATEMENT_COVERAGE_GAP": {
      const gap = d.gap as { from: string; to: string } | undefined;
      const span = gap ? `${dateInWords(gap.from)} to ${dateInWords(gap.to)}` : "part of the period";
      return { headline: `The statements do not cover ${span}.`, missing: [`A statement or bank confirmation for ${span}`], action: upload("Upload the missing statement", `A statement or bank confirmation for ${span}`) };
    }
    case "MATCH_AMBIGUOUS": return { headline: "Two bank rows could be the same ledger entry, so none was matched automatically.", missing: [], action: { kind: "decide", label: "Choose the matching bank row", request: `Ledger entry ${asNum(d.entry) ?? ""} has ${asNum(d.candidates) ?? "several"} possible bank rows` } };
    case "TIMING_ITEM_UNSUPPORTED": return { headline: "An outstanding item has not been shown to clear after year end.", missing: [asNum(d.request) ?? "The next statement showing the item"], action: FACT_PROBLEM.test(why) ? { kind: "confirm_facts", label: "Confirm what the statement states", request: `${why}: ${asNum(d.request) ?? ""}` } : upload("Upload the later statement", asNum(d.request) ?? "A statement after year end showing the item") };
    case "BOOK_ENTRY_UNMATCHED": return { headline: `Ledger entry ${asNum(d.entry) ?? ""} has no bank row.`, missing: [], action: { kind: "decide", label: "Explain or correct the entry", request: `No bank row matches ledger entry ${asNum(d.entry) ?? ""}` } };
    case "BANK_ROW_UNMATCHED": return { headline: `A bank row of ${money(d.amount)} on ${dateInWords(String(d.date))} has no ledger entry.`, missing: [], action: { kind: "decide", label: "Record or explain the bank row", request: `No ledger entry matches the bank row of ${money(d.amount)} on ${dateInWords(String(d.date))}` } };
    case "CASH_DOES_NOT_TIE": return { headline: `The bank balance ${money(d.bank)}, after outstanding items, gives ${money(d.reconciled)} but the trial balance has ${money(d.tb)}.`, missing: ["Bank rows or ledger entries that explain the difference"], action: { kind: "decide", label: "Find the difference", request: `Explain ${money(String(BigInt(String(d.reconciled)) - BigInt(String(d.tb))))}` } };
    case "EVIDENCE_USED_TWICE": return { headline: "One document supports two different reported balances.", missing: [], action: { kind: "decide", label: "Keep it on one line only", request: "A balance may be supported once" } };
    case "DEPOSIT_MOVEMENT": return { headline: "A deposit movement is not backed by a statement row that states it.", missing: ["A statement row stating the amount, the receiving account and the date"], action: FACT_PROBLEM.test(why) ? { kind: "confirm_facts", label: "Confirm what the statement states", request: why } : upload("Upload the statement", "The statement showing the deposit movement") };
    case "DEPOSIT_HISTORY_INCOMPLETE": return { headline: `The deposit history leaves ${money(d.unexplained)} unexplained.`, missing: [asNum(d.request) ?? "Deposit certificates or the bank's confirmation"], action: upload("Upload the deposit certificates", asNum(d.request) ?? "Deposit certificates or the bank's confirmation") };
    case "OPENING_DIFFERENCE_UNCLASSIFIED": return { headline: `The ledger's opening balance differs from the approved figure by ${money(d.difference)}, and the difference has not been classified.`, missing: [], action: { kind: "decide", label: "Classify the difference", request: "Say whether it is a mapping, timing, an unposted audit adjustment or a possible prior-period error" } };
    case "OPENING_CLASSIFICATION_UNEVIDENCED": {
      const ms = (d.must_state ?? {}) as { amount?: string; account?: string[] };
      const need = `A ${String(d.kind ?? "supporting").replace(/_/g, " ")} document stating the amount ${ms.amount ? money(ms.amount) : money(d.difference)}, the account (${(ms.account ?? []).map((a) => nameOf(a, ctx)).join(", ")}) and a date`;
      return { headline: `The opening difference of ${money(d.difference)} is classified as ${String(d.kind ?? "").replace(/_/g, " ")}, but no document states it. A reviewer's approval is not evidence.`, missing: [need], action: { kind: "confirm_facts", label: "Upload or correct the document", request: need } };
    }
    case "OPENING_ADJUSTMENT_UNPOSTED": return { headline: `The ledger opens ${money(String(d.difference).replace(/^-/, ""))} away from last year's approved figure. The approved adjustment that explains it was never posted in the ledger, so this year's opening position must include it.`, missing: [], action: { kind: "review_correction", label: "Review the opening correction", request: "Propose the correction shown; a second person approves it. Until it applies, this period cannot be finalised." }, ...(f.resolves ? { correctionId: f.resolves } : {}) };
    case "PRIOR_PERIOD_ERROR_ROUTED": return { headline: "This difference looks like an error in the prior period.", missing: [], action: { kind: "decide", label: "Propose a restatement", request: "Restate the comparative; the figures as reported stay beside it" } };
    case "ENTRY_UNSUPPORTED": return { headline: `Entry ${asNum(d.entry) ?? ""} of ${money(d.amount)} has no support. A balance that nets to zero does not make its entries supported.`, missing: [`A document stating the amount ${money(String(d.amount).replace(/^-/, ""))}, the account and which entry it supports`], action: { kind: "confirm_facts", label: "Attach support for the entry", request: `Support for ledger entry ${asNum(d.entry) ?? ""}` } };
    case "OBE_ARITHMETIC": return { headline: "The opening equity reconstruction does not reproduce the trial balance.", missing: [], action: { kind: "confirm_facts", label: "Correct the reconstruction", request: "Recheck the journals used" } };
    case "OBE_CONTENT_UNVERIFIED": return { headline: "The opening equity figure was reproduced arithmetically, but the entries behind it have not been seen.", missing: [asNum(d.request) ?? "The opening journal and the ledger detail of the equity account"], action: upload("Upload the opening journal", asNum(d.request) ?? "The opening journal and the ledger detail of the equity account") };
    case "CUTOFF_SEARCH_INCOMPLETE": return { headline: "Nothing shows what was paid or invoiced after year end, so unrecorded liabilities have not been searched for. A clean bank reconciliation does not test this.", missing: [cap(asNum(d.request) ?? "The payments listing and the supplier invoice register after year end")], action: upload("Upload the documents for the search after year end", asNum(d.request) ?? "The payments listing and the supplier invoice register after year end") };
    case "CUTOFF_RECEIPT_DATE_UNEVIDENCED": case "CUTOFF_INVOICE_UNEVIDENCED": {
      const which = f.rule === "CUTOFF_INVOICE_UNEVIDENCED" ? "invoice" : "goods-received note";
      const need = f.rule === "CUTOFF_INVOICE_UNEVIDENCED" ? "A supplier invoice stating its number, the amount and a date after year end" : "A goods-received note stating its number and a date on or before year end";
      return { headline: `The ${which} for ${asNum(d.ref) ?? "a late invoice"} does not state what is needed to treat it as a liability at year end.`, missing: [need], action: FACT_PROBLEM.test(why) || why ? { kind: "confirm_facts", label: `Confirm what the ${which} states`, request: need } : upload(`Upload the ${which}`, need) };
    }
    case "CUTOFF_OMITTED_LIABILITY": {
      const p = r.proposals.find((x) => x.id === f.resolves);
      const dr = p?.lines.find((l) => !l.amount.startsWith("-"));
      return { headline: `${money(d.amount)} of goods received before year end (${asNum(d.ref) ?? ""}) was invoiced afterwards and is not in the ledger. Accrue it at ${ctx.periodEnd ? dateInWords(ctx.periodEnd) : "year end"}.`, missing: [], action: { kind: "review_correction", label: "Review the accrual", request: dr ? `Debit ${nameOf(dr.account, ctx)}, credit the accrual` : "Review the proposed accrual" }, correctionId: f.resolves };
    }
    case "OPENING_PAYABLE_CHARGED_TO_EXPENSE": {
      const dc = ctx.doubleCharge;
      const proposal = r.proposals.find((x) => x.id === f.resolves);
      const amount = dc?.amount ?? proposal?.lines.find((l) => !l.amount.startsWith("-"))?.amount;
      const payDate = dc ? ctx.evidence?.[dc.payment_evidence]?.facts?.date : undefined;
      if (f.outcome === "confirmed") {
        const what = amount ? `${formatMinor(amount, ctx)} was charged to ${dc ? `${nameOf(dc.expense_account, ctx).toLowerCase()} expense` : "expense"}${payDate ? ` on ${dateInWords(payDate)}` : ""}, but it paid last year's approved bill${dc ? ` ${dc.bill}` : ""}.` : "A payment was charged to expense but it paid last year's approved bill.";
        return { headline: what, missing: [], action: { kind: "review_correction", label: "Review the correction", request: "Approve the correction as a second person, or post it in the source and re-import" }, correctionId: f.resolves };
      }
      const missing = (Array.isArray(d.missing) ? (d.missing as string[]) : []).map(cap);
      const checks: [string, RegExp][] = [["Bank payment", /^bank payment/i], ["Approved opening payable", /approved opening payable/i], ["General Ledger posting of the payment", /ledger posting/i],
        ["Payment voucher linking the cheque to the bill", /payment voucher/i], ["Payee confirmation that the payment settled the bill", /payee confirmation/i]];
      const held = checks.filter(([, re]) => !missing.some((m) => re.test(m))).map(([label]) => label);
      return { headline: `${amount ? formatMinor(amount, ctx) : "A payment"} may have been charged to expense although it paid an approved opening payable. The correction cannot be confirmed yet.`, missing,
        evidenceHeld: held, action: upload("Upload the missing documents", missing.join("; ")) };
    }
    case "CORRECTION_PARTIAL_OR_DIFFERENT": {
      const res = (d.residual ?? {}) as Record<string, string>;
      const parts = Object.entries(res).map(([a, v]) => `${nameOf(a, ctx)} ${money(v)}`);
      return { headline: `The source already carries part of this correction. What is still to be corrected: ${parts.join(", ") || "a different effect"}.`, missing: [], action: { kind: "decide", label: "Propose the remaining part or complete it in the source", request: parts.join(", ") } };
    }
    case "CORRECTION_CORRECTED_THEN_REVERSED": return { headline: "The source corrected this and then reversed it. Nothing is reinstated automatically.", missing: [], action: { kind: "decide", label: "Decide whether the correction should apply", request: "Reinstate it as a new correction or leave the source as it is" } };
    case "CORRECTION_CANDIDATE_NEEDS_CONFIRMATION": return { headline: "A journal in the source has the same effect as your correction but does not refer to it.", missing: [], action: { kind: "decide", label: "Say whether that journal is the correction", request: "Link it to the correction or reject it" } };
    case "CORRECTION_NOT_CORRECTED_IN_SOURCE": return { headline: "This correction has not been approved yet, and the source does not carry it.", missing: [], action: { kind: "review_correction", label: "Review the correction", request: "Approve it as a second person" }, correctionId: String(d.correction ?? "") };
    case "CORRECTION_IDENTITY_CONFLICT": return { headline: `The correction ${asNum(d.correction) ?? ""} exists with two different effects, so neither was applied.`, missing: [], action: { kind: "decide", label: "Withdraw the wrong version", request: "One correction identity must have one effect" } };
    case "CORRECTION_DUPLICATE_EFFECT": return { headline: `Two corrections (${Array.isArray(d.corrections) ? (d.corrections as string[]).join(" and ") : ""}) have the same effect, so neither was applied.`, missing: [], action: { kind: "decide", label: "Withdraw one of them", request: "The same effect must not be applied twice" } };
    case "CORRECTION_POSTCONDITION_FAILED": return { headline: "The approved corrections do not leave the accounts as the case requires (for example, the payable must be nil once the bill is settled).", missing: [], action: { kind: "decide", label: "Complete or reverse the corrections", request: JSON.stringify(d.problems ?? []) } };
    case "DECISION_WITHOUT_EVIDENCE": return { headline: "A decision was recorded without a document that states what it relies on.", missing: ["A document stating the amount, account and date the decision relies on"], action: upload("Attach the document", "A document stating what the decision relies on") };
    case "CITATION_UNVERIFIED": return { headline: "A rule relies on a provision that has not been verified against the standard, so it cannot be used.", missing: [], action: { kind: "decide", label: "Verify the provision or withdraw the rule", request: String(d.provision ?? "") } };
    case "TB_ARITHMETIC": return { headline: `The trial balance does not balance (difference ${money(d.difference)}).`, missing: [], action: { kind: "confirm_facts", label: "Correct the trial balance", request: "Re-import a trial balance that balances" } };
    default: return {
      headline: `This check is held: ${f.rule.toLowerCase().replace(/_/g, " ")}.`, missing: f.outcome === "evidence_missing" || f.outcome === "incomplete" ? [`Evidence for ${f.scope}`] : [],
      action: f.outcome === "evidence_missing" || f.outcome === "incomplete" ? upload("Upload the missing evidence", `Evidence for ${f.scope}`) : { kind: "decide", label: "Review this check", request: f.rule },
    };
  }
}

export function presentIssues(result: ReadinessResult, ctx: PresentContext = {}): Issue[] {
  const issues: Issue[] = [];
  const applied = new Set(result.applied_adjustments);
  for (const [scope, status] of Object.entries(result.scopes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (status !== "HELD") continue;
    const holding = result.findings.filter((f) => f.scope === scope && f.outcome !== "pass" && !f.resolved_by)
      .sort((a, b) => (RANK[a.outcome] ?? 3) - (RANK[b.outcome] ?? 3));
    const evidenceHeld = result.findings.filter((f) => f.scope === scope && f.outcome === "pass" && PASS_WORDS[f.rule]).map((f) => PASS_WORDS[f.rule]);
    const rules = [...new Set(holding.map((f) => f.rule))];
    let described: Described;
    if (holding.length === 0) {
      const u = SIGNALS_UNCHECKED[scope] ?? (scope.startsWith("cash:") ? { what: "whether the bank account's statements, matching and closing balance support the trial balance", import: ["The bank statement for the whole period", "The General Ledger for the period"] }
        : scope.startsWith("opening:") ? { what: "whether the opening balance agrees to the approved figure", import: ["The approved prior-year figure for this line", "The General Ledger for the period"] }
        : scope.startsWith("suspense:") ? { what: "whether every entry in this account is supported", import: ["Support for each entry"] }
        : scope.startsWith("population:") ? { what: "whether the bank confirmed every account it holds", import: ["The bank's confirmation"] } : { what: "this check", import: ["The evidence this check needs"] });
      described = { headline: `Not checked yet: ${u.what}.`, missing: u.import, action: { kind: "upload_evidence", label: "Import what this check needs", request: u.import.join("; ") } };
    } else {
      described = describe(holding[0], result, ctx);
    }
    const secondary = holding.slice(1).filter((f) => f.rule !== holding[0].rule);
    const corr = described.correctionId ? result.proposals.find((p) => p.id === described.correctionId) : undefined;
    const correction = corr && !applied.has(corr.id) ? correctionView(corr.id, corr.lines, ctx) : undefined;
    const related = correction ? result.proposals.filter((p) => p.id !== correction.id && !applied.has(p.id) && p.lines.some((l) => correction.lines.some((c) => c.account === l.account))).map((p) => correctionView(p.id, p.lines, ctx)) : [];
    issues.push({
      scope, group: groupOf(scope), headline: described.headline, evidenceHeld: described.evidenceHeld ?? evidenceHeld,
      missing: [...described.missing], nextAction: described.action, ...(correction ? { correction } : {}), relatedCorrections: related,
      rules: [...rules, ...secondary.map((f) => f.rule)].filter((v, i, a) => a.indexOf(v) === i),
    });
  }
  return issues;
}
