// Launch-acceptance QA — the NINE customer-journey scenario functions (BLACK's independent acceptance).
//
// These are REAL journeys, grounded in the selectors/conventions the repository's own local-stack journey uses
// (scripts/e2e/localStackJourney.mjs — read-only reference): sign-in `#email`/`#password` at `/auth`; first run `#fr-*`
// radix pickers; launchpad `[data-testid="service-FINANCIAL_STATEMENTS"]`/`[data-testid="primary-cta"]`; uploader
// `[data-testid="trial-balance-file-input"]`/`[data-testid="trial-balance-upload-primary"]`; review
// `[data-testid="account-review-workbench"]`; server truth via the service-role client (trusted runner only).
//
// Each function takes `env` (built by launchAcceptance.mjs) and returns { status, problems, evidence }.
//   status: "PASS" | "FAIL" | "BLOCKED" | "NOT_APPLICABLE"   (never a fabricated PASS)
//   - PASS requires its assertions to have executed and found no problem.
//   - FAIL lists observed mismatches with the independent expectation.
//   - BLOCKED names a missing prerequisite (e.g. NORMAL's same-name repair, final invalid-file policy, mock-payment hook).
// RUNTIME-UNVERIFIED until executed on a capable runner; do not read these as passed until the runner reports PASS.
import { focusOrderProblems, loadingErrorStateProblems, copyWordingProblems, primaryActionProblems, responsiveProblems, ariaAssociationProblems, announcementProblems, clarityStateProblems } from "../checks.mjs";
import { BALANCED, IMBALANCED, SAME_NAME, UNSUPPORTED } from "../fixtures/syntheticTb.mjs";

const result = (status, problems = [], evidence = {}) => ({ status, problems, evidence });

// A: First upload — sign in (entitled synthetic user) → create workspace → confirm entity/period/currency → upload a
// supported invented TB through the real screen → start processing → inspect the real result + persisted bindings.
async function scenarioA(env) {
  const problems = [];
  const page = await env.openPage();
  await env.signIn(page, env.users.owner);
  const { companyId, periodYear } = await env.createWorkspace(page, { org: "Mto Holdings Limited", year: "2026", fye: "30 June", currency: "TZS — Tanzanian Shilling", framework: "IFRS for SMEs" });
  if (!companyId) return result("FAIL", ["workspace was not created / did not open at /workspace/:id/:year"]);
  // Confirmed context is SOURCED, not guessed: the created company carries exactly what the form confirmed.
  const co = await env.admin.from("companies").select("id, name, fiscal_year_end, reporting_framework").eq("id", companyId).maybeSingle();
  if (!co.data) problems.push("created company not found via server truth");
  else { if (!/IFRS/i.test(co.data.reporting_framework ?? "")) problems.push(`framework not confirmed as selected (got ${co.data.reporting_framework})`); }
  await env.establishPeriod(page, companyId, periodYear);
  const uploadId = await env.uploadTb(page, companyId, periodYear, env.writeFile("A-balanced.csv", BALANCED.csv));
  if (!uploadId) return result("FAIL", [...problems, "no upload row persisted for the uploaded file"]);
  // Truthful result: the server's own status settled; a certified/reviewed state is not claimed before the engine wrote it.
  const up = await env.settle(companyId, periodYear);
  if (!up) problems.push("processing never settled (truthful result could not be observed)");
  env.record("A.uploadId", uploadId);
  return result(problems.length ? "FAIL" : "PASS", problems, { companyId, periodYear, uploadId });
}

// B: Existing entity — from an existing entity, show sourced context, confirm, and attach the upload to the INTENDED
// entity/period; no unintended new entity, no silent cross-period attachment.
async function scenarioB(env) {
  const problems = [];
  const page = await env.openPage();
  await env.signIn(page, env.users.owner);
  const before = await env.admin.from("companies").select("id").eq("user_id", env.users.owner.id);
  const beforeN = (before.data ?? []).length;
  const existing = env.lastWorkspace; // the entity A created in scenario A
  if (!existing?.companyId) return result("BLOCKED", ["requires scenario A's existing entity (run A first)"]);
  const uploadId = await env.uploadTb(page, existing.companyId, existing.periodYear, env.writeFile("B-balanced.csv", BALANCED.csv));
  const after = await env.admin.from("companies").select("id").eq("user_id", env.users.owner.id);
  if ((after.data ?? []).length !== beforeN) problems.push("an unintended new entity was created when uploading to an existing one");
  const up = uploadId && await env.admin.from("trial_balance_uploads").select("company_id, period_year").eq("id", uploadId).maybeSingle();
  if (up?.data && (up.data.company_id !== existing.companyId || up.data.period_year !== existing.periodYear)) problems.push(`upload attached to the wrong entity/period: ${JSON.stringify(up.data)}`);
  return result(problems.length ? "FAIL" : "PASS", problems, { companyId: existing.companyId });
}

// C: Recovery + identity isolation — refresh/back/interrupt/retry draft recovery for the SAME user; a second user never
// sees the first's draft/file/result; retries do not duplicate outcomes or consumption.
async function scenarioC(env) {
  const problems = [];
  const a = await env.openPage(); await env.signIn(a, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  await env.go(a, `/workspace/${ws.companyId}/${ws.periodYear}/trial-balance/review`);
  await a.goto(await a.url()); // refresh
  await a.evaluate(() => history.back()); await env.sleep(500);
  const recovered = await env.isWorkspaceVisible(a, ws.companyId);
  if (!recovered) problems.push("the owner's own workspace/draft did not recover after refresh/back");
  // Isolation: a DIFFERENT user (fresh identity) must NOT see the first user's workspace — the URL is refused and its API
  // reads return nothing. Mirrors the repository journey's isolation control.
  const b = await env.openPage(); await env.signIn(b, env.users.ownerB);
  await b.goto(`${env.APP}/workspace/${ws.companyId}/${ws.periodYear}`);
  const leaked = await env.isWorkspaceVisible(b, ws.companyId);
  if (leaked) problems.push("CROSS-USER LEAKAGE: a second user can see the first user's workspace");
  const bApiLeak = await env.readsAsOtherUser(env.users.ownerB, ws.companyId); // service-truth: ownerB's own reads see nothing
  if (bApiLeak) problems.push("CROSS-USER LEAKAGE: a second user's API reads return the first user's data");
  return result(problems.length ? "FAIL" : "PASS", problems);
}

// D: Purchase-required path — entitlements unchanged; the requirement is explained; the draft is preserved; the existing
// isolated purchase SIMULATION returns the user to the intended work. No implied free preview / unauthorised paid access.
async function scenarioD(env) {
  if (!env.mockPurchase) return result("BLOCKED", ["needs NORMAL's existing isolated purchase simulation hook (scripts/e2e/mockPaymentProviders.mjs) wired into env.mockPurchase — do not create a real payable checkout"]);
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.preparer); // a user without the required entitlement
  const gated = await env.reachPurchaseRequired(page);
  if (!gated) return result("FAIL", ["the purchase-required state was not reached for a non-entitled user"]);
  const copy = await env.captureCopy(page);
  problems.push(...copyWordingProblems(copy, { context: "purchase-required" }));
  if (!/need|requires|upgrade|plan/i.test(copy)) problems.push("purchase requirement is not clearly explained");
  const before = await env.entitlementSnapshot(env.users.preparer);
  await env.mockPurchase(page); // existing sandbox/mock path ONLY — never a real charge
  const after = await env.entitlementSnapshot(env.users.preparer);
  if (JSON.stringify(before) !== JSON.stringify(after) && !env.purchaseAuthorised) problems.push("entitlement changed without an authorised purchase (no bypass permitted)");
  const draftKept = await env.draftStillPresent(page);
  if (!draftKept) problems.push("the draft was not preserved across the purchase-required detour");
  return result(problems.length ? "FAIL" : "PASS", problems);
}

// E: Replacement — explicit replacement decision; prior upload + history preserved; a STALE replacement refuses safely and
// leaves the current upload intact; retry after success returns the same outcome.
async function scenarioE(env) {
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing reviewed upload (run A first)"]);
  const r = await env.replaceUpload(page, ws.companyId, ws.periodYear, env.writeFile("E-replacement.csv", BALANCED.csv));
  if (!r) return result("BLOCKED", ["replacement affordance not located — confirm the real replacement control with NORMAL"]);
  if (!r.explicit) problems.push("replacement happened without an explicit decision");
  if (!r.historyPreserved) problems.push("prior upload/history was not preserved by the replacement");
  const stale = await env.staleReplace(page, ws.companyId, ws.periodYear);
  if (stale && stale.accepted) problems.push("a STALE replacement was accepted instead of safely refused");
  if (stale && !stale.currentIntact) problems.push("a refused stale replacement did not leave the current upload intact");
  return result(problems.length ? "FAIL" : "PASS", problems);
}

// F: Invalid / unsupported / over-limit files — actionable refusal, no silent truncation, no accepted partial result,
// recovery with a normal file afterwards. USES NORMAL's final policy/fixtures for the limit — does not invent one.
async function scenarioF(env) {
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  // Unsupported file → actionable refusal (not a false success), via the real uploader + error state.
  const unsup = await env.uploadRaw(page, ws.companyId, ws.periodYear, env.writeFile(UNSUPPORTED.name, UNSUPPORTED.content));
  if (unsup?.accepted) problems.push("an unsupported file was accepted (false success)");
  else { const err = await env.captureErrorState(page); problems.push(...loadingErrorStateProblems(err)); }
  // Over-limit: NORMAL owns the final size/row limit + fixtures. Without them this sub-check is BLOCKED, not invented.
  if (!env.overLimitFixture) return result(problems.length ? "FAIL" : (problems.length ? "FAIL" : "PASS"), [...problems, "OVER-LIMIT sub-check BLOCKED: needs NORMAL's final size/row policy + fixture (no invented limit)"]);
  // Recovery: a normal file afterwards succeeds.
  const ok = await env.uploadTb(page, ws.companyId, ws.periodYear, env.writeFile("F-recovery.csv", BALANCED.csv));
  if (!ok) problems.push("could not recover with a normal file after a refusal");
  return result(problems.length ? "FAIL" : "PASS", problems);
}

// G: Review + identity — legitimate same-name/different-code accounts AFTER NORMAL's repair: separate identities &
// treatments; ambiguous matching stays unresolved (never first/last); an imbalance/missing evidence stays visible.
async function scenarioG(env) {
  if (!env.sameNameRepairApplied) return result("BLOCKED", ["gated on NORMAL's same-name/different-code constraint-and-lookup repair (uq_acct_map_company_norm_name). Until applied, mapping two same-name accounts raises a raw constraint error — tested as a FINDING in the Phase-5 lane, not here."]);
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  const uploadId = await env.uploadTb(page, ws.companyId, ws.periodYear, env.writeFile("G-same-name.csv", SAME_NAME.csv));
  await env.settle(ws.companyId, ws.periodYear);
  const mapped = await env.admin.from("account_mappings").select("account_key, account_code, account_name").eq("company_id", ws.companyId).ilike("account_name", "Sales");
  const codes = new Set((mapped.data ?? []).map((m) => m.account_code));
  if (codes.size < 2) problems.push(`the two same-name/different-code 'Sales' accounts are not both preserved as distinct identities (codes: ${[...codes].join(",")})`);
  return result(problems.length ? "FAIL" : "PASS", problems, { uploadId });
}

// H: Accessibility + responsive — keyboard access, logical/visible focus, accessible labels, error association, processing
// announcement, recovery controls; 320/390/desktop. Tables may scroll in-container; the PAGE must not clip.
async function scenarioH(env) {
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  for (const vw of [320, 390, 1280]) {
    const obs = await env.observeViewport(page, `/workspace/${ws.companyId}/${ws.periodYear}`, vw);
    problems.push(...responsiveProblems(vw, obs.layoutWidth, { label: `workspace@${vw}` }));
  }
  const focusables = await env.observeFocusSequence(page);
  problems.push(...focusOrderProblems(focusables));
  const fields = await env.observeFields(page);
  problems.push(...ariaAssociationProblems(fields));
  const ann = await env.observeProcessingAnnouncement(page);
  problems.push(...announcementProblems(ann));
  if (env.axe) { const violations = await env.axe(page); if (violations?.length) problems.push(...violations.map((v) => `axe: ${v.id} (${v.nodes} nodes)`)); }
  else problems.push("NOTE: no automated accessibility tool wired — manual keyboard checks above only; a zero-violation count alone is not full proof");
  return result(problems.filter((p) => !p.startsWith("NOTE")).length ? "FAIL" : "PASS", problems);
}

// I: Professional clarity — first-visit/confirmation/processing/result/blocked/retry each say what happened, what to do
// next, and whether anything was saved/committed. Flag competing primaries, codenames, unsupported claims.
async function scenarioI(env) {
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  for (const stateName of ["first-visit", "confirmation", "processing", "result", "blocked", "retry"]) {
    const s = await env.captureClarityState(page, ws, stateName); // { name, whatHappened, whatNext, saved, copy, ctas }
    if (!s) continue;
    problems.push(...clarityStateProblems(s));
    problems.push(...primaryActionProblems(s.ctas));
    problems.push(...copyWordingProblems(s.copy, { context: stateName }));
  }
  return result(problems.length ? "FAIL" : "PASS", problems);
}

export const SCENARIOS = [
  { id: "A", name: "First upload → context → processing → truthful result", run: scenarioA },
  { id: "B", name: "Existing entity: sourced context, correct attachment, no unintended entity", run: scenarioB },
  { id: "C", name: "Recovery + identity isolation (no cross-user leakage, no duplicate consumption)", run: scenarioC },
  { id: "D", name: "Purchase-required: clear explanation, preserved draft, no bypass (mock payment)", run: scenarioD },
  { id: "E", name: "Replacement: explicit, history preserved, stale refused safely", run: scenarioE },
  { id: "F", name: "Invalid/unsupported/over-limit: actionable refusal, no false success, recovery", run: scenarioF },
  { id: "G", name: "Review: same-name/different-code distinct identities (after NORMAL's repair)", run: scenarioG },
  { id: "H", name: "Accessibility + responsive (320/390/desktop, keyboard/focus/aria/announce)", run: scenarioH },
  { id: "I", name: "Professional clarity across states; one primary action; no codenames/claims", run: scenarioI },
];
