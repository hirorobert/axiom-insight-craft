/**
 * Frozen exports → the registrations "Check my books" sends. Pure: it parses with the strict readers, maps ledger accounts to
 * the workspace's accounts and refuses (with the file, line and column) anything it cannot read exactly. Nothing is repaired.
 */
import type { Bank, BridgeLine, Cutoff, DoubleCharge, OpeningBridge, ScopeFacts } from "../../../supabase/functions/_shared/readiness/types";
import { parseApprovedFigures } from "./intake/approvedFigures";
import { parseBankStatementExport } from "./intake/bankStatement";
import { parseEvidenceRegister } from "./intake/evidenceRegister";
import { parseGeneralLedgerExport } from "./intake/generalLedger";

export interface WorkspaceAccount { key: string; code: string | null; name: string }
export interface Registration { family: string; key: string; payload: Record<string, unknown>; source: "export_file"; file_sha256: string }

/** What the accountant (or the engagement setup) decides around the files. */
export interface CheckSettings {
  scopeFacts: ScopeFacts;
  bank?: Omit<Bank, "statements">; doubleCharge?: DoubleCharge; cutoff?: Cutoff;
  classifications?: Record<string, NonNullable<BridgeLine["classification"]>>; proposals?: NonNullable<OpeningBridge["proposals"]>;
}

export function parseSettings(text: string): CheckSettings {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error("The settings file is not valid JSON."); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("The settings file must be a JSON object.");
  const o = v as Record<string, unknown>;
  if (!o.scopeFacts || typeof o.scopeFacts !== "object" || Array.isArray(o.scopeFacts)) throw new Error("The settings file needs a scopeFacts object saying which checks apply.");
  return o as unknown as CheckSettings;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
export function accountKeyOfFactory(accounts: readonly WorkspaceAccount[]): (cell: string) => string | undefined {
  return (cell) => {
    const t = cell.trim();
    const first = t.split(/\s+/)[0];
    const byKey = accounts.find((a) => a.key === first || a.code === first);
    if (byKey) return byKey.key;
    const rest = norm(t.replace(/^\S+\s+/, ""));
    return accounts.find((a) => norm(a.name) === norm(t) || norm(a.name) === rest)?.key;
  };
}

export interface ImportInput {
  gl?: { name: string; text: string };
  bank?: { name: string; text: string; bankId: string; from: string; to: string; pagesTotal: number };
  approved?: { name: string; text: string };
  evidence?: { name: string; text: string };
  settings: CheckSettings;
  period: { start: string; end: string; currency: string; exponent: number };
  accounts: readonly WorkspaceAccount[];
}

export function buildRegistrations(i: ImportInput): Registration[] {
  const out: Registration[] = [];
  const reg = (family: string, key: string, payload: object, file_sha256: string) => out.push({ family, key, payload: payload as Record<string, unknown>, source: "export_file", file_sha256 });
  const x = i.period.exponent;
  if (i.gl) {
    const gl = parseGeneralLedgerExport(i.gl.text, { file: i.gl.name, exponent: x, period: i.period, accountKeyOf: accountKeyOfFactory(i.accounts) });
    reg("ledger_snapshot", "gl", gl.payload, gl.fileSha256);
  }
  if (i.bank) {
    const b = parseBankStatementExport(i.bank.text, { file: i.bank.name, bankId: i.bank.bankId, from: i.bank.from, to: i.bank.to, pagesTotal: i.bank.pagesTotal, exponent: x });
    const base = i.settings.bank ?? { id: i.bank.bankId, ledger_key: null, status: "active" as const, match: { window_days: 5 } };
    reg("bank_account", base.id, { ...base, id: i.bank.bankId, statements: [b.statement] } satisfies Bank, b.fileSha256);
  }
  if (i.approved) {
    const a = parseApprovedFigures(i.approved.text, { file: i.approved.name, exponent: x });
    const cls = i.settings.classifications ?? {};
    const bridge: OpeningBridge = { basis: a.basis, lines: a.lines.map((l) => (cls[l.line] ? { ...l, classification: cls[l.line] } : l)), proposals: i.settings.proposals ?? [] };
    reg("opening_bridge", "opening_bridge", bridge, a.fileSha256);
  }
  if (i.evidence) {
    const ev = parseEvidenceRegister(i.evidence.text, i.evidence.name);
    for (const d of ev.documents) reg("evidence", d.id, ev.evidence[d.id], d.file_sha256 ?? ev.fileSha256);
    if (i.settings.doubleCharge) reg("double_charge", "double_charge", i.settings.doubleCharge, ev.fileSha256);
    if (i.settings.cutoff) reg("cutoff", "cutoff", i.settings.cutoff, ev.fileSha256);
  }
  return out;
}
