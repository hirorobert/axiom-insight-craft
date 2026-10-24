# Review Response

| | |
|---|---|
| **Document ID** | CFR-REVIEW-3 (supersedes CFR-REVIEW-2 and -1, neither committed) |
| **Baseline** | `f3d1b40`; implementation branch `fix/track-a-release-hardening-20261024`, draft PR #194 |
| **Responds to** | Review A (REQUEST CHANGES on draft RFC-FW-001), Review B (master-specification assignment), Review C (evidence baseline, two tracks, defect re-assessment, immutability, concurrency, security, trust model, manifests, accounting corrections, traceability, recovery, workflow, delivery), **Review D** (this revision: Track A implementation and architecture corrections) |
| **Shared contracts** | `FINANCIAL_REPORTING_MASTER_SPEC.md` (findings §3, actors §4, open items §13); the release record `docs/release/track-a-r1/RECORD.md` |

Dispositions: **ACCEPTED** · **IMPLEMENTED (I, not installed)** · **CORRECTED WITH EVIDENCE** · **UNRESOLVED** (with consequence).

## 1. Review D dispositions

| Item | Requirement | Disposition | Where / evidence |
|---|---|---|---|
| A | Release-journal test: exact entries and hashes, source/mirror correspondence, missing, duplicate, reordered, altered entries, unreviewed forms | IMPLEMENTED, T | `0a735c9a`: literal identities from the transport record (not derived from the implementation under test); refusal cases for each defect class; plus the wrapper close-out test that also failed on `main` (`816c9838`). Master §3 N-04 |
| B | FINAL authority protected against direct service-role INSERT/UPDATE/DELETE without relying on a caller-settable flag; legitimate paths and events preserved | IMPLEMENTED, T | Master §3 D-05, D-09; `20261127100000` §2–§5; proof `b1`–`b6`, `f1` |
| C | Append-only UPDATE/DELETE/TRUNCATE; RLS not assumed to cover TRUNCATE | IMPLEMENTED, T | Master §3 D-06 (fifteen tables); proof `c1`, `c2` |
| D | Governed framework change: audited RPC plus DB enforcement; other company edits preserved; certification invalidated; history; tenant isolation; concurrency; existing owner authorization; policy documented | IMPLEMENTED, T | Master §3 D-01, §5.4 (policy and sequence), §7.2 (lock); proof `d1`–`d5`, `e1`–`e4`; `companyFramework.ts`, `CompanyManager.tsx` |
| E | Findings authority: rule-to-blocking inventory; correct only contract-supported discrepancies; record policy decisions | CORRECTED WITH EVIDENCE | Master §3 D-02 table. Residual of CFR-MASTER-2 withdrawn; the reviewer-acceptance discrepancy recorded as OD-8; no code change (fails closed) |
| F | Related defects | IMPLEMENTED | D-09 (replacement setting); D-06 broadened; the wrapper close-out test; `CompanyManager` no longer drops a framework clear silently. Not implemented here: N-01, O-02 (A-H4) |
| Installation | Additive server → frontend → enforcement; registered forms and transport; preflight; preservation assertions; postconditions; interruption and retry; forward repair; regenerated compiler bundle if changed | IMPLEMENTED, T | `docs/release/track-a-r1/` (preflight, two postconditions, RECORD); `scripts/release/trackAStagedTransport.mjs` and `release/staged-transport-tra/`; SUBMISSION_FORMS; proofs T6 (`m1`–`m4`) and T7 (37 checks). Compiler unchanged, so no regeneration was required (T11) |
| Proofs | The twelve required proofs | IMPLEMENTED, T | RECORD §6 maps each to its case ids; master §0.4 T6–T11 |
| Docs | Privilege model; acceptance versus activation; concurrency and multi-period scope; fencing; manifest extensions and isolated replay; IPSAS 47 194–203A; signing deferred; A-gate consistency; stale installation claims; no guard removal as recovery | ACCEPTED / UNRESOLVED (IPSAS text) | Master §4, §5.4, §7.2, §8.3 (DS-1), §9.1, §9.6, §11.4; delivery §1; IPSAS spec §5.3. **IPSAS 47 paras 194–203A could not be retrieved verbatim** from the provided URL (extraction ends at para 180); dates were established from the standard setter's announcements and the amendment table; transition text remains Q-1 |

## 2. Review C dispositions (carried forward, status updated)

| § | Requirement | Disposition |
|---|---|---|
| 1 | Latest commit; evidence classes; release position | ACCEPTED; class **I** added (master §0.1) |
| 2 | Track A separate from Track B; demonstrated defects not exempted | ACCEPTED; A-H1/A-H2 implemented instead of risk-accepted |
| 3 | Reassess findings; correct D-02; verify grants | ACCEPTED, CORRECTED WITH EVIDENCE (D-02 inventory) |
| 4 | Records + events + projection | ACCEPTED (master §6) |
| 5 | Concurrency and idempotency; held-transaction proofs | ACCEPTED; L2 implemented and proven (`e1`–`e4`); L1 and `fs_requests` remain Track B |
| 6 | Implementable security boundaries; actor model | ACCEPTED, CORRECTED: actor classes separated (master §4.1); "flags are not authorization" (§4.2); CFR-MASTER-2's flag-based proposals and its description of the `filing_jurisdiction` guard corrected |
| 7 | Compiler, signing, audit trust | ACCEPTED; signing deferred as DS-1 |
| 8 | Manifest and replay | ACCEPTED; extensions and isolated replay added (master §9.1, §9.6) |
| 9 | Accounting corrections with primary sources | ACCEPTED / UNRESOLVED (IPSAS 47 text Q-1; dates now separated, IPSAS spec §5.3) |
| 10–14 | Traceability; publication and issuance; workflow; delivery; document set | ACCEPTED; issuance fencing added (master §11.4); delivery gates rewritten (delivery §1) |

## 3. Reviews A and B (carried forward)

All accepted items remain accepted. CFR-REVIEW-1's claim that the reporting migrations were pending hosted application is superseded (journal mirrors record hosted ids 77–80, R).

## 4. Corrections made in this revision

1. Track A permission defects fixed in source rather than risk-accepted (D-01, D-05, D-06, D-09).
2. Actor model separates the service API credential, direct SQL connections, function owners and administrators; flags declared non-authorizing.
3. CFR-MASTER-2's D-01 correction (setting-based guard, "the `filing_jurisdiction` pattern") was wrong on two counts — the pattern does not use a setting, and a setting is not authorization; replaced by the owner-identity guard.
4. Acceptance separated from activation: a temporary window for the acceptance company only, reporting disabled again afterwards; hardening resolved before the window opens.
5. Lock protocol: the company key L2 is implemented (shared by every scope decision, exclusive by the framework change); multi-period rule stated.
6. Issuance workers fenced by a monotonically increasing lease token.
7. Manifest extended (policies, budgets, reconciliation inputs, FX, group); replay isolated from production.
8. IPSAS 47: original effective date, amendment date and early-application conditions separated; ED text explicitly not used.
9. Gate references made consistent (A1 exact candidate; A2 deployed closures; A3 hosted read-only state; A4 installation around publication; A5 acceptance window; A6 activation).
10. Stale statements removed: "no commits", "risk acceptance at A5/A6", "dropping the trigger restores prior behaviour".

## 5. Findings downgraded, disproved or reclassified

| ID | Earlier claim | Now | Evidence |
|---|---|---|---|
| D-02 | (CFR-MASTER-2 residual) lower-severity non-core findings block only if the client reports them | **Withdrawn.** They block in neither path. Only reviewer acceptance of server-detected CRITICAL/HIGH/`INSUFFICIENT_EVIDENCE` differs, failing closed → OD-8 | Master §3 D-02 table |
| D-03 | Missing preparer ≠ approver is a defect | **WITHDRAWN** (unchanged) | `20261125100000…sql:410-433` |
| D-04 | Title check is a privilege defect | **DESIGN WEAKNESS** (unchanged) | CLAUDE.md §9.3 |
| D-06 | Three tables | **Broadened** to fifteen tables by catalog audit; fixed | Master §3 D-06; proof `c1` |
| D-07 | Designation bypasses blockers | **AUDITABILITY IMPROVEMENT** (unchanged) | `20261125100000…sql:346-379` |

## 6. Defects: status at the end of this work

| ID | Defect | Status | Evidence |
|---|---|---|---|
| D-01 | Owner can change the framework at any time; unaudited | **Fixed in source (I)**; installed at A4 | T6 `d1`–`d5`, `e1`–`e3` |
| D-05 | `service_role` can write the FINAL-authority pointer | **Fixed in source (I)** | T6 `b1`, `b2`, `f1` |
| D-06 | TRUNCATE of history tables | **Fixed in source (I)** (fifteen tables) | T6 `c1`, `c2` |
| D-09 | Replacement signalled by a caller-settable setting | **Fixed in source (I)** | T6 `b3`, `b4`, `b6` |
| N-04 | `main` fails its release-journal and wrapper close-out tests | **Fixed in source (I, T)** | T9; CI of PR #194 |
| N-01 | IPSAS/full IFRS entities see IFRS-for-SMEs refusal text | Unresolved (A-H4) | S |
| O-02 | Renderers use 2015 constants | Unresolved (before any third-edition authorization) | S |
| D-04, D-07, D-08, O-01 | Design weaknesses / auditability | Unresolved; Track B | Master §3 |

## 7. Open accounting and owner decisions

Authoritative register: master §13. Accounting: Q-1 (IPSAS 47 paragraph text, transition methods, early-application conditions), Q-3, Q-7, third-edition Appendix A confirmation, **OD-8** (reviewer acceptance versus server blocking). Jurisdiction: Q-2. Owner: OD-3…OD-7, **DS-1** (signing deferred). Resolved: OD-1, OD-2 (fixed). Operational: Q-8 (read at A3).

## 8. Current release gates versus future framework gates

| Gate | Belongs to | Evidence |
|---|---|---|
| A1 exact candidate green | Track A | CI on the exact SHA of PR #194's release commit |
| A2 deployed closures verified | Track A | `verifyDeployedClosure.mjs` → `745c8170…`, `cdc5416f…` (unchanged by `track-a-r1`) |
| A3 hosted read-only posture | Track A | Journal head 80 (`5481a1bb…`); kill switch; rollout; grants; preflight NOTICE |
| A4 install `track-a-r1` around frontend publication, reporting disabled | Track A | Journal ids 81–83 with registered hashes; postcondition NOTICEs; publish record |
| A5 temporary acceptance window, acceptance company only | Track A | J1–J11, one official issuance; window closed (reporting disabled) and recorded |
| A6 activation decision | Track A | Owner record naming the scope |
| Framework authorization (pack revision × jurisdiction × scope) | Track B | Master §6.4; signed fixtures; Q-1/Q-2/Q-3 |

## 9. Exact evidence reviewed and tests executed

**Reviewed (S/R):** as CFR-REVIEW-2 §8, plus `20260920100000` (filing-jurisdiction guard), the canonical-statement rule pack (`src/lib/canonicalStatement/rules/*`, the severities each rule emits), `fs_unresolved_blocking_count`, `fs_unmet_reconciliation_count`, `fs_server_compilation_blocker`, `scripts/release/fsIntegrityStagedTransport.mjs`, `scripts/db-proof/lib/releaseBase.mjs`.

**Executed (T):** master §0.4 T1–T11. **Not executed here:** Deno edge tests, db-contract-tests outside the proof steps, the real-application journey (CI of PR #194 runs them), any hosted check, any accounting fixture.

**External sources:** master §0.5 (verification date 2026-10-24).

## 10. Cross-document consistency check

| Contract / fact | Authoritative location | Referenced from | Consistent? |
|---|---|---|---|
| Evidence classes S/T/R/O/H/I/P/U/X | Master §0.1 | All companions | Yes |
| Findings D-01…D-09, O-01, O-02, N-01, N-04, N-05 | Master §3 | Delivery A-H1…A-H4, A1; review §5–§6 | Yes |
| Actor classes; flags are not authorization | Master §4 | Master §5.1 rule 8, §5.4; review §4 | Yes |
| Framework policy and installation sequence | Master §5.4 | Delivery A4, A-H2; RECORD §4 | Yes |
| Lock order L1–L7 (L2 implemented) | Master §7.2 | Master §6.3, §11.4; delivery B3 | Yes |
| Issuance fencing | Master §11.4 | Delivery B13 | Yes |
| Manifest extensions; isolated replay | Master §9.1, §9.6 | Delivery B2; IPSAS §6 (budgets) | Yes |
| IPSAS 47 dates and Q-1 | IPSAS §5.3; master §0.5, §13 | Coverage §3, IP-29; delivery §3 | Yes |
| Signing deferred (DS-1) | Master §8.3, §13 | Review §7 | Yes |
| Track A gates A1–A6 | Delivery §1 | Master §1, §3 N-04, §5.4, §8.2, §13; review §8; RECORD §5 | Yes |
| Open items Q-1…Q-8, OD-1…OD-8, DS-1 | Master §13 | Review §7; delivery §1, §3 | Yes |

**Statement:** these documents do not declare the architecture failure-proof, complete or beyond redesign. They state what exists (S/T/R), what is implemented but not installed (I), what is supplied (O), what remains unproven (U; H is empty), what must be done next (Track A gates; Track B in dependency order) and what evidence permits each release decision.
