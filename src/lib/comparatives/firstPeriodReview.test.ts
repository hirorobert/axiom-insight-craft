// The first-period review's state mapping and calls (20261223100000): every server state the page can meet, unknown ones
// failing closed, separation of duties in what the page offers, and the RPCs called exactly as the migration declares them.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIM_OUTCOMES, DECISION_OUTCOMES, EVIDENCE_OUTCOMES, documentSha256, firstPeriodClient, firstPeriodFacts, outcomeWords, parseFirstPeriodStatus, reviewView, type Abilities, type SubjectStatus } from "./firstPeriodReview";
import { fpStatus, item, subject } from "./firstPeriodReviewFixture";
import { FIRST_PERIOD_NEXT_ACTIONS } from "@/lib/comparatives/firstPeriodNextActions";
import { blockerText } from "@/lib/reporting/blockers";

// INTEGRATION: the review's functions are installed by 20261217100000; the delta 20261223100000 replaces fs_decide_first_period (p_expected_binding) and
// fs_first_period_status. The delta is read FIRST so the first definition found for those two is the current one.
const SQL = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261223100000_first_period_review_page_read_model.sql"), "utf8")
  + readFileSync(resolve(__dirname, "../../../supabase/migrations/20261217100000_first_period_governed_review.sql"), "utf8");
const PREPARER: Abilities = { canPrepare: true, canApprove: false };
const APPROVER: Abilities = { canPrepare: false, canApprove: true };
const BOTH: Abilities = { canPrepare: true, canApprove: true };
const VIEWER: Abilities = { canPrepare: false, canApprove: false };
const fp = (o: Parameters<typeof subject>[1]) => subject("first_period", o) as unknown as SubjectStatus;
const ob = (o: Parameters<typeof subject>[1]) => subject("opening_balances", o) as unknown as SubjectStatus;

describe("parsing the server's read model", () => {
  it("a complete payload is evaluated; 'unavailable' is kept; anything else is unknown (never a default)", () => {
    expect(parseFirstPeriodStatus(fpStatus(subject("first_period", { items: [item("FIRST_PERIOD_FACTS_MISSING")] }))).state).toBe("evaluated");
    expect(parseFirstPeriodStatus({ state: "unavailable" })).toEqual({ state: "unavailable" });
    for (const bad of [null, {}, { state: "evaluated" }, { ...fpStatus(subject("first_period")), period: null }, { state: "approved" }, "verified"]) expect(parseFirstPeriodStatus(bad).state).toBe("unknown");
  });
  it("a legacy declaration that claimed to satisfy the requirement is not accepted as a read model at all", () => {
    const s = fpStatus(subject("first_period", { items: [item("FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED")] }), undefined, { legacy: true });
    expect(parseFirstPeriodStatus(s).state).toBe("evaluated");
    expect(parseFirstPeriodStatus({ ...s, legacyDeclaration: { ...s.legacyDeclaration, satisfiesRequirement: true } }).state).toBe("unknown");
  });
});

describe("every server state of the first-period subject", () => {
  it("not started: the preparer records the facts; a viewer is told who acts", () => {
    const s = fp({ items: [item("FIRST_PERIOD_FACTS_MISSING")] });
    expect(reviewView(s, "first_period", PREPARER)).toMatchObject({ kind: "not_started", primary: "record_facts", nextAction: FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_FACTS_MISSING });
    expect(reviewView(s, "first_period", VIEWER)).toMatchObject({ kind: "not_started", primary: null, note: "A preparer records the facts and the evidence." });
    expect(reviewView(s, "first_period", APPROVER).primary).toBeNull();
  });
  it("legacy declaration: an unverified claim that needs a governed review - never approved", () => {
    const v = reviewView(fp({ items: [item("FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED")] }), "first_period", BOTH);
    expect(v).toMatchObject({ kind: "legacy_claim", primary: "record_facts" });
    expect(v.title).toMatch(/unverified claim/);
    expect(v.nextAction).toMatch(/kept as a claim only/);
  });
  it("awaiting approval: a DIFFERENT approver reviews; the person who recorded it has no approve control, even holding the capability", () => {
    const other = fp({ items: [item("FIRST_PERIOD_REVIEW_PENDING")], claim: { recordedByYou: false } });
    const mine = fp({ items: [item("FIRST_PERIOD_REVIEW_PENDING")], claim: { recordedByYou: true } });
    expect(reviewView(other, "first_period", APPROVER)).toMatchObject({ kind: "awaiting_approval", primary: "review" });
    expect(reviewView(mine, "first_period", BOTH)).toMatchObject({ kind: "awaiting_approval", primary: null });
    expect(reviewView(mine, "first_period", BOTH).note).toMatch(/You recorded these facts, so you cannot approve them/);
    expect(reviewView(other, "first_period", PREPARER)).toMatchObject({ primary: null, note: expect.stringMatching(/Waiting for a partner or manager/) });
  });
  it("returned: the reviewer's not-verified decision sends it back to the preparer", () => {
    expect(reviewView(fp({ items: [item("FIRST_PERIOD_REVIEW_REFUSED")], claim: true, decision: "not_verified" }), "first_period", PREPARER)).toMatchObject({ kind: "returned", primary: "record_facts" });
    // A refusal without a not-verified decision behind it is not something the page can explain: cannot confirm.
    expect(reviewView(fp({ items: [item("FIRST_PERIOD_REVIEW_REFUSED")], claim: true, decision: null }), "first_period", PREPARER).kind).toBe("cannot_confirm");
  });
  it("approved: only 'verified' with a verified decision, no reasons and a claim", () => {
    expect(reviewView(fp({ state: "verified", claim: true, decision: "verified" }), "first_period", APPROVER)).toMatchObject({ kind: "approved", primary: null });
    expect(reviewView(fp({ state: "verified", claim: true, decision: null }), "first_period", APPROVER).kind).toBe("cannot_confirm");
    expect(reviewView(fp({ state: "verified", claim: false, decision: "verified" }), "first_period", APPROVER).kind).toBe("cannot_confirm");
    expect(reviewView(fp({ state: "verified", claim: true, decision: "verified", items: [item("FIRST_PERIOD_DECISION_STALE")] }), "first_period", APPROVER).kind).toBe("cannot_confirm");
  });
  it("stale: the server's named reason and ONE next action; a re-review by a different approver, or the preparer first when a fact no longer holds", () => {
    const stale = reviewView(fp({ items: [item("FIRST_PERIOD_DECISION_STALE")], claim: true, decision: "verified" }), "first_period", APPROVER);
    expect(stale).toMatchObject({ kind: "stale", primary: "review", nextAction: FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_DECISION_STALE, codes: ["FIRST_PERIOD_DECISION_STALE"] });
    const rules = reviewView(fp({ items: [item("FIRST_PERIOD_RULES_CHANGED")], claim: true, decision: "verified" }), "first_period", APPROVER);
    expect(rules).toMatchObject({ kind: "stale", nextAction: FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_RULES_CHANGED });
    const superseded = fp({ items: [item("FIRST_PERIOD_EVIDENCE_SUPERSEDED", "1"), item("FIRST_PERIOD_DECISION_STALE")], claim: true, decision: "verified" });
    expect(reviewView(superseded, "first_period", BOTH)).toMatchObject({ kind: "stale", primary: "record_facts", nextAction: FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_EVIDENCE_SUPERSEDED });
    expect(reviewView(superseded, "first_period", APPROVER).primary).toBeNull();
    const mineStale = fp({ items: [item("FIRST_PERIOD_DECISION_STALE")], claim: { recordedByYou: true }, decision: "verified" });
    expect(reviewView(mineStale, "first_period", BOTH).primary).toBeNull();
  });
  it("facts that break a rule: the preparer corrects them; the reason is the server's", () => {
    const v = reviewView(fp({ items: [item("FIRST_PERIOD_IDENTITY_EVIDENCE_MISSING"), item("FIRST_PERIOD_DATES_MISMATCH", "2026-02-03:2026-12-31")], claim: true }), "first_period", PREPARER);
    expect(v).toMatchObject({ kind: "needs_correction", primary: "record_facts", nextAction: FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_IDENTITY_EVIDENCE_MISSING });
  });
  it("not eligible (earlier books, a registration before the period, earlier statements): no action offered, the server's words", () => {
    for (const code of ["FIRST_PERIOD_EARLIER_BOOKS_EXIST", "FIRST_PERIOD_NOT_FIRST_ON_EVIDENCE", "FIRST_PERIOD_PRIOR_STATEMENTS_EXIST"]) {
      expect(reviewView(fp({ state: "not_eligible", items: [item(code)], claim: code !== "FIRST_PERIOD_EARLIER_BOOKS_EXIST" }), "first_period", BOTH)).toMatchObject({ kind: "not_applicable", primary: null, nextAction: FIRST_PERIOD_NEXT_ACTIONS[code] });
    }
  });
  it("period unknown: a prerequisite, with its own next action and no form", () => {
    expect(reviewView(fp({ items: [item("FIRST_PERIOD_PERIOD_UNKNOWN"), item("FIRST_PERIOD_IDENTITY_EVIDENCE_MISSING")], claim: true }), "first_period", BOTH)).toMatchObject({ kind: "prerequisite", primary: null, nextAction: FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_PERIOD_UNKNOWN });
  });
});

describe("fail closed: anything the page does not recognise is 'cannot confirm', never approved", () => {
  const cases: [string, SubjectStatus | null][] = [
    ["no subject", null],
    ["an unknown state", fp({ state: "approved", claim: true, decision: "verified" })],
    ["an unknown state with reasons", fp({ state: "draft", items: [item("FIRST_PERIOD_REVIEW_PENDING")], claim: true })],
    ["an unknown reason code", fp({ items: [{ code: "FIRST_PERIOD_SOMETHING_NEW", detail: null, nextAction: "Do something." }], claim: true })],
    ["a reason without its next action", fp({ items: [{ code: "FIRST_PERIOD_REVIEW_PENDING", detail: null, nextAction: null }], claim: true })],
    ["the other subject's reason", fp({ items: [item("OPENING_SUPPORT_MISSING")] })],
    ["pending with no reason", fp({ state: "pending", items: [], claim: true })],
    ["items and pending disagree", { ...fp({ items: [item("FIRST_PERIOD_REVIEW_PENDING")], claim: true }), pending: [] }],
    ["awaiting approval with no claim", fp({ items: [item("FIRST_PERIOD_REVIEW_PENDING")] })],
    ["facts missing yet a claim exists", fp({ items: [item("FIRST_PERIOD_FACTS_MISSING")], claim: true })],
    ["stale without a verified decision", fp({ items: [item("FIRST_PERIOD_DECISION_STALE")], claim: true, decision: "not_verified" })],
    ["a not-eligible opening subject", { ...ob({ state: "not_eligible", items: [item("OPENING_SUPPORT_MISSING")] }) }],
  ];
  for (const [name, s] of cases) {
    it(name, () => {
      const v = reviewView(s, s?.subject === "opening_balances" ? "opening_balances" : "first_period", BOTH);
      expect(v.kind).toBe("cannot_confirm");
      expect(v.primary).toBeNull();
    });
  }
  it("no pending server state, for any reason code, ever maps to approved", () => {
    for (const code of Object.keys(FIRST_PERIOD_NEXT_ACTIONS)) {
      const subj = code.startsWith("FIRST_PERIOD_") ? "first_period" : "opening_balances";
      for (const claim of [false, true]) for (const decision of [null, "verified", "not_verified"] as const) {
        const s = subject(subj, { items: [item(code)], claim, decision }) as unknown as SubjectStatus;
        expect(reviewView(s, subj, BOTH).kind).not.toBe("approved");
      }
    }
  });
});

describe("the opening-balance subject", () => {
  it("maps its own states", () => {
    expect(reviewView(ob({ items: [item("OPENING_SUPPORT_FIRST_PERIOD_FACTS_MISSING")] }), "opening_balances", PREPARER).kind).toBe("prerequisite");
    expect(reviewView(ob({ items: [item("OPENING_SUPPORT_MISSING")] }), "opening_balances", PREPARER)).toMatchObject({ kind: "not_started", primary: "record_facts" });
    expect(reviewView(ob({ items: [item("OPENING_SUPPORT_REVIEW_PENDING")], claim: true }), "opening_balances", APPROVER)).toMatchObject({ kind: "awaiting_approval", primary: "review" });
    expect(reviewView(ob({ items: [item("OPENING_SUPPORT_NOT_RECONCILED", "100000")], claim: true }), "opening_balances", PREPARER)).toMatchObject({ kind: "needs_correction", nextAction: FIRST_PERIOD_NEXT_ACTIONS.OPENING_SUPPORT_NOT_RECONCILED });
    expect(reviewView(ob({ items: [item("OPENING_SUPPORT_DECISION_STALE")], claim: true, decision: "verified" }), "opening_balances", APPROVER)).toMatchObject({ kind: "stale", primary: "review" });
    expect(reviewView(ob({ state: "verified", claim: true, decision: "verified" }), "opening_balances", APPROVER).kind).toBe("approved");
  });
});

describe("outcomes in plain words", () => {
  it("names the refusal; keeps each unmet rule's next action; never hides an unknown outcome", () => {
    expect(outcomeWords(DECISION_OUTCOMES, { outcome: "separate_approver_required" })).toMatch(/You recorded these facts, so you cannot approve them/);
    expect(outcomeWords(DECISION_OUTCOMES, { outcome: "changed_since_viewed" })).toMatch(/nothing was recorded/);
    expect(outcomeWords(DECISION_OUTCOMES, { outcome: "not_ready", pending: ["FIRST_PERIOD_IDENTITY_EVIDENCE_MISSING"] })).toContain(FIRST_PERIOD_NEXT_ACTIONS.FIRST_PERIOD_IDENTITY_EVIDENCE_MISSING);
    expect(outcomeWords(CLAIM_OUTCOMES, { outcome: "invalid_request", detail: "evidence_not_current" })).toMatch(/replaced or retracted/);
    expect(outcomeWords(CLAIM_OUTCOMES, { outcome: "invalid_request", detail: "legalName" })).toBe("The facts were refused; nothing was recorded. (legalName)");
    expect(outcomeWords(EVIDENCE_OUTCOMES, { outcome: "invalid_request", detail: "issued_on_in_future" })).toMatch(/cannot be in the future/);
    expect(outcomeWords(EVIDENCE_OUTCOMES, { outcome: "brand_new" })).toBe("The server answered: brand_new; nothing is assumed.");
  });
});

describe("the facts the page sends", () => {
  it("the reporting dates are always the server's; an empty TIN is omitted; dormancy dates only on the dormancy basis", () => {
    const base = { legalName: " Synthetic SME Limited ", registrationNumber: "CN-1", tin: " ", basis: "incorporated_in_period" as const, registrationDate: "2026-02-03", effectiveStart: "2026-02-03", priorStatementsPrepared: false, dormantFrom: "2019-01-01", dormantThrough: "2026-01-31" };
    const f = firstPeriodFacts(base, { reportingStart: "2026-02-03", reportingEnd: "2026-12-31" });
    expect(f).toEqual({ legalName: "Synthetic SME Limited", registrationNumber: "CN-1", basis: "incorporated_in_period", registrationDate: "2026-02-03", effectiveStart: "2026-02-03", reportingStart: "2026-02-03", reportingEnd: "2026-12-31", priorStatementsPrepared: false });
    expect(firstPeriodFacts({ ...base, tin: "123456789", basis: "commenced_after_dormancy" }, { reportingStart: "2026-01-01", reportingEnd: "2026-12-31" })).toMatchObject({ tin: "123456789", dormantFrom: "2019-01-01", dormantThrough: "2026-01-31" });
  });
  it("the document fingerprint is the SHA-256 of its bytes", async () => {
    expect(await documentSha256(new TextEncoder().encode("abc").buffer as ArrayBuffer)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("the calls are exactly the migration's functions, with exactly their parameters", () => {
  const params = (fn: string) => {
    const m = SQL.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(([^)]*)\\)`));
    if (!m) throw new Error(`${fn} not in the migration`);
    return m[1].split(",").map((x) => x.trim().split(/\s+/)[0]).sort();
  };
  it("each RPC the page makes names every parameter the function declares, and only those", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const c = firstPeriodClient({ rpc: async (fn, args) => { calls.push([fn, args]); return { data: fn === "fs_first_period_status" ? { state: "unavailable" } : { outcome: "recorded" }, error: null }; } });
    await c.status("c1", 2026);
    await c.recordEvidence("c1", 2026, { kind: "certificate_of_incorporation", reference: "Cert 1", issuedOn: "2026-02-03", assertedDate: "2026-02-03", documentSha256: "a".repeat(64), note: null, retract: false }, "r1");
    await c.submitClaim("c1", 2026, "first_period", {}, "x".repeat(20), ["e1"], "r2");
    await c.decide("c1", 2026, "first_period", true, "ok ok", "r3", "b".repeat(64));
    await c.withdraw("c1", 2026, "first_period", "ok ok", "r4");
    for (const [fn, args] of calls) expect(Object.keys(args).sort()).toEqual(params(fn));
    expect(calls.map(([fn]) => fn)).toEqual(["fs_first_period_status", "fs_record_first_period_evidence", "fs_submit_first_period_claim", "fs_decide_first_period", "fs_withdraw_first_period"]);
    expect(calls[3][1].p_expected_binding).toBe("b".repeat(64));
  });
  it("a failed status read is 'unknown' (cannot confirm), not an exception and not a default", async () => {
    expect(await firstPeriodClient({ rpc: async () => ({ data: null, error: { message: "function fs_first_period_status does not exist" } }) }).status("c1", 2026)).toMatchObject({ state: "unknown" });
    expect(await firstPeriodClient({ rpc: async () => { throw new Error("network"); } }).status("c1", 2026)).toMatchObject({ state: "unknown" });
  });
});

describe("the sign-off page's words for the same reasons", () => {
  it("each first-period and opening-balance reason reads as its one next action, never 'the server reports a blocker'; the missing comparative names the review", () => {
    for (const [code, words] of Object.entries(FIRST_PERIOD_NEXT_ACTIONS)) {
      expect(blockerText(code)).toBe(words);
      expect(blockerText(`${code}:1`)).toBe(words);
    }
    expect(blockerText("COMPARATIVE_PERIOD_MISSING")).toMatch(/first-period review on the Comparatives page/);
    expect(blockerText("COMPARATIVE_PERIOD_MISSING")).toMatch(/A declaration alone does not/);
  });
});
