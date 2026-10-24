/**
 * Ask CFOClose (Release 0.1) — cfoclose-assistant-response/2 (supabase/functions/_shared/assistantResponse.ts): binding to
 * the request context, only this request's facts and sources, no model-written figures, causes or authority wording —
 * checked on the ASSEMBLED text, so nothing passes by splitting it across parts or blocks — and an application-authored
 * limitation the model can neither write nor weaken. These rules narrow claims; they do not prove an answer correct.
 */
import { describe, expect, it } from "vitest";
import { buildEnvelope, envelopeDigest, type ContextEnvelope } from "../../../supabase/functions/_shared/assistantFacts";
import { LIMITATION_TEXT, LIMITS, parseModelJson, renderResponse, validateResponse } from "../../../supabase/functions/_shared/assistantResponse";
import { composition } from "@/lib/statements/compositionFixture";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const COMPANY = "99999999-9999-4999-8999-999999999999";
async function ctx(action: "explain_movement" | "draft_commentary" = "explain_movement", payload: unknown = composition) {
  const r = buildEnvelope(payload, { action, companyId: COMPANY, periodYear: 2026, lineId: "sfp.cash_and_cash_equivalents" });
  if (!r.ok) throw new Error(r.code);
  return { env: r.envelope as ContextEnvelope, digest: await envelopeDigest(r.envelope) };
}
const LINE = "line:sfp.cash_and_cash_equivalents";
const SCHEMA = "cfoclose-assistant-response/2";
const good = (digest: string): Json => ({
  schemaVersion: SCHEMA, contextDigest: digest,
  blocks: [
    { kind: "observation", parts: [{ text: "Cash and cash equivalents were " }, { factRef: "line.current" }, { text: " at the end of " }, { factRef: "period.current" },
      { text: ", compared with " }, { factRef: "line.comparative" }, { text: " a year earlier: " }, { factRef: "line.change" }, { text: " (" }, { factRef: "line.change_percent" }, { text: ")." }],
      sourceRefs: [LINE] },
    { kind: "next_step", parts: [{ text: "Compare the bank statements with the cash book for the year." }], sourceRefs: [] },
  ],
});
async function errorsOf(mut: (r: Json) => void, action: "explain_movement" | "draft_commentary" = "explain_movement") {
  const { env, digest } = await ctx(action);
  const r = good(digest);
  mut(r);
  const v = validateResponse(r, env, digest);
  return v.ok ? [] : v.errors;
}

describe("independently reproduced bypasses (regressions)", () => {
  it("a 'limitation' block written by the model is refused — the limitation is application-authored", async () => {
    const e = await errorsOf((r) => { r.blocks.push({ kind: "limitation", parts: [{ text: "Cash rose because customers paid faster." }], sourceRefs: [] }); });
    expect(e.join()).toMatch(/kind "limitation" is not permitted.*application writes the limitation itself/);
  });
  it("prohibited wording split across parts is caught on the assembled text", async () => {
    // Renders as "Cash rose by twelve percent because customers paid faster." — every part alone looks harmless.
    const e = await errorsOf((r) => { r.blocks[0].parts.push({ text: "Cash rose by twel" }, { text: "ve per" }, { text: "cent bec" }, { text: "ause customers paid faster." }); });
    expect(e.join()).toMatch(/quantity in words \("twelve"\)/);
    expect(e.join()).toMatch(/causal or speculative wording \("because"\)/);
  });
  it("a word split across two blocks is caught on the whole answer", async () => {
    const e = await errorsOf((r) => {
      r.blocks[0].parts.push({ text: " Customers paid faster, bec" });
      r.blocks[1].parts = [{ text: "ause of new terms check the receivables ledger." }];
    });
    expect(e.join()).toMatch(/the answer as a whole: causal or speculative wording \("because"\)/);
  });
  it("a missing block cannot carry a claim: causal words, available facts and no unavailable fact are all refused", async () => {
    const e = await errorsOf((r) => { r.blocks.push({ kind: "missing", parts: [{ text: "Cash rose because customers paid faster." }], sourceRefs: [] }); });
    expect(e.join()).toMatch(/causal/);
    expect(e.join()).toMatch(/must name at least one fact that is not available/);
  });
  it("zero-width and bidirectional characters cannot hide a word", async () => {
    expect((await errorsOf((r) => { r.blocks[1].parts = [{ text: "be\u200bcause" }]; })).join()).toMatch(/markup|control/);
    expect((await errorsOf((r) => { r.blocks[1].parts = [{ text: "\u202ebecause" }]; })).join()).toMatch(/markup|control/);
  });
});

describe("validation", () => {
  it("accepts a well-formed, fact-referenced explanation; figures render from fact records; the application's limitation is appended", async () => {
    const { env, digest } = await ctx();
    const v = validateResponse(good(digest), env, digest);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const a = renderResponse(v.response, env);
    expect(a.label).toBe("Explanation");
    expect(a.blocks[0].parts.map((p) => p.text).join("")).toBe(
      "Cash and cash equivalents were TZS 19,000.00 at the end of 2026, compared with TZS 12,800.00 a year earlier: an increase of TZS 6,200.00 (+48.4%).");
    expect(a.blocks[0]).toMatchObject({ author: "assistant", sources: [{ id: LINE, label: "Cash and cash equivalents" }] });
    expect(a.blocks.at(-1)).toEqual({ kind: "limitation", author: "application", parts: [{ kind: "text", text: LIMITATION_TEXT }], sources: [] });
    expect(a.draftText).toBeNull();
  });

  it("is bound to the request context and schema version", async () => {
    expect(await errorsOf((r) => { r.contextDigest = "0".repeat(64); })).toContain("contextDigest does not match the request context");
    expect((await errorsOf((r) => { r.schemaVersion = "cfoclose-assistant-response/1"; }))[0]).toMatch(/schemaVersion/);
    expect((await errorsOf((r) => { r.extra = 1; }))[0]).toMatch(/unexpected fields/);
  });

  it("rejects invented facts and citations", async () => {
    expect((await errorsOf((r) => { r.blocks[0].parts[1] = { factRef: "line.net_profit" }; })).join()).toMatch(/not a fact of this request/);
    expect((await errorsOf((r) => { r.blocks[0].sourceRefs = ["certification:00000000-0000-4000-8000-000000000000"]; })).join()).toMatch(/not in the evidence/);
    expect((await errorsOf((r) => { r.blocks[0].sourceRefs = []; })).join()).toMatch(/must name its sources/);
    expect((await errorsOf((r) => { r.blocks[0].parts = [{ text: "Cash moved." }]; })).join()).toMatch(/must cite at least one available fact/);
  });

  it("rejects any figure written by the model: digits, years, percentages and quantities in words", async () => {
    for (const t of ["Cash rose by 6,200.", "Cash rose in 2026.", "Cash rose 48%.", "Cash rose by twelve percent.", "Cash nearly doubled.",
      "Cash grew by six thousand.", "a threefold increase", "up two percentage points", "Cash rose ٣ times", "Cash rose by half."]) {
      const e = await errorsOf((r) => { r.blocks[1].parts = [{ text: t }]; });
      expect(e.join(), t).toMatch(/digit|quantity in words/);
    }
    expect(await errorsOf((r) => { r.blocks[1].parts = [{ text: "Often one useful check is to review the scaffold of the ledger." }]; })).toEqual([]);
  });

  it("rejects causal and speculative wording in every model block", async () => {
    for (const t of ["Cash rose because customers paid faster.", "Cash rose due to new sales.", "The increase likely relates to collections.",
      "Higher sales drove this.", "This was driven by financing.", "The increase is attributable to the loan.", "This may reflect timing.",
      "Since sales grew, cash rose.", "Following the loan, cash rose.", "Cash rose, suggesting growth.", "Cash therefore rose."]) {
      const e = await errorsOf((r) => { r.blocks[0].parts.push({ text: " " + t }); });
      expect(e.join(), t).toMatch(/causal or speculative/);
    }
  });

  it("rejects wording of approval, verification or correctness", async () => {
    for (const t of ["The figures are approved.", "The balance is verified.", "The statements are correct.", "This is accurate.", "Signed off by the partner.",
      "The audited figures", "These figures give a true and fair view.", "The ledger is reliable."]) {
      expect((await errorsOf((r) => { r.blocks[1].parts = [{ text: t }]; })).join(), t).toMatch(/approval, verification or correctness/);
    }
  });

  it("a fact that is not available can be named only in a missing block, which names only unavailable facts", async () => {
    const c = structuredClone(composition) as Json;
    c.comparative = { state: "missing", periodYear: null, certificationId: null, currency: null, bridgeIds: [], restatementIds: [] };
    for (const l of c.lines) l.comparative = null;
    const { env, digest } = await ctx("explain_movement", c);
    const r = good(digest);
    expect((validateResponse(r, env, digest) as Json).errors.join()).toMatch(/line.comparative is not available/);
    r.blocks[0].parts = [{ text: "Cash and cash equivalents were " }, { factRef: "line.current" }, { text: "." }];
    r.blocks.push({ kind: "missing", parts: [{ text: "The comparative is " }, { factRef: "line.comparative" }, { text: "." }], sourceRefs: [] });
    const v = validateResponse(r, env, digest);
    expect(v.ok).toBe(true);
    if (v.ok) expect(renderResponse(v.response, env).blocks[2].parts[1].text).toBe("not available (there is no prior-year trial balance)");
    r.blocks[2].parts.push({ factRef: "line.current" });
    expect((validateResponse(r, env, digest) as Json).errors.join()).toMatch(/cites only facts that are not available/);
  });

  it("no markup, links or control characters can enter through text", async () => {
    for (const t of ["<script>x</script>", "See [here](http://x.example)", "visit www.example.com", "use `code`", "javascript:x"]) {
      expect((await errorsOf((r) => { r.blocks[1].parts = [{ text: t }]; })).join(), t).toMatch(/markup/);
    }
  });

  it("enforces kinds per action and bounded sizes", async () => {
    expect((await errorsOf((r) => { r.blocks[1].kind = "draft"; })).join()).toMatch(/not permitted for explain_movement/);
    expect((await errorsOf((r) => { r.blocks[1].kind = "action"; })).join()).toMatch(/not permitted/);
    expect((await errorsOf((r) => { r.blocks = Array(LIMITS.blocks + 1).fill(r.blocks[1]); })).join()).toMatch(/blocks must be a list/);
    expect((await errorsOf((r) => { r.blocks.push(r.blocks[1], r.blocks[1]); })).join()).toMatch(/at most 2 next-step blocks/);
    expect((await errorsOf((r) => { r.blocks[1].parts = [{ text: "a".repeat(LIMITS.textPart + 1) }]; })).join()).toMatch(/1 to 400 characters/);
    expect((await errorsOf((r) => { r.blocks[1].parts.push({ factRef: "line.current" }); })).join()).toMatch(/next step cites no figures/);
    expect((await errorsOf((r) => { r.blocks[1].navigate = "/workspace"; })).join()).toMatch(/unexpected fields/);
  });

  it("drafts: draft blocks required, labelled as an unreviewed draft, one editable text; the limitation stays outside the draft", async () => {
    const { env, digest } = await ctx("draft_commentary");
    const r: Json = { schemaVersion: SCHEMA, contextDigest: digest, blocks: [
      { kind: "draft", parts: [{ text: "Cash and cash equivalents increased to " }, { factRef: "line.current" }, { text: " at the end of " }, { factRef: "period.current" }, { text: "." }], sourceRefs: [LINE] },
    ] };
    const v = validateResponse(r, env, digest);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const a = renderResponse(v.response, env);
    expect(a.label).toBe("Draft — not reviewed");
    expect(a.draftText).toBe("Cash and cash equivalents increased to TZS 19,000.00 at the end of 2026.");
    expect(a.blocks.at(-1)?.author).toBe("application");
    expect((validateResponse({ ...r, blocks: [{ kind: "missing", parts: [{ text: "x" }], sourceRefs: [] }] }, env, digest) as Json).errors.join()).toMatch(/at least one draft block/);
    expect((validateResponse({ ...r, blocks: [{ ...r.blocks[0], parts: [...r.blocks[0].parts, { text: " Strong trading drove it." }] }] }, env, digest) as Json).errors.join()).toMatch(/causal/);
  });

  it("parses only one JSON object (a ```json fence tolerated)", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Here you go: {"a":1}')).toBeUndefined();
    expect(parseModelJson("{not json}")).toBeUndefined();
  });
});
