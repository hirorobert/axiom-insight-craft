# Canonical Financial Statement Model

`src/lib/canonicalStatement/` — schema version `1.0.0`.

## Why this exists

CFOClose has two ways a set of financial statements can enter the system:

- **Workflow A** — statements *prepared* from a reviewed trial balance (HESABU).
- **Workflow B** — statements *uploaded* and reviewed as documents
  (`financial-statement-intake`).

Both need the same downstream capability: structural and arithmetic
validation, note reconciliation, evidence tracking and reviewer sign-off.
Building that twice — once per workflow — would mean two validation
engines that could quietly drift apart. This module is the shared,
format-neutral core both workflows normalize into. **They are never merged
into one another.** A `CanonicalFinancialStatementReport` records which
workflow produced it (`provenanceOrigin: "TRIAL_BALANCE_DERIVED" |
"DOCUMENT_REVIEWED"`) precisely so downstream code can never conflate the
two — they only *converge* by both landing in this one model, through an
adapter (see below).

## Module map

```
src/lib/canonicalStatement/
  types.ts               Domain types — the model itself (see below)
  money.ts                Decimal-safe monetary arithmetic (bigint minor units)
  concepts.ts              Controlled vocabulary of canonical concept keys
  validation.ts             Runtime schema/aggregate validation — the actual boundary (see below)
  provenance.ts            Read-only fact-lineage helpers (resolveLatestFact, indexLatestFacts)
  reviewState.ts            CanonicalReviewState + the atomic recordFactCorrection command
  reviewerDecisions.ts      Append-only reviewer decision log (standalone decisions only)
  serialization.ts          Deterministic stringify + SHA-256 identity hashing
  adapters.ts               Adapter interfaces (NOT implemented here)
  rules/
    ruleEngine.ts            The validation kernel: RuleContext, RuleDefinition, findingKey/evaluationId hashing, deterministic output ordering
    shared.ts                 Fact/line/period-binding lookup helpers shared by every rule
    financialPositionEquation.ts   Rule 1
    subtotalCasting.ts             Rule 2
    noteToFaceReconciliation.ts    Rule 3
    comparativePeriodAlignment.ts  Rule 4
    currencyScaleConsistency.ts    Rule 5
    cashFlowClosingReconciliation.ts Rule 6
    movementReconciliation.ts      Rule 7
    duplicateDetection.ts          Rule 8
    missingComparativeDetection.ts Rule 9
    orphanedNoteReferenceDetection.ts Rule 10
    rulePack.ts                CANONICAL_RULE_PACK_V1 — registers all ten
  fixtures/
    builders.ts               Fixture-only factories (fact/line helpers, factBindings-aware)
    ifrsFullFixture.ts         Golden: IFRS, full statement set
    ifrsForSmesFixture.ts      Golden: IFRS for SMEs, combined income statement
    ipsasAccrualFixture.ts     Golden: IPSAS accrual, government entity
    ipsasCashFixture.ts        Golden: IPSAS cash, no SFP at all
    multiComparativeFixture.ts Golden: one current period + TWO comparative periods
    defectiveFixture.ts        Adversarial: trips every one of the ten rules, still schema-valid
```

## The model

`CanonicalFinancialStatementReport` is the root. It holds identity
(`ReportIdentity`, `EntityIdentity`), periods (`ReportingPeriod`,
`ComparativePeriod`), framework (`ReportingFramework`:
IFRS / IFRS for SMEs / IPSAS accrual / IPSAS cash), presentation
(`PresentationCurrency`), the statement tree (`Statement` →
`StatementSection` → `StatementLine`), disclosures (`Note`,
`NoteReference`, `AccountingPolicy`, `TextualDisclosure`), and an
append-only fact ledger (`MonetaryFact[]`).

A `StatementLine` carries a `concept` — a canonical, framework-neutral key
(e.g. `"total_assets"`) — deliberately separate from its printed `label`.
Two lines can share a label ("Total" appears at the foot of both the asset
column and the liabilities-and-equity column) without being structurally
confused, because only `concept` identity drives the rule pack. A `TOTAL`/
`SUBTOTAL` line declares its own `castingChildLineIds` explicitly — casting
is never inferred from section membership or ordering.

A line's period-specific figures live in `factBindings: {periodId,
factId}[]` — at most one binding per `periodId`, any number of periods.
This replaced an earlier `currentFactId`/`comparativeFactId` pair, which
could only ever represent one comparative period; with more than one
comparative declared, every rule that reads a "the comparative" fact would
have silently re-read the same single field for every comparative period in
its loop. `rules/shared.ts`'s `factIdForPeriod(line, periodId)` and
`allPeriodIds(report)` are how every rule reads a binding correctly
regardless of how many comparative periods a report declares — see
`fixtures/multiComparativeFixture.ts` (one current + two comparative
periods, each with genuinely distinct figures) and its test, which proves
Rules 1, 2, 4 and 9 each evaluate every period's own fact exactly once.

### Numeric authority

`Money` (`money.ts`) is an integer count of minor units (`bigint`) at an
explicit `scale`, in an explicit `currency`. There is no binary float
anywhere in this module tree. `moneyFromDecimalString` parses a decimal
string by splitting on the decimal point and refuses to construct a value
that would lose precision at the target scale — it never rounds through an
intermediate float. Arithmetic across two different currencies or scales
throws `MoneyDenominationMismatchError` rather than silently converting.

**A missing fact and a genuine zero are different values.** `MonetaryFact.value:
Money | null` — `null` means the source never presented the figure at all
(MISSING); a `Money` with `minorUnits: 0n` is a real reported zero. No rule
in this pack ever treats one as the other.

### Runtime validation — the actual boundary (`validation.ts`)

TypeScript's `interface`/`readonly` describe shape at compile time only.
Anything arriving as `unknown` — an uploaded document's extraction, an Edge
Function payload, a hand-built JSON aggregate, a future Arelle-derived
report — must pass through `validateCanonicalReport(input):
CanonicalFinancialStatementReport` (throws `CanonicalValidationError` with
structured, path-addressable issues) or `safeValidateCanonicalReport(input):
ValidationResult` (never throws; discriminated on the string field
`status: "VALID" | "INVALID"` — see the note on that field below) before
anything else in this module tree may assume it is well-formed. Built on
this repository's existing `zod` dependency (see `src/pages/Auth.tsx` for
the established `import { z } from "zod"` convention) — no second schema
library was introduced for this module.

**The validation/rule-pack boundary.** This is the single most important
design decision in this file, because it resolves what would otherwise be
several contradictory requirements. The validator enforces *structural*
integrity — is the aggregate a well-formed, internally navigable graph?
Every ID a binding or reference depends on to be interpretable at all must
resolve: fact bindings, casting children (which must also stay within the
same statement and never self-reference), movement-schedule fact ids, a
note's own `totalFactId`. It also enforces field-level shape (dates,
hashes, confidence ranges, version-chain integrity, ID uniqueness) and two
framework-level structural contradictions (an `IPSAS_CASH` report cannot
contain a `STATEMENT_OF_FINANCIAL_POSITION`, and must contain a
`STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS`; every other framework is the
mirror image).

It deliberately does **not** enforce semantic/business correctness — that
is the rule pack's job, evaluated against an aggregate that already passed
validation:

- a fact's own currency/scale matching the report's *presentation*
  currency/scale is Rule 5's job, not a validation rejection — a real
  extracted fact can legitimately arrive in the wrong currency, and that is
  precisely the defect this rule pack exists to surface to a reviewer, not
  hide by refusing the upload outright;
- a fact bound under periodId `P` actually belonging to period `P` is Rule
  4's job;
- a `NoteReference`'s `toNoteId`/`fromLineId` actually resolving is Rule
  10's job — by definition, that rule exists to detect exactly the case
  validation would otherwise reject, so it cannot itself be a hard
  rejection;
- wrong totals, missing comparative figures, duplicate concepts, and bad
  movement roll-forwards (Rules 1/2/7/8/9) are valid numbers in valid
  positions, just numerically wrong in a way only the rule pack explains.

This is why `fixtures/defectiveFixture.ts` — which contains a currency
mismatch, a rogue/undeclared comparative period, a broken and an orphaned
note reference, wrong totals, and a duplicate fact fingerprint — still
passes `validateCanonicalReport` unchanged (`validation.test.ts` and
`fixtures.test.ts` both assert this directly): it is a valid aggregate that
fails ten business rules, not a corrupt one.

**A note on `ValidationResult`'s discriminant.** It is `status: "VALID" |
"INVALID"`, a string literal, not a `ok: true | false` boolean. This was a
deliberate workaround for a verified narrowing failure in this project's
installed TypeScript toolchain: an isolated repro
(`{ok:true,...}|{ok:false,...}` narrowed via `if (result.ok)`) reproducibly
fails to narrow in this environment, while the string-literal equivalent
narrows correctly. `validateCanonicalReport`'s own implementation is the
first caller that would have hit this.

### Provenance and atomic correction

Every extracted fact records: source document id, source hash (sha256 —
the same content-identity discipline as `financial-statement-intake`),
locator (page/cell/element, discriminated by artifact kind), extraction
method, extraction confidence, the verbatim original text, currency,
scale, sign convention, reporting period, and version.

**Facts are immutable and append-only, and a correction is atomic with its
decision.** `reviewState.ts`'s `CanonicalReviewState` pairs a report with
its `ReviewerDecisionLog` as one aggregate. `recordFactCorrection(state,
decision, provenance)` is the *only* public way to correct a fact: it
validates decision/reviewer identity, verifies the fact exists and
`supersedesVersion` is genuinely the latest (rejecting a stale concurrent
correction), requires `newVersion = supersedesVersion + 1`, requires the
corrected value's denomination to match the prior value's (when the prior
value was not itself MISSING), then appends the corrected `MonetaryFact`
version and the `CorrectFactDecision` together and re-validates the
resulting report — throwing `FactCorrectionRejectedError` (or
`CanonicalValidationError`) and changing nothing at all if any step fails.
There is no lower-level primitive that appends one without the other:
`provenance.ts` exports only read-only lineage helpers
(`resolveLatestFact`, `indexLatestFacts`), and `reviewerDecisions.ts`'s
general-purpose `appendDecision` accepts `StandaloneReviewerDecision` — a
type that structurally excludes `CorrectFactDecision`, so passing one is a
compile-time error, not just a documented convention.

### Reviewer decisions and finding targets

Six decision types: `ACCEPT_FINDING`, `REJECT_FINDING`, `ACCEPT_FACT`,
`CORRECT_FACT`, `REQUEST_EVIDENCE`, `DEFER`. A decision that references a
finding (the first, second, and — optionally — the last two of those)
carries an explicit `target: {kind:"FINDING_KEY"; findingKey} |
{kind:"EVALUATION_ID"; evaluationId}` — see the next section for what each
identity means and when a decision should target one vs. the other.
`reviewerId` is a `firm_members.id` (this repository's canonical actor
identity — never `auth.users.id`).

## The rule engine

`rules/ruleEngine.ts` is the deterministic validation kernel. A
`RuleDefinition.evaluate(ctx)` returns plain `RuleEvaluationResult`s; the
engine assembles each into a full `RuleEvaluationRecord` carrying two
separate SHA-256-derived identities (`serialization.ts`'s `sha256Hex` — a
small, self-contained, synchronous, pure-TypeScript implementation,
verified against the standard NIST test vectors — not the platform's async
`crypto.subtle`, because identity hashing happens inline in an otherwise-
synchronous evaluate/runRule path):

- **`findingKey`** — durable identity of *what is being checked*: a hash of
  rule-pack id/version, rule id/version, `reportId`, and the rule's own
  `discriminator`. It does **not** change when the outcome changes, the
  report is corrected to a new `reportVersion`, or observed values change.
  A decision that should "follow" an issue across correction cycles targets
  a `findingKey`.
- **`evaluationId`** — immutable identity of *this exact evaluated result*:
  a hash of `findingKey` plus rule-pack/engine version, `reportVersion`,
  `outcome`, `observedValues`, and `evidenceReferences`. It changes
  whenever any of those changes. A decision that should apply only to one
  specific run's result targets an `evaluationId`.

`createdAt` is excluded from both hashes. Two reruns of the same rule pack
against the same report produce identical `findingKey`s and
`evaluationId`s regardless of when either run happened
(`determinism.test.ts`), and permuting any input array — `facts`,
`statements`, `sections`, `notes`, `noteReferences` — never changes the
output order or any identity (`permutation.test.ts`): `runRulePack` sorts
its results by rule-pack registration order, then `ruleId`, then the full
discriminator, then `periodId`, then affected identity, then
`evaluationId`, independent of any input array's own order.

Every rule returns exactly one of `PASS`, `FAIL`, `NOT_APPLICABLE`, or
`INSUFFICIENT_EVIDENCE` — decided entirely by rule code, never guessed by
the engine and never concluded by an LLM. `INSUFFICIENT_EVIDENCE` covers
every "a required fact is missing or ambiguous" case; no rule defaults a
missing fact to zero to force a PASS or FAIL.

**PASS and NOT_APPLICABLE are never actionable findings.**
`RuleEvaluationRecord.actionable` is `true` only for `FAIL` and
`INSUFFICIENT_EVIDENCE` (`isActionableOutcome` in `types.ts`); a
non-actionable record's `status` is forced to `"NOT_ACTIONABLE"`, never
`"OPEN"`, regardless of `failureSeverity` (renamed from `severity` — it
describes the risk *if* this check fails, not "the severity of the current
result," so a `CRITICAL`-severity check that PASSes is never mistakenly
rendered as an "open critical finding"). `reviewerDecisions.ts`'s
`decisionsForFinding`/`deriveFindingStatus` only make sense against
actionable records; nothing in this module tree materializes a reviewer
workflow around a PASS.

### The first rule pack (`CANONICAL_RULE_PACK_V1`, `rules/rulePack.ts`)

| # | Rule ID | What it checks |
|---|---------|----------------|
| 1 | `sfp-equation` | `total_assets = total_liabilities + total_equity`, once per period (current + every declared comparative) |
| 2 | `subtotal-casting` | every `TOTAL`/`SUBTOTAL` line equals the sum of its declared casting children, per period |
| 3 | `note-to-face-reconciliation` | a face line's current-period value equals the note it references |
| 4 | `comparative-period-alignment` | every comparative-period binding is declared, and its fact genuinely belongs to that period — any number of comparative periods, never conflated |
| 5 | `currency-scale-consistency` | every non-null fact matches the report's presentation currency/scale |
| 6 | `cashflow-closing-cash-reconciliation` | cash flow closing cash equals SFP cash and cash equivalents, per period |
| 7 | `movement-reconciliation` | opening + additions − disposals ± other movements = closing |
| 8 | `duplicate-detection` | no two lines share (concept, role); no two facts share one source fingerprint |
| 9 | `missing-comparative-detection` | every material (TOTAL/SUBTOTAL) line has a present value for every declared comparative period, checked independently per period |
| 10 | `orphaned-note-reference-detection` | every note reference resolves to a real line and a real note |

A rule resolves `NOT_APPLICABLE` when the structural precondition for the
check genuinely does not exist in this report (no SFP at all for an IPSAS
cash-basis entity; no comparative period declared at all for a first-year
entity) — this is an honest absence, never a failure. It resolves
`INSUFFICIENT_EVIDENCE` when the precondition exists but a specific fact
needed to complete the check is missing or ambiguous (a denomination
mismatch, a null fact, an undeclared casting basis).

## Adapters (interfaces only — nothing implemented in this branch)

`adapters.ts` declares `IxbrlAdapter`, `PdfAdapter`, `DocxAdapter`,
`XlsxAdapter`, `TrialBalanceAdapter`. Every one returns
`AdapterExtractionResult`, built entirely from this module's own types —
`adapters.test.ts` asserts the file imports exclusively from `./types` and
never references an Arelle-specific type. A future `IxbrlAdapter` will run
Arelle as an isolated service/process; nothing about Arelle's own object
model may ever reach the canonical domain model.

## Fixtures

Five golden fixtures (IFRS, IFRS for SMEs, IPSAS accrual, IPSAS cash,
multi-comparative) are each internally consistent and pass
`validateCanonicalReport` — the whole rule pack produces zero `FAIL` and
zero unexpected `INSUFFICIENT_EVIDENCE` against any of them
(`fixtures.test.ts`, with an exact expected-outcome-count snapshot per rule
for the IFRS full fixture). One adversarial fixture
(`defectiveFixture.ts`) — itself schema-valid, per the boundary above —
deliberately trips all ten rules into a real `FAIL`, exercising the failure
path end-to-end in one place.

## What is explicitly out of scope here

No OCR, no PDF/DOCX/XLSX parsing, no Arelle installation, no AI-generated
compliance conclusion, no migration, no Edge Function deployment, no public
feature enablement. This branch is the shared domain model, its runtime
validation boundary, and its first deterministic rule pack — nothing more.
