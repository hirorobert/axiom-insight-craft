// NON-PRODUCTION acceptance phases. Each phase runs in the harness page for ONE simulated identity (LOCAL_SIMULATED_IDENTITY,
// not GoTrue) against the disposable PostgreSQL bridge, drives the real UI, and returns named pass/fail checks with the observed detail.
//
//   const p = await import("/dev-harness/e2e/phases.mjs"); await p.preparerBuildsAndSaves();
//
// Order (fresh database): preparerBuildsAndSaves → partnerPublishesV1 → partnerAddsXlsxBudget → secondSessionCorrects (tab 2, as
// preparer) → partnerHitsStaleConflict → partnerPublishesCorrected → roleMatrix (viewer/outsider/other company/disabled company)
// → incompleteRefusal → mobileSweep (375 px) → keyboardTabs.

import * as d from "./driver.mjs";

const B = "http://127.0.0.1:54999";
const check = (name, pass, detail) => ({ name, pass: !!pass, detail: detail === undefined ? undefined : String(detail).slice(0, 220) });
const result = (phase, checks) => ({ phase, pass: checks.every((c) => c.pass), failed: checks.filter((c) => !c.pass).map((c) => c.name), checks });

async function post(path, user, body) {
  const r = await fetch(B + path, { method: "POST", headers: { "content-type": "application/json", "x-sim-user": user }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
async function seed() {
  return JSON.parse((await post("/seed", "owner", {})).text);
}
async function reportRows(user, companyId) {
  const r = await post("/select/financial_statement_reports", user, { company_id: companyId });
  return r.status === 200 ? JSON.parse(r.text) : [];
}
const openRow = async (n) => {
  await d.stage("outputs");
  const sv = d.$("saved-versions");
  sv.open = true;
  await d.sleep(200);
  const row = [...sv.querySelectorAll("tr, li")].find((r) => new RegExp(`\\bv${n}\\b`).test(r.innerText) && r.querySelector("button"));
  row?.querySelector("button")?.click();
  await d.sleep(1800);
  return !!row;
};

export async function preparerBuildsAndSaves() {
  await d.sleep(2500);
  const c = [];
  const ev = await d.addCompleteEvidence();
  c.push(check("all six evidence files are accepted (CSV) with no diagnostics", Object.values(ev).every((v) => v.startsWith("ADDED: Added (valid) No diagnostics")), JSON.stringify(ev)));
  await d.stage("structure");
  c.push(check("statement set complete (cash flows and changes in equity present)", !/incomplete/i.test(document.querySelector("#fs-stage-panel").innerText)));
  await d.stage("validate");
  const v = document.querySelector("#fs-stage-panel").innerText.replace(/\s+/g, " ");
  c.push(check("no blocking or insufficient-evidence findings", /Blocking \(0\)/.test(v) && /Insufficient evidence \(0\)/.test(v), v.slice(150, 330)));
  const saved = await d.save();
  c.push(check("first save creates version 1", saved.status === "Saved · version 1", saved.message));
  await d.stage("outputs");
  c.push(check("server readiness: ready", d.$("server-readiness")?.dataset.serverReady === "yes"));
  c.push(check("the workspace and print header show the persisted version 1", /Version 1/.test(d.versionLabel()) && d.text("print-version") === "Version 1"));
  const attempt = await d.publication("REVIEWED", "Preparer attempting review");
  c.push(check("a preparer cannot mark Reviewed (server FORBIDDEN)", /FORBIDDEN/.test(attempt.message), attempt.message));
  const s = await seed();
  const rows = await reportRows("preparer", s.companyA);
  const args = { p_company_id: s.companyA, p_report_id: rows[0].report_id, p_report_version: 1, p_state: "REVIEWED", p_reason: "direct rpc bypass attempt" };
  for (const u of ["preparer", "viewer", "outsider", "ownerB"]) {
    const r = await post("/rpc/fs_set_publication_state", u, args);
    c.push(check(`direct RPC bypass refused for ${u}`, r.status === 400 && /FORBIDDEN/.test(r.text), r.text));
  }
  return result("preparerBuildsAndSaves", c);
}

export async function partnerPublishesV1() {
  await d.sleep(2500);
  const c = [];
  c.push(check("reload restores version 1", /Restored your saved work \(version 1\)/.test(d.text("restore-banner")) && d.text("save-status") === "Saved · version 1", d.text("restore-banner")));
  const rev = await d.publication("REVIEWED", "Partner review of version one");
  c.push(check("partner marks Reviewed", /Recorded as REVIEWED/.test(rev.message), rev.message));
  const fin = await d.publication("FINAL", "Partner final approval version one");
  c.push(check("partner marks Final", /Recorded as FINAL/.test(fin.message), fin.message));
  // exports
  const blobs = [];
  const orig = URL.createObjectURL;
  URL.createObjectURL = (b) => (blobs.push(b), orig.call(URL, b));
  const names = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { names.push(this.download); };
  for (const b of document.querySelectorAll("[data-testid=export-buttons] button")) { b.click(); await d.sleep(250); }
  HTMLAnchorElement.prototype.click = click;
  URL.createObjectURL = orig;
  const texts = await Promise.all(blobs.map((b) => b.text()));
  c.push(check("all exports are named for version 1", names.length >= 5 && names.every((n) => /-v1\./.test(n)), names.join(",")));
  const lineage = (t) => { try { return JSON.parse(t).lineage; } catch { return null; } };
  const jsons = names.map((n, i) => [n, texts[i]]).filter(([n]) => /\.json$/.test(n)).map(([, t]) => lineage(t));
  c.push(check("canonical, evidence and audit JSON carry the same lineage (report, version, hash, evaluation)", jsons.length === 3 && jsons.every((l) => l && JSON.stringify(l) === JSON.stringify(jsons[0])) && jsons[0].reportVersion === 1));
  c.push(check("CSV exports carry the lineage tag", texts.filter((t, i) => /\.csv$/.test(names[i])).every((t) => /report_lineage/.test(t))));
  return result("partnerPublishesV1", c);
}

export async function partnerAddsXlsxBudget() {
  await d.sleep(2500);
  const c = [];
  const bytes = await d.budgetWorkbook();
  const noSheet = await d.addEvidence({ type: "BUDGET", name: "budget-2025.xlsx", bytes });
  c.push(check("a workbook cannot be added until a sheet is chosen; the hidden sheet is labelled", noSheet.kind === "ADD_DISABLED" && noSheet.picker.includes("Scratch (hidden)"), JSON.stringify(noSheet.picker)));
  const ok = await d.addEvidence({ type: "BUDGET", name: "budget-2025.xlsx", bytes, sheet: "Budget" });
  c.push(check("the workbook is accepted with the hidden sheet disclosed", ok.kind === "ADDED" && /OTHER_HIDDEN_SHEETS/.test(ok.text), ok.text));
  const csv = "line_key,line_label,nature,original_budget,final_budget,explanation\nline:detail:pl:4000,Sales,REVENUE,11000000,,Higher volumes than planned\nline:detail:pl:5000,Cost of sales,EXPENSE,6000000,,\nline:detail:pl:6000,Operating expenses,EXPENSE,2900000,,Marketing overspend\n";
  const replay = await d.addEvidence({ type: "BUDGET", name: "budget-2025.csv", csv });
  c.push(check("the same content as CSV converges on the same identity (exact replay)", replay.kind === "EXACT_REPLAY", replay.text));
  const saved = await d.save();
  c.push(check("evidence added after a save is a new version (2)", saved.status === "Saved · version 2", saved.message));
  await d.stage("outputs");
  c.push(check("the budget comparison is shown from the report", /Sales original budget 11000000\.00 12000000\.00 1000000\.00/.test(d.text("budget-actual")), d.text("budget-actual").slice(0, 200)));
  c.push(check("server readiness: ready", d.$("server-readiness")?.dataset.serverReady === "yes"));
  const rev = await d.publication("REVIEWED", "Partner review of version two");
  const fin = await d.publication("FINAL", "Partner final approval version two");
  c.push(check("version 2 marked Reviewed then Final", /REVIEWED/.test(rev.message) && /FINAL/.test(fin.message), rev.message + " / " + fin.message));
  const opened = await openRow(1);
  c.push(check("version 1 opens as a read-only historical view under its own number and state", opened && /Viewing saved version 1 \(historical, final\)/.test(d.text("readonly-banner")) && d.text("print-version") === "Version 1" && /of version 1 — FINAL \(read-only\)/.test(d.text("publication-state")) && !d.$("save-button") && !d.$("server-readiness"), d.text("publication-state")));
  await d.stage("statements");
  c.push(check("no correction controls in a historical view", !d.$("correct-evidence-open")));
  const back = d.$("return-to-draft");
  back?.click();
  await d.sleep(1200);
  return result("partnerAddsXlsxBudget", c);
}

/** Tab 2, as preparer: two evidence corrections saved as ONE atomic group. */
export async function secondSessionCorrects() {
  await d.sleep(2500);
  const c = [];
  await d.stage("sources");
  c.push(check("restored at version 2", /version 2/.test(d.text("restore-banner")), d.text("restore-banner")));
  const correct = async (needle, rowN, col, val) => {
    const li = [...document.querySelectorAll("[data-evidence-id]")].find((i) => i.innerText.includes(needle) && i.innerText.includes("Current") && i.getAttribute("data-evidence-used") === "yes");
    li.querySelector("[data-testid=correct-evidence-open]").click();
    await d.sleep(300);
    d.nativeSet(li.querySelector("[data-testid=correct-row]"), String(rowN));
    d.nativeSet(li.querySelector("[data-testid=correct-column]"), col);
    await d.sleep(200);
    d.nativeSet(li.querySelector("[data-testid=correct-value]"), val);
    d.nativeSet(li.querySelector("[data-testid=correct-rationale]"), "Description clarified after review");
    await d.sleep(200);
    li.querySelector("[data-testid=correct-submit]").click();
    await d.sleep(900);
    return li.querySelector("[data-testid=correct-message]")?.innerText ?? "";
  };
  const m1 = await correct("Cash transaction ledger", 1, "description", "Customer receipts (corrected)");
  const m2 = await correct("Equity movements", 3, "description", "Opening retained earnings agreed");
  c.push(check("both corrections are pending, unsaved, as new evidence versions", /corrected as version 2/.test(m1) && /corrected as version 2/.test(m2) && d.text("save-status") === "Unsaved changes"));
  const saved = await d.save();
  c.push(check("one save records both corrections atomically as contiguous versions (3 and 4)", saved.status === "Saved · version 4", saved.message));
  return result("secondSessionCorrects", c);
}

/** Tab 1, still at version 2 while tab 2 saved version 4. */
export async function partnerHitsStaleConflict() {
  const c = [];
  d.$("return-to-draft")?.click();
  await d.sleep(1200);
  const notes = d.DATA.notes + 'DISCLOSURE,going-concern,Going concern,"Management has assessed the entity as a going concern for twelve months.",,,\n';
  const r = await d.addEvidence({ type: "NOTES_AND_POLICIES", name: "notes.csv", csv: notes, currency: "", scale: "" });
  const s = await d.save();
  c.push(check("the stale session's edit is added locally", r.kind === "ADDED"));
  c.push(check("a stale save is refused before any write, naming both versions", /Conflict/.test(s.status) && /server is at version 4, this session last saw 2/.test(s.message) && !d.$("save-button") && !!d.$("save-reload"), s.message));
  const rows = await reportRows("partner", (await seed()).companyA);
  c.push(check("the server still holds exactly versions 1-4", JSON.stringify(rows.map((x) => x.report_version).sort()) === "[1,2,3,4]", JSON.stringify(rows.map((x) => x.report_version))));
  d.$("save-reload").click();
  await d.sleep(2500);
  c.push(check("discard-and-reload restores version 4 with the corrected evidence in use", d.text("save-status") === "Saved · version 4" && /Restored your saved work \(version 4\)/.test(d.text("restore-banner"))));
  await d.stage("sources");
  const used = [...document.querySelectorAll("[data-evidence-id]")].filter((i) => /\(cor/.test(i.innerText) && i.getAttribute("data-evidence-used") === "yes").length;
  c.push(check("the two corrected evidence versions are the ones in use", used === 2, used));
  return result("partnerHitsStaleConflict", c);
}

export async function partnerPublishesCorrected() {
  const c = [];
  const rev = await d.publication("REVIEWED", "Partner review of corrected version");
  const fin = await d.publication("FINAL", "Partner final approval corrected");
  c.push(check("the corrected version 4 is accepted as Reviewed then Final", /REVIEWED/.test(rev.message) && /FINAL/.test(fin.message), rev.message + " / " + fin.message));
  return result("partnerPublishesCorrected", c);
}

export async function roleMatrix(role) {
  await d.sleep(2500);
  await d.stage("outputs");
  const s = await seed();
  const c = [];
  const status = d.text("save-status");
  if (role === "viewer") {
    c.push(check("viewer sees the saved report", /Saved · version 4/.test(status), status));
    c.push(check("the workspace is explicitly read-only: \"Read-only access\" is explained, no Save, no enabled publication buttons", !!d.$("read-only-access") && !d.$("save-button") && ["reviewed", "final", "draft"].every((k) => d.$("publication-" + k)?.matches(":disabled")) && d.$("publication-reason")?.matches(":disabled") === true, d.text("read-only-access")));
    await d.stage("sources");
    const fieldset = d.$("evidence-form-fields");
    const controls = [...fieldset.querySelectorAll("input, select, button")];
    c.push(check("the evidence form is effectively disabled: the fieldset and every control inside it match :disabled", fieldset.matches(":disabled") && controls.length > 0 && controls.every((el) => el.matches(":disabled")), controls.length + " controls"));
    // Force it anyway: attach a file to the (disabled) input, fire change, click Add and submit the form programmatically.
    const before = document.querySelectorAll("[data-evidence-id]").length;
    const input = d.$("evidence-file");
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode(d.DATA.notes)], "viewer-forced.csv", { type: "text/csv" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await d.sleep(300);
    d.$("evidence-add").click();
    d.$("evidence-add").closest("form").requestSubmit();
    await d.sleep(800);
    const kind = d.$("evidence-result")?.dataset.resultKind;
    c.push(check("a forced submit adds nothing: no evidence row, none unsaved, no Add result other than a refusal, no Save", document.querySelectorAll("[data-evidence-id]").length === before && ![...document.querySelectorAll("[data-evidence-id]")].some((e) => /Not saved/.test(e.innerText)) && (kind === undefined || kind === "REJECTED") && !d.$("save-button"), "result=" + kind));
    await d.stage("statements");
    c.push(check("no correction controls", !d.$("correct-evidence-open")));
    await d.stage("review");
    const forms = [...document.querySelectorAll("form[data-read-only=yes]")];
    c.push(check("every decision form is read-only (submit disabled)", forms.length > 0 && forms.every((f) => f.querySelector("button[type=submit]").matches(":disabled") && f.querySelector("fieldset").matches(":disabled")), forms.length + " forms"));
    const s = await seed();
    const rows0 = await reportRows("partner", s.companyA);
    const direct = await post("/rpc/fs_set_publication_state", "viewer", { p_company_id: s.companyA, p_report_id: rows0[0].report_id, p_report_version: 4, p_state: "REVIEWED", p_reason: "direct rpc as viewer" });
    c.push(check("the server still refuses a viewer's direct write (defence in depth)", direct.status === 400 && /FORBIDDEN/.test(direct.text), direct.text));
    c.push(check("the server still holds four versions", (await reportRows("partner", s.companyA)).length === 4));
  } else if (role === "outsider" || role === "ownerB") {
    c.push(check(`${role} on company A: read-only, no saved versions, no publication controls`, /Read-only/.test(status) && !d.$("saved-versions") && !d.$("publication-controls") && !d.$("save-button"), status));
    const rows = await reportRows(role, s.companyA);
    const ev = await post("/select/financial_evidence_batches", role, { company_id: s.companyA });
    c.push(check(`${role}: zero rows readable`, rows.length === 0 && JSON.parse(ev.text).length === 0));
  } else if (role === "ownerB-on-B") {
    const banner = document.querySelector("[data-persistence-state]");
    c.push(check("company B (not allow-listed): honest feature-disabled state", /not enabled/.test(status) && banner?.getAttribute("data-persistence-state") === "UNAVAILABLE" && !d.$("save-button"), status));
  }
  return result("roleMatrix:" + role, c);
}

export async function incompleteRefusal() {
  await d.sleep(2500);
  const c = [];
  c.push(check("a source change that no longer reproduces the stored version says so and starts fresh", /could not be restored for editing/.test(d.text("restore-banner")), d.text("restore-banner")));
  const saved = await d.save();
  c.push(check("saving creates version 5", saved.status === "Saved · version 5", saved.message));
  await d.stage("outputs");
  const ready = d.$("server-readiness");
  c.push(check("the server lists the unmet requirements", ready?.dataset.serverReady === "no" && /MISSING_STATEMENT:STATEMENT_OF_CASH_FLOWS/.test(ready.innerText) && /DISCLOSURE_CHECKLIST_INCOMPLETE/.test(ready.innerText), ready?.innerText.slice(0, 160)));
  c.push(check("Reviewed and Final are disabled in the UI", d.$("publication-reviewed").disabled && d.$("publication-final").disabled));
  const s = await seed();
  const rows = await reportRows("partner", s.companyA);
  const rid = rows[0].report_id;
  for (const st of ["REVIEWED", "FINAL"]) {
    const r = await post("/rpc/fs_set_publication_state", "partner", { p_company_id: s.companyA, p_report_id: rid, p_report_version: 5, p_state: st, p_reason: "direct rpc on incomplete version" });
    c.push(check(`direct RPC ${st} on the incomplete version is refused (PT409 BLOCKED)`, /PT409/.test(r.text) && /BLOCKED/.test(r.text), r.text));
  }
  const back = await post("/rpc/fs_set_publication_state", "partner", { p_company_id: s.companyA, p_report_id: rid, p_report_version: 4, p_state: "DRAFT", p_reason: "attempt to change a final version" });
  c.push(check("a Final version cannot be changed", /immutable/.test(back.text), back.text));
  return result("incompleteRefusal", c);
}

export async function mobileSweep() {
  await d.sleep(2500);
  const c = [];
  c.push(check("viewport is 375 px", innerWidth === 375, innerWidth));
  for (const s of ["sources", "structure", "statements", "notes", "validate", "review", "outputs"]) {
    await d.stage(s);
    const o = d.overflow();
    c.push(check(`no horizontal overflow at 375 px: ${s}`, o.scrollWidth <= o.clientWidth && o.escapes.length === 0, JSON.stringify(o)));
  }
  return result("mobileSweep", c);
}

export function tabState() {
  const t = [...document.querySelectorAll("[role=tab]")];
  return { selected: t.find((x) => x.getAttribute("aria-selected") === "true")?.dataset.stage, focused: document.activeElement?.dataset?.stage, tabindex: t.map((x) => x.tabIndex).join(",") };
}
