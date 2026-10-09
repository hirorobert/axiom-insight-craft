/**
 * F1a — the same recorded result reads the same in Prepare, the Overview and the account hub.
 *
 * Prepare builds its readiness from the two certification reads (PrepareWorkspace → computeCertificationReadiness) and
 * states it through trialBalanceVerdict, which also reads the stored result (readRecordedEquation). The Overview and the
 * hub both come from fetchWorkspaceSnapshot (the hub through its bulk path: companyOverride / uploadsOverride), which
 * now hands that same stored-equation reading to computeCertificationReadiness. Here each surface is driven through its
 * real code — the snapshot through a stand-in Supabase client that answers only the reads it makes — and the outcomes
 * are compared: Reviewed or not, and the reason given.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { TbCertificationRow } from "./computeCertificationReadiness";

/** What the stand-in database holds for one scenario. */
const db: { authoritative: unknown[]; latestForUpload: unknown[] } = { authoritative: [], latestForUpload: [] };
vi.mock("@/integrations/supabase/client", () => {
  const builder = (table: string) => {
    const rows = () => (table === "tb_certifications" ? db.latestForUpload : table === "safisha_exceptions" ? [] : null);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "not", "is", "in", "order", "limit"]) b[m] = () => b;
    b.single = async () => ({ data: null, error: null });
    b.maybeSingle = async () => ({ data: null, error: null });
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok, bad);
    return b;
  };
  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: async (name: string) => (name === "get_authoritative_certification" ? { data: db.authoritative, error: null } : { data: null, error: { message: `no ${name}` } }),
      functions: { invoke: vi.fn() },
    },
  };
});

const { computeCertificationReadiness, RECORDED_EQUATION_FAILURE, RECORDED_EQUATION_UNREADABLE } = await import("./computeCertificationReadiness");
const { deriveTrialBalanceVerdict, REVIEWED_SCOPE, REVIEWED_SCOPE_EXACT } = await import("./trialBalanceVerdict");
const { fetchWorkspaceSnapshot } = await import("./fetchWorkspaceSnapshot");
const { fetchCertificationReadiness } = await import("@/hooks/useCertificationReadiness");
const { trialBalanceReviewStep, deriveOrientationSummary } = await import("./deriveOrientationSummary");
const { CurrentTrialBalanceCard } = await import("@/components/workspace/CurrentTrialBalanceCard");
const { TrialBalanceChecks } = await import("@/components/workspace/TrialBalanceChecks");
const { default: EngagementHub } = await import("@/pages/workspace/EngagementHub");

const COMPANY = "11111111-1111-4111-8111-111111111111";
const U = "33333333-3333-4333-8333-333333333333";
const company = { id: COMPANY, name: "Synthetic Co", code: null, tin: null, reporting_framework: "full_ifrs", fiscal_year_end: "2025-12-31", currency: "TZS", created_at: "2026-01-01T00:00:00Z", filing_jurisdiction: null };
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const EXACT = { tb_balance_check: { passed: true, total_debits: 2000, total_credits: 2000, difference: 0, exact: { currency: "TZS", currency_exponent: 2, total_debits: "2000.00", total_credits: "2000.00", difference: "0.00" } } };
const EQ_FAIL = { code: "BALANCE_SHEET_EQUATION_FAILED", layer: 3, severity: "warning", accountCode: null, message: "Assets (2000.00) != Liabilities + Closing Equity (1900.00). Difference: 100.00" };
const cert = (exceptions: unknown, over: Partial<TbCertificationRow> = {}): TbCertificationRow =>
  ({ id: "c1", sequence_no: 1, company_id: COMPANY, upload_id: U, period_year: 2025, is_blocking: false, requires_review: false, exceptions, certified_at: "2026-01-02T00:00:00Z", ...over }) as TbCertificationRow;
// A valid tb-amounts/1 document whose statement equation holds to the minor unit (src/lib/accounting/tbAmounts.ts).
const EXACT_AMOUNTS = {
  contract: "tb-amounts/1", currency: "TZS", exponent: 2,
  source: { debit_total_minor: "190025", credit_total_minor: "190025", difference_minor: "0" },
  classes: { assets_minor: "150025", liabilities_minor: "0", equity_minor: "100000", income_minor: "90025", expenses_minor: "40000" },
  equation: { lhs_minor: "150025", rhs_minor: "150025", difference_minor: "0", status: "balanced" },
  cash: { reported_minor: "150025", credit_balances_minor: "0", overdraft_minor: "0", net_position_minor: "150025", accounts: 1 },
  reconciliation: { status: "not_checked" },
};
const upload = (equation: unknown, amounts?: unknown) => ({
  id: U, file_name: "tb.csv", file_path: "x", file_size: 1, status: "complete", is_valid: true, company_id: COMPANY, company_name: "Synthetic Co",
  period_year: 2025, uploaded_at: "2026-01-01T00:00:00Z", processed_at: "2026-01-01T00:00:00Z", safisha_status: null, lifecycle_state: "active_processed",
  processing_result: { ...(amounts === undefined ? {} : { amounts }), validation_report: { ...EXACT, ...(equation === undefined ? {} : { balance_sheet_equation: equation }) } },
});

interface Outcome { reviewed: boolean; reason: string }

async function surfaces(row: { authoritative: TbCertificationRow | null; latest: TbCertificationRow | null }, equation: unknown, amounts?: unknown) {
  db.authoritative = row.authoritative ? [row.authoritative] : [];
  db.latestForUpload = row.latest ? [row.latest] : [];
  const u = upload(equation, amounts);

  // Prepare: exactly what PrepareWorkspace does with the two reads.
  const reads = await fetchCertificationReadiness(COMPANY, 2025, U);
  const readiness = computeCertificationReadiness({ uploadExists: true, currentUploadId: U, authoritative: reads.authoritative, latestForUpload: reads.latestForUpload, fetchFailed: false, revalidating: false });
  const verdict = deriveTrialBalanceVerdict({ upload: u, readiness, canRetry: true });
  const prepareText = text(renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(CurrentTrialBalanceCard, { fileName: "tb.csv", uploadedAt: u.uploaded_at, fileSize: 1, verdict, onPrimary: () => {} }),
    createElement(TrialBalanceChecks, { verdict }))));
  const prepare: Outcome = { reviewed: verdict.statusLabel === "Reviewed", reason: verdict.reason };

  // Overview: the workspace snapshot (useWorkspaceData → fetchWorkspaceSnapshot) and the decision it drives.
  const snapshot = await fetchWorkspaceSnapshot({ companyId: COMPANY, periodYear: 2025, requestedUploadId: U, companyOverride: company as never, uploadsOverride: [u as never] });
  const state = snapshot.workspaceState;
  const step = trialBalanceReviewStep(state);
  const overview: Outcome = { reviewed: step?.label === "Reviewed trial balance", reason: step?.detail ?? state.missions.prepare.blocker ?? state.nextAction.description };
  const orientation = deriveOrientationSummary(state, ["FINANCIAL_STATEMENTS"]).currentStatusLabel;

  // Hub: the account home rendered from the same snapshot (useActiveEngagements → fetchWorkspaceSnapshot).
  const hubText = text(renderToStaticMarkup(createElement(MemoryRouter, null, createElement(EngagementHub, {
    entries: [{ engagementId: "e1", companyId: COMPANY, companyName: "Synthetic Co", periodYear: 2025, engagementType: "standard", framework: "full_ifrs", capabilities: ["FINANCIAL_STATEMENTS"], workspaceState: state, openedAt: "2026-01-01T00:00:00Z" }],
    companiesWithoutEngagement: [], onResume: () => {}, onStartService: () => {},
  } as never))));
  const hub = { reviewed: /Reviewed trial balance/.test(hubText) };
  return { prepare, overview, hub, orientation, prepareText, hubText, readiness, verdict, state };
}

describe("identical outcomes across Prepare, Overview and hub", () => {
  it("equation failure recorded in the stored result WITHOUT a certification exception: none says Reviewed; Prepare and Overview give the same reason", async () => {
    const s = await surfaces({ authoritative: cert([]), latest: null }, { passed: false, assets: 2000, liabilities: 1000, equity: 900, difference: 100 });
    expect([s.prepare.reviewed, s.overview.reviewed, s.hub.reviewed]).toEqual([false, false, false]);
    expect(s.prepare.reason).toBe(RECORDED_EQUATION_FAILURE);
    expect(s.overview.reason).toBe(RECORDED_EQUATION_FAILURE);
    expect(s.orientation).not.toBe("Reviewed trial balance");
    expect(s.prepareText).toMatch(/Statement equation Needs review The statement equation does not hold: the engine recorded a failure in this result\./);
    // Debit/credit parity and classification stay as recorded.
    expect(s.verdict.checks.find((c) => c.id === "l4_classification")?.state).toBe("passed");
    expect(s.verdict.balanceStatement).toBe("Balanced");
  });

  it("equation failure recorded in the certification: none says Reviewed; Prepare and Overview give the same recorded reason", async () => {
    const s = await surfaces({ authoritative: cert([EQ_FAIL]), latest: null }, { passed: false, assets: 2000, liabilities: 1000, equity: 900, difference: 100 });
    expect([s.prepare.reviewed, s.overview.reviewed, s.hub.reviewed]).toEqual([false, false, false]);
    const reason = "The statement equation does not hold: Assets (2000.00) does not equal Liabilities + Closing Equity (1900.00). Difference: 100.00";
    expect(s.prepare.reason).toBe(reason);
    expect(s.overview.reason).toBe(reason);
  });

  it("exact amounts proving the equation: the Overview's summary and the Prepare checks both say it holds exactly — never 'not exactly verified' beside a passed check", async () => {
    const s = await surfaces({ authoritative: cert([]), latest: null }, { passed: true, assets: 1500.25, liabilities: 0, equity: 1000, difference: 0 }, EXACT_AMOUNTS);
    expect([s.prepare.reviewed, s.overview.reviewed, s.hub.reviewed]).toEqual([true, true, true]);
    expect(s.state.statementEquationExact).toBe(true);
    for (const reason of [s.prepare.reason, s.overview.reason]) {
      expect(reason).toContain(REVIEWED_SCOPE_EXACT);
      expect(reason).not.toMatch(/not exactly verified/i);
    }
    expect(s.prepareText).toMatch(/Statement equation Passed Holds exactly/);
  });

  it("valid legacy result with no demonstrated failure: all three say Reviewed, with the same scope and no blanket claim", async () => {
    for (const equation of [{ passed: true, assets: 2000, liabilities: 1100, equity: 900, difference: 0 }, undefined, { assets: 2000, liabilities: 1100, equity: 900 }]) {
      const s = await surfaces({ authoritative: cert([]), latest: null }, equation);
      expect([s.prepare.reviewed, s.overview.reviewed, s.hub.reviewed], JSON.stringify(equation)).toEqual([true, true, true]);
      expect(s.prepare.reason).toContain(REVIEWED_SCOPE);
      expect(s.overview.reason).toContain(REVIEWED_SCOPE);
      expect(s.orientation).toBe("Reviewed trial balance");
      for (const t of [s.prepare.reason, s.overview.reason, s.prepareText, s.hubText]) expect(t).not.toMatch(/every check passed|checks have passed|checks passed/i);
      expect(s.prepareText).toMatch(/Statement equation Exact equation verification unavailable for this legacy result\./);
      expect(s.prepareText).not.toMatch(/Not checked yet Not exactly verified/);
    }
  });

  it("missing or malformed metadata by the existing contract: [] is the legitimate empty list; anything else is never reviewed and never crashes", async () => {
    const legitimate = await surfaces({ authoritative: cert([]), latest: null }, undefined);
    expect([legitimate.prepare.reviewed, legitimate.overview.reviewed, legitimate.hub.reviewed]).toEqual([true, true, true]);

    // tb_certifications.exceptions: JSONB NOT NULL, CHECK jsonb_typeof = 'array'; entries are not shape-checked.
    const malformedLists: [string, unknown][] = [
      ["null list", null], ["object instead of a list", { layer: 3 }], ["string instead of a list", "[]"],
      ["non-object entry", ["BALANCE_SHEET_EQUATION_FAILED"]], ["entry without a layer", [{ code: "X", severity: "warning", message: "m" }]],
      ["entry with an invalid layer", [{ code: "X", layer: "3", severity: "warning", message: "m" }]],
    ];
    for (const [name, exceptions] of malformedLists) {
      for (const placement of ["authoritative", "latest"] as const) {
        const row = cert(exceptions, placement === "latest" ? { requires_review: false, is_blocking: false } : {});
        const s = await surfaces(placement === "authoritative" ? { authoritative: row, latest: null } : { authoritative: null, latest: row }, undefined);
        expect([s.prepare.reviewed, s.overview.reviewed, s.hub.reviewed], `${name} (${placement})`).toEqual([false, false, false]);
        expect(s.readiness.verdict, `${name} (${placement})`).toBe("unknown");
        expect(s.prepare.reason, `${name} (${placement})`).toBe(s.readiness.blocker);
        expect(s.overview.reason, `${name} (${placement})`).toBe(s.readiness.blocker);
      }
    }

    // A layer-3 entry missing its code, message or severity is held for review, never clear.
    const bare = await surfaces({ authoritative: cert([{ layer: 3 }]), latest: null }, undefined);
    expect([bare.prepare.reviewed, bare.overview.reviewed, bare.hub.reviewed]).toEqual([false, false, false]);
    expect(bare.prepare.reason).toBe(bare.overview.reason);

    // A stored equation record whose `passed` is present but not a boolean is unreadable: held, never a pass.
    for (const passed of [null, "false", 0, "true"]) {
      const s = await surfaces({ authoritative: cert([]), latest: null }, { passed, assets: 2000, liabilities: 1100, equity: 900 });
      expect([s.prepare.reviewed, s.overview.reviewed, s.hub.reviewed], String(passed)).toEqual([false, false, false]);
      expect(s.prepare.reason).toBe(RECORDED_EQUATION_UNREADABLE);
      expect(s.overview.reason).toBe(RECORDED_EQUATION_UNREADABLE);
    }
  });
});
