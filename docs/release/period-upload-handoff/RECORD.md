# Period setup and trial-balance handoff

## Problem and resulting behaviour

An existing FY2025 workspace with a saved FY2024 link said its prior period was linked, but reopening Settings loaded blank prior-date inputs. The period setup returned to FY2025, while the company list need not show FY2024: the setup RPC creates its fiscal period, not necessarily an engagement for that year. A tester could therefore upload the prior-year file in FY2025 and believe the save had failed.

The existing Settings form now resolves the saved prior-period ID from the same RLS-scoped company read and prefills its dates and currency. The initial form is clean; a saved prior link cannot be unchecked as if that would remove it. Missing or inconsistent linked records block saving rather than displaying guessed dates.

The normal Trial Balance page displays the current saved dates/currency and a direct link to the saved prior year. The prior-year page offers the matching return link when unambiguous. Settings saves invalidate this read. Failed reads provide Retry; stale reads from an earlier company cannot create cross-company links. No upload IDs or report-version queries are carried to another period. A new prior-year engagement still requires the existing explicit service-selection action if not already open.

The uploader prominently states the company/year destination before and after a file is chosen. File names do not become accounting authority; no automatic filename inference, upload relocation, certification or review is added.

## Boundaries

Frontend only. No migration, function deployment, hosted write, accounting change, AI/provider call, payment change or Lovable agent request is needed. Existing period-authority and upload functions, immutable history, role restrictions, management-window save protection and review gates remain authoritative.

This does not correct the tester's already misfiled source. Correct it only through the existing replace/cancel path; retain its history. It also does not fix the separate bank-loan classification suggestion observed during acceptance.

## Verification

Mounted-component regressions cover restored dates/currency, clean initial state, exact setup arguments, missing linked-record refusal, forward/reverse links, retry, settings invalidation, stale company reads and accessibility. Pure tests cover non-calendar dates, different prior currency, absent links, malformed dates, ambiguity and adjacency. Existing engagement continuity tests retain one save and the original mounted task.

Local full unit suite: 6,425 passed, 10 skipped and 12 todo (378 passing files; one skipped). Focused mounted-component and pure handoff regressions: 17 passed. Lint: zero errors and 177 existing warnings. Production build, pack isolation, migration authority and release-journal checks passed. TypeScript results are recorded in the delivery handoff. Hosted sign-in and published-build verification remain pending until this frontend is published.
