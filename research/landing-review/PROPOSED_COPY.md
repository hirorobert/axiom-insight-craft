# Proposed copy: CFOClose public website

**Status:** proposal only. Nothing is implemented. **Baseline:** `origin/main` `00a2653b5736e89447334e1147aa25f5308b0393`,
`src/content/landing/landingContent.ts`.
Every NEW or CHANGED string below is also in `proposed-strings.json`. Each one is checked by `evidence/copy-rules-check.mjs` against
the repository's current copy rules (`evidence/copy-rules-check.json`: **36/36 pass, 0 failures**; a deliberate violation was confirmed to fail).

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
| eyebrow, headline | *(as at baseline)* | unchanged | KEEP |
| supporting | Import a trial balance, check it, and map every account… professional judgement stays with you. (34 words) | **Check your trial balance, review account classifications, and keep a traceable record of your decisions.** (15 words) | CHANGE. Pinned by `landingPage.test.ts`, which matches the current sentence. |
| primary action | Explore plans → `#plans` | **See a sample review** → `#sample` | CHANGE (pinned test R-5) |
| secondary action | View plans → `/plans` | **View plans** → `/plans` | KEEP |
| screenshot | all widths | ≥1024 px only (decision D-4) | CHANGE (layout) |

**Capability check for the supporting sentence:**
- *Check your trial balance*: the import checks (R-3).
- *Review account classifications*: account review, with accounts held for a decision.
- *A traceable record of your decisions*: decisions are written to an append-only ledger (`account_review_decisions`, migration `20260816120000`) with a server-resolved authenticated account. This is the `attributable-review-decisions` claim.

It avoids that claim's prohibited wordings ("every decision", "unbroken audit trail") and every other registry prohibition (`copy-rules-check.json`). The phrase "professional judgement stays with you" leaves the hero. The sample's disclosure ("CFOClose records decisions; it does not check them against evidence") carries the same limit.

## 2. Sample review section (NEW, `id="sample"`, between Product and Plans)
Every string is in `proposed-strings.json` (`sample.*` and `completed.*`). In summary:

| Element | Text or behaviour |
|---|---|
| lead (always visible) | **Balanced · 2 accounts need your review.** with the label **Illustrative example — invented data** |
| actions | **View completed example** (read-only view, `#completed-example`); **Try the two decisions** (optional; expands in place) |
| disclosure: Checks | Arithmetic checks run on import and pass. The balance note says it is not a classification check. The statement equation is **Pending** until every account has a category, then recalculated and explained. The fingerprint is explained. |
| disclosure: All 16 accounts | 14 mapped and 2 held; a held row shows the visitor's recorded decision if one is made |
| Try the two decisions | Choosing records nothing; only **Record decision** records, as "Sample reviewer". Next to each set of choices: **Guided example—not automated evidence checking.** Director account: "The credit balance suggests the company owes the director. The repayment terms decide the category." (invented evidence: a loan note repayable on demand). The outcome reads "Recorded: …" plus the guided-example comparison. |
| completed example (read-only) | The two decisions supplied with the example: "Example reviewer (invented)", date and time, and invented basis. Then the recalculated equation and the remaining limitations (recorded is not validated; the comparison is guided-example only; reviewed is not reconciled, audited or approved; financial reporting is a pilot). "Viewing them records nothing for you." |
| limit (always visible) | What "reviewed" means … not reconciled to evidence, audited or approved. In a real workspace, readiness depends on all applicable checks and the required decisions being recorded by authorised users. |

Data rules: an invented company, invented people, figures and evidence, balanced at USD 127,150.00 each side. No product validation capability is claimed.

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
