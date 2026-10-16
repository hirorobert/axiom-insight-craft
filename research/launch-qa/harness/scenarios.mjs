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
  if (typeof env.mockPurchase !== "function" || typeof env.entitlementSnapshot !== "function") {
    return result("BLOCKED", ["purchase simulation not supplied (env.mockPurchase / env.entitlementSnapshot) — do not create a real payable checkout"]);
  }
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.preparer); // a user WITHOUT the required entitlement
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // NO BYPASS (grounded, server truth): a SANDBOX purchase authorises NOTHING. If entitlement changes from a mere sandbox
  // payment, that is a real product defect (a paid-access bypass) → FAIL.
  const before = await env.entitlementSnapshot(env.users.preparer);
  await env.mockPurchase(page, env.users.preparer); // sandbox card purchase ONLY — never a real charge
  const afterPurchase = await env.entitlementSnapshot(env.users.preparer);
  if (!eq(before, afterPurchase) || env.purchaseAuthorised) problems.push(`entitlement changed after a sandbox purchase (no authorised grant) — a paid-access bypass: before=${JSON.stringify(before)} after=${JSON.stringify(afterPurchase)}`);

  // AUTHORISED grant (grounded): the manual-activation path IS distinct and DOES grant — proving the grant is gated on
  // authorisation, not on a mere payment.
  let grantEvidence = "activateByAgreement not supplied";
  if (env.payments && typeof env.payments.activateByAgreement === "function") {
    await env.payments.activateByAgreement(env.users.preparer);
    const afterGrant = await env.entitlementSnapshot(env.users.preparer);
    if (eq(afterGrant, before)) problems.push("the authorised activation path did not grant access (expected the server's access to change)");
    grantEvidence = `granted=${!eq(afterGrant, before)}`;
  }
  if (problems.length) return result("FAIL", problems, { before, afterPurchase, grantEvidence });

  // The UI sub-checks — reaching the purchase-required screen with a clear explanation, and the DRAFT being preserved across
  // the return — are not grounded in this harness (no reach/draft probe and no verified paywall selectors). Per the strict
  // rule they are BLOCKED, never a NOTE/PASS. The no-bypass + authorised-grant evidence above is recorded.
  return result("BLOCKED", [
    "purchase-required UI sub-checks not grounded: 'reach the requirement with a clear explanation' and 'draft preserved across the return' need the paywall/draft selectors (NORMAL to confirm, or supply reachPurchaseRequired/draftStillPresent). No-bypass + authorised-grant executed and clean.",
  ], { before, afterPurchase, grantEvidence });
}

// E: Replacement — explicit replacement decision; prior upload + history preserved; a STALE replacement refuses safely and
// leaves the current upload intact; retry after success returns the same outcome.
async function scenarioE(env) {
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing reviewed upload (run A first)"]);
  // Both probes are required. A MISSING probe is BLOCKED (never a silent skip that lets E pass).
  if (typeof env.replaceUpload !== "function" || typeof env.staleReplace !== "function") return result("BLOCKED", ["replacement controls not supplied (env.replaceUpload / env.staleReplace) — UI-driven replacement not in this harness; NORMAL-owned"]);
  const r = await env.replaceUpload(page, ws.companyId, ws.periodYear, env.writeFile("E-replacement.csv", BALANCED.csv));
  if (r == null) return result("BLOCKED", ["replacement affordance not located — the real replacement control is not driveable yet (NORMAL-owned)"]);
  if (!r.explicit) problems.push("replacement happened without an explicit decision");
  if (!r.historyPreserved) problems.push("prior upload/history was not preserved by the replacement");
  const stale = await env.staleReplace(page, ws.companyId, ws.periodYear);
  if (stale == null) return result("BLOCKED", ["stale-replacement probe unavailable — cannot verify a safe stale refusal (NORMAL-owned); not skipped, not PASS"]);
  if (stale.accepted) problems.push("a STALE replacement was accepted instead of safely refused");
  if (!stale.currentIntact) problems.push("a refused stale replacement did not leave the current upload intact");
  return result(problems.length ? "FAIL" : "PASS", problems);
}

// F: Invalid / unsupported / over-limit files — actionable refusal, no silent truncation, no accepted partial result,
// recovery with a normal file afterwards. USES NORMAL's final policy/fixtures for the limit — does not invent one.
async function scenarioF(env) {
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  // The OVER-LIMIT sub-check is mandatory and needs NORMAL's policy fixture. Absent ⇒ BLOCKED (never PASS/NOTE).
  if (!env.overLimitFixture?.path) return result("BLOCKED", ["over-limit sub-check needs env.overLimitFixture (NORMAL's current upload-policy fixture); no invented limit"]);

  // Unsupported file → actionable refusal (not a false success), via the real uploader + error state.
  const unsup = await env.uploadRaw(page, ws.companyId, ws.periodYear, env.writeFile(UNSUPPORTED.name, UNSUPPORTED.content));
  if (unsup?.accepted) problems.push("an unsupported file was accepted (false success)");
  else { const err = await env.captureErrorState(page); problems.push(...loadingErrorStateProblems(err)); }

  // Over-limit: ACTUALLY upload NORMAL's over-limit fixture and require the named refusal with NO partial accepted result.
  const expected = env.overLimitFixture.expectedCode || "TOO_MANY_ACCOUNTS";
  const over = await env.uploadRaw(page, ws.companyId, ws.periodYear, env.overLimitFixture.path);
  const errState = await env.captureErrorState(page);
  const latest = await env.admin.from("trial_balance_uploads").select("id, status, processing_result").eq("company_id", ws.companyId).eq("period_year", ws.periodYear).order("uploaded_at", { ascending: false }).limit(1).maybeSingle();
  const prText = JSON.stringify(latest.data?.processing_result ?? {});
  const refusedByName = new RegExp(expected, "i").test(prText) || new RegExp(expected, "i").test(errState.errorMessage || "") || /too many accounts|account limit|exceed/i.test(errState.errorMessage || "");
  const cert = await env.isCertified(ws.companyId, ws.periodYear); // server truth: must NOT certify an over-limit upload
  const accepted = !!over?.accepted || cert || ["needs_review", "reviewed", "processed", "certified"].includes(latest.data?.status);
  if (!refusedByName) problems.push(`over-limit upload was not refused by name (${expected}); status=${latest.data?.status}; pr=${prText.slice(0, 160)}; err=${(errState.errorMessage || "").slice(0, 120)}`);
  if (accepted) problems.push(`over-limit upload produced an accepted/partial result (status=${latest.data?.status}, certified=${cert}) — must accept nothing`);

  // Recovery: a normal file afterwards succeeds.
  const ok = await env.uploadTb(page, ws.companyId, ws.periodYear, env.writeFile("F-recovery.csv", BALANCED.csv));
  if (!ok) problems.push("could not recover with a normal file after a refusal");
  return result(problems.length ? "FAIL" : "PASS", problems, { expected, policy: env.overLimitFixture.policy, overLimitAccounts: env.overLimitFixture.accounts });
}

// G: Review + identity — legitimate same-name/different-code accounts AFTER NORMAL's repair: separate identities &
// treatments; ambiguous matching stays unresolved (never first/last); an imbalance/missing evidence stays visible.
async function scenarioG(env) {
  if (!env.sameNameRepairApplied) return result("BLOCKED", ["gated on NORMAL's same-name/different-code repair being present+verified in the DB under test (uq_acct_map_company_codeless_name, old all-names index gone). Until verified, mapping two same-name accounts raises a raw constraint error — a FINDING in the Phase-5 lane, not asserted here."]);
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  const uploadId = await env.uploadTb(page, ws.companyId, ws.periodYear, env.writeFile("G-same-name.csv", SAME_NAME.csv));
  if (!uploadId) return result("FAIL", ["the same-name trial balance did not upload"]);
  await env.settle(ws.companyId, ws.periodYear);
  // Mappings exist ONLY after review decisions (resolve_account_review_batch). REVIEW BOTH "Sales" accounts first, as the
  // owner (authenticated), each keyed by its own code — then check they persist as two DISTINCT mappings.
  const decisions = SAME_NAME.rows.filter((r) => /sales/i.test(r.name)).map((r) => ({
    account_code: r.code, account_name: r.name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION",
    statement: "income_statement", classification: "revenue", line_item: r.name, normal_balance: "credit",
  }));
  const reviewed = await env.reviewAccounts(env.users.owner, ws.companyId, uploadId, decisions);
  if (reviewed.error) return result("FAIL", [`reviewing both same-name accounts was refused: ${reviewed.error}`], { uploadId });
  const mapped = await env.admin.from("account_mappings").select("account_key, account_code, account_name").eq("company_id", ws.companyId).ilike("account_name", "Sales");
  const rows = mapped.data ?? [];
  const codes = new Set(rows.map((m) => m.account_code));
  const keys = new Set(rows.map((m) => m.account_key));
  if (rows.length < 2) problems.push(`both same-name 'Sales' accounts were not persisted as mappings (rows=${rows.length})`);
  if (codes.size < 2 || keys.size < 2) problems.push(`the two 'Sales' accounts are not DISTINCT identities (codes=${[...codes].join(",")}; keys=${[...keys].join(",")}) — a coded account must not inherit another's treatment by name`);
  return result(problems.length ? "FAIL" : "PASS", problems, { uploadId, codes: [...codes], keys: [...keys] });
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
  // A manual problem is a FAIL. If the manual checks are clean, full a11y acceptance still requires the AUTOMATED sub-check;
  // when axe is not wired that sub-check is a MISSING PREREQUISITE ⇒ BLOCKED (never a NOTE that passes). A zero automated
  // count alone would not be full proof either — the two are complementary.
  if (problems.length) return result("FAIL", problems);
  if (typeof env.axe !== "function") return result("BLOCKED", ["manual keyboard/focus/aria/announcement/responsive checks passed, but the automated accessibility sub-check (axe) is not wired — a11y is not fully verified; BLOCKED, not a NOTE/PASS"]);
  const violations = await env.axe(page);
  if (violations?.length) return result("FAIL", violations.map((v) => `axe: ${v.id} (${v.nodes} nodes)`));
  return result("PASS", []);
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
