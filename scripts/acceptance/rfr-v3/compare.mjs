/** Comparison of an evaluator's result with a case's expected outcome (shared by the runner and the vitest suites). */
const B = (s) => BigInt(s);

export function compare(result, exp, inputs) {
  const errs = [];
  const has = (f) => result.findings.some((r) => r.rule === f.rule && r.outcome === f.outcome && r.scope === f.scope && (f.resolved_by === undefined || r.resolved_by === f.resolved_by));
  for (const k of ["draft_eligible", "evidence_upload_allowed"]) if (exp[k] !== undefined && result[k] !== exp[k]) errs.push(`${k}: expected ${exp[k]}, got ${result[k]}`);
  for (const f of exp.findings ?? []) if (!has(f)) errs.push(`missing finding ${f.rule}/${f.outcome}@${f.scope}${f.resolved_by ? " resolved_by " + f.resolved_by : ""}`);
  if (exp.required_scopes && JSON.stringify([...exp.required_scopes].sort()) !== JSON.stringify(result.required_scopes ?? [])) errs.push(`required scopes: expected ${exp.required_scopes}, got ${result.required_scopes}`);
  for (const [s, rs] of Object.entries(exp.scope_reasons ?? {})) if (JSON.stringify(rs) !== JSON.stringify(result.scope_reasons?.[s])) errs.push(`scope_reasons ${s}: expected ${JSON.stringify(rs)}, got ${JSON.stringify(result.scope_reasons?.[s])}`);
  for (const [s, st] of Object.entries(exp.scopes ?? {})) if (result.scopes[s] !== st) errs.push(`scope ${s}: expected ${st}, got ${result.scopes[s] ?? "absent"}`);
  if (exp.proposals) {
    const norm = (ps) => JSON.stringify(ps.map((p) => ({ id: p.id, lines: [...p.lines].sort((a, b) => (a.account < b.account ? -1 : 1)) })).sort((a, b) => (a.id < b.id ? -1 : 1)));
    if (norm(result.proposals) !== norm(exp.proposals)) errs.push(`proposals differ: got ${norm(result.proposals)}`);
  }
  for (const a of exp.refusals ?? []) if (!result.refusals.some((r) => r.action === a)) errs.push(`missing refusal ${a}`);
  for (const [k, v] of Object.entries(exp.balances ?? {})) if (result.balances[k] !== v) errs.push(`balance ${k}: expected ${v}, got ${result.balances[k]}`);
  if (exp.finalization) {
    if (result.finalization.held !== exp.finalization.held) errs.push(`finalization held: expected ${exp.finalization.held}, got ${result.finalization.held} (${result.finalization.reasons.join(", ")})`);
    if (exp.finalization.reasons && JSON.stringify([...exp.finalization.reasons].sort()) !== JSON.stringify(result.finalization.reasons)) errs.push(`finalization reasons: expected ${exp.finalization.reasons}, got ${result.finalization.reasons}`);
  }
  if (exp.corrections_count !== undefined && result.corrections.length !== exp.corrections_count) errs.push(`corrections: expected ${exp.corrections_count}, got ${result.corrections.length}`);
  for (const c of exp.corrections ?? []) {
    const r = result.corrections.find((x) => x.id === c.id);
    if (!r) { errs.push(`correction ${c.id} absent`); continue; }
    for (const [k, v] of Object.entries(c)) if (JSON.stringify(r[k]) !== JSON.stringify(v)) errs.push(`correction ${c.id}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(r[k])}`);
  }
  if (exp.applied_adjustments && JSON.stringify(result.applied_adjustments) !== JSON.stringify([...exp.applied_adjustments].sort())) errs.push(`applied adjustments: expected ${exp.applied_adjustments}, got ${result.applied_adjustments}`);
  const appliedLines = [...result.proposals.filter((p) => result.applied_adjustments.includes(p.id)).flatMap((p) => p.lines), ...(inputs.reporting_adjustments ?? []).filter((r) => result.applied_adjustments.includes(r.id)).flatMap((r) => r.lines)];
  for (const a of exp.assertions ?? []) {
    const [name, x, y] = a.split(":");
    if (name === "no_adjustment_touches_cash" && appliedLines.some((l) => l.account === x)) errs.push(`assertion ${a} failed`);
    if (name === "cheque_once") {
      const n = (inputs.ledger?.entries ?? []).filter((e) => e.account === y && e.ref === x).length;
      if (n !== 1 || appliedLines.some((l) => l.account === y)) errs.push(`assertion ${a} failed (${n} postings)`);
    }
  }
  return errs;
}

export function compareMutation(result, m) {
  const errs = [];
  const e = m.expected;
  const inc = [...(e.add_findings ?? []), ...(e.replace_finding ? [e.replace_finding] : [])];
  for (const f of inc) if (!result.findings.some((r) => r.rule === f.rule && r.outcome === f.outcome && r.scope === f.scope)) errs.push(`missing finding ${f.rule}/${f.outcome}@${f.scope}`);
  if (e.replace_finding) { const f = e.replace_finding; if (result.findings.some((r) => r.rule === f.rule && r.scope === f.scope && r.outcome !== f.outcome)) errs.push(`finding ${f.rule}@${f.scope} still has another outcome`); }
  for (const [s, st] of Object.entries(e.scopes ?? {})) if (result.scopes[s] !== st) errs.push(`scope ${s}: expected ${st}, got ${result.scopes[s]}`);
  if (e.finalization_held !== undefined && result.finalization.held !== e.finalization_held) errs.push(`finalization held: expected ${e.finalization_held}, got ${result.finalization.held}`);
  if (e.finalization_reasons && JSON.stringify([...e.finalization_reasons].sort()) !== JSON.stringify(result.finalization.reasons)) errs.push(`finalization reasons: expected ${e.finalization_reasons}, got ${result.finalization.reasons}`);
  for (const r of e.finalization_reasons_include ?? []) if (!result.finalization.reasons.includes(r)) errs.push(`missing reason ${r}`);
  for (const id of e.proposals_exclude ?? []) if (result.proposals.some((p) => p.id === id)) errs.push(`unexpected proposal ${id}`);
  for (const a of e.refusals_include ?? []) if (!result.refusals.some((r) => r.action === a)) errs.push(`missing refusal ${a}`);
  return errs;
}

export const patched = (inputs, patch) => ({ ...structuredClone(inputs), ...structuredClone(patch) });

