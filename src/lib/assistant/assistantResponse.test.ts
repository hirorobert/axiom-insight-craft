/**
 * Ask CFOClose (Release 0.1) — cfoclose-assistant-response/1 (supabase/functions/_shared/assistantResponse.ts): binding to
 * the request context, only this request's facts and sources, no model-written figures, no unsupported causal wording,
 * no markup; every rendered figure comes from its fact record.
 */
import { describe, expect, it } from "vitest";
import { buildEnvelope, envelopeDigest, type ContextEnvelope } from "../../../supabase/functions/_shared/assistantFacts";
import { LIMITS, parseModelJson, renderResponse, validateResponse } from "../../../supabase/functions/_shared/assistantResponse";
import { composition } from "@/lib/statements/compositionFixture";

const COMPANY = "99999999-9999-4999-8999-999999999999";
async function ctx(action: "explain_movement" | "draft_commentary" = "explain_movement", payload: unknown = composition) {
  const r = buildEnvelope(payload, { action, companyId: COMPANY, periodYear: 2026, lineId: "sfp.cash_and_cash_equivalents" });
  if (!r.ok) throw new Error(r.code);
  return { env: r.envelope as ContextEnvelope, digest: await envelopeDigest(r.envelope) };
}
const LINE = "line:sfp.cash_and_cash_equivalents";
const LIMITATION = { kind: "limitation", parts: [{ text: "The statements establish the movement but not its cause; management's explanation or the underlying transactions would be needed." }], sourceRefs: [] };
const good = (digest: string) => ({
  schemaVersion: "cfoclose-assistant-response/1", contextDigest: digest,
  blocks: [
    { kind: "observation", parts: [{ text: "Cash and cash equivalents were " }, { factRef: "line.current" }, { text: " at the end of " }, { factRef: "period.current" },
      { text: ", compared with " }, { factRef: "line.comparative" }, { text: " a year earlier: " }, { factRef: "line.change" }, { text: " (" }, { factRef: "line.change_percent" }, { text: ")." }],
      sourceRefs: [LINE] },
    LIMITATION,
    { kind: "next_step", parts: [{ text: "Compare the bank statements with the cash book for the year." }], sourceRefs: [] },
  ],
});
type Mut = (r: any) => void;
async function errorsOf(mut: Mut, action: "explain_movement" | "draft_commentary" = "explain_movement") {
  const { env, digest } = await ctx(action);
  const r = good(digest) as any;
  mut(r);
  const v = validateResponse(r, env, digest);
  return v.ok ? [] : v.errors;
}

describe("validation", () => {
  it("accepts a well-formed, fact-referenced explanation and renders every figure from the fact records", async () => {
    const { env, digest } = await ctx();
    const v = validateResponse(good(digest), env, digest);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const a = renderResponse(v.response, env);
    expect(a.label).toBe("Explanation");
    expect(a.blocks[0].parts.map((p) => p.text).join("")).toBe(
      "Cash and cash equivalents were TZS 19,000.00 at the end of 2026, compared with TZS 12,800.00 a year earlier: an increase of TZS 6,200.00 (+48.4%).");
    expect(a.blocks[0].sources).toEqual([{ id: LINE, label: "Cash and cash equivalents" }]);
    expect(a.asOf.compositionSha256).toBe("b".repeat(64));
    expect(a.draftText).toBeNull();
  });

  it("is bound to the request context and schema version", async () => {
    expect(await errorsOf((r) => { r.contextDigest = "0".repeat(64); })).toContain("contextDigest does not match the request context");
    expect((await errorsOf((r) => { r.schemaVersion = "cfoclose-assistant-response/2"; }))[0]).toMatch(/schemaVersion/);
    expect((await errorsOf((r) => { r.extra = 1; }))[0]).toMatch(/unexpected fields/);
  });

  it("rejects invented facts and citations", async () => {
    expect((await errorsOf((r) => { r.blocks[0].parts[1] = { factRef: "line.net_profit" }; })).join()).toMatch(/not a fact of this request/);
    expect((await errorsOf((r) => { r.blocks[0].sourceRefs = ["certification:00000000-0000-4000-8000-000000000000"]; })).join()).toMatch(/not in the evidence/);
    expect((await errorsOf((r) => { r.blocks[0].sourceRefs = []; })).join()).toMatch(/must name its sources/);
  });

  it("rejects any figure written by the model: digits, years, percentages and quantities in words", async () => {
    for (const t of ["Cash rose by 6,200.", "Cash rose in 2026.", "Cash rose 48%.", "Cash rose by twelve percent.", "Cash nearly doubled.",
      "Cash grew by six thousand.", "a threefold increase", "up two percentage points", "Cash rose ٣ times"]) {
      const e = await errorsOf((r) => { r.blocks[0].parts = [{ text: t }]; });
      expect(e.join(), t).toMatch(/digit|quantity in words/);
    }
    // Ordinary words that merely contain number-like letters pass.
    expect(await errorsOf((r) => { r.blocks.push({ kind: "next_step", parts: [{ text: "Often one useful check is to review the scaffold of the ledger." }], sourceRefs: [] }); })).toEqual([]);
  });

  it("rejects causal or speculative claims outside limitation / missing blocks, and requires a limitation block", async () => {
    for (const t of ["Cash rose because customers paid faster.", "Cash rose due to new sales.", "The increase likely reflects collections.",
      "Higher sales drove this, suggesting growth.", "This was driven by financing.", "The increase is attributable to the loan."]) {
      const e = await errorsOf((r) => { r.blocks[0].parts.push({ text: t }); });
      expect(e.join(), t).toMatch(/causal or speculative/);
    }
    // In a limitation block, saying the cause is NOT established is the required content.
    expect(await errorsOf((r) => { r.blocks[1].parts = [{ text: "The records do not show whether the change was due to collections or financing." }]; })).toEqual([]);
    expect((await errorsOf((r) => { r.blocks.splice(1, 1); })).join()).toMatch(/must include a limitation block/);
  });

  it("a fact that is not available can be named only as missing", async () => {
    const c = structuredClone(composition) as any;
    c.comparative = { state: "missing", periodYear: null, certificationId: null, currency: null, bridgeIds: [], restatementIds: [] };
    for (const l of c.lines) l.comparative = null;
    const { env, digest } = await ctx("explain_movement", c);
    const r = good(digest) as any;
    expect((validateResponse(r, env, digest) as any).errors.join()).toMatch(/line.comparative is not available/);
    r.blocks[0].parts = [{ text: "Cash and cash equivalents were " }, { factRef: "line.current" }, { text: "." }];
    r.blocks.push({ kind: "missing", parts: [{ text: "The comparative is " }, { factRef: "line.comparative" }, { text: "." }], sourceRefs: [] });
    const v = validateResponse(r, env, digest);
    expect(v.ok).toBe(true);
    if (v.ok) expect(renderResponse(v.response, env).blocks[3].parts[1].text).toBe("not available (there is no prior-year trial balance)");
  });

  it("no markup, links or control characters can enter through text", async () => {
    for (const t of ["<script>alert(1)</script>", "See [here](http://x.example)", "visit www.example.com", "use `code`", "javascript:alert", "a‮b"]) {
      expect((await errorsOf((r) => { r.blocks[2].parts = [{ text: t }]; })).join(), t).toMatch(/markup/);
    }
  });

  it("enforces kinds per action and bounded sizes", async () => {
    expect((await errorsOf((r) => { r.blocks[2].kind = "draft"; })).join()).toMatch(/not permitted for explain_movement/);
    expect((await errorsOf((r) => { r.blocks[2].kind = "action"; })).join()).toMatch(/not permitted/);
    expect((await errorsOf((r) => { r.blocks = Array(LIMITS.blocks + 1).fill(LIMITATION); })).join()).toMatch(/blocks must be a list/);
    expect((await errorsOf((r) => { r.blocks[2].parts = [{ text: "a".repeat(LIMITS.textPart + 1) }]; })).join()).toMatch(/1 to 400 characters/);
    expect((await errorsOf((r) => { r.blocks[2].parts = [{ text: "x", factRef: "line.current" }]; })).join()).toMatch(/either/);
    expect((await errorsOf((r) => { r.blocks[2].navigate = "/workspace"; })).join()).toMatch(/unexpected fields/);
  });

  it("drafts: draft blocks required, labelled as an unreviewed draft, one editable text with rendered figures", async () => {
    const { env, digest } = await ctx("draft_commentary");
    const r = { schemaVersion: "cfoclose-assistant-response/1", contextDigest: digest, blocks: [
      { kind: "draft", parts: [{ text: "Cash and cash equivalents increased to " }, { factRef: "line.current" }, { text: " at the end of " }, { factRef: "period.current" }, { text: "." }], sourceRefs: [LINE] },
      LIMITATION,
    ] };
    const v = validateResponse(r, env, digest);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const a = renderResponse(v.response, env);
    expect(a.label).toBe("Draft — not reviewed");
    expect(a.draftText).toBe("Cash and cash equivalents increased to TZS 19,000.00 at the end of 2026.");
    expect((validateResponse({ ...r, blocks: [LIMITATION] }, env, digest) as any).errors.join()).toMatch(/at least one draft block/);
    expect((validateResponse({ ...r, blocks: [{ ...r.blocks[0], parts: [{ text: "Cash rose because of strong trading." }] }, LIMITATION] }, env, digest) as any).errors.join()).toMatch(/causal/);
  });

  it("parses only one JSON object (a ```json fence tolerated)", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Here you go: {"a":1}')).toBeUndefined();
    expect(parseModelJson("{not json}")).toBeUndefined();
  });
});
