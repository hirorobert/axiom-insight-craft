/**
 * illustrativeReviewModel — the pure, deterministic logic behind the landing page's sample review.
 *
 * No clock, no randomness, no storage, no network: the same actions always give the same state. A visitor's decisions are
 * an ordered list of recorded entries (no timestamps). The decisions supplied with the example (SAMPLE_SUPPLIED_DECISIONS)
 * are constants this module never writes and never merges into a visitor's state.
 *
 * The statement equation depends on classification: it is null (pending) until every account has a category. The
 * illustrated ready state additionally needs every held account's recorded decision to match what the invented evidence
 * supports; that comparison belongs to this guided example only.
 */

import {
  SAMPLE_CATEGORY_GROUP,
  SAMPLE_HELD_ACCOUNTS,
  SAMPLE_MAPPED_ACCOUNTS,
  SAMPLE_SUPPLIED_DECISIONS,
  type SampleCategory,
} from "@/content/landing/illustrativeReview";

export interface RecordedDecision {
  readonly code: string;
  readonly category: SampleCategory;
}

export interface VisitorState {
  /** What the visitor has selected but not recorded, per held account. */
  readonly selected: Readonly<Record<string, SampleCategory | undefined>>;
  /** Every decision the visitor recorded, in order. The current decision for an account is its latest entry. */
  readonly recorded: readonly RecordedDecision[];
}

export type VisitorAction =
  | { readonly type: "select"; readonly code: string; readonly category: SampleCategory }
  | { readonly type: "record"; readonly code: string }
  | { readonly type: "reset" };

export const INITIAL_VISITOR_STATE: VisitorState = { selected: {}, recorded: [] };

const HELD_CODES = SAMPLE_HELD_ACCOUNTS.map((a) => a.code);
const isHeld = (code: string) => HELD_CODES.includes(code);
const isOption = (code: string, category: SampleCategory) =>
  SAMPLE_HELD_ACCOUNTS.some((a) => a.code === code && a.options.some((o) => o.category === category));

export function visitorReducer(state: VisitorState, action: VisitorAction): VisitorState {
  switch (action.type) {
    case "select":
      if (!isHeld(action.code) || !isOption(action.code, action.category)) return state;
      return { ...state, selected: { ...state.selected, [action.code]: action.category } };
    case "record": {
      const category = state.selected[action.code];
      if (!isHeld(action.code) || !category) return state;
      return { ...state, recorded: [...state.recorded, { code: action.code, category }] };
    }
    case "reset":
      return INITIAL_VISITOR_STATE;
  }
}

/** The visitor's current decision per held account (the latest recorded entry), or undefined. */
export function currentDecision(state: VisitorState, code: string): SampleCategory | undefined {
  for (let i = state.recorded.length - 1; i >= 0; i--) if (state.recorded[i].code === code) return state.recorded[i].category;
  return undefined;
}

export type DecisionStanding = "none" | "supported" | "unsupported";

/** How a recorded decision compares with the invented evidence, in this guided example only. */
export function decisionStanding(state: VisitorState, code: string): DecisionStanding {
  const held = SAMPLE_HELD_ACCOUNTS.find((a) => a.code === code);
  const d = currentDecision(state, code);
  if (!held || !d) return "none";
  return d === held.evidenceSupports ? "supported" : "unsupported";
}

export interface StatementEquation {
  readonly assetsMinor: number;
  readonly liabilitiesMinor: number;
  readonly equityMinor: number;
  readonly resultMinor: number;
  readonly holds: boolean;
}

/** The statement equation for a complete set of categories, or null while any account has none. */
export function statementEquation(categoryOf: (code: string) => SampleCategory | undefined): StatementEquation | null {
  const totals = { assets: 0, liabilities: 0, equity: 0, result: 0 };
  for (const a of SAMPLE_MAPPED_ACCOUNTS) totals[SAMPLE_CATEGORY_GROUP[a.category]] += a.balanceMinor;
  for (const h of SAMPLE_HELD_ACCOUNTS) {
    const category = categoryOf(h.code);
    if (!category) return null;
    totals[SAMPLE_CATEGORY_GROUP[category]] += h.balanceMinor;
  }
  const assetsMinor = totals.assets;
  const liabilitiesMinor = -totals.liabilities;
  const equityMinor = -totals.equity;
  const resultMinor = -totals.result;
  return { assetsMinor, liabilitiesMinor, equityMinor, resultMinor, holds: assetsMinor === liabilitiesMinor + equityMinor + resultMinor };
}

export const visitorEquation = (state: VisitorState) => statementEquation((code) => currentDecision(state, code));

/** The completed example's equation, from the supplied decisions only. */
export const suppliedEquation = () => statementEquation((code) => SAMPLE_SUPPLIED_DECISIONS.find((d) => d.code === code)?.category);

/** The illustrated ready state: every account has a category, the equation holds, and every held decision is supported. */
export function isReady(state: VisitorState): boolean {
  const eq = visitorEquation(state);
  return !!eq && eq.holds && HELD_CODES.every((code) => decisionStanding(state, code) === "supported");
}

export const undecidedCount = (state: VisitorState) => HELD_CODES.filter((code) => !currentDecision(state, code)).length;
export const unsupportedCount = (state: VisitorState) => HELD_CODES.filter((code) => decisionStanding(state, code) === "unsupported").length;

/** Debit and credit totals of the source (arithmetic only; independent of classification). */
export function sourceTotals(): { debitMinor: number; creditMinor: number } {
  let debitMinor = 0;
  let creditMinor = 0;
  for (const b of [...SAMPLE_MAPPED_ACCOUNTS.map((a) => a.balanceMinor), ...SAMPLE_HELD_ACCOUNTS.map((a) => a.balanceMinor)]) {
    if (b > 0) debitMinor += b;
    else creditMinor -= b;
  }
  return { debitMinor, creditMinor };
}

/** 1234567 → "12,345.67"; negative amounts in brackets. Deterministic (no locale lookup). */
export function formatMinor(minor: number): string {
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = `${whole}.${String(abs % 100).padStart(2, "0")}`;
  return minor < 0 ? `(${text})` : text;
}
