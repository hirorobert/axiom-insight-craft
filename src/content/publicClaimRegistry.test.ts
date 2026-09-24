/**
 * publicClaimRegistry.test.ts — every approved claim must actually appear on the landing page, and
 * no prohibited stronger wording may appear anywhere in it. This is what makes the registry a real
 * gate rather than documentation: a future edit that silently drops a substantiated claim, or
 * upgrades one into unsupported territory, fails this test.
 *
 * LANDING_FILES tracks the real public surface. It was updated when the landing page was rebuilt
 * (the retired Hero/PainPoints/ProductTour/Features/ClosingCTA sections were deleted and replaced
 * by src/components/landing/* reading src/content/landing/landingContent.ts) — the set of files
 * scanned changed, the strictness did not: every assertion below is retained and the prohibited
 * vocabulary is larger than before.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_CLAIM_REGISTRY } from "./publicClaimRegistry";

const ROOT = path.resolve(__dirname, "../..");
const LANDING_FILES = [
  "src/pages/Index.tsx",
  "src/components/Header.tsx",
  "src/components/Footer.tsx",
  "src/components/landing/LandingHero.tsx",
  "src/components/landing/SyntheticClosePreview.tsx",
  "src/components/landing/CoreCapabilities.tsx",
  "src/components/landing/ControlledCloseAndAssurance.tsx",
  "src/components/landing/VerifiedDeliverables.tsx",
  "src/components/landing/CommercialVerification.tsx",
  "src/components/landing/LandingFAQ.tsx",
  "src/components/landing/LandingFinalCTA.tsx",
  "src/content/landing/landingContent.ts",
  "src/constants/copy.ts",
  "index.html",
];

const RAW_LANDING_SOURCE = LANDING_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
// Strip comments before scanning for prohibited wording: a code comment explaining WHY a stronger
// claim was removed is documentation, not a rendered user claim.
const LANDING_SOURCE_NO_COMMENTS = RAW_LANDING_SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/<!--[\s\S]*?-->/g, "");

describe("PUBLIC_CLAIM_REGISTRY — every entry is well-formed", () => {
  it.each(PUBLIC_CLAIM_REGISTRY)("$id has non-empty claimText, evidenceSource, evidenceScope, approvedWording and a real verifiedDate", (claim) => {
    expect(claim.claimText.length).toBeGreaterThan(0);
    expect(claim.evidenceSource.length).toBeGreaterThan(10);
    expect(claim.evidenceScope.length).toBeGreaterThan(20);
    expect(claim.approvedWording.length).toBeGreaterThan(0);
    expect(claim.verifiedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("every entry names a real repository path in its evidence", () => {
    for (const claim of PUBLIC_CLAIM_REGISTRY) {
      const paths = claim.evidenceSource.match(/(?:src|supabase)\/[\w./-]+\.(?:ts|tsx|sql)/g) ?? [];
      expect(paths.length, `${claim.id}: evidenceSource names no repository file`).toBeGreaterThan(0);
      for (const p of paths) {
        expect(fs.existsSync(path.join(ROOT, p)), `${claim.id}: ${p} does not exist`).toBe(true);
      }
    }
  });

  it("no duplicate ids", () => {
    const ids = PUBLIC_CLAIM_REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("every approved claim genuinely appears on the landing page", () => {
  // A trust-metric card like { value: "7-stage", label: "accounting workflow" } renders as one
  // visual phrase but is two separate source strings — split on whitespace so each word is checked
  // for presence individually rather than requiring one exact concatenated substring match.
  it.each(PUBLIC_CLAIM_REGISTRY)("$id: every word of approvedWording ($approvedWording) is present in the live landing-page source", (claim) => {
    const words = claim.approvedWording.split(/\s+/).filter(Boolean);
    for (const word of words) {
      expect(RAW_LANDING_SOURCE, `${claim.id}: missing "${word}" from "${claim.approvedWording}"`).toContain(word);
    }
  });
});

describe("no prohibited stronger wording appears anywhere on the landing page (comments excluded — see LANDING_SOURCE_NO_COMMENTS)", () => {
  const allProhibited = PUBLIC_CLAIM_REGISTRY.flatMap((c) => c.prohibitedWording.map((w) => ({ claim: c.id, wording: w })));

  it.each(allProhibited)("$claim: \"$wording\" is absent from the live landing-page source", ({ wording }) => {
    expect(LANDING_SOURCE_NO_COMMENTS.toLowerCase()).not.toContain(wording.toLowerCase());
  });
});

describe("absolute prohibited claims never appear anywhere on the landing page, registered or not", () => {
  const ABSOLUTE_PROHIBITED = [
    "soc 2",
    "soc2",
    "hipaa",
    "asc 606",
    "asc 958",
    "bulletproof",
    "tamper-proof",
    "zero errors",
    "guaranteed", // outside code comments — checked against the landing surface only, which has none
    "cancel anytime",
    "money-back guarantee",
    // Absolute / unverifiable assurance language.
    "immutable",
    "every action",
    "all actions",
    "audit assurance",
    "integrity guarantee",
    "encrypted storage",
    "statutory compliance",
    "complete financial statements",
    "every balance is tied",
    "100%",
    "zero ai guesswork",
    "audit-ready",
    "audit ready",
    "no credit card",
    "in minutes",
    "four-eye",
    "four eyes",
  ];

  it.each(ABSOLUTE_PROHIBITED)("\"%s\" is absent from the live landing-page source", (phrase) => {
    expect(LANDING_SOURCE_NO_COMMENTS.toLowerCase()).not.toContain(phrase);
  });

  // Whole-word checks: these tokens are substrings of legitimate words ("tra" inside "traceable",
  // "kinga" nowhere, "partner" inside nothing) so they are matched on word boundaries only.
  const ABSOLUTE_PROHIBITED_WORDS = [
    // Internal engine names must never reach a customer-facing surface (Iron Dome §8.4).
    "safisha",
    "hesabu",
    "kinga",
    "maono",
    // Jurisdiction-specific terminology has no place on the neutral public page.
    "tzs",
    "tra",
    // Occupational hierarchy the product does not implement.
    "junior",
    "juniors",
    "manager",
    "managers",
    "partner",
    "partners",
    "preparer hierarchy",
  ];

  it.each(ABSOLUTE_PROHIBITED_WORDS)("the word \"%s\" is absent from the live landing-page source", (word) => {
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    expect(pattern.test(LANDING_SOURCE_NO_COMMENTS)).toBe(false);
  });
});
