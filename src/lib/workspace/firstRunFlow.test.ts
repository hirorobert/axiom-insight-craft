/**
 * First-run workflow regression suite. Pure state + in-memory ports (a fake of the database the ports talk to, with
 * RLS-style authorisation and a race-friendly async scheduler) + source contracts for the UI wiring.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_OUTCOMES, projectMandate, type EngagementCapability } from "./mandate";
import { deriveLaunchState, LAUNCH_COPY, requiresAccountingData } from "./onboardingState";
import { deriveWorkspaceNavigation } from "./navigation";
import { classifySetupError, getSetupState, openEngagementWithScope, recordDataStart, WorkspaceSetupError, type RpcClient } from "./workspaceSetupClient";
import { STAGE_SEQUENCE } from "./stageMetadata";
import type { MissionState, MissionStatus, WorkspaceMission } from "./types";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));


// ── 1–2, 6, 7: the state machine ─────────────────────────────────────────────────────────────────
describe("launch state machine — durable inputs only", () => {
  const FS: EngagementCapability[] = ["FINANCIAL_STATEMENTS"];

  it("no service in scope → the launchpad, whatever else is true", () => {
    expect(deriveLaunchState({ granted: null, hasUpload: false, dataStart: null })).toBe("LAUNCHPAD");
    expect(deriveLaunchState({ granted: [], hasUpload: true, dataStart: "empty" })).toBe("LAUNCHPAD");
  });

  it("a data-requiring service with no data choice → the one data question", () => {
    expect(deriveLaunchState({ granted: FS, hasUpload: false, dataStart: null })).toBe("DATA_CHOICE");
  });

  it("the two data choices resolve to DIFFERENT workflow states", () => {
    const imp = deriveLaunchState({ granted: FS, hasUpload: false, dataStart: "import" });
    const emp = deriveLaunchState({ granted: FS, hasUpload: false, dataStart: "empty" });
    expect(imp).toBe("IMPORT_PENDING");
    expect(emp).toBe("EMPTY_WORKSPACE");
    expect(imp).not.toBe(emp);
  });

  it("once data exists the question can never reappear, whichever choice was recorded", () => {
    for (const c of [null, "import", "empty"] as const) expect(deriveLaunchState({ granted: FS, hasUpload: true, dataStart: c })).toBe("ACTIVE");
  });

  it("every registered service needs data today (derived from the registry, not re-declared)", () => {
    for (const o of CAPABILITY_OUTCOMES) expect(requiresAccountingData(o.capability), o.capability).toBe(true);
  });

  it("the canonical copy is exactly the specified wording", () => {
    expect(LAUNCH_COPY).toEqual({
      launchpadHeading: "What would you like to complete?",
      dataChoiceHeading: "Add financial data",
      primaryAction: "Import trial balance",
      secondaryAction: "Start without data",
      emptyStateCta: "Import data",
      frameworkMissing: "Framework not selected",
      scopeEditor: "Manage services",
    });
  });
});

// ── the client is a thin, typed RPC layer: every rule lives in the database (proved in scripts/db-proof/setupAuthority.mjs) ──
type RpcCall = { fn: string; args: Record<string, unknown> };
const fakeRpc = (reply: (c: RpcCall) => { data?: unknown; error?: { code?: string; message?: string } | null }) => {
  const calls: RpcCall[] = [];
  const client: RpcClient = {
    async rpc(fn, args) {
      const c = { fn, args: args ?? {} };
      calls.push(c);
      const r = reply(c);
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return { client, calls };
};

describe("workspace setup client — server-authoritative, no client-side compensation", () => {
  it("opening an engagement is ONE transactional RPC carrying the scope (no client-side create/close/grant sequence)", async () => {
    const { client, calls } = fakeRpc(() => ({ data: { engagementId: "e1", periodId: "p1", created: true, granted: ["FINANCIAL_STATEMENTS"] } }));
    const out = await openEngagementWithScope(client, { companyId: "co-A", year: 2026, capabilities: ["FINANCIAL_STATEMENTS", "FINANCIAL_STATEMENTS"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("open_engagement_with_scope");
    expect(calls[0].args).toMatchObject({ p_company_id: "co-A", p_period_year: 2026, p_capabilities: ["FINANCIAL_STATEMENTS"] });
    expect(out).toEqual({ engagementId: "e1", periodId: "p1", created: true, granted: ["FINANCIAL_STATEMENTS"] });
  });

  it("the actor is never sent: identity is derived from the JWT inside the database", async () => {
    const { client, calls } = fakeRpc((c) => ({ data: c.fn === "get_engagement_setup_state" ? { dataStart: null, sequence: 0 } : { dataStart: "empty", changed: true, replay: false } }));
    await getSetupState(client, "e1");
    await recordDataStart(client, "e1", "empty", null);
    await openEngagementWithScope(fakeRpc(() => ({ data: { engagementId: "e", periodId: "p", created: false, granted: [] } })).client, { companyId: "c", year: 2026, capabilities: ["MONITORING"] });
    for (const c of calls) expect(Object.keys(c.args).join(",")).not.toMatch(/user|actor|member|auth/i);
  });

  it("the data choice is keyed by the ENGAGEMENT and carries the last-seen state for conflict detection", async () => {
    const { client, calls } = fakeRpc(() => ({ data: { dataStart: "import", changed: true, replay: false } }));
    const r = await recordDataStart(client, "eng-1", "import", null);
    expect(calls[0]).toEqual({ fn: "record_engagement_data_start", args: { p_engagement_id: "eng-1", p_choice: "import", p_expected_state: null } });
    expect(r).toEqual({ dataStart: "import", changed: true, replay: false });
  });

  it("a replay is reported as success, not as a change", async () => {
    const { client } = fakeRpc(() => ({ data: { dataStart: "empty", changed: false, replay: true } }));
    expect(await recordDataStart(client, "e", "empty", "empty")).toEqual({ dataStart: "empty", changed: false, replay: true });
  });

  it("server errors are classified explicitly (never swallowed, never inferred)", () => {
    expect(classifySetupError({ code: "42501", message: "x" }).kind).toBe("NOT_AUTHORISED");
    expect(classifySetupError({ code: "PT422", message: "JURISDICTION_REQUIRED: x" }).kind).toBe("JURISDICTION_REQUIRED");
    expect(classifySetupError({ code: "PT409", message: "CONFLICT: already import" }).kind).toBe("CONFLICT");
    expect(classifySetupError({ code: "PT409", message: "CONFLICT: already import" }).message).toBe("already import");
    expect(classifySetupError({ code: "22023", message: "INVALID: bad" }).kind).toBe("INVALID");
    expect(classifySetupError({ code: "P0002", message: "" }).kind).toBe("NOT_FOUND");
    expect(classifySetupError({ code: "XX000", message: "boom" }).kind).toBe("UNKNOWN");
    expect(classifySetupError(null).kind).toBe("UNKNOWN");
  });

  it("a rejected call surfaces as a WorkspaceSetupError with the mapped kind", async () => {
    const { client } = fakeRpc(() => ({ error: { code: "PT409", message: "CONFLICT: another member chose import" } }));
    const err = await recordDataStart(client, "e", "empty", null).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceSetupError);
    expect((err as WorkspaceSetupError).kind).toBe("CONFLICT");
  });

  it("the migration enforces the invariants the client relies on (one open engagement per period, append-only events, advisory lock)", () => {
    const sql = fs.readFileSync(path.resolve(ROOT, "../supabase/migrations/20260920100000_workspace_setup_authority.sql"), "utf8");
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]{0,60}uq_engagements_one_open_per_period[\s\S]{0,200}WHERE\s+status\s*=\s*'open'/i);
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('open_engagement:'/);
    expect(sql).toMatch(/engagement_setup_events/);
    expect(sql).toMatch(/auth\.uid\(\)/);
    expect(sql).not.toMatch(/GRANT[^;]*\bTO\s+(anon|public)\b/i);
  });
});


// ── 8, 9, 17: navigation ─────────────────────────────────────────────────────────────────────────
describe("navigation is generated from persisted scope", () => {
  const missions = (o: Partial<Record<WorkspaceMission, MissionStatus>> = {}) => {
    const out = {} as Record<WorkspaceMission, MissionState>;
    for (const s of STAGE_SEQUENCE) out[s] = { status: o[s] ?? "locked", label: s, summary: "", href: `/x/${s}` };
    return out;
  };
  const nav = (granted: EngagementCapability[] | null, o: Partial<Record<WorkspaceMission, MissionStatus>> = {}) => {
    const scopeDeclared = !!granted && granted.length > 0;
    return deriveWorkspaceNavigation({ basePath: "/w/c/2026", scopeDeclared, missionViews: projectMandate(missions(o), granted ? { engagementId: "e", granted } : null) });
  };
  const ids = (items: ReturnType<typeof nav>) => items.map((i) => i.id);

  it("with no scope, only the Overview is offered — no row of unexplained, unavailable modules", () => {
    expect(ids(nav(null))).toEqual(["overview"]);
    expect(ids(nav([]))).toEqual(["overview"]);
  });

  it("a statements-only scope lists Overview and only the statements workflow", () => {
    expect(ids(nav(["FINANCIAL_STATEMENTS"]))).toEqual(["overview", "prepare", "reconcile", "statements"]);
    for (const hidden of ["tax", "compliance", "filing", "monitor"]) expect(ids(nav(["FINANCIAL_STATEMENTS"]))).not.toContain(hidden);
  });

  it("amending the scope recomputes navigation deterministically", () => {
    const before = ids(nav(["FINANCIAL_STATEMENTS"]));
    const added = ids(nav(["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"]));
    expect(added).toEqual(["overview", "prepare", "reconcile", "statements", "tax"]);
    expect(added).toEqual(ids(nav(["TAX_COMPUTATION", "FINANCIAL_STATEMENTS"]))); // order of selection is irrelevant
    expect(before).not.toEqual(added);
    expect(ids(nav(["MONITORING"]))).toEqual(["overview", "prepare", "monitor"]); // prepare appears as input evidence only
    expect(nav(["MONITORING"]).find((i) => i.id === "prepare")!.inputEvidenceOnly).toBe(true);
  });

  it("a disabled stage appears only as a later dependency inside an active workflow, with its reason and the action that unlocks it", () => {
    const items = nav(["FINANCIAL_STATEMENTS"]);
    const locked = items.filter((i) => i.disabled);
    expect(locked.length).toBeGreaterThan(0);
    for (const i of locked) {
      expect(i.reason, i.id).toMatch(/locked/i);
      expect(i.action, i.id).toMatch(/complete/i);
    }
    for (const i of items.filter((x) => !x.disabled)) {
      expect(i.reason).toBeUndefined();
      expect(i.action).toBeUndefined();
    }
  });

  it("an existing workspace keeps its routes: with no declared scope, stages that already carry work stay reachable", () => {
    expect(ids(nav(null, { prepare: "passed", reconcile: "in_progress" }))).toEqual(["overview", "prepare", "reconcile"]);
    expect(ids(nav(null, { prepare: "locked" }))).toEqual(["overview"]);
  });
});

// ── 1, 4, 5, 16: UI wiring contracts ─────────────────────────────────────────────────────────────
describe("UI wiring contracts", () => {
  const overview = read("pages/workspace/WorkspaceOverview.tsx");
  const choice = read("components/workspace/DataChoiceCard.tsx");
  const launchpad = read("components/workspace/ServiceLaunchpad.tsx");
  const firstRun = read("components/workspace/FirstRunEngagement.tsx");
  const dashboard = read("pages/Dashboard.tsx");

  it("a new workspace routes straight to the Overview — there is no Step 2 interstitial anywhere", () => {
    expect(dashboard).toMatch(/navigate\(`\/workspace\/\$\{companyId\}\/\$\{year\}`, \{ replace: true \}\)/);
    const all = walk(ROOT).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(all).not.toMatch(/Step 2 of 2|Step 1 of 2/);
    expect(all).not.toMatch(/How would you like to begin/);
    expect(firstRun).not.toMatch(/Step \d of \d/);
  });

  it("no source anywhere uses skipDataStart or any URL/local flag as workflow truth", () => {
    const files = walk(ROOT).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
    for (const f of files) expect(fs.readFileSync(f, "utf8"), path.relative(ROOT, f)).not.toMatch(/skipDataStart/);
    expect(overview).not.toMatch(/useSearchParams|searchParams|localStorage|sessionStorage/);
    expect(overview).toMatch(/useDataStart\(engagement\?\.id \?\? null\)/);
  });

  it("the launchpad renders when no scope exists, from the canonical registry (no second catalogue)", () => {
    expect(overview).toMatch(/launchState === "LAUNCHPAD"[\s\S]{0,80}<ServiceLaunchpad/);
    expect(launchpad).toMatch(/CAPABILITY_OUTCOMES\.map/);
    expect(launchpad).not.toMatch(/Financial statements|Tax computation|Compliance review/); // no hard-coded card titles
  });

  it("Import trial balance persists the choice and reaches the single upload surface; Start without data persists and does NOT navigate", () => {
    expect(overview).toMatch(/dataStart\.record\("import"\)\) navigate\(`\$\{basePath\}\/prepare`\)/);
    const empty = overview.slice(overview.indexOf("onStartEmpty"), overview.indexOf("onStartEmpty") + 400);
    expect(empty).toMatch(/dataStart\.record\("empty"\)/);
    expect(empty).not.toMatch(/navigate|<Navigate|window\.location|\/prepare/);
    expect(choice).toContain("LAUNCH_COPY.primaryAction");
    expect(choice).toContain("LAUNCH_COPY.secondaryAction");
    expect(choice.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/navigate|Link|href/);
  });

  it("the empty workspace renders in place: 'Import data' is the one, non-blocking call to action", () => {
    expect(overview).toMatch(/launchState === "EMPTY_WORKSPACE"[\s\S]{0,700}LAUNCH_COPY\.emptyStateCta[\s\S]{0,400}tone: "muted"/);
  });

  it("exactly ONE trial-balance upload surface exists: the Prepare route", () => {
    const users = walk(ROOT).filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f) && /<TrialBalanceUpload\b/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    expect(users).toEqual(["pages/workspace/PrepareWorkspace.tsx"]);
    expect(overview).not.toMatch(/TrialBalanceUpload/);
  });

  it("a stage URL cannot bypass the launchpad: with no declared scope and no existing work the gate returns to the Overview", () => {
    const gate = read("components/workspace/StageScopeGate.tsx");
    expect(gate).toMatch(/!scopeDeclared && !hasWork[\s\S]{0,120}<Navigate to=\{`\/workspace\/\$\{companyId\}\/\$\{periodYear\}`\} replace \/>/);
  });

  it("the scope editor is called 'Manage services' and is the persistent way to add or amend services", () => {
    expect(overview).toMatch(/LAUNCH_COPY\.scopeEditor/);
    expect(read("components/workspace/EngagementScopeDialog.tsx")).toMatch(/LAUNCH_COPY\.scopeEditor/);
  });

  it("layouts stay usable at 375 px: one-column cards, full-width actions, no fixed widths", () => {
    expect(launchpad).toMatch(/grid gap-3 sm:grid-cols-2/);
    expect(launchpad).toMatch(/w-full sm:w-auto/);
    expect(choice).toMatch(/flex-col[\s\S]{0,40}sm:flex-row/);
    expect(choice).toMatch(/w-full sm:w-auto/);
    for (const src of [launchpad, choice]) expect(src).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/);
  });

  it("the workspace navigation is generated, not hard-coded from the full stage list", () => {
    const layout = read("pages/workspace/WorkspaceLayout.tsx");
    expect(layout).toMatch(/deriveWorkspaceNavigation\(/);
    expect(layout).not.toMatch(/STAGE_SEQUENCE/);
  });
});