/**
 * Pilot files → the registrations the readiness functions accept (rfr_register_input), and a hand-assembled LoadedInputs so
 * the real engine can run over the pilot without a database. Payload shapes are exactly those documented at the top of
 * supabase/functions/_shared/readiness/load.ts.
 */
import type { LoadedInputs } from "../../../../supabase/functions/_shared/readiness/load";
import type { Bank, Cutoff, DoubleCharge, Line, OpeningBridge, ScopeFacts } from "../../../../supabase/functions/_shared/readiness/types";
import { parseMinor } from "../intake/amount";
import { parseApprovedFigures } from "../intake/approvedFigures";
import { parseBankStatementExport } from "../intake/bankStatement";
import { parseCsv, requireColumns } from "../intake/csv";
import { parseEvidenceRegister } from "../intake/evidenceRegister";
import { parseGeneralLedgerExport } from "../intake/generalLedger";
import {
  PILOT_ACCOUNTS, PILOT_BANK_ID, PILOT_BILL, PILOT_CHEQUE, PILOT_FILE_NAMES, PILOT_FOOD, PILOT_INVOICE, PILOT_OUTSTANDING, PILOT_PAYEE, PILOT_PERIOD, type PilotFiles, type PilotOptions,
} from "./pilotData";

/** In the pilot the account code is the account key. */
export const PILOT_ACCOUNT_KEYS: readonly string[] = PILOT_ACCOUNTS.map((a) => a.code);
export const pilotAccountKeyOf = (cell: string): string | undefined => {
  const token = cell.trim().split(/\s+/)[0];
  return PILOT_ACCOUNT_KEYS.includes(token) ? token : undefined;
};

export interface Registration { family: string; key: string; payload: Record<string, unknown>; source: "export_file"; file_sha256: string }
export interface PilotExtras {
  scopeFacts: ScopeFacts; bank: Omit<Bank, "statements">; doubleCharge: DoubleCharge; cutoff: Omit<Cutoff, "items"> & { items: NonNullable<Cutoff["items"]> };
  classifications: Record<string, NonNullable<OpeningBridge["lines"][number]["classification"]>>; proposals: NonNullable<OpeningBridge["proposals"]>;
}

/** What the accountant (or the server's scope setup) decides around the files: the scope, the classification of the one difference, the search window. */
export function pilotExtras(opts: PilotOptions = {}): PilotExtras {
  const food = PILOT_FOOD.toString();
  return {
    scopeFacts: { banks: [PILOT_BANK_ID], opening_lines: ["cash", "equipment", "payables-food", "remaining"], payables_settlement: true, liabilities_completeness: true },
    bank: { id: PILOT_BANK_ID, ledger_key: "1020", status: "active", match: { window_days: 5 },
      ...(opts.outstandingCheque ? { outstanding: [{ entry_id: "CHQ-000777#2", cleared_by: "EV-JUL-STMT", request: "statement for 1 to 15 July 2026 showing cheque 000777" }] } : {}) },
    doubleCharge: {
      amount: food, cheque: PILOT_CHEQUE, bill: PILOT_BILL, payee: PILOT_PAYEE, payment_evidence: "EV-NMB-001593", gl_entry_id: `CHQ-${PILOT_CHEQUE}#1`, expense_account: "5607", payable_account: "2000",
      voucher: "EV-PV-001593", supplier_confirmation: "EV-ERA-CONF", approved_fs: "EV-V02-N13", bridge_line: "payables-food", correction_id: `corr:food:${PILOT_BILL}`, cash_account: "1020",
    },
    cutoff: {
      search: { from: "2026-07-01", to: "2026-08-14", required_to: "2026-08-14", basis: "longest supplier payment term on file (45 days)", sources: ["EV-PAYLIST", "EV-INVREG"] },
      items: opts.omittedLiability ? [{ ref: "INV-7781", grn_ref: "552", amount: PILOT_INVOICE.toString(), evidence: "EV-INV-7781", receipt_evidence: "EV-GRN-552", expense_account: "5300", accrual_account: "2200" }] : [],
      request: "subsequent payments listing and supplier invoice register to 14 August 2026",
    },
    classifications: { "payables-food": { kind: "mapping", evidence: ["EV-OBE-JNL"] } },
    proposals: [{ id: "corr:opening:payables-food", line: "payables-food", lines: [{ account: "3050", amount: food }, { account: "2000", amount: "-" + food }] }],
  };
}

export interface PilotRegistrations { scopeFacts: ScopeFacts; registrations: Registration[]; parsed: { gl: ReturnType<typeof parseGeneralLedgerExport>; bank: ReturnType<typeof parseBankStatementExport> } }

export function buildPilotRegistrations(p: { files: PilotFiles; accountKeyOf: (cell: string) => string | undefined; extras: PilotExtras }): PilotRegistrations {
  const { files, accountKeyOf, extras } = p;
  const x = PILOT_PERIOD.exponent;
  const gl = parseGeneralLedgerExport(files.gl, { file: PILOT_FILE_NAMES.gl, exponent: x, period: PILOT_PERIOD, accountKeyOf });
  const bank = parseBankStatementExport(files.bank, { file: PILOT_FILE_NAMES.bank, bankId: extras.bank.id, from: PILOT_PERIOD.start, to: PILOT_PERIOD.end, pagesTotal: 2, exponent: x });
  const approved = parseApprovedFigures(files.approved, { file: PILOT_FILE_NAMES.approved, exponent: x });
  const ev = parseEvidenceRegister(files.evidence, PILOT_FILE_NAMES.evidence);

  const registrations: Registration[] = [];
  const reg = (family: string, key: string, payload: object, file_sha256: string) => registrations.push({ family, key, payload: payload as Record<string, unknown>, source: "export_file", file_sha256 });
  reg("ledger_snapshot", "gl", gl.payload, gl.fileSha256);
  reg("bank_account", extras.bank.id, { ...extras.bank, statements: [bank.statement] } satisfies Bank, bank.fileSha256);
  for (const d of ev.documents) reg("evidence", d.id, ev.evidence[d.id], d.file_sha256 ?? ev.fileSha256);
  const bridge: OpeningBridge = {
    basis: approved.basis,
    lines: approved.lines.map((l) => (extras.classifications[l.line] ? { ...l, classification: extras.classifications[l.line] } : l)),
    proposals: extras.proposals,
  };
  reg("opening_bridge", "opening_bridge", bridge, approved.fileSha256);
  reg("double_charge", "double_charge", extras.doubleCharge, ev.fileSha256);
  reg("cutoff", "cutoff", extras.cutoff, ev.fileSha256);
  return { scopeFacts: extras.scopeFacts, registrations, parsed: { gl, bank } };
}

/** The certified trial balance as the loader returns it (the real path reads it from the certification). Blank cells are zero. */
export function readPilotTb(text: string): NonNullable<LoadedInputs["accounts"]> {
  const t = parseCsv(text, PILOT_FILE_NAMES.tb);
  const ix = requireColumns(t, ["Account code", "Account name", "Debit", "Credit"]);
  return t.records.map((r) => {
    const w = (c: string) => ({ file: t.file, line: r.line, column: ix[c] + 1 });
    return {
      key: r.fields[ix["Account code"]].trim(), code: r.fields[ix["Account code"]].trim(), name: r.fields[ix["Account name"]].trim(), classification: "unclassified",
      debitMinor: parseMinor(r.fields[ix.Debit], PILOT_PERIOD.exponent, w("Debit"), "Debit").toString(), creditMinor: parseMinor(r.fields[ix.Credit], PILOT_PERIOD.exponent, w("Credit"), "Credit").toString(),
    };
  });
}

type Adj = NonNullable<LoadedInputs["adjustments"]>[number];
/** The two corrections of the food-rations case, as approved adjustments that apply. */
export function pilotAdjustments(): Adj[] {
  const food = PILOT_FOOD.toString();
  return [
    { adjustmentId: "adj-opening", correctionId: "corr:opening:payables-food", scope: "opening:payables-food", reversesCorrection: null, anchor: [PILOT_BILL],
      lines: [{ account: "3050", amount: food }, { account: "2000", amount: "-" + food }] },
    { adjustmentId: "adj-food", correctionId: `corr:food:${PILOT_BILL}`, scope: "payables", reversesCorrection: null, anchor: [PILOT_BILL, PILOT_CHEQUE],
      lines: [{ account: "2000", amount: food }, { account: "5607", amount: "-" + food }] },
  ];
}
/** The omitted-liability correction (accrue goods received before year end and invoiced after it). */
export function omittedLiabilityAdjustment(): Adj {
  const a = PILOT_INVOICE.toString();
  return { adjustmentId: "adj-cutoff", correctionId: "corr:cutoff:INV-7781", scope: "completeness:liabilities", reversesCorrection: null, anchor: ["INV-7781"], lines: [{ account: "5300", amount: a }, { account: "2200", amount: "-" + a }] };
}

export function pilotLoadedInputs(p: { files: PilotFiles; extras: PilotExtras; adjustments?: Adj[]; drop?: (r: Registration) => boolean }): LoadedInputs {
  const built = buildPilotRegistrations({ files: p.files, accountKeyOf: pilotAccountKeyOf, extras: p.extras });
  return {
    state: "current", contentSha256: "0".repeat(64), certificationId: "cert-pilot",
    period: { start: PILOT_PERIOD.start, end: PILOT_PERIOD.end, currency: PILOT_PERIOD.currency, exponent: PILOT_PERIOD.exponent },
    scope: { rulePackId: "rfr-pilot-ipsas-accrual", rulePackVersion: "1.0.0", facts: built.scopeFacts },
    accounts: readPilotTb(p.files.tb),
    inputs: built.registrations.filter((r) => !p.drop?.(r)).map((r) => ({ family: r.family, key: r.key, source: r.source, payload: r.payload })),
    adjustments: p.adjustments ?? [], corrections: [],
  };
}
export type { Line };
export { PILOT_OUTSTANDING };
