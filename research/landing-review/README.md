# Landing review (research package)

Research only: no production file is changed by this branch, nothing is published, and nothing is wired into the app.
**Baseline:** `origin/main` `00a2653b5736e89447334e1147aa25f5308b0393`. The live site was checked on 2026-10-16 (see `REVIEW.md` §1 for deployment identity).

| File | What it is |
|---|---|
| `REVIEW.md` | The review: repository findings, live observations, deployment identity, technical SEO (facts kept apart from recommendations), accessibility and reflow, hypotheses, owner decisions |
| `PROPOSED_COPY.md` | New and changed public copy, checked against the current commercial and claim rules |
| `proposed-strings.json` | The same strings in machine-readable form (input to the copy check) |
| `mockup/sample-review-mockup.html` | A runnable, self-contained mockup of the illustrative review (invented data; no network requests) |
| `OWNER_DECISION_real_file_preview.md` | The separate owner decision on a real-file free preview |
| `IMPLEMENTATION_FILES.md` | The exact production files for a later bounded implementation |
| `HANDOFF_NORMAL.md` | Four authenticated-journey observations for NORMAL, with evidence |
| `evidence/` | Results, scripts and screenshots (below) |

## Replay (from the repository root)
```bash
node research/landing-review/evidence/copy-rules-check.mjs > research/landing-review/evidence/copy-rules-check.json
```
```bash
node research/landing-review/evidence/seo-probe.mjs > research/landing-review/evidence/seo-probe.json
```
```bash
node research/landing-review/evidence/run-checks.mjs
```
- `copy-rules-check.mjs` reads the baseline's rule sources (the claim registry is parsed live) and exits 1 on any failure.
- `seo-probe.mjs` makes read-only HTTP GETs to the public origin.
- `run-checks.mjs` uses the repository's headless-Chrome driver (`scripts/browser-acceptance/cdp.mjs`, which needs local Chrome or Edge). Its live part is read-only (navigation, measurement and screenshots only). Use `--no-live` to check the mockup alone. In a network-restricted sandbox, Chrome may need network access for the live part.
- To view the mockup, open `mockup/sample-review-mockup.html` in any browser.

## Evidence index
- `evidence/results.json`: mockup reflow (320, 390, 1280 px), keyboard and focus, regression scenarios S0–S6 (the runner exits 1 if any fails), no-JavaScript fallback; live reflow, hero image scale, rendered head metadata and keyboard focus.
- `evidence/seo-probe.json`: status codes, head metadata, JSON-LD, robots.txt, sitemap, host redirects, transfer sizes and the deployment marker.
- `evidence/copy-rules-check.json`: 29/29 proposed strings pass (two expected negations, "not a … certification", are allowed explicitly).
- `evidence/screenshots/`: mockup at 320, 390 and 1280 px (top, section, held accounts), an unsupported decision, the reviewed state, the no-JavaScript fallback at 320 and 1280 px, and the live hero at all three widths.
- `evidence/authenticated/`: three screenshots referenced by `HANDOFF_NORMAL.md` (demonstration company; their build differs from the reviewed baseline; exact identity unverified).
