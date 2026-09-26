// The atomic migration envelope (security corrections B-3 / X-2 / M-1) — a FAIL-CLOSED parser built on a
// PostgreSQL-aware lexer (no regex comment stripping anywhere).
//
// An atomic migration runs every statement inside ONE block:
//
//   <comments / whitespace only>
//   DO $cfoclose_<label>$
//   BEGIN
//     EXECUTE $m<label><aaa>$
//   <one statement, verbatim>
//   $m<label><aaa>$;
//     ... (more segments; only whitespace between them)
//   END
//   $cfoclose_<label>$;
//   <comments / whitespace only>
//
// The lexer (lexSql) distinguishes, exactly as PostgreSQL does: single-quoted strings with doubled quotes; E'...'
// strings with backslash escapes; B/X/U& / N prefixed strings; quoted identifiers ("..." with doubled quotes); dollar-
// quoted strings with any valid tag ($$, $tag$); line comments; NESTED block comments; identifiers (which may contain
// $); positional parameters ($1); numbers; operators and punctuation. Unterminated strings, identifiers, comments or
// dollar quotes are errors.
//
// Refused (AtomicEnvelopeError, never skipped):
//   * any executable token before or after the envelope (raw GRANT / REVOKE / DDL, a trailing statement, a second
//     envelope) — only whitespace and comments may surround it;
//   * inside the DO body, anything but `BEGIN`, segments `EXECUTE <dollar-quoted> ;` and `END` (whitespace only);
//   * a segment tag that is not $m<label><3 letters>$, or is reused; an empty segment; more than one top-level statement
//     in a segment; a nested envelope or segment tag anywhere inside a segment;
//   * dynamic SQL anywhere inside a segment, at any depth: every PL/pgSQL / SQL body (every dollar-quoted string) is
//     lexed recursively, and every EXECUTE token must be followed (after whitespace / comments) by FUNCTION or
//     PROCEDURE, or be `GRANT EXECUTE ON` / `REVOKE EXECUTE ON`. EXECUTE(...), EXECUTE/**/'...', EXECUTE 'sql',
//     EXECUTE format(...), EXECUTE v_sql, EXECUTE $q$...$q$, EXECUTE 'a' || 'b' are all refused;
//   * zero statements.

export class AtomicEnvelopeError extends Error {
  constructor(message) { super(`atomic envelope refused: ${message}`); this.name = "AtomicEnvelopeError"; }
}
const fail = (m) => { throw new AtomicEnvelopeError(m); };

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * Lexes SQL / PL/pgSQL text into tokens { type, text, start, end, tag?, body?, bodyStart? }.
 * type: ws | comment | string | qident | dollar | word | param | number | punct
 */
export function lexSql(t) {
  const out = [];
  let i = 0;
  const push = (type, start, end, extra = {}) => out.push({ type, text: t.slice(start, end), start, end, ...extra });
  while (i < t.length) {
    const c = t[i], n = t[i + 1];
    const start = i;
    if (/\s/.test(c)) { while (i < t.length && /\s/.test(t[i])) i++; push("ws", start, i); continue; }
    if (c === "-" && n === "-") { while (i < t.length && t[i] !== "\n") i++; push("comment", start, i); continue; }
    if (c === "/" && n === "*") {
      let depth = 1; i += 2;
      while (i < t.length && depth > 0) {
        if (t[i] === "/" && t[i + 1] === "*") { depth++; i += 2; }
        else if (t[i] === "*" && t[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) fail(`unterminated block comment at offset ${start}`);
      push("comment", start, i); continue;
    }
    // Prefixed string constants: E'..' (backslash escapes), B'..', X'..', N'..', U&'..'.
    const prefixed = /^(?:[EeBbXxNn]|[Uu]&)'/.exec(t.slice(i, i + 3));
    if (c === "'" || prefixed) {
      const escapes = /^[Ee]'/.test(t.slice(i, i + 2));
      i += prefixed ? prefixed[0].length : 1;
      for (;;) {
        if (i >= t.length) fail(`unterminated string at offset ${start}`);
        if (escapes && t[i] === "\\") { i += 2; continue; }
        if (t[i] === "'") { if (t[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      push("string", start, i); continue;
    }
    if (c === '"' || (/[Uu]/.test(c) && n === "&" && t[i + 2] === '"')) {
      i += c === '"' ? 1 : 3;
      for (;;) {
        if (i >= t.length) fail(`unterminated quoted identifier at offset ${start}`);
        if (t[i] === '"') { if (t[i + 1] === '"') { i += 2; continue; } i++; break; }
        i++;
      }
      push("qident", start, i); continue;
    }
    if (c === "$") {
      if (/[0-9]/.test(n ?? "")) { i++; while (i < t.length && /[0-9]/.test(t[i])) i++; push("param", start, i); continue; }
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(t.slice(i));
      if (!m) fail(`stray "$" at offset ${start}`);
      const open = m[0];
      const bodyStart = i + open.length;
      const close = t.indexOf(open, bodyStart);
      if (close < 0) fail(`unterminated dollar quote ${open} at offset ${start}`);
      i = close + open.length;
      push("dollar", start, i, { tag: m[1] ?? "", body: t.slice(bodyStart, close), bodyStart });
      continue;
    }
    if (IDENT_START.test(c)) { while (i < t.length && IDENT_PART.test(t[i])) i++; push("word", start, i); continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(n ?? ""))) { while (i < t.length && /[0-9A-Za-z_.]/.test(t[i])) i++; push("number", start, i); continue; }
    i++; push("punct", start, i);
  }
  return out;
}

const isTrivia = (tok) => tok.type === "ws" || tok.type === "comment";
const word = (tok, w) => tok?.type === "word" && tok.text.toUpperCase() === w;

/**
 * Inspects executable code (and, recursively, every dollar-quoted body inside it) for dynamic SQL and forbidden tags.
 * `where` names the location in error messages.
 */
function inspectCode(code, where, forbiddenTag, depth = 0) {
  if (depth > 32) fail(`${where}: dollar quotes nested too deeply`);
  const toks = lexSql(code).filter((x) => !isTrivia(x));
  // The statement (at this level) each token belongs to: an executable body of a CREATE FUNCTION / PROCEDURE must be
  // dollar-quoted (so it is inspected below); a string body would be executable code hidden from inspection.
  let stmtStart = 0;
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k];
    if (tok.type === "punct" && tok.text === ";") { stmtStart = k + 1; continue; }
    // DO [LANGUAGE x] <body>: the body must be dollar-quoted (ON CONFLICT DO NOTHING / UPDATE are not bodies).
    if (word(tok, "DO")) {
      let b = k + 1;
      if (word(toks[b], "LANGUAGE")) b += 2;
      if (toks[b]?.type === "string") fail(`${where}: a DO body in a string literal (${JSON.stringify(toks[b].text.slice(0, 24))}); executable bodies must be dollar-quoted`);
    }
    if (word(tok, "AS") && toks[k + 1]?.type === "string") {
      const stmt = toks.slice(stmtStart, k);
      const create = stmt.findIndex((x) => word(x, "CREATE"));
      if (create >= 0 && stmt.slice(create).some((x) => word(x, "FUNCTION") || word(x, "PROCEDURE"))) {
        fail(`${where}: a function / procedure body in a string literal (${JSON.stringify(toks[k + 1].text.slice(0, 24))}); executable bodies must be dollar-quoted`);
      }
    }
    if (tok.type === "dollar") {
      if (forbiddenTag(tok.tag)) fail(`${where}: contains a nested envelope or segment tag $${tok.tag}$`);
      inspectCode(tok.body, where, forbiddenTag, depth + 1);
      continue;
    }
    if (!word(tok, "EXECUTE")) continue;
    const next = toks[k + 1];
    const prev = toks[k - 1];
    const staticForm = word(next, "FUNCTION") || word(next, "PROCEDURE") || ((word(prev, "GRANT") || word(prev, "REVOKE")) && word(next, "ON"));
    if (!staticForm) fail(`${where}: dynamic SQL (EXECUTE ${next ? JSON.stringify(next.text.slice(0, 24)) : "<end>"})`);
  }
}

/** Does this migration claim to be an atomic envelope? Any occurrence of the marker counts (fail closed). */
export function isAtomicEnvelope(sql) {
  return String(sql ?? "").includes("$cfoclose_");
}

/** Parses an atomic envelope strictly. Returns { label, statements } or throws AtomicEnvelopeError. */
export function parseAtomicEnvelope(sql) {
  const t = String(sql ?? "").replace(/\r\n/g, "\n");
  const top = lexSql(t).filter((x) => !isTrivia(x));
  if (top.length === 0) fail("no envelope");
  const [kDo, kBody, kSemi, ...rest] = top;
  if (!word(kDo, "DO")) fail(`executable text before the envelope: ${JSON.stringify(kDo.text.slice(0, 40))}`);
  if (kBody?.type !== "dollar" || !/^cfoclose_[a-z_]+$/.test(kBody.tag)) fail("malformed envelope header (expected DO $cfoclose_<label>$)");
  if (kSemi?.type !== "punct" || kSemi.text !== ";") fail("the envelope is not terminated by ';'");
  if (rest.length > 0) fail(`executable text after the envelope: ${JSON.stringify(rest[0].text.slice(0, 40))}`);
  const label = kBody.tag.slice("cfoclose_".length);
  const segRe = new RegExp(`^m${label}[a-z]{3}$`);
  const forbiddenTag = (tag) => /^cfoclose_/i.test(tag) || new RegExp(`^m${label}[a-z]+$`, "i").test(tag);

  // The DO body: BEGIN, segments, END — whitespace only between them.
  const body = lexSql(kBody.body);
  const code = body.filter((x) => x.type !== "ws");
  const stray = code.find((x) => x.type === "comment");
  if (stray) fail("a comment inside the DO body (only whitespace is allowed between segments)");
  if (!word(code[0], "BEGIN")) fail("the DO body does not start with BEGIN");
  if (!word(code[code.length - 1], "END")) fail("the DO body does not end with END");
  const seen = new Set();
  const statements = [];
  for (let k = 1; k < code.length - 1; k += 3) {
    const [e, d, s] = [code[k], code[k + 1], code[k + 2]];
    if (!word(e, "EXECUTE") || d?.type !== "dollar" || !segRe.test(d.tag) || s?.type !== "punct" || s.text !== ";") {
      fail(`unrecognised executable content inside the DO body: ${JSON.stringify(t.slice(kBody.bodyStart + (e?.start ?? 0), kBody.bodyStart + (e?.start ?? 0) + 40))}`);
    }
    if (seen.has(d.tag)) fail(`segment tag $${d.tag}$ is reused`);
    seen.add(d.tag);
    const where = `segment $${d.tag}$`;
    const stmt = d.body.replace(/^\n/, "").replace(/\n$/, "");
    const stmtToks = lexSql(stmt).filter((x) => !isTrivia(x));
    if (stmtToks.length === 0) fail(`${where} is empty`);
    const semi = stmtToks.findIndex((x) => x.type === "punct" && x.text === ";");
    if (semi >= 0 && semi < stmtToks.length - 1) fail(`${where} holds more than one statement`);
    inspectCode(stmt, where, forbiddenTag);
    statements.push(stmt);
  }
  if (statements.length === 0) fail("the envelope executes zero statements");
  return { label, statements };
}

/**
 * The statements an atomic migration executes, as plain SQL (each terminated by ";"), for static guards. A migration
 * without the envelope marker is returned unchanged; one with it that is not exactly a valid envelope THROWS.
 */
export function unwrapAtomicEnvelope(sql) {
  if (!isAtomicEnvelope(sql)) return sql;
  return `${parseAtomicEnvelope(sql).statements.map((s) => `${s};`).join("\n\n")}\n`;
}
