// src/legal/archive/index.ts - every published policy version, as rendered text, keyed by TERMS_VERSION (commercial handoff 10.8 item 9).
// The files live under docs/legal/<doc>/<version>.md and are bundled as raw text; /terms?v=<version> and /privacy?v=<version> serve them.
// A version's text is the exact input of its hash (src/lib/commercial/__tests__/termsAcceptance.test.ts pins the current one), so an
// archived version can always be shown as it was accepted. Add a version here when its texts are archived; never edit an archived file.
import terms_2026_11_13_43956c6fa6a8 from "../../../docs/legal/terms/2026-11-13.43956c6fa6a8.md?raw";
import privacy_2026_11_13_43956c6fa6a8 from "../../../docs/legal/privacy/2026-11-13.43956c6fa6a8.md?raw";
import refunds_2026_11_13_43956c6fa6a8 from "../../../docs/legal/refunds/2026-11-13.43956c6fa6a8.md?raw";

export interface ArchivedPolicies {
  readonly terms: string; readonly privacy: string; readonly refunds: string;
  /** Only a PUBLISHED version is served at /terms?v= and /privacy?v=; a draft is archived for the hash but answers as unknown. */
  readonly status: "draft" | "published";
}

export const LEGAL_ARCHIVE: Readonly<Record<string, ArchivedPolicies>> = Object.freeze({
  "2026-11-13.43956c6fa6a8": Object.freeze({ terms: terms_2026_11_13_43956c6fa6a8.trimEnd(), privacy: privacy_2026_11_13_43956c6fa6a8.trimEnd(), refunds: refunds_2026_11_13_43956c6fa6a8.trimEnd(), status: "draft" }),
});

export const archivedVersions = (): readonly string[] => Object.keys(LEGAL_ARCHIVE).sort();
/** The versions a customer can open by link: published ones only (commercial review 2026-11-13, item 6). */
export const publishedVersions = (): readonly string[] => Object.entries(LEGAL_ARCHIVE).filter(([, a]) => a.status === "published").map(([v]) => v).sort();
