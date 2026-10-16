# Handoff to NORMAL: four authenticated-journey observations

From the public-website review (research only, branch `research/landing-review-20261016`). **NORMAL owns these repairs.**
Please check each one against your current candidate and close any that are already fixed there. Nothing here is a competing
implementation, and I will not repair any of them.

- **Reviewed baseline (code references):** `origin/main` `00a2653b5736e89447334e1147aa25f5308b0393`.
- **Screenshots:** a local real-application run at 2026-10-16 12:14 +03:00, with demonstration company "Mto Holdings Limited". **They come from a build newer than the baseline**: "Upload your trial balance to start" and "Add the entity you are reporting on" do not exist at `00a2653`. So the line numbers below may have moved in your candidate.
- **Files:** `evidence/authenticated/` (SHA-256 below).

| # | Observation | Screenshot | Code at baseline |
|---|---|---|---|
| 1 | With review pending, the trial-balance status line shows one account's suggestion: "Suggested from the account-name dictionary (Operating bank account) — confirm before the trial balance is accepted." | `05a-account-review-pending.png` | The card renders `verdict.reason`: `src/components/workspace/CurrentTrialBalanceCard.tsx:98`. The per-account text originates at `supabase/functions/process-trial-balance/index.ts:2208` (tier 4). How it becomes the card-level reason is not traced here. |
| 2 | The noun for the thing being reported on varies: public "entities"; "Your engagements" (H1); "Companies" with "Add a company"; "Add the entity you are reporting on"; the plan box says "Active entities". | `02-first-visit-1280.png`, `02-first-run-1280.png` | `src/pages/workspace/EngagementHub.tsx:215`, `:238` and `:361`; public: `src/content/landing/landingContent.ts` (`LANDING_PLANS_COPY`) |
| 3 | The upload accepts `.xls`; the public copy and FAQ say CSV or XLSX only. | `02-first-visit-1280.png` | `src/components/TrialBalanceUpload.tsx:276`, `src/lib/ingestion/uploadFlow.ts:63`, `src/lib/workspace/trialBalanceManagement.ts:170`; public: `LANDING_SERVICES_COPY.formats`, FAQ `formats`, claim `import-formats` |
| 4 | Seat wording differs: public "1 included · more available"; plan box "1 · additional seats depend on your licence". | `02-first-visit-1280.png` | `src/components/commercial/CurrentPlanPanel.tsx:35` vs `src/content/landing/proposedPlans.ts:43` |

For item 3, the public copy needs a decision too: either `.xls` is supported (then the public copy and the claim registry change) or it isn't (then the upload stops accepting it). I've left the public side for your decision.

Screenshot SHA-256:
```
e02c2f4885d4376fe92fabf1e7dbda42798916312fb31efc687aa99172b449e0  02-first-visit-1280.png
e9833ad54d25b97114820117cac78bc9f41ac78e0fe9e51a68aa3a39bf3738b1  02-first-run-1280.png
addf8ab88e1744afbc75213ead3cf44455006d81ff2554db14fd345af2061656  05a-account-review-pending.png
```
