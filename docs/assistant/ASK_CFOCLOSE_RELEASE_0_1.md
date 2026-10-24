# Ask CFOClose — Release 0.1

Explain the movement of one statement line, and draft commentary about it, from the statements the database composed.
Advisory only. Ships **disabled** at every layer.

## Verdict

Draft, disabled, stacked on PR #194 (track-a-r1), which releases first. Not activated: activation needs the owner decisions
below, the hosted migration, the function deployment and secrets, and a passed evaluation — each separately authorized.

## What was reused

| Need | Existing component |
|---|---|
| Authoritative figures, access | `fs_statement_composition` (database-composed statements; `close_review_readable` decides access) — read with the **person's** token |
| Access re-derivation server-side | `_workspace_access_basis`, `fs_rollout_allows`, `has_workspace_capability(…,'manage_members')` |
| AI control pattern | `20261012100000` layout-assist: disabled provider row with approval gates, per-workspace lock, pessimistic reservation, append-only guard (`ai_append_only_guard`), commercial-admin configuration |
| Hashing | `_shared/hash.ts` (`canonicalJson`, `sha256Hex`) |
| Response binding in the browser | `workbench/requestSequence.ts` |
| Edge Function path from reporting pages | `reporting/supabaseDb.ts` transport (the one sanctioned path) |
| Proof harness | `scripts/db-proof/lib/reportingKit.mjs` + `functionHarness.mjs` (real chain, real certifications, real function) |

## Contracts

**Request** (`POST assistant-explain`): `{ action: "explain_movement" | "draft_commentary", companyId, periodYear, lineId,
requestId (uuid), refinement?: "shorter" | "more_formal" | "plain_language" (drafts only) }`. No free text reaches the model.

**Facts** (`_shared/assistantFacts.ts`, `cfoclose-assistant-context/1`): per line — `period.current`, `period.comparative`,
`line.current`, `line.comparative`, `line.comparative_as_reported` (restated only), `line.change`, `line.change_percent`, and
for up to five contributing accounts `account.N.current|comparative|change|change_percent`. Each fact: id, kind, value (exact
minor units / tenths of a percent / year), currency, exponent, period, status (`composed` | `no_records` | `not_computed`),
reason, sourceRef. Percent: not computed on a zero base or a sign change; both-negative uses the absolute base.

**Response** (`_shared/assistantResponse.ts`, `cfoclose-assistant-response/2`): blocks of parts (`{text}` | `{factRef}`).
The model may write only `observation | missing | next_step` (explain) or `draft | missing` (draft). The **limitation**
("the records establish the movement, not its cause") is **application-authored**: the renderer appends it to every answer;
the model cannot write or weaken it. Narrowing rules, all applied to the **assembled** text (parts joined as they render,
NFKC-normalised, zero-width and bidirectional controls refused) and again to the whole answer, so splitting a word across
parts or blocks does not pass: no digit or number word (every figure, year and percentage is a factRef rendered by the
server); no causal or speculative wording in any model block; no wording of approval, verification, correctness or fair
presentation; no markup, links or control characters. Observations and drafts must cite an available fact and their
sources; a missing block cites only unavailable facts; next steps cite no figures. One correction attempt, with the input
bound checked before every call. **These rules narrow what the model can say; they are word lists and structural checks,
not proof that an answer is correct** — paraphrases outside the lists are possible, which is what the evaluation measures.

**HTTP**: handled outcomes are 200 with `{status: answered|refused|unavailable|stale|failed, code, message, answer?}`;
400 for a malformed request; 500 on a crash. Nothing unvalidated is ever returned.

**Persistence** (`20261201100000_assistant_controls.sql`, unapplied): `ai_assistant_settings` (disabled singleton; enabling
needs provider, model, prompt and terms versions, token/time bounds, dated prices, retention policy, both approvals, and a
reservation ≥ two calls at the bounds — a CHECK), `ai_assistant_enablements` (append-only, manage_members, current terms),
`ai_assistant_budgets` (monthly cap, per-user daily quota, workspace concurrency), `ai_assistant_runs` (reserve → complete
once; idempotent per actor + request id with payload digest; expired runs keep reserved cost; answers purged after the
retention). The recorded cost is the provider-reported cost, **never capped** at the reservation; any excess is kept as
`overrun_micros`, counts toward the monthly cap, and **pauses every new reservation platform-wide**
(`COST_OVERRUN_REVIEW_REQUIRED`) until a commercial admin records a review (`ai_assistant_review_overrun`,
`ai_assistant_overrun_reviews`, append-only). An unknown cost (failed or ambiguous call) is recorded at the reservation —
an estimate, stated as such. No client can read or write any of these tables; reserve/complete are service-role only.

**Request identity in the browser** (`src/lib/assistant/assistantClient.ts`): supabase-js returns transport errors
(`FunctionsFetchError`, `FunctionsRelayError`, `FunctionsHttpError`) instead of throwing them. Any outcome that is not a
structured server answer is `uncertain` and KEEPS the request id, as does a server `IN_PROGRESS`; the retry is the same
request and the server replays its record instead of starting a second paid generation.

## Hosting constraints and limits

Synchronous request, no workers or queues. Bounds (proposed settings): 6,000 input tokens, 1,200 output tokens, 60 s per
request including the one correction (each call gets the remaining time). The input bound is enforced on a character-based
**estimate** (characters / 2) before every call; it is not a guaranteed token ceiling — tokenisation is the provider's, and
the reported usage is what is charged and recorded. Confirm the 60 s fits the project's Supabase Edge
Function wall-clock limit for its plan before activation. Per-user concurrency 1; workspace concurrency and quota from the
budget row; the platform emergency switch is `ai_assistant_configure('{"enabled": false}')` (and unsetting
`ASSISTANT_PROVIDER`).

## Owner decisions before customer activation

1. Data handling: permitted data categories (account names and amounts are sent), provider retention configuration and
   region, the legal basis and cross-border position (Tanzania PDPA 2022), customer-facing terms wording (`terms_version`).
   Release 0.1 does not assume consent is sufficient.
2. Who pays: included allowance vs add-on; the monthly cap and daily quota per workspace.
3. The named accountant who reviews the evaluation set, and the activation thresholds (proposal below).
4. Model choice after evaluation (Sonnet-class expected; Haiku-class measured for comparison).
5. Response retention days (default 30) and whether drafts are kept at all.

## Evaluation

`scripts/assistant-eval/cases.mjs`: 30 synthetic cases (20 development, 10 held out) × 2 actions, each with the checks the
accountant applies. `scripts/assistant-eval/run.mjs` runs the real gateway code; dry run by default; a live run needs
`ASSISTANT_EVAL_CONFIRM=spend`, a key, a model and a hard cap, stops before the cap and writes a review CSV.

Proposed thresholds (for owner review, set before the held-out run): answer passes validation ≥ 97% (≥ 90% first attempt);
**zero** unsupported material factual or causal claims in the held-out set; accountant "acceptable as is or with a minor
edit" ≥ 80% (explanations) and ≥ 70% (drafts); p95 latency ≤ 15 s; cost per successful action ≤ $0.02.

## Measured sizes and the proposed capped cost of live evaluation

Dry run over the 60 requests: system prompt ≈ 734 tokens, request ≈ 891 tokens average (1,771 max), answer ≈ 450 tokens
assumed. At October 2026 list prices: Sonnet 5.5 ≈ $0.008 per call, Haiku 5.5 ≈ $0.0004.

Proposal (NOT authorized; to be decided after the deterministic review fixes are accepted): Sonnet 5.5 and Haiku 5.5, all
60 requests × 3 repeats each (360 requests): expected ≈ $1.60 + $0.08, hard cap $5 (the runner stops before exceeding it).

## Activation sequence (each step separately authorized)

1. Owner decisions recorded. 2. Live evaluation within the cap; accountant review; thresholds met. 3. Apply
`20261201100000` through the journalled process. 4. Deploy `assistant-explain`; set secrets `ASSISTANT_PROVIDER=anthropic`
and `ANTHROPIC_API_KEY`. 5. `ai_assistant_configure` with the approved settings; budgets per pilot workspace; workspace
enablement under the terms version. 6. Turn `ASK_CFOCLOSE_ENABLED` on in a reviewed commit. 7. Schedule
`ai_assistant_purge_responses()` daily.

## What this does not prove

Validation enforces references, server-rendered figures and wording rules — not that an explanation is a fair reading. The
evaluation set measures that, within its 30 cases. The wording rules are word lists over the assembled text: they block the
listed phrasings wherever they are split, and are backed by the prompt, the application-authored limitation and the
accountant review — not a guarantee against every paraphrase. Character-based size estimates are not token guarantees.
Ambiguous or failed calls are recorded at the reservation, an estimate of a charge the provider does not report to us.
