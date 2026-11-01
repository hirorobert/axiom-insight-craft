# CF-03 and QuickBooks combined integration candidate

Status: isolated integration branch, not an approval to merge or deploy. No hosted SQL, functions, customer flag, payments or publication changed by this integration work.

## Exact inputs

- main: `4fb2a78950161b81ae6c89752b230f136d9c45da`
- CF-03 / #244: `5d9ff44f01027a1ae8d7dd8a74789c0f2c9f3b9d`
- QuickBooks combined UI head / #241 and verification #242: `f71742a9a760e48e2d794a7e7b5d5943a31cca3a`

These branches were combined locally without updating their remote refs. Parentage preserves both source histories. The inherited features are not newly authored by this integration change, and their author-side evidence is not independent acceptance.

## Reproduced integration defect

Both #239 and #244 independently add a different migration with version `20261212100000`. The combined tree has 209 migrations and strict audit reports exactly one error: duplicate timestamp, legacy write revocation versus QuickBooks storage. Green CI on the separate branches cannot establish combined compatibility.

The merge also conflicts in twelve files that enumerate reviewed migration successors and pending migrations. Selecting either side drops the other candidate. The integration retains both entries in explicit order and retains exact-list checks.

## Repair

- Retain `20261212100000_legacy_financial_write_revocation.sql` unchanged.
- Rename the still-unapplied QuickBooks source to `20261213100000_qbo_connector_storage.sql` without changing its SQL bytes. SHA-256: `70d0a2a390bc7451bb1f273f3bb3a95e4f0b86f1cf6cd34e2b3dababc12be0b3`.
- Update proof source references, exact successor lists, migration count (209), and the exact final-three migration assertion. Preserve both candidates in the inertness allow-list. No pattern-based permission or optional check added.
- Historical review results retain their original identifiers and heads, with a notice identifying the integration rename; their green results do not transfer to this head automatically.

This rename is valid only while the original QuickBooks migration is unapplied. Hosted journal was last observed at id 99 and QuickBooks tables were absent; recheck before any installation. If a copy has been applied anywhere, do not silently rename installed history; design that environment's forward transition.

## Verification

- Before repair: strict audit rejects the combined tree for duplicate timestamp.
- After repair: strict audit passes 209 files, no errors or warnings.
- Migration-authority assertion passes, preserves all 84 mirrored entries, and reports exactly two pending sources (CF-03 then QuickBooks).
- Both SQL bodies verified byte-identical to their input heads.
- Combined full local unit suite with exact DB_INERT_BASE_SHA: 7,409 passed, 10 skipped, 12 TODO; 441 files passed and one skipped. Initial run without a comparison-base reference had four fail-closed guard errors; supplying the verified main SHA resolved them without changing any guard.
- Typecheck passes; production build passes; touched-script lint has no errors; git diff --check passes.
- Real PostgreSQL proof and real-stack tests require exact-head CI; not claimed from a static audit or Node unit tests.

## Release boundaries

This is a combined verification candidate. Do not merge the verification-only #242, do not merge active source branches blindly, and do not deploy from this branch merely because a test passes. The proposed source integration order is CF-03 first, followed by the updated QuickBooks stack on that base. Adoption into the active branches must be coordinated with their author; no active Claude branch was force-pushed or edited here.

The QuickBooks actor-identity review and reviewer independence declaration remain unrecorded. Retention/legal acceptance, realm verification and real Intuit sandbox behavior remain open. Six backend secret names being present proves neither credential validity nor a deployed connector. The hosted migration transport and controlled sandbox UI are separate unfinished release work. Customer activation stays off.
