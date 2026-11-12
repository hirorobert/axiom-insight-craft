/**
 * Ready for Reporting V3 — acceptance fixtures (rfr-acceptance/2).
 *
 * Every expected value below is written by hand from the specification and the cited source. Nothing in `expected` is
 * computed by the reference model; the runner's self-check fails if the model and these literals disagree.
 *
 * origin:
 *   "ewma"              figures and facts taken from the EWMA FY2025/26 workpapers named in `sources`
 *   "ewma_constructed"  EWMA amounts, but a ledger or document whose STRUCTURE is constructed because the real one has
 *                       not been received (named in `constructed`); never presented as EWMA evidence
 *   "synthetic"         invented to test one rule; no EWMA claim
 * status: "draft" while `freeze_checks` are open (the runner reports these; a draft fixture is never cited as frozen).
 *
 * Money: signed minor units (TZS exponent 2), debit positive. `t("1,234.56")` only converts notation.
 */

export const t = (txt) => {
  const neg = txt.startsWith("-");
  const [w, f = ""] = txt.replace(/^-/, "").replace(/,/g, "").split(".");
  const v = (BigInt(w + f.padEnd(2, "0").slice(0, 2))).toString();
  return neg && v !== "0" ? "-" + v : v;
};
const P = { start: "2025-07-01", end: "2026-06-30", currency: "TZS", exponent: 2 };
const ev = (kind, facts = {}, extraction = "human_confirmed") => ({ kind, facts, extraction });
/** TB of the named accounts plus one balancing line standing for the rest of the EWMA TB (fixture-limited). */
const tb = (accounts) => {
  const total = Object.values(accounts).reduce((a, x) => a + BigInt(x), 0n);
  const out = Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, { closing: v }]));
  out.REST = { closing: (-total).toString(), note: "rest of the trial balance (fixture-limited)" };
  return { validated: true, accounts: out };
};
const withRestInLedger = (ledgerAccounts, tbObj) => ({ ...ledgerAccounts, REST: tbObj.accounts.REST.closing });

// ── EWMA source register (paths are the workpapers the fixtures were read from) ────────────────────────────────
const SRC = {
  TB_V2: { ref: "Enduimet_Adjusted_Trial_Balance_30June2026_v2 (QuickBooks extract, preparer journals AJ1-AJ4)", status: "held" },
  V02: { ref: "EWMA FS 2024/25 V02 (approved): SoFP, Notes 8, 13", status: "held" },
  ML: { ref: "CAG draft management letter 2025/26, Q5 (cheque 001593)", status: "held" },
  NMB_MAIN: { ref: "NMB 40102300487 statement 01/07/2025-09/07/2026, printed pages 1-7 and 9-37 of 40 (bank/tx/main_p*.csv)", status: "held_incomplete" },
  CRDB_TZS: { ref: "CRDB TZS statement transcription (bank/tx/crdb_tzs.json), row 08/06/2026", status: "held" },
  JAMBO: { ref: "NMB 40810053685 Jambo Kili Lodge: latest statement 01/07/2024-29/01/2025 (bank/tx/jambo.json)", status: "held_incomplete" },
  QBO_GL: { ref: "QuickBooks General Ledger export / GeneralLedger report for FY2025/26", status: "requested" },
  QBO_OBE_JNL: { ref: "QuickBooks opening-balance journal(s) posting to Opening Balance Equity", status: "requested" },
  PV_001593: { ref: "Payment voucher for cheque 001593 naming bill 003/2024.2025", status: "requested" },
  ERA_CONF: { ref: "Enduimet Rangers Association confirmation / statement (payee of cheque 001593)", status: "requested" },
  CRDB_CONF: { ref: "CRDB deposit certificates and confirmation at 30/06/2025 and 30/06/2026", status: "requested" },
};

// ── E2 shared pieces (food rations) ─────────────────────────────────────────────────────────────────────────────
const FOOD = t("33,518,793.00");
// Source-freshness attestation (D5): a separate, expiring record bound to the reviewed CONTENT, not part of it.
const NOW = "2026-11-07T10:05:00Z";
const BOUND = { tb_fingerprint: "tb1", gl_fingerprint: "gl1" };
const ATTEST = (o = {}) => ({ id: "att-2", pulled_at: "2026-11-07T10:00:00Z", expires_at: "2026-11-07T10:10:00Z", outcome: "confirmed", tb_fingerprint: "tb1", gl_fingerprint: "gl1", bound_content_sha256: "c1", ...o });
const S1_TB = tb({ "5300": t("12,000,000.00"), "2200": "0" });
const E2_TB = tb({ "5607": t("138,798,548.00"), "2000": "0", OBE: t("-305,357,378.30"), "1020": t("65,772,218.34") });
const E2_LEDGER = {
  snapshot: "constructed-gl-1",
  scope_limited: true,
  accounts: withRestInLedger({ "5607": "0", "2000": "0", OBE: t("-305,357,378.30"), "1020": t("88,050,597.63") }, E2_TB),
  entries: [
    { id: "E-001593#1", date: "2025-07-02", account: "5607", amount: FOOD, ref: "001593", links: ["003/2024.2025"] },
    { id: "E-001593#2", date: "2025-07-02", account: "1020", amount: "-" + FOOD, ref: "001593", links: ["003/2024.2025"] },
    { id: "AGG-5607", date: "2026-06-30", account: "5607", amount: t("105,279,755.00"), constructed_aggregate: true },
    { id: "AGG-1020", date: "2026-06-30", account: "1020", amount: t("11,240,413.71"), constructed_aggregate: true },
  ],
};
const E2_EVIDENCE = {
  "EV-NMB-001593": ev("bank_statement", { amount: FOOD, ref: "001593", date: "2025-07-02", counterparty: "ENDUIMET RANGERS ASSOCIATION" }, "reproduced"),
  "EV-V02-N13": ev("approved_fs_note", { amount: FOOD, ref: "003/2024.2025" }),
  "EV-PV-001593": ev("payment_voucher", { amount: FOOD, ref: "003/2024.2025" }),
  "EV-ERA-CONF": ev("supplier_confirmation", { counterparty: "ENDUIMET RANGERS ASSOCIATION", ref: "003/2024.2025", amount: FOOD }),
  "EV-OBE-JNL": ev("opening_journal", { account: "2000", amount: FOOD, date: "2025-06-30", ref: "003/2024.2025", note: "opening journal shows bill 003/2024.2025 loaded to Opening Balance Equity" }),
};
const E2_DC = {
  amount: FOOD, cheque: "001593", bill: "003/2024.2025", payee: "ENDUIMET RANGERS ASSOCIATION",
  payment_evidence: "EV-NMB-001593", gl_entry_id: "E-001593#1", expense_account: "5607", payable_account: "2000",
  voucher: "EV-PV-001593", supplier_confirmation: "EV-ERA-CONF", approved_fs: "EV-V02-N13",
  bridge_line: "payables-food", correction_id: "corr:food:003/2024.2025", cash_account: "1020",
};
const E2_BRIDGE = (classified) => ({
  basis: "external_signed_fs",
  lines: [{ line: "payables-food", approved: "-" + FOOD, accounts: ["2000"], level: "subledger", ...(classified ? { classification: { kind: "mapping", evidence: ["EV-OBE-JNL"] } } : {}) }],
  proposals: [{ id: "corr:opening:payables-food", line: "payables-food", lines: [{ account: "OBE", amount: FOOD }, { account: "2000", amount: "-" + FOOD }] }],
});
const E2_EFFECT = [{ account: "OBE", amount: FOOD }, { account: "5607", amount: "-" + FOOD }]; // combined effect of the two adjustments
const E2_ANCHOR = ["corr:food:003/2024.2025", "001593", "003/2024.2025"];
const E2_APPROVALS = [
  { id: "corr:opening:payables-food", proposer: "preparer-1", approver: "reviewer-1", approver_caps: ["review_close"] },
  { id: "corr:food:003/2024.2025", proposer: "preparer-1", approver: "reviewer-1", approver_caps: ["review_close"] },
];
const E2_EXISTING = [{ id: "corr:food:003/2024.2025", approved: true, lines: [{ account: "OBE", amount: FOOD }, { account: "5607", amount: "-" + FOOD }], note: "both approved reporting adjustments, combined" }];
const CORRECTED_TB = tb({ "5607": t("105,279,755.00"), "2000": "0", OBE: t("-271,838,585.30"), "1020": t("65,772,218.34") });
const lifecycle = (id, title, tbObj, postings, extra = {}) => ({
  id, title, origin: "ewma_constructed", status: "draft", category: "correction_lifecycle",
  constructed: ["QuickBooks journal(s) in the later snapshot"], sources: [SRC.TB_V2, SRC.QBO_GL],
  inputs: {
    period: P, tb: tbObj, required_scopes: ["payables"],
    reporting_adjustments: E2_EXISTING,
    correction_verification: [{ id: "corr:food:003/2024.2025", scope: "payables", effect: E2_EFFECT, anchor: E2_ANCHOR, adjustment_approved: true, snapshot: { id: `snap-${id}`, postings }, ...(extra.cv ?? {}) }, ...(extra.cvRepeat ? [{ id: "corr:food:003/2024.2025", scope: "payables", effect: E2_EFFECT, anchor: E2_ANCHOR, adjustment_approved: true, snapshot: { id: `snap-${id}`, postings } }] : [])],
  },
  ...extra.rest,
});

export const CASES = [
  // ═══ E1 — TZS 100M CRDB principal payout ═══════════════════════════════════════════════════════════════════════
  {
    id: "E1", title: "TZS 100,000,000 CRDB principal payout; prior-year deposit TZS 200,000,000", origin: "ewma", status: "draft",
    sources: [SRC.CRDB_TZS, SRC.V02, SRC.TB_V2, SRC.CRDB_CONF],
    freeze_checks: ["read the CRDB TZS account number and statement period end from the statement header", "cite the V02 note line for the 200,000,000.00 fixed deposit"],
    inputs: {
      period: P,
      tb: tb({ "1030": t("119,601,778.84"), "1032": "0" }),
      required_scopes: ["deposits", "cash:CRDB-TZS"],
      population: { ledger: ["CRDB-USD-0252241325200"], statements: ["CRDB-USD-0252241325200", "CRDB-TZS"] },
      banks: [
        { id: "CRDB-TZS", ledger_key: null, status: "active", statements: [{ file: "crdb-tzs", sha: "sha-crdb-tzs", from: "2025-07-01", to: "2026-06-30", pages_total: null, pages_missing: [], opening: null, rows: [{ date: "2026-06-08", amount: t("100,000,000.00"), balance: t("119,209,092.89"), ref: "AA25247CKBBX" }] }] },
        { id: "CRDB-USD-0252241325200", ledger_key: "1030", status: "active", statements: [{ file: "crdb-usd", sha: "sha-crdb-usd", from: "2025-07-01", to: "2026-06-30", pages_missing: [], opening: null, rows: [] }] },
      ],
      deposit: { approved_opening: t("200,000,000.00"), movements: [{ amount: t("100,000,000.00"), evidence: "EV-CRDB-PAYOUT", receiving_account: "CRDB-TZS" }], history: [], closing_evidenced: null, request: SRC.CRDB_CONF.ref },
      evidence: { "EV-CRDB-PAYOUT": ev("bank_statement", { amount: t("100,000,000.00"), ref: "AA25247CKBBX", date: "2026-06-08", account: "CRDB-TZS" }, "reproduced") },
    },
    expected: {
      findings: [
        { rule: "DEPOSIT_MOVEMENT", outcome: "pass", scope: "deposits" },
        { rule: "DEPOSIT_HISTORY_INCOMPLETE", outcome: "evidence_missing", scope: "deposits" },
        { rule: "BANK_ACCOUNT_NOT_IN_LEDGER", outcome: "suspected", scope: "cash:CRDB-TZS" },
      ],
      scopes: { deposits: "HELD", "cash:CRDB-TZS": "HELD" },
      proposals: [],
      refusals: ["restate_prior_year_deposit", "recognise_additional_deposit_asset"],
      balances: { "1030": t("119,601,778.84"), "1032": "0" },
      finalization: { held: true, reasons: ["SCOPE_HELD:cash:CRDB-TZS", "SCOPE_HELD:cash:CRDB-USD-0252241325200", "SCOPE_HELD:deposits"] },
      user_sees: "We found a TZS 100,000,000.00 fixed-deposit principal payout on 8 June 2026 into the CRDB TZS account. Last year's approved statements show a TZS 200,000,000.00 deposit. Upload CRDB's deposit certificates or confirmation to explain the other TZS 100,000,000.00. The CRDB TZS account has no account in your ledger: choose which ledger account it is before its balance can be reported.",
      permitted_correction: "none until the deposit history and the ledger account for CRDB TZS are evidenced; no restatement of 2024/25 and no second deposit asset",
    },
    mutations: [
      {
        id: "E1-M1", title: "the same CRDB TZS balance is presented as both fixed deposit and cash",
        patch: { evidence_uses: [{ evidence: "EV-CRDB-TZS-CLOSE", line: "Fixed deposit - CRDB" }, { evidence: "EV-CRDB-TZS-CLOSE", line: "Cash at bank - CRDB TZS" }] },
        expected: { add_findings: [{ rule: "EVIDENCE_USED_TWICE", outcome: "confirmed", scope: "pack" }], finalization_reasons_include: ["SCOPE_HELD:pack"], refusals_include: ["present_balance_twice"] },
      },
    ],
  },

  // ═══ E2 — food rations: pilot path (constructed GL and documents) ═════════════════════════════════════════════
  {
    id: "E2", title: "TZS 33,518,793.00 food-rations bill paid 2 July 2025 and charged to expense (pilot path)", origin: "ewma_constructed", status: "draft", pilot: true,
    constructed: ["General Ledger rows (structure); aggregate lines AGG-5607 / AGG-1020", "payment voucher", "payee confirmation", "QuickBooks opening journal"],
    sources: [SRC.NMB_MAIN, SRC.V02, SRC.ML, SRC.TB_V2, SRC.QBO_GL, SRC.PV_001593, SRC.ERA_CONF, SRC.QBO_OBE_JNL],
    freeze_checks: ["replace constructed GL rows with the real QuickBooks GL export and re-run tie-out", "confirm the supplier on bill 003/2024.2025 is the cheque payee (bank row names Enduimet Rangers Association)"],
    inputs: {
      period: P, tb: E2_TB, ledger: E2_LEDGER, gl_dependent_scopes: ["payables"], required_scopes: ["payables", "opening:payables-food", "ledger"],
      opening_bridge: E2_BRIDGE(true), double_charge: E2_DC, evidence: E2_EVIDENCE,
      apply_proposals: ["corr:opening:payables-food", "corr:food:003/2024.2025"], approvals: E2_APPROVALS,
    },
    expected: {
      findings: [
        { rule: "LEDGER_TIEOUT", outcome: "pass", scope: "ledger" },
        { rule: "OPENING_DIFFERENCE_EXPLAINED", outcome: "pass", scope: "opening:payables-food" },
        { rule: "OPENING_PAYABLE_CHARGED_TO_EXPENSE", outcome: "confirmed", scope: "payables", resolved_by: "corr:food:003/2024.2025" },
      ],
      scopes: { payables: "READY", "opening:payables-food": "READY", ledger: "READY" },
      proposals: [
        { id: "corr:opening:payables-food", lines: [{ account: "OBE", amount: FOOD }, { account: "2000", amount: "-" + FOOD }] },
        { id: "corr:food:003/2024.2025", lines: [{ account: "2000", amount: FOOD }, { account: "5607", amount: "-" + FOOD }] },
      ],
      balances: { "5607": t("105,279,755.00"), "2000": "0", OBE: t("-271,838,585.30"), "1020": t("65,772,218.34") },
      assertions: ["no_adjustment_touches_cash:1020", "cheque_once:001593:1020"],
      finalization: { held: false, reasons: [] },
      cash_flow: "Cash is unchanged: the one bank payment of 33,518,793.00 (cheque 001593, 2 July 2025) stays a single operating payment, now settling the opening payable. Indirect method: surplus +33,518,793.00; decrease in payables -33,518,793.00.",
      user_sees: "TZS 33,518,793.00 was charged to food-ration expense on 2 July 2025, but it paid last year's approved bill 003/2024.2025. Correcting it lowers this year's expense by 33,518,793.00 and settles the opening payable. Cash does not change.",
      permitted_correction: "two reporting adjustments, each one effect: (1) opening bridge Dr Opening Balance Equity / Cr Payable 33,518,793.00 (approved liability missing from the ledger opening); (2) Dr Payable / Cr Food ration 33,518,793.00. Or the same correction posted in QuickBooks and verified (E2-L1).",
    },
    mutations: [
      { id: "E2-M1", title: "no payment voucher (EWMA today)", patch: { evidence: { ...E2_EVIDENCE, "EV-PV-001593": undefined } }, expected: { replace_finding: { rule: "OPENING_PAYABLE_CHARGED_TO_EXPENSE", outcome: "suspected", scope: "payables" }, scopes: { payables: "HELD" }, proposals_exclude: ["corr:food:003/2024.2025"], finalization_held: true } },
      { id: "E2-M2", title: "approver is the proposer under the two-person policy", patch: { approvals: E2_APPROVALS.map((a) => ({ ...a, approver: "preparer-1" })) }, expected: { refusals_include: ["apply:corr:food:003/2024.2025"], scopes: { payables: "HELD" }, finalization_held: true } },
      { id: "E2-M3", title: "opening journal not supplied: the opening liability is not established in the ledger bridge", patch: { opening_bridge: E2_BRIDGE(false), apply_proposals: [] }, expected: { add_findings: [{ rule: "OPENING_DIFFERENCE_UNCLASSIFIED", outcome: "suspected", scope: "opening:payables-food" }], proposals_exclude: ["corr:opening:payables-food", "corr:food:003/2024.2025"], finalization_held: true } },
    ],
  },
  {
    id: "E2-REAL", title: "food rations with the evidence EWMA holds today", origin: "ewma", status: "draft",
    sources: [SRC.NMB_MAIN, SRC.V02, SRC.ML, SRC.TB_V2],
    inputs: {
      period: P, tb: E2_TB, ledger: null, gl_dependent_scopes: ["payables"], required_scopes: ["payables", "opening:payables-food"],
      opening_bridge: E2_BRIDGE(false), double_charge: E2_DC,
      evidence: { "EV-NMB-001593": E2_EVIDENCE["EV-NMB-001593"], "EV-V02-N13": E2_EVIDENCE["EV-V02-N13"] },
    },
    expected: {
      draft_eligible: true,
      findings: [
        { rule: "LEDGER_REQUIRED", outcome: "evidence_missing", scope: "payables" },
        { rule: "OPENING_NOT_COMPARED", outcome: "evidence_missing", scope: "opening:payables-food" },
        { rule: "OPENING_PAYABLE_CHARGED_TO_EXPENSE", outcome: "suspected", scope: "payables" },
      ],
      scopes: { payables: "HELD", "opening:payables-food": "HELD" },
      proposals: [],
      balances: { "5607": t("138,798,548.00"), "2000": "0", OBE: t("-305,357,378.30") },
      finalization: { held: true, reasons: ["SCOPE_HELD:opening:payables-food", "SCOPE_HELD:payables"] },
      user_sees: "TZS 33,518,793.00 may have been charged to expense twice. We found last year's approved bill and the 2 July 2025 bank payment. Upload the General Ledger, the payment voucher and the payee's confirmation to confirm the correction.",
    },
  },
  lifecycle("E2-L1", "QuickBooks correction posted and verified: the reporting adjustment retires, the effect counts once", CORRECTED_TB,
    [{ id: "QBO-JE-881", lines: E2_EFFECT, links: ["003/2024.2025"] }],
    { rest: { expected: { corrections: [{ id: "corr:food:003/2024.2025", state: "verified_in_source", adjustment_applied: false }], scopes: { payables: "READY" }, balances: { "5607": t("105,279,755.00"), OBE: t("-271,838,585.30") }, applied_adjustments: [], finalization: { held: false, reasons: [] } } } }),
  lifecycle("E2-L2", "partial QuickBooks correction (20,000,000.00 of 33,518,793.00)", tb({ "5607": t("118,798,548.00"), "2000": "0", OBE: t("-285,357,378.30"), "1020": t("65,772,218.34") }),
    [{ id: "QBO-JE-883", lines: [{ account: "OBE", amount: t("20,000,000.00") }, { account: "5607", amount: t("-20,000,000.00") }], links: ["003/2024.2025"] }],
    { rest: { expected: { corrections: [{ id: "corr:food:003/2024.2025", state: "partial_or_different", adjustment_applied: false, residual: { OBE: t("13,518,793.00"), "5607": t("-13,518,793.00") } }], scopes: { payables: "HELD" }, applied_adjustments: [], balances: { "5607": t("118,798,548.00") }, finalization: { held: true, reasons: ["SCOPE_HELD:payables"] }, user_sees: "QuickBooks now corrects 20,000,000.00 of the 33,518,793.00. Propose the remaining 13,518,793.00 or complete the correction in QuickBooks." } } }),
  lifecycle("E2-L3", "QuickBooks correction later reversed: nothing is silently reinstated", E2_TB,
    [{ id: "QBO-JE-881", lines: E2_EFFECT, links: ["003/2024.2025"] }, { id: "QBO-JE-881-R", lines: E2_EFFECT.map((l) => ({ ...l, amount: l.amount.startsWith("-") ? l.amount.slice(1) : "-" + l.amount })), links: ["003/2024.2025"] }],
    { cv: { previous_state: "verified_in_source" }, rest: { expected: { corrections: [{ id: "corr:food:003/2024.2025", state: "corrected_then_reversed", adjustment_applied: false }], scopes: { payables: "HELD" }, balances: { "5607": t("138,798,548.00") }, finalization: { held: true, reasons: ["SCOPE_HELD:payables"] } } } }),
  lifecycle("E2-L4", "the same snapshot imported twice: one correction, one effect", CORRECTED_TB,
    [{ id: "QBO-JE-881", lines: E2_EFFECT, links: ["003/2024.2025"] }],
    { cvRepeat: true, rest: { expected: { corrections_count: 1, corrections: [{ id: "corr:food:003/2024.2025", state: "verified_in_source", adjustment_applied: false }], balances: { "5607": t("105,279,755.00") }, finalization: { held: false, reasons: [] } } } }),
  lifecycle("E2-L5", "an unrelated posting of the same amount (a refund banked to 1020) is not the correction", tb({ "5607": t("105,279,755.00"), "2000": "0", OBE: t("-305,357,378.30"), "1020": t("99,291,011.34") }),
    [{ id: "QBO-DEP-912", lines: [{ account: "1020", amount: FOOD }, { account: "5607", amount: "-" + FOOD }], links: [] }],
    { rest: { expected: { corrections: [{ id: "corr:food:003/2024.2025", state: "not_corrected_in_source", adjustment_applied: true }], applied_adjustments: ["corr:food:003/2024.2025"], balances: { "5607": t("71,760,962.00"), OBE: t("-271,838,585.30") }, scopes: { payables: "READY" }, finalization: { held: false, reasons: [] } } } }),

  // E2-L6/L7: a PARTIAL source fix completed (or not) by a residual correction that supersedes the original.
  ...(() => {
    const RID = "corr:food:003/2024.2025:residual";
    const RES = [{ account: "OBE", amount: t("13,518,793.00") }, { account: "5607", amount: t("-13,518,793.00") }];
    const part = tb({ "5607": t("118,798,548.00"), "2000": "0", OBE: t("-285,357,378.30"), "1020": t("65,772,218.34") });
    const post = [{ id: "QBO-JE-883", lines: [{ account: "OBE", amount: t("20,000,000.00") }, { account: "5607", amount: t("-20,000,000.00") }], links: ["003/2024.2025"] }];
    const mk = (id, title, res, expected) => ({
      id, title, origin: "ewma_constructed", status: "draft", category: "correction_lifecycle", constructed: ["QuickBooks journal in the later snapshot"], sources: [SRC.TB_V2, SRC.QBO_GL],
      inputs: {
        period: P, tb: part, required_scopes: ["payables"], reporting_adjustments: [{ id: RID, approved: true, lines: res }],
        correction_verification: [
          { id: "corr:food:003/2024.2025", scope: "payables", effect: E2_EFFECT, anchor: E2_ANCHOR, adjustment_approved: false, completed_by: res, snapshot: { id: `snap-${id}`, postings: post } },
          { id: RID, scope: "payables", effect: res, anchor: [RID], adjustment_approved: true, snapshot: { id: `snap-${id}`, postings: post } },
        ],
      },
      expected,
    });
    return [
      mk("E2-L6", "partial QuickBooks fix (20,000,000.00) completed by an approved residual correction of 13,518,793.00", RES,
        { corrections: [{ id: "corr:food:003/2024.2025", state: "completed_by_residual", adjustment_applied: false }, { id: RID, state: "not_corrected_in_source", adjustment_applied: true }], scopes: { payables: "READY" }, applied_adjustments: [RID], balances: { "5607": t("105,279,755.00"), OBE: t("-271,838,585.30") }, finalization: { held: false, reasons: [] } }),
      mk("E2-L7", "partial QuickBooks fix and a residual of the WRONG amount: the correction stays incomplete", [{ account: "OBE", amount: t("10,000,000.00") }, { account: "5607", amount: t("-10,000,000.00") }],
        { corrections: [{ id: "corr:food:003/2024.2025", state: "partial_or_different", adjustment_applied: false, residual: { OBE: t("13,518,793.00"), "5607": t("-13,518,793.00") } }], scopes: { payables: "HELD" }, finalization: { held: true, reasons: ["SCOPE_HELD:payables"] } }),
    ];
  })(),

  // ═══ E3 — Opening Balance Equity 821,968,164.19 ═══════════════════════════════════════════════════════════════
  {
    id: "E3", title: "Opening Balance Equity: TZS 821,968,164.19 is an arithmetic reconstruction, not verified content", origin: "ewma", status: "draft",
    sources: [SRC.TB_V2, SRC.QBO_OBE_JNL, SRC.QBO_GL],
    inputs: {
      period: P, tb: tb({ OBE: t("-305,357,378.30") }), required_scopes: ["opening:equity"],
      obe_reconstruction: {
        tb_obe: t("-305,357,378.30"),
        journals: [{ ref: "AJ1", amount: t("-119,601,778.84") }, { ref: "AJ2", amount: t("-122,000,000.00") }, { ref: "AJ3", amount: t("94,817,865.98") }, { ref: "AJ4", amount: t("663,394,698.75") }],
        reconstructed: t("-821,968,164.19"), source_export: null,
        request: "QuickBooks opening-balance journal(s) and a General Ledger export of Opening Balance Equity, entry by entry",
      },
    },
    expected: {
      findings: [{ rule: "OBE_ARITHMETIC", outcome: "pass", scope: "opening:equity" }, { rule: "OBE_CONTENT_UNVERIFIED", outcome: "evidence_missing", scope: "opening:equity" }],
      scopes: { "opening:equity": "HELD" }, proposals: [],
      finalization: { held: true, reasons: ["SCOPE_HELD:opening:equity"] },
      user_sees: "Before the four preparer journals, Opening Balance Equity was 821,968,164.19 (credit). We reproduced that figure from the trial balance and the journals; we have not seen the entries that make it up. Upload the opening-balance journal and the ledger detail.",
    },
    mutations: [{ id: "E3-M1", title: "a mistyped reconstruction is caught", patch: { obe_reconstruction: { tb_obe: t("-305,357,378.30"), journals: [{ ref: "AJ1", amount: t("-119,601,778.84") }, { ref: "AJ2", amount: t("-122,000,000.00") }, { ref: "AJ3", amount: t("94,817,865.98") }, { ref: "AJ4", amount: t("663,394,698.75") }], reconstructed: t("-821,986,164.19"), source_export: null } }, expected: { replace_finding: { rule: "OBE_ARITHMETIC", outcome: "confirmed", scope: "opening:equity" } } }],
  },

  // ═══ E4 — missing bank pages and omitted or unmatched accounts ══════════════════════════════════════════════
  {
    id: "E4", title: "NMB main pages 8 and 38-40 missing; Jambo statement stops 29/01/2025; CRDB TZS has no ledger account", origin: "ewma", status: "draft",
    sources: [SRC.NMB_MAIN, SRC.JAMBO, SRC.CRDB_TZS, SRC.TB_V2],
    freeze_checks: ["page-8 gap: the bank workpaper note states net debits 7,059,664.92, while the last page-7 and first page-9 rows in main_p01_09.csv imply 12,786,950.80; resolve against the PDF before freezing"],
    inputs: {
      period: P, tb: tb({ "1020": t("65,772,218.34"), "1025": t("11,560,070.41") }),
      required_scopes: ["cash:NMB-40102300487", "cash:NMB-40810053685", "cash:CRDB-TZS"],
      population: { ledger: ["NMB-40102300487", "NMB-40810053685"], statements: ["NMB-40102300487", "NMB-40810053685", "CRDB-TZS"] },
      banks: [
        { id: "NMB-40102300487", ledger_key: "1020", status: "active", supplied_pages_all_matched: true, statements: [{ file: "nmb-main", sha: "sha-nmb", from: "2025-07-01", to: "2026-07-09", pages_total: 40, pages_missing: [8, 38, 39, 40], opening: null,
          rows: [{ date: "2025-08-27", amount: t("-348,642.94"), balance: t("160,550,996.09") }, { date: "2025-09-01", amount: t("-1,000,000.00"), balance: t("146,764,045.29"), ref: "001727" }, { date: "2026-06-26", amount: t("-5,621,000.00"), balance: t("122,311,359.72"), ref: "001809", note: "last row available", excerpt_restart: true }] }] },
        { id: "NMB-40810053685", ledger_key: "1025", status: "dormant", period_end_confirmation: null, statements: [{ file: "jambo", sha: "sha-jambo", from: "2024-07-01", to: "2025-01-29", pages_missing: [], opening: null, rows: [] }] },
        { id: "CRDB-TZS", ledger_key: null, status: "active", statements: [{ file: "crdb-tzs", sha: "sha-crdb-tzs", from: "2025-07-01", to: "2026-06-30", pages_missing: [], opening: null, rows: [] }] },
      ],
    },
    expected: {
      findings: [
        { rule: "RUNNING_BALANCE_BREAK", outcome: "confirmed", scope: "cash:NMB-40102300487" },
        { rule: "STATEMENT_PAGES_MISSING", outcome: "evidence_missing", scope: "cash:NMB-40102300487" },
        { rule: "SUPPLIED_PAGES_MATCHED", outcome: "pass", scope: "cash:NMB-40102300487" },
        { rule: "STATEMENT_COVERAGE_GAP", outcome: "evidence_missing", scope: "cash:NMB-40810053685" },
        { rule: "BANK_ACCOUNT_NOT_IN_LEDGER", outcome: "suspected", scope: "cash:CRDB-TZS" },
      ],
      scopes: { "cash:NMB-40102300487": "HELD", "cash:NMB-40810053685": "HELD", "cash:CRDB-TZS": "HELD" },
      finalization: { held: true, reasons: ["SCOPE_HELD:cash:CRDB-TZS", "SCOPE_HELD:cash:NMB-40102300487", "SCOPE_HELD:cash:NMB-40810053685"] },
      user_sees: "NMB 40102300487: printed pages 8 and 38-40 of 40 are missing, so the 30 June 2026 balance is not evidenced (the last row available is 26 June 2026, 122,311,359.72). Jambo Kili Lodge (dormant): the latest statement ends 29 January 2025; upload a statement or bank confirmation at 30 June 2026.",
    },
  },

  // ═══ S1 — June liability absent from the ledger (cut-off) ═══════════════════════════════════════════════════
  {
    id: "S1", title: "goods received 24 June 2026, invoiced 14 July 2026, not in the ledger", origin: "synthetic", status: "frozen",
    inputs: {
      period: P, tb: S1_TB, required_scopes: ["completeness:liabilities"],
      ledger: { snapshot: "syn-s1", accounts: { "5300": t("12,000,000.00"), "2200": "0", REST: S1_TB.accounts.REST.closing }, entries: [] },
      cutoff: {
        search: { from: "2026-07-01", to: "2026-08-14", required_to: "2026-08-14", basis: "longest supplier payment term on file (45 days)", sources: ["EV-PAYLIST", "EV-INVREG"] },
        items: [{ ref: "INV-7781", grn_ref: "552", amount: t("4,250,000.00"), evidence: "EV-INV-7781", receipt_evidence: "EV-GRN-552", expense_account: "5300", accrual_account: "2200" }],
        bank_reconciliation_clean: true, request: "subsequent payments listing and supplier invoice register to 14 August 2026",
      },
      evidence: {
        "EV-PAYLIST": ev("subsequent_payments_listing", { date: "2026-08-14" }), "EV-INVREG": ev("supplier_invoice_register", { date: "2026-08-14" }),
        "EV-INV-7781": ev("supplier_invoice", { amount: t("4,250,000.00"), date: "2026-07-14", ref: "INV-7781" }), "EV-GRN-552": ev("goods_received_note", { date: "2026-06-24", ref: "552" }),
      },
      apply_proposals: ["corr:cutoff:INV-7781"], approvals: [{ id: "corr:cutoff:INV-7781", proposer: "preparer-1", approver: "reviewer-1", approver_caps: ["review_close"] }],
    },
    expected: {
      findings: [{ rule: "CUTOFF_OMITTED_LIABILITY", outcome: "confirmed", scope: "completeness:liabilities", resolved_by: "corr:cutoff:INV-7781" }, { rule: "BANK_RECONCILIATION_CLEAN_NOT_COMPLETENESS", outcome: "pass", scope: "completeness:liabilities" }],
      scopes: { "completeness:liabilities": "READY" },
      proposals: [{ id: "corr:cutoff:INV-7781", lines: [{ account: "5300", amount: t("4,250,000.00") }, { account: "2200", amount: t("-4,250,000.00") }] }],
      balances: { "5300": t("16,250,000.00"), "2200": t("-4,250,000.00") },
      finalization: { held: false, reasons: [] },
      user_sees: "Goods received on 24 June 2026 (GRN 552) were invoiced on 14 July 2026 (INV-7781, 4,250,000.00) and are not in the ledger. Accrue them at 30 June 2026.",
    },
    mutations: [
      { id: "S1-M1", title: "subsequent evidence removed: completeness is incomplete although the bank reconciliation is clean",
        patch: { cutoff: { search: null, items: [], bank_reconciliation_clean: true, request: "subsequent payments listing and supplier invoice register to 14 August 2026" }, apply_proposals: [] },
        expected: { add_findings: [{ rule: "CUTOFF_SEARCH_INCOMPLETE", outcome: "incomplete", scope: "completeness:liabilities" }], scopes: { "completeness:liabilities": "HELD" }, finalization_held: true } },
      { id: "S1-M2", title: "invoice held but the goods-received date is unevidenced", patch: { evidence: { "EV-PAYLIST": ev("subsequent_payments_listing"), "EV-INVREG": ev("supplier_invoice_register"), "EV-INV-7781": ev("supplier_invoice", { amount: t("4,250,000.00"), date: "2026-07-14", ref: "INV-7781" }) }, apply_proposals: [] },
        expected: { add_findings: [{ rule: "CUTOFF_RECEIPT_DATE_UNEVIDENCED", outcome: "evidence_missing", scope: "completeness:liabilities" }], finalization_held: true } },
    ],
  },

  // ═══ S2 — valid outstanding cheque ═════════════════════════════════════════════════════════════════════════════
  {
    id: "S2", title: "cheque 000777 issued 28 June 2026, presented 3 July 2026", origin: "synthetic", status: "frozen",
    inputs: {
      period: P, tb: tb({ "1010": t("8,500,000.00") }), required_scopes: ["cash:BANK-A", "ledger"], gl_dependent_scopes: ["cash:BANK-A"],
      ledger: { snapshot: "syn-1", accounts: { "1010": t("4,000,000.00"), REST: t("-8,500,000.00") }, entries: [
        { id: "R-1", date: "2026-05-10", account: "1010", amount: t("6,000,000.00"), ref: "DEP-1" },
        { id: "C-777", date: "2026-06-28", account: "1010", amount: t("-1,500,000.00"), ref: "000777" },
      ] },
      population: { ledger: ["BANK-A"], statements: ["BANK-A"], banks_requiring_confirmation: ["Bank A"], confirmation_complete: { "Bank A": true } },
      banks: [{ id: "BANK-A", ledger_key: "1010", status: "active", match: { window_days: 5 }, outstanding: [{ entry_id: "C-777", cleared_by: "EV-JUL-STMT", request: "statement for 1-15 July 2026 showing cheque 000777" }],
        statements: [{ file: "bank-a", sha: "sha-a", from: "2025-07-01", to: "2026-06-30", pages_total: 3, pages_missing: [], opening: t("4,000,000.00"), rows: [{ date: "2026-05-10", amount: t("6,000,000.00"), balance: t("10,000,000.00"), ref: "DEP-1" }] }] }],
      evidence: { "EV-JUL-STMT": ev("bank_statement_subsequent", { amount: t("-1,500,000.00"), ref: "000777", date: "2026-07-03", account: "BANK-A" }, "reproduced") },
    },
    expected: {
      findings: [{ rule: "TIMING_ITEM_CLEARED", outcome: "pass", scope: "cash:BANK-A" }, { rule: "CASH_TIES_TO_TB", outcome: "pass", scope: "cash:BANK-A" }],
      scopes: { "cash:BANK-A": "READY" }, finalization: { held: false, reasons: [] },
      user_sees: "Bank balance 10,000,000.00 less cheque 000777 (1,500,000.00, presented 3 July 2026) = 8,500,000.00, which agrees to the ledger and the trial balance.",
    },
    mutations: [{ id: "S2-M1", title: "no subsequent statement: a targeted request, not a blanket two-month rule", patch: { evidence: {} }, expected: { replace_finding: { rule: "TIMING_ITEM_UNSUPPORTED", outcome: "evidence_missing", scope: "cash:BANK-A" }, scopes: { "cash:BANK-A": "HELD" }, finalization_held: true } }],
  },

  // ═══ S3 — supported, non-zero opening equity ═════════════════════════════════════════════════════════════════
  {
    id: "S3", title: "opening accumulated surplus 12,000,000.00 agrees to the prior CFOClose FINAL at account level", origin: "synthetic", status: "frozen",
    inputs: {
      period: P, tb: tb({ "3100": t("-12,000,000.00") }), required_scopes: ["opening:accumulated-surplus"],
      ledger: { snapshot: "syn-3", accounts: { "3100": t("-12,000,000.00"), REST: t("12,000,000.00") }, entries: [] },
      opening_bridge: { basis: "cfoclose_final", lines: [{ line: "accumulated-surplus", approved: t("-12,000,000.00"), accounts: ["3100"], level: "account" }] },
    },
    expected: { findings: [{ rule: "OPENING_AGREES", outcome: "pass", scope: "opening:accumulated-surplus" }], scopes: { "opening:accumulated-surplus": "READY" }, finalization: { held: false, reasons: [] } },
  },

  // ═══ S4 — unsupported suspense entries that cancel to zero ═══════════════════════════════════════════════════
  {
    id: "S4", title: "suspense 1999: +2,000,000.00 and -2,000,000.00 with no support; closing balance zero", origin: "synthetic", status: "frozen",
    inputs: {
      period: P, tb: { validated: true, accounts: { "1999": { closing: "0" }, REST: { closing: "0" } } }, required_scopes: ["suspense:1999"],
      ledger: { snapshot: "syn-4", accounts: { "1999": "0", REST: "0" }, entries: [{ id: "S-1", date: "2026-03-01", account: "1999", amount: t("2,000,000.00") }, { id: "S-2", date: "2026-05-01", account: "1999", amount: t("-2,000,000.00") }] },
      entry_support: { accounts: ["1999"] },
    },
    expected: {
      findings: [{ rule: "ENTRY_UNSUPPORTED", outcome: "evidence_missing", scope: "suspense:1999" }],
      scopes: { "suspense:1999": "HELD" }, finalization: { held: true, reasons: ["SCOPE_HELD:suspense:1999"] },
      user_sees: "Suspense 1999 ends at zero, but its two entries (2,000,000.00 in March, -2,000,000.00 in May) have no support. Attach what each entry was for.",
    },
    mutations: [{ id: "S4-M1", title: "both entries supported", patch: { ledger: { snapshot: "syn-4b", accounts: { "1999": "0", REST: "0" }, entries: [{ id: "S-1", date: "2026-03-01", account: "1999", amount: t("2,000,000.00"), links: ["EV-T1"] }, { id: "S-2", date: "2026-05-01", account: "1999", amount: t("-2,000,000.00"), links: ["EV-T2"] }] }, evidence: { "EV-T1": ev("other_document", { amount: t("2,000,000.00"), account: "1999", entry: "S-1" }), "EV-T2": ev("other_document", { amount: t("-2,000,000.00"), account: "1999", entry: "S-2" }) } }, expected: { replace_finding: { rule: "ENTRIES_SUPPORTED", outcome: "pass", scope: "suspense:1999" }, scopes: { "suspense:1999": "READY" }, finalization_held: false } }],
  },

  // ═══ S7 / S8 — missing GL and failed tie-out: drafting continues ═════════════════════════════════════════════
  {
    id: "S7", title: "no General Ledger: drafting allowed, ledger-dependent checks held", origin: "synthetic", status: "frozen",
    inputs: { period: P, tb: tb({ "1010": t("8,500,000.00") }), ledger: null, gl_dependent_scopes: ["cash:BANK-A", "suspense:1999"], required_scopes: ["cash:BANK-A"] },
    expected: { draft_eligible: true, evidence_upload_allowed: true, findings: [{ rule: "LEDGER_REQUIRED", outcome: "evidence_missing", scope: "cash:BANK-A" }, { rule: "LEDGER_REQUIRED", outcome: "evidence_missing", scope: "suspense:1999" }], finalization: { held: true, reasons: ["SCOPE_HELD:cash:BANK-A"] } },
  },
  {
    id: "S8", title: "General Ledger does not reproduce the TB: that snapshot is not relied on", origin: "synthetic", status: "frozen",
    inputs: { period: P, tb: tb({ "1010": t("8,500,000.00") }), gl_dependent_scopes: ["cash:BANK-A"], required_scopes: ["cash:BANK-A", "ledger"],
      ledger: { snapshot: "syn-8", accounts: { "1010": t("4,000,000.00"), REST: t("-8,500,000.00") }, entries: [{ id: "R-1", date: "2026-05-10", account: "1010", amount: t("6,000,000.00") }] } },
    expected: { draft_eligible: true, findings: [{ rule: "LEDGER_TIEOUT_FAILED", outcome: "confirmed", scope: "ledger" }, { rule: "LEDGER_NOT_RELIED", outcome: "evidence_missing", scope: "cash:BANK-A" }], scopes: { ledger: "HELD" }, finalization: { held: true, reasons: ["SCOPE_HELD:cash:BANK-A", "SCOPE_HELD:ledger"] } },
  },

  // ═══ S9 — duplicate and overlapping statement files ══════════════════════════════════════════════════════════
  {
    id: "S9", title: "same file uploaded twice; overlapping file disagrees on one row", origin: "synthetic", status: "frozen",
    inputs: { period: P, tb: tb({ "1010": t("10,000,000.00") }), required_scopes: ["cash:BANK-A"],
      banks: [{ id: "BANK-A", ledger_key: "1010", status: "active", statements: [
        { file: "a-jan-jun", sha: "s1", from: "2025-07-01", to: "2026-06-30", pages_missing: [], opening: t("4,000,000.00"), rows: [{ date: "2026-05-10", amount: t("6,000,000.00"), balance: t("10,000,000.00") }] },
        { file: "a-jan-jun-copy", sha: "s1", from: "2025-07-01", to: "2026-06-30", pages_missing: [], opening: t("4,000,000.00"), rows: [{ date: "2026-05-10", amount: t("6,000,000.00"), balance: t("10,000,000.00") }] },
        { file: "a-may-scan", sha: "s2", from: "2026-05-01", to: "2026-05-31", pages_missing: [], opening: t("4,000,000.00"), rows: [{ date: "2026-05-10", amount: t("6,500,000.00"), balance: t("10,500,000.00") }] },
      ] }] },
    expected: { findings: [{ rule: "STATEMENT_DUPLICATE_IGNORED", outcome: "pass", scope: "cash:BANK-A" }, { rule: "STATEMENT_OVERLAP_CONFLICT", outcome: "suspected", scope: "cash:BANK-A" }], scopes: { "cash:BANK-A": "HELD" }, finalization: { held: true, reasons: ["SCOPE_HELD:cash:BANK-A"] } },
  },

  // ═══ S10 — reviewer approval without evidence ═════════════════════════════════════════════════════════════════
  {
    id: "S10", title: "a reviewer classifies an opening difference as timing without evidence", origin: "synthetic", status: "frozen",
    inputs: { period: P, tb: tb({ "1010": t("9,000,000.00") }), required_scopes: ["opening:cash"],
      ledger: { snapshot: "syn-10", accounts: { "1010": t("9,000,000.00"), REST: t("-9,000,000.00") }, entries: [] },
      opening_bridge: { basis: "external_signed_fs", lines: [{ line: "cash", approved: t("8,000,000.00"), accounts: ["1010"], level: "account", classification: { kind: "timing", evidence: [], approved_by: "reviewer-1" } }] } },
    expected: { findings: [{ rule: "OPENING_CLASSIFICATION_UNEVIDENCED", outcome: "evidence_missing", scope: "opening:cash" }], refusals: ["approve_without_evidence"], scopes: { "opening:cash": "HELD" }, finalization: { held: true, reasons: ["SCOPE_HELD:opening:cash"] } },
  },

  // ═══ S11 — rule pack may not encode an unverified provision ═══════════════════════════════════════════════════
  {
    id: "S11", title: "a rule citing a provision not verified against the standard is refused", origin: "synthetic", status: "frozen",
    inputs: { period: P, tb: tb({}), citations: [{ rule: "prior-period-error", framework: "IFRS for SMEs", provision: "Section 10 (paragraph not verified)", status: "unverified" }, { rule: "prior-period-error", framework: "IPSAS", provision: "IPSAS 3.47", status: "verified" }] },
    expected: { findings: [{ rule: "CITATION_UNVERIFIED", outcome: "confirmed", scope: "rule_pack" }], refusals: ["encode_rule"], finalization: { held: true, reasons: ["SCOPE_HELD:rule_pack"] } },
  },

  // ═══ S12 — QuickBooks freshness ═══════════════════════════════════════════════════════════════════════════════
  {
    id: "S12", title: "QuickBooks source cannot be re-read at finalization", origin: "synthetic", status: "frozen",
    inputs: { period: P, tb: tb({}), content_sha256_now: "c1", freshness: { source: "qbo", now: NOW, bound: BOUND, attestation: null } },
    expected: { finalization: { held: true, reasons: ["SOURCE_FRESHNESS_UNDETERMINED"] } },
    mutations: [{ id: "S12-M1", title: "a fresh attestation bound to the same content and fingerprints", patch: { freshness: { source: "qbo", now: NOW, bound: BOUND, attestation: ATTEST() } }, expected: { finalization_held: false } }],
  },

  // ═══ FM1..FM5 — the five ways this design could wrongly clear a pack ═════════════════════════════════════════
  {
    id: "FM1", title: "an account known only to the bank (no ledger, no prior year, no upload)", origin: "synthetic", status: "frozen", failure_mode: 1,
    inputs: { period: P, tb: tb({}), required_scopes: [],
      population: { ledger: [], prior_year: [], statements: [], confirmations: ["BANK-B-9"], banks_requiring_confirmation: ["Bank B", "Bank C"], confirmation_complete: { "Bank B": true, "Bank C": false } }, banks: [] },
    expected: { findings: [{ rule: "BANK_ACCOUNT_UNRESOLVED", outcome: "evidence_missing", scope: "cash:BANK-B-9" }, { rule: "BANK_POPULATION_UNCONFIRMED", outcome: "evidence_missing", scope: "population:Bank C" }], finalization: { held: true, reasons: ["SCOPE_HELD:cash:BANK-B-9", "SCOPE_HELD:population:Bank C"] } },
    required_scope_rule: "every population:* and cash:* scope the population check creates is required",
  },
  {
    id: "FM2", title: "two cheques of the same amount: amount-only matching would hide an unrecorded payment", origin: "synthetic", status: "frozen", failure_mode: 2,
    inputs: { period: P, tb: tb({ "1010": t("2,500,000.00") }), required_scopes: ["cash:BANK-A"],
      ledger: { snapshot: "syn-fm2", accounts: { "1010": t("10,000,000.00"), REST: t("-2,500,000.00") }, entries: [{ id: "C-1", date: "2026-06-10", account: "1010", amount: t("-5,000,000.00") }, { id: "C-2", date: "2026-06-12", account: "1010", amount: t("-2,500,000.00") }] },
      banks: [{ id: "BANK-A", ledger_key: "1010", status: "active", match: { window_days: 5 }, statements: [{ file: "a", sha: "a", from: "2025-07-01", to: "2026-06-30", pages_missing: [], opening: t("10,000,000.00"), rows: [{ date: "2026-06-11", amount: t("-5,000,000.00"), balance: t("5,000,000.00"), ref: "000901" }, { date: "2026-06-13", amount: t("-5,000,000.00"), balance: t("0"), ref: "000902" }] }] }] },
    expected: { findings: [{ rule: "MATCH_AMBIGUOUS", outcome: "suspected", scope: "cash:BANK-A" }], scopes: { "cash:BANK-A": "HELD" }, finalization: { held: true } },
  },
  {
    id: "FM3", title: "QuickBooks GL changed after approval while the TB is identical", origin: "synthetic", status: "frozen", failure_mode: 3,
    inputs: { period: P, tb: tb({}), content_sha256_now: "c1", freshness: { source: "qbo", now: NOW, bound: BOUND, attestation: ATTEST({ gl_fingerprint: "gl2" }) } },
    expected: { finalization: { held: true, reasons: ["SOURCE_CHANGED:gl"] } },
  },
  {
    id: "FM4", title: "evidence of the right kind but not probative (AI-read amount, wrong amount)", origin: "synthetic", status: "frozen", failure_mode: 4,
    inputs: { period: P, tb: tb({ "1010": t("8,500,000.00") }), required_scopes: ["cash:BANK-A"],
      ledger: { snapshot: "syn-fm4", accounts: { "1010": t("10,000,000.00"), REST: t("-8,500,000.00") }, entries: [{ id: "C-777", date: "2026-06-28", account: "1010", amount: t("-1,500,000.00"), ref: "000777" }] },
      banks: [{ id: "BANK-A", ledger_key: "1010", status: "active", match: { window_days: 5 }, outstanding: [{ entry_id: "C-777", cleared_by: "EV-AI", request: "statement for 1-15 July 2026 showing cheque 000777" }],
        statements: [{ file: "a", sha: "a", from: "2025-07-01", to: "2026-06-30", pages_missing: [], opening: t("10,000,000.00"), rows: [] }] }],
      evidence: { "EV-AI": ev("bank_statement_subsequent", { amount: t("-1,500,000.00"), ref: "000777", date: "2026-07-03", account: "BANK-A" }, "ai_unconfirmed") } },
    expected: { findings: [{ rule: "TIMING_ITEM_UNSUPPORTED", outcome: "evidence_missing", scope: "cash:BANK-A" }], scopes: { "cash:BANK-A": "HELD" }, finalization: { held: true } },
    mutations: [{ id: "FM4-M1", title: "human-confirmed but a different amount", patch: { evidence: { "EV-AI": ev("bank_statement_subsequent", { amount: t("-1,050,000.00"), ref: "000777", date: "2026-07-03", account: "BANK-A" }) } }, expected: { scopes: { "cash:BANK-A": "HELD" }, finalization_held: true } }],
  },
  lifecycle("FM5", "a same-accounts, same-amount journal with no link to the correction", CORRECTED_TB,
    [{ id: "QBO-JE-990", lines: E2_EFFECT, links: [] }],
    { rest: { failure_mode: 5, expected: { corrections: [{ id: "corr:food:003/2024.2025", state: "candidate_needs_confirmation", adjustment_applied: true }], scopes: { payables: "HELD" }, finalization: { held: true, reasons: ["SCOPE_HELD:payables"] }, user_sees: "A QuickBooks journal has the same effect as your approved correction but does not reference it. Confirm whether it is the correction; until then the pack cannot be finalized." } } }),
];

// ═══ Defect regression fixtures (independent review of 8bb3b1f) ═══════════════════════════════════════════════════
// D1 required checks are derived and need positive proof · D2 one authoritative set of effective corrections ·
// D4 evidence must state the facts a rule depends on · D5 reviewed content is bound apart from source freshness.
// (D3, the sandbox runner, is covered by auditRegression.mjs and the runner tests, not by a case.)
const e2Base = () => structuredClone(CASES.find((c) => c.id === "E2").inputs);
const OPENING_LINES = [{ account: "OBE", amount: FOOD }, { account: "2000", amount: "-" + FOOD }];
const FOOD_LINES = [{ account: "2000", amount: FOOD }, { account: "5607", amount: "-" + FOOD }];
const negate = (lines) => lines.map((l) => ({ ...l, amount: l.amount.startsWith("-") ? l.amount.slice(1) : "-" + l.amount }));
const D = (id, title, defect, inputs, expected, mutations) => ({ id, title, origin: "ewma_constructed", status: "draft", defect, constructed: ["see E2"], sources: [SRC.TB_V2, SRC.QBO_GL], inputs, expected, ...(mutations ? { mutations } : {}) });

CASES.push(
  // ── D1: required checks are derived on the server and each needs positive proof ────────────────────────────────
  {
    id: "D1-TB-ONLY", title: "a balanced, validated TB alone clears nothing", origin: "synthetic", status: "frozen", defect: "D1",
    inputs: { period: P, tb: tb({ "1010": t("8,500,000.00") }), scope_facts: { banks: ["BANK-A"], opening_lines: ["cash"], payables_settlement: true, liabilities_completeness: true } },
    expected: {
      draft_eligible: true, evidence_upload_allowed: true,
      required_scopes: ["cash:BANK-A", "completeness:liabilities", "opening:cash", "pack", "payables", "rule_pack"],
      scopes: { "cash:BANK-A": "HELD", "completeness:liabilities": "HELD", "opening:cash": "HELD", payables: "HELD", pack: "READY", rule_pack: "READY" },
      scope_reasons: { "opening:cash": ["NOT_EVALUATED"] },
      finalization: { held: true, reasons: ["SCOPE_HELD:cash:BANK-A", "SCOPE_HELD:completeness:liabilities", "SCOPE_HELD:opening:cash", "SCOPE_HELD:payables"] },
      user_sees: "Your trial balance is valid, so you can draft. Cash, opening balances, payables and unrecorded liabilities have not been checked yet, so the pack cannot be finalized.",
    },
  },
  {
    id: "D1-UNEVALUATED-BANK", title: "a bank account is in scope, its statements cover the year, but the cash tie was never performed", origin: "synthetic", status: "frozen", defect: "D1",
    inputs: { period: P, tb: tb({ "1010": t("8,500,000.00") }),
      ledger: { snapshot: "syn-d1", accounts: { "1010": t("8,500,000.00"), REST: t("-8,500,000.00") }, entries: [] },
      banks: [{ id: "BANK-A", ledger_key: "1010", status: "active", statements: [{ file: "a", sha: "sa", from: P.start, to: P.end, pages_missing: [], opening: t("8,500,000.00"), rows: [] }] }] },
    expected: { required_scopes: ["cash:BANK-A", "ledger", "pack", "rule_pack"], scopes: { "cash:BANK-A": "HELD", ledger: "READY" }, scope_reasons: { "cash:BANK-A": ["NOT_EVALUATED"] }, finalization: { held: true, reasons: ["SCOPE_HELD:cash:BANK-A"] } },
  },
  {
    id: "D1-DECLARED-CANNOT-SHRINK", title: "the caller's required list can add scopes but cannot remove a derived one", origin: "synthetic", status: "frozen", defect: "D1",
    inputs: { period: P, tb: tb({ "1010": t("8,500,000.00") }), scope_facts: { banks: ["BANK-A"] }, required_scopes: [] },
    expected: { required_scopes: ["cash:BANK-A", "pack", "rule_pack"], finalization: { held: true, reasons: ["SCOPE_HELD:cash:BANK-A"] } },
  },

  // ── D2: one authoritative set of effective corrections ────────────────────────────────────────────────────────
  D("D2-DUP-PERSISTED", "the opening correction is also persisted as a separate adjustment: a duplicate effect, neither counts, readiness holds", "D2",
    { ...e2Base(), reporting_adjustments: [{ id: "adj-persisted-opening", approved: true, lines: OPENING_LINES }] },
    { findings: [{ rule: "CORRECTION_DUPLICATE_EFFECT", outcome: "confirmed", scope: "pack" }, { rule: "CORRECTION_DUPLICATE_EFFECT", outcome: "confirmed", scope: "opening:payables-food" }, { rule: "CORRECTION_POSTCONDITION_FAILED", outcome: "confirmed", scope: "payables" }],
      scopes: { payables: "HELD" }, applied_adjustments: ["corr:food:003/2024.2025"], balances: { "2000": "3351879300", "5607": t("105,279,755.00"), OBE: t("-305,357,378.30") }, finalization: { held: true } }),
  D("D2-DUPLICATE-SUBMISSION", "the same persisted adjustment submitted twice counts once", "D2",
    { period: P, tb: tb({ "5300": t("5,000.00"), "2200": t("-2,000.00") }), reporting_adjustments: [{ id: "corr:dup", approved: true, lines: [{ account: "5300", amount: t("1,000.00") }, { account: "2200", amount: t("-1,000.00") }] }, { id: "corr:dup", approved: true, lines: [{ account: "5300", amount: t("1,000.00") }, { account: "2200", amount: t("-1,000.00") }] }] },
    { findings: [{ rule: "CORRECTION_DUPLICATE_IGNORED", outcome: "pass", scope: "pack" }], applied_adjustments: ["corr:dup"], balances: { "5300": t("6,000.00"), "2200": t("-3,000.00") }, finalization: { held: false, reasons: [] } }),
  D("D2-RETRY", "the approval of both E2 corrections is retried: the balances are exactly those of E2", "D2",
    (() => { const b = e2Base(); b.apply_proposals = [...b.apply_proposals, ...b.apply_proposals]; b.approvals = [...b.approvals, ...b.approvals]; return b; })(),
    { scopes: { payables: "READY" }, applied_adjustments: ["corr:food:003/2024.2025", "corr:opening:payables-food"], balances: { "5607": t("105,279,755.00"), "2000": "0", OBE: t("-271,838,585.30"), "1020": t("65,772,218.34") }, finalization: { held: false, reasons: [] } }),
  D("D2-IDENTITY-CONFLICT", "one correction identity persisted with a different effect than the approved proposal", "D2",
    { ...e2Base(), reporting_adjustments: [{ id: "corr:food:003/2024.2025", approved: true, lines: [{ account: "OBE", amount: FOOD }, { account: "5607", amount: "-" + FOOD }] }] },
    { findings: [{ rule: "CORRECTION_IDENTITY_CONFLICT", outcome: "confirmed", scope: "payables" }], scopes: { payables: "HELD" }, applied_adjustments: ["corr:opening:payables-food"], finalization: { held: true } }),
  D("D2-ONLY-RECLASS", "only the reclassification is approved: the payable would be left a debit, so it cannot clear", "D2",
    (() => { const b = e2Base(); b.apply_proposals = ["corr:food:003/2024.2025"]; return b; })(),
    { findings: [{ rule: "CORRECTION_POSTCONDITION_FAILED", outcome: "confirmed", scope: "payables" }], scopes: { payables: "HELD" }, balances: { "2000": "3351879300", "5607": t("105,279,755.00") }, finalization: { held: true } }),
  D("D2-REVERSAL", "an approved reversal of the reclassification removes both; the expense returns and the opening stays", "D2",
    { ...e2Base(), reporting_adjustments: [{ id: "rev-food", reverses: "corr:food:003/2024.2025", approved: true, lines: negate(FOOD_LINES) }] },
    { findings: [{ rule: "CORRECTION_REVERSED", outcome: "pass", scope: "payables" }, { rule: "CORRECTION_POSTCONDITION_FAILED", outcome: "confirmed", scope: "payables" }], scopes: { payables: "HELD" }, applied_adjustments: ["corr:opening:payables-food"], balances: { "5607": t("138,798,548.00"), "2000": "-3351879300" }, finalization: { held: true } }),
);

// D4 — evidence must state the facts the rule depends on
const caseById = (id) => CASES.find((c) => c.id === id);
caseById("S1").mutations.push(
  { id: "S1-M3", title: "D4: an invoice with no date cannot satisfy the subsequent-period window", patch: { evidence: { ...caseById("S1").inputs.evidence, "EV-INV-7781": ev("supplier_invoice", { amount: t("4,250,000.00"), ref: "INV-7781" }) }, apply_proposals: [] },
    expected: { add_findings: [{ rule: "CUTOFF_INVOICE_UNEVIDENCED", outcome: "evidence_missing", scope: "completeness:liabilities" }], scopes: { "completeness:liabilities": "HELD" }, proposals_exclude: ["corr:cutoff:INV-7781"], finalization_held: true } },
  { id: "S1-M4", title: "D4: a goods-received note with no date is not evidence of receipt before year end", patch: { evidence: { ...caseById("S1").inputs.evidence, "EV-GRN-552": ev("goods_received_note", { ref: "552" }) }, apply_proposals: [] },
    expected: { add_findings: [{ rule: "CUTOFF_RECEIPT_DATE_UNEVIDENCED", outcome: "evidence_missing", scope: "completeness:liabilities" }], proposals_exclude: ["corr:cutoff:INV-7781"], finalization_held: true } },
  { id: "S1-M5", title: "D4: an invoice dated before year end is not a subsequent-period invoice", patch: { evidence: { ...caseById("S1").inputs.evidence, "EV-INV-7781": ev("supplier_invoice", { amount: t("4,250,000.00"), date: "2026-06-20", ref: "INV-7781" }) }, apply_proposals: [] },
    expected: { add_findings: [{ rule: "CUTOFF_INVOICE_UNEVIDENCED", outcome: "evidence_missing", scope: "completeness:liabilities" }], finalization_held: true } },
);
const s10Cls = (docFacts, extraction = "human_confirmed", kind = "opening_journal") => ({
  opening_bridge: { basis: "external_signed_fs", lines: [{ line: "cash", approved: t("8,000,000.00"), accounts: ["1010"], level: "account", classification: { kind: "mapping", evidence: ["EV-X"] } }] },
  evidence: { "EV-X": ev(kind, docFacts, extraction) },
});
const unevid = { add_findings: [{ rule: "OPENING_CLASSIFICATION_UNEVIDENCED", outcome: "evidence_missing", scope: "opening:cash" }], scopes: { "opening:cash": "HELD" }, refusals_include: ["approve_without_evidence"], finalization_held: true };
caseById("S10").mutations = [
  { id: "S10-M1", title: "D4: the right kind of document that states nothing about the difference", patch: s10Cls({}), expected: unevid },
  { id: "S10-M2", title: "D4: the right kind of document naming a different amount", patch: s10Cls({ amount: t("500,000.00"), account: "1010", date: "2025-06-30" }), expected: unevid },
  { id: "S10-M3", title: "D4: a reproduced document with no relevant facts (extraction status is not relevance)", patch: s10Cls({ note: "looks right" }, "reproduced"), expected: unevid },
  { id: "S10-M4", title: "D4: right amount and account but no date", patch: s10Cls({ amount: t("1,000,000.00"), account: "1010" }), expected: unevid },
  { id: "S10-M5", title: "D4: the document is for another account", patch: s10Cls({ amount: t("1,000,000.00"), account: "1020", date: "2025-06-30" }), expected: unevid },
  { id: "S10-M6", title: "D4 control: amount, account and date all stated", patch: s10Cls({ amount: t("1,000,000.00"), account: "1010", date: "2025-06-30" }), expected: { add_findings: [{ rule: "OPENING_DIFFERENCE_EXPLAINED", outcome: "pass", scope: "opening:cash" }], scopes: { "opening:cash": "READY" }, finalization_held: false } },
];
caseById("E2").mutations.push(
  { id: "E2-M4", title: "D4: the opening journal names a different amount, so the opening difference is not evidenced", patch: { evidence: { ...E2_EVIDENCE, "EV-OBE-JNL": ev("opening_journal", { account: "2000", amount: t("3,351,879.30"), date: "2025-06-30", ref: "003/2024.2025" }) } },
    expected: { add_findings: [{ rule: "OPENING_CLASSIFICATION_UNEVIDENCED", outcome: "evidence_missing", scope: "opening:payables-food" }], scopes: { payables: "HELD", "opening:payables-food": "HELD" }, finalization_held: true } },
  { id: "E2-M5", title: "D4: the payee confirmation does not name the bill or the amount", patch: { evidence: { ...E2_EVIDENCE, "EV-ERA-CONF": ev("supplier_confirmation", { counterparty: "ENDUIMET RANGERS ASSOCIATION" }) } },
    expected: { replace_finding: { rule: "OPENING_PAYABLE_CHARGED_TO_EXPENSE", outcome: "suspected", scope: "payables" }, proposals_exclude: ["corr:food:003/2024.2025"], scopes: { payables: "HELD" }, finalization_held: true } },
);

// D5 — the review is bound to CONTENT; source freshness is a separate expiring attestation bound to that content
CASES.push({
  id: "D5-RENEWED", title: "identical books: a renewed attestation clears finalization without a new review", origin: "synthetic", status: "frozen", defect: "D5",
  inputs: { period: P, tb: tb({}), content_sha256_now: "c1", review: { reviewed_content_sha256: "c1" }, freshness: { source: "qbo", now: NOW, bound: BOUND, attestation: ATTEST() } },
  expected: { finalization: { held: false, reasons: [] }, user_sees: "Source re-read at 10:00. Edits made in QuickBooks after that moment are not detected by this check." },
  mutations: [
    { id: "D5-M1", title: "the attestation has expired", patch: { freshness: { source: "qbo", now: "2026-11-07T10:11:00Z", bound: BOUND, attestation: ATTEST() } }, expected: { finalization_held: true, finalization_reasons: ["SOURCE_FRESHNESS_STALE"] } },
    { id: "D5-M2", title: "the books changed: re-review is required even though the attestation is fresh for the new content", patch: { content_sha256_now: "c2", freshness: { source: "qbo", now: NOW, bound: BOUND, attestation: ATTEST({ bound_content_sha256: "c2" }) } }, expected: { finalization_held: true, finalization_reasons: ["REVIEW_STALE"] } },
    { id: "D5-M3", title: "the attestation was made for different content", patch: { freshness: { source: "qbo", now: NOW, bound: BOUND, attestation: ATTEST({ bound_content_sha256: "c0" }) } }, expected: { finalization_held: true, finalization_reasons: ["SOURCE_FRESHNESS_MISMATCH"] } },
    { id: "D5-M4", title: "an attestation valid for longer than the permitted window is refused", patch: { freshness: { source: "qbo", now: NOW, bound: BOUND, attestation: ATTEST({ expires_at: "2026-11-07T11:00:00Z" }) } }, expected: { finalization_held: true, finalization_reasons: ["SOURCE_FRESHNESS_INVALID"] } },
    { id: "D5-M5", title: "an export-bound workspace needs no attestation", patch: { freshness: { source: "export" } }, expected: { finalization_held: false } },
    { id: "D5-M6", title: "no review was recorded", patch: { review: null }, expected: { finalization_held: true, finalization_reasons: ["REVIEW_MISSING"] } },
    { id: "D5-M7", title: "the pull says the books changed", patch: { freshness: { source: "qbo", now: NOW, bound: BOUND, attestation: ATTEST({ outcome: "changed", tb_fingerprint: "tb9" }) } }, expected: { finalization_held: true, finalization_reasons: ["SOURCE_CHANGED"] } },
  ],
});

// Implementation-only contracts (no reference-model evaluation: they need a database or a live source).
export const IMPLEMENTATION_CONTRACTS = [
  { id: "C1", title: "local change commits before finalization", category: "database", requirement: "finalize recomputes the readiness manifest under the scope lock and refuses RFR_MANIFEST_STALE; no FINAL row, no issuance" },
  { id: "C2", title: "finalization commits before a local change", category: "database", requirement: "the change commits after FINAL; FINAL and its manifest are byte-identical afterwards; the next version shows the change and the issued version is listed as superseded only when a later FINAL exists" },
  { id: "C3", title: "finalize at a non-READ COMMITTED isolation", category: "database", requirement: "refused PT412 before any write (tb_require_read_committed pattern)" },
  { id: "C4", title: "every bound-input writer takes the scope lock", category: "database", requirement: "static catalogue check: each function writing a manifest input calls _rfr_scope_lock first" },
  { id: "C5", title: "QuickBooks GeneralLedger response reproduces an independent QuickBooks export", category: "live_sandbox", requirement: "period, basis, account ids, currency, per-account opening + movements = TB closing, entry count; run.mjs --sandbox compares the two files" },
  { id: "C6", title: "QuickBooks transaction identifiers are stable across edits and re-pulls", category: "live_sandbox", requirement: "edit memo and amount of one journal in a sandbox company; re-pull; the TxnId/line id pair is unchanged; deleting it removes it" },
  { id: "C7", title: "issued version keeps its evidence after source objects are replaced", category: "database", requirement: "replacing or retiring a statement file used by a FINAL leaves the FINAL's bound object hashes retrievable (object retention)" },
];
