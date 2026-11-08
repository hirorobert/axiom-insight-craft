# Statement compiler: a restated comparative and a line present in one period cast (draft; nothing applied, merged or deployed)

**Stack.** `origin/main` f366367 ← #255 ← #256 ← **#257** (returning-client integration) ← this branch (`fix/compiler-restated-and-one-period-casting`).
This is the only change in the stack that touches the **pinned compiler closure** (`supabase/functions/_shared/statementCompiler.generated.mjs`), so it is reviewed and released on its own.

## What it fixes (both were registered, both reproduced)

| Defect | Before | After |
|---|---|---|
| **DEFECT-FS-RESTATED-COMPARATIVE-CASTING-001** (found by the returning-client Source B) | Any restated comparative stopped at the compiler: the restatement child line exists in the comparative column only, so `subtotal-casting` reported `INSUFFICIENT_EVIDENCE` on the parent line for the current period (`BLOCKING_FINDINGS:2`, `RECONCILIATION_UNMET:2`, `SERVER_COMPILATION_FINDINGS`). | Source B reaches REVIEWED and FINAL through the same server path. |
| **DEFECT-FS-NEW-ACCOUNT-COMPARATIVE-CASTING-001** (registered in PR #215) | An account that exists in one year only blocked sign-off for the other year. | A new current-year account (and an account that existed last year only) signs. |

## The change, and what it deliberately is not

`composedStatements` (the builder behind every composed report) now sets, on a composed parent line that has casting children, `castingNilPeriodIds`: the periods for which the **line itself has a figure**
(the database's exact sum of the rows it presents for that period; an account absent from a complete certified trial balance has no balance; a restatement restates the comparative only). The casting rule,
in the **new V2 form (`subtotal-casting` 1.1.0, canonical rule pack 2.3.0)**, treats a declared child that has **no binding at all** for such a period as contributing nothing. Everything else stays fail-closed:

* **no fact is invented and nothing is added up in the builder** (the SQL document-closure and structure gates compare every fact and every skeleton field with the server's; they are unchanged and still pass);
* a real casting error is still a `FAIL` (current says 4,000.01, its rows add to 4,000.00); a child that is *bound* but whose fact is missing is still missing evidence; a document that does not declare it (every report extracted from a file) behaves exactly as before;
* the schema refuses a declaration on a line with no children or for a period the line has no value of its own;
* rule pack **1.0.0 and 2.2.0 are untouched** (`subtotal-casting` 1.0.0 ignores the declaration), so every recorded evaluation and receipt is still reproducible byte for byte.

Also carried here (it is part of the same closure and was not separable): `signoff.ts` reads a missing comparative that carries no dates (`{state: "missing", periodYear}`). It was authored in #256 (`dba4fcf`) without regenerating the bundle and has been moved out of #256/#257 to here. #256's first-period proofs do not depend on it (their harness supplies null dates on a MISSING comparative only); **this PR proves the product client needs no wrapper**: `missingComparativeDates.test.ts` (3 tests) and a CI step that runs the first-period proof with `FIRST_PERIOD_PRODUCT_CLIENT=1` (54/54).

## One coordinated release (why a second compiler identity)

Migration `20261123100000` (applied as drizzle 0076) pins **one** compiler digest in the receipt table's CHECK and in `fs_record_server_compilation`; it is immutable. `20261220100000_statement_compiler_casting_declaration.sql`
is forward-only and idempotent: the CHECK and the function accept exactly **two** triples — the original (`49fc0852…`, 2.2.0, 2.2.0) and the new (`112c5847…`, 2.3.0, 2.3.0) — and nothing else. The function is
re-created from its **live text** with two anchored replacements, each asserted to occur exactly once. No row is read or written.

**Order** (never mis-recorded; a receipt is refused, not wrong, while either side is missing): apply the migration, **then** deploy `compile-financial-report` (closure digest `bc7c3a62…`, registered in
`scripts/release/verifyDeployedClosure.mjs` with the previous closure `745c8170…` as *known older*). The old function keeps working against the new database. Nothing here applies, deploys or activates anything.

`scripts/buildStatementCompiler.mjs` now **normalises the `node_modules` path comments** esbuild prints, so the bundle (and its digest) no longer depends on where `node_modules` lives (a linked worktree changed 8 comment lines and the digest), and its
migration-pin check accepts the digest in either pinning migration.

## Proof

| Layer | Result |
|---|---|
| Unit (`src/lib/statements/castingNil.test.ts`, the real rule on the composed document) | 11 tests: restated comparative passes in both periods; current-year-only and last-year-only accounts pass; a casting error still fails; the undeclared document still reports `INSUFFICIENT_EVIDENCE` (this **is** the pre-fix behaviour, reproduced); v1 ignores the declaration; schema refusals |
| Database (`scripts/db-proof/returningClientJourney.mjs`, real PostgreSQL) | 42/42. **B**: the restated comparative (Source B) reaches REVIEWED then FINAL (previously asserted as the exact stop). **C** (new): a company whose FY2026 carries two new accounts signs REVIEWED then FINAL through the compiler recompilation and the structure gate |
| First-period proof (#256) | 54/54 (needs the tolerance and the new identity) |
| Deployment drift | `node scripts/buildStatementCompiler.mjs --check` OK; `verifyDeployedClosure` test OK |

Not done, stated: the new database groups were **not** run against the pre-fix compiler on the database (the old bundle cannot be paired with the new rule-pack version); the pre-fix behaviour is reproduced at the unit level with the undeclared document, which is byte-identical to the old output.

## Separate, unchanged: the first-period report

The cash-flow roll-forward and the equity statement are built from comparative balances (`CASHFLOW_ROLLFORWARD_BALANCE_MISSING`). No first-period path exists, and **none is added here**. Changing it edits financial
calculations; the applicable IFRS for SMEs requirements (comparative information, the statement of cash flows, the statement of changes in equity, for the edition the period resolves to) must be verified against the
current text first. This change addresses comparatives that exist (restated or not) and lines present in one period only.
