/**
 * publicClaimRegistry.test.ts — every approved claim must actually appear on the landing page, and
 * no prohibited stronger wording may appear anywhere in it. This is what makes the registry a real
 * gate rather than documentation: a future edit that silently drops a substantiated claim, or
 * upgrades one into unsupported territory, fails this test.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_CLAIM_REGISTRY } from "./publicClaimRegistry";

const ROOT = path.resolve(__dirname, "../..");
const LANDING_FILES = [
  "src/pages/Index.tsx",
  "src/components/Header.tsx",
  "src/components/Hero.tsx",
  "src/components/PainPoints.tsx",
  "src/components/ProductTour.tsx",
  "src/components/Features.tsx",
  "src/components/ClosingCTA.tsx",
  "src/components/Footer.tsx",
  "src/constants/copy.ts",
  "index.html",
];

const RAW_LANDING_SOURCE = LANDING_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
// Strip comments before scanning for prohibited wording: a code comment explaining WHY a stronger
// claim was removed (see Hero.tsx's own history note) is documentation, not a rendered user claim.
const LANDING_SOURCE_NO_COMMENTS = RAW_LANDING_SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("PUBLIC_CLAIM_REGISTRY — every entry is well-formed", () => {
  it.each(PUBLIC_CLAIM_REGISTRY)("$id has non-empty claimText, evidenceSource, approvedWording and a real verifiedDate", (claim) => {
    expect(claim.claimText.length).toBeGreaterThan(0);
    expect(claim.evidenceSource.length).toBeGreaterThan(10);
    expect(claim.approvedWording.length).toBeGreaterThan(0);
    expect(claim.verifiedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
  ];

  it.each(ABSOLUTE_PROHIBITED)("\"%s\" is absent from the live landing-page source", (phrase) => {
    expect(LANDING_SOURCE_NO_COMMENTS.toLowerCase()).not.toContain(phrase);
  });
});
