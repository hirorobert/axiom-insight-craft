/**
 * First-run workflow regression suite. Pure state + in-memory ports (a fake of the database the ports talk to, with
 * RLS-style authorisation and a race-friendly async scheduler) + source contracts for the UI wiring.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_OUTCOMES, projectMandate, type EngagementCapability } from "./mandate";
import { deriveLaunchState, DATA_START_STEP, dataStartChoiceFromStep, LAUNCH_COPY, requiresAccountingData } from "./onboardingState";
import { deriveWorkspaceNavigation } from "./navigation";
import { EngagementSetupError, openEngagementWithScope, type EngagementPort } from "./engagementSetup";
import { readDataStart, recordDataStart, type DataStartPort } from "./dataStartStore";
import { STAGE_SEQUENCE } from "./stageMetadata";
import type { MissionState, MissionStatus, WorkspaceMission } from "./types";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// ── an in-memory database with the constraints the real one enforces ─────────────────────────────
class FakeDb {
  members = new Map<string, string>(); // `${company}|${user}` → role
  periods: { id: string; company: string; year: number; created_at: string }[] = [];
  engagements: { id: string; period: string; company: string; status: "open" | "closed"; opened_at: string }[] = [];
  grants = new Map<string, Set<EngagementCapability>>();
  onboarding = new Map<string, string>(); // `${user}|${company}|${year}` → step
  private clock = 0;
  private seq = 0;
  now = () => `2026-09-19T10:00:${String(++this.clock).padStart(2, "0")}.000Z`;
  id = (p: string) => `${p}-${++this.seq}`;
  upserts = 0;
}
const tick = (n = 0) => new Promise<void>((r) => setTimeout(r, n));

function enginePort(db: FakeDb, user: string, jitter = 0): EngagementPort {
  return {
    async memberOf(company) {
      await tick(jitter);
      const role = db.members.get(`${company}|${user}`);
      return role ? { id: `m-${user}`, role } : null;
    },
    async periodsFor(company, year) {
      await tick(jitter);
      return db.periods.filter((p) => p.company === company && p.year === year).map((p) => ({ id: p.id, created_at: p.created_at }));
    },
    async createPeriod(company, year) {
      await tick(jitter);
      const row = { id: db.id("period"), company, year, created_at: db.now() };
      db.periods.push(row); // no uniqueness: a race may create two, exactly like the real table
      return { id: row.id };
    },
    async openEngagements(period) {
      await tick(jitter);
      return db.engagements.filter((e) => e.period === period && e.status === "open").map((e) => ({ id: e.id, opened_at: e.opened_at }));
    },
    async createEngagement(period, company) {
      await tick(jitter);
      const row = { id: db.id("eng"), period, company, status: "open" as const, opened_at: db.now() };
      db.engagements.push(row);
      return { id: row.id };
    },
    async closeEngagement(id) {
      await tick(jitter);
      const e = db.engagements.find((x) => x.id === id);
      if (e) e.status = "closed";
    },
    async granted(id) {
      await tick(jitter);
      return [...(db.grants.get(id) ?? [])];
    },
    async grant(id, cap) {
      await tick(jitter);
      const set = db.grants.get(id) ?? new Set<EngagementCapability>();
      if (set.has(cap)) throw Object.assign(new Error(`Capability ${cap} is already part of this engagement.`), { code: "23001" });
      set.add(cap);
      db.grants.set(id, set);
    },
  };
}

function dataPort(db: FakeDb, user: string): DataStartPort {
  return {
    async read(company, year) {
      return db.onboarding.get(`${user}|${company}|${year}`) ?? null;
    },
    async upsert(company, year, step) {
      db.upserts++;
      db.onboarding.set(`${user}|${company}|${year}`, step); // UNIQUE(user, company, year): an upsert can only ever leave one row
    },
  };
}

const seeded = () => {
  const db = new FakeDb();
  db.members.set("co-A|owner", "owner");
  db.members.set("co-A|partner", "partner");
  db.members.set("co-A|preparer", "preparer");
  db.members.set("co-A|viewer", "viewer");
  db.members.set("co-B|owner", "owner");
  return db;
};

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

  it("the two data choices resolve to DIFFERENT persisted states and DIFFERENT workflow states", () => {
    expect(DATA_START_STEP.import).not.toBe(DATA_START_STEP.empty);
    const imp = deriveLaunchState({ granted: FS, hasUpload: false, dataStart: "import" });
    const emp = deriveLaunchState({ granted: FS, hasUpload: false, dataStart: "empty" });
    expect(imp).toBe("IMPORT_PENDING");
    expect(emp).toBe("EMPTY_WORKSPACE");
    expect(imp).not.toBe(emp);
    expect(dataStartChoiceFromStep(DATA_START_STEP.import)).toBe("import");
    expect(dataStartChoiceFromStep(DATA_START_STEP.empty)).toBe("empty");
    expect(dataStartChoiceFromStep("upload")).toBeNull(); // a legacy step id never counts as a decision
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

// ── 3, 14, 15, 16: engagement setup ──────────────────────────────────────────────────────────────
describe("engagement setup — idempotent, convergent, authorised", () => {
  it("a selection persists: a fresh session (new port, same database) sees the same engagement and services", async () => {
    const db = seeded();
    const first = await openEngagementWithScope(enginePort(db, "owner"), { companyId: "co-A", year: 2026, capabilities: ["FINANCIAL_STATEMENTS", "MONITORING"] });
    const second = await openEngagementWithScope(enginePort(db, "partner"), { companyId: "co-A", year: 2026, capabilities: [] as never }).catch(() => null);
    expect(second).toBeNull(); // an empty selection is refused, never treated as "keep as is"
    const session2 = enginePort(db, "owner");
    const again = await openEngagementWithScope(session2, { companyId: "co-A", year: 2026, capabilities: ["FINANCIAL_STATEMENTS"] });
    expect(again.engagementId).toBe(first.engagementId);
    expect([...again.granted].sort()).toEqual(["FINANCIAL_STATEMENTS", "MONITORING"]);
  });

  it("repeated clicks create ONE engagement, ONE period and ONE grant per service", async () => {
    const db = seeded();
    const results: string[] = [];
    for (let i = 0; i < 6; i++) results.push((await openEngagementWithScope(enginePort(db, "owner"), { companyId: "co-A", year: 2026, capabilities: ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"] })).engagementId);
    expect(new Set(results).size).toBe(1);
    expect(db.engagements.filter((e) => e.status === "open")).toHaveLength(1);
    expect(db.periods).toHaveLength(1);
    expect([...db.grants.get(results[0])!].sort()).toEqual(["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"]);
  });

  it("CONCURRENT setup requests (different interleavings) converge on one open engagement and one grant per service", async () => {
    for (const jitters of [[0, 0], [1, 6], [6, 1], [3, 3], [0, 9]]) {
      const db = seeded();
      const out = await Promise.all(jitters.map((j, i) => openEngagementWithScope(enginePort(db, i % 2 ? "partner" : "owner", j), { companyId: "co-A", year: 2026, capabilities: ["FINANCIAL_STATEMENTS", "COMPLIANCE_REVIEW"] })));
      const open = db.engagements.filter((e) => e.status === "open");
      expect(open, `jitter ${jitters}`).toHaveLength(1);
      expect(new Set(out.map((o) => o.engagementId)), `jitter ${jitters}`).toEqual(new Set([open[0].id]));
      expect([...db.grants.get(open[0].id)!].sort()).toEqual(["COMPLIANCE_REVIEW", "FINANCIAL_STATEMENTS"]);
    }
  });

  it("a request that loses the race closes its own engagement and never leaves a second open one", async () => {
    const db = seeded();
    await Promise.all([openEngagementWithScope(enginePort(db, "owner", 0), { companyId: "co-A", year: 2026, capabilities: ["MONITORING"] }), openEngagementWithScope(enginePort(db, "owner", 2), { companyId: "co-A", year: 2026, capabilities: ["MONITORING"] })]);
    expect(db.engagements.filter((e) => e.status === "open")).toHaveLength(1);
    expect(db.engagements.every((e) => e.status === "open" || !db.grants.has(e.id))).toBe(true); // no grant on a closed loser
  });

  it("separate companies (and separate years) keep independent state", async () => {
    const db = seeded();
    const a = await openEngagementWithScope(enginePort(db, "owner"), { companyId: "co-A", year: 2026, capabilities: ["FINANCIAL_STATEMENTS"] });
    const b = await openEngagementWithScope(enginePort(db, "owner"), { companyId: "co-B", year: 2026, capabilities: ["TAX_COMPUTATION"] });
    const a2025 = await openEngagementWithScope(enginePort(db, "owner"), { companyId: "co-A", year: 2025, capabilities: ["MONITORING"] });
    expect(new Set([a.engagementId, b.engagementId, a2025.engagementId]).size).toBe(3);
    expect([...db.grants.get(a.engagementId)!]).toEqual(["FINANCIAL_STATEMENTS"]);
    expect([...db.grants.get(b.engagementId)!]).toEqual(["TAX_COMPUTATION"]);
    expect([...db.grants.get(a2025.engagementId)!]).toEqual(["MONITORING"]);
  });

  it("unauthorised callers cannot open or amend scope and nothing is created", async () => {
    const db = seeded();
    for (const [user, kind] of [["preparer", "NOT_AUTHORISED"], ["viewer", "NOT_AUTHORISED"], ["stranger", "NOT_A_MEMBER"]] as const) {
      const err = await openEngagementWithScope(enginePort(db, user), { companyId: "co-A", year: 2026, capabilities: ["FINANCIAL_STATEMENTS"] }).catch((e) => e);
      expect(err).toBeInstanceOf(EngagementSetupError);
      expect((err as EngagementSetupError).kind).toBe(kind);
    }
    // another company's owner cannot act on co-A either
    const cross = await openEngagementWithScope(enginePort(db, "owner"), { companyId: "co-Z", year: 2026, capabilities: ["FINANCIAL_STATEMENTS"] }).catch((e) => e);
    expect((cross as EngagementSetupError).kind).toBe("NOT_A_MEMBER");
    expect(db.engagements).toHaveLength(0);
    expect(db.periods).toHaveLength(0);
  });

  it("an amendment adds only what is missing (an 'already part of this engagement' refusal is success, not an error)", async () => {
    const db = seeded();
    const first = await openEngagementWithScope(enginePort(db, "owner"), { companyId: "co-A", year: 2026, capabilities: ["FINANCIAL_STATEMENTS"] });
    const more = await openEngagementWithScope(enginePort(db, "owner"), { companyId: "co-A", year: 2026, capabilities: ["FINANCIAL_STATEMENTS", "FILING_PREPARATION"] });
    expect(more.engagementId).toBe(first.engagementId);
    expect([...more.granted].sort()).toEqual(["FILING_PREPARATION", "FINANCIAL_STATEMENTS"]);
  });
});

// ── 5, 7, 14, 15: the data choice is durable and idempotent ─────────────────────────────────────
describe("data-start persistence", () => {
  it("'Start without data' is durable: a refresh or fresh session reads it back and the question never reappears", async () => {
    const db = seeded();
    expect(await readDataStart(dataPort(db, "owner"), "co-A", 2026)).toBeNull();
    await recordDataStart(dataPort(db, "owner"), "co-A", 2026, "empty");
    for (let refresh = 0; refresh < 3; refresh++) {
      const choice = await readDataStart(dataPort(db, "owner"), "co-A", 2026);
      expect(choice).toBe("empty");
      expect(deriveLaunchState({ granted: ["FINANCIAL_STATEMENTS"], hasUpload: false, dataStart: choice })).toBe("EMPTY_WORKSPACE");
    }
  });

  it("recording the same choice repeatedly (double clicks) writes once", async () => {
    const db = seeded();
    await Promise.all([1, 2, 3].map(() => recordDataStart(dataPort(db, "owner"), "co-A", 2026, "import")));
    await recordDataStart(dataPort(db, "owner"), "co-A", 2026, "import");
    expect(db.onboarding.size).toBe(1);
    expect(db.upserts).toBeLessThanOrEqual(3); // concurrent first clicks may each upsert; the UNIQUE key leaves one row
    expect(await readDataStart(dataPort(db, "owner"), "co-A", 2026)).toBe("import");
  });

  it("the choice is per company and year: one workspace's decision never affects another", async () => {
    const db = seeded();
    await recordDataStart(dataPort(db, "owner"), "co-A", 2026, "empty");
    expect(await readDataStart(dataPort(db, "owner"), "co-B", 2026)).toBeNull();
    expect(await readDataStart(dataPort(db, "owner"), "co-A", 2025)).toBeNull();
    expect(await readDataStart(dataPort(db, "partner"), "co-A", 2026)).toBeNull(); // per user: RLS keeps another member's row private
  });

  it("the two choices persist as different rows of state", async () => {
    const db = seeded();
    await recordDataStart(dataPort(db, "owner"), "co-A", 2026, "import");
    await recordDataStart(dataPort(db, "owner"), "co-B", 2026, "empty");
    expect(db.onboarding.get("owner|co-A|2026")).toBe(DATA_START_STEP.import);
    expect(db.onboarding.get("owner|co-B|2026")).toBe(DATA_START_STEP.empty);
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
    expect(overview).toMatch(/useDataStart\(companyId, periodYear\)/);
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
    expect(overview).toMatch(/launchState === "EMPTY_WORKSPACE"[\s\S]{0,700}LAUNCH_COPY\.emptyStateCta[\s\S]{0,120}tone: "muted"/);
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
