# Independent Reporting & AI Capability Review (BLACK)

**Lane:** `research/reporting-ai-review/**` only. Read-only assessment. No production code,
migrations, workflows, lockfiles, pricing, entitlement, feature-gate, schema or deployment
changes. No paid model calls. No private MUSE figures used.

**Baseline inspected:** branch `redesign/audit-20261013` at `b32aa4f`
(`feat(workspace): harden file context and navigation affordances`).

**One question this review answers:** what is the real path from an unfamiliar uploaded trial
balance to professionally presented, evidence-supported financial statements — what works
today, what the first Phase 6 slice adds, what remains after it, and where AI genuinely helps.

## Status vocabulary
- **VERIFIED** — read end-to-end in source; behaviour provable by inspection.
- **IMPLEMENTED—UNVERIFIED** — code present; runtime/deployed behaviour not provable here.
- **DISABLED** — present but ship-gated off / unrouted / dormant (no live trigger).
- **PROPOSED** — exists only in docs/comments/plans.
- **UNKNOWN** — cannot be verified within reasonable inspection; not expanded.

Deployed (hosted) state is **UNKNOWN** throughout — every claim is repo-at-`b32aa4f`.
"Disabled" is never read as "absent"; "code exists" is never read as "operational".

## Contents
| File | Purpose |
|---|---|
| `00-control-findings.md` | Security/control findings, surfaced first. |
| `01-ai-inventory.md` | Every actual/proposed in-product model invocation, traced end-to-end. |
| `02-readiness-matrix.md` | Evidence-to-output readiness per statement; IFRS / IFRS-SME / IPSAS separate. |
| `03-upload-and-repeat-year.md` | First-upload + repeat-year experience; smallest honest extension. |
| `04-presentation-engine.md` | Presentation/rendering capabilities and gaps. |
| `05-phase5-6-boundary.md` | Phase 5 done / first Phase 6 slice / everything after it. |
| `06-evaluation-design.md` | AI failure & evaluation design (prepare-only; no paid execution). |
| `07-competitor-benchmark.md` | control.dev and Draftworx, official public sources only. |
| `08-decision-package.md` | Executive verdict, ranked slices, exact owner decisions. |

First checkpoint = `00`–`05`. `06`–`08` follow.
