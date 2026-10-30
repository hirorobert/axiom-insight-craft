// The property, plant and equipment part of the IPSAS browser journeys, shared by the loopback-bridge journey
// (scripts/browser-acceptance/ipsasJourney.mjs, SIMULATED identity) and the authenticated local-stack journey
// (scripts/e2e/ipsasAuthJourney.mjs, real Auth, PostgREST, RLS and Storage). The steps use only the helpers they are given, so what
// differs between the two is exactly identity and services, never the steps. j.accounts names the trial-balance account keys.

export async function ppeChain(j) {
  const { check, open, go, set, type, val, tab, text, nextStep, shot, rpc, seed, log, serverContext } = j;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  log("== Preparer builds the chain");
  const preparer = await open();
  j.setPage(preparer);
  await check("the page opens for a signed-in preparer: five areas, one next step, draft label, nothing invented", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    const tabs = await preparer.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent));
    const t = await text(preparer);
    await shot(preparer, "01-opened");
    return JSON.stringify(tabs) === JSON.stringify(["Bring information", "Complete preparation", "Review report", "Approve", "Issue & history"])
      && (await nextStep(preparer)).includes("bring in the trial balance") && t.includes("Draft preparation only") && t.includes("unknown") ? true : { tabs, next: await nextStep(preparer) };
  });
  await check("bring: mapping the PPE accounts, the policy and last year's printed figure are entered by typing; the preparer cannot confirm", async () => {
    await type(preparer, "tb-ppe", j.accounts.ppe.join(", ")); await type(preparer, "tb-dep", j.accounts.dep.join(", "));
    if ((await set(preparer, "conv", "daily")) !== true) return "no convention select";
    await type(preparer, "prior-amt", "16,000.00"); await type(preparer, "prior-loc", "Statement of financial position, p. 12");
    await preparer.click({ text: "Save prior figure" });
    await preparer.waitForText("This is the server's recorded version", { timeout: 20000 });
    const disabled = await preparer.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Confirm against the printed page"))?.disabled);
    return disabled === true && (await text(preparer)).includes("Confirmation needs a reviewer") ? true : { disabled };
  });
  await check("prepare: one asset class with the entity's own estimates, the register tie and five answered questions saves on the server", async () => {
    await tab(preparer, "Complete preparation");
    await preparer.click({ text: "Add an asset class" });
    await preparer.waitForSelector("#c0-label");
    const steps = [["c0-label", "Equipment"], ["c0-acc", j.accounts.ppe.join(", ")], ["c0-openingg", "20,000.00"], ["c0-openingd", "4,000.00"], ["c0-closingg", "20,000.00"], ["c0-closingd", "6,000.00"],
      ["c0-dep", "2,000.00"], ["c0-src", "Fixed asset register FY2026"], ["c0-i0l", "E1"], ["c0-i0c", "20,000.00"], ["c0-i0r", "0.00"], ["c0-i0o", "4,000.00"], ["c0-i0y", "10"],
      ["c0-rat", "Ten years of single-shift use expected"], ["c0-ev", "Maintenance plan MP-2026"]];
    for (const [id, v] of steps) await type(preparer, id, v);
    for (const [id, v] of [["c0-model", "cost"], ["c0-cs", "calculated"]]) if ((await set(preparer, id, v)) !== true) return `no ${id}`;
    for (const q of ["heritage_assets", "infrastructure_assets", "impairment_indicators", "held_for_sale", "commitments_restrictions"]) {
      if ((await set(preparer, `q-${q}`, "no")) !== true) return `no q-${q}`;
      await type(preparer, `q-${q}-t`, "Checked the asset register and the board minutes"); await type(preparer, `q-${q}-e`, "Register FY2026 and minutes");
    }
    await shot(preparer, "02-filled");
    await preparer.click({ text: "Save preparation" });
    await preparer.waitForText("This is the server's recorded version", { timeout: 20000 });
    const ctx = await serverContext();
    return ctx.workpaper?.id && ctx.assessment.ppe && ctx.assessment.ppe.classes[0].chargeCalculatedMinor === "200000" ? true : ctx.assessment;
  });
  await check("server: trial-balance figures come from the CERTIFIED rows, and the next step is the first open matter from the server's assessment", async () => {
    await tab(preparer, "Bring information"); await sleep(300);
    const t = await text(preparer), next = await nextStep(preparer);
    return t.includes("closing 14,000.00, opening 16,000.00") && t.includes("depreciation expense 2,000.00") && /Next:/.test(next) && next.includes("prior report figure") ? true : { next, tb: t.match(/Property, plant and equipment per[^\n]*/)?.[0] };
  });
  await check("review: before management confirms, no policy wording exists for the class and the open matters name what, why, which evidence and who", async () => {
    await tab(preparer, "Review report");
    const t = await text(preparer);
    await shot(preparer, "03-review-before");
    return t.includes("INCOMPLETE DRAFT") && t.includes("await management's confirmation") && !/straight-line over 10 years/.test(t) && t.includes("Estimate unconfirmed")
      && t.includes("Evidence:") && t.includes("Who: management") && t.includes("Carrying amount") ? true : t.slice(0, 1500);
  });
  await check("reload: leaving and reopening restores the saved preparation from the server alone", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    const t = await text(preparer);
    await tab(preparer, "Complete preparation");
    const label = await val(preparer, "c0-label"), life = await val(preparer, "c0-i0y");
    return t.includes("Everything shown is the server's saved version") && label === "Equipment" && life === "10" ? true : { label, life };
  });

  log("\n== Reviewer confirms; the chain completes");
  const partner = await open();
  j.setPage(partner);
  await check("a partner (reviewer) confirms the printed figure and the estimates; the draft policy and note then appear and nothing remains open", async () => {
    await go(partner, "partner", "IPSAS accrual, 2026");
    await partner.click({ text: "Confirm against the printed page" });
    await partner.waitForText("Confirmed against the printed page", { timeout: 20000 });
    await tab(partner, "Complete preparation");
    await partner.click({ text: "Confirm these estimates" });
    await partner.waitForText("Estimates confirmed", { timeout: 20000 });
    await sleep(300);
    const next = await nextStep(partner);
    await tab(partner, "Review report");
    const t = await text(partner);
    await shot(partner, "04-review-after");
    return next.includes("Record the grants") && t.includes("straight-line over 10 years") && t.includes("No open matters in this slice") && t.includes("Server state: ready-for-review")
      && t.includes("Prepared from confirmed facts") && /Total[\s\S]{0,40}16,000\.00[\s\S]{0,20}14,000\.00/.test(t.replace(/\n/g, " ")) ? true : { next, hasPolicy: t.includes("straight-line over 10 years") };
  });
  await check("issue & history: official issuance is stated unavailable, with reasons, even though this slice has no open matter", async () => {
    await tab(partner, "Issue & history");
    const t = await text(partner);
    return t.includes("Official issuance is unavailable") && t.includes("No IPSAS report has been issued") && t.includes("no accounting author or reviewer") ? true : t.slice(0, 800);
  });
  j.setPage(preparer);
  await check("the preparer, reloading, sees the confirmed property, plant and equipment and is pointed to the grants still to record", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    await preparer.waitFor(() => document.querySelector('[aria-label="Next step"]')?.innerText.includes("Record the grants"), [], { timeout: 20000, label: "authoritative grants task after reload" });
    return (await nextStep(preparer)).includes("Record the grants") ? true : await nextStep(preparer);
  });

  return { preparer, partner };}

export async function ppeHostile(j) {
  const { check, open, go, set, type, val, tab, text, nextStep, shot, rpc, seed, log, serverContext } = j;
  const preparer = j.preparer;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  log("\n== Concurrency and lost responses");
  await check("race: another writer saves meanwhile; the page's save is refused by name, the edit is kept, and reloading adopts the server's version", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    await tab(preparer, "Complete preparation");
    await type(preparer, "c0-label", "Equipment (mine)");
    const ctx = await serverContext();
    const theirs = JSON.parse(JSON.stringify(ctx.workpaper.payload)); theirs.classes[0].label = "Equipment (theirs)";
    const saved = await rpc("owner", "ipsas_save_preparation", { p_company_id: seed.companyId, p_period_year: seed.periodYear, p_kind: "ppe_workpaper", p_payload: theirs, p_expected_id: ctx.workpaper.id, p_request_id: crypto.randomUUID() });
    if (saved.outcome !== "recorded") return saved;
    await preparer.click({ text: "Save preparation" });
    await preparer.waitForText("Someone saved a newer version", { timeout: 20000 });
    const kept = await val(preparer, "c0-label");
    await shot(preparer, "05-stale");
    await preparer.click({ text: "Discard edits and reload the saved version" });
    await sleep(600);
    const adopted = await val(preparer, "c0-label");
    return kept === "Equipment (mine)" && adopted === "Equipment (theirs)" ? true : { kept, adopted };
  });
  await check("lost: a response dropped after the server recorded it is reported as unconfirmed, and the retry reuses the ORIGINAL request identity (one revision, replay acknowledged)", async () => {
    await go(preparer, "preparer", "IPSAS accrual, 2026");
    await tab(preparer, "Complete preparation");
    await preparer.evaluate(() => {
      const real = window.fetch.bind(window); window.__sent = []; let dropped = false;
      window.fetch = async (u, o) => {
        if (String(u).includes("/rpc/ipsas_save_preparation")) {
          window.__sent.push(JSON.parse(o.body).p_request_id);
          const r = await real(u, o);
          if (!dropped) { dropped = true; await r.text(); throw new TypeError("Failed to fetch"); } // the server recorded it; the answer never arrives
          return r;
        }
        return real(u, o);
      };
    });
    const before = (await serverContext()).workpaper.id;
    await type(preparer, "c0-rat", "Ten years of single-shift use expected; reviewed after the race");
    await preparer.click({ text: "Save preparation" });
    await preparer.waitForText("We could not confirm whether this was saved", { timeout: 20000 });
    const midText = await text(preparer);
    const recorded = (await serverContext()).workpaper.id;
    await preparer.click({ text: "Send the same request again" });
    await preparer.waitForText("had already been recorded", { timeout: 20000 });
    const sent = await preparer.evaluate(() => window.__sent);
    const after = (await serverContext()).workpaper.id;
    await shot(preparer, "06-lost-retry");
    return midText.includes("Nothing is assumed either way") && sent.length === 2 && sent[0] === sent[1] && recorded !== before && after === recorded ? true : { sent, before, recorded, after };
  });

}
