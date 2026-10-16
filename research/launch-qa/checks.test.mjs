#!/usr/bin/env node
// Launch-acceptance QA — runnable tests for the PURE checks. These execute HERE (no browser/network). They validate the
// check logic itself; they do NOT assert any of the 9 end-to-end scenarios passed — that needs a live candidate (see REPORT).
import { productionTargetProblem, focusOrderProblems, loadingErrorStateProblems, copyWordingProblems, primaryActionProblems } from "./checks.mjs";

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d !== undefined ? `  — ${JSON.stringify(d)}` : ""}`); } };
const group = (n) => console.log(`\n== ${n}`);

group("productionTargetProblem — QA never targets production");
check("flags the production project ref", productionTargetProblem("https://bvyivmmfjejbmqoydezk.supabase.co") !== null);
check("flags a missing target", productionTargetProblem("") !== null);
check("flags a non-URL", productionTargetProblem("not a url") !== null);
check("accepts a loopback preview", productionTargetProblem("http://127.0.0.1:5173") === null);
check("accepts a non-production preview host", productionTargetProblem("https://preview-abc.lovable.app") === null);

group("focusOrderProblems — keyboard/focus (coverage the existing suites lack)");
check("clean sequence has no problems", focusOrderProblems([
  { label: "Skip to content", visible: true, interactive: true, domOrder: 0 },
  { label: "Upload", visible: true, interactive: true, domOrder: 1 },
]).length === 0);
check("positive tabindex is flagged", focusOrderProblems([{ label: "X", visible: true, interactive: true, tabindex: 3, domOrder: 0 }]).some((p) => /positive tabindex/.test(p)));
check("focusable-but-hidden control is flagged (focus trap)", focusOrderProblems([{ label: "Hidden", visible: false, interactive: true, domOrder: 0 }]).some((p) => /not visible/.test(p)));
check("interactive control with no label is flagged", focusOrderProblems([{ visible: true, interactive: true, domOrder: 0 }]).some((p) => /no accessible label/.test(p)));
check("backwards focus jump vs DOM order is flagged", focusOrderProblems([
  { label: "A", visible: true, interactive: true, domOrder: 2 },
  { label: "B", visible: true, interactive: true, domOrder: 1 },
]).some((p) => /does not follow DOM order/.test(p)));

group("loadingErrorStateProblems — busy indicator + legible, actionable errors");
check("loading with a spinner is clean", loadingErrorStateProblems({ phase: "loading", hasBusyIndicator: true }).length === 0);
check("loading with no indicator is flagged", loadingErrorStateProblems({ phase: "loading" }).some((p) => /no busy indicator/.test(p)));
check("error with an actionable message is clean", loadingErrorStateProblems({ phase: "error", errorMessage: "That file isn't a supported trial balance. Choose a .csv or .xlsx and try again.", errorIsActionable: true, nextAction: "choose another file" }).length === 0);
check("error exposing a raw provider error is flagged", loadingErrorStateProblems({ phase: "error", errorMessage: "PGRST116: [object Object]", nextAction: "x" }).some((p) => /raw\/internal error/.test(p)));
check("error with no next step is flagged", loadingErrorStateProblems({ phase: "error", errorMessage: "Something went wrong." }).some((p) => /no actionable next step/.test(p)));

group("copyWordingProblems — no codenames, no unsupported claims, no premature Phase-6 claims");
check("plain customer copy is clean", copyWordingProblems("Confirm the company and period, then upload your trial balance.").length === 0);
check("an internal engine codename is flagged", copyWordingProblems("Running SAFISHA reconciliation…").some((p) => /codename/.test(p)));
check("an unsupported certification claim is flagged", copyWordingProblems("Your statements are now TRA-approved and fully compliant.").some((p) => /certification\/compliance/.test(p)));
check("a premature Phase-6 feature claim is flagged", copyWordingProblems("Financial statements generated and ready to file.").some((p) => /not-yet-available/.test(p)));

group("primaryActionProblems — exactly one dominant next action");
check("one primary CTA is clean", primaryActionProblems([{ label: "Upload trial balance", primary: true }, { label: "Learn more", primary: false }]).length === 0);
check("two primary CTAs are flagged", primaryActionProblems([{ label: "Upload", primary: true }, { label: "Buy now", primary: true }]).some((p) => /competing primary/.test(p)));
check("no primary CTA is flagged", primaryActionProblems([{ label: "Cancel", primary: false }]).some((p) => /no primary/.test(p)));

console.log(`\n${pass}/${pass + fail} launch-qa check-logic tests passed.`);
console.log("NOTE: these validate the CHECK LOGIC only. No end-to-end launch scenario is executed here — that requires a live");
console.log("candidate + isolated preview from NORMAL (see research/launch-qa/REPORT.md: candidate execution PENDING).");
process.exit(fail ? 1 : 0);
