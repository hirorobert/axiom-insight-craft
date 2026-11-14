/**
 * Terms-of-Service acceptance on checkout (PR #266, commercial handoff §10.8 and the owner's acceptance invariants).
 *
 *   T3   TERMS_VERSION identifies the exact applicable policy text: <date>.<first 12 hex of SHA-256 over the rendered Terms,
 *        Privacy and refund texts>; it changes whenever the text changes. The browser mirror equals the server's constant.
 *   T5   The server (checkTermsVersion) refuses a missing, empty, non-string, stale, forged, case- or whitespace-variant
 *        version BEFORE any commercial write, and accepts exactly the current one; the client's string never becomes the
 *        recorded value (the recorded value is the server's constant).
 *   SRC  Static source text: the function refuses before its first RPC and passes p_terms_version from the SERVER constant to
 *        acquire_checkout_attempt and termsVersion to the provider; the migration adds ONE optional trailing parameter from
 *        the live text, drops the 14-argument overload in the same transaction (no PostgREST ambiguity), keeps EXECUTE for
 *        service_role only, and installs the immutability trigger.
 *
 * Hosted behaviour (the real PostgreSQL contract: old 14-argument calls, persistence, replay, immutability, grants) is proven by
 * scripts/db-proof/checkoutTermsAcceptance.mjs in CI; this file proves the source text and the pure checks.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
import { REFUNDS_AND_CANCELLATION, TERMS_ACCEPTANCE, TERMS_VERSION } from "@/lib/commercial/purchaseTerms";
import { checkCheckoutAcknowledgement, checkTermsVersion, CURRENT_TERMS_VERSION } from "../../../../supabase/functions/_shared/commercial/termsVersion";
import { LEGAL_ARCHIVE, archivedVersions, publishedVersions } from "@/legal/archive";
import { BUSINESS_IDENTITY, telephoneLine } from "@/lib/commercial/businessIdentity";
import { Footer } from "@/components/Footer";

const ROOT = path.join(__dirname, "../../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const html = (c: () => JSX.Element) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(c)));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
/** The canonical policy text the version hashes: Terms, Privacy and the refund clause, as rendered, with the version itself blanked. */
export const canonicalPolicyText = () =>
  [text(html(Terms)), text(html(Privacy)), REFUNDS_AND_CANCELLATION.text].join("\n").split(TERMS_VERSION).join("<TERMS_VERSION>");
export const expectedTermsVersion = (date: string) => `${date}.${createHash("sha256").update(canonicalPolicyText(), "utf8").digest("hex").slice(0, 12)}`;

describe("T3 · the Terms version identifies the exact applicable policy text", () => {
  it("the browser mirror and the server constant are one value", () => {
    expect(TERMS_VERSION).toBe(CURRENT_TERMS_VERSION);
  });
  it("has the form <YYYY-MM-DD>.<12 hex>", () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.[0-9a-f]{12}$/);
  });
  it("its hash is the SHA-256 of the rendered Terms, Privacy and refund texts (a changed text changes the version)", () => {
    const date = TERMS_VERSION.slice(0, 10);
    expect(TERMS_VERSION).toBe(expectedTermsVersion(date));
    const other = createHash("sha256").update(canonicalPolicyText() + " ", "utf8").digest("hex").slice(0, 12);
    expect(other).not.toBe(TERMS_VERSION.slice(11));
  });
  it("the acceptance control names the version it sends and the refund terms; the consent wording is package 12.7's; the outdated notice promises no charge", () => {
    expect(TERMS_ACCEPTANCE.label).toContain(TERMS_VERSION);
    expect(TERMS_ACCEPTANCE.label).toMatch(/refund terms above/);
    expect(TERMS_ACCEPTANCE.consentLabel).toMatch(/start as soon as Polar confirms my payment/);
    expect(TERMS_ACCEPTANCE.consentLabel).not.toMatch(/does not apply/); // Update 5: the conservative A3 wording states no loss of a statutory right
    expect(TERMS_ACCEPTANCE.outdated).toMatch(/nothing was charged/);
  });
});

describe("T5 · the server decides which version is acceptable", () => {
  it("accepts exactly the current version and answers the server's own constant", () => {
    expect(checkTermsVersion({ termsVersion: CURRENT_TERMS_VERSION })).toEqual({ ok: true, termsVersion: CURRENT_TERMS_VERSION });
  });
  it.each([
    ["absent", {}],
    ["null", { termsVersion: null }],
    ["empty", { termsVersion: "" }],
    ["a number", { termsVersion: 1 }],
    ["an object", { termsVersion: { v: CURRENT_TERMS_VERSION } }],
    ["no body", undefined],
  ])("missing: %s → TERMS_VERSION_REQUIRED (400), naming the current version", (_label, body) => {
    expect(checkTermsVersion(body)).toEqual({ ok: false, error: "TERMS_VERSION_REQUIRED", status: 400, currentTermsVersion: CURRENT_TERMS_VERSION });
  });
  it.each([
    ["an older date", "2026-11-01." + CURRENT_TERMS_VERSION.slice(11)],
    ["another hash", CURRENT_TERMS_VERSION.slice(0, 11) + "000000000000"],
    ["upper case", CURRENT_TERMS_VERSION.toUpperCase()],
    ["surrounding whitespace", ` ${CURRENT_TERMS_VERSION} `],
    ["a prefix match", CURRENT_TERMS_VERSION.slice(0, -1)],
    ["a longer string", CURRENT_TERMS_VERSION + "0"],
  ])("not current: %s → TERMS_VERSION_NOT_CURRENT (409); the client cannot choose the version", (_label, v) => {
    expect(checkTermsVersion({ termsVersion: v })).toEqual({ ok: false, error: "TERMS_VERSION_NOT_CURRENT", status: 409, currentTermsVersion: CURRENT_TERMS_VERSION });
  });
});

describe("T5b · the consent to an immediate start is a separate, required flag (package 12.7)", () => {
  it("both acknowledgements present → ok, carrying the server's version and the verified flag", () => {
    expect(checkCheckoutAcknowledgement({ termsVersion: CURRENT_TERMS_VERSION, immediateServiceConsent: true })).toEqual({ ok: true, termsVersion: CURRENT_TERMS_VERSION, immediateServiceConsent: true });
  });
  it.each([
    ["absent", {}], ["false", { immediateServiceConsent: false }], ["the string 'true'", { immediateServiceConsent: "true" }],
    ["1", { immediateServiceConsent: 1 }], ["an object", { immediateServiceConsent: { ok: true } }],
  ])("consent %s → SERVICE_CONSENT_REQUIRED (400), nothing else accepted", (_l, extra) => {
    expect(checkCheckoutAcknowledgement({ termsVersion: CURRENT_TERMS_VERSION, ...extra })).toEqual({ ok: false, error: "SERVICE_CONSENT_REQUIRED", status: 400, currentTermsVersion: CURRENT_TERMS_VERSION });
  });
  it("a stale version is refused before the consent is even looked at", () => {
    expect(checkCheckoutAcknowledgement({ termsVersion: "2026-01-01.000000000000", immediateServiceConsent: true })).toMatchObject({ ok: false, error: "TERMS_VERSION_NOT_CURRENT" });
  });
});

describe("SRC · commercial-create-checkout refuses before any write and records the server's version", () => {
  const fn = read("supabase/functions/commercial-create-checkout/index.ts");
  it("checks the version inside request parsing, before resolve_commercial_offer (the first RPC)", () => {
    const parse = fn.indexOf("const body = await req.json();");
    const check = fn.indexOf("checkCheckoutAcknowledgement(body)", parse);
    const firstRpcAfterParse = fn.indexOf("supabase.rpc(", parse);
    expect(parse).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(parse);
    expect(check).toBeLessThan(firstRpcAfterParse);
    expect(fn).toMatch(/if \(!terms\.ok\) return jsonResponse\(\{ error: terms\.error, currentTermsVersion: terms\.currentTermsVersion, correlationId \}, terms\.status\);/);
  });
  it("passes the SERVER's accepted version to acquire_checkout_attempt and to the provider, never body.termsVersion", () => {
    expect(fn).toMatch(/p_terms_version: termsVersion,\s*p_immediate_service_consent: true,/);
    expect(fn).toMatch(/createCheckout\(\{\s*saffReference,\s*intentId,\s*termsVersion,\s*immediateServiceConsent: true,/);
    expect(fn).not.toMatch(/p_terms_version: body/);
    expect(fn.match(/body\.termsVersion/g) ?? []).toHaveLength(0);
  });
  it("Polar's checkout metadata carries terms_version only when the server supplied one", () => {
    const polar = read("supabase/functions/_shared/payments/providers/polar.ts");
    expect(polar).toMatch(/plan_code: p\.planCode, \.\.\.\(p\.termsVersion \? \{ terms_version: p\.termsVersion \} : \{\}\), \.\.\.\(p\.immediateServiceConsent === true \? \{ immediate_service_consent: 'true' \} : \{\}\)/);
  });
});

describe("SRC · 20261229100000 adds the acknowledgement parameters from the live text, refuses creation without them, and freezes the record", () => {
  const sql = read("supabase/migrations/20261229100000_checkout_terms_acceptance.sql");
  it("re-creates acquire_checkout_attempt from pg_get_functiondef with four anchors asserted exactly once, and DROPS the 14-argument overload in the same DO block", () => {
    expect(sql).toMatch(/pg_get_functiondef\(to_regprocedure\(c_old_sig\)\)/);
    expect(sql).toMatch(/FOR i IN 1 \.\. 4 LOOP/);
    expect(sql).toMatch(/IF v_n <> 1 THEN/);
    expect(sql).toMatch(/'p_created_by_user_id uuid, p_saff_reference text, p_terms_version text DEFAULT NULL, p_immediate_service_consent boolean DEFAULT NULL\)'/);
    expect(sql).toMatch(/EXECUTE 'DROP FUNCTION ' \|\| c_old_sig;/);
    expect(sql.match(/DO \$terms_acceptance\$/g)).toHaveLength(1);
  });
  it("no intent without the acknowledgement: the function refuses (TERMS_ACCEPTANCE_REQUIRED) right before the INSERT; the record binds version, both flags, server time and the purchaser", () => {
    expect(sql).toMatch(/IF p_terms_version IS NULL OR p_immediate_service_consent IS DISTINCT FROM true THEN/);
    expect(sql).toMatch(/TERMS_ACCEPTANCE_REQUIRED/);
    expect(sql).toMatch(/jsonb_build_object\(''terms_version'', p_terms_version, ''terms_accepted'', true, ''terms_accepted_at'', v_now,/);
    expect(sql).toMatch(/''terms_accepted_by_user_id'', p_created_by_user_id, ''immediate_service_consent'', true\)/);
    expect(sql).not.toMatch(/CASE WHEN p_terms_version IS NULL THEN ''\{\}''::jsonb/);
  });
  it("EXECUTE stays with service_role only; the postcondition asserts exactly one function, the default, and the grants", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION ' \|\| c_new_sig \|\| ' FROM PUBLIC, anon, authenticated'/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION ' \|\| c_new_sig \|\| ' TO service_role'/);
    expect(sql).toMatch(/proname = 'acquire_checkout_attempt'\) <> 1/);
    expect(sql).toMatch(/pronargdefaults FROM pg_proc p WHERE p\.oid = to_regprocedure\(c_new_sig\)\) <> 2/);
    expect(sql).toMatch(/has_function_privilege\('authenticated', to_regprocedure\(c_new_sig\), 'EXECUTE'\)/);
  });
  it("the BEFORE UPDATE guard refuses any change, removal or addition of the three acceptance keys", () => {
    expect(sql).toMatch(/CREATE TRIGGER payment_checkout_intents_terms_acceptance_guard\s+BEFORE UPDATE ON public\.payment_checkout_intents/);
    for (const k of ["terms_version", "terms_accepted", "terms_accepted_at", "terms_accepted_by_user_id", "immediate_service_consent"]) {
      expect(sql).toContain(`NEW.metadata -> '${k}' IS DISTINCT FROM OLD.metadata -> '${k}'`);
    }
    expect(sql).toMatch(/TERMS_ACCEPTANCE_IMMUTABLE/);
  });
  it("reads or rewrites no existing row (no UPDATE/DELETE/INSERT on intents outside the function text) and reloads the PostgREST schema", () => {
    const outsideFunction = sql.replace(/v_to := ARRAY\[[\s\S]*?\];/, "");
    expect(outsideFunction).not.toMatch(/^\s*(UPDATE|DELETE FROM|INSERT INTO) public\.payment_checkout_intents/m);
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });
});

describe("ARCHIVE · every published version is kept as rendered text and served at /terms?v= and /privacy?v= (handoff 10.8 item 9)", () => {
  const routed = (c: () => JSX.Element, url: string) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, createElement(c)));
  it("the current version's archive is exactly the rendered Terms, Privacy and refund texts", () => {
    const a = LEGAL_ARCHIVE[TERMS_VERSION];
    expect(a).toBeDefined();
    expect(a.terms).toBe(text(html(Terms)));
    expect(a.privacy).toBe(text(html(Privacy)));
    expect(a.refunds).toBe(REFUNDS_AND_CANCELLATION.text);
    expect(archivedVersions()).toContain(TERMS_VERSION);
  });
  it("the live pages show the version and a permanent link; ?v=<current> renders the live page", () => {
    const live = routed(Terms, "/terms");
    expect(text(live)).toContain(`Version ${TERMS_VERSION}`);
    expect(live).toContain(`/terms?v=${TERMS_VERSION}`);
    expect(text(routed(Terms, `/terms?v=${TERMS_VERSION}`))).toBe(text(live));
    expect(text(routed(Privacy, "/privacy"))).toContain(`Version ${TERMS_VERSION}`);
  });
  it("?v=<unknown> says there is no such published version and links to the current one; no placeholder text is rendered", () => {
    const h = routed(Terms, "/terms?v=2020-01-01.000000000000");
    expect(h).toContain('data-testid="terms-version-unknown"');
    expect(text(h)).toContain('There is no published version "2020-01-01.000000000000"');
    expect(text(h)).toContain(`Read the current version (${TERMS_VERSION})`);
    expect(h).not.toContain("terms-archived-text");
  });
  it("a DRAFT version is archived for its hash but never served by link: an old draft answers as unknown; only published versions are reachable", () => {
    expect(Object.keys(LEGAL_ARCHIVE).every((v) => /^\d{4}-\d{2}-\d{2}\.[0-9a-f]{12}$/.test(v))).toBe(true);
    expect(LEGAL_ARCHIVE[TERMS_VERSION].status).toBe("draft"); // flipped to "published" by the owner's publication, never before
    expect(publishedVersions()).not.toContain(TERMS_VERSION);
    // The current text is reachable only as the live page (it IS the current text); nothing pre-approval is served as "a published version".
    const h = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/privacy?v=${TERMS_VERSION}`] }, createElement(Privacy)));
    expect(text(h)).toContain(`Version ${TERMS_VERSION}`);
    expect(h).not.toContain("privacy-archived-text");
  });
});

describe("UPDATE 4 · the settled commercial text is rendered from one identity source; nothing gated is rendered (handoff Update 4, S1-S8)", () => {
  const terms = text(html(Terms));
  const privacy = text(html(Privacy));
  it("S1 · Terms section 1 states the owner-closed identity, with no corporate suffix and no placeholder", () => {
    expect(terms).toContain("1. Who we are " + BUSINESS_IDENTITY.termsIdentity);
    expect(terms).toContain("E-mail: support@cfoclose.com ; legal notices: contact@cfoclose.com .");
    expect(BUSINESS_IDENTITY.termsIdentity).not.toMatch(/\b(Ltd|Limited|Inc\.?|LLC|Plc|Company)\b/);
    expect(terms).not.toMatch(/\{BUSINESS_TELEPHONE\}|\[COUNSEL|\[OWNER|TODO|placeholder/i);
  });
  it("S1 · the telephone line is rendered only once a value exists: null renders nothing, never an empty label", () => {
    expect(BUSINESS_IDENTITY.telephone).toBeNull();
    expect(telephoneLine()).toBeNull();
    expect(terms).not.toContain("Telephone");
  });
  it("S1 · the footer carries the identity line exactly once, from the same source", () => {
    const f = text(html(Footer));
    expect(f.split(BUSINESS_IDENTITY.footerLine).length - 1).toBe(1);
    expect(BUSINESS_IDENTITY.footerLine).toContain("reg. 705538");
  });
  it("S2 · Terms section 2 names Polar Software, Inc. as reseller and merchant of record under the Polar Checkout Buyer Terms", () => {
    expect(terms).toContain("2. Who sells your plan Plans are sold by our reseller and merchant of record, Polar Software, Inc.");
    expect(terms).toContain("https://polar.sh/legal/checkout-buyer-terms");
    expect(BUSINESS_IDENTITY.checkoutNotice).toMatch(/^You are buying from Polar Software, Inc\., our reseller and merchant of record, under the Polar Checkout Buyer Terms\./);
  });
  it("S3 · scope, plans and term as in package 10.3 sections 3 and 5", () => {
    for (const s of ["The service available to customers today is trial balance review", "QuickBooks connections are not currently available", "AI features are disabled",
      "Other parts of the software are not available to customers.", "does not provide an audit, an audit opinion, assurance, or legal or other professional advice",
      "Solo (1 active entity), Practice (5) and Firm (25)", "USD 490, 990 and 2,990 a year", "a plan starts when Polar has confirmed the payment to us",
      "when a term ends, nothing is deleted"]) expect(terms, s).toContain(s);
  });
  it("S4 · the refund text is package 10.5 (five paragraphs), rendered identically on the Terms page and the checkout", () => {
    expect(REFUNDS_AND_CANCELLATION.paragraphs).toHaveLength(5);
    expect(REFUNDS_AND_CANCELLATION.paragraphs[0]).toMatch(/stop a future charge\. Seven-day cancellation\. You may cancel within seven days of buying a plan by writing to billing@cfoclose\.com and receive a full refund, whether or not you have started using it\. After those seven days, you may cancel a plan before its term ends/);
    expect(REFUNDS_AND_CANCELLATION.paragraphs[4]).toBe("Refunds we approve are issued through Polar within thirty days of cancellation. This policy does not limit any right you have under the law that applies to you.");
    expect(terms).toContain(text(REFUNDS_AND_CANCELLATION.text));
    expect(read("src/pages/billing/Checkout.tsx")).toMatch(/whitespace-pre-line[^>]*>\{REFUNDS_AND_CANCELLATION\.text\}/);
  });
  it("S5 · Privacy: controller line, Polar as an independent controller, provider-neutral hosting, verified processors, no PDPC/permit statement", () => {
    expect(privacy).toContain(BUSINESS_IDENTITY.privacyController);
    expect(privacy).toMatch(/Polar Software, Inc\. acts as merchant of record and processes your payment and billing details as an independent controller under its own privacy terms/);
    expect(privacy).toContain("Personal data is stored and processed outside Tanzania by the service providers listed in section 6, which include providers based in the United States.");
    expect(privacy).not.toMatch(/eu-west-1|Ireland|European Union|AWS|Snippe/);
    expect(privacy).not.toMatch(/PDPC|Personal Data Protection Commission|permit|transfer basis/i);
    expect(privacy).toMatch(/Backups held by our hosting provider expire on its backup schedule/);
    expect(privacy).not.toMatch(/within \d+ (days|months)|\d+ (years|months) after/);
  });
  it("S6/S8 + Updates 5/6 · box 1 final; box 2 is the conservative A3 candidate, still DRAFT, stating no loss of any statutory right; A1/A2 rendered verbatim, archive still draft", () => {
    expect(TERMS_ACCEPTANCE.label).toContain(TERMS_VERSION);
    expect(TERMS_ACCEPTANCE.consentLabel).toBe("I ask for my plan to start as soon as Polar confirms my payment.");
    expect(read("src/lib/commercial/purchaseTerms.ts")).not.toMatch(/does not apply/);
    expect(read("src/lib/commercial/purchaseTerms.ts")).toMatch(/DRAFT until the owner approves A3/);
    // A1 and A2 approved in principle by the owner (2026-11-14): rendered verbatim (dossier 28.2); publication waits for final contractual approval.
    expect(terms).toContain("9. Limitation of liability To the extent the law allows, our total liability to you for any claim arising from the service in any 12-month period is limited to the amount you paid for your plan for that period. We are not liable for indirect or consequential loss, or for decisions you make using information from the service; you remain responsible for your professional judgement and for what you sign. Nothing in these Terms limits liability that cannot be limited by law.");
    expect(terms).toContain("10. Governing law and disputes These Terms are governed by the laws of the United Republic of Tanzania, and the courts of Tanzania have jurisdiction over disputes about the service. This does not affect your rights under mandatory consumer law, or the Polar Checkout Buyer Terms that govern your purchase contract with Polar.");
    expect(terms).not.toMatch(/Delaware|arbitration/);
    expect(LEGAL_ARCHIVE[TERMS_VERSION].status).toBe("draft");
  });
});
