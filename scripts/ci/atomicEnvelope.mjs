// The atomic migration envelope (security corrections B-3 / X-2 / M-1) — a FAIL-CLOSED parser.
//
// An atomic migration runs every statement inside ONE block:
//
//   <comments / whitespace only>
//   DO $cfoclose_<label>$
//   BEGIN
//     EXECUTE $m<label><letters>$
//   <one statement, verbatim>
//   $m<label><letters>$;
//     ... (more segments, whitespace between them)
//   END
//   $cfoclose_<label>$;
//   <comments / whitespace only>
//
// Static guards (migration authority, trigger replay) must see every statement the envelope executes. So a file
// that claims an envelope (anywhere: `DO $cfoclose_...$`) is accepted ONLY in exactly this shape; anything the parser
// cannot account for is an error, never skipped:
//   * executable text before or after the envelope (raw GRANT / REVOKE / DDL, a trailing statement, a second envelope);
//   * content inside the DO body that is not a recognised segment (e.g. `EXECUTE 'GRANT ...'`, a raw statement);
//   * a segment tag that is not `$m<label><letters>$`, is reused, or is not closed by `\n<tag>;`;
//   * a nested envelope or another segment's tag inside a segment;
//   * dynamic SQL inside a segment (EXECUTE of anything but FUNCTION / PROCEDURE, i.e. statements hidden from guards);
//   * an empty segment, or an envelope with zero statements.
// Text that does not claim an envelope is returned unchanged by unwrapAtomicEnvelope.

export class AtomicEnvelopeError extends Error {
  constructor(message) { super(`atomic envelope refused: ${message}`); this.name = "AtomicEnvelopeError"; }
}

const fail = (m) => { throw new AtomicEnvelopeError(m); };

/** Index of the first character that is not whitespace or a comment, starting at i. */
function skipTrivia(t, i) {
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t.startsWith("--", i)) { const e = t.indexOf("\n", i); i = e < 0 ? t.length : e + 1; continue; }
    if (t.startsWith("/*", i)) { const e = t.indexOf("*/", i + 2); if (e < 0) fail("unterminated block comment"); i = e + 2; continue; }
    return i;
  }
}

const stripLineComments = (s) => s.replace(/--[^\n]*/g, "");

/** Does this migration claim to be an atomic envelope (anywhere, outside comments)? */
export function isAtomicEnvelope(sql) {
  return /\bDO\s+\$cfoclose_/i.test(stripLineComments(String(sql ?? "").replace(/\r\n/g, "\n")));
}

/**
 * Parses an atomic envelope strictly. Returns { label, statements } (each statement verbatim, without ";") or throws
 * AtomicEnvelopeError.
 */
export function parseAtomicEnvelope(sql) {
  const t = String(sql ?? "").replace(/\r\n/g, "\n");
  let i = skipTrivia(t, 0);
  const head = /^DO (\$cfoclose_([a-z_]+)\$)\nBEGIN\n/.exec(t.slice(i));
  if (!head) fail(i >= t.length ? "no envelope" : "executable text before the envelope, or a malformed envelope header");
  const [whole, doTag, label] = head;
  i += whole.length;
  const segTag = new RegExp(`^EXECUTE (\\$m${label}[a-z]+\\$)\\n`);
  const anySegTag = new RegExp(`\\$m${label}[a-z]+\\$`);
  const seen = new Set();
  const statements = [];
  const footer = `END\n${doTag};`;
  for (;;) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t.startsWith(footer, i)) { i += footer.length; break; }
    const m = segTag.exec(t.slice(i));
    if (!m) fail(i >= t.length ? "the envelope is never closed" : `unrecognised executable content inside the DO body at offset ${i}: ${JSON.stringify(t.slice(i, i + 40))}`);
    const tag = m[1];
    if (seen.has(tag)) fail(`segment tag ${tag} is reused`);
    seen.add(tag);
    const bodyStart = i + m[0].length;
    const close = t.indexOf(tag, bodyStart);
    if (close < 0 || t[close - 1] !== "\n" || t[close + tag.length] !== ";") fail(`segment ${tag} is not closed by "\\n${tag};"`);
    const body = t.slice(bodyStart, close - 1);
    const code = stripLineComments(body);
    if (!code.trim()) fail(`segment ${tag} is empty`);
    if (/\$cfoclose_/i.test(code)) fail(`segment ${tag} contains a nested envelope`);
    if (anySegTag.test(body)) fail(`segment ${tag} contains another segment's tag`);
    if (/\bEXECUTE\s+(?!FUNCTION\b|PROCEDURE\b|ON\b)/i.test(code)) fail(`segment ${tag} contains dynamic SQL (EXECUTE of a string or expression)`);
    statements.push(body);
    i = close + tag.length + 1;
  }
  if (skipTrivia(t, i) !== t.length) fail("executable text after the envelope");
  if (statements.length === 0) fail("the envelope executes zero statements");
  return { label, statements };
}

/**
 * The statements an atomic migration executes, as plain SQL (each terminated by ";"), for static guards. A migration
 * that does not claim an envelope is returned unchanged; one that claims an envelope but is not exactly a valid one
 * THROWS (fail closed: nothing it contains can hide from a guard).
 */
export function unwrapAtomicEnvelope(sql) {
  if (!isAtomicEnvelope(sql)) return sql;
  return `${parseAtomicEnvelope(sql).statements.map((s) => `${s};`).join("\n\n")}\n`;
}
