/**
 * Ask CFOClose (Release 0.1) — the context envelope and fact catalogue for ONE statement line.
 *
 * The database composes the statements (fs_statement_composition, read with the person's own credentials, so the database
 * decides access); this module only selects the line, calculates the movement with exact integer arithmetic, and records
 * every figure the assistant may mention as a typed fact. The model never calculates and never writes a figure: it may only
 * REFER to a fact by id, and the server renders the value from the fact record (assistantResponse.ts).
 *
 *   · Amounts are exact minor units (strings of integers); nothing is converted to floating point.
 *   · A figure the server did not establish is a fact with status "not_computed" and a reason — never zero.
 *   · A line with no contributing accounts is "no_records", distinct from a verified zero (accounts > 0, amount 0).
 *   · Percentage change is computed only on a non-zero comparative of the same sign; otherwise not_computed with the reason.
 *   · Account names are tenant text: carried as untrusted LABELS (data), never as instructions, and length-bounded.
 *
 * Pure: no I/O, no clock, no randomness. The envelope's digest binds a response to exactly these facts.
 */
import { canonicalJson, sha256Hex, type CanonicalValue } from "./hash.ts";

export const CONTEXT_SCHEMA = "cfoclose-assistant-context/1";
export const MAX_ACCOUNT_FACTS = 5;
const MAX_LABEL = 120;
const MINOR = /^(0|-?[1-9][0-9]*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AssistantAction = "explain_movement" | "draft_commentary";
export const ACTIONS: readonly AssistantAction[] = ["explain_movement", "draft_commentary"];

export type FactKind = "amount" | "change" | "percent" | "year";
export type FactStatus = "composed" | "no_records" | "not_computed";
export interface Fact {
  id: string;
  kind: FactKind;
  /** What the fact is, in words the model and the reader see (server-authored, except an account's own name). */
  description: string;
  /** amount/change: minor units; percent: tenths of a percent; year: the year. null when not computed. */
  value: string | null;
  currency: string | null;
  exponent: number | null;
  period: "current" | "comparative" | "change";
  status: FactStatus;
  /** Why a figure is not available (not_computed / no_records). */
  reason: string | null;
  sourceRef: string;
}
export interface Source { id: string; kind: "statement_line" | "certification" | "account"; label: string }

export interface ContextEnvelope {
  schema: typeof CONTEXT_SCHEMA;
  action: AssistantAction;
  companyId: string;
  periodYear: number;
  statement: "SFP" | "SCI";
  section: string;
  lineId: string;
  lineLabel: string;
  currency: string;
  exponent: number;
  comparativeState: string;
  comparativeRestated: boolean;
  /** The composition this was built from. The answer is refused if it changes before the answer is returned. */
  compositionSha256: string;
  inputSha256: string;
  facts: Fact[];
  sources: Source[];
  /** Release 0.1 retrieves no evidence of business causes; every explanation must say the cause is not established. */
  causeEvidence: "none";
}

export type BuildResult =
  | { ok: true; envelope: ContextEnvelope }
  | { ok: false; code: "COMPOSITION_UNAVAILABLE" | "UNKNOWN_LINE" | "COMPOSITION_INVALID"; reason: string };

// ── The composition payload (only the fields read here; validated, never trusted blindly) ──────────────────────────
interface Amount { amountMinor: string; accounts: number }
interface CmpAmount extends Amount { asReportedMinor: string; restated: boolean }
interface Lineage { period: "current" | "comparative"; accountKey: string; accountCode: string | null; accountName: string; amountMinor: string; certificationId: string | null; kind: string }
interface Line { statement: "SFP" | "SCI"; section: string; lineId: string; label: string; current: Amount; comparative: CmpAmount | null; lineage: Lineage[] }
interface Composition {
  state: "composed"; inputSha256: string; compositionSha256: string;
  current: { periodYear: number; certificationId: string; currency: string; exponent: number };
  comparative: { state: string; periodYear: number | null; certificationId: string | null };
  lines: Line[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMinor = (v: unknown): v is string => typeof v === "string" && MINOR.test(v);
const isAmount = (v: unknown): v is Amount => isObj(v) && isMinor(v.amountMinor) && Number.isInteger(v.accounts) && (v.accounts as number) >= 0;

function asComposition(p: unknown): Composition | string {
  if (!isObj(p)) return "not an object";
  if (p.state !== "composed") return `state ${String(p.state ?? "missing")}`;
  if (typeof p.compositionSha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.compositionSha256)) return "compositionSha256";
  if (typeof p.inputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.inputSha256)) return "inputSha256";
  const c = p.current;
  if (!isObj(c) || !Number.isInteger(c.periodYear) || typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency)
    || !Number.isInteger(c.exponent) || (c.exponent as number) < 0 || (c.exponent as number) > 4 || typeof c.certificationId !== "string" || !UUID.test(c.certificationId)) return "current";
  const k = p.comparative;
  if (!isObj(k) || typeof k.state !== "string") return "comparative";
  if (!Array.isArray(p.lines)) return "lines";
  for (const l of p.lines) {
    if (!isObj(l) || (l.statement !== "SFP" && l.statement !== "SCI") || typeof l.lineId !== "string" || typeof l.label !== "string"
      || typeof l.section !== "string" || !isAmount(l.current) || !Array.isArray(l.lineage)) return "line";
    if (l.comparative !== null && !(isAmount(l.comparative) && isMinor((l.comparative as Record<string, unknown>).asReportedMinor)
      && typeof (l.comparative as Record<string, unknown>).restated === "boolean")) return `line ${l.lineId} comparative`;
    for (const g of l.lineage as unknown[]) {
      if (!isObj(g) || (g.period !== "current" && g.period !== "comparative") || typeof g.accountKey !== "string"
        || typeof g.accountName !== "string" || !isMinor(g.amountMinor)) return `line ${l.lineId} lineage`;
    }
  }
  return p as unknown as Composition;
}

// ── Exact arithmetic ─────────────────────────────────────────────────────────────────────────────────────────────────
/** Rounds n/d half away from zero (d > 0). */
function divRound(n: bigint, d: bigint): bigint {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a * 2n + d) / (2n * d);
  return neg ? -q : q;
}

/**
 * Percentage change in tenths of a percent, or the reason it is not meaningful.
 *   comparative 0                 → not computed ("the comparative is zero")
 *   opposite signs (+ → − or − →+)→ not computed ("the balance changed sign")
 *   same sign (incl. both negative) → (current − comparative) / |comparative|, rounded half away from zero
 *   current 0, comparative ≠ 0    → −100.0% (a full decrease), computed
 */
export function percentChange(currentMinor: string, comparativeMinor: string): { tenths: string } | { reason: string } {
  const cur = BigInt(currentMinor), cmp = BigInt(comparativeMinor);
  if (cmp === 0n) return { reason: "the comparative is zero, so a percentage change is not meaningful" };
  if (cur !== 0n && (cur < 0n) !== (cmp < 0n)) return { reason: "the balance changed sign between the periods, so a percentage change is not meaningful" };
  const base = cmp < 0n ? -cmp : cmp;
  return { tenths: divRound((cur - cmp) * 1000n, base).toString() };
}

const clip = (s: string) => {
  // Control characters and markup delimiters removed; length bounded. The name stays data either way.
  const t = s.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1)}…` : t;
};

// ── The envelope ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function buildEnvelope(payload: unknown, req: { action: AssistantAction; companyId: string; periodYear: number; lineId: string }): BuildResult {
  if (isObj(payload) && payload.state !== "composed") {
    return { ok: false, code: "COMPOSITION_UNAVAILABLE", reason: typeof payload.state === "string" ? payload.state : "unavailable" };
  }
  const c = asComposition(payload);
  if (typeof c === "string") return { ok: false, code: "COMPOSITION_INVALID", reason: c };
  if (c.current.periodYear !== req.periodYear) return { ok: false, code: "COMPOSITION_INVALID", reason: "period" };
  const line = c.lines.find((l) => l.lineId === req.lineId);
  if (!line) return { ok: false, code: "UNKNOWN_LINE", reason: "the line is not in the composed statements" };

  const cur = c.current;
  const lineRef = `line:${line.lineId}`;
  const curCert = `certification:${cur.certificationId}`;
  const cmpCert = c.comparative.certificationId ? `certification:${c.comparative.certificationId}` : null;
  const comparativeOn = c.comparative.state === "available" && line.comparative !== null;
  const money = { currency: cur.currency, exponent: cur.exponent };
  const facts: Fact[] = [];
  const sources: Source[] = [
    { id: lineRef, kind: "statement_line", label: clip(line.label) },
    { id: curCert, kind: "certification", label: `Certified trial balance, ${cur.periodYear}` },
  ];
  if (cmpCert && comparativeOn) sources.push({ id: cmpCert, kind: "certification", label: `Certified trial balance, ${c.comparative.periodYear}` });

  const notCmp = comparativeReason(c.comparative.state);
  // Periods are facts too: the model never writes a year in its own text.
  facts.push({ id: "period.current", kind: "year", description: "The current reporting year", value: String(cur.periodYear),
    currency: null, exponent: null, period: "current", status: "composed", reason: null, sourceRef: curCert });
  facts.push(comparativeOn && c.comparative.periodYear !== null
    ? { id: "period.comparative", kind: "year", description: "The comparative year", value: String(c.comparative.periodYear), currency: null, exponent: null, period: "comparative", status: "composed", reason: null, sourceRef: cmpCert ?? lineRef }
    : { id: "period.comparative", kind: "year", description: "The comparative year", value: null, currency: null, exponent: null, period: "comparative", status: "not_computed", reason: notCmp, sourceRef: lineRef });

  const amountFact = (id: string, description: string, a: Amount | null, period: "current" | "comparative", sourceRef: string, missing: string | null): Fact =>
    a === null || missing
      ? { id, kind: "amount", description, value: null, ...money, period, status: "not_computed", reason: missing ?? "not available", sourceRef }
      : a.accounts === 0
        ? { id, kind: "amount", description, value: null, ...money, period, status: "no_records", reason: "no account is presented on this line for this period", sourceRef }
        : { id, kind: "amount", description, value: a.amountMinor, ...money, period, status: "composed", reason: null, sourceRef };

  const curFact = amountFact("line.current", `${clip(line.label)} — current year`, line.current, "current", curCert, null);
  const cmpFact = amountFact("line.comparative", `${clip(line.label)} — comparative year${line.comparative?.restated ? " (as restated)" : ""}`,
    line.comparative, "comparative", cmpCert ?? lineRef, comparativeOn ? null : notCmp);
  facts.push(curFact, cmpFact);
  if (comparativeOn && line.comparative!.restated) {
    facts.push({ id: "line.comparative_as_reported", kind: "amount", description: `${clip(line.label)} — comparative year as originally reported`,
      value: line.comparative!.asReportedMinor, ...money, period: "comparative", status: "composed", reason: null, sourceRef: cmpCert ?? lineRef });
  }
  facts.push(...movementFacts("line", clip(line.label), curFact, cmpFact, money, lineRef));

  // Contributing accounts: the largest movements first, bounded. Names are data.
  const byAccount = new Map<string, { name: string; code: string | null; cur: bigint | null; cmp: bigint | null }>();
  for (const g of line.lineage) {
    if (g.kind !== "account") continue;
    const e = byAccount.get(g.accountKey) ?? { name: g.accountName, code: g.accountCode, cur: null, cmp: null };
    const v = BigInt(g.amountMinor);
    if (g.period === "current") e.cur = (e.cur ?? 0n) + v; else e.cmp = (e.cmp ?? 0n) + v;
    byAccount.set(g.accountKey, e);
  }
  const ranked = [...byAccount.entries()]
    .map(([key, e]) => ({ key, ...e, delta: (e.cur ?? 0n) - (comparativeOn ? (e.cmp ?? 0n) : 0n) }))
    .sort((a, b) => { const x = a.delta < 0n ? -a.delta : a.delta, y = b.delta < 0n ? -b.delta : b.delta; return x === y ? a.key.localeCompare(b.key) : (y > x ? 1 : -1); })
    .slice(0, MAX_ACCOUNT_FACTS);
  ranked.forEach((a, i) => {
    const n = i + 1;
    const ref = `account:${a.key}`;
    const label = clip(a.code ? `${a.code} ${a.name}` : a.name);
    sources.push({ id: ref, kind: "account", label });
    const ac: Fact = a.cur === null
      ? { id: `account.${n}.current`, kind: "amount", description: `Account "${label}" — current year`, value: null, ...money, period: "current", status: "no_records", reason: "the account has no balance in the current year", sourceRef: ref }
      : { id: `account.${n}.current`, kind: "amount", description: `Account "${label}" — current year`, value: a.cur.toString(), ...money, period: "current", status: "composed", reason: null, sourceRef: ref };
    const ap: Fact = !comparativeOn
      ? { id: `account.${n}.comparative`, kind: "amount", description: `Account "${label}" — comparative year`, value: null, ...money, period: "comparative", status: "not_computed", reason: notCmp, sourceRef: ref }
      : a.cmp === null
        ? { id: `account.${n}.comparative`, kind: "amount", description: `Account "${label}" — comparative year`, value: null, ...money, period: "comparative", status: "no_records", reason: "the account has no balance in the comparative year", sourceRef: ref }
        : { id: `account.${n}.comparative`, kind: "amount", description: `Account "${label}" — comparative year`, value: a.cmp.toString(), ...money, period: "comparative", status: "composed", reason: null, sourceRef: ref };
    facts.push(ac, ap, ...movementFacts(`account.${n}`, `Account "${label}"`, withZeroForAbsentAccount(ac), withZeroForAbsentAccount(ap), money, ref));
  });

  return {
    ok: true,
    envelope: {
      schema: CONTEXT_SCHEMA, action: req.action, companyId: req.companyId, periodYear: req.periodYear,
      statement: line.statement, section: line.section, lineId: line.lineId, lineLabel: clip(line.label),
      currency: cur.currency, exponent: cur.exponent, comparativeState: c.comparative.state,
      comparativeRestated: comparativeOn && line.comparative!.restated,
      compositionSha256: c.compositionSha256, inputSha256: c.inputSha256, facts, sources, causeEvidence: "none",
    },
  };
}

/**
 * An account present in one period only has, in the other, genuinely no balance on this line; for its MOVEMENT that is a
 * movement from (or to) nothing. The amount fact itself stays "no_records" — only the change uses zero.
 */
function withZeroForAbsentAccount(f: Fact): Fact {
  return f.status === "no_records" ? { ...f, value: "0", status: "composed" } : f;
}

function movementFacts(prefix: string, label: string, cur: Fact, cmp: Fact, money: { currency: string; exponent: number }, sourceRef: string): Fact[] {
  const missing = cur.status !== "composed" ? cur.reason : cmp.status !== "composed" ? cmp.reason : null;
  if (missing || cur.value === null || cmp.value === null) {
    const reason = missing ?? "not available";
    return [
      { id: `${prefix}.change`, kind: "change", description: `${label} — change from the comparative year`, value: null, ...money, period: "change", status: "not_computed", reason, sourceRef },
      { id: `${prefix}.change_percent`, kind: "percent", description: `${label} — percentage change`, value: null, currency: null, exponent: null, period: "change", status: "not_computed", reason, sourceRef },
    ];
  }
  const delta = (BigInt(cur.value) - BigInt(cmp.value)).toString();
  const pct = percentChange(cur.value, cmp.value);
  return [
    { id: `${prefix}.change`, kind: "change", description: `${label} — change from the comparative year`, value: delta, ...money, period: "change", status: "composed", reason: null, sourceRef },
    "tenths" in pct
      ? { id: `${prefix}.change_percent`, kind: "percent", description: `${label} — percentage change`, value: pct.tenths, currency: null, exponent: null, period: "change", status: "composed", reason: null, sourceRef }
      : { id: `${prefix}.change_percent`, kind: "percent", description: `${label} — percentage change`, value: null, currency: null, exponent: null, period: "change", status: "not_computed", reason: pct.reason, sourceRef },
  ];
}

export function comparativeReason(state: string): string {
  switch (state) {
    case "available": return "the comparative is not available for this line";
    case "missing": return "there is no prior-year trial balance";
    case "different_currency": return "the prior year is in another currency (translation is not supported)";
    case "not_authoritative": return "the prior year has no authoritative certification";
    case "legacy_certification": return "the prior year's certification predates exact amounts";
    case "reference_only": return "the prior-year statements are held as reference only";
    default: return "the comparative is not available";
  }
}

export async function envelopeDigest(e: ContextEnvelope): Promise<string> {
  return sha256Hex(canonicalJson(e as unknown as CanonicalValue));
}

// ── Display (the ONLY place a figure becomes text) ───────────────────────────────────────────────────────────────────
function groupDigits(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
export function formatMinor(minor: string, exponent: number): string {
  const neg = minor.startsWith("-");
  const digits = (neg ? minor.slice(1) : minor).padStart(exponent + 1, "0");
  const whole = groupDigits(digits.slice(0, digits.length - exponent) || "0");
  const frac = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : "";
  return `${whole}${frac}`;
}
/** The rendered value of a fact, or the words for why it is not available. */
export function displayFact(f: Fact): string {
  if (f.status === "no_records") return `no amount recorded (${f.reason})`;
  if (f.status !== "composed" || f.value === null) return `not available (${f.reason ?? "not computed"})`;
  switch (f.kind) {
    case "year": return f.value;
    case "amount": {
      const neg = f.value.startsWith("-");
      const v = formatMinor(neg ? f.value.slice(1) : f.value, f.exponent ?? 0);
      return neg ? `${f.currency} (${v})` : `${f.currency} ${v}`;
    }
    case "change": {
      const neg = f.value.startsWith("-");
      const v = formatMinor(neg ? f.value.slice(1) : f.value, f.exponent ?? 0);
      return f.value === "0" ? `no change (${f.currency} 0${(f.exponent ?? 0) > 0 ? "." + "0".repeat(f.exponent ?? 0) : ""})` : `${neg ? "a decrease of" : "an increase of"} ${f.currency} ${v}`;
    }
    case "percent": {
      const t = BigInt(f.value);
      const a = t < 0n ? -t : t;
      return `${t < 0n ? "-" : t > 0n ? "+" : ""}${a / 10n}.${a % 10n}%`;
    }
  }
}
