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
    shared.ts                 Fact/line/period-binding/note-reference lookup helpers shared by every rule
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
    multipleSfpFixture.ts      Two SFP statements, in opposite declaration order — Rule 6 ambiguity determinism proof
    defectiveFixture.ts        Adversarial: trips every one of the ten rules together, still schema-valid — an INTEGRATION stress fixture, not proof of per-rule independence
    isolatedBaseline.ts        A second, smaller clean baseline purpose-built for isolated mutation
    isolatedMutations.ts       One mutation function per rule, each an isolated defect against isolatedBaseline.ts
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

**Note-reference authority.** `report.noteReferences` is the SOLE
representation of the face-line-to-note edge. `StatementLine` does not
carry its own `noteReferenceIds` list — that duplicated edge representation
existed earlier and was removed, not reconciled: nothing enforced it stayed
in sync with `noteReferences`, so a line could carry an id this array had
no matching entry for, and neither validation nor any rule would ever
notice. `rules/shared.ts`'s `noteReferencesForLine(report, lineId)` derives
"this line's note references" by filtering `noteReferences` on
`fromLineId` — that is the only correct way to ask the question now, and
the only one that exists.

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
note's own `totalFactId` and `monetaryFactIds` (which must also contain no
duplicate factId), and a `TextualDisclosure`'s `relatedNoteId`. It also
enforces field-level shape (dates, hashes, confidence ranges, version-chain
integrity), ID uniqueness (including `sectionId` and a movement schedule's
`scheduleId`, report-wide), two framework-level structural contradictions
(an `IPSAS_CASH` report cannot contain a `STATEMENT_OF_FINANCIAL_POSITION`,
and must contain a `STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS`; every other
framework is the mirror image), and two fact-binding/period checks:

- every `StatementLine.factBindings[].periodId` must be either the current
  period or a period declared in `comparativePeriods` — an undeclared
  period id in a *binding* is a structural defect (there is nothing to
  bind it to), not a business-rule finding;
- a fact's own `reportingPeriod.isComparative` must be self-consistent with
  its `periodId` when that `periodId` names the current period or a
  *declared* comparative period (declaring `periodId: "CURRENT"` with
  `isComparative: true` is simply self-contradictory). A fact naming an
  *undeclared* periodId in its own `reportingPeriod` is not rejected by
  this check — see the next paragraph for why that specific case stays a
  rule-pack concern.

It deliberately does **not** enforce semantic/business correctness — that
is the rule pack's job, evaluated against an aggregate that already passed
validation:

- a fact's own currency/scale matching the report's *presentation*
  currency/scale is Rule 5's job, not a validation rejection — a real
  extracted fact can legitimately arrive in the wrong currency, and that is
  precisely the defect this rule pack exists to surface to a reviewer, not
  hide by refusing the upload outright;
- a fact *bound* under periodId `P` actually being the fact that period `P`
  produced — i.e. the bound fact's own `reportingPeriod.periodId` agreeing
  with the *binding's* periodId — is Rule 4's job. Validation confirms the
  binding's periodId is declared and, separately, that a fact naming a
  declared period is self-consistent about being comparative or not; it
  does NOT cross-check a binding against the specific fact it points to,
  because a binding silently pointing at a fact from the wrong period is
  precisely the authoring defect Rule 4 exists to catch on an otherwise
  valid aggregate (see `fixtures/isolatedMutations.ts`'s Rule 4 mutation,
  and `fixtures/defectiveFixture.ts`'s rogue-period defect — both validate
  cleanly and are Rule 4's job to FAIL);
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
decision AND the report's own version.** `reviewState.ts`'s
`CanonicalReviewState` pairs a report with its `ReviewerDecisionLog` as one
aggregate. `recordFactCorrection(state, decision, provenance)` is the
*only* public way to correct a fact. On success it:

1. requires the *input* report to already pass `validateCanonicalReport`
   (a correction is never the first line of defense against a corrupt
   input);
2. validates decision/reviewer identity and rejects a duplicate
   `decisionId`;
3. checks `decision.expectedReportVersion` against
   `state.report.reportIdentity.reportVersion` — an optimistic-concurrency
   guard. This is a pure in-memory domain command: it guarantees the guard
   is checked correctly, but it does **not** claim database-level
   concurrency safety — a future persistence layer must still enforce its
   own compare-and-swap on `reportVersion` at the storage boundary;
4. verifies the fact exists and `supersedesVersion` is genuinely the
   latest (rejecting a stale concurrent correction), and requires
   `newVersion = supersedesVersion + 1`;
5. requires the corrected value's denomination to match the prior value's
   (when the prior value was not itself MISSING);
6. appends the corrected `MonetaryFact` version, appends the
   `CorrectFactDecision`, and advances
   `reportIdentity.reportVersion` by **exactly 1** — all three together;
7. re-validates the resulting report before returning it.

Any failure throws `FactCorrectionRejectedError` (or
`CanonicalValidationError`) and changes nothing at all — no partial state
(some but not all of {fact, decision, version bump} applied) is ever
observable, and `state` itself is never mutated. Two materially different
report states can therefore never share one `reportVersion`: this is what
makes `evaluationId` (below) meaningful across correction cycles — an
evaluated result computed against version *N* is never confusable with one
computed against version *N+1*, even if every other input happened to
match.

There is no lower-level primitive that performs any subset of {fact
append, decision append, version bump}: `provenance.ts` exports only
read-only lineage helpers (`resolveLatestFact`, `indexLatestFacts`), and
`reviewerDecisions.ts`'s general-purpose `appendDecision` accepts
`StandaloneReviewerDecision` — a type that structurally excludes
`CorrectFactDecision`, so passing one is a compile-time error, not just a
documented convention.

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
  whenever any of those changes — including a `reportVersion` bump from a
  correction that didn't even touch this rule's own facts, since the
  report as a whole is a new version regardless. A decision that should
  apply only to one specific run's result targets an `evaluationId`.

`createdAt` is excluded from both hashes. Two reruns of the same rule pack
against the same report produce identical `findingKey`s and
`evaluationId`s regardless of when either run happened
(`determinism.test.ts`), and permuting any input array — `facts`,
`statements`, `sections`, `notes`, `noteReferences` — never changes the
output order or any identity (`permutation.test.ts`): `runRulePack` sorts
its results by rule-pack registration order, then `ruleId`, then the full
discriminator, then `periodId`, then affected identity, then
`evaluationId`, independent of any input array's own order.
`reviewState.test.ts` proves the reportVersion-vs-evaluationId relationship
directly: correcting a fact a given rule's target never reads still changes
that rule's `evaluationId` (because `reportVersion` moved) while leaving
its `findingKey` and its outcome/observed values untouched.

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
| 4 | `comparative-period-alignment` | every comparative-period binding points at a fact that genuinely belongs to that period (a binding's periodId itself being declared is validation's job — see above) — any number of comparative periods, never conflated |
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

### No first-match accounting authority

**Array order is never accounting authority anywhere in this rule pack.**
Every place a rule once needed "the" line with a given canonical concept,
or "the" statement of a given type, is resolved through an explicit
cardinality result — `rules/shared.ts`'s `resolveLineByConcept` and
`resolveUniqueStatementOfType` — never a bare `.find()` or `const [x] =
array`. Each returns one of exactly three states:

- **`NONE`** — no match. Rule 1 reports this as `INSUFFICIENT_EVIDENCE`
  naming the missing concept(s) (a statement declaring itself an SFP but
  missing `total_assets`, say); Rule 6 reports `NOT_APPLICABLE` only where
  that is honestly true (no SFP at all, in a report whose framework
  permits that — e.g. IPSAS cash), otherwise `INSUFFICIENT_EVIDENCE`.
- **`UNIQUE`** — exactly one match. The rule evaluates it normally.
- **`AMBIGUOUS`** — more than one match. The rule reports
  `INSUFFICIENT_EVIDENCE`, naming every conflicting `lineId` (or
  `statementId`, for Rule 6's SFP-statement resolution) explicitly, with
  remediation directing a reviewer to resolve the ambiguity. **No rule ever
  silently picks one.** The one prior exception — `financialPositionEquation.ts`
  and `cashFlowClosingReconciliation.ts` calling a bare `findLineByConcept`
  that returned the first match — has been removed from the codebase
  entirely (there is no `findLineByConcept` left to call).

**A duplicated canonical concept remains a reviewable Rule 8 finding, and
only Rule 8's.** Rule 8 (`duplicate-detection`) is the one rule whose job
is to *detect* two lines sharing a `(concept, role)` pair and report it —
it never has to "pick a winner" because it is not evaluating anything
*using* the concept, only reporting that the pair collides. Every other
rule that would need to resolve that same concept to a single line (Rule 1
for `total_assets`/`total_liabilities`/`total_equity`/
`total_liabilities_and_equity`; Rule 6 for the closing-cash and SFP-cash
concepts) now correctly reports its own, independent `INSUFFICIENT_EVIDENCE`
for the same underlying ambiguity — this is an intended, tested
consequence, not a bug: `fixtures/isolatedRuleFixtures.test.ts`'s
`duplicate-detection` mutation asserts Rule 8 reports two `FAIL`s *and*
Rule 1 reports the matching `INSUFFICIENT_EVIDENCE`, together, as the one
documented cross-rule relationship this closure necessarily creates (see
that file's own comments, and `fixtures/defectiveFixture.ts`'s updated
defect-1 note).

**Ambiguity reports are themselves order-independent, not just the
ambiguity determination.** An early version of this closure sorted matches
correctly to DETECT ambiguity, but still embedded the conflicting ids in
*whatever order the input array produced them* inside the finding's
`deterministicCalculation`/`observedValues`/`evidenceReferences` — which
silently changed `evaluationId` (and the byte-identical-output guarantee)
under permutation even though the *outcome* stayed correct.
`ambiguousConceptResult`/`ambiguousSfpResult` (Rules 1 and 6) and Rule 8's
own duplicate-group/fingerprint-group reporting all now sort conflicting
ids before building any of those fields.
`fixtures/ambiguityDeterminism.test.ts` is the adversarial proof: it takes
Rule 8's isolated duplicate-concept mutation, reverses the duplicate-
bearing lines, shuffles their statement's sections, and reverses the whole
statements array, then asserts the entire rule-pack output — outcomes,
`findingKey`s, `evaluationId`s, and their order — is byte-identical
(`createdAt` stripped) to the unpermuted run; a second fixture
(`multipleSfpFixture.ts`) declares two SFP statements in opposite order and
proves Rule 6 reports the identical ambiguity result either way; and a
third check confirms no two findings within one rule-pack run ever share a
`findingKey` or an `evaluationId`.

**`buildRuleContext` is the only public rule-engine entry point, and it now
enforces the validation boundary itself** (`rules/ruleEngine.ts`) — it
calls `validateCanonicalReport` and builds the `RuleContext` exclusively
from the validated result, throwing `CanonicalValidationError` on a corrupt
aggregate before any rule ever sees it. There is no lower-level constructor
that skips this. Per-rule unit tests that deliberately exercise a single
rule's branch logic against a minimal, intentionally non-conformant
hand-built report (e.g. "no SFP statement at all") use
`rules/testReport.ts`'s `buildUncheckedRuleContext` instead — a test-only
helper, never imported by production code, that documents exactly why it
bypasses validation: those tests are about one rule's own logic, not about
the validation boundary, which `validation.test.ts` and every full-fixture
test already cover exhaustively against real, validated aggregates.

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
for the IFRS full fixture).

`defectiveFixture.ts` deliberately trips all ten rules into a real `FAIL`
*together*, in one aggregate — useful as an integration stress fixture
exercising the whole failure path at once, but a single fixture with
several interacting defects cannot, by itself, prove any one rule is
independent of the others (a bug that made two rules FAIL for the same
reason could hide behind it indefinitely).

**Isolated rule fixtures** (`isolatedBaseline.ts`, `isolatedMutations.ts`,
`isolatedRuleFixtures.test.ts`) close that gap: `isolatedBaseline.ts` is a
second, smaller, fully clean and valid aggregate; `isolatedMutations.ts`
provides one function per rule, each changing only the fact(s) that rule's
own defect requires. `isolatedRuleFixtures.test.ts` proves, per mutation,
that the aggregate still validates, the target rule reports a real `FAIL`
(or `INSUFFICIENT_EVIDENCE`), and every other rule's FAIL/
INSUFFICIENT_EVIDENCE count stays at zero. Two mutations (Rules 9 and 10)
have one unavoidable, precisely documented, PASS-only or NOT_APPLICABLE-only
secondary effect on a sibling rule's result *count* (never on its
correctness) — removing a line's comparative binding to trigger Rule 9
necessarily removes that period's Rule 2 casting check for the same line
(an absent result, not a wrong one), and a dangling `NoteReference` visible
to Rule 10 is, by Rule 3's own already-documented design, also visible to
Rule 3 as a `NOT_APPLICABLE` (never a FAIL) — both deltas are asserted
exactly, and a final cross-check confirms no mutation's target rule is ever
"satisfied" by an unrelated cascade into a different rule.

## What is explicitly out of scope here

No OCR, no PDF/DOCX/XLSX parsing, no Arelle installation, no AI-generated
compliance conclusion, no migration, no Edge Function deployment, no public
feature enablement. This branch is the shared domain model, its runtime
validation boundary, and its first deterministic rule pack — nothing more.
