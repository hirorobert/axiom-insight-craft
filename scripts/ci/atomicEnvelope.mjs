// The atomic migration envelope (security corrections B-3 / X-2): a migration whose statements all run inside ONE
// `DO $cfoclose_<label>$ ... $cfoclose_<label>$;` block, each executed verbatim by `EXECUTE $m<label><letters>$ ...
// $m<label><letters>$;`. Static guards that reason about individual statements (triggers, grants, corrective
// statements) must inspect the statements the envelope executes, not the single DO block that wraps them.
//
// unwrapAtomicEnvelope(sql) returns the original statement sequence (header comments kept, each statement terminated
// by ";"). Any text that is not an envelope is returned unchanged.

const DO_TAG = /DO (\$cfoclose_[a-z_]+\$)\nBEGIN\n/;

export function isAtomicEnvelope(sql) {
  return DO_TAG.test(String(sql ?? "").replace(/\r\n/g, "\n"));
}

export function unwrapAtomicEnvelope(sql) {
  const text = String(sql ?? "").replace(/\r\n/g, "\n");
  const m = DO_TAG.exec(text);
  if (!m) return sql;
  const header = text.slice(0, m.index);
  const body = text.slice(m.index + m[0].length);
  const segments = [];
  for (const seg of body.matchAll(/ {2}EXECUTE (\$m[a-z]+\$)\n([\s\S]*?)\n\1;/g)) segments.push(`${seg[2]};`);
  return `${header}${segments.join("\n\n")}\n`;
}
