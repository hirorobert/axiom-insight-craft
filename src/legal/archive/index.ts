// src/legal/archive/index.ts - every published policy version, as rendered text, keyed by TERMS_VERSION (commercial handoff 10.8 item 9).
// The files live under docs/legal/<doc>/<version>.md and are bundled as raw text; /terms?v=<version> and /privacy?v=<version> serve them.
// A version's text is the exact input of its hash (src/lib/commercial/__tests__/termsAcceptance.test.ts pins the current one), so an
// archived version can always be shown as it was accepted. Add a version here when its texts are archived; never edit an archived file.
import terms_2026_11_13_c6ad0a9491d5 from "../../../docs/legal/terms/2026-11-13.c6ad0a9491d5.md?raw";
import privacy_2026_11_13_c6ad0a9491d5 from "../../../docs/legal/privacy/2026-11-13.c6ad0a9491d5.md?raw";
import refunds_2026_11_13_c6ad0a9491d5 from "../../../docs/legal/refunds/2026-11-13.c6ad0a9491d5.md?raw";
import terms_2026_11_13_e9570ed37c46 from "../../../docs/legal/terms/2026-11-13.e9570ed37c46.md?raw";
import privacy_2026_11_13_e9570ed37c46 from "../../../docs/legal/privacy/2026-11-13.e9570ed37c46.md?raw";
import refunds_2026_11_13_e9570ed37c46 from "../../../docs/legal/refunds/2026-11-13.e9570ed37c46.md?raw";
import terms_2026_11_16_8c10d10a9deb from "../../../docs/legal/terms/2026-11-16.8c10d10a9deb.md?raw";
import privacy_2026_11_16_8c10d10a9deb from "../../../docs/legal/privacy/2026-11-16.8c10d10a9deb.md?raw";
import refunds_2026_11_16_8c10d10a9deb from "../../../docs/legal/refunds/2026-11-16.8c10d10a9deb.md?raw";
import terms_2026_11_21_4086423bd9f5 from "../../../docs/legal/terms/2026-11-21.4086423bd9f5.md?raw";
import privacy_2026_11_21_4086423bd9f5 from "../../../docs/legal/privacy/2026-11-21.4086423bd9f5.md?raw";
import refunds_2026_11_21_4086423bd9f5 from "../../../docs/legal/refunds/2026-11-21.4086423bd9f5.md?raw";

export interface ArchivedPolicies {
  readonly terms: string; readonly privacy: string; readonly refunds: string;
  /**
   * PUBLISHED = the version customers are asked to accept today. SUPERSEDED = a version that WAS published and stays served at
   * its permanent link exactly as it was, because a purchase may have accepted it. DRAFT = archived for its hash, never served.
   */
  readonly status: "draft" | "published" | "superseded";
}

export const LEGAL_ARCHIVE: Readonly<Record<string, ArchivedPolicies>> = Object.freeze({
  "2026-11-13.c6ad0a9491d5": Object.freeze({ terms: terms_2026_11_13_c6ad0a9491d5.trimEnd(), privacy: privacy_2026_11_13_c6ad0a9491d5.trimEnd(), refunds: refunds_2026_11_13_c6ad0a9491d5.trimEnd(), status: "draft" }),
  "2026-11-13.e9570ed37c46": Object.freeze({ terms: terms_2026_11_13_e9570ed37c46.trimEnd(), privacy: privacy_2026_11_13_e9570ed37c46.trimEnd(), refunds: refunds_2026_11_13_e9570ed37c46.trimEnd(), status: "draft" }),
  // 2026-11-16: the owner's official business telephone added to Terms section 1 (the only text change). PUBLISHED by the owner's final
  // contractual approval of exactly this version on 2026-11-16 ("Approve wording"); the two 2026-11-13 drafts stay archived, never served.
  // SUPERSEDED on 2026-11-21 by the identity correction below: it stays archived and served at its permanent link, byte for byte as
  // published, because a purchase that accepted it must still be able to read exactly what it accepted.
  "2026-11-16.8c10d10a9deb": Object.freeze({ terms: terms_2026_11_16_8c10d10a9deb.trimEnd(), privacy: privacy_2026_11_16_8c10d10a9deb.trimEnd(), refunds: refunds_2026_11_16_8c10d10a9deb.trimEnd(), status: "superseded" }),
  // 2026-11-21: the owner's correction — CFOCLOSE is based in London, United Kingdom; the Tanzania business-name registration
  // (SAFF ERP, reg. 705538, Kati, Pangani) is withdrawn from every customer surface. PUBLISHED on the owner's instruction of 2026-11-21.
  "2026-11-21.4086423bd9f5": Object.freeze({ terms: terms_2026_11_21_4086423bd9f5.trimEnd(), privacy: privacy_2026_11_21_4086423bd9f5.trimEnd(), refunds: refunds_2026_11_21_4086423bd9f5.trimEnd(), status: "published" }),
});

export const archivedVersions = (): readonly string[] => Object.keys(LEGAL_ARCHIVE).sort();
/** The versions a customer can open by link: published ones only (commercial review 2026-11-13, item 6). */
export const publishedVersions = (): readonly string[] => Object.entries(LEGAL_ARCHIVE).filter(([, a]) => a.status === "published").map(([v]) => v).sort();
