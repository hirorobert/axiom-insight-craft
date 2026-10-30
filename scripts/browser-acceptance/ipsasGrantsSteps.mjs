// The grants part of the IPSAS browser journey (scripts/browser-acceptance/ipsasJourney.mjs). Non-production; identity is simulated by the
// loopback bridge. Uses the journey's helpers so the checks, evidence and results are one run.
//
//   chain       agreements with obligations and satisfaction evidence typed in; the server's revenue, liability and receivable appear;
//               cash received is changed and revenue does not move; a reviewer confirms; the draft note and an empty task list follow
//   reopen      leaving and reopening restores the register from the server alone
//   race        another writer saves meanwhile; the page's save is refused by name, the edit is kept, reloading adopts the server's version
//   lost        a response is dropped after the server recorded it; the retry reuses the ORIGINAL request identity (one revision)
//   tamper      direct RPC calls: a preparer cannot confirm; forged confirmation, totals and period in a saved payload change nothing

const A = { ref: "DONOR-X-HEALTH", grantor: "Donor X", cons: "12,000,000.00", cash: "7,500,000.00", prior: "2,000,000.00" };
const COMPLEXITIES = ["variableConsideration", "financing", "agent", "nonCash", "modification", "creditLoss", "foreignCurrency"];
const BASIS = "Clause 4 sets the deliverables and a refund on non-delivery";
const CX_BASIS = "No variable amounts, financing, agency, in-kind resources, modification, collection doubt or foreign currency";

/** Observe this operation, without changing requests/responses or invoking a component handler.
 * Both the receipt and the component's subsequent authoritative context must name the
 * same new revision. Old saved banners and an already-disabled button prove nothing.
 */
export async function saveGrantsAndReadBack(p) {
  await p.evaluate(() => {
    const real = window.fetch;
    const state = { saves: [], contexts: [], failure: null };
    window.__grantsSaveProbe = state;
    window.__restoreGrantsSaveProbe = () => { window.fetch = real; };
    window.fetch = async (...args) => {
      const [input, options] = args;
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const saving = /\/rpc\/ipsas_save_grants(?:\?|$)/.test(url);
      const reading = /\/rpc\/ipsas_grants_context(?:\?|$)/.test(url);
      let sent = null;
      if (saving) {
        sent = JSON.parse(options?.body ?? "{}");
        state.saves.push({ requestId: sent.p_request_id, expectedId: sent.p_expected_id, response: null });
      }
      const response = await real(...args);
      if (saving || reading) {
        // Awaiting a clone does not consume the application's response body.
        const body = await response.clone().json();
        if (saving) state.saves[state.saves.length - 1].response = body;
        else state.contexts.push(body);
      }
      return response;
    };
  });
  try {
    await p.click({ text: "Save grants" });
    return await p.waitFor(() => {
      const probe = window.__grantsSaveProbe;
      if (probe?.saves.length !== 1) return false;
      const save = probe.saves[0], receipt = save.response;
      if (receipt && receipt.outcome !== "recorded") throw new Error(`save refused: ${receipt.outcome}`);
      if (!receipt?.revisionId || receipt.revisionId === save.expectedId) return false;
      const readback = probe.contexts.find(c => c.outcome === "available" && c.register?.id === receipt.revisionId);
      if (!readback) return false;
      if (document.querySelector('[data-grants-revision]')?.getAttribute('data-grants-revision') !== receipt.revisionId) return false;
      const button = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Save grants");
      // The scripted save has no intervening edits. Disabled + saved banner after the
      // matching rendered revision means React adopted the read-back, not merely its receipt.
      return button?.disabled && document.body.innerText.includes("This is the server's recorded version")
        && !document.body.innerText.includes("Saving…") && document.querySelector('[data-testid="gr0-figures"]')
        ? { requestId: save.requestId, revisionId: receipt.revisionId } : false;
    }, [], { timeout: 30000, label: "this grant save receipt and matching authoritative read-back" });
  } finally {
    await p.evaluate(() => { window.__restoreGrantsSaveProbe?.(); delete window.__restoreGrantsSaveProbe; });
  }
}

export async function grantsChain(j) {
  const { check, open, go, set, type, val, tab, text, nextStep, shot, rpc, seed, log } = j;
  const fillGrant = async (p, i, spec) => {
    await type(p, `gr${i}-ref`, spec.ref); await type(p, `gr${i}-grantor`, spec.grantor); await type(p, `gr${i}-agr`, `Signed agreement for ${spec.ref}`);
    if ((await set(p, `gr${i}-class`, spec.classification)) !== true) return `no classification select for ${spec.ref}`;
    await type(p, `gr${i}-basis`, BASIS); await type(p, `gr${i}-cev`, "Agreement clauses 4 and 9");
    await type(p, `gr${i}-cons`, spec.cons); await type(p, `gr${i}-rec`, spec.cons); await type(p, `gr${i}-cash`, spec.cash);
    if (spec.prior) { await type(p, `gr${i}-prior`, spec.prior); await type(p, `gr${i}-priorev`, "Issued grant schedule for the previous year"); }
    for (const [n, o] of (spec.obligations ?? []).entries()) {
      await p.click({ text: "Add an obligation" });
      await p.waitForSelector(`#gr${i}-o${n}-id`);
      await type(p, `gr${i}-o${n}-label`, o.label); await type(p, `gr${i}-o${n}-alloc`, o.alloc); await type(p, `gr${i}-o${n}-sat`, o.sat);
      if (o.basis) { await set(p, `gr${i}-o${n}-basis`, o.basis); await type(p, `gr${i}-o${n}-ev`, o.evidence); }
    }
    for (const k of COMPLEXITIES) if ((await set(p, `gr${i}-cx-${k}`, "no")) !== true) return `no complexity select ${k}`;
    await type(p, `gr${i}-cxb`, CX_BASIS);
    return true;
  };
  const figures = (p, i) => p.evaluate((x) => document.querySelector(`[data-testid="gr${x}-figures"]`)?.innerText ?? "", i);
  const saveGrants = saveGrantsAndReadBack;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ctx = (as = "owner") => rpc(as, "ipsas_grants_context", { p_company_id: seed.companyId, p_period_year: seed.periodYear });

  log("\n== Grants and revenue: from agreement to note");
  const preparer = await open();
  j.setPage(preparer);
  await check("grants: the page says the period is read from the certified trial balance, offers only that period's classifications, and states that cash and spending never decide revenue", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    await tab(preparer, "Complete preparation");
    await preparer.waitForText("Grants and revenue");
    const t = await text(preparer);
    await preparer.click({ text: "Add a grant" });
    await preparer.waitForSelector("#gr0-class");
    const opts = await preparer.evaluate(() => [...document.querySelectorAll("#gr0-class option")].map((o) => o.value).filter(Boolean));
    return t.includes("read from the certified trial balance, not typed") && t.includes("2026-01-01") && t.includes("Cash received and money spent never decide it")
      && opts.includes("binding-arrangement") && !opts.includes("restriction-only") ? true : { opts };
  });
  await check("grants: two agreements with obligations, satisfaction evidence, complexity answers and the trial-balance accounts are typed in and saved; the server calculates revenue, liability and receivable", async () => {
    await type(preparer, "gtb-rev", j.accounts.rev.join(", ")); await type(preparer, "gtb-liab", j.accounts.liab.join(", ")); await type(preparer, "gtb-recv", j.accounts.recv.join(", "));
    let r = await fillGrant(preparer, 0, { ...A, classification: "binding-arrangement", obligations: [
      { label: "Clinic equipment delivered", alloc: "5,000,000.00", sat: "5,000,000.00", basis: "milestone-delivered", evidence: "Grantor acceptance letter" },
      { label: "Outreach sessions", alloc: "4,000,000.00", sat: "1,500,000.00", basis: "output-measure", evidence: "Delivery report Q3" },
      { label: "Final evaluation", alloc: "3,000,000.00", sat: "0.00" }] });
    if (r !== true) return r;
    await preparer.click({ text: "Add a grant" }); await preparer.waitForSelector("#gr1-ref");
    r = await fillGrant(preparer, 1, { ref: "DONOR-Y-UNRESTRICTED", grantor: "Donor Y", cons: "2,000,000.00", cash: "2,000,000.00", classification: "without-binding-no-present-obligation" });
    if (r !== true) return r;
    if ((await set(preparer, "ga-transition_47", "no")) !== true) return "no transition answer";
    await type(preparer, "ga-transition_47-t", "The prior period was already under the new revenue standard"); await type(preparer, "ga-transition_47-e", "Prior issued statements and board minute");
    await shot(preparer, "g1-filled");
    await saveGrants(preparer);
    const f0 = await figures(preparer, 0), f1 = await figures(preparer, 1);
    return f0.includes("revenue this period 4,500,000.00") && f0.includes("cumulative 6,500,000.00") && f0.includes("unfulfilled obligation 5,500,000.00") && f0.includes("receivable 4,500,000.00")
      && f1.includes("revenue this period 2,000,000.00") && f1.includes("unfulfilled obligation 0.00") && f1.includes("receivable 0.00") ? true : { f0, f1 };
  });
  await check("grants: changing the cash received changes the receivable but NOT the revenue; restoring it restores both", async () => {
    await type(preparer, "gr0-cash", "12,000,000.00"); await saveGrants(preparer);
    const more = await figures(preparer, 0);
    await type(preparer, "gr0-cash", "7,500,000.00"); await saveGrants(preparer);
    const back = await figures(preparer, 0);
    return more.includes("revenue this period 4,500,000.00") && more.includes("receivable 0.00") && back.includes("revenue this period 4,500,000.00") && back.includes("receivable 4,500,000.00") ? true : { more, back };
  });
  await check("grants: before a reviewer confirms, the note says so and the open matters name who must act", async () => {
    await tab(preparer, "Review report"); await sleep(300);
    const t = await text(preparer);
    return t.includes("Grant revenue note (draft)") && t.includes("await confirmation") && t.includes("Grant assessment unconfirmed") && t.includes("Who: reviewer") && !/binding arrangement with performance obligations/.test(t) ? true : t.slice(-1500);
  });
  const partner = await open();
  j.setPage(partner);
  await check("grants: a reviewer confirms each assessment; the draft note then states the classification in words and totals match the trial balance; the page reports no open matter anywhere", async () => {
    await go(partner, "partner", "IPSAS accrual, 2026");
    await tab(partner, "Complete preparation");
    await partner.click({ text: "Confirm this assessment" }); await partner.waitForText("Assessment confirmed", { timeout: 20000 }); await sleep(300);
    await partner.click({ text: "Confirm this assessment" }); await sleep(800);
    await tab(partner, "Review report"); await sleep(400);
    const t = (await text(partner)).replace(/\n/g, " ");
    const next = await nextStep(partner);
    await shot(partner, "g2-grants-review");
    return t.includes("binding arrangement with performance obligations") && t.includes("no binding arrangement and no present obligation") && /Total[\s\S]{0,40}TZS 6,500,000\.00[\s\S]{0,30}TZS 5,500,000\.00[\s\S]{0,30}TZS 4,500,000\.00/.test(t)
      && t.includes("No open grant matters") && next.includes("no open matters") ? true : { next, hasTotals: /6,500,000\.00/.test(t) };
  });
  j.setPage(preparer);
  await check("grants: reopening restores the register from the server alone, with the same confirmed state", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    await tab(preparer, "Complete preparation"); await preparer.waitForSelector("#gr0-ref");
    const ref = await val(preparer, "gr0-ref"), cons = await val(preparer, "gr0-cons"), sat = await val(preparer, "gr0-o1-sat"), confirmed = (await text(preparer)).includes("Assessment confirmed");
    return ref === "DONOR-X-HEALTH" && cons === "12,000,000.00" && sat === "1,500,000.00" && confirmed && (await nextStep(preparer)).includes("no open matters") ? true : { ref, cons, sat, confirmed };
  });
}

export async function grantsHostile(j) {
  const { check, go, type, val, tab, text, rpc, seed, shot, log, preparer } = j;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ctx = (as = "owner") => rpc(as, "ipsas_grants_context", { p_company_id: seed.companyId, p_period_year: seed.periodYear });
  log("\n== Grants: concurrency, lost responses, tampering");
  await check("grants race: another writer saves meanwhile; the page's save is refused by name, the edit is kept, and reloading adopts the server's version", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    await tab(preparer, "Complete preparation"); await preparer.waitForSelector("#gr0-ref");
    await type(preparer, "gr0-ref", "DONOR-X-HEALTH (mine)");
    const c = await ctx();
    const theirs = JSON.parse(JSON.stringify(c.register.payload)); theirs.grants[0].reference = "DONOR-X-HEALTH (theirs)";
    const saved = await rpc("owner", "ipsas_save_grants", { p_company_id: seed.companyId, p_period_year: seed.periodYear, p_payload: theirs, p_expected_id: c.register.id, p_request_id: crypto.randomUUID() });
    if (saved.outcome !== "recorded") return saved;
    await preparer.click({ text: "Save grants" });
    await preparer.waitForText("Someone saved a newer version", { timeout: 20000 });
    const kept = await val(preparer, "gr0-ref");
    await shot(preparer, "g3-stale");
    await preparer.click({ text: "Discard grant edits and reload the saved version" }); await sleep(600);
    const adopted = await val(preparer, "gr0-ref");
    return kept === "DONOR-X-HEALTH (mine)" && adopted === "DONOR-X-HEALTH (theirs)" ? true : { kept, adopted };
  });
  await check("grants lost: a response dropped after the server recorded it is reported as unconfirmed, and the retry reuses the ORIGINAL request identity (one revision, replay acknowledged)", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    await tab(preparer, "Complete preparation"); await preparer.waitForSelector("#gr0-ref");
    await preparer.evaluate(() => {
      const real = window.fetch.bind(window); window.__sentG = []; let dropped = false;
      window.fetch = async (u, o) => {
        if (String(u).includes("/rpc/ipsas_save_grants")) {
          window.__sentG.push(JSON.parse(o.body).p_request_id);
          const r = await real(u, o);
          if (!dropped) { dropped = true; await r.text(); throw new TypeError("Failed to fetch"); } // the server recorded it; the answer never arrives
          return r;
        }
        return real(u, o);
      };
    });
    const before = (await ctx()).register.id;
    await type(preparer, "gr0-priorev", "Issued grant schedule for the previous year, re-checked");
    await preparer.click({ text: "Save grants" });
    await preparer.waitForText("We could not confirm whether this was saved", { timeout: 20000 });
    const recorded = (await ctx()).register.id;
    await preparer.click({ text: "Send the same request again" });
    await preparer.waitForText("had already been recorded", { timeout: 20000 });
    const sent = await preparer.evaluate(() => window.__sentG), after = (await ctx()).register.id;
    await shot(preparer, "g4-lost-retry");
    return sent.length === 2 && sent[0] === sent[1] && recorded !== before && after === recorded ? true : { sent, before, recorded, after };
  });
  await check("grants tamper: a preparer cannot confirm; a saved payload that forges confirmation, totals, period and the trial balance changes nothing the server computes", async () => {
    const c = await ctx();
    const denied = await rpc("preparer", "ipsas_confirm_grant", { p_company_id: seed.companyId, p_period_year: seed.periodYear, p_grant_id: c.register.payload.grants[0].grantId, p_expected_revision_id: c.register.id, p_request_id: crypto.randomUUID() });
    const forged = JSON.parse(JSON.stringify(c.register.payload));
    Object.assign(forged, { period: { start: "2025-01-01", end: "2025-12-31" }, tb: { revenueMinor: "1" }, totals: { periodRevenueMinor: "999999999999" }, assessment: { state: "ready-for-review", codes: [] }, confirmedGrants: { x: true } });
    Object.assign(forged.grants[0], { periodRevenueMinor: "999999999999", assessmentConfirmed: true, confirmed: true });
    const r = await rpc("partner", "ipsas_save_grants", { p_company_id: seed.companyId, p_period_year: seed.periodYear, p_payload: forged, p_expected_id: c.register.id, p_request_id: crypto.randomUUID() });
    const a = r.live?.assessment;
    return denied.outcome === "forbidden" && r.outcome === "recorded" && a.model === "ipsas47" && r.live.period.start === "2026-01-01" && a.grants[0].periodRevenueMinor === "450000000" && a.totals.periodRevenueMinor === "650000000" ? true : { denied: denied.outcome, model: a?.model, grants: a?.grants?.[0] };
  });
}
