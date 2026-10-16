// Checks every proposed public string against the copy rules the repository already enforces at the baseline.
// Usage (repository root): node research/landing-review/evidence/copy-rules-check.mjs > research/landing-review/evidence/copy-rules-check.json
// Exit code 1 if any string breaks a rule or (inMockup) is missing from the mockup verbatim.
import fs from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const R = (p) => fs.readFileSync(path.join(REPO, p), "utf8");
const proposed = JSON.parse(R("research/landing-review/proposed-strings.json"));

// Sources of each rule, at the baseline. The regexes are copied from the cited test lines.
const RULES = [
  { id: "landing-no-overclaim", source: "src/components/landing/__tests__/landingPage.test.ts", re: /financial statements in minutes|audit-ready|compliant statements/i },
  { id: "landing-no-acquisition", source: "src/components/landing/__tests__/landingPage.test.ts", re: /\b(Buy( now)?|Subscribe|Checkout now|Start (a |your )?(free )?trial|Free trial|Pay now)\b/i },
  { id: "landing-no-preview-language", source: "src/components/landing/__tests__/landingPage.test.ts", re: /stand behind|not a public commercial offer|This preview/i },
  { id: "landing-no-jurisdiction-payment", source: "src/components/landing/__tests__/landingPage.test.ts", re: /TZS|mobile money/ },
  { id: "no-checkout-claims", source: "src/lib/commercial/__tests__/noCheckoutClaims.test.ts", re: /there is no online (payment|checkout)|online payment is available|pay online now/i },
  { id: "no-manual-activation", source: "src/lib/commercial/__tests__/noCheckoutClaims.test.ts", re: /Request activation|activated by our team/ },
  { id: "no-workspace-explore", source: "src/lib/commercial/__tests__/noCheckoutClaims.test.ts", re: /Create a workspace and explore|explore CFOCLOSE/i },
  { id: "no-provider-names", source: "src/lib/commercial/__tests__/noCheckoutClaims.test.ts", re: /mobile money|M-Pesa|Snippe/i },
  { id: "no-engine-names", source: "CLAUDE.md §3 / §8.4", re: /\b(SAFISHA|HESABU|KINGA|MAONO)\b/i },
  { id: "no-price-in-copy", source: "src/content/publicClaimRegistry.ts (no price in metadata or static copy; prices are server-decided)", re: /\bUSD\b|\$\s?\d|\b\d{2,}(,\d{3})*\s?(per year|\/yr|a year)\b/i },
  { id: "assurance-vocabulary", source: "brief: no compliance badge or certification claim", re: /\b(compliant|compliance|certified|certification|guarantee[sd]?|tamper|immutable|bank-grade|secure)\b/i, negationAllowed: true },
];

// The claim registry's prohibited wordings, parsed from the TypeScript source (applied globally: conservative).
const registry = R("src/content/publicClaimRegistry.ts");
const prohibited = [...new Set([...registry.matchAll(/prohibitedWording:\s*\[([\s\S]*?)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])))];

const mockup = R("research/landing-review/mockup/sample-review-mockup.html")
  .replace(/<!--[\s\S]*?-->/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
  .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const negated = (text, word) => new RegExp(`\\bnot (a |an )?(\\w+ )?${word}`, "i").test(text);
const report = { baseline: proposed.baseline, prohibitedWordingCount: prohibited.length, results: [], failures: 0 };
for (const s of proposed.strings) {
  const hits = [];
  for (const rule of RULES) {
    const m = s.text.match(rule.re);
    if (!m) continue;
    const word = m[0].toLowerCase();
    if (rule.negationAllowed && (s.allowNegated ?? []).some((w) => word.startsWith(w)) && negated(s.text, word)) { hits.push({ rule: rule.id, match: m[0], status: "allowed-negation" }); continue; }
    hits.push({ rule: rule.id, source: rule.source, match: m[0], status: "FAIL" });
  }
  for (const w of prohibited) if (s.text.toLowerCase().includes(w.toLowerCase())) hits.push({ rule: "claim-registry-prohibited", match: w, status: "FAIL" });
  const words = s.text.split(/\s+/).length;
  const inMockup = s.inMockup ? mockup.includes(s.text) : null;
  const fail = hits.some((h) => h.status === "FAIL") || inMockup === false;
  if (fail) report.failures++;
  report.results.push({ id: s.id, words, inMockup, hits, status: fail ? "FAIL" : "PASS" });
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.failures ? 1 : 0);
