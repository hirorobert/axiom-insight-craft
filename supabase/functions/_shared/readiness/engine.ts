/**
 * Ready for Reporting — the readiness engine (rfr-acceptance/2).
 *
 * Pure and deterministic: no clock, no I/O, no randomness. The server loads rows into a ReadinessInput, calls
 * evaluateReadiness, and stores the result; the browser may call it on the same input to explain a result.
 *
 * Invariants (each answers a finding of the independent review):
 *  - Nothing starts READY. A required scope is READY only with positive proof and no holding finding.
 *  - Required scopes are derived from the scope facts, every known bank account and the rule pack.
 *  - One authoritative set of effective corrections feeds the adjusted balances.
 *  - Evidence counts only when it states the facts the rule depends on.
 *  - The review binds to content; source freshness is a separate expiring attestation.
 */
import { abs, addDays, big, dayDiff, diffNets, netByAccount, str, sum } from "./money.ts";
import { probative, type EvidenceNeed } from "./evidence.ts";
import { effectiveCorrections, rowsFrom, type CorrectionRow } from "./corrections.ts";
import { freshnessHolds, reviewHolds } from "./finalization.ts";
import { PILOT_RULE_PACK, type RulePack } from "./rulePack.ts";
import type { Bank, BridgeLine, CorrectionState, Evidence, Finding, Line, Outcome, Proposal, ReadinessInput, ReadinessResult, Refusal } from "./types.ts";

export function evaluateReadiness(I: ReadinessInput, pack: RulePack = PILOT_RULE_PACK): ReadinessResult {
  const ev: Record<string, Evidence | undefined> = I.evidence ?? {};
  const P0 = I.period;
  const findings: Finding[] = [];
  const proposals: Proposal[] = [];
  const refusals: Refusal[] = [];
  const add = (rule: string, outcome: Outcome, scope: string, extra: Partial<Finding> = {}) => { findings.push({ rule, outcome, scope, ...extra }); };

  // ── 1. TB validation and draft eligibility (drafting never waits for the ledger or evidence) ───────────────
  const tbAccounts = I.tb?.accounts ?? {};
  const tbSum = sum(Object.values(tbAccounts).map((a) => a.closing));
  const tbValidated = I.tb?.validated === true && tbSum === 0n;
  if (I.tb && I.tb.validated === true && tbSum !== 0n) add("TB_ARITHMETIC", "confirmed", "tb", { detail: { difference: str(tbSum) } });
  const draftEligible = tbValidated && !!P0?.start && !!P0?.end && !!P0?.currency;

  // ── 2. Required scopes are DERIVED (D1) ─────────────────────────────────────────────────────────────────────
  const required = new Set<string>([...pack.deriveRequired(I.scope_facts, !!I.ledger), ...(I.required_scopes ?? [])]);
  for (const bk of I.banks ?? []) required.add(`cash:${bk.id}`);
  const pop = I.population;
  for (const id of [...(pop?.ledger ?? []), ...(pop?.prior_year ?? []), ...(pop?.confirmations ?? []), ...(pop?.statements ?? [])]) required.add(`cash:${id}`);
  const glDependent = new Set<string>([...(I.gl_dependent_scopes ?? []), ...[...required].filter((s) => pack.glDependent(s))]);

  // ── 3. Ledger snapshot: presence and tie-out ────────────────────────────────────────────────────────────────
  let ledgerReliable = false;
  if (!I.ledger) {
    for (const s of glDependent) add("LEDGER_REQUIRED", "evidence_missing", s, { detail: { request: "General Ledger detail for the period (QuickBooks GeneralLedger report or export)" } });
  } else {
    const L = I.ledger;
    const bad: Record<string, unknown>[] = [];
    for (const k of new Set([...Object.keys(L.accounts), ...Object.keys(tbAccounts), ...L.entries.map((e) => e.account)])) {
      // An account on one side only ties when its closing is exactly zero (a trial balance may omit a zero account). An account
      // with entries but no stated opening is never assumed to open at zero.
      const moves = L.entries.filter((e) => e.account === k).map((e) => e.amount);
      if (!(k in L.accounts) && moves.length) { bad.push({ account: k, reason: "population" }); continue; }
      const closing = (k in L.accounts ? big(L.accounts[k]) : 0n) + sum(moves);
      const tb = k in tbAccounts ? big(tbAccounts[k].closing) : 0n;
      if (closing !== tb) bad.push({ account: k, reason: !(k in L.accounts) || !(k in tbAccounts) ? "population" : "amount", ledger: str(closing), tb: str(tb) });
    }
    if (L.scope_limited) add("LEDGER_SCOPE_LIMITED", "pass", "ledger", { detail: { note: "fixture ledger covers only the accounts listed" } });
    if (bad.length) {
      add("LEDGER_TIEOUT_FAILED", "confirmed", "ledger", { detail: { accounts: bad } });
      for (const s of glDependent) add("LEDGER_NOT_RELIED", "evidence_missing", s, { detail: { snapshot: L.snapshot } });
    } else { ledgerReliable = true; add("LEDGER_TIEOUT", "pass", "ledger", { detail: { snapshot: L.snapshot } }); }
  }

  // ── 4. Bank population, coverage, matching, tie to TB ───────────────────────────────────────────────────────
  if (pop) {
    const all = new Set<string>([...(pop.ledger ?? []), ...(pop.prior_year ?? []), ...(pop.confirmations ?? []), ...(pop.statements ?? [])]);
    for (const id of all) {
      const acct = (I.banks ?? []).find((b) => b.id === id);
      if (!acct) { add("BANK_ACCOUNT_UNRESOLVED", "evidence_missing", `cash:${id}`, { detail: { seen_in: Object.entries(pop).filter(([, v]) => Array.isArray(v) && (v as string[]).includes(id)).map(([k]) => k) } }); continue; }
      if (acct.status === "closed") continue;
      if (!acct.ledger_key) add("BANK_ACCOUNT_NOT_IN_LEDGER", "suspected", `cash:${id}`, { detail: { note: "evidence account with no ledger account; no balance may be presented twice" } });
    }
    for (const bank of pop.banks_requiring_confirmation ?? []) {
      if (!(pop.confirmation_complete ?? {})[bank]) add("BANK_POPULATION_UNCONFIRMED", "evidence_missing", `population:${bank}`, { detail: { request: `confirmation from ${bank} of every account held at period end` } });
      else add("BANK_POPULATION_CONFIRMED", "pass", `population:${bank}`);
    }
  }
  for (const b of I.banks ?? []) evaluateBank(b);

  function evaluateBank(b: Bank): void {
    const scope = `cash:${b.id}`;
    if (b.status === "closed") {
      const p = probative(b.closure_evidence ? ev[b.closure_evidence] : undefined, { kind: "bank_closure_letter", account: b.id, within: ["1900-01-01", addDays(P0.start, -1)] });
      if (!p.ok) add("BANK_CLOSURE_UNEVIDENCED", "evidence_missing", scope, { detail: { why: p.why } }); else add("BANK_CLOSED_EVIDENCED", "pass", scope);
      return;
    }
    const seen = new Map<string, string>();
    const unique: NonNullable<Bank["statements"]> = [];
    for (const s of b.statements ?? []) {
      if (seen.has(s.sha)) { add("STATEMENT_DUPLICATE_IGNORED", "pass", scope, { detail: { file: s.file, duplicate_of: seen.get(s.sha) } }); continue; }
      seen.set(s.sha, s.file); unique.push(s);
    }
    for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i], c = unique[j];
      if (a.from <= c.to && c.from <= a.to) {
        const key = (rows: typeof a.rows, lo: string, hi: string) => new Set((rows ?? []).filter((r) => r.date >= lo && r.date <= hi).map((r) => `${r.date}|${r.amount}|${r.balance}`));
        const ka = key(a.rows, c.from, c.to), kb = key(c.rows, a.from, a.to);
        const same = ka.size === kb.size && [...ka].every((x) => kb.has(x));
        add(same ? "STATEMENT_OVERLAP_CONSISTENT" : "STATEMENT_OVERLAP_CONFLICT", same ? "pass" : "suspected", scope, { detail: { files: [a.file, c.file] } });
      }
    }
    for (const s of unique) {
      let bal: bigint | null = s.opening != null ? big(s.opening) : null;
      for (const r of s.rows ?? []) {
        if (bal !== null && r.balance != null && !r.excerpt_restart && bal + big(r.amount) !== big(r.balance)) add("RUNNING_BALANCE_BREAK", "confirmed", scope, { detail: { file: s.file, at: r.date, expected: str(bal + big(r.amount)), printed: r.balance } });
        if (r.balance != null) bal = big(r.balance);
      }
      if ((s.pages_missing ?? []).length) add("STATEMENT_PAGES_MISSING", "evidence_missing", scope, { detail: { file: s.file, pages: s.pages_missing, of: s.pages_total } });
    }
    let cursor = P0.start;
    let gap: { from: string; to: string } | null = null;
    for (const s of [...unique].sort((x, y) => (x.from < y.from ? -1 : 1))) { if (s.from > cursor) { gap = { from: cursor, to: s.from }; break; } if (s.to > cursor) cursor = s.to; }
    if (!gap && cursor < P0.end) gap = { from: cursor, to: P0.end };
    if (gap) {
      const tbBal = b.ledger_key && tbAccounts[b.ledger_key] ? tbAccounts[b.ledger_key].closing : undefined;
      const conf = b.period_end_confirmation && tbBal !== undefined
        ? probative(ev[b.period_end_confirmation], { kind: "bank_confirmation", account: b.id, date: P0.end, amount: tbBal }) : { ok: false as const, why: "absent" };
      if (b.status === "dormant" && conf.ok) add("DORMANT_BALANCE_CONFIRMED", "pass", scope, { detail: { confirmation: b.period_end_confirmation } });
      else add("STATEMENT_COVERAGE_GAP", "evidence_missing", scope, { detail: { gap, status: b.status } });
    }
    const rows = unique.flatMap((s) => s.rows ?? []).filter((r) => r.kind !== "opening");
    const book = (I.ledger?.entries ?? []).filter((e) => e.account === b.ledger_key);
    if (b.match && ledgerReliable) {
      const used = new Set<number>();
      for (const e of book) {
        const cands = rows.filter((r, i) => !used.has(i) && r.amount === e.amount && (!e.ref || !r.ref || e.ref === r.ref) && r.date >= e.date && dayDiff(e.date, r.date) <= (b.match?.window_days ?? 0));
        const strong = cands.filter((r) => e.ref && r.ref === e.ref);
        const pick = strong.length === 1 ? strong[0] : (cands.length === 1 && !e.ref ? cands[0] : null);
        if (cands.length > 1 && !pick) { add("MATCH_AMBIGUOUS", "suspected", scope, { detail: { entry: e.id, candidates: cands.length } }); continue; }
        if (pick) { used.add(rows.indexOf(pick)); continue; }
        const o = (b.outstanding ?? []).find((x) => x.entry_id === e.id);
        if (o) {
          const p = probative(ev[o.cleared_by], { kind: "bank_statement_subsequent", amount: e.amount, ref: e.ref ?? "", account: b.id, within: [e.date, addDays(P0.end, 90)] });
          add(p.ok ? "TIMING_ITEM_CLEARED" : "TIMING_ITEM_UNSUPPORTED", p.ok ? "pass" : "evidence_missing", scope, { detail: { entry: e.id, request: o.request, why: p.ok ? undefined : p.why } });
        } else add("BOOK_ENTRY_UNMATCHED", "suspected", scope, { detail: { entry: e.id } });
      }
      rows.forEach((r, i) => { if (!used.has(i) && !(b.reconciling_bank_items ?? []).includes(r.ref ?? "")) add("BANK_ROW_UNMATCHED", "suspected", scope, { detail: { date: r.date, amount: r.amount } }); });
      const last = unique.length ? [...unique].sort((x, y) => (x.to < y.to ? -1 : 1)).slice(-1)[0] : null;
      const bankClose = last?.rows?.length ? big(last.rows[last.rows.length - 1].balance) : null;
      if (bankClose !== null && !gap && b.ledger_key) {
        const outstandingTotal = sum((b.outstanding ?? []).map((o) => book.find((e) => e.id === o.entry_id)!.amount));
        const reconciled = bankClose + outstandingTotal;
        const tb = big(tbAccounts[b.ledger_key].closing);
        add(reconciled === tb ? "CASH_TIES_TO_TB" : "CASH_DOES_NOT_TIE", reconciled === tb ? "pass" : "confirmed", scope, { detail: { bank: str(bankClose), reconciled: str(reconciled), tb: str(tb) } });
      }
    } else if (b.match && !ledgerReliable) add("MATCH_NOT_RUN", "evidence_missing", scope, { detail: { why: I.ledger ? "ledger snapshot not reliable" : "no ledger" } });
    if (b.supplied_pages_all_matched) add("SUPPLIED_PAGES_MATCHED", "pass", scope, { detail: { note: "matches on supplied pages do not clear an incomplete account" } });
  }

  // ── 5. Evidence single use ──────────────────────────────────────────────────────────────────────────────────
  const uses: Record<string, string[]> = {};
  for (const u of I.evidence_uses ?? []) (uses[u.evidence] ??= []).push(u.line);
  let reused = false;
  for (const [e, lines] of Object.entries(uses)) if (new Set(lines).size > 1) { reused = true; add("EVIDENCE_USED_TWICE", "confirmed", "pack", { detail: { evidence: e, lines } }); refusals.push({ action: "present_balance_twice", code: "EVIDENCE_SINGLE_USE" }); }
  if (!reused) add("EVIDENCE_SINGLE_USE_OK", "pass", "pack", { detail: { evidence_uses: Object.keys(uses).length } });

  // ── 6. Deposit history ──────────────────────────────────────────────────────────────────────────────────────
  if (I.deposit) {
    const D = I.deposit;
    for (const m of D.movements) {
      const p = probative(ev[m.evidence], { kind: "bank_statement", amount: m.amount, account: m.receiving_account, within: [P0.start, P0.end] });
      add("DEPOSIT_MOVEMENT", p.ok ? "pass" : "evidence_missing", "deposits", { detail: { amount: m.amount, receiving_account: m.receiving_account, why: p.ok ? undefined : p.why } });
    }
    const explained = sum(D.movements.map((m) => m.amount)) + sum((D.history ?? []).filter((h) => probative(ev[h.evidence], { kind: ["deposit_certificate", "bank_confirmation"], amount: h.amount }).ok).map((h) => h.amount));
    const unexplained = big(D.approved_opening) - explained - (D.closing_evidenced != null ? big(D.closing_evidenced) : 0n);
    if (unexplained !== 0n || D.closing_evidenced == null) add("DEPOSIT_HISTORY_INCOMPLETE", "evidence_missing", "deposits", { detail: { approved_opening: D.approved_opening, unexplained: str(unexplained), closing_evidenced: D.closing_evidenced ?? null, request: D.request } });
    else add("DEPOSIT_HISTORY_EXPLAINED", "pass", "deposits");
    refusals.push({ action: "restate_prior_year_deposit", code: "INFERENCE_NOT_EVIDENCE" }, { action: "recognise_additional_deposit_asset", code: "EVIDENCE_SINGLE_USE" });
  }

  // ── 7. Opening-balance bridge: the classification's evidence must STATE the difference (D4) ─────────────────
  const openingNeed = (kind: NonNullable<BridgeLine["classification"]>["kind"], l: BridgeLine, diffAbs: string): EvidenceNeed => {
    const base = { amount_abs: diffAbs, account: l.accounts };
    switch (kind) {
      case "mapping": return { ...base, kind: ["opening_journal", "account_mapping_schedule"], within: ["1900-01-01", P0.start] };
      case "timing": return { ...base, kind: ["bank_reconciliation_prior", "bank_statement_subsequent"], within: [addDays(P0.start, -31), addDays(P0.start, 90)] };
      case "unposted_audit_adjustment": return { ...base, kind: ["audit_adjustment_schedule"], within: ["1900-01-01", P0.start] };
      case "possible_prior_period_error": return { ...base, kind: ["error_analysis"], present: ["ref"], within: ["1900-01-01", P0.end] };
      default: return { ...base, kind: ["other_document"], within: ["1900-01-01", P0.end] };
    }
  };
  for (const l of I.opening_bridge?.lines ?? []) {
    const scope = `opening:${l.line}`;
    const ledgerOpening = l.ledger_opening ?? (I.ledger ? str(sum(l.accounts.map((k) => I.ledger!.accounts[k] ?? "0"))) : null);
    if (ledgerOpening === null) { add("OPENING_NOT_COMPARED", "evidence_missing", scope, { detail: { why: "no ledger opening" } }); continue; }
    const diff = big(ledgerOpening) - big(l.approved);
    if (diff === 0n) { add("OPENING_AGREES", "pass", scope, { detail: { level: l.level, note: l.level === "line" ? "agrees at statement-line level only; constituents not verified" : undefined } }); continue; }
    const cls = l.classification;
    if (!cls) { add("OPENING_DIFFERENCE_UNCLASSIFIED", "suspected", scope, { detail: { difference: str(diff) } }); continue; }
    const need = openingNeed(cls.kind, l, abs(str(diff)));
    if (!(cls.evidence ?? []).some((id) => probative(ev[id], need).ok)) {
      add("OPENING_CLASSIFICATION_UNEVIDENCED", "evidence_missing", scope, { detail: { kind: cls.kind, difference: str(diff), must_state: { amount: abs(str(diff)), account: l.accounts, window: need.within } } });
      refusals.push({ action: "approve_without_evidence", code: "APPROVAL_IS_NOT_EVIDENCE" }); continue;
    }
    if (cls.kind === "possible_prior_period_error") { add("PRIOR_PERIOD_ERROR_ROUTED", "suspected", scope, { detail: { route: "restatement proposal (as-reported comparative kept)" } }); continue; }
    // An approved adjustment the source ledger never carried is not merely explained: the reported opening position must include
    // it. The difference holds the scope until a correction for it is effective (or the ledger carries a verified fix), so an
    // unresolved required difference blocks FINAL. With no proposal on the line it holds with nothing to apply.
    if (cls.kind === "unposted_audit_adjustment") {
      const prop = (I.opening_bridge?.proposals ?? []).find((p) => p.line === l.line);
      add("OPENING_ADJUSTMENT_UNPOSTED", "confirmed", scope, { accounts: l.accounts, ...(prop ? { resolves: prop.id } : {}), detail: { difference: str(diff), kind: cls.kind, approved: l.approved, ledger_opening: ledgerOpening } });
      if (prop) proposals.push({ id: prop.id, scope, lines: prop.lines });
      continue;
    }
    add("OPENING_DIFFERENCE_EXPLAINED", "pass", scope, { detail: { kind: cls.kind, difference: str(diff) } });
  }

  // ── 8. Entry-level support for OBE / suspense / clearing: a zero balance is not evidence ───────────────────
  for (const k of I.entry_support?.accounts ?? []) {
    const scope = `suspense:${k}`;
    if (!I.ledger) { add("ENTRY_SUPPORT_NOT_RUN", "evidence_missing", scope); continue; }
    if (!ledgerReliable) { add("ENTRY_SUPPORT_NOT_RELIED", "evidence_missing", scope); continue; }
    const es = I.ledger.entries.filter((e) => e.account === k);
    let unsupported = 0;
    for (const e of es) {
      const ok = (e.links ?? []).some((id) => probative(ev[id], { amount_abs: abs(e.amount), account: k, present: ["entry"] }).ok && ev[id]?.facts?.entry === e.id);
      if (!ok) { unsupported++; add("ENTRY_UNSUPPORTED", "evidence_missing", scope, { detail: { entry: e.id, amount: e.amount } }); }
    }
    if (!unsupported) add("ENTRIES_SUPPORTED", "pass", scope, { detail: { entries: es.length, net: str(sum(es.map((e) => e.amount))) } });
  }

  // ── 9. Opening Balance Equity: arithmetic reconstruction is not content ─────────────────────────────────────
  if (I.obe_reconstruction) {
    const R = I.obe_reconstruction;
    const pre = big(R.tb_obe) - sum(R.journals.map((j) => j.amount));
    add("OBE_ARITHMETIC", str(pre) === R.reconstructed ? "pass" : "confirmed", "opening:equity", { detail: { reconstructed: str(pre), claimed: R.reconstructed } });
    const src = probative(R.source_export ? ev[R.source_export] : undefined, { kind: "ledger_export_obe", account: R.account ?? "OBE", within: [P0.start, P0.end] });
    if (!src.ok) add("OBE_CONTENT_UNVERIFIED", "evidence_missing", "opening:equity", { detail: { request: R.request } }); else add("OBE_CONTENT_VERIFIED", "pass", "opening:equity");
  }

  // ── 10. Cut-off / omitted liabilities, independent of the bank ──────────────────────────────────────────────
  if (I.cutoff) {
    const C = I.cutoff;
    const scope = "completeness:liabilities";
    const sources = C.search?.sources ?? [];
    const srcOk = !!C.search && sources.length > 0 && sources.every((id) => probative(ev[id], { kind: ["subsequent_payments_listing", "supplier_invoice_register"], within: [C.search!.required_to, "9999-12-31"] }).ok);
    const searchEnd = srcOk ? sources.map((id) => ev[id]!.facts!.date as string).sort()[0] : null;
    if (!(srcOk && C.search!.from <= addDays(P0.end, 1))) add("CUTOFF_SEARCH_INCOMPLETE", "incomplete", scope, { detail: { request: C.request } });
    else add("CUTOFF_SEARCH_COMPLETE", "pass", scope, { detail: { searched_to: searchEnd } });
    for (const it of C.items ?? []) {
      const inv = probative(ev[it.evidence], { kind: "supplier_invoice", amount: it.amount, ref: it.ref, within: [addDays(P0.end, 1), searchEnd ?? C.search?.to ?? "9999-12-31"] });
      const grn = probative(ev[it.receipt_evidence], { kind: "goods_received_note", ...(it.grn_ref ? { ref: it.grn_ref } : { present: ["ref"] }), within: [P0.start, P0.end] });
      // Absence is shown by the reliable ledger, never by a list the caller typed.
      if (!ledgerReliable) { add("CUTOFF_LEDGER_NOT_RELIED", "evidence_missing", scope, { detail: { ref: it.ref } }); continue; }
      if (I.ledger!.entries.some((e) => e.account === it.accrual_account && e.ref === it.ref && big(e.amount) === -big(it.amount))) continue;
      if (inv.ok && grn.ok) {
        add("CUTOFF_OMITTED_LIABILITY", "confirmed", scope, { resolves: `corr:cutoff:${it.ref}`, detail: { ref: it.ref, amount: it.amount } });
        proposals.push({ id: `corr:cutoff:${it.ref}`, scope, lines: [{ account: it.expense_account, amount: it.amount }, { account: it.accrual_account, amount: "-" + it.amount }] });
      } else if (inv.ok) add("CUTOFF_RECEIPT_DATE_UNEVIDENCED", "evidence_missing", scope, { detail: { ref: it.ref, why: grn.ok ? undefined : grn.why } });
      else add("CUTOFF_INVOICE_UNEVIDENCED", "evidence_missing", scope, { detail: { ref: it.ref, why: inv.ok ? undefined : inv.why } });
    }
    if (C.bank_reconciliation_clean) add("BANK_RECONCILIATION_CLEAN_NOT_COMPLETENESS", "pass", scope, { detail: { note: "a clean bank reconciliation does not test unrecorded liabilities" } });
  }

  // ── 12. Correction lifecycle across source snapshots ────────────────────────────────────────────────────────
  const corrections: CorrectionState[] = [];
  /** Postings of the source ledger that ARE a correction's verified fix: they are not a second settlement of anything. */
  const fixedPostings = new Set<string>();
  const sourceFixLines = new Map<string, Line[]>(); // posting id -> its lines, for the post-condition arithmetic (counted once)
  const seenCv = new Set<string>();
  for (const cv of I.correction_verification ?? []) {
    const key = `${cv.id}|${cv.snapshot.id}`;
    if (seenCv.has(key)) continue; // a repeated import of the same snapshot is the same observation
    seenCv.add(key);
    const effect = netByAccount(cv.effect);
    // The original posting of the double charge mentions the bill too; it is the error, never the correction.
    const originals = new Set<string>(I.double_charge ? [I.double_charge.gl_entry_id.split("#")[0]] : []);
    const linked = cv.snapshot.postings.filter((p) => !originals.has(p.id) && (p.links ?? []).some((x) => cv.anchor.includes(x)));
    // An unlinked posting is a candidate for the same correction when it has the same net effect, OR repeats the correction's exact
    // amount on one of the accounts the correction moves (a journal booked another way - e.g. as current-year expense). It is never
    // read as the correction without a verified link, and never ignored: the scope stays open until a reviewer links or rejects it.
    const unlinkedSame = cv.snapshot.postings.filter((p) => {
      if (linked.includes(p) || originals.has(p.id)) return false;
      const net = netByAccount(p.lines);
      if (eqNets(net, effect)) return true;
      // Only for a correction of the OPENING position (scope "opening:..."): a current-year journal that repeats its amount on a
      // moved account is the same economic item booked another way. Other scopes keep the exact-effect rule (a refund banked to cash
      // that shares one amount with a correction is a different thing, proved by the acceptance case E2-L5).
      if (!cv.scope.startsWith("opening:")) return false;
      // A posting that moves cash is settled by the bank checks.
      const cash = new Set<string>([...(I.banks ?? []).map((b) => b.ledger_key).filter((x): x is string => !!x), ...(I.double_charge?.cash_account ? [I.double_charge.cash_account] : [])]);
      if (p.lines.some((l) => cash.has(l.account))) return false;
      return [...effect].some(([acct, amt]) => amt !== 0n && net.get(acct) === amt);
    });
    const observed = netByAccount(linked.flatMap((p) => p.lines));
    let state: string;
    if (!linked.length) state = unlinkedSame.length ? "candidate_needs_confirmation" : "not_corrected_in_source";
    else if (eqNets(observed, effect)) state = "verified_in_source";
    else if ([...observed.values()].every((v) => v === 0n)) state = "corrected_then_reversed";
    else state = "partial_or_different";
    // A partial source fix is completed when applied corrections that supersede it carry exactly the residual.
    if (state === "partial_or_different" && cv.completed_by && eqNets(nonZero(residualMap(effect, observed)), nonZero(netByAccount(cv.completed_by)))) state = "completed_by_residual";
    const applied = state === "not_corrected_in_source" || state === "candidate_needs_confirmation" ? cv.adjustment_approved === true : false;
    const residual = state === "partial_or_different" ? diffNets(effect, observed) : null;
    corrections.push({ id: cv.id, state, adjustment_applied: applied, residual });
    if (state === "verified_in_source" || state === "completed_by_residual") for (const p of linked) { fixedPostings.add(p.id); sourceFixLines.set(p.id, p.lines); }
    const ok = state === "verified_in_source" || state === "completed_by_residual" || (state === "not_corrected_in_source" && cv.adjustment_approved === true);
    add(`CORRECTION_${state.toUpperCase()}`, ok ? "pass" : "suspected", cv.scope, { detail: { correction: cv.id, previous: cv.previous_state ?? null, residual } });
  }

  // ── 11. An approved opening payable settled by a payment charged to expense ─────────────────────────────────
  const X = I.double_charge;
  if (X) {
    const scope = "payables";
    const pay = probative(ev[X.payment_evidence], { kind: "bank_statement", amount: X.amount, ref: X.cheque, within: [P0.start, P0.end] });
    const entry = (I.ledger?.entries ?? []).find((e) => e.id === X.gl_entry_id);
    const glExpense = ledgerReliable && !!entry && entry.account === X.expense_account && big(entry.amount) === big(X.amount);
    const voucher = probative(ev[X.voucher], { kind: "payment_voucher", amount: X.amount, ref: X.bill });
    const supplier = probative(ev[X.supplier_confirmation], { kind: ["supplier_statement", "supplier_confirmation"], counterparty: X.payee, ref: X.bill, amount: X.amount });
    const approved = probative(ev[X.approved_fs], { kind: "approved_fs_note", amount: X.amount, ref: X.bill });
    const otherSettlement = (I.ledger?.entries ?? []).some((e) => e.ref !== X.cheque && (e.links ?? []).includes(X.bill) && !fixedPostings.has(e.id.split("#")[0]));
    const bridge = (I.opening_bridge?.lines ?? []).find((l) => l.line === X.bridge_line);
    const bridgeOk = findings.some((f) => f.scope === `opening:${X.bridge_line}` && f.rule === "OPENING_DIFFERENCE_EXPLAINED");
    const missing: string[] = [];
    if (!pay.ok) missing.push("bank payment");
    if (!approved.ok) missing.push("approved opening payable");
    if (!I.ledger) missing.push("General Ledger posting of the payment"); else if (!glExpense) missing.push("ledger posting debited to expense");
    if (!voucher.ok) missing.push("payment voucher linking the cheque to the bill");
    if (!supplier.ok) missing.push("payee confirmation that the payment settled the bill");
    if (otherSettlement) missing.push("no other settlement of the bill");
    if (bridge && !bridgeOk) missing.push("opening payable recognised in the opening bridge");
    if (missing.length) add("OPENING_PAYABLE_CHARGED_TO_EXPENSE", pay.ok && approved.ok ? "suspected" : "evidence_missing", scope, { accounts: [X.payable_account, X.expense_account], detail: { missing } });
    else {
      add("OPENING_PAYABLE_CHARGED_TO_EXPENSE", "confirmed", scope, { resolves: X.correction_id, accounts: [X.payable_account, X.expense_account] });
      proposals.push({ id: X.correction_id, scope, lines: [{ account: X.payable_account, amount: X.amount }, { account: X.expense_account, amount: "-" + X.amount }] });
    }
  }
  for (const p of I.opening_bridge?.proposals ?? []) {
    if (findings.some((f) => f.scope === `opening:${p.line}` && f.rule === "OPENING_DIFFERENCE_EXPLAINED") && !proposals.some((q) => q.id === p.id)) proposals.push({ id: p.id, scope: `opening:${p.line}`, lines: p.lines });
  }

  // ── 13. Reviewer decisions never stand in for evidence ──────────────────────────────────────────────────────
  for (const d of I.decisions ?? []) {
    if (!(d.evidence ?? []).some((id) => probative(ev[id], (d.need as EvidenceNeed | undefined) ?? { present: ["amount"] }).ok)) { refusals.push({ action: d.action, code: "APPROVAL_IS_NOT_EVIDENCE" }); add("DECISION_WITHOUT_EVIDENCE", "evidence_missing", d.scope); }
  }

  // ── 14. Citations: an unverified provision may not be the basis of a rule ───────────────────────────────────
  let citationsBad = false;
  for (const ci of I.citations ?? []) if (ci.status !== "verified") { citationsBad = true; add("CITATION_UNVERIFIED", "confirmed", "rule_pack", { detail: { ...ci } }); refusals.push({ action: "encode_rule", code: "CITATION_UNVERIFIED" }); }
  if (!citationsBad) add("CITATIONS_VERIFIED", "pass", "rule_pack", { detail: { rule_pack: pack.id, version: pack.version, citations: (I.citations ?? []).length } });

  // ── 15. The one authoritative set of effective corrections (D2) ─────────────────────────────────────────────
  const approvalOk = (a: { proposer: string; approver: string; approver_caps?: string[] } | undefined) => !!a && !!a.approver && a.approver !== a.proposer && (a.approver_caps ?? []).includes("review_close");
  const rows: CorrectionRow[] = rowsFrom(I.reporting_adjustments ?? []);
  for (const id of I.apply_proposals ?? []) {
    const prop = proposals.find((p) => p.id === id);
    if (!prop) continue;
    if (!approvalOk((I.approvals ?? []).find((x) => x.id === id))) { refusals.push({ action: `apply:${id}`, code: "APPROVAL_AUTHORITY" }); continue; }
    rows.push({ id, cid: id, approved: true, lines: prop.lines, scope: prop.scope, reverses: null });
  }
  const { effective, conflicts } = effectiveCorrections(rows, corrections);
  for (const c of conflicts) add(c.rule, c.outcome, c.scope, { detail: c.detail });
  const appliedIds = new Set(effective.map((e) => e.cid));
  const balances = new Map<string, bigint>();
  for (const [k, a] of Object.entries(tbAccounts)) balances.set(k, big(a.closing));
  for (const e of effective) for (const l of e.lines) balances.set(l.account, (balances.get(l.account) ?? 0n) + big(l.amount));
  // Post-conditions of the food-rations correction: the payable nets to zero, the expense falls by exactly the payment, cash is untouched.
  let postOk = true;
  if (X) {
    // The correction's whole effect = the applied corrections PLUS the part of the fix the source ledger already carries.
    const all = [...effective.flatMap((e) => e.lines), ...[...sourceFixLines.values()].flat()];
    const net = (acct: string) => sum(all.filter((l) => l.account === acct).map((l) => l.amount));
    if (all.some((l) => l.account === X.payable_account || l.account === X.expense_account)) {
      const problems: Record<string, string>[] = [];
      if (net(X.payable_account) !== 0n) problems.push({ payable_net: str(net(X.payable_account)), expected: "0" });
      if (net(X.expense_account) !== -big(X.amount)) problems.push({ expense_net: str(net(X.expense_account)), expected: str(-big(X.amount)) });
      if (X.cash_account && net(X.cash_account) !== 0n) problems.push({ cash_net: str(net(X.cash_account)), expected: "0" });
      if (problems.length) { postOk = false; add("CORRECTION_POSTCONDITION_FAILED", "confirmed", "payables", { detail: { problems } }); }
    }
  }
  // A finding is resolved by an applied correction (post-conditions holding) OR by a fix the source ledger already carries.
  const sourceFixed = (id: string) => corrections.some((c) => c.id === id && (c.state === "verified_in_source" || c.state === "completed_by_residual"));
  for (const f of findings) if (f.resolves && ((appliedIds.has(f.resolves) && postOk) || sourceFixed(f.resolves))) f.resolved_by = f.resolves;

  // ── 16. Scopes: nothing starts READY (D1) ───────────────────────────────────────────────────────────────────
  const holding = (f: Finding) => f.outcome !== "pass" && !f.resolved_by;
  const isProof = (f: Finding) => (f.outcome === "pass" && pack.proofRules(f.scope).includes(f.rule)) || (f.outcome === "confirmed" && !!f.resolved_by);
  const scopes: Record<string, "READY" | "HELD"> = {};
  const scopeReasons: Record<string, string[]> = {};
  for (const s of new Set([...required, ...findings.map((f) => f.scope).filter((x) => x !== "tb")])) {
    const fs = findings.filter((f) => f.scope === s);
    const holds = fs.filter(holding);
    if (holds.length) { scopes[s] = "HELD"; scopeReasons[s] = [...new Set(holds.map((f) => f.rule))].sort(); }
    else if (fs.some(isProof)) scopes[s] = "READY";
    else if (required.has(s)) { scopes[s] = "HELD"; scopeReasons[s] = ["NOT_EVALUATED"]; }
  }
  const reasons: string[] = [];
  if (!tbValidated) reasons.push("TB_NOT_VALIDATED");
  for (const s of required) if (scopes[s] !== "READY") reasons.push(`SCOPE_HELD:${s}`);
  const always = (s: string) => ["pack", "rule_pack", "ledger"].includes(s) || s.startsWith("population:") || s.startsWith("cash:");
  for (const [s, st] of Object.entries(scopes)) if (st === "HELD" && !required.has(s) && always(s)) reasons.push(`SCOPE_HELD:${s}`);

  // ── 17. Finalization: reviewed CONTENT apart from source FRESHNESS (D5) ─────────────────────────────────────
  reasons.push(...reviewHolds(I), ...freshnessHolds(I.freshness, I.content_sha256_now));

  return {
    draft_eligible: draftEligible, evidence_upload_allowed: true, required_scopes: [...required].sort(),
    findings, scopes, scope_reasons: scopeReasons,
    proposals: proposals.map((p) => ({ id: p.id, lines: p.lines })), corrections,
    applied_adjustments: [...appliedIds].sort(),
    balances: Object.fromEntries([...balances].map(([k, v]) => [k, str(v)])),
    refusals, finalization: { held: reasons.length > 0, reasons: [...new Set(reasons)].sort() },
  };
}

function nonZero(m: Map<string, bigint>): Map<string, bigint> { return new Map([...m].filter(([, v]) => v !== 0n)); }
function residualMap(want: Map<string, bigint>, got: Map<string, bigint>): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const k of new Set([...want.keys(), ...got.keys()])) { const d = (want.get(k) ?? 0n) - (got.get(k) ?? 0n); if (d !== 0n) m.set(k, d); }
  return m;
}
function eqNets(a: Map<string, bigint>, b: Map<string, bigint>): boolean {
  for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) ?? 0n) !== (b.get(k) ?? 0n)) return false;
  return true;
}
export type { Line };
