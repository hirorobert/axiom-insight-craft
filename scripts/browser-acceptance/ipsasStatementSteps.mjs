// Real signed-in page steps, called only by ipsasAuthJourney. This is test-fixture mapping, never a product classifier.
import { CODES as C } from "../e2e/localStackFixtures.mjs";
import { G, ACCOUNTS } from "../e2e/ipsasAuthFixtures.mjs";

export const FIXTURE_CAPTIONS = {
  [C.bank]:"cash",[C.receivables]:"receivables_current",[C.inventory]:"inventories",
  [C.equipment]:"ppe",[C.depreciationAcc]:"ppe",[C.payables]:"payables",
  [C.tax]:"other_liabilities_current",[C.loan]:"borrowings_non_current",
  [C.capital]:"contributed_capital",[C.retained]:"accumulated",[C.sales]:"fees",
  [C.interestIncome]:"investment_income",[C.costOfSales]:"supplies",[C.salaries]:"employees",
  [C.rent]:"supplies",[C.depreciation]:"depreciation",[C.interestExpense]:"finance",[C.taxExpense]:"other_expenses",
  [G.grantsBank]:"cash",[G.receivable]:"receivables_current",[G.liability]:"grant_liabilities_current",[G.revenue]:"grants",
};

export async function statementReviewChain(j) {
  const p=await j.open(); await j.go(p,"preparer","Statements and presentation");
  const captions=FIXTURE_CAPTIONS;
  const ctx=()=>j.rpc("preparer","ipsas_statement_review",{p_company:j.seed.companyId,p_year:j.seed.periodYear});
  await j.check("signed-in statement review: explicit captions saved through the page and financial figures recomputed on the server",async()=>{
    await p.waitForText("Showing the server's saved figures",{timeout:30000});
    const set=await p.evaluate(mapping=>{
      const selects=[...document.querySelectorAll('#ipsas-statements select[aria-label^="Caption for "]')];
      for(const el of selects){const code=el.getAttribute("aria-label").split(" ").slice(3).join(" "), value=mapping[code];if(!value||![...el.options].some(o=>o.value===value))return `No compatible fixture caption for ${code}`;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("change",{bubbles:true}));}
      return selects.length>0;
    },captions);
    if(set!==true)return set;
    await p.click({text:"Save presentation choices"});await p.waitForText("figures below were recomputed by the server",{timeout:30000});
    const r=await ctx();return r.outcome==="available"&&r.totals.current.state==="composed"&&r.lines.find(l=>l.id==="ppe").currentMinor==="1400000"&&r.officialIssuance.available===false?true:r;
  });
  await j.check("statement review: a figure opens certified and adjusted source rows without changing the credit amount",async()=>{
    await p.click('[aria-label="Trace current Property, plant and equipment"]');await p.waitForSelector('[aria-label="Figure sources"]');
    const t=await p.evaluate(()=>document.querySelector('[aria-label="Figure sources"]').innerText);
    return t.includes(ACCOUNTS.ppe[1])&&t.includes("credit 6,000.00")&&t.includes("Certification:")?true:t;
  });
  await j.check("statement review: refresh actually rereads the server and retains the incomplete report boundary",async()=>{
    const before=await ctx();await p.click({text:"Refresh statements"});await p.waitForText("Showing the server's saved figures",{timeout:30000});
    const after=await ctx(),text=await p.bodyText();await j.shot(p,"statement-review");
    return before.compositionSha256===after.compositionSha256&&text.includes("Incomplete draft — not approved or issued")&&text.includes("What remains before an official report");
  });
  return p;
}
