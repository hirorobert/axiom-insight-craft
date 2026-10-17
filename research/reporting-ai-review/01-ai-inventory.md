# 01 — Actual AI Inventory (AI executed *inside the product*)

**Headline:** In the inspected branch, **no LLM call is reachable through a live customer UI
path.** Every "AI-looking" feature that a user can actually reach today is **deterministic**
(template/rule-based from DB figures). The only LLM code in the product — two Anthropic MAONO
narrative engines and one Gemini policy advisor — is deployed/coded but has **no live UI
trigger** (MAONO) or is **unrouted** (policy-compass). This is stated carefully: the code exists;
it is not operational via the product.

*Build-time AI (Lovable / Claude Code used to write this software) is out of scope here and is
not an in-product invocation.*

## 1.1 Executed-backend surface (ground truth)

Every `supabase.functions.invoke(...)` target in `src/` (the only way the app calls a backend
function):

| Function | Invoker (src) | AI? | Reachable today |
|---|---|---|---|
| `process-trial-balance` (×3) | upload / review flow | **No — deterministic** 6-tier | **Yes (live)** |
| `hesabu-validate` | statements validation | No | Yes (live) |
| `kinga-tax-engine` | tax stage | No (statutory calc) | Yes (live) |
| `generate-management-letter` | `MgmtLetterPanel.tsx` → Filing stage | **No — deterministic** | **Yes (live)** |
| `generate-disclosure-notes` | `NoteSynth.tsx` → Filing stage | **No — deterministic** | **Yes (live)** |
| `financial-statement-intake` | `StatementReviewWorkspace.tsx` | No (malware-scan + intake) | Gated (`DOCUMENT_REVIEW_ENABLED=false`) |
| `safisha-efdms-ingest` | reconcile | No | Yes (service-role, by design) |
| `invite-firm-member` | team admin | No | Yes |
| `policy-compass` | `PolicyCompass.tsx` (**unrouted**) | **Yes — Gemini** | **No (dead route)** |

MAONO edge functions (`maono-compute/-cashflow/-risk/-decide/-root-cause/-monitor`) appear in
**no** `functions.invoke` — the Monitor stage renders `MaonoDashboard` (`MonitorWorkspace.tsx:12,30`)
which **reads** existing MAONO rows and writes a board-pack via `rpc("maono_write_board_pack")`
(`BoardPackGenerator.tsx:303`) but **never triggers the compute/narrative chain**. The functions'
`next_step` strings ("Call maono-root-cause → …") are advisory text, not an orchestrator.

## 1.2 The two in-product Claude engines (deployed; not UI-triggered)

### `maono-decide` — Anthropic — IMPLEMENTED—UNVERIFIED; not reachable from UI
- **Entry:** `POST /functions/v1/maono-decide`, body `{run_id}` (`index.ts:194,207`).
- **Provider/model/config:** Anthropic SDK `0.27.3`, `model: "claude-sonnet-4-6"` (hardcoded,
  `:351`), `max_tokens 6000`; key `Deno.env.get("ANTHROPIC_API_KEY")` (`:335`). No config table.
- **Availability:** implemented + (per CLAUDE.md §3) deployed; **not reachable** — no UI invoker.
  Executed/verified in product: **UNKNOWN** (no runtime evidence; no test harness found here).
- **Data sent to provider:** numbers are **not** in the prompt; they are returned to the model
  via a `get_decision_data` tool result (`:293-321`) — account **names**, P&L categories, actual/
  budget/variance **TZS**, week-1 cash, alert messages, prior AI summaries. TZ regulatory context
  is injected into the system prompt from the `maono_context` table (`:227-234`), never training
  data. No TIN; company identified only by `run_id`/`company_id` server-side.
- **Isolation/authz:** inline `supabase.auth.getUser()` (`:204`); **no `assertCompanyMembership`**
  (see C-5). Isolation = RLS on `variance_runs`/`variance_analyses`/`maono_insights`.
- **Output validation (strong):** (a) **numeric** — every numeric token ≥1000 in the response
  must match a snapshot figure within 0.1% (`validateNumbers`, `:116-130`). *This 0.1% is an
  internal narrative-token guard for generated prose only — NOT a general figure-acceptance
  criterion; extracted/mapped amounts must match source exactly (see `09` §5).* (b) **structural** —
  exactly 3 decision paths per issue (`validateDecisionPaths`, `:68-102`). On failure → **one**
  corrective retry (`:400-414`); if still failing → stored with `confidence_level
  "validation_failed"` and surfaced to Accountant role only (`:417-422,464-467`).
- **Controls MISSING:** no request timeout / AbortController, no cost cap, no max-iteration bound
  on the agentic `while` loop (`:349-388`), no rate limiting. Failure → HTTP 500 (`:470-473`).
- **Persistence & authority:** append-only `maono_insights` insert (`:425-451`) with
  `ai_model_used`, `numeric_validation_passed`, `numeric_validation_detail`, `context_version`.
  **Can never authorise** an accounting treatment: ends every path with "requires your sign-off",
  never auto-executes (`:146-147`), and the Financial-Twin firewall (CLAUDE.md §3) keeps all MAONO
  writes in MAONO-namespaced tables. Advisory only.

### `maono-root-cause` — Anthropic — same profile
- Same model/key/pattern (`index.ts:132` getUser; tool `get_variance_data`; numbers via tool,
  not prompt; numeric validator + one retry → `validation_failed` hidden from CFO/Director;
  append-only `maono_insights`). Explains *why* a variance occurred. Advisory; never authorises.
  Not reachable from UI. Same missing timeout/cost/loop controls.

## 1.3 `policy-compass` — Gemini via Lovable gateway — DISABLED (unrouted)
- `model: "google/gemini-2.5-flash"`, `temperature 0.3`, Lovable AI gateway (`index.ts:165-179`),
  key `LOVABLE_API_KEY`. Sends `question` + `JSON.stringify(financialData)` from the request body
  to the model. JWT-only auth, **no membership check**. **No output grounding/validation**; US-GAAP
  example citations. Handles gateway 429/402; no timeout/retry/cost cap. Only invoker
  (`PolicyCompass.tsx`) is unrouted ⇒ dead. See control finding **C-2**.

## 1.4 Confirmed NON-AI (deterministic) — the live "AI-feeling" features
- **Account classification** (`process-trial-balance`): deterministic 6-tier
  (`account_mappings` exact/fuzzy ≤2 → framework vocab → keyword dictionary → regex rules →
  needs_review). **Zero** model calls (grep clean). UI copy "Processing with AI…"
  (`TrialBalanceUpload.tsx:407`) is inaccurate — see **C-4**.
- **`generate-management-letter`** — header: "No AI inference. No hallucinated numbers." All
  sections computed from `findings` + `tax_computations.computation_detail` (canonical column).
- **`generate-disclosure-notes` (NoteSynth)** — header: "NO AI-hallucinated statutory numbers …
  actual TZS figures injected directly from `tax_computations` + upload data." 8 mandatory notes,
  rule-driven.
- **`financial-statement-intake`** — `_shared/auth.ts validateAuth`; malware scan + intake logic;
  **describes intake, never assessment** (`sourcesModel.ts:24`); extraction adapters do not exist
  (`DOCUMENT_REVIEW_ENABLED=false`, `outcomes.ts:145`). No model.
- **`maono-risk`** — deterministic Z-score (`ai_model_used: "deterministic_zscore"`, `:355-358`).
- **`BoardPackGenerator`** — assembles existing insights; `p_generation_model:"claude-sonnet-4-6"`
  (`:315`) is **provenance metadata** passed to an RPC, not an AI call.
- **`auth-email-hook`** — `LOVABLE_API_KEY` here is the transactional **email** gateway
  (`@lovable.dev/email-js`), not an AI model. Not an in-product AI capability.

## 1.5 Where AI *would* genuinely help (none wired today) — opportunities, not findings
Aligned to the governing principle (AI assists only where it reduces uncertainty/effort; familiar
layouts must work with no model call — which they already do):
1. **Unfamiliar-layout column/row proposal** — only when the deterministic `detectColumns` fails,
   returning source cell references + explicit excluded-row accounting, validated by the existing
   deterministic arithmetic (never trusted for numbers).
2. **Account-meaning proposals** for `needs_review` accounts — grouped by confident common
   treatment, per-account validation, no inferred equivalence; a *suggestion* into the existing
   authorised review, never a decision.
3. **Uncertainty → focused questions** — turn low-confidence classifications into a short
   reviewer question set rather than a long per-account list.
4. **Narrative drafting** — management-letter / disclosure *prose* (not figures), and the MAONO
   root-cause/decision narratives, under the existing numeric-validation + append-only + "never
   authorises" guardrails that `maono-decide` already demonstrates.

Each requires an owner decision on provider data-handling (see C-2) before enablement.
