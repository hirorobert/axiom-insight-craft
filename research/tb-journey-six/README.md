# TB journey — six issues: before/after evidence (2026-10-18)

**All runtime evidence here is mocked/synthetic.** It comes from the committed harness `dev-harness/journey` (on the
fix branch): the real `EngagementHub` + `FirstUpload`, Dashboard's real routing decision (`decideReturningUserRoute`),
the real `prepare` alias redirect and the real `PrepareWorkspace`, against the trial-balance harness's in-browser
synthetic backend (`dev-harness/trial-balance/syntheticBackend.ts`, which runs the real ingestion core) extended with
draft/entity/period answers. **No hosted backend, real account or customer data was used.** The workspace Overview is
not mounted (its route shows a labelled placeholder). The harness's draft-commit refusal and replacement are modelled
on the documented outcomes, not the edge function.

- `before/` — captured on `origin/main` `c2f50c9` with unmodified components (only the harness added).
- `after/` — captured on `fix/tb-journey-six`.
- `journey.mjs` — the capture script (headless Chrome via `scripts/browser-acceptance/cdp.mjs`); `journey.json` holds
  the route, visible actions, live regions, focus and `layoutProblems` for every state, at 1280 px and 390 px.

| Key | State |
|---|---|
| A1–A7 | First upload: home → card (A2: currency search typed / no match) → after check → result → refresh → Back |
| B1–B2 | Saved draft on return → continued |
| C1–C8 | Existing engagement: rows, Company options (purpose), row destination, replacement from home, file options, upload history focus, review focus |
| D1–D3 | Refusal (period currency), failed check (503), check already running (409) |
| keyboard-home | Tab order on the account home (journey.json) |

Key differences:
- A4/A5: before — "See the result" needed a click and the URL had no upload id; after — the result opens directly at `…/review?upload=<id>`.
- A7: before — Back from the result left the app (`about:blank`: the result replaced the home's history entry); after — Back returns home, which routes to the same entity/period.
- C1/C3: before — "Resume" → the Overview; after — "Review account classifications" → that upload's review.
- B1: before — a small underlined link under a filled "Choose a file"; after — a "Saved upload" card with "Continue saved upload".
- A2: before — a separate search box filtering a closed native select (typing shows nothing); after — a combobox listing matches or "No currencies found".
- C2: before — "Change purpose" inline in the company heading; after — "Company options" with the purpose's meaning.
- C5/C6: before — "Resolve account classifications" (outline) beside Replace/Remove; after — "Review account classifications" leads, "File options" holds Replace, Remove and Upload history.
- D3: before — a running check was shown as a red alert with "Try again"; after — that upload's page opens, "Processing … This page updates itself".
