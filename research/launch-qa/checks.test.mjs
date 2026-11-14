#!/usr/bin/env node
// Launch-acceptance QA — runnable tests for the PURE checks. These execute HERE (no browser/network). They validate the
// check logic itself; they do NOT assert any of the 9 end-to-end scenarios passed — that needs a live candidate (see REPORT).
import { productionTargetProblem, reviewHierarchyProblems, chooserStateProblems, tabWalkProblems, programmaticFocusProblems, focusOrderProblems, loadingErrorStateProblems, copyWordingProblems, primaryActionProblems, responsiveProblems, ariaAssociationProblems, announcementProblems, clarityStateProblems } from "./checks.mjs";

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

group("responsiveProblems — 320/390 horizontal clip (page, not in-container tables)");
check("no overflow when document fits the viewport", responsiveProblems(320, 320).length === 0);
check("overflow flagged when the document is wider than the viewport", responsiveProblems(320, 461, { label: "workspace" }).some((p) => /overflows horizontally at 320px/.test(p)));
check("390px clean", responsiveProblems(390, 388).length === 0);

group("ariaAssociationProblems — accessible names + error association");
check("named field with an associated error is clean", ariaAssociationProblems([{ label: "Email", hasAccessibleName: true, errorShown: true, errorAssociated: true }]).length === 0);
check("field with no accessible name is flagged", ariaAssociationProblems([{ label: "Password", hasAccessibleName: false }]).some((p) => /no accessible name/.test(p)));
check("a shown-but-unassociated error is flagged", ariaAssociationProblems([{ label: "Email", hasAccessibleName: true, errorShown: true, errorAssociated: false }]).some((p) => /not associated/.test(p)));

group("announcementProblems — processing must be announced");
check("processing with aria-live is clean", announcementProblems({ processing: true, hasAriaLive: true }).length === 0);
check("processing with no live region/status is flagged", announcementProblems({ processing: true }).some((p) => /not announced/.test(p)));
check("not processing → nothing to announce", announcementProblems({ processing: false }).length === 0);

group("clarityStateProblems — what happened / what next / what saved");
check("a complete state is clean", clarityStateProblems({ name: "result", whatHappened: "Your trial balance was checked.", whatNext: "Review the flagged accounts.", saved: "saved" }).length === 0);
check("missing 'what next' is flagged", clarityStateProblems({ name: "blocked", whatHappened: "x", saved: "nothing" }).some((p) => /what to do next/.test(p)));
check("unknown saved/committed status is flagged", clarityStateProblems({ name: "processing", whatHappened: "x", whatNext: "y" }).some((p) => /saved\/committed/.test(p)));

group("tabWalkProblems — the REAL Tab sequence (NORMAL)");
check("a visible, named, in-order walk is clean", tabWalkProblems([{ label: "Skip", role: "a", visible: true, domIndex: 1 }, { label: "Upload", role: "button", visible: true, domIndex: 9 }]).length === 0);
check("no stops at all is flagged", tabWalkProblems([]).some((p) => /no element/.test(p)));
check("focus landing on an unseen element is flagged", tabWalkProblems([{ label: "x", visible: false, domIndex: 1 }]).some((p) => /not visible/.test(p)));
check("an unnamed stop is flagged", tabWalkProblems([{ label: "", role: "button", visible: true, domIndex: 1 }]).some((p) => /no accessible name/.test(p)));
check("positive tabindex is flagged", tabWalkProblems([{ label: "x", visible: true, tabindex: 2, domIndex: 1 }]).some((p) => /positive tabindex/.test(p)));
check("a backwards jump is flagged", tabWalkProblems([{ label: "a", visible: true, domIndex: 9 }, { label: "b", visible: true, domIndex: 2 }]).some((p) => /backwards/.test(p)));

group("programmaticFocusProblems — tabindex<0 is ASSESSED, never skipped (NORMAL)");
check("a visible button removed from the Tab order is flagged", programmaticFocusProblems([{ label: "Delete", role: "button", interactive: true, visible: true }]).some((p) => /removed from the keyboard order/.test(p)));
check("a roving-tabindex item inside a composite widget is accepted", programmaticFocusProblems([{ label: "Option 2", role: "option", interactive: true, visible: true, compositeItem: true }]).length === 0);
check("a named hidden notifications region is accepted", programmaticFocusProblems([{ label: "Notifications", role: "region", interactive: false, visible: false, named: true }]).length === 0);
check("a hidden live region is accepted", programmaticFocusProblems([{ label: "", role: "ol", interactive: false, visible: false, liveRegion: true }]).length === 0);
check("an unnamed hidden non-live target is flagged", programmaticFocusProblems([{ label: "", role: "div", interactive: false, visible: false }]).some((p) => /no name and no live-region/.test(p)));

group("chooserStateProblems — RULING I-1: peer Resume actions in a deliberate choice");
const chooser = (o = {}) => ({ title: "Choose an engagement to continue",
  peers: [{ name: "Resume Mto Holdings Limited FY2026", visible: true, primary: false }, { name: "Resume Gemini Same Name Ltd FY2026", visible: true, primary: false }],
  otherPrimaries: 0, tabLabels: ["CFOClose home", "Resume Mto Holdings Limited FY2026", "Resume Gemini Same Name Ltd FY2026"],
  navigation: { name: "Resume Mto Holdings Limited FY2026", expectedPath: "/workspace/c1/2026", landedPath: "/workspace/c1/2026/prepare", dialog: false }, ...o });
check("an explicit choice of named, keyboard-reachable peers that open directly passes", chooserStateProblems(chooser()).length === 0);
check("an implicit task is flagged", chooserStateProblems(chooser({ title: "Your engagements" })).some((p) => /not stated explicitly/.test(p)));
check("a peer that does not name its engagement is flagged", chooserStateProblems(chooser({ peers: [{ name: "Resume", visible: true }, { name: "Resume Gemini Same Name Ltd FY2026", visible: true }] })).some((p) => /does not identify/.test(p)));
check("indistinguishable peers are flagged", chooserStateProblems(chooser({ peers: [{ name: "Resume Mto Holdings Limited FY2026", visible: true }, { name: "Resume Mto Holdings Limited FY2026", visible: true }] })).some((p) => /same name/.test(p)));
check("an arbitrary default (a primary peer) is flagged", chooserStateProblems(chooser({ peers: [{ name: "Resume Mto Holdings Limited FY2026", visible: true, primary: true }, { name: "Resume Gemini Same Name Ltd FY2026", visible: true }] })).some((p) => /pre-selected/.test(p)));
check("another primary on the screen is flagged", chooserStateProblems(chooser({ otherPrimaries: 1 })).some((p) => /pre-selected/.test(p)));
check("a peer missing from the Tab sequence is flagged", chooserStateProblems(chooser({ tabLabels: ["Resume Mto Holdings Limited FY2026"] })).some((p) => /not reachable by keyboard/.test(p)));
check("a confirmation screen after choosing is flagged", chooserStateProblems(chooser({ navigation: { name: "x", expectedPath: "/workspace/c1/2026", landedPath: "/workspace/c1/2026", dialog: true } })).some((p) => /confirmation/.test(p)));
check("opening a different engagement is flagged", chooserStateProblems(chooser({ navigation: { name: "x", expectedPath: "/workspace/c1/2026", landedPath: "/workspace/c2/2026", dialog: false } })).some((p) => /did not open its engagement/.test(p)));
check("a single peer is not a choice", chooserStateProblems(chooser({ peers: [{ name: "Resume Mto Holdings Limited FY2026", visible: true }] })).some((p) => /at least two/.test(p)));

group("reviewHierarchyProblems — RULING I-2: one leading action from the review state (not class counting)");
const btn = (emphasis, o = {}) => ({ present: true, emphasis, filled: emphasis === "primary", disabled: false, busy: false, ...o });
check("incomplete: Resolve leads, Save secondary+disabled passes", reviewHierarchyProblems({ state: "incomplete", card: btn("primary"), save: btn("secondary", { disabled: true }) }, "incomplete").length === 0);
check("ready: Save leads, Resolve secondary passes", reviewHierarchyProblems({ state: "ready", card: btn("secondary"), save: btn("primary") }, "ready").length === 0);
check("ready with both leading is flagged", reviewHierarchyProblems({ state: "ready", card: btn("primary"), save: btn("primary") }).some((p) => /competes/.test(p)));
check("a declared primary that is not visually emphasised is flagged", reviewHierarchyProblems({ state: "ready", card: btn("secondary"), save: btn("primary", { filled: false }) }).some((p) => /not visually emphasised/.test(p)));
check("a secondary that is visually filled is flagged", reviewHierarchyProblems({ state: "ready", card: btn("secondary", { filled: true }), save: btn("primary") }).some((p) => /declares secondary/.test(p)));
check("submitting without disabled+busy is flagged", reviewHierarchyProblems({ state: "submitting", card: btn("secondary"), save: btn("primary", { disabled: true }) }).some((p) => /duplicate/.test(p)));
check("failed without the inline reason is flagged", reviewHierarchyProblems({ state: "failed", card: btn("secondary"), save: btn("primary") }).some((p) => /not saved/.test(p)));
check("failed with the reason and Save leading passes", reviewHierarchyProblems({ state: "failed", card: btn("secondary"), save: btn("primary"), alert: true }).length === 0);
check("nothing to save: a promoted Save is flagged", reviewHierarchyProblems({ state: "nothing", card: btn("primary"), save: btn("primary") }).some((p) => /unnecessary/.test(p)));
check("review not shown: the card's action leading passes", reviewHierarchyProblems({ state: null, card: btn("primary"), save: { present: false } }).length === 0);
check("incomplete with Save enabled is flagged", reviewHierarchyProblems({ state: "incomplete", card: btn("primary"), save: btn("secondary") }).some((p) => /enabled before/.test(p)));
check("an unexpected state is flagged", reviewHierarchyProblems({ state: "ready", card: btn("secondary"), save: btn("primary") }, "incomplete").some((p) => /expected incomplete/.test(p)));

console.log(`\n${pass}/${pass + fail} launch-qa check-logic tests passed.`);
console.log("NOTE: these validate the CHECK LOGIC only. No end-to-end launch scenario is executed here — that requires a live");
console.log("candidate + isolated preview from NORMAL (see research/launch-qa/REPORT.md: candidate execution PENDING).");
process.exit(fail ? 1 : 0);
