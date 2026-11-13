/**
 * The provider's legal identity and the identity/seller notices built from it - the facts the owner closed on 2026-11-13
 * (commercial handoff "Update 4", S1 and S2). ONE source: Terms section 1, the footer, the checkout notice and the Privacy
 * controller line all read from here. No corporate suffix or structure is added. Pure: no I/O, no React.
 *
 * The telephone is the only field without a value. Its line is rendered only once a value exists - never as an empty or
 * placeholder value (S1).
 */
import { channel } from "@/lib/contact/contactChannels";

export const BUSINESS_IDENTITY = {
  /** The registered proprietor, as declared. */
  provider: "CFOCLOSE",
  /** The registered business name (Business Names Act, Cap. 213). */
  businessName: "SAFF ERP",
  registrationNumber: "705538",
  address: "Kati, Pangani, Tanzania",
  /** null until the owner supplies a value; see telephoneLine(). */
  telephone: null as string | null,
  /** Terms section 1, first sentences. */
  termsIdentity:
    'CFOClose is provided by CFOCLOSE, the registered proprietor of the business name SAFF ERP, registered in the United Republic of Tanzania under the Business Names Act (Cap. 213), registration number 705538 ("we", "us"). Place of business and address: Kati, Pangani, Tanzania.',
  /** The footer identity line. */
  footerLine: "CFOClose is provided by CFOCLOSE, proprietor of SAFF ERP (Tanzania business name reg. 705538), Kati, Pangani.",
  /** The checkout notice above the acknowledgements (S2). */
  checkoutNotice:
    "You are buying from Polar Software, Inc., our reseller and merchant of record, under the Polar Checkout Buyer Terms. CFOClose is provided by CFOCLOSE (proprietor of SAFF ERP, Tanzania business name reg. 705538) under our Terms of Service.",
  /** The Privacy Policy controller line (S5.1). */
  privacyController:
    `The controller of personal data processed through CFOClose is CFOCLOSE, the registered proprietor of the business name SAFF ERP (registration no. 705538, United Republic of Tanzania), Kati, Pangani. Contact: ${channel("contact").address}.`,
} as const;

/** "Telephone: <value>." once a value exists; null (nothing rendered) while there is none. Never a placeholder. */
export function telephoneLine(): string | null {
  const v = BUSINESS_IDENTITY.telephone?.trim();
  return v ? `Telephone: ${v}.` : null;
}
