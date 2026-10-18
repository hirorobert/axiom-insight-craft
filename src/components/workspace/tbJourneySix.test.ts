// @vitest-environment jsdom
/**
 * The six trial-balance journey issues, driven through real clicks and keys where they are interactive:
 *
 *  1. A finished (or already running) first upload opens THAT upload's result — the upload id travels in the URL —
 *     with its own history entry; refusals and failures stay on the card.
 *  2. An engagement's button names its actual next step and opens it, instead of a generic "Resume".
 *  3. A saved draft is a card with its filename, saved status and a prominent "Continue saved upload"; choosing another
 *     file is secondary.
 *  4. One searchable currency selector: typing shows the matches or "No currencies found"; only an explicit choice
 *     changes the value; nothing is defaulted.
 *  5. The workspace purpose is edited under "Company options", with its meaning, through the same owner-only authority.
 *  6. "Review account classifications" leads while classifications block completion; "File options" (replace, remove,
 *     upload history) is a separate, secondary disclosure.
 */
import { act, createElement, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { axeViolations, click, key, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { CurrencySelect } from "@/components/currency/CurrencySelect";
import { CURRENCY_SELECT_COPY, filterCurrencies, isoCurrencyOptions } from "@/lib/currency/currencyOptions";
import { ENGAGEMENT_ACTION_LABELS, engagementNextAction, firstUploadResultRoute } from "@/lib/workspace/engagementNextAction";
import { deriveWorkspaceState } from "@/lib/workspace/deriveWorkspaceState";
import { deriveTrialBalanceVerdict } from "@/lib/workspace/trialBalanceVerdict";
import { runStart, type StartDeps } from "@/lib/workspace/firstUpload";
import { reviewActionHierarchy } from "@/lib/workspace/reviewActionHierarchy";
import type { UploadSnapshot } from "@/lib/workspace/types";
import type { ActiveEngagementEntry } from "@/hooks/useActiveEngagements";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const ROOT = path.join(__dirname, "../../..");
const src = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.resetModules();
  for (const m of ["@/integrations/supabase/client", "@/lib/ensureFreshSession", "@/lib/workspace/firstUpload"]) vi.doUnmock(m);
  try { sessionStorage.clear(); } catch { /* */ }
});

const C = "c1";
const snap = (o: Partial<UploadSnapshot>): UploadSnapshot => ({
  id: "u1", companyId: C, companyName: "Synthetic Co", periodYear: 2025, status: "complete", isValid: true, safishaStatus: null,
  uploadedAt: "2026-10-01T00:00:00Z", processedAt: "2026-10-01T00:01:00Z", hasMapping: true, certificationVerdict: "certified", ...o,
});
const state = (o: Partial<UploadSnapshot> | null) => deriveWorkspaceState(C, "Synthetic Co", 2025, o === null ? null : snap(o));

// ── 1. The first upload opens that upload's result ──────────────────────────────────────────────────────────────────

describe("1. first upload → that exact upload's result", () => {
  it("the result route carries entity, period and upload id", () => {
    expect(firstUploadResultRoute("c1", 2025, "u9")).toBe("/workspace/c1/2025/prepare?upload=u9");
  });

  it("Dashboard opens it as its own history entry (Back returns home), and rows open their next step", () => {
    const dash = src("src/pages/Dashboard.tsx");
    expect(dash).toMatch(/onOpenTrialBalance: \(companyId, year, uploadId\) => navigate\(firstUploadResultRoute\(companyId, year, uploadId\)\),/);
    expect(dash).not.toMatch(/onOpenTrialBalance:[^\n]*replace: true/);
    expect(dash).toMatch(/navigate\(engagementNextAction\(entry\.workspaceState\)\.href\)/);
  });

  it("a check already running elsewhere is not a failure: the start reports it running, for that upload", async () => {
    const deps: StartDeps = {
      createEntity: async () => ({ kind: "created", companyId: "c1", replayed: false }),
      openPeriod: async () => ({ outcome: "opened", engagementId: "e1", periodId: "p1", priorPeriodId: null, periodYear: 2025, created: true, granted: [] }),
      commit: async () => ({ uploadId: "u9" }),
      check: async () => ({ kind: "wait" }),
    } as unknown as StartDeps;
    const r = await runStart(deps, { draftId: "d1", entity: { kind: "new", name: "Synthetic Co" }, period: { start: "2025-01-01", end: "2025-12-31", year: 2025, name: "Year ended 31 December 2025" }, currency: "TZS" },
      { entityRequestId: "a", commitKey: "b", checkRequestId: "c" }, {});
    expect(r).toMatchObject({ kind: "running", periodYear: 2025, progress: { companyId: "c1", uploadId: "u9" } });
  });

  async function mountFirstUpload(runStartImpl: () => Promise<unknown>) {
    const onOpenResult = vi.fn();
    sessionStorage.setItem("cfoclose:tb-draft-card:d1", JSON.stringify({ mode: "new", entityName: "Synthetic Co", existingId: "", period: { preset: "year", end: "2025-12-31", start: null }, currency: "TZS" }));
    const chain = (data: unknown) => { const c: Record<string, unknown> = {}; for (const k of ["select", "eq", "in", "order", "limit"]) c[k] = () => c; c.maybeSingle = async () => ({ data: { processing_result: null }, error: null }); c.then = (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res); return c; };
    vi.doMock("@/integrations/supabase/client", () => ({ supabase: {
      from: (t: string) => chain(t === "currency_registry" ? [{ code: "TZS", name: "Tanzanian shilling" }, { code: "USD", name: "US dollar" }] : []),
      rpc: async (n: string) => (n === "list_trial_balance_drafts" ? { data: [{ draft_id: "d1", file_name: "fy2025.csv", file_size: 2048, state: "reserved", stored: true }], error: null } : { data: null, error: null }),
    } }));
    vi.doMock("@/lib/ensureFreshSession", () => ({ ensureFreshSession: async () => undefined }));
    const runStartMock = vi.fn(runStartImpl);
    vi.doMock("@/lib/workspace/firstUpload", async (orig) => ({ ...(await orig<typeof import("@/lib/workspace/firstUpload")>()), runStart: runStartMock }));
    const { default: FirstUpload } = await import("./FirstUpload");
    mounted = mount(createElement(FirstUpload, { onChoosePlan: () => undefined, onOpenResult }));
    await flush(); await flush();
    return { onOpenResult, q: (id: string) => mounted!.container.querySelector<HTMLElement>(`[data-testid="${id}"]`) };
  }

  it("a finished check opens the result of that upload directly", async () => {
    const { onOpenResult, q } = await mountFirstUpload(async () => ({ kind: "checked", progress: { companyId: "c1", uploadId: "u9" }, periodYear: 2025 }));
    click(q("first-upload-continue-draft")!);
    await flush();
    click(q("first-upload-start")!);
    await flush(); await flush();
    expect(onOpenResult).toHaveBeenCalledWith("c1", 2025, "u9");
    expect(q("first-upload-open-result")?.textContent).toContain("View results");
  });

  it("a running check opens that upload to follow it; a refusal stays on the card, in words", async () => {
    let r = await mountFirstUpload(async () => ({ kind: "running", progress: { companyId: "c1", uploadId: "u9" }, periodYear: 2025 }));
    click(r.q("first-upload-continue-draft")!); await flush();
    click(r.q("first-upload-start")!); await flush(); await flush();
    expect(r.onOpenResult).toHaveBeenCalledWith("c1", 2025, "u9");
    expect(r.q("first-upload-open-result")?.textContent).toContain("View check progress");
    mounted!.unmount(); mounted = null; vi.resetModules();

    r = await mountFirstUpload(async () => ({ kind: "failed", step: "period", message: "This period already exists with a different reporting currency.", retryable: false, progress: {} }));
    click(r.q("first-upload-continue-draft")!); await flush();
    click(r.q("first-upload-start")!); await flush(); await flush();
    expect(r.onOpenResult).not.toHaveBeenCalled();
    expect(r.q("first-upload-failure")?.getAttribute("role")).toBe("alert");
    expect(r.q("first-upload-failure")?.textContent).toContain("different reporting currency");
  });

  // ── 3. Saved draft ────────────────────────────────────────────────────────────────────────────────────────────────
  it("3. a saved draft: filename, saved status and a prominent Continue; choosing another file is secondary", async () => {
    const { q } = await mountFirstUpload(async () => ({ kind: "checked", progress: { companyId: "c1", uploadId: "u9" }, periodYear: 2025 }));
    expect(q("first-upload-saved-name")?.textContent).toBe("fy2025.csv");
    expect(q("first-upload-saved-status")?.textContent).toMatch(/2 KB · Saved privately as a draft/);
    const cont = q("first-upload-continue-draft")!;
    expect(cont.textContent).toBe("Continue saved upload");
    expect(cont.className).toMatch(/bg-primary/);
    const another = q("first-upload-choose")!;
    expect(another.textContent).toContain("Choose another file");
    expect(another.className).not.toMatch(/bg-primary/);
    // The saved card comes before the dropzone in reading and Tab order.
    expect(cont.compareDocumentPosition(another) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    click(cont); await flush();
    expect(q("first-upload-confirm")).not.toBeNull();
    expect(q("confirm-currency")?.getAttribute("data-value")).toBe("TZS"); // what was entered before, restored — not inferred
  });
});

// ── 2. Engagement next action ───────────────────────────────────────────────────────────────────────────────────────

describe("2. an engagement's button names its next step", () => {
  it("each Prepare state → its own words and destination (same entity, period and upload)", () => {
    expect(engagementNextAction(state(null))).toEqual({ kind: "upload", label: "Upload trial balance", href: "/workspace/c1/2025/prepare" });
    expect(engagementNextAction(state({ status: "processing", isValid: null }))).toMatchObject({ label: "View check progress", href: "/workspace/c1/2025/prepare?upload=u1" });
    expect(engagementNextAction(state({ status: "needs_review", isValid: null, certificationVerdict: "review" }))).toMatchObject({ label: "Review account classifications", href: "/workspace/c1/2025/prepare?upload=u1&review=unresolved" });
    expect(engagementNextAction(state({ status: "error", isValid: false }))).toMatchObject({ kind: "correct", label: "See what to correct" });
    expect(engagementNextAction(state({}))).toMatchObject({ label: "View results", href: "/workspace/c1/2025/prepare?upload=u1" });
    expect(Object.values(ENGAGEMENT_ACTION_LABELS)).not.toContain("Resume");
  });

  it("a trial balance blocked by its checks opens with the file's options", () => {
    const blocked = state({ status: "blocked", isValid: false, certificationVerdict: "blocked", certificationBlocker: "Debits do not equal credits." });
    expect(blocked.missions.prepare.status).toBe("blocked");
    expect(engagementNextAction(blocked)).toEqual({ kind: "correct", label: "See what to correct", href: "/workspace/c1/2025/prepare?upload=u1&manage=source" });
  });

  const entry = (id: string, s: ReturnType<typeof state>, name = "Synthetic Co"): ActiveEngagementEntry => ({
    engagementId: id, companyId: s.companyId, companyName: name, periodYear: 2025, engagementType: "composite", framework: null,
    capabilities: ["FINANCIAL_STATEMENTS"], workspaceState: s, openedAt: "2026-10-01T00:00:00Z", periodStart: "2025-01-01", periodEnd: "2025-12-31", workspacePurpose: null,
  });

  async function hub(onSetPurpose = vi.fn(async () => "Recorded.")) {
    const { default: EngagementHub } = await import("@/pages/workspace/EngagementHub");
    const onResume = vi.fn();
    const entries = [entry("e1", state({ status: "needs_review", isValid: null, certificationVerdict: "review" })), entry("e2", deriveWorkspaceState("c2", "Other Co", 2025, null), "Other Co")];
    mounted = mount(createElement(MemoryRouter, null, createElement(EngagementHub, { entries, companiesWithoutEngagement: [], onResume, onStartService: () => undefined, onSetPurpose })));
    return { onResume, onSetPurpose, q: (sel: string) => mounted!.container.querySelector<HTMLElement>(sel) };
  }

  it("rows say the next step (with entity and year in the accessible name), never a bare Resume", async () => {
    const { onResume, q } = await hub();
    const row = q('[data-testid="resume-e1"]')!;
    expect(row.textContent).toContain("Review account classifications");
    expect(row.getAttribute("aria-label")).toBe("Review account classifications: Synthetic Co FY2025");
    expect(q('[data-testid="resume-e2"]')!.textContent).toContain("Upload trial balance");
    expect(mounted!.container.textContent).not.toMatch(/\bResume\b/);
    click(row);
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ engagementId: "e1" }));
  });

  // ── 5. Company options ──────────────────────────────────────────────────────────────────────────────────────────────
  it("5. the purpose is edited under Company options, explained, through the same owner-only callback", async () => {
    const { onSetPurpose, q } = await hub();
    expect(q('[data-testid="set-purpose-c1"]')).toBeNull(); // nothing inline in the heading any more
    const toggle = q('[data-testid="company-options-c1"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = q('[data-testid="company-options-panel-c1"]')!;
    expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.textContent).toMatch(/changes no accounting, records, access or billing/);
    expect(panel.textContent).toMatch(/Only the company's owner can record it, with a reason/);
    const form = q('[data-testid="set-purpose-c1"]') as HTMLFormElement;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true); // a reason is required
    typeInto(form.querySelector<HTMLInputElement>("input")!, "Training cohort");
    expect(submit.disabled).toBe(false);
    await act(async () => { form.requestSubmit(submit); });
    await flush();
    expect(onSetPurpose).toHaveBeenCalledWith("c1", "test", "Training cohort");
    expect(panel.querySelector('[role="status"]')?.textContent).toBe("Recorded.");
    expect(await axeViolations(panel)).toEqual([]);
  });
});

// ── 4. Currency selector ────────────────────────────────────────────────────────────────────────────────────────────

describe("4. one searchable currency selector", () => {
  const OPTIONS = [{ code: "KES", name: "Kenyan shilling" }, { code: "TZS", name: "Tanzanian shilling" }, { code: "USD", name: "US dollar" }];
  function Harness({ initial = "", onChange }: { initial?: string; onChange?: (c: string) => void }) {
    const [v, setV] = useState(initial);
    return createElement("div", null,
      createElement("label", { htmlFor: "cur" }, "Trial balance currency"),
      createElement(CurrencySelect, { id: "cur", value: v, onChange: (c: string) => { setV(c); onChange?.(c); }, options: OPTIONS, testId: "cur" }));
  }
  const parts = () => {
    const c = mounted!.container;
    return {
      input: c.querySelector<HTMLInputElement>("#cur")!,
      options: () => [...c.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent),
      none: () => c.querySelector('[data-testid="cur-none"]'),
      popupHidden: () => !c.querySelector('[data-testid="cur-popup"]'),
      status: () => c.querySelector('[role="status"]')!.textContent,
    };
  };

  it("is a labelled combobox; typing shows the matches visibly, or 'No currencies found'", async () => {
    mounted = mount(createElement(Harness));
    const p = parts();
    expect(p.input.getAttribute("role")).toBe("combobox");
    expect(p.input.labels?.[0]?.textContent).toBe("Trial balance currency");
    expect(p.input.value).toBe(""); // nothing defaulted
    expect(p.popupHidden()).toBe(true);
    typeInto(p.input, "shil");
    expect(p.popupHidden()).toBe(false);
    expect(p.input.getAttribute("aria-expanded")).toBe("true");
    expect(p.options()).toEqual(["KESKenyan shilling", "TZSTanzanian shilling"]);
    expect(p.status()).toBe("2 currencies found");
    typeInto(p.input, "zzz");
    expect(p.options()).toEqual([]);
    expect(p.none()?.textContent).toBe(CURRENCY_SELECT_COPY.none);
    expect(p.status()).toBe(CURRENCY_SELECT_COPY.none);
    expect(await axeViolations(mounted.container)).toEqual([]);
  });

  it("only an explicit choice changes the value: typing, Escape and leaving keep the previous choice", () => {
    const onChange = vi.fn();
    mounted = mount(createElement(Harness, { initial: "USD", onChange }));
    const p = parts();
    expect(p.input.value).toBe("USD · US dollar");
    typeInto(p.input, "TZS");
    key(p.input, "Escape");
    expect(onChange).not.toHaveBeenCalled();
    expect(p.input.value).toBe("USD · US dollar");
    typeInto(p.input, "KES");
    act(() => { p.input.dispatchEvent(new FocusEvent("blur")); p.input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(onChange).not.toHaveBeenCalled();
    expect(p.input.getAttribute("data-value")).toBe("USD");
  });

  it("keyboard: arrows move the highlight (aria-activedescendant), Enter chooses; a click chooses too", () => {
    const onChange = vi.fn();
    mounted = mount(createElement(Harness, { onChange }));
    const p = parts();
    key(p.input, "ArrowDown");
    expect(p.popupHidden()).toBe(false);
    key(p.input, "ArrowDown");
    const active = p.input.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(active)?.textContent).toContain("TZS");
    key(p.input, "Enter");
    expect(onChange).toHaveBeenLastCalledWith("TZS");
    expect(p.input.value).toBe("TZS · Tanzanian shilling");
    expect(p.popupHidden()).toBe(true);
    typeInto(p.input, "us");
    click(mounted.container.querySelector('[data-testid="cur-option-USD"]')!);
    expect(onChange).toHaveBeenLastCalledWith("USD");
  });

  it("pure helpers: match by code or name; ISO names where the runtime has them", () => {
    expect(filterCurrencies(OPTIONS, "dollar").map((o) => o.code)).toEqual(["USD"]);
    expect(filterCurrencies(OPTIONS, "").length).toBe(3);
    expect(isoCurrencyOptions(["TZS"])[0].code).toBe("TZS");
  });

  it("all three currency fields use it (first upload, Intake period, company form)", () => {
    for (const f of ["src/components/workspace/FirstUpload.tsx", "src/components/workbench/intake/PeriodSetup.tsx", "src/components/workspace/FirstRunEngagement.tsx"]) {
      expect(src(f)).toMatch(/<CurrencySelect\b/);
    }
    expect(src("src/components/workspace/FirstUpload.tsx")).not.toMatch(/Search currencies/);
  });
});

// ── 6. Review vs file options ───────────────────────────────────────────────────────────────────────────────────────

describe("6. Review account classifications leads; File options is separate and secondary", () => {
  // A real derived verdict, with the classification review as its open action.
  const layers = ["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"].map((id) => ({ id, label: "", state: "passed", detail: "" }));
  const verdict = {
    ...deriveTrialBalanceVerdict({ upload: { status: "needs_review", processing_result: {} }, readiness: { verdict: "review", blocker: null, checks: layers as never }, canRetry: true }),
    primaryAction: { kind: "review_classifications", label: "Resolve account classifications" },
  };
  async function card(props: Record<string, unknown> = {}) {
    const { CurrentTrialBalanceCard } = await import("./CurrentTrialBalanceCard");
    const onPrimary = vi.fn();
    const onShowHistory = vi.fn();
    mounted = mount(createElement(CurrentTrialBalanceCard, {
      fileName: "tb.csv", uploadedAt: "2026-10-18T10:00:00Z", fileSize: 2048, verdict: verdict as never, onPrimary,
      management: createElement("button", { type: "button", "data-testid": "replace" }, "Replace Trial Balance"),
      onShowHistory, historyCount: 2, ...props,
    }));
    const q = (id: string) => mounted!.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return { onPrimary, onShowHistory, q };
  }

  it("the review action says Review and leads; file actions are closed under File options until asked", async () => {
    const { onPrimary, onShowHistory, q } = await card();
    const primary = q("trial-balance-primary-action")!;
    expect(primary.textContent).toContain("Review account classifications");
    expect(primary.getAttribute("data-action-emphasis")).toBe("primary");
    const options = q("trial-balance-file-options")!;
    expect(options.className).not.toMatch(/bg-primary/);
    expect(options.getAttribute("aria-expanded")).toBe("false");
    expect(q("replace")).toBeNull();
    click(options);
    expect(options.getAttribute("aria-expanded")).toBe("true");
    expect(q("trial-balance-file-options-panel")!.id).toBe(options.getAttribute("aria-controls"));
    expect(q("replace")).not.toBeNull();
    click(q("trial-balance-show-history")!);
    expect(onShowHistory).toHaveBeenCalledTimes(1);
    click(primary);
    expect(onPrimary).toHaveBeenCalledWith("review_classifications");
  });

  it("asked to show the file's options (?manage=source), they are open on arrival", async () => {
    const { q } = await card({ fileOptionsOpen: true });
    expect(q("trial-balance-file-options")!.getAttribute("aria-expanded")).toBe("true");
    expect(q("replace")).not.toBeNull();
  });

  it("decisions made but not saved still block completion: Review keeps the lead", () => {
    expect(reviewActionHierarchy("review_classifications", "ready")).toEqual({ card: "primary", save: "secondary" });
    expect(reviewActionHierarchy("review_classifications", "failed")).toEqual({ card: "secondary", save: "primary" });
  });

  it("Upload history: a request opens, and focuses, the history section", async () => {
    const { UploadHistory } = await import("./UploadHistory");
    const uploads = [{ id: "u1", file_name: "a.csv", uploaded_at: "2026-10-01T00:00:00Z", status: "complete", lifecycle_state: "active_processed" }];
    mounted = mount(createElement(UploadHistory, { uploads: uploads as never, currentId: "u1", viewingId: "u1", onOpen: () => undefined, openRequest: 0 }));
    const section = mounted.container.querySelector('[data-testid="upload-history"]')!;
    expect(section.querySelector("ul")).toBeNull();
    mounted.rerender(createElement(UploadHistory, { uploads: uploads as never, currentId: "u1", viewingId: "u1", onOpen: () => undefined, openRequest: 1 }));
    expect(section.querySelector("ul")).not.toBeNull();
    expect(document.activeElement).toBe(section.querySelector("button"));
    expect(section.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("Prepare wires it: the card gets the history request and opens its options for ?manage=source", () => {
    const prep = src("src/pages/workspace/PrepareWorkspace.tsx");
    expect(prep).toMatch(/fileOptionsOpen=\{focusManage\}/);
    expect(prep).toMatch(/onShowHistory=\{rawUploads\.length > 0 \? \(\) => setHistoryRequest\(\(n\) => n \+ 1\) : undefined\}/);
    expect(prep).toMatch(/openRequest=\{historyRequest\}/);
  });
});

// ── DEFECT-UX-TB-OVERSIZE-REPLACEMENT-FEEDBACK-001 ──────────────────────────────────────────────────────────────────

describe("an over-limit replacement is refused visibly and persistently, next to Replace", () => {
  it("the card shows the refusal with role=alert, opens File options beside it, and it can be dismissed", async () => {
    const { CurrentTrialBalanceCard } = await import("./CurrentTrialBalanceCard");
    const { fileTooLarge } = await import("@/lib/workspace/uploadPolicy");
    const { validateReplacementFile } = await import("@/lib/workspace/trialBalanceManagement");
    const big = { name: "fy2027.csv", size: 12_000_039 };
    const refusal = `${validateReplacementFile(big)} The current Trial Balance was not changed.`;
    expect(validateReplacementFile(big)).toBe(fileTooLarge(big));
    expect(refusal).toContain("“fy2027.csv” is larger than 10 MB. Export only the trial balance (one sheet, no images) and upload it again.");
    const layers = ["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"].map((id) => ({ id, label: "", state: "passed", detail: "" }));
    const verdict = deriveTrialBalanceVerdict({ upload: { status: "complete", processing_result: {} }, readiness: { verdict: "certified", blocker: null, checks: layers as never }, canRetry: true });
    const onDismiss = vi.fn();
    const props = { fileName: "tb.csv", uploadedAt: "2026-10-18T10:00:00Z", fileSize: 2048, verdict, onPrimary: () => undefined,
      management: createElement("button", { type: "button", "data-testid": "replace" }, "Replace Trial Balance"), onDismissReplaceRefusal: onDismiss };
    mounted = mount(createElement(CurrentTrialBalanceCard, { ...props, replaceRefusal: null }));
    const q = (id: string) => mounted!.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    expect(q("trial-balance-replace-refusal")).toBeNull();
    mounted.rerender(createElement(CurrentTrialBalanceCard, { ...props, replaceRefusal: refusal }));
    const alert = q("trial-balance-replace-refusal")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("is larger than 10 MB");
    expect(q("trial-balance-file-options")!.getAttribute("aria-expanded")).toBe("true");
    expect(q("replace")).not.toBeNull(); // beside the Replace control
    click(q("trial-balance-replace-refusal-dismiss")!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    mounted.rerender(createElement(CurrentTrialBalanceCard, { ...props, replaceRefusal: null }));
    expect(q("trial-balance-replace-refusal")).toBeNull();
  });

  it("Prepare keeps the refusal (no transient toast), makes no upload call for it, and clears it when a valid file is picked", () => {
    const prep = src("src/pages/workspace/PrepareWorkspace.tsx");
    const handler = prep.slice(prep.indexOf("const handleReplacePicked"), prep.indexOf("setPendingFile(file);"));
    expect(handler).toMatch(/if \(invalid\) \{\n\s*setReplaceRefusal\(`\$\{invalid\} The current Trial Balance was not changed\.`\);\n\s*return;\n\s*\}/);
    expect(handler).not.toMatch(/toast/);
    expect(handler).not.toMatch(/retireAndProcess/);
    expect(handler).toMatch(/setReplaceRefusal\(null\);\s*$/);
    expect(prep).toMatch(/replaceRefusal=\{replaceRefusal\}/);
    expect(prep).toMatch(/onDismissReplaceRefusal=\{\(\) => setReplaceRefusal\(null\)\}/);
  });

  it("the first-upload path already refuses it persistently with role=alert, before storing anything", () => {
    const fu = src("src/components/workspace/FirstUpload.tsx");
    expect(fu).toMatch(/const invalid = validateFileChoice\(file\) \?\? fileTooLarge\(file\);\n\s*if \(invalid\) \{ setPhase\(\{ kind: "empty", error: invalid \}\); return; \}/);
    expect(fu).toMatch(/role="alert"[^>]*data-testid="first-upload-error"/);
  });
});
