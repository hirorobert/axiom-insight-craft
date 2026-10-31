// Launch-acceptance QA — the OVERALL pass rule (pure, so it is unit-tested). The nine scenarios are MANDATORY: an overall
// PASS requires EVERY one of the nine ids present EXACTLY ONCE, each executed and PASS. Anything else — a missing id, a
// duplicate id, an unexpected id, or any FAIL / BLOCKED / NOT_RUN — prevents overall PASS and a zero exit code.
//
// (Replaces the insufficient `executed.length > 0 && failed.length === 0`, which could PASS with mandatory scenarios
// BLOCKED — e.g. 1 PASS + 8 BLOCKED.)
export const MANDATORY_SCENARIO_IDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];

/**
 * @param {{id:string,status:"PASS"|"FAIL"|"BLOCKED"|"NOT_RUN"|string}[]} results
 * @param {string[]} mandatoryIds
 * @returns {{overallPass:boolean, exitCode:number, missing:string[], duplicates:string[], extra:string[],
 *            failed:string[], blocked:string[], notRun:string[], reasons:string[]}}
 */
export function evaluateOverall(results, mandatoryIds = MANDATORY_SCENARIO_IDS) {
  const list = Array.isArray(results) ? results : [];
  const mand = new Set(mandatoryIds);
  const countById = new Map();
  for (const r of list) countById.set(r.id, (countById.get(r.id) ?? 0) + 1);

  const missing = mandatoryIds.filter((id) => (countById.get(id) ?? 0) === 0);
  const duplicates = mandatoryIds.filter((id) => (countById.get(id) ?? 0) > 1);
  const extra = [...countById.keys()].filter((id) => !mand.has(id));

  const statusOf = (id) => { const rs = list.filter((r) => r.id === id); return rs.length === 1 ? rs[0].status : null; };
  const failed = mandatoryIds.filter((id) => list.some((r) => r.id === id && r.status === "FAIL"));
  const blocked = mandatoryIds.filter((id) => statusOf(id) === "BLOCKED");
  const notRun = mandatoryIds.filter((id) => statusOf(id) === "NOT_RUN");

  // Every mandatory id appears exactly once AND is PASS; no missing, duplicate or extra id anywhere.
  const allNinePass = missing.length === 0 && duplicates.length === 0 && extra.length === 0
    && mandatoryIds.every((id) => (countById.get(id) === 1) && statusOf(id) === "PASS");

  const reasons = [];
  if (missing.length) reasons.push(`missing scenarios: ${missing.join(",")}`);
  if (duplicates.length) reasons.push(`duplicate scenarios: ${duplicates.join(",")}`);
  if (extra.length) reasons.push(`unexpected scenarios: ${extra.join(",")}`);
  if (failed.length) reasons.push(`FAIL: ${failed.join(",")}`);
  if (blocked.length) reasons.push(`BLOCKED: ${blocked.join(",")}`);
  if (notRun.length) reasons.push(`NOT_RUN: ${notRun.join(",")}`);

  const overallPass = allNinePass;
  // Exit: 0 only on overall PASS. A real FAIL ⇒ 1. Otherwise (not executed / missing / duplicate / extra) ⇒ 4.
  const exitCode = overallPass ? 0 : (failed.length > 0 ? 1 : 4);
  return { overallPass, exitCode, missing, duplicates, extra, failed, blocked, notRun, reasons };
}
