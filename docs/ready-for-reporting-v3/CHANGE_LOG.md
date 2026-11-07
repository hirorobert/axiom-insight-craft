# Ready for Reporting V3 — change log

Each finding from the reviews of v1/v2 and from the V3 assignment, with its resolution or the blocker that remains.
"Spec" = `READY_FOR_REPORTING_V3.md`; "Contract" = `ACCEPTANCE_CONTRACT.md`; fixtures are in `cases.mjs`.

## Reviewer critique of v1/v2

| # | Finding | Resolution | Status |
|---|---|---|---|
| R1 | "A TB cannot test the bookkeeping" was too absolute. | Spec §2.1 lists what TB-only checks run; the limit is stated as: a TB cannot show whether a balanced posting reflects the real transaction (E2). | Resolved |
| R2 | "At most 5 of 18 errors" was unsupported precision. | Removed. Coverage is claimed only per fixture, with category (Contract §1, §5). | Resolved |
| R3 | "Everything in front of the TB is missing" was incorrect. | Spec §1 inventories the existing connector, findings, decisions, adjustments, comparatives, Comparative Assurance, SAFISHA and finalization at `f366367`, with what is reused. SAFISHA's authority layer is quarantined and its 1% drift is unsuitable for readiness; both are stated. | Resolved |
| R4 | Reject "OBE, suspense, difference accounts must be zero". | Replaced by entry-level support (Spec §4.3): net zero with unsupported entries holds (S4); supported non-zero passes (S3). | Resolved |
| R5 | "Evidence for both sides" was incomplete. | Evidence standard: original posting, underlying event, treatment; one source may support both sides; estimates use a documented calculation and approved judgment (Spec §8.1). | Resolved |
| R6 | "Twelve rule families catch all 18" was a hypothesis. | Three-outcome model (confirmed / suspected / evidence missing, plus incomplete) per fixture; missing pages detectable, missing transactions not reconstructed (E4). | Resolved |
| R7 | EWMA figures unverified: 822M opening equity, 2M receipt, ~9.7M interest. | 821,968,164.19: reproduced arithmetically from TB v2 and AJ1–AJ4 and labelled reconstruction, content unverified (E3). 2,000,000 receipt: not a fixture; it may sit on the missing NMB pages 38–40. ~9.73M interest: not a fixture; needs the GL and an interest computation. | E3 resolved; the other two remain blockers (Spec §15.6) |
| R8 | The 119.2M CRDB TZS balance includes the 100M payout; calling it a missing asset could double count. | E1 holds the deposit history; refusals for an inferred restatement and a second asset; EVIDENCE_SINGLE_USE (E1-M1). v2's stage table said "approved deposit 200M vs 100M at CRDB" was an EWMA flag; that wording is withdrawn. | Resolved |
| R9 | Verify the QuickBooks GL response against an independent export before relying on it. | Contracts C5 and C6, LIVE_SANDBOX_PROOF mode in the runner; connector allow-list unchanged until they pass (Spec §3). | Blocker: no sandbox run yet |
| R10 | Keep "TB validated" and "Ready for reporting" separate; bind the decision to what was reviewed; reopen on change. | Four states (Spec §2); readiness manifest and finalizing transaction (Spec §9). | Resolved in spec; C1–C4 not yet run |
| R11 | One button, one queue, one next action per card. | Spec §11. | Resolved |
| R12 | The food-rations card wording. | Adopted (E2 `user_sees`), with the opening-bridge condition made explicit because the ledger carries no opening payable. | Resolved |
| R13 | A QuickBooks correction and a reporting adjustment must never both count. | Correction states and retirement (Spec §8.2); E2-L1…L5, FM5. | Resolved in spec |
| R14 | First release around one end-to-end case. | Pilot = E2 through the adjusted TB and `fs_reporting_input` (Spec §12). | Resolved |
| R15 | Replay register with confirmed / suspected / missing outcomes and clean cases. | `cases.mjs`: EWMA, constructed and synthetic cases; clean cases S2, S3, S4-M1, E2-L4/L5. | Resolved |

## V3 assignment requirements

| # | Requirement | Where | Status |
|---|---|---|---|
| A1 | Draft from a validated TB; separate TB, draft, scope and pack states; GL absence and tie-out failure hold only dependent checks | Spec §2, §3; S7, S8, E2-REAL | Resolved |
| A2 | Opening bridge: reuse prior pack or signed FS + TB + audit journals + schedules; line-to-account map; level verified; first period; migration | Spec §4.1; S3 | Resolved in spec; path B line mapping UI not designed |
| A3 | Independent opening tests; entry-level OBE/suspense; classification; approval not evidence; preserve comparatives; verify standards first | Spec §4.2–4.4; S4, S10, S11, E3 | Resolved; IAS 8 and IFRS for SMEs Section 10 citations remain unverified |
| A4 | Bank population, coverage, duplicates, OCR uncertainty, matching, splits, transfers, reversals, tie, targeted subsequent evidence, independent cut-off search | Spec §5; E4, S1, S2, S9, FM1, FM2, FM4 | Resolved; splits, transfers and reversals specified but not yet fixtures |
| A5 | One effect per correction; roles and separation; stable identity; QuickBooks verification; partial, reversal, repeat, unrelated same amount | Spec §7, §8; E2, E2-L1…L5, FM5 | Resolved |
| A6 | Enforceable finalization; manifest in the same transaction; both orderings; QuickBooks freshness; issued evidence preserved | Spec §9; S12, FM3; C1–C4, C7 | Resolved in spec; database proofs not run |
| F | EWMA fixtures with inputs, sources, finding, scopes, user text, correction, balances, finalization | Contract §3 | E1, E2, E3, E4 draft (freeze checks open); S1–S4 frozen synthetic |
| K | Separate self-check, implementation tests, live sandbox proof | Contract §1; `run.mjs` modes, distinct reports and exit codes; adapter refusal | Resolved |
| P | Narrow pilot with frozen exports | Spec §12 | Blocked on EWMA's real GL export |
| CL | Claude's role: extraction, candidate matching, explanation | Spec §10 | Resolved |

## Found during this inspection

| # | Finding | Effect on V3 |
|---|---|---|
| D1 | No Codex V3 draft or acceptance runner at `f366367` or in the attachments. | Not reconciled; Spec header says how to reconcile if it appears. |
| D2 | SAFISHA server-authority migrations quarantined; functions on main call their objects. | V3 does not depend on SAFISHA for readiness (Spec §1, §15.5). |
| D3 | `CLEARING_ACCOUNT_BALANCE` and catalogue A02 are balance-level or not evaluated. | Entry-level rule added (Spec §4.3). |
| D4 | CLAUDE.md lists DEFECT-ACCOUNT-REVIEW-AUTHORITATIVE-FLAGS-001 open; source shows flag preservation (`20260904120000`). | Register update needed (not done here). The population rule does not rely on the flags. |
| D5 | TB v2 names 1030 "CRDB USD"; the CRDB TZS statement has no ledger account; the CRDB USD statement is in USD. | E1 and E4 hold cash:CRDB-TZS for a mapping decision and Bank of Tanzania rates. |
| D6 | The page-8 amount in this engagement's bank workpaper (7,059,664.92) does not match the transcribed adjacent rows (12,786,950.80). | E4 stays draft until resolved against the PDF; the fixture asserts the break, not an amount. |
| D7 | The ledger carries no opening payable (A/P nil), so "Dr Payable / Cr Expense" alone would leave a debit payable. | E2 requires the opening-bridge correction first; two corrections, one effect each. |
