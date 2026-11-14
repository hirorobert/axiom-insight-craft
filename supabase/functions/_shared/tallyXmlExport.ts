/**
 * tallyXmlExport — reads TallyPrime's Trial Balance XML export into source rows for the ingestion core.
 *
 * Tally's own documentation (docs/release/tally-export-r1/README.md, S6) shows the report exported as XML as an
 * ENVELOPE whose body is a flat sequence of
 *
 *   <DSPACCNAME><DSPDISPNAME>name</DSPDISPNAME></DSPACCNAME>
 *   <DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-100000.00</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA></DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO>
 *
 * pairs: a closing debit written negative (or empty), a closing credit positive (or empty), and NO element that says
 * whether a line is a group or a ledger. So the rows are handed to the Tally adapter (tbIngestion.ts, `source:
 * "tally_xml"`) as a ledger-wise export, where a line that names a predefined Tally group refuses the file, and the
 * sign rule is enforced per amount (parseTallyXmlAmount), never flipped.
 *
 * Pure TypeScript with no DOM: a small strict tokenizer for exactly this shape. Anything else in the envelope — a
 * HEADER, a BODY, an unknown element, CDATA, an unknown entity, a stray "<" — refuses the file with the element and
 * line named. Nothing is skipped or repaired. Row numbers are the 1-based text lines on which each line's DSPACCNAME
 * starts (the header row is the ENVELOPE's line), so a finding points into the file as a text editor shows it.
 */

import type { IngestIssue, SourceRow } from "./tbIngestion.ts";

interface XmlNode { name: string; line: number; children: XmlNode[]; text: string }

type Parsed = { ok: true; root: XmlNode } | { ok: false; line: number; why: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const MAX_DEPTH = 32;

/** Decodes the five XML entities and numeric references; null for anything else (an unknown entity is not guessed). */
function decodeText(raw: string): string | null {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "<") return null;
    if (ch !== "&") { out += ch; continue; }
    const end = raw.indexOf(";", i);
    if (end < 0) return null;
    const ref = raw.slice(i + 1, end);
    if (ref in ENTITIES) out += ENTITIES[ref];
    else if (/^#\d{1,7}$/.test(ref)) out += String.fromCodePoint(Number(ref.slice(1)));
    else if (/^#x[0-9A-Fa-f]{1,6}$/.test(ref)) out += String.fromCodePoint(parseInt(ref.slice(2), 16));
    else return null;
    i = end;
  }
  return out;
}

/** A strict, iterative parse of one XML document into a tree. Mixed content keeps its text on the element. */
export function parseTallyXml(text: string): Parsed {
  let pos = 0;
  let line = 1;
  const advance = (to: number) => { for (let k = pos; k < to; k++) if (text[k] === "\n") line++; pos = to; };
  const fail = (why: string): Parsed => ({ ok: false, line, why });
  const skipWhitespaceAndComments = (): string | null => {
    for (;;) {
      const m = /^\s*/.exec(text.slice(pos)) as RegExpExecArray;
      advance(pos + m[0].length);
      if (text.startsWith("<!--", pos)) {
        const end = text.indexOf("-->", pos + 4);
        if (end < 0) return "a comment that never closes";
        advance(end + 3);
        continue;
      }
      return null;
    }
  };
  if (text.startsWith("<?xml", pos)) {
    const end = text.indexOf("?>", pos);
    if (end < 0) return fail("the XML declaration never closes");
    advance(end + 2);
  }
  const pre = skipWhitespaceAndComments();
  if (pre) return fail(pre);
  if (text[pos] !== "<") return fail("the file does not start with an XML element");

  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let textStart = -1;
  const flushText = (upTo: number) => {
    if (stack.length === 0 || textStart < 0) return null;
    const decoded = decodeText(text.slice(textStart, upTo));
    textStart = -1;
    if (decoded === null) return "an unknown entity or a stray “<” in text";
    stack[stack.length - 1].text += decoded;
    return null;
  };
  while (pos < text.length) {
    if (text[pos] !== "<") {
      if (stack.length === 0) {
        if (/\s/.test(text[pos])) { advance(pos + 1); continue; }
        return fail(root ? "text after the closing </ENVELOPE>" : "text before the first element");
      }
      if (textStart < 0) textStart = pos;
      advance(pos + 1);
      continue;
    }
    const err = flushText(pos);
    if (err) return fail(err);
    if (text.startsWith("<!--", pos)) {
      const end = text.indexOf("-->", pos + 4);
      if (end < 0) return fail("a comment that never closes");
      advance(end + 3);
      continue;
    }
    if (text.startsWith("<![CDATA[", pos)) return fail("a CDATA section, which a Tally export does not contain");
    if (text.startsWith("<?", pos)) return fail("a processing instruction inside the document");
    if (text.startsWith("<!", pos)) return fail("a DOCTYPE or other declaration inside the document");
    if (text.startsWith("</", pos)) {
      const m = NAME.exec(text.slice(pos + 2));
      if (!m) return fail("a closing tag without a name");
      const close = text.indexOf(">", pos);
      if (close < 0) return fail("a closing tag that never closes");
      if (text.slice(pos + 2 + m[0].length, close).trim() !== "") return fail(`a malformed closing tag </${m[0]}`);
      const open = stack.pop();
      if (!open) return fail(`a closing tag </${m[0]}> with nothing open`);
      if (open.name !== m[0]) return fail(`</${m[0]}> closes <${open.name}> (opened on line ${open.line})`);
      advance(close + 1);
      if (stack.length === 0) root = open;
      continue;
    }
    const m = NAME.exec(text.slice(pos + 1));
    if (!m) return fail("a tag without a name");
    if (root !== null && stack.length === 0) return fail(`a second top-level element <${m[0]}> after </${root.name}>`);
    const node: XmlNode = { name: m[0], line, children: [], text: "" };
    let p = pos + 1 + m[0].length;
    // Attributes are read for well-formedness only (Tally writes TYPE="…"); their values are not used.
    for (;;) {
      const ws = /^\s*/.exec(text.slice(p)) as RegExpExecArray;
      p += ws[0].length;
      if (text.startsWith("/>", p)) { p += 2; break; }
      if (text[p] === ">") { p += 1; if (stack.length >= MAX_DEPTH) return fail(`elements nested more than ${MAX_DEPTH} deep`); stack.push(node); break; }
      const a = /^[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*("[^"<]*"|'[^'<]*')/.exec(text.slice(p));
      if (!a) return fail(`a malformed start tag <${node.name}`);
      p += a[0].length;
    }
    if (stack.length > 0 && stack[stack.length - 1] !== node) stack[stack.length - 1].children.push(node);
    else if (stack.length > 1) stack[stack.length - 2].children.push(node);
    else if (stack.length === 0) { if (root !== null) return fail("a second top-level element"); root = node; }
    advance(p);
  }
  if (stack.length > 0) return fail(`<${stack[stack.length - 1].name}> (opened on line ${stack[stack.length - 1].line}) is never closed`);
  if (!root) return fail("no element was found");
  return { ok: true, root };
}

export type TallyXmlRead = { ok: true; rows: SourceRow[] } | { ok: false; issue: IngestIssue };

const SHAPE = "A Tally Trial Balance XML export is an <ENVELOPE> of <DSPACCNAME> / <DSPACCINFO> pairs (Tally's own documented shape). In Tally, open the Trial Balance, press F5 (Ledger-wise), export it as XML and upload that file — or export it as Excel.";

function refused(message: string): TallyXmlRead {
  return { ok: false, issue: { code: "UNSUPPORTED_FORMAT", severity: "blocking", message } };
}

/** Exactly one child element of `name` (or none when optional); anything else is reported. */
function only(node: XmlNode, name: string, optional: boolean): XmlNode | null | string {
  const hits = node.children.filter((c) => c.name === name);
  const others = node.children.filter((c) => c.name !== name);
  if (others.length > 0) return `<${node.name}> on line ${node.line} contains <${others[0].name}> (line ${others[0].line})`;
  if (hits.length > 1) return `<${node.name}> on line ${node.line} contains <${name}> more than once`;
  if (hits.length === 0) return optional ? null : `<${node.name}> on line ${node.line} has no <${name}>`;
  return hits[0];
}

/**
 * The Trial Balance envelope → source rows: a header row ("Particulars", "Debit", "Credit") on the ENVELOPE's line and
 * one row per line of the report, amounts as Tally wrote them (the sign rule is enforced by the ingestion core).
 * `maxRows` bounds the rows materialised (the upload policy's row limit is applied by the caller on what comes back).
 */
export function readTallyTrialBalanceXml(text: string, maxRows: number): TallyXmlRead {
  const parsed = parseTallyXml(text);
  if (!parsed.ok) return refused(`The file could not be read as XML: line ${parsed.line} has ${parsed.why}. ${SHAPE}`);
  const root = parsed.root;
  if (root.name !== "ENVELOPE") return refused(`The XML's top-level element is <${root.name}>, not <ENVELOPE>. ${SHAPE}`);
  if (root.text.trim() !== "") return refused(`<ENVELOPE> contains text outside its elements (line ${root.line}). ${SHAPE}`);
  const rows: SourceRow[] = [{ rowNumber: root.line, cells: ["Particulars", "Debit", "Credit"] }];
  const kids = root.children;
  if (kids.length === 0) return refused(`The <ENVELOPE> has no Trial Balance lines. ${SHAPE}`);
  for (let k = 0; k < kids.length; k += 2) {
    const nameNode = kids[k];
    const infoNode = kids[k + 1];
    if (nameNode.name !== "DSPACCNAME") return refused(`<${nameNode.name}> on line ${nameNode.line} is not part of the Trial Balance export shape. ${SHAPE}`);
    if (!infoNode || infoNode.name !== "DSPACCINFO") return refused(`<DSPACCNAME> on line ${nameNode.line} is not followed by its <DSPACCINFO>. ${SHAPE}`);
    const disp = only(nameNode, "DSPDISPNAME", false);
    if (typeof disp === "string") return refused(`${disp}. ${SHAPE}`);
    const name = (disp as XmlNode).text.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
    if (name === "") return refused(`The line on line ${nameNode.line} has an empty <DSPDISPNAME>. ${SHAPE}`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(name)) return refused(`The name on line ${nameNode.line} contains a control character. ${SHAPE}`);
    // DSPACCINFO holds exactly the two wrappers, each with at most one amount element; anything else is named.
    const extra = infoNode.children.filter((c) => c.name !== "DSPCLDRAMT" && c.name !== "DSPCLCRAMT");
    if (extra.length > 0) return refused(`<DSPACCINFO> on line ${infoNode.line} contains <${extra[0].name}> (line ${extra[0].line}). ${SHAPE}`);
    const amounts: (string | null)[] = [];
    for (const [outer, inner] of [["DSPCLDRAMT", "DSPCLDRAMTA"], ["DSPCLCRAMT", "DSPCLCRAMTA"]] as const) {
      const wrapper = infoNode.children.filter((c) => c.name === outer);
      if (wrapper.length !== 1) return refused(`<DSPACCINFO> on line ${infoNode.line} does not contain exactly one <${outer}>. ${SHAPE}`);
      const a = only(wrapper[0], inner, true);
      if (typeof a === "string") return refused(`${a}. ${SHAPE}`);
      const t = a ? a.text.replace(/[  ]/g, " ").trim() : "";
      amounts.push(t === "" ? null : t);
    }
    if (rows.length <= maxRows) rows.push({ rowNumber: nameNode.line, cells: [name, amounts[0], amounts[1]] });
  }
  return { ok: true, rows };
}
