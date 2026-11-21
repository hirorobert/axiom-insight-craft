/**
 * The provider's legal identity and the identity/seller notices built from it - the facts the owner closed on 2026-11-21
 * (the provider is based in London, United Kingdom; the earlier Tanzania business-name registration is withdrawn). ONE source:
 * Terms section 1, the footer, the checkout notice and the Privacy controller line all read from here. No corporate suffix or
 * structure is added. Pure: no I/O, no React.
 *
 * The telephone line is rendered only while a value exists - never as an empty or placeholder value (S1); the owner supplied
 * the official business number on 2026-11-16.
 */
import { channel } from "@/lib/contact/contactChannels";

export const BUSINESS_IDENTITY = {
  /** The provider, as declared. */
  provider: "CFOCLOSE",
  /** The place of business, as declared by the owner on 2026-11-21. */
  address: "London, United Kingdom",
  /** The official business telephone number, supplied by the owner on 2026-11-16 (international format); see telephoneLine(). */
  telephone: "+44 20 4577 2480" as string | null,
  /** Terms section 1, first sentences. */
  termsIdentity:
    'CFOClose is provided by CFOCLOSE, based in London, United Kingdom ("we", "us"). Place of business and address: London, United Kingdom.',
  /** The footer identity line. */
  footerLine: "CFOClose is provided by CFOCLOSE, London, United Kingdom.",
  /** The checkout notice above the acknowledgements (S2). */
  checkoutNotice:
    "You are buying from Polar Software, Inc., our reseller and merchant of record, under the Polar Checkout Buyer Terms. CFOClose is provided by CFOCLOSE (London, United Kingdom) under our Terms of Service.",
  /** The Privacy Policy controller line (S5.1). */
  privacyController:
    `The controller of personal data processed through CFOClose is CFOCLOSE, London, United Kingdom. Contact: ${channel("contact").address}.`,
} as const;

/** "Telephone: <value>." once a value exists; null (nothing rendered) while there is none. Never a placeholder. */
export function telephoneLine(): string | null {
  const v = BUSINESS_IDENTITY.telephone?.trim();
  return v ? `Telephone: ${v}.` : null;
}
