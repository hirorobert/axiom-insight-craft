# Review confirmation visibility (DEFECT-UX-TB-REVIEW-CONFIRMATION-VISIBILITY-001) — synthetic evidence

**Mocked/synthetic only.** The real Prepare page in `dev-harness/trial-balance`, an in-browser backend (the real ingestion core, plus
stored decisions, a member, statements and a reprocess answer added for this capture). No hosted backend or customer data.

Scenario (`confirm.mjs`): upload 4 accounts → review (all pre-selected suggestions) → save → replace with a file adding 2 accounts
(1200, 4100) → review → save. 1280 and 390 px. `confirm.json` has the save label, the live status, the row marks and the record.

- `before/` — `main` components (with the harness extension only): "Save & reprocess"; no row marks; status "All decisions recorded";
  nothing after saving says what was confirmed or by whom. (The list had to be opened with "Show the full list": on `main` an all-
  suggested review shows no rows by default — #164 fixes that.)
- `after/` — this branch alone: each row "Suggested — not yet confirmed"; "Confirm 4/2 classifications and reprocess"; afterwards the
  Classification record: "2 accounts confirmed in this review by you (owner) … 4 accounts stood on a previously reviewed mapping."
- `combined/` — this branch merged with #164, #168 and #170: the same, with #164's full list and truthful status, and no layout problems.
