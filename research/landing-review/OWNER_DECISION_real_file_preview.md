# Owner decision: a free preview on a visitor's real file

**Status:** OPEN, for the owner. **Baseline:** `origin/main` `00a2653b5736e89447334e1147aa25f5308b0393`. It is separate from the illustrative (synthetic) review, which needs no decision beyond D-1 in `REVIEW.md`.
**Recommendation:** **not now.** Ship the illustrative review first. If the evidence then shows that visitors still need their own file
(hypothesis H-1), start with option D (sales-assisted), which needs no code, before any self-serve option.

Nothing in this document changes entitlements, pricing or terms. Each option states what *would* have to change.

---

## 1. Why this is a decision and not a copy change

- **The commercial position is deliberate.** Migration `20260925130000` retired the Free plan ("There is no trial"). Migrations `20260925140000` and
  `20260926160000` refuse new uploads, *and the processing of existing uploads*, for accounts without a current plan, at the
  database boundary and including the service role. Any real-file preview reverses part of that decision.
- **The data is sensitive.** A trial balance is a client's complete financial position, often uploaded by an accountant on behalf of a
  third party.
- **The legal pages are not yet reviewed.** `/terms` and `/privacy` have not been reviewed by a lawyer
  (`LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE`). Accepting third-party financial data from anonymous visitors raises that exposure.
- **Sign-up email is capacity-limited.** Supabase's default mailer has a low hourly send cap (`PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED`). An
  account-gated preview would push more sign-ups through that cap.

---

## 2. Options

| | A. Not now | B. Browser-only check | C. Signed-in limited preview | D. Sales-assisted preview |
|---|---|---|---|---|
| What the visitor gets | The illustrative review (invented data) | Their file parsed **in the browser**; totals and the balance check only; nothing uploaded | One real upload processed by the product: checks and suggested mapping; no reviewed status; expires | A guided session where staff run the visitor's (or an anonymised) file in a licensed demonstration workspace |
| Entitlement change | None | None (no server path) | **Yes**: a new preview capability or plan; a migration; changes to the processing wall | None (it uses an existing paid licence) |
| Server cost | None | None | Function invocations, storage, database rows per preview | Staff time |
| Privacy | No real data | Best: the file never leaves the device | Real client data held server-side by an unpaid, unverified party | Real data under a direct, agreed relationship |
| Main risk | H-1 stays unanswered | **Two engines**: the browser result can differ from the product's server checks, which is the authority. It must be labelled non-authoritative and kept to arithmetic only | Abuse, retention and legal exposure; it reverses retire-Free | Does not scale |
| Effort | None | Small to medium, plus a long-term duty to keep the browser check in line with the server | Large (migration, wall changes, expiry job, abuse controls, legal) | None in code |

---

## 3. If C is ever chosen: minimum conditions

These are listed so the decision can be costed, not as a plan.

**Costs**
- Per-preview cost is one `process-trial-balance` run plus its storage and rows. It is bounded by the existing upload limits (below). Estimate it from
  the hosted function's measured duration before approving; no figure is assumed here.
- There is an operational cost for the expiry job, the abuse review and support for users who never convert.

**Privacy**
- An explicit statement at upload: what is stored, for how long, who can see it, and that it is deleted at expiry.
- A lawful basis and processor wording reviewed by a lawyer *before* launch. The current pages are not reviewed.
- No use of preview files for any other purpose (training, analytics, demos).

**Retention**
- Automatic hard deletion of the file and every derived row at a fixed expiry (for example 72 hours). This is a hard delete, not a soft delete, and it is
  logged.
- No export, no reviewed status, no sign-off, and no carry-over into a paid workspace unless the visitor re-uploads after paying.
- A conflict to resolve: "protected history" (supported outputs stay readable) must explicitly *not* apply to preview outputs.

**Resource limits** (use the existing ingestion bounds; do not add a looser preview path)
- 10 MB file, 10,000 rows, 120,000 cells, 2 MB decompressed expansion (current provisional `tb-upload-policy` limits).
- One preview per account, and at most N per day across the platform, with a hard stop.

**Abuse controls**
- An account is required. Bot protection on sign-up and preview. Per-account and per-IP rate limits.
- No file is served back to the browser. Parsing stays inside the existing bounded reader. XLSX macros and external links are never evaluated.
- Monitoring for duplicate-account farming (the same file fingerprint across accounts).
- A kill switch: a server-side flag, never a browser-controlled one.

---

## 4. What is needed from the owner

1. Approve or decline **D-1** (the illustrative review). It needs no change of position.
2. For the real-file preview, choose **A** (recommended) or **D** now. Revisit **B** or **C** only with evidence from the illustrative review (H-1) and,
   for C, after the legal review and SMTP configuration gates are closed.
