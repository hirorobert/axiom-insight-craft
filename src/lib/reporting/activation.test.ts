// Reporting activation guards:
//  1. the reporting routes reach the server-sealed Reporting Pack issuance ONLY through the sanctioned module and transport
//     (DEFECT-REPORTING-PACK-SEAL-RACE-001 repaired in 84cd8e0 / e698c3c; before that the routes could not reach it at all)
//     — checked over the full transitive import closure of the routed pages; the legacy helper and storage stay out;
//  2. reporting is offered per company by the server's answer, never to every customer;
//  3. the legacy statements workspace (which does import that path) stays unrouted and its gates stay off.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseReportingAccess } from "./access";
import { deriveWorkbenchNavigation, REPORTING_GROUPS, REPORTING_PAGES_SHIPPED, RELEASED_WORKBENCH_PAGES } from "@/lib/workbench/routes";
import type { NavItem } from "@/lib/workspace/navigation";

const ROOT = path.join(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function importClosure(entries: string[]): string[] {
  const exts = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];
  const resolve = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? path.join(ROOT, "src", spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const e of exts) { const f = base + e; if (fs.existsSync(f) && fs.statSync(f).isFile()) return f; }
    return null;
  };
  const seen = new Set<string>();
  const stack = entries.map((e) => path.join(ROOT, e));
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)) { const r = resolve(f, m[1]); if (r) stack.push(r); }
  }
  return [...seen].map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
}

describe("the reporting routes cannot reach the defective Reporting Pack sealing path", () => {
  const closure = importClosure(["src/pages/workspace/ReportingWorkbenchPage.tsx", "src/components/reporting/ReportingAccessGate.tsx"]);
  it("the closure is the reporting workbench (sanity: it is not empty and includes the pages)", () => {
    expect(closure.length).toBeGreaterThan(50);
    expect(closure).toContain("src/components/reporting/SignoffView.tsx");
    expect(closure).toContain("src/components/reporting/ExportsView.tsx");
  });
  // 20261112100000 (the reviewed reporting journey): DEFECT-REPORTING-PACK-SEAL-RACE-001 was repaired in 84cd8e0 (a failed
  // seal never removes the canonical object) and e698c3c (#156: issuance never deletes or overwrites a stored object; unit
  // regressions and 63/63 on real PostgreSQL). The reporting workbench now reaches the REPAIRED server-sealed issuance
  // through exactly one module (lib/reporting/reviewWorkflow.ts: issue_official_reporting_pack → the Edge Function's
  // issue / verify / retrieve) over exactly one transport (lib/reporting/supabaseDb.ts). The legacy commercial helper and
  // the legacy workspace stay out; nothing in the closure touches storage directly.
  const SANCTIONED: Readonly<Record<string, readonly string[]>> = {
    "src/lib/reporting/reviewWorkflow.ts": ["sealing path"],
    "src/lib/reporting/supabaseDb.ts": ["edge function invocation"],
  };
  it("no file of it imports the legacy Reporting Pack helper or touches storage; the repaired sealing path and the Edge Function are reached only from the two sanctioned modules", () => {
    const offenders: string[] = [];
    const sanctionedSeen: string[] = [];
    for (const rel of closure) {
      if (rel === "src/integrations/supabase/types.ts") continue; // generated type declarations, not calls
      const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
      for (const [re, what] of [
        [/reportingPackSeal|issueOfficialPack|seal-reporting-pack|seal_reporting_pack|prepare_official_reporting_pack/, "sealing path"],
        [/requestReportingPack|lib\/commercial\/reportingPack/, "legacy Reporting Pack helper"],
        [/functions\.invoke/, "edge function invocation"],
        [/\.storage\b/, "storage access"],
      ] as const) {
        if (!re.test(src)) continue;
        if (SANCTIONED[rel]?.includes(what)) { sanctionedSeen.push(`${rel}: ${what}`); continue; }
        offenders.push(`${rel}: ${what}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(sanctionedSeen.sort()).toEqual(["src/lib/reporting/reviewWorkflow.ts: sealing path", "src/lib/reporting/supabaseDb.ts: edge function invocation"]);
  });
  it("the sanctioned module never builds, uploads or hashes a pack itself: it names the server's issue RPC and the Edge Function's three actions, nothing else of the path", () => {
    const src = read("src/lib/reporting/reviewWorkflow.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
    expect(src).toMatch(/issue_official_reporting_pack/);
    expect(src).not.toMatch(/prepare_official_reporting_pack|seal_reporting_pack_server|reporting_pack_sealed_object|\.storage\b|upload\(/);
    expect([...src.matchAll(/action: "(issue|verify|retrieve)"/g)].map((m) => m[1]).sort()).toEqual(["issue", "retrieve", "verify"]);
  });
  it("the legacy statements workspace (which imports that path) is not routed, and its gates stay off", () => {
    const app = read("src/App.tsx");
    expect(app).not.toMatch(/StatementsWorkspace/);
    // (the legacy gate's name is not spelled here: workspaceGate.test.ts pins every file that names it)
    const legacyGate = ["FINANCIAL", "STATEMENTS", "WORKSPACE", "ENABLED"].join("_");
    expect(read("src/lib/financialStatementsWorkspace/workspaceGate.ts")).toMatch(new RegExp(`^export const ${legacyGate} = false;$`, "m"));
    expect(read("src/lib/financialStatementsWorkspace/persistenceGate.ts")).toMatch(/FINANCIAL_STATEMENT_PERSISTENCE_ENABLED = false;/);
  });
  it("the Reporting Pack service and the other restricted modules stay withheld; AI and two-year intake stay off", () => {
    const m = read("src/lib/workspace/moduleAvailability.ts");
    expect(m).toMatch(/export const UNPROVEN_MODULES_CUSTOMER_VISIBLE: boolean = false;/);
    expect(m).toMatch(/"close-certification", "reporting-pack", "close-insights"/);
    expect(read("src/lib/workbench/gate.ts")).toMatch(/WORKBENCH_NAVIGATION_ENABLED = true;/);
    const layoutAssist = fs.readdirSync(path.join(ROOT, "src"), { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f) && !/test/.test(f))
      .map((f) => read(`src/${f.split(path.sep).join("/")}`)).filter((t) => /export const (LAYOUT_ASSIST_ENABLED|TWO_PERIOD_INTAKE_ENABLED) =/.test(t));
    expect(layoutAssist.length).toBe(2);
    for (const t of layoutAssist) expect(t).toMatch(/export const (LAYOUT_ASSIST_ENABLED|TWO_PERIOD_INTAKE_ENABLED) = false;/);
  });
});

describe("reporting is offered per company by the server, never to every customer", () => {
  const items: NavItem[] = [
    { id: "overview", label: "Overview", href: "/w", disabled: false },
    { id: "prepare", label: "Prepare", href: "/w/prepare", disabled: false },
  ];
  it("the six pages are released and shipped together", () => {
    expect(REPORTING_PAGES_SHIPPED).toBe(true);
    for (const id of ["fs-statements", "fs-notes", "fs-schedules", "fs-comparatives", "signoff", "exports"] as const) expect(RELEASED_WORKBENCH_PAGES.has(id)).toBe(true);
  });
  it("the Close Review Findings route is guarded by the company's reporting access as well as the Prepare stage scope", () => {
    expect(read("src/App.tsx")).toMatch(/<Route path="close\/findings" element=\{<StageScopeGate stage="prepare"><ReportingAccessGate prepareStage>/);
  });
  it("without the server's 'enabled', the reporting groups are absent (Statements stays withheld from customers in general)", () => {
    const ids = deriveWorkbenchNavigation("/w", items).groups.map((g) => g.id);
    expect(ids.some((id) => REPORTING_GROUPS.has(id))).toBe(false);
    expect(ids).toEqual(["overview", "trial-balance"]);
  });
  it("with it, both reporting groups appear with their pages", () => {
    const m = deriveWorkbenchNavigation("/w", items, undefined, true);
    expect(m.groups.map((g) => g.id)).toEqual(["overview", "trial-balance", "close-review", "financial-statements", "signoff-exports"]);
    // Close Review ships Findings and Adjustments (the one adjustment path; the legacy browser-write panel is retired).
    expect(m.groups.find((g) => g.id === "close-review")!.pages.map((p) => p.id)).toEqual(["close-findings", "close-adjustments"]);
    expect(m.groups.find((g) => g.id === "signoff-exports")!.pages.map((p) => p.href)).toEqual(["/w/signoff", "/w/signoff/exports"]);
  });
  it("the server answer is read fail-closed: only an explicit enabled = true enables", () => {
    expect(parseReportingAccess({ enabled: true, role: "owner" })).toEqual({ state: "enabled", role: "owner" });
    for (const raw of [{ enabled: false, reason: "NOT_ALLOWLISTED" }, { enabled: "true" }, null, [], "enabled", { reason: "KILL_SWITCH" }]) {
      expect(parseReportingAccess(raw).state).toBe("disabled");
    }
    expect(parseReportingAccess({ enabled: false, reason: "KILL_SWITCH" })).toEqual({ state: "disabled", reason: "KILL_SWITCH" });
  });
});
