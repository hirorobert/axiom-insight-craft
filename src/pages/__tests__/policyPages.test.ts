/**
 * The policy pages state the purchase terms and the parties that receive data — as the code does today.
 *
 *   S2-C03  Terms §3 states the commercial terms (one-time card payment through Polar as merchant of record, a 12-month
 *           term that does not renew automatically, what happens when it ends) and a Refunds and cancellation section.
 *   S2-C04  Privacy §6 names every external party that receives personal or financial data on a customer-reachable path,
 *           describes the mobile-money provider as not offered, and adds no new data-location claim.
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

  it("§3: one-time card payment through Polar as merchant of record, 12-month term, no automatic renewal, term end", () => {
    expect(t).toMatch(/one-time card payment/i);
    expect(t).toContain("Polar");
    expect(t).toContain("merchant of record");
    expect(t).toMatch(/12-month term/);
    expect(t).toMatch(/does not renew automatically/);
    expect(t).toMatch(/When a term ends/);
  });

  it("has a Refunds and cancellation section that the checkout can link to", () => {
    expect(terms).toMatch(/<h2[^>]*id="refunds"[^>]*>[^<]*Refunds and cancellation<\/h2>/);
  });

  it("the section is the ONE refund text the checkout also shows; it states the rule, the channel and who decides", () => {
    expect(REFUNDS_AND_CANCELLATION.anchor).toBe("refunds");
    expect(t).toContain(REFUNDS_AND_CANCELLATION.text);
    const policy = REFUNDS_AND_CANCELLATION.text;
    expect(policy).toMatch(/does not renew automatically/);
    expect(policy).toMatch(/refund of the unused part of the term, calculated pro rata by the whole days remaining/);
    expect(policy).toContain("billing@cfoclose.com");
    expect(policy).toMatch(/through Polar, our merchant of record, to the original payment method/);
    expect(policy).toMatch(/decided and made by a person at CFOClose, never automatically/);
    // No promise the operation cannot keep: no guarantee, no automatic or instant refund, no self-serve cancel button.
    expect(policy).not.toMatch(/guarantee|automatic refund|instant|cancel anytime|money-back/i);
  });
});

describe("S2-C04 · Privacy names the parties that receive data", () => {
  const t = text(html(Privacy));

  it("§6 names every external party on a customer-reachable path", () => {
    for (const party of ["Supabase", "Lovable", "Polar", "Cloudflare Turnstile", "Google", "Namecheap", "Intuit", "Google Fonts"]) {
      expect(t, party).toContain(party);
    }
  });

  it("the mobile-money provider is described as not offered, never as an integration in use", () => {
    expect(t).toMatch(/Snippe[^.]*not offered/);
    expect(t).not.toMatch(/include Polar and Snippe/);
  });

  it("keeps the one existing region sentence and adds no other data-location claim", () => {
    expect(t).toContain("The production database is configured in AWS eu-west-1, Ireland.");
    expect(t.match(/\b[a-z]{2}-[a-z]+-\d\b/g)).toEqual(["eu-west-1"]);
  });
});
