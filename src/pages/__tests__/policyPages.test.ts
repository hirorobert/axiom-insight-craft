/**
 * The policy pages state the purchase terms and the parties that receive data — as the code does today.
 *
 *   S2-C03  Terms sections 2 and 5 state the commercial terms (Polar Software, Inc. as reseller and merchant of record, a
 *           one-time payment for a 12-month term that does not renew automatically, what happens when it ends) and section 6
 *           is the Refunds and cancellation text of commercial package 10.5 (handoff Update 4, S2-S4).
 *   S2-C04  Privacy section 6 names every external party that receives personal or financial data on a customer-reachable
 *           path (the verified list of Update 4, S5), names no provider that is not offered, and makes no data-location
 *           claim beyond the provider-neutral sentence.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null, session: null, loading: false, signOut: async () => undefined }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }) }, rpc: async () => ({ data: null, error: null }) },
}));

import Terms from "@/pages/Terms";
import Privacy from "@/pages/Privacy";
import { REFUNDS_AND_CANCELLATION } from "@/lib/commercial/purchaseTerms";

const html = (c: () => JSX.Element) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(c)));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("S2-C03 · Terms state the purchase terms", () => {
  const terms = html(Terms);
  const t = text(terms);

  it("sections 2 and 5: Polar Software, Inc. as reseller and merchant of record; one-time payment, 12-month term, no automatic renewal, term end", () => {
    expect(t).toContain("Plans are sold by our reseller and merchant of record, Polar Software, Inc.");
    expect(t).toContain("https://polar.sh/legal/checkout-buyer-terms");
    expect(t).toMatch(/one-time payment for a 12-month term/);
    expect(t).toMatch(/does not renew automatically/);
    expect(t).toMatch(/when a term ends, nothing is deleted/i);
    expect(t).toMatch(/USD 490,\s*990 and 2,990 a year/);
  });

  it("has a Refunds and cancellation section that the checkout can link to", () => {
    expect(terms).toMatch(/<h2[^>]*id="refunds"[^>]*>[^<]*Refunds and cancellation<\/h2>/);
  });

  it("the section is the ONE refund text the checkout also shows; it states the rule, the channel and who decides", () => {
    expect(REFUNDS_AND_CANCELLATION.anchor).toBe("refunds");
    expect(t).toContain(text(REFUNDS_AND_CANCELLATION.text));
    const policy = REFUNDS_AND_CANCELLATION.text;
    expect(REFUNDS_AND_CANCELLATION.paragraphs).toHaveLength(5);
    expect(policy).toBe(REFUNDS_AND_CANCELLATION.paragraphs.join("\n\n"));
    expect(policy).toMatch(/does not renew automatically/);
    expect(policy).toMatch(/calculated on the price you paid, pro rata to the whole days remaining from the day we receive your request, together with the matching share of any sales tax or VAT charged/);
    expect(policy).toContain("billing@cfoclose.com");
    expect(policy).toMatch(/through Polar, our merchant of record, to the original payment method/);
    expect(policy).toMatch(/A person at CFOClose reviews every request; refunds are never made automatically/);
    // One rule ends the plan (a refund of the unused term); any other refund keeps it unless we say so (package 10.5).
    expect(policy).toMatch(/the plan ends on the day the refund is made/);
    expect(policy).toMatch(/does not end a plan unless we tell you so/);
    expect(policy).toMatch(/does not limit any right you have under the law/);
    // No promise the operation cannot keep: no guarantee, no automatic or instant refund, no self-serve cancel button.
    expect(policy).not.toMatch(/guarantee|automatic refund|instant|cancel anytime|money-back/i);
  });
});

describe("S2-C04 · Privacy names the parties that receive data", () => {
  const t = text(html(Privacy));

  it("section 6 names every external party on a customer-reachable path (the verified list, by role)", () => {
    for (const party of ["Supabase", "Lovable", "Mailgun", "Polar Software, Inc.", "Cloudflare Turnstile", "Google", "Namecheap Private Email", "Intuit"]) {
      expect(t, party).toContain(party);
    }
    expect(t).toMatch(/Polar Software, Inc\. acts as merchant of record and processes your payment and billing details as an independent controller/);
  });

  it("names no provider that is not offered (the mobile-money provider is not a recipient and is not mentioned)", () => {
    expect(t).not.toContain("Snippe");
  });

  it("makes no region or data-centre claim: the provider-neutral sentence only", () => {
    expect(t).toContain("Personal data is stored and processed outside Tanzania by the service providers listed in section 6, which include providers based in the United States.");
    expect(t).not.toMatch(/\b[a-z]{2}-[a-z]+-\d\b/);
    expect(t).not.toMatch(/Ireland|European Union|AWS/);
  });
});
