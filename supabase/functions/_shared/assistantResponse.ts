/**
 * Ask CFOClose (Release 0.1) — the exact response schema (cfoclose-assistant-response/2), its validator, and the renderer.
 *
 * The model returns BLOCKS of PARTS: plain text, or a reference to a fact the server supplied. The validator is a set of
 * deterministic NARROWING rules. It is not, and is not presented as, proof that an explanation is factually right: a sentence
 * that passes can still be a poor reading of the facts, which is what the accountant-reviewed evaluation measures.
 *
 *   binding      schemaVersion exact; contextDigest equals the envelope the request was built from.
 *   kinds        the model may write only: explain → observation | missing | next_step; draft → draft | missing.
 *                The LIMITATION ("the records establish the movement but not its cause") is APPLICATION-AUTHORED: the
 *                renderer appends it to every answer; the model can neither write nor weaken it.
 *   references   every factRef and sourceRef belongs to THIS envelope. An observation or draft must cite at least one
 *                computed fact; a missing block must name at least one fact that is NOT available, and may say nothing
 *                else of substance; next_step blocks cite no figures.
 *   assembled    every wording rule runs on the ASSEMBLED text — the block's parts joined exactly as they render (a fact
 *                is a neutral placeholder) — and again on the whole answer, after Unicode normalisation (NFKC) and with
 *                zero-width and bidirectional controls refused. Splitting a word across parts or blocks cannot pass.
 *   numbers      no digit and no number word anywhere in model text; every year, amount, change and percentage is a factRef
 *                rendered by the server from the fact record.
 *   cause        NO causal or speculative wording in any model block (Release 0.1 retrieves no evidence of causes).
 *   authority    no wording of approval, sign-off, audit, verification, correctness or fair presentation.
 *   markup       no HTML, links, URLs, code spans or control characters (the browser also renders text as text).
 *
 * Word lists narrow the claims a model can make; they do not establish correctness. Paraphrases outside the lists are
 * possible; the evaluation set and the accountant's review exist for that reason.
 */
import { displayFact, type AssistantAction, type ContextEnvelope, type Fact } from "./assistantFacts.ts";

export const RESPONSE_SCHEMA = "cfoclose-assistant-response/2";
export const LIMITS = Object.freeze({ blocks: 6, partsPerBlock: 24, textPart: 400, totalText: 2400, factRefsPerBlock: 12, sourceRefsPerBlock: 6, nextSteps: 2 });
export type ModelBlockKind = "observation" | "missing" | "next_step" | "draft";
export type BlockKind = ModelBlockKind | "limitation";
const KINDS: Record<AssistantAction, readonly ModelBlockKind[]> = {
  explain_movement: ["observation", "missing", "next_step"],
  draft_commentary: ["draft", "missing"],
};

/** The application-authored limitation, appended to every answer. Never model output. */
export const LIMITATION_TEXT =
  "The available records establish the movement, not its cause. Management's explanation or the underlying transactions would be needed to say why it changed. This text has not been reviewed or approved.";

export type Part = { text: string } | { factRef: string };
export interface Block { kind: ModelBlockKind; parts: Part[]; sourceRefs: string[] }
export interface AssistantResponse { schemaVersion: typeof RESPONSE_SCHEMA; contextDigest: string; blocks: Block[] }

// Number words (and multiplicative words) that would state a figure the server did not render.
const NUMBER_WORDS = /\b(zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|trillions?|dozens?|percent|per\s*cent|percentage\s+points?|doubled?|doubling|halved|halving|tripled?|quadrupled?|twice|thrice|(?:two|three|four|five|six|seven|eight|nine|ten|hundred|many)-?fold|half|quarter|third)\b/i;
const CAUSAL = /\b(because|cause[sd]?|causing|due\s+to|as\s+a\s+result|result(?:ed|s|ing)?\s+(?:of|from|in)|driven|dr(?:ove|ives|iving)|boost(?:ed|s|ing)?|fuell?(?:ed|ing)|owing\s+to|attribut\w*|reflect\w*|explain(?:s|ed)\s+by|stems?\s+from|stemm\w*|led\s+to|leading\s+to|since|thanks\s+to|following|amid|on\s+the\s+back\s+of|in\s+(?:line|response)\s+(?:with|to)|likely|unlikely|probabl\w*|presumabl\w*|possibl\w*|perhaps|may\s+(?:have|be)|might|could|suggest\w*|indicat\w*|impl(?:y|ies|ied)|appears?\s+to|seems?|expected|consistent\s+with|signal\w*|demonstrat\w*|shows?\s+that|means?\s+that|therefore|thus|hence|consequently)\b/i;
const AUTHORITY = /\b(approv\w*|sign(?:ed)?[\s-]*off|signoff|audit(?:ed|or|ors)?|verif\w*|certif\w*|assur\w*|guarante\w*|correct(?:ly|ness)?|accurate(?:ly)?|accuracy|error[\s-]*free|completeness|true\s+and\s+fair|fair(?:ly)?\s+present\w*|compliant|complian\w*|reliable|validated|confirmed)\b/i;
const MARKUP = /[<>`]|\]\(|https?:|www\.|\bjavascript:|\bdata:|[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/i;
const DIGIT = /\p{Nd}/u;
const FACT_SLOT = " \u2022 "; // neutral placeholder for a fact in assembled text (a bullet: never a letter or a digit)

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

/** The text a reader sees, with facts as a neutral placeholder: what every wording rule is applied to. */
export function assembled(parts: readonly Part[]): string {
  return parts.map((p) => ("text" in p ? p.text : FACT_SLOT)).join("").normalize("NFKC");
}

/** Wording rules over one assembled string. Returns the reasons it is refused. */
export function wordingErrors(text: string, at: string): string[] {
  const out: string[] = [];
  if (DIGIT.test(text)) out.push(`${at}: contains a digit — every figure, year and percentage must be a factRef`);
  const n = NUMBER_WORDS.exec(text); if (n) out.push(`${at}: states a quantity in words ("${n[0]}") — use a factRef`);
  const c = CAUSAL.exec(text); if (c) out.push(`${at}: causal or speculative wording ("${c[0]}") — the records establish no cause; the application states this itself`);
  const a = AUTHORITY.exec(text); if (a) out.push(`${at}: wording of approval, verification or correctness ("${a[0]}") is not permitted`);
  if (MARKUP.test(text)) out.push(`${at}: contains markup, a link or a control character`);
  return out;
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
    const kind = b.kind as ModelBlockKind;
    if (!allowed.includes(kind)) {
      err(`${at}: kind "${String(b.kind)}" is not permitted for ${env.action}${b.kind === "limitation" ? " (the application writes the limitation itself)" : ""}`);
      return;
    }
    if (!Array.isArray(b.parts) || b.parts.length === 0 || b.parts.length > LIMITS.partsPerBlock) { err(`${at}: parts must be a list of 1 to ${LIMITS.partsPerBlock}`); return; }
    const refs = Array.isArray(b.sourceRefs) ? b.sourceRefs : null;
    if (!refs || refs.length > LIMITS.sourceRefsPerBlock || !refs.every((r) => typeof r === "string")) { err(`${at}: sourceRefs must be a list of at most ${LIMITS.sourceRefsPerBlock} ids`); return; }
    for (const r of refs as string[]) if (!sources.has(r)) err(`${at}: sourceRef "${r.slice(0, 60)}" is not in the evidence for this request`);
    const parts: Part[] = [];
    const cited: Fact[] = [];
    (b.parts as unknown[]).forEach((p, pi) => {
      const pat = `${at} part ${pi + 1}`;
      if (!isObj(p)) { err(`${pat}: not an object`); return; }
      const keys = Object.keys(p);
      if (keys.length === 1 && typeof p.text === "string") {
        if (p.text.length === 0 || p.text.length > LIMITS.textPart) err(`${pat}: text must be 1 to ${LIMITS.textPart} characters`);
        totalText += p.text.length;
        parts.push({ text: p.text });
      } else if (keys.length === 1 && typeof p.factRef === "string") {
        const f = facts.get(p.factRef);
        if (!f) { err(`${pat}: factRef "${p.factRef.slice(0, 60)}" is not a fact of this request`); return; }
        if (f.currency !== null && f.currency !== env.currency) err(`${pat}: fact ${f.id} is in another currency`);
        cited.push(f);
        parts.push({ factRef: f.id });
      } else err(`${pat}: a part is either {"text"} or {"factRef"}`);
    });
    // Every wording rule on the block exactly as it reads.
    for (const e of wordingErrors(assembled(parts), at)) err(e);
    if (cited.length > LIMITS.factRefsPerBlock) err(`${at}: at most ${LIMITS.factRefsPerBlock} factRefs`);
    const composed = cited.filter((f) => f.status === "composed");
    const unavailable = cited.filter((f) => f.status !== "composed");
    if (kind === "observation" || kind === "draft") {
      if (composed.length === 0) err(`${at}: an ${kind} block must cite at least one available fact`);
      for (const f of unavailable) err(`${at}: fact ${f.id} is not available (${f.status}); name it only in a missing block`);
      if (refs.length === 0) err(`${at}: an ${kind} block must name its sources`);
      for (const f of composed) if (!refs.includes(f.sourceRef) && !refs.some((r) => r.startsWith("line:"))) err(`${at}: fact ${f.id} needs its source (${f.sourceRef}) or the statement line among the block's sourceRefs`);
    }
    if (kind === "missing") {
      if (unavailable.length === 0) err(`${at}: a missing block must name at least one fact that is not available`);
      if (composed.length > 0) err(`${at}: a missing block cites only facts that are not available`);
    }
    if (kind === "next_step" && cited.length > 0) err(`${at}: a next step cites no figures`);
    blocks.push({ kind, parts, sourceRefs: refs as string[] });
  });
  if (totalText > LIMITS.totalText) err(`the answer's text exceeds ${LIMITS.totalText} characters`);
  if (blocks.filter((b) => b.kind === "next_step").length > LIMITS.nextSteps) err(`at most ${LIMITS.nextSteps} next-step blocks`);
  // And on the whole answer as one text: nothing can be assembled across blocks either.
  for (const e of wordingErrors(blocks.map((b) => assembled(b.parts)).join(""), "the answer as a whole")) err(e);
  if (env.action === "explain_movement" && !blocks.some((b) => b.kind === "observation")) err("an explanation must include at least one observation block");
  if (env.action === "draft_commentary" && !blocks.some((b) => b.kind === "draft")) err("a draft must include at least one draft block");
  return errors.length ? { ok: false, errors } : { ok: true, response: { schemaVersion: RESPONSE_SCHEMA, contextDigest: digest, blocks } };
}

// ── Rendering: every figure from its fact record; the limitation from the application ───────────────────────────────
export interface RenderedPart { kind: "text" | "fact"; text: string; factId?: string; status?: Fact["status"] }
export interface RenderedBlock { kind: BlockKind; author: "assistant" | "application"; parts: RenderedPart[]; sources: { id: string; label: string }[] }
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
    author: "assistant" as const,
    parts: b.parts.map((p): RenderedPart => {
      if ("text" in p) return { kind: "text", text: p.text };
      const f = facts.get(p.factRef)!;
      return { kind: "fact", text: displayFact(f), factId: f.id, status: f.status };
    }),
    sources: b.sourceRefs.map((id) => ({ id, label: sources.get(id)!.label })),
  }));
  blocks.push({ kind: "limitation", author: "application", parts: [{ kind: "text", text: LIMITATION_TEXT }], sources: [] });
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
