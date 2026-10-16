# Proposed copy: CFOClose public website

**Status:** proposal only. Nothing is implemented. **Baseline:** `origin/main` `00a2653b5736e89447334e1147aa25f5308b0393`,
`src/content/landing/landingContent.ts`.
Every NEW or CHANGED string below is also in `proposed-strings.json`. Each one is checked by `evidence/copy-rules-check.mjs` against
the repository's current copy rules (`evidence/copy-rules-check.json`: **20/20 pass, 0 failures**; a deliberate violation was confirmed to fail).

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
| secondary action | View plans → `/plans` | **Explore an illustrative review** → `#sample` | CHANGE (pinned test R-5) |
| screenshot | all widths | ≥1024 px only (decision D-4) | CHANGE (layout) |

## 2. Illustrative review section (NEW, `id="sample"`, between Product and Plans)
| Key | Text |
|---|---|
| eyebrow | Illustrative example |
| heading | Explore an illustrative trial balance review |
| intro | An invented company with invented figures, showing the three steps of a trial balance review. Nothing you choose here is saved, and you cannot upload a file. |
| label (always visible) | Illustrative example — invented data |
| outstanding note (always visible) | This example has two outstanding decisions. They are left open so you can see how accounts are held for review. In a real workspace, readiness depends on all applicable checks passing and the required decisions being recorded by authorised users. |
| step 1 | Every import is checked: the file is read, amounts are valid numbers, debits equal credits, and the statement equation holds. Each check reports what it found. |
| fingerprint | It identifies the exact file that was imported. It is not a signature and not a security certification. |
| step 2 | Each account is mapped to a statement category. Where the workspace cannot map an account on evidence it can defend, it holds the account for a decision. |
| step 3 | When all applicable checks have passed and the required decisions are recorded, the trial balance is marked reviewed and ready for statement preparation. In this example that happens only after the two outstanding decisions. |
| close | Checks, mapping and a recorded review are what the trial balance workspace provides today. Financial reporting is a pilot by invitation and is not shown here. |
| limit (always visible) | What "reviewed" means: a reviewed trial balance is balanced and mapped. It is not reconciled to evidence, audited or approved. |

Data rules: an invented company (Kilele Supplies Ltd), invented accounts and figures, balanced at USD 127,150.00 each side. There is no
contra-asset mis-suggestion (accumulated depreciation is suggested as Non-Current Assets). The SHA-256 value is shown as illustrative.

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
