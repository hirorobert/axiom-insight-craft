// The published CFOClose email addresses: one source, exact addresses, working mailto links, rendered on every surface that
// needs them, and no other address hard-coded in the application.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { CONTACT_CHANNELS, channel, mailtoHref } from "@/lib/contact/contactChannels";
import { BillingHelpLine, ContactChannelList, ContactChannelOptions } from "@/components/contact/ContactChannels";

const ROOT = path.resolve(__dirname, "../../..");
const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

describe("contact channels", () => {
  it("are exactly the three published mailboxes, each with a label and a purpose", () => {
    expect(CONTACT_CHANNELS.map((c) => [c.id, c.label, c.address])).toEqual([
      ["support", "Support", "support@cfoclose.com"],
      ["billing", "Billing", "billing@cfoclose.com"],
      ["contact", "General", "contact@cfoclose.com"],
    ]);
    for (const c of CONTACT_CHANNELS) {
      expect(c.address).toMatch(/^[a-z]+@cfoclose\.com$/);
      expect(c.purpose.length).toBeGreaterThan(10);
      expect(c.purpose).not.toMatch(/\b(24\/7|hours?|minutes?|guarantee|instant)\b/i); // no unverifiable service promise
    }
    expect(Object.isFrozen(CONTACT_CHANNELS)).toBe(true);
  });

  it("build valid mailto links; a subject is URL-encoded", () => {
    expect(mailtoHref("support")).toBe("mailto:support@cfoclose.com");
    expect(mailtoHref("billing", "Payment SAFF-1 & more")).toBe("mailto:billing@cfoclose.com?subject=Payment%20SAFF-1%20%26%20more");
    expect(() => channel("sales" as never)).toThrow();
  });

  it("the footer list renders all three as labelled mailto links", () => {
    const html = render(createElement(ContactChannelList));
    expect(hrefs(html)).toEqual(["mailto:support@cfoclose.com", "mailto:billing@cfoclose.com", "mailto:contact@cfoclose.com"]);
    for (const c of CONTACT_CHANNELS) expect(html).toContain(`aria-label="${c.label}: email ${c.address}"`);
  });

  it("the contact-page options render a heading, an icon (decorative), the purpose and the address for each", () => {
    const html = render(createElement(ContactChannelOptions));
    expect(html).toContain('aria-labelledby="contact-options-heading"');
    expect(html).toContain("Email the right team");
    expect(hrefs(html)).toEqual(CONTACT_CHANNELS.map((c) => `mailto:${c.address}`));
    for (const c of CONTACT_CHANNELS) expect(html).toContain(c.purpose);
    expect((html.match(/aria-hidden="true"/g) ?? []).length).toBe(3);
  });

  it("the billing line points to billing@ with an optional subject", () => {
    expect(hrefs(render(createElement(BillingHelpLine)))).toEqual(["mailto:billing@cfoclose.com"]);
    expect(hrefs(render(createElement(BillingHelpLine, { subject: "Checkout question" })))).toEqual(["mailto:billing@cfoclose.com?subject=Checkout%20question"]);
  });

  it("every surface that needs an address uses the shared components or helpers", () => {
    const uses: [string, RegExp][] = [
      ["src/components/Footer.tsx", /<ContactChannelList\b/],
      ["src/pages/Contact.tsx", /<ContactChannelOptions\b/],
      ["src/components/account/AccountShell.tsx", /mailtoHref\("support"\)/],
      ["src/pages/workspace/WorkspaceLayout.tsx", /mailtoHref\("support"\)/],
      ["src/pages/Plans.tsx", /<BillingHelpLine\b/],
      ["src/pages/Pricing.tsx", /<BillingHelpLine\b/],
      ["src/pages/billing/Checkout.tsx", /<BillingHelpLine\b/],
      ["src/pages/billing/Orders.tsx", /<BillingHelpLine\b/],
      ["src/pages/billing/PaymentReturn.tsx", /<BillingHelpLine\b/],
      ["src/pages/Settings.tsx", /<BillingHelpLine\b/],
    ];
    for (const [f, rx] of uses) expect(fs.readFileSync(path.join(ROOT, f), "utf8"), f).toMatch(rx);
  });

  it("the signed-in frame offers support by email in its own footer, beside Contact", async () => {
    const { AccountShell } = await import("@/components/account/AccountShell");
    const html = render(createElement(AccountShell, { onSignOut: () => undefined, children: "x" }));
    expect(hrefs(html)).toContain("mailto:support@cfoclose.com");
    expect(html).toContain('aria-label="Support: email support@cfoclose.com"');
    expect(hrefs(html)).toContain("/contact");
  });

  it("every mailto link has at least a 24 px touch target (vertical padding on an inline-block link)", () => {
    for (const html of [render(createElement(ContactChannelList)), render(createElement(ContactChannelOptions)), render(createElement(BillingHelpLine))]) {
      for (const m of html.matchAll(/<a [^>]*href="mailto:[^"]*"[^>]*>/g)) expect(m[0]).toMatch(/class="[^"]*\binline-block\b[^"]*\bpy-(0\.5|1)\b/);
    }
  });

  it("the existing contact form is still rendered on /contact (and still submits through the enquiry function)", () => {
    const contact = fs.readFileSync(path.join(ROOT, "src/pages/Contact.tsx"), "utf8");
    expect(contact).toMatch(/<ServiceEnquiryForm formKey="contact" variant="general"/);
    expect(fs.readFileSync(path.join(ROOT, "src/lib/serviceEnquiry/client.ts"), "utf8")).toMatch(/functions\.invoke\("submit-service-enquiry"/);
  });

  it("no application source hard-codes a cfoclose.com mailbox except this module", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) && !/\.test\.|__tests__/.test(path.join(d, e.name)) ? [path.join(d, e.name)] : []);
    const offenders = walk(path.join(ROOT, "src"))
      .filter((f) => !f.endsWith(path.join("lib", "contact", "contactChannels.ts")))
      .filter((f) => /[a-z0-9._-]+@cfoclose\.com/i.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
