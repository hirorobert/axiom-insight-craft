# 08 — Decision Package

## Executive verdict (≤1 page, plain language)

> **CORRECTED — see `09-evidence-reconciliation.md`.** Read the blanket "mostly built" phrasing as
> the per-capability table in `09` §3 (implemented / tested-at-which-level / disabled / remaining
> verification). "Live" means "reachable in inspected source" (`09` §1); engine activation is **not
> approved** and S2 below is recast as verification-and-completion (`09` §7). The sign-off finding
> is resolved on `69155ae` (`09` §4).

**The real path from an unfamiliar trial balance to professional, evidence-supported financial
statements is largely *implemented in source* — and largely *gated off / not end-to-end verified*.**
The substantial parts exist in code (each qualified per-capability in `09` §3):
a deterministic trial-balance parser, period-agnostic mapping reuse, an immutable certification
ledger, an authorised versioned account-review, and a sophisticated statement engine that is
decimal-exact, framework-selected, comparative-aware, provenance-bearing and reproducible. What a
customer can actually reach today is far thinner: statements come from a simpler renderer that sums
floats, has no comparatives, is non-deterministic, and (because it is fed no tax result) emits only
a balance sheet, a P&L, five boilerplate notes and a trial-balance listing. The good engine
("World B") is hard-gated off.

**On AI:** there is **no AI reachable through a live customer path** in this branch. The
"Processing with AI…" the user sees during upload is a deterministic classifier; the management
letter and disclosure notes are deterministic templates over real figures; the only real LLM code
(two Anthropic MAONO narrative engines and one Gemini policy advisor) is either not wired to any UI
trigger or sits behind an unrouted screen. This is healthy for trust — nothing fabricates numbers
— and it means the governing principle ("familiar layouts work with no model call; evidence
supplies amounts; deterministic code calculates") is **already** how the product behaves. AI is an
*opportunity on top*, not a load-bearing part, so it can be added slowly and safely.

**Therefore:** the fastest, safest route to a competitive product is **activate and finish the
statement engine first**, add a **grouped-review UI** over the already-authorised batch RPC, and
only then layer **bounded, validated AI assistance** (unfamiliar layouts, account-meaning
proposals, uncertainty→questions, narrative prose) — each AI output a proposal that deterministic
code and an authorised human must accept, never a figure or an authority.

**One control item to fix regardless:** the live sign-off path enforces no partner/manager role
(the CLAUDE.md §4.6 invariant is inaccurate) — see C-1.

## Capability snapshot (existing vs missing)

| Area | Exists & live | Exists but gated/dormant | Missing |
|---|---|---|---|
| Ingestion | Deterministic parse, excluded-row accounting, debits=credits block | — | Blank-row logging; account-count cap (on this branch) |
| Mapping reuse | Period-agnostic `account_mappings` reuse | Governed suggestion store (`mappingMemory`, empty) | Bulk/grouped review UI; hashed versioned MappingSet |
| Statements | SFP + P&L (float, no comparatives) | Full set, decimal-exact, comparatives, drill-down, snapshot (Engine B) | DOCX; IFRS 18; presentation-override layer |
| Notes | Deterministic TZ notes (NoteSynth), mgmt letter | Evidence-bound notes + numbering/cross-ref (Engine B) | Document-extraction (gated) |
| Cash flow | — | Direct-method evidence-ledger engine (gated) | Bank-independent ledger (DEFECT-SAFISHA-...-001) |
| Controls | Certification + HESABU gates; World-B publication gate | World-B role/blocker gate | Legacy sign-off role gate (C-1) |
| AI | None reachable; strong guardrail pattern in `maono-decide` | Anthropic narrative (unwired), Gemini policy (unrouted) | Any wired, validated in-product assistance |

## Ranked implementation slices (dependencies + acceptance criteria)

**S1 — Fix the live control & honest-copy gaps (no new feature).** *Dep:* none. *Accept:* legacy
sign-off requires owner/partner (or legacy path formally retired for World B); §4.6 corrected;
"Processing with AI…" reworded; `generate-xbrl` framework default fails closed. *(C-1, C-3, C-4.)*

**S2 — Verify-and-complete Engine B (NOT an activation instruction).** *Engine activation is not
approved and must not be inferred from source inspection.* *Dep:* S1. *Scope (separately approved):*
first establish evidence — actual migration state on the target DB, satisfiable evidence
requirements per statement, capability/publication permissions verified on the target,
reproducibility (content-hash restore / `DIVERGED`) and output correctness exercised against real
data — **before** any enablement decision. *Accept (of the verification, not of a go-live):* a
documented, evidence-backed readiness report covering those five points; only then does an
enablement decision belong to the owner. See `09` §7. (Engine B is the biggest *potential* unlock —
`07` — but that does not license flipping a gate from a source constant's value.)

**S3 — Grouped-review UI over the existing batch RPC.** *Dep:* none (RPC already authorised).
*Accept:* reviewer can assign a confident common treatment to a group and bulk-assign uncertain
accounts with **per-account validation and no inferred equivalence**; still one authorised batch,
one versioned ledger entry per account; no hundreds of individual clicks for obvious accounts.

**S4 — Governed repeat-year reuse store.** *Dep:* S3; product sign-off on the compatibility policy.
*Accept:* `account_mapping_memory` gets a writer; `resolveMappingMemorySuggestion` wired as a
*suggestion into* the authorised review; changed account identity/meaning/framework/period reopens
confirmation (fail-closed); every reuse recorded with why.

**S5 — Bounded AI assistance (behind the `06` evaluation gate).** *Dep:* S2–S4; owner data-handling
decision; passing evaluation suite. *Accept:* AI proposes only for unfamiliar layouts / `needs_review`
accounts / uncertainty-questions / narrative prose; every proposal validated by deterministic code
(numeric 0.1% match, excluded-row accounting, append-only, never-authorises); injection/resilience
regressions block enablement; model confidence is never acceptance.

**S6 — Close the evidence-family gaps** (cash-flow ledger authority, SOCIE/budget evidence,
asset/PPE registers) and **hashed versioned MappingSet**; resolve
`DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001`. *Dep:* S2. *Accept:* each statement reaches
READY only with its named minimum evidence; no plugs.

## Exact owner decisions needed
1. **Control / doc fix (C-1):** confirm the capability migrations (`20260925130000/140000`) are
   applied on the target DB (sign-off SoD is resolved on `69155ae` by capability RLS — `09` §4 —
   but RLS is inert until applied), and reword CLAUDE.md §4.6 to describe the *capability*
   mechanism rather than a role check in the hesabu trigger.
2. **World-B verify-and-complete (not a rollout approval):** authorise the verification scope in S2
   (`09` §7) — establish migration state, evidence, permissions, reproducibility and output
   correctness. A go-live decision follows that evidence; it is **not** requested here.
3. **AI provider & data-handling:** which provider, under what retention/training/residency terms,
   and precisely what data (account names? figures? documents?) may leave the tenant — today this
   is **UNKNOWN** and must be documented, not assumed. (Gates S5; also unblocks safely routing or
   retiring `policy-compass`, C-2.)
4. **Repeat-year reuse policy:** the compatibility rules for turning a prior decision into a current
   suggestion (framework/source-system/period) — confirm the already-modelled fail-closed policy.
   (Gates S4.)
5. **IFRS 18 scope:** whether/when to model IFRS 18 (full-IFRS only); verify effective dates and
   jurisdictional applicability from current primary sources before building. (Informs S6.)
6. **Status-doc reconciliation:** `DEFECT-ACCOUNT-REVIEW-AUTHORITATIVE-FLAGS-001` appears repaired
   in code on this branch while CLAUDE.md §9.1 lists it OPEN — confirm deployed state and update.

*Implementation requires a separately approved concrete scope. This package recommends sequence and
acceptance criteria only; it changes no product code, schema, workflow, gate, or deployment.*
