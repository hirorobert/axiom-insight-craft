// @vitest-environment jsdom
// The first-period review on Financial Statements › Comparatives against a scripted server (20261223100000): what the
// preparer, a different approver, the person who recorded the facts and a viewer each see and may do; every write is one of
// the four RPCs; unknown server states fail closed. The real-database order of the same calls is proven by
// scripts/db-proof/firstPeriodGovernedReview.mjs (group UI) and the real application by scripts/e2e/localStackJourney.mjs.
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ReportingWorkbench } from "@/components/reporting/ReportingWorkbench";
import type { ReportingPage } from "@/components/reporting/shared";
import { composition } from "@/lib/statements/compositionFixture";
import { axeViolations, click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import type { ReportingDb } from "@/lib/reporting/signoff";
import { CERT, fpStatus, item, subject } from "@/lib/comparatives/firstPeriodReviewFixture";
import { FIRST_PERIOD_NEXT_ACTIONS } from "@/lib/comparatives/firstPeriodNextActions";

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; });

const H = (c: string) => c.repeat(64);
const NOTES = { state: "evaluated", contract: "fs-notes-status/2", packId: "ifrs-for-smes/2015", compositionSha256: H("b"), periodYear: 2026, blockers: [], statusSha256: H("c"), requirements: [] };
const CMP = (state: string) => ({ state: "evaluated", statusSha256: H("e"), comparative: { contract: "fs-comparatives-status/1", periodYear: 2026, state, composedComparativeState: state === "missing" ? "missing" : "available", required: true,
  firstPeriodDeclared: state === "first_period_exception", comparativeSha256: null, compositionSha256: H("b"), approval: null, blockers: state === "missing" ? ["COMPARATIVE_REQUIRED_MISSING"] : [] } });

type Call = { fn: string; args: Record<string, unknown> };
function server(status: () => unknown, writes: Record<string, (args: Record<string, unknown>) => unknown> = {}, cmp = "missing"): ReportingDb & { calls: Call[] } {
  const calls: Call[] = [];
  const reads: Record<string, (args: Record<string, unknown>) => unknown> = {
    fs_statement_composition: () => composition, fs_notes_status: () => NOTES, fs_comparatives_status: () => CMP(cmp), fs_list_saved_versions: () => [], fs_first_period_status: status, ...writes,
  };
  return {
    calls,
    rpc: async (fn, args) => { calls.push({ fn, args }); const f = reads[fn]; if (!f) return { data: null, error: { message: `unexpected ${fn}` } }; try { return { data: f(args), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } },
    select: async () => ({ data: [], error: null }),
  };
}
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async (db: ReportingDb, allowed: string[]) => {
  m = mount(h(MemoryRouter, {}, h(ReportingWorkbench, { page: "fs-comparatives" as ReportingPage, companyId: "c1", periodYear: 2026, legalName: "Synthetic SME Limited", db, allowed, reportVersion: null,
    hrefFor: (p: ReportingPage) => `/${p}` })));
  await settle();
};
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const panel = () => q('[data-testid="first-period-review"]')!;
const buttons = (root: Element = panel()) => [...root.querySelectorAll("button")].map((b) => b.textContent?.trim());
const WRITES = /fs_record_first_period_evidence|fs_submit_first_period_claim|fs_decide_first_period|fs_withdraw_first_period/;
const choose = (el: Element) => click(el);

describe("prepare: the preparer records the facts, cites recorded evidence and submits", () => {
  it("the server's dates are shown, not typed; evidence is chosen from the recorded revisions; the basis counter gates submission", async () => {
    let submitted: Record<string, unknown> | null = null;
    const db = server(() => fpStatus(subject("first_period", { items: [item("FIRST_PERIOD_FACTS_MISSING")] })), { fs_submit_first_period_claim: (a) => { submitted = a; return { outcome: "recorded", claimId: "x", state: "pending", pending: ["FIRST_PERIOD_REVIEW_PENDING"] }; } });
    await render(db, ["prepare_close"]);
    const block = q('[data-testid="fp-first_period"]')!;
    expect(block.getAttribute("data-state")).toBe("not_started");
    expect(q('[data-testid="fp-first_period-next"]')!.textContent).toBe(FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_FACTS_MISSING);
    expect(block.querySelectorAll('[data-testid$="-primary"]')).toHaveLength(1);
    click(q('[data-testid="fp-first_period-primary"]')!);
    await settle();
    const form = q('[data-testid="fp-first_period-form"]')!;
    expect(q('[data-testid="fp-server-dates"]')!.textContent).toContain("2026-02-03 to 2026-12-31");
    expect(form.querySelector('input[type="date"][value="2026-02-03"]')).toBeNull(); // reporting dates are never inputs
    // Evidence is a choice among recorded revisions (checkboxes), never a typed file name.
    const cite = form.querySelector('[data-testid="cite-evidence"]')!;
    expect(cite.textContent).toContain(CERT.reference);
    expect(cite.querySelectorAll('input[type="text"]')).toHaveLength(0);
    typeInto(form.querySelector<HTMLInputElement>('input[maxlength="60"]')!, "CN-2026-0042");
    const dates = form.querySelectorAll<HTMLInputElement>('input[type="date"]');
    typeInto(dates[0], "2026-02-03"); typeInto(dates[1], "2026-02-03");
    choose(cite.querySelector('input[type="checkbox"]')!);
    const basis = form.querySelector<HTMLTextAreaElement>("textarea")!;
    typeInto(basis, "Too short");
    await settle();
    expect(q('[data-testid="basis-count"]')!.textContent).toBe("9 / 1500 characters (at least 20)");
    expect(q<HTMLButtonElement>('[data-testid="fp-submit"]')!.disabled).toBe(true);
    typeInto(basis, "Incorporated on 3 February 2026; first period.");
    await settle();
    expect(q('[data-testid="basis-count"]')!.textContent).toBe("46 / 1500 characters");
    expect(q<HTMLButtonElement>('[data-testid="fp-submit"]')!.disabled).toBe(false);
    click(q('[data-testid="fp-submit"]')!);
    await settle();
    expect(submitted).toMatchObject({ p_company_id: "c1", p_period_year: 2026, p_subject: "first_period", p_evidence_ids: [CERT.id],
      p_facts: { legalName: "Synthetic SME Limited", tin: "123456789", reportingStart: "2026-02-03", reportingEnd: "2026-12-31", registrationNumber: "CN-2026-0042", basis: "incorporated_in_period" } });
    expect(document.body.textContent).toContain("A partner or manager other than you must now review the facts.");
    expect(db.calls.filter((c) => WRITES.test(c.fn)).map((c) => c.fn)).toEqual(["fs_submit_first_period_claim"]);
    expect(await axeViolations(document.body)).toEqual([]);
  }, 30000);
  it("a legacy declaration is shown as an unverified claim that needs a governed review - never as approved", async () => {
    await render(server(() => fpStatus(subject("first_period", { items: [item("FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED")] }), undefined, { legacy: true })), ["prepare_close"]);
    expect(q('[data-testid="fp-legacy"]')!.textContent).toMatch(/kept as an unverified claim\. It does not replace the comparatives\./);
    expect(q('[data-testid="fp-first_period"]')!.getAttribute("data-state")).toBe("legacy_claim");
    expect(q('[data-testid="fp-first_period-primary"]')!.textContent).toBe("Record the first-period facts");
    expect(document.querySelector('[data-state="approved"]')).toBeNull();
  }, 30000);
  it("no single-person declaration route remains on the page", async () => {
    await render(server(() => fpStatus(subject("first_period", { items: [item("FIRST_PERIOD_FACTS_MISSING")] }))), ["prepare_close", "approve_certification"]);
    expect(document.querySelector('[data-testid="open-first-period"], [data-testid="record-first-period"]')).toBeNull();
    expect(document.body.textContent).toContain("A declaration on its own never replaces them.");
  }, 30000);
});

describe("approve or return: a DIFFERENT person who holds the approval capability", () => {
  const pending = (recordedByYou: boolean) => fpStatus(subject("first_period", { items: [item("FIRST_PERIOD_REVIEW_PENDING")], claim: { recordedByYou } }));
  it("the approver sees exactly what is bound, decides with a reason, and the decision carries the binding shown", async () => {
    let decided: Record<string, unknown> | null = null;
    const db = server(() => pending(false), { fs_decide_first_period: (a) => { decided = a; return { outcome: "recorded", decisionId: "d", verified: true }; } });
    await render(db, ["approve_certification"]);
    expect(q('[data-testid="fp-first_period"]')!.getAttribute("data-state")).toBe("awaiting_approval");
    click(q('[data-testid="fp-first_period-primary"]')!);
    await settle();
    expect(q('[data-testid="bound-entity"]')!.textContent).toBe("Synthetic SME Limited");
    expect(q('[data-testid="bound-tin"]')!.textContent).toBe("123456789");
    expect(q('[data-testid="bound-period"]')!.textContent).toBe("2026-02-03 to 2026-12-31");
    expect(q('[data-testid="bound-rules"]')!.textContent).toBe("first-period-rules/1");
    expect(q('[data-testid="bound-cited"]')!.textContent).toContain(CERT.reference);
    expect(q('[data-testid="bound-cited"]')!.textContent).toContain("aaaaaaaaaaaa…");
    expect(q('[data-testid="bound-basis"]')!.textContent).toMatch(/Incorporated on 3 February 2026/);
    const form = q('[data-testid="fp-first_period-decide"]')!;
    const record = q<HTMLButtonElement>('[data-testid="fp-first_period-record-decision"]')!;
    expect(record.disabled).toBe(true);
    choose(form.querySelectorAll('input[type="radio"]')[0]);
    typeInto(form.querySelector("textarea")!, "Certificate agrees to the registration date.");
    await settle();
    expect(record.disabled).toBe(false);
    click(record);
    await settle();
    expect(decided).toMatchObject({ p_subject: "first_period", p_verify: true, p_reason: "Certificate agrees to the registration date.", p_expected_binding: H("b") });
    expect(await axeViolations(document.body)).toEqual([]);
  }, 30000);
  it("the person who recorded the facts has no approve control, even with the approval capability", async () => {
    const db = server(() => pending(true));
    await render(db, ["prepare_close", "approve_certification"]);
    expect(q('[data-testid="fp-first_period-primary"]')).toBeNull();
    expect(q('[data-testid="fp-first_period-decide"]')).toBeNull();
    expect(q('[data-testid="fp-first_period-note"]')!.textContent).toMatch(/You recorded these facts, so you cannot approve them/);
    expect(buttons().some((b) => /Review|Approve|Verify/.test(b ?? ""))).toBe(false);
  }, 30000);
  it("if the server refuses anyway (another tab recorded it), the refusal is shown in plain words and nothing is approved", async () => {
    const db = server(() => pending(false), { fs_decide_first_period: () => ({ outcome: "separate_approver_required" }) });
    await render(db, ["prepare_close", "approve_certification"]);
    click(q('[data-testid="fp-first_period-primary"]')!);
    await settle();
    const form = q('[data-testid="fp-first_period-decide"]')!;
    choose(form.querySelectorAll('input[type="radio"]')[0]);
    typeInto(form.querySelector("textarea")!, "Looks right to me.");
    await settle();
    click(q('[data-testid="fp-first_period-record-decision"]')!);
    await settle();
    expect(document.body.textContent).toContain("You recorded these facts, so you cannot approve them; nothing was recorded.");
    expect(q('[data-testid="fp-first_period"]')!.getAttribute("data-state")).toBe("awaiting_approval");
  }, 30000);
  it("a binding that moved after the page loaded is refused (changed_since_viewed) and the page reads again", async () => {
    let reads = 0;
    const db = server(() => { reads += 1; return pending(false); }, { fs_decide_first_period: () => ({ outcome: "changed_since_viewed" }) });
    await render(db, ["approve_certification"]);
    click(q('[data-testid="fp-first_period-primary"]')!);
    await settle();
    const form = q('[data-testid="fp-first_period-decide"]')!;
    choose(form.querySelectorAll('input[type="radio"]')[1]);
    typeInto(form.querySelector("textarea")!, "The certificate is unreadable.");
    await settle();
    const before = reads;
    click(q('[data-testid="fp-first_period-record-decision"]')!);
    await settle();
    expect(document.body.textContent).toContain("Something changed after this page was loaded");
    expect(reads).toBeGreaterThan(before);
  }, 30000);
  it("returned: the reviewer's reason is shown and the preparer re-submits", async () => {
    await render(server(() => fpStatus(subject("first_period", { items: [item("FIRST_PERIOD_REVIEW_REFUSED")], claim: true, decision: "not_verified" }))), ["prepare_close"]);
    expect(q('[data-testid="fp-first_period"]')!.getAttribute("data-state")).toBe("returned");
    expect(document.body.textContent).toContain("Reviewer's reason: Certificate agrees to the registration date.");
    expect(q('[data-testid="fp-first_period-primary"]')!.textContent).toBe("Correct and re-submit the facts");
  }, 30000);
});

describe("state: stale, approved, and the openings", () => {
  it("stale names the server's reason and its ONE next action; a different approver reviews again", async () => {
    await render(server(() => fpStatus(subject("first_period", { items: [item("FIRST_PERIOD_DECISION_STALE")], claim: true, decision: "verified" }))), ["approve_certification"]);
    expect(q('[data-testid="fp-first_period"]')!.getAttribute("data-state")).toBe("stale");
    expect(q('[data-testid="fp-first_period-next"]')!.textContent).toBe(FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_DECISION_STALE);
    expect(q('[data-testid="fp-first_period-primary"]')!.textContent).toBe("Review again");
    expect(panel().querySelectorAll('[data-testid$="-primary"]')).toHaveLength(1);
  }, 30000);
  it("approved (first-period exception in force): the openings appear as their own review", async () => {
    const s = fpStatus(subject("first_period", { claim: true, decision: "verified" }));
    await render(server(() => s, {}, "first_period_exception"), ["prepare_close"]);
    expect(q('[data-testid="fp-first_period"]')!.getAttribute("data-state")).toBe("approved");
    expect(q('[data-testid="fp-opening_balances"]')!.getAttribute("data-state")).toBe("not_started");
    expect(q('[data-testid="fp-opening_balances-primary"]')!.textContent).toBe("Record the opening-balance support");
    expect(await axeViolations(document.body)).toEqual([]);
  }, 30000);
});

describe("read-only for viewers; fail closed on anything unknown", () => {
  it("a viewer sees the state and the evidence but no control of any kind", async () => {
    const db = server(() => fpStatus(subject("first_period", { items: [item("FIRST_PERIOD_REVIEW_PENDING")], claim: true })));
    await render(db, []);
    expect(panel().querySelectorAll("button, input, textarea, select")).toHaveLength(0);
    expect(document.body.textContent).toContain(CERT.reference);
    expect(db.calls.filter((c) => WRITES.test(c.fn))).toEqual([]);
  }, 30000);
  it("an unknown server state is 'cannot confirm': no green state, no action", async () => {
    await render(server(() => fpStatus({ ...subject("first_period", { claim: true, decision: "verified" }), state: "approved_by_magic" })), ["prepare_close", "approve_certification"]);
    expect(q('[data-testid="fp-first_period"]')!.getAttribute("data-state")).toBe("cannot_confirm");
    expect(document.querySelector('[data-state="approved"]')).toBeNull();
    expect(q('[data-testid="fp-first_period-primary"]')).toBeNull();
  }, 30000);
  it("an unreadable answer, or a server without the review, is 'cannot confirm' too", async () => {
    for (const status of [() => ({ state: "evaluated" }), () => { throw new Error("function public.fs_first_period_status does not exist"); }]) {
      await render(server(status), ["prepare_close", "approve_certification"]);
      expect(q('[data-testid="fp-first_period"]')!.getAttribute("data-state")).toBe("cannot_confirm");
      expect(q('[data-testid="fp-first_period"]')!.textContent).toContain("Cannot confirm the first-period review");
      m?.unmount(); m = null; document.body.innerHTML = "";
    }
  }, 30000);
});
