# Period-currency correction: release evidence (batch `currency-c1`)

Status: **APPLIED to production and registered.** Publication and signed-in hosted acceptance are recorded below once
they are done. Rule, lock impact and trust boundary: [README.md](README.md).

## Source and review

| | |
|---|---|
| PR | #179 (`feat/period-currency-correction`) |
| Accepted implementation | `70f4354c96910baa1b06354aaa077b37a68a08ad`. Independent review (Codex): **ACCEPTED**. Four findings resolved; the database-capable trust boundary is documented as non-blocking |
| Merged head | `b08953619f369cf6541a6765af9eab63ed79ea97`. This is the accepted implementation merged with main's frontend changes (LinkedIn link, CSS and Tailwind) plus the re-captured gate-OFF footer fixture; it is byte-identical to the accepted head for migration, wrapper, scripts and workspace code |
| CI on the merged head | [run 39289972528](https://github.com/hirorobert/axiom-insight-craft/actions/runs/39289972528): all required jobs green. Real local-Supabase journey 47/47 on the accepted head ([run 39270029712](https://github.com/hirorobert/axiom-insight-craft/actions/runs/39270029712)) |
| Merge commit | `4ead5c91ca71d9f62b80d71d2f302fc06693f276` (2026-10-20 03:44:40 UTC) |

## Identities

| Form | File | Bytes | SHA-256 |
|---|---|---|---|
| Source | `supabase/migrations/20261113100000_period_currency_correction.sql` | 34,382 | `91d098a5e6958ac2529fee1005ddc500e0fdbb072635ba3a1967840d3378466d` |
| Wrapper (canonical) | `release/wrappers/20261113100000_period_currency_correction.wrapper.sql` | 35,956 | `723baa6cc28cefd0e82ffacb40ff2514aec8f0666d4b28a2c06e268214fb528a` |
| **Submitted** (wrapper, final LF removed) | `drizzle/migrations/0063_period_currency_correction.sql` | **35,955** | **`8122917c23abca8726e7ee763796ffae568179233c9537b61a5aff35310f17bc`** |
| Postcondition | `docs/release/period-currency-correction/postcondition.sql` | 6,917 | `d1e007db319ea1ed0c42de7fba16a8780acda30cf87077394005eb2f042ed3cc` |

The wrapper encloses source commit `5581158eeaf172c387715f278fadfb92cc032557`. All four forms were registered in
`SUBMISSION_FORMS` before application. The mirror was verified **byte-identical** to the canonical wrapper with exactly
its single final LF removed (`wrapper_final_lf_removed`).

## Hosted application (production, Lovable's journalled migrator)

| | |
|---|---|
| Hosted preflight | Run read-only as `current_user` = `session_user` = `postgres`. `correct_period_currency` was absent and every prerequisite present. The dependency visibility and lock query returned **0 failing rows**. No permissions were changed |
| Application | Once, through Lovable's journalled migrator, in the final-LF-removed form |
| Hosted journal | **id 64**; `created_at` (journal `when`) **1792470872315** = 2026-10-20T04:34:32.315Z; hash = `8122917c…` (equal to the submitted form) |
| Repository mirror | Lovable commit `14efba2` (merged on main as `da31e04`): `drizzle/migrations/0063_period_currency_correction.sql`, `meta/0063_snapshot.json`, a `meta/_journal.json` entry (idx 63, version 7, tag `0063_period_currency_correction`), and generated RPC types in `src/integrations/supabase/types.ts` |
| Postcondition | **`POSTCONDITION OK.`** (reported by Lovable). The hosted journal entry and all eight new or replaced functions owned by `postgres` were confirmed independently |
| Registration | `RELEASE_JOURNAL["0063_period_currency_correction"]` (`release_self_checking_wrapper`, `wrapper_final_lf_removed`, 35,955 B, `8122917c…`). Pending lists cleared; `assertMigrationAuthority`: `PENDING_HOSTED_APPLY: none` |

## Evidence boundary

* **Local and CI only:**
  * the database proofs (`periodCurrencyCorrection.mjs` 62/62; wrapper proof 32/32);
  * the browser journey (CI, local Supabase stack, invented data);
  * lock timings (about 50 ms uncontended), which are not a hosted guarantee.
* **Hosted:** the preflight, the application, the journal identity and the postcondition, all listed above.
* **Not yet done:** Publish (the served build identity) and signed-in production acceptance with synthetic data.

## Recovery (unchanged; see the PR #179 handoff)

* **Kill switch** (prepared, not executed): a reviewed forward migration revoking `EXECUTE` on `correct_period_currency`
  and `get_period_currency_correction` from `authenticated`. The panel then shows nothing and Replace remains.
* Never edit or delete `fiscal_period_events`.
