/**
 * illustrativeReview.test.ts — the landing page's sample review (invented data).
 *
 * Behaviour is tested on the pure model (vitest runs in node, no DOM); the rendered markup is checked with
 * renderToStaticMarkup. The real page is driven in a browser separately (keyboard, focus, hash view, reset).
 *
 * Protected:
 *   S0–S6  an unresolved, unrecorded or unsupported treatment never reaches the illustrated ready state;
 *   C2–C3  the decisions supplied with the example are never written by, or merged with, a visitor's decisions;
 *   the statement equation is pending until every account has a category, then recalculated from the categories;
 *   the invented-data label, the guided-example label beside every set of choices, the corrected director wording, and
 *   a completed example with no recording control and no "validated / verified / correct / approved" claim.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IllustrativeReview } from "@/components/landing/IllustrativeReview";
import {
  INITIAL_VISITOR_STATE,
  currentDecision,
  formatMinor,
  isReady,
  sourceTotals,
  suppliedEquation,
  visitorEquation,
  visitorReducer,
  type VisitorAction,
  type VisitorState,
} from "@/components/landing/illustrativeReviewModel";
import { SAMPLE_HELD_ACCOUNTS, SAMPLE_SUPPLIED_DECISIONS, type SampleCategory } from "@/content/landing/illustrativeReview";
import { LANDING_SAMPLE_COPY } from "@/content/landing/landingContent";

const run = (...actions: VisitorAction[]) => actions.reduce(visitorReducer, INITIAL_VISITOR_STATE);
const decide = (code: string, category: SampleCategory): VisitorAction[] => [{ type: "select", code, category }, { type: "record", code }];
const SUPPLIED_SNAPSHOT = JSON.stringify(SAMPLE_SUPPLIED_DECISIONS);

describe("the invented trial balance", () => {
  it("balances: debits equal credits, 127,150.00 each side", () => {
    const t = sourceTotals();
    expect(t.debitMinor).toBe(t.creditMinor);
    expect(formatMinor(t.debitMinor)).toBe("127,150.00");
  });
  it("formats deterministically, with credits in brackets", () => {
    expect(formatMinor(-300000)).toBe("(3,000.00)");
    expect(formatMinor(5)).toBe("0.05");
  });
});

describe("regression scenarios: the illustrated ready state", () => {
  const expectNotReady = (s: VisitorState) => expect(isReady(s)).toBe(false);

  it("S0 nothing decided: not ready, equation pending", () => {
    expectNotReady(INITIAL_VISITOR_STATE);
    expect(visitorEquation(INITIAL_VISITOR_STATE)).toBeNull();
  });
  it("S1 one supported decision recorded, one unresolved: not ready, equation pending", () => {
    const s = run(...decide("2100", "Current Liabilities"));
    expectNotReady(s);
    expect(visitorEquation(s)).toBeNull();
  });
  it("S1b both supported treatments selected but not recorded: not ready, nothing recorded", () => {
    const s = run({ type: "select", code: "2100", category: "Current Liabilities" }, { type: "select", code: "4800", category: "Current Liabilities" });
    expectNotReady(s);
    expect(s.recorded).toEqual([]);
    expect(visitorEquation(s)).toBeNull();
  });
  it("S2 both recorded, both unsupported by the invented evidence: not ready; the equation is recalculated and still holds", () => {
    const s = run(...decide("2100", "Equity"), ...decide("4800", "Other Income"));
    expectNotReady(s);
    expect(visitorEquation(s)?.holds).toBe(true);
  });
  it("S3 one supported, one unsupported: not ready", () => {
    expectNotReady(run(...decide("2100", "Current Liabilities"), ...decide("4800", "Revenue")));
  });
  it("S4 both supported (after an earlier unsupported decision): ready; every decision kept in order, without timestamps", () => {
    const s = run(...decide("2100", "Non-Current Liabilities"), ...decide("2100", "Current Liabilities"), ...decide("4800", "Current Liabilities"));
    expect(isReady(s)).toBe(true);
    expect(s.recorded).toEqual([
      { code: "2100", category: "Non-Current Liabilities" },
      { code: "2100", category: "Current Liabilities" },
      { code: "4800", category: "Current Liabilities" },
    ]);
    const eq = visitorEquation(s)!;
    expect([eq.assetsMinor, eq.liabilitiesMinor, eq.equityMinor, eq.resultMinor].map(formatMinor)).toEqual(["49,650.00", "14,050.00", "24,500.00", "11,100.00"]);
  });
  it("S5 a supported decision changed to an unsupported one after the ready state: no longer ready", () => {
    const ready = run(...decide("2100", "Current Liabilities"), ...decide("4800", "Current Liabilities"));
    expect(isReady(ready)).toBe(true);
    expect(isReady([...decide("4800", "Revenue")].reduce(visitorReducer, ready))).toBe(false);
  });
  it("S6 reset returns to two held accounts and an empty record", () => {
    const s = visitorReducer(run(...decide("2100", "Current Liabilities"), ...decide("4800", "Current Liabilities")), { type: "reset" });
    expect(s).toEqual(INITIAL_VISITOR_STATE);
    expectNotReady(s);
  });
  it("the same actions always give the same state (deterministic)", () => {
    const actions = [...decide("2100", "Equity"), ...decide("4800", "Current Liabilities"), ...decide("2100", "Current Liabilities")];
    expect(JSON.stringify(run(...actions))).toBe(JSON.stringify(run(...actions)));
  });
  it("ignores unknown accounts, unoffered categories, and recording with nothing selected", () => {
    expect(run({ type: "select", code: "1000", category: "Equity" })).toEqual(INITIAL_VISITOR_STATE);
    expect(run({ type: "select", code: "2100", category: "Revenue" })).toEqual(INITIAL_VISITOR_STATE);
    expect(run({ type: "record", code: "2100" })).toEqual(INITIAL_VISITOR_STATE);
  });
});

describe("the completed example is separate from the visitor's decisions", () => {
  it("C2 the supplied decisions are complete and reach the reviewed figures on their own", () => {
    expect(SAMPLE_SUPPLIED_DECISIONS.map((d) => d.code)).toEqual(SAMPLE_HELD_ACCOUNTS.map((a) => a.code));
    expect(suppliedEquation()?.holds).toBe(true);
    // Viewing them is not an action on the visitor's state: an untouched visitor has nothing recorded.
    expect(INITIAL_VISITOR_STATE.recorded).toEqual([]);
  });
  it("C3 a visitor's decisions never change the supplied decisions, and the supplied ones never appear as the visitor's", () => {
    const s = run(...decide("2100", "Equity"), ...decide("4800", "Revenue"), { type: "reset" }, ...decide("2100", "Equity"));
    expect(JSON.stringify(SAMPLE_SUPPLIED_DECISIONS)).toBe(SUPPLIED_SNAPSHOT);
    expect(currentDecision(s, "2100")).toBe("Equity");
    expect(currentDecision(s, "4800")).toBeUndefined();
  });
});

describe("rendered markup", () => {
  const html = renderToStaticMarkup(createElement(IllustrativeReview));
  const between = (startId: string, endMarker: string) => html.slice(html.indexOf(`id="${startId}"`), html.indexOf(endMarker, html.indexOf(`id="${startId}"`)));
  const completed = html.slice(html.indexOf('id="completed-example"'));
  const text = (m: string) => m.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("leads with the balanced status and the invented-data label", () => {
    expect(text(html)).toContain("Balanced · 2 accounts need your review.");
    expect(html).toContain(`data-testid="sample-label">${LANDING_SAMPLE_COPY.label}<`);
    expect(text(completed)).toContain(LANDING_SAMPLE_COPY.label);
  });
  it("puts the checks and the accounts behind native disclosures, with the equation pending", () => {
    expect((html.match(/<details\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/data-testid="equation-state"[^>]*>Pending</);
  });
  it("places the guided-example label inside every held account's choices", () => {
    for (const a of SAMPLE_HELD_ACCOUNTS) {
      const fieldset = between(`held-${a.code}`, "</fieldset>");
      expect(fieldset).toContain(`data-testid="guided-label-${a.code}">Guided example—not automated evidence checking.<`);
    }
  });
  it("uses the corrected director wording (supporting terms help determine it), not the absolute one", () => {
    expect(text(html)).toContain("The credit balance suggests the company owes the director. The supporting terms help determine its classification.");
    expect(html).not.toContain("decide the category");
  });
  it("the completed example has no recording control, names the invented reviewer, and states its limitations", () => {
    expect(completed).not.toMatch(/<(input|select|textarea|button)\b/);
    expect(text(completed)).toContain("Example reviewer (invented) · 14 Oct 2026, 10:42");
    expect(text(completed)).toContain("Viewing them records nothing for you.");
    for (const l of LANDING_SAMPLE_COPY.limitations) expect(text(completed)).toContain(l);
    expect(text(completed)).not.toMatch(/Sample reviewer|\(you\)/);
  });
  it("never calls a decision validated, verified, correct or approved (other than to deny it)", () => {
    const outcomes = [LANDING_SAMPLE_COPY.supported, LANDING_SAMPLE_COPY.unsupported, LANDING_SAMPLE_COPY.readyState, LANDING_SAMPLE_COPY.completedStatus];
    for (const o of outcomes) expect(o).not.toMatch(/validated|verified|correct|approved/i);
    expect(LANDING_SAMPLE_COPY.limitations[0]).toBe("These are recorded decisions, not validated accounting treatment.");
  });
  it("offers no upload of any kind", () => {
    expect(html).not.toMatch(/type="file"/);
  });
});
