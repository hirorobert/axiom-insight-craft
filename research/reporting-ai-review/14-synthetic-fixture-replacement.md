# 14 — Forward-only synthetic-fixture replacement (prepared for review)

**Prepared for review; not applied.** Forward-only (no history rewrite, no force-push, no client
notification). **Single owner of the applied change: NORMAL** (implementation owner) — this lane does
not touch `main` or the affected source files. The precise file list and specifics are held in the
**private** incident record (outside this repo); this public document stays generic so as not to
signpost. No FS activation, no accounting-logic change.

## Why / scope (generic)
A set of accounting **test fixtures, a classification rule-pack's evidence strings, two tests and two
top-level docs** currently carry a **real entity's data and identity** instead of synthetic data. The
replacement makes every one of them **independently invented** while **preserving the intended test
coverage**. The exact files are enumerated privately for NORMAL. The balances live in two fixtures;
the entity identity is additionally embedded in the rule-pack evidence strings and two docs — all in
scope for de-identification.

## Principles for the replacement
1. **Independently invented, not transformed.** New codes, names and amounts are authored fresh — not
   the real values scaled, offset, rounded or permuted. (Do not derive synthetic data from the real data.)
2. **Preserve coverage, drop magic client constants.** Each test keeps the engine behaviour it proves,
   but asserts **fixture-derived / property-based** results instead of hard-coded client figures:
   - depreciation add-back = sum of the fixture's own depreciation lines (computed inline);
   - working-capital receivables movement: delta sign + `presentationCode === "RECEIVABLES"` by construction;
   - asset-category movement: opening/additions/closing from the fixture; the "no accumulated-depreciation
     ⇒ `dataGap` / null NBV" branch exercised by a category the fixture deliberately leaves without a contra;
   - full aggregation: `accountingEquationHolds === true`, `|variance| < 1`, `balances.length === FIXTURE.length`,
     and section-total **relationships** (ASSET > 0, etc.) rather than client magnitudes;
   - surplus: computed from the fixture (sign/relationship), not a client constant.
3. **De-identify names.** `describe()` titles and rule-pack `evidenceDetail` strings drop the entity
   name + entity number, keeping the classification rationale (e.g. "natural account code family '12'
   is consistent with this classification" stays; the entity reference becomes "an illustrative TZ
   public-sector entity").
4. **Same contracts.** Fixtures keep the `{ code: string; debit: number; credit: number }[]` shape and
   the `Fy2025Balance` / `Fy2026Balance` interfaces; codes remain members of the rule pack's recognised
   families so classification still resolves. Standard chart codes are not client data; the (code→amount)
   pairing and the entity identity were.
5. **Rename to de-identify.** Fixture files → neutral names (e.g. `syntheticSmeFy2025Balances.fixture.ts`),
   exports → neutral symbols; update the importers.

## Apply spec (mechanical, for NORMAL on `main`)
1. Author the two synthetic fixtures (starter below) covering: cash; receivables (FY2026 > FY2025);
   payables; PPE motor-vehicle **cost with no accumulated-depreciation contra** (to exercise the
   dataGap branch); ≥1 depreciation-expense line; revenue; expenses; equity — **balanced** (Σdebit = Σcredit)
   each year. Align each `code` to the rule pack's recognised family for the presentationCode it must hit.
2. Replace the two real fixtures with the synthetic ones; rename; update imports in the four tests.
3. Rewrite the four tests' assertions to the fixture-derived/property form in Principle 2; de-identify
   `describe()` names.
4. De-identify the rule-pack `evidenceDetail` strings and the two docs (entity name + number → generic).
5. **Proof (required, NORMAL in CI):** `bun run test` green for the four affected suites + typecheck +
   `git grep -i` for the entity name / entity number on HEAD → **zero** matches outside the private
   record. No real data on HEAD. (This does not remove it from history — that remains owner-gated.)

## Starter synthetic fixtures (illustrative; NORMAL aligns codes to the pack + regenerates property assertions)
Invented, balanced, obviously-synthetic round amounts. Codes are placeholders to be mapped to the
pack's recognised families (receivables / PPE-additions / depreciation / revenue / etc.).

```ts
// syntheticSmeFy2025Balances.fixture.ts — INDEPENDENTLY INVENTED synthetic data (no real entity).
export interface Fy2025Balance { code: string; debit: number; credit: number; }
export const SYNTHETIC_FY2025_BALANCES: Fy2025Balance[] = [
  { code: "1010", debit: 4_000_000, credit: 0 },     // cash
  { code: "1210", debit: 3_000_000, credit: 0 },     // receivables (RECEIVABLES family)
  { code: "1610", debit: 12_000_000, credit: 0 },    // PPE motor vehicles — cost (no accum. dep. contra)
  { code: "2110", debit: 0, credit: 2_500_000 },     // payables
  { code: "3010", debit: 0, credit: 10_000_000 },    // accumulated surplus / equity b/f
  { code: "4010", debit: 0, credit: 9_000_000 },     // revenue (user fees)
  { code: "5110", debit: 2_000_000, credit: 0 },     // operating expense
  { code: "5810", debit: 500_000, credit: 0 },       // depreciation expense (non-cash add-back line)
  // balanced: debits 21,500,000 = credits 21,500,000
];
```
```ts
// syntheticSmeFy2026Balances.fixture.ts — INDEPENDENTLY INVENTED synthetic data (no real entity).
export interface Fy2026Balance { code: string; debit: number; credit: number; }
export const SYNTHETIC_FY2026_BALANCES: Fy2026Balance[] = [
  { code: "1010", debit: 5_200_000, credit: 0 },     // cash
  { code: "1210", debit: 4_100_000, credit: 0 },     // receivables ↑ vs FY2025 (working-capital delta > 0)
  { code: "1610", debit: 15_000_000, credit: 0 },    // PPE motor vehicles — cost (additions 3,000,000)
  { code: "2110", debit: 0, credit: 2_800_000 },     // payables
  { code: "3010", debit: 0, credit: 12_900_000 },    // accumulated surplus / equity b/f
  { code: "4010", debit: 0, credit: 11_000_000 },    // revenue
  { code: "5110", debit: 1_800_000, credit: 0 },     // operating expense
  { code: "5810", debit: 200_000, credit: 0 },       // depreciation expense
  // balanced: debits 26,100,000 = credits 26,100,000
];
```
These are a seed, not a drop-in: NORMAL maps the codes to the rule-pack families and regenerates the
property-based expectations against them, then confirms CI green.

## Coordination / ownership
- **NORMAL owns the applied change on `main`** (fixtures, rule-pack strings, tests, docs) and runs the
  proof. **This lane (BLACK) will not edit those files or `main`,** to keep a single owner.
- This document + the starter fixtures are the review input; the precise file list is in the private record.
- Containment of the already-public data in **git history** (and any repo-visibility change or client
  notification) remains **owner-gated** and is out of this forward-only change.
