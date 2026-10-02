/**
 * The Tax computation module is withheld from every customer-facing surface, through ONE boundary
 * (moduleAvailability.ts). Each block below proves one containment property; the backend, migrations and tax
 * records are untouched and are proven by the branch diff, not here.
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
  WITHHELD_WORKSPACE_ROUTE_SEGMENTS,
  customerVisibleCapabilities,
  isEngagementWithheld,
} from "./moduleAvailability";
import { CAPABILITY_OUTCOMES, CUSTOMER_CAPABILITY_OUTCOMES, ENGAGEMENT_CAPABILITIES, projectMandate, type EngagementCapability } from "./mandate";
import { deriveWorkspaceNavigation } from "./navigation";
import { STAGE_SEQUENCE } from "./stageMetadata";
import { deriveScopeChange } from "./engagementScopeChange";
import { decideReturningUserRoute } from "./resolveReturningUserRoute";
import { openEngagementWithScope, SERVICE_NOT_AVAILABLE_MESSAGE } from "./workspaceSetupClient";
import type { MissionState, WorkspaceMission } from "./types";
import { SERVICE_INTENTS, currentServiceIntent, intentFromUserMetadata, parseServiceIntent } from "@/lib/commercial/serviceIntent";
import { PRODUCT_OUTCOMES, PUBLIC_PRODUCT_OUTCOMES, getOutcome } from "@/lib/product/outcomes";
import WorkspaceUnavailable, { WORKSPACE_UNAVAILABLE_COPY } from "@/components/workspace/WorkspaceUnavailable";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** Source without comments — what can actually reach a screen. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });

/** The product-module wording that must never reach a customer. Tax-related ACCOUNTS are deliberately not listed. */
const MODULE_WORDING = /tax computation|compute (corporate )?tax|computed tax|tax workspace|prepare tax|tax service|tax engine|assess tax|tax workpaper|tax module/i;

const missions = (status: MissionState["status"] = "passed"): Record<WorkspaceMission, MissionState> =>
  Object.fromEntries(STAGE_SEQUENCE.map((s) => [s, { status, label: s, summary: "", href: `/x/${s}` }])) as Record<WorkspaceMission, MissionState>;

describe("the boundary itself", () => {
  it("is one reviewed source constant, false, never read from the environment, storage or a URL (fails closed)", () => {
    expect(TAX_MODULE_CUSTOMER_VISIBLE).toBe(false);
    const src = code("src/lib/workspace/moduleAvailability.ts");
    expect(src).toMatch(/export const TAX_MODULE_CUSTOMER_VISIBLE: boolean = false;/);
    expect(src).not.toMatch(/import\.meta|process\.env|VITE_|localStorage|sessionStorage|location|searchParams|supabase/);
    expect([...CUSTOMER_HIDDEN_CAPABILITIES]).toEqual(["TAX_COMPUTATION"]);
    expect([...CUSTOMER_HIDDEN_STAGES]).toEqual(["tax"]);
    expect([...CUSTOMER_HIDDEN_OUTCOMES]).toEqual(["tax-compliance"]);
    expect(WITHHELD_WORKSPACE_ROUTE_SEGMENTS).toEqual(["tax"]);
  });

  it("is the only place that decides it: no customer-facing file hard-codes its own tax-module check", () => {
    // Excluded: the canonical registries that DEFINE the stage/service/outcome (filtered through the boundary, never
    // consulted around it), the unreachable module itself, the jurisdiction pack, and dev-only galleries. The jurisdiction
    // registry and tax-profile lists name which services need a jurisdiction; ProductTour is mounted by no route.
    const DEFINITIONS = /moduleAvailability\.ts$|TaxWorkspace\.tsx$|deriveWorkspaceState\.ts$|stageMetadata\.ts$|\/mandate\.ts$|workspaceAccess\.ts$|\/types\.ts$|useWorkspaceData\.ts$|\/lib\/product\/outcomes\.ts$|\/lib\/jurisdiction\/(registry|taxProfile)\.ts$|ProductTour\.tsx$/;
    const offenders = walk("src")
      .filter((f) => !/\.test\.|__tests__|\/jurisdiction-packs\/|\/integrations\/supabase\/|\/dev\/|\/pages\/internal\/|workflowAcceptanceFixtures\.ts$/.test(f) && !DEFINITIONS.test(f))
      .filter((f) => /["']TAX_COMPUTATION["']|["']tax-compliance["']|stage === ["']tax["']|missions\.tax\b/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

describe("1. no public page offers the Tax module", () => {
  const PUBLIC = [
    "src/pages/Index.tsx", "src/pages/Pricing.tsx", "src/pages/Plans.tsx", "src/pages/Auth.tsx", "src/pages/Terms.tsx",
    "src/components/Header.tsx", "src/components/Footer.tsx", "src/content/publicClaimRegistry.ts",
    ...walk("src/components/landing"), ...walk("src/content/landing"),
    "src/lib/commercial/serviceIntent.ts", "src/lib/commercial/featureRegistry.ts", "src/lib/commercial/pricingCatalogue.ts",
  ].filter((f) => !/\.test\.|__tests__/.test(f));

  it("no public source file carries the module's wording", () => {
    for (const f of PUBLIC) expect(code(f), f).not.toMatch(MODULE_WORDING);
  });

  it("the crawler-visible metadata (index.html, structured data) does not either", () => {
    expect(read("index.html")).not.toMatch(MODULE_WORDING);
    expect(read("index.html")).not.toMatch(/tax capabilit/i);
  });

  it("the public outcome selector never offers the tax outcome", () => {
    expect(PUBLIC_PRODUCT_OUTCOMES.map((o) => o.id)).not.toContain("tax-compliance");
    for (const o of PUBLIC_PRODUCT_OUTCOMES) expect(JSON.stringify(o), o.id).not.toMatch(/\btax\b/i);
    // The registry itself is kept (no stored id is orphaned); only its customer projection changes.
    expect(PRODUCT_OUTCOMES.map((o) => o.id)).toContain("tax-compliance");
  });
});

describe("2/12. no authenticated surface — navigation (desktop and mobile), services, account home — shows it", () => {
  const ALL: EngagementCapability[][] = [[], ...ENGAGEMENT_CAPABILITIES.map((c) => [c]), ENGAGEMENT_CAPABILITIES];

  it("navigation never contains the tax stage, for any mandate, declared or not, with or without work", () => {
    for (const granted of ALL) {
      for (const status of ["passed", "signed", "locked"] as const) {
        for (const mandate of [null, { engagementId: "e", granted }]) {
          const views = projectMandate(missions(status), mandate);
          expect(views.map((v) => v.stage)).not.toContain("tax");
          for (const scopeDeclared of [true, false]) {
            const items = deriveWorkspaceNavigation({ basePath: "/w/c/2025", scopeDeclared, missionViews: views });
            expect(items.map((i) => i.id)).not.toContain("tax");
            expect(items.map((i) => i.href).join(" ")).not.toMatch(/\/tax\b/);
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

  it("customer-facing workspace sources carry none of the module's wording", () => {
    const files = [
      ...walk("src/pages/workspace"), ...walk("src/components"), "src/pages/Dashboard.tsx", "src/pages/Settings.tsx",
      "src/lib/workspace/trialBalanceVerdict.ts", "src/lib/workspace/deriveOrientationSummary.ts",
    ].filter((f) => !/\.test\.|__tests__|TaxWorkspace\.tsx$|\/components\/enquiry\/|ProductTour\.tsx$/.test(f));
    const hits = files.filter((f) => MODULE_WORDING.test(code(f)));
    expect(hits).toEqual([]);
  });

  it("the engine's own wording for OTHER stages never names the module (strings only; gates unchanged)", () => {
    const engine = code("src/lib/workspace/deriveWorkspaceState.ts");
    expect(engine).not.toMatch(/Available after tax computation|Complete Compute Tax first|Awaiting Compute Tax|before tax computation can run|Tax computation is signed/);
  });
});

describe("3/4. no service chooser or engagement-creation path offers it", () => {
  it("the customer service list is the canonical registry less the withheld service — every other service kept", () => {
    expect(CUSTOMER_CAPABILITY_OUTCOMES.map((o) => o.capability)).toEqual(["FINANCIAL_STATEMENTS", "COMPLIANCE_REVIEW", "FILING_PREPARATION", "MONITORING"]);
    expect(CAPABILITY_OUTCOMES.map((o) => o.capability)).toContain("TAX_COMPUTATION");
  });

  it("the launchpad and the Manage/Start-another-service dialog render only the customer list", () => {
    for (const f of ["src/components/workspace/ServiceLaunchpad.tsx", "src/components/workspace/EngagementScopeDialog.tsx"]) {
      expect(code(f), f).toMatch(/CUSTOMER_CAPABILITY_OUTCOMES\.map/);
      expect(code(f), f).not.toMatch(/[^_]CAPABILITY_OUTCOMES\.map/);
    }
  });

  it("the only client path that opens an engagement refuses the withheld service before any request", async () => {
    const rpc = vi.fn();
    await expect(openEngagementWithScope({ rpc } as never, { companyId: "c", year: 2025, capabilities: ["TAX_COMPUTATION"] })).rejects.toThrow(SERVICE_NOT_AVAILABLE_MESSAGE);
    await expect(openEngagementWithScope({ rpc } as never, { companyId: "c", year: 2025, capabilities: ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"] })).rejects.toThrow(SERVICE_NOT_AVAILABLE_MESSAGE);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("granting a service refuses the withheld one before any request", () => {
    expect(code("src/hooks/useEngagementMandate.ts")).toMatch(/if \(!isCapabilityCustomerVisible\(cap\)\) throw new Error\(SERVICE_NOT_AVAILABLE_MESSAGE\);\s*const \{ error \} = await supabase\.rpc\("grant_engagement_capability"/);
  });
});

describe("5. no stored or linked sign-up intent can select it", () => {
  it("the service-intent registry has no tax service and routes only to customer-visible stages", () => {
    for (const s of Object.values(SERVICE_INTENTS)) expect(boundary.isStageCustomerVisible(s.stage), s.id).toBe(true);
    for (const v of ["tax", "tax-computation", "tax-compliance", "TAX_COMPUTATION", "kinga"]) {
      expect(parseServiceIntent(v), v).toBeNull();
      expect(currentServiceIntent(`?service=${v}&plan=solo`), v).toBeNull();
      expect(intentFromUserMetadata({ service_intent: { v: 1, service: v, plan: "solo" } }), v).toBeNull();
    }
  });

  it("the tax outcome resolves to nothing from a link (?intent=) or from browser storage", () => {
    expect(getOutcome("tax-compliance")).toBeNull();
    const store = new Map<string, string>([["cfoclose:selected-outcome:v1", "tax-compliance"]]);
    vi.stubGlobal("window", { sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: () => undefined } });
    return import("@/lib/product/outcomes").then(({ readRememberedOutcome }) => {
      expect(readRememberedOutcome()).toBeNull();
      vi.unstubAllGlobals();
    });
  });
});

describe("6/7. direct URLs, old bookmarks and refreshes never mount the Tax workspace", () => {
  it("App.tsx neither imports nor routes to TaxWorkspace; the stage path renders the neutral boundary", () => {
    const app = code("src/App.tsx");
    expect(app).not.toMatch(/TaxWorkspace/);
    expect(app).not.toMatch(/path="tax"/);
    expect(app).toMatch(/\{WITHHELD_WORKSPACE_ROUTE_SEGMENTS\.map\(\(segment\) => \(\s*<Route key=\{segment\} path=\{segment\} element=\{<WorkspaceUnavailable \/>\} \/>/);
    // The legacy engine-named alias still resolves through the same boundary (never to a module component).
    expect(app).toMatch(/path="kinga"\s+element=\{<LegacySubRouteRedirect to="tax" \/>\}/);
    // No lazy or dynamic import of the page anywhere in the application graph either.
    for (const f of walk("src").filter((x) => !/\.test\.|__tests__/.test(x))) expect(code(f), f).not.toMatch(/import\(["'][^"']*TaxWorkspace["']\)|from ["'][^"']*TaxWorkspace["']/);
  });

  it("an old bookmark (and its query-string variants) lands on the neutral boundary with one way back to the account home", () => {
    for (const url of ["/workspace/c/2025/tax", "/workspace/c/2025/tax?tab=comparative", "/workspace/c/2025/tax#workpapers"]) {
      const html = renderToStaticMarkup(
        createElement(MemoryRouter, { initialEntries: [url] },
          createElement(Routes, null,
            createElement(Route, { path: "/workspace/:companyId/:periodYear" },
              ...WITHHELD_WORKSPACE_ROUTE_SEGMENTS.map((segment) => createElement(Route, { key: segment, path: segment, element: createElement(WorkspaceUnavailable) }))))),
      );
      expect(html).toContain(WORKSPACE_UNAVAILABLE_COPY.headline);
      expect(html).toContain(">Return to account home<");
      expect(html).toContain('href="/dashboard"');
      expect(html).not.toMatch(/tax/i);
    }
    expect(WORKSPACE_UNAVAILABLE_COPY).toEqual({ headline: "This workspace is not currently available.", action: "Return to account home" });
  });
});

describe("8. an existing Tax-only engagement is preserved, never listed, never mounted, never converted", () => {
  it("it is withheld as a whole; a mixed engagement keeps every other service; an undeclared one keeps its launchpad", () => {
    expect(isEngagementWithheld(["TAX_COMPUTATION"])).toBe(true);
    expect(isEngagementWithheld(["TAX_COMPUTATION", "FINANCIAL_STATEMENTS"])).toBe(false);
    expect(customerVisibleCapabilities(["TAX_COMPUTATION", "FINANCIAL_STATEMENTS"])).toEqual(["FINANCIAL_STATEMENTS"]);
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

  it("amending a mixed engagement can never withdraw the hidden grant — it is not listed, so it stays selected", () => {
    const current: EngagementCapability[] = ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"];
    expect(deriveScopeChange("amend", current, [...current]).removed).toEqual([]);
    expect(deriveScopeChange("add", current, [...current, "MONITORING"]).removed).toEqual([]);
  });

  it("no client code path deletes, rewrites or revokes it: the containment adds no write", () => {
    for (const f of ["src/lib/workspace/moduleAvailability.ts", "src/components/workspace/WorkspaceUnavailable.tsx"]) {
      expect(code(f), f).not.toMatch(/supabase|\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    }
  });
});

describe("10. every other service stays reachable", () => {
  it("each remaining stage keeps its route, and its navigation under its own service", () => {
    const app = code("src/App.tsx");
    for (const s of ["prepare", "reconcile", "statements", "compliance", "filing", "monitor"]) expect(app).toMatch(new RegExp(`path="${s}"\\s+element=\\{<StageScopeGate stage="${s}">`));
    const nav = (granted: EngagementCapability[]) => deriveWorkspaceNavigation({ basePath: "/w", scopeDeclared: true, missionViews: projectMandate(missions(), { engagementId: "e", granted }) }).map((i) => i.id);
    expect(nav(["FINANCIAL_STATEMENTS"])).toEqual(["overview", "prepare", "reconcile", "statements"]);
    expect(nav(["COMPLIANCE_REVIEW"])).toEqual(["overview", "prepare", "statements", "compliance"]);
    expect(nav(["FILING_PREPARATION"])).toEqual(["overview", "compliance", "filing"]);
    expect(nav(["MONITORING"])).toEqual(["overview", "prepare", "monitor"]);
  });
});

describe("11. tax-related accounting data is not the module and is never filtered", () => {
  it("the boundary filters only stages, services and outcomes — it has no account-level API", () => {
    expect(Object.keys(boundary).sort()).toEqual([
      "CUSTOMER_HIDDEN_CAPABILITIES", "CUSTOMER_HIDDEN_OUTCOMES", "CUSTOMER_HIDDEN_STAGES", "TAX_MODULE_CUSTOMER_VISIBLE",
      "WITHHELD_WORKSPACE_ROUTE_SEGMENTS", "customerVisibleCapabilities", "isCapabilityCustomerVisible", "isEngagementWithheld",
      "isOutcomeCustomerVisible", "isStageCustomerVisible",
    ]);
  });

  it("no trial-balance, classification or statement code consults it", () => {
    const tb = [...walk("src/lib/accounting"), ...walk("src/lib/canonicalStatement"), "src/components/TrialBalanceUpload.tsx", "src/lib/workspace/trialBalanceVerdict.ts", "src/components/ExportStatements.tsx"];
    for (const f of tb) expect(read(f), f).not.toMatch(/moduleAvailability/);
    // Ordinary tax accounts stay ordinary statement lines, untouched by this change.
    expect(read("src/components/ExportStatements.tsx")).toMatch(/PROFIT BEFORE TAX/);
  });
});
