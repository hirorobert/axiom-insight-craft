/**
 * Ask CFOClose (Release 0.1) — the exact response schema (cfoclose-assistant-response/1), its validator, and the renderer.
 *
 * The model returns BLOCKS of PARTS: plain text, or a reference to a fact the server supplied. Validation is structural and
 * deterministic; it does not try to judge whether an explanation is wise (the reviewed evaluation set does that):
 *
 *   binding      schemaVersion exact; contextDigest equals the envelope the request was built from.
 *   shape        permitted block kinds per action; bounded block, part, reference and text counts and lengths.
 *   references   every factRef and sourceRef belongs to THIS envelope; a fact not computed may only be referenced where
 *                the answer is saying what is missing (missing / limitation blocks).
 *   numbers      RULE: no digit and no number word may appear in model text. Every year, amount, change and percentage
 *                is a factRef, rendered by the server from the fact record. (Standard names with digits — "Section 4" —
 *                are therefore written without the number; a reference catalogue is outside Release 0.1.)
 *   cause        Release 0.1 retrieves no evidence of business causes. Causal or speculative wording ("due to",
 *                "because", "likely", …) is allowed only in limitation / missing blocks, where the answer says the cause
 *                is NOT established; an explanation must contain at least one limitation block.
 *   markup       no HTML, links, URLs, code spans or control characters can enter through text (the browser also renders
 *                text as text). No action payloads exist in the schema.
 *
 * What this cannot prove (stated, not hidden): that a permitted sentence is a fair reading of the facts. That is measured by
 * the accountant-reviewed evaluation set before activation.
 */
import { displayFact, type AssistantAction, type ContextEnvelope, type Fact } from "./assistantFacts.ts";

export const RESPONSE_SCHEMA = "cfoclose-assistant-response/1";
export const LIMITS = Object.freeze({ blocks: 8, partsPerBlock: 24, textPart: 400, totalText: 3000, factRefsPerBlock: 12, sourceRefsPerBlock: 6 });
export type BlockKind = "observation" | "limitation" | "missing" | "next_step" | "draft";
const KINDS: Record<AssistantAction, readonly BlockKind[]> = {
  explain_movement: ["observation", "limitation", "missing", "next_step"],
  draft_commentary: ["draft", "limitation", "missing"],
};
const ALLOWS_NOT_COMPUTED: ReadonlySet<BlockKind> = new Set(["missing", "limitation"]);
const ALLOWS_CAUSAL: ReadonlySet<BlockKind> = new Set(["missing", "limitation"]);

export type Part = { text: string } | { factRef: string };
export interface Block { kind: BlockKind; parts: Part[]; sourceRefs: string[] }
export interface AssistantResponse { schemaVersion: typeof RESPONSE_SCHEMA; contextDigest: string; blocks: Block[] }

// Number words (and multiplicative words) that would state a figure the server did not render.
const NUMBER_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|trillions?|dozens?|percent|per\s*cent|percentage\s+points?|doubled?|doubling|halved|halving|tripled?|quadrupled?|twice|thrice|(?:two|three|four|five|six|seven|eight|nine|ten|hundred|many)-?fold)\b/i;
const CAUSAL = /\b(because|due\s+to|caused|causing|as\s+a\s+result|result(?:ed|s)?\s+(?:of|from)|driven\s+by|dr(?:ove|ives|iving)|boost(?:ed|s|ing)|fuell?(?:ed|ing)|owing\s+to|attributable|reflects?|reflecting|explained\s+by|stems?\s+from|led\s+to|likely|probably|presumably|suggest(?:s|ed|ing)?|indicat(?:es|ing)\s+that|implies|thanks\s+to)\b/i;
const MARKUP = /[<>`]|\]\(|https?:|www\.|\bjavascript:|\bdata:|[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/i;
const DIGIT = /\p{Nd}/u;

export type Validation = { ok: true; response: AssistantResponse } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses the model's raw text: exactly one JSON object (an optional ```json fence is tolerated, nothing else). */
export function parseModelJson(raw: string): unknown {
  let t = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(t);
  if (fence) t = fence[1].trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

export function validateResponse(raw: unknown, env: ContextEnvelope, digest: string): Validation {
  const errors: string[] = [];
  const err = (m: string) => { if (errors.length < 25) errors.push(m); };
  if (!isObj(raw)) return { ok: false, errors: ["the answer is not a JSON object"] };
  const extra = Object.keys(raw).filter((k) => !["schemaVersion", "contextDigest", "blocks"].includes(k));
  if (extra.length) err(`unexpected fields: ${extra.slice(0, 5).join(", ")}`);
  if (raw.schemaVersion !== RESPONSE_SCHEMA) err(`schemaVersion must be ${RESPONSE_SCHEMA}`);
  if (raw.contextDigest !== digest) err("contextDigest does not match the request context");
  if (!Array.isArray(raw.blocks) || raw.blocks.length === 0 || raw.blocks.length > LIMITS.blocks) {
    err(`blocks must be a list of 1 to ${LIMITS.blocks}`);
    return { ok: false, errors };
  }
  const facts = new Map<string, Fact>(env.facts.map((f) => [f.id, f]));
  const sources = new Set(env.sources.map((s) => s.id));
  const allowed = KINDS[env.action];
  let totalText = 0;
  const blocks: Block[] = [];
  (raw.blocks as unknown[]).forEach((b, bi) => {
    const at = `block ${bi + 1}`;
    if (!isObj(b)) { err(`${at}: not an object`); return; }
    const bx = Object.keys(b).filter((k) => !["kind", "parts", "sourceRefs"].includes(k));
    if (bx.length) err(`${at}: unexpected fields ${bx.slice(0, 3).join(", ")}`);
    const kind = b.kind as BlockKind;
    if (!allowed.includes(kind)) { err(`${at}: kind "${String(b.kind)}" is not permitted for ${env.action}`); return; }
    if (!Array.isArray(b.parts) || b.parts.length === 0 || b.parts.length > LIMITS.partsPerBlock) { err(`${at}: parts must be a list of 1 to ${LIMITS.partsPerBlock}`); return; }
    const refs = Array.isArray(b.sourceRefs) ? b.sourceRefs : null;
    if (!refs || refs.length > LIMITS.sourceRefsPerBlock || !refs.every((r) => typeof r === "string")) { err(`${at}: sourceRefs must be a list of at most ${LIMITS.sourceRefsPerBlock} ids`); return; }
    for (const r of refs as string[]) if (!sources.has(r)) err(`${at}: sourceRef "${r.slice(0, 60)}" is not in the evidence for this request`);
    const parts: Part[] = [];
    let factRefs = 0;
    (b.parts as unknown[]).forEach((p, pi) => {
      const pat = `${at} part ${pi + 1}`;
      if (!isObj(p)) { err(`${pat}: not an object`); return; }
      const keys = Object.keys(p);
      if (keys.length === 1 && typeof p.text === "string") {
        const t = p.text;
        if (t.length === 0 || t.length > LIMITS.textPart) err(`${pat}: text must be 1 to ${LIMITS.textPart} characters`);
        if (DIGIT.test(t)) err(`${pat}: text contains a digit — every figure, year and percentage must be a factRef`);
        const nw = NUMBER_WORDS.exec(t);
        if (nw) err(`${pat}: text states a quantity in words ("${nw[0]}") — use a factRef`);
        if (MARKUP.test(t)) err(`${pat}: text contains markup, a link or a control character`);
        if (!ALLOWS_CAUSAL.has(kind)) {
          const c = CAUSAL.exec(t);
          if (c) err(`${pat}: causal or speculative wording ("${c[0]}") is only permitted where the answer says the cause is not established (limitation or missing)`);
        }
        totalText += t.length;
        parts.push({ text: t });
      } else if (keys.length === 1 && typeof p.factRef === "string") {
        const f = facts.get(p.factRef);
        factRefs++;
        if (!f) { err(`${pat}: factRef "${p.factRef.slice(0, 60)}" is not a fact of this request`); return; }
        if (f.currency !== null && f.currency !== env.currency) err(`${pat}: fact ${f.id} is in another currency`);
        if (f.status !== "composed" && !ALLOWS_NOT_COMPUTED.has(kind)) err(`${pat}: fact ${f.id} is not available (${f.status}); say so in a missing or limitation block`);
        if ((kind === "observation" || kind === "draft") && f.status === "composed" && !refs.includes(f.sourceRef) && !refs.some((r) => r.startsWith("line:"))) {
          err(`${pat}: fact ${f.id} needs its source (${f.sourceRef}) or the statement line among the block's sourceRefs`);
        }
        parts.push({ factRef: f.id });
      } else err(`${pat}: a part is either {"text"} or {"factRef"}`);
    });
    if (factRefs > LIMITS.factRefsPerBlock) err(`${at}: at most ${LIMITS.factRefsPerBlock} factRefs`);
    if ((kind === "observation" || kind === "draft") && refs.length === 0) err(`${at}: an ${kind} block must name its sources`);
    blocks.push({ kind, parts, sourceRefs: refs as string[] });
  });
  if (totalText > LIMITS.totalText) err(`the answer's text exceeds ${LIMITS.totalText} characters`);
  if (env.action === "explain_movement" && !blocks.some((b) => b.kind === "limitation")) err("an explanation must include a limitation block stating that the records do not establish the cause");
  if (env.action === "explain_movement" && !blocks.some((b) => b.kind === "observation")) err("an explanation must include at least one observation block");
  if (env.action === "draft_commentary" && !blocks.some((b) => b.kind === "draft")) err("a draft must include at least one draft block");
  return errors.length ? { ok: false, errors } : { ok: true, response: { schemaVersion: RESPONSE_SCHEMA, contextDigest: digest, blocks } };
}

// ── Rendering: every figure from its fact record ─────────────────────────────────────────────────────────────────────
export interface RenderedPart { kind: "text" | "fact"; text: string; factId?: string; status?: Fact["status"] }
export interface RenderedBlock { kind: BlockKind; parts: RenderedPart[]; sources: { id: string; label: string }[] }
export interface RenderedAnswer {
  schemaVersion: typeof RESPONSE_SCHEMA;
  action: AssistantAction;
  label: "Explanation" | "Draft — not reviewed";
  contextDigest: string;
  asOf: { compositionSha256: string; periodYear: number; lineId: string; lineLabel: string; currency: string };
  blocks: RenderedBlock[];
  /** The draft as one editable string (draft_commentary only). Edits belong to the person; nothing edited is verified. */
  draftText: string | null;
}

export function renderResponse(r: AssistantResponse, env: ContextEnvelope): RenderedAnswer {
  const facts = new Map(env.facts.map((f) => [f.id, f]));
  const sources = new Map(env.sources.map((s) => [s.id, s]));
  const blocks: RenderedBlock[] = r.blocks.map((b) => ({
    kind: b.kind,
    parts: b.parts.map((p): RenderedPart => {
      if ("text" in p) return { kind: "text", text: p.text };
      const f = facts.get(p.factRef)!;
      return { kind: "fact", text: displayFact(f), factId: f.id, status: f.status };
    }),
    sources: b.sourceRefs.map((id) => ({ id, label: sources.get(id)!.label })),
  }));
  const draft = env.action === "draft_commentary"
    ? blocks.filter((b) => b.kind === "draft").map((b) => b.parts.map((p) => p.text).join("").replace(/\s+/g, " ").trim()).join("\n\n")
    : null;
  return {
    schemaVersion: RESPONSE_SCHEMA, action: env.action, label: env.action === "draft_commentary" ? "Draft — not reviewed" : "Explanation",
    contextDigest: r.contextDigest,
    asOf: { compositionSha256: env.compositionSha256, periodYear: env.periodYear, lineId: env.lineId, lineLabel: env.lineLabel, currency: env.currency },
    blocks, draftText: draft,
  };
}
