// NON-PRODUCTION browser-acceptance driver. Imported into the harness page by the acceptance run
// (`await import("/dev-harness/e2e/driver.mjs")`); it drives the REAL workspace UI through its own controls
// and reads only what the UI shows. Nothing here writes to a database directly. Identity is the harness's
// LOCAL_SIMULATED_IDENTITY (not GoTrue). Lives outside src/ and is never part of the production bundle.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const $ = (id) => document.querySelector(`[data-testid="${id}"]`);
export const text = (id) => ($(id)?.innerText ?? "").replace(/\s+/g, " ").trim();

export function nativeSet(el, value) {
  const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
}

export async function stage(slug) {
  const tab = document.querySelector(`[data-stage="${slug}"]`);
  if (!tab) throw new Error(`no stage tab ${slug}`);
  tab.click();
  await sleep(450);
}

async function attach(file) {
  const input = $("evidence-file");
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(350);
}

/** Add one evidence file through the panel's own controls. `bytes` (a Uint8Array) makes it a workbook. */
export async function addEvidence({ type, role = "CURRENT", name, csv, bytes, sheet, currency = "TZS", scale = "2" }) {
  await stage("sources");
  nativeSet($("evidence-type"), type);
  nativeSet($("evidence-role"), role);
  nativeSet($("evidence-currency"), currency);
  nativeSet($("evidence-scale"), scale);
  await sleep(60);
  const file = bytes ? new File([bytes], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) : new File([new TextEncoder().encode(csv)], name, { type: "text/csv" });
  await attach(file);
  let picker = null;
  if (bytes) {
    picker = $("sheet-picker") ? [...$("evidence-sheet").options].map((o) => o.textContent) : null;
    if (sheet) nativeSet($("evidence-sheet"), sheet);
    await sleep(100);
  }
  const add = $("evidence-add");
  if (add.disabled) return { kind: "ADD_DISABLED", picker };
  add.click();
  await sleep(900);
  const res = $("evidence-result");
  return { kind: res?.dataset.resultKind, text: text("evidence-result").slice(0, 260), picker };
}

export async function save() {
  const b = $("save-button");
  if (!b) return { status: text("save-status"), message: "no save button" };
  b.click();
  await sleep(2600);
  return { status: text("save-status"), message: text("save-message") };
}

export const versionLabel = () => text("workspace-context") + " | " + (document.body.innerText.match(/Internal preview[^\n]*/)?.[0] ?? "");

export async function publication(state, reason) {
  await stage("outputs");
  const reasonEl = $("publication-reason");
  if (reasonEl) nativeSet(reasonEl, reason);
  await sleep(200);
  const btn = $(`publication-${state.toLowerCase()}`);
  if (!btn) return { message: "no button", controls: text("publication-controls").slice(0, 200) };
  if (btn.disabled) return { message: "button disabled", controls: text("publication-controls").slice(0, 300) };
  btn.click();
  await sleep(1800);
  return { message: text("publication-message"), readiness: text("server-readiness").slice(0, 400) };
}

// ── data for the "multicash" scenario (matches dev-harness/fixture.ts) ───────────────
const H_LEDGER = "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\n";
export const DATA = {
  // gross 6,300,000 (restricted 900,000), ECL -100,000, overdraft 200,000 -> cash-flow closing 6,100,000, net SFP 6,200,000
  cashMap: "account_key,category,effect,include_in_cash_flow,note\n1000,BANK_ACCOUNT,ADD,Y,\n1010,MOBILE_MONEY,ADD,Y,\n1020,CASH_ON_HAND,ADD,Y,\n1030,DESIGNATED_PROJECT,ADD,Y,donor project\n1090,CASH_ECL_ALLOWANCE,ADD,N,allowance is a negative asset balance\n2100,OVERDRAFT,SUBTRACT,Y,repayable on demand\n",
  // per-account movement: 1000 +900,000; 1030 +200,000; 2100 overdraft +100,000 (a cash-perimeter reduction) -> net +1,000,000 = 6.1M - 5.1M
  ledgerCurrent: H_LEDGER + "T1,2025-03-01,1000,Customer receipts,12500000,,OPERATING,Receipts from customers\nT2,2025-04-01,1000,Supplier and staff payments,,11600000,OPERATING,Payments to suppliers\nT3,2025-06-01,1030,Donor project receipt,200000,,FINANCING,Donor grant received\nT4,2025-07-01,2100,Overdraft drawn,,100000,FINANCING,Net overdraft drawn\n",
  ledgerComparative: H_LEDGER + "P1,2024-03-01,1000,Customers,10000000,,OPERATING,Receipts from customers\nP2,2024-04-01,1000,Suppliers,,9000000,OPERATING,Payments to suppliers\nP3,2024-06-01,1030,Donor project receipt,100000,,FINANCING,Donor grant received\nP4,2024-07-01,2100,Overdraft drawn,,50000,FINANCING,Net overdraft drawn\n",
  equityCurrent: "component,movement_type,amount,description\nShare Capital,OPENING_BALANCE,6000000,\nShare Capital,CLOSING_BALANCE,6000000,\nRetained Earnings,OPENING_BALANCE,500000,\nRetained Earnings,PROFIT_OR_LOSS,3000000,\nRetained Earnings,DIVIDENDS_OR_DISTRIBUTIONS,-3000000,\nRetained Earnings,CLOSING_BALANCE,500000,\n",
  equityComparative: "component,movement_type,amount,description\nShare Capital,OPENING_BALANCE,6000000,\nShare Capital,CLOSING_BALANCE,6000000,\nRetained Earnings,OPENING_BALANCE,500000,\nRetained Earnings,PROFIT_OR_LOSS,2450000,\nRetained Earnings,DIVIDENDS_OR_DISTRIBUTIONS,-2450000,\nRetained Earnings,CLOSING_BALANCE,500000,\n",
  notes: 'kind,key,title,body,applies_to_line_keys,checklist_ref,applicability\nPOLICY,basis,Basis of preparation,"These statements are prepared under the stated framework on the accrual basis.",,basis-of-preparation,\nPOLICY,policies,Significant accounting policies,"Receivables are carried net of expected credit losses; property is carried at cost less depreciation.",,accounting-policies,\nNOTE,receivables,Trade receivables,"Trade receivables are shown net of expected credit losses.",line:detail:sfp:1100,supporting-notes,\n',
};

/** Everything the complete-report scenario adds, in the order a preparer would. */
export async function addCompleteEvidence() {
  const out = {};
  out.map = await addEvidence({ type: "CASH_ACCOUNT_MAP", name: "cash-map.csv", csv: DATA.cashMap, currency: "", scale: "" });
  out.ledger = await addEvidence({ type: "TRANSACTION_LEDGER", name: "ledger-2025.csv", csv: DATA.ledgerCurrent });
  out.ledgerPrior = await addEvidence({ type: "TRANSACTION_LEDGER", role: "COMPARATIVE", name: "ledger-2024.csv", csv: DATA.ledgerComparative });
  out.eq = await addEvidence({ type: "EQUITY_MOVEMENTS", name: "equity-2025.csv", csv: DATA.equityCurrent });
  out.eqPrior = await addEvidence({ type: "EQUITY_MOVEMENTS", role: "COMPARATIVE", name: "equity-2024.csv", csv: DATA.equityComparative });
  out.notes = await addEvidence({ type: "NOTES_AND_POLICIES", name: "notes.csv", csv: DATA.notes, currency: "", scale: "" });
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, `${v.kind}: ${(v.text ?? "").slice(0, 110)}`]));
}

export function overflow() {
  const de = document.documentElement;
  const wide = [...document.querySelectorAll("body *")].filter((e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.right <= de.clientWidth + 1) return false;
    for (let p = e.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll" || o === "hidden") return false;
    }
    return true;
  });
  return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, escapes: wide.slice(0, 5).map((e) => e.tagName + "." + String(e.className).slice(0, 50)) };
}

// ── a real .xlsx built in the page with the same audited zip library the product reads with ─────────
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const COL = (i) => String.fromCharCode(65 + i);
/** sheets: [{ name, state?, rows: (string | {n: string} | null)[][] }] — strings are shared strings, {n} are numeric cells. */
export async function makeXlsx(sheets) {
  const { strToU8, zipSync } = await import("/node_modules/fflate/esm/browser.js");
  const sst = [];
  const sidx = (t) => {
    let i = sst.indexOf(t);
    if (i < 0) i = sst.push(t) - 1;
    return i;
  };
  const files = {};
  sheets.forEach((sh, si) => {
    const rows = sh.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => (c === null ? "" : typeof c === "string" ? `<c r="${COL(ci)}${ri + 1}" t="s"><v>${sidx(c)}</v></c>` : `<c r="${COL(ci)}${ri + 1}"><v>${c.n}</v></c>`)).join("")}</row>`).join("");
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  files["xl/workbook.xml"] = strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`);
  files["xl/sharedStrings.xml"] = strToU8(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sst.map((t) => `<si><t>${esc(t)}</t></si>`).join("")}</sst>`);
  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  files["xl/styles.xml"] = strToU8(`<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`);
  files["docProps/app.xml"] = strToU8("<Properties><Application>Microsoft Excel</Application></Properties>");
  return zipSync(files);
}

/** The budget as a workbook: a visible `Budget` sheet and a hidden `Scratch` sheet the reader must disclose. */
export async function budgetWorkbook() {
  const header = ["line_key", "line_label", "nature", "original_budget", "final_budget", "explanation"];
  return makeXlsx([
    { name: "Budget", rows: [header, ["line:detail:pl:4000", "Sales", "REVENUE", { n: "11000000" }, null, "Higher volumes than planned"], ["line:detail:pl:5000", "Cost of sales", "EXPENSE", { n: "6000000" }, null, ""], ["line:detail:pl:6000", "Operating expenses", "EXPENSE", { n: "2900000" }, null, "Marketing overspend"]] },
    { name: "Scratch", state: "hidden", rows: [["ignore me"]] },
  ]);
}
