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
  provenance.ts            Fact versioning (append-only correction)
  reviewerDecisions.ts      Append-only reviewer decision log
  serialization.ts          Deterministic stringify + stable identifier hashing
  adapters.ts               Adapter interfaces (NOT implemented here)
  rules/
    ruleEngine.ts            The validation kernel: RuleContext, RuleDefinition, findingId hashing
    shared.ts                 Fact/line lookup helpers shared by every rule
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
    builders.ts               Fixture-only factories (fact/line helpers)
    ifrsFullFixture.ts         Golden: IFRS, full statement set
    ifrsForSmesFixture.ts      Golden: IFRS for SMEs, combined income statement
    ipsasAccrualFixture.ts     Golden: IPSAS accrual, government entity
    ipsasCashFixture.ts        Golden: IPSAS cash, no SFP at all
    defectiveFixture.ts        Adversarial: trips every one of the ten rules
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

### Provenance

Every extracted fact records: source document id, source hash (sha256 —
the same content-identity discipline as `financial-statement-intake`),
locator (page/cell/element, discriminated by artifact kind), extraction
method, extraction confidence, the verbatim original text, currency,
scale, sign convention, reporting period, and version.

**Facts are immutable and append-only.** A correction never overwrites a
`MonetaryFact` — `provenance.ts`'s `applyFactCorrection` appends a new
version (`version = supersedesVersion + 1`) alongside an explicit
`CorrectFactDecision`, and throws `FactVersionConflictError` if the
decision's `supersedesVersion` is stale. `resolveLatestFact` /
`indexLatestFacts` always resolve to the highest version recorded.

### Reviewer decisions

Six decision types: `ACCEPT_FINDING`, `REJECT_FINDING`, `ACCEPT_FACT`,
`CORRECT_FACT`, `REQUEST_EVIDENCE`, `DEFER`. `reviewerDecisions.ts`'s
`appendDecision` returns a new log and refuses a duplicate `decisionId` —
decisions are never mutated or removed. `reviewerId` is a `firm_members.id`
(this repository's canonical actor identity — never `auth.users.id`).

## The rule engine

`rules/ruleEngine.ts` is the deterministic validation kernel. A
`RuleDefinition.evaluate(ctx)` returns plain `RuleEvaluationResult`s; the
engine assembles each into a full `ValidationFinding`, computing
`findingId` as a deterministic (FNV-1a, non-cryptographic) hash over the
rule pack identity, rule id/version, report identity/version, and the
rule's own `discriminator` string — **`createdAt` is never part of this
hash**. Two reruns of the same rule pack against the same report therefore
produce byte-identical `findingId`s regardless of when either run happened
(see `determinism.test.ts`).

Every rule returns exactly one of `PASS`, `FAIL`, `NOT_APPLICABLE`, or
`INSUFFICIENT_EVIDENCE` — decided entirely by rule code, never guessed by
the engine and never concluded by an LLM. `INSUFFICIENT_EVIDENCE` covers
every "a required fact is missing or ambiguous" case; no rule defaults a
missing fact to zero to force a PASS or FAIL.

### The first rule pack (`CANONICAL_RULE_PACK_V1`, `rules/rulePack.ts`)

| # | Rule ID | What it checks |
|---|---------|----------------|
| 1 | `sfp-equation` | `total_assets = total_liabilities + total_equity`, per period |
| 2 | `subtotal-casting` | every `TOTAL`/`SUBTOTAL` line equals the sum of its declared casting children |
| 3 | `note-to-face-reconciliation` | a face line's value equals the note it references |
| 4 | `comparative-period-alignment` | comparative facts reference one declared, consistent period |
| 5 | `currency-scale-consistency` | every non-null fact matches the report's presentation currency/scale |
| 6 | `cashflow-closing-cash-reconciliation` | cash flow closing cash equals SFP cash and cash equivalents |
| 7 | `movement-reconciliation` | opening + additions − disposals ± other movements = closing |
| 8 | `duplicate-detection` | no two lines share (concept, role); no two facts share one source fingerprint |
| 9 | `missing-comparative-detection` | every material (TOTAL/SUBTOTAL) line has a present comparative, when comparatives are expected |
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

Four golden fixtures (IFRS, IFRS for SMEs, IPSAS accrual, IPSAS cash) are
each internally consistent — the whole rule pack produces zero `FAIL`
findings against any of them (`fixtures.test.ts`). One adversarial fixture
(`defectiveFixture.ts`) deliberately trips all ten rules into a real `FAIL`
(or, where a defect legitimately produces one, `INSUFFICIENT_EVIDENCE`),
exercising the failure path end-to-end in one place.

## What is explicitly out of scope here

No OCR, no PDF/DOCX/XLSX parsing, no Arelle installation, no AI-generated
compliance conclusion, no migration, no Edge Function deployment, no public
feature enablement. This branch is the shared domain model and its first
deterministic rule pack — nothing more.
