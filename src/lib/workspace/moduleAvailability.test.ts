/**
 * The Tax computation module — and the Compliance review and Filing package services whose gates require its signed
 * output — are withheld from every customer-facing surface, through ONE boundary (moduleAvailability.ts). Each block
 * below proves one containment property. The backend, migrations and tax records are untouched (proven by the branch
 * diff, not here). The last two blocks record, from the code itself, which customer-selectable services can complete
 * and which cannot, and what the server enforces for the statement of changes in equity.
 */
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import * as boundary from "./moduleAvailability";
import {
  CUSTOMER_HIDDEN_CAPABILITIES,
  CUSTOMER_HIDDEN_OUTCOMES,
  CUSTOMER_HIDDEN_STAGES,
  TAX_MODULE_CUSTOMER_VISIBLE,
  WITHHELD_SERVICE_SURFACES_VISIBLE,
  WITHHELD_WORKSPACE_ROUTE_SEGMENTS,
  customerVisibleCapabilities,
  isCapabilityCustomerVisible,
  isEngagementWithheld,
} from "./moduleAvailability";
import { CAPABILITY_OUTCOMES, CUSTOMER_CAPABILITY_OUTCOMES, ENGAGEMENT_CAPABILITIES, projectMandate, type EngagementCapability } from "./mandate";
import { deriveWorkspaceNavigation } from "./navigation";
import { deriveWorkspaceState } from "./deriveWorkspaceState";
import { STAGE_SEQUENCE } from "./stageMetadata";
import { deriveScopeChange } from "./engagementScopeChange";
import { decideReturningUserRoute } from "./resolveReturningUserRoute";
import { openEngagementWithScope, SERVICE_NOT_AVAILABLE_MESSAGE } from "./workspaceSetupClient";
import type { MissionState, UploadSnapshot, WorkspaceMission } from "./types";
import { JURISDICTION_DEPENDENT } from "@/lib/jurisdiction/registry";
import { SERVICE_INTENTS, currentServiceIntent, intentFromUserMetadata, parseServiceIntent } from "@/lib/commercial/serviceIntent";
import { PRODUCT_OUTCOMES, PUBLIC_PRODUCT_OUTCOMES, getOutcome } from "@/lib/product/outcomes";
import WorkspaceUnavailable, { WORKSPACE_UNAVAILABLE_COPY } from "@/components/workspace/WorkspaceUnavailable";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** Source without comments — what can actually reach a screen. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
/** Visible text with JSX line wrapping collapsed, so a phrase split across lines is still found. */
const flat = (rel: string) => code(rel).replace(/\s+/g, " ");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });

/** The withheld modules' wording that must never reach a customer. Tax-related ACCOUNTS are deliberately not listed. */
const MODULE_WORDING = /tax computation|compute (corporate )?tax|computed tax|tax workspace|prepare tax|tax service|tax engine|tax analysis|assess tax|tax workpaper|tax module|tax rules|compliance review|filing pack|filing package/i;

const VISIBLE: EngagementCapability[] = ["FINANCIAL_STATEMENTS", "MONITORING"];
const WITHHELD: EngagementCapability[] = ["TAX_COMPUTATION", "COMPLIANCE_REVIEW", "FILING_PREPARATION"];

const missions = (status: MissionState["status"] = "passed"): Record<WorkspaceMission, MissionState> =>
  Object.fromEntries(STAGE_SEQUENCE.map((s) => [s, { status, label: s, summary: "", href: `/x/${s}` }])) as Record<WorkspaceMission, MissionState>;

const upload = (overrides: Partial<UploadSnapshot> = {}): UploadSnapshot => ({
  id: "u1", companyId: "c1", companyName: "Example Co", periodYear: 2025, status: "complete", isValid: true, safishaStatus: "clean",
  uploadedAt: "2026-01-01T00:00:00.000Z", processedAt: "2026-01-01T00:05:00.000Z", hasMapping: true,
  certificationVerdict: "certified", certificationBlocker: null, ...overrides,
});

describe("the boundary itself", () => {
  it("is one reviewed source constant, false, never read from the environment, storage or a URL (fails closed)", () => {
    expect(TAX_MODULE_CUSTOMER_VISIBLE).toBe(false);
    const src = code("src/lib/workspace/moduleAvailability.ts");
    expect(src).toMatch(/export const TAX_MODULE_CUSTOMER_VISIBLE: boolean = false;/);
    expect(src).not.toMatch(/import\.meta|process\.env|VITE_|localStorage|sessionStorage|location|searchParams|supabase/);
    expect([...CUSTOMER_HIDDEN_CAPABILITIES]).toEqual(WITHHELD);
    expect([...CUSTOMER_HIDDEN_STAGES]).toEqual(["tax", "compliance", "filing"]);
    expect([...CUSTOMER_HIDDEN_OUTCOMES]).toEqual(["tax-compliance", "full-close"]);
    expect(WITHHELD_WORKSPACE_ROUTE_SEGMENTS).toEqual(["tax", "compliance", "filing"]);
    expect(WITHHELD_SERVICE_SURFACES_VISIBLE).toBe(false);
  });

  it("is the only place that decides it: no customer-facing file hard-codes its own check for a withheld service", () => {
    // Excluded: the canonical registries that DEFINE the stages/services/outcomes (filtered through the boundary, never
    // consulted around it), the unmounted module pages, the jurisdiction pack, and dev-only galleries. The jurisdiction
    // registry and tax-profile lists name which services need a jurisdiction; ProductTour is mounted by no route.
    const DEFINITIONS = /moduleAvailability\.ts$|(Tax|Compliance|Filing)Workspace\.tsx$|deriveWorkspaceState\.ts$|stageMetadata\.ts$|\/mandate\.ts$|workspaceAccess\.ts$|\/types\.ts$|useWorkspaceData\.ts$|\/lib\/product\/outcomes\.ts$|\/lib\/jurisdiction\/(registry|taxProfile)\.ts$|ProductTour\.tsx$/;
    const offenders = walk("src")
      .filter((f) => !/\.test\.|__tests__|\/jurisdiction-packs\/|\/integrations\/supabase\/|\/dev\/|\/pages\/internal\/|workflowAcceptanceFixtures\.ts$/.test(f) && !DEFINITIONS.test(f))
      .filter((f) => /["'](TAX_COMPUTATION|COMPLIANCE_REVIEW|FILING_PREPARATION)["']|["'](tax-compliance|full-close)["']|stage === ["'](tax|compliance|filing)["']|missions\.(tax|compliance|filing)\b/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

describe("1. no public page offers a withheld module", () => {
  const PUBLIC = [
    "src/pages/Index.tsx", "src/pages/Pricing.tsx", "src/pages/Plans.tsx", "src/pages/Auth.tsx", "src/pages/Terms.tsx", "src/pages/Privacy.tsx",
    "src/components/Header.tsx", "src/components/Footer.tsx", "src/content/publicClaimRegistry.ts",
    ...walk("src/components/landing"), ...walk("src/content/landing"),
    "src/lib/commercial/serviceIntent.ts", "src/lib/commercial/pricingCatalogue.ts",
  ].filter((f) => !/\.test\.|__tests__/.test(f));

  it("no public source file carries the modules' wording (line-wrapped JSX included)", () => {
    for (const f of PUBLIC) expect(flat(f), f).not.toMatch(MODULE_WORDING);
  });

  it("the legal pages describe the service as offered today; the ownership clause is neutral and covers historical records", () => {
    const terms = flat("src/pages/Terms.tsx");
    expect(terms).not.toMatch(/\btax\b|compliance review|filing pack/i);
    expect(terms).toMatch(/including records created with services that are no longer offered — belong to you and your firm/);
    const privacy = flat("src/pages/Privacy.tsx");
    expect(privacy).not.toMatch(/\btax\b|compliance, and filing/i);
    expect(privacy).toMatch(/including records created with services that are no longer offered/);
  });

  it("the crawler-visible metadata (index.html, structured data) does not either", () => {
    expect(read("index.html")).not.toMatch(MODULE_WORDING);
    expect(read("index.html")).not.toMatch(/tax capabilit/i);
  });

  it("the public outcome selector never offers a withheld outcome", () => {
    expect(PUBLIC_PRODUCT_OUTCOMES.map((o) => o.id)).toEqual(["clean-trial-balance", "prepare-statements", "performance-risk"]);
    for (const o of PUBLIC_PRODUCT_OUTCOMES) expect(JSON.stringify(o), o.id).not.toMatch(/\btax\b|complian|filing/i);
    // The registry itself is kept (no stored id is orphaned); only its customer projection changes.
    expect(PRODUCT_OUTCOMES.map((o) => o.id)).toEqual(expect.arrayContaining(["tax-compliance", "full-close"]));
  });
});

describe("2/12. no authenticated surface — navigation (desktop and mobile), services, account home — shows them", () => {
  const ALL: EngagementCapability[][] = [[], ...ENGAGEMENT_CAPABILITIES.map((c) => [c]), ENGAGEMENT_CAPABILITIES];

  it("navigation never contains a withheld stage, for any mandate, declared or not, with or without work", () => {
    for (const granted of ALL) {
      for (const status of ["passed", "signed", "locked", "ready"] as const) {
        for (const mandate of [null, { engagementId: "e", granted }]) {
          const views = projectMandate(missions(status), mandate);
          expect(views.map((v) => v.stage)).toEqual(expect.not.arrayContaining(["tax", "compliance", "filing"]));
          for (const scopeDeclared of [true, false]) {
            const items = deriveWorkspaceNavigation({ basePath: "/w/c/2025", scopeDeclared, missionViews: views });
            expect(items.map((i) => i.id)).toEqual(expect.not.arrayContaining(["tax", "compliance", "filing"]));
            expect(items.map((i) => i.href).join(" ")).not.toMatch(/\/(tax|compliance|filing)\b/);
          }
        }
      }
    }
  });

  it("the layout renders one navigation (labels adapt by breakpoint) built only from that derivation", () => {
    const layout = code("src/pages/workspace/WorkspaceLayout.tsx");
    expect(layout.match(/<nav\b/g)?.length).toBe(1);
    expect(layout).toMatch(/const navItems = withheld \? \[\] : deriveWorkspaceNavigation\(/);
    expect(layout).toMatch(/\{withheld \? <WorkspaceUnavailable \/> : <Outlet \/>\}/);
  });

  it("Monitor renders the withheld services' panels (compliance scorecard, filing calendar, tax payment ledger, compliance dashboard) only through the boundary", () => {
    const monitor = code("src/pages/workspace/MonitorWorkspace.tsx");
    const gated = monitor.slice(monitor.indexOf("{WITHHELD_SERVICE_SURFACES_VISIBLE && ("));
    expect(monitor.indexOf("{WITHHELD_SERVICE_SURFACES_VISIBLE && (")).toBeGreaterThan(0);
    for (const panel of ["<ComplianceScorecard />", 'panel="filingCalendar"', 'panel="paymentLedger"', "<FirmDashboardPanel />"]) {
      expect(monitor.split(panel).length - 1, panel).toBe(1);
      expect(gated).toContain(panel);
    }
  });

  it("the launchpad offers no jurisdiction setting while every service that needs one is withheld", () => {
    expect(JURISDICTION_DEPENDENT.some(isCapabilityCustomerVisible)).toBe(false);
    expect(code("src/components/workspace/ServiceLaunchpad.tsx")).toMatch(/\{JURISDICTION_DEPENDENT\.some\(isCapabilityCustomerVisible\) && \(\s*<div[^>]*>\s*<FilingJurisdictionSetting/);
  });

  it("customer-facing workspace sources carry none of the modules' wording", () => {
    // OutputsStage belongs to the evidence-based statements workspace, which is switched off in production
    // (src/lib/financialStatementsWorkspace/workspaceGate.ts); its only such wording is an XBRL filing package marked "Not available".
    const UNMOUNTED = /(Tax|Compliance|Filing)Workspace\.tsx$|\/components\/enquiry\/|ProductTour\.tsx$|MgmtLetterPanel\.tsx$|NoteSynth\.tsx$|ComplianceScorecard\.tsx$|FirmDashboardPanel\.tsx$|financialStatements\/OutputsStage\.tsx$/;
    const files = [
      ...walk("src/pages/workspace"), ...walk("src/components"), "src/pages/Dashboard.tsx", "src/pages/Settings.tsx",
      "src/lib/workspace/trialBalanceVerdict.ts", "src/lib/workspace/deriveOrientationSummary.ts",
    ].filter((f) => !/\.test\.|__tests__/.test(f) && !UNMOUNTED.test(f));
    expect(files.filter((f) => MODULE_WORDING.test(flat(f)))).toEqual([]);
  });

  it("the panels excluded above are mounted only by withheld pages or behind the boundary", () => {
    const mounts = (name: string) => walk("src").filter((f) => !/\.test\.|__tests__|\/dev\//.test(f) && new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(read(f)));
    expect(mounts("MgmtLetterPanel")).toEqual(["src/pages/workspace/FilingWorkspace.tsx"]);
    expect(mounts("NoteSynth")).toEqual(["src/pages/workspace/FilingWorkspace.tsx"]);
    expect(mounts("ComplianceScorecard")).toEqual(["src/pages/workspace/MonitorWorkspace.tsx"]);
    expect(mounts("FirmDashboardPanel")).toEqual(["src/pages/workspace/MonitorWorkspace.tsx"]);
  });

  it("the engine's own wording for OTHER stages never names the Tax module (strings only; gates unchanged)", () => {
    const engine = code("src/lib/workspace/deriveWorkspaceState.ts");
    expect(engine).not.toMatch(/Available after tax computation|Complete Compute Tax first|Awaiting Compute Tax|before tax computation can run|Tax computation is signed/);
  });
});

describe("3/4. no service chooser or engagement-creation path offers them", () => {
  it("the customer service list is the canonical registry less the withheld services", () => {
    expect(CUSTOMER_CAPABILITY_OUTCOMES.map((o) => o.capability)).toEqual(VISIBLE);
    expect(CAPABILITY_OUTCOMES.map((o) => o.capability)).toEqual(expect.arrayContaining(WITHHELD));
  });

  it("the launchpad and the Manage/Start-another-service dialog render only the customer list", () => {
    for (const f of ["src/components/workspace/ServiceLaunchpad.tsx", "src/components/workspace/EngagementScopeDialog.tsx"]) {
      expect(code(f), f).toMatch(/CUSTOMER_CAPABILITY_OUTCOMES\.map/);
      expect(code(f), f).not.toMatch(/[^_]CAPABILITY_OUTCOMES\.map/);
    }
  });

  it("the only client path that opens an engagement refuses every withheld service before any request", async () => {
    const rpc = vi.fn();
    for (const cap of WITHHELD) {
      await expect(openEngagementWithScope({ rpc } as never, { companyId: "c", year: 2025, capabilities: [cap] })).rejects.toThrow(SERVICE_NOT_AVAILABLE_MESSAGE);
      await expect(openEngagementWithScope({ rpc } as never, { companyId: "c", year: 2025, capabilities: ["FINANCIAL_STATEMENTS", cap] })).rejects.toThrow(SERVICE_NOT_AVAILABLE_MESSAGE);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("granting a service refuses a withheld one before any request", () => {
    expect(code("src/hooks/useEngagementMandate.ts")).toMatch(/if \(!isCapabilityCustomerVisible\(cap\)\) throw new Error\(SERVICE_NOT_AVAILABLE_MESSAGE\);\s*const \{ error \} = await supabase\.rpc\("grant_engagement_capability"/);
  });
});

describe("5. no stored or linked sign-up intent can select them", () => {
  it("the service-intent registry routes only to customer-visible stages; no withheld identifier parses", () => {
    for (const s of Object.values(SERVICE_INTENTS)) expect(boundary.isStageCustomerVisible(s.stage), s.id).toBe(true);
    for (const v of ["tax", "tax-computation", "tax-compliance", "compliance", "filing", "full-close", "TAX_COMPUTATION", "COMPLIANCE_REVIEW", "FILING_PREPARATION", "kinga"]) {
      expect(parseServiceIntent(v), v).toBeNull();
      expect(currentServiceIntent(`?service=${v}&plan=solo`), v).toBeNull();
      expect(intentFromUserMetadata({ service_intent: { v: 1, service: v, plan: "solo" } }), v).toBeNull();
    }
  });

  it("a withheld outcome resolves to nothing from a link (?intent=) or from browser storage", async () => {
    expect(getOutcome("tax-compliance")).toBeNull();
    expect(getOutcome("full-close")).toBeNull();
    for (const stored of ["tax-compliance", "full-close"]) {
      vi.stubGlobal("window", { sessionStorage: { getItem: () => stored, setItem: () => undefined } });
      const { readRememberedOutcome } = await import("@/lib/product/outcomes");
      expect(readRememberedOutcome(), stored).toBeNull();
      vi.unstubAllGlobals();
    }
  });
});

describe("6/7. direct URLs, old bookmarks and refreshes never mount a withheld workspace", () => {
  it("App.tsx neither imports nor routes to the withheld pages; their paths render the neutral boundary", () => {
    const app = code("src/App.tsx");
    expect(app).not.toMatch(/TaxWorkspace|ComplianceWorkspace|FilingWorkspace/);
    expect(app).not.toMatch(/path="(tax|compliance|filing)"/);
    expect(app).toMatch(/\{WITHHELD_WORKSPACE_ROUTE_SEGMENTS\.map\(\(segment\) => \(\s*<Route key=\{segment\} path=\{segment\} element=\{<WorkspaceUnavailable \/>\} \/>/);
    // Legacy aliases still resolve through the same boundary (never to a module component).
    expect(app).toMatch(/path="kinga"\s+element=\{<LegacySubRouteRedirect to="tax" \/>\}/);
    expect(app).toMatch(/path="issues"\s+element=\{<LegacySubRouteRedirect to="compliance" \/>\}/);
    // No lazy or dynamic import of those pages anywhere in the application graph either.
    for (const f of walk("src").filter((x) => !/\.test\.|__tests__/.test(x))) {
      expect(code(f), f).not.toMatch(/(import\(["']|from ["'])[^"']*(Tax|Compliance|Filing)Workspace["']/);
    }
  });

  it("an old bookmark (and its query-string variants) lands on the neutral boundary with one way back to the account home", () => {
    for (const url of ["/workspace/c/2025/tax", "/workspace/c/2025/tax?tab=comparative", "/workspace/c/2025/compliance", "/workspace/c/2025/filing#notes"]) {
      const html = renderToStaticMarkup(
        createElement(MemoryRouter, { initialEntries: [url] },
          createElement(Routes, null,
            createElement(Route, { path: "/workspace/:companyId/:periodYear" },
              ...WITHHELD_WORKSPACE_ROUTE_SEGMENTS.map((segment) => createElement(Route, { key: segment, path: segment, element: createElement(WorkspaceUnavailable) }))))),
      );
      expect(html, url).toContain(WORKSPACE_UNAVAILABLE_COPY.headline);
      expect(html, url).toContain(">Return to account home<");
      expect(html, url).toContain('href="/dashboard"');
      expect(html, url).not.toMatch(/tax|complian|filing/i);
    }
    expect(WORKSPACE_UNAVAILABLE_COPY).toEqual({ headline: "This workspace is not currently available.", action: "Return to account home" });
  });
});

describe("8. an existing withheld-only engagement is preserved, never listed, never mounted, never converted", () => {
  it("it is withheld as a whole; a mixed engagement keeps every visible service; an undeclared one keeps its launchpad", () => {
    for (const cap of WITHHELD) expect(isEngagementWithheld([cap]), cap).toBe(true);
    expect(isEngagementWithheld(WITHHELD)).toBe(true);
    expect(isEngagementWithheld([...WITHHELD, "FINANCIAL_STATEMENTS"])).toBe(false);
    expect(customerVisibleCapabilities([...WITHHELD, "MONITORING"])).toEqual(["MONITORING"]);
    expect(isEngagementWithheld([])).toBe(false);
    expect(isEngagementWithheld(null)).toBe(false);
  });

  it("the account home keeps it out of the list without turning the account into a first run", () => {
    expect(decideReturningUserRoute([], [], [], 1)).toEqual({ kind: "chooser" });
    expect(decideReturningUserRoute([], [], [], 0)).toEqual({ kind: "first_run" });
    const hook = code("src/hooks/useActiveEngagements.ts");
    expect(hook).toMatch(/setEntries\(resolved\.filter\(\(e\) => !isEngagementWithheld\(e\.capabilities\)\)\)/);
    // Its company is not re-offered as "without engagement" (that would invite a silently converted second engagement).
    expect(hook).toMatch(/const companyIdsWithEngagement = new Set\(openEngagements\.map\(\(e\) => e\.company_id\)\);/);
  });

  it("amending a mixed engagement can never withdraw a hidden grant — it is not listed, so it stays selected", () => {
    const current: EngagementCapability[] = ["FINANCIAL_STATEMENTS", ...WITHHELD];
    expect(deriveScopeChange("amend", current, [...current]).removed).toEqual([]);
    expect(deriveScopeChange("add", current, [...current, "MONITORING"]).removed).toEqual([]);
  });

  it("no client code path deletes, rewrites or revokes it: the containment adds no write", () => {
    for (const f of ["src/lib/workspace/moduleAvailability.ts", "src/components/workspace/WorkspaceUnavailable.tsx"]) {
      expect(code(f), f).not.toMatch(/supabase|\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    }
  });
});

describe("10. the customer-selectable services keep their routes and navigation", () => {
  it("each remaining stage keeps its route, and its navigation under its own service", () => {
    const app = code("src/App.tsx");
    for (const s of ["prepare", "reconcile", "statements", "monitor"]) expect(app).toMatch(new RegExp(`path="${s}"\\s+element=\\{<StageScopeGate stage="${s}">`));
    const nav = (granted: EngagementCapability[]) => deriveWorkspaceNavigation({ basePath: "/w", scopeDeclared: true, missionViews: projectMandate(missions(), { engagementId: "e", granted }) }).map((i) => i.id);
    expect(nav(["FINANCIAL_STATEMENTS"])).toEqual(["overview", "prepare", "reconcile", "statements"]);
    expect(nav(["MONITORING"])).toEqual(["overview", "prepare", "monitor"]);
    for (const cap of WITHHELD) expect(nav([cap]), cap).toEqual(["overview"]);
  });
});

describe("4. completion paths of every customer-selectable service (recorded from the code, not asserted by hope)", () => {
  it("Prepare data (intent prepare-review) completes without any withheld output: certified, reconciled TB → Prepare passed", () => {
    const s = deriveWorkspaceState("c1", "Example Co", 2025, upload());
    expect(s.missions.prepare.status).toBe("passed");
    expect(s.missions.statements.status).toBe("ready");
    expect(SERVICE_INTENTS["prepare-review"].stage).toBe("prepare");
  });

  it("Ongoing monitoring (intent close-insights) has no lock gate in any engine path and runs on the certified TB", () => {
    for (const u of [null, upload(), upload({ hesabuPassedAt: "2026-02-01T00:00:00.000Z" })]) {
      expect(deriveWorkspaceState("c1", "Example Co", 2025, u).missions.monitor.status).not.toBe("locked");
    }
    expect(code("src/pages/workspace/MonitorWorkspace.tsx")).toMatch(/upload\?\.status === "complete" && upload\.is_valid === true && upload\.company_id && \(\s*<MaonoDashboard/);
    const maono = read("supabase/functions/maono-compute/index.ts");
    expect(maono).toMatch(/import \{ loadCertifiedTb/);
    expect(maono).not.toMatch(/from\("tax_computations"\)/);
    expect(SERVICE_INTENTS["close-insights"].stage).toBe("monitor");
  });

  it("Financial statements (intent reporting-pack): the statements stage opens without Tax, but only a WORKING COPY can be produced in production", () => {
    // Reachable: the stage and its working-copy export.
    expect(deriveWorkspaceState("c1", "Example Co", 2025, upload()).missions.statements.status).toBe("ready");
    const page = code("src/pages/workspace/StatementsWorkspace.tsx");
    expect(page).toMatch(/<ExportStatements[\s\S]*?taxResult=\{null\}/);
    expect(read("src/components/ExportStatements.tsx")).toMatch(/working copy, not a sealed official Reporting Pack/);
    // BLOCKER (registered in the PR): "Statements validated" needs hesabuPassedAt, and hesabu-validate refuses without
    // a tax computation; the evidence-based FINAL / official-pack workspace is switched off in production.
    expect(deriveWorkspaceState("c1", "Example Co", 2025, upload({ hesabuPassedAt: "2026-02-01T00:00:00.000Z" })).missions.statements.status).toBe("passed");
    expect(read("supabase/functions/hesabu-validate/index.ts")).toMatch(/No tax computation found for this upload\. Run kinga-tax-engine first\./);
    expect(read("src/jurisdiction-packs/tz/KingaTaxPanel.tsx")).toMatch(/functions\.invoke\("hesabu-validate"/);
    // The statements-workspace gate (its own module; the isolation guard keeps its name out of other files) is off.
    expect(read("src/lib/financialStatementsWorkspace/workspaceGate.ts")).toMatch(/^export const \w+_WORKSPACE_ENABLED = false;$/m);
  });

  it("Close Certification (intent close-certification) — BLOCKER: a statement sign-off can only be CREATED from the Tax panel", () => {
    const creators = walk("src").filter((f) => !/\.test\.|__tests__/.test(f) && /from\("statement_sign_offs"\)\s*\.insert\(/.test(read(f)));
    expect(creators).toEqual(["src/jurisdiction-packs/tz/KingaTaxPanel.tsx"]);
    // Settings can only advance an EXISTING sign-off; the database gate requires a passed statement validation.
    expect(read("src/components/PeriodCloseManager.tsx")).toMatch(/from\("statement_sign_offs"\)\s*\.update\(payload\)/);
    expect(read("src/components/PeriodCloseManager.tsx")).not.toMatch(/from\("statement_sign_offs"\)\s*\.insert\(/);
    expect(SERVICE_INTENTS["close-certification"].stage).toBe("statements");
  });
});

describe("SOCIE: what each statement path depends on, and what the server enforces before FINAL / an official pack", () => {
  const persistence = read("supabase/migrations/20260919110000_financial_statements_persistence.sql");
  const authorization = read("supabase/migrations/20260925140000_workspace_capability_authorization.sql");

  it("working-copy export: every SOCIE value came only from KINGA's socie_engine, which the Statements stage never passes", () => {
    const x = read("src/components/ExportStatements.tsx");
    expect(x).toMatch(/const socie = taxResult\?\.socie_engine;/);
    for (const v of ["share_capital.opening_tzs", "retained_earnings.profit_for_year_tzs", "retained_earnings.dividends_declared_tzs", "share_capital.issued_tzs", "total.closing_derived_tzs"]) expect(x).toContain(`socie.${v}`);
    expect(code("src/pages/workspace/StatementsWorkspace.tsx")).toMatch(/taxResult=\{null\}/);
    // The placeholder states the consequence, never a bare "no data".
    expect(x).toMatch(/A statement set without it is incomplete and is not an official Reporting Pack\./);
    expect(x).not.toMatch(/No data has been recorded for this statement/);
  });

  it("official path: the SOCIE is generated only from validated equity-movement evidence — never from tax output", () => {
    expect(read("src/lib/financialGeneration/applyEvidence.ts")).toMatch(/inputs<EquityPeriodInput>\("EQUITY_MOVEMENTS"[\s\S]*?collect\("STATEMENT_OF_CHANGES_IN_EQUITY", buildEquityStatement\(equity\.items\)/);
    for (const f of [...walk("src/lib/financialGeneration"), ...walk("src/lib/financialStatementsWorkspace")].filter((x) => !/\.test\./.test(x))) {
      expect(read(f), f).not.toMatch(/tax_computations|socie_engine|kinga/i);
    }
  });

  it("server: FINAL needs a SOCIE statement, EQUITY_MOVEMENTS evidence and unwaivable equity ties; an official pack needs FINAL", () => {
    for (const fw of ["IFRS", "IFRS_FOR_SMES", "IPSAS_ACCRUAL"]) {
      expect(persistence).toMatch(new RegExp(`\\('${fw}',\\s+ARRAY\\[[^\\]]*'STATEMENT_OF_CHANGES_IN_EQUITY'[^\\]]*\\], true, ARRAY\\['TRANSACTION_LEDGER', 'EQUITY_MOVEMENTS'\\]`));
    }
    expect(persistence).toMatch(/v_out := v_out \|\| \('MISSING_STATEMENT:' \|\| v_type\);/);
    expect(persistence).toMatch(/v_out := v_out \|\| \('REQUIRED_EVIDENCE_MISSING:' \|\| v_type\);/);
    expect(persistence).toMatch(/'equity-closing-tie',\s+'equity-profit-tie'/);
    expect(authorization).toMatch(/v_blockers := public\.fs_publication_blockers\(p_company_id, p_report_id, p_report_version\);/);
    expect(authorization).toMatch(/RAISE EXCEPTION 'BLOCKED: % requirement\(s\) unmet, the report cannot be marked %/);
    expect(authorization).toMatch(/AND p\.state = 'FINAL'/);
  });

  it("server GAP (registered, not fixed here): the document, evaluation findings and evidence status are client-supplied, not recomputed", () => {
    // fs_assert_report_document checks lineage and integer money encoding only; fs_save_evaluation stores the caller's
    // findings; evidence validation_status is a caller parameter. A modified client could therefore assert a
    // materially incomplete SOCIE as complete. No frontend guarantee is claimed for this.
    const assertDoc = persistence.slice(persistence.indexOf("FUNCTION public.fs_assert_report_document"), persistence.indexOf("$$;", persistence.indexOf("FUNCTION public.fs_assert_report_document")));
    expect(assertDoc).not.toMatch(/STATEMENT_OF_CHANGES_IN_EQUITY|socie/i);
    expect(persistence).toMatch(/v_row := public\.fs_store_evaluation\(p_evaluation_run_id, p_report_id, p_report_version, p_company_id, p_rule_pack_id, p_rule_pack_version, p_engine_version, p_input_hash, p_findings\);/);
    expect(persistence).toMatch(/p_validation_status TEXT, p_diagnostics JSONB/);
  });
});

describe("11. tax-related accounting data is not the module and is never filtered", () => {
  it("the boundary filters only stages, services, outcomes and their surfaces — it has no account-level API", () => {
    expect(Object.keys(boundary).sort()).toEqual([
      "CUSTOMER_HIDDEN_CAPABILITIES", "CUSTOMER_HIDDEN_OUTCOMES", "CUSTOMER_HIDDEN_STAGES", "TAX_MODULE_CUSTOMER_VISIBLE",
      "WITHHELD_SERVICE_SURFACES_VISIBLE", "WITHHELD_WORKSPACE_ROUTE_SEGMENTS", "customerVisibleCapabilities",
      "isCapabilityCustomerVisible", "isEngagementWithheld", "isOutcomeCustomerVisible", "isStageCustomerVisible",
    ]);
  });

  it("no trial-balance, classification or statement code consults it", () => {
    const tb = [...walk("src/lib/accounting"), ...walk("src/lib/canonicalStatement"), "src/components/TrialBalanceUpload.tsx", "src/lib/workspace/trialBalanceVerdict.ts", "src/components/ExportStatements.tsx"];
    for (const f of tb) expect(read(f), f).not.toMatch(/moduleAvailability/);
    // Ordinary tax accounts stay ordinary statement lines, untouched by this change.
    expect(read("src/components/ExportStatements.tsx")).toMatch(/PROFIT BEFORE TAX/);
  });
});
