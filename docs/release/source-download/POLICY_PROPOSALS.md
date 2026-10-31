# Source-file retrieval - policy proposals (PROPOSED; NOT IMPLEMENTED in this candidate)

The candidate keeps the **current capability policy**: the function authorizes with `can_user_act_on_workspace(user, company, 'manage_source_files')` -
the right that already governs uploading, replacing and removing the source (the owner with a current plan, or an active explicit grant). Nothing
below is built, silently or otherwise; each item needs an owner decision and, where noted, a migration of its own. The bucket's policies are not
widened by any of them.

## 1. Download rights from accounting / evidence capabilities, not role names
**Problem.** `manage_source_files` is a *file-management* right (it can replace or remove the source). Retrieving evidence is a *read*, and the people
who need it - a reviewer checking a figure, a preparer reconciling, an external auditor - should not need the power to replace or remove it. Role
names (`partner`, `manager`, `preparer`) are labels on `firm_members` and are not authority anywhere in this system's file rules.
**Proposal.**
- Add one explicit read capability (working name `view_source_evidence`) beside the existing four (`manage_source_files`, `prepare_trial_balance`,
  `review_close`, `administer_workspace`), granted through the existing `grant_workspace_capability` path so it is named, revocable and event-logged.
- Define the policy as a table of **capability -> action**, e.g. retrieval: `view_source_evidence` OR `manage_source_files`; replace/remove: `manage_source_files` only. Whether `prepare_trial_balance`
  and `review_close` *imply* retrieval (they plainly need the evidence to do their work) is a decision for the owner, stated in the table, not inferred from titles.
- Mechanically: extend the capability allow-lists in `grant_workspace_capability` and `workspace_authority_basis` (a migration), then change `DOWNLOAD_CAPABILITY` to a set. The function keeps
  re-checking per request.
**Open:** the original file can hold more than the trial balance (extra columns, notes); a read right to it is a wider disclosure than reading the processed result. The owner should decide
whether retrieval needs its own justification (a reason field) or only a capability.

## 2. Retrieval of historical evidence after plan expiry, distinct from revoked membership
**Today.** `workspace_authority_basis` returns no basis without a current plan, so a lapsed workspace ("read-only archive" in the UI) cannot download its own evidence, although
the UI promises "historical records stay available". That predicate is shared with writes, so it must not simply be loosened.
**Proposal.** Separate two situations that are different in kind:
- **Plan lapsed (account-level):** the workspace is read-only. People who held a *read* right at lapse keep **read-only** retrieval of existing evidence; every write stays blocked.
- **Membership or grant revoked / person suspended (person-level):** no retrieval, immediately, whatever the plan.
Implement as a **new read predicate** (`workspace_can_read_evidence(user, company)`: owner or active read-capable grant, active named-user access, *ignoring* plan state), used only by retrieval, leaving
`workspace_authority_basis` untouched. A time limit after lapse (and the obligation to keep records) is a retention policy decision to be confirmed with counsel; this document does not assert any statutory period.

## 3. Audited download-authorization events - without claiming a download completed
**Proposal.** An append-only table (new migration; RLS, no client write, read by the workspace owner and an administrative capability), written by the function:
`company_id, upload_id, actor_user_id, authority basis/capability, outcome (authorized | refused_forbidden | refused_unavailable ...), url_expires_at, request id, occurred_at`.
**What an event means - stated precisely.** `authorized` records that the server **issued a 60-second link**. It does **not** prove the file was fetched, fully received, or saved: the bytes travel from Storage
to the browser without passing through the function, and Storage reports nothing back. Any "completed" signal could only be a **client-reported** event (the browser's SHA-256 matched), which is
user-attested rather than server-observed, and must be recorded as a separate, labelled event type if recorded at all. Never store the URL or token; rate-limit or aggregate refusals so a loop cannot flood the table;
decide retention with the audit-log owner.
**Interaction with the 60-second window:** the log is the only record that a link existed for that window, which is exactly what an investigator needs after a revocation.
