/**
 * The customer-facing application exposes exactly ONE proven workflow — Trial balance review (Prepare + Reconcile) —
 * through ONE boundary (moduleAvailability.ts). Statements, Tax, Compliance, Filing and Monitoring are withheld:
 * implementation, records, backend and migrations untouched. Each numbered block proves one release requirement; the
 * last blocks record, from the code itself, why the withheld modules are not complete and what the server does not yet
 * enforce for official reporting.
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
    channel: vi.fn(() => ({ on: vi.fn(() => ({ subscribe: vi.fn() })), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
    functions: { invoke: vi.fn() },
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) },
  },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null, session: null, signOut: vi.fn() }) }));

import * as boundary from "./moduleAvailability";
import {
  CUSTOMER_HIDDEN_CAPABILITIES,
  CUSTOMER_HIDDEN_OUTCOMES,
  CUSTOMER_HIDDEN_SERVICE_INTENTS,
  CUSTOMER_HIDDEN_STAGES,
  TRIAL_BALANCE_REVIEW,
  UNPROVEN_MODULES_CUSTOMER_VISIBLE,
  WITHHELD_SERVICE_SURFACES_VISIBLE,
  WITHHELD_WORKSPACE_ROUTE_SEGMENTS,
  customerVisibleCapabilities,
  isEngagementWithheld,
} from "./moduleAvailability";
import { CAPABILITY_OUTCOMES, CUSTOMER_CAPABILITY_OUTCOMES, ENGAGEMENT_CAPABILITIES, customerCapabilityTitle, projectMandate, type EngagementCapability } from "./mandate";
import { deriveWorkspaceNavigation } from "./navigation";
import { deriveWorkspaceState } from "./deriveWorkspaceState";
import { deriveOrientationSummary, trialBalanceReviewStep } from "./deriveOrientationSummary";
import { STAGE_SEQUENCE } from "./stageMetadata";
import { deriveScopeChange } from "./engagementScopeChange";
import { decideReturningUserRoute } from "./resolveReturningUserRoute";
import { openEngagementWithScope, SERVICE_NOT_AVAILABLE_MESSAGE } from "./workspaceSetupClient";
import type { MissionState, UploadSnapshot, WorkspaceMission } from "./types";
import { CUSTOMER_SERVICE_INTENT_IDS, SERVICE_INTENTS, SERVICE_INTENT_IDS, currentServiceIntent, intentFromUserMetadata, parseServiceIntent } from "@/lib/commercial/serviceIntent";
import { PRODUCT_OUTCOMES, PUBLIC_PRODUCT_OUTCOMES, getOutcome } from "@/lib/product/outcomes";
import { PUBLIC_CLAIM_REGISTRY } from "@/content/publicClaimRegistry";
import { LANDING_FAQ, LANDING_SERVICES, LANDING_WORKFLOW } from "@/content/landing/landingContent";
import WorkspaceUnavailable, { WORKSPACE_UNAVAILABLE_COPY } from "@/components/workspace/WorkspaceUnavailable";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { CapacityPlans } from "@/components/landing/CapacityPlans";
import { LandingFAQ } from "@/components/landing/LandingFAQ";
import { LandingFinalCTA } from "@/components/landing/LandingFinalCTA";
import { LandingHero } from "@/components/landing/LandingHero";
import { LandingIntentProvider } from "@/components/landing/LandingIntent";
import { ServiceChooser } from "@/components/landing/ServiceChooser";
import { TrustStrip } from "@/components/landing/TrustStrip";
import { PlanCatalogue } from "@/components/commercial/PlanCatalogue";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** Source without comments — what can actually reach a screen. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const flat = (rel: string) => code(rel).replace(/\s+/g, " ");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const VISIBLE: EngagementCapability[] = ["FINANCIAL_STATEMENTS"];
const WITHHELD: EngagementCapability[] = ["TAX_COMPUTATION", "COMPLIANCE_REVIEW", "FILING_PREPARATION", "MONITORING"];
const HIDDEN_STAGES: WorkspaceMission[] = ["statements", "tax", "compliance", "filing", "monitor"];
/** What a customer must never be promised while those modules are withheld. Tax-related ACCOUNTS are not listed. */
const WITHHELD_CLAIMS = /financial statements?\b|statement set|statement of financial position|certif|reporting pack|close insights|variance|forecast|tax computation|compute tax|\btax (workpapers?|service|module|engine)\b|assess tax|compliance (review|filing)|filing (pack|package)|complete (financial )?close|cash outlook|performance and risk/i;

const missions = (status: MissionState["status"] = "passed"): Record<WorkspaceMission, MissionState> =>
  Object.fromEntries(STAGE_SEQUENCE.map((s) => [s, { status, label: s, summary: "", href: `/x/${s}` }])) as Record<WorkspaceMission, MissionState>;
const upload = (overrides: Partial<UploadSnapshot> = {}): UploadSnapshot => ({
  id: "u1", companyId: "c1", companyName: "Example Co", periodYear: 2025, status: "complete", isValid: true, safishaStatus: "clean",
  uploadedAt: "2026-01-01T00:00:00.000Z", processedAt: "2026-01-01T00:05:00.000Z", hasMapping: true,
  certificationVerdict: "certified", certificationBlocker: null, ...overrides,
});

describe("the boundary itself", () => {
  it("is one reviewed source constant, false, never read from the environment, storage or a URL (fails closed)", () => {
    expect(UNPROVEN_MODULES_CUSTOMER_VISIBLE).toBe(false);
    expect(WITHHELD_SERVICE_SURFACES_VISIBLE).toBe(false);
    const src = code("src/lib/workspace/moduleAvailability.ts");
    expect(src).toMatch(/export const UNPROVEN_MODULES_CUSTOMER_VISIBLE: boolean = false;/);
    expect(src).not.toMatch(/import\.meta|process\.env|VITE_|localStorage|sessionStorage|location|searchParams|supabase/);
    expect([...CUSTOMER_HIDDEN_CAPABILITIES]).toEqual(WITHHELD);
    expect([...CUSTOMER_HIDDEN_STAGES]).toEqual(HIDDEN_STAGES);
    expect([...CUSTOMER_HIDDEN_OUTCOMES]).toEqual(["prepare-statements", "review-statements", "tax-compliance", "performance-risk", "full-close"]);
    expect([...CUSTOMER_HIDDEN_SERVICE_INTENTS]).toEqual(["close-certification", "reporting-pack", "close-insights"]);
    expect(WITHHELD_WORKSPACE_ROUTE_SEGMENTS).toEqual(["statements", "statements/review", "tax", "compliance", "filing", "monitor"]);
    expect(TRIAL_BALANCE_REVIEW).toEqual({
      title: "Trial balance review",
      description: "Upload, check and review the accounts in your trial balance.",
      workflow: ["Upload and validate trial balance", "Review and confirm account classifications", "Trial balance ready for statement preparation"],
      ready: "Reviewed trial balance",
      notApproval: "This is not an approval of financial statements.",
    });
  });

  it("is the only place that decides it: no customer-facing file hard-codes its own check for a withheld module", () => {
    // Excluded: the canonical registries that DEFINE stages/services/outcomes (filtered through the boundary, never
    // consulted around it), the unmounted module pages, the jurisdiction pack, and dev-only galleries.
    const DEFINITIONS = /moduleAvailability\.ts$|(Tax|Compliance|Filing|Statements|StatementReview|Monitor)Workspace\.tsx$|deriveWorkspaceState\.ts$|stageMetadata\.ts$|\/mandate\.ts$|workspaceAccess\.ts$|\/types\.ts$|useWorkspaceData\.ts$|\/lib\/product\/outcomes\.ts$|\/lib\/jurisdiction\/(registry|taxProfile)\.ts$|ProductTour\.tsx$|serviceIntent\.ts$|resolveNextActionDestination\.ts$|onboardingState\.ts$|TrialBalanceProgressLedger\.tsx$/;
    const offenders = walk("src")
      .filter((f) => !/\.test\.|__tests__|\/jurisdiction-packs\/|\/integrations\/supabase\/|\/dev\/|\/pages\/internal\/|workflowAcceptanceFixtures\.ts$/.test(f) && !DEFINITIONS.test(f))
      .filter((f) => /["'](TAX_COMPUTATION|COMPLIANCE_REVIEW|FILING_PREPARATION|MONITORING)["']|stage === ["'](statements|tax|compliance|filing|monitor)["']|missions\.(statements|tax|compliance|filing|monitor)\b/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

describe("1. Trial balance review is the only customer-selectable service", () => {
  it("the service registry's customer projection is FINANCIAL_STATEMENTS presented as Trial balance review — nothing else", () => {
    expect(CUSTOMER_CAPABILITY_OUTCOMES.map((o) => [o.capability, o.title, o.description])).toEqual([
      ["FINANCIAL_STATEMENTS", "Trial balance review", "Upload, check and review the accounts in your trial balance."],
    ]);
    expect(customerCapabilityTitle("FINANCIAL_STATEMENTS")).toBe("Trial balance review");
    // The registry itself is complete and unchanged; only its customer projection differs.
    expect(CAPABILITY_OUTCOMES.map((o) => o.capability)).toEqual(ENGAGEMENT_CAPABILITIES);
  });

  it("the launchpad and the Manage/Start-another-service dialog render only that projection", () => {
    for (const f of ["src/components/workspace/ServiceLaunchpad.tsx", "src/components/workspace/EngagementScopeDialog.tsx"]) {
      expect(code(f), f).toMatch(/CUSTOMER_CAPABILITY_OUTCOMES\.map/);
      expect(code(f), f).not.toMatch(/[^_]CAPABILITY_OUTCOMES\.map/);
    }
  });

  it("the public service chooser, sign-up intents and outcome selector offer only Trial balance review", () => {
    expect(CUSTOMER_SERVICE_INTENT_IDS).toEqual(["prepare-review"]);
    expect(SERVICE_INTENTS["prepare-review"]).toMatchObject({ name: "Trial balance review", stage: "prepare" });
    expect(LANDING_SERVICES.map((s) => [s.id, s.name])).toEqual([["prepare-review", "Trial balance review"]]);
    expect([...LANDING_WORKFLOW]).toEqual([...TRIAL_BALANCE_REVIEW.workflow]);
    expect(PUBLIC_PRODUCT_OUTCOMES.map((o) => o.id)).toEqual(["clean-trial-balance"]);
  });

  it("every client path that opens or grants a service refuses a withheld one before any request", async () => {
    const rpc = vi.fn();
    for (const cap of WITHHELD) {
      await expect(openEngagementWithScope({ rpc } as never, { companyId: "c", year: 2025, capabilities: [cap] })).rejects.toThrow(SERVICE_NOT_AVAILABLE_MESSAGE);
      await expect(openEngagementWithScope({ rpc } as never, { companyId: "c", year: 2025, capabilities: ["FINANCIAL_STATEMENTS", cap] })).rejects.toThrow(SERVICE_NOT_AVAILABLE_MESSAGE);
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(code("src/hooks/useEngagementMandate.ts")).toMatch(/if \(!isCapabilityCustomerVisible\(cap\)\) throw new Error\(SERVICE_NOT_AVAILABLE_MESSAGE\);\s*const \{ error \} = await supabase\.rpc\("grant_engagement_capability"/);
  });

  it("no stored, linked or metadata intent can select a withheld service or outcome", async () => {
    for (const v of ["close-certification", "reporting-pack", "close-insights", "tax", "tax-compliance", "full-close", "monitoring", "statements"]) {
      expect(parseServiceIntent(v), v).toBeNull();
      expect(currentServiceIntent(`?service=${v}&plan=solo`), v).toBeNull();
      expect(intentFromUserMetadata({ service_intent: { v: 1, service: v, plan: "solo" } }), v).toBeNull();
    }
    for (const id of CUSTOMER_HIDDEN_OUTCOMES) {
      expect(getOutcome(id), id).toBeNull();
      vi.stubGlobal("window", { sessionStorage: { getItem: () => id, setItem: () => undefined } });
      const { readRememberedOutcome } = await import("@/lib/product/outcomes");
      expect(readRememberedOutcome(), id).toBeNull();
      vi.unstubAllGlobals();
    }
    // The registries keep every identifier (an old link is recognised and resolves to nothing, never an error).
    expect(SERVICE_INTENT_IDS).toEqual(["prepare-review", "close-certification", "reporting-pack", "close-insights"]);
    expect(PRODUCT_OUTCOMES.map((o) => o.id)).toEqual(expect.arrayContaining([...CUSTOMER_HIDDEN_OUTCOMES]));
  });
});

describe("2. only Prepare and Reconcile are customer-reachable", () => {
  const ALL: EngagementCapability[][] = [[], ...ENGAGEMENT_CAPABILITIES.map((c) => [c]), ENGAGEMENT_CAPABILITIES];

  it("navigation never offers anything but Overview, Prepare and Reconcile — any mandate, any status, declared or not", () => {
    for (const granted of ALL) {
      for (const status of ["passed", "signed", "locked", "ready", "in_progress"] as const) {
        for (const mandate of [null, { engagementId: "e", granted }]) {
          const views = projectMandate(missions(status), mandate);
          expect(views.map((v) => v.stage).every((s) => s === "prepare" || s === "reconcile")).toBe(true);
          for (const scopeDeclared of [true, false]) {
            const ids = deriveWorkspaceNavigation({ basePath: "/w/c/2025", scopeDeclared, missionViews: views }).map((i) => i.id);
            expect(ids.every((id) => ["overview", "prepare", "reconcile"].includes(id)), JSON.stringify({ granted, status, ids })).toBe(true);
          }
        }
      }
    }
    const nav = (granted: EngagementCapability[]) => deriveWorkspaceNavigation({ basePath: "/w", scopeDeclared: true, missionViews: projectMandate(missions(), { engagementId: "e", granted }) }).map((i) => i.id);
    expect(nav(VISIBLE)).toEqual(["overview", "prepare", "reconcile"]);
    for (const cap of WITHHELD) expect(nav([cap]), cap).toEqual(["overview"]);
  });

  it("App.tsx routes exactly two stages to pages, through the scope gate; the layout renders one navigation from that derivation", () => {
    const app = code("src/App.tsx");
    const staged = [...app.matchAll(/<StageScopeGate stage="([a-z]+)">/g)].map((m) => m[1]);
    // Still exactly two stages. The workbench's canonical Trial Balance routes are the same Prepare stage, registered only
    // under WORKBENCH_NAVIGATION_ENABLED (src/lib/workbench/gate.ts, false): with the gate off, App.tsx routes exactly as before.
    expect(new Set(staged)).toEqual(new Set(["prepare", "reconcile"]));
    const gated = [...app.matchAll(/\{WORKBENCH_NAVIGATION_ENABLED && <Route path="([a-z/-]+)" element=\{<StageScopeGate stage="([a-z]+)">/g)].map((m) => [m[1], m[2]]);
    expect(gated).toEqual([["trial-balance/intake", "prepare"], ["trial-balance/review", "prepare"]]);
    expect(staged.filter((x) => x === "reconcile")).toHaveLength(1);
    expect(staged.filter((x) => x === "prepare")).toHaveLength(1 + gated.length);
    const layout = code("src/pages/workspace/WorkspaceLayout.tsx");
    expect(layout.match(/<nav\b/g)?.length).toBe(1);
    expect(layout).toMatch(/const navItems = withheld \? \[\] : deriveWorkspaceNavigation\(/);
    expect(layout).toMatch(/\{withheld \? <WorkspaceUnavailable \/> : <Outlet \/>\}/);
  });
});

describe("3. every other stage route renders the neutral unavailable boundary", () => {
  it("typed URLs, bookmarks and refreshes — with query strings and fragments — land on the boundary with one way home", () => {
    const urls = WITHHELD_WORKSPACE_ROUTE_SEGMENTS.flatMap((s) => [`/workspace/c/2025/${s}`, `/workspace/c/2025/${s}?upload=u1`, `/workspace/c/2025/${s}#x`]);
    for (const url of urls) {
      const html = renderToStaticMarkup(
        createElement(MemoryRouter, { initialEntries: [url] },
          createElement(Routes, null,
            createElement(Route, { path: "/workspace/:companyId/:periodYear" },
              ...WITHHELD_WORKSPACE_ROUTE_SEGMENTS.map((segment) => createElement(Route, { key: segment, path: segment, element: createElement(WorkspaceUnavailable) }))))),
      );
      expect(html, url).toContain(WORKSPACE_UNAVAILABLE_COPY.headline);
      expect(html, url).toContain('href="/dashboard"');
      expect(text(html), url).not.toMatch(WITHHELD_CLAIMS);
      expect(text(html), url).not.toMatch(/statement|tax|complian|filing|monitor/i);
    }
    expect(WORKSPACE_UNAVAILABLE_COPY).toEqual({ headline: "This workspace is not currently available.", action: "Return to account home" });
  });

  it("App.tsx renders those segments through the boundary; legacy aliases redirect into them", () => {
    const app = code("src/App.tsx");
    expect(app).toMatch(/\{WITHHELD_WORKSPACE_ROUTE_SEGMENTS\.map\(\(segment\) => \(\s*<Route key=\{segment\} path=\{segment\} element=\{<WorkspaceUnavailable \/>\} \/>/);
    for (const [alias, to] of [["hesabu", "statements"], ["kinga", "tax"], ["analytics", "monitor"], ["issues", "compliance"]]) {
      expect(app).toMatch(new RegExp(`path="${alias}"\\s+element=\\{<LegacySubRouteRedirect to="${to}" />\\}`));
    }
    expect(app).not.toMatch(/path="(statements|statements\/review|tax|compliance|filing|monitor)"/);
  });
});

describe("4. no withheld module component is imported into the production entry path", () => {
  /** The static import graph from src/main.tsx (what the entry chunk can contain), plus the dynamic imports it reaches. */
  function entryGraph(): { reached: Set<string>; dynamic: Set<string> } {
    const resolve = (from: string, spec: string): string | null => {
      let base: string;
      if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
      else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
      else return null;
      for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (fs.existsSync(path.join(ROOT, c)) && fs.statSync(path.join(ROOT, c)).isFile()) return c;
      }
      return null;
    };
    const reached = new Set<string>(); const dynamic = new Set<string>();
    const queue = ["src/main.tsx"];
    while (queue.length) {
      const f = queue.pop()!;
      if (reached.has(f) || !/\.(ts|tsx)$/.test(f)) continue;
      reached.add(f);
      const src = code(f);
      for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
        const r = resolve(f, m[1] ?? m[2]); if (r) queue.push(r);
      }
      for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) { const r = resolve(f, m[1]); if (r) dynamic.add(r); }
    }
    return { reached, dynamic };
  }

  it("the withheld pages and their module panels are not in the entry graph", () => {
    const { reached } = entryGraph();
    expect(reached.has("src/App.tsx")).toBe(true);
    expect(reached.has("src/pages/workspace/PrepareWorkspace.tsx")).toBe(true);
    expect(reached.has("src/pages/workspace/ReconcileWorkspace.tsx")).toBe(true);
    for (const f of [
      "src/pages/workspace/StatementsWorkspace.tsx", "src/pages/workspace/StatementReviewWorkspace.tsx", "src/pages/workspace/TaxWorkspace.tsx",
      "src/pages/workspace/ComplianceWorkspace.tsx", "src/pages/workspace/FilingWorkspace.tsx", "src/pages/workspace/MonitorWorkspace.tsx",
      "src/components/PeriodCloseManager.tsx", "src/components/ExportStatements.tsx", "src/components/HesabuAssurancePanel.tsx",
      "src/components/PeriodClosingBalancesPanel.tsx", "src/components/MgmtLetterPanel.tsx", "src/components/NoteSynth.tsx",
      "src/components/ComplianceScorecard.tsx", "src/components/FirmDashboardPanel.tsx", "src/components/maono/MaonoDashboard.tsx",
      "src/components/financialStatements/FinancialStatementsWorkspace.tsx",
    ]) expect(reached.has(f), f).toBe(false);
  });

  it("no withheld module is reachable through a lazy chunk either", () => {
    const { dynamic } = entryGraph();
    expect(dynamic.size).toBeGreaterThan(0);
    for (const f of dynamic) {
      expect(f, f).not.toMatch(/(Statements|StatementReview|Tax|Compliance|Filing|Monitor)Workspace\.tsx$|FinancialStatementsWorkspace|MaonoDashboard|PeriodCloseManager/);
    }
  });
});

describe("5. existing hidden records are never changed by the client", () => {
  it("the containment adds no write: the boundary and the unavailable page read nothing and write nothing", () => {
    for (const f of ["src/lib/workspace/moduleAvailability.ts", "src/components/workspace/WorkspaceUnavailable.tsx"]) {
      expect(code(f), f).not.toMatch(/supabase|\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    }
  });

  it("a withheld grant is never listed in the scope dialogs, so it can be neither withdrawn nor converted", () => {
    const current: EngagementCapability[] = ["FINANCIAL_STATEMENTS", ...WITHHELD];
    expect(deriveScopeChange("amend", current, [...current]).removed).toEqual([]);
    expect(deriveScopeChange("add", current, [...current]).added).toEqual([]);
    expect(customerVisibleCapabilities(current)).toEqual(["FINANCIAL_STATEMENTS"]);
  });
});

describe("6. historical engagements never become first-run accounts", () => {
  it("a withheld-only engagement (Tax, Compliance, Filing or Monitoring only) is withheld as a whole; an undeclared one keeps its launchpad", () => {
    for (const cap of WITHHELD) expect(isEngagementWithheld([cap]), cap).toBe(true);
    expect(isEngagementWithheld(WITHHELD)).toBe(true);
    expect(isEngagementWithheld(["FINANCIAL_STATEMENTS", "MONITORING"])).toBe(false);
    expect(isEngagementWithheld([])).toBe(false);
    expect(isEngagementWithheld(null)).toBe(false);
  });

  it("the account home keeps it out of the list and routes the account to the chooser, never to first run", () => {
    expect(decideReturningUserRoute([], [], [], 1)).toEqual({ kind: "chooser" });
    expect(decideReturningUserRoute([], [], [], 0)).toEqual({ kind: "first_run" });
    const hook = code("src/hooks/useActiveEngagements.ts");
    expect(hook).toMatch(/const \{ visible, unavailable \} = partitionEngagements\(resolved\);/);
    expect(hook).toMatch(/setEntries\(visible\);/);
    expect(hook).toMatch(/const companyIdsWithEngagement = new Set\(openEngagements\.map\(\(e\) => e\.company_id\)\);/);
    expect(code("src/pages/Dashboard.tsx")).toMatch(/decideReturningUserRoute\(entries, companiesWithoutEngagement, sharedWorkspaces, withheldEngagementCount\)/);
  });
});

describe("7. trial-balance preparation remains fully usable", () => {
  it("the Prepare page keeps its upload, checks and account review, and mounts no evidence-matching panel; Reconcile keeps its journal review", () => {
    const prepare = code("src/pages/workspace/PrepareWorkspace.tsx");
    for (const c of ["TrialBalanceUpload", "AccountReviewPanel", "TrialBalanceChecks"]) expect(prepare, c).toMatch(new RegExp(`\\b${c}\\b`));
    // Supporting-evidence matching is not part of Trial balance review: neither upload path mounts it.
    for (const f of ["src/pages/workspace/PrepareWorkspace.tsx", "src/components/TrialBalanceUpload.tsx"]) expect(code(f), f).not.toMatch(/\bSafishaGate\b|evidence-verification/);
    expect(code("src/pages/workspace/ReconcileWorkspace.tsx")).toMatch(/AdjustingJournalPanel/);
  });

  it("the engine reaches Prepare passed without any withheld output, and the workflow ends at 'Reviewed trial balance' whatever the reconciliation says", () => {
    for (const safishaStatus of [null, "processing", "needs_review", "blocked", "clean"]) {
      const state = deriveWorkspaceState("c1", "Example Co", 2025, upload({ safishaStatus }));
      expect(state.missions.prepare.status, String(safishaStatus)).toBe("passed");
      expect(trialBalanceReviewStep(state)).toMatchObject({ ready: true, label: "Reviewed trial balance" });
      const o = deriveOrientationSummary(state, ["FINANCIAL_STATEMENTS"]);
      expect(o).toMatchObject({ service: "Trial balance review", currentStageLabel: "Trial balance review", currentStatusLabel: "Reviewed trial balance" });
      expect(JSON.stringify(o)).not.toMatch(WITHHELD_CLAIMS);
      expect(JSON.stringify(o)).not.toMatch(/reconciled|audited|assured|signed off/i);
    }
    // Failed validation or outstanding classifications never reach it.
    expect(trialBalanceReviewStep(deriveWorkspaceState("c1", "Example Co", 2025, upload({ certificationVerdict: "blocked", certificationBlocker: "x" })))).toBeNull();
    expect(trialBalanceReviewStep(deriveWorkspaceState("c1", "Example Co", 2025, upload({ status: "needs_review" })))).toBeNull();
  });
});

describe("8. tax-related accounting accounts remain ordinary, usable accounting data", () => {
  it("the boundary filters only modules — it has no account-level API", () => {
    expect(Object.keys(boundary).sort()).toEqual([
      "CUSTOMER_HIDDEN_CAPABILITIES", "CUSTOMER_HIDDEN_OUTCOMES", "CUSTOMER_HIDDEN_SERVICE_INTENTS", "CUSTOMER_HIDDEN_STAGES",
      "TRIAL_BALANCE_REVIEW", "UNPROVEN_MODULES_CUSTOMER_VISIBLE", "WITHHELD_SERVICE_SURFACES_VISIBLE", "WITHHELD_WORKSPACE_ROUTE_SEGMENTS",
      "customerVisibleCapabilities", "isCapabilityCustomerVisible", "isEngagementWithheld", "isOutcomeCustomerVisible",
      "isServiceIntentCustomerVisible", "isStageCustomerVisible",
    ]);
  });

  it("no trial-balance ingestion, classification, review or reconciliation code consults it", () => {
    const tb = [...walk("src/lib/accounting"), ...walk("src/lib/canonicalStatement"), ...walk("src/components/safisha"),
      "src/components/TrialBalanceUpload.tsx", "src/components/AccountReviewPanel.tsx", "src/lib/workspace/trialBalanceVerdict.ts"];
    for (const f of tb.filter((x) => fs.existsSync(path.join(ROOT, x)))) expect(read(f), f).not.toMatch(/moduleAvailability/);
    expect(read("supabase/functions/process-trial-balance/index.ts")).not.toMatch(/moduleAvailability|TAX_COMPUTATION/);
  });
});

describe("9/10. no public claim — in source or rendered — promises a withheld module", () => {
  it("the registered public claims describe only Trial balance review — no evidence reconciliation claim", () => {
    for (const c of PUBLIC_CLAIM_REGISTRY) expect(`${c.claimText} ${c.approvedWording}`, c.id).not.toMatch(WITHHELD_CLAIMS);
    expect(PUBLIC_CLAIM_REGISTRY.map((c) => c.id)).toContain("trial-balance-review-scope");
    expect(PUBLIC_CLAIM_REGISTRY.map((c) => c.id)).not.toContain("evidence-reconciliation");
    for (const id of ["framework-aware-preparation", "export-formats", "close-certification-internal-record"]) expect(PUBLIC_CLAIM_REGISTRY.map((c) => c.id)).not.toContain(id);
  });

  it("the rendered landing page, plans catalogue, header and footer carry no withheld-module claim", () => {
    const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
    const page = [
      wrap(createElement(Header)),
      wrap(createElement(LandingIntentProvider, null, createElement(LandingHero), createElement(ServiceChooser), createElement(CapacityPlans), createElement(TrustStrip), createElement(LandingFAQ), createElement(LandingFinalCTA))),
      wrap(createElement(PlanCatalogue)),
      wrap(createElement(Footer)),
    ].map(text).join(" ");
    expect(page).toContain("Trial balance review");
    expect(page).toContain("Upload, check and review the accounts in your trial balance.");
    expect(page.match(WITHHELD_CLAIMS)?.[0]).toBeUndefined();
    for (const f of LANDING_FAQ) expect(`${f.question} ${f.answer}`, f.id).not.toMatch(WITHHELD_CLAIMS);
  });

  it("the crawler-visible document (title, meta, structured data) carries none either", () => {
    const html = read("index.html").replace(/<!--[\s\S]*?-->/g, "");
    expect(html).toMatch(/<title>CFOClose — Trial Balance Review Workspace<\/title>/);
    expect(html.match(WITHHELD_CLAIMS)?.[0]).toBeUndefined();
  });

  it("the legal pages describe the service as offered today; the ownership clause covers historical records", () => {
    const terms = flat("src/pages/Terms.tsx");
    expect(terms).not.toMatch(/\btax\b|compliance review|filing pack/i);
    expect(terms).toMatch(/including records created with services that are no longer offered — belong to you and your firm/);
    expect(flat("src/pages/Privacy.tsx")).not.toMatch(/\btax\b|compliance, and filing/i);
  });

  it("customer-reachable authenticated sources carry no withheld-module wording", () => {
    const { reached } = (() => {
      const files = [
        "src/pages/Dashboard.tsx", "src/pages/Settings.tsx", "src/pages/workspace/EngagementHub.tsx", "src/pages/workspace/WorkspaceLayout.tsx",
        "src/pages/workspace/WorkspaceOverview.tsx", "src/pages/workspace/PrepareWorkspace.tsx", "src/pages/workspace/ReconcileWorkspace.tsx",
        "src/components/workspace/ServiceLaunchpad.tsx", "src/components/workspace/EngagementScopeDialog.tsx", "src/components/workspace/FirstRunEngagement.tsx",
        "src/components/workspace/TrialBalanceProgressLedger.tsx", "src/components/TrialBalanceUpload.tsx", "src/components/safisha/SafishaGate.tsx",
        "src/components/safisha/ExceptionQueue.tsx", "src/components/AdjustingJournalPanel.tsx", "src/lib/workspace/trialBalanceVerdict.ts",
      ];
      return { reached: files };
    })();
    const hits = reached.filter((f) => /tax computation|compute tax|tax engine|financial statements? (generation|output)|reporting pack|close certification|close insights|variance analysis|forecast/i.test(flat(f)));
    expect(hits).toEqual([]);
  });
});

describe("SERVER_AUTHORITATIVE_STATEMENT_COMPILER_REQUIRED — why official reporting stays withheld (recorded, not solved here)", () => {
  const persistence = read("supabase/migrations/20260919110000_financial_statements_persistence.sql");

  it("statement validation needs a tax computation and is started only from the Tax panel", () => {
    expect(read("supabase/functions/hesabu-validate/index.ts")).toMatch(/No tax computation found for this upload\. Run kinga-tax-engine first\./);
    expect(read("src/jurisdiction-packs/tz/KingaTaxPanel.tsx")).toMatch(/functions\.invoke\("hesabu-validate"/);
  });

  it("the evidence-based FINAL / official-pack workspace is switched off in production", () => {
    expect(read("src/lib/financialStatementsWorkspace/workspaceGate.ts")).toMatch(/^export const \w+_WORKSPACE_ENABLED = false;$/m);
  });

  it("the server stores, but does not recompute, the client's report document, findings and evidence status", () => {
    const assertDoc = persistence.slice(persistence.indexOf("FUNCTION public.fs_assert_report_document"), persistence.indexOf("$$;", persistence.indexOf("FUNCTION public.fs_assert_report_document")));
    expect(assertDoc).not.toMatch(/STATEMENT_OF_CHANGES_IN_EQUITY|socie/i);
    expect(persistence).toMatch(/v_row := public\.fs_store_evaluation\(p_evaluation_run_id, p_report_id, p_report_version, p_company_id, p_rule_pack_id, p_rule_pack_version, p_engine_version, p_input_hash, p_findings\);/);
    expect(persistence).toMatch(/p_validation_status TEXT, p_diagnostics JSONB/);
    expect(read("CLAUDE.md")).toMatch(/\*\*SERVER_AUTHORITATIVE_STATEMENT_COMPILER_REQUIRED\*\*/);
  });

  it("Monitoring is not complete: the dashboard only reads existing runs; nothing in the interface starts one", () => {
    const starters = walk("src").filter((f) => !/\.test\.|__tests__/.test(f) && /functions\.invoke\(\s*["']maono-compute["']/.test(read(f)));
    expect(starters).toEqual([]);
  });
});
