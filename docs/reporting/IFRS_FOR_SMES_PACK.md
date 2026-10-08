# IFRS for SMEs framework pack

Code: `src/lib/frameworkPacks/` (shared contract `types.ts`; packs `ifrsForSmes.ts`; edition policy `editionPolicy.ts`;
coverage `coverage.ts`). Coverage matrix: [`COVERAGE_IFRS_FOR_SMES.md`](COVERAGE_IFRS_FOR_SMES.md) (generated, test-pinned).

## Editions (both pinned)

| Pack | Edition | Effective for annual periods beginning on or after | Source of the date |
|---|---|---|---|
| `ifrs-for-smes/2015` | 2015 edition (incorporating the 2015 Amendments) | 2017-01-01 | 2015 text, paragraph A1 (PRIMARY_TEXT) |
| `ifrs-for-smes/2025` | Third edition, issued February 2025 | 2027-01-01 (earlier application permitted) | IFRS Foundation 2025 supporting materials (PRIMARY_SUMMARY) |

**Edition policy** (`resolveIfrsForSmesEdition`):
- The period **start** decides the edition; a missing or invalid start is refused, and there is never a default.
- A period beginning before 2017-01-01 is refused, because earlier editions are not encoded.
- A period beginning on or after 2027-01-01 uses the third edition.
- A period in between uses the 2015 edition, unless an early-application election of the third edition is recorded.
  - The election must carry the reference of a confirmation that the reporting jurisdiction permits early application.
  - It also makes the early-application disclosure applicable.
- **Tanzania:** no NBAA pronouncement adopting the third edition was found on 2026-10-08. Until one exists, an early
  election needs its own documented jurisdiction confirmation.

## Sources and verification classes

| Source | Use | Verification |
|---|---|---|
| 2015 text — IFRS Foundation PDF, third-party-hosted copy (SHA-256 `acc6500e…eb9f`, 1,027,941 bytes) | Every 2015 citation | PRIMARY_TEXT: read from these exact bytes |
| 2025 HTML standard (ifrs.org) | Every 2025 paragraph citation | PRIMARY_EXTRACT: bytes not pinned; re-verify exact wording before relying on it |
| 2025 supporting materials (ifrs.org) | Third-edition effective date and early application | PRIMARY_SUMMARY |
| EY IFRS Developments 235 | Third-edition early-application disclosure | SECONDARY: the Appendix A paragraph itself was not retrieved |

## Corrections this pack made to existing code
- `frameworkProfiles.ts` (profile version 1.2.0) cited **3.17(d)** for the statement of changes in equity and **3.17(e)**
  for the statement of cash flows. Both editions' text has **3.17(c)** and **3.17(d)**.
- The accounting-policy area now names both editions' wording: "summary of significant accounting policies" (2015) and
  "material accounting policy information" (third edition).

## Unresolved validation (required before any VALIDATED status)
- No requirement is VALIDATED. That needs golden fixtures whose expected statements, notes and schedules are prepared
  **outside this code by a qualified reviewer** (named, with a sign-off date). Passing implementation-generated tests is
  not accounting validation.
- PRIMARY_EXTRACT and SECONDARY citations should be re-verified against the published third-edition text, in
  particular Appendix A on early-application disclosure.
