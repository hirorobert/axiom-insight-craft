/**
 * Ready for Reporting V3 — REFERENCE MODEL (rfr-acceptance/2).
 *
 * A small, pure, deterministic statement of the V3 rules, used ONLY to check that the fixtures in cases.mjs are
 * internally consistent with the specification (the runner's "self-check"). It is not CFOClose, it is not deployed,
 * and a green result here says nothing about any implementation. The runner refuses to accept this file as an
 * implementation adapter (hash check).
 *
 * Money: signed minor units as decimal strings, debit positive (Dr+ / Cr-). No floats anywhere.
 *
 * rfr-acceptance/2 (changes from /1, each answering a finding of the independent review of 8bb3b1f):
 *   D1  A scope is READY only on POSITIVE PROOF: at least one designated proof finding (PROOF_RULES) or a confirmed
 *       finding resolved by an effective correction, and no holding finding. Nothing starts READY. The required scopes
 *       are DERIVED from `scope_facts` and the rule pack (deriveRequired) and the caller's `required_scopes` can only
 *       add to them. An unevaluated required scope is HELD with reason NOT_EVALUATED.
 *   D2  One authoritative set of effective corrections, keyed by correction identity (effectiveCorrections). A repeat of
 *       the same identity and effect counts once; the same identity with another effect, or two identities with one
 *       effect, are conflicts that hold the scope and apply neither. Post-conditions are checked on the result.
 *   D4  probative() requires every fact a rule depends on to be PRESENT and equal; a missing fact never passes. A date
 *       window needs a date. Human confirmation and extraction status only make facts admissible, never relevant.
 *   D5  Finalization separates the REVIEWED content binding (`review.reviewed_content_sha256` against the server's
 *       `content_sha256_now`) from an expiring source-freshness attestation bound to that content.
 */

const B = (s) => {
  if (typeof s !== "string" || !/^-?\d+$/.test(s)) throw new Error(`not a minor-unit string: ${JSON.stringify(s)}`);
  return BigInt(s);
};
const S = (b) => b.toString();
const sum = (xs) => xs.reduce((a, x) => a + B(x), 0n);
const arr = (x) => (Array.isArray(x) ? x : [x]);
const absStr = (s) => s.replace(/^-/, "");
const DAY = 86400000;
const addDays = (d, n) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** Longest freshness attestation a server may issue, in milliseconds (spec §9.3: 10 minutes). */
export const FRESHNESS_MAX_MS = 10 * 60 * 1000;

/**
 * Evidence is probative for a rule only when (1) its facts are human-confirmed or reproduced against an independent
 * control AND (2) every fact the rule depends on is present and equal. Absent facts never pass.
 *   need.kind, ref, counterparty, account (string or any-of array), amount (signed), amount_abs, date (exact),
 *   within [from, to] (needs a date), present [fact names].
 */
export function probative(ev, need = {}) {
  if (!ev) return { ok: false, why: "absent" };
  if (!["human_confirmed", "reproduced"].includes(ev.extraction)) return { ok: false, why: "extraction_unconfirmed" };
  if (need.kind && !arr(need.kind).includes(ev.kind)) return { ok: false, why: "wrong_kind" };
  const f = ev.facts ?? {};
  for (const k of ["amount", "ref", "counterparty", "account", "date"]) {
    if (need[k] === undefined) continue;
    if (f[k] === undefined || f[k] === null || f[k] === "") return { ok: false, why: `missing_fact:${k}` };
    if (!arr(need[k]).includes(f[k])) return { ok: false, why: `fact_mismatch:${k}` };
  }
  if (need.amount_abs !== undefined) {
    if (f.amount === undefined) return { ok: false, why: "missing_fact:amount" };
    if (absStr(f.amount) !== need.amount_abs) return { ok: false, why: "fact_mismatch:amount" };
  }
  for (const k of need.present ?? []) if (f[k] === undefined || f[k] === null || f[k] === "") return { ok: false, why: `missing_fact:${k}` };
  if (need.within) {
    if (f.date === undefined || f.date === "") return { ok: false, why: "missing_fact:date" };
    if (f.date < need.within[0] || f.date > need.within[1]) return { ok: false, why: "outside_window" };
  }
  return { ok: true };
}

/** The scope registry of the pilot rule pack: which facts require which scopes, and what proves each. */
export const RULE_PACK = {
  id: "rfr-pilot-ipsas-accrual", version: "1.0.0",
  /** Scope kinds that cannot be evaluated without a General Ledger snapshot (spec §2.1). */
  glDependent: (s) => s.startsWith("cash:") || s.startsWith("suspense:") || s === "completeness:liabilities",
  /** Rules whose `pass` outcome is positive proof for a scope. A confirmed finding resolved by an effective correction is also proof. */
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
  /** Required scopes derived from the facts the server holds about the reporting scope. Never from the caller's list alone. */
  deriveRequired(facts = {}, hasLedger = false) {
    const r = new Set(["pack", "rule_pack"]);
    for (const b of facts.banks ?? []) r.add(`cash:${b}`);
    for (const b of facts.banks_requiring_confirmation ?? []) r.add(`population:${b}`);
    if (facts.deposits) r.add("deposits");
    for (const l of facts.opening_lines ?? []) r.add(`opening:${l}`);
    if (facts.opening_equity) r.add("opening:equity");
    for (const k of facts.suspense_accounts ?? []) r.add(`suspense:${k}`);
    if (facts.liabilities_completeness) r.add("completeness:liabilities");
    if (facts.payables_settlement) r.add("payables");
    if (hasLedger) r.add("ledger");
    return r;
  },
};

const effectOf = (lines) => {
  const m = new Map();
  for (const l of lines) m.set(l.account, (m.get(l.account) ?? 0n) + B(l.amount));
  return [...m.entries()].filter(([, v]) => v !== 0n).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}:${v}`).join("|");
};

export function evaluate(inputs) {
  const I = inputs;
  const ev = I.evidence ?? {};
  const P0 = I.period ?? {};
  const findings = [];
  const proposals = [];
  const refusals = [];
  const add = (rule, outcome, scope, extra = {}) => findings.push({ rule, outcome, scope, ...extra });

  // ── 1. TB validation and draft eligibility (draft never waits for GL or evidence) ────────────────────────────
  const tbAccounts = I.tb?.accounts ?? {};
  const tbSum = sum(Object.values(tbAccounts).map((a) => a.closing));
  const tbValidated = I.tb?.validated === true && tbSum === 0n;
  if (I.tb && I.tb.validated === true && tbSum !== 0n) add("TB_ARITHMETIC", "confirmed", "tb", { detail: { difference: S(tbSum) } });
  const draftEligible = tbValidated && !!P0.start && !!P0.end && !!P0.currency;

  // ── 2. Ledger snapshot: presence and tie-out ───────────────────────────────────────────────────────────────
  let ledgerReliable = false;
  const required = new Set([...RULE_PACK.deriveRequired(I.scope_facts, !!I.ledger), ...(I.required_scopes ?? [])]);
  // Every bank account the server knows of is a required cash scope, whatever the caller listed (spec §2.3, §5.1).
  for (const bk of I.banks ?? []) required.add(`cash:${bk.id}`);
  for (const id of [...(I.population?.ledger ?? []), ...(I.population?.prior_year ?? []), ...(I.population?.confirmations ?? []), ...(I.population?.statements ?? [])]) required.add(`cash:${id}`);
  const glDependent = new Set([...(I.gl_dependent_scopes ?? []), ...[...required].filter(RULE_PACK.glDependent)]);
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
      if (acct.status === "closed") continue;
      if (!acct.ledger_key) add("BANK_ACCOUNT_NOT_IN_LEDGER", "suspected", `cash:${id}`, { detail: { note: "evidence account with no ledger account; no balance may be presented twice" } });
    }
    for (const bank of P.banks_requiring_confirmation ?? []) {
      if (!(P.confirmation_complete ?? {})[bank]) add("BANK_POPULATION_UNCONFIRMED", "evidence_missing", `population:${bank}`, { detail: { request: `confirmation from ${bank} of every account held at period end` } });
      else add("BANK_POPULATION_CONFIRMED", "pass", `population:${bank}`);
    }
  }
  for (const b of I.banks ?? []) {
    if (b.status === "closed") {
      const p = probative(ev[b.closure_evidence], { kind: "bank_closure_letter", account: b.id, within: ["1900-01-01", addDays(P0.start, -1)] });
      if (!p.ok) add("BANK_CLOSURE_UNEVIDENCED", "evidence_missing", `cash:${b.id}`, { detail: { why: p.why } });
      else add("BANK_CLOSED_EVIDENCED", "pass", `cash:${b.id}`);
      continue;
    }
    const scope = `cash:${b.id}`;
    const stmts = b.statements ?? [];
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
    for (const s of unique) {
      let bal = s.opening != null ? B(s.opening) : null;
      for (const r of s.rows ?? []) {
        if (bal !== null && r.balance != null && !r.excerpt_restart && bal + B(r.amount) !== B(r.balance)) add("RUNNING_BALANCE_BREAK", "confirmed", scope, { detail: { file: s.file, at: r.date, expected: S(bal + B(r.amount)), printed: r.balance } });
        if (r.balance != null) bal = B(r.balance);
      }
      if ((s.pages_missing ?? []).length) add("STATEMENT_PAGES_MISSING", "evidence_missing", scope, { detail: { file: s.file, pages: s.pages_missing, of: s.pages_total } });
    }
    const sorted = [...unique].sort((x, y) => (x.from < y.from ? -1 : 1));
    let cursor = P0.start;
    let gap = null;
    for (const s of sorted) { if (s.from > cursor) { gap = { from: cursor, to: s.from }; break; } if (s.to > cursor) cursor = s.to; }
    if (!gap && cursor < P0.end) gap = { from: cursor, to: P0.end };
    if (gap) {
      const tbBal = b.ledger_key && tbAccounts[b.ledger_key] ? tbAccounts[b.ledger_key].closing : undefined;
      const conf = b.period_end_confirmation && tbBal !== undefined
        ? probative(ev[b.period_end_confirmation], { kind: "bank_confirmation", account: b.id, date: P0.end, amount: tbBal }) : { ok: false };
      if (b.status === "dormant" && conf.ok) add("DORMANT_BALANCE_CONFIRMED", "pass", scope, { detail: { confirmation: b.period_end_confirmation } });
      else add("STATEMENT_COVERAGE_GAP", "evidence_missing", scope, { detail: { gap, status: b.status } });
    }
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
          const p = probative(ev[o.cleared_by], { kind: "bank_statement_subsequent", amount: e.amount, ref: e.ref, account: b.id, within: [e.date, addDays(P0.end, 90)] });
          add(p.ok ? "TIMING_ITEM_CLEARED" : "TIMING_ITEM_UNSUPPORTED", p.ok ? "pass" : "evidence_missing", scope, { detail: { entry: e.id, request: o.request, why: p.why } });
        } else add("BOOK_ENTRY_UNMATCHED", "suspected", scope, { detail: { entry: e.id } });
      }
      rows.forEach((r, i) => { if (!used.has(i) && !(b.reconciling_bank_items ?? []).includes(r.ref)) add("BANK_ROW_UNMATCHED", "suspected", scope, { detail: { date: r.date, amount: r.amount } }); });
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
  let reused = false;
  for (const [e, lines] of Object.entries(uses)) if (new Set(lines).size > 1) { reused = true; add("EVIDENCE_USED_TWICE", "confirmed", "pack", { detail: { evidence: e, lines } }); refusals.push({ action: "present_balance_twice", code: "EVIDENCE_SINGLE_USE" }); }
  if (!reused) add("EVIDENCE_SINGLE_USE_OK", "pass", "pack", { detail: { evidence_uses: Object.keys(uses).length } });

  // ── 5. Deposit history ──────────────────────────────────────────────────────────────────────────────────────
  if (I.deposit) {
    const D = I.deposit;
    for (const m of D.movements) {
      const p = probative(ev[m.evidence], { kind: "bank_statement", amount: m.amount, account: m.receiving_account, within: [P0.start, P0.end] });
      add("DEPOSIT_MOVEMENT", p.ok ? "pass" : "evidence_missing", "deposits", { detail: { amount: m.amount, receiving_account: m.receiving_account, why: p.why } });
    }
    const explained = sum(D.movements.map((m) => m.amount)) + sum((D.history ?? []).filter((h) => probative(ev[h.evidence], { kind: ["deposit_certificate", "bank_confirmation"], amount: h.amount }).ok).map((h) => h.amount));
    const unexplained = B(D.approved_opening) - explained - (D.closing_evidenced != null ? B(D.closing_evidenced) : 0n);
    if (unexplained !== 0n || D.closing_evidenced == null) add("DEPOSIT_HISTORY_INCOMPLETE", "evidence_missing", "deposits", { detail: { approved_opening: D.approved_opening, unexplained: S(unexplained), closing_evidenced: D.closing_evidenced ?? null, request: D.request } });
    else add("DEPOSIT_HISTORY_EXPLAINED", "pass", "deposits");
    refusals.push({ action: "restate_prior_year_deposit", code: "INFERENCE_NOT_EVIDENCE" }, { action: "recognise_additional_deposit_asset", code: "EVIDENCE_SINGLE_USE" });
  }

  // ── 6. Opening-balance bridge ───────────────────────────────────────────────────────────────────────────────
  // What a classification's evidence must STATE (account, amount, date, identity), not just what kind of document it is.
  const openingNeed = (cls, l, diffAbs) => {
    const base = { amount_abs: diffAbs, account: l.accounts };
    switch (cls.kind) {
      case "mapping": return { ...base, kind: ["opening_journal", "account_mapping_schedule"], within: ["1900-01-01", P0.start] };
      case "timing": return { ...base, kind: ["bank_reconciliation_prior", "bank_statement_subsequent"], within: [addDays(P0.start, -31), addDays(P0.start, 90)] };
      case "unposted_audit_adjustment": return { ...base, kind: ["audit_adjustment_schedule"], within: ["1900-01-01", P0.start] };
      case "possible_prior_period_error": return { ...base, kind: ["error_analysis"], present: ["ref"], within: ["1900-01-01", P0.end] };
      default: return { ...base, kind: ["other_document"], within: ["1900-01-01", P0.end] };
    }
  };
  for (const l of I.opening_bridge?.lines ?? []) {
    const scope = `opening:${l.line}`;
    const ledgerOpening = l.ledger_opening ?? (I.ledger ? S(sum(l.accounts.map((k) => I.ledger.accounts[k] ?? "0"))) : null);
    if (ledgerOpening === null) { add("OPENING_NOT_COMPARED", "evidence_missing", scope, { detail: { why: "no ledger opening" } }); continue; }
    const diff = B(ledgerOpening) - B(l.approved);
    if (diff === 0n) { add("OPENING_AGREES", "pass", scope, { detail: { level: l.level, note: l.level === "line" ? "agrees at statement-line level only; constituents not verified" : undefined } }); continue; }
    const cls = l.classification;
    if (!cls) { add("OPENING_DIFFERENCE_UNCLASSIFIED", "suspected", scope, { detail: { difference: S(diff) } }); continue; }
    const need = openingNeed(cls, l, absStr(S(diff)));
    const okEv = (cls.evidence ?? []).filter((id) => probative(ev[id], need).ok);
    if (!okEv.length) { add("OPENING_CLASSIFICATION_UNEVIDENCED", "evidence_missing", scope, { detail: { kind: cls.kind, difference: S(diff), must_state: { amount: absStr(S(diff)), account: l.accounts, window: need.within } } }); refusals.push({ action: "approve_without_evidence", code: "APPROVAL_IS_NOT_EVIDENCE" }); continue; }
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
      const ok = (e.links ?? []).some((id) => probative(ev[id], { amount_abs: absStr(e.amount), account: k, present: ["entry"], date: undefined }).ok && ev[id].facts.entry === e.id);
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
    const src = probative(ev[R.source_export], { kind: "ledger_export_obe", account: R.account ?? "OBE", within: [P0.start, P0.end] });
    if (!src.ok) add("OBE_CONTENT_UNVERIFIED", "evidence_missing", "opening:equity", { detail: { request: R.request } });
    else add("OBE_CONTENT_VERIFIED", "pass", "opening:equity");
  }

  // ── 9. Cut-off / omitted liabilities (independent of bank reconciliation) ─────────────────────────────────
  if (I.cutoff) {
    const C = I.cutoff;
    const scope = "completeness:liabilities";
    const srcOk = (C.search?.sources ?? []).length > 0 && C.search.sources.every((id) => probative(ev[id], { kind: ["subsequent_payments_listing", "supplier_invoice_register"], within: [C.search.required_to, "9999-12-31"] }).ok);
    const searchEnd = srcOk ? C.search.sources.map((id) => ev[id].facts.date).sort()[0] : null;
    const searchOk = srcOk && C.search.from <= addDays(P0.end, 1);
    if (!searchOk) add("CUTOFF_SEARCH_INCOMPLETE", "incomplete", scope, { detail: { request: C.request } });
    else add("CUTOFF_SEARCH_COMPLETE", "pass", scope, { detail: { searched_to: searchEnd } });
    for (const it of C.items ?? []) {
      const inv = probative(ev[it.evidence], { kind: "supplier_invoice", amount: it.amount, ref: it.ref, within: [addDays(P0.end, 1), searchEnd ?? C.search?.to ?? "9999-12-31"] });
      const grn = probative(ev[it.receipt_evidence], { kind: "goods_received_note", ref: it.grn_ref, within: [P0.start, P0.end] });
      // Absence is shown by the reliable ledger, never by a list the caller typed (spec §2.1, §5.5).
      if (!ledgerReliable) { add("CUTOFF_LEDGER_NOT_RELIED", "evidence_missing", scope, { detail: { ref: it.ref } }); continue; }
      const inLedger = I.ledger.entries.some((e) => e.account === it.accrual_account && e.ref === it.ref && B(e.amount) === -B(it.amount));
      if (inLedger) continue;
      if (inv.ok && grn.ok) {
        add("CUTOFF_OMITTED_LIABILITY", "confirmed", scope, { resolves: `corr:cutoff:${it.ref}`, detail: { ref: it.ref, amount: it.amount } });
        proposals.push({ id: `corr:cutoff:${it.ref}`, scope, kind: "reporting_adjustment", lines: [{ account: it.expense_account, amount: it.amount }, { account: it.accrual_account, amount: "-" + it.amount }], requires: ["review_close"] });
      } else if (inv.ok) add("CUTOFF_RECEIPT_DATE_UNEVIDENCED", "evidence_missing", scope, { detail: { ref: it.ref, why: grn.why } });
      else add("CUTOFF_INVOICE_UNEVIDENCED", "evidence_missing", scope, { detail: { ref: it.ref, why: inv.why } });
    }
    if (C.bank_reconciliation_clean) add("BANK_RECONCILIATION_CLEAN_NOT_COMPLETENESS", "pass", scope, { detail: { note: "a clean bank reconciliation does not test unrecorded liabilities" } });
  }

  // ── 10. Opening payable settled and charged to expense (food rations) ──────────────────────────────────────
  const X = I.double_charge;
  if (X) {
    const scope = "payables";
    const pay = probative(ev[X.payment_evidence], { kind: "bank_statement", amount: X.amount, ref: X.cheque, within: [P0.start, P0.end] });
    const entry = (I.ledger?.entries ?? []).find((e) => e.id === X.gl_entry_id);
    const glExpense = ledgerReliable && entry && entry.account === X.expense_account && B(entry.amount) === B(X.amount);
    const voucher = probative(ev[X.voucher], { kind: "payment_voucher", amount: X.amount, ref: X.bill });
    const supplier = probative(ev[X.supplier_confirmation], { kind: ["supplier_statement", "supplier_confirmation"], counterparty: X.payee, ref: X.bill, amount: X.amount });
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
      proposals.push({ id: X.correction_id, scope, kind: "reporting_adjustment", lines: [{ account: X.payable_account, amount: X.amount }, { account: X.expense_account, amount: "-" + X.amount }], requires: ["review_close"] });
    }
  }
  for (const p of I.opening_bridge?.proposals ?? []) {
    if (findings.some((f) => f.scope === `opening:${p.line}` && f.rule === "OPENING_DIFFERENCE_EXPLAINED")) proposals.push({ id: p.id, scope: `opening:${p.line}`, kind: "reporting_adjustment", lines: p.lines, requires: ["review_close"] });
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
    // A partial source fix is completed when applied corrections that supersede it carry exactly the residual.
    if (state === "partial_or_different" && cv.completed_by) {
      const resid = new Map(effect);
      for (const [k, v] of observed) resid.set(k, (resid.get(k) ?? 0n) - v);
      if (eqMap(new Map([...resid].filter(([, v]) => v !== 0n)), netOf(cv.completed_by))) state = "completed_by_residual";
    }
    const prev = cv.previous_state ?? null;
    const adjustmentApplied = state === "not_corrected_in_source" || state === "candidate_needs_confirmation" ? cv.adjustment_approved === true : false;
    corrections.push({ id: cv.id, state, adjustment_applied: adjustmentApplied, residual: state === "partial_or_different" ? diffMap(effect, observed) : null });
    const ok = state === "verified_in_source" || state === "completed_by_residual" || (state === "not_corrected_in_source" && cv.adjustment_approved === true);
    add(`CORRECTION_${state.toUpperCase()}`, ok ? "pass" : "suspected", cv.scope, { detail: { correction: cv.id, previous: prev, residual: corrections.at(-1).residual } });
  }

  // ── 12. Reviewer decisions never stand in for evidence ────────────────────────────────────────────────────
  for (const d of I.decisions ?? []) {
    if (!(d.evidence ?? []).some((id) => probative(ev[id], d.need ?? { present: ["amount"] }).ok)) { refusals.push({ action: d.action, code: "APPROVAL_IS_NOT_EVIDENCE" }); add("DECISION_WITHOUT_EVIDENCE", "evidence_missing", d.scope); }
  }

  // ── 13. Citations: no unverified provision may be encoded as a rule basis ─────────────────────────────────
  let citationsBad = false;
  for (const ci of I.citations ?? []) if (ci.status !== "verified") { citationsBad = true; add("CITATION_UNVERIFIED", "confirmed", "rule_pack", { detail: ci }); refusals.push({ action: "encode_rule", code: "CITATION_UNVERIFIED" }); }
  if (!citationsBad) add("CITATIONS_VERIFIED", "pass", "rule_pack", { detail: { rule_pack: RULE_PACK.id, version: RULE_PACK.version, citations: (I.citations ?? []).length } });

  // ── 14. The ONE authoritative set of effective corrections (D2) ───────────────────────────────────────────
  const approvalOk = (a) => a && a.approver && a.approver !== a.proposer && (a.approver_caps ?? []).includes("review_close");
  const rows = [];
  for (const ra of I.reporting_adjustments ?? []) rows.push({ id: ra.id, cid: ra.correction_id ?? ra.id, approved: ra.approved === true, lines: ra.lines, scope: ra.scope ?? "pack", reverses: ra.reverses ?? null });
  for (const id of I.apply_proposals ?? []) {
    const a = (I.approvals ?? []).find((x) => x.id === id);
    const prop = proposals.find((p) => p.id === id);
    if (!prop) continue;
    if (!approvalOk(a)) { refusals.push({ action: `apply:${id}`, code: "APPROVAL_AUTHORITY" }); continue; }
    rows.push({ id, cid: id, approved: true, lines: prop.lines, scope: prop.scope, reverses: null });
  }
  const { effective, conflicts } = effectiveCorrections(rows, corrections);
  for (const c of conflicts) add(c.rule, c.outcome, c.scope, { detail: c.detail });
  const appliedIds = new Set(effective.map((e) => e.cid));
  const applied = effective;
  const balances = {};
  for (const [k, a] of Object.entries(tbAccounts)) balances[k] = B(a.closing);
  for (const e of applied) for (const l of e.lines) balances[l.account] = (balances[l.account] ?? 0n) + B(l.amount);
  // Post-conditions of the food-rations correction: the payable nets to zero, the expense falls by exactly the payment, cash is untouched.
  let postOk = true;
  if (X) {
    const net = (acct) => sum(applied.flatMap((e) => e.lines).filter((l) => l.account === acct).map((l) => l.amount));
    const touches = applied.some((e) => e.lines.some((l) => l.account === X.payable_account || l.account === X.expense_account));
    if (touches) {
      const problems = [];
      if (net(X.payable_account) !== 0n) problems.push({ payable_net: S(net(X.payable_account)), expected: "0" });
      if (net(X.expense_account) !== -B(X.amount)) problems.push({ expense_net: S(net(X.expense_account)), expected: S(-B(X.amount)) });
      if (X.cash_account && net(X.cash_account) !== 0n) problems.push({ cash_net: S(net(X.cash_account)), expected: "0" });
      if (problems.length) { postOk = false; add("CORRECTION_POSTCONDITION_FAILED", "confirmed", "payables", { detail: { problems } }); }
    }
  }
  for (const f of findings) if (f.resolves && appliedIds.has(f.resolves) && postOk) f.resolved_by = f.resolves;

  // ── Scopes: nothing starts READY (D1) ─────────────────────────────────────────────────────────────────────
  const holding = (f) => f.outcome !== "pass" && !f.resolved_by;
  const isProof = (f) => (f.outcome === "pass" && RULE_PACK.proofRules(f.scope).includes(f.rule)) || (f.outcome === "confirmed" && !!f.resolved_by);
  const scopes = {};
  const scope_reasons = {};
  const names = new Set([...required, ...findings.map((f) => f.scope).filter((s) => s !== "tb")]);
  for (const s of names) {
    const fs = findings.filter((f) => f.scope === s);
    const holds = fs.filter(holding);
    if (holds.length) { scopes[s] = "HELD"; scope_reasons[s] = [...new Set(holds.map((f) => f.rule))].sort(); }
    else if (fs.some(isProof)) scopes[s] = "READY";
    else if (required.has(s)) { scopes[s] = "HELD"; scope_reasons[s] = ["NOT_EVALUATED"]; }
  }
  const reasons = [];
  if (!tbValidated) reasons.push("TB_NOT_VALIDATED");
  for (const s of required) if (scopes[s] !== "READY") reasons.push(`SCOPE_HELD:${s}`);
  // Always-required families: a held scope of these kinds holds every pack whatever the framework selects.
  const ALWAYS = (s) => ["pack", "rule_pack", "ledger"].includes(s) || s.startsWith("population:") || s.startsWith("cash:");
  for (const [s, st] of Object.entries(scopes)) if (st === "HELD" && !required.has(s) && ALWAYS(s)) reasons.push(`SCOPE_HELD:${s}`);

  // ── 15. Finalization: reviewed CONTENT is bound separately from source FRESHNESS (D5) ─────────────────────
  if (I.review !== undefined) {
    if (!I.review || !I.review.reviewed_content_sha256) reasons.push("REVIEW_MISSING");
    else if (I.review.reviewed_content_sha256 !== I.content_sha256_now) reasons.push("REVIEW_STALE");
  }
  const F = I.freshness;
  if (F && F.source === "qbo") {
    const a = F.attestation;
    if (!a) reasons.push("SOURCE_FRESHNESS_UNDETERMINED");
    else {
      const life = Date.parse(a.expires_at) - Date.parse(a.pulled_at);
      if (!(life > 0 && life <= FRESHNESS_MAX_MS)) reasons.push("SOURCE_FRESHNESS_INVALID");
      else if (a.outcome !== "confirmed") reasons.push("SOURCE_CHANGED");
      else if (a.tb_fingerprint !== F.bound?.tb_fingerprint) reasons.push("SOURCE_CHANGED:tb");
      else if (F.bound?.gl_fingerprint && a.gl_fingerprint !== F.bound.gl_fingerprint) reasons.push("SOURCE_CHANGED:gl");
      else if (Date.parse(a.expires_at) <= Date.parse(F.now)) reasons.push("SOURCE_FRESHNESS_STALE");
      else if (a.bound_content_sha256 !== I.content_sha256_now) reasons.push("SOURCE_FRESHNESS_MISMATCH");
    }
  }
  return {
    draft_eligible: draftEligible,
    evidence_upload_allowed: true,
    required_scopes: [...required].sort(),
    findings,
    scopes,
    scope_reasons,
    proposals: proposals.map((p) => ({ id: p.id, lines: p.lines })),
    corrections,
    applied_adjustments: [...appliedIds].sort(),
    balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, S(v)])),
    refusals,
    finalization: { held: reasons.length > 0, reasons: [...new Set(reasons)].sort() },
  };
}

/**
 * The one authoritative set of effective corrections (D2). Input: every approved-adjustment row from any path
 * (a proposal approved in this evaluation, a persisted adjustment), plus the source-verification state of each
 * correction. Output: the corrections whose effect is added to the trial balance, exactly once each.
 *   - rows with one identity and one effect are one correction (duplicate submission, retry, reimport);
 *   - one identity with two effects is a conflict: neither applies;
 *   - two identities with one effect are a duplicate effect: neither applies (a reviewer withdraws one);
 *   - an approved reversal removes its target and itself;
 *   - source verification retires (verified), suspends (partial, reversed) or keeps a correction.
 */
export function effectiveCorrections(rows, verification = []) {
  const conflicts = [];
  const byCid = new Map();
  for (const r of rows) (byCid.get(r.cid) ?? byCid.set(r.cid, []).get(r.cid)).push(r);
  const candidates = [];
  for (const [cid, group] of byCid) {
    const digests = new Set(group.map((g) => effectOf(g.lines)));
    if (digests.size > 1) { for (const sc of new Set(group.map((g) => g.scope))) conflicts.push({ rule: "CORRECTION_IDENTITY_CONFLICT", outcome: "confirmed", scope: sc, detail: { correction: cid } }); continue; }
    if (group.length > 1) conflicts.push({ rule: "CORRECTION_DUPLICATE_IGNORED", outcome: "pass", scope: group[0].scope, detail: { correction: cid, copies: group.length } });
    candidates.push({ ...group.find((g) => g.approved) ?? group[0], approved: group.some((g) => g.approved), reverses: group.find((g) => g.reverses)?.reverses ?? null });
  }
  const reversed = new Set(candidates.filter((c) => c.approved && c.reverses).flatMap((c) => [c.cid, c.reverses]));
  for (const id of reversed) { const c = candidates.find((x) => x.cid === id); if (c && !c.reverses) conflicts.push({ rule: "CORRECTION_REVERSED", outcome: "pass", scope: c.scope, detail: { correction: id } }); }
  let live = candidates.filter((c) => c.approved && !reversed.has(c.cid));
  const byEffect = new Map();
  for (const c of live) (byEffect.get(effectOf(c.lines)) ?? byEffect.set(effectOf(c.lines), []).get(effectOf(c.lines))).push(c);
  const dup = new Set();
  for (const [, group] of byEffect) if (group.length > 1) { for (const c of group) dup.add(c.cid); for (const sc of new Set(group.map((g) => g.scope))) conflicts.push({ rule: "CORRECTION_DUPLICATE_EFFECT", outcome: "confirmed", scope: sc, detail: { corrections: group.map((g) => g.cid).sort() } }); }
  live = live.filter((c) => !dup.has(c.cid));
  live = live.filter((c) => { const v = verification.find((x) => x.id === c.cid); return v ? v.adjustment_applied : true; });
  return { effective: live, conflicts };
}

function netOf(lines) { const m = new Map(); for (const l of lines) m.set(l.account, (m.get(l.account) ?? 0n) + BigInt(l.amount)); return new Map([...m].filter(([, v]) => v !== 0n)); }
function sameEffect(lines, effect) { const m = new Map(); for (const l of lines) m.set(l.account, (m.get(l.account) ?? 0n) + BigInt(l.amount)); return eqMap(m, effect); }
function eqMap(a, b) { const ks = new Set([...a.keys(), ...b.keys()]); for (const k of ks) if ((a.get(k) ?? 0n) !== (b.get(k) ?? 0n)) return false; return true; }
function diffMap(want, got) { const o = {}; for (const k of new Set([...want.keys(), ...got.keys()])) { const d = (want.get(k) ?? 0n) - (got.get(k) ?? 0n); if (d !== 0n) o[k] = d.toString(); } return o; }
