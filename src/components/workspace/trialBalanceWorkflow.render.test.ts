/**
 * Rendered upload/review workflow: the uploader's visible primary action, the trial-balance card's row-level
 * corrections, and the checks' recorded milestones.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CurrentTrialBalanceCard } from "./CurrentTrialBalanceCard";
import { TrialBalanceChecks } from "./TrialBalanceChecks";
import { deriveTrialBalanceVerdict } from "@/lib/workspace/trialBalanceVerdict";

afterEach(() => {
  vi.doUnmock("@/contexts/AuthContext");
  vi.doUnmock("@/hooks/useAuditLog");
  vi.doUnmock("@/integrations/supabase/client");
  vi.doUnmock("@/components/safisha/SafishaGate");
});

async function renderUploader(): Promise<string> {
  vi.resetModules();
  vi.doMock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
  vi.doMock("@/hooks/useAuditLog", () => ({ useAuditLog: () => ({ logAction: vi.fn() }) }));
  vi.doMock("@/integrations/supabase/client", () => ({ supabase: {} }));
  vi.doMock("@/components/safisha/SafishaGate", () => ({ default: () => null }));
  const { TrialBalanceUpload } = await import("../TrialBalanceUpload");
  return renderToStaticMarkup(createElement(TrialBalanceUpload, { embedded: true, lockedCompanyId: "c1", periodYear: 2025 }));
}

const blockedUpload = {
  id: "up1",
  status: "blocked",
  processing_result: {
    validation_report: { tb_balance_check: { passed: false, total_debits: 100.01, total_credits: 100, exact: { currency: "USD", total_debits: "100.01", total_credits: "100.00", difference: "0.01" } } },
    ingestion: {
      issues: [
        { code: "TRIAL_BALANCE_IMBALANCE", severity: "blocking", message: "Debits (100.01) do not equal credits (100.00); the difference is 0.01.", rows: [] },
        { code: "DUPLICATE_ACCOUNT_CODE", severity: "blocking", message: "Account code 1000 appears on rows 2, 3. Each account must appear once — combine or correct those rows.", rows: [2, 3] },
      ],
      milestones: [
        { id: "read", label: "File read", status: "passed", detail: "12 rows" },
        { id: "rows", label: "Every row accounted for", status: "failed" },
        { id: "amounts", label: "Amounts checked", status: "not_reached" },
      ],
    },
  },
};

describe("upload and review workflow — rendered", () => {
  it("the uploader shows ONE visible primary action before a file is chosen, and no fake progress", async () => {
    const html = await renderUploader();
    expect(html).toContain('data-phase="empty"');
    expect(html.match(/data-testid="trial-balance-upload-primary"/g)).toHaveLength(1);
    expect(html).toContain("Choose trial balance file");
    expect(html).not.toMatch(/Processing with AI|role="progressbar"/);
  });

  it("a blocked card lists what to correct, row by row, with exact totals in the recorded currency", () => {
    const verdict = deriveTrialBalanceVerdict({ upload: blockedUpload, readiness: { verdict: "blocked", blocker: "TRIAL_BALANCE_IMBALANCE: Debits (100.01) do not equal credits (100.00); the difference is 0.01.", checks: [] }, canRetry: true });
    const html = renderToStaticMarkup(createElement(CurrentTrialBalanceCard, { fileName: "tb.csv", uploadedAt: "2026-10-03T10:00:00Z", fileSize: 2048, verdict, onPrimary: () => undefined }));
    expect(html).toContain('data-testid="trial-balance-issues"');
    expect(html).toContain("Account code 1000 appears on rows 2, 3.");
    expect(html).toContain("Total debits (USD)");
    expect(html).toContain("0.01");
    expect(html.match(/data-testid="trial-balance-primary-action"/g)).toHaveLength(1);
  });

  it("the checks show what the last check actually reached", () => {
    const verdict = deriveTrialBalanceVerdict({ upload: blockedUpload, readiness: { verdict: "blocked", blocker: "x", checks: [] }, canRetry: true });
    const html = renderToStaticMarkup(createElement(TrialBalanceChecks, { verdict }));
    expect(html).toContain('data-testid="trial-balance-milestones"');
    expect(html).toMatch(/data-milestone="rows" data-state="failed"/);
    expect(html).toContain("Stopped here");
    expect(html).toContain("Not reached");
  });
});
