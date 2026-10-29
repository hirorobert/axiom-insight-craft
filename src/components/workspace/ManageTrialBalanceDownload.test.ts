/**
 * "Download original" in Manage Trial Balance: who is shown it, and that the page only ever reaches the file through the
 * server-authorized function (never a bucket or a path). The server re-checks the right on every request; what is shown
 * here is a convenience, so these tests also pin that the browser code holds no direct Storage read.
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { SourceManagementMode } from "@/lib/workspace/trialBalanceManagement";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } } }));
const { ManageTrialBalance } = await import("./ManageTrialBalance");

const render = (mode: SourceManagementMode, withDownload: boolean, downloading = false) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ManageTrialBalance, {
    mode, removeAction: null, replacing: false, removing: false, focusRequested: false, onReplace: () => {}, onRemove: () => {},
    ...(withDownload ? { onDownload: () => {}, downloading } : {}),
  })));
const src = (p: string) => fs.readFileSync(path.join(__dirname, "../../..", p), "utf8");

describe("Download original", () => {
  it("is offered, enabled, to a person who manages source files", () => {
    const html = render("manage", true);
    expect(html).toContain('data-testid="download-original-trial-balance"');
    expect(html).toContain("Download original");
    expect(html).not.toMatch(/data-testid="download-original-trial-balance"[^>]*disabled/);
  });
  it("shows progress and cannot be pressed twice while preparing", () => {
    const html = render("manage", true, true);
    expect(html).toContain("Preparing download");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="download-original-trial-balance"|data-testid="download-original-trial-balance"[^>]*disabled/);
  });
  it("is not shown without source-file authority, without a current plan, or while the right is unknown", () => {
    for (const mode of ["view_only", "archive", "unknown"] as const) expect(render(mode, true), mode).not.toContain("download-original-trial-balance");
  });
  it("is not shown by a page that supplies no handler", () => {
    expect(render("manage", false)).not.toContain("download-original-trial-balance");
  });
});

describe("the page reaches the file only through the server", () => {
  it("Prepare Data uses the download service; the service uses the Edge Function and no Storage read", () => {
    const page = src("src/pages/workspace/PrepareWorkspace.tsx");
    expect(page).toMatch(/onDownload=\{handleDownloadOriginal\}/);
    expect(page).toMatch(/downloadOriginalSource\(companyId, upload\.id\)/);
    const client = src("src/lib/workspace/sourceDownload.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(client).toMatch(/functions\.invoke\("trial-balance-source-download"/);
    expect(client).not.toMatch(/\.storage\b|createSignedUrl|trial-balance-files/);
    // the page never reads the bucket either
    expect(page).not.toMatch(/storage\.from\("trial-balance-files"\)\.(download|createSignedUrl)/);
  });
  it("the bucket policies are untouched by this change: no migration here widens a Storage policy", () => {
    const newest = fs.readdirSync(path.join(__dirname, "../../../supabase/migrations")).filter((f) => /^2026(1[0-2]|09)/.test(f));
    for (const f of newest) {
      const sql = src(`supabase/migrations/${f}`);
      expect(sql, f).not.toMatch(/CREATE POLICY[^;]*ON\s+storage\.objects[^;]*trial-balance-files[^;]*FOR\s+SELECT/is);
    }
  });
});
