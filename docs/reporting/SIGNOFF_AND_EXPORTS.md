# Sign-off and exports

Migration `20261021100000_fs_signoff_binding.sql`; builder `src/lib/statements/canonicalDocument.ts`; pack
`src/lib/exports/reportPack.ts`; proof `scripts/db-proof/signoffBinding.mjs` (real PostgreSQL, end to end through
FINAL).

## One sign-off path, now bound
The only sign-off remains `fs_set_publication_state`:
- REVIEWED needs `review_close`; FINAL needs `approve_certification` after REVIEWED, on the latest version.
- FINAL is immutable.
- The legacy `statement_sign_offs` path is not used.

For an IFRS for SMEs trial-balance report it now also requires the following (`fs_publication_blockers` v2):

| Check | Blocker |
|---|---|
| The report is bound to its reporting dependencies (the database's statement composition, notes status and comparative status) | `REPORTING_DEPENDENCIES_UNBOUND` |
| Those dependencies are current | `REPORTING_DEPENDENCIES_STALE` |
| Every blocker of the dependencies is clear: composition, notes and schedules, comparatives | the dependency's own blocker, by name |
| The statements of financial position and comprehensive income carry **exactly** the composed figures, under fixed fact identities | `STATEMENT_FIGURE_MISMATCH:n:<fact>` |
| Nothing else is bound on those two statements | `STATEMENT_FIGURE_NOT_COMPOSED:n:<fact>` |

The fixed fact identities are:
- `fact:<period>:<section>:<lineId>` for composed lines;
- `fact:<period>:total:<key>` for totals;
- `fact:<period>:account:<accountKey>` for each account a line presents (the line is a SUBTOTAL casting one DETAIL
  line `line:detail:<sfp|sci>:<accountKey>` per account, so the existing cash-ledger authority can resolve cash
  accounts against the composed statement);
- `fact:comparative:restatement:<restatementId>:<section>:<lineId>` for an approved restatement's delta.
Everything from `20261017100000` still applies, including the current authoritative input, a finished Close Review and
comparatives.

**Bindings.** Every REVIEWED and FINAL publication records an `fs_publication_bindings` row in the canonical path's own
transaction (trigger `fs_bind_publication`). The row holds:
- the **server's** SHA-256 of the stored document (the client-declared content hash is kept beside it, never as the
  authority);
- the dependencies identity;
- a snapshot of the dependencies at that moment.

Bindings are append-only. A publication inserted behind the canonical path's back for a stale report fails in the
trigger (`BINDING_STALE`).

**Later changes.** A change after sign-off never alters a FINAL version or its binding. The old version reads as
`REPORTING_DEPENDENCIES_STALE`, and the next sign-off needs a new version with its own binding.

## The document
`composedStatements(composition, comparativeDates)` builds the canonical statement of financial position and statement
of comprehensive income from the database's composition:
- Every amount is a server figure, and the facts carry the reporting input's identity.
- Line ids are unique report-wide.
- The comparative period's dates come from the reporting input; without them the builder refuses.
- The result validates against the canonical model.

The cash-flow statement and the statement of changes in equity come from the existing evidence generators, with their
existing server checks.

## Exports
`buildReportPack` renders the printable pack (A4, repeating table headers) and a spreadsheet (CSV) **only** from a saved
version and its binding:
- **Draft and final share one rendering.** They differ only in the status banner: a DRAFT or REVIEWED watermark, or the
  FINAL seal with the document and dependencies identities.
- **Deterministic:** the same version always renders the same bytes.
- **Preparer wording** is escaped.
- **Disclosures:** self-approved and self-revalidated adjustments are listed in the approval disclosures.

## Limits (carried)
- The server verifies the composed statements' figures exactly. For the evidence-built statements (cash flows, changes
  in equity) it verifies only their existing checks (statement presence, ledger-authority note, evidence batches).
  Generating those statements server-side is future work.
- The legacy financial-statements workspace (gated off) does not bind dependencies. For IFRS for SMEs its reports now
  read `REPORTING_DEPENDENCIES_UNBOUND` and cannot be signed. That is intended: the database composition is the
  authority.
- Full IFRS and IPSAS reports have no pack yet. Their sign-off rules are unchanged.
- XBRL is not part of this work.
