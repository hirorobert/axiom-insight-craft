# Proposed copy: CFOClose public website

**Status:** proposal only. Nothing is implemented. **Baseline:** `origin/main` `00a2653b5736e89447334e1147aa25f5308b0393`,
`src/content/landing/landingContent.ts`.
Every NEW or CHANGED string below is also in `proposed-strings.json`. Each one is checked by `evidence/copy-rules-check.mjs` against
the repository's current copy rules (`evidence/copy-rules-check.json`: **28/28 pass, 0 failures**; a deliberate violation was confirmed to fail).

Rules applied (from the baseline):
- `src/components/landing/__tests__/landingPage.test.ts`: no "audit-ready" or "compliant statements"; no buy, subscribe or trial wording; no TZS or mobile money; the hero is at most 40 words.
- `src/lib/commercial/__tests__/noCheckoutClaims.test.ts`: no "Request activation" or "activated by our team"; no "explore CFOCLOSE"; no provider names; no claim that online payment does or does not exist.
- `src/content/publicClaimRegistry.ts`: none of its 56 prohibited wordings (applied globally, which is conservative). Approved claim wording is kept verbatim.
- No engine names. No prices in copy or metadata (prices are server-decided at runtime).
- The brief: no compliance badge, no certification claim, no file upload.

---

## 1. Hero
| Field | Current | Proposed | |
|---|---|---|---|
| eyebrow, headline, supporting | *(as at baseline)* | unchanged | KEEP (supporting text is 34 words) |
| primary action | Explore plans → `#plans` | unchanged | KEEP |
| secondary action | View plans → `/plans` | **See a sample review** → `#sample` | CHANGE (pinned test R-5) |
| screenshot | all widths | ≥1024 px only (decision D-4) | CHANGE (layout) |

## 2. Sample review section (NEW, `id="sample"`, between Product and Plans)
All of this section's strings are listed verbatim in `proposed-strings.json` (ids `sample.*`). In summary:

| Key | Text |
|---|---|
| eyebrow / heading | Sample review / Explore an illustrative trial balance review |
| label (always visible) | Illustrative example — invented data |
| outstanding note | This example has two outstanding decisions. Two accounts are held because their names do not show how to classify them. In a real workspace, readiness depends on all applicable checks and the required decisions being recorded by authorised users. |
| step 1 | Arithmetic checks (run on import) are listed apart from the classification-dependent statement equation. The equation reads "Pending" until every account has a category; then it is recalculated, with figures, and explained as not showing that the categories are right. |
| step 2 disclosure | What this sample shows: how a decision is recorded, with who made it and when. In this illustration the invented evidence points to one treatment for each account, and the sample compares your choice with it. CFOClose itself records decisions; it does not check them against evidence. |
| held accounts | Invented evidence for each (a loan note; ledger detail of customer overpayments), three treatments, and **Record decision**. The outcome says whether the recorded treatment matches the invented evidence. |
| step 3 | In this sample, the trial balance is marked reviewed only when the arithmetic checks have passed, every account has a category, and both held accounts have a decision that matches the invented evidence. |
| limit (always visible) | What "reviewed" means: a reviewed trial balance is balanced and mapped. It is not reconciled to evidence, audited or approved. |

Data rules: an invented company (Kilele Supplies Ltd), invented accounts, figures and evidence, balanced at USD 127,150.00 each side. Accumulated
depreciation is suggested as Non-Current Assets. The SHA-256 value is shown as illustrative. The comparison with evidence belongs to the illustration only;
no product validation capability is claimed.

## 3. Trust strip
The approved claims stay verbatim. Each gets one plain line from its own `evidenceScope`. Each line **needs a registry entry** (for example an
`explanatoryWording` field) before it ships.
| Claim (KEEP) | Plain line (NEW) |
|---|---|
| A SHA-256 fingerprint is recorded for supported trial-balance imports. | It identifies the exact file you imported. It is not a signature and not a security certification. |
| Review decisions are associated with authenticated user accounts. | You can see who decided each account. Your firm still sets its own approval policy. |
| Supported historical outputs remain readable under the defined lifecycle and subscription rules. | Work you have prepared stays readable if a plan ends; preparing new work needs a current plan. |

## 4. Plans
| Where | Proposed | |
|---|---|---|
| after the plans intro | There is no free plan. You can explore an illustrative trial balance review above, using invented data. | NEW (factual: migration `20260925130000`) |
| table, notes, prices | unchanged; server-decided | KEEP |

## 5. Final band
| Field | Current | Proposed | |
|---|---|---|---|
| supporting | Choose the plan that fits your entities and users, or ask us to activate one for you. | Choose the plan that fits your entities and users. | CHANGE: the removed clause implies manual activation, against the `noCheckoutClaims` rule. |

## 6. FAQ (one addition; also add it to the `FAQPage` JSON-LD in `index.html`)
- **Q:** Can I see how CFOCLOSE works before choosing a plan?
- **A:** There is no free plan. The illustrative trial balance review on this page shows each step on an invented company, without an account. Plans run for 12 months and do not renew automatically.

## 7. Metadata (correctness fix S-1)
| Where | Current | Proposed |
|---|---|---|
| `index.html` meta, `og:` and `twitter:` description; `src/lib/seo/publicPages.json` `/` | Import a trial balance, run the checks and record a classification decision for every account. Subscriptions are activated by our team; financial reporting is a pilot by invitation. | Import a trial balance, run the checks and record a classification decision for every account. Financial reporting is a pilot by invitation. |

## Not proposed
No "IFRS compliant", "audit-ready", "certified" or "secure" badges. No logos, counts or testimonials. No ranking, conversion or retention promise. No change
to the brand name, casing, prices, entitlements or terms.
