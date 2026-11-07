/**
 * Ready for Reporting V3 — REFERENCE MODEL (rfr-acceptance/1).
 *
 * A small, pure, deterministic statement of the V3 rules, used ONLY to check that the fixtures in cases.json are
 * internally consistent with the specification (the runner's "self-check"). It is not CFOClose, it is not deployed,
 * and a green result here says nothing about any implementation. The runner refuses to accept this file as an
 * implementation adapter (hash check).
 *
 * Money: signed minor units as decimal strings, debit positive (Dr+ / Cr-). No floats anywhere.
 * Every check returns findings; scopes are HELD when any finding on them holds; the pack is held when any
 * required scope is not READY or a pack-level condition fails. Nothing here defaults a missing input to zero.
 */

const B = (s) => {
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) throw new Error(`not a minor-unit string: ${JSON.stringify(s)}`);
  return BigInt(s);
};
const S = (b) => b.toString();
const sum = (xs) => xs.reduce((a, x) => a + B(x), 0n);

/** Evidence counts only when its facts are human-confirmed or reproduced against an independent control
 *  (e.g. a printed running balance). AI-extracted facts not yet reproduced are never probative. */
export function probative(ev, need = {}) {
  if (!ev) return { ok: false, why: "absent" };
  if (!["human_confirmed", "reproduced"].includes(ev.extraction)) return { ok: false, why: "extraction_unconfirmed" };
  if (need.kind && !(Array.isArray(need.kind) ? need.kind : [need.kind]).includes(ev.kind)) return { ok: false, why: "wrong_kind" };
  for (const k of ["amount", "date", "ref", "counterparty", "account"]) {
    if (need[k] !== undefined && (ev.facts ?? {})[k] !== need[k]) return { ok: false, why: `fact_mismatch:${k}` };
  }
  if (need.within && ev.facts?.date && (ev.facts.date < need.within[0] || ev.facts.date > need.within[1])) return { ok: false, why: "outside_window" };
  return { ok: true };
}

export function evaluate(inputs) {
  const I = inputs;
  const ev = I.evidence ?? {};
  const findings = [];
  const proposals = [];
  const refusals = [];
  const add = (rule, outcome, scope, extra = {}) => findings.push({ rule, outcome, scope, ...extra });

  // ── 1. TB validation and draft eligibility (draft never waits for GL or evidence) ────────────────────────────
  const tbAccounts = I.tb?.accounts ?? {};
  const tbSum = sum(Object.values(tbAccounts).map((a) => a.closing));
  const tbValidated = I.tb?.validated === true && tbSum === 0n;
  if (I.tb && I.tb.validated === true && tbSum !== 0n) add("TB_ARITHMETIC", "confirmed", "tb", { detail: { difference: S(tbSum) } });
  const draftEligible = tbValidated && !!I.period?.start && !!I.period?.end && !!I.period?.currency;

  // ── 2. Ledger snapshot: presence and tie-out ───────────────────────────────────────────────────────────────
  let ledgerReliable = false;
  const glDependent = I.gl_dependent_scopes ?? [];
  if (!I.ledger) {
    for (const s of glDependent) add("LEDGER_REQUIRED", "evidence_missing", s, { detail: { request: "General Ledger detail for the period (QuickBooks GeneralLedger report or export)" } });
  } else {
    const L = I.ledger;
    const bad = [];
    const keys = new Set([...Object.keys(L.accounts), ...Object.keys(tbAccounts)]);
    for (const k of keys) {
      if (!(k in L.accounts) || !(k in tbAccounts)) { bad.push({ account: k, reason: "population" }); continue; }
      const moves = L.entries.filter((e) => e.account === k).map((e) => e.amount);
      const closing = B(L.accounts[k]) + sum(moves);
      if (closing !== B(tbAccounts[k].closing)) bad.push({ account: k, reason: "amount", ledger: S(closing), tb: tbAccounts[k].closing });
    }
    if (L.scope_limited) add("LEDGER_SCOPE_LIMITED", "pass", "ledger", { detail: { note: "fixture ledger covers only the accounts listed" } });
    if (bad.length) {
      add("LEDGER_TIEOUT_FAILED", "confirmed", "ledger", { detail: { accounts: bad } });
      for (const s of glDependent) add("LEDGER_NOT_RELIED", "evidence_missing", s, { detail: { snapshot: L.snapshot } });
    } else {
      ledgerReliable = true;
      add("LEDGER_TIEOUT", "pass", "ledger", { detail: { snapshot: L.snapshot } });
    }
  }

  // ── 3. Bank population, coverage, matching, tie to TB ─────────────────────────────────────────────────────
  const P = I.population;
  if (P) {
    const all = new Set([...(P.ledger ?? []), ...(P.prior_year ?? []), ...(P.confirmations ?? []), ...(P.statements ?? [])]);
    for (const id of all) {
      const acct = (I.banks ?? []).find((b) => b.id === id);
      if (!acct) { add("BANK_ACCOUNT_UNRESOLVED", "evidence_missing", `cash:${id}`, { detail: { seen_in: Object.entries(P).filter(([k, v]) => Array.isArray(v) && v.includes(id)).map(([k]) => k) } }); continue; }
      if (acct.status === "closed") {
        const p = probative(ev[acct.closure_evidence], { kind: "bank_closure_letter" });
        if (!p.ok) add("BANK_CLOSURE_UNEVIDENCED", "evidence_missing", `cash:${id}`, { detail: { why: p.why } });
        continue;
      }
      if (!acct.ledger_key) add("BANK_ACCOUNT_NOT_IN_LEDGER", "suspected", `cash:${id}`, { detail: { note: "evidence account with no ledger account; no balance may be presented twice" } });
    }
    for (const bank of P.banks_requiring_confirmation ?? []) {
      if (!(P.confirmation_complete ?? {})[bank]) add("BANK_POPULATION_UNCONFIRMED", "evidence_missing", `population:${bank}`, { detail: { request: `confirmation from ${bank} of every account held at period end` } });
    }
  }
  for (const b of I.banks ?? []) {
    if (b.status === "closed") continue;
    const scope = `cash:${b.id}`;
    const stmts = b.statements ?? [];
    // duplicates and overlaps
    const seen = new Map();
    const unique = [];
    for (const s of stmts) { if (seen.has(s.sha)) { add("STATEMENT_DUPLICATE_IGNORED", "pass", scope, { detail: { file: s.file, duplicate_of: seen.get(s.sha) } }); continue; } seen.set(s.sha, s.file); unique.push(s); }
    for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i], c2 = unique[j];
      if (a.from <= c2.to && c2.from <= a.to) {
        const ka = new Set((a.rows ?? []).filter((r) => r.date >= c2.from && r.date <= c2.to).map((r) => `${r.date}|${r.amount}|${r.balance}`));
        const kb = new Set((c2.rows ?? []).filter((r) => r.date >= a.from && r.date <= a.to).map((r) => `${r.date}|${r.amount}|${r.balance}`));
        const same = ka.size === kb.size && [...ka].every((x) => kb.has(x));
        add(same ? "STATEMENT_OVERLAP_CONSISTENT" : "STATEMENT_OVERLAP_CONFLICT", same ? "pass" : "suspected", scope, { detail: { files: [a.file, c2.file] } });
      }
    }
    // running balance chain (reproduces printed balances; a break is a missing page or a misread row)
    for (const s of unique) {
      let bal = s.opening != null ? B(s.opening) : null;
      for (const r of s.rows ?? []) {
        if (bal !== null && r.balance != null && !r.excerpt_restart && bal + B(r.amount) !== B(r.balance)) add("RUNNING_BALANCE_BREAK", "confirmed", scope, { detail: { file: s.file, at: r.date, expected: S(bal + B(r.amount)), printed: r.balance } });
        if (r.balance != null) bal = B(r.balance);
      }
      if ((s.pages_missing ?? []).length) add("STATEMENT_PAGES_MISSING", "evidence_missing", scope, { detail: { file: s.file, pages: s.pages_missing, of: s.pages_total } });
    }
    // coverage of the whole period
    const sorted = [...unique].sort((x, y) => (x.from < y.from ? -1 : 1));
    let cursor = I.period.start;
    let gap = null;
    for (const s of sorted) { if (s.from > cursor) { gap = { from: cursor, to: s.from }; break; } if (s.to > cursor) cursor = s.to; }
    if (!gap && cursor < I.period.end) gap = { from: cursor, to: I.period.end };
    if (gap) {
      const conf = b.period_end_confirmation ? probative(ev[b.period_end_confirmation], { kind: "bank_confirmation" }) : { ok: false };
      if (!(b.status === "dormant" && conf.ok)) add("STATEMENT_COVERAGE_GAP", "evidence_missing", scope, { detail: { gap, status: b.status } });
    }
    // matching: one-to-one, exact amount; ambiguity never auto-matches
    const rows = unique.flatMap((s) => s.rows ?? []).filter((r) => r.kind !== "opening");
    const book = (I.ledger?.entries ?? []).filter((e) => e.account === b.ledger_key);
    if (b.match && ledgerReliable) {
      const used = new Set();
      for (const e of book) {
        const cands = rows.filter((r, i) => !used.has(i) && r.amount === e.amount && (!e.ref || !r.ref || e.ref === r.ref) && r.date >= e.date && dayDiff(e.date, r.date) <= (b.match.window_days ?? 0));
        const strong = cands.filter((r) => e.ref && r.ref === e.ref);
        const pick = strong.length === 1 ? strong[0] : (cands.length === 1 && !e.ref ? cands[0] : null);
        if (cands.length > 1 && !pick) { add("MATCH_AMBIGUOUS", "suspected", scope, { detail: { entry: e.id, candidates: cands.length } }); continue; }
        if (pick) { used.add(rows.indexOf(pick)); continue; }
        const o = (b.outstanding ?? []).find((x) => x.entry_id === e.id);
        if (o) {
          const p = probative(ev[o.cleared_by], { kind: "bank_statement_subsequent", amount: e.amount, ref: e.ref });
          add(p.ok ? "TIMING_ITEM_CLEARED" : "TIMING_ITEM_UNSUPPORTED", p.ok ? "pass" : "evidence_missing", scope, { detail: { entry: e.id, request: o.request } });
        } else add("BOOK_ENTRY_UNMATCHED", "suspected", scope, { detail: { entry: e.id } });
      }
      rows.forEach((r, i) => { if (!used.has(i) && !(b.reconciling_bank_items ?? []).includes(r.ref)) add("BANK_ROW_UNMATCHED", "suspected", scope, { detail: { date: r.date, amount: r.amount } }); });
      // tie: bank closing - outstanding book items = reconciled book cash = TB
      const last = unique.length ? [...unique].sort((x, y) => (x.to < y.to ? -1 : 1)).at(-1) : null;
      const bankClose = last?.rows?.length ? B(last.rows.at(-1).balance) : null;
      if (bankClose !== null && !gap) {
        const outstandingTotal = sum((b.outstanding ?? []).map((o) => book.find((e) => e.id === o.entry_id).amount));
        const reconciled = bankClose + outstandingTotal;
        const tb = B(tbAccounts[b.ledger_key].closing);
        add(reconciled === tb ? "CASH_TIES_TO_TB" : "CASH_DOES_NOT_TIE", reconciled === tb ? "pass" : "confirmed", scope, { detail: { bank: S(bankClose), reconciled: S(reconciled), tb: S(tb) } });
      }
    } else if (b.match && !ledgerReliable) add("MATCH_NOT_RUN", "evidence_missing", scope, { detail: { why: I.ledger ? "ledger snapshot not reliable" : "no ledger" } });
    if (b.supplied_pages_all_matched) add("SUPPLIED_PAGES_MATCHED", "pass", scope, { detail: { note: "matches on supplied pages do not clear an incomplete account" } });
  }

  // ── 4. Evidence single use: one bank balance supports one reported balance ──────────────────────────────────
  const uses = {};
  for (const u of I.evidence_uses ?? []) (uses[u.evidence] ??= []).push(u.line);
  for (const [e, lines] of Object.entries(uses)) if (new Set(lines).size > 1) { add("EVIDENCE_USED_TWICE", "confirmed", "pack", { detail: { evidence: e, lines } }); refusals.push({ action: "present_balance_twice", code: "EVIDENCE_SINGLE_USE" }); }

  // ── 5. Deposit history ──────────────────────────────────────────────────────────────────────────────────────
  if (I.deposit) {
    const D = I.deposit;
    for (const m of D.movements) {
      const p = probative(ev[m.evidence], { kind: "bank_statement", amount: m.amount });
      add("DEPOSIT_MOVEMENT", p.ok ? "pass" : "evidence_missing", "deposits", { detail: { amount: m.amount, receiving_account: m.receiving_account, why: p.why } });
    }
    const explained = sum(D.movements.map((m) => m.amount)) + sum((D.history ?? []).filter((h) => probative(ev[h.evidence], { kind: ["deposit_certificate", "bank_confirmation"] }).ok).map((h) => h.amount));
    const unexplained = B(D.approved_opening) - explained - (D.closing_evidenced != null ? B(D.closing_evidenced) : 0n);
    if (unexplained !== 0n || D.closing_evidenced == null) add("DEPOSIT_HISTORY_INCOMPLETE", "evidence_missing", "deposits", { detail: { approved_opening: D.approved_opening, unexplained: S(unexplained), closing_evidenced: D.closing_evidenced ?? null, request: D.request } });
    refusals.push({ action: "restate_prior_year_deposit", code: "INFERENCE_NOT_EVIDENCE" }, { action: "recognise_additional_deposit_asset", code: "EVIDENCE_SINGLE_USE" });
  }

  // ── 6. Opening-balance bridge ───────────────────────────────────────────────────────────────────────────────
  const KIND_EVIDENCE = {
    mapping: ["opening_journal", "account_mapping_schedule"],
    timing: ["bank_reconciliation_prior", "bank_statement_subsequent"],
    unposted_audit_adjustment: ["audit_adjustment_schedule"],
    possible_prior_period_error: ["error_analysis"],
    other_evidenced: ["other_document"],
  };
  for (const l of I.opening_bridge?.lines ?? []) {
    const scope = `opening:${l.line}`;
    const ledgerOpening = l.ledger_opening ?? (I.ledger ? S(sum(l.accounts.map((k) => I.ledger.accounts[k] ?? "0"))) : null);
    if (ledgerOpening === null) { add("OPENING_NOT_COMPARED", "evidence_missing", scope, { detail: { why: "no ledger opening" } }); continue; }
    const diff = B(ledgerOpening) - B(l.approved);
    if (diff === 0n) { add("OPENING_AGREES", "pass", scope, { detail: { level: l.level, note: l.level === "line" ? "agrees at statement-line level only; constituents not verified" : undefined } }); continue; }
    const cls = l.classification;
    if (!cls) { add("OPENING_DIFFERENCE_UNCLASSIFIED", "suspected", scope, { detail: { difference: S(diff) } }); continue; }
    const okEv = (cls.evidence ?? []).filter((id) => probative(ev[id], { kind: KIND_EVIDENCE[cls.kind] }).ok);
    if (!okEv.length) { add("OPENING_CLASSIFICATION_UNEVIDENCED", "evidence_missing", scope, { detail: { kind: cls.kind, difference: S(diff) } }); refusals.push({ action: "approve_without_evidence", code: "APPROVAL_IS_NOT_EVIDENCE" }); continue; }
    if (cls.kind === "possible_prior_period_error") { add("PRIOR_PERIOD_ERROR_ROUTED", "suspected", scope, { detail: { route: "restatement proposal (as-reported comparative kept)" } }); continue; }
    add("OPENING_DIFFERENCE_EXPLAINED", "pass", scope, { detail: { kind: cls.kind, difference: S(diff) } });
  }

  // ── 7. Entry-level support for OBE / suspense / clearing (net zero never passes) ───────────────────────────
  for (const k of I.entry_support?.accounts ?? []) {
    const scope = `suspense:${k}`;
    const es = (I.ledger?.entries ?? []).filter((e) => e.account === k);
    if (!I.ledger) { add("ENTRY_SUPPORT_NOT_RUN", "evidence_missing", scope); continue; }
    if (!ledgerReliable) { add("ENTRY_SUPPORT_NOT_RELIED", "evidence_missing", scope); continue; }
    let unsupported = 0;
    for (const e of es) {
      const ok = (e.links ?? []).some((id) => probative(ev[id], { amount: e.amount.replace(/^-/, "") }).ok);
      if (!ok) { unsupported++; add("ENTRY_UNSUPPORTED", "evidence_missing", scope, { detail: { entry: e.id, amount: e.amount } }); }
    }
    if (!unsupported) add("ENTRIES_SUPPORTED", "pass", scope, { detail: { entries: es.length, net: S(sum(es.map((e) => e.amount))) } });
  }

  // ── 8. OBE arithmetic reconstruction vs verified content ──────────────────────────────────────────────────
  if (I.obe_reconstruction) {
    const R = I.obe_reconstruction;
    const pre = B(R.tb_obe) - sum(R.journals.map((j) => j.amount));
    const reproduced = S(pre) === R.reconstructed;
    add("OBE_ARITHMETIC", reproduced ? "pass" : "confirmed", "opening:equity", { detail: { reconstructed: S(pre), claimed: R.reconstructed } });
    const src = probative(ev[R.source_export], { kind: "ledger_export_obe" });
    if (!src.ok) add("OBE_CONTENT_UNVERIFIED", "evidence_missing", "opening:equity", { detail: { request: R.request } });
  }

  // ── 9. Cut-off / omitted liabilities (independent of bank reconciliation) ─────────────────────────────────
  if (I.cutoff) {
    const C = I.cutoff;
    const scope = "completeness:liabilities";
    const searchOk = C.search && (C.search.sources ?? []).length && C.search.sources.every((id) => probative(ev[id], { kind: ["subsequent_payments_listing", "supplier_invoice_register"] }).ok) && C.search.to >= C.search.required_to;
    if (!searchOk) add("CUTOFF_SEARCH_INCOMPLETE", "incomplete", scope, { detail: { request: C.request } });
    for (const it of C.items ?? []) {
      const p = probative(ev[it.evidence], { kind: "supplier_invoice", amount: it.amount });
      const grn = probative(ev[it.receipt_evidence], { kind: "goods_received_note" });
      const inLedger = (C.ledger_liabilities ?? []).some((l) => l.ref === it.ref && l.amount === it.amount);
      if (inLedger) continue;
      if (p.ok && grn.ok && it.goods_received <= I.period.end) {
        add("CUTOFF_OMITTED_LIABILITY", "confirmed", scope, { resolves: `corr:cutoff:${it.ref}`, detail: { ref: it.ref, amount: it.amount } });
        proposals.push({ id: `corr:cutoff:${it.ref}`, kind: "reporting_adjustment", lines: [{ account: it.expense_account, amount: it.amount }, { account: it.accrual_account, amount: "-" + it.amount }], requires: ["review_close"] });
      } else if (p.ok) add("CUTOFF_RECEIPT_DATE_UNEVIDENCED", "evidence_missing", scope, { detail: { ref: it.ref } });
    }
    if (C.bank_reconciliation_clean) add("BANK_RECONCILIATION_CLEAN_NOT_COMPLETENESS", "pass", scope, { detail: { note: "a clean bank reconciliation does not test unrecorded liabilities" } });
  }

  // ── 10. Opening payable settled and charged to expense (food rations) ──────────────────────────────────────
  if (I.double_charge) {
    const X = I.double_charge;
    const scope = "payables";
    const pay = probative(ev[X.payment_evidence], { kind: "bank_statement", amount: X.amount, ref: X.cheque });
    const entry = (I.ledger?.entries ?? []).find((e) => e.id === X.gl_entry_id);
    const glExpense = ledgerReliable && entry && entry.account === X.expense_account && B(entry.amount) === B(X.amount);
    const voucher = probative(ev[X.voucher], { kind: "payment_voucher", amount: X.amount, ref: X.bill });
    const supplier = probative(ev[X.supplier_confirmation], { kind: ["supplier_statement", "supplier_confirmation"], counterparty: X.payee });
    const approved = probative(ev[X.approved_fs], { kind: "approved_fs_note", amount: X.amount, ref: X.bill });
    const otherSettlement = (I.ledger?.entries ?? []).some((e) => e.ref !== X.cheque && (e.links ?? []).includes(X.bill));
    const bridge = (I.opening_bridge?.lines ?? []).find((l) => l.line === X.bridge_line);
    const bridgeOk = findings.some((f) => f.scope === `opening:${X.bridge_line}` && f.rule === "OPENING_DIFFERENCE_EXPLAINED");
    const missing = [];
    if (!pay.ok) missing.push("bank payment");
    if (!approved.ok) missing.push("approved opening payable");
    if (!I.ledger) missing.push("General Ledger posting of the payment");
    else if (!glExpense) missing.push("ledger posting debited to expense");
    if (!voucher.ok) missing.push("payment voucher linking the cheque to the bill");
    if (!supplier.ok) missing.push("payee confirmation that the payment settled the bill");
    if (otherSettlement) missing.push("no other settlement of the bill");
    if (bridge && !bridgeOk) missing.push("opening payable recognised in the opening bridge");
    if (missing.length) {
      add("OPENING_PAYABLE_CHARGED_TO_EXPENSE", pay.ok && approved.ok ? "suspected" : "evidence_missing", scope, { accounts: [X.payable_account, X.expense_account], detail: { missing } });
    } else {
      add("OPENING_PAYABLE_CHARGED_TO_EXPENSE", "confirmed", scope, { resolves: X.correction_id, accounts: [X.payable_account, X.expense_account] });
      proposals.push({ id: X.correction_id, kind: "reporting_adjustment", lines: [{ account: X.payable_account, amount: X.amount }, { account: X.expense_account, amount: "-" + X.amount }], requires: ["review_close"] });
    }
  }
  for (const p of I.opening_bridge?.proposals ?? []) {
    if (findings.some((f) => f.scope === `opening:${p.line}` && f.rule === "OPENING_DIFFERENCE_EXPLAINED")) proposals.push({ id: p.id, kind: "reporting_adjustment", lines: p.lines, requires: ["review_close"] });
  }

  // ── 11. Correction lifecycle across source snapshots ──────────────────────────────────────────────────────
  const corrections = [];
  const seenCv = new Set();
  for (const cv of I.correction_verification ?? []) {
    const cvKey = `${cv.id}|${cv.snapshot.id}`;
    if (seenCv.has(cvKey)) continue; // a repeated import of the same snapshot is the same observation
    seenCv.add(cvKey);
    const effect = new Map(cv.effect.map((l) => [l.account, B(l.amount)]));
    const linked = (cv.snapshot.postings ?? []).filter((p) => (p.links ?? []).some((x) => cv.anchor.includes(x)));
    const unlinkedSame = (cv.snapshot.postings ?? []).filter((p) => !linked.includes(p) && sameEffect(p.lines, effect));
    const observed = new Map();
    for (const p of linked) for (const l of p.lines) observed.set(l.account, (observed.get(l.account) ?? 0n) + B(l.amount));
    let state;
    if (!linked.length) state = unlinkedSame.length ? "candidate_needs_confirmation" : "not_corrected_in_source";
    else if (eqMap(observed, effect)) state = "verified_in_source";
    else if ([...observed.values()].every((v) => v === 0n)) state = "corrected_then_reversed";
    else state = "partial_or_different";
    const prev = cv.previous_state ?? null;
    const adjustmentApplied = state === "not_corrected_in_source" || state === "candidate_needs_confirmation" ? cv.adjustment_approved : false;
    corrections.push({ id: cv.id, state, adjustment_applied: adjustmentApplied, residual: state === "partial_or_different" ? diffMap(effect, observed) : null });
    const ok = state === "verified_in_source" || (state === "not_corrected_in_source" && cv.adjustment_approved === true);
    add(`CORRECTION_${state.toUpperCase()}`, ok ? "pass" : "suspected", cv.scope, { detail: { correction: cv.id, previous: prev, residual: corrections.at(-1).residual } });
  }

  // ── 12. Reviewer decisions never stand in for evidence ────────────────────────────────────────────────────
  for (const d of I.decisions ?? []) {
    if (!(d.evidence ?? []).some((id) => probative(ev[id]).ok)) { refusals.push({ action: d.action, code: "APPROVAL_IS_NOT_EVIDENCE" }); add("DECISION_WITHOUT_EVIDENCE", "evidence_missing", d.scope); }
  }

  // ── 13. Citations: no unverified provision may be encoded as a rule basis ─────────────────────────────────
  for (const ci of I.citations ?? []) if (ci.status !== "verified") { add("CITATION_UNVERIFIED", "confirmed", "rule_pack", { detail: ci }); refusals.push({ action: "encode_rule", code: "CITATION_UNVERIFIED" }); }

  // ── Approval authority, applied adjustments, scopes ──────────────────────────────────────────────────────
  const approvalOk = (a) => a && a.approver && a.approver !== a.proposer && (a.approver_caps ?? []).includes("review_close");
  const appliedIds = new Set();
  for (const id of I.apply_proposals ?? []) {
    const a = (I.approvals ?? []).find((x) => x.id === id);
    if (!proposals.some((p) => p.id === id)) continue;
    if (!approvalOk(a)) { refusals.push({ action: `apply:${id}`, code: "APPROVAL_AUTHORITY" }); continue; }
    appliedIds.add(id);
  }
  const existing = (I.reporting_adjustments ?? []).filter((ra) => {
    const c = corrections.find((x) => x.id === ra.id);
    return c ? c.adjustment_applied : ra.approved === true;
  });
  const scopes = {};
  for (const s of I.required_scopes ?? []) scopes[s] = "READY";
  const holdsNow = (f) => f.outcome !== "pass" && !(f.resolves && appliedIds.has(f.resolves));
  for (const f of findings) { if (f.resolves && appliedIds.has(f.resolves)) f.resolved_by = f.resolves; if (holdsNow(f)) scopes[f.scope] = "HELD"; else scopes[f.scope] ??= "READY"; }
  const balances = {};
  for (const [k, a] of Object.entries(tbAccounts)) balances[k] = B(a.closing);
  const applyLines = (lines) => { for (const l of lines) balances[l.account] = (balances[l.account] ?? 0n) + B(l.amount); };
  for (const p of proposals) if (appliedIds.has(p.id)) applyLines(p.lines);
  for (const ra of existing) applyLines(ra.lines);
  const reasons = [];
  if (!tbValidated) reasons.push("TB_NOT_VALIDATED");
  for (const s of I.required_scopes ?? []) if (scopes[s] !== "READY") reasons.push(`SCOPE_HELD:${s}`);
  // Always-required families: a held scope of these kinds holds every pack whatever the framework selects.
  const ALWAYS = (s) => ["pack", "rule_pack", "ledger"].includes(s) || s.startsWith("population:") || s.startsWith("cash:");
  for (const [s, st] of Object.entries(scopes)) if (st === "HELD" && !(I.required_scopes ?? []).includes(s) && ALWAYS(s)) reasons.push(`SCOPE_HELD:${s}`);
  const F = I.freshness;
  if (F) {
    if (F.source === "qbo") {
      if (F.reconfirmed !== true) reasons.push("SOURCE_FRESHNESS_UNDETERMINED");
      else if (F.tb_hash_now !== F.tb_hash_bound) reasons.push("SOURCE_CHANGED:tb");
      else if (F.gl_hash_bound && F.gl_hash_now !== F.gl_hash_bound) reasons.push("SOURCE_CHANGED:gl");
    }
  }
  return {
    draft_eligible: draftEligible,
    evidence_upload_allowed: true,
    findings,
    scopes,
    proposals: proposals.map((p) => ({ id: p.id, lines: p.lines })),
    corrections,
    applied_adjustments: [...appliedIds, ...existing.map((r) => r.id)].sort(),
    balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, S(v)])),
    refusals,
    finalization: { held: reasons.length > 0, reasons: [...new Set(reasons)].sort() },
  };
}

function dayDiff(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function sameEffect(lines, effect) { const m = new Map(); for (const l of lines) m.set(l.account, (m.get(l.account) ?? 0n) + BigInt(l.amount)); return eqMap(m, effect); }
function eqMap(a, b) { const ks = new Set([...a.keys(), ...b.keys()]); for (const k of ks) if ((a.get(k) ?? 0n) !== (b.get(k) ?? 0n)) return false; return true; }
function diffMap(want, got) { const o = {}; for (const k of new Set([...want.keys(), ...got.keys()])) { const d = (want.get(k) ?? 0n) - (got.get(k) ?? 0n); if (d !== 0n) o[k] = d.toString(); } return o; }
