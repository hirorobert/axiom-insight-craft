# 00 — Control & Security Findings (surfaced first)

No credential exposure, RCE, or data-exfiltration-in-flight was found. One **live control
contradiction** and three latent/quality items are registered below. All are repo-at-`b32aa4f`;
deployed exposure is UNKNOWN.

## C-1 — Sign-off segregation-of-duties NOT enforced on the live path — HIGH (doc invariant false)

- **Claim (CLAUDE.md §4.6):** "Financial sign-offs require role = partner or manager … enforced
  by the `hesabu_gate_before_signoff` trigger on `statement_sign_offs`."
- **Reality:** the effective trigger (`supabase/migrations/20260713090437_...sql`, sign-off gate
  `~:211-257`) blocks an insert **only** until a passing HESABU validation exists
  (`gate_satisfied = TRUE`). It contains **no role predicate**. RLS on `statement_sign_offs`
  (`20260707183617_...sql:302-317`) is **firm-membership-only** — no `role` check. A member of
  any role (including a junior/preparer) can record a sign-off once HESABU passes.
- The owner/partner role gate exists **only** in the gated-off World-B publication path
  (`fs_set_publication_state`, `20260919110000_...sql:1138-1140`), on a **different** table.
- **Corroboration:** `ARCHITECTURE-GAP.md:106,99` already states "no DB role gate — a control failure."
- **Exposure:** bounded today because statement *generation* (World B) is gated off, so the
  legacy sign-off table sees little live traffic — but the invariant as written is inaccurate and
  must not be relied on. **Owner decision:** add a role predicate to the legacy gate (or formally
  retire the legacy path in favour of World B's gate) and correct §4.6.

## C-2 — `policy-compass` data-handling + grounding (latent; unreachable today) — MEDIUM

- `supabase/functions/policy-compass/index.ts` calls an LLM (Lovable gateway →
  `google/gemini-2.5-flash`, `:165-179`). Auth is JWT-only (`validateAuth`, `:98-104`) with
  **no `assertCompanyMembership`** and **no `companyId`** at all.
- It forwards the request-body `financialData` **verbatim** to the model
  (`:162-163`, `JSON.stringify(financialData)`), with no schema, no redaction, no tenant scoping.
- **No output validation/grounding.** The system prompt and worked example cite **US-GAAP
  (`ASC 606-10`, FASB)** (`:142-159`) — the wrong framework for TZ / IFRS-for-SMEs / IPSAS, and
  citations are model-authored (can be fabricated).
- **Status:** DISABLED/unreachable — `PolicyCompass.tsx` (the only invoker, `:74`) is unrouted
  (not imported by `tzPack.tsx` or any router; CLAUDE.md §7 agrees). Do **not** route it without a
  data-handling (what may be sent, retention), tenant-isolation and output-grounding decision.
  Provider retention/training/residency for the Lovable→Gemini path: **UNKNOWN** (no documented
  evidence in repo).

## C-3 — `generate-xbrl` silent framework default — MEDIUM (Iron Dome §4.4) — unreachable today

- `supabase/functions/generate-xbrl/index.ts:118`:
  `const reportingFramework = upload.reporting_framework ?? "ifrs_for_smes"` — a silent default,
  violating Iron Dome §4.4 "no silent defaults" (framework must never be guessed). IPSAS is
  hard-blocked (`:121-130`). The function has **no UI invoker** (grep: no
  `functions.invoke("generate-xbrl")`), depends on an external Arelle worker
  (`SAFISHA_WORKER_URL`), and sources from KINGA tables, not the canonical model. Fix the default
  (fail closed) before any route is added.

## C-4 — "Processing with AI…" copy over a deterministic classifier — LOW (honest-copy)

- `src/components/TrialBalanceUpload.tsx:407` shows "Processing with AI..." while
  `process-trial-balance` runs a **fully deterministic** 6-tier classifier (no model call — see
  `01-ai-inventory.md`). This overclaims AI and conflicts with the governing principle (no
  overstated capability). Reword to describe what actually runs (e.g. "Classifying accounts…").

## C-5 — In-product Claude engines bypass the canonical membership assert — LOW (RLS-mitigated)

- `maono-decide/index.ts:204` and `maono-root-cause/index.ts:132` authenticate with inline
  `supabase.auth.getUser()` and **do not** call `assertCompanyMembership` from `_shared/auth.ts`
  (contra CLAUDE.md §4.3/§5). Isolation rests entirely on RLS of `variance_runs` et al. Mitigated
  further by having **no UI trigger** today (see `01-ai-inventory.md`). If these are ever wired to
  a live path, add the canonical membership assert.
